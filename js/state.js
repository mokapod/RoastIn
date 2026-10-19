// state.js
// Depends on: config
//
// Every mutable runtime value in the app. Grouped by concern so the
// relationships between variables are visible — grace periods sit
// together, history counters sit together, and so on.
//
// Everything here is module-scoped. No exports; consumers reference
// these names directly because all files share one global lexical
// scope via <script> tags.

/* ═══════════════════════════════════════════════════════════════════
   LIBRARY DATA
   ═══════════════════════════════════════════════════════════════════
   masterAlbums is the immutable source of truth — grouped and sorted
   once at load, then read-only. allAlbums is the current view: a
   filtered and re-sorted copy. Grid indices, playback lookups, and
   history all key off allAlbums; moreby.js and restore.js use
   masterAlbums because they need the full library.
   ────────────────────────────────────────────────────────────────── */

let masterAlbums = [];
let allAlbums    = [];

// The raw <directory> nodes from library.xml, kept alive so the album
// grouping can be re-run after an alias merge. A NodeList holds
// references to its nodes, so the parsed document stays in memory as
// long as this is set. That's ~a few MB for a large library — a fair
// price for being able to reaggregate without refetching.
let libraryDirectories = null;

/* ═══════════════════════════════════════════════════════════════════
   PLAYBACK
   ═══════════════════════════════════════════════════════════════════ */

// Current transport state. `album` is a reference into masterAlbums;
// `trackIndex` is the global index across all discs. `offset` plus
// `startTime` give the estimated position between status polls — the
// server's reported position takes over once it arrives.
let currentPlayback = {
  album: null,
  trackIndex: -1,
  isPlaying: false,
  duration: 0,
  startTime: 0,
  offset: 0
};

// Which album is displayed in the detail view. -1 when the grid is
// showing. Set by showAlbumDetail, cleared by showGridView.
let currentDetailAlbumIndex = -1;

// True while the queue view is showing. Set by showQueueView, cleared
// by showGridView. Checked by hotkeys to toggle.
let isQueueView = false;

// Snapshot of the view that was showing when queue view was opened.
// q-toggle uses it to restore the previous view (grid or detail)
// instead of always returning to the grid. Null when queue view is
// closed.
let queueReturnState = null;

// Set by the queue reorder path right after it issues SelectTrack for
// the track whose position the reorder changed. During the window
// that follows, this value takes precedence over the server's
// <Status track> in the poll's reconciliation and in
// updatePlayingTrackHighlight: HQPlayer's transport pointer can lag a
// poll or two behind a PlaylistMove + SelectTrack pair, and using the
// server's stale value would revert the highlight to the moved
// track's pre-move position.
//
// Cleared in status.js when the server reports the same position
// (client and server agree), or when the window expires.
let pendingQueueTrack = null;   // { pos, until } | null

// HQPlayer process state, refreshed by the status poll. `isLaunching`
// is set optimistically the moment a launch is requested, so the UI
// can show a spinner before the server confirms.
let isHQPlayerRunning   = false;
let isLaunchingHQPlayer = false;

// Consecutive status polls that have reported HQPlayer as not running.
// Used by updatePlaybackBarMode to debounce the "down" collapse — a
// single failed poll (Wi-Fi blip, HQPlayer busy, a socket timeout)
// shouldn't hide the whole bar for a second.
let hqplayerDownStreak = 0;

// Shuffle and repeat mirror the server's flags. toggles.js updates
// these optimistically; status.js reconciles them when the server's
// values arrive, gated by toggleGracePeriodUntil.
let shuffleOn  = false;
let repeatMode = 'off';   // 'off' | 'all' | 'one'

// Snapshot of the most recent /status response. Read by functions that
// need transport data but run outside the poll — progress.js for
// duration, transport.js for verifying playback started.
let lastStatus = null;

/* ═══════════════════════════════════════════════════════════════════
   PLAYBACK MODE
   ═══════════════════════════════════════════════════════════════════
   Which of HQPlayer's two transport engines the client last engaged.

     'album' — SetTransportPath. One album, gapless.
     'queue' — PlaylistUpload + PlaylistAdd. A track queue.
     null    — nothing loaded.

   Persisted to sessionStorage so a page reload within the same tab
   retains the mode. Without this, reload sets it to null, and the next
   drag-reorder hits the album-mode gate in queue.js on a real queue
   that is still loaded server-side.

   Tracked client-side only. Not authoritative — HQPlayer owns the real
   state — but accurate enough to decide whether adding to the queue
   requires a mode switch first, and to gate reordering on a transport
   where PlaylistMove is destructive.
   ────────────────────────────────────────────────────────────────── */
let playbackMode = sessionStorage.getItem('hqp.playbackMode') || null;

/* ═══════════════════════════════════════════════════════════════════
   GRACE PERIODS
   ═══════════════════════════════════════════════════════════════════
   Each of these is a timestamp — the moment after which the server's
   value is trusted again. While Date.now() is below the deadline, the
   status poll leaves the corresponding piece of local state alone, so
   an optimistic update isn't immediately clobbered by stale data.
   ────────────────────────────────────────────────────────────────── */

// Set after starting playback or switching tracks. HQPlayer takes a
// few seconds (especially for DSD) to report the new track, during
// which the poll would otherwise see the old one and revert the UI.
let loadGracePeriodUntil = 0;

// Set after a shuffle/repeat toggle. Long enough for the server to
// process the command and report the new value, short enough that a
// second click isn't blocked.
let toggleGracePeriodUntil = 0;

// Set after a play/pause command. Prevents the poll from overriding
// the optimistic isPlaying flip during the round-trip.
let transportGracePeriodUntil = 0;

// Set after a queue clear. HQPlayer's status endpoint can keep
// reporting the previously-playing track for a second or two after
// PlaylistClear, with transport_loaded: true. Without a grace
// period, restorePlaybackFromServer repopulates currentPlayback
// from that stale Status on the next poll, undoing the clear.
let clearGracePeriodUntil = 0;

// Set after a volume change or mute/unmute. Stops the poll from
// snapping the slider back to the previous volume before the server
// has applied the new one.
let volumeGracePeriodUntil = 0;

/* ═══════════════════════════════════════════════════════════════════
   PROGRESS SCRUBBING
   ═══════════════════════════════════════════════════════════════════ */

// True while the user is dragging the progress slider. Suppresses the
// poll's position updates so the thumb doesn't fight the drag.
let isDraggingProgress = false;

// Timestamp of the last seek. The poll ignores position updates for
// ~1.5s after a seek, since the server needs time to actually move.
let lastSeekTime = 0;

/* ═══════════════════════════════════════════════════════════════════
   SORT & SEARCH
   ═══════════════════════════════════════════════════════════════════ */

let currentSort = DEFAULT_SORT;   // 'artist' | 'title' | 'year'
const SORT_ORDER = ['artist', 'title', 'year'];   // cycle order for the sort button

// Search text changes immediately, while the debounced grid render may be
// deferred if a detail/queue view opens before the timer fires.
let currentSearchQuery = '';
let gridRenderPending = false;
// The query the grid was last actually rendered with. Null until the
// first render. popstate compares against this rather than the input
// value, because the input can hold a query whose render was cancelled
// or deferred.
let renderedSearchQuery = null;

// Roving-tabindex focus return. Only keyboard activation sets this, so
// mouse users are not unexpectedly focused when they return to the grid.
let lastKeyboardGridAlbumFolder = null;

// Debounce timer for the search input. Cleared before each new
// keystroke, so applyFiltersAndRender only runs once the user pauses.
let searchTimeout = null;

/* ═══════════════════════════════════════════════════════════════════
   VIEW STATE
   ═══════════════════════════════════════════════════════════════════ */

// Which top-level view is showing. Set true by showAlbumDetail, false
// by showGridView. Checked by hotkeys and search to decide whether a
// transition is needed.
let isDetailView = false;

// Scroll position to restore when returning from detail to grid. Kept
// in memory rather than trusting history.scrollRestoration, which is
// disabled in history.js.
let savedScrollPosition = 0;

// Saved scroll positions for detail views, keyed by album folder.
// Written by history.js when popstate takes us out of a detail view;
// read by views.js when popstate brings us back to that same album.
// Distinct from savedScrollPosition, which tracks the single grid view.
let detailScrollPositions = new Map();

/* ═══════════════════════════════════════════════════════════════════
   HISTORY TRACKING
   ═══════════════════════════════════════════════════════════════════
   The browser's history stack is opaque — no API exposes its depth or
   cursor. We tag each entry we push with its own index and mirror the
   browser's cursor here, so Back/Forward button enablement can be
   derived without querying the browser.
   ────────────────────────────────────────────────────────────────── */

let historyCursor = 0;   // index of the entry we're currently on
let historyMax    = 0;   // highest index ever pushed; no forward entries exist past this

/* ═══════════════════════════════════════════════════════════════════
   VOLUME
   ═══════════════════════════════════════════════════════════════════ */

// Mute is tracked separately from volume level so unmuting can restore
// the previous value rather than snapping to something arbitrary.
let isMuted = false;

// The percent to restore on unmute. Updated whenever a non-zero volume
// change is applied. Initial 95% matches a typical default.
let lastVolumePercent = 95;

/* ═══════════════════════════════════════════════════════════════════
   WAVEFORM
   ═══════════════════════════════════════════════════════════════════ */

// Current track's peak envelope, or null when nothing is loaded. The
// disk cache lives in waveform.js; this is the in-memory copy that
// paintWaveform reads.
let currentWaveform = null;

/* ═══════════════════════════════════════════════════════════════════
   FAVORITES
   ═══════════════════════════════════════════════════════════════════ */

// Set of favorited album hashes. Loaded from /favorites at bootstrap
// and mutated locally on each favorite-set click; the server is the
// source of truth on reload.
let favorites = new Set();