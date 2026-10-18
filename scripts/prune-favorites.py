#!/usr/bin/env python3
import json
import re
from pathlib import Path

APP_DIR   = Path(__file__).resolve().parent.parent
FAVORITES = APP_DIR / 'favorites.json'
LIBRARY   = Path.home() / '.hqplayer' / 'library.xml'

if not FAVORITES.exists():
    print('No favorites file yet')
    raise SystemExit(0)

favs = set(json.loads(FAVORITES.read_text())['albums'])

if not favs:
    print('No favorites to prune')
    raise SystemExit(0)

if not LIBRARY.exists():
    print(f'Library not found: {LIBRARY}')
    raise SystemExit(1)

raw = LIBRARY.read_text(encoding='utf-8', errors='replace')
live = set(re.findall(r'<directory[^>]*\bhash="([^"]+)"', raw))

kept = favs & live
removed = len(favs - kept)

if removed:
    FAVORITES.write_text(json.dumps({'albums': sorted(kept)}, indent=2))
    print(f'Pruned {removed} of {len(favs)} favorites ({len(kept)} kept)')
else:
    print(f'All {len(favs)} favorites still valid')