import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';
loadEnv();
const client = createClient();
const v = await client.viewer();
const userId = v?.viewer?.id;
const username = v?.viewer?.username;
console.log('seller', username, userId?.slice(0,8));
const data = await client.sellerCompletedItems(userId, { first: 24, username });
const root = data?.items ?? data?.userItems ?? data;
const edges = root?.edges || root?.nodes || (Array.isArray(root)?root:[]);
const items = edges.map(e => e?.node ?? e).filter(Boolean);
console.log('completed n', items.length);
let noBuyer=0, withBuyer=0, pubOk=0;
for (const i of items) {
  const buyer = i?.buyer?.username || i?.buyer?.id || null;
  if (buyer) withBuyer++; else noBuyer++;
  console.log(i.status, 'buyer='+buyer, 'mayPub='+i.mayBePublished, 'edit='+i.editable, (i.name||'').slice(0,40), (i.slug||'').slice(0,28));
}
console.log('summary withBuyer', withBuyer, 'noBuyer', noBuyer);

// try publish first without buyer if any
const free = items.find(i => !i.buyer && i.mayBePublished && i.id);
if (free) {
  console.log('try free', free.id, free.slug);
  try {
    const st = await client.itemPriorityStatuses(free.id, free.rawPrice || free.price || 0, `https://playerok.com/products/${free.slug}`);
    const list = st?.itemPriorityStatuses || [];
    const sid = list[0]?.id;
    const data2 = await client.runMutationFromFile(
      'PUBLISH_ITEM_MUTATION_FILE', './captures/publish-item.graphql',
      { input: { transactionProviderId: 'LOCAL', priorityStatuses: sid?[sid]:[], itemId: free.id, transactionProviderData: { paymentMethodId: null } } },
      'publishItem', `/products/${free.slug}`);
    console.log('FREE PUB OK', data2?.publishItem?.status);
  } catch (e) {
    console.log('FREE PUB FAIL', e.message);
  }
} else {
  console.log('no buyer-free completed item in first page');
}
