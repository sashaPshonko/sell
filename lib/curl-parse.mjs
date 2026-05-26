/** Парсинг «Copy as cURL» из Chrome DevTools */

/** Строка cookie из -b '...' */
export function extractCookieHeaderFromCurl(curl) {
    const m = curl.match(/-b\s+'([^']+)'/s) || curl.match(/-b\s+"([^"]+)"/s);
    return m?.[1]?.trim() || null;
}

export function extractTokenFromCurl(curl) {
    const m =
        curl.match(/(?:^|[\s'"])token=([^;'"\s\\]+)/i) ||
        curl.match(/(?:-H|--header)\s+['"]cookie:\s*[^'"]*token=([^;'"\s\\]+)/i);
    if (m?.[1]?.length > 50) return m[1];
    return null;
}

/** GET graphql?operationName=...&extensions=... → hash */
export function extractPersistedFromCurl(curl) {
    const out = {};
    const urlMatches = curl.matchAll(/https?:\/\/[^\s'"]+graphql[^\s'"]*/gi);
    for (const um of urlMatches) {
        let url = um[0].replace(/\\$/g, '');
        try {
            const u = new URL(url);
            const op = u.searchParams.get('operationName');
            const ext = u.searchParams.get('extensions');
            if (!op || !ext) continue;
            const parsed = JSON.parse(ext);
            const hash = parsed?.persistedQuery?.sha256Hash;
            if (hash) out[op] = hash;
        } catch {
            /* ignore */
        }
    }
    return out;
}

/** POST body с query mutation */
export function splitCurlBlocks(text) {
    const parts = text.split(/\n(?=curl\s+['"]https:\/\/playerok\.com)/i);
    return parts.filter((p) => p.includes('playerok.com'));
}

export function extractPostOperationsFromCurl(curl) {
    const ops = [];
    const gqlOp = curl.match(/x-gql-op:\s*([^\s\\'"]+)/i)?.[1];
    const bodyRe = /(?:--data-raw|--data|-d)\s+\$?'([\s\S]*?)'(?:\s*\\)?\s*(?:\n\s*-H|\n\s*--|\n*$)/gi;
    for (const b of curl.matchAll(bodyRe)) {
        try {
            let raw = b[1].replace(/\\u0021/g, '!').replace(/\\"/g, '"').replace(/\\n/g, '\n');
            const json = JSON.parse(raw);
            const list = Array.isArray(json) ? json : [json];
            for (const item of list) {
                if (!item.operationName) continue;
                ops.push({
                    operationName: item.operationName,
                    gqlOp: gqlOp || item.operationName,
                    query: item.query || null,
                    variables: item.variables || {},
                });
            }
        } catch {
            /* ignore */
        }
    }
    return ops;
}
