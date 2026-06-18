/**
 * Дефолты sell — в .env достаточно PLAYEROK_TOKEN.
 * Переменные из .env при наличии перекрывают эти значения.
 */
export const SELL_DEFAULTS = {
    WS_URL: 'ws://127.0.0.1:8790',
    POLL_MS: '15000',
    CHAT_MESSAGES_FIRST: '20',

    USER_CHATS_HASH:
        '999f86b7c94a4cb525ed5549d8f24d0d24036214f02a213e8fd7cefc742bbd58',
    CHAT_MESSAGES_HASH:
        '8e795b5d1562a14662a60b82d44255586ba1946d743214823dcf064df76d704e',

    ITEMS_HASH: 'bacca5d020eef37b4ff7a2253ad33ecd8b7e144b9ef854c20051f42ebcd04d82',

    SEND_MESSAGE_OPERATION: 'createChatMessage',
    SEND_MESSAGE_MUTATION_FILE: './captures/send-message.graphql',
    SEND_MESSAGE_VARIABLES:
        '{"input":{"chatId":"CHAT_ID","imagesIds":[],"text":"MESSAGE_TEXT"}}',

    CONFIRM_DEAL_OPERATION: 'updateDeal',
    CONFIRM_DEAL_MUTATION_FILE: './captures/update-deal.graphql',
    CONFIRM_DEAL_STATUS: 'SENT',
    AUTO_MARK_PLAYEROK: '1',

    AUTO_CANCEL_PLAYEROK: '1',
    CANCEL_DEAL_OPERATION: 'updateDeal',
    CANCEL_DEAL_MUTATION_FILE: './captures/cancel-deal.graphql',
    CANCEL_DEAL_STATUS: 'ROLLED_BACK',
    CANCEL_DEAL_VARIABLES: '{"input":{"id":"DEAL_ID","status":"ROLLED_BACK"}}',

    REPUBLISH_WHEN: 'sent',
    PUBLISH_DELAY_MS: '10000',
    PUBLISH_TRANSACTION_PROVIDER: 'LOCAL',
    /** «Обычный» (DEFAULT), не «Премиум» */
    PUBLISH_PRIORITY_STATUS_ID: '1efbe5bc-99a7-68e5-4534-85dad913b981',
    PUBLISH_PRIORITY_STATUSES: '["1efbe5bc-99a7-68e5-4534-85dad913b981"]',
    ITEM_PRIORITY_STATUSES_HASH:
        'b922220c6f979537e1b99de6af8f5c13727daeff66727f679f07f986ce1c025a',
    PUBLISH_ITEM_OPERATION: 'publishItem',
    PUBLISH_ITEM_MUTATION_FILE: './captures/publish-item.graphql',
    PUBLISH_ITEM_GQL_PATH: '/products/[slug]',
};

export function applySellDefaults() {
    for (const [key, value] of Object.entries(SELL_DEFAULTS)) {
        if (process.env[key] === undefined || process.env[key] === '') {
            process.env[key] = value;
        }
    }
}
