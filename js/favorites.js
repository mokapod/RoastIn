// favorites.js
// Depends on: config, state, dom, notifications

async function handleFavoriteClick(e) {
  const btn = e.target.closest('.album-detail-fav');
  if (!btn) return;

  const hash = btn.dataset.albumHash;
  if (!hash) return;

  // Ignore clicks while a previous request for this button is still in
  // flight. Prevents two concurrent favorite-set POSTs from resolving
  // out of order and leaving the server disagreeing with the UI.
  if (btn.dataset.updating === 'true') return;
  btn.dataset.updating = 'true';

  const currentlyOn = btn.getAttribute('aria-pressed') === 'true';
  const next = !currentlyOn;

  // Optimistic UI
  btn.setAttribute('aria-pressed', next ? 'true' : 'false');
  if (next) favorites.add(hash);
  else      favorites.delete(hash);

  try {
    const res = await fetch(`${API_BASE}/favorite-set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash, value: next })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Roll back to the pre-click state.
    if (next) favorites.delete(hash);
    else      favorites.add(hash);
    btn.setAttribute('aria-pressed', currentlyOn ? 'true' : 'false');
    showNotification('Failed to update favorite', true);
  } finally {
    // Release the lock whether the request succeeded or failed.
    delete btn.dataset.updating;
  }
}

$detailContent.addEventListener('click', handleFavoriteClick);