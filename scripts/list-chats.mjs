import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';
import { flattenChats } from '../parse.mjs';

loadEnv();

const client = createClient();
const v = await client.viewer();
const userId = process.env.PLAYEROK_USER_ID || v.viewer.id;
const data = await client.userChats(userId);
const chats = flattenChats(data);

console.log(JSON.stringify(chats, null, 2));
