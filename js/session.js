// session.js
// Depends on: config, state, dom, utils, library, views, transport, waveform, queue, restore
//
// Durable playback intent + aggressive auto-resume.
//
// RoastIn is the session owner; HQPlayer is a replaceable playback engine.
// This module persists what the user WANTS RoastIn to restore (album or
// queue, track, position, desired state) to the server's
// .playback_session.json, and on boot re-drives HQPlayer from that intent
// whenever HQPlayer is not already showing the same thing.
//
// The durable file (not sessionStorage, not in-memory state) survives
// RoastIn restarts, browser restarts, and tab closes. An explicit
// Stop/Clear is itself a persisted intent (intent 'empty'), so a stale
// HQPlayer reply can never resurrect a transport the user cleared.

/* ═══════════════════════════════════════════════════════════════════
   SESSION FRAME
   ═══════════════════════════════════════════════════════════════════ */

// The last state we persisted. Kept so we never write the identical frame
// twice (every save is a JSON body + disk write).
let lastSavedSession = null;
let lastSavedSessionKey = null;
let lastSessionSaveAt = 0;

function encodePath(raw) {
  // Store plain absolute paths in the durable session; the server
  // rejects anything outside COVER_ROOTS on restore. Rejects empties.
  if (!raw) return '';
  let p = raw;
  try { p = decodeURIComponent(p); } catch (e) { /* keep raw */ }
  return p.replace(/^file:\/\/([^/]*)/, '');
}

function currentTrackNode() {
  if (!currentPlayback.album) return null;
  return getTrackByIndex(currentPlayback.album, currentPlayback.trackIndex);
}

function queueSnapshot() {
  // The durable queue records raw paths + names so a queue-mode session
  // can be rebuilt even after HQPlayer loses its transport (PlaylistUpload
  // is the only way HQP restores a queue — it has no restore of its own).
  return lastKnownQueue.map(t => ({
    path: encodePath(t.uri || ''),
    name: t.song || t.artist || ''
  })).filter(t => t.path);
}

async function refreshSessionQueue() {
  if (playbackMode !== 'queue') return;
  const tracks = await syncQueueFromServer();
  if (tracks) lastKnownQueue = tracks;
}

function sessionFrame(intent) {
  const track = currentTrackNode();
  const isPlaying = intent === 'playing' && currentPlayback.isPlaying;
  const elapsed = isPlaying && currentPlayback.startTime
    ? (Date.now() - currentPlayback.startTime) / 1000
    : 0;
  const frame = {
    version: 1,
    known: true,
    intent,
    mode: intent === 'empty' ? null : (playbackMode === 'queue' ? 'queue' : 'album'),
    album: intent === 'empty' ? null : (currentPlayback.album ? {
      folder: currentPlayback.album.folder,
      baseName: currentPlayback.album.baseName,
      artist: currentPlayback.album.artist || ''
    } : null),
    track: intent === 'empty' ? null : (track ? {
      path: encodePath(
        `${track.parentNode.getAttribute('path') || ''}/${track.getAttribute('name') || ''}`
      ),
      name: track.getAttribute('song') || track.getAttribute('name') || ''
    } : null),
    position: Math.max(0, Math.round(
      (currentPlayback.offset || 0) + elapsed
    )),
    duration: currentPlayback.duration || 0,
    queue: queueSnapshot(),
    updated_at: Date.now(),
  };
  return frame;
}

/* Persist the current intent. Fire-and-forget; failures are logged once
   and otherwise silent — a lost save means a stale-but-safe previous
   snapshot, never corruption. */
function saveSession(intent) {
  if (!currentPlayback.album && intent !== 'empty') return;
  const frame = sessionFrame(intent);
  const body = JSON.stringify(frame);
  const now = Date.now();
  const compareFrame = { ...frame, updated_at: 0 };
  const compareKey = JSON.stringify(compareFrame);

  // Polls can observe the same paused/stopped state repeatedly. Avoid
  // rewriting the durable file for identical state, and rate-limit
  // playing checkpoints to one write per 30 seconds. updated_at is
  // deliberately excluded from the equality key.
  if (compareKey === lastSavedSessionKey
      || (intent === 'playing' && now - lastSessionSaveAt < 30000)) {
    return;
  }
  lastSavedSession = frame;
  lastSavedSessionKey = compareKey;
  lastSessionSaveAt = now;
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 5000);
    fetch(`${API_BASE}/playback-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
      keepalive: true
    })
      .then(() => { if (timer) clearTimeout(timer); })
      .catch((err) => {
        console.warn('[session] save failed — prior snapshot remains valid:', err);
        if (timer) clearTimeout(timer);
      });
  } catch (e) {
    if (timer) clearTimeout(timer);
  }
}

// Periodic checkpoint while actually playing, so a crash loses at most a
// few seconds of position — not the whole session.
let checkpointTimer = null;
let sessionBootRecoveryDone = false;

function startCheckpointing() {
  if (checkpointTimer) return;
  checkpointTimer = setInterval(() => {
    if (currentPlayback.isPlaying && currentPlayback.album) {
      saveSession('playing');
    }
  }, 30000);
}

/* Called on every meaningful transport change (load, play, pause, seek,
   track switch). If HQPlayer is alive and paused/stopped we persist that
   intent; if playing, persist 'playing'. */
function persistSessionForState() {
  if (!currentPlayback.album) return;
  const state = (lastStatus && lastStatus.state) || '';
  if (state === 'playing') {
    saveSession('playing');
  } else if (state === 'paused' || state === 'stopped') {
    // A user-triggered stop is persisted as 'empty' by the stop hook; here
    // (poll-driven pause) it just records the current paused/stopped frame.
    saveSession('stopped');
  } else {
    saveSession('paused');
  }
}

function sessionStoreUrl() {
  return `${API_BASE}/playback-session`;
}

async function fetchStoredSession() {
  try {
    const res = await fetch(sessionStoreUrl());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('[session] could not read stored session:', e);
    return null;
  }
}

function makeEncodedUrl(path) {
  const segments = String(path || '').split('/').map(seg => encodeURIComponent(seg));
  const encoded = segments.join('/');
  return `file://${encoded}`;
}

/* Boot-time recovery: load the durable intent, then reconcile against
   HQPlayer's live status. */
async function attemptRecovery() {
  const stored = await fetchStoredSession();
  if (!stored || !stored.known || stored.intent === 'empty') return;

  // The stream may not have delivered its first frame yet. A one-shot
  // status read makes the decision below authoritative: adopt a live
  // transport if HQPlayer already has one, otherwise recover the durable
  // RoastIn session.
  if (!lastStatus) await fetchStatus();

  // If HQPlayer is already running with a loaded transport, do nothing —
  // adopted live state wins; the poll/restore path owns the UI. This is
  // the "RoastIn restarted, HQP still alive with the same track" case.
  if (lastStatus && lastStatus.hqplayer_running && lastStatus.transport_loaded) {
    return;
  }

  // HQPlayer is a replaceable engine. If it is down, launch it and wait
  // for the status broker to confirm it before issuing load commands.
  if (!isHQPlayerRunning) {
    const launched = await ensureHQPlayerRunning();
    if (!launched) return;
  }

  // HQPlayer has nothing loaded (or is paused with an empty transport).
  // Rebuild the session.
  const folder = stored.album?.folder;
  if (!folder) return;
  const albumIndex = findOrRevealAlbum(folder);
  if (albumIndex === -1) return;

  const albumTracks = allAlbums[albumIndex]
    ? allAlbums[albumIndex].tracks.map((t) => ({
        name: t.node.getAttribute('song') || t.node.getAttribute('name'),
        path: encodePath(
          `${t.node.parentNode.getAttribute('path')}/${t.node.getAttribute('name')}`
        ),
      }))
    : [];
  const tracks = stored.mode === 'queue' && stored.queue?.length
    ? stored.queue
    : albumTracks;

  if (stored.mode === 'queue' && stored.queue?.length) {
    // Seed the in-memory resolver before the first status frame/save.
    // Otherwise the recovered queue would be immediately persisted as an
    // empty queue before the user opens the queue view.
    lastKnownQueue = stored.queue.map((item) => ({
      uri: item.path,
      song: item.name || '',
      artist: '',
      album: '',
      length: '',
    }));
  }

  if (!tracks.length) return;

  const wanted = stored.track?.path ? normalizeFileUri(stored.track.path) : '';
  let trackIndex = 0;
  if (wanted) {
    const idx = tracks.findIndex((t) => normalizeFileUri(t.path) === wanted);
    if (idx !== -1) trackIndex = idx;
  }

  // The UI album track index is independent from a queue position. Resolve
  // the saved URI back into the library album so the playback bar can show
  // the right cover/title even when the queue was rebuilt.
  let albumTrackIndex = allAlbums[albumIndex].tracks.findIndex((t) => {
    const path = `${t.node.parentNode.getAttribute('path') || ''}/${t.node.getAttribute('name') || ''}`;
    return wanted && normalizeFileUri(path) === wanted;
  });
  if (albumTrackIndex < 0) albumTrackIndex = 0;

  // A paused or stopped session is primed without autoplay. A stopped
  // session receives an explicit Stop after priming so its intent is not
  // accidentally converted into paused by HQPlayer's SelectTrack behavior.
  const shouldPlay = stored.intent === 'playing';
  const shouldStop = stored.intent === 'stopped';
  const body = JSON.stringify({
    album_name: allAlbums[albumIndex].baseName,
    tracks,
    start_track: trackIndex + 1,
    seek_to: stored.position || 0,
    mode: stored.mode || 'album',
    play: shouldPlay,
  });

  try {
    loadGracePeriodUntil = Date.now() + LOAD_GRACE_MS;
    const res = await fetch(`${API_BASE}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    playbackMode = data.mode || stored.mode || 'album';
    sessionStorage.setItem('hqp.playbackMode', playbackMode);

    // Adopt the reconstructed session so restore/restore.js doesn't clobber it.
    currentPlayback = {
      album: allAlbums[albumIndex],
      trackIndex: albumTrackIndex,
      isPlaying: shouldPlay,
      duration: stored.duration || 0,
      startTime: shouldPlay ? Date.now() : 0,
      offset: stored.position || 0,
    };
    loadTrackIntoUI(albumTrackIndex, true);
    anchorPosition(stored.position || 0, stored.duration || 0);
    updatePlaybackUI();
    updatePlayingTrackHighlight();
    if (shouldStop) {
      await fetch(`${API_BASE}/stop`, { method: 'POST' });
    }
    fetchStatus();
  } catch (e) {
    // A failed recovery leaves the stored session intact for the next boot.
    // The poll will keep reporting an empty transport until the user acts.
    console.warn('[session] recovery failed — stored session kept for next boot:', e);
  }
}

/* Public: called by the transport/queue hooks after they've mutated the
   intended state. Persists that intent immediately. */
function persistSessionIntent(intent) {
  saveSession(intent);
}

function persistObservedStatus(data) {
  // Never turn a transient outage or a genuinely empty transport into a
  // new durable intent. Only a live, loaded HQPlayer status can update the
  // session from observation.
  if (!data || !data.hqplayer_running || data.transport_loaded === false) return;
  if (!currentPlayback.album) return;

  if (data.state === 'playing') saveSession('playing');
  else if (data.state === 'paused') saveSession('paused');
  else if (data.state === 'stopped') saveSession('stopped');
}

// Immediate hookup. The library must be loaded before any recovery can
// resolve album paths — bootstrap calls loadLibrary() at script load, and
// addSessionHooks is invoked from that promise chain once masterAlbums is
// built.
let sessionReady = false;
function markSessionReady() {
  sessionReady = true;
  startCheckpointing();
}

async function startSessionRecovery() {
  if (sessionBootRecoveryDone) return;
  sessionBootRecoveryDone = true;
  markSessionReady();
  await attemptRecovery();
}

/* ── SAVE HOOKS FROM CALLERS ──
   transport.js:
     - after a successful /load, /play, /pause, /stop, /seek, or a queue
       mutation, call persistSessionIntent('playing' | 'paused' | 'empty')
   Callers reach in directly since all files share one global scope. */
