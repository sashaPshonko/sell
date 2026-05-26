/**
 * Разбор HAR (Chrome: Network → правый клик → Save all as HAR with content).
 */

/** JWT из cookie token в HAR (запросы и ответы) */
export function extractTokenFromHar(harJson) {
    const entries = harJson?.log?.entries || [];
    const candidates = [];

    for (const entry of entries) {
        const url = entry.request?.url || entry.response?.url || '';
        if (!url.includes('playerok')) continue;

        const bags = [
            entry.request?.cookies,
            entry.response?.cookies,
        ];
        for (const list of bags) {
            for (const c of list || []) {
                if (c.name === 'token' && c.value?.length > 50) candidates.push(c.value);
            }
        }

        for (const headers of [entry.request?.headers, entry.response?.headers]) {
            for (const h of headers || []) {
                const n = (h.name || '').toLowerCase();
                if (n !== 'cookie' && n !== 'set-cookie') continue;
                const re = /(?:^|[;,]\s*)token=([^;,\s]+)/gi;
                let m;
                while ((m = re.exec(h.value || ''))) {
                    if (m[1]?.length > 50) candidates.push(m[1]);
                }
            }
        }
    }

    return candidates.find((t) => t.startsWith('eyJ')) || candidates[0] || null;
}

function headerMap(headers = []) {
    const m = {};
    for (const h of headers) {
        const k = (h.name || '').toLowerCase();
        if (k) m[k] = h.value;
    }
    return m;
}

function parseGraphqlUrl(url) {
    try {
        const u = new URL(url);
        if (!u.pathname.includes('graphql')) return null;
        const op = u.searchParams.get('operationName');
        const vars = u.searchParams.get('variables');
        const ext = u.searchParams.get('extensions');
        let hash;
        if (ext) {
            const parsed = JSON.parse(ext);
            hash = parsed?.persistedQuery?.sha256Hash;
        }
        return {
            method: 'GET',
            operationName: op,
            variables: vars ? JSON.parse(vars) : {},
            hash,
            query: null,
            gqlOp: null,
        };
    } catch {
        return null;
    }
}

function parsePostBody(text) {
    if (!text) return null;
    try {
        const body = JSON.parse(text);
        const ops = Array.isArray(body) ? body : [body];
        return ops.map((b) => ({
            method: 'POST',
            operationName: b.operationName,
            variables: b.variables || {},
            query: b.query || null,
            hash: b.extensions?.persistedQuery?.sha256Hash,
            gqlOp: null,
        }));
    } catch {
        return null;
    }
}

export function parseHarFile(harJson) {
    const entries = harJson?.log?.entries || [];
    const ops = new Map();

    for (const entry of entries) {
        const url = entry.request?.url || '';
        if (!url.includes('playerok.com/graphql')) continue;

        const headers = headerMap(entry.request?.headers);
        const gqlOp = headers['x-gql-op'] || null;
        let parsed = null;

        if (entry.request?.method === 'GET') {
            parsed = parseGraphqlUrl(url);
        } else if (entry.request?.method === 'POST') {
            const posts = parsePostBody(entry.request?.postData?.text);
            if (posts) parsed = posts[0];
        }

        if (!parsed?.operationName) continue;

        const name = parsed.operationName;
        const prev = ops.get(name);
        const score = (parsed.query ? 10 : 0) + (parsed.method === 'POST' ? 5 : 0) + (gqlOp ? 1 : 0);

        const record = {
            ...parsed,
            gqlOp: gqlOp || parsed.gqlOp,
            url,
            score,
        };

        if (!prev || record.score > prev.score) {
            ops.set(name, record);
        }
    }

    return [...ops.values()].sort((a, b) => a.operationName.localeCompare(b.operationName));
}

/** Эвристика: какая операция для чего */
export function classifyOperations(operations) {
    const send = [];
    const confirm = [];
    const hashes = {};

    for (const op of operations) {
        const n = op.operationName.toLowerCase();
        const gql = (op.gqlOp || '').toLowerCase();
        const blob = `${n} ${gql} ${op.query || ''}`.toLowerCase();

        if (op.hash) hashes[op.operationName] = op.hash;

        if (/createchatmessage|sendmessage|createchat|addchatmessage/.test(blob)) {
            send.push(op);
        } else if (/message|send|postmessage|reply/.test(blob) && /mutation/.test(blob)) {
            send.push(op);
        }
        if (/updatedeal|confirmdeal|confirmitem/.test(blob)) {
            const st = op.variables?.input?.status;
            if (st === 'CONFIRMED' || st === 'COMPLETED') confirm.push(op);
            else if (st === 'SENT') {
                /* «отправил», не финальное «выполнил» */
            } else confirm.push(op);
        } else if (/confirm|complete|fulfill|finish|done|approve/.test(blob) && /mutation/.test(blob)) {
            confirm.push(op);
        }
        if (n === 'userchats' && op.hash) hashes.userChats = op.hash;
        if (n === 'chatmessages' && op.hash) hashes.chatMessages = op.hash;
    }

    return {
        send: send[0] || operations.find((o) => /create.*message|send.*message/i.test(o.operationName)),
        confirm: confirm[0] || operations.find((o) => /confirm/i.test(o.operationName)),
        hashes,
        all: operations,
    };
}

export function variablesTemplate(variables) {
    return JSON.stringify(variables, null, 2)
        .replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi, '"$1"')
        .replace(/"([^"]{1,200})"/g, (m, val) => {
            if (/^[0-9a-f-]{36}$/i.test(val)) return `"${val}"`.replace(val, 'CHAT_ID');
            if (val.length > 3 && val.length < 500 && !val.startsWith('{{')) {
                return '"MESSAGE_TEXT"';
            }
            return m;
        });
}

/** Умная замена id чата и текста в variables */
export function toEnvVariables(variables) {
    const s = JSON.stringify(variables);
    let out = s;
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const uuids = [...new Set(s.match(uuidRe) || [])];
    if (uuids[0]) out = out.replaceAll(uuids[0], 'CHAT_ID');

    // длинные строки — вероятно текст сообщения
    const parsed = JSON.parse(out);
    replaceLongStrings(parsed);
    return JSON.stringify(parsed);
}

function replaceLongStrings(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
        const v = obj[key];
        if (typeof v === 'string' && v.length >= 8 && v.length <= 2000 && !v.startsWith('{{') && !/^[0-9a-f-]{36}$/i.test(v)) {
            if (/text|message|body|content/i.test(key)) obj[key] = 'MESSAGE_TEXT';
        } else if (typeof v === 'object') replaceLongStrings(v);
    }
}
