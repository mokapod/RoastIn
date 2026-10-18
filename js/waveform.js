// waveform.js
// Depends on: config, state, dom, utils

/* ═══════════════════════════════════════════════════════════════════
   10. WAVEFORM — full-track peak envelope drawn behind the progress slider
   ═══════════════════════════════════════════════════════════════════ */

const styleOverride = localStorage.getItem('hqp.waveformStyle');
if (styleOverride) WAVEFORM_CONFIG.style = styleOverride;

const WAVEFORM_CACHE_MAX = 100;   // ~15 KB per entry → ~1.5 MB ceiling

const waveformCache = new Map();
const waveformFetches = new Map(); // in-flight requests, keyed by path

async function fetchWaveformData(trackPath) {
  if (!trackPath) return null;

  const cached = boundedGet(waveformCache, trackPath);
  if (cached !== CACHE_MISS) return cached;

  // Deduplicate in-flight requests: a prefetch immediately followed by a
  // manual skip to the same track would otherwise fire two HTTP calls.
  if (waveformFetches.has(trackPath)) {
    return waveformFetches.get(trackPath);
  }

  const fetchPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/waveform`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trackPath })
      });
      if (!res.ok) return null;

      const payload = await res.json();
      boundedSet(waveformCache, trackPath, payload, WAVEFORM_CACHE_MAX);
      return payload;
    } catch (e) {
      console.warn('Waveform fetch failed:', e);
      return null;
    } finally {
      waveformFetches.delete(trackPath);
    }
  })();

  waveformFetches.set(trackPath, fetchPromise);
  return fetchPromise;
}

async function loadWaveform(trackPath) {
  if (!trackPath || !$waveform) return;

  const cached = boundedGet(waveformCache, trackPath);
  if (cached !== CACHE_MISS) {
    currentWaveform = cached;
    paintWaveform(true);
    return;
  }

  const payload = await fetchWaveformData(trackPath);
  currentWaveform = payload;   // may be null — paintWaveform handles that
  paintWaveform();
}

// Warm the cache for a track without displaying it. Safe to call at any
// time; if already cached or already in flight, returns immediately.
function prefetchWaveform(trackPath) {
  if (!trackPath) return;
  fetchWaveformData(trackPath);
}

/* ═══════════════════════════════════════════════════════════════════
   CANVAS SIZE CACHE
   ═══════════════════════════════════════════════════════════════════
   paintWaveform() runs on every progress-drag input event, at up to
   ~120Hz. Calling getBoundingClientRect() on each of those forces a
   layout flush that almost always returns the same numbers. Measure
   only when the size can actually change: at script load, and on
   window resize.
   ────────────────────────────────────────────────────────────────── */

let cachedWaveformWidth  = 1;
let cachedWaveformHeight = 1;

function measureWaveformCanvas() {
  if (!$waveform) return;
  const rect = $waveform.getBoundingClientRect();
  cachedWaveformWidth  = Math.max(1, rect.width);
  cachedWaveformHeight = Math.max(1, rect.height);
}

// Initial measurement. The playback bar is always present in the layout
// (hidden via transform, not display:none), so its dimensions are
// available as soon as this script runs.
measureWaveformCanvas();

let lastPaintedWaveform = null;
let lastPaintedPercent  = -1;

function paintWaveform(force = false) {
  if (!$waveform) return;

  const percent = parseFloat($progress.value) || 0;

  if (!force &&
      currentWaveform === lastPaintedWaveform &&
      Math.abs(percent - lastPaintedPercent) < 0.05) {
    return;
  }

  lastPaintedWaveform = currentWaveform;
  lastPaintedPercent  = percent;

  const dpr  = window.devicePixelRatio || 1;
  const cssW = cachedWaveformWidth;
  const cssH = cachedWaveformHeight;

  if ($waveform.width !== Math.round(cssW * dpr) ||
      $waveform.height !== Math.round(cssH * dpr)) {
    $waveform.width  = Math.round(cssW * dpr);
    $waveform.height = Math.round(cssH * dpr);
  }

  const ctx = $waveform.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!currentWaveform || !currentWaveform.data) {
    ctx.fillStyle = 'rgba(255, 240, 220, 0.04)';
    ctx.fillRect(0, 0, cssW, cssH);
    return;
  }

  const cfg     = WAVEFORM_CONFIG;
  const useBars = cfg.style === 'bars';

  const data    = currentWaveform.data;
  const points  = currentWaveform.points;
  const centerY = cssH / 2;
  const halfH   = cssH / 2 - 2;

  function buildWaveformPath() {
    ctx.beginPath();
    for (let i = 0; i < points; i++) {
      const x = (i / (points - 1)) * cssW;
      const peak = data[i] / 255;
      const y = centerY - peak * halfH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = points - 1; i >= 0; i--) {
      const x = (i / (points - 1)) * cssW;
      const peak = data[i] / 255;
      const y = centerY + peak * halfH;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // Bars are drawn as a single path with two roundRects per bar. The
  // top and bottom rects share an edge at centerY but do not overlap,
  // so the default nonzero fill rule produces the same result as
  // filling them individually — at a fraction of the fill-call count.
  function drawBars() {
    const pitch  = cfg.bars.pitch;
    const gap    = cfg.bars.gap;
    const width  = Math.max(0.5, pitch - gap);
    const radius = Math.min(cfg.bars.maxRadius, width / 2);

    const numBars = Math.max(1, Math.floor(cssW / pitch));
    const pointsPerBar = points / numBars;

    ctx.beginPath();
    for (let b = 0; b < numBars; b++) {
      const start = Math.floor(b * pointsPerBar);
      const end   = Math.min(points, Math.floor((b + 1) * pointsPerBar));
      let peak = 0;
      for (let i = start; i < end; i++) {
        if (data[i] > peak) peak = data[i];
      }

      // Skip silent bars entirely. Non-zero peaks render at least half
      // a pixel so very quiet passages stay visible.
      if (peak === 0) continue;

      const h = Math.max(0.5, (peak / 255) * halfH);
      const x = b * pitch;

      ctx.roundRect(x, centerY - h, width, h, [radius, radius, 0, 0]);
      ctx.roundRect(x, centerY,     width, h, [0, 0, radius, radius]);
    }
    ctx.fill();
  }

  function drawPass() {
    if (useBars) {
      drawBars();
    } else {
      buildWaveformPath();
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.fillStyle   = cfg.colors.unplayedFill;
  ctx.strokeStyle = cfg.colors.unplayedStroke;
  ctx.lineWidth   = 0.5;
  drawPass();

  const playedX = (percent / 100) * cssW;

  if (playedX > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, playedX, cssH);
    ctx.clip();

    ctx.fillStyle   = cfg.colors.playedFill;
    ctx.strokeStyle = cfg.colors.playedStroke;
    ctx.lineWidth   = 1;
    drawPass();

    ctx.restore();
  }
}

// rAF-throttled resize. A trailing debounce would freeze the waveform
// during the drag, since each resize event resets the timer. This
// coalesces bursts into one paint per frame while keeping the display
// live as the user drags the window edge.
let resizeScheduled = false;

function scheduleWaveformRepaint() {
  if (resizeScheduled) return;
  resizeScheduled = true;

  requestAnimationFrame(() => {
    measureWaveformCanvas();
    paintWaveform(true);
    resizeScheduled = false;
  });
}

window.addEventListener('resize', scheduleWaveformRepaint, { passive: true });