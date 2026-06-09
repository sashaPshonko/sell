/**
 * Перевыставление лота на PlayerOK после оплаты (publishItem).
 */
import { setOrderPhase, getOrder, saveState } from './state.mjs';
import { isMarkedProfileLot } from './lib/profile-upsell.mjs';

const pending = new Map();

function publishEnabled() {
    return process.env.AUTO_PUBLISH_ITEM !== '0';
}

/** Только лоты с 🎁 в названии → перевыставление со статусом «Обычный». */
export function shouldRepublishOrder(order) {
    return Boolean(order?.itemId && isMarkedProfileLot(order.itemName));
}

/** PlayerOK: «Обычный», type DEFAULT, price 0 (не «Премиум» за 25₽). */
const DEFAULT_PRIORITY_STATUS_ID = '1efbe5bc-99a7-68e5-4534-85dad913b981';

function publishDelayMs() {
    return Number(process.env.PUBLISH_DELAY_MS || 10_000);
}

/** paid — сразу после оплаты. sent — после выдачи (по умолчанию). */
export function republishWhen() {
    const v = (process.env.REPUBLISH_WHEN || 'sent').trim().toLowerCase();
    return v === 'paid' ? 'paid' : 'sent';
}

function defaultPriorityStatusIds() {
    const priRaw = process.env.PUBLISH_PRIORITY_STATUSES?.trim();
    if (priRaw) return JSON.parse(priRaw);
    const preferId = process.env.PUBLISH_PRIORITY_STATUS_ID?.trim();
    return [preferId || DEFAULT_PRIORITY_STATUS_ID];
}

function normalizeStatusEntry(entry) {
    if (!entry) return null;
    const id = entry.id || entry.status?.id || entry.statusId;
    if (!id) return null;
    const price = entry.price ?? entry.statusPrice ?? entry.cost ?? 0;
    return {
        id: String(id),
        price: Number(price) || 0,
        name: entry.name || null,
        type: entry.type || null,
    };
}

/**
 * Как в UI: «Обычный» (DEFAULT, price 0), не «Премиум» (PREMIUM).
 * Явный PUBLISH_PRIORITY_STATUS_ID → иначе DEFAULT/price 0 → иначе fallback id.
 */
export function pickPriorityStatusIds(data) {
    const raw = data?.itemPriorityStatuses;
    if (!Array.isArray(raw) || !raw.length) return null;

    const list = raw.map(normalizeStatusEntry).filter(Boolean);
    if (!list.length) return null;

    const preferId =
        process.env.PUBLISH_PRIORITY_STATUS_ID?.trim() || DEFAULT_PRIORITY_STATUS_ID;
    const preferred = list.find((s) => s.id === preferId);
    if (preferred) return [preferred.id];

    const ordinary = list.find((s) => s.type === 'DEFAULT' || s.price === 0);
    if (ordinary) return [ordinary.id];

    return null;
}

function formatStatusLog(ids, list) {
    const id = ids[0];
    const hit = list?.find((s) => s.id === id);
    return hit?.name ? `${hit.name} (${id})` : id;
}

async function resolvePriorityStatusIds(client, itemId, priceRub) {
    if (typeof client?.itemPriorityStatuses !== 'function') {
        return defaultPriorityStatusIds();
    }
    let statusList = null;
    try {
        const data = await client.itemPriorityStatuses(itemId, priceRub ?? 0);
        statusList = data?.itemPriorityStatuses
            ?.map(normalizeStatusEntry)
            .filter(Boolean);
        const picked = pickPriorityStatusIds(data);
        if (picked?.length) {
            console.log(`[sell] статус: ${formatStatusLog(picked, statusList)}`);
            return picked;
        }
    } catch (e) {
        console.warn(`[sell] itemPriorityStatuses: ${e.message}`);
    }
    const fallback = defaultPriorityStatusIds();
    console.log(`[sell] статус (fallback): ${formatStatusLog(fallback, statusList)}`);
    return fallback;
}

function buildPublishVariables(itemId, priorityStatuses) {
    const varsRaw = process.env.PUBLISH_ITEM_VARIABLES;
    if (varsRaw) {
        return JSON.parse(varsRaw.replaceAll('ITEM_ID', itemId));
    }

    return {
        input: {
            transactionProviderId: process.env.PUBLISH_TRANSACTION_PROVIDER || 'LOCAL',
            priorityStatuses,
            itemId,
        },
    };
}

export async function publishItemOnPlayerok(client, itemId, priceRub = null) {
    const file = process.env.PUBLISH_ITEM_MUTATION_FILE || './captures/publish-item.graphql';
    const op = process.env.PUBLISH_ITEM_OPERATION || 'publishItem';
    const gqlPath = process.env.PUBLISH_ITEM_GQL_PATH || '/products/[slug]';

    const priorityStatuses = await resolvePriorityStatusIds(client, itemId, priceRub);
    const variables = buildPublishVariables(itemId, priorityStatuses);

    console.log(`[sell] PlayerOK publishItem itemId=${itemId}…`);
    const data = await client.runMutationFromFile(
        'PUBLISH_ITEM_MUTATION_FILE',
        file,
        variables,
        op,
        gqlPath,
    );
    const item = data?.publishItem;
    if (item?.status) {
        console.log(`[sell] publishItem ok: status=${item.status} slug=${item.slug || '?'}`);
    }
    return data;
}

/** Через N мс после оплаты / выдачи — один раз на заказ */
export function scheduleRepublishItem(client, state, order) {
    if (!publishEnabled()) return;
    if (!shouldRepublishOrder(order)) {
        console.log(
            `[sell] перевыставление пропуск: ${order?.itemName || '?'} (нет itemId или нет 🎁)`,
        );
        return;
    }

    const dealId = order.dealId || order.orderId;
    const existing = getOrder(state, dealId);
    if (existing?.republishedAt) return;
    if (pending.has(dealId)) return;
    if (existing?.republishScheduled && !existing?.republishError) return;

    const delayMs = publishDelayMs();
    setOrderPhase(state, dealId, existing?.phase || order.phase || 'new', {
        republishScheduled: true,
    });

    console.log(
        `[sell] перевыставление через ${delayMs / 1000}с: ${dealId.slice(0, 8)}… item=${order.itemId.slice(0, 8)}…`,
    );

    const timer = setTimeout(async () => {
        pending.delete(dealId);
        try {
            await publishItemOnPlayerok(client, order.itemId, order.itemPriceRub);
            setOrderPhase(state, dealId, getOrder(state, dealId)?.phase || 'new', {
                republishedAt: new Date().toISOString(),
                republishError: null,
            });
            console.log(`[sell] лот перевыставлен: ${order.itemName || order.itemId}`);
        } catch (e) {
            console.warn(`[sell] publishItem ${dealId.slice(0, 8)}…: ${e.message}`);
            setOrderPhase(state, dealId, getOrder(state, dealId)?.phase || 'new', {
                republishScheduled: false,
                republishError: e.message,
            });
        }
        await saveState(state);
    }, delayMs);

    pending.set(dealId, timer);
}
