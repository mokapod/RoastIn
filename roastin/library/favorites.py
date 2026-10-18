"""favorites.json persistence.

A single set of album hashes, written atomically. The HTTP layer owns
the read-modify-write lock; this module only does file I/O.
"""
import json

from ..config import FAVORITES_PATH


def load_favorites():
    """Return the set of favorited album hashes."""
    try:
        with FAVORITES_PATH.open(encoding='utf-8') as f:
            data = json.load(f)
        return set(data.get('albums', []))
    except (OSError, json.JSONDecodeError):
        return set()


def save_favorites(fav_set):
    """Write the favorites set to disk atomically."""
    tmp = str(FAVORITES_PATH) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'albums': sorted(fav_set)}, f, indent=2)
    import os
    os.replace(tmp, FAVORITES_PATH)
