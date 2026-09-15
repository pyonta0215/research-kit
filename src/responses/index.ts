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

export type SourceKind = 'citation' | 'search-result' | 'opened-page';

export interface UrlCitation {
  url: string;
  /** 注釈にタイトルが無ければ空文字（補わない） */
  title: string;
  /** 本文中の位置。注釈に無ければ undefined */
  startIndex: number | undefined;
  endIndex: number | undefined;
}

export interface SourceUrl {
  url: string;
  /** その URL がどの経路で現れたか。重複は1件にまとめ、種類を併記する */
  kinds: SourceKind[];
}

export interface ResponseSources {
  citations: UrlCitation[];
  searchResults: string[];
  openedPages: string[];
  /** 3種類の和集合。レスポンスに現れた順、URL の完全一致で重複を除く（正規化はしない） */
  urls: SourceUrl[];
}

export interface WebSearchActivity {
  /** `web_search_call` の件数（検索・ページを開く・ページ内検索のすべて） */
  calls: number;
  search: number;
  openPage: number;
  findInPage: number;
  /** action が無い、または知らない種類 */
  other: number;
  /** 検索クエリ。API が返したときだけ入る */
  queries: string[];
}

export interface ResponseUsage {
  /** キャッシュ済み入力を含む入力トークン数 */
  inputTokens: number;
  /** `input_tokens_details.cached_tokens`。返らなければ 0 */
  cachedInputTokens: number;
  outputTokens: number;
  /** `output_tokens_details.reasoning_tokens`。出力トークン数に含まれる。返らなければ undefined */
  reasoningTokens: number | undefined;
}

export interface ParsedResponse {
  id: string | undefined;
  /** `completed` / `incomplete` / `failed` など。返らなければ undefined */
  status: string | undefined;
  /** `incomplete_details.reason`（`max_output_tokens` など） */
  incompleteReason: string | undefined;
  /** message の output_text をすべて改行で連結したもの */
  text: string;
  /** 使用量が返らなかったときは undefined。0 で埋めない（費用を「無料」に見せないため） */
  usage: ResponseUsage | undefined;
  sources: ResponseSources;
  webSearch: WebSearchActivity;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord =>
  typeof value === 'object' && value !== null ? (value as UnknownRecord) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Responses API のレスポンス JSON を読む。形が崩れていても例外にせず、読めたものだけを返す。
 * （使用量が無いことは `usage: undefined` で分かる）
 */
export function parseResponse(raw: unknown): ParsedResponse {
  const body = asRecord(raw);
  const texts: string[] = [];
  const citations: UrlCitation[] = [];
  const searchResults: string[] = [];
  const openedPages: string[] = [];
  const byUrl = new Map<string, SourceUrl>();
  const webSearch: WebSearchActivity = { calls: 0, search: 0, openPage: 0, findInPage: 0, other: 0, queries: [] };

  const see = (url: string, kind: SourceKind) => {
    const entry = byUrl.get(url);
    if (!entry) byUrl.set(url, { url, kinds: [kind] });
    else if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
  };

  for (const entry of asArray(body.output)) {
    const item = asRecord(entry);
    if (item.type === 'web_search_call') {
      webSearch.calls += 1;
      const action = asRecord(item.action);
      if (action.type === 'search') {
        webSearch.search += 1;
        const query = asString(action.query);
        const queries = asArray(action.queries).map(asString).filter((q): q is string => Boolean(q));
        for (const q of queries.length > 0 ? queries : query ? [query] : []) webSearch.queries.push(q);
        for (const source of asArray(action.sources)) {
          const url = asString(asRecord(source).url);
          if (!url) continue;
          searchResults.push(url);
          see(url, 'search-result');
        }
      } else if (action.type === 'open_page' || action.type === 'find_in_page') {
        if (action.type === 'open_page') webSearch.openPage += 1;
        else webSearch.findInPage += 1;
        const url = asString(action.url);
        if (url) {
          openedPages.push(url);
          see(url, 'opened-page');
        }
      } else {
        webSearch.other += 1;
      }
      continue;
    }
    if (item.type !== 'message') continue;
    for (const part of asArray(item.content)) {
      const block = asRecord(part);
      const text = asString(block.text);
      if (block.type === 'output_text' && text) texts.push(text);
      for (const note of asArray(block.annotations)) {
        const annotation = asRecord(note);
        const url = asString(annotation.url);
        if (annotation.type !== 'url_citation' || !url) continue;
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
    if (convenience) texts.push(convenience);
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

function parseUsage(value: unknown): ResponseUsage | undefined {
  const usage = asRecord(value);
  const inputTokens = asCount(usage.input_tokens);
  const outputTokens = asCount(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
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
export function sourceUrlsOf(sources: ResponseSources, kinds: readonly SourceKind[]): string[] {
  return sources.urls.filter((entry) => entry.kinds.some((kind) => kinds.includes(kind))).map((entry) => entry.url);
}

// ---------------------------------------------------------------------------
// 送信
// ---------------------------------------------------------------------------

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export type ResponsesApiErrorKind = 'http' | 'timeout' | 'network' | 'invalid-json';

/**
 * 失敗を、状態コード・エラーコード・リクエスト ID だけで表す。
 *
 * API キー、リクエスト本文、レスポンス本文、API が返したエラーメッセージは含めない。
 * エラーメッセージには、伏せ字にしたキーや入力の一部が入ることがあるため。
 */
export class ResponsesApiError extends Error {
  readonly kind: ResponsesApiErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    label: string,
    details: { kind: ResponsesApiErrorKind; status?: number; code?: string; requestId?: string; timeoutMs?: number },
  ) {
    const base = `${label} Responses API`;
    const request = details.requestId ? ` (request ${details.requestId})` : '';
    const message =
      details.kind === 'timeout'
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

export interface PostResponsesOptions {
  url: string;
  /**
   * 認証ヘッダを含む。ここで組み立てた値はエラーに出さない。
   * content-type が無ければ application/json を足す（大文字小文字を問わず、あれば触らない。署名済みヘッダを壊さないため）
   */
  headers: Readonly<Record<string, string>>;
  /** JSON にする前の値、または署名済みの JSON 文字列 */
  body: unknown;
  /** 必須。呼び出しの性質（検索の有無、出力の長さ）で適切な値が違うので既定値を持たない */
  timeoutMs: number;
  /** エラーの先頭に付ける呼び先の名前。既定 `OpenAI` */
  label?: string;
  fetch?: typeof fetch;
}

/**
 * Responses API へ POST し、成功したらレスポンス JSON を返す。
 * Node と Cloudflare Workers の両方で使えるよう、グローバルの fetch と AbortSignal だけを使う。
 */
export async function postResponsesRequest(options: PostResponsesOptions): Promise<unknown> {
  const label = options.label ?? 'OpenAI';
  const request = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs);
  const headers = new Headers(options.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  let response: Response;
  let text: string;
  try {
    response = await request(options.url, {
      method: 'POST',
      headers,
      body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
      signal,
    });
    text = await response.text();
  } catch (error) {
    if (signal.aborted || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))) {
      throw new ResponsesApiError(label, { kind: 'timeout', timeoutMs: options.timeoutMs });
    }
    throw new ResponsesApiError(label, { kind: 'network' });
  }

  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
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
