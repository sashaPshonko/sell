import { DELIVERY_ANARCHY } from './config.mjs';

export { DELIVERY_ANARCHY };

function askNickInChatLine() {
    return '💬 Напиши сюда, в этот чат, свой игровой ник из Minecraft.';
}

/**
 * Раньше здесь было грозное «ОБЯЗАТЕЛЬНО ТВИНК, возможен БАН». Убрано: мы не проверяли, банят ли за такую выдачу,
 * а угроза в момент оплаты только отпугивает. Оставлено пустым, чтобы не трогать места вызова.
 */
export function twinAccountWarningLines() {
    return [];
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

export function buildOrderCancelledHint(playerokCancelled = false, count = 1) {
    const lines = [
        count > 1 ? `❌ Заказы отменены (${count}).` : '❌ Заказ отменён.',
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

/** /cancel прошёл у нас, но PlayerOK не оформил возврат */
export function buildOrderCancelRefundFailedHint(errMsg = '') {
    const reason = String(errMsg || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
    const lines = [
        '❌ Не получилось оформить возврат на PlayerOK.',
        '',
        'Попробуй /cancel ещё раз через минуту.',
        'Если снова ошибка — напиши в поддержку PlayerOK.',
    ];
    if (reason) {
        lines.push('', `⚠️ ${reason}`);
    }
    return lines.join('\n');
}

/** Бот выдачи заходит на сервер и решает капчу — просим немного подождать (не ошибка, отмена не нужна). */
export function buildCaptchaWaitHint() {
    return '🤖 Бот усердно решает капчу — подожди 2–3 минуты. Выдача начнётся сама.';
}

/** /cancel на заказе, который отменить нельзя (подписка). */
/** Номера вариантов в меню /cancel. */
export const CANCEL_MENU_KEYS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/**
 * /cancel, когда у покупателя несколько заказов: выбрать, какой отменить.
 * @param {string[]} labels — подписи заказов («70кк»); последним пунктом добавляется «Все заказы».
 */
export function buildCancelMenuHint(labels) {
    const items = [...labels, 'Все заказы'];
    return [
        '❓ Какой заказ отменить? Ответь цифрой:',
        '',
        ...items.map((l, i) => `${CANCEL_MENU_KEYS[i]} ${l}`),
    ].join('\n');
}

export function buildCancelMenuExpiredHint() {
    return '⌛ Время выбора вышло — напиши /cancel ещё раз.';
}

/** /cancel, а перевод (несколько заказов одним переводом) уже в работе у бота. */
export function buildOrderCancelInDeliveryHint() {
    return `⏳ Перевод уже в работе — отменить сейчас нельзя. Будь на анархии ${DELIVERY_ANARCHY}.`;
}

export function buildOrderCancelDeniedHint() {
    return [
        '⛔ Этот заказ отменить через бота нельзя.',
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

/** Общий текст «не получилось, зайди и напиши ник снова». */
function buildTryAgainHint() {
    return `⏳ Не получилось выдать. Зайди на анархию ${DELIVERY_ANARCHY} и напиши ник в чат ещё раз.`;
}

export function buildRetryNickHint() {
    return buildTryAgainHint();
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

    switch (reason) {
        case 'captcha':
            return buildCaptchaWaitHint();
        case 'banned':
            return [
                '❌ Аккаунт бота забанили на FunTime — это не твоя ошибка, выдача остановлена.',
                '⏳ Когда заменим бота — неизвестно. Можешь подождать и написать ник в чат снова,',
                '❌ или вернуть оплату: /cancel',
            ].join('\n');
        case 'insufficient_funds':
            return buildInsufficientFundsHint(ctx);
        case 'balance_unread':
            return `❌ Не удалось проверить баланс бота (сбой на сервере). Будь на анархии ${anka} и напиши ник в чат ещё раз.`;
        case 'player_offline':
        case 'offline':
            return `❌ Тебя нет на анархии ${anka}. Зайди и напиши ник в чат ещё раз.`;
        case 'proxy_timeout':
        case 'bot_offline':
            return [
                '❌ Бот сейчас не может зайти на сервер (не твоя ошибка), когда заработает — неизвестно.',
                '❌ Вернуть оплату: /cancel',
            ].join('\n');
        default:
            return buildRetryNickHint();
    }
}

/** Лимит попыток на один /nick — нужен новый /nick с анархии */
export function buildDeliveryAttemptsExceededHint(maxAttempts = 3) {
    return buildTryAgainHint();
}

/** Таймаут выдачи — заказ сброшен, нужен повторный /nick */
export function buildQueueStallHint() {
    return buildTryAgainHint();
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
    return [
        '✅ Валюта выдана!',
        '',
        '⭐ Пожалуйста, подтверди заказ',
        '⭐ Если всё устроило, можешь оставить отзыв',
    ].join('\n');
}

/**
 * Ссылка на лот-аналог: пустая строка и сама ссылка отдельной строкой (кликабельна).
 * @param {string} url
 */
export function formatUpsellLinkLine(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    return `\n\n${u}`;
}

/**
 * Автовозврат прошёл — деньги уже на балансе, сразу на 🎁-лот.
 * @param {{ upsellKk?: number, baseKk?: number, url?: string }} opts
 */
/** Повторному покупателю сразу после оплаты: 🎁-аналог по той же цене или возврат. */
export function buildRepeatBuyerOfferHint(opts = {}) {
    const upsellKk = Math.round(Number(opts.upsellKk) || 0);
    const url = String(opts.url || '').trim();
    const head = upsellKk > 0 ? `🎁 Есть ${upsellKk}кк по этой же цене` : '🎁 Есть выгоднее по этой же цене';
    return [head, url, '', '❌ Возврат — /cancel'].filter((x, i) => x !== '' || i === 2).join('\n');
}

export function buildPremiumRefundUpsellHint(opts = {}) {
    const upsellKk = Math.round(Number(opts.upsellKk) || 0);
    const baseKk = Math.round(Number(opts.baseKk) || 0);
    const url = String(opts.url || '').trim();
    const more = upsellKk > 0 && baseKk > 0 ? `${upsellKk}кк вместо ${baseKk}кк` : upsellKk > 0 ? `${upsellKk}кк` : 'больше валюты';
    const lines = [
        '↩️ Этот заказ отменён, деньги уже вернулись на твой баланс PlayerOK.',
        '',
        `🎁 За ту же цену есть ${more} — купи по ссылке и напиши ник, выдам сразу:`,
    ];
    if (url) lines.push(url);
    return lines.join('\n');
}

/** Покупатель пишет в чат после автовозврата (ник, /cancel…) — заказа уже нет, напоминаем. */
export function buildUpsellRefundReminderHint(opts = {}) {
    const upsellKk = Math.round(Number(opts.upsellKk) || 0);
    const baseKk = Math.round(Number(opts.baseKk) || 0);
    const url = String(opts.url || '').trim();
    const what = baseKk > 0 ? `Заказ на ${baseKk}кк отменён` : 'Заказ отменён';
    const lines = [
        `↩️ ${what}, деньги на твоём балансе PlayerOK — по нему ничего не выдам.`,
        '',
        `🎁 Купи ${upsellKk > 0 ? `${upsellKk}кк` : 'лот'} по той же цене, потом напиши сюда ник:`,
    ];
    if (url) lines.push(url);
    return lines.join('\n');
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

/** Старый апселл пробника ботов — больше не шлём в чат. */
export const DEFAULT_POPCORN_TRIAL_URL = '';

export function popcornTrialUrl() {
    return '';
}

export function buildPopcornTrialHint() {
    return '';
}

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

/** /nick — сейчас выдаём этому покупателю */
export function buildNickDeliveryActiveHint(nick, amountKk) {
    return `⏳ Выдаю на ник «${nick}» (${fmtKk(amountKk)}). Будь на анархии ${DELIVERY_ANARCHY}.`;
}

/** /nick — в очереди, сейчас выдают другому */
export function buildNickQueueWaitingHint(position, amountKk = null) {
    const posLine = position <= 2 ? 'Ты следующий в очереди' : `Твоя очередь: ${position}`;
    return `⏳ ${posLine}, будь на анархии ${DELIVERY_ANARCHY}.`;
}

export function buildDispatchingHint(nick, amountKk, bonus = null) {
    return `⏳ Выдаю на ник «${nick}». Будь на анархии ${DELIVERY_ANARCHY}.`;
}

/** Коротко: новая оплата, когда полное приветствие уже было в чате. */
export function buildNewOrderTwinHint(ctx = null) {
    return [
        `🎮 Сначала зайди на анархию ${DELIVERY_ANARCHY}, потом напиши в этот чат ник (не в Minecraft).`,
        '✅ Это сложная выдача через /pay БЕЗ БАНОВ',
    ].join('\n');
}

/** Полное приветствие в чате (не короткий twin-hint после повторной оплаты). */
export function hasGreetingInChat(messages, sellerUserId) {
    const marker = (process.env.GREETING_MARKER || 'выдача автоматическая').toLowerCase();
    for (const msg of messages) {
        if (!msg?.text || msg.user?.id !== sellerUserId) continue;
        const text = msg.text.toLowerCase();
        if (text.includes(marker)) return true;
        // Twin / кастом тоже считаем «уже писали» — иначе полное + twin подряд
        if (text.includes('оплата получена')) return true;
        if (text.includes('заходи на анархию')) return true;
        if (text.includes('сначала зайди на анархию')) return true;
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
        const twinHint =
            text.includes('потом напиши в этот чат ник (не в minecraft)')
            || text.includes('сложная выдача через /pay');
        if (!text.includes('оплата получена') && !twinHint) continue;
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