"""Circuit breaker for HQPlayer reachability.

Why this exists: when HQPlayer is hung (process alive, not answering),
every caller waits out its socket timeout. Measured on this machine:
2.03 s per /api/status poll, with one thread per waiting request. The
frontend polls at 1 Hz, so a hung HQPlayer means the UI freezes for two
seconds on every single tick.

A stopped HQPlayer is different — it refuses the connection instantly,
so there is nothing to wait for. The expensive case is specifically
"accepts the connection, never replies".

Behaviour:
  CLOSED     every caller attempts. Normal operation.
  OPEN       every caller fails fast for `cooldown` seconds. No socket.
  HALF_OPEN  cooldown elapsed; exactly ONE caller probes. If it
             succeeds the breaker closes; if it fails it re-opens.

The half-open probe is what makes recovery fast without a thundering
herd: without it, N clients would all retry at the same instant the
cooldown expires and all wait out the timeout together.

Recovery cost: at most `cooldown` seconds of "unavailable" after
HQPlayer comes back. With the frontend polling at 1 Hz that is
invisible; the alternative (probing on every request) is the pile-up
this exists to prevent.
"""
import threading
import time

# How long to fail fast after a failure. Must be comfortably longer than
# the frontend's poll interval (1 s) so a burst of polls is absorbed,
# and short enough that recovery feels immediate.
COOLDOWN_SECONDS = 5.0


class CircuitBreaker:
    """Thread-safe three-state breaker. One instance per upstream."""

    def __init__(self, cooldown=COOLDOWN_SECONDS):
        self._lock = threading.Lock()
        self._open_until = 0.0   # monotonic deadline; 0.0 == closed
        self._probing = False
        self._cooldown = cooldown

    def allow(self):
        """True if this caller may attempt the upstream call.

        False means "fail fast" — return the last known state without
        opening a socket.
        """
        with self._lock:
            now = time.monotonic()

            if self._open_until == 0.0:
                return True                      # CLOSED

            if now < self._open_until:
                return False                     # OPEN — still cooling

            # HALF_OPEN — cooldown expired, let exactly one probe through.
            if self._probing:
                return False
            self._probing = True
            return True

    def success(self):
        """Record a successful call. Closes the breaker."""
        with self._lock:
            self._open_until = 0.0
            self._probing = False

    def failure(self):
        """Record a failed call. Opens the breaker for the cooldown."""
        with self._lock:
            self._open_until = time.monotonic() + self._cooldown
            self._probing = False

    def release(self):
        """Abandon a probe without recording a verdict.

        Used when a caller took a probe slot but did not reach the
        upstream for a reason that says nothing about its health (e.g.
        an exception in local code before the connect). Without this
        the probe slot would leak and the breaker would never re-close.
        """
        with self._lock:
            self._probing = False

    @property
    def is_open(self):
        with self._lock:
            return self._open_until != 0.0 and time.monotonic() < self._open_until

    def state(self):
        """'closed' | 'open' | 'half_open' — for logging and diagnostics."""
        with self._lock:
            if self._open_until == 0.0:
                return 'closed'
            if time.monotonic() < self._open_until:
                return 'open'
            return 'half_open'


# Process-wide: HQPlayer is a single upstream.
hqplayer_breaker = CircuitBreaker()
