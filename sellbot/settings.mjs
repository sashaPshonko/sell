import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DELIVERY_ANARCHY_NUM } from '../config.mjs';
import { SELLBOT_BALANCE_MIN } from './lib/telegram-alerts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_JSON = join(__dirname, 'bot.json');

/** Настройки sellbot — только bot.json + эти дефолты (без .env) */
export const DEFAULTS = {
    wsPort: 8790,
    deliveryMode: 'clan',
    /** 200кк → /clan invest 200000000 */
    clanInvestMultiplier: 1_000_000,
    clanPhaseTimeoutMs: 60_000,
    /** withdraw solo: invest подтверждён, очередь пустая */
    clanWithdrawSoloTimeoutMs: 300_000,
    clanLoopWaitMs: 2000,
    /** после /clan invest — ждём строку в чате, не шлём повтор раньше */
    clanInvestWaitMs: 15_000,
    /** ≥90% — на конце фазы выдача ок; clanWithdrawGraceMs — legacy, не используется */
    clanWithdrawMinRatio: 0.9,
    clanWithdrawGraceMs: 60_000,
    /** после частичного withdraw — минимум столько ждём остаток (даже если <90%) */
    clanWithdrawRemainderMs: 30_000,
    clanClickDelayMinMs: 1500,
    clanClickDelayMaxMs: 4500,
    clanMembersMenuSlot: 11,
    clanKickConfirmSlot: 0,
    anarchyRejoinWaitMs: 5000,
    mockDelivery: false,
    mockDeliveryMs: 300,
    healthCheckEnabled: true,
    healthCheckMs: 3_600_000,
    healthCheckFirstMs: 120_000,
    healthCheckObserveMs: 8000,
    idleQuitMs: 25_000,
    deliverTimeoutMs: 600_000,
    /** 150кк — ниже тег в TG */
    balanceMin: 150_000_000,
    balanceWaitMs: 15_000,
    balanceCmdWaitMs: 2000,
    /** /clan info — ждём ответ дольше (после transfer) */
    clanInfoWaitMs: 30_000,
    clanInfoCmdWaitMs: 5000,
    /** /clan money|balance и /balance в начале выдачи */
    clanBalanceWaitMs: 30_000,
    clanBalanceCmdWaitMs: 5000,
    /** Единственная строка: покупатель не на анархии / не в сети на сервере (legacy /pay) */
    playerOfflineMarker: '[✘] Ошибка! Указанный игрок не найден!',
    /** Не хватает монет на балансе бота */
    insufficientFundsMarker: '[✘] Ошибка! У вас недостаточно денег.',
    invalidNickMarkers: ['ник не найден'],
    /** Токен/чат — хардкод в lib/telegram-alerts.mjs (не из bot.json) */
    telegramToken: '',
    telegramChatId: '',
    telegramSkip: false,
    /** `off` — напрямую; иначе `socks5h://127.0.0.1:1080` и т.п. */
    telegramProxy: 'off',
    telegramAutoXray: false,
    telegramXrayCmd: '',
};

function parseMarkers(value, fallback) {
    if (Array.isArray(value)) {
        return value.map((s) => String(s).trim()).filter(Boolean);
    }
    const raw = value ?? fallback;
    if (Array.isArray(raw)) return raw;
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function pick(entry, key, def) {
    return entry[key] !== undefined && entry[key] !== null ? entry[key] : def;
}

/**
 * @returns {{ bot: { username, password, anarchy }, settings: typeof DEFAULTS }}
 */
export async function loadSettings(path = BOT_JSON) {
    if (!existsSync(path)) {
        throw new Error(`нет ${path}`);
    }
    const arr = JSON.parse(await readFile(path, 'utf-8'));
    if (!Array.isArray(arr) || !arr[0]?.username) {
        throw new Error(`${path}: массив [{ username, password, anarchy, ... }]`);
    }
    const entry = arr[0];

    const bot = {
        username: entry.username,
        password: entry.password,
        /** Анархия — только из sell/config.mjs (поле anarchy в bot.json не используется) */
        anarchy: DELIVERY_ANARCHY_NUM,
        proxy: String(pick(entry, 'proxy', '')).trim(),
    };

    const settings = {
        wsPort: Number(pick(entry, 'wsPort', DEFAULTS.wsPort)),
        deliveryMode: String(pick(entry, 'deliveryMode', DEFAULTS.deliveryMode)).trim() || 'clan',
        clanInvestMultiplier: Number(
            pick(entry, 'clanInvestMultiplier', pick(entry, 'payAmountMultiplier', DEFAULTS.clanInvestMultiplier)),
        ),
        clanPhaseTimeoutMs: Number(pick(entry, 'clanPhaseTimeoutMs', DEFAULTS.clanPhaseTimeoutMs)),
        clanWithdrawSoloTimeoutMs: Number(
            pick(entry, 'clanWithdrawSoloTimeoutMs', DEFAULTS.clanWithdrawSoloTimeoutMs),
        ),
        clanLoopWaitMs: Number(pick(entry, 'clanLoopWaitMs', pick(entry, 'payLoopWaitMs', DEFAULTS.clanLoopWaitMs))),
        clanInvestWaitMs: Number(pick(entry, 'clanInvestWaitMs', DEFAULTS.clanInvestWaitMs)),
        clanWithdrawMinRatio: Number(
            pick(entry, 'clanWithdrawMinRatio', DEFAULTS.clanWithdrawMinRatio),
        ),
        clanWithdrawGraceMs: Number(
            pick(entry, 'clanWithdrawGraceMs', DEFAULTS.clanWithdrawGraceMs),
        ),
        clanWithdrawRemainderMs: Number(
            pick(entry, 'clanWithdrawRemainderMs', DEFAULTS.clanWithdrawRemainderMs),
        ),
        clanClickDelayMinMs: Number(pick(entry, 'clanClickDelayMinMs', DEFAULTS.clanClickDelayMinMs)),
        clanClickDelayMaxMs: Number(pick(entry, 'clanClickDelayMaxMs', DEFAULTS.clanClickDelayMaxMs)),
        clanMembersMenuSlot: Number(pick(entry, 'clanMembersMenuSlot', DEFAULTS.clanMembersMenuSlot)),
        clanKickConfirmSlot: Number(pick(entry, 'clanKickConfirmSlot', DEFAULTS.clanKickConfirmSlot)),
        anarchyRejoinWaitMs: Number(pick(entry, 'anarchyRejoinWaitMs', DEFAULTS.anarchyRejoinWaitMs)),
        mockDelivery: Boolean(pick(entry, 'mockDelivery', DEFAULTS.mockDelivery)),
        mockDeliveryMs: Number(pick(entry, 'mockDeliveryMs', DEFAULTS.mockDeliveryMs)),
        healthCheckEnabled: pick(entry, 'healthCheckEnabled', DEFAULTS.healthCheckEnabled) !== false,
        healthCheckMs: Number(pick(entry, 'healthCheckMs', DEFAULTS.healthCheckMs)),
        healthCheckFirstMs: Number(pick(entry, 'healthCheckFirstMs', DEFAULTS.healthCheckFirstMs)),
        healthCheckObserveMs: Number(
            pick(entry, 'healthCheckObserveMs', DEFAULTS.healthCheckObserveMs),
        ),
        idleQuitMs: Number(pick(entry, 'idleQuitMs', DEFAULTS.idleQuitMs)),
        deliverTimeoutMs: Number(pick(entry, 'deliverTimeoutMs', DEFAULTS.deliverTimeoutMs)),
        balanceMin: SELLBOT_BALANCE_MIN,
        balanceWaitMs: Number(pick(entry, 'balanceWaitMs', DEFAULTS.balanceWaitMs)),
        balanceCmdWaitMs: Number(pick(entry, 'balanceCmdWaitMs', DEFAULTS.balanceCmdWaitMs)),
        clanInfoWaitMs: Number(pick(entry, 'clanInfoWaitMs', DEFAULTS.clanInfoWaitMs)),
        clanInfoCmdWaitMs: Number(pick(entry, 'clanInfoCmdWaitMs', DEFAULTS.clanInfoCmdWaitMs)),
        clanBalanceWaitMs: Number(pick(entry, 'clanBalanceWaitMs', DEFAULTS.clanBalanceWaitMs)),
        clanBalanceCmdWaitMs: Number(
            pick(entry, 'clanBalanceCmdWaitMs', DEFAULTS.clanBalanceCmdWaitMs),
        ),
        playerOfflineMarker: String(
            pick(entry, 'playerOfflineMarker', DEFAULTS.playerOfflineMarker),
        ).trim(),
        insufficientFundsMarker: String(
            pick(entry, 'insufficientFundsMarker', DEFAULTS.insufficientFundsMarker),
        ).trim(),
        invalidNickMarkers: parseMarkers(entry.invalidNickMarkers, DEFAULTS.invalidNickMarkers),
        telegramToken: String(pick(entry, 'telegramToken', DEFAULTS.telegramToken)).trim(),
        telegramChatId: String(pick(entry, 'telegramChatId', DEFAULTS.telegramChatId)).trim(),
        telegramSkip: pick(entry, 'telegramSkip', DEFAULTS.telegramSkip) === true,
        telegramProxy: pick(entry, 'telegramProxy', DEFAULTS.telegramProxy),
        telegramAutoXray: pick(entry, 'telegramAutoXray', DEFAULTS.telegramAutoXray) === true,
        telegramXrayCmd: String(pick(entry, 'telegramXrayCmd', DEFAULTS.telegramXrayCmd)).trim(),
    };

    return { bot, settings };
}
