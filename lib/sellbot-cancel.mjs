import { dispatchCancelOrder } from '../dispatch.mjs';
import { isOrderFulfilled } from './playerok-deal-sync.mjs';

/** Снять с sellbot все заказы, которые по state уже закрыты (один раз на id за сессию poll). */
export function cancelClosedOrdersOnSellbot(state) {
    if (!Array.isArray(state._sellbotCancelSent)) state._sellbotCancelSent = [];
    const sent = new Set(state._sellbotCancelSent);

    for (const o of Object.values(state.orders || {})) {
        if (!o || !isOrderFulfilled(o)) continue;
        const oid = o.orderId || o.dealId;
        if (!oid || sent.has(oid)) continue;
        sent.add(oid);
        state._sellbotCancelSent.push(oid);
        void dispatchCancelOrder(oid);
        console.log(`[sell] sellbot: отмена закрытого ${oid.slice(0, 8)}…`);
    }
}
