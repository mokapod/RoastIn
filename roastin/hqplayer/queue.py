"""HQPlayer queue: fetch, parse, and cache.

PlaylistGet is expensive. HQPlayer includes a base64-encoded 1500x1500
JPEG cover as the `picture` attribute of every PlaylistItem — a
30-track queue is roughly 25 MB per response.

Two things make the queue view usable:

  1. query_playlistget_lean parses the reply as a stream and clears
     each item's element as soon as its useful attributes have been
     copied out. Peak allocation is bounded by one item, not by the
     total reply size.

  2. get_queue_cached stores the parsed list and returns it on the
     next request if HQPlayer still reports the same tracks_total.

Invalidation sources:
  * Explicit calls from every queue-mutating endpoint.
  * sync_queue_cache_with_status, run on every status poll.
"""
from __future__ import annotations

import socket
import time
import xml.etree.ElementTree as ET

from .. import state
from ..config import HQPLAYER_HOST, HQPLAYER_PORT
from ..types import StatusPayload, TrackInfo
from .breaker import hqplayer_breaker
from .client import _XML_TIMING_ENABLED


def invalidate_queue_cache() -> None:
    """Drop the cached queue. Safe to call when no cache exists."""
    with state.queue_cache_lock:
        state.queue_cache = None
        state.queue_cache_total = -1


def sync_queue_cache_with_status(status_data: StatusPayload) -> None:
    """Drop the cache if HQPlayer reports a different queue length.

    Called on every successful status poll. The comparison is one
    integer under the lock, so the cost is negligible against a poll
    that already opens a socket to HQPlayer.
    """
    reported = status_data.get('tracks_total', 0)
    with state.queue_cache_lock:
        if state.queue_cache is not None and reported != state.queue_cache_total:
            state.queue_cache = None
            state.queue_cache_total = -1


def query_playlistget_lean(timeout: float = 30,
                           idle_timeout: float = 1.0
                           ) -> tuple[list[TrackInfo], bool]:
    """Fetch HQPlayer's queue without holding the cover art in memory.

    Streams the reply through an XMLPullParser. Each PlaylistItem's
    five useful attributes are copied into a plain dict the moment
    the element closes, then the element is cleared. The 700 KB
    picture string becomes unreachable and its memory is reusable
    for the next item.

    Returns (tracks, complete).

      tracks   — list of dicts, one per PlaylistItem.
      complete — True when the reply ended via silence after data
                 (the normal case) or via a clean socket close. False
                 when the deadline fired mid-transfer, which means
                 the list is partial and must not be cached.

    HQPlayer does not terminate its PlaylistGet reply in any way
    this code can detect. There is no closing </PlaylistGet> tag on
    the wire, no FIN after the last item, and no newline separator.
    The socket simply goes quiet once the items have been written.
    Attempting to read until EOF blocks until the socket timeout.

    The exit condition is therefore silence: if no bytes have
    arrived for idle_timeout seconds and we've already received at
    least one byte, the reply is treated as complete. HQPlayer sends
    the whole response in a few seconds on this machine, so a
    two-second quiet period is a wide margin. The overall timeout
    parameter remains as a ceiling for the case where HQPlayer is
    slower than expected or never starts replying at all.
    """
    # Bound the queue fetch by the breaker as well. Against a hung
    # upstream this would wait out the full 30 s deadline — longer than
    # the status path's 2 s and the worst single wait in the system.
    if not hqplayer_breaker.allow():
        raise ConnectionError('HQPlayer unavailable (circuit open)')

    from ..timing import record
    fetch_start = time.perf_counter()

    tracks: list[TrackInfo] = []
    complete = False
    timing = _XML_TIMING_ENABLED
    t0 = time.perf_counter() if timing else 0.0
    total_bytes = 0

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                # Each individual recv blocks for at most idle_timeout
                # seconds. The loop distinguishes "silence after we've
                # received something" (done) from "silence before we've
                # received anything" (still waiting).
                sock.settimeout(idle_timeout)
                sock.connect((HQPLAYER_HOST, HQPLAYER_PORT))
                sock.sendall(
                    b'<?xml version="1.0" encoding="utf-8"?><PlaylistGet/>\n')

                parser = ET.XMLPullParser(['end'])
                deadline = time.time() + timeout

                while True:
                    if time.time() >= deadline:
                        print(f'[queue] PlaylistGet timed out after {timeout}s '
                              f'({total_bytes:,} bytes, {len(tracks)} items)')
                        break

                    try:
                        chunk = sock.recv(65536)
                    except socket.timeout:
                        # No data for idle_timeout seconds.
                        if total_bytes > 0:
                            # The stream went quiet after delivering data.
                            # HQPlayer is done; it just doesn't say so.
                            complete = True
                            break
                        # Nothing has arrived yet. HQPlayer may still be
                        # preparing the reply. Keep waiting until the
                        # overall deadline.
                        continue

                    if not chunk:
                        # Socket closed cleanly. Rare with this server,
                        # but handled for completeness.
                        complete = True
                        break

                    total_bytes += len(chunk)
                    parser.feed(chunk)

                    for event, elem in parser.read_events():
                        if event != 'end':
                            continue

                        if elem.tag == 'PlaylistItem':
                            tracks.append({
                                'uri': elem.get('uri', ''),
                                'song': elem.get('song', ''),
                                'artist': elem.get('artist', ''),
                                'album': elem.get('album', ''),
                                'length': elem.get('length', ''),
                            })
                            elem.clear()

                        elif elem.tag == 'PlaylistGet':
                            # Root end tag. Present for small replies,
                            # apparently absent for large ones. Taking it
                            # as a definitive signal when it appears saves
                            # the 2-second idle wait.
                            complete = True

                    if complete:
                        # Root end tag arrived in this chunk, or the
                        # socket closed mid-chunk. Either way the reply
                        # is over and there is nothing to wait for.
                        break

    except Exception as e:
        print(f'[queue] PlaylistGet failed: {e}')
        hqplayer_breaker.failure()
        raise ConnectionError('Failed to communicate with HQPlayer') from e
    finally:
        # Measured normal: a few hundred ms empty, 2-4 s with cover art.
        # The threshold sits above the cover case, so a warning means the
        # queue grew or HQPlayer's reply path degraded.
        record('queue.fetch', (time.perf_counter() - fetch_start) * 1000,
               items=len(tracks), kb=f'{total_bytes // 1024}')

    if timing:
        elapsed_ms = (time.perf_counter() - t0) * 1000
        status = 'complete' if complete else 'incomplete'
        print(f'[xml-query] PlaylistGet: {len(tracks)} items, '
              f'{total_bytes:,} bytes, {elapsed_ms:.0f} ms ({status})')

    return tracks, complete


def get_queue_cached(tracks_total: int) -> list[TrackInfo]:
    """Return HQPlayer's queue, using the cache when possible.

    A cache hit is an integer comparison under the lock — no socket,
    no parse, no allocation. A miss calls PlaylistGet outside the
    lock so a slow fetch doesn't block status polls.

    The cache key is the length of the list we actually parsed, not
    the caller's `tracks_total`. `tracks_total` comes from the last
    status poll, which runs once a second — right after a mutation,
    it's one generation stale. Keying on the stale value means the
    cache ends up labelled with the pre-mutation count while holding
    the post-mutation tracks, and the next request (with the fresh
    count) looks like a mismatch and forces a redundant PlaylistGet.

    Keying on the parsed length makes the label honest: the cache is
    valid exactly when HQPlayer's reported total matches the number
    of tracks we've cached.
    """
    with state.queue_cache_lock:
        if state.queue_cache is not None \
                and state.queue_cache_total == tracks_total:
            return state.queue_cache

    tracks, complete = query_playlistget_lean()

    if complete:
        with state.queue_cache_lock:
            state.queue_cache = tracks
            state.queue_cache_total = len(tracks)
    else:
        print(f'[queue] not caching partial result ({len(tracks)} items)')

    return tracks
