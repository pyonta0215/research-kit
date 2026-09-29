import { describe, expect, it } from 'vitest';
import {
  assertValidPrice,
  billedDurationCost,
  findPrice,
  requirePrice,
  roundUsd,
  sumCosts,
  tokenCostBreakdown,
  tokenCostUsd,
  UNMEASURED,
  UnknownPriceError,
  webSearchCostUsd,
} from './index.js';

const price = { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 12 };

describe('tokenCostUsd', () => {
  it('キャッシュ済み入力を分けて数える', () => {
    const breakdown = tokenCostBreakdown(price, { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 });
    expect(breakdown.inputUsd).toBeCloseTo(1.2);
    expect(breakdown.cachedInputUsd).toBeCloseTo(0.08);
    expect(breakdown.outputUsd).toBeCloseTo(1.2);
    expect(breakdown.totalUsd).toBeCloseTo(2.48);
  });

  it('整数のトークン数と単価なら丸め誤差を出さない', () => {
    expect(tokenCostUsd({ inputPerMillionUsd: 1, outputPerMillionUsd: 5 }, { inputTokens: 100, outputTokens: 50 })).toBe(0.00035);
  });

  it('キャッシュ単価が無ければ通常の入力単価で数える（少なく見積もらない）', () => {
    expect(tokenCostUsd({ inputPerMillionUsd: 2, outputPerMillionUsd: 12 }, { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 }))
      .toBeCloseTo(2);
  });

  it('キャッシュ済みが入力を超えていても入力を上限にする', () => {
    expect(tokenCostUsd(price, { inputTokens: 100, cachedInputTokens: 1000, outputTokens: 0 })).toBeCloseTo((100 / 1e6) * 0.2);
  });

  const gpt6 = {
    inputPerMillionUsd: 2,
    cachedInputPerMillionUsd: 0.2,
    cacheWritePerMillionUsd: 2.5,
    outputPerMillionUsd: 10,
    longContext: { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  };

  it('書き込み単価も割増も無ければ、今までと同じ金額になる', () => {
    const usage = { inputTokens: 500_000, cachedInputTokens: 100_000, outputTokens: 20_000 };
    const breakdown = tokenCostBreakdown(price, usage);
    expect(breakdown.inputUsd).toBeCloseTo(0.8);
    expect(breakdown.cachedInputUsd).toBeCloseTo(0.02);
    expect(breakdown.outputUsd).toBeCloseTo(0.24);
    expect(breakdown.totalUsd).toBeCloseTo(1.06);
  });

  it('書き込み単価があれば、キャッシュされなかった入力をすべてその単価で数える（上限値）', () => {
    const breakdown = tokenCostBreakdown(gpt6, { inputTokens: 200_000, cachedInputTokens: 50_000, outputTokens: 10_000 });
    expect(breakdown.inputUsd).toBeCloseTo(0.375);
    expect(breakdown.cachedInputUsd).toBeCloseTo(0.01);
    expect(breakdown.outputUsd).toBeCloseTo(0.1);
    expect(breakdown.totalUsd).toBeCloseTo(0.485);
  });

  it('入力が閾値を超えたらリクエスト全体に倍率をかけ、ちょうど閾値なら通常単価にする', () => {
    const atThreshold = tokenCostBreakdown(gpt6, { inputTokens: 272_000, outputTokens: 10_000 });
    expect(atThreshold.inputUsd).toBeCloseTo(0.68);
    expect(atThreshold.outputUsd).toBeCloseTo(0.1);

    const above = tokenCostBreakdown(gpt6, { inputTokens: 300_000, cachedInputTokens: 100_000, outputTokens: 10_000 });
    expect(above.inputUsd).toBeCloseTo(200_000 * 2.5 * 2 / 1e6);
    expect(above.cachedInputUsd).toBeCloseTo(100_000 * 0.2 * 2 / 1e6);
    expect(above.outputUsd).toBeCloseTo(10_000 * 10 * 1.5 / 1e6);
    expect(above.totalUsd).toBeCloseTo(1 + 0.04 + 0.15);
  });

  it('書き込み単価が無くても割増はかかる', () => {
    const { cacheWritePerMillionUsd: _, ...noWrite } = gpt6;
    expect(tokenCostUsd(noWrite, { inputTokens: 300_000, outputTokens: 0 })).toBeCloseTo(1.2);
  });

  it('負の単価や倍率は受け付けない', () => {
    expect(() => assertValidPrice({ ...gpt6, cacheWritePerMillionUsd: -1 })).toThrow();
    expect(() => assertValidPrice({ ...gpt6, longContext: { ...gpt6.longContext, inputMultiplier: Number.NaN } })).toThrow();
    expect(() => assertValidPrice(gpt6)).not.toThrow();
  });

  it('負の数や NaN の使用量は受け付けない', () => {
    expect(() => tokenCostUsd(price, { inputTokens: -1, outputTokens: 0 })).toThrow();
    expect(() => tokenCostUsd(price, { inputTokens: Number.NaN, outputTokens: 0 })).toThrow();
  });
});

describe('requirePrice', () => {
  const table = { 'model-a': price };

  it('表に無いモデルは 0 円にせず例外にする', () => {
    expect(() => requirePrice(table, 'model-unknown')).toThrow(UnknownPriceError);
    expect(findPrice(table, 'model-unknown')).toBeUndefined();
  });

  it('Object のプロトタイプにある名前を単価として拾わない', () => {
    expect(() => requirePrice(table, 'toString')).toThrow(UnknownPriceError);
    expect(() => requirePrice(table, '__proto__')).toThrow(UnknownPriceError);
  });

  it('表にあれば返す', () => {
    expect(requirePrice(table, 'model-a')).toBe(price);
  });
});

describe('webSearchCostUsd', () => {
  const counts = { calls: 5, search: 2 };

  it('数え方を利用側が選ぶ', () => {
    expect(webSearchCostUsd(counts, { perCallUsd: 0.01, count: 'search-actions' })).toBeCloseTo(0.02);
    expect(webSearchCostUsd(counts, { perCallUsd: 0.01, count: 'all-calls' })).toBeCloseTo(0.05);
  });

  it('検索だけを数えるのに検索の件数が無ければ、0 にせず例外にする', () => {
    expect(webSearchCostUsd({ calls: 3 }, { perCallUsd: 0.01, count: 'all-calls' })).toBeCloseTo(0.03);
    expect(() => webSearchCostUsd({ calls: 3 }, { perCallUsd: 0.01, count: 'search-actions' })).toThrow();
  });
});

describe('billedDurationCost', () => {
  it('途中までの単位を切り上げ、最低1単位にする。見積もりとして返す', () => {
    expect(billedDurationCost({ elapsedMs: 0, unitMs: 1000, perUnitUsd: 0.01 })).toEqual({ usd: 0.01, basis: 'estimated' });
    expect(billedDurationCost({ elapsedMs: 61_000, unitMs: 60_000, perUnitUsd: 0.5 })).toEqual({ usd: 1, basis: 'estimated' });
  });
});

describe('sumCosts', () => {
  it('未計測を 0 として足さず、件数で返す', () => {
    expect(sumCosts([{ usd: 0.1, basis: 'metered' }, UNMEASURED])).toEqual({ knownUsd: 0.1, unmeasured: 1, basis: 'metered' });
    expect(sumCosts([UNMEASURED])).toEqual({ knownUsd: 0, unmeasured: 1, basis: 'unmeasured' });
    expect(sumCosts([{ usd: 0.1, basis: 'metered' }, { usd: 0.2, basis: 'estimated' }]).basis).toBe('estimated');
  });

  it('roundUsd は 6 桁で丸める', () => {
    expect(roundUsd(0.1234567)).toBe(0.123457);
  });
});
