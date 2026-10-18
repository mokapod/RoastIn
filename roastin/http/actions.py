"""Route handlers that own their entire HTTP response.

Each function here takes the handler instance, reads its own body,
validates, dispatches to HQPlayer or disk, and writes the response.
Functions that `return` from inside the router (load, run-script,
waveform, queue-get) write their own responses; the rest fall back to
the router's generic {"status": "success"} reply.
"""
import json
import os
import subprocess
import time
from xml.sax.saxutils import quoteattr, escape as xml_escape

from .. import state
from ..config import (
    FAVORITES_PATH,
    HQPLAYER_APP,
    HQPLAYER_SCRIPTS,
    ROOT,
    SCRIPTS_DIR,
)
from ..hqplayer.client import send_xml_command, send_xml_commands_pipelined
from ..hqplayer.queue import get_queue_cached, invalidate_queue_cache
from ..library.favorites import load_favorites, save_favorites
from ..paths import is_within_allowed_roots, normalize_path
from ..platform import os_open, os_quit_app, os_reveal
from .body import get_int, read_json_body


def build_m3u8(paths):
    """Build an M3U8 playlist body for HQPlayer's PlaylistUpload command."""
    lines = ['#EXTM3U']
    for p in paths:
        lines.append(f'#EXTINF:-1,{os.path.basename(p)}')
        lines.append(p)
    return '\n'.join(lines) + '\n'


def handle_hqplayer_action(handler):
    """HQPlayer menu commands from the frontend."""
    data = read_json_body(handler)
    cmd = data.get('command', '')

    if cmd == 'activate':
        from ..platform import os_launch_app
        os_launch_app(HQPLAYER_APP)

    elif cmd == 'reveal-settings':
        settings_dir = os.path.join(ROOT, '.hqplayer')
        if not os.path.isdir(settings_dir):
            raise ValueError('Settings folder not found')
        os_open(settings_dir)

    elif cmd == 'reveal-library':
        library_file = os.path.join(ROOT, '.hqplayer', 'library.xml')
        if not os.path.isfile(library_file):
            raise ValueError('library.xml not found')
        os_reveal(library_file)

    elif cmd == 'quit':
        os_quit_app(HQPLAYER_APP)

    else:
        raise ValueError(f'Unknown command: {cmd}')


def handle_run_script(handler):
    """Run a whitelisted shell script and wait for it to finish.

    Sends its own response so it can return the script's stdout to the
    frontend. The caller in the POST router must return immediately
    after calling this.
    """
    data = read_json_body(handler)
    name = (data.get('name') or '').strip()

    if not name:
        raise ValueError("Missing 'name' parameter")

    if name not in HQPLAYER_SCRIPTS:
        raise ValueError(f'Unknown script: {name}')

    script_path = os.path.expanduser(HQPLAYER_SCRIPTS[name])

    if not os.path.isabs(script_path):
        script_path = os.path.join(SCRIPTS_DIR, script_path)

    if not os.path.isfile(script_path):
        raise ValueError(f'Script not found: {script_path}')

    if not os.access(script_path, os.X_OK):
        raise ValueError(f'Script not executable: {script_path}')

    try:
        result = subprocess.run(
            ['/bin/bash', script_path],
            capture_output=True,
            timeout=60,
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise ValueError('Script timed out after 60s') from e

    stdout = result.stdout.decode('utf-8', errors='replace').strip()
    stderr = result.stderr.decode('utf-8', errors='replace').strip()

    # Log to the server terminal so debugging is possible even when
    # the frontend only sees the summary.
    if stdout:
        print(f'[run-script:{name}] {stdout}')
    if stderr:
        print(f'[run-script:{name}] stderr: {stderr}')

    if result.returncode != 0:
        raise ValueError(
            f'Script failed (exit {result.returncode})'
            + (f': {stderr[:200]}' if stderr else '')
        )

    handler.send_response(200)
    handler.send_header('Content-type', 'application/json')
    handler.end_headers()
    handler.wfile.write(json.dumps({
        'status': 'success',
        'output': stdout,
    }).encode())


def handle_load(handler):
    """Load an album into HQPlayer's transport.

    `mode` selects which of HQPlayer's two transport engines is used:

      'album' (default) — SetTransportPath for single-directory
                          albums. Gapless, but the resulting
                          transport cannot be appended to.
      'queue'           — PlaylistUpload. A track queue that
                          PlaylistAdd can extend.

    Multi-directory albums (disc folders) always use the queue path,
    since SetTransportPath cannot span directories.

    This function owns its HTTP response. The 'mode' field in that
    response reports the engine that was actually used, which differs
    from the requested mode whenever a multi-directory album was
    loaded with mode='album'. The client tracks this so a subsequent
    'Add to Queue' doesn't issue a redundant transport switch.

    A load may replace HQPlayer's current queue (queue mode) or leave
    it alone (album mode). Either way, the cached queue is invalidated
    — it costs nothing to invalidate on an album load and it
    guarantees correctness on a queue load.

    Every track path is validated against the allowed roots before
    any command reaches HQPlayer. Without that check, a client with a
    valid token could hand HQPlayer an arbitrary filesystem path and
    observe whether the transport attempted to decode it.

    The start_track and seek_to conversions are null-safe
    (`None or 1` evaluates to 1), so unlike the other POST handlers
    they don't route through get_int.

    Timing: after the transport is primed (upload or
    SetTransportPath), the trailing SelectTrack / Seek / Play sequence
    goes through send_xml_commands_pipelined. Those three commands
    depend on the primed state but not on each other's side effects
    beyond ordering, so batching them on one socket collapses three
    round-trips into one. The sleeps before each batch are genuine —
    HQPlayer needs a moment to register the upload or the transport
    path before SelectTrack can address it — so they stay.
    """
    data = read_json_body(handler)
    tracks = data.get('tracks', [])
    start_track = int(data.get('start_track', 1) or 1)
    seek_to = int(data.get('seek_to', 0) or 0)
    mode = data.get('mode', 'album')

    # Default to the requested mode. Overwritten below once the
    # multi-directory heuristic has run, so the response always
    # reports what actually happened rather than what was asked for.
    effective_mode = mode

    # Reject an empty track list outright. The previous behaviour fell
    # through the `if tracks:` guard below and replied
    # {"status": "success"} without sending anything to HQPlayer — the
    # client then believed playback had started against a transport
    # that was never primed, and subsequent Play/Pause commands went
    # to whatever was previously loaded.
    #
    # The queue-append handler already raises on an empty list, so
    # this aligns load with it. A client that means "clear the
    # transport" should call /api/stop, not /api/load with nothing.
    if not tracks:
        raise ValueError("Missing 'tracks'")

    paths = [normalize_path(t.get('path', '')) for t in tracks]

    # Reject any path that resolves outside the allowed roots. Done
    # before the multi-directory check so an out-of-bounds path fails
    # fast with a clear error rather than after attempting to compute
    # unique_dirs.
    for p in paths:
        if not is_within_allowed_roots(p):
            raise ValueError('Track path outside allowed roots')

    unique_dirs = list({os.path.dirname(p) for p in paths})

    if start_track < 1 or start_track > len(paths):
        start_track = 1

    use_playlist = (mode == 'queue') or (len(unique_dirs) > 1)
    effective_mode = 'queue' if use_playlist else 'album'

    # Commands shared by both branches once the transport is primed.
    # Built once, dispatched via the pipelined sender.
    def _post_load_commands():
        cmds = [f'<SelectTrack index="{start_track}"/>']
        if seek_to > 0:
            cmds.append(f'<Seek position="{seek_to}"/>')
        cmds.append('<Play/>')
        return cmds

    if use_playlist:
        send_xml_command('<PlaylistClear/>')

        m3u_content = build_m3u8(paths)
        # Only &, <, > need escaping in XML text content. Quotes are
        # special only inside attribute values, which this isn't.
        safe_content = xml_escape(m3u_content)

        upload_cmd = (
            '<PlaylistUpload filename="album_queue.m3u8">\n'
            f'{safe_content}'
            '</PlaylistUpload>'
        )
        send_xml_command(upload_cmd)

        # HQPlayer registers the uploaded tracks asynchronously.
        # SelectTrack issued before that finishes addresses the
        # previous (now-cleared) queue and silently fails.
        time.sleep(0.5)

        send_xml_commands_pipelined(_post_load_commands())

    else:
        # SINGLE-DISC: SetTransportPath
        dir_path = unique_dirs[0]

        send_xml_command(
            f'<SetTransportPath value={quoteattr(dir_path)} freewheel="1"/>'
        )

        # Same reasoning as the upload sleep, but shorter: the
        # directory already exists in HQPlayer's library, so there is
        # no per-track registration to wait on.
        time.sleep(0.15)

        send_xml_commands_pipelined(_post_load_commands())

    # The old queue is unreachable after a queue-mode load and
    # possibly stale after an album-mode load. Either way, the next
    # /api/queue must fetch fresh.
    invalidate_queue_cache()

    handler.send_response(200)
    handler.send_header('Content-type', 'application/json')
    handler.end_headers()
    handler.wfile.write(json.dumps({
        'status': 'success',
        'mode': effective_mode,
    }).encode())


def handle_queue_append(handler):
    """Append tracks to HQPlayer's queue without interrupting playback.

    Collects every PlaylistAdd into a single batch and dispatches
    through send_xml_commands_pipelined. The sequential form of this
    loop took N × 320 ms for N tracks; the pipelined form takes
    roughly one poll tick regardless of N, because HQPlayer reads the
    batched commands together.

    A one-track append still falls through to send_xml_command in the
    pipelined helper — pipelining a single command adds the drain
    window without collapsing anything.

    Every track path is validated against the allowed roots before
    any command reaches HQPlayer — same reasoning as handle_load.
    """
    data = read_json_body(handler)
    tracks = data.get('tracks', [])

    if not tracks:
        raise ValueError("Missing 'tracks'")

    commands = []
    for t in tracks:
        path = normalize_path(t.get('path', ''))
        if not path:
            continue
        if not is_within_allowed_roots(path):
            raise ValueError('Track path outside allowed roots')
        commands.append(f'<PlaylistAdd uri={quoteattr(path)} queued="0"/>')

    # The loop above skips entries whose `path` is empty or whitespace.
    # If every entry in the request was skipped, the previous behaviour
    # dispatched send_xml_commands_pipelined([]) — a documented no-op —
    # and then replied {"status": "success"}. The client showed "Added
    # N tracks to queue" for a batch that never touched HQPlayer.
    #
    # Failing loudly here means the client's error branch runs and the
    # user sees "Failed to add to queue" instead of a silent no-op.
    # The condition can only arise from a malformed request (the
    # frontend always sends a `path`), so treating it as a client
    # error is appropriate.
    if not commands:
        raise ValueError('No valid track paths to append')

    send_xml_commands_pipelined(commands)
    invalidate_queue_cache()


def handle_queue_move(handler):
    """Move a track within HQPlayer's queue.

    HQPlayer exposes only single-step moves — there is no direct
    "move from N to M" command. A move of distance d becomes d
    single-step commands, with the index tracking the moving track's
    current position:

      moving down:  index increments on each step
      moving up:    index decrements on each step

    The command sequence is dispatched through the pipelined sender so
    the batch arrives at HQPlayer in one write burst. Order matters
    here in a way it does not for PlaylistAdd: the commands are
    position-dependent, so if HQPlayer reorders them the queue ends up
    in the wrong state. Single-stream socket writes preserve order, so
    the sequence arrives intact.

    A distance-1 move is a single command and goes through
    send_xml_command — nothing to collapse.

    The queue is invalidated after a successful move so the next
    /api/queue returns the reordered list. The order changed but the
    length did not, so the tracks_total-based invalidation in
    get_native_status would not catch this on its own.
    """
    data = read_json_body(handler)
    from_idx = get_int(data, 'from', 0)
    to_idx = get_int(data, 'to', 0)

    if from_idx < 1 or to_idx < 1:
        raise ValueError('Invalid from/to indices')
    if from_idx == to_idx:
        return

    commands = []
    if to_idx > from_idx:
        for i in range(from_idx, to_idx):
            commands.append(f'<PlaylistMoveDown index="{i}"/>')
    else:
        for i in range(from_idx, to_idx, -1):
            commands.append(f'<PlaylistMoveUp index="{i}"/>')

    send_xml_commands_pipelined(commands)
    invalidate_queue_cache()


def handle_queue_remove(handler):
    """Remove a single track from HQPlayer's queue.

    PlaylistRemove takes a 1-based index. Removal shifts every
    subsequent entry down by one, so a caller removing multiple tracks
    must remove from highest index to lowest or re-fetch between
    removals. The client re-renders after each removal, which
    sidesteps the issue entirely.
    """
    data = read_json_body(handler)
    index = get_int(data, 'index', 0)

    if index < 1:
        raise ValueError('Invalid index')

    send_xml_command(f'<PlaylistRemove index="{index}"/>')
    invalidate_queue_cache()


def handle_queue_clear(handler):
    """Empty HQPlayer's queue.

    PlaylistClear has no arguments — it wipes the entire list.
    Playback stops; the transport is left empty. The client re-renders
    the queue view, which shows the empty state.
    """
    send_xml_command('<PlaylistClear/>')
    invalidate_queue_cache()


def handle_queue_get(handler):
    """Return HQPlayer's current queue as JSON.

    The tracks_total from the last successful status poll decides
    whether the cache is still valid. The status poll runs once per
    second per client, so the value is at most a second stale — good
    enough to detect any change that alters the queue length, without
    opening another socket to HQPlayer on the fast path.

    A cache miss means a full PlaylistGet, which takes a few seconds
    for a large queue. That is the cost of HQPlayer including the
    cover art on every item, not something the server can avoid.
    """
    status_total = (state.last_known_status or {}).get('tracks_total', 0)

    try:
        tracks = get_queue_cached(status_total)
    except Exception as e:
        handler.send_response(502)
        handler.send_header('Content-type', 'application/json')
        handler.end_headers()
        handler.wfile.write(json.dumps({'error': str(e)}).encode())
        return

    handler.send_response(200)
    handler.send_header('Content-type', 'application/json')
    handler.end_headers()
    handler.wfile.write(json.dumps({'tracks': tracks}).encode())


def handle_waveform(handler, waveform_module):
    """Compute and return a waveform envelope, or an error response.

    The requested path is validated against the allowed roots before
    it reaches ffmpeg. Without this check, a client with a valid token
    could ask the server to decode any file the server process can
    read — a path outside the music library would still be handed to
    ffmpeg, which would fail on non-audio input but would reveal file
    existence and, for audio, its duration.

    `waveform_module` is the roastin.waveform module, passed in rather
    than imported at module scope so the numpy/ffmpeg probing stays
    lazy — importing this module never probes for optional deps.
    """
    data = read_json_body(handler)
    audio_path = normalize_path(data.get('path', ''))

    if not audio_path or not is_within_allowed_roots(audio_path):
        print(f'[waveform] 403 — path outside allowed roots: {audio_path}')
        handler.send_response(403)
        handler.send_header('Content-type', 'application/json')
        handler.end_headers()
        handler.wfile.write(
            json.dumps({'error': 'Path outside allowed roots'}).encode())
        return

    if not waveform_module.WAVEFORM_AVAILABLE:
        detail = []
        if waveform_module.FFMPEG_ERROR:
            detail.append(waveform_module.FFMPEG_ERROR)
        if waveform_module.NUMPY_ERROR:
            detail.append(f'numpy: {waveform_module.NUMPY_ERROR}')
        msg = '; '.join(detail) or 'waveform backend unavailable'
        print(f'[waveform] 503 — {msg}')
        handler.send_response(503)
        handler.send_header('Content-type', 'application/json')
        handler.end_headers()
        handler.wfile.write(json.dumps({
            'error': msg,
            'hint': ('Install ffmpeg (brew install ffmpeg) '
                     'and numpy (pip3 install numpy)'),
        }).encode())
        return

    if not os.path.isfile(audio_path):
        print(f'[waveform] 404 — file not found: {audio_path}')
        handler.send_response(404)
        handler.send_header('Content-type', 'application/json')
        handler.end_headers()
        handler.wfile.write(
            json.dumps({'error': 'Audio file not found'}).encode())
        return

    try:
        result = waveform_module.analyze_waveform(audio_path)
    except Exception as e:
        import traceback
        print(f'[waveform] 500 — {e}')
        traceback.print_exc()
        handler.send_response(500)
        handler.send_header('Content-type', 'application/json')
        handler.end_headers()
        handler.wfile.write(json.dumps({'error': str(e)}).encode())
        return

    handler.send_response(200)
    handler.send_header('Content-type', 'application/json')
    handler.end_headers()
    handler.wfile.write(json.dumps(result).encode())


def set_favorite(handler, favorites_lock):
    """Toggle one album hash in favorites.json.

    Read-modify-write under the lock. Without it, two concurrent
    toggles on different hashes both load the same snapshot and the
    second write silently discards the first one's change.
    """
    data = read_json_body(handler)
    hash_value = (data.get('hash') or '').strip()
    value = bool(data.get('value'))
    if not hash_value:
        raise ValueError("Missing 'hash' parameter")

    with favorites_lock:
        favs = load_favorites()
        if value:
            favs.add(hash_value)
        else:
            favs.discard(hash_value)
        save_favorites(favs)


def reveal_folder(handler):
    """Open a folder in the OS file manager, restricted to allowed roots.

    Even with a valid token, the frontend has no business opening
    arbitrary paths on the server machine.
    """
    data = read_json_body(handler)
    folder = normalize_path(data.get('path', ''))

    if not folder or not os.path.isdir(folder):
        raise ValueError('Folder not found')

    if not is_within_allowed_roots(folder):
        raise ValueError('Path outside allowed roots')

    os_reveal(folder)


# Imported late to avoid a cycle: state.py has no imports, so a direct
# import at the top would be fine — kept here only for documentation.
_ = FAVORITES_PATH
_ = state
