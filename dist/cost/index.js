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
export const UNMEASURED = Object.freeze({ usd: null, basis: 'unmeasured' });
export class UnknownPriceError extends Error {
    model;
    constructor(model) {
        super(`No price is configured for model "${model}"; its cost cannot be computed, so it is not run`);
        this.name = 'UnknownPriceError';
        this.model = model;
    }
}
/**
 * 単価表からモデルの単価を引く。無ければ {@link UnknownPriceError}。
 * 単価が分からないモデルを 0 円で通すと、予算の歯止めが黙って外れるため。
 */
export function requirePrice(table, model) {
    if (!Object.hasOwn(table, model))
        throw new UnknownPriceError(model);
    return table[model];
}
/** 単価表にあれば単価、無ければ undefined（例外にしたくない記録用途向け）。 */
export function findPrice(table, model) {
    return Object.hasOwn(table, model) ? table[model] : undefined;
}
export function assertValidPrice(price, label = 'price') {
    for (const value of [price.inputPerMillionUsd, price.outputPerMillionUsd, price.cachedInputPerMillionUsd]) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0))
            throw new Error(`Invalid token ${label}`);
    }
}
/** トークン費用の内訳。キャッシュ済み入力は入力トークン数を超えない範囲で数える。 */
export function tokenCostBreakdown(price, usage) {
    assertCount(usage.inputTokens, 'inputTokens');
    assertCount(usage.outputTokens, 'outputTokens');
    const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
    assertCount(cached, 'cachedInputTokens');
    // 掛けてから割る（整数のトークン数では、割ってから掛けるより丸め誤差が出にくい）
    const inputMicro = (usage.inputTokens - cached) * price.inputPerMillionUsd;
    const cachedMicro = cached * (price.cachedInputPerMillionUsd ?? price.inputPerMillionUsd);
    const outputMicro = usage.outputTokens * price.outputPerMillionUsd;
    return {
        inputUsd: inputMicro / 1_000_000,
        cachedInputUsd: cachedMicro / 1_000_000,
        outputUsd: outputMicro / 1_000_000,
        totalUsd: (inputMicro + cachedMicro + outputMicro) / 1_000_000,
    };
}
export function tokenCostUsd(price, usage) {
    return tokenCostBreakdown(price, usage).totalUsd;
}
export function webSearchCostUsd(counts, pricing) {
    const units = pricing.count === 'all-calls' ? counts.calls : counts.search;
    if (units === undefined)
        throw new Error('Counting search actions requires the search count');
    assertCount(units, 'web search count');
    return units * pricing.perCallUsd;
}
/**
 * 時間で課金されるもの（実行基盤・ブラウザのセッション）を、設定した単価で見積もる。
 * 途中までの単位は1単位に切り上げ、動いた以上は最低1単位とする。結果の basis は `estimated`。
 */
export function billedDurationCost(options) {
    assertCount(options.elapsedMs, 'elapsedMs');
    if (!(options.unitMs > 0) || !Number.isFinite(options.perUnitUsd) || options.perUnitUsd < 0) {
        throw new Error('Invalid duration pricing');
    }
    const units = Math.max(1, Math.ceil(options.elapsedMs / options.unitMs));
    return { usd: units * options.perUnitUsd, basis: 'estimated' };
}
/** 小数第 digits 位で丸める（既定 6 桁 = 0.000001 USD）。 */
export function roundUsd(value, digits = 6) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}
/**
 * 複数の費用を合計する。1つでも `unmeasured` があれば、分かった分の合計と未計測の件数を分けて返す。
 * 未計測を 0 として足した値を「合計」と呼ばないため。
 */
export function sumCosts(costs) {
    let knownUsd = 0;
    let unmeasured = 0;
    let estimated = false;
    for (const cost of costs) {
        if (cost.basis === 'unmeasured')
            unmeasured += 1;
        else {
            knownUsd += cost.usd;
            if (cost.basis === 'estimated')
                estimated = true;
        }
    }
    const basis = costs.length === 0 || unmeasured === costs.length ? 'unmeasured' : estimated ? 'estimated' : 'metered';
    return { knownUsd, unmeasured, basis };
}
function assertCount(value, field) {
    if (!Number.isFinite(value) || value < 0)
        throw new Error(`${field} must be a finite non-negative number`);
}
