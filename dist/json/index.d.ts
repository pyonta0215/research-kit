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
export declare function extractJsonCandidate(text: string): string;
export type JsonParseResult = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    /**
     * JSON.parse のメッセージ。**モデル出力の断片を含むことがある**ので、
     * 修復を促すプロンプトには使ってよいが、ログやエラー表示には出さない。
     */
    detail: string;
};
/** {@link extractJsonCandidate} で切り出してから JSON.parse する。例外は投げない。 */
export declare function parseJsonFromText(text: string): JsonParseResult;
