#!/bin/bash
# list-corruptions.sh — report files with corrupted UTF-8 in library.xml
#
# Prints a short summary to stdout (shown in the notification) and the
# full list of affected files to stderr (shown only in the server log).

python3 <<'PYEOF'
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

LIBRARY = Path.home() / ".hqplayer" / "library.xml"

if not LIBRARY.exists():
    print("library.xml not found")
    sys.exit(0)

text = LIBRARY.read_text(encoding="utf-8", errors="replace")
try:
    root = ET.fromstring(text)
except ET.ParseError as e:
    print(f"library.xml unparseable: {e}")
    sys.exit(0)

hits = []
for directory in root.findall("directory"):
    dir_path = directory.get("path", "")
    for f in directory.findall("file"):
        for attr, value in f.attrib.items():
            if "\ufffd" in value:
                name = f.get("name", "(no name)")
                hits.append({
                    "full":      f"{dir_path}/{name}",
                    "attribute": attr,
                    "value":     value,
                })

if not hits:
    print("Library clean: no corruptions found")
    sys.exit(0)

print(f"{len(hits)} corruption(s) — see server log for details")

# Full list goes to stderr so it lands in the server terminal
# without overflowing the notification.
for h in hits:
    print(f"  {h['attribute']}: {h['value']!r}", file=sys.stderr)
    print(f"    {h['full']}", file=sys.stderr)
PYEOF