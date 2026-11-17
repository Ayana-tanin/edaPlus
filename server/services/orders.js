import crypto from 'node:crypto';
import { AppError, escapeHtml as esc, localNow, localShifted, notFound } from '../util.js';
import { queueNotification } from './notifications.js';
import { getOfferRow, offerState, withAvailabilityWatch } from './offers.js';

export const STATUSES = ['booked', 'received', 'cancelled', 'not_picked_up'];

// Без символов, которые легко спутать при вводе: 0/O, 1/I/L.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

function generateCode(db) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    if (!db.prepare('SELECT 1 FROM orders WHERE code = ?').get(code)) return code;
  }
  throw new Error('Не удалось сгенерировать код заказа');
}

export function normalizeCode(code) {
  return String(code).trim().toUpperCase().replace(/\s+/g, '');
}

function formatPickup(start, end) {
  const [date, from] = start.split('T');
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}, ${from}–${end.split('T')[1]}`;
}

export function getOrderRow(db, id) {
  return db
    .prepare(
      `SELECT o.*, v.name AS venue_name, v.address AS venue_address, u.first_name AS customer_name
       FROM orders o
       JOIN venues v ON v.id = o.venue_id
       JOIN users u ON u.telegram_id = o.user_id
       WHERE o.id = ?`,
    )
    .get(id);
}

export function serializeOrder(db, row) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(row.id);
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    total: row.total,
    venueId: row.venue_id,
    venueName: row.venue_name,
    venueAddress: row.venue_address,
    customerName: row.customer_name,
    pickupStart: row.pickup_start,
    pickupEnd: row.pickup_end,
    createdAt: row.created_at,
    items: items.map((i) => ({
      id: i.id,
      offerId: i.offer_id,
      name: i.name,
      price: i.price,
      priceOriginal: i.price_original,
      quantity: i.quantity,
    })),
  };
}

export function getOrderHistory(db, orderId) {
  return db
    .prepare(
      `SELECT from_status AS "from", to_status AS "to", actor_id AS actorId, actor_role AS actorRole, comment, created_at AS createdAt
       FROM order_status_history WHERE order_id = ? ORDER BY id`,
    )
    .all(orderId);
}

function addHistory(db, orderId, from, to, actor, comment) {
  db.prepare(
    `INSERT INTO order_status_history (order_id, from_status, to_status, actor_id, actor_role, comment)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(orderId, from, to, actor.id ?? null, actor.role, comment ?? null);
}

/** Создаёт один заказ на несколько позиций. Повтор с тем же ключом возвращает уже созданный заказ. */
export function createOrder(db, config, userId, { items, idempotencyKey }) {
  const run = db.transaction(() => {
    const existing = db
      .prepare('SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?')
      .get(userId, idempotencyKey);
    if (existing) return { id: existing.id, created: false };

    const now = localNow(config.timezone);
    const merged = new Map();
    for (const item of items) merged.set(item.offerId, (merged.get(item.offerId) ?? 0) + item.quantity);

    const lines = [];
    for (const [offerId, quantity] of merged) {
      const offer = getOfferRow(db, offerId);
      if (!offer) throw new AppError(409, 'offer_unavailable', 'Одно из предложений больше не существует', { offerId });
      const state = offerState(offer, now);
      if (state === 'sold_out') {
        throw new AppError(409, 'sold_out', `«${offer.name}» закончился`, { offerId, available: 0 });
      }
      if (state !== 'available') {
        throw new AppError(409, 'offer_unavailable', `«${offer.name}» больше недоступен`, { offerId, available: 0 });
      }
      if (quantity > offer.quantity) {
        throw new AppError(409, 'not_enough', `«${offer.name}»: доступно только ${offer.quantity} шт.`, {
          offerId,
          available: offer.quantity,
        });
      }
      lines.push({ offer, quantity });
    }

    const venueId = lines[0].offer.venue_id;
    if (lines.some((l) => l.offer.venue_id !== venueId)) {
      throw new AppError(400, 'mixed_venues', 'В одном заказе могут быть позиции только одного заведения');
    }

    // Код один на весь заказ, поэтому у позиций должно быть общее время получения.
    const pickupStart = lines.map((l) => l.offer.pickup_start).sort().at(-1);
    const pickupEnd = lines.map((l) => l.offer.pickup_end).sort()[0];
    if (pickupStart >= pickupEnd) {
      throw new AppError(409, 'pickup_conflict', 'У позиций не совпадает время получения. Оформите их отдельными заказами.');
    }

    const total = lines.reduce((sum, l) => sum + l.offer.price_discounted * l.quantity, 0);
    const code = generateCode(db);
    const reminderDue = pickupStart <= localShifted(config.timezone, config.reminderMinutes);
    const { lastInsertRowid: orderId } = db
      .prepare(
        `INSERT INTO orders (user_id, venue_id, code, status, total, pickup_start, pickup_end, idempotency_key, reminder_sent)
         VALUES (?, ?, ?, 'booked', ?, ?, ?, ?, ?)`,
      )
      .run(userId, venueId, code, total, pickupStart, pickupEnd, idempotencyKey, reminderDue ? 1 : 0);

    for (const { offer, quantity } of lines) {
      db.prepare(
        `INSERT INTO order_items (order_id, offer_id, name, price, price_original, quantity)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(orderId, offer.id, offer.name, offer.price_discounted, offer.price_original, quantity);
      db.prepare(`UPDATE offers SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ?`).run(quantity, offer.id);
    }

    addHistory(db, orderId, null, 'booked', { id: userId, role: 'buyer' });

    const venue = lines[0].offer;
    const list = lines.map((l) => `• ${esc(l.offer.name)} × ${l.quantity}`).join('\n');
    queueNotification(
      db,
      userId,
      'order_confirmed',
      `✅ <b>Бронирование подтверждено</b>\n\n${list}\n\n` +
        `📍 ${esc(venue.venue_name)}, ${esc(venue.venue_address)}\n` +
        `🕒 ${formatPickup(pickupStart, pickupEnd)}\n` +
        `💰 ${total} ${esc(config.currency)}, оплата при получении\n\n` +
        `Код получения: <code>${code}</code>`,
      `/orders/${orderId}`,
    );
    return { id: Number(orderId), created: true };
  });
  return run.immediate();
}

function takeStock(db, orderId) {
  const items = db.prepare('SELECT offer_id, quantity, name FROM order_items WHERE order_id = ?').all(orderId);
  for (const item of items) {
    const { changes } = db
      .prepare(`UPDATE offers SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ? AND quantity >= ?`)
      .run(item.quantity, item.offer_id, item.quantity);
    if (!changes) throw new AppError(409, 'not_enough', `«${item.name}»: недостаточно наборов, чтобы вернуть заказ`);
  }
}

function releaseStock(db, config, orderId) {
  const now = localNow(config.timezone);
  const items = db.prepare('SELECT offer_id, quantity FROM order_items WHERE order_id = ?').all(orderId);
  for (const item of items) {
    withAvailabilityWatch(db, item.offer_id, now, () => {
      db.prepare(`UPDATE offers SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?`).run(item.quantity, item.offer_id);
    });
  }
}

/**
 * Единственное место, где меняется статус заказа: история и остатки всегда согласованы.
 * Остатки возвращаются только при отмене активной брони: выданная или
 * просроченная еда на полку не возвращается.
 */
export function changeOrderStatus(db, config, orderId, to, actor, comment) {
  const run = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw notFound('Заказ не найден');
    const from = order.status;
    if (from === to) throw new AppError(409, 'same_status', 'Заказ уже в этом статусе');

    let released = order.stock_released;
    if (to === 'cancelled' && from === 'booked') {
      releaseStock(db, config, orderId);
      released = 1;
    } else if ((to === 'booked' || to === 'received') && released) {
      takeStock(db, orderId);
      released = 0;
    }

    db.prepare(`UPDATE orders SET status = ?, stock_released = ?, updated_at = datetime('now') WHERE id = ?`).run(to, released, orderId);
    addHistory(db, orderId, from, to, actor, comment);

    if (to === 'cancelled') {
      const reason = comment ? `\nПричина: ${esc(comment)}` : '';
      queueNotification(db, order.user_id, 'order_cancelled', `❌ Заказ <code>${order.code}</code> отменён.${reason}`, `/orders/${orderId}`);
    } else if (to === 'received') {
      queueNotification(db, order.user_id, 'order_received', `🎉 Заказ <code>${order.code}</code> получен. Спасибо, что выбрали eda+!`, `/orders/${orderId}`);
    } else if (to === 'booked') {
      queueNotification(db, order.user_id, 'order_restored', `✅ Заказ <code>${order.code}</code> снова активен.`, `/orders/${orderId}`);
    }
  });
  run.immediate();
  return getOrderRow(db, orderId);
}

/** Напоминания о скором получении и перевод просроченных броней в «Не получен». */
export function runOrderJobs(db, config) {
  const reminderBefore = localShifted(config.timezone, config.reminderMinutes);
  const now = localNow(config.timezone);
  const due = db
    .prepare(
      `SELECT o.*, v.name AS venue_name, v.address AS venue_address
       FROM orders o JOIN venues v ON v.id = o.venue_id
       WHERE o.status = 'booked' AND o.reminder_sent = 0 AND o.pickup_start <= ? AND o.pickup_end > ?`,
    )
    .all(reminderBefore, now);
  for (const order of due) {
    db.transaction(() => {
      queueNotification(
        db,
        order.user_id,
        'order_reminder',
        `⏰ Скоро получение заказа\n\n📍 ${esc(order.venue_name)}, ${esc(order.venue_address)}\n` +
          `🕒 ${formatPickup(order.pickup_start, order.pickup_end)}\nКод получения: <code>${order.code}</code>`,
        `/orders/${order.id}`,
      );
      db.prepare('UPDATE orders SET reminder_sent = 1 WHERE id = ?').run(order.id);
    })();
  }

  const expiredBefore = localShifted(config.timezone, -config.noShowGraceMinutes);
  const expired = db.prepare(`SELECT id FROM orders WHERE status = 'booked' AND pickup_end <= ?`).all(expiredBefore);
  for (const { id } of expired) {
    changeOrderStatus(db, config, id, 'not_picked_up', { role: 'system' }, 'Истекло время получения');
  }
  return { reminders: due.length, expired: expired.length };
}
