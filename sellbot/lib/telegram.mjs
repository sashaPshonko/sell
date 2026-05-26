import TelegramBot from 'node-telegram-bot-api';
import {
    attachTelegramDiagnostics,
    buildTelegramBotOptions,
    ensureTelegramProxy,
} from './telegram-proxy.mjs';

function isTelegramSkipped(telegram) {
    if (!telegram || telegram.skip) return true;
    if (!telegram.token?.trim()) return true;
    return false;
}

/** Если chatId не задан — последний чат из getUpdates (сначала напиши боту /start) */
async function resolveChatId(token, chatId) {
    if (chatId?.trim()) return chatId.trim();

    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`);
        const data = await res.json();
        if (!data.ok) {
            console.warn('[Telegram] getUpdates:', data.description || 'ошибка');
            return null;
        }
        const updates = data.result || [];
        for (let i = updates.length - 1; i >= 0; i--) {
            const u = updates[i];
            const id =
                u.message?.chat?.id ??
                u.callback_query?.message?.chat?.id ??
                u.my_chat_member?.chat?.id;
            if (id != null) {
                console.log(
                    `[Telegram] chatId из getUpdates: ${id} (можно прописать telegramChatId в bot.json)`,
                );
                return String(id);
            }
        }
    } catch (e) {
        console.warn('[Telegram] getUpdates:', e.message);
    }
    return null;
}

export async function createTelegramBot({ telegram, onCommand } = {}) {
    const tg = telegram || {};

    if (isTelegramSkipped(tg)) {
        console.log('[Telegram] отключён (нет telegramToken в bot.json или telegramSkip: true)');
        return { bot: null, sendAlert: consoleAlert };
    }

    const token = tg.token.trim();
    const tgProxy = { ...tg, token };

    if (!(await ensureTelegramProxy(tgProxy))) {
        console.warn('[Telegram] прокси недоступен — только консоль');
        return { bot: null, sendAlert: consoleAlert };
    }

    let chatId = await resolveChatId(token, tg.chatId);
    if (!chatId) {
        console.warn(
            '[Telegram] нет telegramChatId — напиши боту /start в Telegram и перезапусти sellbot',
        );
        return { bot: null, sendAlert: consoleAlert };
    }

    const bot = new TelegramBot(token, buildTelegramBotOptions(tgProxy));
    attachTelegramDiagnostics(bot, tgProxy);

    async function sendAlert(message) {
        console.log(`🔔 ${message}`);
        try {
            await bot.sendMessage(chatId, message);
        } catch (e) {
            console.error('[Telegram] send:', e.message);
        }
    }

    bot.onText(/\/chatid/, async (msg) => {
        const id = String(msg.chat.id);
        await bot.sendMessage(id, `chatId: ${id}`);
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

    console.log(`✅ Telegram готов (chat ${chatId})`);
    return { bot, sendAlert, chatId };
}

function consoleAlert(message) {
    console.log(`🔔 ${message}`);
}
