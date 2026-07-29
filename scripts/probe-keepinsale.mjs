import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';

loadEnv();
const client = createClient();

const targets = [
    {
        itemId: '1f18b46e-60d5-6100-1ceb-ec8ebe404c07',
        slug: 'ec8ebe404c07-20kk-momentalno-bonus',
        price: 200,
        note: 'madar4ik stuck',
    },
    {
        itemId: '1f18b641-1401-6980-6da5-28fff2dab03f',
        slug: '28fff2dab03f-100kk-momentalno-bonus',
        price: 420,
        note: 'user curl item (already APPROVED?)',
    },
];

async function tryOne({ itemId, slug, price, note }) {
    console.log('\n====', note, itemId.slice(0, 8));
    const meta = await client.itemBySlug(slug);
    const i = meta?.item || meta;
    console.log({
        status: i?.status,
        buyer: i?.buyer?.username || null,
        mayBePublished: i?.mayBePublished,
        editable: i?.editable,
    });

    const st = await client.itemPriorityStatuses(
        itemId,
        price,
        `https://playerok.com/products/${slug}`,
    );
    const list = st?.itemPriorityStatuses || [];
    const sid =
        list.find((s) => /премиум/i.test(s.name || ''))?.id ||
        list[0]?.id ||
        '1f00f21b-7768-62a0-296f-75a31ee8ce72';
    console.log(
        'statusId',
        sid.slice(0, 8),
        list.map((s) => s.name),
    );

    for (const keepInSale of [false, true, undefined]) {
        const input = {
            priorityStatuses: [sid],
            transactionProviderId: 'LOCAL',
            transactionProviderData: { paymentMethodId: null },
            itemId,
        };
        if (keepInSale !== undefined) input.keepInSale = keepInSale;
        try {
            const data = await client.runMutationFromFile(
                'PUBLISH_ITEM_MUTATION_FILE',
                './captures/publish-item.graphql',
                { input },
                'publishItem',
                `/products/${slug}`,
            );
            console.log(
                `keepInSale=${keepInSale}`,
                'OK',
                data?.publishItem?.status,
                'buyer',
                data?.publishItem?.buyer?.username || null,
            );
            return;
        } catch (e) {
            console.log(`keepInSale=${keepInSale}`, 'FAIL', e.message);
        }
    }
}

for (const t of targets) {
    await tryOne(t);
}
