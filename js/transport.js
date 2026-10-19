// transport.js
// Depends on: config, state, dom, utils, library, views
//
// playbackMode is persisted to sessionStorage via the
// 'hqp.playbackMode' key. It survives a page reload within the same
// tab, so a user who reloads while a queue is loaded retains queue
// mode and can reorder without hitting the album-mode gate in
// queue.js. state.js reads the value on load; every write here
// mirrors the new value back. clearQueue is the only operation that
// removes the key, because it's the only operation that empties the
// server-side playlist.

/* ═══════════════════════════════════════════════════════════════════
   7. TRANSPORT — launch, play, pause, skip, select
   ═══════════════════════════════════════════════════════════════════ */

const LOAD_GRACE_MS = 6000;

function transportWasLost() {
  return (
    lastStatus &&
    lastStatus.hqplayer_running &&
    lastStatus.transport_loaded === false &&
    currentPlayback.album !== null
  );
}

let playbackVerifyToken = 0;
const PLAYBACK_FAIL_MSG = 'Playback did not start. Check your audio device.';

function cancelPlaybackVerify() {
  playbackVerifyToken++;
}

function getCurrentAlbumIndex() {
  if (!currentPlayback.album || !currentPlayback.album.folder) return -1;
  return allAlbums.findIndex(a => a.folder === currentPlayback.album.folder);
}

// Abandon an optimistic play that HQPlayer never confirmed. The client
// flips isPlaying=true before the command resolves so the transport
// feels instant; when the audio device is missing, HQPlayer never
// reports 'playing' and no transport frame is pushed to correct us, so
// the bar would otherwise keep advancing under a failure notification.
// `offset` still holds the position playback was resumed from — the
// play path only advanced startTime — so re-anchoring there rewinds the
// display to where the failed attempt began.
function haltPlaybackDisplay() {
  if (!currentPlayback.album) return;

  currentPlayback.isPlaying = false;
  anchorPosition(currentPlayback.offset, currentPlayback.duration);

  const length = currentPlayback.duration || 0;
  $progress.value = length > 0 ? (currentPlayback.offset / length) * 100 : 0;
  setTimeDisplay($pbTimeCurMin, $pbTimeCurSec, currentPlayback.offset || 0);
  updateSeekValueText(currentPlayback.offset || 0, length);
  paintWaveform(true);
  updatePlaybackUI();
}

async function verifyPlaybackStarted(targetTrackNumber) {
  const myToken = ++playbackVerifyToken;
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));

    if (myToken !== playbackVerifyToken) return;
    if (!lastStatus || !lastStatus.hqplayer_running) continue;

    if (lastStatus.state === 'playing'
        && (targetTrackNumber == null || lastStatus.track === targetTrackNumber)) {
      return;
    }
  }

  // HQPlayer never confirmed sound within the window. Stop believing
  // otherwise — without this the notification says playback failed
  // while isPlaying stays true and the bar keeps advancing.
  if (myToken !== playbackVerifyToken) return;
  haltPlaybackDisplay();
  showNotification(PLAYBACK_FAIL_MSG, true);
}

async function reloadCurrentAlbum() {
  const album = currentPlayback.album;
  if (!album) return false;

  const tracksToSend = album.tracks.map(t => ({
    name: t.node.getAttribute('song') || t.node.getAttribute('name'),
    path: `file://${t.node.parentNode.getAttribute('path')}/${t.node.getAttribute('name')}`
  }));

  const startTrackNumber = currentPlayback.trackIndex + 1;

  let resumeAt = 0;
  if (lastStatus && lastStatus.state === 'playing' && lastStatus.position > 0) {
    resumeAt = Math.floor(lastStatus.position);
  } else if (currentPlayback.isPlaying && currentPlayback.startTime) {
    const elapsed = (Date.now() - currentPlayback.startTime) / 1000;
    resumeAt = Math.floor((currentPlayback.offset || 0) + elapsed);
  } else {
    resumeAt = Math.floor(currentPlayback.offset || 0);
  }
  if (resumeAt < 3) resumeAt = 0;

  try {
    loadGracePeriodUntil = Date.now() + LOAD_GRACE_MS;
    const res = await fetch(`${API_BASE}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        album_name: album.baseName,
        tracks: tracksToSend,
        start_track: startTrackNumber,
        seek_to: resumeAt
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json().catch(() => ({}));
    playbackMode = data.mode || 'album';
    sessionStorage.setItem('hqp.playbackMode', playbackMode);

    currentPlayback.offset = resumeAt;
    currentPlayback.startTime = Date.now();
    currentPlayback.isPlaying = true;

    loadTrackIntoUI(currentPlayback.trackIndex, true);

    if (resumeAt > 0 && currentPlayback.duration > 0) {
      const percent = (resumeAt / currentPlayback.duration) * 100;
      $progress.value = percent;
      setTimeDisplay($pbTimeCurMin, $pbTimeCurSec, resumeAt);
    }

    updatePlaybackUI();
    updatePlayingTrackHighlight();
    verifyPlaybackStarted(startTrackNumber);
    return true;
  } catch (e) {
    showNotification('Failed to restore playback', true);
    return false;
  }
}

/* Fire-and-forget launch. Sends POST /api/launch and returns without
   waiting for HQPlayer to actually come up. Used by callers that only
   need the side effect — the HQPlayer menu button, and the transport
   paths where there's nothing to roll back if the launch fails.

   For callers that need HQPlayer to be running before they can
   proceed — playTrackInHQPlayer, addToQueue — use
   ensureHQPlayerRunning instead, which blocks until the launch is
   confirmed or fails. */
async function launchHQPlayer() {
  try {
    isLaunchingHQPlayer = true;
    if ($hqBtn) { $hqBtn.classList.remove('disconnected'); $hqBtn.classList.add('launching'); }
    const res = await fetch(`${API_BASE}/launch`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    isLaunchingHQPlayer = false;
    showNotification(`Failed to launch ${HQPLAYER_APP}`, true);
    if ($hqBtn) { $hqBtn.classList.remove('launching'); $hqBtn.classList.add('disconnected'); }
  }
}

/* Shared in-flight launch promise. If ensureHQPlayerRunning is
   called again while a launch is already in progress, the second
   caller gets the same promise rather than firing a second
   POST /api/launch and running its own polling loop. The variable is
   cleared in the finally block of the creating call, so a failed
   launch doesn't leave a resolved-but-stale promise in place. */
let hqplayerLaunchPromise = null;

/* Launch HQPlayer if it isn't already running, and wait for the
   status poll to confirm it came up. Returns true on success, false
   if the launch request failed or HQPlayer didn't report running
   within HQPLAYER_LAUNCH_TIMEOUT_SEC seconds.

   Extracted from two call sites that were doing the same thing with
   slightly different failure handling — the previous
   launchHQPlayerAndWait, and the inline branch in
   playTrackInHQPlayer. The launch logic itself is caller-independent;
   what differs is what happens after a failure, and that stays with
   each caller. */
async function ensureHQPlayerRunning() {
  if (isHQPlayerRunning) return true;
  if (hqplayerLaunchPromise) return hqplayerLaunchPromise;

  hqplayerLaunchPromise = (async () => {
    const alreadyLaunching = isLaunchingHQPlayer;
    isLaunchingHQPlayer = true;
    if ($hqBtn) {
      $hqBtn.classList.remove('disconnected');
      $hqBtn.classList.add('launching');
    }
    if (!alreadyLaunching) {
      showNotification(`Launching ${HQPLAYER_APP}...`);
    }

    try {
      const res = await fetch(`${API_BASE}/launch`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      showNotification(`Failed to launch ${HQPLAYER_APP}`, true);
      isLaunchingHQPlayer = false;
      if ($hqBtn) {
        $hqBtn.classList.remove('launching');
        $hqBtn.classList.add('disconnected');
      }
      return false;
    }

    let attempts = 0;
    while (!isHQPlayerRunning && attempts < HQPLAYER_LAUNCH_TIMEOUT_SEC) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    if (!isHQPlayerRunning) {
      showNotification(`${HQPLAYER_APP} failed to start.`, true);
      isLaunchingHQPlayer = false;
      if ($hqBtn) {
        $hqBtn.classList.remove('launching');
        $hqBtn.classList.add('disconnected');
      }
      return false;
    }

    isLaunchingHQPlayer = false;
    return true;
  })();

  try {
    return await hqplayerLaunchPromise;
  } finally {
    hqplayerLaunchPromise = null;
  }
}

function tryLocalSkip(delta) {
  // In queue mode, HQPlayer owns the queue order. Advancing within the
  // current album's track list would send SelectTrack with an
  // album-relative index, which after a reorder points at a different
  // track than the one the album list names. Let HQPlayer's <Next/>
  // handle it: it advances to the next item in the queue, which is the
  // order the queue view is showing.
  if (playbackMode === 'queue') return false;

  if (!currentPlayback.album || currentPlayback.trackIndex < 0) return false;
  if (shuffleOn) return false;

  const totalTracks = currentPlayback.album.tracks.length;
  const nextIndex = currentPlayback.trackIndex + delta;

  if (nextIndex < 0 || nextIndex >= totalTracks) return false;

  const albumIndex = getCurrentAlbumIndex();
  if (albumIndex === -1) return false;

  playTrackInHQPlayer(albumIndex, nextIndex);
  return true;
}

async function sendCommand(action) {
  if (action === 'pause' || action === 'stop') cancelPlaybackVerify();

  if (!isHQPlayerRunning && ['play', 'next', 'prev'].includes(action) && currentPlayback.album) {
    const albumIndex = findOrRevealAlbum(currentPlayback.album.folder);
    if (albumIndex !== -1) {
      let targetIndex = currentPlayback.trackIndex;
      if (action === 'next') {
        targetIndex = Math.min(targetIndex + 1, currentPlayback.album.tracks.length - 1);
      } else if (action === 'prev') {
        targetIndex = Math.max(targetIndex - 1, 0);
      }

      if (action !== 'play' && targetIndex === currentPlayback.trackIndex) {
        await launchHQPlayer();
        return;
      }

      await playTrackInHQPlayer(albumIndex, targetIndex);
      return;
    }
  }

  const transportActions = ['play', 'pause', 'next', 'prev', 'stop'];
  if (transportActions.includes(action) && transportWasLost()) {
    const ok = await reloadCurrentAlbum();
    if (!ok) return;
    if (action === 'play') return;
  }

  try {
    const res = await fetch(`${API_BASE}/${action}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (action === 'stop') {
      currentPlayback.isPlaying = false;
      currentPlayback.offset = 0;
      // playbackMode is deliberately NOT reset here. HQPlayer's Stop
      // halts playback but leaves the playlist intact; nulling the
      // mode would route the next addToQueue through the seed-then-
      // append branch, which does a PlaylistClear under the hood and
      // wipes the surviving queue. clearQueue is the operation that
      // legitimately nulls this — and removes the sessionStorage key —
      // because it's the operation that actually empties the
      // server-side playlist.
      $progress.value = 0;
      setTimeDisplay($pbTimeCurMin, $pbTimeCurSec, 0);
      updateSeekValueText(0, currentPlayback.duration || 0);
      anchorPosition(0, currentPlayback.duration);
      paintWaveform(true);
    } else if (action === 'play') {
      transportGracePeriodUntil = Date.now() + 1500;
      currentPlayback.isPlaying = true;
      currentPlayback.startTime = Date.now();
      verifyPlaybackStarted(currentPlayback.trackIndex + 1);
    } else if (action === 'pause') {
      transportGracePeriodUntil = Date.now() + 1500;
      currentPlayback.isPlaying = false;
      currentPlayback.offset += (Date.now() - currentPlayback.startTime) / 1000;
    }

    updatePlaybackUI();
    updatePlayingTrackHighlight();
  } catch (e) {
    showNotification('Failed to send command', true);
  }
}

function loadTrackIntoUI(trackIndex, preserveOffset = false) {
  const track = getTrackByIndex(currentPlayback.album, trackIndex);
  if (!track) return;

  if (!preserveOffset) {
    currentPlayback.duration = parseInt(track.getAttribute('length')) || 0;
    currentPlayback.offset = 0;
    currentPlayback.startTime = Date.now();
    setTimeDisplay($pbTimeCurMin, $pbTimeCurSec, 0);
    $progress.value = 0;
  }

  $pbTimeTot.textContent = formatTime(currentPlayback.duration);
  updateSeekValueText(currentPlayback.offset || 0, currentPlayback.duration);
  anchorPosition(currentPlayback.offset, currentPlayback.duration);
}

async function togglePlayPause() {
  if (!isHQPlayerRunning) {
    if (currentPlayback.album) {
      const albumIndex = getCurrentAlbumIndex();
      if (albumIndex !== -1) {
        await playTrackInHQPlayer(albumIndex, currentPlayback.trackIndex);
        return;
      }
    }
    await launchHQPlayer();
    return;
  }

  if (transportWasLost()) {
    await reloadCurrentAlbum();
    return;
  }

  const action = currentPlayback.isPlaying ? 'pause' : 'play';
  if (action === 'pause') cancelPlaybackVerify();

  try {
    const res = await fetch(`${API_BASE}/${action}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    transportGracePeriodUntil = Date.now() + 1500;

    if (action === 'pause') {
      currentPlayback.isPlaying = false;
      currentPlayback.offset += (Date.now() - currentPlayback.startTime) / 1000;
    } else {
      currentPlayback.isPlaying = true;
      currentPlayback.startTime = Date.now();
      verifyPlaybackStarted(currentPlayback.trackIndex + 1);
    }
    updatePlaybackUI();
    updatePlayingTrackHighlight();
  } catch (e) {
    showNotification('Failed to send command', true);
  }
}

function restorePlaybackState(previous) {
  currentPlayback = previous;
  if (currentPlayback.album) {
    loadTrackIntoUI(currentPlayback.trackIndex, true);
    updatePlaybackUI();
    updatePlayingTrackHighlight();
  } else {
    $playbackBar.classList.remove('active');
  }
}

// Album identity. Two rips of the same title/artist in different
// folders are distinct albums and must not be conflated — grouping
// already includes folder in the map key.
function isSameAlbum(a, b) {
  return !!a && !!b && a.folder === b.folder;
}

async function playTrackInHQPlayer(albumIndex, trackIndex) {
  const album = allAlbums[albumIndex];
  const startTrackNumber = trackIndex + 1;
  const isSameAlbumResult = isSameAlbum(currentPlayback.album, album);

  if (!isHQPlayerRunning) {
    const previousPlayback = { ...currentPlayback };

    // Optimistic UI: show the target track in the playback bar
    // before the launch confirms, so the click feels immediate.
    // If the launch fails, restorePlaybackState undoes this.
    currentPlayback = { album: album, trackIndex: trackIndex, isPlaying: false, duration: 0, startTime: Date.now(), offset: 0 };
    loadTrackIntoUI(trackIndex);
    updatePlaybackUI();

    const launched = await ensureHQPlayerRunning();
    if (!launched) {
      restorePlaybackState(previousPlayback);
      return;
    }
  }

  if (isSameAlbumResult && !transportWasLost()) {
    const previousTrackIndex = currentPlayback.trackIndex;
    const previousIsPlaying  = currentPlayback.isPlaying;

    try {
      loadGracePeriodUntil = Date.now() + LOAD_GRACE_MS;
      currentPlayback.trackIndex = trackIndex;
      currentPlayback.isPlaying = true;
      loadTrackIntoUI(trackIndex);
      updatePlaybackUI();
      updatePlayingTrackHighlight();

      const res = await fetch(`${API_BASE}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: startTrackNumber })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      verifyPlaybackStarted(startTrackNumber);

      const t = album.tracks[trackIndex]?.node;
      if (t) {
        const dir = t.parentNode.getAttribute('path');
        const name = t.getAttribute('name');
        loadWaveform(`${dir}/${name}`);
      }
    } catch (error) {
      currentPlayback.trackIndex = previousTrackIndex;
      currentPlayback.isPlaying  = previousIsPlaying;
      loadTrackIntoUI(previousTrackIndex, true);
      updatePlaybackUI();
      updatePlayingTrackHighlight();
      showNotification('Failed to select track', true);
    }
    return;
  }

  const tracksToSend = album.tracks.map(t => ({
    name: t.node.getAttribute('song') || t.node.getAttribute('name'),
    path: `file://${t.node.parentNode.getAttribute('path')}/${t.node.getAttribute('name')}`
  }));

  const previousPlayback = { ...currentPlayback };

  currentPlayback = { album: album, trackIndex: trackIndex, isPlaying: true, duration: 0, startTime: Date.now(), offset: 0 };
  loadTrackIntoUI(trackIndex);
  updatePlaybackUI();
  updatePlayingTrackHighlight();

  const t = album.tracks[trackIndex]?.node;
  if (t) {
    const dir = t.parentNode.getAttribute('path');
    const name = t.getAttribute('name');
    loadWaveform(`${dir}/${name}`);
  }

  try {
    loadGracePeriodUntil = Date.now() + LOAD_GRACE_MS;
    const res = await fetch(`${API_BASE}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album_name: album.baseName, tracks: tracksToSend, start_track: startTrackNumber })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json().catch(() => ({}));
    playbackMode = data.mode || 'album';
    sessionStorage.setItem('hqp.playbackMode', playbackMode);

    fetchStatus();
    verifyPlaybackStarted(startTrackNumber);
  } catch (error) {
    showNotification('Failed to load album.', true);
    restorePlaybackState(previousPlayback);
  }
}

/* ── Queue ── */

async function addToQueue(albumIndex, trackIndex) {
  const album = allAlbums[albumIndex];
  if (!album) return;

  if (!isHQPlayerRunning) {
    const launched = await ensureHQPlayerRunning();
    if (!launched) return;
  }

  const newTracks = trackIndex !== null
    ? [album.tracks[trackIndex]]
    : album.tracks;

  const newTracksSend = newTracks.map(t => ({
    path: `file://${t.node.parentNode.getAttribute('path')}/${t.node.getAttribute('name')}`
  }));

  const count = newTracks.length;
  const countLabel = `${count} track${count === 1 ? '' : 's'}`;

  try {
    // ── Already in queue mode: append only ──
    if (playbackMode === 'queue') {
      const res = await fetch(`${API_BASE}/queue-append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: newTracksSend })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      showNotification(`Added ${countLabel} to queue`);
      return;
    }

    // ── Not in queue mode, but something is playing: seed then append ──
    if (currentPlayback.album) {
      const seedAlbum = currentPlayback.album;

      const seedTracks = seedAlbum.tracks.map(t => ({
        path: `file://${t.node.parentNode.getAttribute('path')}/${t.node.getAttribute('name')}`
      }));

      const elapsed = currentPlayback.isPlaying
        ? (Date.now() - currentPlayback.startTime) / 1000
        : 0;
      let seekTo = Math.floor((currentPlayback.offset || 0) + elapsed);
      if (seekTo < 3) seekTo = 0;

      // Suppress the status poll's currentPlayback mutations until the
      // seed-and-append sequence completes.
      loadGracePeriodUntil = Date.now() + LOAD_GRACE_MS;

      const seedRes = await fetch(`${API_BASE}/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          album_name: seedAlbum.baseName,
          tracks: seedTracks,
          start_track: currentPlayback.trackIndex + 1,
          seek_to: seekTo,
          mode: 'queue'
        })
      });
      if (!seedRes.ok) throw new Error(`HTTP ${seedRes.status}`);

      const appendRes = await fetch(`${API_BASE}/queue-append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: newTracksSend })
      });
      if (!appendRes.ok) throw new Error(`HTTP ${appendRes.status}`);

      // The seed replaced the transport with the current album under a
      // PlaylistUpload, so the client is now in queue mode. Persist the
      // flag so a page reload retains it — otherwise the next drop
      // would hit the album-mode gate in queue.js.
      playbackMode = 'queue';
      sessionStorage.setItem('hqp.playbackMode', 'queue');

      showNotification(`Added ${countLabel} to queue`);
      return;
    }

    // ── Nothing playing: start a fresh queue ──
    const res = await fetch(`${API_BASE}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        album_name: album.baseName,
        tracks: newTracksSend,
        start_track: 1,
        mode: 'queue'
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    playbackMode = 'queue';
    sessionStorage.setItem('hqp.playbackMode', 'queue');

    currentPlayback = {
      album,
      trackIndex: trackIndex ?? 0,
      isPlaying: true,
      duration: 0,
      startTime: Date.now(),
      offset: 0
    };
    loadTrackIntoUI(trackIndex ?? 0);
    updatePlaybackUI();
    updatePlayingTrackHighlight();

    loadGracePeriodUntil = Date.now() + LOAD_GRACE_MS;
    verifyPlaybackStarted(1);
    showNotification(`Started queue with ${countLabel}`);
  } catch (e) {
    showNotification('Failed to add to queue', true);
  }
}

let currentDetailPlayState = null;

function syncDetailPlayButton() {
  if (!isDetailView || currentDetailAlbumIndex === -1) return;

  const playBtn = $detailContent.querySelector('.album-play-btn');
  if (!playBtn) return;

  const album = allAlbums[currentDetailAlbumIndex];
  const isThisAlbum = isSameAlbum(currentPlayback.album, album);
  const isPlaying = isThisAlbum && currentPlayback.isPlaying;

  // The icon and label only change on a state transition. Rebuilding the
  // SVG subtree on every transport frame is pure parse work, and this
  // button is off-screen for most of a listening session.
  if (isPlaying === currentDetailPlayState) return;
  currentDetailPlayState = isPlaying;

  const iconSvg = playBtn.querySelector('svg');

  if (isPlaying) {
    iconSvg.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    playBtn.classList.add('is-playing');
    playBtn.setAttribute('aria-label', 'Pause album');
  } else {
    iconSvg.innerHTML = '<path d="M8 5v14l11-7z"/>';
    playBtn.classList.remove('is-playing');
    playBtn.setAttribute('aria-label', 'Play album');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   PLAYBACK BAR MODE
   ═══════════════════════════════════════════════════════════════════
   Choose which of three modes the playback bar displays:

     full    — HQPlayer running, viewing anything other than the
               playing album. Cover/title/artist on the left,
               transport and progress in the middle, the pipeline /
               HQPlayer / volume group on the right.

     compact — HQPlayer running, and the album on screen is the one
               playing. The left and right columns are redundant
               with the page, so the bar reduces to just the transport
               and progress.

     down    — HQPlayer not running. Everything except the HQPlayer
               button is hidden; the button is the only element on
               the bar that can still do something useful.

   The mode is a class on $playbackBar; the CSS decides what each
   mode looks like.

   The "down" transition is debounced — a single failed poll doesn't
   collapse the bar. The streak counter lives in state.js and is
   incremented by status.js on every poll where HQPlayer is
   unreachable.
   ────────────────────────────────────────────────────────────────── */

const HQPLAYER_DOWN_THRESHOLD = 3;

function updatePlaybackBarMode() {
  if (!$playbackBar) return;

  const wasDown = $playbackBar.classList.contains('is-hqplayer-down');
  const wasNowPlayingView = $playbackBar.classList.contains('is-now-playing-view');
  const isDown = !isHQPlayerRunning
    && hqplayerDownStreak >= HQPLAYER_DOWN_THRESHOLD;

  let isNowPlayingView = false;
  if (!isDown) {
    // Compact mode — the album on screen is the one playing. Only
    // applied on mobile, where the bar is otherwise reduced to a
    // single play/pause button and the compact form restores the
    // transport row and the progress slider. On desktop the full
    // bar is always shown, so the class is not applied there.
    const isMobile = window.innerWidth <= 768;
    const album = isMobile && isDetailView && currentDetailAlbumIndex !== -1
      ? allAlbums[currentDetailAlbumIndex]
      : null;

    isNowPlayingView = isSameAlbum(album, currentPlayback.album);
  }

  $playbackBar.classList.toggle('is-hqplayer-down', isDown);
  $playbackBar.classList.toggle('is-now-playing-view', isNowPlayingView);

  // The canvas geometry only changes when a mode class changes. Avoid a
  // forced layout read and full repaint on status frames that leave the
  // bar in the same mode.
  const modeChanged = wasDown !== isDown
    || wasNowPlayingView !== isNowPlayingView;
  if (modeChanged && typeof scheduleWaveformRepaint === 'function') {
    scheduleWaveformRepaint();
  }
}

let currentPlayPauseIcon = null;

function updatePlaybackUI() {
  if (currentPlayback.album) {
    $playbackBar.classList.add('active');

    if (currentPlayback.album.coverUrl) {
      $pbImg.style.display = '';
      $pbImg.src = currentPlayback.album.coverUrl;
    } else {
      $pbImg.style.display = 'none';
      $pbImg.removeAttribute('src');
    }

    const currentTrack = getTrackByIndex(currentPlayback.album, currentPlayback.trackIndex);
    $pbTitle.textContent = currentTrack ? (currentTrack.getAttribute('song') || currentTrack.getAttribute('name')) : 'Unknown Track';
    $pbArtist.textContent = currentPlayback.album.artist;

    const playPauseIcon = currentPlayback.isPlaying ? 'pause' : 'play';
    if (playPauseIcon !== currentPlayPauseIcon) {
      currentPlayPauseIcon = playPauseIcon;
      $playPause.innerHTML = playPauseIcon === 'pause'
        ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
        : '<path d="M8 5v14l11-7z"/>';
      if ($pbPlayPauseBtn) {
        $pbPlayPauseBtn.setAttribute(
          'aria-label', playPauseIcon === 'pause' ? 'Pause' : 'Play');
      }
    }
  } else {
    $playbackBar.classList.remove('active');
    currentPlayPauseIcon = null;
  }

  syncDetailPlayButton();
  updatePlaybackBarMode();
}

function getTotalTracksInAlbum(album) {
  return album ? album.tracks.length : 0;
}

function getTrackByIndex(album, globalIndex) {
  if (!album || globalIndex < 0 || globalIndex >= album.tracks.length) return null;
  return album.tracks[globalIndex].node;
}

let highlightedTrackEl  = null;
let highlightedStateKey = null;

function updatePlayingTrackHighlight() {
  const album = currentPlayback.album;

  const stateKey = album
    ? `${album.folder}|${currentPlayback.trackIndex}|${currentPlayback.isPlaying}`
    : null;

  // ── Queue view highlighting ──
  // Queue tracks use data-queue-index (1-based, matches lastStatus.track)
  // instead of data-album-folder/data-track-index.
  if (isQueueView) {
    $queueContent.querySelectorAll('.track').forEach(el => {
      el.classList.remove('playing', 'paused');
      el.removeAttribute('aria-current');
    });
    if (lastStatus && lastStatus.track) {
      const currentQueueTrack = $queueContent.querySelector(
        `.track[data-queue-index="${lastStatus.track}"]`
      );
      if (currentQueueTrack) {
        currentQueueTrack.classList.add('playing');
        currentQueueTrack.setAttribute('aria-current', 'true');
        if (!currentPlayback.isPlaying) {
          currentQueueTrack.classList.add('paused');
        }
      }
    }
    return;
  }

  // ── Album detail view highlighting (existing logic) ──
  if (stateKey === highlightedStateKey
      && highlightedTrackEl
      && highlightedTrackEl.isConnected) {
    return;
  }

  // Clear the previously highlighted element directly. Only one row
  // in the album-detail DOM ever carries .playing / .paused — both
  // classes are set exclusively by this function, and only on the
  // row it just highlighted. A direct reference is equivalent to the
  // document-wide query that used to run here, without traversing
  // the whole document to remove classes from at most one element.
  //
  // If the element has been detached (a fresh showAlbumDetail
  // replaced the tracklist), the remove is a no-op and there is
  // nothing to clear in the live DOM — the class existed only on the
  // old, discarded element.
  if (highlightedTrackEl) {
    highlightedTrackEl.classList.remove('playing', 'paused');
    highlightedTrackEl.removeAttribute('aria-current');
  }

  highlightedTrackEl  = null;
  highlightedStateKey = stateKey;

  if (!album) return;

  const folder     = album.folder;
  const trackIndex = String(currentPlayback.trackIndex);

  // Scope to the detail view: the queue branch above already handles its
  // own rows, and a document-wide scan mixes the two lists.
  const trackElement = $detailContent.querySelector(
    `.track[data-album-folder="${CSS.escape(folder)}"][data-track-index="${trackIndex}"]`
  );

  if (!trackElement) return;

  trackElement.classList.add('playing');
  trackElement.setAttribute('aria-current', 'true');

  if (!currentPlayback.isPlaying) {
    trackElement.classList.add('paused');
  }

  highlightedTrackEl = trackElement;
}