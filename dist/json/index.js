/**
 * モデルの出力テキストから JSON を取り出す。
 *
 * 構造化出力（json_schema）を強制すると Web 検索の引用が付かないことがあるため、
 * 「自然文で調べる → JSON で返させる」の2段にしたとき、2段目の出力がコードフェンスや
 * 前置きの文に包まれて返ることがある。そこから JSON 部分だけを救う。
 *
 * 検証（スキーマとの照合）と、失敗したときに再試行するかは利用側が決める。
 */
/**
 * JSON らしい部分を切り出す。
 * コードフェンスがあればその中身、無ければ最初の `{` か `[` から、対応する種類の最後の閉じ括弧まで。
 * どちらも見つからなければ前後の空白を除いた全体を返す。
 */
export function extractJsonCandidate(text) {
    const trimmed = text.trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence?.[1] !== undefined)
        return fence[1].trim();
    const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter((index) => index >= 0);
    if (starts.length === 0)
        return trimmed;
    const start = Math.min(...starts);
    const end = trimmed.lastIndexOf(trimmed[start] === '{' ? '}' : ']');
    return end > start ? trimmed.slice(start, end + 1) : trimmed;
}
/** {@link extractJsonCandidate} で切り出してから JSON.parse する。例外は投げない。 */
export function parseJsonFromText(text) {
    try {
        return { ok: true, value: JSON.parse(extractJsonCandidate(text)) };
    }
    catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
}
