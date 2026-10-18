// restore.js
// Depends on: config, state, dom, utils, library, views, transport, waveform

/* ═══════════════════════════════════════════════════════════════════
   13. SERVER STATE RESTORE
   ═══════════════════════════════════════════════════════════════════ */

/* Normalize a file URI or filesystem path for comparison. HQPlayer
   may report the same file as `file:///Users/...`, `file://localhost/Users/...`,
   or `/Users/...`, with or without percent-encoding. The library's
   path + name attributes use raw, unencoded paths. This reduces all
   of them to a canonical form. */
function normalizeFileUri(uri) {
  if (!uri) return '';
  let s = uri;
  try { s = decodeURIComponent(s); } catch (e) { /* leave as-is */ }
  // Strip scheme and any host portion: file:/// → file://localhost/ → file://
  s = s.replace(/^file:\/\/([^/]*)/, '');
  // Collapse any duplicate slashes introduced by the strip or present
  // in the original.
  s = s.replace(/\/+/g, '/');
  return s;
}

function restorePlaybackFromServer(data) {
  if (currentPlayback.album) return;

  // The server sets transport_loaded: false whenever it returns
  // cached metadata rather than a live Status from HQPlayer. That
  // happens after a queue clear or a stop, and during a brief gap
  // when HQPlayer has no current track. Restoring from the cache in
  // that state would re-populate the playback bar with a track that
  // isn't loaded, undoing the clear.
  if (data.transport_loaded === false) return;

  if (!data.album && !data.song) return;
  if (data.state === 'stopped' && !data.song) return;

  const serverAlbum      = (data.album || '').trim();
  const serverArtistRaw  = (data.artist || data.albumartist || '').trim();
  const serverSong       = (data.song || '').trim();

  const serverAlbumLower  = serverAlbum.toLowerCase();
  const serverArtistCanon = canonicalArtist(serverArtistRaw);
  const serverSongLower   = serverSong.toLowerCase();

  if (!serverAlbum && !serverSong) return;

  let matchedAlbum = null;
  let globalIndex = -1;

  // ── Queue-mode resolution ──
  //
  // In queue mode, data.track is the position in the queue, not an
  // album track index. lastKnownQueue holds the exact entries the
  // queue view rendered, so indexing into it gives us the queue entry
  // for the currently-playing track — including its URI and its
  // HQPlayer-reported title. Both are used to locate the corresponding
  // album track without relying on the string-matching passes below,
  // which break down when HQPlayer's reported metadata differs in
  // whitespace or punctuation from the library's stored tags.
  //
  // Runs first so it short-circuits the fallback: if we know the
  // queue position and have the queue cached, the URI is authoritative
  // and the passes are unnecessary.
  if (playbackMode === 'queue'
      && data.track
      && lastKnownQueue.length > 0
      && data.track >= 1
      && data.track <= lastKnownQueue.length) {
    const entry = lastKnownQueue[data.track - 1];

    if (entry) {
      const entryAlbum = entry.uri ? findAlbumByUri(entry.uri) : null;

      if (entryAlbum) {
        const targetUri = normalizeFileUri(entry.uri);

        // Match by full path (path + '/' + name) against the entry's
        // URI. This is the most specific match and succeeds when
        // HQPlayer and the library agree on the file path.
        for (let idx = 0; idx < entryAlbum.tracks.length; idx++) {
          const t = entryAlbum.tracks[idx].node;
          const path = t.parentNode.getAttribute('path') || '';
          const name = t.getAttribute('name') || '';
          const candidate = normalizeFileUri(`${path}/${name}`);
          if (candidate === targetUri) {
            matchedAlbum = entryAlbum;
            globalIndex = idx;
            break;
          }
        }

        // Fall back to matching by title within the identified album.
        // The queue entry's song field came from HQPlayer's own
        // PlaylistItem — the same source the queue view renders — so
        // it matches the library's tags more reliably than the
        // /api/status metadata does.
        if (globalIndex === -1 && entry.song) {
          const entrySongLower = entry.song.toLowerCase();
          for (let idx = 0; idx < entryAlbum.tracks.length; idx++) {
            const t = entryAlbum.tracks[idx].node;
            const s = (t.getAttribute('song') || t.getAttribute('name') || '').toLowerCase();
            if (s === entrySongLower) {
              matchedAlbum = entryAlbum;
              globalIndex = idx;
              break;
            }
          }
        }
      }
    }
  }

  // Pass 1 — exact track match. Runs only if the queue lookup above
  // didn't already resolve, since that lookup is authoritative.
  if (!matchedAlbum && serverSong) {
    for (const a of masterAlbums) {
      if (serverAlbum && a.baseName.toLowerCase() !== serverAlbumLower) continue;

      for (let idx = 0; idx < a.tracks.length; idx++) {
        const t = a.tracks[idx].node;
        const s = (t.getAttribute('song') || t.getAttribute('name') || '').toLowerCase();
        if (s === serverSongLower) {
          matchedAlbum = a;
          globalIndex = idx;
          break;
        }
      }
      if (matchedAlbum) break;
    }
  }

  // Pass 2 — album name plus artist. Only reachable when pass 1 didn't
  // resolve, and only meaningful when an album name was reported.
  if (!matchedAlbum && serverAlbum) {
    for (const a of masterAlbums) {
      if (a.baseName.toLowerCase() !== serverAlbumLower) continue;
      if (!serverArtistRaw || canonicalArtist(a.artist) === serverArtistCanon) {
        matchedAlbum = a;
        break;
      }
    }
  }

  // Pass 3 — album name only, ignoring artist. Recovers from a bad
  // artist tag while the album name is still usable.
  if (!matchedAlbum && serverAlbum) {
    for (const a of masterAlbums) {
      if (a.baseName.toLowerCase() === serverAlbumLower) {
        matchedAlbum = a;
        break;
      }
    }
  }

  if (!matchedAlbum) return;

  // Resolve the track index if none of the above produced one.
  //
  // NOTE: this fallback uses data.track as an album track index. That
  // is correct in album mode (where SetTransportPath means position
  // equals album index) but wrong in queue mode (where data.track is
  // a queue position). Queue mode should always resolve above; if it
  // doesn't, the fallback may pick the wrong track. The clamp keeps it
  // from running off the end of the album's track list.
  if (globalIndex === -1) {
    if (data.track) {
      globalIndex = Math.max(0, Math.min(data.track - 1, matchedAlbum.tracks.length - 1));
    } else {
      globalIndex = 0;
    }
  }

  const foundTrack = getTrackByIndex(matchedAlbum, globalIndex);

  currentPlayback.album = matchedAlbum;
  currentPlayback.trackIndex = globalIndex;
  currentPlayback.isPlaying = (data.state === 'playing');
  currentPlayback.duration = data.length
    || parseInt(foundTrack?.getAttribute('length'), 10)
    || 0;
  currentPlayback.offset = data.position || 0;
  currentPlayback.startTime = Date.now();

  loadTrackIntoUI(globalIndex, true);
  updatePlaybackUI();
  updatePlayingTrackHighlight();

  // Progress slider and current time. Total time was already set by
  // loadTrackIntoUI from currentPlayback.duration — via the same
  // split-span setter used below, so both displays stay in sync.
  if (data.length > 0) {
    $progress.value = (data.position / data.length) * 100;
    setTimeDisplay($pbTimeCurMin, $pbTimeCurSec, data.position);
    anchorPosition(data.position, data.length);
  }

  if (foundTrack) {
    const dir = foundTrack.parentNode.getAttribute('path');
    const name = foundTrack.getAttribute('name');
    loadWaveform(`${dir}/${name}`);
  }
}