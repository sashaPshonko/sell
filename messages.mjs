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
        'или /nick твой-ник [В ЭТОМ ЧАТЕ]',
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

function fmtKk(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '0kk';
    return `${v}kk`;
}

function fmtBonusKk(kk, pct) {
    const k = Number(kk) || 0;
    const p = Number(pct) || 0;
    if (k <= 0) return '—';
    return p > 0 ? `+${k}kk (+${p}%)` : `+${k}kk`;
}

/**
 * @param {object} [bonus]
 * @param {number} [bonus.lotKk]
 * @param {number} [bonus.payAmountKk]
 * @param {number} [bonus.wheelPct]
 * @param {number} [bonus.repeatPct]
 * @param {number} [bonus.bonusWheelKk]
 * @param {number} [bonus.bonusRepeatKk]
 */
export function buildDeliveryOkHint(amountKk, bonus = null) {
    const lot = Number(bonus?.lotKk ?? amountKk) || 0;
    const paid = Number(bonus?.payAmountKk ?? amountKk) || 0;
    const wheelKk =
        bonus?.bonusWheelKk ??
        (bonus?.wheelPct > 0 ? Math.round((lot * bonus.wheelPct) / 100) : 0);
    const repeatKk =
        bonus?.bonusRepeatKk ??
        (bonus?.repeatPct > 0 ? Math.round((lot * bonus.repeatPct) / 100) : 0);
    const wheelPct = bonus?.wheelPct ?? 0;
    const repeatPct = bonus?.repeatPct ?? 0;

    const lines = ['✅ Валюта выдана!', ''];

    if (lot > 0 && paid > 0) {
        lines.push(`💰 Итого выдано: ${fmtKk(paid)}`, '');
        lines.push(`📦 По заказу (лот): ${fmtKk(lot)}`);

        if (wheelKk > 0 || wheelPct > 0) {
            lines.push(`🎲 Случайный бонус: ${fmtBonusKk(wheelKk, wheelPct)}`);
        }

        if (repeatKk > 0 || repeatPct > 0) {
            lines.push(
                `🔁 Бонус за повторную покупку (24ч): ${fmtBonusKk(repeatKk, repeatPct)}`,
            );
        }

        lines.push('', '🎮 Приятной игры!');
    } else {
        lines.push('🎮 Приятной игры!');
    }

    lines.push(
        '',
        '⭐ Пожалуйста, подтверди заказ на PlayerOK.',
        '⭐ Оставь отзыв — это очень помогает!',
    );
    return lines.join('\n');
}

/** Через 10с после подтверждения сделки на PlayerOK */
export function buildRepeatPurchaseHint() {
    return [
        '🎁 Хочешь ещё валюту?',
        '',
        'Если купишь снова в течение 24 часов — к случайному бонусу добавим отдельную строку:',
        '🔁 «Бонус за повторную покупку» — ещё +5% к сумме лота.',
        '',
        '⚡ Выдача автоматическая — после оплаты напиши ник.',
    ].join('\n');
}

/**
 * @param {{ emoji: string, upsellKk: number, baseKk?: number, priceRub?: number, url: string }} opts
 */
export function buildProfileUpsellHint(opts) {
    const marker = opts.emoji || '🎁';
    const upsellKk = Math.round(Number(opts.upsellKk) || 0);
    const baseKk = opts.baseKk != null ? Math.round(Number(opts.baseKk)) : null;
    const priceRub = opts.priceRub != null ? Math.round(Number(opts.priceRub)) : null;
    const url = String(opts.url || '').trim();

    const priceLine =
        priceRub != null && priceRub > 0
            ? `за те же ${priceRub} ₽`
            : 'за ту же цену';

    const compareLine =
        baseKk != null && baseKk > 0 && upsellKk > baseKk
            ? `больше, чем ${baseKk}kk в этом заказе`
            : 'больше валюты за те же деньги';

    const titleExample = `${upsellKk}KK ${marker} МОМЕНТАЛЬНО ${marker} БОНУС`;

    return [
        '💡 На профиле выгоднее',
        '',
        `Следующий раз: «${titleExample}» ${priceLine} — ${compareLine}.`,
        '',
        `👇 Пролистай профиль вниз — в названии ${marker} вместо · (больше kk за те же ₽, без премки).`,
        url,
    ].join('\n');
}

export function buildOrderAlreadyDoneHint() {
    return [
        '✅ Заказ уже выполнен — валюта выдана.',
        '',
        '🔁 Менять ник через /nick не нужно.',
    ].join('\n');
}

/** Закрыто на PlayerOK, в игру sellbot не платил */
export function buildOrderClosedOnPlayerokHint() {
    return [
        '✅ Сделка на PlayerOK уже закрыта (подтверждена).',
        '',
        'Если валюта в игру не приходила — напиши в поддержку PlayerOK.',
        'Новый /nick для этой оплаты не сработает.',
    ].join('\n');
}

/** Сразу после ника — перед выдачей на сервере */
export function buildDispatchingHint(nick, amountKk, payAmountKk = null) {
    const anka = DELIVERY_ANARCHY();
    const pay = payAmountKk != null && payAmountKk > 0 ? payAmountKk : amountKk;
    const sum = pay != null && pay > 0 ? `${pay}kk ` : '';
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
