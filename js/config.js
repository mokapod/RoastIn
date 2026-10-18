// config.js
// Depends on: (none — must load first)
//
// window.CONFIG is injected by server.py into index.html just before
// </head>. If it's missing, the page was served incorrectly (e.g.
// opened directly from disk) and none of the app's network calls,
// paths, or numeric settings can be resolved. Fail loudly rather
// than scatter undefined values through the rest of the codebase.

if (!window.CONFIG) {
  throw new Error(
    'window.CONFIG is missing. This page must be served by server.py — ' +
    'opening index.html directly from disk is not supported.'
  );
}

const CONFIG = window.CONFIG;

/* ═══════════════════════════════════════════════════════════════════
   IDENTITY
   ═══════════════════════════════════════════════════════════════════ */

const APP_NAME     = CONFIG.appName;
const HQPLAYER_APP = CONFIG.hqplayerApp;

document.title = `${APP_NAME} Library`;
console.log(`✅ ${APP_NAME} Script Loaded Successfully`);

/* ═══════════════════════════════════════════════════════════════════
   ENDPOINTS & TIMING
   ═══════════════════════════════════════════════════════════════════ */

const ASSET_BASE       = CONFIG.assetBase;
const API_BASE         = CONFIG.apiBase;
const LIBRARY_URL      = CONFIG.libraryUrl;

const DEFAULT_SORT     = CONFIG.defaultSort;
const SEARCH_DEBOUNCE_MS       = CONFIG.searchDebounceMs;
const NOTIFICATION_DURATION_MS = CONFIG.notificationDurationMs;
const HQPLAYER_LAUNCH_TIMEOUT_SEC = CONFIG.hqplayerLaunchTimeoutSec;

/* ═══════════════════════════════════════════════════════════════════
   OPTIONAL SETTINGS
   ═══════════════════════════════════════════════════════════════════
   These have meaningful defaults and are safe to omit from
   settings.json.
   ────────────────────────────────────────────────────────────────── */

const WATERMARK = CONFIG.watermark ?? '音';

/* ═══════════════════════════════════════════════════════════════════
   WAVEFORM
   ═══════════════════════════════════════════════════════════════════ */

const WAVEFORM_CONFIG = {
  style:  CONFIG.waveform.style,
  bars:   CONFIG.waveform.bars,
  colors: CONFIG.waveform.colors,
};

/* ═══════════════════════════════════════════════════════════════════
   VOLUME
   ═══════════════════════════════════════════════════════════════════ */

const VOLUME_MIN_DB   = CONFIG.volume.minDb;
const VOLUME_MAX_DB   = CONFIG.volume.maxDb;
const VOLUME_STEP_DB  = CONFIG.volume.stepDb;
const VOLUME_RANGE_DB = VOLUME_MAX_DB - VOLUME_MIN_DB;

/* ═══════════════════════════════════════════════════════════════════
   API AUTHENTICATION
   ═══════════════════════════════════════════════════════════════════
   Every /api/* request must carry the X-API-Token header. Rather
   than touch ~30 fetch call sites, patch window.fetch once to add
   the header automatically when the URL targets the API.
   ────────────────────────────────────────────────────────────────── */

const API_TOKEN = CONFIG.apiToken || '';

if (API_TOKEN) {
  const nativeFetch = window.fetch.bind(window);

  // Match the API prefix as a *path segment*, not as a character
  // prefix. `startsWith('/api')` also matches '/api-status',
  // '/apix', and anything else that happens to begin with those
  // four characters — any such URL would receive the X-API-Token
  // header, which is both a small information leak (the token is
  // sent to a path that isn't the API) and a latent correctness bug
  // if a non-API endpoint ever ends up served under such a path.
  //
  // The API prefix is used in exactly two forms in this codebase:
  // the bare prefix followed by a slash ('/api/status', '/api/queue',
  // …), and never as a bare word. So the check is: the URL must be
  // exactly API_BASE, or must start with API_BASE + '/'.
  //
  // The equality branch is included for completeness even though
  // nothing currently fetches the bare prefix. If a future endpoint
  // is served at '/api' itself, the token should still be attached.
  const API_PREFIX = API_BASE + '/';

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;

    if (typeof url === 'string'
        && (url === API_BASE || url.startsWith(API_PREFIX))) {
      init = init || {};
      // Headers constructor accepts either a plain object, an array
      // of [name, value] pairs, or an existing Headers instance.
      // Object.assign would silently drop everything if callers ever
      // pass a Headers object, since Headers doesn't expose its
      // entries as own enumerable properties.
      const headers = new Headers(init.headers || {});
      headers.set('X-API-Token', API_TOKEN);
      init.headers = headers;
    }

    return nativeFetch(input, init);
  };
}