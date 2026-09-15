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
/**
 * Responses API のレスポンス JSON を読む。形が崩れていても例外にせず、読めたものだけを返す。
 * （使用量が無いことは `usage: undefined` で分かる）
 */
export declare function parseResponse(raw: unknown): ParsedResponse;
/**
 * 出典の和集合から、指定した種類で現れた URL だけを返す（現れた順）。
 * 例えば「引用か開いたページだけを根拠に使い、検索結果に出ただけの URL は使わない」ときに絞る。
 */
export declare function sourceUrlsOf(sources: ResponseSources, kinds: readonly SourceKind[]): string[];
export declare const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export type ResponsesApiErrorKind = 'http' | 'timeout' | 'network' | 'invalid-json';
/**
 * 失敗を、状態コード・エラーコード・リクエスト ID だけで表す。
 *
 * API キー、リクエスト本文、レスポンス本文、API が返したエラーメッセージは含めない。
 * エラーメッセージには、伏せ字にしたキーや入力の一部が入ることがあるため。
 */
export declare class ResponsesApiError extends Error {
    readonly kind: ResponsesApiErrorKind;
    readonly status: number | undefined;
    readonly code: string | undefined;
    readonly requestId: string | undefined;
    constructor(label: string, details: {
        kind: ResponsesApiErrorKind;
        status?: number;
        code?: string;
        requestId?: string;
        timeoutMs?: number;
    });
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
export declare function postResponsesRequest(options: PostResponsesOptions): Promise<unknown>;
