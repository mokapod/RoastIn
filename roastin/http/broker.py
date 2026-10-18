"""Server-side status broker.

One poll loop per server — not one per client. The broker calls
get_native_status() on a fixed cadence, diffs each field group
independently, and only wakes subscribers whose group actually moved.

Why diff per group: the frontend treats `position` differently from
everything else. It advances its own clock from the last reported
(offset, startTime) pair and only wants the server's position as a
periodic correction. Every other field is authoritative — song,
album, state, volume — and is applied verbatim.

Current groups:

  transport  song, album, state, track, tracks_total, length  — pushed
             only when something in it changes.

  flags      random, repeat, volume, volume_available, and friends —
             pushed only when something in it changes.

  heartbeat  position only. Sent every `heartbeat_interval` seconds,
             NOT every poll. The frontend interpolates between
             heartbeats, so whole minutes can pass with no traffic
             when the same track is playing. This is the one deliberate
             exception to "push only on change": without it a client that
             joined mid-track — or a tab that was hidden — could display
             a position frozen at the last transport event even though
             the track never paused.

Sharing one socket read across N clients is what makes this cheaper
than N×/s polling: one HQPlayer round-trip per tick no matter how many
tabs are open.

Concurrency notes:

  * The broker runs on its own thread, started once at process start.
  * Subscribers are per-connection Queue objects. The broker never
    blocks on a slow consumer: queues are bounded, and a full queue
    means the consumer disconnected without closing — it is dropped.
  * state.py holds the "latest snapshot" used to seed new subscribers,
    so a tab that connects mid-track gets the current state instantly
    instead of waiting for the next change.
"""
import json
import queue as queue_module
import threading
import time

# Transport fields: identity of what's playing and how far in.
# position is included so every transport event carries the fresh
# anchor (offset, startTime) the frontend needs to re-sync its clock —
# otherwise the client would interpolate from a stale zero after a
# track change.
TRANSPORT_FIELDS = frozenset({
    'song', 'album', 'albumartist', 'artist', 'state', 'track',
    'tracks_total', 'length', 'position', 'samplerate', 'sdm',
    'active_shaper', 'active_mode',
})

# Position is carried in every transport frame as the fresh clock
# anchor, but it does NOT decide whether the transport group changed.
# Without this separate key, a playing track's position changes every
# second and turns "push only on change" back into one frame per tick.
TRANSPORT_DIFF_FIELDS = TRANSPORT_FIELDS - {'position'}

# Everything else the UI mirrors verbatim.
FLAG_FIELDS = frozenset({
    'random', 'repeat', 'volume', 'volume_available',
    'volume_disabled_reason', 'hqplayer_running', 'transport_loaded',
})

# Max frames queued per subscriber before we assume it went away.
_MAX_QUEUE_DEPTH = 32

# How often a position heartbeat goes out regardless of changes.
# The frontend coasts on its own clock between these.
HEARTBEAT_INTERVAL = 30.0

# Broker tick. Must be shorter than the tightest UI need (the position
# display ticks once per second) and longer than a pointless cost.
# 1.0 s preserves the response time of the old 1 Hz poll for every
# non-position field, since transport events are pushed within one tick.
POLL_INTERVAL = 1.0


class Broker:
    """One background poller, N subscribers, per-group fan-out.

    Lifecycle: construct once, call start() once. subscribe() returns a
    (queue, initial_frames) pair; unsubscribe() removes the queue.
    """

    def __init__(self, get_status, poll_interval=POLL_INTERVAL,
                 heartbeat_interval=HEARTBEAT_INTERVAL):
        self._get_status = get_status
        self._poll_interval = poll_interval
        self._heartbeat_interval = heartbeat_interval
        self._subscribers = []          # list[queue.Queue]
        self._sub_lock = threading.Lock()
        self._thread = None
        self._last_transport = None     # last-sent transport frame
        self._last_transport_key = None # same, excluding position
        self._last_flags = None         # last-sent flags frame
        self._last_heartbeat = 0.0      # monotonic, last position push
        self._last_position = {}        # last-sent position frame
        self._running = False

    def start(self):
        """Spawn the poll loop. Idempotent — safe to call twice."""
        with self._sub_lock:
            if self._running:
                return
            self._running = True
        self._thread = threading.Thread(
            target=self._loop, name='StatusBroker', daemon=True)
        self._thread.start()

    def subscribe(self):
        """Register a new SSE connection.

        Returns (queue, seed_frames). The seeds are the latest known
        frames so the client starts current and never waits for the
        next change.
        """
        q = queue_module.Queue(maxsize=_MAX_QUEUE_DEPTH)
        with self._sub_lock:
            self._subscribers.append(q)
            # Snapshot under the same lock so seeds and future pushes
            # can't interleave into a stale-then-fresh inversion.
            seeds = []
            if self._last_transport is not None:
                seeds.append(
                    ('transport', dict(self._last_transport)))
            if self._last_flags is not None:
                seeds.append(('flags', dict(self._last_flags)))
            if self._last_heartbeat:
                # Re-anchor the client's clock from the last known
                # position even if the next heartbeat is far off.
                seeds.append(('heartbeat', dict(self._last_position)))
        return q, seeds

    def unsubscribe(self, q):
        with self._sub_lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass

    def subscriber_count(self):
        with self._sub_lock:
            return len(self._subscribers)

    def _project(self, status):
        """Split one status dict into (transport, flags) frames."""
        transport = {k: status.get(k) for k in TRANSPORT_FIELDS}
        flags = {k: status.get(k) for k in FLAG_FIELDS}
        return transport, flags

    def _fanout(self, kind, payload):
        """Send one frame to every subscriber, dropping dead ones."""
        dead = []
        with self._sub_lock:
            targets = list(self._subscribers)
        for q in targets:
            try:
                q.put_nowait((kind, payload))
            except queue_module.Full:
                dead.append(q)
        if dead:
            with self._sub_lock:
                for q in dead:
                    try:
                        self._subscribers.remove(q)
                    except ValueError:
                        pass

    def _loop(self):
        while self._running:
            started = time.monotonic()
            try:
                status = self._get_status()
            except Exception as e:  # noqa: BLE001 — upstream covered, must not die
                # get_native_status already returns error dicts rather
                # than raising, so this is the belt-and-suspenders for
                # truly unexpected failures. The loop must never die:
                # it is the only poller in the process.
                print(f'[broker] status fetch raised: {e}')
                status = {'error': str(e), 'hqplayer_running': False}

            transport, flags = self._project(status)
            transport_key = {
                k: transport.get(k) for k in TRANSPORT_DIFF_FIELDS
            }

            if transport_key != self._last_transport_key:
                self._last_transport_key = transport_key
                self._last_transport = transport
                self._last_position = {'position': transport.get('position', 0),
                                       'length': transport.get('length', 0)}
                self._last_heartbeat = time.monotonic()
                self._fanout('transport', transport)

            if flags != self._last_flags:
                self._last_flags = flags
                self._fanout('flags', flags)

            # Heartbeat: position only, on its own cadence, only while
            # something is actually playing. Silent when stopped so an
            # idle server emits zero frames per minute.
            now = time.monotonic()
            if (status.get('state') == 'playing'
                    and now - self._last_heartbeat >= self._heartbeat_interval):
                heartbeat = {'position': status.get('position', 0),
                             'length': status.get('length', 0)}
                self._last_position = dict(heartbeat)
                self._last_heartbeat = now
                self._fanout('heartbeat', heartbeat)

            elapsed = time.monotonic() - started
            time.sleep(max(0.0, self._poll_interval - elapsed))


def format_sse(kind, payload):
    """Encode one frame as an SSE message body."""
    return f'event: {kind}\ndata: {json.dumps(payload)}\n\n'
