import { DELIVERY_ANARCHY } from '../config.mjs';

/** Тексты покупателю на FunPay (без отсылок к PlayerOK и /cancel: возврат на FunPay делает только продавец). */
const ASK_NICK = '💬 Напиши сюда, в этот чат, свой игровой ник из Minecraft.';

export function greeting(orderId, amountKk) {
    return [
        `✅ Оплата получена (заказ #${orderId}, ${amountKk}кк).`,
        '',
        `ЗАХОДИ НА АНАРХИЮ ${DELIVERY_ANARCHY}`,
        ASK_NICK,
        '',
        '✅ Это сложная выдача через /pay БЕЗ БАНОВ',
        '🔁 Ошибся в нике или бот не выдал — напиши ник в этом чате снова',
    ].join('\n');
}

export const wrongNick = () =>
    ['⚠️ Ник не подошёл.', '', '👤 Нужен ник Minecraft: 3–16 символов, a-z, A-Z, 0-9, _', ASK_NICK].join('\n');

export const nickAccepted = (nick, amountKk) =>
    `⏳ Ник ${nick} принят, выдаю ${amountKk}кк. Будь на анархии ${DELIVERY_ANARCHY} в сети.`;

export const nickChanged = (nick) => `🔁 Ник изменён на ${nick}.`;

export const delivered = () =>
    ['✅ Валюта выдана!', '', '⭐ Пожалуйста, подтверди заказ', '⭐ Если всё устроило, можешь оставить отзыв'].join('\n');

export const captchaWait = () => '🤖 Бот усердно решает капчу — подожди 2–3 минуты. Выдача начнётся сама.';

export const tryAgain = () =>
    `⏳ Не получилось выдать. Зайди на анархию ${DELIVERY_ANARCHY} и напиши ник в чат ещё раз.`;

export const offline = () => `❌ Тебя нет на анархии ${DELIVERY_ANARCHY}. Зайди и напиши ник в чат ещё раз.`;

export const insufficientFunds = () =>
    `❌ Не удалось выдать: не хватает баланса у бота. Подожди пополнения (будь на анархии ${DELIVERY_ANARCHY}) и напиши ник в чат снова.`;

export const botDown = () => '❌ Бот сейчас не может зайти на сервер (не твоя ошибка). Когда заработает — неизвестно, напиши продавцу.';

export const balanceRefilling = () =>
    [
        '⏳ Сейчас баланс бота пополняется.',
        'Бот скоро снова зайдёт на сервер и продолжит выдачу.',
        '',
        `🎮 Будь на анархии ${DELIVERY_ANARCHY} в сети — ничего писать не нужно.`,
    ].join('\n');

export function failHint(reason) {
    switch (reason) {
        case 'captcha':
            return captchaWait();
        case 'insufficient_funds':
            return insufficientFunds();
        case 'player_offline':
        case 'offline':
            return offline();
        case 'banned':
        case 'proxy_timeout':
        case 'bot_offline':
            return botDown();
        default:
            return tryAgain();
    }
}

export const refundedTooSmall = (amountKk, minKk) =>
    [
        `❌ Выдаём от ${minKk}кк, а в заказе ${amountKk}кк — меньше минимума.`,
        '💸 Оформил возврат, деньги вернутся на твой баланс FunPay.',
        `Если нужна валюта — оформи новый заказ от ${minKk}кк.`,
    ].join('\n');

export const tooSmallManual = (amountKk, minKk) =>
    [
        `❌ Выдаём от ${minKk}кк, а в заказе ${amountKk}кк — меньше минимума.`,
        '💸 Продавец вернёт деньги вручную, подожди немного.',
        `Если нужна валюта — оформи новый заказ от ${minKk}кк.`,
    ].join('\n');

/** «90 дней» → «3 месяцев», иначе «N дней». */
export const ageLimitText = (days) => (days % 30 === 0 ? `${days / 30} ${days / 30 === 1 ? 'месяца' : 'месяцев'}` : `${days} дней`);

// Тон нейтральный: правило магазина, без обвинений (покупателем может оказаться модератор или честный новичок).
export const refundedYoungAccount = (days) =>
    `⚠️ Автоматическая выдача доступна аккаунтам FunPay старше ${ageLimitText(days)} — это правило магазина, претензий к тебе нет.`;

export const youngAccountManual = (days) =>
    [
        `⚠️ Автоматическая выдача доступна аккаунтам FunPay старше ${ageLimitText(days)} — это правило магазина, претензий к тебе нет.`,
        '💸 Продавец вернёт деньги вручную, подожди немного.',
    ].join('\n');

/** Автоответ тем, кто пишет до покупки («можно купить?»). Свой текст — FUNPAY_AUTOREPLY в .env. */
export function autoReply(minKk = Number(process.env.FUNPAY_MIN_KK || 200)) {
    const custom = process.env.FUNPAY_AUTOREPLY?.trim();
    if (custom) return custom.replace(/\\n/g, '\n');
    return [
        '🤖 Автоответ. Если лот открыт, то в наличии, выдам сразу после оплаты — выдача автоматическая.',
        'Выдача через /pay, без банов.',
    ].join('\n');
}
