import { createClient } from '../playerok-client.mjs';

export function hasPlayerokAuid() {
    return Boolean(process.env.PLAYEROK_AUID?.trim());
}

/** Проверка при старте: без auid chatMessages всегда «нет доступа» */
export async function assertPlayerokAuth() {
    if (!process.env.PLAYEROK_TOKEN?.trim()) {
        console.error('[sell] В .env нет PLAYEROK_TOKEN');
        process.exit(3);
    }
    if (!hasPlayerokAuid()) {
        console.error(`
[sell] В .env нет PLAYEROK_AUID — чаты не откроются.

В .env должны быть:
  PLAYEROK_TOKEN=...
  PLAYEROK_AUID=...   (cookie auid на playerok.com)
  PLAYEROK_DDG1=...   (опционально)

PLAYEROK_COOKIES в .env не нужен.
`);
        process.exit(3);
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

    const chatsData = await client.userChats(sellerId, 5);
    let chatId =
        chatsData.chats?.edges?.[0]?.node?.id ||
        chatsData.userChats?.edges?.[0]?.node?.id;
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
        process.exit(3);
    }

    try {
        await client.chatMessages(chatId, Number(process.env.CHAT_MESSAGES_FIRST || 20));
    } catch (e) {
        const msg = e.message || String(e);
        console.error(`[sell] chatMessages НЕ работает: ${msg}`);
        if (/PaginationInput|sha does not match|PersistedQueryNotFound/i.test(msg)) {
            console.error('[sell] git pull в ~/sell (нужен queries/chatMessages.graphql с Pagination!)');
            console.error('[sell] или убери CHAT_MESSAGES_HASH из .env — будет POST без hash');
        } else if (/401|403|Unauthorized|Forbidden|access/i.test(msg)) {
            console.error('[sell] Обнови TOKEN и AUID из F12 → Cookies → playerok.com');
        } else {
            console.error('[sell] TOKEN/AUID или query — см. ошибку выше');
        }
        process.exit(3);
    }

    console.log(`[sell] ${v.viewer.username} — PlayerOK чаты ок`);
}
