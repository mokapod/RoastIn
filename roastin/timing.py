"""Lightweight phase timing.

Two modes, both off by default so the hot path costs one dict lookup:

  slow log   Always on. Any phase exceeding SLOW_MS prints one line.
             This is the mode that earns its keep — it surfaces the
             operation that actually hurt, on the machine that hurt,
             without anyone having to reproduce it under a profiler.

  verbose    ROASTIN_TIMING=1. Every phase prints, including fast ones.
             For measuring a change end to end rather than waiting for
             something to be slow enough to notice.

Measured baseline on this machine (library of 342 dirs / 4,823 tracks,
HQPlayer 6 on loopback), so a reader can tell "slow" from "normal":

  status poll (HQPlayer XML)   ~296 ms   dominated by HQPlayer itself
  PlaylistGet (empty queue)    ~ 40 ms
  PlaylistGet (30 tracks)      ~2-4 s    cover art dominates
  waveform compute (ffmpeg)    ~150-400 ms per track, first time
  waveform cache hit           ~0.01 ms
  library.xml parse            ~ 14 ms

Those numbers are why the status poll threshold below is generous: a
250 ms warning on a 296 ms operation would fire on every single poll
and train the reader to ignore the log.
"""
from __future__ import annotations

import contextlib
import os
import time
from collections.abc import Iterator
from typing import Any

VERBOSE = os.environ.get('ROASTIN_TIMING') == '1'

# Per-operation slow thresholds in milliseconds. Tuned above the measured
# normal for each phase so a warning means something changed.
_THRESHOLDS = {
    'status.poll': 600.0,
    'queue.fetch': 8000.0,
    'waveform.compute': 3000.0,
    'waveform.hit': 20.0,
    'library.parse': 500.0,
    'http.request': 5000.0,
    'load': 8000.0,
}
_DEFAULT_THRESHOLD = 1000.0


@contextlib.contextmanager
def timed(phase: str, **fields: Any) -> Iterator[None]:
    """Time a block; log if slow, or always when verbose.

    Extra keyword fields are appended to the log line, which is what
    makes a warning actionable — a bare duration says nothing about
    which track or how many items.
    """
    t0 = time.perf_counter()
    try:
        yield
    finally:
        ms = (time.perf_counter() - t0) * 1000
        threshold = _THRESHOLDS.get(phase, _DEFAULT_THRESHOLD)
        if VERBOSE or ms >= threshold:
            _emit(phase, ms, threshold, fields)


def record(phase: str, ms: float, **fields: Any) -> None:
    """Report a duration measured elsewhere (e.g. inside a subprocess)."""
    threshold = _THRESHOLDS.get(phase, _DEFAULT_THRESHOLD)
    if VERBOSE or ms >= threshold:
        _emit(phase, ms, threshold, fields)


def _emit(phase: str, ms: float, threshold: float, fields: dict) -> None:
    """One log line. SLOW is appended only when the threshold was actually
    crossed — in verbose mode a fast phase is still logged, but it must
    not be labelled slow or the marker stops meaning anything."""
    extra = '  '.join(f'{k}={v}' for k, v in fields.items())
    marker = '  ⚠️  SLOW' if ms >= threshold else ''
    print(f'[timing] {phase}: {ms:.1f} ms'
          f'{("  " + extra) if extra else ""}{marker}')
