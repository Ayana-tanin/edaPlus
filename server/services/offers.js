import { notifyFavoritesAvailable } from './notifications.js';

export const OFFER_SELECT = `
  SELECT o.*, v.name AS venue_name, v.address AS venue_address, v.city AS venue_city,
         v.is_active AS venue_active, v.lat AS venue_lat, v.lng AS venue_lng
  FROM offers o JOIN venues v ON v.id = o.venue_id`;

/** available: можно бронировать; sold_out: закончилось; unavailable: снято, скрыто или истекло. */
export function offerState(row, now) {
  if (!row.is_published || row.is_hidden || !row.venue_active || row.pickup_end <= now) return 'unavailable';
  return row.quantity > 0 ? 'available' : 'sold_out';
}

export function serializeOffer(row, now) {
  return {
    id: row.id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    venueAddress: row.venue_address,
    city: row.venue_city,
    name: row.name,
    photo: row.photo,
    description: row.description,
    ingredients: row.ingredients,
    category: row.category,
    priceOriginal: row.price_original,
    priceDiscounted: row.price_discounted,
    quantity: row.quantity,
    pickupStart: row.pickup_start,
    pickupEnd: row.pickup_end,
    isPublished: !!row.is_published,
    isHidden: !!row.is_hidden,
    state: offerState(row, now),
  };
}

export function getOfferRow(db, id) {
  return db.prepare(`${OFFER_SELECT} WHERE o.id = ?`).get(id);
}

/** Выполняет изменение и уведомляет избранное, если предложение снова стало доступным. */
export function withAvailabilityWatch(db, offerId, now, change) {
  const before = offerState(getOfferRow(db, offerId), now);
  const result = change();
  const after = getOfferRow(db, offerId);
  if (before !== 'available' && offerState(after, now) === 'available') notifyFavoritesAvailable(db, after);
  return result;
}
