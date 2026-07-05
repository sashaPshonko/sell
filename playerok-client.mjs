import { readFile } from 'fs/promises';

const GQL_URL = 'https://playerok.com/graphql';

const DEFAULT_HEADERS = {
    accept: '*/*',
    'content-type': 'application/json',
    'apollo-require-preflight': 'true',
    'apollographql-client-name': 'web',
    origin: 'https://playerok.com',
    referer: 'https://playerok.com/chats',
    'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/** Минимальные cookies — работают с VPS; полная строка с __ddg9_ привязана к IP дома */
function buildCookie(token) {
    const auid = process.env.PLAYEROK_AUID?.trim();
    const ddg1 = process.env.PLAYEROK_DDG1?.trim();
    const parts = [
        auid ? `auid=${auid}` : '',
        `token=${token}`,
        ddg1 ? `__ddg1_=${ddg1}` : '',
    ].filter(Boolean);
    return parts.join('; ');
}

export function createClient() {
    const token = process.env.PLAYEROK_TOKEN;
    if (!token) {
        throw new Error('В .env нужен PLAYEROK_TOKEN (JWT из cookie playerok.com)');
    }

    const baseHeaders = {
        ...DEFAULT_HEADERS,
        cookie: buildCookie(token),
        'x-timezone-offset': process.env.TIMEZONE_OFFSET || '-300',
    };

    function gqlErrorMessage(json, statusText) {
        const err = json?.errors?.[0];
        if (!err) return statusText;
        if (typeof err.message === 'string') return err.message;
        return String(err.message ?? statusText);
    }

    function isPersistedQueryNotFound(json) {
        return json?.errors?.some((e) => {
            const msg = String(e?.message ?? '');
            const code = e?.extensions?.code ?? e?.extensions?.exception?.code;
            return msg.includes('PersistedQueryNotFound') || code === 'PERSISTED_QUERY_NOT_FOUND';
        });
    }

    async function request(opts) {
        const headers = {
            ...baseHeaders,
            ...(opts.referer ? { referer: opts.referer } : {}),
            ...(opts.gqlOp ? { 'x-gql-op': opts.gqlOp } : {}),
            ...(opts.gqlPath ? { 'x-gql-path': opts.gqlPath } : {}),
        };

        let url = GQL_URL;
        let init = { method: 'POST', headers, body: JSON.stringify(opts.body) };

        if (opts.persisted) {
            const params = new URLSearchParams({
                operationName: opts.persisted.operationName,
                variables: JSON.stringify(opts.persisted.variables),
                extensions: JSON.stringify({
                    persistedQuery: {
                        version: 1,
                        sha256Hash: opts.persisted.hash,
                    },
                }),
            });
            url = `${GQL_URL}?${params}`;
            init = { method: 'GET', headers };
        }

        const res = await fetch(url, init);
        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`PlayerOK: не JSON (${res.status}): ${text.slice(0, 200)}`);
        }

        if (
            opts.persisted &&
            opts.fallbackBody &&
            isPersistedQueryNotFound(json)
        ) {
            const retryRes = await fetch(GQL_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify(opts.fallbackBody),
            });
            const retryText = await retryRes.text();
            try {
                json = JSON.parse(retryText);
            } catch {
                throw new Error(`PlayerOK: не JSON (${retryRes.status}): ${retryText.slice(0, 200)}`);
            }
            if (!retryRes.ok || json.errors?.length) {
                throw new Error(`PlayerOK GraphQL: ${gqlErrorMessage(json, retryRes.statusText)}`);
            }
            return json.data;
        }

        if (!res.ok || json.errors?.length) {
            throw new Error(`PlayerOK GraphQL: ${gqlErrorMessage(json, res.statusText)}`);
        }
        return json.data;
    }

    return {
        async viewer() {
            const query = `query viewer {
  viewer {
    id
    username
    canPublishItems
    balance { available value }
  }
}`;
            return request({
                gqlOp: 'viewer',
                gqlPath: '/chats',
                body: { operationName: 'viewer', variables: {}, query },
            });
        },

        async userChats(userId, first = 15) {
            const hash = process.env.USER_CHATS_HASH;
            if (!hash) {
                throw new Error('В .env укажи USER_CHATS_HASH (из DevTools, запрос userChats)');
            }
            return request({
                gqlOp: 'userChats',
                gqlPath: '/chats',
                persisted: {
                    operationName: 'userChats',
                    hash,
                    variables: {
                        pagination: { first },
                        filter: { userId },
                    },
                },
            });
        },

        async chatMessages(
            chatId,
            first = Number(process.env.CHAT_MESSAGES_FIRST || 20),
            after = null,
        ) {
            const hash = process.env.CHAT_MESSAGES_HASH;
            const pagination = after ? { first, after } : { first };
            const variables = {
                pagination,
                filter: { chatId },
                hasSupportAccess: process.env.CHAT_HAS_SUPPORT_ACCESS === '1',
                showForbiddenImage: process.env.CHAT_SHOW_FORBIDDEN_IMAGE !== '0',
            };
            const query = await loadQuery('CHAT_MESSAGES_QUERY_FILE', './queries/chatMessages.graphql');
            const fallbackBody = { operationName: 'chatMessages', variables, query };
            const reqOpts = {
                gqlOp: 'chatMessages',
                gqlPath: '/chats/[id]',
                referer: `https://playerok.com/chats/${chatId}`,
                fallbackBody,
            };

            if (hash) {
                return request({
                    ...reqOpts,
                    persisted: {
                        operationName: 'chatMessages',
                        hash,
                        variables,
                    },
                });
            }

            return request({
                ...reqOpts,
                body: fallbackBody,
            });
        },

        /** Лоты продавца (профиль → products). Hash из DevTools: operationName=items */
        /** Премки для перевыставления (перед publishItem). */
        async itemPriorityStatuses(itemId, price, referer = null) {
            const hash =
                process.env.ITEM_PRIORITY_STATUSES_HASH ||
                'b922220c6f979537e1b99de6af8f5c13727daeff66727f679f07f986ce1c025a';
            return request({
                gqlOp: 'itemPriorityStatuses',
                gqlPath: '/products/[slug]',
                referer: referer || 'https://playerok.com/profile/products',
                persisted: {
                    operationName: 'itemPriorityStatuses',
                    hash,
                    variables: {
                        itemId,
                        price: Math.max(0, Math.round(Number(price) || 0)),
                    },
                },
            });
        },

        async sellerItems(userId, { first = 16, after = null, username = null } = {}) {
            const hash =
                process.env.ITEMS_HASH ||
                'bacca5d020eef37b4ff7a2253ad33ecd8b7e144b9ef854c20051f42ebcd04d82';
            const pagination = after ? { first, after } : { first };
            const profileUser =
                username?.trim() ||
                process.env.PLAYEROK_USERNAME?.trim() ||
                null;
            const referer = profileUser
                ? `https://playerok.com/profile/${profileUser}/products`
                : 'https://playerok.com/profile/products';
            return request({
                gqlOp: 'items',
                gqlPath: '/profile/[username]/products',
                referer,
                persisted: {
                    operationName: 'items',
                    hash,
                    variables: {
                        pagination,
                        filter: {
                            userId,
                            status: ['APPROVED', 'PENDING_MODERATION', 'PENDING_APPROVAL'],
                            withOfficial: false,
                        },
                        showForbiddenImage: true,
                    },
                },
            });
        },

        async runMutationFromFile(
            fileEnvKey,
            defaultPath,
            variables,
            operationName,
            gqlPath = '/chats/[id]',
        ) {
            const query = await loadQuery(fileEnvKey, defaultPath);
            const op = operationName || process.env.CONFIRM_DEAL_OPERATION || 'confirmDeal';
            return request({
                gqlOp: op,
                gqlPath,
                body: { operationName: op, variables, query },
            });
        },
    };
}

async function loadQuery(envKey, defaultPath) {
    const path = process.env[envKey] || defaultPath;
    try {
        const raw = await readFile(path, 'utf8');
        return raw
            .split('\n')
            .filter((line) => !line.trim().startsWith('#'))
            .join('\n')
            .trim();
    } catch {
        throw new Error(
            `Нет файла запроса ${path}. Сними из DevTools (Copy → Copy as cURL / Payload) или задай ${envKey} в .env`,
        );
    }
}
