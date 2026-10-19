# RoastIn

A web-based music library player that fronts HQPlayer, with waveform seek bars, artist-alias merging, and favorites.

## What it does

- **Library browser** — reads HQPlayer's own library (`~/.hqplayer/library.xml`) and serves it as a fast, searchable album/artist/composer view in the browser. RoastIn does not scan your music folders; whatever HQPlayer has indexed is what you see.
- **HQPlayer control** — play, queue, transport, volume (dB-stepped), and HQPlayer Desktop lifecycle (restart, DirectSDM toggle) via HQPlayer's XML control protocol on its TCP control port (default `4321`).
- **Waveform seek bars** — server-side waveform extraction with ffmpeg + numpy, rendered as playable waveform/bar visuals. Peaks persist in a single SQLite database (`waveforms.sqlite3`), imported once from any legacy flat-file cache. Cached per-track (90-day prune).
- **Artist aliases** — merge artist/composer name variants (`aliases.json`), so "Karl Böhm" and "Karl Boehm" stay one entity.
- **Favorites** — pin albums (`favorites.json`).
- **Keyboard hotkeys** — full keyboard control of playback and navigation.

## Requirements

RoastIn is a front end, not a player. Everything it displays comes from a running
HQPlayer Desktop on the same Mac, and every command goes back to it.

| Requirement | Needed for | Notes |
| --- | --- | --- |
| HQPlayer Desktop, running | everything | The library is HQPlayer's `~/.hqplayer/library.xml`; RoastIn never scans folders itself. |
| Python 3.9+ | everything | Verified on 3.9.6 (import) and 3.14.6 (full run). Use `brew install python@3.14`; macOS's `/usr/bin/python3` is 3.9 and cannot install packages into itself. |
| ffmpeg | waveform seek bars | `brew install ffmpeg`. Without it the app runs and waveforms return 503. |
| numpy | waveform seek bars | Installed by `requirements.txt` into the project venv. |
| Music files, locally readable | playback + waveforms | HQPlayer plays them; ffmpeg decodes them server-side to compute peaks. |
| macOS | everything | Developed and run on macOS. `roastin/platform.py` has Linux/Windows fallbacks for opening files and launching apps, but they are untested. |

Disk: the waveform cache holds roughly 1.2 KB of peaks per track — about 6 MB for
a 4,800-track library — in one SQLite file, pruned after 90 days.

## Installation

One-time setup on a Mac that has never run RoastIn:

```bash
brew install python@3.14 ffmpeg
git clone git@github.com:mokapod/RoastIn.git ~/RoastIn
cd ~/RoastIn
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

Then:

1. **Install HQPlayer Desktop** and let it index your music. RoastIn is useless
   until `~/.hqplayer/library.xml` exists and HQPlayer is running.
2. **Adjust `settings.json`** for this machine — the tracked copy carries the
   author's values, not yours:
   - `server.httpHost` / `httpPort` — bind address and port (default `0.0.0.0:8080`).
   - `server.hqplayerHost` / `hqplayerPort` — where HQPlayer's control port listens (default `127.0.0.1:4321`).
   - `server.homePath` — only if HQPlayer's `.hqplayer` directory is not under your home directory.
   - `server.coverRoots` — extra roots cover art may be served from, e.g. an external volume.
   - `server.hqplayer.appName` — must match the installed HQPlayer (`HQPlayer6Desktop`); `scripts/toggle-directsdm.sh` hardcodes the same name for its AppleScript calls.
   - `server.waveform.ffmpegPath` — only if ffmpeg is not on `PATH`.
   - `server.waveform.cacheDir` — `waveforms.sqlite3` is created in this path's
     **parent** directory, so keep it inside the checkout (`~/RoastIn/waveform_cache`).
3. **Start the server** — first run creates `.api_token` (mode `600`), validates
   `library.xml`, prints directory/track counts, and warns about any missing
   numpy or ffmpeg:

   ```bash
   ./.venv/bin/python server.py
   ```

4. **Open the UI** at `http://localhost:8080/RoastIn/index.html`. For a
   standalone window, Safari → File → Add to Dock; from another device on the
   same network, use `http://<mac-ip>:8080/RoastIn/index.html`.

The venv is not portable between Macs — recreate it with the two commands above
rather than copying `.venv/`. `.api_token` is per-machine and regenerates; the
waveform cache rebuilds as tracks are played.

## Running

```bash
./.venv/bin/python server.py     # or: source .venv/bin/activate && ./server.py
```

`./server.py` on its own runs under whatever `python3` is first on `PATH`, which
is not the venv and has no numpy — waveforms would be unavailable.

- Default bind is `0.0.0.0` — any network device can open the UI.
- Every `/api/*` request needs an `X-API-Token` header. The page is served with
  the token already inlined, so a browser works without extra setup; scripts must
  send it. The token lives in `.api_token` (auto-generated on first start,
  `chmod 600`, git-ignored — treat it like a password). Set `ROASTIN_API_TOKEN`
  in the environment to override it (containers, CI).
- Waveform rendering needs `ffmpeg` (PATH-discoverable) and `numpy` (from
  `.venv`); without them the app runs fine, just without waveforms. Startup
  prints a `⚠️  numpy:` / `⚠️  ffmpeg:` line when either is missing.
- To start at login, wrap the command in a LaunchAgent with `RunAtLoad` and
  `KeepAlive`, `WorkingDirectory` at the checkout, and `ProgramArguments`
  pointing at `.venv/bin/python server.py`.

## Layout

```
server.py          Python backend (stdlib only; numpy optional, for waveforms)
index.html         Single-page frontend shell
css/main.css       Styling
js/                Frontend modules (ES modules, no framework)
images/            Format/logo icons
d-din-fonts/       D-DIN font files
requirements.txt   Pip dependencies (numpy; ffmpeg is a system binary)
.venv/             Project-local Python venv (created once; not tracked)
scripts/           HQPlayer helper scripts + library maintenance utilities
aliases.json       Artist/composer alias map (editable, served read-write)
favorites.json     Pinned album IDs
settings.json      Frontend + server configuration
waveforms.sqlite3  Waveform peak cache (SQLite; created on first run,
                   legacy waveform_cache/ entries imported automatically)
```

## Diagnostics

- `ROASTIN_TIMING=1` logs every timed phase; without it, only phases exceeding their per-phase slow threshold print (`⚠️  SLOW`).
- Startup validates `library.xml` and prints directory/track counts. On a malformed file (HQPlayer has been observed to write truncated UTF-8), the log names the byte offset and points at `scripts/repair-library.sh`.

## Troubleshooting

- **Every `/api/*` returns 401** — the page is holding a stale token (`.api_token` was deleted or regenerated). Hard-reload the tab.
- **`⚠️  numpy: No module named 'numpy'`** — the server was started with the wrong interpreter. Use `./.venv/bin/python server.py`.
- **`⚠️  ffmpeg: …`** — install it (`brew install ffmpeg`) or set `server.waveform.ffmpegPath`.
- **Empty library** — HQPlayer is not running, has no `library.xml`, or `server.homePath` points somewhere else. Startup prints the track count it found.
- **Transport does nothing** — HQPlayer's control port is unreachable; check `server.hqplayerHost`/`hqplayerPort` and that HQPlayer Desktop is actually open.
- **Waveform 403** — the track sits outside the allowed roots; add its volume to `server.coverRoots`.
- **Address already in use** — an older instance still holds the port: `lsof -tiTCP:8080 -sTCP:LISTEN`.

## Configuration

All settings live in `settings.json`:

- `frontend` — read by the browser, injected as `window.CONFIG`: sort order, search debounce, notification duration, waveform style/colors, volume range and step.
- `server` — read by the Python backend only, never sent to the browser: bind host/port, HQPlayer host/port and control port, `homePath` (where HQPlayer's `.hqplayer/library.xml` lives), `coverRoots` (extra roots art may be served from, e.g. an external volume), ffmpeg path, waveform cache dir and resolution.

## Notes

- No third-party frontend dependencies — plain ES modules, served as-is.
- Python backend uses only the standard library plus optional numpy.
- `waveforms.sqlite3` (and its `-wal`/`-shm` companions) is regenerable output, not source.
