"""Waveform cache: peak-envelope persistence in one SQLite database.

Replaces the flat directory of per-track JSON files. The cache's public
contract is deliberately tiny — get/put/prune/stats — and waveform.py
is the only caller.

The connection is per-thread (`threading.local`), not shared. SQLite
connections are not safely shareable by default, and a global Python
lock would serialize every reader with every writer — exactly the
contention WAL mode exists to avoid. WAL + per-thread connections means
request threads can read cache hits while one waveform worker commits a
new row.

Peaks are 0-255 uint8 samples packed as a BLOB. 1,200 points consume
exactly 1,200 bytes instead of ~5 KB of JSON text and avoid JSON parsing
on a hit.

Migration is handled by migrate_flat_cache(), called explicitly during
startup before request threads begin. It imports into one transaction,
backfills cached_at from file mtime (preserving the old 90-day prune
contract), validates the committed row count, then removes only the
files that were successfully imported. Any unparseable files are left
in place and reported; they are harmless misses that ffmpeg can rebuild.
"""
import json
import os
import sqlite3
import threading
import time

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS waveform_cache (
  key       TEXT PRIMARY KEY,
  duration  REAL NOT NULL,
  points    INTEGER NOT NULL,
  peaks     BLOB NOT NULL,
  cached_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waveform_cached_at
  ON waveform_cache (cached_at);
"""

_local = threading.local()
_schema_lock = threading.Lock()
_schema_by_path = set()


def db_path():
    """Database beside the configured legacy cache directory."""
    base = config.WAVEFORM_CACHE_DIR
    return os.path.join(
        os.path.dirname(os.path.expanduser(base.rstrip(os.sep))),
        'waveforms.sqlite3')


def _new_connection():
    path = db_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    conn = sqlite3.connect(path, timeout=10.0)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=NORMAL')
    return conn


def connection():
    """Return this thread's connection, creating it lazily.

    Schema is tracked per database path, not once globally: a test (or
    a config change) pointing at a fresh path must not skip CREATE TABLE
    just because an earlier database already had it.
    """
    path = db_path()
    conn = getattr(_local, 'conn', None)
    old_path = getattr(_local, 'path', None)
    if conn is not None and old_path != path:
        conn.close()
        conn = None

    if conn is None:
        conn = _new_connection()
        _local.conn = conn
        _local.path = path

    if path not in _schema_by_path:
        with _schema_lock:
            if path not in _schema_by_path:
                conn.executescript(SCHEMA)
                _schema_by_path.add(path)

    return conn


def reset_for_tests():
    """Close this thread's connection and drop known schemas."""
    conn = getattr(_local, 'conn', None)
    if conn is not None:
        conn.close()
    _local.conn = None
    _local.path = None


def get_cached(key):
    """Return the cached result dict for key, or None on a miss.

    A corrupt row (BLOB length differs from points) is deleted and
    treated as a miss rather than breaking playback.
    """
    row = connection().execute(
        'SELECT duration, points, peaks FROM waveform_cache WHERE key=?',
        (key,)).fetchone()
    if row is None:
        return None

    duration, points, raw = row
    peaks = bytes(raw)
    if len(peaks) != points:
        print(f'[waveform] cache row corrupt for {key}, recomputing')
        delete_cached(key)
        return None

    return {'duration': duration, 'points': points, 'data': list(peaks)}


def put_cached(key, duration, points, data):
    """Persist one result in a single transaction."""
    peaks = bytes(data)
    if len(peaks) != int(points):
        raise ValueError(
            f'waveform points/data mismatch: {points} != {len(peaks)}')
    conn = connection()
    with conn:
        conn.execute(
            'INSERT OR REPLACE INTO waveform_cache '
            '(key, duration, points, peaks, cached_at) VALUES (?,?,?,?,?)',
            (key, float(duration), int(points), peaks, time.time()))


def delete_cached(key):
    conn = connection()
    with conn:
        conn.execute('DELETE FROM waveform_cache WHERE key=?', (key,))


def prune_cache(max_age_days=90):
    """Delete entries older than max_age_days with one indexed DELETE.

    cached_at is written once and never touched on a hit, matching the
    flat era's file-mtime semantics exactly.
    """
    cutoff = time.time() - max_age_days * 86400
    conn = connection()
    with conn:
        cur = conn.execute(
            'DELETE FROM waveform_cache WHERE cached_at < ?', (cutoff,))
    return cur.rowcount or 0


def stats():
    """Return (entry_count, packed_peak_bytes)."""
    return connection().execute(
        'SELECT COUNT(*), COALESCE(SUM(LENGTH(peaks)),0) '
        'FROM waveform_cache').fetchone()


def migrate_flat_cache(legacy_dir=None):
    """Import legacy *.json entries and remove only imported files.

    Returns (imported, skipped). Idempotent: INSERT OR REPLACE by the
    unchanged cache key means a retry cannot duplicate rows.

    Crucially, this is explicit and called before the HTTP server binds.
    A test changing config.WAVEFORM_CACHE_DIR therefore never surprises itself
    by importing/removing the real user cache merely by asking stats().
    """
    legacy = legacy_dir or config.WAVEFORM_CACHE_DIR
    if not os.path.isdir(legacy):
        return 0, 0

    names = [n for n in os.listdir(legacy) if n.endswith('.json')]
    if not names:
        return 0, 0

    rows = []
    good_paths = []
    skipped = 0
    for name in names:
        path = os.path.join(legacy, name)
        key = name[:-5]
        try:
            with open(path, 'r') as f:
                entry = json.load(f)
            peaks = bytes(entry['data'])
            points = int(entry['points'])
            if len(peaks) != points:
                raise ValueError(
                    f'points/data mismatch {points} != {len(peaks)}')
            rows.append((key, float(entry['duration']), points, peaks,
                         os.path.getmtime(path)))
            good_paths.append(path)
        except (OSError, ValueError, KeyError, TypeError) as e:
            skipped += 1
            print(f'[waveform] skipping unimportable cache file {name}: {e}')

    if not rows:
        return 0, skipped

    conn = connection()
    with conn:
        conn.executemany(
            'INSERT OR REPLACE INTO waveform_cache '
            '(key,duration,points,peaks,cached_at) VALUES (?,?,?,?,?)',
            rows)

    # Read-back count before deleting originals. A failed/misrouted DB
    # write leaves every JSON file untouched.
    placeholders = ','.join('?' for _ in rows)
    keys = [row[0] for row in rows]
    committed = conn.execute(
        f'SELECT COUNT(*) FROM waveform_cache WHERE key IN ({placeholders})',
        keys).fetchone()[0]
    if committed != len(rows):
        raise RuntimeError(
            f'waveform migration verification failed: '
            f'{committed}/{len(rows)} rows committed')

    for path in good_paths:
        os.remove(path)
    try:
        # .DS_Store and friends are not cache entries and are never
        # touched by the writer, so the legacy directory may still hold
        # stragglers after all valid and failed imports. Remove only
        # the files the flat cache ever produced.
        for name in os.listdir(legacy):
            path = os.path.join(legacy, name)
            if name.endswith('.json') and os.path.isfile(path):
                os.remove(path)
        os.rmdir(legacy)
    except OSError:
        # Anything foreign (a stray dotfile, an extra directory) stays.
        # Deliberate: never delete files the cache writer did not create.
        pass

    print(f'[waveform] imported {len(rows)} flat cache entries into SQLite'
          + (f' ({skipped} skipped)' if skipped else ''))
    return len(rows), skipped
