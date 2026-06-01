/**
 * Настройки sell — меняй здесь, на VPS: git pull + restart poll и sellbot.
 * Секреты PlayerOK (TOKEN, AUID) — только в .env
 */
export const DELIVERY_ANARCHY = '221';

/** Число для sellbot (/l и выдача) */
export const DELIVERY_ANARCHY_NUM = Number(DELIVERY_ANARCHY) || 221;
