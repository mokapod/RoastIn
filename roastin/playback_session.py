"""Durable playback intent for aggressive session recovery.

This file is intentionally separate from HQPlayer's live status and from
in-memory state. It survives RoastIn and browser restarts, but it records
what the user intended RoastIn to restore, not an unverified claim about
what HQPlayer currently has loaded.
"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any

from .config import PLAYBACK_SESSION_PATH


_VALID_INTENTS = frozenset({'playing', 'paused', 'stopped', 'empty'})
_VALID_MODES = frozenset({'album', 'queue'})


def _empty_session() -> dict[str, Any]:
    return {
        'version': 1,
        'known': False,
        'intent': 'empty',
        'mode': None,
        'album': None,
        'track': None,
        'position': 0,
        'duration': 0,
        'queue': [],
        'updated_at': 0,
    }


def _sanitize(data: Any) -> dict[str, Any]:
    """Return a safe session object, discarding malformed persisted data."""
    if not isinstance(data, dict):
        return _empty_session()

    intent = data.get('intent')
    if intent not in _VALID_INTENTS:
        return _empty_session()

    result = _empty_session()
    result['intent'] = intent
    # A recognized intent means a session was persisted on purpose —
    # even intent='empty' (an explicit Stop/Clear). The file-missing
    # case (known=False) is the only way the app treats "no session".
    result['known'] = True

    mode = data.get('mode')
    if mode in _VALID_MODES:
        result['mode'] = mode

    album = data.get('album')
    if isinstance(album, dict):
        folder = album.get('folder')
        base_name = album.get('baseName')
        if isinstance(folder, str) and folder and isinstance(base_name, str):
            result['album'] = {
                'folder': folder,
                'baseName': base_name,
                'artist': album.get('artist', '')
                if isinstance(album.get('artist', ''), str) else '',
            }

    track = data.get('track')
    if isinstance(track, dict):
        path = track.get('path')
        name = track.get('name')
        if isinstance(path, str) and path and isinstance(name, str) and name:
            result['track'] = {'path': path, 'name': name}

    for key in ('position', 'duration'):
        value = data.get(key, 0)
        if isinstance(value, (int, float)) and value >= 0:
            result[key] = value

    queue = data.get('queue')
    if isinstance(queue, list):
        clean_queue = []
        for item in queue:
            if not isinstance(item, dict):
                continue
            path = item.get('path')
            if isinstance(path, str) and path:
                clean_queue.append({
                    'path': path,
                    'name': item.get('name', '')
                    if isinstance(item.get('name', ''), str) else '',
                })
        result['queue'] = clean_queue

    updated_at = data.get('updated_at', 0)
    if isinstance(updated_at, (int, float)) and updated_at >= 0:
        result['updated_at'] = updated_at

    return result


def load_session() -> dict[str, Any]:
    """Load durable playback intent; malformed or absent data means empty."""
    try:
        with PLAYBACK_SESSION_PATH.open(encoding='utf-8') as handle:
            return _sanitize(json.load(handle))
    except (OSError, json.JSONDecodeError):
        return _empty_session()


def save_session(session: dict[str, Any]) -> None:
    """Atomically persist a sanitized playback-intent snapshot."""
    clean = _sanitize(session)
    PLAYBACK_SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(
        prefix='.playback_session.',
        suffix='.tmp',
        dir=PLAYBACK_SESSION_PATH.parent,
    )
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(clean, handle, indent=2)
            handle.write('\n')
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, PLAYBACK_SESSION_PATH)
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass


def clear_session() -> None:
    """Persist the explicit user intent that no transport should be restored."""
    save_session({'intent': 'empty'})


__all__ = ['clear_session', 'load_session', 'save_session']
