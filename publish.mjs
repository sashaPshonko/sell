/**
 * Перевыставление лота на PlayerOK после оплаты (publishItem).
 */
import { setOrderPhase, getOrder, saveState } from './state.mjs';
import { isMarkedProfileLot, isSearchPremiumLot } from './lib/profile-upsell.mjs';
import { resolveCompletedItemForOrder } from './lib/completed-republish.mjs';
import {
    cloneItemAsDraft,
    applyCloneSalePrice,
    needsCloneRepublish,
} from './lib/clone-republish.mjs';
import {
    discountedPriceRub,
    listingRawPriceRub,
    guessItemSlug,
    parseAmountKk,
} from './parse.mjs';
import { enqueuePublishWork, publishRetryDelayMs } from './lib/publish-queue.mjs';

const pending = new Map();

function publishEnabled() {
    return process.env.AUTO_PUBLISH_ITEM !== '0';
}

/**
 * Достаточно kk: цену PlayerOK часто не кладёт в ITEM_PAID (itemPriceRub=null).
 * Цену подтянем из completed-list / itemMeta при publish.
 */
export function shouldRepublishOrder(order) {
    const kk = order?.amountKk ?? parseAmountKk(order?.itemName);
    return Boolean(kk);
}

function publishDelayMs() {
    // После оплаты buyer ещё на лоте; 10с почти всегда рано.
    return Number(process.env.PUBLISH_DELAY_MS || 120_000);
}

function publishMaxRetries() {
    return Number(process.env.PUBLISH_MAX_RETRIES || 30);
}

/** paid — сразу после оплаты (по умолчанию). sent — после выдачи. */
export function republishWhen() {
    const v = (process.env.REPUBLISH_WHEN || 'paid').trim().toLowerCase();
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
 * Кандидаты на publishItem.
 * profileLot (🎁) — сначала «Обычный» / бесплатный.
 * Обычный лот в поиске — сначала «Премиум» / платный.
 */
export function listPublishPriorityCandidates(data, { profileLot = false } = {}) {
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

    if (profileLot) {
        for (const s of list) {
            if (/обычн/i.test(s.name || '')) add(s);
        }
        for (const s of list) {
            if (s.type === 'DEFAULT' || s.price === 0) add(s);
        }
    } else {
        for (const s of list) {
            if (/премиум/i.test(s.name || '')) add(s);
        }
        for (const s of list) {
            if (s.type === 'PREMIUM' || s.price > 0) add(s);
        }
        // Fallback: если премку PlayerOK отклонит (нет ₽ на статусе / «нельзя обновить»),
        // всё равно выставим обычным — лучше на профиле, чем дыра в витрине.
        for (const s of list) {
            if (/обычн/i.test(s.name || '')) add(s);
        }
        for (const s of list) {
            if (s.type === 'DEFAULT' || s.price === 0) add(s);
        }
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

async function fetchPriorityStatusList(client, itemId, priceRub, referer = null) {
    if (typeof client?.itemPriorityStatuses !== 'function') {
        throw new Error('itemPriorityStatuses недоступен в playerok-client');
    }
    const data = await client.itemPriorityStatuses(itemId, priceRub ?? 0, referer);
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

    const input = {
        transactionProviderId: process.env.PUBLISH_TRANSACTION_PROVIDER || 'LOCAL',
        priorityStatuses,
        itemId,
        // как в web UI; без поля PlayerOK иногда отвечает «нельзя обновить статус»
        keepInSale: process.env.PUBLISH_KEEP_IN_SALE === '1',
    };
    if (process.env.PUBLISH_TRANSACTION_PROVIDER_DATA !== '0') {
        input.transactionProviderData = { paymentMethodId: null };
    }
    return { input };
}

const STATUS_REJECTED_RE =
    /нельзя обновить статус|слишком много попыток|не удалось найти в базе/i;

async function loadItemMeta(client, { itemId, slug } = {}) {
    if (!slug || typeof client?.itemBySlug !== 'function') return null;
    const data = await client.itemBySlug(slug);
    const item = data?.item ?? null;
    if (!item) return null;
    if (itemId && item.id && item.id !== itemId) {
        console.warn(
            `[sell] slug ${slug}: itemId ${item.id} ≠ ожидаемый ${itemId}`,
        );
    }
    return item;
}

export async function publishItemOnPlayerok(
    client,
    itemId,
    priceRub = null,
    { profileLot = false, slug = null, itemName = null } = {},
) {
    if (!slug) slug = guessItemSlug({ itemId, itemName });
    const file = process.env.PUBLISH_ITEM_MUTATION_FILE || './captures/publish-item.graphql';
    const op = process.env.PUBLISH_ITEM_OPERATION || 'publishItem';
    const gqlPath = process.env.PUBLISH_ITEM_GQL_PATH || '/products/[slug]';

    let itemMeta = await loadItemMeta(client, { itemId, slug });
    // slug из заказа мог быть кривой — угадываем и пробуем ещё раз
    if (!itemMeta && itemId && itemName) {
        const guessed = guessItemSlug({ itemId, itemName, itemSlug: slug });
        if (guessed && guessed !== slug) {
            slug = guessed;
            itemMeta = await loadItemMeta(client, { itemId, slug });
        }
    }
    let publishItemId = itemId;
    let statusPriceRub = priceRub;
    let referer = slug ? `https://playerok.com/products/${slug}` : null;
    if (itemMeta) {
        publishItemId = itemMeta.id || itemId;
        slug = itemMeta.slug || slug;
        const salePrice = discountedPriceRub(itemMeta);
        const rawPrice = listingRawPriceRub(itemMeta);
        console.log(
            `[sell] лот ${itemMeta.slug || slug}: status=${itemMeta.status} ` +
                `mayBePublished=${itemMeta.mayBePublished} ` +
                `price=${salePrice} rawPrice=${rawPrice ?? '?'}`,
        );
        // itemPriorityStatuses считает премку от цены листинга (raw), не от скидки в сделке
        statusPriceRub = rawPrice ?? salePrice ?? priceRub;
        if (salePrice != null) priceRub = salePrice;
        // Уже в продаже без buyer — считать успехом (ручной/прошлый publish).
        if (
            itemMeta.status === 'APPROVED' &&
            !itemMeta.buyer?.id &&
            !itemMeta.buyer?.username
        ) {
            console.log(
                `[sell] лот ${itemMeta.slug || slug}: уже APPROVED без buyer — ` +
                    `перевыставление не нужно`,
            );
            return { publishItem: itemMeta, alreadyListed: true };
        }
        // SOLD+buyer+editable=false: publishItem того же id всегда «нельзя обновить статус».
        // Веб создаёт новый лот — делаем createItem → publish.
        if (needsCloneRepublish(itemMeta)) {
            const who =
                itemMeta.buyer?.username ||
                (itemMeta.buyer?.id
                    ? String(itemMeta.buyer.id).slice(0, 8)
                    : '?');
            console.warn(
                `[sell] лот ${itemMeta.slug || slug}: status=${itemMeta.status} ` +
                    `buyer=${who} editable=${itemMeta.editable} — clone+publish`,
            );
            // премку считаем от raw исходника; sale потом вернём через updateItem
            const sourceSale = discountedPriceRub(itemMeta);
            const sourceRaw = listingRawPriceRub(itemMeta);
            let draft = await cloneItemAsDraft(client, itemMeta);
            draft = await applyCloneSalePrice(client, draft, itemMeta);
            publishItemId = draft.id;
            slug = draft.slug || slug;
            itemName = draft.name || itemName;
            statusPriceRub =
                sourceRaw ??
                listingRawPriceRub(draft) ??
                draft.rawPrice ??
                draft.price ??
                statusPriceRub;
            if (sourceSale != null) priceRub = sourceSale;
            if (draft.name) {
                profileLot = isMarkedProfileLot(draft.name);
            }
            itemMeta = draft;
            referer = slug ? `https://playerok.com/products/${slug}` : referer;
        } else if (itemMeta.mayBePublished === false) {
            throw new Error(
                `mayBePublished=false (status=${itemMeta.status}) — рано перевыставлять`,
            );
        } else if (itemMeta.buyer?.id || itemMeta.buyer?.username) {
            const who =
                itemMeta.buyer.username || String(itemMeta.buyer.id).slice(0, 8);
            console.warn(
                `[sell] лот ${itemMeta.slug || slug}: ещё buyer=${who}, ` +
                    `status=${itemMeta.status} editable=${itemMeta.editable} — пробуем publish`,
            );
        }
        if (itemMeta.name) {
            profileLot = isMarkedProfileLot(itemMeta.name);
            itemName = itemMeta.name;
        }
    }

    // raw, потом sale, потом 0 — разный price даёт разный набор статусов
    const priceAttempts = [...new Set(
        [statusPriceRub, priceRub, listingRawPriceRub(itemMeta), 0].filter(
            (p) => p != null && Number.isFinite(Number(p)),
        ).map((p) => Math.round(Number(p))),
    )];
    if (!priceAttempts.length) priceAttempts.push(0);

    let lastErr;
    const triedStatus = new Set();
    for (const tryPrice of priceAttempts) {
        let list;
        try {
            ({ list } = await fetchPriorityStatusList(
                client,
                publishItemId,
                tryPrice,
                referer,
            ));
        } catch (e) {
            lastErr = e;
            console.warn(
                `[sell] itemPriorityStatuses @${tryPrice}₽: ${e.message || e}`,
            );
            continue;
        }
        const candidates = listPublishPriorityCandidates(
            { itemPriorityStatuses: list },
            { profileLot },
        );
        if (!candidates.length) {
            lastErr = new Error(
                `нет подходящего priorityStatus @${tryPrice}₽ (${formatStatusList(list)})`,
            );
            continue;
        }

        const lotKind = profileLot
            ? '🎁 обычный'
            : isSearchPremiumLot(itemName)
              ? '· премиум'
              : 'премиум';
        console.log(
            `[sell] статусы лота (${lotKind}) @${tryPrice}₽: ${formatStatusList(list)}`,
        );

        for (const statusId of candidates) {
            if (triedStatus.has(statusId)) continue;
            triedStatus.add(statusId);
            const hit = list.find((s) => s.id === statusId);
            const label = hit?.name
                ? `${hit.name} (${statusId.slice(0, 8)}…)`
                : statusId.slice(0, 8) + '…';
            try {
                const variables = buildPublishVariables(publishItemId, [statusId]);
                console.log(
                    `[sell] PlayerOK publishItem itemId=${publishItemId}… status=${label}`,
                );
                console.log(
                    `[sell] publish payload: referer=${referer || '-'} ` +
                        `price=${tryPrice} profileLot=${profileLot} ` +
                        `statusId=${statusId}`,
                );
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
    }

    throw lastErr || new Error('publishItem: все статусы отклонены');
}

/** Через N мс после оплаты / выдачи — один раз на заказ */
export function scheduleRepublishItem(client, state, order, { delayOverrideMs } = {}) {
    if (!publishEnabled()) return;
    if (!shouldRepublishOrder(order)) {
        console.log(
            `[sell] перевыставление пропуск: ${order?.itemName || '?'} (нет kk)`,
        );
        return;
    }

    const dealId = order.dealId || order.orderId;
    const existing = getOrder(state, dealId);
    if (existing?.republishedAt) return;
    if (pending.has(dealId)) return;
    if (existing?.republishScheduled && !existing?.republishError && !delayOverrideMs) return;

    const delayMs = delayOverrideMs ?? publishDelayMs();
    const maxRetries = publishMaxRetries();
    const attempt = Number(existing?.republishAttempts || 0);

    setOrderPhase(state, dealId, existing?.phase || order.phase || 'new', {
        republishScheduled: true,
        republishAttempts: attempt,
    });

    console.log(
        `[sell] перевыставление через ${delayMs / 1000}с: ${dealId.slice(0, 8)}… ` +
            `item=${order.itemId.slice(0, 8)}… (попытка ${attempt + 1}/${maxRetries})`,
    );

    const timer = setTimeout(() => {
        pending.delete(dealId);
        void enqueuePublishWork(async () => {
        const fresh = getOrder(state, dealId) || order;

        let itemId = fresh.itemId;
        let slug = fresh.itemSlug || guessItemSlug(fresh);
        let priceRub = fresh.itemPriceRub;
        let itemName = fresh.itemName;

        try {
            const completed = await resolveCompletedItemForOrder(client, fresh);
            if (!completed?.id) {
                throw new Error(
                    `completed-list: лот ${fresh.amountKk ?? '?'}kk ещё не в completed ` +
                        `(itemId=${fresh.itemId?.slice(0, 8) || '—'}… slug=${slug || '—'})`,
                );
            }

            itemId = completed.id;
            slug = completed.slug || slug;
            priceRub = discountedPriceRub(completed) ?? priceRub;
            itemName = completed.name || itemName;
            setOrderPhase(state, dealId, fresh.phase || 'new', {
                itemSlug: slug || fresh.itemSlug || null,
            });

            if (completed.alreadyListed) {
                setOrderPhase(state, dealId, getOrder(state, dealId)?.phase || 'new', {
                    republishedAt: new Date().toISOString(),
                    republishError: null,
                    republishAttempts: attempt + 1,
                });
                console.log(
                    `[sell] лот уже в продаже: ${fresh.itemName || slug || itemId}`,
                );
                await saveState(state);
                return;
            }

            await publishItemOnPlayerok(client, itemId, priceRub, {
                profileLot: isMarkedProfileLot(fresh.itemName || itemName),
                slug,
                itemName,
            });
            setOrderPhase(state, dealId, getOrder(state, dealId)?.phase || 'new', {
                republishedAt: new Date().toISOString(),
                republishError: null,
                republishAttempts: attempt + 1,
            });
            console.log(`[sell] лот перевыставлен: ${order.itemName || order.itemId}`);
        } catch (e) {
            const msg = String(e.message || e);
            const retryable =
                STATUS_REJECTED_RE.test(msg) ||
                /mayBePublished=false/i.test(msg) ||
                /рано перевыставлять/i.test(msg) ||
                /лот ещё с buyer/i.test(msg) ||
                /не удалось найти в базе/i.test(msg) ||
                /все статусы отклонены/i.test(msg) ||
                /ещё не в completed/i.test(msg) ||
                /fetch failed/i.test(msg) ||
                /слишком много попыток/i.test(msg);
            const nextAttempt = attempt + 1;
            if (retryable && nextAttempt < maxRetries) {
                const retryMs = publishRetryDelayMs(nextAttempt, msg);
                console.warn(
                    `[sell] publishItem ${dealId.slice(0, 8)}…: ${msg} → повтор через ${retryMs / 1000}с`,
                );
                setOrderPhase(state, dealId, getOrder(state, dealId)?.phase || 'new', {
                    republishScheduled: true,
                    republishError: msg,
                    republishAttempts: nextAttempt,
                });
                await saveState(state);
                const retryOrder = {
                    ...order,
                    ...(getOrder(state, dealId) || {}),
                    republishAttempts: nextAttempt,
                };
                const retryTimer = setTimeout(() => {
                    pending.delete(dealId);
                    scheduleRepublishItem(client, state, retryOrder, { delayOverrideMs: retryMs });
                }, retryMs);
                pending.set(dealId, retryTimer);
                return;
            }
            console.warn(`[sell] publishItem ${dealId.slice(0, 8)}…: ${msg}`);
            setOrderPhase(state, dealId, getOrder(state, dealId)?.phase || 'new', {
                republishScheduled: false,
                republishError: msg,
                republishAttempts: nextAttempt,
            });
        }
        await saveState(state);
        }).catch((e) => {
            console.warn(`[sell] publish-queue ${dealId.slice(0, 8)}…: ${e.message || e}`);
        });
    }, delayMs);

    pending.set(dealId, timer);
}
