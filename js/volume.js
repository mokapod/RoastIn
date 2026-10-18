// volume.js
// Depends on: config, state, dom, utils, views

/* ═══════════════════════════════════════════════════════════════════
   8. VOLUME CONTROL
   ═══════════════════════════════════════════════════════════════════ */

function dbToPercent(db) {
  const clamped = Math.max(VOLUME_MIN_DB, Math.min(VOLUME_MAX_DB, db));
  return Math.round(((clamped - VOLUME_MIN_DB) / VOLUME_RANGE_DB) * 100);
}

function percentToDb(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (clamped / 100) * VOLUME_RANGE_DB + VOLUME_MIN_DB;
}

// Returns true (and surfaces the reason) when the server reports that
// volume control is unavailable — DirectSDM enabled, or a fixed volume
// setting. Callers return immediately on true.
function volumeDisabled() {
  if (!lastStatus || lastStatus.volume_available !== false) return false;

  const reason = lastStatus.volume_disabled_reason || 'Volume control';
  showNotification(`${reason}: volume control is disabled`);
  return true;
}

// The icon shape only changes at three thresholds. Track which of the
// four variants is currently in the DOM so the SVG subtree is only
// rebuilt when it actually changes. Without this, the status poll
// rewrites the icon's innerHTML every second — a full parser pass,
// node teardown, node creation, and style recalc — even on a quiet
// system.
//
// The early return also skips the classList.add/remove('muted') calls.
// That's safe because the muted class is only ever set here, so its
// state is always in sync with currentVolumeIconVariant.
let currentVolumeIconVariant = null;

function updateVolumeIcon(volumePercent, muted = false) {
  let variant;
  if (muted || volumePercent === 0) variant = 'muted';
  else if (volumePercent < 33)      variant = 'low';
  else if (volumePercent < 66)      variant = 'medium';
  else                              variant = 'high';

  if (variant === currentVolumeIconVariant) return;
  currentVolumeIconVariant = variant;

  if (variant === 'muted') {
    $volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>`;
    $volBtn.classList.add('muted');
  } else if (variant === 'low') {
    $volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>`;
    $volBtn.classList.remove('muted');
  } else if (variant === 'medium') {
    $volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>`;
    $volBtn.classList.remove('muted');
  } else {
    $volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>`;
    $volBtn.classList.remove('muted');
  }
}

let volDbTimeout = null;

function showVolumeDb(dbValue, isMutedState = false) {
  if (volDbTimeout) clearTimeout(volDbTimeout);
  if (!$volDbText) return;
  $volDbText.textContent = isMutedState ? 'MUTE' : `${dbValue.toFixed(1)}`;
  $volBtn.classList.add('showing-db');
  volDbTimeout = setTimeout(() => {
    $volBtn.classList.remove('showing-db');
    volDbTimeout = null;
  }, 1500);
}

// Shared unmute path for toggleMute and adjustVolume. Restores the last
// non-zero volume percent rather than snapping to some arbitrary value.
function unmuteVolume() {
  if (!isMuted) return;
  isMuted = false;

  const restorePercent = (lastVolumePercent > 0) ? lastVolumePercent : 95;
  const exactDb = percentToDb(restorePercent);
  volumeGracePeriodUntil = Date.now() + 1500;

  fetch(`${API_BASE}/volume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: exactDb })
  }).catch(err => console.error("Volume error:", err));

  $volBtn.dataset.volumePercent = restorePercent;
  updateVolumeIcon(restorePercent, false);
}

function toggleMute() {
  if (volumeDisabled()) return;

  if (isMuted) {
    unmuteVolume();
    return;
  }

  // Capture the current level so unmute can restore it. Falls back to
  // the last known non-zero percent when the current value is 0 or
  // missing.
  const currentPercent = parseInt($volBtn.dataset.volumePercent, 10);
  if (Number.isFinite(currentPercent) && currentPercent > 0) {
    lastVolumePercent = currentPercent;
  } else {
    lastVolumePercent = lastVolumePercent > 0 ? lastVolumePercent : 95;
  }

  isMuted = true;
  volumeGracePeriodUntil = Date.now() + 1500;

  fetch(`${API_BASE}/volume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: VOLUME_MIN_DB })
  }).catch(err => console.error("Mute error:", err));

  updateVolumeIcon(0, true);
}

function adjustVolume(direction) {
  if (volumeDisabled()) return;

  if (isMuted) {
    unmuteVolume();
    return;
  }

  const parsed = parseInt($volBtn.dataset.volumePercent, 10);
  const currentPercent = Number.isFinite(parsed) ? parsed : lastVolumePercent;
  const currentDb = percentToDb(currentPercent);
  let newDb = currentDb + (direction * VOLUME_STEP_DB);
  newDb = Math.max(VOLUME_MIN_DB, Math.min(VOLUME_MAX_DB, newDb));

  if (Math.abs(newDb - currentDb) < 0.05) return;

  const newPercent = dbToPercent(newDb);
  lastVolumePercent = newPercent;
  volumeGracePeriodUntil = Date.now() + 1500;

  fetch(`${API_BASE}/volume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: newDb })
  }).catch(err => console.error("Volume error:", err));

  $volBtn.dataset.volumePercent = newPercent;
  updateVolumeIcon(newPercent, false);
}