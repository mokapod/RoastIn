// toggles.js
// Depends on: config, state, dom, utils, views, transport

/* ═══════════════════════════════════════════════════════════════════
   9. MODE TOGGLES — shuffle and repeat
   ═══════════════════════════════════════════════════════════════════ */

// Cycle order and server codes. Hoisted so the mappings are visible
// and no object literal is allocated per click.
const REPEAT_NEXT = { off: 'all', all: 'one', one: 'off' };
const REPEAT_CODE = { off: 0, one: 1, all: 2 };

// Tokens to detect superseded requests. If a user clicks the toggle
// twice before the first fetch resolves, the older request must not
// run its rollback — that would revert to a state the newer request
// has already moved past.
let repeatRequestToken  = 0;
let shuffleRequestToken = 0;

function updateRepeatUI(mode) {
  $repeatBtn.classList.toggle('repeat-one', mode === 'one');
  $repeatBtn.classList.toggle('active', mode !== 'off');
  $repeatBtn.setAttribute('aria-pressed', mode !== 'off');
  $repeatBtn.setAttribute('aria-label',
    mode === 'off' ? 'Repeat off' :
    mode === 'all' ? 'Repeat all' : 'Repeat one'
  );
}

function updateShuffleUI(isOn) {
  $shuffleBtn.classList.toggle('active', isOn);
  $shuffleBtn.setAttribute('aria-pressed', isOn);
  $shuffleBtn.setAttribute('aria-label', isOn ? 'Shuffle on' : 'Shuffle off');
}

async function cycleRepeat() {
  if (!isHQPlayerRunning) {
    const launched = await launchHQPlayerAndWait();
    if (!launched) return;
  }

  const myToken = ++repeatRequestToken;

  toggleGracePeriodUntil = Date.now() + 1500;

  const previousRepeatMode = repeatMode;
  repeatMode = REPEAT_NEXT[repeatMode];
  updateRepeatUI(repeatMode);

  try {
    const res = await fetch(`${API_BASE}/repeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: REPEAT_CODE[repeatMode] })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // A newer click superseded this request — its outcome is the truth.
    if (myToken !== repeatRequestToken) return;

    repeatMode = previousRepeatMode;
    updateRepeatUI(repeatMode);
    console.error('Repeat error:', err);
    showNotification('Repeat command failed', true);
  }
}

async function toggleShuffle() {
  if (!isHQPlayerRunning) {
    const launched = await launchHQPlayerAndWait();
    if (!launched) return;
  }

  const myToken = ++shuffleRequestToken;

  toggleGracePeriodUntil = Date.now() + 1500;

  const previousShuffleOn = shuffleOn;
  shuffleOn = !shuffleOn;
  updateShuffleUI(shuffleOn);

  try {
    const res = await fetch(`${API_BASE}/random`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: shuffleOn ? 1 : 0 })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (myToken !== shuffleRequestToken) return;

    shuffleOn = previousShuffleOn;
    updateShuffleUI(shuffleOn);
    console.error('Shuffle error:', err);
    showNotification('Shuffle command failed', true);
  }
}