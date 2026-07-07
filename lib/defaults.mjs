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
        'fb54c09b01fab14903034c0084376122e31c4a704c9094e586c60dd0ffcb3978',

    ITEMS_HASH: '63eefcfd813442882ad846360d925279bc376e8bc85a577ebefbee0f9c78b557',
    ITEM_QUERY_HASH:
        '014b7824712618664cdfd3223504f52f785a46b06561dd9e9c0e9d2e4d8262c6',

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
    PUBLISH_RETRY_MS: '60000',
    PUBLISH_MAX_RETRIES: '5',
    PUBLISH_TRANSACTION_PROVIDER: 'LOCAL',
    /** itemPriorityStatuses — hash persisted query; id статуса берётся из API, не отсюда */
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
