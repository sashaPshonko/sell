import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';
loadEnv();
const client = createClient();
const itemId = '1f187aa5-5b65-69c0-6b01-21c4121ac384';
const file = './captures/publish-item.graphql';

async function tryPublish(label, input) {
  try {
    console.log('try', label, JSON.stringify(input));
    const data = await client.runMutationFromFile(
      'PUBLISH_ITEM_MUTATION_FILE',
      file,
      { input },
      'publishItem',
      '/products/[slug]',
    );
    console.log('OK', data?.publishItem?.status, data?.publishItem?.slug);
  } catch (e) {
    console.log('FAIL', label, e.message);
  }
}

await tryPublish('empty', {
  transactionProviderId: 'LOCAL',
  priorityStatuses: [],
  itemId,
  transactionProviderData: { paymentMethodId: null },
});

await tryPublish('no-provider-data', {
  transactionProviderId: 'LOCAL',
  priorityStatuses: [],
  itemId,
});

const st = await client.itemPriorityStatuses(
  itemId,
  700,
  'https://playerok.com/products/21c4121ac384-300kk-momentalno-bonus',
);
console.log('statuses@700 raw:', JSON.stringify(st?.itemPriorityStatuses)?.slice(0, 2000));

const premium = (st?.itemPriorityStatuses || [])[0];
const sid = premium?.id || premium?.status?.id;
if (sid) {
  await tryPublish('premium-id', {
    transactionProviderId: 'LOCAL',
    priorityStatuses: [sid],
    itemId,
    transactionProviderData: { paymentMethodId: null },
  });
}
