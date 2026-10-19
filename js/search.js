// search.js
// Depends on: config, state, dom, utils, library, views

/* ═══════════════════════════════════════════════════════════════════
   12. SEARCH / FILTER
   ═══════════════════════════════════════════════════════════════════ */

const searchBtn       = document.getElementById('searchBtn');
const searchContainer = document.getElementById('searchContainer');
const searchInput     = document.getElementById('searchInput');
const clearSearchBtn  = document.getElementById('clearSearchBtn');

// Shared clear logic for the X button and the Escape key. Cancels any
// pending debounced render so a stale filter can't fire after the user
// has already discarded the query.
function clearSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = null;

  // If the query was already empty (user opened the search and pressed
  // Escape without typing), there's nothing to re-render — just collapse
  // the container.
  const hadQuery = currentSearchQuery !== '';

  searchInput.value = '';
  currentSearchQuery = '';
  searchContainer.classList.remove('has-content', 'expanded');

  if (hadQuery) {
    applyFiltersAndRender();

    // Keep the history entry in sync with the cleared query, so Forward
    // doesn't resurrect a filter the user explicitly discarded.
    if (history.state
        && history.state.view === 'grid'
        && history.state.query !== '') {
      replaceHistoryEntry({ ...history.state, query: '' });
    }
  }

  searchInput.blur();
}

searchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!searchContainer.classList.contains('expanded')) {
    searchContainer.classList.add('expanded');
    setTimeout(() => searchInput.focus(), 300);
  } else {
    searchInput.focus();
    searchInput.select();
  }
});

document.addEventListener('click', (e) => {
  if (!searchContainer.contains(e.target) && searchInput.value === '') {
    searchContainer.classList.remove('expanded');
  }
});

clearSearchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearSearch();
});

searchInput.addEventListener('input', (e) => {
  currentSearchQuery = e.target.value;

  // Reflect the input state in the container classes.
  searchContainer.classList.toggle('has-content', currentSearchQuery.length > 0);

  // If the user starts typing while in the detail view, transition to
  // the grid and record it in history exactly once. showGridView() sets
  // isDetailView = false, so subsequent keystrokes won't push duplicates.
  if (isDetailView) {
    pushHistoryEntry({ view: 'grid', query: currentSearchQuery });
    showGridView();
  }

  clearTimeout(searchTimeout);
  searchTimeout = null;
  searchTimeout = setTimeout(() => {
    searchTimeout = null;
    applyFiltersAndRender();

    // Keep the current grid history entry in sync with the settled query.
    // Without this, Back/Forward would restore whatever query happened to
    // be present at push time (usually just the first character).
    if (history.state
        && history.state.view === 'grid'
        && history.state.query !== currentSearchQuery) {
      replaceHistoryEntry({ ...history.state, query: currentSearchQuery });
    }
  }, SEARCH_DEBOUNCE_MS);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    clearSearch();
  }
});