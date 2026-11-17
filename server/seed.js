// Демо-данные для локальной разработки. Заведения вымышленные.
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { localNow } from './util.js';

const config = loadConfig();
if (config.isProd) {
  console.error('seed запрещён в production');
  process.exit(1);
}

const db = openDb(config.dbPath);
if (db.prepare('SELECT COUNT(*) AS n FROM venues').get().n > 0) {
  console.log('В базе уже есть заведения, демо-данные не добавлены.');
  process.exit(0);
}

const tomorrow = localNow(config.timezone, new Date(Date.now() + 86_400_000)).slice(0, 10);

const VENUES = [
  { name: 'Пекарня «Тёплый хлеб»', address: 'ул. Киевская, 95', phone: '+996 555 000 001', lat: 42.8746, lng: 74.6042 },
  { name: 'Кафе «Сад»', address: 'пр. Чуй, 136', phone: '+996 555 000 002', lat: 42.8766, lng: 74.5982 },
  { name: 'Суши «Волна»', address: 'ул. Токтогула, 112', phone: '+996 555 000 003', lat: 42.8689, lng: 74.6123 },
];

const OFFERS = [
  { venue: 0, name: 'Набор свежей выпечки', photo: 'bakery', category: 'Выпечка', was: 600, now: 250, qty: 6, date: tomorrow, from: '18:00', to: '20:00', description: 'Круассаны, булочки и слойки, испечённые сегодня утром.', ingredients: 'Мука, масло, яйца, сахар. Аллергены: глютен, молоко, яйца.' },
  { venue: 0, name: 'Хлебная корзина', photo: 'bread', category: 'Выпечка', was: 350, now: 150, qty: 4, date: tomorrow, from: '18:00', to: '20:30', description: 'Два батона и половина ржаного хлеба.', ingredients: 'Мука пшеничная и ржаная, дрожжи, соль. Аллергены: глютен.' },
  { venue: 0, name: 'Десерт дня', photo: 'dessert', category: 'Десерты', was: 420, now: 190, qty: 3, date: tomorrow, from: '19:00', to: '21:00', description: 'Два кусочка торта на выбор кондитера.', ingredients: 'Состав зависит от торта. Аллергены: глютен, молоко, яйца, орехи.' },
  { venue: 1, name: 'Обед с плова', photo: 'meal', category: 'Готовые блюда', was: 550, now: 270, qty: 5, date: tomorrow, from: '15:00', to: '17:00', description: 'Порция плова, салат и лепёшка.', ingredients: 'Рис, говядина, морковь, лук, зира. Аллергены: глютен (лепёшка).' },
  { venue: 1, name: 'Греческий салат', photo: 'salad', category: 'Салаты', was: 320, now: 140, qty: 8, date: tomorrow, from: '15:00', to: '18:00', description: 'Большая порция салата из сегодняшней витрины.', ingredients: 'Огурцы, томаты, сыр фета, маслины. Аллергены: молоко.' },
  { venue: 2, name: 'Сюрприз-сет роллов', photo: 'sushi', category: 'Сюрприз-набор', was: 1100, now: 490, qty: 2, date: tomorrow, from: '21:00', to: '22:30', description: 'Восемнадцать роллов: состав зависит от остатков витрины.', ingredients: 'Рис, рыба, нори, соевый соус. Аллергены: рыба, соя, глютен, кунжут.' },
];

const seed = db.transaction(() => {
  const venueIds = VENUES.map((v) =>
    db
      .prepare('INSERT INTO venues (name, city, address, phone, lat, lng) VALUES (?, ?, ?, ?, ?, ?)')
      .run(v.name, config.defaultCity, v.address, v.phone, v.lat, v.lng).lastInsertRowid,
  );
  for (const o of OFFERS) {
    db.prepare(
      `INSERT INTO offers (venue_id, name, photo, description, ingredients, category, price_original, price_discounted,
         quantity, pickup_start, pickup_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(venueIds[o.venue], o.name, `/demo/${o.photo}.svg`, o.description, o.ingredients, o.category, o.was, o.now, o.qty, `${o.date}T${o.from}`, `${o.date}T${o.to}`);
  }
  // Тестовый партнёр для входа в режиме DEV_AUTH (id 2001).
  db.prepare("INSERT OR IGNORE INTO users (telegram_id, first_name) VALUES (2001, 'Партнёр')").run();
  db.prepare('INSERT OR IGNORE INTO venue_partners (venue_id, user_id) VALUES (?, 2001)').run(venueIds[0]);
});
seed();
console.log(`Добавлено: ${VENUES.length} заведения, ${OFFERS.length} предложений.`);
