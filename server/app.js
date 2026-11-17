import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { authenticate, requireAdmin } from './auth.js';
import { adminRoutes } from './routes/admin.js';
import { buyerRoutes } from './routes/buyer.js';
import { partnerRoutes } from './routes/partner.js';
import { AppError, forbidden, notFound } from './util.js';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Тип определяется по содержимому файла: заголовкам от клиента верить нельзя. */
function detectImageExt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function createApp(db, config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  fs.mkdirSync(config.uploadsDir, { recursive: true });
  app.use('/uploads', express.static(config.uploadsDir, { maxAge: '30d', immutable: true, dotfiles: 'deny', setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff') }));

  const api = express.Router();
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.use(authenticate(db, config));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });
  api.post('/uploads', upload.single('photo'), (req, res) => {
    const isPartner = db.prepare('SELECT 1 FROM venue_partners WHERE user_id = ? LIMIT 1').get(req.user.telegram_id);
    if (!isPartner && !req.isAdmin) throw forbidden();
    if (!req.file) throw new AppError(400, 'validation', 'Файл не получен');
    const ext = detectImageExt(req.file.buffer);
    if (!ext) throw new AppError(400, 'validation', 'Нужен файл JPG, PNG или WebP');
    const name = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(config.uploadsDir, name), req.file.buffer);
    res.status(201).json({ url: `/uploads/${name}` });
  });

  api.use('/partner', partnerRoutes(db, config));
  api.use('/admin', requireAdmin, adminRoutes(db, config));
  api.use(buyerRoutes(db, config));
  api.use((_req, _res, next) => next(notFound('Метод не найден')));
  app.use('/api', api);

  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Фото больше 5 МБ' : 'Не удалось загрузить файл';
      return res.status(400).json({ error: { code: 'upload', message } });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Некорректный запрос' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'server_error', message: 'Ошибка сервера. Попробуйте ещё раз.' } });
  });

  return app;
}
