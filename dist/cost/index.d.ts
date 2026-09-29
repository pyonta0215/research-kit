/**
 * AI 呼び出しの費用を、使用量と単価から計算する道具。
 *
 * **ここで出る金額は請求額ではない。** 使用量（API が返したトークン数・呼び出し回数）に、
 * 利用側が転記した単価を掛けた見積もりで、単価表の古さ・丸め・請求側の集計単位の差を含む。
 *
 * 金額には必ず「どう求めたか」を付ける。
 *
 * | basis | 意味 |
 * |---|---|
 * | `metered` | API が返した使用量 × 公開単価。請求額ではないが、推測は入っていない |
 * | `estimated` | 設定した単価 × 観測した時間など、仮定を含む見積もり |
 * | `unmeasured` | 求められなかった。**0 円として扱わない** |
 */
export type CostBasis = 'metered' | 'estimated' | 'unmeasured';
export type MeasuredCost = {
    usd: number;
    basis: 'metered' | 'estimated';
} | {
    usd: null;
    basis: 'unmeasured';
};
export declare const UNMEASURED: MeasuredCost;
/** 100万トークンあたりの USD。 */
export interface TokenPrice {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    /** 無ければキャッシュ済み入力も通常の入力単価で数える（少なく見積もらない側に倒す） */
    cachedInputPerMillionUsd?: number;
    /**
     * キャッシュ書き込みの単価。指定すると、キャッシュされなかった入力はすべて書き込まれたとみなしてこの単価で数える。
     * Responses API の使用量には書き込んだトークン数が返らないため、少なく見積もらない側に倒した上限値になる。
     */
    cacheWritePerMillionUsd?: number;
    /** 長いプロンプトの割増。無ければ入力トークン数によらず同じ単価で数える */
    longContext?: LongContextPricing;
}
/**
 * 入力トークン数が閾値を超えたリクエストは、リクエスト全体に倍率がかかる
 * （入力・キャッシュ済み入力・キャッシュ書き込みに inputMultiplier、出力に outputMultiplier）。
 *
 * 判定は1リクエスト単位。複数リクエストを合算した使用量で計算すると、合計が閾値を超えただけで倍率がかかり、
 * 実際より多めの見積もりになる（少なくはならない）。
 */
export interface LongContextPricing {
    /** この入力トークン数を**超える**と倍率がかかる（ちょうど同じなら通常単価） */
    aboveInputTokens: number;
    inputMultiplier: number;
    outputMultiplier: number;
}
export interface TokenUsage {
    /** キャッシュ済み入力を含む入力トークン数（OpenAI Responses API の input_tokens と同じ数え方） */
    inputTokens: number;
    outputTokens: number;
    /** inputTokens のうちキャッシュ済みの分 */
    cachedInputTokens?: number;
}
export declare class UnknownPriceError extends Error {
    readonly model: string;
    constructor(model: string);
}
/**
 * 単価表からモデルの単価を引く。無ければ {@link UnknownPriceError}。
 * 単価が分からないモデルを 0 円で通すと、予算の歯止めが黙って外れるため。
 */
export declare function requirePrice<T>(table: Readonly<Record<string, T>>, model: string): T;
/** 単価表にあれば単価、無ければ undefined（例外にしたくない記録用途向け）。 */
export declare function findPrice<T>(table: Readonly<Record<string, T>>, model: string): T | undefined;
export declare function assertValidPrice(price: TokenPrice, label?: string): void;
export interface TokenCostBreakdown {
    inputUsd: number;
    cachedInputUsd: number;
    outputUsd: number;
    totalUsd: number;
}
/**
 * トークン費用の内訳。キャッシュ済み入力は入力トークン数を超えない範囲で数える。
 * `inputUsd` はキャッシュされなかった入力の費用で、`cacheWritePerMillionUsd` があればその単価で数えた値。
 * `longContext` の判定は `usage` を1リクエスト分とみなして行う。
 */
export declare function tokenCostBreakdown(price: TokenPrice, usage: TokenUsage): TokenCostBreakdown;
export declare function tokenCostUsd(price: TokenPrice, usage: TokenUsage): number;
export interface WebSearchCounts {
    /** `web_search_call` の件数（ページを開く・ページ内検索を含む） */
    calls: number;
    /** そのうち検索（action.type === 'search'）の件数。`count: 'search-actions'` のときは必須 */
    search?: number;
}
export interface WebSearchPricing {
    perCallUsd: number;
    /**
     * どの件数に単価を掛けるか。利用側が選ぶ（既定値を持たない）。
     *
     * - `search-actions`: 検索だけを数える。公式の料金説明は「検索は tool call の費用が掛かる」とだけ書き、
     *   ページを開く操作が課金単位かは明記していない
     * - `all-calls`: ページを開く・ページ内検索も1回に数える。多めに見積もり、予算の歯止めを緩めない
     *
     * どちらを選んでも請求額と一致する保証はない（検索結果のトークンは別に課金される）。
     */
    count: 'search-actions' | 'all-calls';
}
export declare function webSearchCostUsd(counts: WebSearchCounts, pricing: WebSearchPricing): number;
/**
 * 時間で課金されるもの（実行基盤・ブラウザのセッション）を、設定した単価で見積もる。
 * 途中までの単位は1単位に切り上げ、動いた以上は最低1単位とする。結果の basis は `estimated`。
 */
export declare function billedDurationCost(options: {
    elapsedMs: number;
    unitMs: number;
    perUnitUsd: number;
}): {
    usd: number;
    basis: 'estimated';
};
/** 小数第 digits 位で丸める（既定 6 桁 = 0.000001 USD）。 */
export declare function roundUsd(value: number, digits?: number): number;
/**
 * 複数の費用を合計する。1つでも `unmeasured` があれば、分かった分の合計と未計測の件数を分けて返す。
 * 未計測を 0 として足した値を「合計」と呼ばないため。
 */
export declare function sumCosts(costs: readonly MeasuredCost[]): {
    knownUsd: number;
    unmeasured: number;
    basis: CostBasis;
};
