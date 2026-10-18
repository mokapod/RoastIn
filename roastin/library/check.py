"""Startup validation of HQPlayer's library.xml.

Context: HQPlayer rewrites this file on every rescan, and it has been
observed to write truncated UTF-8 — one missing byte on a CJK song
title took the whole library down (browsers hard-fail XML parses, the
frontend showed only the "malformed" error page, and nothing on the
server side could say why).

Checks, in order:

  1. File exists and is non-empty.
  2. Decodes as UTF-8. On failure, the byte offset and a 60-byte
     context window are printed — enough to add the pattern to
     scripts/repair-library.sh.
  3. Parses as XML. On failure, line and column are printed.
  4. Counts <directory> and <file> entries so the startup log states
     what the frontend is about to load.

On any failure this returns a report with ok=False rather than raising:
startup logging is informational, and a corrupt library must not
prevent the server from serving everything else (the frontend already
shows its own malformed-library page).

The repair hint names scripts/repair-library.sh, which exists
precisely for byte-pattern repairs of this file.
"""
from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from typing import Tuple

from ..config import HQPLAYER_SETTINGS_DIR, ROOT
from ..timing import timed
from ..types import LibraryReport

_LIBRARY_NAME = 'library.xml'
_REPAIR_SCRIPT = 'scripts/repair-library.sh'


def library_path() -> str:
    return os.path.join(ROOT, HQPLAYER_SETTINGS_DIR, _LIBRARY_NAME)


def check_library(path: str | None = None) -> LibraryReport:
    """Validate library.xml and return a structured report."""
    target = path or library_path()

    if not os.path.isfile(target):
        return LibraryReport(ok=False, path=target, bytes=0, directories=0,
                             files=0, error='file not found', line=0,
                             column=0)

    try:
        size = os.path.getsize(target)
    except OSError:
        size = 0
    if size == 0:
        return LibraryReport(ok=False, path=target, bytes=0, directories=0,
                             files=0, error='file is empty', line=0,
                             column=0)

    try:
        raw = open(target, 'rb').read()
    except OSError as e:
        return LibraryReport(ok=False, path=target, bytes=size,
                             directories=0, files=0,
                             error=f'unreadable: {e}', line=0, column=0)

    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError as e:
        start = max(0, e.start - 30)
        context = raw[start:e.start + 30]
        return LibraryReport(
            ok=False, path=target, bytes=len(raw), directories=0, files=0,
            error=(f'invalid UTF-8 at byte {e.start} '
                   f'(context {context!r}). Run {_REPAIR_SCRIPT} — '
                   f'it patterns exactly this class of truncation.'),
            line=0, column=0)

    with timed('library.parse', bytes=len(raw)):
        try:
            root = ET.fromstring(text)
        except ET.ParseError as e:
            msg, _, where = str(e).partition(': ')
            line, _, column = where.partition(', column ')
            return LibraryReport(
                ok=False, path=target, bytes=len(raw), directories=0,
                files=0, error=f'malformed XML: {msg}',
                line=_safe_int(line), column=_safe_int(column))

    directories = len(root.findall('.//directory'))
    files = len(root.findall('.//file'))
    return LibraryReport(ok=True, path=target, bytes=len(raw),
                         directories=directories, files=files,
                         error='', line=0, column=0)


def _safe_int(value: str) -> int:
    try:
        return int(''.join(c for c in value if c.isdigit()) or 0)
    except ValueError:
        return 0


def report_to_log(report: LibraryReport) -> None:
    """Print one startup line: the good case and the bad case."""
    if report['ok']:
        print(f'   Library: {report["directories"]} directories, '
              f'{report["files"]} tracks '
              f'({report["bytes"] / 1024:.0f} KB)')
        return
    print(f'   ⚠️  library.xml FAILED validation: {report["error"]}')
    if report['line']:
        print(f'      line {report["line"]}, column {report["column"]}')
    print('      The library view will show the malformed-library page '
          'until this is fixed.')
    print(f'      Try: ./{_REPAIR_SCRIPT} (byte-pattern repairs), or '
          f'rescan the library in HQPlayer.')


def count_library() -> Tuple[int, int]:
    """(directories, files) for the already-validated common case.

    Returns (0, 0) if the file cannot be read or parsed. Used by
    callers that only need the counts, e.g. health summaries.
    """
    report = check_library()
    if not report['ok']:
        return 0, 0
    return report['directories'], report['files']
