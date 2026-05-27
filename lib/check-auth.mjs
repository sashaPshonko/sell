import { createClient } from '../playerok-client.mjs';

export function hasPlayerokAuid() {
    if (process.env.PLAYEROK_AUID?.trim()) return true;
    return /(?:^|;\s*)auid=/i.test(process.env.PLAYEROK_COOKIES || '');
}

/** Проверка при старте: без auid chatMessages всегда «нет доступа» */
export async function assertPlayerokAuth() {
    if (!process.env.PLAYEROK_TOKEN?.trim()) {
        console.error('[sell] В .env нет PLAYEROK_TOKEN');
        process.exit(1);
    }
    if (!hasPlayerokAuid()) {
        console.error(`
[sell] В .env нет PLAYEROK_AUID — чаты не откроются.

В .env должны быть:
  PLAYEROK_TOKEN=...
  PLAYEROK_AUID=...   (cookie auid на playerok.com)
  PLAYEROK_DDG1=...   (опционально)

Удали строку PLAYEROK_COOKIES= если там только token.
`);
        process.exit(1);
    }

    const client = createClient();
    const v = await client.viewer();
    const sellerId = v.viewer.id;

    const envUserId = process.env.PLAYEROK_USER_ID?.trim();
    if (envUserId && envUserId !== sellerId) {
        console.warn(
            `[sell] PLAYEROK_USER_ID в .env не совпадает с аккаунтом (${v.viewer.username}) — игнорируем`,
        );
    }

    const chats = await client.userChats(sellerId, 5);
    let chatId = chats.userChats?.edges?.[0]?.node?.id;
    if (!chatId) {
        chatId = process.env.CHECK_CHAT_ID?.trim();
        if (chatId) {
            console.warn(`[sell] список чатов пуст — проверяем CHECK_CHAT_ID`);
        }
    }
    if (!chatId) {
        console.error(
            `[sell] ${v.viewer.username} — нет чатов (задай CHECK_CHAT_ID=uuid в .env)`,
        );
        process.exit(1);
    }

    try {
        await client.chatMessages(chatId, 2);
    } catch (e) {
        console.error(`[sell] chatMessages НЕ работает: ${e.message}`);
        console.error('[sell] Обнови TOKEN и AUID из F12 → Cookies → playerok.com');
        process.exit(1);
    }

    console.log(`[sell] ${v.viewer.username} — PlayerOK чаты ок`);
}
