import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { loadEnv } from './env.mjs';
import { createClient } from '../playerok-client.mjs';

loadEnv();
import { flattenChats, flattenMessages, findPaidDealInChat } from '../parse.mjs';

const OUT = './captures/snapshots';

export async function runApiSnapshot() {
    await mkdir(OUT, { recursive: true });
    const client = createClient();
    const report = { ok: true, at: new Date().toISOString(), steps: [] };

    const viewer = await client.viewer();
    await writeFile(join(OUT, 'viewer.json'), JSON.stringify(viewer, null, 2));
    report.steps.push({ step: 'viewer', username: viewer.viewer?.username, id: viewer.viewer?.id });

    const userId = viewer.viewer.id;
    let chatsData;
    try {
        chatsData = await client.userChats(userId);
        await writeFile(join(OUT, 'userChats.json'), JSON.stringify(chatsData, null, 2));
        report.steps.push({ step: 'userChats', ok: true });
    } catch (e) {
        report.steps.push({ step: 'userChats', ok: false, error: e.message });
        report.ok = false;
        return report;
    }

    const chats = flattenChats(chatsData);
    report.chatsCount = chats.length;
    await writeFile(join(OUT, 'chats-flat.json'), JSON.stringify(chats, null, 2));

    const sample = chats.find((c) => c.lastMessage?.deal) || chats[0];
    if (!sample?.id) {
        report.steps.push({ step: 'chatMessages', ok: false, error: 'нет чатов' });
        return report;
    }

    report.sampleChatId = sample.id;
    try {
        const msgData = await client.chatMessages(sample.id);
        await writeFile(join(OUT, 'chatMessages.json'), JSON.stringify(msgData, null, 2));
        const messages = flattenMessages(msgData);
        await writeFile(join(OUT, 'messages-flat.json'), JSON.stringify(messages, null, 2));
        const paid = findPaidDealInChat(messages);
        report.steps.push({
            step: 'chatMessages',
            ok: true,
            chatId: sample.id,
            messagesCount: messages.length,
            samplePaid: paid,
        });
    } catch (e) {
        report.steps.push({ step: 'chatMessages', ok: false, error: e.message });
        report.hint = 'Сними CHAT_MESSAGES_HASH из HAR (npm run capture -- file.har)';
    }

    await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    return report;
}
