// events.js
// Depends on: config, state, dom, utils, library, views, transport, volume, toggles, waveform, progress, search
//
// Feature-module listeners (favorites, moreby, hqplayer-menu) register
// themselves in their own files. This file wires the rest.

/* ═══════════════════════════════════════════════════════════════════
   ALBUM GRID — card click, play overlay, keyboard
   ═══════════════════════════════════════════════════════════════════ */

$content.addEventListener('click', (e) => {
  const card = e.target.closest('.album-card');
  if (!card) return;

  const index = parseInt(card.dataset.albumIndex, 10);
  if (!Number.isNaN(index)) showAlbumDetail(index);
});

$content.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;

  const card = e.target.closest('.album-card');
  if (!card) return;

  e.preventDefault();
  const index = parseInt(card.dataset.albumIndex, 10);
  if (!Number.isNaN(index)) showAlbumDetail(index);
});

/* ═══════════════════════════════════════════════════════════════════
   HEADER & TRANSPORT
   ═══════════════════════════════════════════════════════════════════ */

$navBackBtn.addEventListener('click', () => window.history.back());
$navFwdBtn.addEventListener('click', () => window.history.forward());

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

    const isThisAlbum = currentPlayback.album &&
                        currentPlayback.album.baseName === album.baseName &&
                        currentPlayback.album.artist === album.artist;

    if (isThisAlbum) togglePlayPause();
    else playTrackInHQPlayer(currentDetailAlbumIndex, 0);
    return;
  }

  // 2. Reveal Folder (Cover Click)
  const cover = e.target.closest('.album-detail-cover');
  if (cover) {
    const folder = cover.dataset.folder;
    if (folder) {
      fetch(`${API_BASE}/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folder })
      }).catch(() => showNotification('Could not open folder', true));
    }
    return;
  }

  // 3. Play Specific Track
  const track = e.target.closest('.track');
  if (track) {
    const albumIndex = parseInt(track.dataset.albumIndex, 10);
    const trackIndex = parseInt(track.dataset.trackIndex, 10);

    if (!Number.isNaN(albumIndex) && !Number.isNaN(trackIndex)) {
      playTrackInHQPlayer(albumIndex, trackIndex);
    }
    return;
  }
});

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
  if (e.key !== 'Enter' && e.key !== ' ') return;

  const cover = e.target.closest('.album-detail-cover');
  if (cover) {
    e.preventDefault();
    const folder = cover.dataset.folder;
    if (!folder) return;
    fetch(`${API_BASE}/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder })
    }).catch(() => showNotification('Could not open folder', true));
    return;
  }

  const track = e.target.closest('.track');
  if (track) {
    e.preventDefault();
    const albumIndex = parseInt(track.dataset.albumIndex, 10);
    const trackIndex = parseInt(track.dataset.trackIndex, 10);
    if (!Number.isNaN(albumIndex) && !Number.isNaN(trackIndex)) {
      playTrackInHQPlayer(albumIndex, trackIndex);
    }
  }
});