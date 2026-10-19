// views.js
// Depends on: config, state, dom, utils, aliases, library, moreby, workgroup, notifications

/* ═══════════════════════════════════════════════════════════════════
   VIEW SWITCHING
   ═══════════════════════════════════════════════════════════════════ */

function showGridView() {
  // Capture the queue's scroll position before hiding it. The Escape
  // handler in queue.js calls showGridView directly rather than going
  // through hideQueueView, so this is the one place that sees every
  // exit from the queue view and can record the position.
  if (isQueueView) {
    savedQueueScrollPosition = window.scrollY || window.pageYOffset;
  }

  disconnectMoreByObserver();
  currentDetailAlbumIndex = -1;
  isQueueView = false;
  $queueView.classList.remove('active');
  $gridView.style.display = 'block';
  $detailArtist = null;
  $detailView.classList.remove('active');
  $detailView.removeAttribute('data-tint');
  $detailView.style.removeProperty('--album-tint');
  $detailView.style.removeProperty('--album-glow');
  $header.classList.remove('is-detail', 'is-opaque', 'is-queue');
  $header.classList.toggle('is-scrolled', savedScrollPosition > 10);
  $header.classList.add('is-grid');
  $headerInfo.classList.remove('active', 'visible');
  isDetailView = false;
  if (gridRenderPending) {
    // A debounced filter settled while detail/queue was open. Apply it
    // only after those modes are cleared, then keep the rebuilt grid at
    // its first result rather than restoring an obsolete scroll offset.
    savedScrollPosition = 0;
    applyFiltersAndRender();
  }
  observeDetailArtist();
  updateNavButtons();
  requestAnimationFrame(() => {
    window.scrollTo(0, savedScrollPosition);
    if (lastKeyboardGridAlbumFolder) {
      const index = allAlbums.findIndex(
        album => album.folder === lastKeyboardGridAlbumFolder
      );
      if (index !== -1) ensureGridIndexRendered(index);
      const card = index === -1 ? null : $content.querySelector(
        `.album-card[data-album-index="${index}"]`
      );
      const fallback = $content.querySelector('.album-card');
      if (card || fallback) focusGridCard(card || fallback);
      lastKeyboardGridAlbumFolder = null;
    }
  });
  updatePlaybackBarMode();
}

/* ═══════════════════════════════════════════════════════════════════
   TRACKLIST
   ═══════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
   TRACKLIST HTML CACHE
   ═══════════════════════════════════════════════════════════════════
   buildTracklistHTML walks every track, runs work grouping and
   canonical-name lookups, and builds a large string. That output is
   deterministic for a given album + alias state, so re-opening an
   album can be a Map lookup. Cleared whenever aliases change, because
   the composer/performer labels come from the canonical maps. */

const tracklistCache = new Map();
const TRACKLIST_CACHE_MAX = 60;

function clearTracklistCache() {
  tracklistCache.clear();
}

function buildTracklistHTML(album, opts) {
  const cached = boundedGet(tracklistCache, album.folder);
  if (cached !== CACHE_MISS) return cached;

  const html = computeTracklistHTML(album, opts);
  boundedSet(tracklistCache, album.folder, html, TRACKLIST_CACHE_MAX);
  return html;
}

function computeTracklistHTML(album, opts) {
  const { isMultiDisc, showTrackComposer, isVariousArtists, useWorkGrouping } = opts;

  // Heading level tracks the outline: the album title is h1, a multi-disc
  // album puts disc headers at h2 and works at h3. Single-disc albums have
  // no disc header, so their works sit directly under the h1 as h2.
  const workHeadingTag = isMultiDisc ? 'h3' : 'h2';


  function renderTrack(entry, workDisplay, hideArtist, showComposerAbove) {
    const t   = entry.track;
    const f   = t.node;
    // Disc information is now carried by the disc header above each
    // group of tracks. The row itself shows only the local track
    // number, so the number column never has to fit "1-10" or
    // similar — it fits at most two characters.
    const num = t.localTrackNum;

    const title   = entry.movement;
    const numberInTitle = movementCarriesOwnNumber(title);
    const fArtist = effectiveArtist(t, album);
    const length  = parseInt(f.getAttribute('length')) || 0;

    const safeTitle  = esc(normalizeMusicalKey(title));
    const safeArtist = esc(fArtist);
    const ariaArtist = esc(fArtist || album.artist);
    const workCtx    = workDisplay ? `, from ${esc(workDisplay)}` : '';
    const trackPos   = `track ${entry.globalIndex + 1} of ${album.tracks.length}`;
    const duration   = formatTime(length);

    const composerForTrack = showComposerAbove ? getTrackComposer(t) : '';
    const composerTag = composerForTrack
      ? `<div class="track-composer">${esc(canonicalComposer(composerForTrack))}</div>`
      : '';

    const isDifferentArtist = isVariousArtists && fArtist !== album.artist;
    const performerTag = (isDifferentArtist && !hideArtist)
      ? `<div class="track-performer">${esc(fArtist)}</div>`
      : '';

    return `<div class="track${numberInTitle ? ' num-in-title' : ''}" role="button"
			tabindex="${entry.globalIndex === 0 ? '0' : '-1'}"
			data-track-index="${entry.globalIndex}"
			data-album-folder="${esc(album.folder)}"
			aria-label="${safeTitle}${workCtx} by ${ariaArtist}, ${trackPos}, ${duration}">
        <span class="track-play-icon">${TRACK_EQ_ICON}${TRACK_PLAY_ICON}</span>
        <span class="track-num">${num}</span>
        <div class="track-info">
          ${composerTag}
          <div class="track-name">${safeTitle}</div>
          ${performerTag}
        </div>
        <span class="track-length">${duration}</span>
      </div>`;
  }

  // Build the blocks for one disc's worth of entries. The blocks
  // structure is identical to the single-disc case — the only thing
  // that differs is which subset of the album's tracks the blocks
  // are built from.
  function buildBlocksForEntries(entries) {
    if (useWorkGrouping) {
      return groupTracksByWork(album, entries);
    }
    return [{
      work: null,
      composer: '',
      movements: entries.map(e => ({
        track: e.track,
        globalIndex: e.globalIndex,
        movement: e.track.node.getAttribute('song')
               || e.track.node.getAttribute('name')
               || ''
      }))
    }];
  }

  // One group per disc for multi-disc albums, a single unnamed group
  // for single-disc. Each entry carries its own global index into
  // album.tracks, so the data-track-index on the row is correct
  // regardless of which disc group it belongs to.
  const discGroups = isMultiDisc
    ? album.discs.map(disc => ({
        discNumber: disc.discNumber,
        entries: album.tracks
          .map((t, i) => ({ track: t, globalIndex: i }))
          .filter(e => e.track.discNumber === disc.discNumber)
      }))
    : [{
        discNumber: 0,
        entries: album.tracks.map((t, i) => ({ track: t, globalIndex: i }))
      }];

  const allGroups = discGroups.map(g => ({
    discNumber: g.discNumber,
    blocks: buildBlocksForEntries(g.entries)
  }));

  // The performer line is shown on a work header only when the
  // performer varies across the works of the album. Compute it across
  // all discs so a work on disc 1 is judged against a work on disc 2.
  const workBlocks = allGroups
    .flatMap(g => g.blocks)
    .filter(b => b.work !== null && b.movements.length > 1 && !b.isSection);
  const performers = new Set(
    workBlocks.map(b => b.performer).filter(Boolean)
  );
  const showPerformers = performers.size > 1;

  function renderBlock(block) {
    // Section header (Act N, Book N, Part N)
    if (block.work !== null && block.isSection) {
      const sectionTitle = normalizeMusicalKey(block.work);
      const tracksHTML = block.movements
        .map(e => renderTrack(e, sectionTitle, false, showTrackComposer))
        .join('');

      return `
        <div class="work-group" data-section="true">
          <div class="work-header">
            <${workHeadingTag} class="work-section">${esc(sectionTitle)}</${workHeadingTag}>
          </div>
          ${tracksHTML}
        </div>`;
    }

    // Singleton work
    if (block.work !== null && block.movements.length === 1) {
      const e = block.movements[0];
      const node = e.track.node;
      const fullTitle = node.getAttribute('song')
                     || node.getAttribute('name')
                     || e.movement;
      return renderTrack(
        { ...e, movement: fullTitle },
        null,
        false,
        showTrackComposer
      );
    }

    // Flat block
    if (block.work === null) {
      return block.movements
        .map(e => renderTrack(e, null, false, showTrackComposer))
        .join('');
    }

    // Grouped work
    const { composer, title: displayTitle } = extractComposerPrefix(block.work, block.composer);
    const normalizedTitle = normalizeMusicalKey(displayTitle);
    const hasPerformerLine = !!(showPerformers && block.performer);

    const eyebrow = (showTrackComposer && composer)
      ? `<div class="work-composer">${esc(canonicalComposer(composer))}</div>`
      : '';

    const performerLine = hasPerformerLine
      ? `<div class="work-performer">${esc(block.performer)}</div>`
      : '';

    const tracksHTML = block.movements
      .map(e => renderTrack(e, normalizedTitle, hasPerformerLine, false))
      .join('');

    return `
      <div class="work-group">
        <div class="work-header">
          ${eyebrow}
          <${workHeadingTag} class="work-title">${esc(normalizedTitle)}</${workHeadingTag}>
          ${performerLine}
        </div>
        ${tracksHTML}
      </div>`;
  }

  let html = '';
  for (const g of allGroups) {
    if (isMultiDisc) {
      html += `<h2 class="disc-header">Disc ${g.discNumber}</h2>`;
    }
    html += g.blocks.map(renderBlock).join('');
  }
  return html;
}

/* ═══════════════════════════════════════════════════════════════════
   ALBUM DETAIL
   ═══════════════════════════════════════════════════════════════════ */

// Set for keyboard-initiated detail openings and consumed once by
// showAlbumDetail. Mouse users keep normal visual-only navigation
// without unexpected focus movement.
let detailFocusOnOpen = false;

function showAlbumDetail(albumIndex, pushState = true, preserveScroll = false) {
  const album = allAlbums[albumIndex];

  // Validate before mutating detail state. A stale caller must not leave
  // the previous page visible with an invalid index used by transport sync.
  if (!album) return;

  const comingFromGrid = pushState && !isDetailView;

  if (pushState && isDetailView && currentDetailAlbumIndex !== -1) {
    const scrollY = window.scrollY || window.pageYOffset;
    replaceHistoryEntry({ ...(history.state || {}), scrollY });
  }

  const scrollBeforeRender = window.scrollY || window.pageYOffset;
  currentDetailAlbumIndex = albumIndex;
  currentDetailPlayState = null;

  const safeAlbumTitle  = esc(normalizeMusicalKey(album.baseName));
  const safeAlbumArtist = esc(album.artist);
  const safeAlbumGenre  = esc(album.genre);
  const safeCoverUrl    = esc(coverThumbUrl(album.coverUrl, 640));

  // getFormatDisplay only inspects files[0], so a one-element array is
  // all it needs. Grab the first track of disc 1 (or the first track
  // overall) without building the full list.
  const firstTrack = album.tracks.find(t => t.discNumber === 1)?.node
                  || album.tracks[0]?.node;

  const numDiscs     = album.discs.length;
  const isMultiDisc  = numDiscs > 1;
  const isClassical  = isClassicalGenre(album.genre);
  const showTrackComposer = isClassical && album.showComposer;

  // Various-artists check: stop as soon as two distinct artists are
  // found. Avoids building a Set of every track's artist when the first
  // two tracks already disagree.
  let isVariousArtists = false;
  let firstArtist = '';
  for (const t of album.tracks) {
    const a = effectiveArtist(t, album);
    if (a) {
      if (!firstArtist) {
        firstArtist = a;
      } else if (a !== firstArtist) {
        isVariousArtists = true;
        break;
      }
    }
  }

  const tracklistHTML = buildTracklistHTML(album, {
    isMultiDisc,
    showTrackComposer,
    isVariousArtists,
    useWorkGrouping: isClassical,
  });

  const moreByHTML     = buildMoreByRowsHTML(album);
  const initialFavState = (album.hash && favorites.has(album.hash)) ? 'true' : 'false';

  $detailContent.innerHTML = `
		<div class="album-detail-header">
			<div class="album-detail-cover" data-album-folder="${esc(album.folder)}" role="button" tabindex="0" aria-label="Reveal album folder">
				${safeCoverUrl ? `<img src="${safeCoverUrl}" alt="" onerror="this.parentElement.innerHTML='🎼'">` : '🎼'}
			</div>
			<div class="album-detail-info">
				<div class="album-detail-top">
					${album.date ? `<span class="album-detail-year">${getYear(album.date)}</span>` : ''}
				</div>
				<div class="album-detail-middle">
					<h1 class="album-detail-title" tabindex="-1">${safeAlbumTitle}</h1>
					<div class="album-detail-artist">${safeAlbumArtist}</div>
					<div class="album-detail-meta">
						<span class="format-display">${getFormatDisplay(album.rate, album.bits, album.channels, firstTrack ? [firstTrack] : [])}</span>
						${album.genre ? `<span class="badge badge-genre">${safeAlbumGenre}</span>` : ''}
					</div>
					<div class="album-detail-stats">
						${isMultiDisc ? `${numDiscs} discs · ` : ''}
						${album.tracks.length} track${album.tracks.length === 1 ? '' : 's'} · ${formatTotalTime(album.totalDuration)}
					</div>
				</div>
				<div class="album-detail-bottom">
					<button class="album-play-btn" aria-label="Play album">
						<svg viewBox="0 0 24 24" fill="currentColor">
							<path d="M8 5v14l11-7z"/>
						</svg>
					</button>
					<button class="album-detail-fav"
									data-album-hash="${esc(album.hash)}"
									aria-pressed="${initialFavState}"
									aria-label="${initialFavState === 'true' ? 'Remove album from favorites' : 'Add album to favorites'}">
						<svg viewBox="0 0 24 24" width="22" height="22">
							<path class="heart-outline" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"/>
							<path class="heart-solid" d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z"/>
						</svg>
					</button>
				</div>
			</div>
		</div>
		<div class="tracklist-detail" role="group" aria-label="Tracklist">${tracklistHTML}</div>
		${moreByHTML}
	`;

  // No applyAriaLabels call: the template above contains no `title`
  // attributes, and neither does buildMoreByRowsHTML's output. If a
  // title attribute is ever added to either, reinstate the call.

  $detailArtist = $detailContent.querySelector('.album-detail-artist');

  if (comingFromGrid) savedScrollPosition = window.scrollY || window.pageYOffset;

  $queueView.classList.remove('active');
  isQueueView = false;

  $gridView.style.display = 'none';
  $detailView.classList.add('active');

  $headerTitle.textContent  = normalizeMusicalKey(album.baseName);
  $headerArtist.textContent = album.artist;
  $headerInfo.classList.remove('visible');
	$headerInfo.classList.add('active');
  observeDetailArtist();

  if (pushState) {
    window.scrollTo(0, 0);
  } else if (preserveScroll) {
    requestAnimationFrame(() => window.scrollTo(0, scrollBeforeRender));
  } else {
    // Restore scroll for this album on Back/Forward. Prefer the live
    // Map (populated when we last left this album), fall back to the
    // history entry's push-time scrollY, then 0.
    const savedY = detailScrollPositions.get(album.folder);
    const restoreY = savedY ?? history.state?.scrollY ?? 0;
    requestAnimationFrame(() => window.scrollTo(0, restoreY));
  }

  isDetailView = true;
  updatePlayingTrackHighlight();
  syncDetailPlayButton();

  // Keyboard-opened views begin with the heading focused and announced.
  // Mouse users keep normal visual-only navigation without focus movement.
  // focusOnOpen is consumed once so back-navigation does not re-focus.
  if (detailFocusOnOpen) {
    detailFocusOnOpen = false;
    const heading = $detailContent.querySelector('.album-detail-title');
    heading?.focus({ preventScroll: true });
  }

  if (pushState) {
    pushHistoryEntry({
      view: 'detail',
      albumFolder: album.folder,
      albumIndex,                    // kept as a fallback for old entries
      scrollY: 0,
    });
  }

  updateNavButtons();
  observeMoreBySentinel(pushState);

  // Tint the detail view from the album cover. Clears the previous
  // album's tint synchronously, then fades in the new one when the
  // palette resolves.
  $header.classList.remove('is-grid', 'is-scrolled', 'is-queue');
	$header.classList.add('is-detail');

  const albumFolderAtCall = album.folder;
  applyAlbumPalette(
    $detailView,
    // Palette extraction only averages pixels, so the thumbnail is
    // enough — and it avoids downloading the full cover a second time.
    coverThumbUrl(album.coverUrl, 240),
    () => allAlbums[currentDetailAlbumIndex]?.folder === albumFolderAtCall
  );
  
  updatePlaybackBarMode();
}

function showQueueView() {
  const scrollY = window.scrollY || window.pageYOffset;

  queueReturnState = {
    wasDetail: isDetailView,
    albumFolder: isDetailView && currentDetailAlbumIndex !== -1
      ? allAlbums[currentDetailAlbumIndex]?.folder ?? null
      : null,
    scrollY
  };

  if (!isDetailView) {
    savedScrollPosition = scrollY;
  }

  disconnectMoreByObserver();
  currentDetailAlbumIndex = -1;
  isDetailView = false;
  isQueueView = true;

  $gridView.style.display = 'none';
  $detailView.classList.remove('active');
  $queueView.classList.add('active');

  // The queue is only reachable from the keyboard (the Q hotkey), so
  // move focus to its heading: it announces the view and gives Tab a
  // sensible starting point ahead of the row list.
  $queueView.querySelector('.queue-title')?.focus({ preventScroll: true });

  $headerTitle.textContent = 'Queue';
  $headerArtist.textContent = '';
  $headerInfo.classList.add('active', 'visible');
  $detailArtist = null;
  observeDetailArtist();

  // Header is hidden in queue view. is-grid and is-scrolled are
  // still set so that if is-queue is ever removed without a view
  // switch (e.g. a future feature that closes the header
  // independently), the header underneath is already in a
  // consistent state.
  $header.classList.remove('is-detail', 'is-opaque');
  $header.classList.add('is-grid', 'is-scrolled', 'is-queue');

  renderQueueView(savedQueueScrollPosition);

  updateNavButtons();
  updatePlaybackBarMode();
}

function hideQueueView() {
  const state = queueReturnState;
  queueReturnState = null;

  // Record where the user was in the queue. On the next open,
  // showQueueView restores this instead of jumping to the top.
  savedQueueScrollPosition = window.scrollY || window.pageYOffset;

  isQueueView = false;
  $queueView.classList.remove('active');

  if (state && state.wasDetail && state.albumFolder) {
    const idx = findOrRevealAlbum(state.albumFolder);
    if (idx !== -1) {
      showAlbumDetail(idx, false, true);
      requestAnimationFrame(() => window.scrollTo(0, state.scrollY));
      return;
    }
    // The album is gone (library rebuild). Fall back to the grid without
    // restoring the detail view's scroll offset onto a different page.
    showGridView();
    return;
  }
  showGridView();
}
