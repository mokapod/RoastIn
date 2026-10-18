// menu.js
// Depends on: config, state, dom, utils, views, transport
// Exports:   handleHqButtonClick (used by events.js)

/* ═══════════════════════════════════════════════════════════════════
   HQPLAYER ACTION MENU
   ═══════════════════════════════════════════════════════════════════ */

const $hqMenu = document.getElementById('hqplayerMenu');

const HQ_MENU_ITEMS = [
  {
    script: 'toggle-directsdm',
    label: 'Toggle DirectSDM',
    icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'
  },
  {
    id: 'reveal-settings',
    label: 'Open .hqplayer',
    icon: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
  },
  {
    script: 'prune-favorites',
    label: 'Prune Favorites',
    icon: '<path d="M7.5 7.5c0-1.2-1-2.2-2.2-2.2-.9 0-1.7.5-2 1.3-.4-.8-1.1-1.3-2-1.3C2.1 5.3 1 6.3 1 7.5c0 3 3.5 5.5 3.5 5.5S8 10.5 8 7.5" opacity="0.5"/><path d="M20 13.5c0-1.2-1-2.2-2.2-2.2-.9 0-1.7.5-2 1.3-.4-.8-1.1-1.3-2-1.3-1.2 0-2.3 1-2.3 2.2 0 3 3.5 5.5 3.5 5.5s4.5-2.5 4.5-5.5"/>'
  },
  {
    script: 'list-corruptions',
    label: 'Show Corruptions',
    icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="M12 9v.01"/>'
  },
  {
    script: 'repair-library',
    label: 'Repair Library',
    icon: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
  },
  { sep: true },
  {
    id: 'activate',
    label: 'Activate',
    icon: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M9 21h12V9"/>'
  },
  {
    script: 'restart',
    label: 'Restart',
    icon: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
  },
  {
    id: 'quit',
    label: 'Quit',
    danger: true,
    icon: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>'
  }
];

// Each item is a plain <button>. No ARIA menu role — the container
// doesn't implement the keyboard interaction pattern that role="menu"
// promises (arrow-key navigation, roving tabindex, Home/End). Plain
// buttons inside a popup are a disclosure, and browsers / screen
// readers already handle that correctly.
function buildMenu() {
  $hqMenu.innerHTML = HQ_MENU_ITEMS.map(item => {
    if (item.sep) return '<div class="hqplayer-menu-sep"></div>';

    const cls = item.danger ? 'hqplayer-menu-item is-danger' : 'hqplayer-menu-item';
    const attrs = item.script
      ? `data-script="${item.script}"`
      : `data-command="${item.id}"`;

    return `
      <button class="${cls}" ${attrs}>
        <svg viewBox="0 0 24 24">${item.icon}</svg>
        <span>${item.label}</span>
      </button>`;
  }).join('');
}

function positionMenu() {
  const btnRect = $hqBtn.getBoundingClientRect();
  const menuRect = $hqMenu.getBoundingClientRect();

  let left = btnRect.right - menuRect.width;
  let top  = btnRect.top - menuRect.height - 8;
  const pad = 8;

  if (left < pad) left = pad;
  if (left + menuRect.width > window.innerWidth - pad) {
    // Math.max guards against a menu wider than the viewport pushing
    // left below pad after the earlier clamp already passed.
    left = Math.max(pad, window.innerWidth - menuRect.width - pad);
  }
  if (top < pad) {
    top = btnRect.bottom + 8;
  }
  if (top + menuRect.height > window.innerHeight - pad) {
    top = window.innerHeight - menuRect.height - pad;
    if (top < pad) top = pad;
  }

  $hqMenu.style.left = `${left}px`;
  $hqMenu.style.top  = `${top}px`;
}

function openHqMenu() {
  buildMenu();
  $hqMenu.hidden = false;
  $hqBtn.setAttribute('aria-expanded', 'true');
  positionMenu();
}

function closeHqMenu() {
  if ($hqMenu.hidden) return;
  $hqMenu.hidden = true;
  $hqBtn.setAttribute('aria-expanded', 'false');
}

// Shared executor for both action kinds. The endpoint and payload are
// the only things that differ between a menu command and a script.
async function executeHqAction(endpoint, payload) {
  closeHqMenu();
  try {
    const res = await fetch(`${API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    if (data.output) {
      showNotification(data.output);
    }
  } catch (err) {
    showNotification(err.message, true);
    console.error(`HQPlayer ${endpoint} error:`, err);
  }
}

function runHqCommand(command) {
  executeHqAction('hqplayer-action', { command });
}

function runScript(name) {
  executeHqAction('run-script', { name });
}

function handleHqButtonClick(e) {
  e.stopPropagation();

  if (!isHQPlayerRunning) {
    launchHQPlayer();
    return;
  }

  if ($hqMenu.hidden) openHqMenu();
  else closeHqMenu();
}

// Menu item clicks — delegated so it survives buildMenu() rebuilds
$hqMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-command], [data-script]');
  if (!item) return;
  e.stopPropagation();

  if (item.dataset.script) {
    runScript(item.dataset.script);
  } else if (item.dataset.command) {
    runHqCommand(item.dataset.command);
  }
});

// Outside click dismisses
document.addEventListener('click', (e) => {
  if ($hqMenu.hidden) return;
  if ($hqMenu.contains(e.target)) return;
  if ($hqBtn.contains(e.target)) return;
  closeHqMenu();
});

// Escape dismisses
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$hqMenu.hidden) {
    closeHqMenu();
    $hqBtn.focus();
  }
});

// Reposition on scroll/resize — throttled to one layout per animation
// frame. positionMenu reads getBoundingClientRect on two elements, so
// running it on every scroll event would force a layout flush per tick.
let positionScheduled = false;

function schedulePositionUpdate() {
  if ($hqMenu.hidden || positionScheduled) return;
  positionScheduled = true;
  requestAnimationFrame(() => {
    positionMenu();
    positionScheduled = false;
  });
}

window.addEventListener('scroll', schedulePositionUpdate, { passive: true });
window.addEventListener('resize', schedulePositionUpdate);