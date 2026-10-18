"""HQPlayer status: query, parse, and volume-availability checks.

Status is polled every second. Parsing settings.xml on every poll would
be wasteful — get_volume_availability() caches by mtime instead.

All mutable state lives in `roastin.state`, which this module imports
without creating a cycle.
"""
import os
import socket
import xml.etree.ElementTree as ET

from .. import state
from ..config import HQPLAYER_HOST, HQPLAYER_PORT, HQPLAYER_SETTINGS_PATH


def get_volume_availability():
    """Return (available, reason) based on the engine node in settings.xml.

    Cached by mtime. Falls back to (True, '') if the file is missing or
    unreadable — the frontend then leaves volume controls enabled, which
    is the safer default than disabling them on a transient error.

    The lock is held across the check-parse-write cycle. Holding it
    during the parse is deliberate: parsing is a few milliseconds even
    for a large settings.xml, and the alternative — releasing between
    check and parse — lets concurrent polls all miss and all parse the
    same file. The cache would still produce correct answers, but it
    would stop doing the work it exists to do.
    """
    try:
        mtime = os.path.getmtime(HQPLAYER_SETTINGS_PATH)
    except OSError:
        # File missing or unreadable. Return the safe default without
        # caching it — a transient error shouldn't freeze the answer
        # until the next mtime change.
        return True, ''

    with state.settings_engine_cache_lock:
        cached = state.settings_engine_cache
        if cached is not None and cached[0] == mtime:
            return cached[1], cached[2]

        available, reason = True, ''
        try:
            tree = ET.parse(HQPLAYER_SETTINGS_PATH)
            engine = tree.getroot().find('engine')
            if engine is not None:
                if engine.get('direct_sdm', '0') == '1':
                    available, reason = False, 'DirectSDM'
                elif engine.get('volume_fixed', '0') == '1':
                    available, reason = False, 'Fixed volume'
        except Exception as e:
            # A malformed or unreadable settings.xml must not disable
            # the volume controls — fall through with the safe default
            # and report why, once per mtime change.
            print(f'[status] could not read engine node from '
                  f'{HQPLAYER_SETTINGS_PATH}: {e}')

        # Single-name rebinding — atomic from the reader's point of
        # view. A reader that grabs `cached` at the top of a later
        # call sees either the previous tuple or this one, never a mix.
        state.settings_engine_cache = (mtime, available, reason)
        return available, reason


def parse_status_element(elem):
    """Extract status data from a parsed <Status> XML element."""
    volume_available, volume_disabled_reason = get_volume_availability()

    status_data = {
        'state': {0: 'stopped', 1: 'paused', 2: 'playing'}.get(
            int(elem.get('state') or 0), 'stopped'
        ),
        'position': float(elem.get('position') or 0),
        'length': float(elem.get('length') or 0),
        'track': int(elem.get('track') or 1),
        'tracks_total': int(elem.get('tracks_total') or 0),
        'volume': float(elem.get('volume') or -100),
        'active_shaper': elem.get('active_shaper', ''),
        'active_mode': elem.get('active_mode', ''),
        'volume_available': volume_available,
        'volume_disabled_reason': volume_disabled_reason,
        'random': elem.get('random', '0'),
        'repeat': elem.get('repeat', '0'),
        'hqplayer_running': True,
        'transport_loaded': True,
    }
    metadata = elem.find('metadata')
    if metadata is not None:
        status_data.update(metadata.attrib)
        if 'samplerate' in status_data:
            status_data['samplerate'] = int(status_data['samplerate'])
        if 'sdm' in status_data:
            status_data['sdm'] = str(status_data['sdm'])

    status_data.setdefault('song', '')
    status_data.setdefault('artist', '')
    status_data.setdefault('albumartist', '')
    status_data.setdefault('album', '')
    status_data.setdefault('samplerate', 0)
    status_data.setdefault('sdm', '0')

    return status_data


def get_native_status():
    """Query HQPlayer's XML API. Returns a status dict."""
    from .queue import sync_queue_cache_with_status

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            sock.connect((HQPLAYER_HOST, HQPLAYER_PORT))
            sock.sendall(
                b'<?xml version="1.0" encoding="utf-8"?><Status/>\n')

            parser = ET.XMLPullParser(['end'])

            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break

                try:
                    parser.feed(chunk)
                except ET.ParseError:
                    return {'error': 'Malformed XML response',
                            'hqplayer_running': True}

                for _event, elem in parser.read_events():
                    if elem.tag == 'Status':
                        result = parse_status_element(elem)

                        # Every successful status parse is an opportunity
                        # to detect that HQPlayer's queue changed outside
                        # of our own endpoints. Invalidate the cache
                        # before the client's next /api/queue call.
                        sync_queue_cache_with_status(result)

                        if result.get('song') or result.get('album'):
                            state.last_known_status = dict(result)
                            result['transport_loaded'] = True
                            return result

                        if state.last_known_status:
                            cached = dict(state.last_known_status)
                            cached['state'] = 'stopped'
                            cached['position'] = 0
                            cached['hqplayer_running'] = True
                            cached['transport_loaded'] = False
                            return cached

                        result['transport_loaded'] = False
                        return result

            return {'error': 'No Status element received',
                    'hqplayer_running': False}

    except OSError:
        if state.last_known_status:
            cached = dict(state.last_known_status)
            cached['state'] = 'stopped'
            cached['position'] = 0
            cached['hqplayer_running'] = False
            cached['transport_loaded'] = False
            return cached
        return {'error': 'Connection refused', 'hqplayer_running': False}

    except Exception as e:
        return {'error': str(e), 'hqplayer_running': True}
