"""Process-wide mutable state shared between modules.

This module imports nothing, so any other module can import it without a
circular dependency. Consumers mutate the attributes directly:

    from .. import state
    state.last_known_status = result

That is a normal module-attribute assignment; the `global` statement is
only needed when rebinding a name inside the module that owns it.
"""
import threading

# Last known status snapshot, used when HQPlayer disappears so the UI
# keeps showing something rather than blanking out.
#
# The snapshot preserves position from the last successful poll. This
# matters for paused tracks: HQPlayer stops sending position frames when
# paused, so a paused tab that loses connection (network partition,
# system sleep, or a short HQPlayer unavailability window) would
# otherwise display 0:00 on reconnect. The snapshot carries the correct
# last-known position into the SSE seed so the UI anchors to it. State,
# transport_loaded, and hqplayer_running are overridden to their
# correct "unknown" values (stopped/False) so the UI does not falsely
# show a playing indicator; only position is preserved from the cache.
last_known_status = None

# Queue cache.
queue_cache = None        # list[dict] | None
queue_cache_total = -1    # HQPlayer's tracks_total when the cache was filled
queue_cache_lock = threading.Lock()

# Cached parse of settings.xml's engine node.
settings_engine_cache = None   # (mtime, available, reason) | None
settings_engine_cache_lock = threading.Lock()
