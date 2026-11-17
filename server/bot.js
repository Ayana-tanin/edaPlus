import { Bot, InlineKeyboard } from 'grammy';
import { upsertUser } from './auth.js';

const WELCOME =
  'Привет! Это <b>eda+</b> 🥐\n\n' +
  'Заведения рядом продают нераспроданную еду со скидкой. ' +
  'Выберите набор, забронируйте его и заберите сами, оплата при получении.';

export function createBot(db, config) {
  const bot = new Bot(config.botToken);
  const canOpenApp = config.webappUrl.startsWith('https://');
  if (!canOpenApp) {
    console.warn('[bot] WEBAPP_URL должен начинаться с https://, иначе Telegram не откроет Mini App. Кнопки отключены.');
  }

  const appButton = (label, path = '') =>
    canOpenApp ? new InlineKeyboard().webApp(label, `${config.webappUrl}${path}`) : undefined;

  bot.command('start', async (ctx) => {
    if (ctx.from) upsertUser(db, ctx.from);
    const keyboard = appButton('Открыть eda+');
    if (keyboard && ctx.from) {
      const isMainAdmin = config.adminIds.has(ctx.from.id);
      if (isMainAdmin) keyboard.row().webApp('Главный админ', `${config.webappUrl}/admin`);
      const isCafeAdmin = db.prepare('SELECT 1 FROM venue_partners WHERE user_id = ? LIMIT 1').get(ctx.from.id);
      if (isMainAdmin || isCafeAdmin) keyboard.row().webApp('Кабинет кафе', `${config.webappUrl}/partner`);
    }
    await ctx.reply(WELCOME, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // Telegram ID нужен администратору, чтобы выдать доступ партнёру.
  bot.command('id', (ctx) =>
    ctx.reply(`Ваш Telegram ID: <code>${ctx.from?.id}</code>`, { parse_mode: 'HTML' }),
  );

  bot.catch((err) => console.error('[bot]', err.error ?? err));

  return {
    async start() {
      await bot.api.setMyCommands([
        { command: 'start', description: 'Открыть eda+' },
        { command: 'id', description: 'Показать мой Telegram ID' },
      ]);
      if (canOpenApp) {
        await bot.api.setChatMenuButton({
          menu_button: { type: 'web_app', text: 'Открыть eda+', web_app: { url: config.webappUrl } },
        });
      }
      bot.start({ onStart: (me) => console.log(`[bot] запущен как @${me.username}`) }).catch((err) => {
        console.error('[bot] polling остановлен:', err.message);
      });
    },
    stop: () => bot.stop(),
    send(telegramId, text, buttonPath) {
      const reply_markup = buttonPath ? appButton('Открыть в eda+', buttonPath) : undefined;
      return bot.api.sendMessage(telegramId, text, { parse_mode: 'HTML', reply_markup });
    },
  };
}
