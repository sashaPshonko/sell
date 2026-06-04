/**
 * Перевыставление лота на PlayerOK после оплаты (publishItem).
 * Только лоты с 🎁 в названии — бесплатная премка priorityStatuses.
 */
import { setOrderPhase, getOrder, saveState } from './state.mjs';
import { isMarkedProfileLot } from './lib/profile-upsell.mjs';

const pending = new Map();

function publishEnabled() {
    return process.env.AUTO_PUBLISH_ITEM !== '0';
}

/** Перевыставляем только профильные лоты (🎁 в названии). */
export function shouldRepublishOrder(order) {
    return Boolean(order?.itemId && isMarkedProfileLot(order.itemName));
}

function publishDelayMs() {
    return Number(process.env.PUBLISH_DELAY_MS || 10_000);
}

/** paid — сразу после оплаты (PlayerOK часто отказывает). sent — после SENT/выдачи (по умолчанию). */
export function republishWhen() {
    const v = (process.env.REPUBLISH_WHEN || 'sent').trim().toLowerCase();
    return v === 'paid' ? 'paid' : 'sent';
}

function buildPublishVariables(itemId) {
    const varsRaw = process.env.PUBLISH_ITEM_VARIABLES;
    if (varsRaw) {
        return JSON.parse(varsRaw.replaceAll('ITEM_ID', itemId));
    }

    let priorityStatuses = ['1f00f21b-7768-62a0-296f-75a31ee8ce72'];
    const priRaw = process.env.PUBLISH_PRIORITY_STATUSES?.trim();
    if (priRaw) {
        priorityStatuses = JSON.parse(priRaw);
    }

    return {
        input: {
            transactionProviderId: process.env.PUBLISH_TRANSACTION_PROVIDER || 'LOCAL',
            priorityStatuses,
            itemId,
        },
    };
}

export async function publishItemOnPlayerok(client, itemId) {
    const file = process.env.PUBLISH_ITEM_MUTATION_FILE || './captures/publish-item.graphql';
    const op = process.env.PUBLISH_ITEM_OPERATION || 'publishItem';
    const gqlPath = process.env.PUBLISH_ITEM_GQL_PATH || '/products/[slug]';
    const variables = buildPublishVariables(itemId);

    console.log(`[sell] PlayerOK publishItem itemId=${itemId}…`);
    return client.runMutationFromFile(
        'PUBLISH_ITEM_MUTATION_FILE',
        file,
        variables,
        op,
        gqlPath,
    );
}

/** Через N мс после оплаты — один раз на заказ */
export function scheduleRepublishItem(client, state, order) {
    if (!publishEnabled()) return;
    if (!shouldRepublishOrder(order)) return;
    if (!order?.itemId) {
        console.warn(
            `[sell] перевыставление: нет itemId (deal ${order?.dealId?.slice(0, 8) || '?'})`,
        );
        return;
    }

    const dealId = order.dealId || order.orderId;
    const existing = getOrder(state, dealId);
    if (existing?.republishedAt) return;
    if (pending.has(dealId)) return;
    // Уже ждём таймер и прошлый раз не падал
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
            await publishItemOnPlayerok(client, order.itemId);
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
