// hotkeys.js
// Depends on: state, dom, utils, transport, volume, search

/* ═══════════════════════════════════════════════════════════════════
   16. GLOBAL HOTKEYS
   ═══════════════════════════════════════════════════════════════════ */

// Consolidated helper for the two search-focus entry points (F with no
// modifiers, Ctrl/Cmd+F).
function focusSearchInput() {
  if (!searchContainer.classList.contains('expanded')) {
    searchContainer.classList.add('expanded');
    setTimeout(() => searchInput.focus(), 300);
  } else {
    searchInput.focus();
    searchInput.select();
  }
}

document.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const isTyping = el && (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable
  );
  if (isTyping) return;
  
  // A more specific handler (a card, a track row, a More-by card) has
  // already acted on this key and called preventDefault(). Do not
  // double-fire.
  if (e.defaultPrevented) return;

  // The F7–F12 transport hotkeys require Shift+Ctrl+Alt+Cmd to avoid
  // colliding with the browser's own F-key bindings (F5 reload, F11
  // fullscreen, F12 DevTools) and with OS media keys. On macOS, F-keys
  // also need the system setting "Use F1, F2, etc. as standard function
  // keys" enabled, or held with the Fn modifier.
  const hasAllMods = e.shiftKey && e.ctrlKey && e.altKey && e.metaKey;
  const noMods     = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  const ctrlOnly   = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;

  if (hasAllMods) {
    switch (e.key) {
      case 'F7':  e.preventDefault(); if (currentPlayback.album) sendCommand('prev'); return;
      case 'F8':  e.preventDefault(); if (currentPlayback.album) togglePlayPause(); return;
      case 'F9':  e.preventDefault(); if (currentPlayback.album) sendCommand('next'); return;
      case 'F10': e.preventDefault(); toggleMute(); return;
      case 'F11': e.preventDefault(); adjustVolume(-1); return;
      case 'F12': e.preventDefault(); adjustVolume(+1); return;
    }
    return;
  }

  if (noMods) {
    if (e.key === ' ') {
      // Space activates the focused control. Real <button> elements
      // fire a synthesized click on Space; role="button" elements
      // are handled by their own keydown listeners above. Only
      // treat Space as play/pause when nothing more specific owns
      // the keystroke.
      if (el && el.closest('button, [role="button"], a[href], input, select, textarea')) {
        return;
      }

      if (currentPlayback.album) {
        // Something is loaded. Space toggles play/pause, matching
        // the main transport control.
        e.preventDefault();
        togglePlayPause();
      } else if (isDetailView && currentDetailAlbumIndex !== -1) {
        // Nothing loaded yet, but the detail view is showing an
        // album. Space plays the displayed album from the top —
        // the same action as clicking the large play button in the
        // action row.
        e.preventDefault();
        playTrackInHQPlayer(currentDetailAlbumIndex, 0);
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'a': {
        if (!currentPlayback.album) return;
        e.preventDefault();
        const idx = findOrRevealAlbum(currentPlayback.album.folder);
        if (idx !== -1) {
          detailFocusOnOpen = true;
          showAlbumDetail(idx);
        }
        return;
      }

      case 'h':
        if (!isDetailView) return;
        e.preventDefault();
        pushHistoryEntry({ view: 'grid' });
        showGridView();
        return;

      case 'f':
        e.preventDefault();
        focusSearchInput();
        return;

      case 'w':
        e.preventDefault();
        WAVEFORM_CONFIG.style = WAVEFORM_CONFIG.style === 'bars' ? 'waveform' : 'bars';
        localStorage.setItem('hqp.waveformStyle', WAVEFORM_CONFIG.style);
        paintWaveform(true);
        showNotification(`Waveform: ${WAVEFORM_CONFIG.style}`);
        return;
      case 'q':
				e.preventDefault();
				if (isQueueView) hideQueueView();
				else            showQueueView();
				return;
    }
    return;
  }

  if (ctrlOnly && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    focusSearchInput();
    return;
  }
});