import { createApp } from './app.js';
import { createBot } from './bot.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { flushNotifications } from './services/notifications.js';
import { runOrderJobs } from './services/orders.js';

const config = loadConfig();

if (config.isProd && !config.botToken) {
  console.error('BOT_TOKEN обязателен в production');
  process.exit(1);
}

const db = openDb(config.dbPath);
const app = createApp(db, config);

let bot = null;
if (config.botToken) {
  bot = createBot(db, config);
  bot.start().catch((err) => console.error('[bot] не удалось запустить:', err.message));
} else {
  console.warn('[bot] BOT_TOKEN не задан: бот выключен, уведомления пишутся в лог.');
}

const send = bot
  ? bot.send
  : async (telegramId, text) => console.log(`[notify → ${telegramId}] ${text.replace(/\n+/g, ' | ')}`);

let flushing = false;
const flushTimer = setInterval(async () => {
  if (flushing) return;
  flushing = true;
  try {
    await flushNotifications(db, send);
  } catch (err) {
    console.error('[notify]', err);
  } finally {
    flushing = false;
  }
}, 3_000);

const jobsTimer = setInterval(() => {
  try {
    runOrderJobs(db, config);
  } catch (err) {
    console.error('[jobs]', err);
  }
}, 60_000);

const server = app.listen(config.port, () => {
  console.log(`[api] http://localhost:${config.port}${config.devAuth ? ' (DEV_AUTH включён)' : ''}`);
});

function shutdown() {
  clearInterval(flushTimer);
  clearInterval(jobsTimer);
  bot?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
