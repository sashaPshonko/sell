import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';

loadEnv();
const client = createClient();
const itemId = process.argv[2] || '1f18b46e-60d5-6100-1ceb-ec8ebe404c07';
const slug = process.argv[3] || 'ec8ebe404c07-20kk-momentalno-bonus';

const st = await client.itemPriorityStatuses(
    itemId,
    200,
    `https://playerok.com/products/${slug}`,
);
const list = st?.itemPriorityStatuses || [];
console.log(
    'statuses',
    list.map((s) => ({
        name: s.name,
        type: s.type,
        price: s.price,
        id: (s.id || '').slice(0, 8),
    })),
);

async function tryPub(label, input) {
    try {
        const data = await client.runMutationFromFile(
            'PUBLISH_ITEM_MUTATION_FILE',
            './captures/publish-item.graphql',
            { input },
            'publishItem',
            `/products/${slug}`,
        );
        console.log(label, 'OK', data?.publishItem?.status, data?.publishItem?.slug);
    } catch (e) {
        console.log(label, 'FAIL', e.message);
    }
}

const sid =
    list.find((s) => /премиум/i.test(s.name || ''))?.id ||
    list.find((s) => s.type === 'PREMIUM')?.id ||
    list[0]?.id;
if (sid) {
    await tryPub('premium', {
        transactionProviderId: 'LOCAL',
        priorityStatuses: [sid],
        itemId,
        transactionProviderData: { paymentMethodId: null },
    });
}
await tryPub('empty', {
    transactionProviderId: 'LOCAL',
    priorityStatuses: [],
    itemId,
    transactionProviderData: { paymentMethodId: null },
});
const def =
    list.find((s) => /обычн/i.test(s.name || ''))?.id ||
    list.find((s) => s.type === 'DEFAULT' || s.price === 0)?.id;
if (def) {
    await tryPub('default', {
        transactionProviderId: 'LOCAL',
        priorityStatuses: [def],
        itemId,
        transactionProviderData: { paymentMethodId: null },
    });
}
