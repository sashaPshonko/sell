/** Ошибки бота / сети — повтор без /nick */
export const RETRYABLE_DELIVERY_REASONS = new Set([
    'delivery_loop_crash',
    'connect_failed',
    'kicked',
    'disconnected',
    'worker_crash',
    'anarchy_join_failed',
]);

/** Покупатель / финал / таймаут — только /nick или стоп */
export const TERMINAL_DELIVERY_REASONS = new Set([
    'invalid',
    'invalid_nick',
    'player_in_other_clan',
    'insufficient_funds',
    'banned',
    'captcha',
    'offline',
    'player_offline',
    'clan_timeout',
    'clan_withdraw_timeout',
    'max_retries',
    'timeout',
]);

export const MAX_DELIVERY_RETRIES = 5;
export const DELIVERY_RETRY_DELAY_MS = 15_000;

export function isRetryableDeliveryFailure(reason) {
    return RETRYABLE_DELIVERY_REASONS.has(String(reason || ''));
}

export function isTerminalDeliveryFailure(reason) {
    return TERMINAL_DELIVERY_REASONS.has(String(reason || ''));
}
