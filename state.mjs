import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';

const PATH = process.env.STATE_FILE || './state.json';
const TMP_PATH = `${PATH}.tmp`;
const BAK_PATH = `${PATH}.bak`;

const EMPTY = {
    orders: {},
    confirmedDeals: {},
    chats: {},
    bannedBuyers: {},
    scheduledChatMessages: [],
    botBalance: null,
};

export async function loadState() {
    if (!existsSync(PATH)) return structuredClone(EMPTY);
    const state = await readJsonWithFallback();
    if (!state.orders) state.orders = {};
    if (!state.confirmedDeals) state.confirmedDeals = {};
    if (!state.chats) state.chats = {};
    if (!state.scheduledChatMessages) state.scheduledChatMessages = [];
    if (!state.bannedBuyers) state.bannedBuyers = {};
    if (!('botBalance' in state)) state.botBalance = null;
    return state;
}

export async function saveState(state) {
    const payload = JSON.stringify(state, null, 2);
    // Atomic replace: write temp, keep backup of last good, then swap.
    await writeFile(TMP_PATH, payload);
    if (existsSync(PATH)) {
        await rename(PATH, BAK_PATH);
    }
    await rename(TMP_PATH, PATH);
}

export function getOrder(state, dealId) {
    return state.orders[dealId] || null;
}

export function upsertOrder(state, deal) {
    const id = deal.dealId || deal.orderId;
    const prev = state.orders[id] || {};
    state.orders[id] = { ...prev, ...deal, orderId: id, dealId: id };
    return state.orders[id];
}

export function setOrderPhase(state, dealId, phase, extra = {}) {
    const o = state.orders[dealId];
    if (!o) return null;
    Object.assign(o, { phase, ...extra });
    return o;
}

export function markConfirmed(state, dealId) {
    state.confirmedDeals[dealId] = new Date().toISOString();
}

export function ensureChat(state, chatId) {
    if (!state.chats[chatId]) {
        state.chats[chatId] = { greetingSent: false, buyers: {} };
    }
    return state.chats[chatId];
}

export function getBuyerSession(state, chatId, buyerId) {
    const chat = ensureChat(state, chatId);
    if (!chat.buyers[buyerId]) {
        chat.buyers[buyerId] = {};
    }
    return chat.buyers[buyerId];
}

export function ordersInChat(state, chatId) {
    return Object.values(state.orders).filter((o) => o.chatId === chatId);
}

async function readJsonWithFallback() {
    const tryRead = async (path) => {
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw);
    };

    try {
        return await tryRead(PATH);
    } catch (e) {
        const msg = String(e?.message || e);
        console.warn(`[sell] state.json повреждён (${msg})`);
        if (existsSync(BAK_PATH)) {
            try {
                const recovered = await tryRead(BAK_PATH);
                console.warn('[sell] восстановление state из backup');
                await writeFile(PATH, JSON.stringify(recovered, null, 2));
                return recovered;
            } catch (be) {
                console.warn(`[sell] backup тоже повреждён: ${be?.message || be}`);
            }
        }
        console.warn('[sell] state reset → EMPTY');
        return structuredClone(EMPTY);
    }
}
