import prismarineChat from 'prismarine-chat';

const ChatMessage = prismarineChat('1.21.11');

function flattenChatFallback(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') {
        try {
            return flattenChatFallback(JSON.parse(raw));
        } catch {
            return raw;
        }
    }
    if (typeof raw !== 'object') return String(raw);
    let out = raw.text ?? '';
    if (Array.isArray(raw.extra)) {
        for (const part of raw.extra) out += flattenChatFallback(part);
    }
    if (raw.translate && Array.isArray(raw.with)) {
        for (const part of raw.with) out += flattenChatFallback(part);
    }
    return out;
}

function chatTextFromFormatted(raw) {
    if (raw == null || raw === '') return '';
    try {
        return ChatMessage.fromNotch(raw).toString();
    } catch {
        return flattenChatFallback(raw);
    }
}

export function chatTextFromRaw(data) {
    if (data?.plainMessage) return String(data.plainMessage);
    const formatted = data?.formattedMessage ?? data?.content ?? data?.unsignedContent;
    if (typeof formatted === 'string') {
        try {
            return chatTextFromFormatted(JSON.parse(formatted));
        } catch {
            return chatTextFromFormatted(formatted);
        }
    }
    return chatTextFromFormatted(formatted);
}

/** Funtime: chat_type в registry битый — не используем ChatMessage.fromNetwork. */
export function setupChatSafeGuard(bot, onText) {
    const client = bot._client;
    if (!client) return;

    client.removeAllListeners('playerChat');
    client.removeAllListeners('systemChat');

    client.on('playerChat', (data) => {
        const text = chatTextFromRaw(data);
        if (text) onText(text);
    });

    client.on('systemChat', (data) => {
        const text = chatTextFromRaw(data);
        if (text) onText(text);
    });
}
