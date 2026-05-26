# Отмена сделки на PlayerOK

`/cancel` в чате → sellbot снимает заказ + фаза `cancelled`.

**На сайте** (если `AUTO_CANCEL_PLAYEROK=1` в `.env`):

- mutation: `captures/cancel-deal.graphql`
- статус: **`ROLLED_BACK`** (как в DevTools при отмене)

```env
AUTO_CANCEL_PLAYEROK=1
CANCEL_DEAL_OPERATION=updateDeal
CANCEL_DEAL_MUTATION_FILE=./captures/cancel-deal.graphql
CANCEL_DEAL_STATUS=ROLLED_BACK
CANCEL_DEAL_VARIABLES={"input":{"id":"DEAL_ID","status":"ROLLED_BACK"}}
```

Обновить из нового cURL: вставь в `captures/paste-cancel.curl` → `npm run capture-cancel`.

Пока `AUTO_CANCEL_PLAYEROK=0` — только локально, без API PlayerOK.
