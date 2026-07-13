/** Хардкод TG как у оркестраторов 4narek (тот же чат + @тег). */

export const SELLBOT_TG_TOKEN = '8779973341:AAFoPjPiop1Pndoit4Cdv8dUJ6UWu-9CzC4';
/** Тот же супергруппа/чат, что у 502b…510b */
export const SELLBOT_TG_CHAT_ID = '-1003827870631';
export const SELLBOT_TG_MENTION = 'sasha_pshonko';
/** Не тегать чаще раза в час на тип алерта */
export const SELLBOT_TG_MENTION_CD_MS = 60 * 60 * 1000;
/** Порог «мало баланса» — 150кк */
export const SELLBOT_BALANCE_MIN = 150_000_000;

export const ALERT_KIND = {
    BAN: 'ban',
    CAPTCHA: 'captcha',
    BALANCE: 'balance',
};

const mentionCooldownUntil = new Map();

export function classifySellbotAlert(message) {
    if (message == null) return null;
    const lower = String(message).toLowerCase();
    if (lower.includes('забанен') || lower.includes('бан (')) return ALERT_KIND.BAN;
    if (lower.includes('капч') || lower.includes('ввести капчу')) return ALERT_KIND.CAPTCHA;
    if (lower.includes('мало баланса') || lower.includes('мало монет')) return ALERT_KIND.BALANCE;
    return null;
}

function mentionKey(kind) {
    return `sellbot:${kind}`;
}

function shouldMention(kind) {
    if (!kind) return false;
    const until = mentionCooldownUntil.get(mentionKey(kind)) || 0;
    return Date.now() >= until;
}

function recordMention(kind) {
    if (!kind) return;
    mentionCooldownUntil.set(mentionKey(kind), Date.now() + SELLBOT_TG_MENTION_CD_MS);
}

/** Текст алерта + @sasha_pshonko (бан / капча / мало баланса, КД 1ч). */
export function buildSellbotTelegramText(message, { forceKind = null } = {}) {
    let text = String(message ?? '');
    const kind = forceKind || classifySellbotAlert(text);
    if (kind && shouldMention(kind)) {
        recordMention(kind);
        text = `${text} @${SELLBOT_TG_MENTION}`;
    }
    return text;
}
