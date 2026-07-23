/**
 * Сообщение «мало валюты»: сколько реально влезет (с запасом под бонус) + 🎁 без премки.
 */

import { insufficientFundsHintCtx } from './bot-balance.mjs';
import { resolveGiftLotUpToKk } from './profile-upsell.mjs';
import { buildInsufficientFundsHint } from '../messages.mjs';

/**
 * @param {object|null} client
 * @param {object} state
 * @param {object} order
 * @param {number|null} [balanceCoinsOverride]
 */
export async function composeInsufficientFundsHint(
    client,
    state,
    order,
    balanceCoinsOverride = null,
) {
    const ctx = insufficientFundsHintCtx(state, order, balanceCoinsOverride);
    const cap = Math.round(Number(ctx.availableLotKk) || 0);
    const sellerUserId = state?.sellerUserId || null;
    const sellerUsername = state?.sellerUsername ?? null;

    if (client && sellerUserId && cap > 0) {
        try {
            const gift = await resolveGiftLotUpToKk(
                client,
                order,
                sellerUserId,
                sellerUsername,
                cap,
            );
            if (gift?.url && gift.kk > 0) {
                ctx.upsellUrl = gift.url;
                ctx.upsellKk = gift.kk;
            }
        } catch (e) {
            console.warn(`[sell] gift≤kk upsell: ${e.message}`);
        }
    }

    return buildInsufficientFundsHint(ctx);
}
