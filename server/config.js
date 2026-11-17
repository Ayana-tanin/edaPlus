import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CATEGORIES = ['Готовые блюда', 'Выпечка', 'Десерты', 'Салаты', 'Напитки', 'Сюрприз-набор'];

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const dataDir = path.resolve(root, env.DATA_DIR || 'data');
  return {
    isProd,
    // API_PORT важнее PORT: инструменты разработки задают PORT для dev-сервера Vite.
    port: int(env.API_PORT ?? env.PORT, 3000),
    botToken: env.BOT_TOKEN || '',
    webappUrl: (env.WEBAPP_URL || '').replace(/\/+$/, ''),
    adminIds: new Set(
      (env.ADMIN_TELEGRAM_IDS || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
    timezone: env.APP_TIMEZONE || 'Asia/Bishkek',
    currency: env.CURRENCY || 'сом',
    defaultCity: env.DEFAULT_CITY || 'Бишкек',
    reminderMinutes: int(env.REMINDER_MINUTES, 30),
    noShowGraceMinutes: int(env.NO_SHOW_GRACE_MINUTES, 30),
    initDataMaxAgeSec: int(env.INIT_DATA_MAX_AGE_SEC, 24 * 60 * 60),
    // Вход без Telegram для разработки. В production выключен безусловно.
    devAuth: !isProd && env.DEV_AUTH === 'true',
    dbPath: env.DB_PATH || path.join(dataDir, 'eda.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    webDist: path.join(root, 'web', 'dist'),
  };
}
