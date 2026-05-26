import { config } from 'dotenv';
import { createClient } from '../playerok-client.mjs';
import { sendGreeting } from '../chat.mjs';

config();

const chatId = process.argv[2];
if (!chatId) {
    console.error('Использование: node scripts/send-greeting.mjs CHAT_ID');
    process.exit(1);
}

const client = createClient();
await sendGreeting(client, chatId);
console.log('OK');
