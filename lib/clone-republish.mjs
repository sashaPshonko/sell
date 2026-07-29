/**
 * Клон проданного лота: createItem → publishItem.
 * publishItem на SOLD+buyer+editable=false стабильно «нельзя обновить статус» —
 * веб в этом случае создаёт новый лот, а не republish того же id.
 */
import { listingRawPriceRub, discountedPriceRub } from '../parse.mjs';

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
    const categoryId = item?.category?.id;
    const obtainingTypeId = item?.obtainingType?.id;
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
    const dataFields = (item?.dataFields || [])
        .filter((f) => f?.type === 'ITEM_DATA' || !f?.type)
        .filter((f) => f?.id)
        .map((f) => ({
            fieldId: f.id,
            value: f.value == null ? '' : String(f.value),
        }));

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

/** SOLD с buyer / не editable — republish того же id бесполезен. */
export function needsCloneRepublish(itemMeta) {
    if (!itemMeta) return false;
    if (itemMeta.status === 'APPROVED' && !itemMeta.buyer) return false;
    if (itemMeta.editable === false) return true;
    if (itemMeta.status === 'SOLD' && (itemMeta.buyer?.id || itemMeta.buyer?.username)) {
        return true;
    }
    return false;
}
