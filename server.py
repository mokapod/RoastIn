#!/usr/bin/env python3
import concurrent.futures
import hashlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import xml.etree.ElementTree as ET
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import unquote, urlparse
from xml.sax.saxutils import escape as xml_escape
from xml.sax.saxutils import quoteattr

# ==========================================================================
# SETTINGS
# ==========================================================================
SCRIPT_DIR    = Path(__file__).resolve().parent      # /RoastIn
SETTINGS_PATH = SCRIPT_DIR / 'settings.json'          # /RoastIn/settings.json
ALIASES_PATH  = SCRIPT_DIR / 'aliases.json'           # /RoastIn/aliases.json


def _load_settings():
    if not SETTINGS_PATH.exists():
        print(f"❌ Settings file not found: {SETTINGS_PATH}")
        print("   Create it before starting the server.")
        sys.exit(1)

    try:
        with SETTINGS_PATH.open(encoding='utf-8') as f:
            settings = json.load(f)
    except json.JSONDecodeError as e:
        print(f"❌ {SETTINGS_PATH} is not valid JSON:")
        print(f"   line {e.lineno}, column {e.colno}: {e.msg}")
        sys.exit(1)
    except OSError as e:
        print(f"❌ Could not read {SETTINGS_PATH}: {e}")
        sys.exit(1)

    for section in ('frontend', 'server'):
        if section not in settings:
            print(f"❌ {SETTINGS_PATH} is missing the '{section}' section")
            sys.exit(1)

    return settings


SETTINGS = _load_settings()


def _load_aliases():
    """Return (artist_aliases, composer_aliases), or empty dicts on error.

    Aliases are optional — the app runs fine without them. Missing or
    malformed file just means no alias grouping. This is the lenient
    loader: correct for the read-only paths that must not fail a page
    load over a bad file. The merge path uses _load_aliases_strict.
    """
    if not ALIASES_PATH.exists():
        return {}, {}
    try:
        with ALIASES_PATH.open(encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"⚠️  Could not read {ALIASES_PATH}: {e}")
        return {}, {}
    return (
        data.get('artistAliases', {}),
        data.get('composerAliases', {}),
    )


def _load_aliases_strict():
    """Load aliases.json for the write path, raising on any error.

    Returns (base_data, artist_aliases, composer_aliases):

      base_data         — the whole parsed JSON document. Carries any
                          top-level keys this code doesn't manage, such
                          as the _misses block written by
                          audit_names.py, so the writer can preserve
                          them without re-reading the file.

      artist_aliases    — base_data['artistAliases'], or {} when absent.
      composer_aliases  — base_data['composerAliases'], or {} when absent.

    The two sub-maps are convenience views; the caller mutates them in
    place, and the writer reassembles the document around base_data.

    Differs from _load_aliases in two ways:

      * A corrupt file is a hard failure rather than a silent empty
        result. The merge path is about to write, and proceeding on
        a failed read would destroy the file on the way out.

      * A missing file is still treated as an empty starting state —
        the first-ever merge legitimately begins with no file.

    Exceptions are wrapped in RuntimeError so the HTTP layer maps them
    to 500 rather than 400. json.JSONDecodeError is a ValueError
    subclass, and do_POST's ValueError handler returns 400 — which
    would misattribute a server-side state problem to the client.
    """
    if not ALIASES_PATH.exists():
        return {}, {}, {}

    try:
        with ALIASES_PATH.open(encoding='utf-8') as f:
            data = json.load(f)
    except OSError as e:
        raise RuntimeError(
            f"Cannot read {ALIASES_PATH}: {e}"
        ) from e
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"{ALIASES_PATH} is not valid JSON "
            f"(line {e.lineno}, column {e.colno}: {e.msg}). "
            f"Fix or remove the file and retry."
        ) from e

    return (
        data,
        data.get('artistAliases', {}),
        data.get('composerAliases', {}),
    )


def _save_aliases(artist_aliases, composer_aliases, base_data):
    """Write aliases.json atomically, preserving other top-level keys.

    `base_data` is the full parsed document previously returned by
    _load_aliases_strict. It carries every key this function does not
    manage — including the _misses block written by audit_names.py —
    and those keys survive the write untouched.

    The document is passed in rather than re-read here to close a
    read-read window. The old form called json.load a second time,
    after the strict loader had already validated and parsed the
    same file. In between, an external writer (a text editor, a
    cloud-sync daemon, a manual JSON edit) could leave the file in a
    state the second read would reject. The merge was then abandoned
    — the correct outcome — but the RuntimeError referred to the
    save path rather than the merge, and pointed at a line and
    column for a problem that had not existed when the merge began.

    Passing the already-validated document removes the second read
    entirely. There is nothing to re-check: the object was produced
    by json.load microseconds ago, and only this process holds a
    reference to it.

    Top-level keys (canonicals) are sorted alphabetically for
    readability. Variant lists are left in insertion order, with the
    canonical first.
    """
    data = dict(base_data)

    # Sort top-level keys case-insensitively.
    data['artistAliases']   = dict(sorted(
        artist_aliases.items(), key=lambda kv: kv[0].casefold()
    ))
    data['composerAliases'] = dict(sorted(
        composer_aliases.items(), key=lambda kv: kv[0].casefold()
    ))

    tmp = str(ALIASES_PATH) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, ALIASES_PATH)


def _merge_alias(field, target, source):
    """Merge `source` into `target` in aliases.json. Returns a summary dict.

    field:  'artist' or 'composer'
    target: the canonical name to merge into
    source: the variant to merge from
    """
    if field not in ('artist', 'composer'):
        raise ValueError(f"Invalid field: {field}")

    target = (target or '').strip()
    source = (source or '').strip()
    if not target:
        raise ValueError("Missing 'target'")
    if not source:
        raise ValueError("Missing 'source'")

    # The entire read-modify-write cycle runs under the lock. Without it,
    # two concurrent merges both load the same snapshot, each mutates its
    # own copy, and the second writer overwrites the first writer's merge.
    #
    # The strict loader is what protects the file: a corrupt read raises
    # here, before any mutation, and the file is left untouched. The
    # lenient loader used by the read-only endpoints would have handed
    # this function empty dicts and let it overwrite the file on the
    # way out.
    #
    # base_data is the whole document, threaded through to _save_aliases
    # so the writer does not re-read the file. See the docstring on
    # _save_aliases for why that matters.
    with _aliases_lock:
        base_data, artist_aliases, composer_aliases = _load_aliases_strict()
        aliases = artist_aliases if field == 'artist' else composer_aliases

        # Ensure target group exists with target in its own variant list.
        if target not in aliases:
            aliases[target] = [target]
        elif target not in aliases[target]:
            aliases[target].insert(0, target)

        # Append source to target's variant list if not already present.
        added = False
        if source not in aliases[target]:
            aliases[target].append(source)
            added = True

        # Remove the standalone group for source, if it exists and isn't
        # target. Copy over any other variants that belonged to source
        # first, so they don't disappear when the group is deleted.
        removed_group = False
        if source != target and source in aliases:
            for v in aliases.get(source, []):
                if v not in aliases[target]:
                    aliases[target].append(v)
            del aliases[source]
            removed_group = True

        _save_aliases(artist_aliases, composer_aliases, base_data)

        # Snapshot under the lock. `aliases[target]` is a live list that a
        # concurrent merge could still mutate before the response is
        # serialized on the way out.
        target_variants = list(aliases[target])

    # Invalidate the alias cache now that the file on disk has changed.
    # Done after the lock is released — the cache has its own lock, and
    # nothing in the merge path needs to see the two held together.
    _invalidate_alias_cache()

    return {
        'field':           field,
        'target':          target,
        'source':          source,
        'added':           added,
        'removed_group':   removed_group,
        'target_variants': target_variants,
    }


# ==========================================================================
# CONFIGURATION CONSTANTS
# ==========================================================================
APP_DIR    = SCRIPT_DIR
APP_FOLDER = SETTINGS['server'].get('appFolder') or SCRIPT_DIR.name

_hp = SETTINGS['server'].get('homePath', '').strip()
# realpath at definition time: strips trailing slashes, resolves
# symlinks, and collapses macOS firmlinks. Every downstream comparison
# that does commonpath(...) == ROOT relies on ROOT already being in
# this canonical form — commonpath returns normalized paths, so an
# un-normalized ROOT would compare unequal to its own canonical form
# whenever it has a trailing separator, and the coverage checks would
# silently reject legitimate paths.
ROOT = os.path.realpath(
    os.path.expanduser(_hp) if _hp else os.path.expanduser('~')
)

HQPLAYER_APP          = SETTINGS['server']['hqplayer']['appName']
HQPLAYER_SCRIPTS      = SETTINGS['server']['hqplayer'].get('scripts', {})
HQPLAYER_SETTINGS_DIR = '.hqplayer'

HQPLAYER_HOST = SETTINGS['server']['hqplayerHost']
HQPLAYER_PORT = SETTINGS['server']['hqplayerPort']

HTTP_HOST = SETTINGS['server']['httpHost']
HTTP_PORT = SETTINGS['server']['httpPort']

HQPLAYER_SETTINGS_PATH = os.path.join(ROOT, HQPLAYER_SETTINGS_DIR, 'settings.xml')
WEB_INDEX_FS_PATH      = APP_DIR / 'index.html'
WEB_INDEX_URL          = f'/{APP_FOLDER}/index.html'

WAVEFORM_CACHE_DIR     = os.path.expanduser(SETTINGS['server']['waveform']['cacheDir'])
WAVEFORM_SAMPLE_RATE   = 1000
WAVEFORM_TARGET_POINTS = SETTINGS['server']['waveform']['points']

FAVORITES_PATH         = APP_DIR / 'favorites.json'
SCRIPTS_DIR            = APP_DIR / 'scripts'
API_TOKEN_PATH         = APP_DIR / '.api_token'

# Upper bound on any POST body. Every endpoint takes a small command
# payload, so this is a guard against a hostile Content-Length rather
# than a real limit on legitimate use.
MAX_JSON_BODY_BYTES    = 1024 * 1024

# Roots the /files/ route is allowed to serve from, and that every
# path-accepting endpoint validates against. ROOT is already canonical
# — realpath'd at definition above — so it needs no further processing
# here. User-supplied coverRoots entries come straight from
# settings.json and are canonicalized now so every comparison against
# a resolved path is apples-to-apples.
COVER_ROOTS = [
    ROOT,
    *(
        os.path.realpath(os.path.expanduser(p))
        for p in SETTINGS['server'].get('coverRoots', [])
    ),
]

# Only serve these extensions from /files/. The browser requests images
# unauthenticated (it can't attach the X-API-Token header to <img>),
# so a broader allowlist would let any same-machine process read
# arbitrary files by guessing names.
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'}

MIME_BY_EXT = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.bmp':  'image/bmp',
    '.avif': 'image/avif',
}

# /files/ responses are streamed in this chunk size rather than read
# whole into memory. A 5 MB PNG becomes 80 reads of 64 KB instead of
# one allocation of 5 MB, which matters when several clients request
# covers at the same moment on the machine running HQPlayer's DSP.
COVER_CHUNK_BYTES = 64 * 1024

# One lock per JSON file. Each guards the read-modify-write cycle that
# mutates that file. Readers that only look at the file (GET
# /api/aliases, GET /api/favorites, the index injection) don't take the
# lock: _save_aliases and save_favorites both write via os.replace, so a
# reader always sees either the complete old file or the complete new
# one — never a partial write.
_favorites_lock = threading.Lock()
_aliases_lock   = threading.Lock()

# ── XML timing diagnostic ──
# When ROASTIN_XML_TIMING=1 is set in the environment before the server
# starts, send_xml_command measures the connect, send, and reply-wait
# phases of every command and prints them to the log, and
# _handle_queue_move prints an aggregate for the whole move operation.
#
# Off by default. The boolean check on the disabled path costs nothing
# measurable, and no time.perf_counter() calls run.
_XML_TIMING_ENABLED = os.environ.get('ROASTIN_XML_TIMING') == '1'

os.makedirs(WAVEFORM_CACHE_DIR, exist_ok=True)

_last_known_status = None

_FFMPEG_AVAILABLE = shutil.which('ffmpeg') is not None
_FFMPEG_ERROR = '' if _FFMPEG_AVAILABLE else 'ffmpeg not found on PATH'

_NUMPY_AVAILABLE = False
_NUMPY_ERROR = ''
try:
    import numpy as np
    _NUMPY_AVAILABLE = True
except Exception as e:
    _NUMPY_ERROR = str(e)

_WAVEFORM_AVAILABLE = _FFMPEG_AVAILABLE and _NUMPY_AVAILABLE


# ==========================================================================
# API TOKEN
# ==========================================================================
# Every /api/* request must carry an X-API-Token header. The token is
# generated on first run and persisted next to the app so a browser tab
# stays authenticated across server restarts. Set ROASTIN_API_TOKEN in
# the environment to override — useful for containers and CI.
# --------------------------------------------------------------------------

def _load_or_create_token():
    env_token = os.environ.get('ROASTIN_API_TOKEN')
    if env_token:
        return env_token

    try:
        if API_TOKEN_PATH.exists():
            token = API_TOKEN_PATH.read_text(encoding='utf-8').strip()
            if token:
                return token
    except OSError:
        pass

    token = secrets.token_urlsafe(32)
    try:
        API_TOKEN_PATH.write_text(token + '\n', encoding='utf-8')
        os.chmod(API_TOKEN_PATH, 0o600)
    except OSError:
        pass
    return token


API_TOKEN = _load_or_create_token()


# ==========================================================================
# IMMUTABLE-ISH FILE CACHES
# ==========================================================================
# index.html and aliases.json are read on every page load. Neither
# changes during normal operation — index.html not at all, and
# aliases.json only when the user performs a merge. Caching them
# eliminates two disk reads per page load.
#
# Invalidation:
#   * index.html  — never. Restart the server to pick up edits.
#   * aliases     — explicit call to _invalidate_alias_cache() after a
#                   successful merge.
# --------------------------------------------------------------------------

_INDEX_HTML_CACHE = None
_ALIASES_CACHE    = None
_alias_cache_lock = threading.Lock()


def _get_index_html():
    global _INDEX_HTML_CACHE
    if _INDEX_HTML_CACHE is None:
        with open(WEB_INDEX_FS_PATH, 'r', encoding='utf-8') as f:
            _INDEX_HTML_CACHE = f.read()
    return _INDEX_HTML_CACHE


def _get_aliases():
    global _ALIASES_CACHE
    with _alias_cache_lock:
        if _ALIASES_CACHE is None:
            _ALIASES_CACHE = _load_aliases()
        return _ALIASES_CACHE


def _invalidate_alias_cache():
    global _ALIASES_CACHE
    with _alias_cache_lock:
        _ALIASES_CACHE = None


# ==========================================================================
# PLATFORM HELPERS
# ==========================================================================

def os_open(path):
    """Open a file or folder in the OS file manager / default app."""
    if sys.platform == 'darwin':
        subprocess.Popen(['open', path])
    elif sys.platform == 'win32':
        subprocess.Popen(['explorer', path.replace('/', '\\')])
    else:
        subprocess.Popen(['xdg-open', path])


def os_reveal(path):
    """Reveal a file or folder, with it selected where supported."""
    if sys.platform == 'darwin':
        subprocess.Popen(['open', '-R', path])
    elif sys.platform == 'win32':
        subprocess.Popen(['explorer', '/select,', path.replace('/', '\\')])
    else:
        # Most Linux file managers don't support "reveal selected",
        # so open the containing folder instead.
        folder = path if os.path.isdir(path) else os.path.dirname(path)
        subprocess.Popen(['xdg-open', folder])


def os_launch_app(app_name):
    """Bring an already-running app to the front, or launch it."""
    if sys.platform == 'darwin':
        subprocess.Popen(['open', '-a', app_name])
    elif sys.platform == 'win32':
        subprocess.Popen(['cmd', '/c', 'start', '', app_name])
    else:
        subprocess.Popen([app_name.lower()])


def os_quit_app(app_name):
    """Request a graceful quit of a running app."""
    if sys.platform == 'darwin':
        subprocess.Popen(['osascript', '-e', f'tell application "{app_name}" to quit'])
    elif sys.platform == 'win32':
        subprocess.Popen(['taskkill', '/IM', f'{app_name}.exe', '/F'])
    else:
        subprocess.Popen(['pkill', '-f', app_name])


# ==========================================================================
# HQPLAYER XML API HELPERS
# ==========================================================================

def send_xml_command(xml_string):
    """Send a native XML command to HQPlayer. Fire-and-forget.

    When _XML_TIMING_ENABLED is true (ROASTIN_XML_TIMING=1 in the
    server's environment), the connect, send, and reply-wait phases
    are timed separately and printed to the log. The three are
    distinct costs:

      connect — the TCP handshake. On loopback, tens of microseconds.
                Not worth optimizing unless this dominates.
      send    — the outbound write. Negligible either way.
      reply   — waiting for HQPlayer to process the command and
                write its reply. This is the round-trip cost, and on
                the queue-move path it is the one that multiplies.

    For batches of two or more related commands (queue append, queue
    move, a SelectTrack-then-Play pair), prefer
    send_xml_commands_pipelined — the per-command reply wait is
    eliminated there.
    """
    timing = _XML_TIMING_ENABLED
    t0 = time.perf_counter() if timing else 0.0

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            sock.connect((HQPLAYER_HOST, HQPLAYER_PORT))
            t1 = time.perf_counter() if timing else 0.0

            request = f'<?xml version="1.0" encoding="utf-8"?>{xml_string}\n'.encode()
            sock.sendall(request)
            t2 = time.perf_counter() if timing else 0.0

            try:
                sock.recv(4096)
            except socket.timeout:
                pass
            t3 = time.perf_counter() if timing else 0.0

        if timing:
            print(f"[xml-timing] connect={(t1-t0)*1000:6.2f}ms  "
                  f"send={(t2-t1)*1000:5.2f}ms  "
                  f"reply={(t3-t2)*1000:7.2f}ms  "
                  f"total={(t3-t0)*1000:7.2f}ms  "
                  f"cmd={xml_string[:50]}")
    except Exception as e:
        print(f"XML Command failed: {e}")
        raise ConnectionError("Failed to communicate with HQPlayer") from e


def send_xml_commands_pipelined(xml_strings, idle_timeout=0.5):
    """Send N XML commands on one socket, then drain replies.

    A single command is not a batch. Pipelining exists to collapse N
    round-trips into one tick of HQPlayer's poll loop; with N=1 there
    is nothing to collapse, and the drain's idle window (~500 ms) is
    added on top of the reply latency (~320 ms) with no compensating
    benefit. That's why the single-command case delegates to
    send_xml_command, which reads once and closes.

    Two commands are already worth pipelining. Sequential dispatch is
    roughly 2 × (connect + reply) ≈ 640 ms; pipelined dispatch is
    connect + write + drain ≈ 500 ms, because the drain's idle window
    overlaps both replies rather than following each one. The gap
    widens with N — three commands go from ~960 ms to ~500 ms, which
    is the savings the album-load path relies on.

    Order matters when the commands are position-dependent (queue
    moves, SelectTrack-then-Play): HQPlayer reads them off the socket
    in the order written, and writes preserve order on a single
    stream, so the sequence arrives intact.
    """
    if not xml_strings:
        return

    if len(xml_strings) <= 1:
        for xml_string in xml_strings:
            send_xml_command(xml_string)
        return

    timing = _XML_TIMING_ENABLED
    t_start = time.perf_counter() if timing else 0.0

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(10.0)
            sock.connect((HQPLAYER_HOST, HQPLAYER_PORT))

            # Phase 1 — write every command back-to-back. No reads
            # between sends. Each command is ~200 bytes; a 30-command
            # batch is under 10 KB, comfortably within the kernel's
            # send buffer, so no sendall() blocks waiting for HQPlayer
            # to drain its input.
            for xml_string in xml_strings:
                request = (
                    f'<?xml version="1.0" encoding="utf-8"?>{xml_string}\n'
                ).encode()
                sock.sendall(request)

            t_sent = time.perf_counter() if timing else 0.0

            # Phase 2 — drain. HQPlayer will send one acknowledgment
            # per command. We don't know whether it bursts them or
            # trickles them, so we read until the socket goes quiet
            # for idle_timeout seconds.
            sock.settimeout(idle_timeout)
            reply_bytes = 0
            reply_chunks = 0

            while True:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                reply_bytes  += len(chunk)
                reply_chunks += 1

            t_drained = time.perf_counter() if timing else 0.0

        if timing:
            send_ms  = (t_sent - t_start) * 1000
            drain_ms = (t_drained - t_sent) * 1000
            per_cmd  = drain_ms / len(xml_strings)
            warning = "  ⚠️  no replies received" if reply_chunks == 0 else ""
            print(f"[xml-pipeline] {len(xml_strings)} cmd(s): "
                  f"send={send_ms:.1f}ms  drain={drain_ms:.1f}ms  "
                  f"total={(send_ms + drain_ms):.1f}ms  "
                  f"({per_cmd:.1f} ms/cmd)  "
                  f"recv={reply_chunks} chunks, {reply_bytes:,} bytes"
                  f"{warning}")

    except Exception as e:
        print(f"XML pipelined commands failed: {e}")
        raise ConnectionError("Failed to communicate with HQPlayer") from e


# ==========================================================================
# QUEUE
# ==========================================================================
# PlaylistGet is expensive. HQPlayer includes a base64-encoded 1500x1500
# JPEG cover as the `picture` attribute of every PlaylistItem — a
# 30-track queue is roughly 25 MB per response.
#
# Two things make the queue view usable:
#
#   1. query_playlistget_lean parses the reply as a stream and clears
#      each item's element as soon as its useful attributes have been
#      copied out. Peak allocation is bounded by one item, not by the
#      total reply size.
#
#   2. get_queue_cached stores the parsed list and returns it on the
#      next request if HQPlayer still reports the same tracks_total.
#
# Invalidation sources:
#   * Explicit calls from every queue-mutating endpoint.
#   * _sync_queue_cache_with_status, run on every status poll.
# --------------------------------------------------------------------------

_queue_cache       = None    # list of track dicts, or None
_queue_cache_total = -1      # HQPlayer's tracks_total when the cache was filled
_queue_cache_lock  = threading.Lock()


def _invalidate_queue_cache():
    """Drop the cached queue. Safe to call when no cache exists."""
    global _queue_cache, _queue_cache_total
    with _queue_cache_lock:
        _queue_cache = None
        _queue_cache_total = -1


def _sync_queue_cache_with_status(status_data):
    """Drop the cache if HQPlayer reports a different queue length.

    Called on every successful status poll. The comparison is one
    integer under the lock, so the cost is negligible against a poll
    that already opens a socket to HQPlayer.
    """
    global _queue_cache, _queue_cache_total
    reported = status_data.get('tracks_total', 0)
    with _queue_cache_lock:
        if _queue_cache is not None and reported != _queue_cache_total:
            _queue_cache = None
            _queue_cache_total = -1


def query_playlistget_lean(timeout=30, idle_timeout=1.0):
    """Fetch HQPlayer's queue without holding the cover art in memory.

    Streams the reply through an XMLPullParser. Each PlaylistItem's
    five useful attributes are copied into a plain dict the moment
    the element closes, then the element is cleared. The 700 KB
    picture string becomes unreachable and its memory is reusable
    for the next item.

    Returns (tracks, complete).

      tracks   — list of dicts, one per PlaylistItem.
      complete — True when the reply ended via silence after data
                 (the normal case) or via a clean socket close. False
                 when the deadline fired mid-transfer, which means
                 the list is partial and must not be cached.

    HQPlayer does not terminate its PlaylistGet reply in any way
    this code can detect. There is no closing </PlaylistGet> tag on
    the wire, no FIN after the last item, and no newline separator.
    The socket simply goes quiet once the items have been written.
    Attempting to read until EOF blocks until the socket timeout.

    The exit condition is therefore silence: if no bytes have
    arrived for idle_timeout seconds and we've already received at
    least one byte, the reply is treated as complete. HQPlayer sends
    the whole response in a few seconds on this machine, so a
    two-second quiet period is a wide margin. The overall timeout
    parameter remains as a ceiling for the case where HQPlayer is
    slower than expected or never starts replying at all.
    """
    tracks = []
    complete = False
    timing = _XML_TIMING_ENABLED
    t0 = time.perf_counter() if timing else 0.0
    total_bytes = 0

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            # Each individual recv blocks for at most idle_timeout
            # seconds. The loop distinguishes "silence after we've
            # received something" (done) from "silence before we've
            # received anything" (still waiting).
            sock.settimeout(idle_timeout)
            sock.connect((HQPLAYER_HOST, HQPLAYER_PORT))
            sock.sendall(b'<?xml version="1.0" encoding="utf-8"?><PlaylistGet/>\n')

            parser = ET.XMLPullParser(['end'])
            deadline = time.time() + timeout

            while True:
                if time.time() >= deadline:
                    print(f"[queue] PlaylistGet timed out after {timeout}s "
                          f"({total_bytes:,} bytes, {len(tracks)} items)")
                    break

                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    # No data for idle_timeout seconds.
                    if total_bytes > 0:
                        # The stream went quiet after delivering data.
                        # HQPlayer is done; it just doesn't say so.
                        complete = True
                        break
                    # Nothing has arrived yet. HQPlayer may still be
                    # preparing the reply. Keep waiting until the
                    # overall deadline.
                    continue

                if not chunk:
                    # Socket closed cleanly. Rare with this server,
                    # but handled for completeness.
                    complete = True
                    break

                total_bytes += len(chunk)
                parser.feed(chunk)

                for event, elem in parser.read_events():
                    if event != 'end':
                        continue

                    if elem.tag == 'PlaylistItem':
                        tracks.append({
                            'uri':    elem.get('uri', ''),
                            'song':   elem.get('song', ''),
                            'artist': elem.get('artist', ''),
                            'album':  elem.get('album', ''),
                            'length': elem.get('length', ''),
                        })
                        elem.clear()

                    elif elem.tag == 'PlaylistGet':
                        # Root end tag. Present for small replies,
                        # apparently absent for large ones. Taking it
                        # as a definitive signal when it appears saves
                        # the 2-second idle wait.
                        complete = True

                if complete:
                    # Root end tag arrived in this chunk, or the
                    # socket closed mid-chunk. Either way the reply
                    # is over and there is nothing to wait for.
                    break

    except Exception as e:
        print(f"[queue] PlaylistGet failed: {e}")
        raise ConnectionError("Failed to communicate with HQPlayer") from e

    if timing:
        elapsed_ms = (time.perf_counter() - t0) * 1000
        status = "complete" if complete else "incomplete"
        print(f"[xml-query] PlaylistGet: {len(tracks)} items, "
              f"{total_bytes:,} bytes, {elapsed_ms:.0f} ms ({status})")

    return tracks, complete


def get_queue_cached(tracks_total):
    """Return HQPlayer's queue, using the cache when possible.

    A cache hit is an integer comparison under the lock — no socket,
    no parse, no allocation. A miss calls PlaylistGet outside the
    lock so a slow fetch doesn't block status polls.

    The cache key is the length of the list we actually parsed, not
    the caller's `tracks_total`. `tracks_total` comes from the last
    status poll, which runs once a second — right after a mutation,
    it's one generation stale. Keying on the stale value means the
    cache ends up labelled with the pre-mutation count while holding
    the post-mutation tracks, and the next request (with the fresh
    count) looks like a mismatch and forces a redundant PlaylistGet.

    Keying on the parsed length makes the label honest: the cache is
    valid exactly when HQPlayer's reported total matches the number
    of tracks we've cached.
    """
    global _queue_cache, _queue_cache_total

    with _queue_cache_lock:
        if _queue_cache is not None and _queue_cache_total == tracks_total:
            return _queue_cache

    tracks, complete = query_playlistget_lean()

    if complete:
        with _queue_cache_lock:
            _queue_cache = tracks
            _queue_cache_total = len(tracks)
    else:
        print(f"[queue] not caching partial result "
              f"({len(tracks)} items)")

    return tracks


# ==========================================================================
# PATH / STRING HELPERS
# ==========================================================================

def normalize_path(raw_path):
    """Convert a file:// URL from the frontend into a clean filesystem path."""
    path = raw_path or ''
    path = path.removeprefix('file://')
    path = unquote(path)

    if sys.platform == 'win32' and len(path) >= 3 and path[0] == '/' and path[2] == ':':
        path = path[1:]

    return path


def build_m3u8(paths):
    """Build an M3U8 playlist body for HQPlayer's PlaylistUpload command."""
    lines = ['#EXTM3U']
    for p in paths:
        lines.append(f'#EXTINF:-1,{os.path.basename(p)}')
        lines.append(p)
    return '\n'.join(lines) + '\n'


def read_json_body(handler):
    """Read and parse JSON body from a POST request.

    The body is capped at MAX_JSON_BODY_BYTES. Without a cap, a client
    that sends `Content-Length: 2147483647` makes `rfile.read(n)`
    allocate toward that size before any validation runs — a single
    request could exhaust the server's memory. Every request this
    server accepts is a small command payload (a handful of track
    paths, a script name), so 1 MB is orders of magnitude of headroom.
    """
    content_length = handler.headers.get('Content-Length')
    if not content_length:
        return {}

    try:
        length = int(content_length)
    except ValueError:
        return {}

    if length < 0:
        raise ValueError("Invalid Content-Length")
    if length > MAX_JSON_BODY_BYTES:
        raise ValueError(
            f"Request body too large (limit {MAX_JSON_BODY_BYTES} bytes)"
        )

    post_data = handler.rfile.read(length).decode('utf-8')
    if not post_data:
        return {}

    try:
        result = json.loads(post_data)
    except json.JSONDecodeError as e:
        raise ValueError("Invalid JSON payload") from e

    if not isinstance(result, dict):
        # ValueError rather than TypeError on purpose: do_POST maps
        # ValueError to 400 and everything else to 500, and a non-object
        # body is a client error.
        raise ValueError("JSON body must be an object")

    return result


def _get_int(data, key, default=None):
    """Fetch an integer from a parsed JSON body.

    json.loads produces None for a JSON null, and the two-argument
    .get(key, default) only substitutes the default when the key is
    *missing* — not when it is present and null. So
    int(data.get('track', 1)) raises TypeError on {"track": null},
    which do_POST's ValueError handler does not catch, and the
    request returns 500 instead of 400.

    This helper normalizes null to the default and converts the result,
    raising ValueError (mapped to 400) for anything non-numeric.
    """
    value = data.get(key, default)
    if value is None:
        value = default
    if value is None:
        raise ValueError(f"Missing '{key}'")
    try:
        return int(value)
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid '{key}': expected an integer") from e


def _get_float(data, key, default=None):
    """Same contract as _get_int, for floating-point fields."""
    value = data.get(key, default)
    if value is None:
        value = default
    if value is None:
        raise ValueError(f"Missing '{key}'")
    try:
        return float(value)
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid '{key}': expected a number") from e


def _is_within_allowed_roots(path):
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
            continue
    return False


# ==========================================================================
# WAVEFORM
# ==========================================================================

# Executor caps concurrent waveform decodes. Without this, N simultaneous
# requests would spawn N ffmpeg subprocesses — a real CPU stampede on the
# same machine that's running HQPlayer's DSP. Four gives headroom for the
# current track plus a couple of stale prefetches.
_waveform_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="Waveform"
)

# In-flight computations keyed by audio path. Deduplicates concurrent
# requests for the same file so the heavy work happens once and every
# caller waits on the same future.
_waveform_futures = {}
_waveform_lock = threading.Lock()


def load_audio_samples(audio_path, target_sr):
    """Decode any audio file to mono float32 at target_sr via ffmpeg."""
    cmd = [
        'ffmpeg', '-v', 'error',
        '-i', audio_path,
        '-ac', '1',
        '-ar', str(target_sr),
        '-f', 'f32le', '-'
    ]
    raw = subprocess.check_output(cmd)
    return np.frombuffer(raw, dtype=np.float32)


def _compute_waveform_uncached(audio_path):
    """The actual heavy lifting, separated for the executor."""
    y = load_audio_samples(audio_path, WAVEFORM_SAMPLE_RATE)
    duration = float(len(y) / WAVEFORM_SAMPLE_RATE)

    n = len(y)
    if n == 0:
        peaks_u8 = np.zeros(WAVEFORM_TARGET_POINTS, dtype=np.uint8)
    else:
        factor = max(1, n // WAVEFORM_TARGET_POINTS)
        usable = (n // factor) * factor

        if usable == 0:
            peaks = np.abs(y)
        else:
            peaks = np.abs(y[:usable]).reshape(-1, factor).max(axis=1)

        peak_max = float(peaks.max()) if len(peaks) else 0.0
        if peak_max > 0:
            peaks = peaks / peak_max

        peaks_u8 = (peaks * 255).astype(np.uint8)

        if len(peaks_u8) > WAVEFORM_TARGET_POINTS:
            peaks_u8 = peaks_u8[:WAVEFORM_TARGET_POINTS]
        elif len(peaks_u8) < WAVEFORM_TARGET_POINTS:
            peaks_u8 = np.pad(
                peaks_u8,
                (0, WAVEFORM_TARGET_POINTS - len(peaks_u8)),
                mode='edge'
            )

    return {
        "duration": duration,
        "points":   len(peaks_u8),
        "data":     peaks_u8.tolist()
    }


def analyze_waveform(audio_path):
    """Compute (and cache) a peak envelope for a track.

    Concurrent requests for the same file wait on a single shared future
    rather than each spawning their own ffmpeg subprocess.
    """
    try:
        mtime = int(os.path.getmtime(audio_path))
    except OSError as e:
        raise FileNotFoundError(audio_path) from e

    key = hashlib.sha1(f"{audio_path}|{mtime}".encode()).hexdigest()[:16]
    cache_file = os.path.join(WAVEFORM_CACHE_DIR, f"{key}.json")

    # Disk cache first — the common case after a track has been played.
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"[waveform] cache unreadable ({e}), recomputing "
                  f"{os.path.basename(audio_path)}")

    # Check-and-submit under a single lock hold. Releasing between the
    # check and the registration lets two threads both decide they're
    # the first, both submit futures, and both compute the same file.
    with _waveform_lock:
        existing = _waveform_futures.get(audio_path)
        if existing is not None:
            is_computer = False
            future = existing
        else:
            future = _waveform_executor.submit(
                _compute_waveform_uncached, audio_path
            )
            _waveform_futures[audio_path] = future
            is_computer = True

    try:
        result = future.result()
    finally:
        # Only the submitting thread owns cleanup. Waiters must not pop
        # the entry out from under a future other waiters may still be
        # attached to.
        if is_computer:
            with _waveform_lock:
                _waveform_futures.pop(audio_path, None)

    # Only the submitting thread writes the disk cache, and only on
    # success. If future.result() raised, we never reach here.
    if is_computer:
        tmp = cache_file + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(result, f)
        os.replace(tmp, cache_file)

    return result


def prune_waveform_cache(max_age_days=90):
    """Delete waveform cache files whose track hasn't been played in
    `max_age_days`.

    Ages on mtime rather than atime. Entries are written once and never
    rewritten, so an entry's mtime is the moment its track was last
    played — replaying a track produces the same key from the same
    source mtime, hits the existing cache file, and does not rewrite it.
    atime would be the semantically correct field, but it is unreliable
    in practice: most Linux filesystems default to relatime, which only
    updates it after a 24-hour window, and noatime mounts don't maintain
    it at all. A prune keyed on atime would either miss recent plays or
    delete the whole cache on a filesystem that never updates it.

    The cache grows unbounded as the user plays more tracks. Each entry
    is ~5 KB, so a 5,000-track library is ~25 MB — fine. At 50,000 it
    starts to matter. Running the prune in a background thread shortly
    after startup keeps it self-limiting without blocking the listener.

    Returns the number of files removed.
    """
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    try:
        for name in os.listdir(WAVEFORM_CACHE_DIR):
            if not name.endswith('.json'):
                continue
            path = os.path.join(WAVEFORM_CACHE_DIR, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
                    removed += 1
            except OSError:
                pass
    except OSError:
        pass
    return removed


# ==========================================================================
# FAVORITES
# ==========================================================================

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
    os.replace(tmp, FAVORITES_PATH)


# ==========================================================================
# STATUS
# ==========================================================================

# Cached result of parsing settings.xml's engine node. The file only
# changes when the user toggles DirectSDM or edits volume settings, so
# re-parsing on every status poll (once per second, per client) is pure
# waste. Keyed by mtime; a change to the file invalidates the cache.
#
# Stored as a single tuple rather than three dict keys so the write is
# atomic — a reader that grabs the reference sees a fully-consistent
# snapshot, never a new mtime paired with a stale availability flag.
# The lock serializes the check-parse-write cycle, which both prevents
# torn reads and stops N concurrent polls from each parsing the same
# file on a cold or invalidated cache.
_settings_engine_cache      = None      # (mtime, available, reason) or None
_settings_engine_cache_lock = threading.Lock()


def get_volume_availability():
    """Return (available, reason) based on the engine node in settings.xml.

    Cached by mtime. Falls back to (True, '') if the file is missing or
    unreadable — the frontend then leaves volume controls enabled, which
    is the safer default than disabling them on a transient error.

    The lock is held across the check-parse-write cycle. Holding it
    during the parse is deliberate: parsing is a few milliseconds even
    for a large settings.xml, and the alternative — releasing between
    check and parse — lets concurrent polls all miss and all parse the
    same file. The cache would still produce correct answers, but it
    would stop doing the work it exists to do.
    """
    global _settings_engine_cache

    try:
        mtime = os.path.getmtime(HQPLAYER_SETTINGS_PATH)
    except OSError:
        # File missing or unreadable. Return the safe default without
        # caching it — a transient error shouldn't freeze the answer
        # until the next mtime change.
        return True, ''

    with _settings_engine_cache_lock:
        cached = _settings_engine_cache
        if cached is not None and cached[0] == mtime:
            return cached[1], cached[2]

        available, reason = True, ''
        try:
            tree = ET.parse(HQPLAYER_SETTINGS_PATH)
            engine = tree.getroot().find('engine')
            if engine is not None:
                if engine.get('direct_sdm', '0') == '1':
                    available, reason = False, 'DirectSDM'
                elif engine.get('volume_fixed', '0') == '1':
                    available, reason = False, 'Fixed volume'
        except Exception as e:
            # A malformed or unreadable settings.xml must not disable
            # the volume controls — fall through with the safe default
            # and report why, once per mtime change.
            print(f"[status] could not read engine node from "
                  f"{HQPLAYER_SETTINGS_PATH}: {e}")

        # Single-name rebinding — atomic from the reader's point of
        # view. A reader that grabs `cached` at the top of a later call
        # sees either the previous tuple or this one, never a mix.
        _settings_engine_cache = (mtime, available, reason)
        return available, reason


def parse_status_element(elem):
    """Extract status data from a parsed <Status> XML element."""
    volume_available, volume_disabled_reason = get_volume_availability()

    status_data = {
        'state': {0: 'stopped', 1: 'paused', 2: 'playing'}.get(
            int(elem.get('state') or 0), 'stopped'
        ),
        'position': float(elem.get('position') or 0),
        'length': float(elem.get('length') or 0),
        'track': int(elem.get('track') or 1),
        'tracks_total': int(elem.get('tracks_total') or 0),
        'volume': float(elem.get('volume') or -100),
        'active_shaper': elem.get('active_shaper', ''),
        'active_mode': elem.get('active_mode', ''),
        'volume_available': volume_available,
        'volume_disabled_reason': volume_disabled_reason,
        'random': elem.get('random', '0'),
        'repeat': elem.get('repeat', '0'),
        'hqplayer_running': True,
        'transport_loaded': True
    }

    metadata = elem.find('metadata')
    if metadata is not None:
        status_data.update(metadata.attrib)
        if 'samplerate' in status_data:
            status_data['samplerate'] = int(status_data['samplerate'])
        if 'sdm' in status_data:
            status_data['sdm'] = str(status_data['sdm'])

    status_data.setdefault('song', '')
    status_data.setdefault('artist', '')
    status_data.setdefault('albumartist', '')
    status_data.setdefault('album', '')
    status_data.setdefault('samplerate', 0)
    status_data.setdefault('sdm', '0')

    return status_data


def get_native_status():
    """Query HQPlayer's XML API. Returns a status dict."""
    global _last_known_status

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            sock.connect((HQPLAYER_HOST, HQPLAYER_PORT))
            sock.sendall(b'<?xml version="1.0" encoding="utf-8"?><Status/>\n')

            parser = ET.XMLPullParser(['end'])

            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break

                try:
                    parser.feed(chunk)
                except ET.ParseError:
                    return {'error': 'Malformed XML response', 'hqplayer_running': True}

                for _event, elem in parser.read_events():
                    if elem.tag == 'Status':
                        result = parse_status_element(elem)

                        # Every successful status parse is an opportunity
                        # to detect that HQPlayer's queue changed outside
                        # of our own endpoints — for example, through
                        # HQPlayer's own UI. The comparison is one integer
                        # against the cached value, and it invalidates the
                        # cache before the client's next /api/queue call.
                        _sync_queue_cache_with_status(result)

                        if result.get('song') or result.get('album'):
                            _last_known_status = dict(result)
                            result['transport_loaded'] = True
                            return result

                        if _last_known_status:
                            cached = dict(_last_known_status)
                            cached['state'] = 'stopped'
                            cached['position'] = 0
                            cached['hqplayer_running'] = True
                            cached['transport_loaded'] = False
                            return cached

                        result['transport_loaded'] = False
                        return result

            return {'error': 'No Status element received', 'hqplayer_running': False}

    except OSError:
        if _last_known_status:
            cached = dict(_last_known_status)
            cached['state'] = 'stopped'
            cached['position'] = 0
            cached['hqplayer_running'] = False
            cached['transport_loaded'] = False
            return cached
        return {'error': 'Connection refused', 'hqplayer_running': False}

    except Exception as e:
        return {'error': str(e), 'hqplayer_running': True}


# ==========================================================================
# SERVER
# ==========================================================================

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    # ------------------------------------------------------------------
    # Static file routing — locked to APP_DIR
    # ------------------------------------------------------------------
    def translate_path(self, path):
        """Serve only files under APP_DIR, mapped through /{APP_FOLDER}/.

        Any request for a path outside that prefix returns /dev/null,
        which the base handler converts into a 404. This replaces the
        stock SimpleHTTPRequestHandler behaviour of serving everything
        under its `directory` argument — which, before this override,
        was the user's entire home directory.
        """
        clean  = unquote(urlparse(path).path)
        prefix = f'/{APP_FOLDER}/'

        if clean.startswith(prefix):
            rel = clean[len(prefix):]
        elif clean == f'/{APP_FOLDER}':
            rel = 'index.html'
        else:
            return os.devnull

        full = os.path.normpath(os.path.join(APP_DIR, rel))

        # Reject any traversal that escaped APP_DIR.
        try:
            if os.path.commonpath([full, str(APP_DIR)]) != str(APP_DIR):
                return os.devnull
        except ValueError:
            return os.devnull

        # Never serve dotfiles or dot-directories. APP_DIR is the repo
        # root, so this is what keeps /.git/ — config, objects, and the
        # full commit history — from being readable over HTTP. The app
        # has no dotfiles it legitimately serves: .api_token and
        # .gitignore are both server-side only.
        parts = Path(full).relative_to(APP_DIR).parts
        if any(part.startswith('.') for part in parts):
            return os.devnull

        return full

    # ------------------------------------------------------------------
    # Headers / preflight
    # ------------------------------------------------------------------
    def end_headers(self):
        # No CORS headers. The app is served from the same origin as
        # the API, so no preflight ever fires. Emitting
        # Access-Control-Allow-Origin: * only served to let any
        # website on the internet read this server's responses.
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------
    def _is_authorized(self):
        """Check the X-API-Token header against the configured token.

        compare_digest prevents a timing side-channel from leaking the
        token one byte at a time under repeated requests.
        """
        provided = self.headers.get('X-API-Token', '')
        if not provided:
            return False
        return secrets.compare_digest(provided, API_TOKEN)

    # ------------------------------------------------------------------
    # GET routing
    # ------------------------------------------------------------------
    def do_GET(self):
        parsed_path = urlparse(self.path)
        path = parsed_path.path

        # Gate /api/* before any routing branch runs. Static assets
        # stay open — the browser needs them to load the app and read
        # the injected token.
        if path.startswith('/api/') and not self._is_authorized():
            self.send_response(401)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"Unauthorized"}')
            return

        if path == '/api/status':
            status = get_native_status()
            try:
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(status).encode())
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if path == '/api/favorites':
            try:
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'albums': sorted(load_favorites())
                }).encode())
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if path == '/api/aliases':
            try:
                artist_aliases, composer_aliases = _get_aliases()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'artistAliases':   artist_aliases,
                    'composerAliases': composer_aliases,
                }).encode())
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if path == '/api/queue':
            self._handle_queue_get()
            return

        # library.xml lives under ~/.hqplayer/, which is outside the
        # APP_DIR tree the static handler serves. Expose exactly that
        # one file and nothing else under ROOT.
        if path == f'/{HQPLAYER_SETTINGS_DIR}/library.xml':
            library_file = os.path.join(ROOT, HQPLAYER_SETTINGS_DIR, 'library.xml')
            try:
                with open(library_file, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-type', 'text/xml; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except OSError:
                self.send_response(404)
                self.end_headers()
            return

        # Cover art. The frontend sends the complete absolute path,
        # URL-encoded, so there is no ambiguity about which base
        # directory to resolve against. The server validates the
        # resolved realpath against COVER_ROOTS and refuses anything
        # outside or any non-image extension.
        #
        # Served unauthenticated for the same reason as the JS and CSS:
        # the browser's image loader can't attach the X-API-Token
        # header, and cover art is not sensitive.
        #
        # Response body is streamed in COVER_CHUNK_BYTES chunks via
        # shutil.copyfileobj rather than read whole into memory. Peak
        # memory per request drops from image-size to one chunk,
        # regardless of how large the image is.
        if path.startswith('/files/'):
            rel = unquote(path[len('/files/'):])
            target = os.path.normpath('/' + rel)

            # Image extension gate first — the cheapest rejection.
            ext = os.path.splitext(target)[1].lower()
            if ext not in IMAGE_EXTS:
                self.send_response(403)
                self.end_headers()
                return

            # realpath collapses symlinks and macOS firmlinks to a
            # canonical form, so a cover reported as
            # /System/Volumes/Data/Users/… and a root of /Users/…
            # compare equal after normalization.
            try:
                resolved = os.path.realpath(target)
            except OSError:
                self.send_response(404)
                self.end_headers()
                return

            allowed = False
            for root in COVER_ROOTS:
                try:
                    if os.path.commonpath([resolved, root]) == root:
                        allowed = True
                        break
                except ValueError:
                    continue

            if not allowed:
                self.send_response(403)
                self.end_headers()
                return

            if not os.path.isfile(resolved):
                self.send_response(404)
                self.end_headers()
                return

            try:
                size = os.path.getsize(resolved)
            except OSError:
                self.send_response(404)
                self.end_headers()
                return

            ctype = MIME_BY_EXT.get(ext, 'application/octet-stream')
            self.send_response(200)
            self.send_header('Content-type', ctype)
            self.send_header('Content-Length', str(size))
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.end_headers()

            try:
                with open(resolved, 'rb') as f:
                    shutil.copyfileobj(f, self.wfile, COVER_CHUNK_BYTES)
            except (BrokenPipeError, ConnectionResetError, OSError):
                # Client went away mid-stream (navigated away, closed
                # the tab). Nothing to do — the file handle is closed
                # by the context manager, and the partial response is
                # the client's problem.
                pass
            return

        if path in ('/', '', '/index.html', f'/{APP_FOLDER}/', f'/{APP_FOLDER}'):
            self.send_response(302)
            self.send_header('Location', WEB_INDEX_URL)
            self.end_headers()
            return

        if path == WEB_INDEX_URL:
            try:
                # Cached reads — index.html and aliases.json are only
                # re-read after a server restart or an alias merge.
                html = _get_index_html()
                artist_aliases, composer_aliases = _get_aliases()

                frontend_cfg = dict(SETTINGS['frontend'])
                frontend_cfg['homePath']    = ROOT
                frontend_cfg['appName']     = APP_FOLDER
                frontend_cfg['hqplayerApp'] = HQPLAYER_APP
                frontend_cfg['assetBase']   = f'/{APP_FOLDER}/images'
                frontend_cfg['libraryUrl']  = f'/{HQPLAYER_SETTINGS_DIR}/library.xml'

                # Hand the API token to same-origin JS. The fetch patch
                # in config.js reads window.CONFIG.apiToken and attaches
                # it to every /api/* request.
                frontend_cfg['apiToken'] = API_TOKEN

                frontend_cfg['artistAliases']   = artist_aliases
                frontend_cfg['composerAliases'] = composer_aliases

                config_js = json.dumps(frontend_cfg, separators=(',', ':'))
                config_js = config_js.replace('</', '<\\/')

                # str.replace returns a new string; the cache is untouched.
                html = html.replace(
                    '</head>',
                    f'<script>window.CONFIG={config_js};</script>\n</head>',
                    1
                )

                self.send_response(200)
                self.send_header('Content-type', 'text/html; charset=utf-8')
                self.end_headers()
                self.wfile.write(html.encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode())
            return

        try:
            super().do_GET()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    # ------------------------------------------------------------------
    # POST routing
    # ------------------------------------------------------------------
    def do_POST(self):
        parsed_path = urlparse(self.path)
        path = parsed_path.path
        action = path.strip('/').split('/')[-1]

        # Gate /api/* before any routing branch runs.
        if path.startswith('/api/') and not self._is_authorized():
            self.send_response(401)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"Unauthorized"}')
            return

        try:
            # ---- Transport ----
            if action == 'play':
                send_xml_command('<Play/>')

            elif action == 'pause':
                send_xml_command('<Pause/>')

            elif action == 'stop':
                send_xml_command('<Stop/>')

            elif action == 'next':
                send_xml_command('<Next/>')

            elif action == 'prev':
                send_xml_command('<Previous/>')

            elif action == 'random':
                data = read_json_body(self)
                enabled = _get_int(data, 'enabled', 0)
                send_xml_command(f'<SetRandom value="{enabled}"/>')

            elif action == 'repeat':
                data = read_json_body(self)
                mode = _get_int(data, 'mode', 0)
                send_xml_command(f'<SetRepeat value="{mode}"/>')

            elif action == 'select':
                # SelectTrack followed immediately by Play. Two commands
                # whose order is load-bearing — pipelining preserves it
                # on a single socket and saves one round-trip.
                data = read_json_body(self)
                track_num = _get_int(data, 'track', 1)
                send_xml_commands_pipelined([
                    f'<SelectTrack index="{track_num}"/>',
                    '<Play/>',
                ])

            elif action == 'seek':
                data = read_json_body(self)
                seek_seconds = round(_get_float(data, 'time', 0))
                send_xml_command(f'<Seek position="{seek_seconds}"/>')

            elif action == 'volume':
                data = read_json_body(self)
                vol = _get_float(data, 'volume', -3.0)
                send_xml_command(f'<Volume value="{vol}"/>')

            elif action == 'mute':
                send_xml_command('<VolumeMute/>')

            elif action == 'load':
                self._handle_load()
                return

            elif action == 'queue-append':
                self._handle_queue_append()

            elif action == 'queue-move':
                self._handle_queue_move()

            elif action == 'queue-remove':
                self._handle_queue_remove()

            elif action == 'queue-clear':
                self._handle_queue_clear()

            # ---- HQPlayer app control (menu) ----
            elif action == 'launch':
                os_launch_app(HQPLAYER_APP)

            elif action == 'hqplayer-action':
                self._handle_hqplayer_action()

            elif action == 'run-script':
                self._handle_run_script()
                return

            # ---- Reveal / open ----
            elif action == 'reveal':
                data = read_json_body(self)
                folder = normalize_path(data.get('path', ''))

                if not folder or not os.path.isdir(folder):
                    raise ValueError("Folder not found")

                # Restrict to the allowed roots. Even with a valid
                # token, the frontend has no business opening arbitrary
                # paths on the server machine.
                if not _is_within_allowed_roots(folder):
                    raise ValueError("Path outside allowed roots")

                os_reveal(folder)

            # ---- Favorites ----
            elif action == 'favorite-set':
                data = read_json_body(self)
                hash_value = (data.get('hash') or '').strip()
                value = bool(data.get('value'))
                if not hash_value:
                    raise ValueError("Missing 'hash' parameter")

                # Read-modify-write under the lock. Without it, two
                # concurrent toggles on different hashes both load the
                # same snapshot and the second write silently discards
                # the first one's change.
                with _favorites_lock:
                    favs = load_favorites()
                    if value:
                        favs.add(hash_value)
                    else:
                        favs.discard(hash_value)
                    save_favorites(favs)

            # ---- Waveform ----
            elif action == 'waveform':
                self._handle_waveform()
                return

            # ---- Alias merge ----
            elif action == 'alias':
                data = read_json_body(self)
                field  = (data.get('field')  or '').strip()
                target = (data.get('target') or '').strip()
                source = (data.get('source') or '').strip()
                result = _merge_alias(field, target, source)

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'status': 'success',
                    **result,
                }).encode())
                return

            else:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b'Not Found')
                return

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'success'}).encode())

        except ValueError as e:
            try:
                self.send_response(400)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

        except Exception as e:
            try:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

    # ------------------------------------------------------------------
    # POST handlers (extracted for readability)
    # ------------------------------------------------------------------

    def _handle_hqplayer_action(self):
        """HQPlayer menu commands from the frontend."""
        data = read_json_body(self)
        cmd = data.get('command', '')

        if cmd == 'activate':
            os_launch_app(HQPLAYER_APP)

        elif cmd == 'reveal-settings':
            settings_dir = os.path.join(ROOT, HQPLAYER_SETTINGS_DIR)
            if not os.path.isdir(settings_dir):
                raise ValueError("Settings folder not found")
            os_open(settings_dir)

        elif cmd == 'reveal-library':
            library_file = os.path.join(ROOT, HQPLAYER_SETTINGS_DIR, 'library.xml')
            if not os.path.isfile(library_file):
                raise ValueError("library.xml not found")
            os_reveal(library_file)

        elif cmd == 'quit':
            os_quit_app(HQPLAYER_APP)

        else:
            raise ValueError(f"Unknown command: {cmd}")

    def _handle_run_script(self):
        """Run a whitelisted shell script and wait for it to finish.

        Sends its own response so it can return the script's stdout
        to the frontend. The caller in do_POST must return immediately
        after calling this.
        """
        data = read_json_body(self)
        name = (data.get('name') or '').strip()

        if not name:
            raise ValueError("Missing 'name' parameter")

        if name not in HQPLAYER_SCRIPTS:
            raise ValueError(f"Unknown script: {name}")

        script_path = os.path.expanduser(HQPLAYER_SCRIPTS[name])

        if not os.path.isabs(script_path):
            script_path = os.path.join(SCRIPTS_DIR, script_path)

        if not os.path.isfile(script_path):
            raise ValueError(f"Script not found: {script_path}")

        if not os.access(script_path, os.X_OK):
            raise ValueError(f"Script not executable: {script_path}")

        try:
            result = subprocess.run(
                ['/bin/bash', script_path],
                capture_output=True,
                timeout=60,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise ValueError("Script timed out after 60s") from e

        stdout = result.stdout.decode('utf-8', errors='replace').strip()
        stderr = result.stderr.decode('utf-8', errors='replace').strip()

        # Log to the server terminal so debugging is possible even when
        # the frontend only sees the summary.
        if stdout:
            print(f"[run-script:{name}] {stdout}")
        if stderr:
            print(f"[run-script:{name}] stderr: {stderr}")

        if result.returncode != 0:
            raise ValueError(
                f"Script failed (exit {result.returncode})"
                + (f": {stderr[:200]}" if stderr else "")
            )

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({
            'status': 'success',
            'output': stdout
        }).encode())

    def _handle_load(self):
        """Load an album into HQPlayer's transport.

        `mode` selects which of HQPlayer's two transport engines is used:

          'album' (default) — SetTransportPath for single-directory
                              albums. Gapless, but the resulting
                              transport cannot be appended to.
          'queue'           — PlaylistUpload. A track queue that
                              PlaylistAdd can extend.

        Multi-directory albums (disc folders) always use the queue
        path, since SetTransportPath cannot span directories.

        This method owns its HTTP response. The 'mode' field in that
        response reports the engine that was actually used, which
        differs from the requested mode whenever a multi-directory
        album was loaded with mode='album'. The client tracks this so
        a subsequent 'Add to Queue' doesn't issue a redundant
        transport switch.

        A load may replace HQPlayer's current queue (queue mode) or
        leave it alone (album mode). Either way, the cached queue is
        invalidated — it costs nothing to invalidate on an album load
        and it guarantees correctness on a queue load.

        Every track path is validated against the allowed roots before
        any command reaches HQPlayer. Without that check, a client
        with a valid token could hand HQPlayer an arbitrary filesystem
        path — /etc/passwd, another user's home directory — and
        observe whether the transport attempted to decode it.

        The start_track and seek_to conversions are null-safe
        (`None or 1` evaluates to 1), so unlike the other POST
        handlers they don't route through _get_int.

        Timing: after the transport is primed (upload or
        SetTransportPath), the trailing SelectTrack / Seek / Play
        sequence goes through send_xml_commands_pipelined. Those
        three commands depend on the primed state but not on each
        other's side effects beyond ordering, so batching them on one
        socket collapses three round-trips into one. The sleeps
        before each batch are genuine — HQPlayer needs a moment to
        register the upload or the transport path before SelectTrack
        can address it — so they stay.
        """
        data = read_json_body(self)
        tracks = data.get('tracks', [])
        start_track = int(data.get('start_track', 1) or 1)
        seek_to = int(data.get('seek_to', 0) or 0)
        mode = data.get('mode', 'album')

        # Default to the requested mode. Overwritten below once the
        # multi-directory heuristic has run, so the response always
        # reports what actually happened rather than what was asked for.
        effective_mode = mode

        # Reject an empty track list outright. The previous behaviour
        # fell through the `if tracks:` guard below and replied
        # {"status": "success"} without sending anything to HQPlayer —
        # the client then believed playback had started against a
        # transport that was never primed, and subsequent Play/Pause
        # commands went to whatever was previously loaded.
        #
        # The queue-append handler already raises on an empty list, so
        # this aligns load with it. A client that means "clear the
        # transport" should call /api/stop, not /api/load with nothing.
        if not tracks:
            raise ValueError("Missing 'tracks'")

        paths = [normalize_path(t.get('path', '')) for t in tracks]

        # Reject any path that resolves outside the allowed roots.
        # Done before the multi-directory check so an out-of-bounds
        # path fails fast with a clear error rather than after
        # attempting to compute unique_dirs.
        for p in paths:
            if not _is_within_allowed_roots(p):
                raise ValueError("Track path outside allowed roots")

        unique_dirs = list({os.path.dirname(p) for p in paths})

        if start_track < 1 or start_track > len(paths):
            start_track = 1

        use_playlist = (mode == 'queue') or (len(unique_dirs) > 1)
        effective_mode = 'queue' if use_playlist else 'album'

        # Commands shared by both branches once the transport is
        # primed. Built once, dispatched via the pipelined sender.
        def _post_load_commands():
            cmds = [f'<SelectTrack index="{start_track}"/>']
            if seek_to > 0:
                cmds.append(f'<Seek position="{seek_to}"/>')
            cmds.append('<Play/>')
            return cmds

        if use_playlist:
            send_xml_command('<PlaylistClear/>')

            m3u_content = build_m3u8(paths)
            # Only &, <, > need escaping in XML text content. Quotes
            # are special only inside attribute values, which this
            # isn't.
            safe_content = xml_escape(m3u_content)

            upload_cmd = (
                f'<PlaylistUpload filename="album_queue.m3u8">\n'
                f'{safe_content}'
                f'</PlaylistUpload>'
            )
            send_xml_command(upload_cmd)

            # HQPlayer registers the uploaded tracks asynchronously.
            # SelectTrack issued before that finishes addresses the
            # previous (now-cleared) queue and silently fails.
            time.sleep(0.5)

            send_xml_commands_pipelined(_post_load_commands())

        else:
            # SINGLE-DISC: SetTransportPath
            dir_path = unique_dirs[0]

            send_xml_command(
                f'<SetTransportPath value={quoteattr(dir_path)} freewheel="1"/>'
            )

            # Same reasoning as the upload sleep, but shorter: the
            # directory already exists in HQPlayer's library, so
            # there is no per-track registration to wait on.
            time.sleep(0.15)

            send_xml_commands_pipelined(_post_load_commands())

        # The old queue is unreachable after a queue-mode load and
        # possibly stale after an album-mode load. Either way, the
        # next /api/queue must fetch fresh.
        _invalidate_queue_cache()

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({
            'status': 'success',
            'mode':   effective_mode,
        }).encode())

    def _handle_queue_append(self):
        """Append tracks to HQPlayer's queue without interrupting playback.

        Collects every PlaylistAdd into a single batch and dispatches
        through send_xml_commands_pipelined. The sequential form of
        this loop took N × 320 ms for N tracks; the pipelined form
        takes roughly one poll tick regardless of N, because HQPlayer
        reads the batched commands together.

        A one-track append still falls through to send_xml_command in
        the pipelined helper — pipelining a single command adds the
        drain window without collapsing anything.

        Every track path is validated against the allowed roots before
        any command reaches HQPlayer — same reasoning as _handle_load.
        """
        data = read_json_body(self)
        tracks = data.get('tracks', [])

        if not tracks:
            raise ValueError("Missing 'tracks'")

        commands = []
        for t in tracks:
            path = normalize_path(t.get('path', ''))
            if not path:
                continue
            if not _is_within_allowed_roots(path):
                raise ValueError("Track path outside allowed roots")
            commands.append(f'<PlaylistAdd uri={quoteattr(path)} queued="0"/>')

        # The loop above skips entries whose `path` is empty or
        # whitespace. If every entry in the request was skipped, the
        # previous behaviour dispatched send_xml_commands_pipelined([])
        # — which is a documented no-op — and then replied
        # {"status": "success"}. The client showed "Added N tracks to
        # queue" for a batch that never touched HQPlayer.
        #
        # Failing loudly here means the client's error branch runs and
        # the user sees "Failed to add to queue" instead of a silent
        # no-op. The condition can only arise from a malformed request
        # (the frontend always sends a `path`), so treating it as a
        # client error is appropriate.
        if not commands:
            raise ValueError("No valid track paths to append")

        send_xml_commands_pipelined(commands)
        _invalidate_queue_cache()

    def _handle_queue_move(self):
        """Move a track within HQPlayer's queue.

        HQPlayer exposes only single-step moves — there is no direct
        "move from N to M" command. A move of distance d becomes d
        single-step commands, with the index tracking the moving
        track's current position:

          moving down:  index increments on each step
          moving up:    index decrements on each step

        The command sequence is dispatched through the pipelined
        sender so the batch arrives at HQPlayer in one write burst.
        Order matters here in a way it does not for PlaylistAdd: the
        commands are position-dependent, so if HQPlayer reorders them
        the queue ends up in the wrong state. Single-stream socket
        writes preserve order, so the sequence arrives intact.

        A distance-1 move is a single command and goes through
        send_xml_command — nothing to collapse.

        The queue is invalidated after a successful move so the next
        /api/queue returns the reordered list. The order changed but
        the length did not, so the tracks_total-based invalidation in
        get_native_status would not catch this on its own.
        """
        data = read_json_body(self)
        from_idx = _get_int(data, 'from', 0)
        to_idx   = _get_int(data, 'to', 0)

        if from_idx < 1 or to_idx < 1:
            raise ValueError("Invalid from/to indices")
        if from_idx == to_idx:
            return

        commands = []
        if to_idx > from_idx:
            for i in range(from_idx, to_idx):
                commands.append(f'<PlaylistMoveDown index="{i}"/>')
        else:
            for i in range(from_idx, to_idx, -1):
                commands.append(f'<PlaylistMoveUp index="{i}"/>')

        send_xml_commands_pipelined(commands)
        _invalidate_queue_cache()

    def _handle_queue_remove(self):
        """Remove a single track from HQPlayer's queue.

        PlaylistRemove takes a 1-based index. Removal shifts every
        subsequent entry down by one, so a caller removing multiple
        tracks must remove from highest index to lowest or re-fetch
        between removals. The client re-renders after each removal,
        which sidesteps the issue entirely.
        """
        data = read_json_body(self)
        index = _get_int(data, 'index', 0)

        if index < 1:
            raise ValueError("Invalid index")

        send_xml_command(f'<PlaylistRemove index="{index}"/>')
        _invalidate_queue_cache()

    def _handle_queue_clear(self):
        """Empty HQPlayer's queue.

        PlaylistClear has no arguments — it wipes the entire list.
        Playback stops; the transport is left empty. The client
        re-renders the queue view, which shows the empty state.
        """
        send_xml_command('<PlaylistClear/>')
        _invalidate_queue_cache()

    def _handle_queue_get(self):
        """Return HQPlayer's current queue as JSON.

        The tracks_total from the last successful status poll decides
        whether the cache is still valid. The status poll runs once
        per second per client, so the value is at most a second stale
        — good enough to detect any change that alters the queue
        length, without opening another socket to HQPlayer on the
        fast path.

        A cache miss means a full PlaylistGet, which takes a few
        seconds for a large queue. That is the cost of HQPlayer
        including the cover art on every item, not something the
        server can avoid.
        """
        status_total = (_last_known_status or {}).get('tracks_total', 0)

        try:
            tracks = get_queue_cached(status_total)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
            return

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'tracks': tracks}).encode())

    def _handle_waveform(self):
        """Compute and return a waveform envelope, or an error response.

        The requested path is validated against the allowed roots
        before it reaches ffmpeg. Without this check, a client with a
        valid token could ask the server to decode any file the server
        process can read — a path outside the music library would
        still be handed to ffmpeg, which would fail on non-audio
        input but would reveal file existence and, for audio, its
        duration.
        """
        data = read_json_body(self)
        audio_path = normalize_path(data.get('path', ''))

        if not audio_path or not _is_within_allowed_roots(audio_path):
            print(f"[waveform] 403 — path outside allowed roots: {audio_path}")
            self.send_response(403)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'error': 'Path outside allowed roots'
            }).encode())
            return

        if not _WAVEFORM_AVAILABLE:
            detail = []
            if _FFMPEG_ERROR:
                detail.append(_FFMPEG_ERROR)
            if _NUMPY_ERROR:
                detail.append(f"numpy: {_NUMPY_ERROR}")
            msg = '; '.join(detail) or 'waveform backend unavailable'
            print(f"[waveform] 503 — {msg}")
            self.send_response(503)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'error': msg,
                'hint': ('Install ffmpeg (brew install ffmpeg) '
                         'and numpy (pip3 install numpy)')
            }).encode())
            return

        if not os.path.isfile(audio_path):
            print(f"[waveform] 404 — file not found: {audio_path}")
            self.send_response(404)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Audio file not found'}).encode())
            return

        try:
            result = analyze_waveform(audio_path)
        except Exception as e:
            print(f"[waveform] 500 — {e}")
            traceback.print_exc()
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
            return

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def log_message(self, format, *args):
        pass


# ==========================================================================
# ENTRY POINT
# ==========================================================================

if __name__ == '__main__':
    print(f"🎵 {APP_FOLDER} server running at http://localhost:{HTTP_PORT}")
    print(f"   Settings: {SETTINGS_PATH}")
    print(f"   Aliases:  {ALIASES_PATH}")
    print(f"   Scripts:  {SCRIPTS_DIR}")
    print(f"   App root: {APP_DIR}")
    print(f"   Data root: {ROOT}")
    print("   Allowed roots:")
    for r in COVER_ROOTS:
        print(f"     - {r}")
    print(f"   Waveform cache: {WAVEFORM_CACHE_DIR}")
    print(f"   Favorites: {FAVORITES_PATH}")
    print(f"   API token: {API_TOKEN_PATH}")

    if HTTP_HOST not in ('127.0.0.1', 'localhost', '::1'):
        print(f"   ⚠️  Binding to {HTTP_HOST} — API is reachable on the network.")
        print("   ⚠️  Requests require the X-API-Token header.")
        print("   ⚠️  Do not commit .api_token; treat it like a password.")

    if HQPLAYER_SCRIPTS:
        print(f"   HQPlayer scripts: {', '.join(HQPLAYER_SCRIPTS.keys())}")

    if _FFMPEG_ERROR:
        print(f"   ⚠️  ffmpeg: {_FFMPEG_ERROR}")
    if _NUMPY_ERROR:
        print(f"   ⚠️  numpy: {_NUMPY_ERROR}")
    if not _WAVEFORM_AVAILABLE:
        print("   ⚠️  waveform endpoint will return 503 until both are installed")

    if _XML_TIMING_ENABLED:
        print("   ⏱  XML timing enabled (ROASTIN_XML_TIMING=1)")
        print("      Per-command timings will be printed to this log.")

    # Prune stale waveform cache entries off the critical path. The
    # scan is O(cache size) — one stat per file — and can block for
    # hundreds of milliseconds on a large cache. Running it on a
    # daemon thread lets the HTTP listener bind and accept requests
    # immediately.
    #
    # Safe to run concurrently with the request handlers:
    #   * The prune only removes files older than max_age_days. New
    #     writes are seconds old, so there is no overlap.
    #   * A handler that reads a file the pruner is about to delete
    #     sees either the complete file or no file at all — both
    #     paths are already handled by the cache-miss branch in
    #     analyze_waveform.
    #   * The thread is a daemon, so Ctrl-C kills it cleanly. A
    #     partial prune is idempotent — the next startup finishes
    #     the job.
    def _background_prune():
        pruned = prune_waveform_cache()
        if pruned:
            print(f"   Pruned {pruned} stale waveform cache file(s)")

    threading.Thread(
        target=_background_prune,
        name="WaveformPrune",
        daemon=True,
    ).start()

    ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), Handler).serve_forever()