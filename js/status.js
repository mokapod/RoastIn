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

// Polling gate. When the tab is hidden the loop stops scheduling
// itself; when it becomes visible again, one fetch runs immediately
// and the chain resumes. Without this, a background tab pings
// HQPlayer's socket once per second forever, parsing XML and
// touching the DOM for a UI nobody is looking at.
let statusPollingActive = !document.hidden;

// Generation token for the polling loop. Every visibilitychange bumps
// this; fetchStatus captures the current value at entry and only
// reschedules itself if the generation still matches when its request
// finishes.
//
// The bug this fixes: the previous design relied solely on
// statusPollingActive to decide whether to reschedule. That works when
// the tab hides and stays hidden (the in-flight loop sees false and
// stops), and it works when the tab hides and shows after the loop has
// already gone idle (the visibility handler starts a fresh chain and
// there's no old one to collide with). It breaks when the tab hides
// and shows *while a request is in flight*:
//
//   1. Visible. Loop A starts.
//   2. Hidden.  statusPollingActive = false. Loop A's request still
//               on the wire.
//   3. Visible. statusPollingActive = true, visibility handler calls
//               fetchStatus() → Loop B starts.
//   4. Loop A's request resolves. finally sees statusPollingActive
//               === true and schedules itself.
//   5. Loop B's request resolves. finally also sees true, schedules.
//   6. Two independent chains now run forever, each pinging HQPlayer
//               once per second — double the sockets, double the XML
//               parsing, double the DOM writes, permanently.
//
// The generation token makes the race impossible. Only one value of
// statusPollGeneration is "current" at any moment; a loop whose
// captured generation no longer matches that value has been superseded
// and must not schedule another iteration.
let statusPollGeneration = 0;

// Last queue position observed in queue mode. Used to detect track
// changes in the queue, where data.track is a queue position rather
// than an album track index. The two coincide in album mode, so this
// is only consulted when playbackMode === 'queue'.
let lastSeenQueuePosition = null;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    statusPollingActive = false;
    // Invalidate any loop still in flight. Bumping on hide (rather
    // than on show) expresses the intent directly: the moment the tab
    // goes away, everything that was already running is stale, and
    // whatever the visibility handler starts on return is the only
    // loop that matters.
    statusPollGeneration++;
  } else if (!statusPollingActive) {
    statusPollingActive = true;
    fetchStatus();   // restart immediately; don't wait a full interval
  }
});

async function fetchStatus() {
  // Capture the generation for this iteration. If a visibilitychange
  // fires before the request resolves, the value here goes stale and
  // the finally block below declines to reschedule — the handler's
  // call to fetchStatus becomes the sole owner of the chain.
  //
  // This must be read before the first await so the capture happens
  // on the same tick the loop iteration was launched, not after the
  // request round-trip has already begun.
  const myGeneration = statusPollGeneration;

  try {
    const res = await fetch(`${API_BASE}/status`);
    const data = await res.json();

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
      if ($volBtn) {
        $volBtn.classList.remove('disconnected');
        $volBtn.style.removeProperty('opacity');
        $volBtn.style.removeProperty('cursor');
        $volBtn.disabled = false;
      }
      isLaunchingHQPlayer = false;
    } else if (isLaunchingHQPlayer) {
      hqplayerDownStreak++;
      if ($hqBtn) {
        $hqBtn.classList.add('launching');
        $hqBtn.classList.remove('disconnected');
      }
      if ($pipeline) $pipeline.classList.remove('disconnected', 'idle');
      if ($pbRight) $pbRight.classList.remove('disconnected');
      if ($volBtn) {
        $volBtn.classList.remove('disconnected');
        $volBtn.style.removeProperty('opacity');
        $volBtn.disabled = false;
        $volBtn.style.removeProperty('cursor');
      }
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
        if ($shuffleBtn) {
          $shuffleBtn.classList.toggle('active', shuffleOn);
          $shuffleBtn.setAttribute('aria-pressed', shuffleOn);
          $shuffleBtn.setAttribute('aria-label', shuffleOn ? 'Shuffle on' : 'Shuffle off');
        }
      }

      const serverRepeat = parseInt(data.repeat || '0', 10);
      const newRepeatMode = serverRepeat === 1 ? 'one' : serverRepeat === 2 ? 'all' : 'off';

      if (repeatMode !== newRepeatMode) {
        repeatMode = newRepeatMode;
        if ($repeatBtn) {
          $repeatBtn.classList.toggle('repeat-one', repeatMode === 'one');
          $repeatBtn.classList.toggle('active', repeatMode !== 'off');
          $repeatBtn.setAttribute('aria-pressed', repeatMode !== 'off');
          $repeatBtn.setAttribute('aria-label',
            repeatMode === 'off' ? 'Repeat off' :
            repeatMode === 'all' ? 'Repeat all' : 'Repeat one'
          );
        }
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
        $volBtn.disabled = false;
        $volBtn.classList.add('disabled');
        updateVolumeIcon(100, false);
      }
    } else if ($volBtn) {
      $volBtn.disabled = false;
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
  } catch (e) {
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
  } finally {
    // Reschedule only if this iteration is still the current one. Two
    // independent conditions must both hold:
    //
    //   statusPollingActive — the tab is visible, so the loop should
    //     run at all. When the tab is hidden, this is false and the
    //     visibilitychange handler takes over responsibility for
    //     restarting on return.
    //
    //   myGeneration === statusPollGeneration — no visibilitychange
    //     has fired since this iteration began. If one has (tab hid
    //     or showed mid-request), a newer fetchStatus call is either
    //     running now or was scheduled by the handler, and this
    //     iteration must not add a competing chain.
    //
    // The second condition is what prevents the double-up: without
    // it, an iteration whose request spanned a hide/show cycle would
    // reschedule alongside the handler's fresh call, producing two
    // permanent polling loops. See the note on statusPollGeneration
    // for the full sequence.
    if (statusPollingActive && myGeneration === statusPollGeneration) {
      setTimeout(fetchStatus, POLL_INTERVAL_MS);
    }
  }
}