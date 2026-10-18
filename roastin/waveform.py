"""Waveform peak-envelope extraction and its disk cache.

Requires ffmpeg (on PATH) and numpy. Both are optional: without them the
endpoint returns 503 and the rest of the app works normally.

Concurrency model: a 4-worker ThreadPoolExecutor caps concurrent ffmpeg
decodes so a burst of requests can't stampede the CPU that is also
running HQPlayer's DSP. Concurrent requests for the SAME file share one
future rather than each spawning its own subprocess.
"""
from __future__ import annotations

import concurrent.futures
import os
import shutil
import subprocess
import threading

from .config import (
    WAVEFORM_SAMPLE_RATE,
    WAVEFORM_TARGET_POINTS,
)
from .types import WaveformResult

if __debug__:
    # numpy may be absent; the annotation below is a string under
    # `from __future__ import annotations`, so no runtime import needed.
    pass

# --- dependency probing --------------------------------------------------
FFMPEG_AVAILABLE = shutil.which('ffmpeg') is not None
FFMPEG_ERROR = '' if FFMPEG_AVAILABLE else 'ffmpeg not found on PATH'

NUMPY_AVAILABLE = False
NUMPY_ERROR = ''
try:
    import numpy as np
    NUMPY_AVAILABLE = True
except Exception as e:  # pragma: no cover - depends on host
    NUMPY_ERROR = str(e)
    np = None

WAVEFORM_AVAILABLE = FFMPEG_AVAILABLE and NUMPY_AVAILABLE

# --- executor and in-flight registry -------------------------------------
# Executor caps concurrent waveform decodes. Without this, N simultaneous
# requests would spawn N ffmpeg subprocesses — a real CPU stampede on the
# same machine that's running HQPlayer's DSP. Four gives headroom for the
# current track plus a couple of stale prefetches.
_waveform_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix='Waveform'
)

# In-flight computations keyed by audio path. Deduplicates concurrent
# requests for the same file so the heavy work happens once and every
# caller waits on the same future.
_waveform_futures = {}
_waveform_lock = threading.Lock()


def _cache_module():  # -> waveform_cache module; string annotation avoids import cost
    """Late import keeps sqlite setup lazy until the first cache use.

    Module imports remain side-effect free: importing waveform.py probes
    optional ffmpeg/numpy only; the DB opens when analyze/prune/stats
    actually touch it.
    """
    from . import waveform_cache
    return waveform_cache


def load_audio_samples(audio_path: str, target_sr: int) -> "np.ndarray":
    """Decode any audio file to mono float32 at target_sr via ffmpeg."""
    cmd = [
        'ffmpeg', '-v', 'error',
        '-i', audio_path,
        '-ac', '1',
        '-ar', str(target_sr),
        '-f', 'f32le', '-',
    ]
    raw = subprocess.check_output(cmd)
    return np.frombuffer(raw, dtype=np.float32)


def _compute_waveform_uncached(audio_path: str) -> WaveformResult:
    """The actual heavy lifting, separated for the executor."""
    from .timing import timed
    # First compute of a track is the only user-visible waveform cost
    # (~150-400 ms ffmpeg decode). Everything after is a cache hit.
    with timed('waveform.compute', track=os.path.basename(audio_path)):
        y = load_audio_samples(audio_path, WAVEFORM_SAMPLE_RATE)
    duration = float(len(y) / WAVEFORM_SAMPLE_RATE)

    n = len(y)
    if n == 0:
        peaks_u8 = np.zeros(WAVEFORM_TARGET_POINTS, dtype=np.uint8)
    else:
        factor = max(1, n // WAVEFORM_TARGET_POINTS)
        usable = (n // factor) * factor

        if usable == 0:
            peaks = np.abs(y)
        else:
            peaks = np.abs(y[:usable]).reshape(-1, factor).max(axis=1)

        peak_max = float(peaks.max()) if len(peaks) else 0.0
        if peak_max > 0:
            peaks = peaks / peak_max

        peaks_u8 = (peaks * 255).astype(np.uint8)

        if len(peaks_u8) > WAVEFORM_TARGET_POINTS:
            peaks_u8 = peaks_u8[:WAVEFORM_TARGET_POINTS]
        elif len(peaks_u8) < WAVEFORM_TARGET_POINTS:
            peaks_u8 = np.pad(
                peaks_u8,
                (0, WAVEFORM_TARGET_POINTS - len(peaks_u8)),
                mode='edge'
            )

    return {
        'duration': duration,
        'points': len(peaks_u8),
        'data': peaks_u8.tolist(),
    }


def analyze_waveform(audio_path: str) -> WaveformResult:
    """Compute (and cache) a peak envelope for a track.

    Concurrent requests for the same file wait on a single shared future
    rather than each spawning their own ffmpeg subprocess.

    Persistence is one SQLite row per (path, mtime) key — see
    roastin/waveform_cache.py for storage details. The in-process
    future registry above it is unchanged: the DB removes the file
    I/O bottleneck, not the duplicate-compute one.
    """
    import hashlib

    try:
        mtime = int(os.path.getmtime(audio_path))
    except OSError as e:
        raise FileNotFoundError(audio_path) from e

    key = hashlib.sha1(f'{audio_path}|{mtime}'.encode()).hexdigest()[:16]

    # Disk cache first — the common case after a track has been played.
    from .timing import timed
    with timed('waveform.hit', track=os.path.basename(audio_path)):
        cached = _cache_module().get_cached(key)
    if cached is not None:
        return cached

    # Check-and-submit under a single lock hold. Releasing between the
    # check and the registration lets two threads both decide they're
    # the first, both submit futures, and both compute the same file.
    with _waveform_lock:
        existing = _waveform_futures.get(audio_path)
        if existing is not None:
            is_computer = False
            future = existing
        else:
            future = _waveform_executor.submit(
                _compute_waveform_uncached, audio_path
            )
            _waveform_futures[audio_path] = future
            is_computer = True

    try:
        result = future.result()
    finally:
        # Only the submitting thread owns cleanup. Waiters must not pop
        # the entry out from under a future other waiters may still be
        # attached to.
        if is_computer:
            with _waveform_lock:
                _waveform_futures.pop(audio_path, None)

    # Only the submitting thread writes the disk cache, and only on
    # success. If future.result() raised, we never reach here.
    if is_computer:
        _cache_module().put_cached(key, result['duration'],
                                   result['points'], result['data'])

    return result


def prune_waveform_cache(max_age_days: int = 90) -> int:
    """Delete waveform cache entries older than `max_age_days`.

    Same 90-day contract and same timestamp semantics as the flat era —
    see roastin/waveform_cache.prune_cache for details. One indexed
    DELETE now stands in for the old full-directory scan + per-file
    stat.

    Returns the number of entries removed.
    """
    return _cache_module().prune_cache(max_age_days)


def cache_stats() -> tuple[int, int]:
    """(entry count, peak bytes) for the startup log."""
    return _cache_module().stats()
