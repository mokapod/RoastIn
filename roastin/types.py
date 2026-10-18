"""Typed shapes for the payloads that cross module boundaries.

These exist because the same dict travels from HQPlayer's XML, through
the broker, into the frontend's window.CONFIG — and every bug found in
this codebase so far was a mismatch at one of those seams:

  * a field present in the status payload but absent from the SSE
    projection (position, silently dropped from transport frames)
  * a boolean flag compared as a string ('1' vs 1) in three places
  * `transport_loaded` defaulting differently on two return paths

Annotations here are documentation the type checker can enforce, not a
refactor: nothing at runtime changes, and TypedDicts erase to plain
dicts, so the JSON on the wire is byte-identical.

Deliberately NOT modelled: the album/track structures the frontend
builds from DOM nodes. Those live entirely in the browser, and typing
them here would imply the server knows their shape.
"""
from __future__ import annotations

from typing import Any, Dict, List, TypedDict


class StatusPayload(TypedDict, total=False):
    """One HQPlayer status snapshot.

    total=False because the error paths return a strict subset — the
    frontend has always had to tolerate missing fields, and saying so
    in the type is more honest than a lie the checker would enforce.
    """
    # transport
    state: str                 # 'stopped' | 'paused' | 'playing'
    position: float
    length: float
    track: int
    tracks_total: int
    song: str
    artist: str
    albumartist: str
    album: str
    samplerate: int
    sdm: str
    active_shaper: str
    active_mode: str

    # flags
    volume: float
    volume_available: bool
    volume_disabled_reason: str
    random: str
    repeat: str
    hqplayer_running: bool
    transport_loaded: bool

    # error paths
    error: str


class TrackInfo(TypedDict):
    """One queue item, as HQPlayer's PlaylistItem carries it."""
    uri: str
    song: str
    artist: str
    album: str
    length: str


class WaveformResult(TypedDict):
    """Peak envelope. `data` is 0-255 samples, length == points."""
    duration: float
    points: int
    data: List[int]


class AliasMaps(TypedDict):
    """The two alias tables the frontend consumes."""
    artistAliases: Dict[str, List[str]]
    composerAliases: Dict[str, List[str]]


class LibraryFileInfo(TypedDict):
    """One <file> entry from library.xml, for the startup check."""
    name: str
    song: str
    length: int


class LibraryReport(TypedDict):
    """Result of the startup library.xml validation."""
    ok: bool
    path: str
    bytes: int
    directories: int
    files: int
    error: str
    line: int
    column: int


# A JSON value the server can emit. Used where a helper returns
# "whatever json.dumps accepts" rather than one specific shape.
JSONValue = Any
