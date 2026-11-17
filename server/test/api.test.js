import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createApp } from '../app.js';
import { verifyInitData } from '../auth.js';
import { openDb } from '../db.js';
import { flushNotifications } from '../services/notifications.js';
import { runOrderJobs } from '../services/orders.js';
import { localNow, localShifted } from '../util.js';

const BOT_TOKEN = '123456:TEST-TOKEN';
const ADMIN = 9001;
const PARTNER = 2001;
const OTHER_PARTNER = 2002;
const BUYER = 1001;
const OTHER_BUYER = 1002;
const TZ = 'Asia/Bishkek';

const tomorrow = () => localShifted(TZ, 24 * 60).slice(0, 10);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function signInitData(user, { token = BOT_TOKEN, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'q1', user: JSON.stringify(user) });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

describe('eda+ API', () => {
  let db, server, base, tmp, config, venueA, venueB;

  async function call(user, method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(user ? { Authorization: `tma ${signInitData({ id: user, first_name: `U${user}` })}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const offerBody = (over = {}) => ({
    name: 'Выпечка',
    photo: '/uploads/a.jpg',
    description: 'Описание',
    ingredients: 'Мука. Аллергены: глютен',
    category: 'Выпечка',
    priceOriginal: 500,
    priceDiscounted: 200,
    quantity: 5,
    pickupStart: `${tomorrow()}T18:00`,
    pickupEnd: `${tomorrow()}T20:00`,
    ...over,
  });

  const createOffer = async (over, venue = venueA, partner = PARTNER) => {
    const res = await call(partner, 'POST', `/api/partner/venues/${venue}/offers`, offerBody(over));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };

  const book = (user, items, key = crypto.randomUUID()) => call(user, 'POST', '/api/orders', { idempotencyKey: key, items });
  const stock = (id) => db.prepare('SELECT quantity FROM offers WHERE id = ?').get(id).quantity;
  const kinds = (user) => db.prepare('SELECT kind FROM notifications WHERE user_id = ? ORDER BY id').all(user).map((n) => n.kind);

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eda-test-'));
    config = {
      isProd: false,
      botToken: BOT_TOKEN,
      webappUrl: '',
      adminIds: new Set([ADMIN]),
      timezone: TZ,
      currency: 'сом',
      defaultCity: 'Бишкек',
      reminderMinutes: 30,
      noShowGraceMinutes: 30,
      initDataMaxAgeSec: 86400,
      devAuth: false,
      uploadsDir: path.join(tmp, 'uploads'),
      webDist: path.join(tmp, 'nothing'),
    };
    db = openDb(path.join(tmp, 'test.db'));
    const app = createApp(db, config);
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    db.exec(`DELETE FROM notifications; DELETE FROM order_status_history; DELETE FROM order_items; DELETE FROM orders;
             DELETE FROM favorites; DELETE FROM offers; DELETE FROM venue_partners; DELETE FROM venues; DELETE FROM users;`);
    venueA = (await call(ADMIN, 'POST', '/api/admin/venues', { name: 'Пекарня', city: 'Бишкек', address: 'Киевская 1', lat: 42.87, lng: 74.6 })).body.id;
    venueB = (await call(ADMIN, 'POST', '/api/admin/venues', { name: 'Кафе', city: 'Бишкек', address: 'Чуй 2', lat: 42.9, lng: 74.7 })).body.id;
    await call(ADMIN, 'POST', `/api/admin/venues/${venueA}/partners`, { user: String(PARTNER) });
    await call(ADMIN, 'POST', `/api/admin/venues/${venueB}/partners`, { user: String(OTHER_PARTNER) });
    // Сообщения о выдаче доступа из подготовки не относятся к проверкам тестов.
    db.exec('DELETE FROM notifications');
  });

  describe('авторизация Telegram', () => {
    it('принимает корректную подпись и создаёт пользователя', async () => {
      const res = await call(BUYER, 'GET', '/api/me');
      assert.equal(res.status, 200);
      assert.equal(res.body.id, BUYER);
      assert.equal(res.body.isAdmin, false);
    });

    it('отвергает отсутствие, подделку и устаревшую подпись', async () => {
      assert.equal((await call(null, 'GET', '/api/me')).status, 401);
      const forged = signInitData({ id: BUYER }, { token: '1:other' });
      assert.equal((await call(null, 'GET', '/api/me', null, { Authorization: `tma ${forged}` })).status, 401);
      const old = signInitData({ id: BUYER }, { authDate: Math.floor(Date.now() / 1000) - 90000 });
      assert.equal((await call(null, 'GET', '/api/me', null, { Authorization: `tma ${old}` })).status, 401);
    });

    it('подмена пользователя в подписанных данных ломает подпись', () => {
      const tampered = signInitData({ id: BUYER }).replace(encodeURIComponent(`"id":${BUYER}`), encodeURIComponent('"id":9001'));
      assert.equal(verifyInitData(tampered, BOT_TOKEN, 86400), null);
    });

    it('заголовок разработчика не работает при выключенном DEV_AUTH', async () => {
      assert.equal((await call(null, 'GET', '/api/me', null, { 'X-Dev-User': String(ADMIN) })).status, 401);
    });

    it('разделяет права ролей', async () => {
      assert.equal((await call(BUYER, 'GET', '/api/admin/users')).status, 403);
      assert.equal((await call(PARTNER, 'GET', '/api/admin/venues')).status, 403);
      assert.equal((await call(BUYER, 'GET', `/api/partner/venues/${venueA}/offers`)).status, 403);
      assert.equal((await call(OTHER_PARTNER, 'POST', `/api/partner/venues/${venueA}/offers`, offerBody())).status, 403);
    });
  });

  describe('каталог и поиск (FR-02, FR-03, FR-04)', () => {
    it('показывает только доступные предложения', async () => {
      const live = await createOffer();
      const soldOut = await createOffer({ quantity: 0 });
      const hidden = await createOffer();
      const unpublished = await createOffer();
      await call(ADMIN, 'PATCH', `/api/admin/offers/${hidden.id}`, { isHidden: true });
      await call(PARTNER, 'POST', `/api/partner/offers/${unpublished.id}/unpublish`);
      const { body } = await call(BUYER, 'GET', '/api/offers?city=Бишкек');
      assert.deepEqual(body.map((o) => o.id), [live.id]);
      assert.equal((await call(BUYER, 'GET', `/api/offers/${soldOut.id}`)).body.state, 'sold_out');
      assert.equal((await call(BUYER, 'GET', `/api/offers/${hidden.id}`)).body.state, 'unavailable');
    });

    it('ищет по набору и заведению без учёта регистра кириллицы', async () => {
      await createOffer({ name: 'Круассаны' });
      await createOffer({ name: 'Плов' }, venueB, OTHER_PARTNER);
      const q = async (s) => (await call(BUYER, 'GET', `/api/offers?q=${encodeURIComponent(s)}`)).body.map((o) => o.name);
      assert.deepEqual(await q('КРУАС'), ['Круассаны']);
      assert.deepEqual(await q('кафе'), ['Плов']);
      assert.deepEqual(await q('нет такого'), []);
      assert.deepEqual(await q('%'), []);
    });

    it('фильтрует по категории и сортирует заведения по расстоянию', async () => {
      await createOffer({ category: 'Десерты', name: 'Торт' });
      await createOffer({ category: 'Выпечка', name: 'Хлеб' });
      const { body } = await call(BUYER, 'GET', `/api/offers?category=${encodeURIComponent('Десерты')}`);
      assert.deepEqual(body.map((o) => o.name), ['Торт']);
      const near = await call(BUYER, 'GET', '/api/venues?lat=42.9&lng=74.7');
      assert.equal(near.body[0].id, venueB);
      assert.equal(near.body[0].distanceKm, 0);
    });
  });

  describe('бронирование (FR-05)', () => {
    it('создаёт один заказ на несколько позиций с единым кодом и уменьшает остатки', async () => {
      const a = await createOffer({ quantity: 5, priceDiscounted: 200 });
      const b = await createOffer({ name: 'Торт', quantity: 3, priceDiscounted: 100 });
      const res = await book(BUYER, [{ offerId: a.id, quantity: 2 }, { offerId: b.id, quantity: 3 }]);
      assert.equal(res.status, 201);
      assert.equal(res.body.items.length, 2);
      assert.equal(res.body.total, 700);
      assert.match(res.body.code, /^[2-9A-Z]{6}$/);
      assert.equal(res.body.status, 'booked');
      assert.equal(stock(a.id), 3);
      assert.equal(stock(b.id), 0);
      assert.deepEqual(kinds(BUYER), ['order_confirmed']);
    });

    it('повторное нажатие не создаёт второй заказ', async () => {
      const a = await createOffer({ quantity: 5 });
      const key = crypto.randomUUID();
      const results = await Promise.all(Array.from({ length: 5 }, () => book(BUYER, [{ offerId: a.id, quantity: 1 }], key)));
      assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(stock(a.id), 4);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
      assert.deepEqual(kinds(BUYER), ['order_confirmed']);
    });

    it('не даёт заказать больше остатка, даже при одновременных запросах', async () => {
      const a = await createOffer({ quantity: 3 });
      const results = await Promise.all(Array.from({ length: 10 }, () => book(BUYER, [{ offerId: a.id, quantity: 1 }])));
      assert.equal(results.filter((r) => r.status === 201).length, 3);
      assert.equal(results.filter((r) => r.status === 409).length, 7);
      assert.equal(stock(a.id), 0);
    });

    it('при нехватке одной позиции не бронирует ничего', async () => {
      const a = await createOffer({ quantity: 5 });
      const b = await createOffer({ quantity: 1 });
      const res = await book(BUYER, [{ offerId: a.id, quantity: 2 }, { offerId: b.id, quantity: 2 }]);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'not_enough');
      assert.equal(res.body.error.details.available, 1);
      assert.equal(stock(a.id), 5);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
    });

    it('суммирует одинаковые позиции при проверке остатка', async () => {
      const a = await createOffer({ quantity: 2 });
      const res = await book(BUYER, [{ offerId: a.id, quantity: 2 }, { offerId: a.id, quantity: 1 }]);
      assert.equal(res.status, 409);
    });

    it('запрещает заказ из разных заведений, закончившиеся и снятые наборы', async () => {
      const a = await createOffer();
      const b = await createOffer({}, venueB, OTHER_PARTNER);
      assert.equal((await book(BUYER, [{ offerId: a.id, quantity: 1 }, { offerId: b.id, quantity: 1 }])).body.error.code, 'mixed_venues');
      const empty = await createOffer({ quantity: 0 });
      assert.equal((await book(BUYER, [{ offerId: empty.id, quantity: 1 }])).body.error.code, 'sold_out');
      await call(PARTNER, 'POST', `/api/partner/offers/${a.id}/unpublish`);
      assert.equal((await book(BUYER, [{ offerId: a.id, quantity: 1 }])).body.error.code, 'offer_unavailable');
    });

    it('требует общего времени получения и считает его пересечением', async () => {
      const a = await createOffer({ pickupStart: `${tomorrow()}T10:00`, pickupEnd: `${tomorrow()}T12:00` });
      const b = await createOffer({ pickupStart: `${tomorrow()}T15:00`, pickupEnd: `${tomorrow()}T16:00` });
      const c = await createOffer({ pickupStart: `${tomorrow()}T11:00`, pickupEnd: `${tomorrow()}T13:00` });
      assert.equal((await book(BUYER, [{ offerId: a.id, quantity: 1 }, { offerId: b.id, quantity: 1 }])).body.error.code, 'pickup_conflict');
      const ok = await book(BUYER, [{ offerId: a.id, quantity: 1 }, { offerId: c.id, quantity: 1 }]);
      assert.equal(ok.body.pickupStart, `${tomorrow()}T11:00`);
      assert.equal(ok.body.pickupEnd, `${tomorrow()}T12:00`);
    });

    it('покупатель видит и отменяет только свои заказы, остатки возвращаются', async () => {
      const a = await createOffer({ quantity: 2 });
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 2 }]);
      assert.equal((await call(OTHER_BUYER, 'GET', `/api/orders/${order.id}`)).status, 404);
      assert.equal((await call(OTHER_BUYER, 'POST', `/api/orders/${order.id}/cancel`)).status, 404);
      assert.equal((await call(OTHER_BUYER, 'GET', '/api/orders')).body.length, 0);
      assert.equal((await call(BUYER, 'POST', `/api/orders/${order.id}/cancel`)).body.status, 'cancelled');
      assert.equal(stock(a.id), 2);
      assert.equal((await call(BUYER, 'POST', `/api/orders/${order.id}/cancel`)).status, 409);
      assert.deepEqual(kinds(BUYER), ['order_confirmed', 'order_cancelled']);
    });
  });

  describe('избранное (FR-06)', () => {
    it('без дублей, у каждого своё, сохраняет недоступные с пометкой', async () => {
      const a = await createOffer();
      await call(BUYER, 'PUT', `/api/favorites/${a.id}`);
      await call(BUYER, 'PUT', `/api/favorites/${a.id}`);
      assert.equal((await call(BUYER, 'GET', '/api/favorites')).body.length, 1);
      assert.equal((await call(OTHER_BUYER, 'GET', '/api/favorites')).body.length, 0);
      await call(PARTNER, 'POST', `/api/partner/offers/${a.id}/unpublish`);
      assert.equal((await call(BUYER, 'GET', '/api/favorites')).body[0].state, 'unavailable');
      await call(BUYER, 'DELETE', `/api/favorites/${a.id}`);
      assert.equal((await call(BUYER, 'GET', '/api/favorites')).body.length, 0);
    });

    it('уведомляет о появлении в наличии один раз', async () => {
      const a = await createOffer({ quantity: 0 });
      await call(BUYER, 'PUT', `/api/favorites/${a.id}`);
      await call(PARTNER, 'PATCH', `/api/partner/offers/${a.id}`, { quantity: 3 });
      await call(PARTNER, 'PATCH', `/api/partner/offers/${a.id}`, { quantity: 4 });
      assert.deepEqual(kinds(BUYER), ['favorite_available']);
    });
  });

  describe('кабинет партнёра (FR-08, FR-09)', () => {
    it('проверяет поля предложения', async () => {
      const post = (over) => call(PARTNER, 'POST', `/api/partner/venues/${venueA}/offers`, offerBody(over));
      assert.equal((await post({ priceDiscounted: 500 })).status, 400);
      assert.equal((await post({ pickupEnd: `${tomorrow()}T17:00` })).status, 400);
      assert.equal((await post({ name: '  ' })).status, 400);
      assert.equal((await post({ pickupStart: '2020-01-01T10:00', pickupEnd: '2020-01-01T11:00' })).status, 400);
      assert.equal((await post({ photo: 'https://evil.example/x.jpg' })).status, 400);
    });

    it('изменение количества и цены не трогает сделанные брони', async () => {
      const a = await createOffer({ quantity: 5, priceDiscounted: 200 });
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 3 }]);
      const res = await call(PARTNER, 'PATCH', `/api/partner/offers/${a.id}`, { quantity: 0, priceDiscounted: 50, name: 'Новое' });
      assert.equal(res.status, 200);
      const after = (await call(BUYER, 'GET', `/api/orders/${order.id}`)).body;
      assert.equal(after.status, 'booked');
      assert.equal(after.total, 600);
      assert.equal(after.items[0].quantity, 3);
      assert.equal(after.items[0].name, 'Выпечка');
    });

    it('чужие предложения и заказы недоступны', async () => {
      const a = await createOffer();
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      assert.equal((await call(OTHER_PARTNER, 'PATCH', `/api/partner/offers/${a.id}`, { quantity: 9 })).status, 403);
      assert.equal((await call(OTHER_PARTNER, 'POST', `/api/partner/orders/${order.id}/complete`)).status, 403);
      assert.equal((await call(OTHER_PARTNER, 'PATCH', `/api/partner/orders/${order.id}`, { status: 'cancelled' })).status, 403);
    });

    it('выдача: код проверяется по заведению и работает один раз', async () => {
      const a = await createOffer();
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      const lookup = (partner, venue, code) => call(partner, 'POST', `/api/partner/venues/${venue}/orders/lookup`, { code });

      assert.equal((await lookup(OTHER_PARTNER, venueB, order.code)).status, 404);
      assert.equal((await lookup(PARTNER, venueA, 'NOPE22')).status, 404);
      const found = await lookup(PARTNER, venueA, ` ${order.code.toLowerCase()} `);
      assert.equal(found.body.id, order.id);

      const done = await call(PARTNER, 'POST', `/api/partner/orders/${order.id}/complete`);
      assert.equal(done.body.status, 'received');
      const again = await call(PARTNER, 'POST', `/api/partner/orders/${order.id}/complete`);
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, 'code_used');
      assert.equal((await call(BUYER, 'POST', `/api/orders/${order.id}/cancel`)).status, 409);
      // Повторный ввод кода не должен слать покупателю второе сообщение.
      assert.deepEqual(kinds(BUYER), ['order_confirmed', 'order_received']);
    });

    it('покупатель узнаёт о получении при смене статуса вручную кафе и главным админом', async () => {
      const a = await createOffer({ quantity: 2 });
      const { body: first } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      const { body: second } = await book(OTHER_BUYER, [{ offerId: a.id, quantity: 1 }]);
      await call(PARTNER, 'PATCH', `/api/partner/orders/${first.id}`, { status: 'received' });
      await call(ADMIN, 'PATCH', `/api/admin/orders/${second.id}`, { status: 'received' });
      assert.deepEqual(kinds(BUYER), ['order_confirmed', 'order_received']);
      assert.deepEqual(kinds(OTHER_BUYER), ['order_confirmed', 'order_received']);
      const { text } = db.prepare("SELECT text FROM notifications WHERE user_id = ? AND kind = 'order_received'").get(BUYER);
      assert.ok(text.includes(first.code));
    });

    it('загрузка фото: только изображения и только партнёр', async () => {
      const upload = (user, bytes) => {
        const form = new FormData();
        form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'a.jpg');
        return fetch(`${base}/api/uploads`, {
          method: 'POST',
          headers: { Authorization: `tma ${signInitData({ id: user })}` },
          body: form,
        });
      };
      assert.equal((await upload(BUYER, JPEG)).status, 403);
      assert.equal((await upload(PARTNER, Buffer.from('<svg onload="alert(1)"/>'))).status, 400);
      const ok = await upload(PARTNER, JPEG);
      assert.equal(ok.status, 201);
      const { url } = await ok.json();
      assert.match(url, /^\/uploads\/[\w-]+\.jpg$/);
      assert.equal((await fetch(base + url)).status, 200);
    });
  });

  describe('роли и статусы', () => {
    it('админ кафе меняет статус своего заказа с записью в историю', async () => {
      const a = await createOffer({ quantity: 2 });
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 2 }]);
      const set = (status) => call(PARTNER, 'PATCH', `/api/partner/orders/${order.id}`, { status, comment: 'тест' });

      const received = await set('received');
      assert.equal(received.body.status, 'received');
      const last = received.body.history.at(-1);
      assert.deepEqual([last.from, last.to, last.actorId, last.actorRole, last.comment], ['booked', 'received', PARTNER, 'partner', 'тест']);
      assert.equal(stock(a.id), 0);

      await set('booked');
      await set('cancelled');
      assert.equal(stock(a.id), 2);
      assert.equal((await call(PARTNER, 'GET', `/api/partner/venues/${venueA}/orders`)).body[0].history.length, 4);
      assert.equal((await set('unknown')).status, 400);
    });

    it('главный админ управляет любым кафе, админ кафе только своим', async () => {
      const a = await createOffer();
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);

      const me = await call(ADMIN, 'GET', '/api/me');
      assert.deepEqual(me.body.venues.map((v) => v.id).sort(), [venueA, venueB].sort());
      assert.deepEqual((await call(PARTNER, 'GET', '/api/me')).body.venues.map((v) => v.id), [venueA]);

      assert.equal((await call(ADMIN, 'PATCH', `/api/partner/offers/${a.id}`, { quantity: 9 })).status, 200);
      const done = await call(ADMIN, 'POST', `/api/partner/orders/${order.id}/complete`);
      assert.equal(done.body.status, 'received');
      assert.equal((await call(ADMIN, 'POST', '/api/partner/venues/99999/offers', offerBody())).status, 404);

      assert.equal((await call(PARTNER, 'POST', '/api/admin/venues', { name: 'X', city: 'Y', address: 'Z' })).status, 403);
      assert.equal((await call(PARTNER, 'POST', `/api/admin/venues/${venueA}/partners`, { user: '777' })).status, 403);
      assert.equal((await call(OTHER_PARTNER, 'GET', `/api/partner/venues/${venueA}/orders`)).status, 403);
    });
  });

  describe('архив блюд', () => {
    const catalog = async () => (await call(BUYER, 'GET', '/api/offers')).body.map((o) => o.id);

    it('блюдо из архива не видно гостям и не бронируется', async () => {
      const a = await createOffer({ publish: false });
      assert.equal(a.isPublished, false);
      assert.deepEqual(await catalog(), []);
      assert.equal((await book(BUYER, [{ offerId: a.id, quantity: 1 }])).body.error.code, 'offer_unavailable');
      assert.equal((await call(PARTNER, 'GET', `/api/partner/venues/${venueA}/offers`)).body[0].id, a.id);
    });

    it('блюдо переносится в архив и возвращается, брони не страдают', async () => {
      const a = await createOffer();
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      await call(PARTNER, 'POST', `/api/partner/offers/${a.id}/unpublish`);
      assert.deepEqual(await catalog(), []);
      assert.equal((await call(BUYER, 'GET', `/api/orders/${order.id}`)).body.status, 'booked');
      await call(PARTNER, 'POST', `/api/partner/offers/${a.id}/publish`);
      assert.deepEqual(await catalog(), [a.id]);
    });

    it('старая дата допустима в архиве, но не для публикации', async () => {
      const old = { pickupStart: '2020-01-01T10:00', pickupEnd: '2020-01-01T11:00' };
      const a = await createOffer({ publish: false, ...old });
      assert.equal((await call(PARTNER, 'PATCH', `/api/partner/offers/${a.id}`, { name: 'Новое имя' })).status, 200);
      assert.equal((await call(PARTNER, 'PATCH', `/api/partner/offers/${a.id}`, { publish: true })).status, 400);
      assert.equal((await call(PARTNER, 'POST', `/api/partner/offers/${a.id}/publish`)).status, 409);
      const res = await call(PARTNER, 'PATCH', `/api/partner/offers/${a.id}`, {
        publish: true, pickupStart: `${tomorrow()}T10:00`, pickupEnd: `${tomorrow()}T11:00`,
      });
      assert.equal(res.body.state, 'available');
      assert.deepEqual(await catalog(), [a.id]);
    });
  });

  describe('администратор (FR-10)', () => {
    it('меняет статусы с историей и согласованными остатками', async () => {
      const a = await createOffer({ quantity: 2 });
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 2 }]);
      const set = (status, comment) => call(ADMIN, 'PATCH', `/api/admin/orders/${order.id}`, { status, comment });

      await set('cancelled', 'Ошибка заведения');
      assert.equal(stock(a.id), 2);
      const restored = await set('booked');
      assert.equal(stock(a.id), 0);
      assert.deepEqual(restored.body.history.map((h) => [h.from, h.to, h.actorRole]), [
        [null, 'booked', 'buyer'],
        ['booked', 'cancelled', 'admin'],
        ['cancelled', 'booked', 'admin'],
      ]);
      assert.equal(restored.body.history[1].comment, 'Ошибка заведения');
      assert.equal((await set('booked')).status, 409);
    });

    it('не возвращает отменённый заказ, если наборы уже разобрали', async () => {
      const a = await createOffer({ quantity: 1 });
      const { body: first } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      await call(BUYER, 'POST', `/api/orders/${first.id}/cancel`);
      await book(OTHER_BUYER, [{ offerId: a.id, quantity: 1 }]);
      const res = await call(ADMIN, 'PATCH', `/api/admin/orders/${first.id}`, { status: 'booked' });
      assert.equal(res.status, 409);
      assert.equal(stock(a.id), 0);
    });

    it('отмена выданного заказа не возвращает остаток', async () => {
      const a = await createOffer({ quantity: 1 });
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      await call(PARTNER, 'POST', `/api/partner/orders/${order.id}/complete`);
      await call(ADMIN, 'PATCH', `/api/admin/orders/${order.id}`, { status: 'cancelled' });
      assert.equal(stock(a.id), 0);
    });

    it('выдаёт доступ по @username только известному боту пользователю', async () => {
      assert.equal((await call(ADMIN, 'POST', `/api/admin/venues/${venueA}/partners`, { user: '@ghost' })).status, 404);
      db.prepare("INSERT INTO users (telegram_id, username) VALUES (3003, 'Real_User')").run();
      const res = await call(ADMIN, 'POST', `/api/admin/venues/${venueA}/partners`, { user: '@real_user' });
      assert.ok(res.body.partners.some((p) => p.id === 3003));
      const removed = await call(ADMIN, 'DELETE', `/api/admin/venues/${venueA}/partners/3003`);
      assert.ok(!removed.body.partners.some((p) => p.id === 3003));
    });

    it('новый админ кафе получает сообщение и сразу видит кафе', async () => {
      await call(BUYER, 'GET', '/api/me');
      assert.deepEqual((await call(BUYER, 'GET', '/api/me')).body.venues, []);
      const res = await call(ADMIN, 'POST', `/api/admin/venues/${venueA}/partners`, { user: String(BUYER) });
      assert.match(res.body.notice, /получит сообщение/);
      assert.deepEqual(kinds(BUYER), ['cafe_admin_added']);
      assert.deepEqual((await call(BUYER, 'GET', '/api/me')).body.venues.map((v) => v.id), [venueA]);
      assert.equal((await call(BUYER, 'GET', `/api/partner/venues/${venueA}/orders`)).status, 200);

      const again = await call(ADMIN, 'POST', `/api/admin/venues/${venueA}/partners`, { user: String(BUYER) });
      assert.match(again.body.notice, /уже админ/);
      assert.deepEqual(kinds(BUYER), ['cafe_admin_added']);
    });

    it('предупреждает про главного админа и про человека без бота', async () => {
      const main = await call(ADMIN, 'POST', `/api/admin/venues/${venueA}/partners`, { user: String(ADMIN) });
      assert.match(main.body.notice, /главный админ/);
      assert.deepEqual(kinds(ADMIN), []);
      const stranger = await call(ADMIN, 'POST', `/api/admin/venues/${venueA}/partners`, { user: '424242' });
      assert.match(stranger.body.notice, /не запускал бота/);
    });

    it('показывает пользователей с поиском', async () => {
      await call(BUYER, 'GET', '/api/me');
      const { body } = await call(ADMIN, 'GET', `/api/admin/users?q=U${BUYER}`);
      assert.deepEqual(body.map((u) => u.id), [BUYER]);
    });
  });

  describe('фоновые задачи и уведомления', () => {
    function setPickup(orderId, start, end) {
      db.prepare('UPDATE orders SET pickup_start = ?, pickup_end = ?, reminder_sent = 0 WHERE id = ?').run(start, end, orderId);
    }

    it('напоминает один раз перед получением', async () => {
      const a = await createOffer();
      const { body: order } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      setPickup(order.id, localShifted(TZ, 20), localShifted(TZ, 120));
      assert.equal(runOrderJobs(db, config).reminders, 1);
      assert.equal(runOrderJobs(db, config).reminders, 0);
      assert.deepEqual(kinds(BUYER), ['order_confirmed', 'order_reminder']);
    });

    it('переводит просроченные брони в «Не получен» с учётом запаса времени', async () => {
      const a = await createOffer({ quantity: 2 });
      const { body: fresh } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      const { body: stale } = await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      setPickup(fresh.id, localShifted(TZ, -120), localShifted(TZ, -10));
      setPickup(stale.id, localShifted(TZ, -120), localShifted(TZ, -40));
      assert.equal(runOrderJobs(db, config).expired, 1);
      assert.equal((await call(BUYER, 'GET', `/api/orders/${stale.id}`)).body.status, 'not_picked_up');
      assert.equal((await call(BUYER, 'GET', `/api/orders/${fresh.id}`)).body.status, 'booked');
      assert.equal(stock(a.id), 0);
    });

    it('сбой отправки не теряет уведомление, блокировка бота прекращает повторы', async () => {
      const a = await createOffer();
      await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      const log = console.error;
      console.error = () => {};
      try {
        await flushNotifications(db, async () => {
          throw new Error('network');
        });
        assert.equal(db.prepare('SELECT attempts, sent_at FROM notifications').get().sent_at, null);
        const sent = [];
        await flushNotifications(db, async (id, text) => sent.push([id, text]));
        assert.equal(sent.length, 1);
        assert.equal(sent[0][0], BUYER);
        assert.ok(db.prepare('SELECT sent_at FROM notifications').get().sent_at);

        await book(OTHER_BUYER, [{ offerId: a.id, quantity: 1 }]);
        await flushNotifications(db, async () => {
          throw Object.assign(new Error('blocked'), { error_code: 403 });
        });
        let calls = 0;
        await flushNotifications(db, async () => calls++);
        assert.equal(calls, 0);
      } finally {
        console.error = log;
      }
    });

    it('экранирует HTML в названиях для сообщений Telegram', async () => {
      const a = await createOffer({ name: 'Торт <b>"X" & Y' });
      await book(BUYER, [{ offerId: a.id, quantity: 1 }]);
      const { text } = db.prepare('SELECT text FROM notifications WHERE user_id = ?').get(BUYER);
      assert.ok(text.includes('Торт &lt;b&gt;"X" &amp; Y'));
    });
  });

  it('localNow возвращает время в поясе приложения', () => {
    assert.equal(localNow('Asia/Bishkek', new Date('2026-03-01T20:30:00Z')), '2026-03-02T02:30');
    assert.equal(localNow('UTC', new Date('2026-03-01T00:05:00Z')), '2026-03-01T00:05');
  });
});
