import TelegramBot from 'node-telegram-bot-api';
import {
    attachTelegramDiagnostics,
    buildTelegramBotOptions,
    ensureTelegramProxy,
} from './telegram-proxy.mjs';
import {
    SELLBOT_TG_TOKEN,
    SELLBOT_TG_CHAT_ID,
    buildSellbotTelegramText,
} from './telegram-alerts.mjs';

function isTelegramSkipped(telegram) {
    if (!telegram || telegram.skip) return true;
    return false;
}

export async function createTelegramBot({ telegram, onCommand } = {}) {
    const tg = telegram || {};

    if (isTelegramSkipped(tg)) {
        console.log('[Telegram] отключён (telegramSkip: true)');
        return { bot: null, sendAlert: consoleAlert };
    }

    const token = SELLBOT_TG_TOKEN;
    const chatId = SELLBOT_TG_CHAT_ID;
    const tgProxy = { ...tg, token, proxy: tg.proxy || 'off' };

    if (!(await ensureTelegramProxy(tgProxy))) {
        console.warn('[Telegram] прокси недоступен — только консоль');
        return { bot: null, sendAlert: consoleAlert };
    }

    const bot = new TelegramBot(token, buildTelegramBotOptions(tgProxy));
    attachTelegramDiagnostics(bot, tgProxy);

    async function sendAlert(message, opts = {}) {
        const text = buildSellbotTelegramText(message, opts);
        console.log(`🔔 ${text}`);
        try {
            await bot.sendMessage(chatId, text);
        } catch (e) {
            console.error('[Telegram] send:', e.message);
        }
    }

    bot.onText(/\/chatid/, async (msg) => {
        const id = String(msg.chat.id);
        await bot.sendMessage(id, `chatId: ${id} (sellbot шлёт в ${chatId})`);
        console.log(`[Telegram] /chatid → ${id}`);
    });

    try {
        await bot.sendMessage(chatId, '✅ Sellbot оркестратор запущен');
    } catch (e) {
        console.error('[Telegram] стартовое сообщение:', e.message);
    }

    if (onCommand) {
        for (const [pattern, handler] of Object.entries(onCommand)) {
            bot.onText(pattern, async (msg) => {
                if (Date.now() / 1000 - msg.date > 10) return;
                await handler(msg, sendAlert, bot);
            });
        }
    }

    console.log(`✅ Telegram готов (chat ${chatId}, токен захардкожен)`);
    return { bot, sendAlert, chatId };
}

function consoleAlert(message, opts = {}) {
    console.log(`🔔 ${buildSellbotTelegramText(message, opts)}`);
}
