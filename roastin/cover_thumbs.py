"""Cover thumbnails: downscaled cover art cached in one SQLite database.

Cover files are stored at scan resolution — 1400px and 1-2 MB is typical —
while the album grid draws them into ~211px tiles. Serving the originals
means a single pass through the grid pulls ~200 MB and stalls paint while
the browser decodes each one, which reads as black or ghosted tiles.

Thumbnails cut both costs by roughly an order of magnitude. Generation
uses macOS `sips`, present on every system this app runs on; Pillow is not
a dependency and adding one for a resize would be a poor trade.

Keys cover the source's realpath, mtime and size, so an edited cover
produces a new row instead of a stale thumbnail. Rows are pruned by age
and by total size on the same contract the waveform cache uses.

The connection is per-thread (`threading.local`), not shared — the same
reasoning as waveform_cache: WAL plus per-thread connections lets request
threads read hits while another thread commits a freshly generated thumb.
"""
import hashlib
import os
import sqlite3
import subprocess
import tempfile
import threading
import time

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS cover_thumbs (
  key       TEXT PRIMARY KEY,
  width     INTEGER NOT NULL,
  data      BLOB NOT NULL,
  bytes     INTEGER NOT NULL,
  cached_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cover_thumbs_cached_at
  ON cover_thumbs (cached_at);
"""

# A thumbnail outside this range is not a thumbnail. Requests outside it
# are treated as a miss and answered with the original file, so a stray
# ?w= cannot make the server spend seconds on a 4000px render.
MIN_WIDTH = 64
MAX_WIDTH = 2048

# Roughly a 1500x1500 source at quality 82 lands well under this; the cap
# exists so a pathological cover cannot bloat one row.
MAX_THUMB_BYTES = 2 * 1024 * 1024

SIPS_TIMEOUT_SECONDS = 20

_local = threading.local()


def _conn():
    conn = getattr(_local, 'conn', None)
    if conn is None:
        conn = sqlite3.connect(config.COVER_CACHE_PATH, timeout=5.0)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA synchronous=NORMAL')
        conn.executescript(SCHEMA)
        _local.conn = conn
    return conn


def key_for(path, width):
    """Cache key for one source file at one width.

    mtime_ns and size make a replaced cover miss rather than serve the
    previous album's art.
    """
    try:
        st = os.stat(path)
        stamp = f'{st.st_mtime_ns}:{st.st_size}'
    except OSError:
        stamp = '0:0'
    raw = f'{os.path.realpath(path)}\0{stamp}\0{int(width)}'
    return hashlib.sha1(raw.encode('utf-8', 'surrogateescape')).hexdigest()


def get(key):
    """Cached JPEG bytes, or None."""
    try:
        row = _conn().execute(
            'SELECT data FROM cover_thumbs WHERE key = ?', (key,)
        ).fetchone()
    except sqlite3.Error:
        return None
    return row[0] if row else None


def put(key, width, data):
    if not data or len(data) > MAX_THUMB_BYTES:
        return
    try:
        _conn().execute(
            'INSERT OR REPLACE INTO cover_thumbs'
            ' (key, width, data, bytes, cached_at) VALUES (?, ?, ?, ?, ?)',
            (key, int(width), data, len(data), time.time()),
        )
        _conn().commit()
    except sqlite3.Error:
        pass


def generate(source_path, width):
    """Render a JPEG thumbnail with sips. Returns bytes, or None.

    Two passes, deliberately: sips preserves the source colour space, and
    scanned covers are often CMYK — a 400px CMYK JPEG comes out at ~680 KB
    because it carries four channels with no subsampling. Resampling to
    PNG first lands the pixels in RGB, and the PNG → JPEG pass then
    compresses to ~45 KB. Doing it in one pass with `-s space RGB` fails
    silently on these files.

    sips writes to a file, so both renders go through temp files that are
    unlinked immediately. -Z scales the long edge and preserves the aspect
    ratio.
    """
    png_tmp = None
    jpg_tmp = None
    try:
        png_fd, png_tmp = tempfile.mkstemp(prefix='roastin-thumb-',
                                           suffix='.png')
        os.close(png_fd)
        first = subprocess.run(
            ['sips', '-Z', str(int(width)), '-s', 'format', 'png',
             '--out', png_tmp, source_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=SIPS_TIMEOUT_SECONDS,
        )
        if first.returncode != 0:
            return None

        jpg_fd, jpg_tmp = tempfile.mkstemp(prefix='roastin-thumb-',
                                           suffix='.jpg')
        os.close(jpg_fd)
        second = subprocess.run(
            ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '75',
             '--out', jpg_tmp, png_tmp],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=SIPS_TIMEOUT_SECONDS,
        )
        if second.returncode != 0:
            return None

        with open(jpg_tmp, 'rb') as f:
            data = f.read()
        if not data or len(data) > MAX_THUMB_BYTES:
            return None
        return data
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        for tmp in (png_tmp, jpg_tmp):
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass


def for_source(source_path, width):
    """Thumbnail bytes for a source file, generating on first use.

    Returns None when the width is out of range or the render failed; the
    caller then falls back to serving the original file.
    """
    width = int(width)
    if width < MIN_WIDTH or width > MAX_WIDTH:
        return None

    key = key_for(source_path, width)
    cached = get(key)
    if cached is not None:
        return cached

    data = generate(source_path, width)
    if data is not None:
        put(key, width, data)
    return data


def prune(max_age_days=120, max_total_bytes=512 * 1024 * 1024):
    """Drop rows older than max_age_days, then the oldest until the cache
    fits max_total_bytes. Returns (expired, evicted) counts."""
    cutoff = time.time() - max_age_days * 86400
    expired = evicted = 0
    try:
        conn = _conn()
        cur = conn.execute('DELETE FROM cover_thumbs WHERE cached_at < ?',
                           (cutoff,))
        expired = cur.rowcount or 0

        total = conn.execute(
            'SELECT COALESCE(SUM(bytes), 0) FROM cover_thumbs'
        ).fetchone()[0]
        while total > max_total_bytes:
            row = conn.execute(
                'SELECT key, bytes FROM cover_thumbs'
                ' ORDER BY cached_at ASC LIMIT 1'
            ).fetchone()
            if row is None:
                break
            conn.execute('DELETE FROM cover_thumbs WHERE key = ?', (row[0],))
            total -= row[1]
            evicted += 1
        conn.commit()
    except sqlite3.Error:
        pass
    return expired, evicted


def stats():
    try:
        row = _conn().execute(
            'SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM cover_thumbs'
        ).fetchone()
    except sqlite3.Error:
        return {'entries': 0, 'bytes': 0}
    return {'entries': row[0], 'bytes': row[1]}
