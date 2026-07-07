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

function publishDelayMs() {
    return Number(process.env.PUBLISH_DELAY_MS || 10_000);
}

/** paid — сразу после оплаты. sent — после выдачи (по умолчанию). */
export function republishWhen() {
    const v = (process.env.REPUBLISH_WHEN || 'sent').trim().toLowerCase();
    return v === 'paid' ? 'paid' : 'sent';
}

function normalizeStatusEntry(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') {
        return { id: entry, price: 0, name: null, type: null };
    }
    const id = entry.id || entry.status?.id || entry.statusId;
    if (!id) return null;
    const price = entry.price ?? entry.statusPrice ?? entry.cost ?? 0;
    return {
        id: String(id),
        price: Number(price) || 0,
        name: entry.name || entry.status?.name || null,
        type: entry.type || entry.status?.type || null,
    };
}

function formatStatusList(list) {
    return list
        .map((s) => `${s.name || s.type || '?'}:${s.id.slice(0, 8)}… ₽${s.price}`)
        .join(', ');
}

/**
 * Кандидаты на publishItem — сначала «Обычный» / бесплатный, не зашитый UUID.
 */
export function listPublishPriorityCandidates(data) {
    const raw = data?.itemPriorityStatuses;
    if (!Array.isArray(raw) || !raw.length) return [];

    const list = raw.map(normalizeStatusEntry).filter(Boolean);
    if (!list.length) return [];

    const ordered = [];
    const seen = new Set();
    const add = (s) => {
        if (!s?.id || seen.has(s.id)) return;
        seen.add(s.id);
        ordered.push(s);
    };

    for (const s of list) {
        if (/обычн/i.test(s.name || '')) add(s);
    }
    for (const s of list) {
        if (s.type === 'DEFAULT' || s.price === 0) add(s);
    }
    for (const s of list) {
        add(s);
    }

    return ordered.map((s) => s.id);
}

/** @deprecated используй listPublishPriorityCandidates */
export function pickPriorityStatusIds(data) {
    const ids = listPublishPriorityCandidates(data);
    return ids.length ? [ids[0]] : null;
}

async function fetchPriorityStatusList(client, itemId, priceRub) {
    if (typeof client?.itemPriorityStatuses !== 'function') {
        throw new Error('itemPriorityStatuses недоступен в playerok-client');
    }
    const data = await client.itemPriorityStatuses(itemId, priceRub ?? 0);
    const list =
        data?.itemPriorityStatuses?.map(normalizeStatusEntry).filter(Boolean) ?? [];
    if (!list.length) {
        throw new Error(
            `itemPriorityStatuses пуст (itemId=${itemId}, price=${priceRub ?? 0})`,
        );
    }
    return { data, list };
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

const STATUS_REJECTED_RE = /нельзя обновить статус/i;

export async function publishItemOnPlayerok(client, itemId, priceRub = null) {
    const file = process.env.PUBLISH_ITEM_MUTATION_FILE || './captures/publish-item.graphql';
    const op = process.env.PUBLISH_ITEM_OPERATION || 'publishItem';
    const gqlPath = process.env.PUBLISH_ITEM_GQL_PATH || '/products/[slug]';

    const { list } = await fetchPriorityStatusList(client, itemId, priceRub);
    const candidates = listPublishPriorityCandidates({ itemPriorityStatuses: list });
    if (!candidates.length) {
        throw new Error(`нет подходящего priorityStatus (${formatStatusList(list)})`);
    }

    console.log(`[sell] статусы лота: ${formatStatusList(list)}`);

    let lastErr;
    for (const statusId of candidates) {
        const hit = list.find((s) => s.id === statusId);
        const label = hit?.name ? `${hit.name} (${statusId.slice(0, 8)}…)` : statusId.slice(0, 8) + '…';
        try {
            const variables = buildPublishVariables(itemId, [statusId]);
            console.log(`[sell] PlayerOK publishItem itemId=${itemId}… status=${label}`);
            const data = await client.runMutationFromFile(
                'PUBLISH_ITEM_MUTATION_FILE',
                file,
                variables,
                op,
                gqlPath,
            );
            const item = data?.publishItem;
            if (item?.status) {
                console.log(
                    `[sell] publishItem ok: status=${item.status} slug=${item.slug || '?'}`,
                );
            }
            return data;
        } catch (e) {
            lastErr = e;
            const msg = String(e.message || e);
            if (!STATUS_REJECTED_RE.test(msg)) throw e;
            console.warn(`[sell] publishItem status ${label}: ${msg}`);
        }
    }

    throw lastErr || new Error('publishItem: все статусы отклонены');
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
