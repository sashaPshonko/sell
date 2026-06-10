/** Парсинг баланса из чата FunTime — как в 4NAREK/4NAREK.mjs */

export const BALANCE_CHAT_MARKER = '[$] Ваш баланс:';
export const CLAN_BALANCE_CHAT_MARKER = 'Баланс клана:';

export function parseChatPrice(text) {
    return parseInt(String(text).replace(/\./g, '').replace(/\D/g, ''), 10);
}

export function parseBalanceFromChat(text) {
    if (!text?.includes(BALANCE_CHAT_MARKER)) return null;
    const n = parseChatPrice(text);
    return Number.isFinite(n) ? n : null;
}

/** «[X] Баланс клана: 32077623» */
export function parseClanBalanceFromChat(text) {
    if (!text?.includes(CLAN_BALANCE_CHAT_MARKER)) return null;
    const n = parseChatPrice(text);
    return Number.isFinite(n) ? n : null;
}

/** «Игрок nick снял $1,000,000 из казны клана!» */
export function parseClanWithdrawAmount(text) {
    if (!text?.includes(' снял $') || !text?.includes(' из казны')) return null;
    const m = String(text).match(/ снял \$([\d.,]+)/);
    if (!m) return null;
    const n = parseChatPrice(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
}
