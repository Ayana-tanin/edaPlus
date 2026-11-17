import { escapeHtml as esc } from '../util.js';

const MAX_ATTEMPTS = 5;
const FAVORITE_NOTIFY_COOLDOWN = '-6 hours';

export function queueNotification(db, userId, kind, text, buttonPath = null) {
  db.prepare('INSERT INTO notifications (user_id, kind, text, button_path) VALUES (?, ?, ?, ?)').run(
    userId,
    kind,
    text,
    buttonPath,
  );
}

/** Отправляет накопленную очередь. send(telegramId, text, buttonPath) бросает ошибку при сбое. */
export async function flushNotifications(db, send, limit = 25) {
  const pending = db
    .prepare('SELECT * FROM notifications WHERE sent_at IS NULL AND attempts < ? ORDER BY id LIMIT ?')
    .all(MAX_ATTEMPTS, limit);
  for (const n of pending) {
    try {
      await send(n.user_id, n.text, n.button_path);
      db.prepare("UPDATE notifications SET sent_at = datetime('now'), attempts = attempts + 1 WHERE id = ?").run(n.id);
    } catch (err) {
      // 403 и 400: бот заблокирован или человек его ещё не запускал. Повторять бессмысленно.
      const attempts = [400, 403].includes(err?.error_code) ? MAX_ATTEMPTS : n.attempts + 1;
      db.prepare('UPDATE notifications SET attempts = ? WHERE id = ?').run(attempts, n.id);
      console.error(`[notify] #${n.id} не отправлено: ${err?.message ?? err}`);
    }
  }
}

/** Сообщает добавившим в избранное, что предложение снова можно забронировать. */
export function notifyFavoritesAvailable(db, offer) {
  const users = db
    .prepare(
      `SELECT user_id FROM favorites
       WHERE offer_id = ? AND (last_notified_at IS NULL OR last_notified_at < datetime('now', ?))`,
    )
    .all(offer.id, FAVORITE_NOTIFY_COOLDOWN);
  for (const { user_id } of users) {
    queueNotification(
      db,
      user_id,
      'favorite_available',
      `💚 Снова в наличии: <b>${esc(offer.name)}</b>`,
      `/offers/${offer.id}`,
    );
  }
  db.prepare("UPDATE favorites SET last_notified_at = datetime('now') WHERE offer_id = ?").run(offer.id);
}
