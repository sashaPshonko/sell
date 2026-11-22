/**
 * Сколько кк выдавать по заказу FunPay.
 *
 * Цена на FunPay за 1кк, покупатель выбирает количество, поэтому выдаём ровно столько кк, сколько куплено:
 *   количество 100 → 100кк.
 * Размер единицы по умолчанию 1кк (FUNPAY_DEFAULT_UNIT_KK). Брать его из описания лота («10кк») только если
 * включить FUNPAY_UNIT_FROM_DESC=1: по умолчанию число в описании игнорируется, чтобы случайное «от 10кк» не
 * умножило выдачу.
 *
 * Минимальная выдача FUNPAY_MIN_KK (200кк): заказ меньше — возврат и сообщение покупателю (tooSmall).
 * Максимума нет (FUNPAY_MAX_KK, если нужен потолок).
 */
const UNIT_RE = /(\d+(?:[.,]\d+)?)\s*(?:kk|млн|m)(?![\p{L}\d])/iu;

export function parseUnitKk(text) {
    const m = String(text || '').replace(/к/gi, 'k').match(UNIT_RE);
    if (!m) return null;
    const n = Number(m[1].replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {{ shortDescription?: string, fullDescription?: string, description?: string, quantity?: number|null }} o
 * @param {{ defaultUnitKk?: number, maxKk?: number }} [opts]
 * @returns {{ ok: boolean, amountKk: number, unitKk: number, quantity: number, reason?: string }}
 */
export function computeOrderKk(o, opts = {}) {
    const defaultUnit = opts.defaultUnitKk ?? Number(process.env.FUNPAY_DEFAULT_UNIT_KK || 1);
    const maxKk = opts.maxKk ?? (process.env.FUNPAY_MAX_KK ? Number(process.env.FUNPAY_MAX_KK) : Infinity);
    const minKk = opts.minKk ?? Number(process.env.FUNPAY_MIN_KK || 200);
    // количество не разобрали — НЕ возвращаем деньги и не выдаём наугад: ручной режим
    if (!(o.quantity > 0)) return { ok: false, amountKk: 0, unitKk: defaultUnit, quantity: 0, reason: 'не удалось прочитать количество' };
    const qty = o.quantity;
    const fromDesc = opts.unitFromDesc ?? process.env.FUNPAY_UNIT_FROM_DESC === '1';
    const unit = fromDesc
        ? parseUnitKk(o.shortDescription) ?? parseUnitKk(o.description) ?? parseUnitKk(o.fullDescription) ?? defaultUnit
        : defaultUnit;
    const amountKk = Math.round(unit * qty * 1000) / 1000;
    if (!(amountKk > 0)) return { ok: false, amountKk, unitKk: unit, quantity: qty, reason: 'нулевая сумма' };
    if (amountKk < minKk) {
        return { ok: false, tooSmall: true, amountKk, unitKk: unit, quantity: qty, reason: `меньше минимальной выдачи ${minKk}кк` };
    }
    if (amountKk > maxKk) {
        return { ok: false, amountKk, unitKk: unit, quantity: qty, reason: `больше лимита ${maxKk}кк (FUNPAY_MAX_KK)` };
    }
    return { ok: true, amountKk, unitKk: unit, quantity: qty };
}

/**
 * Минимальная выдача из описания лота: «АВТОВЫДАЧА ОТ 200КК», «минимум 150 кк», «мин. сумма 100кк».
 * Нет такой фразы — null (тогда берём FUNPAY_MIN_KK / 200).
 */
const MIN_RE = /(?:^|[^\p{L}])(?:от|мин(?:имум|имальн\p{L}*)?\.?)(?:\s+(?:сумм\p{L}*|заказ\p{L}*|выдач\p{L}*|количеств\p{L}*))*\s*[:\-–]?\s*(\d+(?:[.,]\d+)?)\s*(?:kk|млн|m)(?![\p{L}\d])/iu;

export function parseMinKk(text) {
    const m = String(text || '').replace(/к/gi, 'k').match(MIN_RE);
    if (!m) return null;
    const n = Number(m[1].replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
}
