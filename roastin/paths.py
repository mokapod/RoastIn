"""Path normalisation and root-containment checks.

These are the security boundary for every path that arrives from the
client: /api/load, /api/queue-append, /api/waveform, /api/reveal, and
the /files/ cover-art route. Every one of them resolves the path and
checks it against COVER_ROOTS before touching disk or HQPlayer.
"""
from __future__ import annotations

import os
import sys
from urllib.parse import unquote

from .config import COVER_ROOTS, ROOT


def normalize_path(raw_path: str | None) -> str:
    """Convert a file:// URL from the frontend into a clean filesystem path."""
    path = raw_path or ''
    path = path.removeprefix('file://')
    path = unquote(path)

    if sys.platform == 'win32' and len(path) >= 3 \
            and path[0] == '/' and path[2] == ':':
        path = path[1:]

    return path


def is_within_allowed_roots(path: str) -> bool:
    """True if the real path resolves inside any allowed root.

    Uses COVER_ROOTS rather than ROOT alone. COVER_ROOTS starts as
    [ROOT] and is extended by the user-configured coverRoots list in
    settings.json. That extension point is what allows a library on
    an external volume — the realpath of a track under a symlinked
    directory resolves to the external volume, which is outside ROOT
    and would be rejected by a check against ROOT alone.

    realpath is essential — commonpath on an unresolved path would be
    defeated by a symlink pointing outside the allowed roots. The
    roots themselves are already canonical, so no further
    normalization is needed.

    Returns False for any path that can't be resolved — a missing
    file, a permission error, a path whose realpath computation
    raises.
    """
    try:
        resolved = os.path.realpath(path)
    except (OSError, ValueError):
        return False

    for root in COVER_ROOTS:
        try:
            if os.path.commonpath([resolved, root]) == root:
                return True
        except ValueError:
            # Different drives on Windows, or one path is relative.
            continue
    return False


__all__ = ['normalize_path', 'is_within_allowed_roots', 'ROOT']
