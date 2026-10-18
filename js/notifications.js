// notifications.js
// Depends on: config, utils

function showNotification(message, isError = false) {
  document.querySelectorAll('.notification').forEach(n => n.remove());

  const notification = document.createElement('div');
  notification.className = 'notification';
  if (isError) notification.classList.add('is-error');

  notification.setAttribute('role', 'status');
  notification.setAttribute('aria-live', 'polite');
  notification.innerHTML = `
    <div class="notification-signature" aria-hidden="true">${esc(WATERMARK)}</div>
    <div class="notification-message">${esc(message)}</div>
  `;

  notification.style.visibility = 'hidden';
  notification.style.animation  = 'none';
  document.body.appendChild(notification);

  notification.style.visibility = 'visible';
  notification.style.animation  = '';

  setTimeout(() => {
    notification.style.animation =
      'riseFromBar 1.2s cubic-bezier(0.16, 1, 0.3, 1) reverse';
    setTimeout(() => notification.remove(), 1200);
  }, NOTIFICATION_DURATION_MS);
}