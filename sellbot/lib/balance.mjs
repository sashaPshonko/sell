/** Парсинг баланса из чата FunTime — как в 4NAREK/4NAREK.mjs */

export const BALANCE_CHAT_MARKER = '[$] Ваш баланс:';

export function parseChatPrice(text) {
    return parseInt(String(text).replace(/\./g, '').replace(/\D/g, ''), 10);
}

export function parseBalanceFromChat(text) {
    if (!text?.includes(BALANCE_CHAT_MARKER)) return null;
    const n = parseChatPrice(text);
    return Number.isFinite(n) ? n : null;
}
