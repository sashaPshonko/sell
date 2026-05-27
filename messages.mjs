export const DELIVERY_ANARCHY = () => process.env.DELIVERY_ANARCHY || '502';

/** Текст после оплаты (без номера заказа — только для логов/WS) */
export function buildGreetingText() {
    const custom = process.env.GREETING_MESSAGE?.trim();
    if (custom) return custom;

    const anka = DELIVERY_ANARCHY();

    return [
        `ЗАХОДИ НА АНАРХИЮ ${anka}`,
        'ПОСЛЕ ЭТОГО НАПИШИ НИК ОДНИМ СЛОВОМ',
        'твой-ник',
        'или /nick твой-ник',
        '',
        '✅ выдача автоматическая - бот выдаст сам',
        '❗ Валюта только на Minecraft 1.21 (FunTime).',
        'На 1.16 не выдаём — отмена: /cancel',
        '💸 Выдача через /pay на сервере (автоматически).',
        '👥 Лучше купи на твинк, тк через /pay могут забанить',
        '🔁 Ошибся в нике: /nick твой-ник',
        '⏳ Бот не выдал — повтори: /nick твой-ник',
        '❌ Отмена: /cancel',
    ].join('\n');
}

export function buildOrderCancelledHint(playerokCancelled = false) {
    const lines = [
        '❌ Заказ отменён.',
        '',
        '💰 Валюта не будет выдана.',
    ];
    if (playerokCancelled) {
        lines.push('', '✅ Отмена отправлена на PlayerOK.');
    } else {
        lines.push(
            '',
            '💬 Оплата уже прошла? Оформи возврат через поддержку PlayerOK.',
        );
    }
    return lines.join('\n');
}

export function buildWrongNickHint() {
    return [
        '⚠️ Ник не подошёл.',
        '',
        '👤 Нужен ник Minecraft: 3–16 символов, a-z, 0-9, _',
        'Исправь: /nick твой-ник',
    ].join('\n');
}

export function buildRetryNickHint() {
    const anka = DELIVERY_ANARCHY();
    return [
        '⏳ Сейчас не удалось выдать (сервер занят или ты не в сети).',
        '',
        `🔁 Зайди на анархию ${anka} и отправь снова:`,
        '/nick твой-ник',
    ].join('\n');
}

/** Таймаут выдачи при очереди — заказ сброшен, нужен повторный /nick */
export function buildQueueStallHint() {
    const anka = DELIVERY_ANARCHY();
    return [
        '⏱ Выдача заняла слишком долго (очередь на сервере).',
        '',
        `🔁 На анархии ${anka} отправь снова:`,
        '/nick твой-ник',
        '',
        '💰 Валюта придёт после повторной команды.',
    ].join('\n');
}

export function buildDeliveryOkHint(amountKk) {
    const sum = amountKk != null && amountKk > 0 ? `${amountKk}kk ` : '';
    return [
        `✅ ${sum}валюта выдана! Приятной игры! 🎮`,
        '',
        '⭐ Пожалуйста, подтверди заказ на PlayerOK.',
        '⭐ Оставь отзыв — это очень помогает!',
    ].join('\n');
}

export function buildOrderAlreadyDoneHint() {
    return [
        '✅ Заказ уже выполнен — валюта выдана.',
        '',
        '🔁 Менять ник через /nick не нужно.',
    ].join('\n');
}

/** Сразу после ника — перед выдачей на сервере */
export function buildDispatchingHint(nick, amountKk) {
    const anka = DELIVERY_ANARCHY();
    const sum = amountKk != null && amountKk > 0 ? `${amountKk}kk ` : '';
    return [
        `⏳ Сейчас выдаю ${sum}на ник «${nick}».`,
        '',
        `🎮 Будь на анархии ${anka} и в сети (FunTime 1.21).`,
        'Если не пришло за минуту — /nick твой-ник',
    ].join('\n');
}

export function hasGreetingInChat(messages, sellerUserId) {
    const marker = (process.env.GREETING_MARKER || 'выдача автоматическая').toLowerCase();
    for (const msg of messages) {
        if (!msg?.text || msg.user?.id !== sellerUserId) continue;
        if (msg.text.toLowerCase().includes(marker)) return true;
    }
    return false;
}
