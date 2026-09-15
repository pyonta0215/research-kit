/**
 * Responses API（OpenAI 公式、または同じ形を返す互換エンドポイント）の結果を読む道具。
 *
 * ここにあるのは「API が返した構造から、本文・使用量・出典を取り出す」ことと、
 * 「タイムアウト付きで送り、失敗を安全な形で返す」ことだけ。
 * プロンプト、ツールの設定、業務スキーマ、出典の採否は利用側に残す。
 *
 * ## 出典は3種類を区別して返す
 *
 * | 種類 | 取り出し元 | 意味 |
 * |---|---|---|
 * | `citation` | 本文の `url_citation` 注釈 | モデルがその箇所の根拠として示した URL。付く回と付かない回がある |
 * | `search-result` | `web_search_call` の `action.sources` | 検索結果に出た URL。`include: ['web_search_call.action.sources']` を付けたときだけ返る |
 * | `opened-page` | `web_search_call` の `open_page` / `find_in_page` の `action.url` | 実際に開いた（ページ内検索した）URL |
 *
 * **モデルが本文に書いただけの URL はどれにも入れない。** 出典集合に URL があることは
 * 「API がその URL を扱った」ことしか示さず、そのページが主張を裏付けることは示さない。
 */
const asRecord = (value) => typeof value === 'object' && value !== null ? value : {};
const asArray = (value) => (Array.isArray(value) ? value : []);
const asString = (value) => (typeof value === 'string' ? value : undefined);
const asCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
/**
 * Responses API のレスポンス JSON を読む。形が崩れていても例外にせず、読めたものだけを返す。
 * （使用量が無いことは `usage: undefined` で分かる）
 */
export function parseResponse(raw) {
    const body = asRecord(raw);
    const texts = [];
    const citations = [];
    const searchResults = [];
    const openedPages = [];
    const byUrl = new Map();
    const webSearch = { calls: 0, search: 0, openPage: 0, findInPage: 0, other: 0, queries: [] };
    const see = (url, kind) => {
        const entry = byUrl.get(url);
        if (!entry)
            byUrl.set(url, { url, kinds: [kind] });
        else if (!entry.kinds.includes(kind))
            entry.kinds.push(kind);
    };
    for (const entry of asArray(body.output)) {
        const item = asRecord(entry);
        if (item.type === 'web_search_call') {
            webSearch.calls += 1;
            const action = asRecord(item.action);
            if (action.type === 'search') {
                webSearch.search += 1;
                const query = asString(action.query);
                const queries = asArray(action.queries).map(asString).filter((q) => Boolean(q));
                for (const q of queries.length > 0 ? queries : query ? [query] : [])
                    webSearch.queries.push(q);
                for (const source of asArray(action.sources)) {
                    const url = asString(asRecord(source).url);
                    if (!url)
                        continue;
                    searchResults.push(url);
                    see(url, 'search-result');
                }
            }
            else if (action.type === 'open_page' || action.type === 'find_in_page') {
                if (action.type === 'open_page')
                    webSearch.openPage += 1;
                else
                    webSearch.findInPage += 1;
                const url = asString(action.url);
                if (url) {
                    openedPages.push(url);
                    see(url, 'opened-page');
                }
            }
            else {
                webSearch.other += 1;
            }
            continue;
        }
        if (item.type !== 'message')
            continue;
        for (const part of asArray(item.content)) {
            const block = asRecord(part);
            const text = asString(block.text);
            if (block.type === 'output_text' && text)
                texts.push(text);
            for (const note of asArray(block.annotations)) {
                const annotation = asRecord(note);
                const url = asString(annotation.url);
                if (annotation.type !== 'url_citation' || !url)
                    continue;
                citations.push({
                    url,
                    title: asString(annotation.title) ?? '',
                    startIndex: asCount(annotation.start_index),
                    endIndex: asCount(annotation.end_index),
                });
                see(url, 'citation');
            }
        }
    }
    // SDK が付ける output_text は、output を持たない形を渡されたときだけ使う
    if (texts.length === 0 && body.output === undefined) {
        const convenience = asString(body.output_text);
        if (convenience)
            texts.push(convenience);
    }
    return {
        id: asString(body.id),
        status: asString(body.status),
        incompleteReason: asString(asRecord(body.incomplete_details).reason),
        text: texts.join('\n'),
        usage: parseUsage(body.usage),
        sources: { citations, searchResults, openedPages, urls: [...byUrl.values()] },
        webSearch,
    };
}
function parseUsage(value) {
    const usage = asRecord(value);
    const inputTokens = asCount(usage.input_tokens);
    const outputTokens = asCount(usage.output_tokens);
    if (inputTokens === undefined || outputTokens === undefined)
        return undefined;
    return {
        inputTokens,
        cachedInputTokens: asCount(asRecord(usage.input_tokens_details).cached_tokens) ?? 0,
        outputTokens,
        reasoningTokens: asCount(asRecord(usage.output_tokens_details).reasoning_tokens),
    };
}
/**
 * 出典の和集合から、指定した種類で現れた URL だけを返す（現れた順）。
 * 例えば「引用か開いたページだけを根拠に使い、検索結果に出ただけの URL は使わない」ときに絞る。
 */
export function sourceUrlsOf(sources, kinds) {
    return sources.urls.filter((entry) => entry.kinds.some((kind) => kinds.includes(kind))).map((entry) => entry.url);
}
// ---------------------------------------------------------------------------
// 送信
// ---------------------------------------------------------------------------
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
/**
 * 失敗を、状態コード・エラーコード・リクエスト ID だけで表す。
 *
 * API キー、リクエスト本文、レスポンス本文、API が返したエラーメッセージは含めない。
 * エラーメッセージには、伏せ字にしたキーや入力の一部が入ることがあるため。
 */
export class ResponsesApiError extends Error {
    kind;
    status;
    code;
    requestId;
    constructor(label, details) {
        const base = `${label} Responses API`;
        const request = details.requestId ? ` (request ${details.requestId})` : '';
        const message = details.kind === 'timeout'
            ? `${base} timed out after ${details.timeoutMs}ms`
            : details.kind === 'network'
                ? `${base} request could not be sent`
                : details.kind === 'invalid-json'
                    ? `${base} returned a body that is not JSON: ${details.status}${request}`
                    : `${base} error: ${details.status}${details.code ? ` ${details.code}` : ''}${request}`;
        super(message);
        this.name = 'ResponsesApiError';
        this.kind = details.kind;
        this.status = details.status;
        this.code = details.code;
        this.requestId = details.requestId;
    }
}
/**
 * Responses API へ POST し、成功したらレスポンス JSON を返す。
 * Node と Cloudflare Workers の両方で使えるよう、グローバルの fetch と AbortSignal だけを使う。
 */
export async function postResponsesRequest(options) {
    const label = options.label ?? 'OpenAI';
    const request = options.fetch ?? fetch;
    const signal = AbortSignal.timeout(options.timeoutMs);
    const headers = new Headers(options.headers);
    if (!headers.has('content-type'))
        headers.set('content-type', 'application/json');
    let response;
    let text;
    try {
        response = await request(options.url, {
            method: 'POST',
            headers,
            body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
            signal,
        });
        text = await response.text();
    }
    catch (error) {
        if (signal.aborted || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))) {
            throw new ResponsesApiError(label, { kind: 'timeout', timeoutMs: options.timeoutMs });
        }
        throw new ResponsesApiError(label, { kind: 'network' });
    }
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        body = undefined;
    }
    if (!response.ok) {
        const error = asRecord(asRecord(body).error);
        const code = asString(error.code) ?? asString(error.type);
        throw new ResponsesApiError(label, {
            kind: 'http',
            status: response.status,
            ...(code ? { code } : {}),
            ...(requestId ? { requestId } : {}),
        });
    }
    if (body === undefined) {
        throw new ResponsesApiError(label, { kind: 'invalid-json', status: response.status, ...(requestId ? { requestId } : {}) });
    }
    return body;
}
