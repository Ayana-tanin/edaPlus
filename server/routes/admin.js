import { Router } from 'express';
import { z } from 'zod';
import { likePattern } from '../db.js';
import { OFFER_SELECT, getOfferRow, serializeOffer, withAvailabilityWatch } from '../services/offers.js';
import { queueNotification } from '../services/notifications.js';
import { STATUSES, changeOrderStatus, getOrderHistory, getOrderRow, serializeOrder } from '../services/orders.js';
import { AppError, escapeHtml, idParam, localNow, notFound, parse } from '../util.js';

const optionalCoord = (min, max) => z.number().min(min).max(max).nullable().optional();

const venueSchema = z.object({
  name: z.string().trim().min(1, 'Укажите название').max(120),
  city: z.string().trim().min(1, 'Укажите город').max(80),
  address: z.string().trim().min(1, 'Укажите адрес').max(200),
  phone: z.string().trim().max(40).nullable().optional(),
  lat: optionalCoord(-90, 90),
  lng: optionalCoord(-180, 180),
  isActive: z.boolean().optional(),
});

const serializeVenue = (db, v) => ({
  id: v.id,
  name: v.name,
  city: v.city,
  address: v.address,
  phone: v.phone,
  lat: v.lat,
  lng: v.lng,
  isActive: !!v.is_active,
  partners: db
    .prepare(
      `SELECT u.telegram_id AS id, u.first_name AS firstName, u.username
       FROM venue_partners p JOIN users u ON u.telegram_id = p.user_id WHERE p.venue_id = ?`,
    )
    .all(v.id),
});

export function adminRoutes(db, config) {
  const r = Router();
  const now = () => localNow(config.timezone);

  function getVenue(id) {
    const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(id);
    if (!venue) throw notFound('Заведение не найдено');
    return venue;
  }

  r.get('/venues', (_req, res) => {
    res.json(db.prepare('SELECT * FROM venues ORDER BY name').all().map((v) => serializeVenue(db, v)));
  });

  r.post('/venues', (req, res) => {
    const d = parse(venueSchema, req.body);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO venues (name, city, address, phone, lat, lng, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(d.name, d.city, d.address, d.phone ?? null, d.lat ?? null, d.lng ?? null, d.isActive === false ? 0 : 1);
    res.status(201).json(serializeVenue(db, getVenue(lastInsertRowid)));
  });

  r.patch('/venues/:id', (req, res) => {
    const venue = getVenue(parse(idParam, req.params.id));
    const d = parse(venueSchema.partial(), req.body);
    db.prepare('UPDATE venues SET name = ?, city = ?, address = ?, phone = ?, lat = ?, lng = ?, is_active = ? WHERE id = ?').run(
      d.name ?? venue.name,
      d.city ?? venue.city,
      d.address ?? venue.address,
      d.phone === undefined ? venue.phone : d.phone,
      d.lat === undefined ? venue.lat : d.lat,
      d.lng === undefined ? venue.lng : d.lng,
      d.isActive === undefined ? venue.is_active : d.isActive ? 1 : 0,
      venue.id,
    );
    res.json(serializeVenue(db, getVenue(venue.id)));
  });

  /** Партнёр указывается числовым Telegram ID или @username уже знакомого боту пользователя. */
  function resolveUser(identifier) {
    const value = identifier.trim();
    if (/^\d+$/.test(value)) {
      const id = Number(value);
      if (!Number.isSafeInteger(id)) throw new AppError(400, 'validation', 'Некорректный Telegram ID');
      db.prepare('INSERT OR IGNORE INTO users (telegram_id) VALUES (?)').run(id);
      return id;
    }
    const username = value.replace(/^@/, '').toLowerCase();
    const user = db.prepare('SELECT telegram_id FROM users WHERE ru_lower(username) = ?').get(username);
    if (!user) {
      throw new AppError(404, 'user_unknown', 'Этот @username ещё не запускал бота. Попросите нажать /start или укажите Telegram ID.');
    }
    return user.telegram_id;
  }

  r.post('/venues/:id/partners', (req, res) => {
    const venue = getVenue(parse(idParam, req.params.id));
    const { user } = parse(z.object({ user: z.string().min(1, 'Укажите Telegram ID или @username').max(64) }), req.body);
    const userId = resolveUser(user);
    const notice = db.transaction(() => {
      const { changes } = db.prepare('INSERT OR IGNORE INTO venue_partners (venue_id, user_id) VALUES (?, ?)').run(venue.id, userId);
      if (!changes) return 'Этот человек уже админ этого кафе.';
      if (config.adminIds.has(userId)) {
        return 'Добавлено, но это главный админ: доступ ко всем кафе уже есть, поэтому ничего не изменится.';
      }
      queueNotification(
        db,
        userId,
        'cafe_admin_added',
        `🏪 Вам выдан доступ администратора кафе: <b>${escapeHtml(venue.name)}</b>`,
        '/partner',
      );
      const { last_seen_at: lastSeen } = db.prepare('SELECT last_seen_at FROM users WHERE telegram_id = ?').get(userId);
      return lastSeen
        ? 'Админ добавлен и получит сообщение в боте.'
        : 'Админ добавлен, но ещё не запускал бота. Попросите открыть бота и нажать /start: появится кнопка «Кабинет кафе».';
    })();
    res.status(201).json({ ...serializeVenue(db, venue), notice });
  });

  r.delete('/venues/:id/partners/:userId', (req, res) => {
    const venue = getVenue(parse(idParam, req.params.id));
    db.prepare('DELETE FROM venue_partners WHERE venue_id = ? AND user_id = ?').run(venue.id, parse(idParam, req.params.userId));
    res.json(serializeVenue(db, venue));
  });

  r.get('/users', (req, res) => {
    const q = parse(z.string().max(100).optional(), req.query.q);
    const like = q?.trim() ? likePattern(q) : null;
    const rows = db
      .prepare(
        `SELECT u.*,
           (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.telegram_id) AS orders_count,
           (SELECT GROUP_CONCAT(v.name, ', ') FROM venue_partners p JOIN venues v ON v.id = p.venue_id WHERE p.user_id = u.telegram_id) AS venues
         FROM users u
         WHERE @like IS NULL
            OR ru_lower(COALESCE(u.first_name, '')) LIKE @like ESCAPE '\\'
            OR ru_lower(COALESCE(u.last_name, '')) LIKE @like ESCAPE '\\'
            OR ru_lower(COALESCE(u.username, '')) LIKE @like ESCAPE '\\'
            OR CAST(u.telegram_id AS TEXT) LIKE @like ESCAPE '\\'
         ORDER BY u.created_at DESC, u.telegram_id DESC LIMIT 200`,
      )
      .all({ like });
    res.json(
      rows.map((u) => ({
        id: u.telegram_id,
        firstName: u.first_name,
        lastName: u.last_name,
        username: u.username,
        ordersCount: u.orders_count,
        venues: u.venues,
        isAdmin: config.adminIds.has(u.telegram_id),
        lastSeenAt: u.last_seen_at,
      })),
    );
  });

  r.get('/offers', (_req, res) => {
    const t = now();
    res.json(
      db.prepare(`${OFFER_SELECT} ORDER BY o.pickup_end DESC, o.id DESC LIMIT 300`).all().map((row) => serializeOffer(row, t)),
    );
  });

  r.patch('/offers/:id', (req, res) => {
    const offerId = parse(idParam, req.params.id);
    if (!getOfferRow(db, offerId)) throw notFound('Предложение не найдено');
    const { isHidden } = parse(z.object({ isHidden: z.boolean() }), req.body);
    const t = now();
    db.transaction(() =>
      withAvailabilityWatch(db, offerId, t, () => {
        db.prepare(`UPDATE offers SET is_hidden = ?, updated_at = datetime('now') WHERE id = ?`).run(isHidden ? 1 : 0, offerId);
      }),
    ).immediate();
    res.json(serializeOffer(getOfferRow(db, offerId), t));
  });

  r.get('/orders', (req, res) => {
    const status = parse(z.enum(STATUSES).optional(), req.query.status);
    const rows = db
      .prepare('SELECT id FROM orders WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT 300')
      .all(status ?? null, status ?? null);
    res.json(rows.map(({ id }) => ({ ...serializeOrder(db, getOrderRow(db, id)), history: getOrderHistory(db, id) })));
  });

  r.patch('/orders/:id', (req, res) => {
    const id = parse(idParam, req.params.id);
    const { status, comment } = parse(
      z.object({ status: z.enum(STATUSES), comment: z.string().trim().max(300).optional() }),
      req.body,
    );
    const order = changeOrderStatus(db, config, id, status, { id: req.user.telegram_id, role: 'admin' }, comment || null);
    res.json({ ...serializeOrder(db, order), history: getOrderHistory(db, id) });
  });

  return r;
}
