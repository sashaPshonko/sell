import { buildGreetingText } from './messages.mjs';

/**
 * Отправка сообщения в чат PlayerOK.
 * Нужен mutation из DevTools (см. captures/send-message.graphql).
 */
export async function sendChatMessage(client, chatId, text) {
    const file = process.env.SEND_MESSAGE_MUTATION_FILE || './captures/send-message.graphql';
    const op = process.env.SEND_MESSAGE_OPERATION || 'createChatMessage';

    let variables = {
        input: { chatId, imagesIds: [], text },
    };
    const varsRaw = process.env.SEND_MESSAGE_VARIABLES;
    if (varsRaw) {
        const escaped = JSON.stringify(text).slice(1, -1);
        variables = JSON.parse(
            varsRaw.replaceAll('CHAT_ID', chatId).replaceAll('MESSAGE_TEXT', escaped),
        );
    }

    return client.runMutationFromFile('SEND_MESSAGE_MUTATION_FILE', file, variables, op);
}

/**
 * @param {{ orderId?: string, lotKk?: number, repeatEligible?: boolean }} [ctx]
 */
export async function sendGreeting(client, chatId, ctx = null) {
    const orderId = ctx?.orderId ?? ctx;
    const greetingCtx =
        ctx && typeof ctx === 'object' && !Array.isArray(ctx)
            ? {
                  lotKk: ctx.lotKk,
                  repeatEligible: ctx.repeatEligible,
              }
            : null;
    const text = buildGreetingText(greetingCtx);
    console.log(`[sell] приветствие → чат ${chatId} (${orderId ?? '?'})`);
    return sendChatMessage(client, chatId, text);
}
