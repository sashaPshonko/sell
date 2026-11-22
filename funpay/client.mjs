import * as cheerio from 'cheerio';

/**
 * Клиент FunPay (сайт без официального API): сессия по cookie golden_key, разбор HTML/JSON.
 * Селекторы и запросы взяты из открытых реализаций (FunPayCardinal / FunPayAPI) и сверяются
 * с живым аккаунтом скриптом funpay/probe.mjs — если вёрстка изменится, править здесь.
 */

const BASE = process.env.FUNPAY_BASE || 'https://funpay.com';
const DEFAULT_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class FunPayError extends Error {
    constructor(message, { status = 0, kind = 'error' } = {}) {
        super(message);
        this.status = status;
        this.kind = kind; // 'auth' | 'rate' | 'flood' | 'error'
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── чистые парсеры (покрыты тестами) ─────────────────────────

/** body[data-app-data] → { userId, csrf, username } */
export function parseAppPage(html) {
    const $ = cheerio.load(html);
    const username = $('div.user-link-name').first().text().trim();
    if (!username) throw new FunPayError('не вошли: нет div.user-link-name (golden_key устарел?)', { kind: 'auth' });
    let app;
    try {
        app = JSON.parse($('body').attr('data-app-data') || '');
    } catch {
        throw new FunPayError('не разобрал data-app-data', { kind: 'error' });
    }
    return { userId: Number(app.userId), csrf: String(app['csrf-token']), username };
}

/**
 * Список продаж (/orders/trade).
 * status: 'paid' — оплачен, ждёт выполнения (класс info); 'refunded' (warning); 'closed' — остальное.
 */
export function parseSales(html) {
    const $ = cheerio.load(html);
    const orders = [];
    $('a.tc-item').each((_, el) => {
        const a = $(el);
        const cls = a.attr('class') || '';
        const status = cls.includes('warning') ? 'refunded' : cls.includes('info') ? 'paid' : 'closed';
        const id = a.find('div.tc-order').first().text().trim().replace(/^#/, '');
        if (!id) return;
        const description = a.find('div.order-desc div').first().text().trim();
        const priceText = a.find('div.tc-price').first().text().trim();
        const m = priceText.match(/^([\d\s.,]+)\s*(\S+)$/);
        const price = m ? Number(m[1].replace(/\s/g, '').replace(',', '.')) : null;
        const buyerEl = a.find('div.media-user-name span').first();
        const href = buyerEl.attr('data-href') || '';
        const buyerIdMatch = href.match(/\/users\/(\d+)/);
        orders.push({
            id,
            status,
            description,
            price,
            currency: m ? m[2] : '',
            buyerName: buyerEl.text().trim(),
            buyerId: buyerIdMatch ? Number(buyerIdMatch[1]) : null,
            category: a.find('div.text-muted').first().text().trim(),
            dateText: a.find('div.tc-date-time').first().text().trim(),
        });
    });
    const next = $('input[type="hidden"][name="continue"]').attr('value') || null;
    return { orders, next };
}

/** Страница заказа (/orders/<id>/): пары «название параметра → значение» (param-item). */
export function parseOrderPage(html) {
    const $ = cheerio.load(html);
    const params = {};
    $('div.param-item').each((_, el) => {
        const item = $(el);
        const label = item.find('h5').first().text().trim();
        const value = item.find('div').first().text().trim() || item.clone().children('h5').remove().end().text().trim();
        if (label) params[label] = value;
    });
    const find = (re) => {
        for (const [k, v] of Object.entries(params)) if (re.test(k)) return v;
        return '';
    };
    const qtyText = find(/количеств/i);
    const qm = qtyText.match(/[\d\s.,]+/);
    return {
        params,
        shortDescription: find(/краткое описание/i),
        fullDescription: find(/подробное описание/i),
        quantity: qm ? Number(qm[0].replace(/\s/g, '').replace(',', '.')) : null,
        quantityText: qtyText,
    };
}

/** Ответ /chat/history или chat_node: массив сообщений { id, author, text, system } */
export function parseChatMessages(messages) {
    const out = [];
    for (const m of messages || []) {
        const $ = cheerio.load(`<div id="r">${m.html || ''}</div>`);
        const author = Number(m.author ?? 0);
        const text = (author === 0 ? $('div[role=alert]').first().text() : $('div.chat-msg-text').first().text()).trim()
            || $('#r').text().trim();
        out.push({ id: Number(m.id), author, text: text.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, ''), system: author === 0, raw: m });
    }
    return out;
}

/** Лоты на странице продавца (/users/<id>/): id, ссылка, описание. */
export function parseOwnLots(html) {
    const $ = cheerio.load(html);
    const lots = [];
    $('a.tc-item').each((_, el) => {
        const a = $(el);
        const href = a.attr('href') || '';
        if (!/\/lots\/offer/.test(href)) return;
        lots.push({ href, description: a.find('.tc-desc-text').first().text().trim() });
    });
    return lots;
}

const RU_MONTHS = { января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5, июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11 };

/**
 * Дата регистрации со страницы профиля (/users/<id>/): блок «Дата регистрации» → «4 июня 2022, 14:29».
 * Время на сайте московское (UTC+3). Возвращает миллисекунды (UTC) или null, если не распознали.
 */
export function parseRegisteredAt(html) {
    const $ = cheerio.load(html);
    let text = '';
    $('.param-item').each((_, el) => {
        const item = $(el);
        if (/дата регистрации/i.test(item.find('h5').first().text())) text = item.text();
    });
    const m = text.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})(?:,?\s*(\d{1,2}):(\d{2}))?/i);
    if (!m) return null;
    const month = RU_MONTHS[m[2].toLowerCase()];
    if (month === undefined) return null;
    return Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4] || 0) - 3, Number(m[5] || 0));
}

/** Левая колонка чатов (chat_bookmarks.html) */
export function parseChatList(html) {
    const $ = cheerio.load(html);
    const chats = [];
    $('a.contact-item').each((_, el) => {
        const a = $(el);
        const chatId = Number(a.attr('data-id'));
        if (!chatId) return;
        chats.push({
            chatId,
            userName: a.find('div.media-user-name').first().text().trim(),
            lastText: a.find('div.contact-item-message').first().text().trim(),
            nodeMsg: Number(a.attr('data-node-msg')) || 0,
            unread: (a.attr('class') || '').includes('unread'),
        });
    });
    return chats;
}

// ───────────────────────── клиент ─────────────────────────

export class FunPayClient {
    constructor({ goldenKey, userAgent = DEFAULT_UA, phpsessid = '' }) {
        if (!goldenKey) throw new Error('FUNPAY_GOLDEN_KEY не задан');
        this.goldenKey = goldenKey;
        this.userAgent = userAgent;
        this.phpsessid = phpsessid;
        this.jar = {}; // прочие cookie от сайта (golden_seal и т.п.): без них /runner/ отвечает «cookie отсутствует или устарела»
        this.userId = null;
        this.username = '';
        this.csrf = '';
        this.lastRateAt = 0;
    }

    cookies() {
        const c = [`golden_key=${this.goldenKey}`, 'cookie_prefs=1'];
        if (this.phpsessid) c.push(`PHPSESSID=${this.phpsessid}`);
        for (const [k, v] of Object.entries(this.jar)) c.push(`${k}=${v}`);
        return c.join('; ');
    }

    /** Один HTTP-запрос с повторами на 429/5xx; редирект на логин или 403 → ошибка авторизации. */
    async request(method, path, { headers = {}, body, expectJson = false } = {}) {
        const url = path.startsWith('http') ? path : `${BASE}/${path.replace(/^\//, '')}`;
        let lastErr;
        for (let attempt = 0; attempt < 6; attempt++) {
            let res;
            try {
                res = await fetch(url, {
                    method,
                    redirect: 'manual',
                    headers: { 'user-agent': this.userAgent, cookie: this.cookies(), ...headers },
                    body,
                });
            } catch (e) {
                lastErr = e;
                await sleep(Math.min(1000 * 2 ** attempt, 15000));
                continue;
            }
            const setCookie = res.headers.getSetCookie?.() || [];
            for (const sc of setCookie) {
                const m = sc.match(/^([^=;\s]+)=([^;]*)/);
                if (!m || m[1] === 'golden_key') continue;
                if (m[1] === 'PHPSESSID') this.phpsessid = m[2];
                else if (m[2]) this.jar[m[1]] = m[2];
            }
            if (res.status === 429) {
                this.lastRateAt = Date.now();
                await sleep(Math.min(2 ** (attempt + 1) * 1000, 30000));
                continue;
            }
            if (res.status >= 500) {
                lastErr = new FunPayError(`HTTP ${res.status}`, { status: res.status });
                await sleep(Math.min(1000 * 2 ** attempt, 15000));
                continue;
            }
            if (res.status === 403) throw new FunPayError('403 (golden_key / защита)', { status: 403, kind: 'auth' });
            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get('location') || '';
                if (/account\/login/.test(loc)) throw new FunPayError('редирект на логин (golden_key устарел)', { status: res.status, kind: 'auth' });
                // прочие редиректы (локаль, слэш) — идём за ними один раз
                return this.request(method, loc, { headers, body, expectJson });
            }
            if (res.status !== 200) throw new FunPayError(`HTTP ${res.status} ${path}`, { status: res.status });
            return expectJson ? res.json() : res.text();
        }
        throw lastErr || new FunPayError(`не удалось получить ${path}`, { kind: 'rate' });
    }

    /** Войти по golden_key: csrf-токен, id, ник. Обновляет PHPSESSID — вызывать раз в 40–60 минут. */
    async init() {
        const html = await this.request('GET', '/');
        const { userId, csrf, username } = parseAppPage(html);
        this.userId = userId;
        this.csrf = csrf;
        this.username = username;
        return { userId, username };
    }

    /** Все продажи с пагинацией (maxPages — сколько страниц листать назад). */
    async getSales({ maxPages = 1 } = {}) {
        const all = [];
        let next = null;
        for (let page = 0; page < maxPages; page++) {
            const html = next
                ? await this.request('POST', '/orders/trade', {
                      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                      body: new URLSearchParams({ continue: next, state_id: '', buyer: '', game: '', 'subcategory-id': '' }).toString(),
                  })
                : await this.request('GET', '/orders/trade');
            const { orders, next: n } = parseSales(html);
            all.push(...orders);
            if (!n || !orders.length) break;
            next = n;
        }
        return all;
    }

    /** Детали заказа: количество, описание, параметры. */
    async getOrderDetails(orderId) {
        const html = await this.request('GET', `/orders/${encodeURIComponent(orderId)}/`);
        return parseOrderPage(html);
    }

    chatNode(buyerId) {
        const [a, b] = [this.userId, Number(buyerId)].sort((x, y) => x - y);
        return `users-${a}-${b}`;
    }

    /** Заголовки и тело запроса к /runner/ (так ходит сам сайт). */
    async runner(objects, request = false) {
        const body = new URLSearchParams({
            csrf_token: this.csrf,
            objects: JSON.stringify(objects),
            request: request ? JSON.stringify(request) : 'false',
        }).toString();
        return this.request('POST', '/runner/', {
            headers: {
                accept: '*/*',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-requested-with': 'XMLHttpRequest',
            },
            body,
            expectJson: true,
        });
    }

    /**
     * История чата после lastMessage (-1 = последние сообщения) — через chat_node в /runner/.
     * (GET /chat/history на живом аккаунте отдаёт пустой список, runner — полный.)
     */
    async getChatHistory(node, lastMessage = -1) {
        const json = await this.runner([{ type: 'chat_node', id: node, tag: '00000000', data: { node, last_message: lastMessage, content: '' } }]);
        const obj = (json?.objects || []).find((o) => o.type === 'chat_node' && o.id === node);
        return parseChatMessages(obj?.data?.messages);
    }

    /** Свои лоты (для минимальной выдачи из описания). */
    async getOwnLots() {
        return parseOwnLots(await this.request('GET', `/users/${this.userId}/`));
    }

    /** Когда покупатель зарегистрирован на FunPay (мс, UTC) или null. Профили публичные. */
    async getUserRegisteredAt(userId) {
        return parseRegisteredAt(await this.request('GET', `/users/${userId}/`));
    }

    /** Список чатов (левая колонка): chatId, ник собеседника, последнее сообщение, id последнего сообщения. */
    async getChats() {
        const json = await this.runner([{ type: 'chat_bookmarks', id: this.userId, tag: '00000000', data: false }]);
        const obj = (json?.objects || []).find((o) => o.type === 'chat_bookmarks');
        return parseChatList(obj?.data?.html || '');
    }

    /** Чат по числовому id (из списка чатов): имя узла users-A-B и сообщения после lastMessage. */
    async getChatByNumericId(chatId, lastMessage = 0) {
        const json = await this.runner([{ type: 'chat_node', id: String(chatId), tag: '00000000', data: { node: String(chatId), last_message: lastMessage, content: '' } }]);
        const obj = (json?.objects || []).find((o) => o.type === 'chat_node');
        return { name: obj?.data?.node?.name || '', messages: parseChatMessages(obj?.data?.messages) };
    }

    /** Отправить сообщение в чат (через /runner/ как это делает сайт). */
    async sendMessage(node, text) {
        // как у FunPayCardinal (abuse_runner): в objects идёт chat_node этого чата, в request — само сообщение
        const json = await this.runner(
            [{ type: 'chat_node', id: node, tag: '00000000', data: { node, last_message: -1, content: '' } }],
            { action: 'chat_message', data: { node, last_message: -1, content: text } },
        );
        const err = json?.response?.error;
        if (err) {
            const flood = /слишком часто/i.test(String(err));
            throw new FunPayError(`сообщение не доставлено: ${err}`, { kind: flood ? 'flood' : 'error' });
        }
        return json;
    }

    /** Возврат денег покупателю (кнопка «Вернуть деньги»). Сайт отвечает 200 и {"error":true,"msg":...} при отказе. */
    async refund(orderId) {
        const json = await this.request('POST', '/orders/refund', {
            headers: {
                accept: '*/*',
                'x-requested-with': 'XMLHttpRequest',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            body: new URLSearchParams({ id: orderId, csrf_token: this.csrf }).toString(),
            expectJson: true,
        });
        if (json?.error) throw new FunPayError(`возврат #${orderId}: ${json.msg || 'отказ'}`);
        return json;
    }
}
