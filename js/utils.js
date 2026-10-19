// utils.js
// Depends on: config

/* ═══════════════════════════════════════════════════════════════════
   4. UTILITIES
   ═══════════════════════════════════════════════════════════════════ */

function formatTime(seconds) {
  // Number.isFinite rejects NaN, Infinity, and non-number inputs in one
  // check. The previous `typeof seconds !== 'number'` guard let NaN
  // through (typeof NaN === 'number', NaN <= 0 is false), producing
  // "NaN:NaN" in the UI. Negative values clamp to 0:00 — a display
  // countdown is never meaningful.
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ═══════════════════════════════════════════════════════════════════
   BOUNDED CACHE HELPERS
   ═══════════════════════════════════════════════════════════════════
   Map preserves insertion order, so evicting the first key turns
   the map into a cache with a fixed ceiling. boundedGet also moves
   the entry it returns to the end of the insertion order, which
   makes the eviction policy LRU rather than FIFO — the entries
   you've read most recently are the ones that survive.

   CACHE_MISS is a sentinel rather than `undefined` because a
   palette entry can legitimately be `null` (the negative cache for
   a monochrome cover or a tainted canvas), and a consumer must be
   able to tell "cached null" from "not present."
   ────────────────────────────────────────────────────────────────── */

const CACHE_MISS = Symbol('cache miss');

function boundedGet(cache, key) {
  if (!cache.has(key)) return CACHE_MISS;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);   // re-insert at the end = most recently used
  return value;
}

function boundedSet(cache, key, value, maxSize) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > maxSize) {
    cache.delete(cache.keys().next().value);
  }
}

// Split-form time setter. Writes minutes and seconds into two separate
// spans so the colon between them can't move: the layout width is
// constant regardless of how many digits the minutes value has.
//
// Returns true if either span changed, so callers that poll can skip
// work when the display is already current.
function setTimeDisplay(minEl, secEl, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const minStr = String(m);
  const secStr = String(s).padStart(2, '0');

  let changed = false;
  if (minEl.textContent !== minStr) { minEl.textContent = minStr; changed = true; }
  if (secEl.textContent !== secStr) { secEl.textContent = secStr; changed = true; }
  return changed;
}

// Hoisted so the inner replace callback doesn't allocate a new object
// per matched character. esc runs on every interpolated string in every
// grid chunk, so this is the hottest function in the file.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);

function getTrackComposer(trackEntry) {
  return trackEntry.node.getAttribute('composer') ||
         trackEntry.node.parentNode.getAttribute('composer') || '';
}

// "Classical" for the purposes of track grouping and composer rows.
// Matches the common genre strings: bare "Classical"/"Classique", the
// compound forms ("Baroque Classical", "Modern Classical"), and
// "Symphonic" (film scores and the like, which group and credit
// composers the same way).
//
// Broader than strict equality on purpose: callers in views.js and
// moreby.js must agree on what counts as classical, or the detail
// view will group tracks by work while the More-by section omits the
// composer row for the same album.
const CLASSICAL_GENRE_RE = /\b(classical|classique|symphonic)\b/i;

function isClassicalGenre(genre) {
  return CLASSICAL_GENRE_RE.test(genre || '');
}

// Normalize musical key names to the Library-of-Congress display form:
// capital note, lowercase mode, spelled-out hyphenated accidental.
const MUSICAL_KEY_RE =
  /\bin\s+([A-G])(?:(-?\s*(?:flat|sharp))|([♭♯])|([b#]))?\s+(major|minor)\b/gi;

function normalizeMusicalKey(text) {
  if (!text) return text;
  return text.replace(
    MUSICAL_KEY_RE,
    (_match, note, wordAcc, symAcc, bAcc, mode) => {
      let acc = '';
      if (wordAcc) {
        acc = wordAcc.toLowerCase().includes('sharp') ? '-sharp' : '-flat';
      } else if (symAcc === '♯' || bAcc === '#') {
        acc = '-sharp';
      } else if (symAcc === '♭' || bAcc === 'b') {
        acc = '-flat';
      }
      return `in ${note.toUpperCase()}${acc} ${mode.toLowerCase()}`;
    }
  );
}

function formatTotalTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function getYear(dateStr) {
  if (!dateStr) return '';
  const match = dateStr.match(/\b(\d{4})\b/);
  return match ? match[1] : dateStr;
}

function formatRateKHz(rate) {
  const kHz = rate / 1000;
  return kHz % 1 === 0 ? kHz.toString() : kHz.toFixed(1);
}

// Shared parse-and-clamp for the channel attribute. Both formatChannelSpec
// and formatChannelBadge read the same field with the same guard; keeping
// the guard in one place means a future rule change (e.g. accepting "6ch"
// strings) only needs to be made once.
function parseChannelCount(channels) {
  const n = parseInt(channels, 10);
  return (Number.isFinite(n) && n > 0) ? n : 0;
}

function formatChannelSpec(channels) {
  const n = parseChannelCount(channels);
  return n ? `${n}ch` : '';
}

const CHANNEL_NAMES = { 4: '4.0', 5: '5.0', 6: '5.1', 8: '7.1' };

function formatChannelBadge(channels) {
  const n = parseChannelCount(channels);
  if (!n) return '';
  if (n === 1) return 'Mono';
  if (n === 2) return 'Stereo';
  return CHANNEL_NAMES[n] || `${n}ch`;
}

const FORMAT_MAP = {
  'dsf': 'DSF',  'dff': 'DFF',  'flac': 'FLAC',
  'wav': 'WAV',  'aiff': 'AIFF', 'aif': 'AIFF',
  'alac': 'ALAC', 'm4a': 'ALAC', 'mp3': 'MP3',
  'ogg': 'OGG',  'wma': 'WMA'
};

function getFileFormat(files) {
  if (!files || files.length === 0) return 'Unknown';
  const ext = files[0].getAttribute('name').split('.').pop().toLowerCase();
  return FORMAT_MAP[ext] || ext.toUpperCase();
}

function getFormatInfo(rate, bits, channels, files) {
  const r = parseInt(rate, 10) || 0;
  const b = parseInt(bits, 10) || 0;
  const fileFormat = getFileFormat(files);

  const channelLabel = formatChannelSpec(channels);
  const suffix = channelLabel ? ` · ${channelLabel}` : '';

  if (r >= 22579200) return { label: `${fileFormat} DSD512${suffix}` };
  if (r >= 11289600) return { label: `${fileFormat} DSD256${suffix}` };
  if (r >= 5644800)  return { label: `${fileFormat} DSD128${suffix}` };
  if (r >= 2822400)  return { label: `${fileFormat} DSD64${suffix}` };

  const bitDepth = b || (r >= 88200 ? 24 : 16);
  const rateStr = formatRateKHz(r);
  return { label: `${fileFormat} ${rateStr}kHz · ${bitDepth}bit${suffix}` };
}

const FORMAT_ICONS = {
  'flac': 'flac.svg', 'dsf': 'dsd.svg', 'dff': 'dsd.svg',
  'wav': 'wav.svg',   'wv': 'wav.svg',
  'aiff': 'aiff.svg', 'aif': 'aiff.svg',
  'alac': 'alac.svg', 'm4a': 'alac.svg'
};

// Set membership is O(1); the previous array used .includes(), which is a
// linear scan. Six items either way, but the Set states the intent.
const BLACK_ICONS = new Set(['dsf', 'dff', 'wav', 'wv', 'alac', 'm4a']);

function getFormatDisplay(rate, bits, channels, files) {
  if (!files || files.length === 0) return '';

  const formatInfo = getFormatInfo(rate, bits, channels, files);
  const ext = files[0].getAttribute('name').split('.').pop().toLowerCase();

  const iconFile = FORMAT_ICONS[ext] || 'flac.svg';
  const iconUrl = `${ASSET_BASE}/${iconFile}`;
  const invertClass = BLACK_ICONS.has(ext) ? ' invert-icon' : '';

  const specs = formatInfo.label.replace(/^[A-Z]+\s*/, '');

  return `<img src="${iconUrl}" alt="${esc(ext)}" class="format-icon${invertClass}"> <span class="format-specs">${esc(specs)}</span>`;
}

function localPathToUrl(localPath) {
  if (!localPath) return '';
  const path = localPath.startsWith('/') ? localPath : '/' + localPath;
  return '/files/' + path.split('/').filter(s => s.length > 0).map(encodeURIComponent).join('/');
}

// Cover files are stored at scan resolution — around 1400px, 1-2 MB each
// — while most of the UI draws them into tiles a fraction of that size.
// The server renders and caches a thumbnail for ?w=<long edge>, so a grid
// pass downloads tens of KB per cover instead of megabytes. Only /files/
// URLs take the parameter; anything else (a remote cover) is left alone.
function coverThumbUrl(url, width) {
  if (!url) return '';
  return url.startsWith('/files/') ? `${url}?w=${width}` : url;
}

// Disc-suffix patterns, in priority order. Matched against the album
// name; the first hit determines the base name and the disc number.
const DISC_PATTERNS = [
  /\s*\(\s*(?:CD|Disc)\s*(\d+)\s*\)\s*$/i,
  /\s*\[\s*(?:CD|Disc)\s*(\d+)\s*\]\s*$/i,
  /\s*-\s*(?:CD|Disc)\s*(\d+)\s*$/i,
  /\s*(?:CD|Disc)\s*(\d+)\s*$/i,
  /\s*\(?\s*CD\s*(\d+)\s*\)?\s*$/i
];

function parseAlbumInfo(albumName, path = '') {
  for (const pattern of DISC_PATTERNS) {
    const match = albumName.match(pattern);
    if (match) {
      return {
        baseName: albumName.replace(pattern, '').trim(),
        discNumber: parseInt(match[1], 10),
        isMultiDisc: true
      };
    }
  }
  const pathDiscMatch = path.match(/(?:CD|Disc|Disk)\s*(\d+)/i);
  if (pathDiscMatch) {
    return {
      baseName: albumName,
      discNumber: parseInt(pathDiscMatch[1], 10),
      isMultiDisc: true
    };
  }
  return { baseName: albumName, discNumber: 1, isMultiDisc: false };
}

const DISC_FOLDER_RE = /^(?:CD|Disc|Disk)\s*\d+$/i;

function getAlbumFolder(path) {
  const parts = path.split('/').filter(p => p.length > 0);
  if (parts.length === 0) return '';
  const lastPart = parts[parts.length - 1];
  if (DISC_FOLDER_RE.test(lastPart)) {
    return parts.length > 1 ? parts[parts.length - 2] : lastPart;
  }
  return lastPart;
}

const TRAILING_DISC_RE = /\s*[\(\[]?\s*(?:cd|disc|disk)\s*\d+\s*[\)\]]?\s*$/i;

function normalizeAlbumName(s) {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(TRAILING_DISC_RE, '')
    .trim();
}

function updateNavButtons() {
  // Queue view is a keyboard-only overlay — it never touches history,
  // so Back would navigate away from a view the user hasn't actually
  // left. The button stays disabled while it's open.
  if (isQueueView) {
    $navBackBtn.classList.add('disabled');
    return;
  }

  $navBackBtn.classList.toggle('disabled', historyCursor <= 0);
}

/* Track-row state icons. The album tracklist (views.js) and the queue
   (queue.js) render the same pair, so they live here rather than being
   duplicated per renderer. Size and colour are set in CSS — the markup
   carries no width/height so the token values stay the single source. */
const TRACK_EQ_ICON =
  `<svg class="track-icon-eq" viewBox="0 0 24 24"><rect class="eq-bar eq-bar-1" x="4" y="12" width="4" height="12" rx="1"/><rect class="eq-bar eq-bar-2" x="10" y="8" width="4" height="16" rx="1"/><rect class="eq-bar eq-bar-3" x="16" y="4" width="4" height="20" rx="1"/></svg>`;
const TRACK_PLAY_ICON =
  `<svg class="track-icon-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;