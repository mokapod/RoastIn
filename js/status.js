// status.js
// Depends on: config, state, dom, utils, library, views, transport, volume, toggles, waveform, restore

/* ═══════════════════════════════════════════════════════════════════
   14. STATUS POLLING
   ═══════════════════════════════════════════════════════════════════ */

// Cached values to skip redundant work between polls. These shadow what
// the DOM already holds; the DOM remains the source of truth, but these
// let the poll short-circuit writes when nothing has changed.
//
// Note: after a drag or seek in progress.js, $progress.value is written
// directly without touching lastProgressPercent. The cache is stale
// until the next poll past the seek grace, which means one extra write
// on the poll after a drag. The threshold is small enough that this is
// invisible — the wrong reference still usually lands on the same
// decision, and the one extra write costs nothing.
let lastProgressPercent    = -1;
let lastShownVolumePercent = -1;

// Transport state applied from a pushed frame. Frames are per-group:
// 'transport' carries song/album/state/track/..., 'flags' carries
// volume/random/repeat/..., and 'heartbeat' carries only position.
// Each is merged into lastStatus (declared in state.js) and then the
// whole thing is applied, so a flags-only frame still sees the current
// transport fields.

// Live stream handle. Null until connected, and null again whenever the
// tab is hidden or the connection drops.
let statusStream = null;

// Position anchor: the server's last reported position and when we
// received it. Between heartbeats the UI coasts on its own clock, so a
// 30 s heartbeat interval still yields a smoothly advancing bar.
let positionAnchor = { position: 0, length: 0, at: 0 };

// Generation token. Every (re)connect bumps this so a frame arriving
// from a superseded connection cannot overwrite fresher state.
let streamGeneration = 0;

// Last queue position observed in queue mode. Used to detect track
// changes in the queue, where data.track is a queue position rather
// than an album track index. The two coincide in album mode, so this
// is only consulted when playbackMode === 'queue'.
let lastSeenQueuePosition = null;

/* ── Stream lifecycle ──
   One EventSource per tab. The browser reconnects automatically on
   drop (the server sends `retry: 2000`), so there is no manual retry
   loop here. We only manage the two cases EventSource does not:
   the tab going hidden (close it, stop the server thread) and coming
   back (reopen and re-seed from the stream's initial frames). */

function startStatusStream() {
  // The bar coasts on its anchor between heartbeats; the ticker is
  // lifecycle-independent of the stream, so start it exactly once.
  startPositionTicker();

  if (statusStream || document.hidden) return;

  const myGeneration = ++streamGeneration;

  // EventSource cannot send headers, so the token rides in the query
  // string. Same-origin, and the token is already in this page.
  const url = `${API_BASE}/stream?token=${encodeURIComponent(API_TOKEN)}`;
  const es = new EventSource(url);
  statusStream = es;

  const handle = (kind) => (event) => {
    // Ignore frames from a connection we've already replaced.
    if (myGeneration !== streamGeneration) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    applyFrame(kind, payload);
  };

  es.addEventListener('transport', handle('transport'));
  es.addEventListener('flags', handle('flags'));
  es.addEventListener('heartbeat', handle('heartbeat'));

  es.onerror = () => {
    // ReadyState CLOSED means the browser gave up (e.g. 401 after a
    // token rotation). Stop and let the next visibility change or
    // reload restart it; otherwise the browser handles reconnecting.
    if (es.readyState === EventSource.CLOSED && myGeneration === streamGeneration) {
      statusStream = null;
      markDisconnected();
    }
  };
}

function stopStatusStream() {
  if (!statusStream) return;
  streamGeneration++;   // invalidate in-flight frames
  statusStream.close();
  statusStream = null;
}

/* Merge one frame into lastStatus, then apply. */
function applyFrame(kind, payload) {
  if (!lastStatus) lastStatus = {};

  if (kind === 'heartbeat') {
    // Position only — re-anchor the local clock, don't touch anything
    // else. The bar and time text advance from this anchor.
    anchorPosition(payload.position, payload.length);
    lastStatus.position = payload.position;
    if (payload.length) lastStatus.length = payload.length;
    tickPosition();
    return;
  }

  Object.assign(lastStatus, payload);

  if (kind === 'transport') {
    anchorPosition(payload.position, payload.length);
  }

  applyStatus(lastStatus);
}

/* Local position ticker. Heartbeats arrive at most every 30 s; between
   them the bar coasts on the anchor via tickPosition(). One shared
   500 ms interval keeps it smooth, skips hidden tabs, and otherwise
   no-ops when nothing is playing. */
let positionTickTimer = null;

function startPositionTicker() {
  if (positionTickTimer) return;
  positionTickTimer = setInterval(() => {
    if (!document.hidden) tickPosition();
  }, 500);
}

// Re-anchor the local clock to a position we chose ourselves (seek,
// stop, track change, restore). tickPosition() advances from this
// anchor between server frames, so skipping the re-anchor would make
// the next tick recompute from the server's last reported position
// and yank the slider back to the pre-seek value.
function anchorPosition(position, length) {
  positionAnchor = {
    position: position || 0,
    length: length || 0,
    at: Date.now()
  };
}

function tickPosition() {
  if (!currentPlayback.isPlaying || isDraggingProgress) return;
  const length = positionAnchor.length || currentPlayback.duration || 0;
  if (!length) return;

  const elapsed = (Date.now() - positionAnchor.at) / 1000;
  const pos = Math.min(positionAnchor.position + elapsed, length);

  if (Date.now() - lastSeekTime > 1500) {
    const percent = (pos / length) * 100;
    if (Math.abs(lastProgressPercent - percent) > 0.5) {
      $progress.value = percent;
      lastProgressPercent = percent;
    }
    if (setTimeDisplay($pbTimeCurMin, $pbTimeCurSec, pos)) {
      $pbTimeTot.textContent = formatTime(length);
    }
    updateSeekValueText(pos, length);
  }
  paintWaveform();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Closing the stream releases the server thread and stops the
    // frames. The state we hold stays on screen, frozen, which is
    // correct for a tab nobody is looking at.
    stopStatusStream();
  } else {
    // Reopen. The stream seeds transport + flags + position on
    // connect, so the frozen state corrects itself immediately.
    startStatusStream();
  }
});

/* ── One-shot refresh ──
   Kept for the paths that mutate state and want the UI updated
   without waiting for the next pushed frame (album load, restore).
   This is a plain GET, not a poll — nothing schedules it. */
async function fetchStatus() {
  try {
    const res = await fetch(`${API_BASE}/status`);
    const data = await res.json();
    lastStatus = data;
    anchorPosition(data.position, data.length);
    applyStatus(data);
  } catch (e) {
    markDisconnected();
  }
}

function markDisconnected() {
  if ($pipeline) {
    $pipeline.style.setProperty('--logo-color-main', '#6a5c4d');
    $pipeline.style.setProperty('--logo-color-accent', '#6a5c4d');
    $pipeline.style.setProperty('--logo-color-center', '#6a5c4d');
    $pipeline.classList.add('disconnected');
    $pipeline.classList.remove('idle');
  }
  if ($hqBtn && !isLaunchingHQPlayer) {
    $hqBtn.classList.remove('launching');
    $hqBtn.classList.add('disconnected');
  }
  if ($pbRight) $pbRight.classList.add('disconnected');
  isLaunchingHQPlayer = false;
}

/* Apply one complete status snapshot to the UI. Called from the stream
   (merged frames) and from the one-shot refresh. */
function applyStatus(data) {
    // Reconcile the client's post-reorder belief with the server's
    // report. The drop handler sets pendingQueueTrack when a reorder
    // shifted the playing track's position; until the server confirms
    // that position — or the window expires — data.track is forced to
    // the client's value so downstream logic (the null-restore block,
    // restorePlaybackFromServer, updatePlayingTrackHighlight) all see
    // the same position the client believes is playing.
    if (pendingQueueTrack) {
      if (data.track === pendingQueueTrack.pos) {
        // Server caught up; the override is no longer needed.
        pendingQueueTrack = null;
      } else if (Date.now() >= pendingQueueTrack.until) {
        // Window expired without confirmation. Drop the override and let
        // the server's value take over; if the two disagree at this point
        // the server is presumed authoritative.
        pendingQueueTrack = null;
      } else {
        data.track = pendingQueueTrack.pos;
      }
    }

    lastStatus = data;

    // The queue view highlights rows by HQPlayer's track number, which
    // only ever changes as a result of this poll. The transport-change
    // branches further down are gated on currentPlayback, so they don't
    // fire when the client already applied the change optimistically —
    // the poll sees no delta and skips updatePlayingTrackHighlight. This
    // refresh is what keeps the queue view in sync through that window.
    // It's a no-op when the queue view isn't showing.
    if (isQueueView) {
      updatePlayingTrackHighlight();
    }

		// End the clear grace period early once HQPlayer reports an empty
		// transport. Waiting the full window is not necessary once the
		// server has confirmed there's nothing loaded.
		if (Date.now() < clearGracePeriodUntil
				&& !data.song
				&& !data.album) {
			clearGracePeriodUntil = 0;
		}

    let mainColor = '#f6efe2';
    let centerColor = '#f6efe2';

    if (data.hqplayer_running) {
      isHQPlayerRunning = true;
  		hqplayerDownStreak = 0;
      if ($hqBtn) $hqBtn.classList.remove('disconnected', 'launching');
      if ($pipeline) {
        $pipeline.classList.remove('disconnected');
        const isPlaying = (data.state === 'playing');
        isPlaying ? $pipeline.classList.remove('idle') : $pipeline.classList.add('idle');
      }
      if ($pbRight) $pbRight.classList.remove('disconnected');
      if ($volBtn) $volBtn.classList.remove('disconnected');
      isLaunchingHQPlayer = false;
    } else if (isLaunchingHQPlayer) {
      hqplayerDownStreak++;
      if ($hqBtn) {
        $hqBtn.classList.add('launching');
        $hqBtn.classList.remove('disconnected');
      }
      if ($pipeline) $pipeline.classList.remove('disconnected', 'idle');
      if ($pbRight) $pbRight.classList.remove('disconnected');
      if ($volBtn) $volBtn.classList.remove('disconnected');
    } else {
      isHQPlayerRunning = false;
      hqplayerDownStreak++;
      if ($hqBtn) {
        $hqBtn.classList.remove('launching');
        $hqBtn.classList.add('disconnected');
      }
      if ($pipeline) {
        $pipeline.classList.add('disconnected');
        $pipeline.classList.remove('idle');
      }
      if ($pbRight) $pbRight.classList.add('disconnected');
    }

    if (data.error) {
      mainColor = '#3a3228';
      centerColor = '#5a5045';
    } else {
      const isPlaying = data.state === 'playing';
      const isStopped = data.state === 'stopped';
      const sdm = data.sdm === '1';
      const shaper = (data.active_shaper || '').toLowerCase();
      const activeMode = (data.active_mode || '').toLowerCase();

      if (isStopped) {
        centerColor = '#f6efe2';
      } else if (sdm) {
        centerColor = '#9f1239';
      } else {
        const sourceRate = parseInt(data.samplerate) || 0;
        centerColor = sourceRate >= 88200 ? '#4ade80' : '#f6efe2';
      }

      if (!isPlaying) {
        mainColor = '#f6efe2';
      } else if (activeMode.includes('source')) {
        mainColor = '#f6efe2';
      } else if (sdm) {
        mainColor = (shaper.includes('directsdm') || activeMode.includes('sdm')) ? '#9f1239' : '#4ade80';
      } else {
        mainColor = activeMode.includes('pcm') ? '#4ade80' : '#9f1239';
      }
    }

    if ($pipeline) {
      $pipeline.style.setProperty('--logo-color-main', mainColor);
      $pipeline.style.setProperty('--logo-color-accent', mainColor);
      $pipeline.style.setProperty('--logo-color-center', centerColor);
    }

    if (data.error) return;

    // In queue mode, data.track is the position in the queue, not an
    // album track index. The reconciliation block below treats it as
    // an album index, which either silently fails (position exceeds
    // the album's track count) or points at the wrong track. Whenever
    // the queue position changes, null currentPlayback so
    // restorePlaybackFromServer re-derives the display from the new
    // track's metadata (song + album).
    //
    // Complements the nulling in queue.js's drop handler, which covers
    // the opposite case: a reorder that changes which item occupies the
    // current position without changing the position number itself. Neither
    // block alone is sufficient — this one only fires when the number
    // moves, the drop handler only fires after an explicit user action.
    if (playbackMode === 'queue'
        && data.hqplayer_running
        && data.track
        && data.track !== lastSeenQueuePosition) {
      lastSeenQueuePosition = data.track;
      currentPlayback.album = null;
      currentPlayback.trackIndex = -1;
    }

    if (data.hqplayer_running && Date.now() >= toggleGracePeriodUntil) {
      const isShuffleOn = data.random === '1' || data.random === 1;
      if (shuffleOn !== isShuffleOn) {
        shuffleOn = isShuffleOn;
        updateShuffleUI(shuffleOn);
      }

      const serverRepeat = parseInt(data.repeat || '0', 10);
      const newRepeatMode = serverRepeat === 1 ? 'one' : serverRepeat === 2 ? 'all' : 'off';

      if (repeatMode !== newRepeatMode) {
        repeatMode = newRepeatMode;
        updateRepeatUI(repeatMode);
      }
    }

    // End the grace period early once the server confirms both the album
		// and the track we optimistically switched to. Checking the track
		// number alone is not enough: during a cross-album load, HQPlayer
		// still reports the previous album for the first few polls, and if
		// its current track number happens to equal our new track index (0
		// when starting an album from track 1), the condition matches and
		// the grace period ends before the server has actually confirmed.
		if (Date.now() < loadGracePeriodUntil
				&& typeof data.track === 'number'
				&& (data.track - 1) === currentPlayback.trackIndex
				&& currentPlayback.album
				&& normalizeAlbumName(data.album) === normalizeAlbumName(currentPlayback.album.baseName)) {
			loadGracePeriodUntil = 0;
		}

    const withinLoadGrace = Date.now() < loadGracePeriodUntil;

    if (!withinLoadGrace) {
      if ((data.state === 'playing') !== currentPlayback.isPlaying
          && Date.now() >= transportGracePeriodUntil) {
        currentPlayback.isPlaying = (data.state === 'playing');
        updatePlaybackUI();
        updatePlayingTrackHighlight();
      }

      // Same-album track reconciliation. Guarded to album mode because
      // data.track there is an album track index; in queue mode it's a
      // queue position, and treating it as an album index overwrites
      // currentPlayback.trackIndex with a queue-relative value — the
      // playback bar then renders an unrelated track. Queue-mode track
      // changes are handled by the lastSeenQueuePosition block above,
      // which nulls currentPlayback so restorePlaybackFromServer
      // re-derives the display.
      if (playbackMode !== 'queue'
          && currentPlayback.album
          && data.hqplayer_running
          && data.track) {
        const serverAlbum = normalizeAlbumName(data.album);
        const currentAlbumName = normalizeAlbumName(currentPlayback.album.baseName);

        if (serverAlbum === currentAlbumName || !serverAlbum) {
          const serverTrackIndex = data.track - 1;
          const totalTracks = getTotalTracksInAlbum(currentPlayback.album);

          if (serverTrackIndex >= 0
              && serverTrackIndex < totalTracks
              && serverTrackIndex !== currentPlayback.trackIndex) {
            currentPlayback.trackIndex = serverTrackIndex;
            currentPlayback.offset = data.position || 0;
            currentPlayback.startTime = Date.now();
            if (data.length > 0) currentPlayback.duration = data.length;

            updatePlaybackUI();
            updatePlayingTrackHighlight();

            const t = getTrackByIndex(currentPlayback.album, serverTrackIndex);
            if (t) {
              const dir = t.parentNode.getAttribute('path');
              const name = t.getAttribute('name');
              loadWaveform(`${dir}/${name}`);

              // Warm the next track's waveform so a skip feels instant.
              // If it's already cached, prefetchWaveform returns without
              // a request.
              const nextT = getTrackByIndex(currentPlayback.album, serverTrackIndex + 1);
              if (nextT) {
                const nextDir = nextT.parentNode.getAttribute('path');
                const nextName = nextT.getAttribute('name');
                prefetchWaveform(`${nextDir}/${nextName}`);
              }
            }
          }
        } else {
          currentPlayback.album = null;
          currentPlayback.trackIndex = -1;
        }
      }

      if (!isDraggingProgress && data.length > 0) {
        const percent = (data.position / data.length) * 100;
        const timeSinceSeek = Date.now() - lastSeekTime;

        if (timeSinceSeek > 1500) {
          // Slider: 0.5% guard prevents thumb jitter on sub-pixel server
          // wobble. Uses lastProgressPercent to skip a DOM read on every
          // poll — see the note at the top of this file about the cache's
          // benign staleness after a drag.
          if (Math.abs(lastProgressPercent - percent) > 0.5) {
            $progress.value = percent;
            lastProgressPercent = percent;
          }

          // Time text: tick once per displayed second, regardless of track
					// length. The total-time span only updates alongside the current-time
					// span, since the track length is static.
					if (setTimeDisplay($pbTimeCurMin, $pbTimeCurSec, data.position)) {
						$pbTimeTot.textContent = formatTime(data.length);
					}
          updateSeekValueText(data.position, data.length);
        }

        if (data.state === 'playing' && currentPlayback.isPlaying && timeSinceSeek > 1500) {
          currentPlayback.offset = data.position;
          currentPlayback.startTime = Date.now();
        }
      }

      paintWaveform();
      restorePlaybackFromServer(data);
    }

    const volumeAvailable = data.volume_available !== false;

    if (!volumeAvailable) {
      if ($volBtn) {
        $volBtn.classList.add('disabled');
        updateVolumeIcon(100, false);
      }
    } else if ($volBtn) {
      $volBtn.classList.remove('disabled');
    }

    const withinGracePeriod = Date.now() < volumeGracePeriodUntil;

    if (data.volume !== undefined && volumeAvailable && !withinGracePeriod) {
      const volumePercent = dbToPercent(data.volume);

      if ($volBtn) $volBtn.dataset.volumePercent = volumePercent;

      if (!isMuted) {
        // updateVolumeIcon now short-circuits internally when the icon
        // variant hasn't changed, so this is a no-op on a quiet system.
        updateVolumeIcon(volumePercent, false);

        if (Math.abs(volumePercent - lastShownVolumePercent) > 2) {
          showVolumeDb(data.volume, false);
          lastShownVolumePercent = volumePercent;
        }
      }
    }
    
    // Re-evaluate the playback bar's mode. Runs at the end of every
    // successful poll so a change in HQPlayer's running state (or in
    // the underlying currentPlayback.album, if the server corrected
    // it) is reflected in the bar within a poll interval.
    updatePlaybackBarMode();
}