"""RoastIn — a web music library player fronting HQPlayer.

Module layout:

    roastin/config.py        settings.json + derived configuration constants
    roastin/paths.py         path normalisation and root-containment checks
    roastin/state.py         process-wide caches (token, index, aliases)
    roastin/hqplayer/        HQPlayer control: XML protocol, socket client,
                             status and queue state
    roastin/library/         aliases.json and favorites.json persistence
    roastin/waveform.py      ffmpeg/numpy peak envelopes + disk cache
    roastin/http/            the HTTP layer: handler, routing, static files

Nothing here runs at import time beyond loading settings.json, which
every module needs and which fails fast if malformed.
"""

__version__ = '1.0.0'
