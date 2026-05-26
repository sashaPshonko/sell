import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';
import { flattenMessages } from '../parse.mjs';

loadEnv();

const chatId = process.argv[2];
if (!chatId) {
    console.error('Использование: npm run messages -- CHAT_ID');
    process.exit(1);
}

const client = createClient();
const data = await client.chatMessages(chatId);
const messages = flattenMessages(data);

for (const m of messages) {
    const deal = m.deal ? ` deal=${m.deal.status}` : '';
    console.log(`${m.createdAt} | ${m.text?.slice(0, 40)}${deal}`);
}
