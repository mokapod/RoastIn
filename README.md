# RoastIn

A web-based music library player that fronts HQPlayer, with waveform seek bars, artist-alias merging, and favorites.

## What it does

- **Library browser** — reads HQPlayer's own library (`~/.hqplayer/library.xml`) and serves it as a fast, searchable album/artist/composer view in the browser. RoastIn does not scan your music folders; whatever HQPlayer has indexed is what you see.
- **HQPlayer control** — play, queue, transport, volume (dB-stepped), and HQPlayer Desktop lifecycle (restart, DirectSDM toggle) via HQPlayer's XML control protocol on its TCP control port (default `4321`).
- **Waveform seek bars** — server-side waveform extraction with ffmpeg + numpy, rendered as playable waveform/bar visuals. Peaks persist in a single SQLite database (`waveforms.sqlite3`), imported once from any legacy flat-file cache. Cached per-track (90-day prune).
- **Artist aliases** — merge artist/composer name variants (`aliases.json`), so "Karl Böhm" and "Karl Boehm" stay one entity.
- **Favorites** — pin albums (`favorites.json`).
- **Keyboard hotkeys** — full keyboard control of playback and navigation.

## Layout

```
server.py          Python backend (stdlib only; numpy optional, for waveforms)
index.html         Single-page frontend shell
css/main.css       Styling
js/                Frontend modules (ES modules, no framework)
images/            Format/logo icons
d-din-fonts/       D-DIN font files
scripts/           HQPlayer helper scripts + library maintenance utilities
aliases.json       Artist/composer alias map (editable, served read-write)
favorites.json     Pinned album IDs
settings.json      Frontend + server configuration
waveforms.sqlite3  Waveform peak cache (SQLite; created on first run,
                   legacy waveform_cache/ entries imported automatically)
```

## Running

```bash
./server.py            # or: python3 server.py
```

Then open `http://localhost:8080`. Edit `settings.json` to point `httpHost`/`httpPort` at what you want, and set `homePath` if HQPlayer's `.hqplayer` directory is not under your home directory.

Requires a running HQPlayer Desktop instance, since the library and all playback state come from it.

- Default bind is `0.0.0.0` — any network device can open the UI.
- When not on localhost, every API request needs an `X-API-Token` header. The token lives in `.api_token` (auto-generated on first start, `chmod 600`, git-ignored — treat it like a password).
- Waveform rendering needs `ffmpeg` (PATH-discoverable) and `numpy`; without them the app runs fine, just without waveforms.

## Diagnostics

- `ROASTIN_TIMING=1` logs every timed phase; without it, only phases exceeding their per-phase slow threshold print (`⚠️  SLOW`).
- Startup validates `library.xml` and prints directory/track counts. On a malformed file (HQPlayer has been observed to write truncated UTF-8), the log names the byte offset and points at `scripts/repair-library.sh`.

## Configuration

All settings live in `settings.json`:

- `frontend` — read by the browser, injected as `window.CONFIG`: sort order, search debounce, notification duration, waveform style/colors, volume range and step.
- `server` — read by the Python backend only, never sent to the browser: bind host/port, HQPlayer host/port and control port, `homePath` (where HQPlayer's `.hqplayer/library.xml` lives), `coverRoots` (extra roots art may be served from, e.g. an external volume), ffmpeg path, waveform cache dir and resolution.

## Notes

- No third-party frontend dependencies — plain ES modules, served as-is.
- Python backend uses only the standard library plus optional numpy.
- `waveforms.sqlite3` (and its `-wal`/`-shm` companions) is regenerable output, not source.
