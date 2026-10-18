#!/usr/bin/env python3
"""
Audit composer and artist names in library.xml against the alias maps in
aliases.json. Writes any misses into a `_misses` block at the top level.

Combined credit strings (e.g. "A, B, C" or "X & Y") are split into their
components before checking, mirroring what the frontend does with
splitArtistComponents(). This keeps the audit reporting only names that
actually affect grouping.

Usage:
    python3 audit_names.py [library.xml] [aliases.json]

Defaults:
    library.xml   — relative to the current directory
    aliases.json  — in the app root, one level above this script

Options:
    --dry-run     print misses without writing anything
    --clear       remove the `_misses` block and exit
"""

import argparse
import json
import os
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR      = Path(__file__).resolve().parent      # /Users/tzegin/RoastIn/scripts
APP_DIR         = SCRIPT_DIR.parent                    # /Users/tzegin/RoastIn
DEFAULT_ALIASES = APP_DIR / "aliases.json"             # /Users/tzegin/RoastIn/aliases.json


# ─── Library reading ────────────────────────────────────────────────────

def parse_library_tolerant(path):
    """Parse library.xml, replacing undecodable bytes with U+FFFD.

    HQPlayer occasionally writes truncated UTF-8 sequences into
    library.xml (trailing-character corruption on CJK names).
    ElementTree's default parser rejects these outright. Decoding with
    errors='replace' substitutes U+FFFD for the bad bytes, so the file
    parses and the corrupted names appear verbatim in the audit.
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    return ET.fromstring(text)


def split_components(name):
    """Split a combined credit string into individual names.

    Separators: comma, ampersand (with surrounding spaces), and slash
    (with surrounding spaces). Hyphens are preserved — they appear in
    many names.

    Examples:
        "Anatole Fistoulari, Concertgebouw Orchestra of Amsterdam"
            → ["Anatole Fistoulari", "Concertgebouw Orchestra of Amsterdam"]
        "Ella Fitzgerald & Louis Armstrong"
            → ["Ella Fitzgerald", "Louis Armstrong"]
        "Chick Hollanda / Antonio Carlos Jobim"
            → ["Chick Hollanda", "Antonio Carlos Jobim"]
    """
    if not name:
        return []
    parts = re.split(r"\s*,\s*|\s+&\s+|\s+/\s+", name)
    return [p.strip() for p in parts if p.strip()]


def collect_names(root, attribute):
    """Return the set of non-empty values of `attribute`, split into
    individual components. Combined strings like 'A, B, C' become
    three separate names."""
    names = set()
    for element in root.iter():
        value = element.get(attribute)
        if value:
            for component in split_components(value):
                names.add(component)
    return names


# ─── Alias reading ──────────────────────────────────────────────────────

def variants_of(aliases):
    """Flatten a canonical → [variants] map into a single set."""
    out = set()
    for variants in aliases.values():
        out.update(variants)
    return out


# ─── Diff ───────────────────────────────────────────────────────────────

def find_misses(library_names, covered_names):
    """Names in the library that aren't covered by any variant."""
    return sorted(library_names - covered_names, key=str.casefold)


# ─── JSON I/O ───────────────────────────────────────────────────────────

def load_json(path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json_atomic(path, data):
    """Write `data` to `path` atomically, preserving JSON formatting."""
    directory = path.parent
    fd, tmp_path = tempfile.mkstemp(
        dir=directory, prefix=path.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


# ─── Main ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "library", nargs="?", default="library.xml",
        help="path to library.xml (default: library.xml)",
    )
    parser.add_argument(
        "aliases", nargs="?", default=str(DEFAULT_ALIASES),
        help="path to aliases.json (default: next to the app root)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="print misses without writing to aliases.json",
    )
    parser.add_argument(
        "--clear", action="store_true",
        help="remove the _misses block and exit",
    )
    args = parser.parse_args()

    aliases_path = Path(args.aliases).expanduser()
    library_path = Path(args.library).expanduser()

    # --clear short-circuit: drop the _misses block, done.
    if args.clear:
        if not aliases_path.exists():
            print(f"error: {aliases_path} not found", file=sys.stderr)
            sys.exit(1)
        aliases = load_json(aliases_path)
        if "_misses" in aliases:
            del aliases["_misses"]
            write_json_atomic(aliases_path, aliases)
            print(f"cleared _misses from {aliases_path}")
        else:
            print(f"nothing to clear in {aliases_path}")
        return

    if not library_path.exists():
        print(f"error: library not found: {library_path}", file=sys.stderr)
        sys.exit(1)
    if not aliases_path.exists():
        print(f"error: aliases not found: {aliases_path}", file=sys.stderr)
        sys.exit(1)

    # Load both.
    root    = parse_library_tolerant(library_path)
    aliases = load_json(aliases_path)

    # Read the two maps from the top level of aliases.json.
    artist_aliases   = aliases.get("artistAliases",   {})
    composer_aliases = aliases.get("composerAliases", {})

    covered_artists   = variants_of(artist_aliases)
    covered_composers = variants_of(composer_aliases)

    library_artists   = collect_names(root, "artist")
    library_composers = collect_names(root, "composer")

    artist_misses   = find_misses(library_artists,   covered_artists)
    composer_misses = find_misses(library_composers, covered_composers)

    # Report.
    print(f"artist misses:   {len(artist_misses)}")
    print(f"composer misses: {len(composer_misses)}")

    if args.dry_run:
        if artist_misses:
            print("\nartist misses:")
            for name in artist_misses:
                print(f"  {name}")
        if composer_misses:
            print("\ncomposer misses:")
            for name in composer_misses:
                print(f"  {name}")
        return

    # Write the misses into aliases.json as a top-level _misses block.
    aliases["_misses"] = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "library":   str(library_path),
        "artistMisses":   artist_misses,
        "composerMisses": composer_misses,
    }

    write_json_atomic(aliases_path, aliases)
    print(f"wrote _misses into {aliases_path}")


if __name__ == "__main__":
    main()