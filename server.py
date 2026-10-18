#!/usr/bin/env python3
"""RoastIn server entry point.

The thin end of the app: imports the package, prints a startup banner,
starts the waveform-cache pruner in the background, and serves until
interrupted. Everything else lives in the roastin/ package.
"""
import os
import sys
import threading

from roastin.config import (
    ALIASES_PATH,
    APP_DIR,
    APP_FOLDER,
    COVER_ROOTS,
    FAVORITES_PATH,
    HTTP_HOST,
    HTTP_PORT,
    HQPLAYER_SCRIPTS,
    ROOT,
    SCRIPTS_DIR,
    SETTINGS_PATH,
    WAVEFORM_CACHE_DIR,
)
from roastin import waveform
from roastin.http.handler import Handler, ThreadingHTTPServer


def main():
    print(f'🎵 {APP_FOLDER} server running at http://localhost:{HTTP_PORT}')
    print(f'   Settings: {SETTINGS_PATH}')
    print(f'   Aliases:  {ALIASES_PATH}')
    print(f'   Scripts:  {SCRIPTS_DIR}')
    print(f'   App root: {APP_DIR}')
    print(f'   Data root: {ROOT}')
    print('   Allowed roots:')
    for r in COVER_ROOTS:
        print(f'     - {r}')
    print(f'   Waveform cache: {WAVEFORM_CACHE_DIR}')
    print(f'   Favorites: {FAVORITES_PATH}')
    token_desc = '<env>' if os.environ.get('ROASTIN_API_TOKEN') \
        else '<repo>/.api_token'
    print(f'   API token: {token_desc}')

    if HTTP_HOST not in ('127.0.0.1', 'localhost', '::1'):
        print(f'   ⚠️  Binding to {HTTP_HOST} — API is reachable on the network.')
        print('   ⚠️  Requests require the X-API-Token header.')
        print('   ⚠️  Do not commit .api_token; treat it like a password.')

    if HQPLAYER_SCRIPTS:
        print(f'   HQPlayer scripts: {", ".join(HQPLAYER_SCRIPTS.keys())}')

    if waveform.FFMPEG_ERROR:
        print(f'   ⚠️  ffmpeg: {waveform.FFMPEG_ERROR}')
    if waveform.NUMPY_ERROR:
        print(f'   ⚠️  numpy: {waveform.NUMPY_ERROR}')
    if not waveform.WAVEFORM_AVAILABLE:
        print('   ⚠️  waveform endpoint will return 503 until both are installed')

    if os.environ.get('ROASTIN_XML_TIMING') == '1':
        print('   ⏱  XML timing enabled (ROASTIN_XML_TIMING=1)')
        print('      Per-command timings will be printed to this log.')

    # Prune stale waveform cache entries off the critical path. The scan is
    # O(cache size) — one stat per file — and can block for hundreds of
    # milliseconds on a large cache. Running it on a daemon thread lets the
    # HTTP listener bind and accept requests immediately.
    def _background_prune():
        pruned = waveform.prune_waveform_cache()
        if pruned:
            print(f'   Pruned {pruned} stale waveform cache file(s)')

    threading.Thread(target=_background_prune, name='WaveformPrune',
                     daemon=True).start()

    server = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down.')
        server.shutdown()


if __name__ == '__main__':
    sys.exit(main())
