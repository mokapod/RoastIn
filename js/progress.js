// progress.js
// Depends on: config, state, dom, utils, views, waveform

/* ═══════════════════════════════════════════════════════════════════
   11. PROGRESS BAR
   ═══════════════════════════════════════════════════════════════════ */

function updateSeekValueText(position, length) {
  $progress.setAttribute(
    'aria-valuetext',
    `${formatTime(position)} of ${formatTime(length)}`
  );
}

function handleProgressInput(e) {
  isDraggingProgress = true;
  const percent = parseFloat(e.target.value);

  // duration is set at track load and refreshed on track change; it's
  // the length the frontend has committed to. lastStatus.length would
  // also work, but only after the first poll of a new track.
  const duration = currentPlayback.duration || 0;
  const previewTime = Math.round((percent / 100) * duration);
  setTimeDisplay($pbTimeCurMin, $pbTimeCurSec, previewTime);
  updateSeekValueText(previewTime, duration);

  // paintWaveform self-throttles on a 0.05% change, so calling it on
  // every input event is cheap.
  paintWaveform();
}

async function handleProgressChange(e) {
  isDraggingProgress = false;
  const percent = parseFloat(e.target.value);
  const duration = currentPlayback.duration || 0;
  const seekTime = Math.round((percent / 100) * duration);

  // Update local state immediately so any poll landing before the
  // server confirms the seek sees the new position. Re-anchor the
  // local clock too — tickPosition() advances from the anchor, and
  // without this the next tick would recompute from the server's last
  // reported position and pull the slider back to the pre-seek value.
  currentPlayback.offset = seekTime;
  currentPlayback.startTime = Date.now();
  anchorPosition(seekTime, duration);
  lastSeekTime = Date.now();

  $progress.value = percent;
  setTimeDisplay($pbTimeCurMin, $pbTimeCurSec, seekTime);
  updateSeekValueText(seekTime, duration);

  // Serialize the seek before any subsequent play command. Without
  // this await, the two fetches below can complete out of order: if
  // play reaches HQPlayer before seek, playback resumes from the old
  // position and then jumps to the new one — a visible glitch that
  // can be several seconds off.
  //
  // The await is why the function is declared async. Nothing reads
  // the handler's return value, so the promise it produces is
  // discarded by the event system as a matter of course.
  try {
    await fetch(`${API_BASE}/seek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ time: seekTime })
    });
  } catch (err) {
    console.error("Seek error:", err);
  }

  // Seeking while paused resumes playback — matches how most players
  // behave, and avoids the "moved the scrubber but nothing happened"
  // confusion.
  //
  // Ordering vs. the seek above: this fetch is issued only after the
  // awaited seek has resolved, so HQPlayer receives the position
  // change before it receives the play command.
  if (!currentPlayback.isPlaying) {
    currentPlayback.isPlaying = true;
    transportGracePeriodUntil = Date.now() + 1500;
    updatePlaybackUI();
    fetch(`${API_BASE}/play`, { method: 'POST' }).catch(() => {});
  }
}

$progress.addEventListener('input', handleProgressInput);
$progress.addEventListener('change', handleProgressChange);

$pbInfo.addEventListener('click', () => {
  if (!currentPlayback.album) return;
  const idx = findOrRevealAlbum(currentPlayback.album.folder);
  if (idx !== -1) showAlbumDetail(idx);
});