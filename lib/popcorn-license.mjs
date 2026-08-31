/**
 * Выдача ключа botpodpopcorn с оплаты PlayerOK → license-сервер.
 */
import { confirmDealOnPlayerok } from '../confirm.mjs';
import { sendChatMessage } from '../chat.mjs';
import { playerokNeedsDelivery, playerokIsClosed } from './playerok-deal-sync.mjs';
import { findAllSubscriptionPaidDeals } from '../parse.mjs';

/** Тот же admin-ключ, что в license (plan=admin). */
const LICENSE_ADMIN_KEY = 'POP-521485-1EC1B3-9A7804';

function licenseBase() {
    return String(process.env.LICENSE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
}

function adminToken() {
    return LICENSE_ADMIN_KEY;
}

function buildKeyChatText(keyCode, days, installerUrl) {
    const lines = [
        '✅ Подписка botpodpopcorn',
        `🔑 Ключ: ${keyCode}`,
        `📅 Срок: ${days} дн.`,
    ];
    if (installerUrl) lines.push(`⬇️ Скачай программу и посмотри видео: ${installerUrl}`);
    else lines.push('⬇️ Скачай программу и посмотри видео: http://212.8.229.76:8787/kit');
    return lines.join('\n');
}

async function issueOnLicense({ dealId, days, note }) {
    const token = adminToken();
    const res = await fetch(`${licenseBase()}/v1/admin/issue-subscription`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': token,
        },
        body: JSON.stringify({ dealId, days, note, adminKey: token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
        throw new Error(data.reason || `license http ${res.status}`);
    }
    return data;
}

function subState(state, dealId) {
    if (!state.subscriptions) state.subscriptions = {};
    if (!state.subscriptions[dealId]) state.subscriptions[dealId] = {};
    return state.subscriptions[dealId];
}

export async function fulfillPopcornSubscriptions(client, state, chatId, messages) {
    const deals = findAllSubscriptionPaidDeals(messages).filter((d) => {
        if (d.chatId && d.chatId !== chatId) return false;
        return playerokNeedsDelivery(d.status) || !playerokIsClosed(d.status);
    });
    if (!deals.length) return;

    for (const paid of deals) {
        const rec = subState(state, paid.dealId);
        if (rec.chatSent && rec.playerokSent) continue;
        if (playerokIsClosed(paid.status) && rec.chatSent) {
            rec.done = true;
            continue;
        }

        try {
            const data = await issueOnLicense({
                dealId: paid.dealId,
                days: paid.days,
                note: `${paid.buyer || ''} ${paid.itemName || ''}`.trim(),
            });
            const keyCode = data.key?.key_code;
            rec.key = keyCode;
            rec.days = paid.days;

            if (!rec.chatSent && keyCode) {
                await sendChatMessage(
                    client,
                    paid.chatId || chatId,
                    buildKeyChatText(keyCode, paid.days, data.installerUrl),
                );
                rec.chatSent = true;
            }

            if (!rec.playerokSent) {
                try {
                    await confirmDealOnPlayerok(client, paid.dealId);
                    rec.playerokSent = true;
                } catch (e) {
                    console.warn(`[sell] popcorn PlayerOK SENT: ${e.message}`);
                }
            }

            rec.done = Boolean(rec.chatSent && rec.playerokSent);
            console.log(`[sell] popcorn ключ ${paid.dealId.slice(0, 8)}… ${paid.days}д`);
        } catch (e) {
            console.warn(`[sell] popcorn license: ${e.message}`);
            if (!rec.errorTold) {
                rec.errorTold = true;
                try {
                    await sendChatMessage(
                        client,
                        paid.chatId || chatId,
                        '⚠️ Не выдал ключ автоматически. Напиши в этот чат — разберём.',
                    );
                } catch {
                    /* ignore */
                }
            }
        }
    }
}
