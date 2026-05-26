import TelegramBot from 'node-telegram-bot-api';
import {
    attachTelegramDiagnostics,
    buildTelegramBotOptions,
    ensureTelegramProxy,
} from './telegram-proxy.mjs';

export function isTelegramSkipped() {
    if (process.env.SKIP_TELEGRAM === '1' || process.env.TEST_MODE === '1') return true;
    if (!process.env.TELEGRAM_TOKEN?.trim()) return true;
    return false;
}

export async function createTelegramBot({ onCommand } = {}) {
    if (isTelegramSkipped()) {
        console.log('[Telegram] отключён (SKIP_TELEGRAM / нет TELEGRAM_TOKEN)');
        return { bot: null, sendAlert: consoleAlert };
    }

    await ensureTelegramProxy();
    const token = process.env.TELEGRAM_TOKEN.trim();
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
    if (!chatId) {
        console.warn('[Telegram] нет TELEGRAM_CHAT_ID — только консоль');
        return { bot: null, sendAlert: consoleAlert };
    }

    const bot = new TelegramBot(token, buildTelegramBotOptions());
    attachTelegramDiagnostics(bot);

    async function sendAlert(message) {
        console.log(`🔔 ${message}`);
        try {
            await bot.sendMessage(chatId, message);
        } catch (e) {
            console.error('[Telegram] send:', e.message);
        }
    }

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

    console.log('✅ Telegram готов');
    return { bot, sendAlert, chatId };
}

function consoleAlert(message) {
    console.log(`🔔 ${message}`);
}
