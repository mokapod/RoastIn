// queue.js
// Depends on: config, state, dom, utils, library, transport, notifications
//
// Right-click context menu for "Add to Queue". Two entry points:
//   - Album card in the grid → adds the whole album.
//   - Track row in the detail view → adds that track, plus a second
//     menu item to add the whole album.
//
// The queue view renders exclusively from /api/queue. There is no
// client-side mirror: every open fetches from the server, and every
// mutation re-renders from a fresh fetch after the server confirms.
// This trades the mirror's instant reopens for a guarantee that the
// view reflects what HQPlayer actually has.
//
// Reordering uses pointer events (mousedown / mousemove / mouseup)
// rather than the native HTML5 draggable attribute. The native drag
// session leaves the browser's :hover state frozen on the source row
// after drop, and that state lives in the browser's pointer-tracking
// layer — no DOM or CSS manipulation from JavaScript reaches it.
// Pointer events skip the drag subsystem entirely, so there's no
// hover freeze to work around.

/* ═══════════════════════════════════════════════════════════════════
   CONTEXT MENU
   ═══════════════════════════════════════════════════════════════════ */

let contextMenuEl = null;
let contextMenuReturnFocus = null;

function showContextMenu(x, y, items, returnFocus = null) {
  hideContextMenu(false);
  contextMenuReturnFocus = returnFocus;

  contextMenuEl = document.createElement('div');
  contextMenuEl.className = 'context-menu';

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      contextMenuEl.appendChild(sep);
      continue;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item';
    if (item.danger) btn.classList.add('is-danger');
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideContextMenu();
      item.action();
    });
    contextMenuEl.appendChild(btn);
  }

  contextMenuEl.style.left = '-9999px';
  contextMenuEl.style.top  = '-9999px';
  document.body.appendChild(contextMenuEl);

  const rect = contextMenuEl.getBoundingClientRect();
  const pad  = 6;
  const vw   = window.innerWidth;
  const vh   = window.innerHeight;

  let left = x;
  if (left + rect.width > vw - pad) {
    left = vw - rect.width - pad;
  }
  if (left < pad) left = pad;

  let top = y - rect.height;
  if (top < pad) {
    top = y;
  }
  if (top + rect.height > vh - pad) {
    top = vh - rect.height - pad;
  }
  if (top < pad) top = pad;

  contextMenuEl.style.left = `${left}px`;
  contextMenuEl.style.top  = `${top}px`;
}

function hideContextMenu(restoreFocus = true) {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
  const target = contextMenuReturnFocus;
  contextMenuReturnFocus = null;
  if (restoreFocus && target?.isConnected) target.focus();
}

document.addEventListener('mousedown', (e) => {
  if (contextMenuEl && !contextMenuEl.contains(e.target)) {
    hideContextMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});

window.addEventListener('blur', hideContextMenu);
window.addEventListener('scroll', hideContextMenu, { passive: true });

document.addEventListener('contextmenu', (e) => {
  if (contextMenuEl && contextMenuEl.contains(e.target)) {
    e.preventDefault();
  }
});

// Context-menu keyboard key and Shift+F10 expose the same album actions
// as right-click. The menu opens beside the focused card and moves focus
// to its first item so it is immediately usable without a pointer.
$content.addEventListener('keydown', (e) => {
  if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
  const card = e.target.closest('.album-card');
  if (!card) return;
  e.preventDefault();
  const rect = card.getBoundingClientRect();
  showContextMenu(
    rect.left + 8,
    rect.bottom - 8,
    albumCardMenuItems(card),
    card
  );
  contextMenuEl?.querySelector('button')?.focus();
});

/* ═══════════════════════════════════════════════════════════════════
   RIGHT-CLICK HANDLERS
   ═══════════════════════════════════════════════════════════════════ */

function resolveAlbumIndexByFolder(folder) {
  if (!folder) return -1;
  return allAlbums.findIndex(album => album.folder === folder);
}

function addAlbumFolderToQueue(folder) {
  const index = resolveAlbumIndexByFolder(folder);
  if (index !== -1) addToQueue(index, null);
}

function addAlbumTrackToQueue(folder, trackIndex) {
  const index = resolveAlbumIndexByFolder(folder);
  if (index !== -1) addToQueue(index, trackIndex);
}

function revealAlbumFolderByFolder(folder) {
  const album = masterAlbums.find(item => item.folder === folder);
  if (!album?.folder) return;
  fetch(`${API_BASE}/reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: album.folder })
  }).catch(() => showNotification('Could not open folder', true));
}

function albumCardMenuItems(card) {
  const folder = card.dataset.albumFolder;
  if (!folder) return [];
  return [
    { label: 'Add Album to Queue', action: () => addAlbumFolderToQueue(folder) },
    { label: 'Reveal Album Folder', action: () => revealAlbumFolderByFolder(folder) }
  ];
}

function showAlbumCardMenu(card, x, y) {
  const items = albumCardMenuItems(card);
  if (items.length) showContextMenu(x, y, items);
}

function showDetailCoverMenu(cover, x, y, returnFocus) {
  const album = masterAlbums.find(item => item.folder === cover.dataset.albumFolder);
  if (!album?.folder) return;
  showContextMenu(x, y, [
    { label: 'Add Album to Queue',  action: () => addAlbumFolderToQueue(album.folder) },
    { label: 'Reveal Album Folder', action: () => revealFolder(album.folder) }
  ], returnFocus);
}

function showDetailTrackMenu(track, x, y, returnFocus) {
  const folder = track.dataset.albumFolder;
  const trackIndex = parseInt(track.dataset.trackIndex, 10);
  if (!folder || Number.isNaN(trackIndex)) return;

  const album = masterAlbums.find(item => item.folder === folder);
  if (!album) return;

  const trackCount = album.tracks.length;
  const items = [];
  if (trackIndex >= 0 && trackIndex < trackCount) {
    items.push({
      label: 'Add Track to Queue',
      action: () => addAlbumTrackToQueue(album.folder, trackIndex)
    });
  }
  items.push({
    label: 'Add Album to Queue',
    action: () => addAlbumFolderToQueue(album.folder)
  });
  showContextMenu(x, y, items, returnFocus);
}
$content.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.album-card');
  if (!card) return;
  e.preventDefault();

  showAlbumCardMenu(card, e.clientX, e.clientY);
});

$detailContent.addEventListener('contextmenu', (e) => {
  // Cover only. The menu is scoped to the album artwork rather than
  // the whole header block, so a right-click on the title, artist,
  // format badges, or stats falls through to the browser's native
  // context menu — which gives the user Copy, Search with, Look Up,
  // and the rest of the text-selection actions those regions expect.
  const cover = e.target.closest('.album-detail-cover');
  if (cover) {
    e.preventDefault();
    showDetailCoverMenu(cover, e.clientX, e.clientY, cover);
    return;
  }

  const track = e.target.closest('.track');
  if (!track) return;
  e.preventDefault();
  showDetailTrackMenu(track, e.clientX, e.clientY, track);
});

// Keyboard entry for the detail context menus, mirroring the grid.
$detailContent.addEventListener('keydown', (e) => {
  if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
  const cover = e.target.closest('.album-detail-cover');
  if (cover) {
    e.preventDefault();
    const rect = cover.getBoundingClientRect();
    showDetailCoverMenu(cover, rect.left + 8, rect.bottom - 8, cover);
    contextMenuEl?.querySelector('button')?.focus();
    return;
  }
  const track = e.target.closest('.track');
  if (track) {
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    showDetailTrackMenu(track, rect.left + 8, rect.bottom - 8, track);
    contextMenuEl?.querySelector('button')?.focus();
  }
});

/* ═══════════════════════════════════════════════════════════════════
   QUEUE VIEW
   ═══════════════════════════════════════════════════════════════════ */

let queueAlbumDirIndex = null;
let queueAlbumDirIndexRef = null;

function getQueueAlbumDirIndex() {
  if (queueAlbumDirIndex && queueAlbumDirIndexRef === masterAlbums) {
    return queueAlbumDirIndex;
  }

  queueAlbumDirIndex = new Map();
  queueAlbumDirIndexRef = masterAlbums;

  for (const album of masterAlbums) {
    for (const disc of album.discs) {
      const dir = disc.directory.getAttribute('path');
      if (dir) queueAlbumDirIndex.set(dir, album);
    }
  }

  return queueAlbumDirIndex;
}

function findAlbumByUri(uri) {
  if (!uri) return null;
  let clean = uri.replace(/^file:\/\//, '');
  try { clean = decodeURIComponent(clean); } catch (e) { /* leave as-is */ }
  const lastSlash = clean.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return getQueueAlbumDirIndex().get(clean.slice(0, lastSlash)) || null;
}

/* Compute where the currently-playing track ends up after a move from
   `from` to `to`. HQPlayer's transport pointer tracks position, not
   item identity, so a move that shifts items around the current index
   leaves the pointer aimed at whatever item now occupies that slot.
   This mirrors the arithmetic PlaylistMove applies to the playlist, so
   the client can re-select the same track at its new index. */
function positionAfterMove(currentPos, from, to) {
  if (currentPos === from) return to;
  if (from < to) {
    // Moving down: items in (from, to] shift up by one index.
    if (currentPos > from && currentPos <= to) return currentPos - 1;
  } else {
    // Moving up: items in [to, from) shift down by one index.
    if (currentPos >= to && currentPos < from) return currentPos + 1;
  }
  return currentPos;
}

/* Scroll position the user was at the last time they left the queue
   view. Written by hideQueueView when the view closes, read by
   showQueueView on the next entry. Starts at 0 so the first open lands
   at the top. */
let savedQueueScrollPosition = 0;

/* Last rendered queue contents, in order. Populated by
   renderQueueFromTracks and read by restore.js to resolve the
   currently-playing track in queue mode, where HQPlayer's reported
   track number is a queue position rather than an album track index.
   Refreshed after every mutation that changes the order without
   going through renderQueueFromTracks (currently: clear). */
let lastKnownQueue = [];

/* True once renderQueueFromTracks has written the queue at least
   once for this page load. Guarding the skip-check in
   renderQueueView on this flag prevents the first render of an empty
   queue from being skipped — at that point lastKnownQueue is also
   empty, the two arrays would compare equal, and the container would
   stay blank rather than showing the "queue is empty" message. */
let queueHasRendered = false;

/* ── Pointer-drag state ──
   Replaces the native HTML5 drag state. Set on mousedown over a queue
   row, cleared inline in the mouseup handler. dragOverEl tracks the
   row currently under the cursor during the drag so its highlight can
   be cleared on the next move or on release. */
let pointerDrag = null;
let dragOverEl  = null;

/* ── Fetch ──
   Shared promise for the queue fetch. Two concurrent renderQueueView
   calls — a user-initiated open racing a mutation-triggered re-render
   — share one PlaylistGet rather than issuing two. */
let queueFetchPromise = null;

async function syncQueueFromServer() {
  if (queueFetchPromise) return queueFetchPromise;

  queueFetchPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/queue`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.tracks || [];
    } catch (e) {
      console.warn('[queue] fetch failed:', e);
      return null;
    } finally {
      queueFetchPromise = null;
    }
  })();

  return queueFetchPromise;
}

/* ── Render ── */

async function renderQueueView(restoreTo = null) {
  const internalScrollY = window.scrollY || window.pageYOffset;
  const targetScrollY = (restoreTo !== null) ? restoreTo : internalScrollY;
  const isFirstRender = $queueContent.children.length === 0;

  if (isFirstRender) {
    $queueContent.innerHTML = '<div class="loading">Loading queue...</div>';
  }

  const tracks = await syncQueueFromServer();

  // The user may have left the queue view (Escape, Q hotkey, a
  // navigation into an album detail) while the fetch was in flight.
  // Without this guard, both the DOM render below and the scroll
  // restore that follows would mutate a view the user is no longer
  // looking at — and the scroll restore in particular would jump the
  // *current* view (grid or album detail) to the queue's saved scroll
  // position, since window.scrollTo is not scoped to a container.
  //
  // Bailing here is safe: the queue contents are cached server-side
  // (server.py's queue cache), so the next open fetches cheaply and
  // gets the same data.
  if (!isQueueView) return;

  if (tracks === null) {
    $queueContent.innerHTML = '<div class="error">Could not load the queue.</div>';
    return;
  }

  // Skip the render when the fetched queue is identical to what is
  // already on screen. This is the common case when opening the queue
  // view after closing it without mutating anything — the fetch
  // returns the same list, and rebuilding would discard every cover
  // <img>, forcing a decode and paint on every row. The comparison
  // includes metadata fields (song, artist, length) as well as the
  // URI, because those can change without the URI changing — an
  // external tag edit followed by a rescan, for example — and a
  // URI-only check would leave stale labels in the DOM.
  if (queueHasRendered &&
      tracks.length === lastKnownQueue.length &&
      tracks.every((t, i) => {
        const p = lastKnownQueue[i];
        return t.uri    === p.uri
            && t.song   === p.song
            && t.artist === p.artist
            && t.length === p.length;
      })) {
    // Nothing changed — but the scroll restore below still needs to
    // run. The list is where it was; the viewport is where the user
    // left it on the previous visit.
    if (targetScrollY > 0) {
      requestAnimationFrame(() => {
        if (!isQueueView) return;
        window.scrollTo(0, targetScrollY);
      });
    }
    return;
  }

  renderQueueFromTracks(tracks);

  if (targetScrollY > 0) {
    // Re-check inside the rAF callback as well. A frame can elapse
    // between this point and the scroll firing, and a view switch
    // during that window has the same problem — the scroll would
    // land on the wrong view. Checking twice is cheap and closes
    // the last gap.
    requestAnimationFrame(() => {
      if (!isQueueView) return;
      window.scrollTo(0, targetScrollY);
    });
  }
}

function renderQueueFromTracks(tracks) {
  lastKnownQueue = tracks;
  queueHasRendered = true;

  if (tracks.length === 0) {
    $queueContent.innerHTML = '<div class="loading is-empty">The queue is empty.</div>';
    return;
  }

  const eqIcon = `<svg class="track-icon-eq" viewBox="0 0 24 24" width="16" height="16"><rect class="eq-bar eq-bar-1" x="4" y="12" width="4" height="12" rx="1"/><rect class="eq-bar eq-bar-2" x="10" y="8" width="4" height="16" rx="1"/><rect class="eq-bar eq-bar-3" x="16" y="4" width="4" height="20" rx="1"/></svg>`;
  const playIcon = `<svg class="track-icon-play" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

  let html = '<div class="tracklist-detail">';
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const fallback = (t.uri || '').split('/').pop() || 'Unknown';
    const song = esc(t.song || fallback);
    const artist = t.artist ? esc(t.artist) : '';
    const length = parseInt(t.length, 10) || 0;

    const album = findAlbumByUri(t.uri);
    const coverUrl = album && album.coverUrl ? album.coverUrl : '';
    const artHTML = coverUrl
      ? `<img src="${esc(coverUrl)}" alt="" loading="lazy" onerror="this.remove()">`
      : '';

    // No draggable="true" here — reordering is handled by the pointer
    // handlers below. The native drag attribute would put the browser
    // back into the drag subsystem that causes the stuck-hover bug.
    html += `
      <div class="track" role="button" tabindex="0" data-queue-index="${i + 1}">
        <span class="track-play-icon">${eqIcon}${playIcon}</span>
        <span class="track-num">${i + 1}</span>
        <div class="track-art">${artHTML}</div>
        <div class="track-info">
          <div class="track-name">${song}</div>
          ${artist ? `<div class="track-performer">${artist}</div>` : ''}
        </div>
        <span class="track-length">${formatTime(length)}</span>
      </div>`;
  }
  html += '</div>';

  $queueContent.innerHTML = html;

  const currentNum = lastStatus && lastStatus.track;
  if (currentNum) {
    const el = $queueContent.querySelector(`.track[data-queue-index="${currentNum}"]`);
    if (el) {
      el.classList.add('playing');
      if (lastStatus.state !== 'playing') el.classList.add('paused');
    }
  }
}

$queueContent.addEventListener('click', async (e) => {
  // A completed pointer drag suppresses the click that follows it.
  // pointerDrag is nulled on mouseup before the click event fires,
  // so this check relies on the flag the mouseup handler set.
  if (suppressNextClick) {
    suppressNextClick = false;
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  const track = e.target.closest('.track');
  if (!track) return;

  const index = parseInt(track.dataset.queueIndex, 10);
  if (Number.isNaN(index)) return;

  // Optimistic highlight: give immediate visual feedback before the
  // server confirms. This concerns only the playing indicator, not
  // queue contents, so it lives outside the render-from-server model.
  $queueContent.querySelectorAll('.track').forEach(el => {
    el.classList.remove('playing', 'paused');
  });
  track.classList.add('playing');

  try {
    const res = await fetch(`${API_BASE}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track: index })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Write the new position into lastStatus so the next status poll
    // doesn't re-highlight the previous row while HQPlayer catches up.
    if (lastStatus) {
      lastStatus.track = index;
      lastStatus.state = 'playing';
    }

    // Override the server's track value until it catches up to the
    // SelectTrack issued above. Without this, the next poll overwrites
    // lastStatus.track with the previous position and the highlight
    // reverts to the row that was playing before the click.
    pendingQueueTrack = { pos: index, until: Date.now() + 5000 };

    updatePlayingTrackHighlight();

    // Force the playback bar to re-derive from this new track. Without
    // this, restorePlaybackFromServer's own guard (currentPlayback.album
    // is set) blocks the update, and the bar keeps the previous track.
    currentPlayback.album = null;
    currentPlayback.trackIndex = -1;
  } catch {
    showNotification('Failed to select track', true);
    renderQueueView();
  }
});

$queueContent.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;

  const track = e.target.closest('.track');
  if (!track) return;

  e.preventDefault();
  const index = parseInt(track.dataset.queueIndex, 10);
  if (Number.isNaN(index)) return;

  // Reuse the click path by dispatching a synthetic click.
  track.click();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!isQueueView) return;
  e.preventDefault();
  showGridView();
});

/* ═══════════════════════════════════════════════════════════════════
   POINTER-BASED DRAG-TO-REORDER

   mousedown / mousemove / mouseup rather than the native HTML5
   draggable attribute. The native drag session leaves the browser's
   :hover state frozen on the source row after drop, and that state
   lives in the browser's pointer-tracking layer — no DOM or CSS
   manipulation from JavaScript reaches it. Pointer events skip the
   drag subsystem entirely, so there's no hover freeze to work around.

   The interaction is unchanged from the user's perspective: press,
   move to a target row, release. A short movement threshold
   distinguishes a drag from a click.
   ═══════════════════════════════════════════════════════════════════ */

let suppressNextClick = false;
let suppressClearTimer = null;

$queueContent.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;

  const track = e.target.closest('.track');
  if (!track) return;

  const idx = parseInt(track.dataset.queueIndex, 10);
  if (Number.isNaN(idx)) return;

  e.preventDefault();

  const rect = track.getBoundingClientRect();

  pointerDrag = {
    startX: e.clientX,
    startY: e.clientY,
    sourceIdx: idx,
    sourceEl: track,
    active: false,
    lastTarget: null,
    // Where within the row the user grabbed, so the ghost can be
    // positioned with the same point under the cursor as they drag.
    grabOffsetX: e.clientX - rect.left,
    grabOffsetY: e.clientY - rect.top,
    ghost: null,
  };
});

document.addEventListener('mousemove', (e) => {
  if (!pointerDrag) return;

  if (!pointerDrag.active) {
    const dx = e.clientX - pointerDrag.startX;
    const dy = e.clientY - pointerDrag.startY;
    if (dx * dx + dy * dy < 25) return;

    pointerDrag.active = true;
    pointerDrag.sourceEl.classList.add('dragging');
    document.body.style.cursor = 'grabbing';

    // Build the drag preview once, on activation. A clone of the
    // source row, styled fixed and semi-transparent, moved with the
    // cursor via transform so each frame is a GPU composite rather
    // than a layout.
    const rect = pointerDrag.sourceEl.getBoundingClientRect();
    const ghost = pointerDrag.sourceEl.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width  = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);
    pointerDrag.ghost = ghost;
  }

  if (pointerDrag.ghost) {
    pointerDrag.ghost.style.transform =
      `translate(${e.clientX - pointerDrag.grabOffsetX}px, ` +
      `${e.clientY - pointerDrag.grabOffsetY}px)`;
  }

  const under = document.elementFromPoint(e.clientX, e.clientY);
  const targetRow = under && under.closest ? under.closest('.track') : null;

  if (targetRow === pointerDrag.lastTarget) return;
  if (dragOverEl) dragOverEl.classList.remove('drag-over');
  if (targetRow && targetRow !== pointerDrag.sourceEl) {
    targetRow.classList.add('drag-over');
    dragOverEl = targetRow;
  } else {
    dragOverEl = null;
  }
  pointerDrag.lastTarget = targetRow;
});

document.addEventListener('mouseup', () => {
  if (!pointerDrag) return;

  const wasActive = pointerDrag.active;
  const sourceIdx = pointerDrag.sourceIdx;
  const sourceEl  = pointerDrag.sourceEl;
  const targetRow = dragOverEl;
  const ghost     = pointerDrag.ghost;

  // Clear all drag visual state. Done inline rather than through a
  // helper because this is the only place the state is torn down.
  sourceEl.classList.remove('dragging');
  document.body.style.cursor = '';
  if (dragOverEl) dragOverEl.classList.remove('drag-over');
  dragOverEl = null;
  pointerDrag = null;
  if (ghost) ghost.remove();

  // A press without movement is a click; let the click handler run.
  if (!wasActive) return;

  // A real drag completed. The browser is about to fire a click event
  // on whatever element the mouseup landed on; suppress it so the
  // row's click handler (which would trigger track selection) doesn't
  // fire.
  //
  // The flag is normally consumed by the click handler in
  // $queueContent below. But that handler only runs if the click
  // actually lands inside $queueContent — and a drag can end anywhere:
  // the user might release over the header, over the playback bar, or
  // past the edges of the viewport entirely. In those cases no click
  // ever reaches the handler, the flag stays true, and the *next*
  // legitimate click on a queue row is silently swallowed.
  //
  // The timer below is the safety net. A task-queue timeout fires
  // after the browser has dispatched any pending click (click is
  // dispatched synchronously after mouseup, before the next macrotask),
  // so a real suppression is never cut short — but a stranded flag is
  // cleared before the user can produce a genuine click to absorb it.
  suppressNextClick = true;
  clearTimeout(suppressClearTimer);
  suppressClearTimer = setTimeout(() => {
    suppressNextClick = false;
    suppressClearTimer = null;
  }, 0);

  if (!targetRow) return;
  const to = parseInt(targetRow.dataset.queueIndex, 10);
  if (Number.isNaN(to) || to === sourceIdx) return;

  performQueueReorder(sourceIdx, to);
});

/* The reorder logic, extracted from the old drop handler. Runs after
   a pointer drag completes. */
async function performQueueReorder(from, to) {
  // HQPlayer's PlaylistMove commands are destructive on a
  // SetTransportPath transport: they empty the queue and stop
  // playback. On a real PlaylistUpload queue they preserve both. The
  // client's playbackMode flag distinguishes the two, and reordering
  // is only offered in the safe case.
  if (playbackMode !== 'queue') {
    showNotification('Reordering is only available in queue mode', true);
    renderQueueView();
    return;
  }

  // Capture transport state before the move. HQPlayer's transport
  // pointer tracks position, so if the move shifts items around the
  // current index, the pointer lands on whatever item now sits there.
  //
  // The "is playing" signal comes from the DOM, not from lastStatus.
  // lastStatus.state can be stale by a poll or momentarily non-
  // 'playing' — the server maps HQPlayer's state attribute through
  // {0: stopped, 1: paused, 2: playing} and returns 'stopped' for
  // anything else, so a single transient report leaves the flag wrong
  // until the next poll. The .playing class is what the client
  // currently displays and what the user is acting on.
  const playingRowEl = $queueContent.querySelector('.track.playing');
  const wasPlaying   = !!playingRowEl;
  const oldTrackPos  = playingRowEl
    ? parseInt(playingRowEl.dataset.queueIndex, 10)
    : (lastStatus && lastStatus.track ? lastStatus.track : null);
  const oldTime      = lastStatus ? Math.floor(lastStatus.position || 0) : 0;

  // Optimistic DOM reorder. The gesture needs the visual move to
  // happen on release, not after a round-trip. The server confirms
  // the same order asynchronously; on failure, renderQueueView
  // refetches and the server's order replaces the optimistic one.
  const rows = [...$queueContent.querySelectorAll('.track')];
  const fromRow = rows.find(r => parseInt(r.dataset.queueIndex, 10) === from);
  const toRow   = rows.find(r => parseInt(r.dataset.queueIndex, 10) === to);
  if (fromRow && toRow) {
    if (to > from) {
      toRow.after(fromRow);
    } else {
      toRow.before(fromRow);
    }
    $queueContent.querySelectorAll('.track').forEach((row, i) => {
      row.dataset.queueIndex = String(i + 1);
      row.querySelector('.track-num').textContent = String(i + 1);
    });
  }

  try {
    const res = await fetch(`${API_BASE}/queue-move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Re-assert the originally-playing track at its new index. Only
    // needed when the move actually shifted its position — if the
    // playing track was outside the affected range, HQPlayer's
    // pointer is still valid and a re-select would needlessly restart
    // a track that was already playing fine.
    if (wasPlaying && oldTrackPos !== null) {
      const newTrackPos = positionAfterMove(oldTrackPos, from, to);

      if (newTrackPos !== oldTrackPos) {
        // Move the highlight optimistically BEFORE the round-trips
        // below. HQPlayer's transport pointer lands on the wrong item
        // while the reorder settles, and the status poll picks that up
        // during the select/seek window — without this, the highlight
        // reverts to the pre-move row for the duration of the pause.
        //
        // pendingQueueTrack is what makes the update stick: the poll
        // reconciliation at the top of status.js sees the stale value
        // from the server, compares it against pendingQueueTrack.pos,
        // and substitutes the client's belief until the server
        // confirms (or the window expires).
        if (lastStatus) {
          lastStatus.track = newTrackPos;
          lastStatus.state = 'playing';
        }
        pendingQueueTrack = { pos: newTrackPos, until: Date.now() + 5000 };

        updatePlayingTrackHighlight();

        await fetch(`${API_BASE}/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ track: newTrackPos })
        });

        if (oldTime > 2) {
          await fetch(`${API_BASE}/seek`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ time: oldTime })
          });
        }
      }
    }

    // Refresh the cache so it matches the new order. No re-render —
    // the optimistic DOM reorder already shows the new sequence, and
    // rebuilding innerHTML would force every cover image to reload,
    // producing a visible flicker.
    const tracks = await syncQueueFromServer();
    if (tracks) lastKnownQueue = tracks;

    // Force the next status poll's restore to re-derive the playback
    // bar. The reorder changed which item occupies the playing position
    // without changing the position number, so neither status.js's
    // lastSeenQueuePosition comparison nor restorePlaybackFromServer's
    // own `if (currentPlayback.album) return;` guard detects the change.
    // Nulling currentPlayback bypasses both and lets the next poll
    // resolve against the cache we just refreshed.
    currentPlayback.album = null;
    currentPlayback.trackIndex = -1;
  } catch {
    showNotification('Failed to reorder queue', true);
    renderQueueView();
  }
}

$queueContent.addEventListener('contextmenu', (e) => {
  const track = e.target.closest('.track');
  if (!track) return;
  e.preventDefault();

  const index = parseInt(track.dataset.queueIndex, 10);
  if (Number.isNaN(index)) return;

  showContextMenu(e.clientX, e.clientY, [
    { label: 'Remove from Queue', action: () => removeFromQueue(index) },
    { separator: true },
    { label: 'Clear Queue', danger: true, action: clearQueue }
  ]);
});

async function removeFromQueue(index) {
  try {
    const res = await fetch(`${API_BASE}/queue-remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Remove just the affected row rather than rebuilding the whole
    // list. A full innerHTML replacement discards every cover image
    // element and forces them all to reload — a visible flicker on
    // every removal, and the cost grows with the queue length. The
    // row to remove is identified by its 1-based data-queue-index,
    // which the client last set during renderQueueFromTracks.
    const row = $queueContent.querySelector(
      `.track[data-queue-index="${index}"]`
    );

    if (!row) {
      // The row wasn't found — the queue changed underneath us.
      // Fall back to a full refresh.
      renderQueueView();
      return;
    }

    row.remove();

    // Renumber the rows that followed the removed one. Only their
    // data-queue-index and displayed number change — the row
    // elements themselves, including their cover images, are kept.
    //
    // The strict-greater-than is deliberate: only rows with an index
    // greater than the removed one shift down. The row at `index`
    // has already been removed above, so `i >= index` and `i > index`
    // are equivalent in this execution order — but `>` states the
    // invariant directly and stays correct if the ordering ever
    // changes.
    $queueContent.querySelectorAll('.track[data-queue-index]').forEach(r => {
      const i = parseInt(r.dataset.queueIndex, 10);
      if (i > index) {
        r.dataset.queueIndex = String(i - 1);
        r.querySelector('.track-num').textContent = String(i - 1);
      }
    });

    // Keep lastKnownQueue in sync so restore.js resolves the playing
    // track against the current queue rather than the pre-removal one.
    if (lastKnownQueue.length >= index) {
      lastKnownQueue.splice(index - 1, 1);
    }

    // If that was the last row, swap in the empty state. The wrapper
    // is deliberately absent — renderQueueFromTracks writes the empty
    // message the same way, so both paths leave $queueContent in the
    // same shape.
    if (!$queueContent.querySelector('.track')) {
      $queueContent.innerHTML =
        '<div class="loading is-empty">The queue is empty.</div>';
    }
  } catch {
    showNotification('Failed to remove from queue', true);
  }
}

async function clearQueue() {
  try {
    const res = await fetch(`${API_BASE}/queue-clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    playbackMode = null;
    sessionStorage.removeItem('hqp.playbackMode');
    currentPlayback = {
      album: null,
      trackIndex: -1,
      isPlaying: false,
      duration: 0,
      startTime: 0,
      offset: 0
    };

    // Suppress the status poll's restore path until HQPlayer's
    // transport has actually unloaded. Without this, a poll landing in
    // the gap between PlaylistClear and the transport reporting empty
    // sees the stale track with transport_loaded: true, passes
    // restorePlaybackFromServer's guard, and repopulates
    // currentPlayback.album — undoing the clear.
    clearGracePeriodUntil = Date.now() + 4000;

    updatePlaybackUI();
    updatePlayingTrackHighlight();

    // The queue is empty; the resolver has nothing left to look up.
    // Without this, lastKnownQueue still holds the pre-clear entries
    // and the next status poll would resolve the playing track
    // against a queue that no longer exists.
    lastKnownQueue = [];

    // Render the empty state directly rather than refetching, which
    // would hit the same stale server state that clearGracePeriodUntil
    // exists to paper over.
    $queueContent.innerHTML = '<div class="loading is-empty">The queue is empty.</div>';
    showNotification('Queue cleared');
  } catch {
    showNotification('Failed to clear queue', true);
  }
}