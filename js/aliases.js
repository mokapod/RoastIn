// aliases.js
// Depends on: config
//
// Map every known spelling of an artist or composer to a single
// canonical spelling so grouping and "More by" rows resolve variants
// together. Data comes from aliases.json, injected by the server into
// window.CONFIG on every page load.

const ARTIST_ALIASES   = CONFIG.artistAliases   || {};
const COMPOSER_ALIASES = CONFIG.composerAliases || {};

function buildCanonicalMap(aliases) {
  const map = new Map();
  for (const [canonical, variants] of Object.entries(aliases)) {
    for (const variant of variants) map.set(variant, canonical);
  }
  return map;
}

const ARTIST_CANONICAL   = buildCanonicalMap(ARTIST_ALIASES);
const COMPOSER_CANONICAL = buildCanonicalMap(COMPOSER_ALIASES);

function canonicalArtist(name) {
  if (!name) return '';
  return ARTIST_CANONICAL.get(name) || name;
}

function canonicalComposer(name) {
  if (!name) return '';
  return COMPOSER_CANONICAL.get(name) || name;
}

// Swap in fresh alias data without a page reload. Used after a merge.
function rebuildCanonicalMaps(newArtistAliases, newComposerAliases) {
  ARTIST_CANONICAL.clear();
  COMPOSER_CANONICAL.clear();

  for (const [canonical, variants] of Object.entries(newArtistAliases || {})) {
    for (const v of variants) ARTIST_CANONICAL.set(v, canonical);
  }
  for (const [canonical, variants] of Object.entries(newComposerAliases || {})) {
    for (const v of variants) COMPOSER_CANONICAL.set(v, canonical);
  }
}

// Re-fetch aliases.json from the server and rebuild the maps.
async function reloadAliases() {
  try {
    const res = await fetch(`${API_BASE}/aliases`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    rebuildCanonicalMaps(
      data.artistAliases   || {},
      data.composerAliases || {},
    );
  } catch (e) {
    console.warn('Could not reload aliases:', e);
  }
}