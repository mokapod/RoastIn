// history.js
// Depends on: state, views

/* ═══════════════════════════════════════════════════════════════════
   HISTORY BOOKKEEPING
   ═══════════════════════════════════════════════════════════════════
   The browser's history stack is opaque — we can't ask it how many
   entries exist or where the cursor sits. We tag each entry we push
   with an index and track the cursor ourselves. Back enablement is then
   derived from that, matching browser semantics.
   ────────────────────────────────────────────────────────────────── */

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

function initializeHistory() {
  history.replaceState({ view: 'grid', index: 0 }, '');
  historyCursor = 0;
}

function pushHistoryEntry(state) {
  const index = historyCursor + 1;
  history.pushState({ ...state, index }, '');
  historyCursor = index;
}

function replaceHistoryEntry(state) {
  // replaceState swaps the current entry in place — the cursor does
  // not move, so preserve its index.
  history.replaceState({ ...state, index: historyCursor }, '');
}

window.addEventListener('popstate', (event) => {
  // Cancel any pending debounced search render. Without this, a search
  // fired just before Back would complete after popstate has already
  // rendered the destination view, causing a redundant re-render that
  // jumps the scroll to the top.
  clearTimeout(searchTimeout);

  const state = event.state || {};
  
  // Before the cursor advances, save the scroll position of the view
  // we're leaving so Forward can restore it later.
  if (isDetailView && currentDetailAlbumIndex !== -1) {
		const leavingAlbum = allAlbums[currentDetailAlbumIndex];
		if (leavingAlbum) {
			detailScrollPositions.set(
				leavingAlbum.folder,
				window.scrollY || window.pageYOffset
			);
		}
	}
  
  // When Back/Forward carries us from the grid into a detail view,
  // capture the grid's current scroll before the view switch hides it.
  // Card clicks already do this via showAlbumDetail's comingFromGrid
  // path; this covers popstate navigation, which reaches the detail
  // view with pushState=false and would otherwise skip the capture.
  if (!isDetailView && state.view === 'detail') {
    savedScrollPosition = window.scrollY || window.pageYOffset;
  }
  
  historyCursor = state.index ?? 0;

  if (state.view === 'detail') {
    isDetailView = true;

    // Prefer resolving by folder (which also handles un-filtering the
    // grid if the album was hidden by an active search). Fall back to
    // the raw index for legacy history entries or if the folder lookup
    // fails.
    let targetIdx = -1;
    if (state.albumFolder) {
      targetIdx = findOrRevealAlbum(state.albumFolder);
    }
    if (targetIdx === -1 && state.albumIndex != null) {
      targetIdx = state.albumIndex;
    }

    if (targetIdx !== -1 && allAlbums[targetIdx]) {
      showAlbumDetail(targetIdx, false);
    } else {
      isDetailView = false;
      showGridView();
    }
  } else {
    isDetailView = false;

    const q = typeof state.query === 'string' ? state.query : '';
    const hasQuery = !!q;

    if (searchInput.value !== q) {
      searchInput.value = q;
      searchContainer.classList.toggle('has-content', hasQuery);
      searchContainer.classList.toggle('expanded', hasQuery);
    }

    // Render whenever the grid does not already reflect this query.
    // Comparing the input value alone is not enough: a debounced render
    // cancelled above (or deferred while a detail view was open) leaves
    // the input and the grid out of step, so Forward would show the
    // saved query with the unfiltered grid behind it.
    currentSearchQuery = q;
    if (renderedSearchQuery !== q.toLowerCase()) {
      applyFiltersAndRender();
    }

    showGridView();
  }

  updateNavButtons();
});