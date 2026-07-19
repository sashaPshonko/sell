/** Парсинг баланса из чата FunTime */

export const BALANCE_CHAT_MARKER = '[$] Ваш баланс:';
export const CLAN_BALANCE_CHAT_MARKER = 'Баланс клана:';

/** Цифры из фрагмента (точки/пробелы — разделители тысяч). Не склеивать всю строку. */
function digitsToInt(text) {
    const digits = String(text).replace(/\D/g, '');
    if (!digits) return NaN;
    return parseInt(digits, 10);
}

/**
 * Цена/сумма из куска текста. Нельзя склеивать ВСЕ цифры строки —
 * иначе «Баланс: 50.000.000» ок, но мусор в строке ломает число.
 */
export function parseChatPrice(text) {
    const s = String(text || '');
    const afterZa = s.match(/за\s*([\d.\s\u00a0,$]+)/i);
    if (afterZa) {
        const n = digitsToInt(afterZa[1]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    const afterBal = s.match(/баланс[^:]*:\s*([\d.\s\u00a0,$]+)/i);
    if (afterBal) {
        const n = digitsToInt(afterBal[1]);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    const groups = [...s.matchAll(/(\d(?:[\d.\s\u00a0]*\d)?)/g)]
        .map((m) => digitsToInt(m[1]))
        .filter((n) => Number.isFinite(n));
    if (groups.length) return groups[groups.length - 1];
    const n = digitsToInt(s);
    return Number.isFinite(n) ? n : NaN;
}

export function parseBalanceFromChat(text) {
    if (!text?.includes(BALANCE_CHAT_MARKER)) return null;
    const m = String(text).match(/баланс:\s*([\d.\s\u00a0,$]+)/i);
    const n = m ? digitsToInt(m[1]) : parseChatPrice(text);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/** «[X] Баланс клана: 32077623» */
export function parseClanBalanceFromChat(text) {
    if (!text?.includes(CLAN_BALANCE_CHAT_MARKER)) return null;
    const m = String(text).match(/Баланс клана:\s*([\d.\s\u00a0,$]+)/i);
    const n = m ? digitsToInt(m[1]) : parseChatPrice(text);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/** «Игрок nick снял $1,000,000 из казны клана!» */
export function parseClanWithdrawAmount(text) {
    if (!text?.includes(' снял $') || !text?.includes(' из казны')) return null;
    const m = String(text).match(/ снял \$([\d.,\s\u00a0]+)/);
    if (!m) return null;
    const n = digitsToInt(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
}
