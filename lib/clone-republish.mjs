/**
 * Клон проданного лота: createItem → updateItem(скидка) → publishItem.
 * publishItem на SOLD+buyer+editable=false стабильно «нельзя обновить статус» —
 * веб в этом случае создаёт новый лот, а не republish того же id.
 *
 * Скидка: create с rawPrice, потом updateItem({ price: sale }) — raw остаётся,
 * price становится со скидкой (как в вебе при редактировании).
 */
import {
    listingRawPriceRub,
    discountedPriceRub,
    listingHasDiscount,
} from '../parse.mjs';

async function downloadAttachment(url, cookie = null) {
    const headers = {
        accept: 'image/*,*/*',
        'user-agent':
            process.env.PLAYEROK_USER_AGENT ||
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        referer: 'https://playerok.com/',
    };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(url, { headers });
    if (!res.ok) {
        throw new Error(`скачать вложение: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || 'image/png';
    const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : 'png';
    return { buffer: buf, filename: `banner.${ext}`, contentType: ct.split(';')[0] };
}

function buildCreateInput(item) {
    const categoryId =
        item?.category?.id || item?.gameCategory?.id || item?.category?.id;
    const obtainingTypeId =
        item?.obtainingType?.id || item?.obtainingType?.id;
    if (!categoryId || !obtainingTypeId) {
        throw new Error('clone: нет category.id / obtainingType.id');
    }
    const price =
        listingRawPriceRub(item) ??
        discountedPriceRub(item) ??
        item?.rawPrice ??
        item?.price;
    if (price == null || !Number.isFinite(Number(price)) || Number(price) <= 0) {
        throw new Error('clone: нет цены у исходного лота');
    }
    const dataFields = (item?.dataFields || item?.dataFields || [])
        .map((f) => ({
            fieldId: f?.fieldId || f?.id,
            value: f?.value == null ? '' : String(f.value),
        }))
        .filter((f) => f.fieldId);

    return {
        gameCategoryId: categoryId,
        obtainingTypeId,
        name: item.name,
        price: Math.round(Number(price)),
        description: item.description || '',
        attributes: item.attributes && typeof item.attributes === 'object'
            ? item.attributes
            : {},
        dataFields,
    };
}

/**
 * @returns {Promise<{ id, slug, name, price, rawPrice, status }>}
 */
export async function cloneItemAsDraft(client, sourceItem) {
    if (!sourceItem?.name) throw new Error('clone: пустой sourceItem');
    if (typeof client?.createItem !== 'function') {
        throw new Error('createItem недоступен в playerok-client');
    }

    const input = buildCreateInput(sourceItem);
    const attachments = [];
    for (const att of sourceItem.attachments || []) {
        if (!att?.url) continue;
        try {
            attachments.push(await downloadAttachment(att.url));
        } catch (e) {
            console.warn(`[sell] clone attach skip: ${e.message || e}`);
        }
    }
    if (!attachments.length && !sourceItem.isAttachmentsForbidden) {
        console.warn(
            `[sell] clone ${sourceItem.slug || sourceItem.id}: без вложений — пробуем`,
        );
    }

    console.log(
        `[sell] createItem clone «${input.name}» ₽${input.price} ` +
            `cat=${input.gameCategoryId.slice(0, 8)}… att=${attachments.length}`,
    );
    const data = await client.createItem(input, attachments);
    const created = data?.createItem;
    if (!created?.id) {
        throw new Error('createItem: пустой ответ');
    }
    console.log(
        `[sell] createItem ok: id=${created.id.slice(0, 13)}… ` +
            `slug=${created.slug || '?'} status=${created.status || '?'}`,
    );
    return created;
}

/**
 * После create с raw — updateItem(price=sale), как в вебе.
 * @returns {Promise<object>} draft с обновлёнными price/rawPrice
 */
export async function applyCloneSalePrice(client, draft, sourceItem) {
    if (!draft?.id || !sourceItem) return draft;
    if (!listingHasDiscount(sourceItem)) return draft;

    const sale = discountedPriceRub(sourceItem);
    const raw = listingRawPriceRub(sourceItem);
    if (sale == null || raw == null || sale >= raw || sale <= 0) return draft;

    if (typeof client?.updateItem !== 'function') {
        console.warn('[sell] updateItem недоступен — скидку не поставили');
        return draft;
    }

    console.log(
        `[sell] updateItem скидка: «${draft.name || draft.slug}» ` +
            `raw ${raw} → ${sale}₽`,
    );
    try {
        const data = await client.updateItem(
            { id: draft.id, price: sale },
            { slug: draft.slug },
        );
        const updated = data?.updateItem;
        if (updated?.id) {
            console.log(
                `[sell] updateItem ok: price=${updated.price} ` +
                    `rawPrice=${updated.rawPrice ?? '?'}`,
            );
            return { ...draft, ...updated };
        }
    } catch (e) {
        console.warn(`[sell] updateItem скидка: ${e.message || e}`);
    }
    return { ...draft, price: sale, rawPrice: draft.rawPrice ?? raw };
}

/**
 * Проданный лот не публикуем тем же id — как веб: createItem → publish.
 * Исключение: уже APPROVED без buyer (лот на витрине).
 */
export function needsCloneRepublish(itemMeta) {
    if (!itemMeta) return false;
    if (
        itemMeta.status === 'APPROVED' &&
        !itemMeta.buyer?.id &&
        !itemMeta.buyer?.username
    ) {
        return false;
    }
    return true;
}
