// bootstrap.js
// Depends on: everything above

/* ═══════════════════════════════════════════════════════════════════
   18. BOOTSTRAP
   ═══════════════════════════════════════════════════════════════════ */

if ($hqBtn) {
  const hqImg = $hqBtn.querySelector('img');
  if (hqImg) hqImg.src = `${ASSET_BASE}/hqplayer.png`;
  $hqBtn.setAttribute('aria-label', `Launch ${HQPLAYER_APP}`);
}

if ($sortBtn) {
  if (!SORT_ORDER.includes(currentSort)) {
    console.warn(
      `defaultSort "${currentSort}" is not valid; falling back to "artist"`
    );
    currentSort = 'artist';
  }
  updateSortButton();
}

async function loadLibrary() {
  try {
    const response = await fetch(LIBRARY_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xmlText = await response.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

    const parserError = xmlDoc.querySelector('parsererror');
    if (parserError) {
      throw new Error('Malformed XML in library.xml');
    }

    libraryDirectories = xmlDoc.querySelectorAll('directory');
    masterAlbums = groupAlbums(libraryDirectories);
    applyFiltersAndRender();
  } catch (error) {
    console.error('Library load failed:', error);

    const isParseError = /Malformed XML/i.test(error.message);

    $content.innerHTML = `
      <div class="error">
        <h3>${isParseError ? 'library.xml is malformed' : 'Cannot load library.xml'}</h3>
        <p style="margin-top: 1rem; line-height: 1.6;">
          ${isParseError
            ? `HQPlayer wrote a library.xml that could not be parsed.
               Use <strong>Repair Library</strong> from the HQPlayer menu,
               or rescan the library in HQPlayer.`
            : `Ensure <code>library.xml</code> exists in your HQPlayer
               settings folder and that the ${APP_NAME} server is running.`}
        </p>
      </div>`;
  }
}

async function loadFavorites() {
  try {
    const res = await fetch(`${API_BASE}/favorites`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    favorites = new Set(data.albums || []);
  } catch (e) {
    console.warn('Could not load favorites:', e);
    favorites = new Set();
  }
}

loadFavorites();
loadLibrary();

initializeHistory();
isDetailView = false;
updateNavButtons();

let scrollScheduled = false;

window.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;

  requestAnimationFrame(() => {
    if (!isDetailView) {
      $header.classList.toggle('is-scrolled', window.scrollY > 10);
    }

    updateHeaderAlbumInfoVisibility();
    scrollScheduled = false;
  });
}, { passive: true });

function updateHeaderAlbumInfoVisibility() {
  if (!$headerInfo || !$headerInfo.classList.contains('active')) return;

  if ($detailArtist) {
    const rect = $detailArtist.getBoundingClientRect();
    const headerHeight = $header ? $header.offsetHeight : 0;

    const shouldShow = rect.top <= headerHeight;

    $headerInfo.classList.toggle('visible', shouldShow);
		$header.classList.toggle('is-opaque', shouldShow);
  }
}

document.querySelectorAll('[title]').forEach(el => {
  if (!el.hasAttribute('aria-label')) {
    el.setAttribute('aria-label', el.getAttribute('title'));
  }
  el.removeAttribute('title');
});

// Open the status stream. Frames push transport changes, flag changes,
// and a position heartbeat; nothing polls. The one-shot fetchStatus()
// remains for mutations that want an immediate refresh. Queue contents
// are still fetched on demand when the queue view opens.
startStatusStream();