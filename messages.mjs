import { REPEAT_EXTRA_PCT, formatWheelBonusTiersText } from './lib/pay-bonus.mjs';
import { DELIVERY_ANARCHY } from './config.mjs';

export { DELIVERY_ANARCHY };

function askNickInChatLine() {
    return '💬 Напиши в этом чате PlayerOK свой ник (не в Minecraft).';
}

/** Предупреждение: выдача через клан — риск бана, только твинк. */
export function twinAccountWarningLines() {
    return [
        '⛔⛔⛔ ОБЯЗАТЕЛЬНО ТВИНК ⛔⛔⛔',
        'Выдача через клан — на основном аккаунте часто дают БАН.',
        'Указывай ник ЗАПАСНОГО аккаунта (твинка), не основного!',
        '————————————————',
    ];
}

/**
 * @param {{ lotKk?: number, repeatEligible?: boolean }} [ctx]
 * Текст после оплаты (без номера заказа — только для логов/WS)
 */
export function buildGreetingText(ctx = null) {
    const custom = process.env.GREETING_MESSAGE?.trim();
    if (custom) return custom;

    const anka = DELIVERY_ANARCHY;
    const lotKk = Number(ctx?.lotKk);
    const repeatEligible = Boolean(ctx?.repeatEligible);

    const bonusLines = [
        '',
        '🎁 БОНУС к выдаче:',
        `После ника к лоту добавим случайный бонус: ${formatWheelBonusTiersText(lotKk)}.`,
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
        ...twinAccountWarningLines(),
        askNickInChatLine(),
        ...bonusLines,
        '',
        '✅ выдача автоматическая - бот выдаст сам',
        '❗ Валюта только на Minecraft 1.21 (FunTime).',
        'На 1.16 не выдаём — отмена: /cancel',
        '💸 Выдача через клан: приглашение → казна → ты снимешь /clan withdraw',
        '🔁 Ошибся в нике или бот не выдал — напиши ник в этом чате снова',
        '❌ Отмена: /cancel',
    ].join('\n');
}

/**
 * Повторная оплата в том же чате — без полного приветствия, но с напоминанием про твинк.
 * @param {{ lotKk?: number, repeatEligible?: boolean }} [ctx]
 */
export function buildNewOrderTwinHint(ctx = null) {
    const anka = DELIVERY_ANARCHY;
    const lotKk = Number(ctx?.lotKk);
    const repeatEligible = Boolean(ctx?.repeatEligible);

    const lines = [
        '✅ Оплата получена.',
        '',
        ...twinAccountWarningLines(),
        `🎮 Анархия ${anka} — будь в сети.`,
        '💸 Выдача теперь через клан (не /pay):',
        'приглашение → казна → ты снимешь /clan withdraw',
        '',
        askNickInChatLine(),
    ];
    if (lotKk > 0) {
        lines.push('', `📦 Лот: ${lotKk}кк`);
    }
    if (repeatEligible) {
        lines.push(`🔁 Повтор за 24ч — ещё +${REPEAT_EXTRA_PCT}% к лоту.`);
    }
    return lines.join('\n');
}

/** Красная «рамка» для бан-сообщений (симметрично сверху и снизу). */
function buildRedAlertFrame(headline, bodyLines, footerLines = []) {
    const border =
        '🛑🛑🛑🛑🛑🛑 ⛔⛔⛔⛔⛔⛔ ⛔⛔⛔⛔⛔⛔ 🛑🛑🛑🛑🛑🛑';
    const title = `🔴🔴🔴🔴🔴 ${headline} 🔴🔴🔴🔴🔴`;
    const footer =
        '🛑🛑🛑🛑🛑🛑 🔴🔴🔴🔴🔴🔴 🔴🔴🔴🔴🔴🔴 🛑🛑🛑🛑🛑🛑';

    return [
        border,
        title,
        border,
        '',
        ...bodyLines,
        '',
        ...footerLines,
        '',
        border,
        footer,
        border,
    ].join('\n');
}

/** Сразу после /ban продавцом — заказы с аккаунта не принимаются. */
export function buildBannedBuyerBlockedNotice() {
    return buildRedAlertFrame('ЗАКАЗЫ НЕ ПРИНИМАЮТСЯ', [
        '🚫🚫 Тебя добавили в банлист продавца.',
        '❌❌ С этого аккаунта валюту больше не выдают.',
        '🚫🚫 Любые новые оплаты будут отменены с возвратом.',
    ]);
}

/** Забаненный покупатель снова оплатил — возврат, без выдачи. */
export function buildBannedBuyerRefundHint(playerokCancelled = false) {
    const footer = ['💰💰 Оплата возвращена.'];
    if (playerokCancelled) {
        footer.push('✅✅ Возврат оформлен на PlayerOK.');
    } else {
        footer.push('💬💬 Если деньги не вернулись — поддержка PlayerOK.');
    }

    return buildRedAlertFrame('ВЫДАЧА ОТКЛОНЕНА', [
        '⛔⛔ Продавец посчитал, что тебе больше не стоит выдавать валюту.',
        '🚫🚫 Повторные покупки с этого аккаунта не принимаются.',
    ], footer);
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
        '👤 Нужен ник Minecraft: 3–16 символов, a-z, A-Z, 0-9, _',
        askNickInChatLine(),
    ].join('\n');
}

function retryNickAfterFailLines() {
    return [askNickInChatLine()];
}

export function buildRetryNickHint() {
    const anka = DELIVERY_ANARCHY;
    return [
        '⏳ Сейчас не удалось выдать (сервер занят или ты не в сети в игре).',
        '',
        `🎮 Зайди на анархию ${anka} и будь в сети.`,
        ...retryNickAfterFailLines(),
    ].join('\n');
}

/**
 * Покупателю — почему не выдали (капча / бан бота / нет монет / офлайн).
 * @param {string} [reason]
 */
export function buildDeliveryFailHint(reason) {
    const anka = DELIVERY_ANARCHY;
    const lines = ['❌ Не удалось выдать.', ''];

    switch (reason) {
        case 'captcha':
            lines.push(
                '📋 Причина: капча на сервере (бот не смог зайти).',
                '⏳ Это не твоя ошибка — попробуем снова чуть позже.',
                '',
                '🤖 Боту нужно ввести капчу в Minecraft — выдача временно стоит.',
            );
            break;
        case 'banned':
            lines.push(
                '📋 Причина: аккаунт бота заблокирован на сервере.',
                '⏳ Это не твоя ошибка — попробуем снова чуть позже.',
                '',
                '🤖 Аккаунт бота забанен на FunTime — выдача временно стоит.',
            );
            break;
        case 'insufficient_funds':
            lines.push(
                '📋 Причина: на балансе бота не хватило монет для выдачи через клан.',
                '⏳ Пополним баланс и выдадим — напиши /nick чуть позже.',
            );
            break;
        case 'player_offline':
        case 'offline':
            lines.push(
                '📋 Причина: тебя нет на сервере (или не на нужной анархии).',
                '',
                `🎮 Зайди на анархию ${anka} и будь в сети.`,
            );
            break;
        default:
            return buildRetryNickHint();
    }

    lines.push('', ...retryNickAfterFailLines());
    return lines.join('\n');
}

/** Таймаут выдачи — заказ сброшен, нужен повторный /nick */
export function buildQueueStallHint() {
    const anka = DELIVERY_ANARCHY;
    return [
        '⏱ Не успели завершить выдачу через клан (таймаут 1 мин на шаг).',
        '',
        `🎮 Будь на анархии ${anka} и в сети.`,
        askNickInChatLine(),
        '',
        '💰 Валюта придёт после того, как напишешь ник.',
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
    return '🎁 Повторная покупка в течение 24 ч — ещё +5% к валюте (🔁 «Бонус за повторную покупку»).';
}

/** Нет конкретного лота-аналога — подсказка про 🎁 на профиле (без ссылки). */
export function buildProfileBrowseHint(opts = {}) {
    const marker = opts.emoji || '🎁';
    return `💡 На профиле выгоднее — лоты с ${marker} в названии (пролистай вниз).`;
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

    const priceBit =
        priceRub != null && priceRub > 0 ? `за ${priceRub} ₽` : 'за ту же цену';

    const compareBit =
        baseKk != null && baseKk > 0 && upsellKk > baseKk ? ` (сейчас ${baseKk}кк)` : '';

    const lines = [
        `💡 На профиле: ${upsellKk}кк ${priceBit}${compareBit} — пролистай вниз, в названии лота ${marker}`,
    ];
    if (url) lines.push(url);
    return lines.join('\n');
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
    const anka = DELIVERY_ANARCHY;
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
        '⛔ Ник должен быть твинка — на основном высокий риск бана.',
        'Если не пришло за минуту — напиши ник в этом чате.',
    );
    return lines.join('\n');
}

/** После отправки приглашения в клан */
export function buildClanInviteHint(nick) {
    const anka = DELIVERY_ANARCHY;
    return [
        `📨 Приглашение в клан отправлено игроку «${nick}».`,
        '',
        `🎮 Зайди на анархию ${anka} и ПРИМИ приглашение в клан.`,
        '⏳ Жди — после вступления бот вложит деньги в казну.',
    ].join('\n');
}

/** Полная сумма заказа в монетах (kk × 1M) */
export function clanFullAmountRaw(orderOrKk, multiplier = 1_000_000) {
    const kk =
        typeof orderOrKk === 'object'
            ? (orderOrKk.payAmountKk ?? orderOrKk.amountKk)
            : orderOrKk;
    return String(Math.round(Number(kk) * multiplier));
}

/** После /clan invest — снять всю сумму заказа */
export function buildClanWithdrawHint(nick, fullAmountRaw) {
    const anka = DELIVERY_ANARCHY;
    const amount = String(fullAmountRaw || '').replace(/\D/g, '') || '?';
    return [
        `💰 Деньги вложены в казну клана для «${nick}».`,
        '',
        `🎮 На анархии ${anka} сними ВСЮ сумму заказа:`,
        `/clan withdraw ${amount}`,
        '',
        '⏳ Нужно снять полностью — можно несколькими withdraw, но итого должна совпасть.',
        'Если не снимешь всё — остаток заберёт бот после кика из клана.',
    ].join('\n');
}

/** Игрок снял не всю сумму — напомнить про полную */
export function buildClanPartialWithdrawHint(nick, fullAmountRaw) {
    const anka = DELIVERY_ANARCHY;
    const amount = String(fullAmountRaw || '').replace(/\D/g, '') || '?';
    return [
        `⚠️ Ты снял не всю сумму из казны.`,
        '',
        `🎮 На анархии ${anka} сними ВСЮ сумму заказа:`,
        `/clan withdraw ${amount}`,
        '',
        'Можно частями, но итого должна совпасть с суммой заказа.',
        '',
        askNickInChatLine(),
        '💰 Бот продолжит выдачу после /nick.',
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
