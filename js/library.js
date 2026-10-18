// library.js
// Depends on: config, state, dom, utils, aliases

/* ═══════════════════════════════════════════════════════════════════
   INFINITE SCROLL CHUNKING STATE
   ═══════════════════════════════════════════════════════════════════ */

const renderChunkSize = 100;         // cards per appended chunk
let renderOffset = 0;                // index into currentAlbumsToRender
let currentAlbumsToRender = [];      // snapshot of allAlbums for this cycle
let gridObserver = null;
let currentSentinel = null;          // kept to avoid getElementById on removal

function initGridObserver() {
  if (gridObserver) gridObserver.disconnect();
  // Pre-load the next chunk well before it reaches the viewport so
  // keyboard navigation (Page Down, browser Find) doesn't outrun it.
  gridObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      appendNextChunk();
    }
  }, { rootMargin: '800px 0px' });
}

function appendNextChunk() {
  const grid = document.getElementById('albumGrid');
  if (!grid) return;

  if (currentSentinel) {
    currentSentinel.remove();
    currentSentinel = null;
  }

  const start = renderOffset;
  const end = Math.min(start + renderChunkSize, currentAlbumsToRender.length);

  if (start >= currentAlbumsToRender.length) {
    return; // All albums have been rendered
  }

  let cardsHTML = '';
  for (let i = start; i < end; i++) {
    const album = currentAlbumsToRender[i];
    const safeTitle    = esc(normalizeMusicalKey(album.baseName));
    const safeArtist   = esc(album.artist);
    const safeCoverUrl = esc(album.coverUrl);

    let badgeHTML = '';
    const rate     = parseInt(album.rate, 10) || 0;
    const bits     = parseInt(album.bits, 10) || 0;
    const channels = parseInt(album.channels, 10) || 0;

    const isDSD       = bits === 1 && rate >= 2822400;
    const isHiRes     = bits >= 24 && rate > 44100;
    // channels is guaranteed to be a number by the `|| 0` above, so the
    // Number.isFinite guard would always pass.
    const isNonStereo = channels > 0 && channels !== 2;
    const channelLabel = formatChannelBadge(channels);

    if (isDSD) {
      badgeHTML = `<div class="album-badge dsd">${isNonStereo ? channelLabel : 'DSD'}</div>`;
    } else if (isHiRes) {
      badgeHTML = `<div class="album-badge hires">${isNonStereo ? channelLabel : 'Hi-Res'}</div>`;
    }

    const imgHTML = safeCoverUrl
      ? `<img src="${safeCoverUrl}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
      : '';

    // 'i' is the global index in currentAlbumsToRender (which is
    // allAlbums), so events.js and views.js lookups stay accurate no
    // matter which chunk a card belongs to.
    //
    // No play overlay: the card is a pure navigational tile. Playback
    // is reached from the album detail page or the track rows.
    cardsHTML += `
      <div class="album-card" role="button" tabindex="0"
           aria-label="${safeTitle} by ${safeArtist}"
           data-album-index="${i}">
        <div class="album-cover-wrapper">
          <div class="album-cover">
            ${imgHTML}
          </div>
        </div>
        ${badgeHTML}
        <div class="album-info">
          <div class="album-title">${safeTitle}</div>
          <div class="album-artist">${safeArtist}</div>
        </div>
      </div>`;
  }

  // Append the new chunk to the existing grid (no full reflow)
  grid.insertAdjacentHTML('beforeend', cardsHTML);
  renderOffset = end;

  if (renderOffset < currentAlbumsToRender.length) {
    currentSentinel = document.createElement('div');
    currentSentinel.id = 'albumGridSentinel';
    currentSentinel.className = 'album-grid-sentinel';
    grid.appendChild(currentSentinel);
    gridObserver.observe(currentSentinel);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   5. LIBRARY — grouping, sorting, filtering, grid rendering
   ═══════════════════════════════════════════════════════════════════ */

function groupAlbums(directories) {
  const albumMap = new Map();
  let originalIndex = 0;

  directories.forEach(dir => {
    const albumName = dir.getAttribute('album') || 'Unknown Album';
    const rawArtist = dir.getAttribute('artist') || 'Unknown Artist';
    const artist = canonicalArtist(rawArtist);
    const path = dir.getAttribute('path') || '';
    const albumFolder = getAlbumFolder(path);
    const { baseName, discNumber } = parseAlbumInfo(albumName, path);
    const key = `${baseName}|||${artist}|||${albumFolder}`;

    if (!albumMap.has(key)) {
      const coverPath = dir.getAttribute('cover') || '';
      const date = dir.getAttribute('date') || '';
      albumMap.set(key, {
        baseName,
        artist,               // canonical — drives sort, filter, More-by, display
        rawArtist,            // original tag value, kept for reference
        date,
        // Precomputed so sort and filter don't run the year regex on
        // every comparison / every album on every search.
        year: getYear(date) || '',
        rate: dir.getAttribute('rate') || '',
        bits: dir.getAttribute('bits') || '',
        channels: dir.getAttribute('channels') || '',
        cover: coverPath,
        coverUrl: localPathToUrl(coverPath),
        folder: path,
        genre: dir.getAttribute('genre') || '',
        composer: dir.getAttribute('composer') || '',
        hash: dir.getAttribute('hash') || '',
        discs: [],
        tracks: [],
        totalDuration: 0,
        originalIndex: originalIndex++
      });
    }

    const album = albumMap.get(key);
    album.discs.push({ discNumber, directory: dir });

    const files = dir.querySelectorAll('file');
    let localTrackNum = 1;
    files.forEach(f => {
      album.tracks.push({
        node: f,
        discNumber: discNumber,
        localTrackNum: localTrackNum++
      });
      album.totalDuration += parseInt(f.getAttribute('length'), 10) || 0;
    });
  });

  albumMap.forEach(album => {
    album.discs.sort((a, b) => a.discNumber - b.discNumber);
    album.tracks.sort((a, b) => {
      if (a.discNumber !== b.discNumber) return a.discNumber - b.discNumber;
      return a.localTrackNum - b.localTrackNum;
    });

    // Canonicalize before counting. showComposer drives whether the
    // detail view prints a composer eyebrow above each work, which is
    // only worth the vertical space when the album actually has more
    // than one composer. Counting raw spellings treats "Bach",
    // "J.S. Bach", and "Johann Sebastian Bach" as three distinct
    // composers and turns the eyebrow on for an album that has one.
    const composers = new Set();
    for (const t of album.tracks) {
      const c = canonicalComposer(getTrackComposer(t));
      if (c) composers.add(c);
    }
    album.showComposer = composers.size >= 2;
  });

  return Array.from(albumMap.values());
}

function sortAlbums(albums, sortBy) {
  const sorted = [...albums];
  switch (sortBy) {
    case 'artist': return sorted.sort((a, b) => a.artist.localeCompare(b.artist));
    case 'title':  return sorted.sort((a, b) => a.baseName.localeCompare(b.baseName));
    case 'year':
      return sorted.sort((a, b) => {
        const yearCmp = (a.year || '0').localeCompare(b.year || '0');
        if (yearCmp !== 0) return yearCmp;
        return a.baseName.localeCompare(b.baseName);
      });
    default: return sorted;
  }
}

function applyFiltersAndRender() {
  let displayAlbums = sortAlbums(masterAlbums, currentSort);
  if (currentSearchQuery) {
    const query = currentSearchQuery.toLowerCase();
    displayAlbums = displayAlbums.filter(album => {
      const title    = album.baseName.toLowerCase();
      const artist   = album.artist.toLowerCase();
      const year     = album.year || '';
      const genre    = (album.genre || '').toLowerCase();
      const composer = (album.composer || '').toLowerCase();
      return title.includes(query) || artist.includes(query) || year.includes(query)
          || genre.includes(query) || composer.includes(query);
    });
  }
  allAlbums = displayAlbums;
  renderAlbumGrid(displayAlbums);

  // The grid is rebuilt from scratch each time — the previous scroll
  // position refers to content that no longer exists. Jump to the top
  // so the user sees the first result.
  //
  // Note: history.js calls this from popstate, then calls showGridView(),
  // whose requestAnimationFrame scroll restore runs later and wins. So
  // Back/Forward still lands on the correct scroll position.
  window.scrollTo(0, 0);
}

function applyAriaLabels(container) {
  container.querySelectorAll('[title]').forEach(el => {
    if (!el.hasAttribute('aria-label')) {
      el.setAttribute('aria-label', el.getAttribute('title'));
    }
    el.removeAttribute('title');
  });
}

function renderAlbumGrid(albumsToRender) {
  if (albumsToRender.length === 0) {
    $content.innerHTML = '<div class="loading is-empty">No albums found matching your search.</div>';
    $stats.innerHTML = '';
    return;
  }

  // Stats reflect the full filtered list, not just the first chunk.
  let totalTracks = 0;
  let totalTime = 0;
  for (let i = 0; i < albumsToRender.length; i++) {
    totalTracks += albumsToRender[i].tracks.length;
    totalTime += albumsToRender[i].totalDuration;
  }

  // Reset chunking state for this new render cycle (search, sort, or
  // the initial load).
  currentAlbumsToRender = albumsToRender;
  renderOffset = 0;

  // Fresh grid container — the previous one is discarded entirely.
  $content.innerHTML = '<div class="album-grid" id="albumGrid"></div>';

  $stats.innerHTML = `
    <div class="stat">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.5"/></svg>
      <strong>${albumsToRender.length.toLocaleString()}</strong>
    </div>
    <span class="stat-divider"></span>
    <div class="stat">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V8h4V4h-6z"/></svg>
      <strong>${totalTracks.toLocaleString()}</strong>
    </div>
    <span class="stat-divider"></span>
    <div class="stat">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
      <strong>${formatTotalTime(totalTime)}</strong>
    </div>`;

  initGridObserver();
  appendNextChunk();
}

/* ═══════════════════════════════════════════════════════════════════
   Artist string parsing — split on comma, &, and /; classify each
   component as either a performer or an ensemble (orchestra, choir,
   chamber group, etc.).
   ═══════════════════════════════════════════════════════════════════ */

const ENSEMBLE_KEYWORDS = [
  // English
  'orchestra', 'philharmonic', 'symphony', 'ensemble', 'consort',
  'sinfonia', 'sinfonietta', 'camerata',
  // German
  'orchester', 'philharmoniker', 'staatskapelle', 'kapelle',
  'barockorchester', 'sinfonieorchester', 'streichquartett', 'quartett',
  // French
  'orchestre', 'philharmonique', 'société',
  // Italian
  'orchestrale', 'complesso', 'quartetto',
  // Spanish
  'orquesta',
  // Choir and chorus
  'choir', 'chorus', 'chœur', 'chor',
];

// Ensembles whose names don't contain any of the keywords above.
// Add to this list as you notice misses in the wild.
const KNOWN_ENSEMBLES = [
  'i musici',
  'the english concert',
  'academy of st martin in the fields',
  'les solistes romands',
  'philharmonia hungarica',
];

function splitArtistComponents(artistField) {
  if (!artistField) return [];

  // Split on commas, ampersands (with spaces), and slashes (with spaces).
  // Do not split on bare hyphens — too risky, many names contain them.
  return artistField
    .split(/\s*,\s*|\s+&\s+|\s+\/\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function isEnsemble(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (ENSEMBLE_KEYWORDS.some(kw => lower.includes(kw))) return true;
  if (KNOWN_ENSEMBLES.some(known => known === lower)) return true;
  return false;
}

function performersIn(artistField) {
  return splitArtistComponents(artistField).filter(c => !isEnsemble(c));
}

/* ═══════════════════════════════════════════════════════════════════
   Album lookup with filter-reveal
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Find the index of an album in allAlbums by its folder path.
 *
 * If the album exists in masterAlbums but has been filtered out of
 * allAlbums by an active search, clears the search (updating the search
 * UI to match), re-renders the grid, and returns the new index.
 *
 * Returns -1 if the album doesn't exist in the library at all.
 */
function findOrRevealAlbum(folder) {
  if (!folder) return -1;

  let albumIndex = allAlbums.findIndex(a => a.folder === folder);
  if (albumIndex !== -1) return albumIndex;

  const inMaster = masterAlbums.some(a => a.folder === folder);
  if (!inMaster) return -1;

  currentSearchQuery = '';
  searchInput.value = '';
  searchContainer.classList.remove('has-content');
  searchContainer.classList.remove('expanded');
  applyFiltersAndRender();

  // The grid we just rebuilt is unfiltered. Keep history in sync so
  // Back/Forward don't reapply a query we've already discarded.
  if (history.state
      && history.state.view === 'grid'
      && history.state.query !== '') {
    replaceHistoryEntry({ ...history.state, query: '' });
  }

  return allAlbums.findIndex(a => a.folder === folder);
}