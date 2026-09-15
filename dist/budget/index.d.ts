/**
 * 1回の実行の中で使う、費用の予約と精算の台帳。
 *
 * 払う処理の前に見積もりを予約し、上限を超えるならその処理を始めない。終わったら実際の費用で精算する。
 * 並行する処理の予約も「使った分」に含めて判定する。
 *
 * ## この台帳が保証しないこと
 *
 * - **メモリ上の台帳なので、実行をまたいだ上限（月額など）は守れない。** プロセスが変われば0から始まる。
 *   月間の上限は、利用側が永続化した支出の合計と、同時に走る実行どうしの排他（条件付き書き込みなど）で守る
 * - **見積もりが実際より小さければ、上限を超える。** 予約は見積もりを信じるだけで、呼び出しの費用に上限を掛けない。
 *   厳密な上限には「呼び出し側で費用の上限を固定できる」こと（出力トークン・ツール呼び出し回数の上限と、
 *   入力の大きさが事前に分かること）が要る。Web 検索のように読んだページの量で入力が増える呼び出しでは成り立たない
 * - 金額は使用量 × 単価の見積もりで、請求額ではない（`../cost` を参照）
 */
import type { CostBasis, MeasuredCost } from '../cost/index.js';
export declare class BudgetExceededError extends Error {
    readonly remainingUsd: number;
    readonly estimatedNextCostUsd: number;
    constructor(remainingUsd: number, estimatedNextCostUsd: number);
}
export interface BudgetReservation {
    readonly id: string;
    readonly estimatedUsd: number;
}
export interface ComponentTotal {
    /** 精算・記録された金額の合計（未計測は含まない） */
    usd: number;
    /**
     * 何も精算されていなければ `unmeasured`。`estimated` が1つでも混ざれば `estimated`、すべて実測なら `metered`。
     * 0 で精算されたものも測った結果として扱う（金額ではなく basis が「測ったか」を表す）
     */
    basis: CostBasis;
    /** 費用が分からないまま終わった件数 */
    unmeasured: number;
}
export interface LedgerSnapshot<C extends string> {
    limitUsd: number | undefined;
    /** これまでの予約の合計 */
    estimatedUsd: number;
    /** 精算・記録された金額の合計 */
    actualUsd: number;
    /** まだ精算されていない予約の合計 */
    outstandingUsd: number;
    /** 費用不明で終わった予約の見積もりの合計。上限の判定では使った分として残す */
    heldForUnmeasuredUsd: number;
    unmeasured: number;
    components: Record<C, ComponentTotal>;
}
export interface CostLedgerOptions {
    /** 省略すると上限なし（記録だけに使う）。指定するなら 0 より大きい有限の値 */
    limitUsd?: number;
    /** テスト用 */
    createId?: () => string;
}
export declare class CostLedger<C extends string> {
    readonly limitUsd: number | undefined;
    private readonly totals;
    private readonly outstanding;
    private readonly createId;
    private estimatedUsd;
    private actualUsd;
    private heldUsd;
    constructor(components: readonly C[], options?: CostLedgerOptions);
    /** 上限の判定に使う額: 精算済み + 未精算の予約 + 費用不明で残した予約 */
    get committedUsd(): number;
    get remainingUsd(): number;
    /** 上限に達しているか（上限なしなら常に false） */
    isExhausted(): boolean;
    /** 払う処理の前に見積もりを押さえる。上限を超えるなら {@link BudgetExceededError}。 */
    reserve(estimatedUsd: number): BudgetReservation;
    /**
     * 予約を実際の費用で精算する。
     * `unmeasured`（失敗して費用が分からない等）で精算すると、予約額を上限の判定に残したまま件数を数える。
     * 分からない費用を 0 として予算を戻さないため。
     */
    settle(reservation: BudgetReservation, component: C, cost: MeasuredCost): void;
    /** 予約した処理を始めなかったとき（費用が発生していないと分かっているときだけ）予約を戻す。 */
    release(reservation: BudgetReservation): void;
    /**
     * 予約なしで費用を記録する（実行後にしか費用が分からない処理）。
     * `unmeasured` は件数だけを数え、上限の判定には入らない（押さえた額が無いため）。
     */
    record(component: C, cost: MeasuredCost): void;
    snapshot(): LedgerSnapshot<C>;
    private add;
    private requireComponent;
    private outstandingUsd;
}
