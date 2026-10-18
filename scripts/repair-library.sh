#!/bin/bash
# repair-library.sh — fix known truncated UTF-8 sequences in library.xml
#
# Safe to run repeatedly. Only matches the exact byte patterns we've
# identified, and verifies the result is valid UTF-8 before writing.
# Run after any HQPlayer library rescan.

python3 <<'PYEOF'
import sys
from pathlib import Path

LIBRARY = Path.home() / ".hqplayer" / "library.xml"

if not LIBRARY.exists():
    print("library.xml not found")
    sys.exit(0)

data = LIBRARY.read_bytes()

# Known truncations: (bad_bytes, good_bytes)
# Each entry is a 2-byte prefix of a 3-byte UTF-8 sequence that lost
# its final byte, immediately followed by the closing quote of an
# attribute. We restore the correct third byte.
#
# To add a new case: find the byte pattern around the corruption,
# note the missing third byte, and append to this list.
REPAIRS = [
    # 你 (E4 BD A0) truncated to E4 BD, followed by "
    (b"\xe4\xbd\x22", b"\xe4\xbd\xa0\x22"),
]

total = 0
for bad, good in REPAIRS:
    count = data.count(bad)
    if count:
        data = data.replace(bad, good)
        total += count

if total == 0:
    print("Library already clean — no repairs needed")
    sys.exit(0)

# Verify the result is valid UTF-8 before writing.
try:
    data.decode("utf-8")
except UnicodeDecodeError as e:
    print(f"Repair failed — result still invalid at byte {e.start}")
    sys.exit(1)

backup = LIBRARY.with_suffix(".xml.bak")
backup.write_bytes(LIBRARY.read_bytes())
LIBRARY.write_bytes(data)

print(f"Repaired {total} truncated character(s)")
PYEOF