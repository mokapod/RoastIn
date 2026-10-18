// palette.js
// Depends on: (none — self-contained)
//
// Extract a dominant color from an album cover and expose it as two
// CSS custom properties (--album-tint, --album-glow) on a target
// element. Used by views.js to tint the detail view per album.

const PALETTE_CACHE_MAX = 200;   // ~200 B per entry → ~40 KB ceiling

const paletteCache = new Map();   // coverUrl -> { tint, glow } | null

/* ── Color helpers ───────────────────────────────────────────────── */

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h;
  if (max === r)      h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;

  return { h: h * 60, s, l };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r, g, b;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

// Clamp a color into a range that reads well over a dark UI:
// saturation floor so it never goes gray, lightness ceiling so it
// never blows out, lightness floor so it never disappears.
function constrainColor({ r, g, b }, minSat = 0.35, maxL = 0.65, minL = 0.20) {
  const { h, s, l } = rgbToHsl(r, g, b);
  return hslToRgb(h, Math.max(minSat, s), Math.min(maxL, Math.max(minL, l)));
}

const rgba = (c, a) => `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;

/* ── Extraction ──────────────────────────────────────────────────── */

async function extractPalette(coverUrl) {
  if (!coverUrl) return null;

  const cached = boundedGet(paletteCache, coverUrl);
  if (cached !== CACHE_MISS) return cached;

  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload  = () => resolve(el);
      el.onerror = reject;
      el.src = coverUrl;
    });
  } catch {
    boundedSet(paletteCache, coverUrl, null, PALETTE_CACHE_MAX);
    return null;
  }

  // 48×48 downsample: enough resolution to find the dominant hue,
  // ~100× faster than reading the full image, and the browser does
  // the smoothing for us.
  const SIZE = 48;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
	img.src = '';

  let data;
  try {
    ({ data } = ctx.getImageData(0, 0, SIZE, SIZE));
  } catch (e) {
    console.warn('Palette extraction blocked (tainted canvas):', e);
    boundedSet(paletteCache, coverUrl, null, PALETTE_CACHE_MAX);
    return null;
  }

  // Quantize to 4 bits per channel and bin. Skip pixels that would
  // produce a muddy result: near-black, near-white, and near-gray.
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    if (max < 40)     continue;   // too dark to contribute hue
    if (min > 220)    continue;   // too bright, washes out
    if (max - min < 25) continue; // too gray to be useful

    const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
    let bin = bins.get(key);
    if (!bin) { bin = { r: 0, g: 0, b: 0, n: 0 }; bins.set(key, bin); }
    bin.r += r; bin.g += g; bin.b += b; bin.n++;
  }

  if (bins.size === 0) {
    boundedSet(paletteCache, coverUrl, null, PALETTE_CACHE_MAX);
    return null;
  }

  // Population-weighted dominant color. A large cluster of a
  // medium-saturated color reads as "the cover's color" more
  // reliably than a tiny cluster of a vivid one.
  let best = null;
  for (const bin of bins.values()) {
    if (!best || bin.n > best.n) best = bin;
  }

  const dominant = {
    r: best.r / best.n,
    g: best.g / best.n,
    b: best.b / best.n
  };

  const tintSource = constrainColor(dominant, 0.30, 0.55, 0.25);
  const glowSource = constrainColor(dominant, 0.45, 0.65, 0.30);

  const palette = {
    tint: rgba(tintSource, 0.10),
    glow: rgba(glowSource, 0.16)
  };

  boundedSet(paletteCache, coverUrl, palette, PALETTE_CACHE_MAX);
  return palette;
}

/* ── Application ─────────────────────────────────────────────────── */

// Apply (or clear) the palette on a target element. Safe to call
// repeatedly; clears synchronously before the async extraction so
// there's no flash of the previous album's color.
async function applyAlbumPalette(target, coverUrl, isStillValid = () => true) {
  if (!target) return;

  target.style.removeProperty('--album-tint');
  target.style.removeProperty('--album-glow');

  if (!coverUrl) return;

  const palette = await extractPalette(coverUrl);
  if (!palette) return;
  if (!isStillValid()) return;   // album changed during extraction

  target.style.setProperty('--album-tint', palette.tint);
  target.style.setProperty('--album-glow', palette.glow);
}