"""Configuration loading.

settings.json is the single source of truth for both halves of the app.
It is read once at import time and exposed as module-level constants, so
every other module gets the same immutable view without threading a
config object through call signatures.
"""
import json
import sys
from pathlib import Path

# The application directory is the parent of this package.
APP_DIR = Path(__file__).resolve().parent.parent
SETTINGS_PATH = APP_DIR / 'settings.json'
ALIASES_PATH = APP_DIR / 'aliases.json'


def _load_settings():
    if not SETTINGS_PATH.exists():
        print(f'❌ Settings file not found: {SETTINGS_PATH}')
        print('   Create it before starting the server.')
        sys.exit(1)

    try:
        with SETTINGS_PATH.open(encoding='utf-8') as f:
            settings = json.load(f)
    except json.JSONDecodeError as e:
        print(f'❌ {SETTINGS_PATH} is not valid JSON:')
        print(f'   line {e.lineno}, column {e.colno}: {e.msg}')
        sys.exit(1)
    except OSError as e:
        print(f'❌ Could not read {SETTINGS_PATH}: {e}')
        sys.exit(1)

    for section in ('frontend', 'server'):
        if section not in settings:
            print(f"❌ {SETTINGS_PATH} is missing the '{section}' section")
            sys.exit(1)

    return settings


SETTINGS = _load_settings()

# --- identity ------------------------------------------------------------
APP_FOLDER = SETTINGS['server'].get('appFolder') or APP_DIR.name

# --- HTTP ----------------------------------------------------------------
HTTP_HOST = SETTINGS['server']['httpHost']
HTTP_PORT = SETTINGS['server']['httpPort']
WEB_INDEX_FS_PATH = APP_DIR / 'index.html'
WEB_INDEX_URL = f'/{APP_FOLDER}/index.html'

# --- HQPlayer ------------------------------------------------------------
HQPLAYER_APP = SETTINGS['server']['hqplayer']['appName']
HQPLAYER_SCRIPTS = SETTINGS['server']['hqplayer'].get('scripts', {})
HQPLAYER_SETTINGS_DIR = '.hqplayer'
HQPLAYER_HOST = SETTINGS['server']['hqplayerHost']
HQPLAYER_PORT = SETTINGS['server']['hqplayerPort']

# --- data root -----------------------------------------------------------
# HQPlayer's .hqplayer directory lives under the user's home by default.
# `homePath` overrides it (e.g. an external volume).
_hp = SETTINGS['server'].get('homePath', '').strip()
import os as _os

ROOT = _os.path.realpath(
    _os.path.expanduser(_hp) if _hp else _os.path.expanduser('~')
)
HQPLAYER_SETTINGS_PATH = _os.path.join(ROOT, HQPLAYER_SETTINGS_DIR,
                                       'settings.xml')

# --- files ---------------------------------------------------------------
FAVORITES_PATH = APP_DIR / 'favorites.json'
SCRIPTS_DIR = APP_DIR / 'scripts'
API_TOKEN_PATH = APP_DIR / '.api_token'

# Upper bound on any POST body. Every endpoint takes a small command
# payload, so this guards against a hostile Content-Length rather than
# limiting legitimate use.
MAX_JSON_BODY_BYTES = 1024 * 1024

# --- cover art roots -----------------------------------------------------
# Roots the /files/ route may serve from, and that every path-accepting
# endpoint validates against. ROOT is already canonical (realpath'd
# above). User-supplied coverRoots entries are canonicalised here so
# every comparison is apples-to-apples.
COVER_ROOTS = [
    ROOT,
    *(
        _os.path.realpath(_os.path.expanduser(p))
        for p in SETTINGS['server'].get('coverRoots', [])
    ),
]

# Only serve these extensions from /files/. The browser requests images
# unauthenticated (it cannot attach X-API-Token to an <img>), so a
# broader allowlist would let any same-machine process read arbitrary
# files by guessing names.
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'}

MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
}

# /files/ responses are streamed in chunks rather than read whole into
# memory, so a 5 MB cover becomes ~80 reads of 64 KB.
COVER_CHUNK_BYTES = 64 * 1024

# Downscaled cover art for /files/?w= requests, kept beside the app the
# same way the waveform cache is. SQLite rather than a directory of files:
# one file to back up, prune and inspect, and a BLOB read per hit.
COVER_CACHE_PATH = str(APP_DIR / 'covers.sqlite3')

# --- waveform ------------------------------------------------------------
WAVEFORM_CACHE_DIR = _os.path.expanduser(
    SETTINGS['server']['waveform']['cacheDir']
)
WAVEFORM_SAMPLE_RATE = 1000
WAVEFORM_TARGET_POINTS = SETTINGS['server']['waveform']['points']
