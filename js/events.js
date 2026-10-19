// events.js
// Depends on: config, state, dom, utils, library, views, transport, volume, toggles, waveform, progress, search
//
// Feature-module listeners (favorites, moreby, hqplayer-menu) register
// themselves in their own files. This file wires the rest.

/* ═══════════════════════════════════════════════════════════════════
   ALBUM GRID — card click, play overlay, keyboard
   ═══════════════════════════════════════════════════════════════════ */

function resolveCardAlbum(card) {
  const folder = card?.dataset.albumFolder;
  if (!folder) return { album: null, index: -1 };
  const index = allAlbums.findIndex(album => album.folder === folder);
  return { album: index === -1 ? null : allAlbums[index], index };
}

// Track rows carry the album folder as well as a numeric index. The
// index is baked into the cached tracklist HTML, so it goes stale as
// soon as allAlbums is re-sorted or re-filtered — always resolve by
// folder for anything that can outlive the render.
function resolveTrackAlbumIndex(track) {
  const folder = track?.dataset.albumFolder;
  if (!folder) return -1;
  return allAlbums.findIndex(album => album.folder === folder);
}

function focusGridCard(card) {
  const current = $content.querySelector('.album-card[tabindex="0"]');
  if (current && current !== card) current.tabIndex = -1;
  card.tabIndex = 0;
  card.focus();
}

function ensureGridIndexRendered(targetIndex) {
  while (renderOffset <= targetIndex
      && renderOffset < currentAlbumsToRender.length) {
    appendNextChunk();
  }
}

function moveGridFocus(card, key) {
  const currentIndex = Number.parseInt(card.dataset.albumIndex, 10);
  if (Number.isNaN(currentIndex)) return false;

  const grid = document.getElementById('albumGrid');
  const columns = grid
    ? getComputedStyle(grid).gridTemplateColumns.split(' ').length
    : 1;
  let next = currentIndex;
  if (key === 'ArrowRight') next++;
  else if (key === 'ArrowLeft') next--;
  else if (key === 'ArrowDown') next += columns;
  else if (key === 'ArrowUp') next -= columns;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = currentAlbumsToRender.length - 1;
  else return false;

  next = Math.max(0, Math.min(currentAlbumsToRender.length - 1, next));
  ensureGridIndexRendered(next);
  const target = $content.querySelector(`.album-card[data-album-index="${next}"]`);
  if (target) focusGridCard(target);
  return true;
}

$content.addEventListener('click', (e) => {
  const card = e.target.closest('.album-card');
  if (!card) return;

  const { index } = resolveCardAlbum(card);
  if (index !== -1) {
    focusGridCard(card);
    showAlbumDetail(index);
  }
});

$content.addEventListener('keydown', (e) => {
  const card = e.target.closest('.album-card');
  if (!card) return;

  if (moveGridFocus(card, e.key)) {
    e.preventDefault();
    return;
  }

  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const { album, index } = resolveCardAlbum(card);
    if (index !== -1) {
      lastKeyboardGridAlbumFolder = album.folder;
      detailFocusOnOpen = true;
      showAlbumDetail(index);
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════
   HEADER & TRANSPORT
   ═══════════════════════════════════════════════════════════════════ */

$navBackBtn.addEventListener('click', () => window.history.back());

$prevBtn.addEventListener('click', () => { if (!tryLocalSkip(-1)) sendCommand('prev'); });
$pbPlayPauseBtn.addEventListener('click', togglePlayPause);
$nextBtn.addEventListener('click', () => { if (!tryLocalSkip(+1)) sendCommand('next'); });

$shuffleBtn.addEventListener('click', toggleShuffle);
$repeatBtn.addEventListener('click', cycleRepeat);

$hqBtn.addEventListener('click', handleHqButtonClick);
$volBtn.addEventListener('click', toggleMute);

function updateSortButton() {
  const label = currentSort.charAt(0).toUpperCase() + currentSort.slice(1);
  $sortBtn.querySelector('.sort-cycle-label').textContent = label;
  $sortBtn.setAttribute('aria-label', `Sort by ${label}`);
}

$sortBtn.addEventListener('click', () => {
  const idx = SORT_ORDER.indexOf(currentSort);
  currentSort = SORT_ORDER[(idx + 1) % SORT_ORDER.length];
  updateSortButton();
  savedScrollPosition = 0;
  applyFiltersAndRender();
});

/* ═══════════════════════════════════════════════════════════════════
   ALBUM DETAIL — consolidated click & keyboard handlers
   ═══════════════════════════════════════════════════════════════════ */

// Single delegated click handler for every interactive element inside
// the detail view. Early returns ensure only one action is dispatched
// per click, even if selectors overlap (the play button sits inside
// the header, the cover sits inside the same container, etc.).
//
// Synchronous by design: the only network call (reveal folder) is
// genuinely fire-and-forget, so there's no reason to make the handler
// async and force every future branch to carry its own error handling.
$detailContent.addEventListener('click', (e) => {
  // 1. Play/Pause Album Button
  const playBtn = e.target.closest('.album-play-btn');
  if (playBtn) {
    if (currentDetailAlbumIndex === -1) return;
    const album = allAlbums[currentDetailAlbumIndex];
    if (!album) return;

    const isThisAlbum = isSameAlbum(currentPlayback.album, album);

    if (isThisAlbum) togglePlayPause();
    else playTrackInHQPlayer(currentDetailAlbumIndex, 0);
    return;
  }

  // 2. Reveal Folder (Cover Click)
  const cover = e.target.closest('.album-detail-cover');
  if (cover) {
    revealFolder(cover.dataset.albumFolder);
    return;
  }

  // 3. Play Specific Track
  const track = e.target.closest('.track');
  if (track) {
    const albumIndex = resolveTrackAlbumIndex(track);
    const trackIndex = parseInt(track.dataset.trackIndex, 10);

    if (albumIndex !== -1 && !Number.isNaN(trackIndex)) {
      playTrackInHQPlayer(albumIndex, trackIndex);
    }
    return;
  }
});

function revealFolder(path) {
  if (!path) return;
  fetch(`${API_BASE}/reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  }).catch(() => showNotification('Could not open folder', true));
}

// Keyboard handler for the two element types in the detail view that
// aren't real <button> elements and therefore don't fire click on
// Enter/Space natively: the reveal cover (role="button" tabindex="0")
// and the track rows (role="button" tabindex="0").
//
// The album play button and the favourite heart are real <button>
// elements — the browser synthesises a click for them on Enter/Space,
// which the delegated click handler above already catches. No keyboard
// handling is needed for those.
$detailContent.addEventListener('keydown', (e) => {
  const cover = e.target.closest('.album-detail-cover');
  const track = e.target.closest('.track');

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    // Arrow keys move through the tracklist without activating.
    // Enter/Space is still required to play a row.
    if (!track) return;
    e.preventDefault();
    const rows = Array.from($detailContent.querySelectorAll('.track'));
    const next = rows.indexOf(track) + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= rows.length) return;
    rows.forEach(row => { row.tabIndex = -1; });
    rows[next].tabIndex = 0;
    rows[next].focus();
    return;
  }

  if (e.key !== 'Enter' && e.key !== ' ') return;

  if (cover) {
    e.preventDefault();
    revealFolder(cover.dataset.albumFolder);
    return;
  }

  if (track) {
    e.preventDefault();
    const albumIndex = resolveTrackAlbumIndex(track);
    const trackIndex = parseInt(track.dataset.trackIndex, 10);
    if (albumIndex !== -1 && !Number.isNaN(trackIndex)) {
      playTrackInHQPlayer(albumIndex, trackIndex);
    }
  }
});