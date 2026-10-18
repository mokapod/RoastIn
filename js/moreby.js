// moreby.js
// Depends on: config, state, dom, utils, aliases, library, views, notifications

/* ═══════════════════════════════════════════════════════════════════
   ROW COMPUTATION & MARKUP
   ═══════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
   LIBRARY RE-AGGREGATION AFTER ALIAS CHANGE
   ═══════════════════════════════════════════════════════════════════
   Aliases are applied once, at bootstrap, inside groupAlbums. After
   a merge, the canonical-name maps change but the album objects do
   not — their .artist and .composer fields still hold the pre-merge
   values. Every consumer of those fields (grid display, sort,
   filter, detail header, More-by labels) shows a stale name until
   the page is reloaded.

   This function rebuilds masterAlbums from the cached directory
   nodes and re-resolves the two positions the app tracks by object
   reference: the currently displayed album (currentDetailAlbumIndex
   into allAlbums) and the currently playing album (currentPlayback
   .album). Both are stored as indices or references and would point
   at detached objects after the rebuild.
   ────────────────────────────────────────────────────────────────── */

function reindexLibraryAfterAliasChange() {
  if (!libraryDirectories || libraryDirectories.length === 0) return;

  // Capture the scroll position before anything can reset it. The
  // detail view's More-by section sits near the bottom of the page,
  // so the user almost always triggers a merge from a scrolled-down
  // position — restoring that position is what makes the interaction
  // feel like nothing moved.
  const savedScrollY = window.scrollY || window.pageYOffset;

  // Resolve current positions by stable identifiers before the
  // rebuild replaces every album object. Folder is unique per album
  // and survives regrouping; the index into allAlbums does not.
  const detailFolder = currentDetailAlbumIndex !== -1
    ? allAlbums[currentDetailAlbumIndex]?.folder ?? null
    : null;

  const playingFolder     = currentPlayback.album?.folder ?? null;
  const playingTrackIndex = currentPlayback.trackIndex;

  // Rebuild the library. Every album object is replaced; any held
  // references into the old array are now detached.
  masterAlbums = groupAlbums(libraryDirectories);

  // Rebuild the sorted/filtered view. This populates allAlbums with
  // fresh objects and re-renders the grid. It scrolls to 0, which we
  // undo below.
  applyFiltersAndRender();

  // Re-resolve currentPlayback.album. The track count can change if
  // two previously-separate albums merged into one, so the stored
  // index is validated against the new length.
  if (playingFolder) {
    const newAlbum = masterAlbums.find(a => a.folder === playingFolder);
    if (newAlbum) {
      currentPlayback.album = newAlbum;
      if (playingTrackIndex >= newAlbum.tracks.length) {
        currentPlayback.trackIndex = -1;
      }
    } else {
      currentPlayback.album = null;
      currentPlayback.trackIndex = -1;
    }
  }

  // Restore the detail view, if it was open. showAlbumDetail re-reads
  // allAlbums by index, so we look up the new index by folder first.
  if (detailFolder) {
    const newIndex = allAlbums.findIndex(a => a.folder === detailFolder);
    if (newIndex !== -1) {
      currentDetailAlbumIndex = newIndex;
      showAlbumDetail(newIndex, false, true);
      // showAlbumDetail captured 0 (applyFiltersAndRender's scroll)
      // and scheduled a restore to 0. Override it on the same frame
      // with the position we captured at the top.
      requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
    } else {
      currentDetailAlbumIndex = -1;
      showGridView();
      requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
    }
  } else {
    // Grid view — just restore the grid's scroll.
    requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
  }

  // The track rows were re-created by showAlbumDetail; reapply the
  // playing highlight against the fresh DOM.
  updatePlayingTrackHighlight();
}

/* ── More-by HTML cache ──
   buildMoreByRowsHTML walks every album in masterAlbums (O(n)) and
   runs canonical-name lookups on each artist and composer. The result
   is deterministic for a given library + alias state, so caching per
   album folder turns re-opening a detail view into a Map lookup
   instead of a full scan.

   Invalidated by clearMoreByCache() when aliases change — the
   canonical maps feed the row labels, so a merge makes old HTML stale. */
const moreByCache = new Map();
const MORE_BY_CACHE_MAX = 200;

function cacheMoreByHTML(folder, html) {
  boundedSet(moreByCache, folder, html, MORE_BY_CACHE_MAX);
}

function clearMoreByCache() {
  moreByCache.clear();
}

function buildMoreByRowsHTML(album) {
  const cached = moreByCache.get(album.folder);
  if (cached !== undefined) return cached;

  const html = computeMoreByRowsHTML(album);
  cacheMoreByHTML(album.folder, html);
  return html;
}

function computeMoreByRowsHTML(album) {
  const isClassical = isClassicalGenre(album.genre);

  const performers = [...new Set(
    performersIn(album.artist).map(canonicalArtist)
  )];
  const performerSet = new Set(performers);

  // Decide up front whether a composer row is even possible. Same three
  // conditions the row-building code below enforces, hoisted here so the
  // album scan can filter on the way in rather than building a full
  // library-wide map and discarding almost all of it.
  const composerKey = (
    isClassical
    && album.composer
    && !performerSet.has(canonicalComposer(album.composer))
  ) ? canonicalComposer(album.composer) : null;

  const sortAlbumsByYearThenTitle = (a, b) => {
    const yearCmp = (getYear(a.date) || '0').localeCompare(getYear(b.date) || '0');
    if (yearCmp !== 0) return yearCmp;
    return a.baseName.localeCompare(b.baseName);
  };

  // Single pass over masterAlbums, grouped by the specific names we'll
  // actually display. Splitting each album's artist field once and
  // filtering against performerSet keeps the maps to at most a handful
  // of entries, regardless of library size.
  const albumsByPerformer = new Map();
  const albumsByComposer  = new Map();

  for (const a of masterAlbums) {
    if (a.folder === album.folder) continue;

    for (const p of performersIn(a.artist).map(canonicalArtist)) {
      if (!performerSet.has(p)) continue;
      let bucket = albumsByPerformer.get(p);
      if (!bucket) { bucket = []; albumsByPerformer.set(p, bucket); }
      bucket.push(a);
    }

    if (composerKey && a.composer && canonicalComposer(a.composer) === composerKey) {
      let bucket = albumsByComposer.get(composerKey);
      if (!bucket) { bucket = []; albumsByComposer.set(composerKey, bucket); }
      bucket.push(a);
    }
  }

  const moreByRows = [];

  for (const person of performers) {
    const albums = albumsByPerformer.get(person) || [];
    if (albums.length > 0) {
      moreByRows.push({
        label: person,
        albums: albums.sort(sortAlbumsByYearThenTitle),
        field: 'artist'
      });
    }
  }

  if (composerKey) {
    const albums = albumsByComposer.get(composerKey) || [];
    if (albums.length > 0) {
      moreByRows.push({
        label: composerKey,
        albums: albums.sort(sortAlbumsByYearThenTitle),
        field: 'composer'
      });
    }
  }

  const MAX_ROWS = 4;
  const visibleRows = moreByRows.slice(0, MAX_ROWS);
  if (visibleRows.length === 0) return '';

  return `
    <div class="more-by-sentinel"></div>
    <div class="more-by-section" data-visible="false">
      ${visibleRows.map(row => `
        <div class="more-by-row">
          <h2 class="more-by-heading">
            <span class="more-by-heading-text">Also by ${esc(row.label)}</span>
            <button class="more-by-edit"
                    type="button"
                    data-more-by-label="${esc(row.label)}"
                    data-more-by-field="${esc(row.field || '')}"
                    aria-label="Merge ${esc(row.label)} with another name">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="1"/>
                <circle cx="19" cy="12" r="1"/>
                <circle cx="5" cy="12" r="1"/>
              </svg>
            </button>
          </h2>
          <div class="more-by-grid">
            ${row.albums.map(a => `
              <div class="more-by-card" role="button" tabindex="0"
                   data-album-folder="${esc(a.folder)}"
                   aria-label="${esc(a.baseName)}">
                <div class="more-by-cover">
									${a.coverUrl ? `<img src="${esc(a.coverUrl)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
								</div>
                <div class="more-by-title">${esc(normalizeMusicalKey(a.baseName))}</div>
                <div class="more-by-year">${esc(getYear(a.date) || '')}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════
   SCROLL REVEAL
   ═══════════════════════════════════════════════════════════════════ */

let moreByObserver = null;

function disconnectMoreByObserver() {
  if (moreByObserver) {
    moreByObserver.disconnect();
    moreByObserver = null;
  }
}

function observeMoreBySentinel(animate = true) {
  disconnectMoreByObserver();

  const sentinel = $detailContent.querySelector('.more-by-sentinel');
  const section  = $detailContent.querySelector('.more-by-section');
  if (!sentinel || !section) return;

  if (!animate) {
    section.dataset.instant = 'true';
    section.dataset.visible = 'true';
    return;
  }

  moreByObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        section.dataset.visible = 'true';
        disconnectMoreByObserver();
        break;
      }
    }
  }, { rootMargin: '0px 0px 200px 0px' });

  moreByObserver.observe(sentinel);
}

/* ═══════════════════════════════════════════════════════════════════
   MERGE PICKER — candidates and markup
   ═══════════════════════════════════════════════════════════════════ */

function moreByCandidates(label, field, album) {
  const seen = new Set();
  const out  = [];

  function push(name) {
    if (!name || name === label || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  }

  // Seed with the current album's credited performers. The album's own
  // composer is not seeded here: for a composer row, `label` already
  // equals that name, and push() would reject it anyway.
  for (const p of performersIn(album.artist)) {
    push(canonicalArtist(p));
  }

  // Extend with any name in the library that starts with the same word.
  // Bounded at 12 candidates so the picker doesn't grow unbounded on a
  // large library with a common first word.
  const firstWord = label.split(/\s+/)[0]?.toLowerCase();
  if (firstWord && firstWord.length >= 3) {
    for (const a of masterAlbums) {
      if (out.length >= 12) break;

      if (a.composer) {
        const canonical = canonicalComposer(a.composer);
        if (canonical.toLowerCase().startsWith(firstWord)) push(canonical);
      }

      if (out.length < 12) {
        for (const p of performersIn(a.artist)) {
          const canonical = canonicalArtist(p);
          if (canonical.toLowerCase().startsWith(firstWord)) push(canonical);
          if (out.length >= 12) break;
        }
      }
    }
  }

  return out.slice(0, 12);
}

function buildMoreByPickerHTML(label, field, candidates) {
  const list = candidates.length
    ? candidates.map(c => `
        <button class="more-by-pick" type="button" data-target="${esc(c)}">
          ${esc(c)}
        </button>
      `).join('')
    : '<div class="more-by-pick-empty">No suggestions.</div>';

  return `
    <div class="more-by-picker" role="dialog" aria-label="Merge name">
      <div class="more-by-picker-title">Merge into…</div>
      <div class="more-by-picker-current">
        Current: <strong>${esc(label)}</strong>
      </div>
      <input type="text"
             class="more-by-picker-input"
             placeholder="Type a name, or pick below"
             value="">
      <div class="more-by-picker-suggestions">${list}</div>
      <div class="more-by-picker-actions">
        <button type="button" class="more-by-picker-cancel">Cancel</button>
        <button type="button" class="more-by-picker-confirm">Merge</button>
      </div>
      <div class="more-by-picker-error" role="alert" hidden></div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════
   MERGE PICKER — open / close / submit
   ═══════════════════════════════════════════════════════════════════ */

function closeMoreByPicker() {
  const backdrop = document.querySelector('.more-by-picker-backdrop');
  if (backdrop) backdrop.remove();
}

function openMoreByPicker(label, field, candidates) {
  closeMoreByPicker();

  const backdrop = document.createElement('div');
  backdrop.className = 'more-by-picker-backdrop';
  backdrop.innerHTML = buildMoreByPickerHTML(label, field, candidates);
  document.body.appendChild(backdrop);

  const input = backdrop.querySelector('.more-by-picker-input');
  input.focus();

  // Delegated click handling for the suggestion chips. Rebuilds of the
  // chip list (if any ever happen) won't require re-binding.
  const suggestionsContainer = backdrop.querySelector('.more-by-picker-suggestions');
  suggestionsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.more-by-pick');
    if (!btn) return;
    input.value = btn.dataset.target;
    input.focus();
  });

  backdrop.querySelector('.more-by-picker-cancel')
    .addEventListener('click', closeMoreByPicker);

  backdrop.querySelector('.more-by-picker-confirm')
    .addEventListener('click', () => submitMoreByMerge(label, field, input, backdrop));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitMoreByMerge(label, field, input, backdrop);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMoreByPicker();
    }
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeMoreByPicker();
  });
}

async function submitMoreByMerge(label, field, input, backdrop) {
  const target  = input.value.trim();
  const errorEl = backdrop.querySelector('.more-by-picker-error');

  if (!target) {
    errorEl.textContent = 'Enter or pick a name';
    errorEl.hidden = false;
    return;
  }
  if (target === label) {
    errorEl.textContent = 'Target is the same as source';
    errorEl.hidden = false;
    return;
  }

  const confirmBtn = backdrop.querySelector('.more-by-picker-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Merging…';

  try {
    const res = await fetch(`${API_BASE}/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, target, source: label }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    closeMoreByPicker();
    showNotification(`Merged "${label}" into "${target}"`);

    await reloadAliases();
    clearMoreByCache();
    reindexLibraryAfterAliasChange();
  } catch (err) {
    errorEl.textContent = err.message || 'Merge failed';
    errorEl.hidden = false;
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Merge';
  }
}

/* ═══════════════════════════════════════════════════════════════════
   WIRING — delegated listeners on the detail container
   ═══════════════════════════════════════════════════════════════════ */

// Open the merge picker from the "..." button next to a row heading.
$detailContent.addEventListener('click', (e) => {
  const btn = e.target.closest('.more-by-edit');
  if (!btn) return;

  e.stopPropagation();

  const label = btn.dataset.moreByLabel;
  const field = btn.dataset.moreByField;
  if (!label || !field) return;
  if (currentDetailAlbumIndex === -1) return;

  const album = allAlbums[currentDetailAlbumIndex];
  if (!album) return;

  openMoreByPicker(label, field, moreByCandidates(label, field, album));
});

function navigateToMoreByCard(card) {
  const folder = card.dataset.albumFolder;
  if (!folder) return;

  const albumIndex = findOrRevealAlbum(folder);
  if (albumIndex === -1) {
    showNotification('Album not found in library.', true);
    return;
  }

  showAlbumDetail(albumIndex);
}

$detailContent.addEventListener('click', (e) => {
  const card = e.target.closest('.more-by-card');
  if (!card) return;
  navigateToMoreByCard(card);
});

$detailContent.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;

  const card = e.target.closest('.more-by-card');
  if (!card) return;

  e.preventDefault();
  navigateToMoreByCard(card);
});