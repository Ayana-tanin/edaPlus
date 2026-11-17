import { Router } from 'express';
import { z } from 'zod';
import { assertVenueAccess } from '../auth.js';
import { CATEGORIES } from '../config.js';
import { getOfferRow, serializeOffer, withAvailabilityWatch } from '../services/offers.js';
import { changeOrderStatus, getOrderHistory, getOrderRow, normalizeCode, serializeOrder, STATUSES } from '../services/orders.js';
import { AppError, idParam, localNow, notFound, parse } from '../util.js';

const money = (label) =>
  z.number({ error: `${label}: укажите число` }).int(`${label}: укажите целое число`).positive(`${label}: должна быть больше нуля`).max(10_000_000);
const text = (label, max) => z.string().trim().min(1, `Заполните поле «${label}»`).max(max, `«${label}»: слишком длинно`);
const pickupStamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Укажите дату и время получения');

const offerFields = z.object({
  name: text('Название', 120),
  photo: z.string({ error: 'Добавьте фото' }).regex(/^\/(uploads|demo)\/[\w.-]+$/, 'Добавьте фото'),
  description: text('Описание', 2000),
  ingredients: text('Состав и аллергены', 2000),
  category: z.enum(CATEGORIES, { error: 'Выберите категорию' }),
  priceOriginal: money('Первоначальная цена'),
  priceDiscounted: money('Цена со скидкой'),
  quantity: z.number({ error: 'Количество: укажите число' }).int().min(0, 'Количество не может быть отрицательным').max(100_000),
  pickupStart: pickupStamp,
  pickupEnd: pickupStamp,
});

// publish: false сохраняет блюдо в архиве, гости его не видят.
const createSchema = offerFields.extend({ publish: z.boolean().optional() });
const patchSchema = offerFields.partial().extend({ publish: z.boolean().optional() });

function assertOfferRules(data, now, isPublished) {
  if (data.priceDiscounted >= data.priceOriginal) {
    throw new AppError(400, 'validation', 'Цена со скидкой должна быть ниже первоначальной');
  }
  if (data.pickupStart.slice(0, 10) !== data.pickupEnd.slice(0, 10) || data.pickupStart >= data.pickupEnd) {
    throw new AppError(400, 'validation', 'Конец периода получения должен быть позже начала в тот же день');
  }
  // В архиве можно держать блюдо со старой датой, но для публикации дата должна быть актуальной.
  if (isPublished && data.pickupEnd <= now) {
    throw new AppError(400, 'validation', 'Период получения уже прошёл. Укажите новую дату.');
  }
}

export function partnerRoutes(db, config) {
  const r = Router();
  const now = () => localNow(config.timezone);

  function venueIdOf(req) {
    const venueId = parse(idParam, req.params.venueId);
    assertVenueAccess(db, req, venueId);
    return venueId;
  }

  function ownOffer(req) {
    const offer = getOfferRow(db, parse(idParam, req.params.id));
    if (!offer) throw notFound('Предложение не найдено');
    assertVenueAccess(db, req, offer.venue_id);
    return offer;
  }

  function ownOrder(req) {
    const order = getOrderRow(db, parse(idParam, req.params.id));
    if (!order) throw notFound('Заказ не найден');
    assertVenueAccess(db, req, order.venue_id);
    return order;
  }

  const actorOf = (req) => ({ id: req.user.telegram_id, role: req.isAdmin ? 'admin' : 'partner' });

  r.get('/venues/:venueId/offers', (req, res) => {
    const venueId = venueIdOf(req);
    const rows = db
      .prepare(
        `SELECT o.*, v.name AS venue_name, v.address AS venue_address, v.city AS venue_city, v.is_active AS venue_active,
           (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i JOIN orders ord ON ord.id = i.order_id
            WHERE i.offer_id = o.id AND ord.status = 'booked') AS booked
         FROM offers o JOIN venues v ON v.id = o.venue_id
         WHERE o.venue_id = ? ORDER BY o.pickup_end DESC, o.id DESC LIMIT 200`,
      )
      .all(venueId);
    const t = now();
    res.json(rows.map((row) => ({ ...serializeOffer(row, t), booked: row.booked })));
  });

  r.post('/venues/:venueId/offers', (req, res) => {
    const venueId = venueIdOf(req);
    const data = parse(createSchema, req.body);
    const isPublished = data.publish !== false;
    assertOfferRules(data, now(), isPublished);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO offers (venue_id, name, photo, description, ingredients, category, price_original,
           price_discounted, quantity, pickup_start, pickup_end, is_published)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        venueId, data.name, data.photo, data.description, data.ingredients, data.category,
        data.priceOriginal, data.priceDiscounted, data.quantity, data.pickupStart, data.pickupEnd, isPublished ? 1 : 0,
      );
    res.status(201).json(serializeOffer(getOfferRow(db, lastInsertRowid), now()));
  });

  r.get('/offers/:id', (req, res) => {
    res.json(serializeOffer(ownOffer(req), now()));
  });

  r.patch('/offers/:id', (req, res) => {
    const offer = ownOffer(req);
    const patch = parse(patchSchema, req.body);
    const t = now();
    const next = {
      name: patch.name ?? offer.name,
      photo: patch.photo ?? offer.photo,
      description: patch.description ?? offer.description,
      ingredients: patch.ingredients ?? offer.ingredients,
      category: patch.category ?? offer.category,
      priceOriginal: patch.priceOriginal ?? offer.price_original,
      priceDiscounted: patch.priceDiscounted ?? offer.price_discounted,
      quantity: patch.quantity ?? offer.quantity,
      pickupStart: patch.pickupStart ?? offer.pickup_start,
      pickupEnd: patch.pickupEnd ?? offer.pickup_end,
    };
    const isPublished = patch.publish ?? !!offer.is_published;
    assertOfferRules(next, t, isPublished);
    // Меняется только доступный остаток: сделанные брони лежат в order_items и не затрагиваются.
    db.transaction(() =>
      withAvailabilityWatch(db, offer.id, t, () => {
        db.prepare(
          `UPDATE offers SET name = ?, photo = ?, description = ?, ingredients = ?, category = ?, price_original = ?,
             price_discounted = ?, quantity = ?, pickup_start = ?, pickup_end = ?, is_published = ?, updated_at = datetime('now')
           WHERE id = ?`,
        ).run(
          next.name, next.photo, next.description, next.ingredients, next.category, next.priceOriginal,
          next.priceDiscounted, next.quantity, next.pickupStart, next.pickupEnd, isPublished ? 1 : 0, offer.id,
        );
      }),
    ).immediate();
    res.json(serializeOffer(getOfferRow(db, offer.id), t));
  });

  r.post('/offers/:id/publish', (req, res) => {
    const offer = ownOffer(req);
    const t = now();
    if (offer.pickup_end <= t) throw new AppError(409, 'expired', 'Период получения прошёл. Измените дату, чтобы опубликовать.');
    db.transaction(() =>
      withAvailabilityWatch(db, offer.id, t, () => {
        db.prepare(`UPDATE offers SET is_published = 1, updated_at = datetime('now') WHERE id = ?`).run(offer.id);
      }),
    ).immediate();
    res.json(serializeOffer(getOfferRow(db, offer.id), t));
  });

  r.post('/offers/:id/unpublish', (req, res) => {
    const offer = ownOffer(req);
    db.prepare(`UPDATE offers SET is_published = 0, updated_at = datetime('now') WHERE id = ?`).run(offer.id);
    res.json(serializeOffer(getOfferRow(db, offer.id), now()));
  });

  r.get('/venues/:venueId/orders', (req, res) => {
    const venueId = venueIdOf(req);
    const status = parse(z.enum(STATUSES).optional(), req.query.status);
    const rows = db
      .prepare(`SELECT id FROM orders WHERE venue_id = ? AND (? IS NULL OR status = ?) ORDER BY pickup_start DESC, id DESC LIMIT 200`)
      .all(venueId, status ?? null, status ?? null);
    res.json(rows.map(({ id }) => ({ ...serializeOrder(db, getOrderRow(db, id)), history: getOrderHistory(db, id) })));
  });

  // Заказ чужого заведения неотличим от несуществующего кода.
  r.post('/venues/:venueId/orders/lookup', (req, res) => {
    const venueId = venueIdOf(req);
    const { code } = parse(z.object({ code: z.string().min(1, 'Введите код').max(20) }), req.body);
    const row = db.prepare('SELECT id FROM orders WHERE code = ? AND venue_id = ?').get(normalizeCode(code), venueId);
    if (!row) throw notFound('Заказ с таким кодом в этом заведении не найден');
    res.json(serializeOrder(db, getOrderRow(db, row.id)));
  });

  r.post('/orders/:id/complete', (req, res) => {
    const order = ownOrder(req);
    if (order.status === 'received') throw new AppError(409, 'code_used', 'Этот код уже использован: заказ выдан');
    if (order.status !== 'booked') throw new AppError(409, 'not_active', 'Заказ не активен, выдача невозможна');
    const updated = changeOrderStatus(db, config, order.id, 'received', actorOf(req));
    res.json(serializeOrder(db, updated));
  });

  r.patch('/orders/:id', (req, res) => {
    const order = ownOrder(req);
    const { status, comment } = parse(
      z.object({ status: z.enum(STATUSES), comment: z.string().trim().max(300).optional() }),
      req.body,
    );
    const updated = changeOrderStatus(db, config, order.id, status, actorOf(req), comment || null);
    res.json({ ...serializeOrder(db, updated), history: getOrderHistory(db, order.id) });
  });

  return r;
}
