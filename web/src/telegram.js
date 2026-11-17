export const tg = window.Telegram?.WebApp ?? null;

export function initTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
}

export function haptic(type = 'light') {
  try {
    if (type === 'success' || type === 'error') tg?.HapticFeedback?.notificationOccurred(type);
    else tg?.HapticFeedback?.impactOccurred(type);
  } catch {
    // Старые клиенты Telegram не поддерживают вибрацию.
  }
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    if (tg?.initData && tg.isVersionAtLeast?.('6.2')) tg.showConfirm(message, resolve);
    else resolve(window.confirm(message));
  });
}
