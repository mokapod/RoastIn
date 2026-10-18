"""HQPlayer XML protocol — socket-level command dispatch.

Two senders:

  send_xml_command          one command, read one reply, close.
                            For single, unrelated commands.

  send_xml_commands_piped   N commands on one socket, then drain.
                            Collapses N round-trips into one tick of
                            HQPlayer's poll loop. Never use for N=1 —
                            the drain's idle window would be added on
                            top of the reply latency for no benefit.

XML timing diagnostics are enabled by ROASTIN_XML_TIMING=1 in the
server's environment.
"""
import os
import socket
import time

from ..config import HQPLAYER_HOST, HQPLAYER_PORT
from .breaker import hqplayer_breaker

_XML_TIMING_ENABLED = os.environ.get('ROASTIN_XML_TIMING') == '1'


def _require_reachable():
    """Fail fast when the breaker says HQPlayer isn't answering.

    Raises the same ConnectionError a real failure would, so the HTTP
    layer maps it identically — only the latency differs.
    """
    if not hqplayer_breaker.allow():
        raise ConnectionError('HQPlayer unavailable (circuit open)')


def send_xml_command(xml_string):
    """Send a native XML command to HQPlayer. Fire-and-forget.

    When _XML_TIMING_ENABLED is true (ROASTIN_XML_TIMING=1 in the
    server's environment), the connect, send, and reply-wait phases
    are timed separately and printed to the log. The three are
    distinct costs:

      connect — the TCP handshake. On loopback, tens of microseconds.
                Not worth optimizing unless this dominates.
      send    — the outbound write. Negligible either way.
      reply   — waiting for HQPlayer to process the command and
                write its reply. This is the round-trip cost, and on
                the queue-move path it is the one that multiplies.

    For batches of two or more related commands (queue append, queue
    move, a SelectTrack-then-Play pair), prefer
    send_xml_commands_pipelined — the per-command reply wait is
    eliminated there.
    """
    timing = _XML_TIMING_ENABLED
    t0 = time.perf_counter() if timing else 0.0

    _require_reachable()

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            sock.connect((HQPLAYER_HOST, HQPLAYER_PORT))
            t1 = time.perf_counter() if timing else 0.0

            request = (
                f'<?xml version="1.0" encoding="utf-8"?>{xml_string}\n'
            ).encode()
            sock.sendall(request)
            t2 = time.perf_counter() if timing else 0.0

            try:
                sock.recv(4096)
                # A reply means HQPlayer is answering. Handshaking alone
                # proves nothing — a hung HQPlayer accepts and then says
                # nothing, which would leave the breaker stuck closed.
                hqplayer_breaker.success()
            except socket.timeout:
                # Deliberately NOT a failure(). A healthy HQPlayer can
                # take longer than 2 s to acknowledge a command, so a
                # timeout here is not evidence of a dead upstream, and
                # counting it would open the breaker against a working
                # server. Health is sampled by get_native_status, which
                # is polled every second and treats its timeout as
                # failure — that path opens the breaker within one poll
                # interval and this command path then fails fast.
                pass
            t3 = time.perf_counter() if timing else 0.0

        if timing:
            print(f'[xml-timing] connect={(t1-t0)*1000:6.2f}ms  '
                  f'send={(t2-t1)*1000:5.2f}ms  '
                  f'reply={(t3-t2)*1000:7.2f}ms  '
                  f'total={(t3-t0)*1000:7.2f}ms  '
                  f'cmd={xml_string[:50]}')
    except Exception as e:
        print(f'XML Command failed: {e}')
        hqplayer_breaker.failure()
        raise ConnectionError('Failed to communicate with HQPlayer') from e


def send_xml_commands_pipelined(xml_strings, idle_timeout=0.5):
    """Send N XML commands on one socket, then drain replies.

    A single command is not a batch. Pipelining exists to collapse N
    round-trips into one tick of HQPlayer's poll loop; with N=1 there
    is nothing to collapse, and the drain's idle window (~500 ms) is
    added on top of the reply latency (~320 ms) with no compensating
    benefit. That's why the single-command case delegates to
    send_xml_command, which reads once and closes.

    Two commands are already worth pipelining. Sequential dispatch is
    roughly 2 × (connect + reply) ≈ 640 ms; pipelined dispatch is
    connect + write + drain ≈ 500 ms, because the drain's idle window
    overlaps both replies rather than following each one. The gap
    widens with N — three commands go from ~960 ms to ~500 ms, which
    is the savings the album-load path relies on.

    Order matters when the commands are position-dependent (queue
    moves, SelectTrack-then-Play): HQPlayer reads them off the socket
    in the order written, and writes preserve order on a single
    stream, so the sequence arrives intact.
    """
    if not xml_strings:
        return

    if len(xml_strings) <= 1:
        for xml_string in xml_strings:
            send_xml_command(xml_string)
        return

    # The N=1 case delegates above, so its breaker logic applies.
    # For N≥2 this function opens its own socket — gate that here.
    _require_reachable()

    timing = _XML_TIMING_ENABLED
    t_start = time.perf_counter() if timing else 0.0

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(10.0)
            sock.connect((HQPLAYER_HOST, HQPLAYER_PORT))

            # Phase 1 — write every command back-to-back. No reads
            # between sends. Each command is ~200 bytes; a 30-command
            # batch is under 10 KB, comfortably within the kernel's
            # send buffer, so no sendall() blocks waiting for HQPlayer
            # to drain its input.
            for xml_string in xml_strings:
                request = (
                    f'<?xml version="1.0" encoding="utf-8"?>{xml_string}\n'
                ).encode()
                sock.sendall(request)

            t_sent = time.perf_counter() if timing else 0.0

            # Phase 2 — drain. HQPlayer will send one acknowledgment
            # per command. We don't know whether it bursts them or
            # trickles them, so we read until the socket goes quiet
            # for idle_timeout seconds.
            sock.settimeout(idle_timeout)
            reply_bytes = 0
            reply_chunks = 0

            while True:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                reply_bytes += len(chunk)
                reply_chunks += 1

            t_drained = time.perf_counter() if timing else 0.0

        if timing:
            send_ms = (t_sent - t_start) * 1000
            drain_ms = (t_drained - t_sent) * 1000
            per_cmd = drain_ms / len(xml_strings)
            warning = '  ⚠️  no replies received' if reply_chunks == 0 else ''
            print(f'[xml-pipeline] {len(xml_strings)} cmd(s): '
                  f'send={send_ms:.1f}ms  drain={drain_ms:.1f}ms  '
                  f'total={(send_ms + drain_ms):.1f}ms  '
                  f'({per_cmd:.1f} ms/cmd)  '
                  f'recv={reply_chunks} chunks, {reply_bytes:,} bytes'
                  f'{warning}')

    except Exception as e:
        print(f'XML pipelined commands failed: {e}')
        hqplayer_breaker.failure()
        raise ConnectionError('Failed to communicate with HQPlayer') from e
