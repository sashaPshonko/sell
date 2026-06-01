import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const PATH = process.env.STATE_FILE || './state.json';

const EMPTY = {
    orders: {},
    confirmedDeals: {},
    chats: {},
    buyerBonus: {},
    bannedBuyers: {},
    scheduledChatMessages: [],
};

export async function loadState() {
    if (!existsSync(PATH)) return structuredClone(EMPTY);
    const raw = await readFile(PATH, 'utf8');
    const state = JSON.parse(raw);
    if (!state.orders) state.orders = {};
    if (!state.confirmedDeals) state.confirmedDeals = {};
    if (!state.chats) state.chats = {};
    if (!state.buyerBonus) state.buyerBonus = {};
    if (!state.scheduledChatMessages) state.scheduledChatMessages = [];
    if (!state.bannedBuyers) state.bannedBuyers = {};
    return state;
}

export async function saveState(state) {
    await writeFile(PATH, JSON.stringify(state, null, 2));
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
