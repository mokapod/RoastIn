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
last_known_status = None

# Queue cache.
queue_cache = None        # list[dict] | None
queue_cache_total = -1    # HQPlayer's tracks_total when the cache was filled
queue_cache_lock = threading.Lock()

# Cached parse of settings.xml's engine node.
settings_engine_cache = None   # (mtime, available, reason) | None
settings_engine_cache_lock = threading.Lock()
