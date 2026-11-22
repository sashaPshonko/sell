/**
 * Меню /cancel для покупателя с несколькими заказами: «какой отменить? 1️⃣ 70кк 2️⃣ 300кк 3️⃣ Все заказы».
 * Состояние меню — в сессии покупателя (`session.cancelMenu`), ответ — следующее сообщение покупателя.
 */
import { CANCEL_MENU_KEYS } from '../messages.mjs';

/** Сколько ждём ответ на меню. */
export const CANCEL_MENU_TTL_MS = Number(process.env.CANCEL_MENU_TTL_MS || 15 * 60_000);

const stripVs = (s) => String(s || '').replace(/️/g, '');

/**
 * Ответ покупателя на меню → номер пункта (1…n) или null, если это не выбор.
 * Понимает «1️⃣», «1⃣», «1», «1.», «1)», и «все» / «всё» / «все заказы» (= последний пункт).
 * @param {string} text
 * @param {number} n — сколько пунктов в меню (включая «Все заказы»)
 */
export function parseCancelChoice(text, n) {
    const t = stripVs(String(text || '').trim()).toLowerCase();
    if (!t) return null;
    const ki = CANCEL_MENU_KEYS.findIndex((k) => stripVs(k) === t);
    if (ki >= 0) return ki + 1 <= n ? ki + 1 : null;
    const m = /^(\d{1,2})\s*[.)]?$/.exec(t);
    if (m) {
        const v = Number(m[1]);
        return v >= 1 && v <= n ? v : null;
    }
    if (/^(все|всё)(\s+заказы)?[.!]?$/.test(t)) return n;
    return null;
}

/** Подписи заказов для меню: «70кк»; если суммы совпадают — добавляем время оплаты (МСК). */
export function cancelMenuLabels(orders) {
    const amounts = orders.map((o) => Math.round(Number(o.amountKk) || 0));
    return orders.map((o, i) => {
        const base = `${amounts[i]}кк`;
        const dup = amounts.filter((a) => a === amounts[i]).length > 1;
        if (!dup || !o.paidAt) return base;
        const d = new Date(Date.parse(o.paidAt) + 3 * 3600_000);
        const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        return `${base} (оплата в ${hm})`;
    });
}
