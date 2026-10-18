"""Waveform peak-envelope extraction and its disk cache.

Requires ffmpeg (on PATH) and numpy. Both are optional: without them the
endpoint returns 503 and the rest of the app works normally.

Concurrency model: a 4-worker ThreadPoolExecutor caps concurrent ffmpeg
decodes so a burst of requests can't stampede the CPU that is also
running HQPlayer's DSP. Concurrent requests for the SAME file share one
future rather than each spawning its own subprocess.
"""
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time

from .config import (
    WAVEFORM_CACHE_DIR,
    WAVEFORM_SAMPLE_RATE,
    WAVEFORM_TARGET_POINTS,
)

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


def load_audio_samples(audio_path, target_sr):
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


def _compute_waveform_uncached(audio_path):
    """The actual heavy lifting, separated for the executor."""
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


def analyze_waveform(audio_path):
    """Compute (and cache) a peak envelope for a track.

    Concurrent requests for the same file wait on a single shared future
    rather than each spawning their own ffmpeg subprocess.
    """
    try:
        mtime = int(os.path.getmtime(audio_path))
    except OSError as e:
        raise FileNotFoundError(audio_path) from e

    key = hashlib.sha1(f'{audio_path}|{mtime}'.encode()).hexdigest()[:16]
    cache_file = os.path.join(WAVEFORM_CACHE_DIR, f'{key}.json')

    # Disk cache first — the common case after a track has been played.
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f'[waveform] cache unreadable ({e}), recomputing '
                  f'{os.path.basename(audio_path)}')

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
        tmp = cache_file + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(result, f)
        os.replace(tmp, cache_file)

    return result


def prune_waveform_cache(max_age_days=90):
    """Delete waveform cache files whose track hasn't been played in
    `max_age_days`.

    Ages on mtime rather than atime. Entries are written once and never
    rewritten, so an entry's mtime is the moment its track was last
    played — replaying a track produces the same key from the same
    source mtime, hits the existing cache file, and does not rewrite it.
    atime would be the semantically correct field, but it is unreliable
    in practice: most Linux filesystems default to relatime, which only
    updates it after a 24-hour window, and noatime mounts don't maintain
    it at all. A prune keyed on atime would either miss recent plays or
    delete the whole cache on a filesystem that never updates it.

    The cache grows unbounded as the user plays more tracks. Each entry
    is ~5 KB, so a 5,000-track library is ~25 MB — fine. At 50,000 it
    starts to matter. Running the prune in a background thread shortly
    after startup keeps it self-limiting without blocking the listener.

    Returns the number of files removed.
    """
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    try:
        for name in os.listdir(WAVEFORM_CACHE_DIR):
            if not name.endswith('.json'):
                continue
            path = os.path.join(WAVEFORM_CACHE_DIR, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
                    removed += 1
            except OSError:
                pass
    except OSError:
        pass
    return removed
