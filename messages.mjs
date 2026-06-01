import { REPEAT_EXTRA_PCT } from './lib/pay-bonus.mjs';

export const DELIVERY_ANARCHY = () => process.env.DELIVERY_ANARCHY || '502';

/**
 * @param {{ lotKk?: number, repeatEligible?: boolean }} [ctx]
 * Текст после оплаты (без номера заказа — только для логов/WS)
 */
export function buildGreetingText(ctx = null) {
    const custom = process.env.GREETING_MESSAGE?.trim();
    if (custom) return custom;

    const anka = DELIVERY_ANARCHY();
    const lotKk = Number(ctx?.lotKk);
    const repeatEligible = Boolean(ctx?.repeatEligible);

    const bonusLines = [
        '',
        '🎁 БОНУС к выдаче:',
        'После ника к лоту добавим случайный бонус: +5%, +8%, +12% или +15%.',
    ];
    if (repeatEligible) {
        bonusLines.push(
            `🔁 У тебя повторная покупка за 24 часа — ещё +${REPEAT_EXTRA_PCT}% к лоту!`,
        );
    } else {
        bonusLines.push(
            `🔁 Купишь снова в течение 24ч — к бонусу добавим ещё +${REPEAT_EXTRA_PCT}%.`,
        );
    }
    if (lotKk > 0) {
        bonusLines.push(
            '',
            `📦 Лот заказа: ${lotKk}кк — итоговая выдача будет больше (лот + бонусы).`,
        );
    }

    return [
        `ЗАХОДИ НА АНАРХИЮ ${anka}`,
        'ПОСЛЕ ЭТОГО НАПИШИ НИК В ЭТОМ ЧАТЕ PlayerOK (не в игре):',
        'ник твой-ник',
        'или /nick твой-ник',
        ...bonusLines,
        '',
        '✅ выдача автоматическая - бот выдаст сам',
        '❗ Валюта только на Minecraft 1.21 (FunTime).',
        'На 1.16 не выдаём — отмена: /cancel',
        '💸 Выдача через /pay на сервере (автоматически).',
        '👥 Лучше купи на твинк, тк через /pay могут забанить',
        '🔁 Ошибся в нике — напиши в ЭТОМ чате: /nick твой-ник',
        '⏳ Бот не выдал — повтори в ЭТОМ чате: /nick твой-ник',
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
        'Напиши в ЭТОМ чате PlayerOK:',
        'ник твой-ник',
        'или /nick твой-ник',
    ].join('\n');
}

export function buildRetryNickHint() {
    const anka = DELIVERY_ANARCHY();
    return [
        '⏳ Сейчас не удалось выдать (сервер занят или ты не в сети в игре).',
        '',
        `🎮 Зайди на анархию ${anka} и будь в сети.`,
        '💬 В ЭТОМ чате PlayerOK (не в игровой чат!) отправь снова:',
        '/nick твой-ник',
        'или: ник твой-ник',
    ].join('\n');
}

/** Таймаут выдачи при очереди — заказ сброшен, нужен повторный /nick */
export function buildQueueStallHint() {
    const anka = DELIVERY_ANARCHY();
    return [
        '⏱ Выдача заняла слишком долго (очередь на сервере).',
        '',
        `🎮 Будь на анархии ${anka} и в сети.`,
        '💬 В ЭТОМ чате PlayerOK (не в Minecraft!) напиши снова:',
        '/nick твой-ник',
        '',
        '💰 Валюта придёт после повторной команды в этом чате.',
    ].join('\n');
}

function fmtKk(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '0кк';
    return `${v}кк`;
}

function fmtBonusKk(kk, pct) {
    const k = Number(kk) || 0;
    const p = Number(pct) || 0;
    if (k <= 0) return '—';
    return p > 0 ? `+${k}кк (+${p}%)` : `+${k}кк`;
}

/**
 * @param {object} bonus
 * @param {number} [bonus.lotKk]
 * @param {number} [bonus.payAmountKk]
 * @param {number} [bonus.wheelPct]
 * @param {number} [bonus.repeatPct]
 * @param {number} [bonus.bonusWheelKk]
 * @param {number} [bonus.bonusRepeatKk]
 * @param {number} [defaultLotKk]
 */
function resolvePayoutParts(bonus, defaultLotKk = 0) {
    const lot = Number(bonus?.lotKk ?? defaultLotKk) || 0;
    const paid = Number(bonus?.payAmountKk ?? defaultLotKk) || 0;
    const wheelPct = bonus?.wheelPct ?? 0;
    const repeatPct = bonus?.repeatPct ?? 0;
    const wheelKk =
        bonus?.bonusWheelKk ??
        (wheelPct > 0 ? Math.round((lot * wheelPct) / 100) : 0);
    const repeatKk =
        bonus?.bonusRepeatKk ??
        (repeatPct > 0 ? Math.round((lot * repeatPct) / 100) : 0);
    return { lot, paid, wheelKk, repeatKk, wheelPct, repeatPct };
}

/** @param {object} bonus @param {number} [defaultLotKk] @param {{ totalLabel?: string }} [opts] */
function buildPayoutBreakdownLines(bonus, defaultLotKk = 0, opts = null) {
    const { lot, paid, wheelKk, repeatKk, wheelPct, repeatPct } = resolvePayoutParts(
        bonus,
        defaultLotKk,
    );
    if (lot <= 0 || paid <= 0) return [];

    const totalLabel = opts?.totalLabel || 'Итого';
    const lines = [`💰 ${totalLabel}: ${fmtKk(paid)}`, `📦 Лот: ${fmtKk(lot)}`];

    if (wheelKk > 0 || wheelPct > 0) {
        lines.push(`🎲 Случайный бонус: ${fmtBonusKk(wheelKk, wheelPct)}`);
    }

    if (repeatKk > 0 || repeatPct > 0) {
        lines.push(
            `🔁 Бонус за повторную покупку (24ч): ${fmtBonusKk(repeatKk, repeatPct)}`,
        );
    }

    return lines;
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
    const breakdown = buildPayoutBreakdownLines(bonus, amountKk, { totalLabel: 'Итого выдано' });
    const lines = ['✅ Валюта выдана!', ''];

    if (breakdown.length) {
        lines.push(...breakdown, '', '🎮 Приятной игры!');
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

/** Нет конкретного лота-аналога — подсказка про 🎁 на профиле (без ссылки). */
export function buildProfileBrowseHint(opts = {}) {
    const marker = opts.emoji || '🎁';
    return [
        '💡 На профиле есть предложения выгоднее',
        '',
        `Пролистай профиль вниз — лоты с ${marker} в названии (больше кк за те же ₽).`,
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
            ? `больше, чем ${baseKk}кк в этом заказе`
            : 'больше валюты за те же деньги';

    const titleExample = `${upsellKk}КК ${marker} МОМЕНТАЛЬНО ${marker} БОНУС`;

    return [
        '💡 На профиле выгоднее',
        '',
        `Следующий раз: «${titleExample}» ${priceLine} — ${compareLine}.`,
        '',
        `👇 Пролистай профиль вниз — в названии ${marker} (больше кк за те же ₽).`,
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

/**
 * Сразу после ника — перед выдачей на сервере.
 * @param {string} nick
 * @param {number} amountKk — сумма лота
 * @param {object|null} [bonus] — payAmountKk и поля бонуса (как у buildDeliveryOkHint)
 */
export function buildDispatchingHint(nick, amountKk, bonus = null) {
    const anka = DELIVERY_ANARCHY();
    const payoutBonus =
        bonus && typeof bonus === 'object'
            ? bonus
            : bonus != null && Number(bonus) > 0
              ? { payAmountKk: bonus, lotKk: amountKk }
              : { lotKk: amountKk, payAmountKk: amountKk };

    const breakdown = buildPayoutBreakdownLines(payoutBonus, amountKk);

    const lines = [`⏳ Сейчас выдаю на ник «${nick}»:`];
    if (breakdown.length) {
        lines.push('', ...breakdown);
    }
    lines.push(
        '',
        `🎮 Будь на анархии ${anka} и в сети (FunTime 1.21).`,
        'Если не пришло за минуту — в ЭТОМ чате: /nick твой-ник',
    );
    return lines.join('\n');
}

export function hasGreetingInChat(messages, sellerUserId) {
    const marker = (process.env.GREETING_MARKER || 'выдача автоматическая').toLowerCase();
    for (const msg of messages) {
        if (!msg?.text || msg.user?.id !== sellerUserId) continue;
        if (msg.text.toLowerCase().includes(marker)) return true;
    }
    return false;
}
