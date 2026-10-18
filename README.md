# RoastIn

A web-based music library player that fronts HQPlayer, with waveform seek bars, artist-alias merging, and favorites.

## What it does

- **Library browser** — scans a local FLAC/WAV/AIFF/ALAC/DSD music root and serves a fast, searchable album/artist/composer view in the browser.
- **HQPlayer control** — play, queue, transport, volume (dB-stepped), and HQPlayer Desktop lifecycle (restart, DirectSDM toggle) via HQPlayer's local XML-RPC API.
- **Waveform seek bars** — server-side waveform extraction with ffmpeg + numpy, rendered as playable waveform/bar visuals. Cached per-track in `waveform_cache/` (90-day auto-prune).
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
```

## Running

```bash
./server.py            # or: python3 server.py
```

Then open `http://localhost:8080`. Edit `settings.json` to point `httpHost`/`httpPort` at what you want, and set your music library root.

- Default bind is `0.0.0.0` — any network device can open the UI.
- When not on localhost, every API request needs an `X-API-Token` header. The token lives in `.api_token` (auto-generated on first start, `chmod 600`, git-ignored — treat it like a password).
- Waveform rendering needs `ffmpeg` (PATH-discoverable) and `numpy`; without them the app runs fine, just without waveforms.

## Configuration

All settings live in `settings.json`:

- `frontend` — read by the browser, injected as `window.CONFIG`: polling interval, sort order, waveform style/colors, volume range and step.
- `server` — read by the Python backend only, never sent to the browser: bind host/port, HQPlayer host/port, ffmpeg path, waveform cache dir and resolution.

## Notes

- No third-party frontend dependencies — plain ES modules, served as-is.
- Python backend uses only the standard library plus optional numpy.
- `waveform_cache/` is regenerable output, not source.
