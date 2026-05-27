/** Заказы старше окна до старта sell → legacy (не приветствуем повторно). */

import { isFulfillmentOpen } from './playerok-deal-sync.mjs';

const DEFAULT_GRACE_MS = 5 * 60 * 1000;

export function dealGraceMs() {
    const n = Number(process.env.DEAL_START_GRACE_MS);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_MS;
}

/** Каждый запуск `npm start` — своё окно (не берём старый pollStartedAt из state.json). */
export function ensurePollStarted(state) {
    if (state._sellSessionStartMs) {
        return state.pollStartedAt;
    }

    state._sellSessionStartMs = Date.now();
    state.pollStartedAt = new Date(state._sellSessionStartMs).toISOString();

    const min = Math.round(dealGraceMs() / 60_000);
    console.log(
        `[sell] обрабатываем оплаты за ~${min} мин до этого запуска и новее`,
    );
    return state.pollStartedAt;
}

export function getDealCutoffIso(state) {
    const explicit = process.env.PROCESS_DEALS_AFTER?.trim();
    if (explicit) return explicit;

    const startMs = state._sellSessionStartMs ?? Date.parse(state.pollStartedAt);
    if (!startMs || Number.isNaN(startMs)) return null;

    return new Date(startMs - dealGraceMs()).toISOString();
}

export function isStaleDeal(paid, cutoffIso) {
    if (!cutoffIso || !paid?.paidAt) return false;
    return Date.parse(paid.paidAt) < Date.parse(cutoffIso);
}

export function migrateStaleOrders(state, cutoffIso) {
    if (!cutoffIso) return;

    for (const o of Object.values(state.orders)) {
        if (!o?.paidAt) continue;

        const paidMs = Date.parse(o.paidAt);
        const cutoffMs = Date.parse(cutoffIso);

        if (paidMs >= cutoffMs) {
            if (o.phase === 'legacy') {
                o.phase = 'awaiting_nick';
                console.log(
                    `[sell] заказ ${String(o.orderId).slice(0, 8)}… снова в работе (окно ${Math.round(dealGraceMs() / 60_000)} мин)`,
                );
            }
            continue;
        }

        if (o.phase === 'completed' || o.phase === 'cancelled' || o.phase === 'legacy') {
            continue;
        }
        o.phase = 'legacy';
    }
}

export function isActionableOrder(order) {
    return isFulfillmentOpen(order);
}
