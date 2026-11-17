import { Router } from 'express';
import { z } from 'zod';
import { CATEGORIES } from '../config.js';
import { likePattern } from '../db.js';
import { OFFER_SELECT, getOfferRow, serializeOffer } from '../services/offers.js';
import { changeOrderStatus, createOrder, getOrderRow, serializeOrder } from '../services/orders.js';
import { AppError, distanceKm, idParam, localNow, notFound, parse } from '../util.js';

const orderSchema = z.object({
  idempotencyKey: z.string().min(8).max(64),
  items: z
    .array(z.object({ offerId: z.number().int().positive(), quantity: z.number().int().min(1).max(99) }))
    .min(1, 'Корзина пуста')
    .max(50),
});

const AVAILABLE = `o.is_published = 1 AND o.is_hidden = 0 AND v.is_active = 1 AND o.quantity > 0 AND o.pickup_end > @now`;

export function buyerRoutes(db, config) {
  const r = Router();
  const now = () => localNow(config.timezone);

  r.get('/me', (req, res) => {
    // Главному админу доступны все заведения, админу кафе только назначенные.
    const venues = req.isAdmin
      ? db.prepare('SELECT id, name, address FROM venues ORDER BY name').all()
      : db
          .prepare(
            `SELECT v.id, v.name, v.address FROM venue_partners p JOIN venues v ON v.id = p.venue_id
             WHERE p.user_id = ? ORDER BY v.name`,
          )
          .all(req.user.telegram_id);
    const cities = db.prepare('SELECT DISTINCT city FROM venues WHERE is_active = 1 ORDER BY city').all().map((c) => c.city);
    res.json({
      id: req.user.telegram_id,
      firstName: req.user.first_name,
      lastName: req.user.last_name,
      username: req.user.username,
      city: req.user.city || config.defaultCity,
      isAdmin: req.isAdmin,
      venues,
      cities: cities.length ? cities : [config.defaultCity],
      categories: CATEGORIES,
      currency: config.currency,
      devAuth: config.devAuth,
    });
  });

  r.patch('/me', (req, res) => {
    const { city } = parse(z.object({ city: z.string().trim().min(1).max(80) }), req.body);
    db.prepare('UPDATE users SET city = ? WHERE telegram_id = ?').run(city, req.user.telegram_id);
    res.json({ city });
  });

  r.get('/offers', (req, res) => {
    const q = parse(
      z.object({
        city: z.string().optional(),
        category: z.string().optional(),
        q: z.string().max(100).optional(),
        venueId: idParam.optional(),
      }),
      req.query,
    );
    const where = [AVAILABLE];
    const params = { now: now() };
    if (q.city) {
      where.push('v.city = @city');
      params.city = q.city;
    }
    if (q.category) {
      where.push('o.category = @category');
      params.category = q.category;
    }
    if (q.venueId) {
      where.push('o.venue_id = @venueId');
      params.venueId = q.venueId;
    }
    if (q.q?.trim()) {
      where.push(`(ru_lower(o.name) LIKE @like ESCAPE '\\' OR ru_lower(v.name) LIKE @like ESCAPE '\\')`);
      params.like = likePattern(q.q);
    }
    const rows = db.prepare(`${OFFER_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.pickup_end, o.id LIMIT 200`).all(params);
    res.json(rows.map((row) => serializeOffer(row, params.now)));
  });

  r.get('/offers/:id', (req, res) => {
    const row = getOfferRow(db, parse(idParam, req.params.id));
    if (!row) throw notFound('Предложение не найдено');
    res.json(serializeOffer(row, now()));
  });

  r.get('/venues', (req, res) => {
    const q = parse(
      z.object({
        city: z.string().optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
      }),
      req.query,
    );
    const rows = db
      .prepare(
        `SELECT v.*,
           (SELECT COUNT(*) FROM offers o WHERE o.venue_id = v.id AND ${AVAILABLE}) AS offers_count,
           (SELECT MIN(o.price_discounted) FROM offers o WHERE o.venue_id = v.id AND ${AVAILABLE}) AS min_price
         FROM venues v
         WHERE v.is_active = 1 AND (@city IS NULL OR v.city = @city)
         ORDER BY offers_count > 0 DESC, v.name`,
      )
      .all({ now: now(), city: q.city ?? null });
    const venues = rows.map((v) => ({
      id: v.id,
      name: v.name,
      city: v.city,
      address: v.address,
      phone: v.phone,
      lat: v.lat,
      lng: v.lng,
      offersCount: v.offers_count,
      minPrice: v.min_price,
      distanceKm:
        q.lat != null && q.lng != null && v.lat != null && v.lng != null
          ? Math.round(distanceKm(q.lat, q.lng, v.lat, v.lng) * 10) / 10
          : null,
    }));
    if (q.lat != null && q.lng != null) {
      venues.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    }
    res.json(venues);
  });

  r.get('/venues/:id', (req, res) => {
    const venue = db.prepare('SELECT * FROM venues WHERE id = ? AND is_active = 1').get(parse(idParam, req.params.id));
    if (!venue) throw notFound('Заведение не найдено');
    res.json({ id: venue.id, name: venue.name, city: venue.city, address: venue.address, phone: venue.phone });
  });

  r.get('/favorites', (req, res) => {
    const rows = db
      .prepare(
        `${OFFER_SELECT} JOIN favorites f ON f.offer_id = o.id
         WHERE f.user_id = ? ORDER BY f.created_at DESC, f.offer_id DESC`,
      )
      .all(req.user.telegram_id);
    const t = now();
    res.json(rows.map((row) => serializeOffer(row, t)));
  });

  r.put('/favorites/:offerId', (req, res) => {
    const offerId = parse(idParam, req.params.offerId);
    if (!getOfferRow(db, offerId)) throw notFound('Предложение не найдено');
    db.prepare('INSERT OR IGNORE INTO favorites (user_id, offer_id) VALUES (?, ?)').run(req.user.telegram_id, offerId);
    res.status(204).end();
  });

  r.delete('/favorites/:offerId', (req, res) => {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND offer_id = ?').run(
      req.user.telegram_id,
      parse(idParam, req.params.offerId),
    );
    res.status(204).end();
  });

  r.post('/orders', (req, res) => {
    const body = parse(orderSchema, req.body);
    const { id, created } = createOrder(db, config, req.user.telegram_id, body);
    res.status(created ? 201 : 200).json(serializeOrder(db, getOrderRow(db, id)));
  });

  r.get('/orders', (req, res) => {
    const rows = db.prepare('SELECT id FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.telegram_id);
    res.json(rows.map(({ id }) => serializeOrder(db, getOrderRow(db, id))));
  });

  function ownOrder(req) {
    const row = getOrderRow(db, parse(idParam, req.params.id));
    if (!row || row.user_id !== req.user.telegram_id) throw notFound('Заказ не найден');
    return row;
  }

  r.get('/orders/:id', (req, res) => {
    res.json(serializeOrder(db, ownOrder(req)));
  });

  r.post('/orders/:id/cancel', (req, res) => {
    const order = ownOrder(req);
    if (order.status !== 'booked') throw new AppError(409, 'not_active', 'Отменить можно только активный заказ');
    const updated = changeOrderStatus(db, config, order.id, 'cancelled', { id: req.user.telegram_id, role: 'buyer' }, 'Отменён покупателем');
    res.json(serializeOrder(db, updated));
  });

  return r;
}
