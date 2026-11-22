/**
 * Объединение заказов одного покупателя в один перевод.
 *
 * Пока заказ не ушёл в выдачу, все его «соседи» (тот же чат и покупатель, ещё не выданы)
 * едут одним переводом: сумма = Σ payAmountKk (бонус каждого заказа уже выпал и входит в payAmountKk).
 * Основной заказ (primary) уходит в sellbot с общей суммой и держит `mergedOrderIds`;
 * остальные получают `mergedInto` и в sellbot не отправляются.
 *
 * Жизненный цикл:
 *  - delivery_ok по основному → markMergedDelivered (сразу, синхронно) → отметки на PlayerOK.
 *  - основной на паузе (неверный ник, бан бота, лимит попыток) → группа ждёт его и уходит одним переводом.
 *  - основному не хватило валюты → группа распускается, заказы ждут ника и уходят по отдельности.
 *  - основной отменён → приклеенные отвязываются и выдаются сами.
 *  - основной закрыт без выдачи на PlayerOK → приклеенные отвязываются и выдаются сами.
 *  - основной закрыт по таймауту (dispatch_stale) → приклеенные закрываются так же.
 *  - пока общий перевод в sellbot, /cancel по заказам группы запрещён (isMergedGroupInDelivery):
 *    sell-orch не умеет менять сумму уже принятого перевода.
 *  - приклеенный отменён до передачи в sellbot (или возвратом на PlayerOK) → убирается из группы,
 *    сумма следующей отправки считается без него (mergedTotalPay).
 *
 * Отключить: MERGE_ORDERS=0.
 */

import { getOrder, ordersInChat, setOrderPhase } from '../state.mjs';
import { canAffordOrder } from './bot-balance.mjs';
import { applyOrderPayBonus } from './pay-bonus.mjs';
import {
    canDispatchToSellbot,
    isBotFatalPaused,
    isOrderFulfilled,
    playerokNeedsDelivery,
} from './playerok-deal-sync.mjs';

export function mergeEnabled() {
    return String(process.env.MERGE_ORDERS ?? '1').trim() !== '0';
}

const idOf = (o) => o?.orderId || o?.dealId;
const payKk = (o) => Number(o?.payAmountKk ?? o?.amountKk) || 0;
const short = (id) => `${String(id).slice(0, 8)}…`;

/** Основной заказ ещё в выдаче (его перевод может состояться). */
export function isMergePrimaryLive(primary) {
    if (!primary || isOrderFulfilled(primary) || primary.pausedUntilNick) return false;
    return primary.phase === 'dispatched' || primary.phase === 'ws_pending';
}

/** Заказы, которые можно приклеить к `order`: тот же чат и покупатель, выдача ещё не начата. */
export function mergeCandidates(state, order) {
    const self = idOf(order);
    const chatId = order?.chatId;
    const buyerId = order?.buyerId;
    if (!self || !chatId || !buyerId) return [];
    return ordersInChat(state, chatId).filter((o) => {
        if (idOf(o) === self || o.buyerId !== buyerId) return false;
        if (o.mergedInto || (o.mergedOrderIds && o.mergedOrderIds.length)) return false;
        if (isOrderFulfilled(o) || isBotFatalPaused(o) || o.pausedUntilNick) return false;
        if (o.phase === 'dispatched' || o.phase === 'ws_pending') return false;
        if (o.phase === 'completed' || o.phase === 'cancelled') return false;
        if (o.playerokStatus && !playerokNeedsDelivery(o.playerokStatus)) return false;
        if (!(Number(o.amountKk) > 0)) return false;
        return canDispatchToSellbot(o);
    });
}

/**
 * Склеить `primary` с подходящими соседями. Возвращает { total, ids } или null (нечего клеить / не хватит валюты).
 */
export function mergeIntoPrimary(state, primary, nick) {
    if (!mergeEnabled()) return null;
    const pid = idOf(primary);
    const base = getOrder(state, pid) || primary;
    if (base.mergedInto || (base.mergedOrderIds && base.mergedOrderIds.length)) return null;
    const siblings = mergeCandidates(state, { ...base, ...primary, orderId: pid });
    if (!siblings.length) return null;
    siblings.sort((a, b) => Date.parse(a.paidAt || 0) - Date.parse(b.paidAt || 0));
    for (const s of siblings) applyOrderPayBonus(state, s);
    const own = payKk(getOrder(state, pid) || base);
    const total = own + siblings.reduce((sum, s) => sum + payKk(getOrder(state, idOf(s)) || s), 0);
    if (!canAffordOrder(state, { payAmountKk: total })) {
        console.log(`[sell] объединение ${short(pid)}: ${total}kk не хватает на балансе — идут отдельно`);
        return null;
    }
    const ids = siblings.map(idOf);
    setOrderPhase(state, pid, base.phase, { mergedOrderIds: ids });
    const now = new Date().toISOString();
    for (const sid of ids) {
        setOrderPhase(state, sid, 'dispatched', {
            mergedInto: pid,
            nick,
            dispatchedAt: now,
            lastError: null,
            pausedUntilNick: false,
        });
    }
    console.log(
        `[sell] объединение: ${short(pid)} + ${ids.map(short).join(', ')} → один перевод ${total}kk`,
    );
    return { total, ids };
}

/** Приклеенные к основному заказы, ещё не закрытые. */
function liveMembers(state, pid) {
    const base = getOrder(state, pid);
    return (base?.mergedOrderIds || [])
        .map((sid) => getOrder(state, sid))
        .filter((s) => s && s.mergedInto === pid && !isOrderFulfilled(s));
}

/** Общая сумма перевода основного заказа (его + приклеенные, ещё не закрытые). */
export function mergedTotalPay(state, primary) {
    const pid = idOf(primary);
    const base = getOrder(state, pid) || primary;
    return payKk(base) + liveMembers(state, pid).reduce((sum, s) => sum + payKk(s), 0);
}

/**
 * Отвязать заказ от основного — заказ снова сам по себе.
 * `pauseFrom` — основной на паузе «мало валюты»: заказ встаёт на ту же паузу (без повторной подсказки
 * покупателю) и после нового ника уйдёт отдельным, меньшим переводом.
 */
function release(state, sid, why, pauseFrom = null) {
    const s = getOrder(state, sid);
    if (!s || isOrderFulfilled(s)) return;
    const patch = {
        mergedInto: undefined,
        dispatchedAt: undefined,
        dispatchAckSentAt: undefined,
        queueStatusSentAt: undefined,
    };
    if (pauseFrom) {
        Object.assign(patch, {
            pausedUntilNick: true,
            lastError: pauseFrom.lastError ?? null,
            deliveryHintSentAt: pauseFrom.deliveryHintSentAt,
            nick: pauseFrom.nick ?? s.nick ?? null,
        });
    }
    setOrderPhase(state, sid, 'awaiting_nick', patch);
    console.log(`[sell] объединение: ${short(sid)} отвязан (${why})`);
}

/**
 * Сразу после delivery_ok по основному: закрыть приклеенные (синхронно, до любых await),
 * чтобы ни один путь не успел отправить их отдельным переводом. Возвращает их id.
 */
export function markMergedDelivered(state, primary) {
    const pid = idOf(primary);
    const now = new Date().toISOString();
    const ids = [];
    for (const s of liveMembers(state, pid)) {
        setOrderPhase(state, idOf(s), 'completed', { gameDeliveryAt: now, buyerNotifiedAt: now });
        ids.push(idOf(s));
    }
    return ids;
}

/**
 * Заказ входит в группу, чей общий перевод уже передан в sellbot (фаза dispatched).
 * Такой заказ нельзя отменить: sell-orch не пересобирает перевод (повторная отправка того же id
 * игнорируется), а отмена основного посреди выдачи может потерять или задвоить выплату.
 */
export function isMergedGroupInDelivery(state, order) {
    const id = idOf(order);
    const cur = getOrder(state, id) || order;
    const pid = cur?.mergedInto || ((cur?.mergedOrderIds || []).length ? id : null);
    if (!pid) return false;
    const prim = getOrder(state, pid);
    if (!prim || isOrderFulfilled(prim) || prim.pausedUntilNick) return false;
    if (prim.phase !== 'dispatched') return false;
    return liveMembers(state, pid).length > 0;
}

/**
 * Подчистка объединений (раз за проход poll).
 * @returns {{ finish: Array<{sid: string, pid: string}> }}
 *   finish — основной доставлен, а приклеенные не закрыты (delivery_ok потерян/прерван) → отметить на PlayerOK.
 */
export function healMergedOrders(state) {
    const finish = [];
    const orders = Object.values(state?.orders || {});

    // 1) Приклеенный отменён (возврат на PlayerOK, /cancel пока группа не в sellbot) — из группы убираем.
    //    Если общий перевод уже в sellbot, его сумму не пересобрать: пишем в лог (возможна переплата).
    for (const o of orders) {
        if (!o?.mergedInto || o.gameDeliveryAt || o.buyerNotifiedAt) continue;
        if (o.phase !== 'cancelled') continue;
        const pid = o.mergedInto;
        const prim = getOrder(state, pid);
        setOrderPhase(state, idOf(o), o.phase, { mergedInto: undefined });
        if (prim && isMergePrimaryLive(prim) && prim.phase === 'dispatched') {
            console.warn(
                `[sell] объединение: ${short(idOf(o))} отменён, а общий перевод ${short(pid)} уже в sellbot — его сумма уйдёт покупателю (проверь)`,
            );
        } else {
            console.log(`[sell] объединение: ${short(idOf(o))} отменён — убран из группы ${short(pid)}`);
        }
    }

    // 2) Приклеенные, чей основной больше не в выдаче.
    for (const o of orders) {
        const sid = idOf(o);
        if (!o?.mergedInto || isOrderFulfilled(o)) continue;
        const pid = o.mergedInto;
        const prim = getOrder(state, pid);
        if (!prim) {
            release(state, sid, 'основной заказ пропал');
            continue;
        }
        if (isMergePrimaryLive(prim)) continue;
        if (prim.gameDeliveryAt || prim.buyerNotifiedAt) {
            // основной доставлен — приклеенный ехал в том же переводе
            const now = new Date().toISOString();
            setOrderPhase(state, sid, 'completed', { gameDeliveryAt: now, buyerNotifiedAt: now });
            finish.push({ sid, pid });
            continue;
        }
        if (prim.phase === 'completed' && prim.stuckDispatchedAt) {
            // перевод так и не дошёл за DISPATCH_STALE_MS — закрываем так же, как закрылся бы отдельный заказ
            setOrderPhase(state, sid, 'completed', {
                stuckDispatchedAt: new Date().toISOString(),
                lastError: 'dispatch_stale',
            });
            console.log(`[sell] объединение: ${short(sid)} → completed вместе с ${short(pid)} (dispatch_stale)`);
            continue;
        }
        const paused = !isOrderFulfilled(prim) && (prim.pausedUntilNick || isBotFatalPaused(prim));
        if (paused && prim.lastError !== 'insufficient_funds') {
            // неверный ник / бан бота / лимит попыток — группа ждёт основного: после нового ника
            // или восстановления бота основной уйдёт снова с общей суммой
            continue;
        }
        if (paused) {
            // мало валюты на общую сумму — распускаем, по отдельности заказы могут пройти
            release(state, sid, `основной ${short(pid)}: мало валюты на общую сумму`, prim);
        } else {
            // основной отменён / закрыт на PlayerOK без выдачи / вернулся в ожидание → приклеенный выдаётся сам
            release(state, sid, `основной ${short(pid)} в фазе ${prim.phase}`);
        }
        if (prim.mergedOrderIds?.length && !liveMembers(state, pid).length) {
            setOrderPhase(state, pid, prim.phase, { mergedOrderIds: undefined });
        }
    }
    return { finish };
}
