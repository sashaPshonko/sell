import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../lib/env.mjs';
import { acquirePidLock } from '../lib/pid-lock.mjs';
import { audit } from '../lib/audit.mjs';
import * as ws from '../lib/ws-client.mjs';
import { parseNickFromText, looksLikeInvalidNickAttempt } from '../parse.mjs';
import { DELIVERY_ANARCHY } from '../config.mjs';
import { FunPayClient, FunPayError } from './client.mjs';
import { computeOrderKk, parseMinKk } from './amount.mjs';
import * as T from './texts.mjs';

/**
 * Автовыдача FunPay: тот же sell-orch (WS :8790), что и у PlayerOK, но свой процесс и свой state.
 *
 *   новая оплата → приветствие в чат → ник от покупателя → pushOrder в оркестратор →
 *   событие delivery_ok → «выдано» в чат. Подтверждать заказ самим не нужно (подтверждает покупатель).
 *
 * Режимы:  FUNPAY_LIVE=1 — писать в чат и отправлять заказы боту;
 *          иначе (по умолчанию) — только наблюдение: читает заказы/чаты, всё логирует, ничего не шлёт.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv();
acquirePidLock(process.env.FUNPAY_POLL_LOCK || '/tmp/sell-funpay.pid', 'funpay', { processPattern: 'funpay/poll.mjs' });

const LIVE = process.env.FUNPAY_LIVE === '1';
const SALES_MS = Number(process.env.FUNPAY_POLL_MS || 8000);
const CHAT_MS = Number(process.env.FUNPAY_CHAT_MS || 5000);
const REINIT_MS = 45 * 60 * 1000;
const STATE_FILE = process.env.FUNPAY_STATE_FILE || join(ROOT, 'funpay-state.json');
const LOG_FILE = join(ROOT, 'funpay-orders.jsonl');
const PREFIX = 'fp-';
const MIN_SEND_GAP_MS = 1500;
// одиночные слова, которые не считаем ником (покупатели пишут «yes», «ok» и т.п. в ответ на приветствие)
const NOT_NICKS = new Set(['yes', 'no', 'ok', 'okay', 'oke', 'hi', 'hey', 'hello', 'thx', 'thanks', 'thank', 'ty', 'lol', 'ща', 'wait', 'sec', 'done', 'here', 'online', 'ready', 'now', 'pls', 'please', 'ping', 'test']);
function nickFrom(text) {
    const p = parseNickFromText(text);
    if (!p) return null;
    if (p.via === 'bare' && NOT_NICKS.has(p.nick.toLowerCase())) return null;
    return p.nick;
}

const log = (...a) => console.log(`[funpay${LIVE ? '' : ' DRY'}]`, ...a);

// ───────────── state ─────────────
function loadState() {
    if (!existsSync(STATE_FILE)) return { orders: {}, seeded: false };
    try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
        log(`state повреждён (${e.message}) — стартую с пустого, старые оплаты будут пропущены`);
        return { orders: {}, seeded: false };
    }
}
const state = loadState();
function saveState() {
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
}
function journal(row) {
    appendFileSync(LOG_FILE, `${JSON.stringify({ t: new Date().toISOString(), ...row })}\n`);
}

// ───────────── отправка в чат (с паузой между сообщениями) ─────────────
let lastSendAt = 0;
async function say(client, order, text, tag) {
    if (!LIVE) {
        log(`(не отправляю) → #${order.id} ${tag}: ${text.split('\n')[0]}`);
        return false;
    }
    const wait = lastSendAt + MIN_SEND_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
        await client.sendMessage(order.node, text);
        lastSendAt = Date.now();
        return true;
    } catch (e) {
        log(`чат #${order.id} ${tag}: ${e.message}`);
        if (e.kind === 'flood') lastSendAt = Date.now() + 5000;
        return false;
    }
}

/** Подсказку каждого вида шлём не чаще раза в 2 минуты на заказ (бот повторяет события). */
async function hintOnce(client, order, key, text) {
    const now = Date.now();
    order.hints = order.hints || {};
    if (order.hints[key] && now - order.hints[key] < 120_000) return;
    order.hints[key] = now;
    await say(client, order, text, key);
}

// ───────────── заказ → бот ─────────────
function dispatch(order, { resync = false } = {}) {
    if (!LIVE) {
        log(`(не отправляю боту) #${order.id}: ${order.nick} ← ${order.amountKk}кк`);
        return;
    }
    ws.pushOrder({
        orderId: order.orderId,
        dealId: order.orderId,
        chatId: order.node,
        buyer: order.buyerName,
        buyerId: String(order.buyerId),
        nick: order.nick,
        amount: order.amountKk,
        paidAtMs: order.paidAtMs,
        anarchy: DELIVERY_ANARCHY,
        itemName: `${order.amountKk}KK FUNTIME`,
        resync: resync || undefined,
    });
}

async function onNick(client, order, nick) {
    if (order.phase === 'manual' || order.phase === 'delivered' || order.phase === 'refunded') return;
    const prev = order.nick;
    order.nick = nick;
    if (order.phase === 'awaiting_nick') {
        order.phase = 'dispatched';
        order.dispatchedAt = Date.now();
        journal({ ev: 'dispatch', order: order.id, nick, amountKk: order.amountKk });
        audit('funpay_dispatch', { orderId: order.orderId, nick, amountKk: order.amountKk });
        dispatch(order);
        await say(client, order, T.nickAccepted(nick, order.amountKk), 'nick_ok');
    } else if (order.phase === 'dispatched' && prev !== nick) {
        if (LIVE) ws.pushNickUpdate(order.orderId, nick);
        else log(`(не отправляю боту) #${order.id}: смена ника → ${nick}`);
        await say(client, order, T.nickChanged(nick), 'nick_change');
    }
    saveState();
}

// ───────────── возврат заказов меньше минимума ─────────────
async function refundTooSmall(client, order, minKk) {
    if (!LIVE) {
        log(`(не отправляю) #${order.id}: ${order.amountKk}кк < ${minKk}кк — был бы возврат + сообщение`);
        order.phase = 'refunded_dry';
        saveState();
        return;
    }
    try {
        await client.refund(order.id);
        order.phase = 'refunded';
        journal({ ev: 'refund', order: order.id, amountKk: order.amountKk, reason: 'too_small' });
        log(`возврат #${order.id}: ${order.amountKk}кк < ${minKk}кк`);
        await say(client, order, T.refundedTooSmall(order.amountKk, minKk), 'refund');
    } catch (e) {
        order.phase = 'manual';
        order.manualReason = `возврат не удался: ${e.message}`;
        log(`ВОЗВРАТ НЕ УДАЛСЯ #${order.id}: ${e.message} — нужен ручной возврат`);
        await say(client, order, T.tooSmallManual(order.amountKk, minKk), 'refund_manual');
    }
    saveState();
}

// ───────────── возврат: аккаунт FunPay младше N дней ─────────────
// FUNPAY_MIN_ACCOUNT_DAYS (по умолчанию 90; 0 — проверка выключена).
const MIN_ACCOUNT_DAYS = Number(process.env.FUNPAY_MIN_ACCOUNT_DAYS ?? 90);

/** Дата регистрации покупателя (кэш в state.buyerReg). null — не удалось узнать (тогда не блокируем). */
async function buyerRegisteredAt(client, buyerId) {
    state.buyerReg = state.buyerReg || {};
    if (state.buyerReg[buyerId]) return state.buyerReg[buyerId];
    try {
        const ts = await client.getUserRegisteredAt(buyerId);
        if (ts) state.buyerReg[buyerId] = ts;
        else log(`профиль ${buyerId}: дату регистрации не распознал — проверку возраста пропускаю`);
        return ts;
    } catch (e) {
        log(`профиль ${buyerId}: не открылся (${e.message}) — проверку возраста пропускаю`);
        return null;
    }
}

// Новорегов не возвращаем сами: сообщение «через поддержку», заказ уходит в ручной (manual), возврат — только через поддержку FunPay.
async function refundYoungAccount(client, order, days, ageDays) {
    if (!LIVE) {
        log(`(не отправляю) #${order.id}: аккаунт ${order.buyerName} ${ageDays} дн. < ${days} — было бы сообщение «через поддержку»`);
        order.phase = 'refunded_dry';
        saveState();
        return;
    }
    order.phase = 'manual';
    order.manualReason = `аккаунт младше ${days} дн. (${ageDays} дн.), возврат только через поддержку FunPay`;
    journal({ ev: 'young_account', order: order.id, amountKk: order.amountKk, accountAgeDays: ageDays });
    log(`новорег #${order.id}: аккаунт ${order.buyerName} ${ageDays} дн. < ${days} — автовозврата нет, написал про поддержку`);
    saveState();
    await say(client, order, T.youngAccountManual(days), 'young_account');
}

// ───────────── новые оплаты ─────────────
async function handleNewOrder(client, so) {
    let details;
    try {
        details = await client.getOrderDetails(so.id);
    } catch (e) {
        log(`#${so.id}: не получил детали заказа (${e.message}) — повторю позже`);
        return;
    }
    // минимальная выдача: из описания заказа, иначе из текущего лота, иначе FUNPAY_MIN_KK / 200
    const minKk =
        parseMinKk(details.shortDescription) ??
        parseMinKk(details.fullDescription) ??
        parseMinKk(so.description) ??
        currentMinKk();
    // количество берём с двух мест: страница заказа («Количество») и хвост описания в списке продаж («… , 130 шт.»);
    // если оба есть и не совпали — не рискуем (ни выдача, ни возврат), ручной режим
    const m = String(so.description || '').match(/(\d[\d\s.,]*)\s*шт\.?\s*$/);
    const listQty = m ? Number(m[1].replace(/\s/g, '').replace(',', '.')) : null;
    let quantity = details.quantity ?? listQty;
    let mismatch = null;
    if (details.quantity != null && listQty != null && details.quantity !== listQty) {
        mismatch = `количество не сходится: страница ${details.quantity}, список ${listQty}`;
        quantity = null;
    }
    const calc = computeOrderKk({
        shortDescription: details.shortDescription,
        fullDescription: details.fullDescription,
        description: so.description,
        quantity,
    }, { minKk });
    if (mismatch) calc.reason = mismatch;
    const node = client.chatNode(so.buyerId);
    const order = {
        id: so.id,
        orderId: `${PREFIX}${so.id}`,
        buyerId: so.buyerId,
        buyerName: so.buyerName,
        node,
        description: so.description,
        quantity: calc.quantity,
        unitKk: calc.unitKk,
        amountKk: calc.amountKk,
        phase: calc.ok ? 'awaiting_nick' : calc.tooSmall ? 'refunding' : 'manual',
        manualReason: calc.ok ? undefined : calc.reason,
        paidAtMs: Date.now(),
        lastMsgId: -1,
        nick: null,
    };
    state.orders[so.id] = order;
    journal({ ev: 'paid', order: so.id, buyer: so.buyerName, description: so.description, quantity: calc.quantity, amountKk: calc.amountKk, ok: calc.ok, reason: calc.reason, params: details.params });
    log(`новая оплата #${so.id} ${so.buyerName}: «${so.description}» ×${calc.quantity} → ${calc.amountKk}кк${calc.ok ? '' : ` — РУЧНОЙ РЕЖИМ (${calc.reason})`}`);
    if (calc.tooSmall) {
        await refundTooSmall(client, order, minKk);
        return;
    }
    if (calc.ok && MIN_ACCOUNT_DAYS > 0 && so.buyerId) {
        const regAt = await buyerRegisteredAt(client, so.buyerId);
        const ageDays = regAt ? Math.floor((Date.now() - regAt) / 86_400_000) : null;
        if (ageDays !== null && ageDays < MIN_ACCOUNT_DAYS) {
            await refundYoungAccount(client, order, MIN_ACCOUNT_DAYS, ageDays);
            return;
        }
    }
    if (!calc.ok) {
        saveState();
        return;
    }

    // Ник мог прийти до нашего приветствия: берём сообщения покупателя после системного «оплатил заказ #ID».
    let candidate = null;
    try {
        const hist = await client.getChatHistory(node, -1);
        order.lastMsgId = hist.reduce((m, x) => Math.max(m, x.id), -1);
        let from = -1;
        hist.forEach((m, i) => {
            if (m.system && m.text.includes(so.id)) from = i;
        });
        // маркер оплаты не найден — не берём старые сообщения за ник (покупатель мог писать раньше про другой заказ)
        for (const m of from >= 0 ? hist.slice(from + 1) : []) {
            if (m.author === so.buyerId) {
                const n = nickFrom(m.text);
                if (n) candidate = n;
            }
        }
    } catch (e) {
        log(`#${so.id}: чат не прочитан (${e.message})`);
    }
    saveState();
    await say(client, order, T.greeting(order.id, order.amountKk), 'greeting');
    if (candidate) await onNick(client, order, candidate);
}

// ───────────── чат активных заказов ─────────────
const ACTIVE = new Set(['awaiting_nick', 'dispatched']);

async function pollChat(client, order) {
    const age = Date.now() - order.paidAtMs;
    const every = age < 30 * 60_000 ? CHAT_MS : 30_000;
    if (order.lastChatAt && Date.now() - order.lastChatAt < every) return;
    order.lastChatAt = Date.now();

    const msgs = await client.getChatHistory(order.node, order.lastMsgId);
    for (const m of msgs) {
        if (m.id <= order.lastMsgId) continue;
        order.lastMsgId = Math.max(order.lastMsgId, m.id);
        if (m.author !== order.buyerId) continue;
        const n = nickFrom(m.text);
        if (n) {
            await onNick(client, order, n);
        } else if (order.phase === 'awaiting_nick' && looksLikeInvalidNickAttempt(m.text)) {
            await hintOnce(client, order, 'wrong_nick', T.wrongNick());
        }
    }
}

// ───────────── минимальная выдача из описания лота ─────────────
function currentMinKk() {
    return state.lotMinKk || Number(process.env.FUNPAY_MIN_KK || 200);
}

async function refreshLotMin(client) {
    try {
        const lots = await client.getOwnLots();
        const mins = lots.map((l) => parseMinKk(l.description)).filter((x) => x != null);
        const min = mins.length ? Math.min(...mins) : null;
        if (min !== (state.lotMinKk ?? null)) {
            log(`минимальная выдача из описания лота: ${state.lotMinKk ?? '—'} → ${min ?? '— (по умолчанию ' + (process.env.FUNPAY_MIN_KK || 200) + ')'}кк`);
            state.lotMinKk = min;
            saveState();
        }
    } catch (e) {
        log(`лоты не прочитаны: ${e.message}`);
    }
}

// ───────────── автоответ тем, кто пишет до покупки ─────────────
const AUTOREPLY_ON = process.env.FUNPAY_AUTOREPLY !== '0';
const AUTOREPLY_CD_MS = Number(process.env.FUNPAY_AUTOREPLY_CD_MIN || 10) * 60_000;

/** Пока заказ в работе (ждём ник / выдаём / ручной), сообщения покупателя — не вопросы «можно ли купить». */
function buyerHasOrder(buyerId) {
    return Object.values(state.orders).some((o) => o.buyerId === buyerId && (ACTIVE.has(o.phase) || o.phase === 'manual'));
}

async function autoReplyLoop(client) {
    if (!AUTOREPLY_ON) return;
    const chats = await client.getChats();
    state.chats = state.chats || {};
    if (!state.chatsSeeded) {
        // первый запуск: всё, что уже написали, не трогаем
        for (const c of chats) state.chats[c.chatId] = { seen: c.nodeMsg };
        state.chatsSeeded = true;
        saveState();
        return;
    }
    let replies = 0;
    for (const c of chats) {
        const st = (state.chats[c.chatId] = state.chats[c.chatId] || { seen: 0 });
        if (c.nodeMsg <= st.seen) continue;
        const { name, messages } = await client.getChatByNumericId(c.chatId, st.seen);
        st.seen = Math.max(st.seen, c.nodeMsg, ...messages.map((m) => m.id));
        const buyerId = name.split('-').slice(1).map(Number).find((n) => n !== client.userId);
        if (!buyerId || !messages.length) continue;
        const last = messages[messages.length - 1];
        const fromBuyer = messages.some((m) => m.author === buyerId);
        // отвечаем, только если последним написал покупатель (продавец сам уже ответил — не лезем)
        if (!fromBuyer || last.author !== buyerId) continue;
        if (buyerHasOrder(buyerId)) continue;
        if (st.repliedAt && Date.now() - st.repliedAt < AUTOREPLY_CD_MS) continue;
        if (replies >= 3) {
            st.seen = Math.min(st.seen, c.nodeMsg - 1); // разберём на следующем круге
            continue;
        }
        st.repliedAt = Date.now();
        journal({ ev: 'autoreply', buyer: c.userName, text: last.text.slice(0, 120) });
        log(`автоответ ${c.userName}: «${last.text.slice(0, 60)}»`);
        await say(client, { id: `chat-${c.chatId}`, node: name }, T.autoReply(currentMinKk()), 'autoreply');
        replies++;
    }
    saveState();
}

// ───────────── события бота ─────────────
async function handleBotEvents(client) {
    if (ws.consumeOrderResync()) {
        for (const o of Object.values(state.orders)) {
            if (o.phase === 'dispatched') dispatch(o, { resync: true });
        }
    }
    for (const ev of ws.drainBotEvents()) {
        if (ev.type === 'bot_balance_refilling') {
            for (const o of Object.values(state.orders)) {
                if (ACTIVE.has(o.phase)) await hintOnce(client, o, 'refill', T.balanceRefilling());
            }
            continue;
        }
        if (!String(ev.orderId || '').startsWith(PREFIX)) continue;
        const order = state.orders[String(ev.orderId).slice(PREFIX.length)];
        if (!order) {
            log(`событие для неизвестного заказа ${ev.orderId}`);
            continue;
        }
        const retry = async (phase, text, key) => {
            if (order.phase === 'delivered' || order.phase === 'refunded') return;
            order.phase = phase;
            order.nick = null;
            if (LIVE) ws.pushCancelOrder(order.orderId);
            await hintOnce(client, order, key, text);
        };
        switch (ev.type) {
            case 'delivery_ok':
                if (order.phase === 'delivered') break;
                order.phase = 'delivered';
                order.deliveredAt = Date.now();
                journal({ ev: 'delivered', order: order.id, nick: order.nick, amountKk: order.amountKk });
                audit('funpay_delivered', { orderId: order.orderId, nick: order.nick, amountKk: order.amountKk });
                log(`выдано #${order.id}: ${order.amountKk}кк → ${order.nick}`);
                await say(client, order, T.delivered(), 'delivered');
                if (LIVE) ws.pushCancelOrder(order.orderId);
                break;
            case 'invalid_nick':
                await retry('awaiting_nick', T.wrongNick(), 'wrong_nick');
                break;
            case 'player_offline':
                await retry('awaiting_nick', T.offline(), 'offline');
                break;
            case 'insufficient_funds':
                await retry('awaiting_nick', T.insufficientFunds(), 'funds');
                break;
            case 'delivery_stalled':
                await retry('awaiting_nick', T.tryAgain(), 'stalled');
                break;
            case 'delivery_failed':
                await retry('awaiting_nick', T.failHint(ev.reason), `fail_${ev.reason || 'x'}`);
                break;
            case 'delivery_waiting':
                await hintOnce(client, order, 'captcha', T.captchaWait());
                break;
            case 'order_missing':
                if (order.phase === 'dispatched' && order.nick) dispatch(order, { resync: true });
                break;
            default:
                break;
        }
        saveState();
    }
}

// ───────────── главный цикл ─────────────
async function main() {
    const client = new FunPayClient({
        goldenKey: process.env.FUNPAY_GOLDEN_KEY,
        userAgent: process.env.FUNPAY_USER_AGENT || undefined,
    });
    const me = await client.init();
    log(`вошли как ${me.username} (id ${me.userId}); режим: ${LIVE ? 'БОЕВОЙ' : 'наблюдение'}`);
    if (LIVE) ws.startWsClient();
    let lastInit = Date.now();
    let lastSalesAt = 0;
    let lastChatsAt = 0;
    let lastLotAt = 0;

    for (;;) {
        try {
            if (Date.now() - lastInit > REINIT_MS) {
                await client.init();
                lastInit = Date.now();
            }

            if (Date.now() - lastLotAt >= 10 * 60_000) {
                lastLotAt = Date.now();
                await refreshLotMin(client);
            }

            if (Date.now() - lastSalesAt >= SALES_MS) {
                lastSalesAt = Date.now();
                const sales = await client.getSales();
                if (!state.seeded) {
                    // первый запуск: уже существующие оплаты не трогаем (могли быть выданы вручную)
                    for (const s of sales) {
                        if (s.status === 'paid' && !state.orders[s.id]) {
                            state.orders[s.id] = { id: s.id, orderId: `${PREFIX}${s.id}`, phase: 'skipped', paidAtMs: 0 };
                        }
                    }
                    state.seeded = true;
                    saveState();
                    log(`первый запуск: пропущено уже существующих оплат: ${Object.values(state.orders).length}`);
                } else {
                    for (const s of sales) {
                        const known = state.orders[s.id];
                        if (!known && s.status === 'paid') {
                            await handleNewOrder(client, s);
                        } else if (known && s.status === 'refunded' && known.phase !== 'refunded' && known.phase !== 'delivered') {
                            known.phase = 'refunded';
                            if (LIVE && known.orderId) ws.pushCancelOrder(known.orderId);
                            log(`#${s.id} возвращён — снимаю с выдачи`);
                            saveState();
                        } else if (known && s.status === 'closed' && ACTIVE.has(known.phase)) {
                            log(`#${s.id} закрыт на FunPay до выдачи (фаза ${known.phase})`);
                        }
                    }
                }
            }

            for (const o of Object.values(state.orders)) {
                if (ACTIVE.has(o.phase)) await pollChat(client, o);
            }
            if (Date.now() - lastChatsAt >= Number(process.env.FUNPAY_CHATLIST_MS || 6000)) {
                lastChatsAt = Date.now();
                await autoReplyLoop(client);
            }
            await handleBotEvents(client);
        } catch (e) {
            if (e instanceof FunPayError && e.kind === 'auth') {
                log(`ОШИБКА АВТОРИЗАЦИИ: ${e.message} — нужен новый golden_key`);
                process.exit(3);
            }
            log(`цикл: ${e.message}`);
            await new Promise((r) => setTimeout(r, 5000));
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}

main().catch((e) => {
    console.error('[funpay] fatal:', e);
    process.exit(e instanceof FunPayError && e.kind === 'auth' ? 3 : 1);
});
