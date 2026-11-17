export const STATUS_LABELS = {
  booked: 'Забронирован',
  received: 'Получен',
  cancelled: 'Отменён',
  not_picked_up: 'Не получен',
};

export const OFFER_STATE_LABELS = {
  available: 'В наличии',
  sold_out: 'Закончилось',
  unavailable: 'Недоступно',
};

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function localDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDay(date) {
  if (date === localDate(0)) return 'Сегодня';
  if (date === localDate(1)) return 'Завтра';
  const [, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

export function formatPickup(start, end) {
  const [date, from] = start.split('T');
  return `${formatDay(date)}, ${from}–${end.split('T')[1]}`;
}

export function discountPercent(original, discounted) {
  return Math.round((1 - discounted / original) * 100);
}

export function formatDateTime(sqlUtc) {
  const d = new Date(`${sqlUtc.replace(' ', 'T')}Z`);
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function userName(u) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  return name || (u.username ? `@${u.username}` : `ID ${u.id}`);
}
