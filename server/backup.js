// Резервная копия базы без остановки сервера: node server/backup.js <файл>.
// Использует онлайн-бэкап SQLite, поэтому копия согласована даже во время записи заказов.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from './config.js';

const target = process.argv[2];
if (!target) {
  console.error('Укажите файл: node server/backup.js data/backups/eda.db');
  process.exit(1);
}

const { dbPath } = loadConfig(process.env);
fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
const db = new Database(dbPath, { fileMustExist: true });
try {
  await db.backup(target);
  console.log(`Копия сохранена: ${target}`);
} finally {
  db.close();
}
