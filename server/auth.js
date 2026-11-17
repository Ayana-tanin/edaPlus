import crypto from 'node:crypto';
import { AppError, forbidden, notFound } from './util.js';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * Проверка подписи Telegram initData:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Возвращает объект пользователя Telegram или null.
 */
export function verifyInitData(initData, botToken, maxAgeSec, nowSec = Math.floor(Date.now() / 1000)) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const expected = hmac(hmac('WebAppData', botToken), dataCheckString);
  const received = Buffer.from(hash, 'hex');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get('user'));
    return Number.isSafeInteger(user?.id) ? user : null;
  } catch {
    return null;
  }
}

export function upsertUser(db, tg) {
  db.prepare(
    `INSERT INTO users (telegram_id, first_name, last_name, username, last_seen_at)
     VALUES (@id, @first_name, @last_name, @username, datetime('now'))
     ON CONFLICT (telegram_id) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       username = excluded.username,
       last_seen_at = excluded.last_seen_at`,
  ).run({
    id: tg.id,
    first_name: tg.first_name ?? null,
    last_name: tg.last_name ?? null,
    username: tg.username ?? null,
  });
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tg.id);
}

export function authenticate(db, config) {
  return (req, _res, next) => {
    let tg = null;
    const header = req.get('authorization') || '';
    if (header.startsWith('tma ')) {
      tg = verifyInitData(header.slice(4), config.botToken, config.initDataMaxAgeSec);
    } else if (config.devAuth && req.get('x-dev-user')) {
      const id = Number(req.get('x-dev-user'));
      if (Number.isSafeInteger(id) && id > 0) tg = { id, first_name: `Тест ${id}` };
    }
    if (!tg) throw new AppError(401, 'unauthorized', 'Откройте приложение через Telegram-бота eda+');
    req.user = upsertUser(db, tg);
    req.isAdmin = config.adminIds.has(tg.id);
    next();
  };
}

export function requireAdmin(req, _res, next) {
  if (!req.isAdmin) throw forbidden();
  next();
}

/** Главный админ управляет любым заведением, админ кафе только своими. */
export function assertVenueAccess(db, req, venueId) {
  if (req.isAdmin) {
    if (!db.prepare('SELECT 1 FROM venues WHERE id = ?').get(venueId)) throw notFound('Заведение не найдено');
    return;
  }
  const row = db.prepare('SELECT 1 FROM venue_partners WHERE venue_id = ? AND user_id = ?').get(venueId, req.user.telegram_id);
  if (!row) throw forbidden('Нет доступа к этому заведению');
}
