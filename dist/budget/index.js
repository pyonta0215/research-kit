export class BudgetExceededError extends Error {
    remainingUsd;
    estimatedNextCostUsd;
    constructor(remainingUsd, estimatedNextCostUsd) {
        super(`Budget exhausted: remaining ${remainingUsd.toFixed(6)}, next estimate ${estimatedNextCostUsd.toFixed(6)}`);
        this.name = 'BudgetExceededError';
        this.remainingUsd = remainingUsd;
        this.estimatedNextCostUsd = estimatedNextCostUsd;
    }
}
export class CostLedger {
    limitUsd;
    totals;
    outstanding = new Map();
    createId;
    estimatedUsd = 0;
    actualUsd = 0;
    heldUsd = 0;
    constructor(components, options = {}) {
        if (options.limitUsd !== undefined && (!Number.isFinite(options.limitUsd) || options.limitUsd <= 0)) {
            throw new Error('limitUsd must be greater than zero');
        }
        this.limitUsd = options.limitUsd;
        this.totals = new Map(components.map((component) => [component, { usd: 0, settled: 0, estimated: false, unmeasured: 0 }]));
        this.createId = options.createId ?? (() => crypto.randomUUID());
    }
    /** 上限の判定に使う額: 精算済み + 未精算の予約 + 費用不明で残した予約 */
    get committedUsd() {
        return this.actualUsd + this.outstandingUsd() + this.heldUsd;
    }
    get remainingUsd() {
        return this.limitUsd === undefined ? Number.POSITIVE_INFINITY : Math.max(0, this.limitUsd - this.committedUsd);
    }
    /** 上限に達しているか（上限なしなら常に false） */
    isExhausted() {
        return this.limitUsd !== undefined && this.committedUsd >= this.limitUsd;
    }
    /** 払う処理の前に見積もりを押さえる。上限を超えるなら {@link BudgetExceededError}。 */
    reserve(estimatedUsd) {
        assertNonNegative(estimatedUsd);
        const committed = this.committedUsd;
        if (this.limitUsd !== undefined && committed + estimatedUsd > this.limitUsd + Number.EPSILON) {
            throw new BudgetExceededError(Math.max(0, this.limitUsd - committed), estimatedUsd);
        }
        this.estimatedUsd += estimatedUsd;
        const reservation = { id: this.createId(), estimatedUsd };
        this.outstanding.set(reservation.id, estimatedUsd);
        return reservation;
    }
    /**
     * 予約を実際の費用で精算する。
     * `unmeasured`（失敗して費用が分からない等）で精算すると、予約額を上限の判定に残したまま件数を数える。
     * 分からない費用を 0 として予算を戻さないため。
     */
    settle(reservation, component, cost) {
        const total = this.requireComponent(component);
        if (cost.basis !== 'unmeasured')
            assertNonNegative(cost.usd);
        if (!this.outstanding.delete(reservation.id))
            throw new Error('Budget reservation is missing or already settled');
        if (cost.basis === 'unmeasured') {
            this.heldUsd += reservation.estimatedUsd;
            total.unmeasured += 1;
            return;
        }
        this.add(total, cost);
    }
    /** 予約した処理を始めなかったとき（費用が発生していないと分かっているときだけ）予約を戻す。 */
    release(reservation) {
        if (!this.outstanding.delete(reservation.id))
            throw new Error('Budget reservation is missing or already settled');
    }
    /**
     * 予約なしで費用を記録する（実行後にしか費用が分からない処理）。
     * `unmeasured` は件数だけを数え、上限の判定には入らない（押さえた額が無いため）。
     */
    record(component, cost) {
        const total = this.requireComponent(component);
        if (cost.basis === 'unmeasured') {
            total.unmeasured += 1;
            return;
        }
        assertNonNegative(cost.usd);
        this.add(total, cost);
    }
    snapshot() {
        const components = {};
        let unmeasured = 0;
        for (const [component, total] of this.totals) {
            unmeasured += total.unmeasured;
            components[component] = {
                usd: total.usd,
                basis: total.settled === 0 ? 'unmeasured' : total.estimated ? 'estimated' : 'metered',
                unmeasured: total.unmeasured,
            };
        }
        return {
            limitUsd: this.limitUsd,
            estimatedUsd: this.estimatedUsd,
            actualUsd: this.actualUsd,
            outstandingUsd: this.outstandingUsd(),
            heldForUnmeasuredUsd: this.heldUsd,
            unmeasured,
            components,
        };
    }
    add(total, cost) {
        this.actualUsd += cost.usd;
        total.usd += cost.usd;
        total.settled += 1;
        if (cost.basis === 'estimated')
            total.estimated = true;
    }
    requireComponent(component) {
        const total = this.totals.get(component);
        if (!total)
            throw new Error(`Unknown cost component: ${component}`);
        return total;
    }
    outstandingUsd() {
        let sum = 0;
        for (const value of this.outstanding.values())
            sum += value;
        return sum;
    }
}
function assertNonNegative(value) {
    if (!Number.isFinite(value) || value < 0)
        throw new Error('Cost must be a finite non-negative number');
}
