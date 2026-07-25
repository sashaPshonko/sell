import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';
loadEnv();
const client = createClient();
const slug = process.argv[2] || '21c4121ac384-300kk-momentalno-bonus';
const data = await client.itemBySlug(slug);
const i = data?.item;
if (!i) {
  console.log('no item');
  process.exit(1);
}
console.log(JSON.stringify({
  id: i.id,
  slug: i.slug,
  name: i.name,
  status: i.status,
  mayBePublished: i.mayBePublished,
  editable: i.editable,
  price: i.price,
  rawPrice: i.rawPrice,
  buyer: i.buyer?.username || i.buyer?.id || null,
  deletedAt: i.deletedAt,
  statusDescription: i.statusDescription,
  statusExpirationDate: i.statusExpirationDate,
  priority: i.priority,
  approvalDate: i.approvalDate,
  user: i.user?.username,
}, null, 2));
