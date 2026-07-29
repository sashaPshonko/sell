import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';

loadEnv();
const client = createClient();

async function meta(slug) {
    const data = await client.itemBySlug(slug);
    const i = data?.item || data;
    return {
        id: i?.id,
        status: i?.status,
        buyer: i?.buyer?.username || null,
        mayBePublished: i?.mayBePublished,
        editable: i?.editable,
        rawPrice: i?.rawPrice ?? i?.price,
        name: i?.name,
        slug: i?.slug,
    };
}

async function tryPublish(item, label) {
    console.log('\n==', label, item);
    if (!item?.id) return;
    try {
        const price = item.rawPrice || 0;
        const st = await client.itemPriorityStatuses(
            item.id,
            price,
            `https://playerok.com/products/${item.slug}`,
        );
        const list = st?.itemPriorityStatuses || [];
        console.log(
            'statuses',
            list.map((s) => s.name),
            'mayPub',
            item.mayBePublished,
            'buyer',
            item.buyer,
        );
        const sid =
            list.find((s) => /обычн/i.test(s.name || ''))?.id ||
            list.find((s) => s.type === 'DEFAULT' || s.price === 0)?.id ||
            list[0]?.id;
        if (!sid && list.length) {
            console.log('no status id');
            return;
        }
        const data = await client.runMutationFromFile(
            'PUBLISH_ITEM_MUTATION_FILE',
            './captures/publish-item.graphql',
            {
                input: {
                    transactionProviderId: 'LOCAL',
                    priorityStatuses: sid ? [sid] : [],
                    itemId: item.id,
                    transactionProviderData: { paymentMethodId: null },
                },
            },
            'publishItem',
            `/products/${item.slug}`,
        );
        console.log('PUB OK', data?.publishItem?.status, data?.publishItem?.slug);
    } catch (e) {
        console.log('PUB FAIL', e.message);
    }
}

const slugs = [
    'be4ce1655490-30kk-momentalno-bonus', // DRAFT from list
    '88eee261a885-20kk-momentalno-bonus', // older SOLD
    '596c59ddc819-55kk-momentalno-bonus', // gift SOLD
    'ec8ebe404c07-20kk-momentalno-bonus', // recent with buyer
];

for (const slug of slugs) {
    try {
        const m = await meta(slug);
        await tryPublish(m, slug.slice(0, 20));
    } catch (e) {
        console.log(slug, 'meta fail', e.message);
    }
}
