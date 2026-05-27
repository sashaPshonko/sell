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

С Mac (проще всего):
  scp .env root@ТВОЙ_IP:~/sell/.env

Или вручную на VPS в .env добавь (F12 → Cookies → playerok.com):
  PLAYEROK_AUID=значение_из_cookie_auid
  PLAYEROK_DDG1=значение_из___ddg1___  (если есть)
`);
        process.exit(1);
    }

    const client = createClient();
    const v = await client.viewer();
    const chats = await client.userChats(v.viewer.id, 1);
    let chatId = chats.userChats?.edges?.[0]?.node?.id;
    if (!chatId) {
        const fromState = process.env.CHECK_CHAT_ID?.trim();
        if (!fromState) {
            console.warn(
                `[sell] ${v.viewer.username} — в списке 0 чатов, chatMessages не проверяли (задай CHECK_CHAT_ID=uuid чата)`,
            );
            return;
        }
        chatId = fromState;
    }
    await client.chatMessages(chatId, 1);
    console.log(`[sell] ${v.viewer.username} — PlayerOK чаты ок`);
}
