import { describe, expect, it } from 'vitest';
import { extractJsonCandidate, parseJsonFromText } from './index.js';

describe('extractJsonCandidate', () => {
  it('コードフェンスの中身を取り出す', () => {
    expect(extractJsonCandidate('結果です\n```json\n{"a":1}\n```\n以上 {x}')).toBe('{"a":1}');
  });

  it('前後の文を除いて、最初の { から最後の } までを取り出す', () => {
    expect(extractJsonCandidate('はい。{"a":{"b":2}} でした')).toBe('{"a":{"b":2}}');
  });

  it('配列も取り出す', () => {
    expect(extractJsonCandidate('候補: [1, 2, 3]')).toBe('[1, 2, 3]');
  });

  it('括弧が無ければ全体を返す', () => {
    expect(extractJsonCandidate('  見つかりませんでした  ')).toBe('見つかりませんでした');
  });
});

describe('parseJsonFromText', () => {
  it('読めれば値を返す', () => {
    expect(parseJsonFromText('```\n{"ok":true}\n```')).toEqual({ ok: true, value: { ok: true } });
  });

  it('読めなければ例外にせず ok: false', () => {
    const result = parseJsonFromText('{"a": 1,');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.detail).not.toBe('');
  });
});
