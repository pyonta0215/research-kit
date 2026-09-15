import { describe, expect, it } from 'vitest';
import { BudgetExceededError, CostLedger } from './index.js';

type Component = 'llm' | 'browser' | 'runtime';
const COMPONENTS: Component[] = ['llm', 'browser', 'runtime'];

describe('CostLedger', () => {
  it('予約してから精算し、内訳と basis を持つ', () => {
    const ledger = new CostLedger(COMPONENTS, { limitUsd: 1 });
    const reservation = ledger.reserve(0.4);
    ledger.settle(reservation, 'llm', { usd: 0.25, basis: 'metered' });
    const snapshot = ledger.snapshot();
    expect(snapshot).toMatchObject({ estimatedUsd: 0.4, actualUsd: 0.25, outstandingUsd: 0, heldForUnmeasuredUsd: 0, unmeasured: 0 });
    expect(snapshot.components).toEqual({
      llm: { usd: 0.25, basis: 'metered', unmeasured: 0 },
      browser: { usd: 0, basis: 'unmeasured', unmeasured: 0 },
      runtime: { usd: 0, basis: 'unmeasured', unmeasured: 0 },
    });
    expect(() => ledger.settle(reservation, 'llm', { usd: 0.25, basis: 'metered' })).toThrow('already settled');
  });

  it('0 で精算したものは測った結果として扱う', () => {
    const ledger = new CostLedger(COMPONENTS, { limitUsd: 1 });
    ledger.settle(ledger.reserve(0.01), 'runtime', { usd: 0, basis: 'estimated' });
    expect(ledger.snapshot().components.runtime.basis).toBe('estimated');
  });

  it('上限を超える予約を拒み、並行する未精算の予約も数える', () => {
    const ledger = new CostLedger(COMPONENTS, { limitUsd: 1 });
    const first = ledger.reserve(0.4);
    ledger.reserve(0.5);
    expect(() => ledger.reserve(0.11)).toThrow(BudgetExceededError);
    ledger.settle(first, 'runtime', { usd: 0.25, basis: 'estimated' });
    expect(ledger.remainingUsd).toBeCloseTo(0.25);
    ledger.reserve(0.25);
    const error = (() => {
      try {
        ledger.reserve(0.001);
      } catch (e) {
        return e as BudgetExceededError;
      }
    })();
    expect(error).toMatchObject({ remainingUsd: 0, estimatedNextCostUsd: 0.001 });
  });

  it('費用不明で終わった予約は、予算に戻さず件数を残す', () => {
    const ledger = new CostLedger(COMPONENTS, { limitUsd: 1 });
    ledger.settle(ledger.reserve(0.6), 'llm', { usd: null, basis: 'unmeasured' });
    expect(ledger.remainingUsd).toBeCloseTo(0.4);
    expect(() => ledger.reserve(0.5)).toThrow(BudgetExceededError);
    const snapshot = ledger.snapshot();
    expect(snapshot).toMatchObject({ actualUsd: 0, heldForUnmeasuredUsd: 0.6, unmeasured: 1 });
    expect(snapshot.components.llm).toEqual({ usd: 0, basis: 'unmeasured', unmeasured: 1 });
  });

  it('始めなかった処理の予約は戻せる', () => {
    const ledger = new CostLedger(COMPONENTS, { limitUsd: 1 });
    const reservation = ledger.reserve(0.9);
    ledger.release(reservation);
    expect(ledger.remainingUsd).toBe(1);
    expect(() => ledger.release(reservation)).toThrow('already settled');
  });

  it('予約なしの記録: 実測・推定・未計測を分けて数え、上限に達したかを判定できる', () => {
    const ledger = new CostLedger(COMPONENTS, { limitUsd: 0.3 });
    ledger.record('llm', { usd: 0.2, basis: 'metered' });
    ledger.record('llm', { usd: null, basis: 'unmeasured' });
    expect(ledger.isExhausted()).toBe(false);
    ledger.record('browser', { usd: 0.1, basis: 'estimated' });
    expect(ledger.isExhausted()).toBe(true);
    expect(ledger.snapshot().components.llm).toEqual({ usd: 0.2, basis: 'metered', unmeasured: 1 });
  });

  it('上限なしでは記録だけをする', () => {
    const ledger = new CostLedger(COMPONENTS);
    ledger.reserve(1_000);
    expect(ledger.remainingUsd).toBe(Number.POSITIVE_INFINITY);
    expect(ledger.isExhausted()).toBe(false);
  });

  it('不正な値を受け付けない', () => {
    expect(() => new CostLedger(COMPONENTS, { limitUsd: 0 })).toThrow();
    const ledger = new CostLedger(COMPONENTS, { limitUsd: 1 });
    expect(() => ledger.reserve(-1)).toThrow();
    expect(() => ledger.record('llm', { usd: Number.NaN, basis: 'metered' })).toThrow();
    expect(() => ledger.record('other' as Component, { usd: 1, basis: 'metered' })).toThrow('Unknown cost component');
  });
});
