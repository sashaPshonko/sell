import { DELIVERY_ANARCHY } from './config.mjs';

export { DELIVERY_ANARCHY };

function askNickInChatLine() {
    return '💬 Напиши в этом чате свой ник (не в Minecraft).';
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
 * @param {{ lotKk?: number }} [ctx]
 * Текст после оплаты (без номера заказа — только для логов/WS)
 */
export function buildGreetingText(_ctx = null) {
    const custom = process.env.GREETING_MESSAGE?.trim();
    if (custom) return custom;

    const anka = DELIVERY_ANARCHY;

    return [
        `ЗАХОДИ НА АНАРХИЮ ${anka}`,
        ...twinAccountWarningLines(),
        askNickInChatLine(),
        '',
        '✅ выдача автоматическая - бот выдаст сам',
        '❗ Валюта только на Minecraft 1.21 (FunTime).',
        'На 1.16 не выдаём — отмена: /cancel',
        '💸 Выдача через клан: приглашение → казна → ты снимешь /clan withdraw',
        '🔁 Ошибся в нике или бот не выдал — напиши ник в этом чате снова',
        '❌ Отмена: /cancel',
    ].join('\n');
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

/** /cancel после /clan invest — деньги уже в казне, отмена невозможна */
export function buildOrderCancelDeniedHint() {
    return [
        '⛔ Отменить заказ уже нельзя.',
        '',
        '💰 Деньги уже вложены в казну клана — сними их в игре (/clan withdraw).',
        '',
        '💬 Если нужна помощь — напиши в поддержку PlayerOK.',
    ].join('\n');
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
 * Кик «ник уже онлайн» — обычно заход владельца для пополнения.
 */
export function buildBotBalanceRefillingHint() {
    return [
        '⏳ Сейчас баланс бота пополняется.',
        'Бот скоро снова зайдёт на сервер и продолжит выдачу.',
        '',
        `🎮 Будь на анархии ${DELIVERY_ANARCHY} в сети — ждать ничего писать не нужно.`,
    ].join('\n');
}

/**
 * Мало валюты — причина + ссылка на самый большой 🎁 (без эссе про запас/бонус).
 * @param {{
 *   upsellUrl?: string|null,
 *   upsellKk?: number|null,
 * }} [ctx]
 */
export function buildInsufficientFundsHint(ctx = null) {
    const anka = DELIVERY_ANARCHY;
    const upsellUrl = String(ctx?.upsellUrl || '').trim();
    const upsellKk = Math.round(Number(ctx?.upsellKk) || 0);
    const marker = '🎁';

    if (upsellUrl && upsellKk > 0) {
        return [
            '❌ Не удалось выдать.',
            '',
            '📋 Причина: не хватает баланса у бота.',
            '',
            `Можешь /cancel и взять этот лот (${marker}) — ${upsellKk}кк:`,
            '',
            upsellUrl,
            '',
            `Потом анархия ${anka}, ник в этот чат снова.`,
        ].join('\n');
    }

    return [
        '❌ Не удалось выдать.',
        '',
        '📋 Причина: не хватает баланса у бота.',
        'Сейчас нет подходящего предложения под баланс бота.',
        `Можешь подождать пополнения (анархия ${anka}, в сети, ник в чат снова) или /cancel.`,
    ].join('\n');
}

/**
 * Покупателю — почему не выдали (капча / бан бота / нет монет / офлайн).
 * @param {string} [reason]
 * @param {object} [ctx] — для insufficient_funds: upsellUrl, upsellKk
 */
export function buildDeliveryFailHint(reason, ctx = null) {
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
                '📋 Причина: аккаунт бота забанили на сервере FunTime.',
                'Это не твоя ошибка — выдача сейчас остановлена.',
                '',
                '⏳ Можешь подождать: когда бота заменим/разбанят — напиши ник в этот чат снова.',
                '❌ Или верни оплату командой /cancel',
            );
            return lines.join('\n');
        case 'insufficient_funds':
            return buildInsufficientFundsHint(ctx);
        case 'balance_unread':
            lines.push(
                '📋 Сейчас не удалось проверить баланс бота (сбой на сервере).',
                'Это не «закончилась валюта» — просто не прочитали /balance.',
                '',
                `🎮 Будь на анархии ${anka} в сети и напиши ник в этот чат снова.`,
            );
            return lines.join('\n');
        case 'player_offline':
        case 'offline':
            lines.push(
                '📋 Причина: тебя нет на сервере (или не на нужной анархии).',
                '',
                `🎮 Зайди на анархию ${anka} и будь в сети.`,
            );
            break;
        case 'player_in_other_clan':
            lines.push(
                '📋 Причина: твой ник уже состоит в другом клане на сервере.',
                '',
                '🎮 Выйди из текущего клана в игре (/clan leave),',
                `зайди на анархию ${anka} и будь в сети.`,
            );
            break;
        case 'invite_declined':
            lines.push(
                '📋 Причина: ты отклонил приглашение в клан — нужно было принять.',
                '',
                `🎮 Будь на анархии ${anka} в сети и прими invite,`,
                'когда бот пришлёт его снова.',
            );
            break;
        case 'bot_not_in_clan':
            lines.push(
                '📋 Причина: продавец забыл создать клан на сервере.',
                'Это не твоя ошибка — бот без клана не может выдать заказ.',
                '',
                '⏳ Можешь подождать, пока продавец создаст клан.',
                '❌ Или верни оплату командой /cancel',
            );
            return lines.join('\n');
        case 'proxy_timeout':
        case 'bot_offline':
            lines.push(
                '📋 Причина: бот сейчас не работает (нет связи с сервером).',
                '⏳ Когда заработает — неизвестно.',
                '',
                '❌ Верни оплату командой /cancel',
            );
            return lines.join('\n');
        default:
            return buildRetryNickHint();
    }

    lines.push('', ...retryNickAfterFailLines());
    return lines.join('\n');
}

/** Лимит попыток на один /nick — нужен новый /nick с анархии */
export function buildDeliveryAttemptsExceededHint(maxAttempts = 3) {
    const anka = DELIVERY_ANARCHY;
    return [
        `⏹ Не вышло выдать за ${maxAttempts} попытки.`,
        '',
        `🎮 Зайди на анархию ${anka} и будь в сети.`,
        askNickInChatLine(),
        '💰 После нового /nick бот попробует снова (счётчик сбросится).',
    ].join('\n');
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

function fmtBonusKk(kk, pct = 0) {
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
 * @param {number} [bonus.bonusWheelKk]
 * @param {number} [defaultLotKk]
 */
function resolvePayoutParts(bonus, defaultLotKk = 0) {
    const lot = Number(bonus?.lotKk ?? defaultLotKk) || 0;
    const paid = Number(bonus?.payAmountKk ?? defaultLotKk) || 0;
    const wheelPct = bonus?.wheelPct ?? 0;
    const wheelKk =
        bonus?.bonusWheelKk ??
        (wheelPct > 0 ? Math.round((lot * wheelPct) / 100) : 0);
    return { lot, paid, wheelKk, wheelPct };
}

/** @param {object} bonus @param {number} [defaultLotKk] @param {{ totalLabel?: string }} [opts] */
function buildPayoutBreakdownLines(bonus, defaultLotKk = 0, opts = null) {
    const { lot, paid, wheelKk } = resolvePayoutParts(
        bonus,
        defaultLotKk,
    );
    if (lot <= 0 || paid <= 0) return [];

    const totalLabel = opts?.totalLabel || 'Итого';
    const lines = [`💰 ${totalLabel}: ${fmtKk(paid)}`, `📦 Лот: ${fmtKk(lot)}`];

    if (wheelKk > 0) {
        lines.push(`🎲 Случайный бонус: ${fmtBonusKk(wheelKk)}`);
    }

    return lines;
}

/**
 * @param {object} [bonus]
 * @param {number} [bonus.lotKk]
 * @param {number} [bonus.payAmountKk]
 * @param {number} [bonus.wheelPct]
 * @param {number} [bonus.bonusWheelKk]
 */
export function buildDeliveryOkHint(amountKk, bonus = null, opts = {}) {
    const breakdown = buildPayoutBreakdownLines(bonus, amountKk, { totalLabel: 'Итого выдано' });
    const lines = ['✅ Валюта выдана!', ''];

    if (breakdown.length) {
        lines.push(...breakdown, '', '🎮 Приятной игры!');
    } else {
        lines.push('🎮 Приятной игры!');
    }

    const orderId = String(opts.orderId || '').trim();
    const lotKk = opts.lotKk != null ? Math.round(Number(opts.lotKk)) : Math.round(Number(amountKk) || 0);
    const orderTag = orderId
        ? `${lotKk}кк · #${orderId.slice(0, 8)}`
        : `${lotKk}кк`;

    lines.push(
        '',
        `⭐ Подтверди на PlayerOK заказ: ${orderTag}`,
        '⭐ Оставь отзыв — это очень помогает!',
    );
    return lines.join('\n');
}

/**
 * Ссылка на лот-аналог: пустая строка + стрелки с пробелами (URL кликабельный).
 * @param {string} url
 */
export function formatUpsellLinkLine(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    return `\n\n➡️ ${u} ⬅️`;
}

/**
 * Автовозврат прошёл — деньги уже на балансе, сразу на 🎁-лот.
 * @param {{ upsellKk?: number, baseKk?: number, url?: string }} opts
 */
export function buildPremiumRefundUpsellHint(opts = {}) {
    const upsellKk = Math.round(Number(opts.upsellKk) || 0);
    const baseKk = Math.round(Number(opts.baseKk) || 0);
    const url = String(opts.url || '').trim();

    let body;
    if (upsellKk > 0 && baseKk > 0) {
        body = `деньги уже на твоем балансе, так что сразу можешь взять ${upsellKk}кк за цену ${baseKk}кк`;
    } else if (upsellKk > 0) {
        body = `деньги уже на твоем балансе, так что сразу можешь взять ${upsellKk}кк по этой же цене`;
    } else {
        body = 'деньги уже на твоем балансе — бери лот по ссылке';
    }

    if (!url) return body;
    return `${body}\n\n${url}`;
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

    let text =
        `💡 На профиле: ${upsellKk}кк ${priceBit}${compareBit} — пролистай вниз, в названии лота ${marker}`;
    if (url) text += formatUpsellLinkLine(url);
    return text;
}

/**
 * Повтор через 40с — только ссылка + «65кк, вместо 60кк по этой же цене» (без эмодзи).
 * @param {{ upsellKk: number, baseKk?: number, url: string }} opts
 */
export function buildProfileUpsellRepeatHint(opts) {
    const upsellKk = Math.round(Number(opts.upsellKk) || 0);
    const baseKk = Math.round(Number(opts.baseKk) || 0);
    const url = String(opts.url || '').trim();
    if (!url) return '';

    if (upsellKk > 0 && baseKk > 0) {
        return `${url}\n\n${upsellKk}кк, вместо ${baseKk}кк по этой же цене`;
    }
    if (upsellKk > 0) {
        return `${url}\n\n${upsellKk}кк по этой же цене`;
    }
    return url;
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
/** /nick — сейчас выдаём этому покупателю */
export function buildNickDeliveryActiveHint(nick, amountKk) {
    const anka = DELIVERY_ANARCHY;
    return [
        `⏳ Сейчас выдаю валюту на ник «${nick}».`,
        `💰 Сумма: ${fmtKk(amountKk)}`,
        '',
        `🎮 Будь на анархии ${anka} и в сети.`,
    ].join('\n');
}

/** /nick — в очереди, сейчас выдают другому */
export function buildNickQueueWaitingHint(position, amountKk = null) {
    const anka = DELIVERY_ANARCHY;
    const posLine =
        position <= 2 ? 'Ты следующий в очереди.' : `Твоя очередь: ${position}.`;
    const lines = ['⏳ Сейчас валюта выдаётся другому покупателю.', posLine];
    if (amountKk != null) lines.push(`💰 Твой заказ: ${fmtKk(amountKk)}`);
    lines.push('', `🎮 Будь на анархии ${anka} — выдадим, когда подойдёт очередь.`);
    return lines.join('\n');
}

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

function clanAmountDigits(raw) {
    return String(raw || '').replace(/\D/g, '') || '?';
}

/** После /clan invest — снять сумму из казны */
export function buildClanWithdrawHint(nick, withdrawAmountRaw) {
    const anka = DELIVERY_ANARCHY;
    const amount = clanAmountDigits(withdrawAmountRaw);
    return [
        `💰 Деньги вложены в казну клана для «${nick}».`,
        '',
        `🎮 На анархии ${anka} сними:`,
        `/clan withdraw ${amount}`,
    ].join('\n');
}

/** Снял не всё — остаток (во время выдачи) */
export function buildClanRemainderHint(nick, remainAmountRaw) {
    const anka = DELIVERY_ANARCHY;
    const amount = clanAmountDigits(remainAmountRaw);
    return [
        `🎮 На анархии ${anka} досними:`,
        `/clan withdraw ${amount}`,
    ].join('\n');
}

/** Покупатель пишет /nick, пока ждём withdraw в игре */
export function buildClanWithdrawWaitHint(nick, remainAmountRaw) {
    const anka = DELIVERY_ANARCHY;
    const amount = clanAmountDigits(remainAmountRaw);
    return [
        `⏳ Ник «${nick}» уже принят — выдача идёт.`,
        '',
        `🎮 Сначала досними на анархии ${anka}:`,
        `/clan withdraw ${amount}`,
        '',
        '💬 Пока выдача идёт — только /clan withdraw в Minecraft.',
        '⏱ Если тебя нет на анке — через ~1 мин бот остановит попытку; тогда напиши /nick снова.',
    ].join('\n');
}

/** Снял не всё — остаток + повтор /nick после сбоя */
export function buildClanPartialWithdrawHint(nick, remainAmountRaw) {
    const anka = DELIVERY_ANARCHY;
    const amount = clanAmountDigits(remainAmountRaw);
    return [
        `⚠️ Снята не вся сумма.`,
        '',
        `🎮 На анархии ${anka} досними:`,
        `/clan withdraw ${amount}`,
        '',
        askNickInChatLine(),
        '💰 Бот продолжит выдачу после /nick.',
    ].join('\n');
}

/** Коротко: новая оплата, когда полное приветствие уже было в чате. */
export function buildNewOrderTwinHint(ctx = null) {
    const anka = DELIVERY_ANARCHY;
    const lotKk = Number(ctx?.lotKk);

    const lines = [
        '✅ Оплата получена.',
        '',
        ...twinAccountWarningLines(),
        `🎮 Анархия ${anka} — будь в сети.`,
        '💸 Выдача через клан: приглашение → казна → /clan withdraw',
        '',
        askNickInChatLine(),
    ];
    if (lotKk > 0) {
        lines.push('', `📦 Лот: ${lotKk}кк`);
    }
    return lines.join('\n');
}

/** Полное приветствие в чате (не короткий twin-hint после повторной оплаты). */
export function hasGreetingInChat(messages, sellerUserId) {
    const marker = (process.env.GREETING_MARKER || 'выдача автоматическая').toLowerCase();
    for (const msg of messages) {
        if (!msg?.text || msg.user?.id !== sellerUserId) continue;
        const text = msg.text.toLowerCase();
        if (text.includes(marker)) return true;
        // Twin / кастом тоже считаем «уже писали» — иначе полное + twin подряд
        if (text.includes('оплата получена') && text.includes('твинк')) return true;
        if (text.includes('заходи на анархию') && text.includes('твинк')) return true;
    }
    return false;
}

/**
 * Уже кидали «Оплата получена» после этой оплаты (дедуп дублей poll).
 * @param {object[]} messages
 * @param {string} sellerUserId
 * @param {{ lotKk?: number, sinceIso?: string }} [opts]
 */
export function hasPaymentAckInChat(messages, sellerUserId, opts = null) {
    const lotKk = Number(opts?.lotKk);
    const sinceMs = opts?.sinceIso ? Date.parse(opts.sinceIso) : NaN;
    const lotNeedle = lotKk > 0 ? `лот: ${lotKk}кк` : null;

    for (const msg of messages) {
        if (!msg?.text || msg.user?.id !== sellerUserId) continue;
        if (Number.isFinite(sinceMs)) {
            const at = Date.parse(msg.createdAt);
            if (Number.isFinite(at) && at < sinceMs - 5000) continue;
        }
        const text = msg.text.toLowerCase();
        if (!text.includes('оплата получена')) continue;
        if (!text.includes('твинк')) continue;
        if (lotNeedle && !text.includes(lotNeedle)) continue;
        return true;
    }
    return false;
}

/** Уже писали статус выдачи на этот ник (по истории чата PlayerOK). */
export function hasDispatchStatusInChat(messages, sellerUserId, nick) {
    if (!nick) return false;
    const needle = `сейчас выдаю на ник «${String(nick).toLowerCase()}»`;
    for (const msg of messages) {
        if (!msg?.text || msg.user?.id !== sellerUserId) continue;
        if (msg.text.toLowerCase().includes(needle)) return true;
    }
    return false;
}
