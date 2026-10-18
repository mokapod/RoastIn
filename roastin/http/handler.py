"""The HTTP request handler: routing, auth, and static delivery.

Everything the client can reach passes through here. The routing is a
plain if/elif chain — there are ~25 endpoints and each one's guard is a
single comparison, so a dispatch table would add indirection without
removing any.

Auth model: static assets (HTML, CSS, JS, cover art) are served without
a token, because the browser's image loader and <script> tags cannot
attach headers. Everything under /api/ requires X-API-Token. The token
is injected into the page by the index handler, so same-origin JS has it
by the time it makes its first request.
"""
import json
import os
import shutil
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import unquote, urlparse

from .. import state
from ..config import (
    ALIASES_PATH,
    APP_DIR,
    APP_FOLDER,
    COVER_CHUNK_BYTES,
    COVER_ROOTS,
    HQPLAYER_APP,
    HQPLAYER_SETTINGS_DIR,
    IMAGE_EXTS,
    MIME_BY_EXT,
    ROOT,
    SETTINGS,
    WEB_INDEX_URL,
)
from ..hqplayer.client import send_xml_command, send_xml_commands_pipelined
from ..hqplayer.queue import invalidate_queue_cache
from ..library.aliases import merge_alias
from ..paths import is_within_allowed_roots, normalize_path
from ..platform import os_launch_app
from ..token import API_TOKEN
from . import actions
from .body import get_float, get_int, read_json_body
from .static import resolve_static_path


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    # ------------------------------------------------------------------
    # Immutable-ish file caches
    # ------------------------------------------------------------------
    # index.html and aliases.json are read on every page load. Neither
    # changes during normal operation — index.html not at all, and
    # aliases.json only when the user performs a merge. Caching them
    # eliminates two disk reads per page load.
    #
    # Invalidation:
    #   * index.html  — never. Restart the server to pick up edits.
    #   * aliases     — explicit call to invalidate_alias_cache() after
    #                   a successful merge.
    _index_html_cache = None
    _aliases_cache = None
    _cache_lock = threading.Lock()
    # One lock per JSON file. Each guards the read-modify-write cycle
    # that mutates that file. Readers that only look at the file (GET
    # /api/aliases, GET /api/favorites, the index injection) don't take
    # the lock: save_aliases and save_favorites both write via
    # os.replace, so a reader always sees either the complete old file
    # or the complete new one — never a partial write.
    _favorites_lock = threading.Lock()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    # ------------------------------------------------------------------
    # Cached reads
    # ------------------------------------------------------------------
    @classmethod
    def get_index_html(cls):
        with cls._cache_lock:
            if cls._index_html_cache is None:
                try:
                    cls._index_html_cache = APP_DIR.joinpath(
                        'index.html').read_text(encoding='utf-8')
                except OSError as e:
                    raise RuntimeError(f'Cannot read index.html: {e}') from e
            return cls._index_html_cache

    @classmethod
    def get_aliases(cls):
        with cls._cache_lock:
            if cls._aliases_cache is None:
                cls._aliases_cache = aliases_from_disk()
            return cls._aliases_cache

    @classmethod
    def invalidate_alias_cache(cls):
        with cls._cache_lock:
            cls._aliases_cache = None

    # ------------------------------------------------------------------
    # Static file routing — locked to APP_DIR
    # ------------------------------------------------------------------
    def translate_path(self, path):
        """Serve only files under APP_DIR, mapped through /{APP_FOLDER}/.

        Returns /dev/null for anything else, which the base handler
        turns into an empty 200. See roastin/http/static.py for the
        full rationale.
        """
        return resolve_static_path(path)

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
        import secrets
        provided = self.headers.get('X-API-Token', '')
        if not provided:
            return False
        return secrets.compare_digest(provided, API_TOKEN)

    def _read_body(self):
        return read_json_body(self)

    def _get_int(self, data, key, default=None):
        return get_int(data, key, default)

    def _get_float(self, data, key, default=None):
        return get_float(data, key, default)

    # ------------------------------------------------------------------
    # GET routing
    # ------------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path

        # Gate /api/* before any routing branch runs. Static assets
        # stay open — the browser needs them to load the app and read
        # the injected token.
        if path.startswith('/api/') and not self._is_authorized():
            self._unauthorized()
            return

        if self._route_get(path):
            return

        try:
            super().do_GET()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _route_get(self, path):
        """Handle one GET route. True if the request was answered."""
        if path == '/api/status':
            status = get_native_status()
            self._send_json(status, swallow_disconnect=True)
            return True

        if path == '/api/favorites':
            from ..library.favorites import load_favorites
            self._send_json({'albums': sorted(load_favorites())},
                            swallow_disconnect=True)
            return True

        if path == '/api/aliases':
            artist_aliases, composer_aliases = self.get_aliases()
            self._send_json({
                'artistAliases': artist_aliases,
                'composerAliases': composer_aliases,
            }, swallow_disconnect=True)
            return True

        if path == '/api/queue':
            actions.handle_queue_get(self)
            return True

        # library.xml lives under ~/.hqplayer/, which is outside the
        # APP_DIR tree the static handler serves. Expose exactly that
        # one file and nothing else under ROOT.
        if path == f'/{HQPLAYER_SETTINGS_DIR}/library.xml':
            self._serve_library_xml()
            return True

        if path.startswith('/files/'):
            self._serve_cover(path)
            return True

        if path in ('/', '', '/index.html', f'/{APP_FOLDER}/',
                    f'/{APP_FOLDER}'):
            self.send_response(302)
            self.send_header('Location', WEB_INDEX_URL)
            self.end_headers()
            return True

        if path == WEB_INDEX_URL:
            self._serve_index()
            return True

        return False

    def _serve_library_xml(self):
        library_file = os.path.join(ROOT, HQPLAYER_SETTINGS_DIR,
                                    'library.xml')
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

    def _serve_cover(self, path):
        """Serve cover art from the allowed roots.

        The frontend sends the complete absolute path, URL-encoded, so
        there is no ambiguity about which base directory to resolve
        against. The server validates the resolved realpath against
        COVER_ROOTS and refuses anything outside or any non-image
        extension.

        Served unauthenticated for the same reason as the JS and CSS:
        the browser's image loader can't attach the X-API-Token header,
        and cover art is not sensitive.

        Response body is streamed in COVER_CHUNK_BYTES chunks via
        shutil.copyfileobj rather than read whole into memory. Peak
        memory per request drops from image-size to one chunk,
        regardless of how large the image is.
        """
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
        # /System/Volumes/Data/Users/… and a root of /Users/… compare
        # equal after normalization.
        resolved = os.path.realpath(target)

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
            # Client went away mid-stream (navigated away, closed the
            # tab). Nothing to do — the file handle is closed by the
            # context manager, and the partial response is the
            # client's problem.
            pass

    def _serve_index(self):
        """Serve index.html with window.CONFIG injected before </head>."""
        try:
            # Cached reads — index.html and aliases.json are only
            # re-read after a server restart or an alias merge.
            html = self.get_index_html()
            artist_aliases, composer_aliases = self.get_aliases()

            frontend_cfg = dict(SETTINGS['frontend'])
            frontend_cfg['homePath'] = ROOT
            frontend_cfg['appName'] = APP_FOLDER
            frontend_cfg['hqplayerApp'] = HQPLAYER_APP
            frontend_cfg['assetBase'] = f'/{APP_FOLDER}/images'
            frontend_cfg['libraryUrl'] = \
                f'/{HQPLAYER_SETTINGS_DIR}/library.xml'

            # Hand the API token to same-origin JS. The fetch patch in
            # config.js reads window.CONFIG.apiToken and attaches it to
            # every /api/* request.
            frontend_cfg['apiToken'] = API_TOKEN

            frontend_cfg['artistAliases'] = artist_aliases
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

    # ------------------------------------------------------------------
    # POST routing
    # ------------------------------------------------------------------
    def do_POST(self):
        path = urlparse(self.path).path
        action = path.strip('/').split('/')[-1]

        # Gate /api/* before any routing branch runs.
        if path.startswith('/api/') and not self._is_authorized():
            self._unauthorized()
            return

        try:
            if self._route_post(action):
                return
            self._send_json({'status': 'success'})

        except ValueError as e:
            self._send_json({'error': str(e)}, status=400)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        except Exception as e:
            self._send_json({'error': str(e)}, status=500)

    def _route_post(self, action):
        """Handle one POST route.

        Returns True when the handler wrote its own response and the
        router must return immediately; False to let the router send
        the generic success reply.
        """
        # ---- Transport --------------------------------------------------
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
            data = self._read_body()
            enabled = self._get_int(data, 'enabled', 0)
            send_xml_command(f'<SetRandom value="{enabled}"/>')

        elif action == 'repeat':
            data = self._read_body()
            mode = self._get_int(data, 'mode', 0)
            send_xml_command(f'<SetRepeat value="{mode}"/>')

        elif action == 'select':
            # SelectTrack followed immediately by Play. Two commands
            # whose order is load-bearing — pipelining preserves it on
            # a single socket and saves one round-trip.
            data = self._read_body()
            track_num = self._get_int(data, 'track', 1)
            send_xml_commands_pipelined([
                f'<SelectTrack index="{track_num}"/>',
                '<Play/>',
            ])

        elif action == 'seek':
            data = self._read_body()
            seek_seconds = round(self._get_float(data, 'time', 0))
            send_xml_command(f'<Seek position="{seek_seconds}"/>')

        elif action == 'volume':
            data = self._read_body()
            vol = self._get_float(data, 'volume', -3.0)
            send_xml_command(f'<Volume value="{vol}"/>')

        elif action == 'mute':
            send_xml_command('<VolumeMute/>')

        # ---- Queue ------------------------------------------------------
        elif action == 'load':
            actions.handle_load(self)
            return True
        elif action == 'queue-append':
            actions.handle_queue_append(self)
        elif action == 'queue-move':
            actions.handle_queue_move(self)
        elif action == 'queue-remove':
            actions.handle_queue_remove(self)
        elif action == 'queue-clear':
            actions.handle_queue_clear(self)

        # ---- HQPlayer app control (menu) --------------------------------
        elif action == 'launch':
            os_launch_app(HQPLAYER_APP)
        elif action == 'hqplayer-action':
            actions.handle_hqplayer_action(self)
        elif action == 'run-script':
            actions.handle_run_script(self)
            return True

        # ---- Reveal / open ----------------------------------------------
        elif action == 'reveal':
            actions.reveal_folder(self)

        # ---- Favorites --------------------------------------------------
        elif action == 'favorite-set':
            actions.set_favorite(self, self._favorites_lock)

        # ---- Waveform ---------------------------------------------------
        elif action == 'waveform':
            from .. import waveform
            actions.handle_waveform(self, waveform)
            return True

        # ---- Alias merge ------------------------------------------------
        elif action == 'alias':
            data = self._read_body()
            field = (data.get('field') or '').strip()
            target = (data.get('target') or '').strip()
            source = (data.get('source') or '').strip()
            result = merge_alias(field, target, source,
                                 self.invalidate_alias_cache)
            self._send_json({'status': 'success', **result})
            return True

        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'Not Found')
            return True

        return False

    # ------------------------------------------------------------------
    # Response helpers
    # ------------------------------------------------------------------
    def _send_json(self, payload, status=200, swallow_disconnect=False):
        try:
            self.send_response(status)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
        except (BrokenPipeError, ConnectionResetError):
            if not swallow_disconnect:
                raise

    def _unauthorized(self):
        self.send_response(401)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"error":"Unauthorized"}')

    def log_message(self, format, *args):
        pass


# ----------------------------------------------------------------------
# Module-level helpers used by the handler
# ----------------------------------------------------------------------

def aliases_from_disk():
    """Lenient alias load — the read-only path used for page injection."""
    from ..library.aliases import load_aliases
    return load_aliases()


def get_native_status():
    """Late import: keeps the HTTP layer importable without HQPlayer."""
    from ..hqplayer.status import get_native_status as _get
    return _get()


# Re-exported for the entry point.
__all__ = [
    'Handler',
    'ThreadingHTTPServer',
    'aliases_from_disk',
    'get_native_status',
    'state',
    'invalidate_queue_cache',
    'normalize_path',
    'is_within_allowed_roots',
    'ALIASES_PATH',
]
