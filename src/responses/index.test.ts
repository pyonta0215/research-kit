import { describe, expect, it } from 'vitest';
import { parseResponse, postResponsesRequest, ResponsesApiError, sourceUrlsOf } from './index.js';

/** 合成のレスポンス。検索 → ページを開く → ページ内検索 → 引用付きの本文 */
const researched = {
  id: 'resp_example',
  status: 'completed',
  output: [
    {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        queries: ['example corp funding'],
        sources: [{ type: 'url', url: 'https://example.com/about' }, { type: 'url', url: 'https://news.example.org/a' }],
      },
    },
    { type: 'web_search_call', id: 'ws_2', action: { type: 'open_page', url: 'https://example.com/careers' } },
    { type: 'web_search_call', id: 'ws_3', action: { type: 'find_in_page', url: 'https://example.com/about', pattern: 'founded' } },
    { type: 'reasoning', id: 'rs_1', summary: [] },
    {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'Example Corp was founded in 2001. See https://model-wrote-this.example.net too.',
          annotations: [{ type: 'url_citation', url: 'https://example.com/about', title: 'About', start_index: 0, end_index: 32 }],
        },
        { type: 'output_text', text: 'Second block.', annotations: [{ type: 'url_citation', url: 'https://example.com/press' }] },
      ],
    },
  ],
  usage: {
    input_tokens: 12000,
    input_tokens_details: { cached_tokens: 3000 },
    output_tokens: 800,
    output_tokens_details: { reasoning_tokens: 500 },
    total_tokens: 12800,
  },
};

describe('parseResponse', () => {
  it('本文・使用量・検索の内訳を読む', () => {
    const parsed = parseResponse(researched);
    expect(parsed.text).toBe('Example Corp was founded in 2001. See https://model-wrote-this.example.net too.\nSecond block.');
    expect(parsed.usage).toEqual({ inputTokens: 12000, cachedInputTokens: 3000, outputTokens: 800, reasoningTokens: 500 });
    expect(parsed.webSearch).toEqual({ calls: 3, search: 1, openPage: 1, findInPage: 1, other: 0, queries: ['example corp funding'] });
    expect(parsed.status).toBe('completed');
  });

  it('出典を3種類に分けて持ち、和集合では種類を併記する', () => {
    const { sources } = parseResponse(researched);
    expect(sources.searchResults).toEqual(['https://example.com/about', 'https://news.example.org/a']);
    expect(sources.openedPages).toEqual(['https://example.com/careers', 'https://example.com/about']);
    expect(sources.citations).toEqual([
      { url: 'https://example.com/about', title: 'About', startIndex: 0, endIndex: 32 },
      { url: 'https://example.com/press', title: '', startIndex: undefined, endIndex: undefined },
    ]);
    expect(sources.urls).toEqual([
      { url: 'https://example.com/about', kinds: ['search-result', 'opened-page', 'citation'] },
      { url: 'https://news.example.org/a', kinds: ['search-result'] },
      { url: 'https://example.com/careers', kinds: ['opened-page'] },
      { url: 'https://example.com/press', kinds: ['citation'] },
    ]);
  });

  it('モデルが本文に書いただけの URL は出典にしない', () => {
    const urls = parseResponse(researched).sources.urls.map((entry) => entry.url);
    expect(urls).not.toContain('https://model-wrote-this.example.net');
  });

  it('種類で絞り込める（検索結果に出ただけの URL を除く）', () => {
    expect(sourceUrlsOf(parseResponse(researched).sources, ['citation', 'opened-page'])).toEqual([
      'https://example.com/about',
      'https://example.com/careers',
      'https://example.com/press',
    ]);
  });

  it('引用が1件も付かず、sources を include していない回は、出典が空になる（補わない）', () => {
    const parsed = parseResponse({
      output: [
        { type: 'web_search_call', action: { type: 'search', query: 'q' } },
        { type: 'message', content: [{ type: 'output_text', text: 'See https://example.com/x', annotations: [] }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(parsed.sources.urls).toEqual([]);
    expect(parsed.webSearch.queries).toEqual(['q']);
    expect(parsed.usage).toEqual({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: undefined });
  });

  it('使用量が無ければ undefined を返し、0 で埋めない', () => {
    expect(parseResponse({ output: [] }).usage).toBeUndefined();
    expect(parseResponse({ usage: { input_tokens: 5 } }).usage).toBeUndefined();
    expect(parseResponse({ usage: { input_tokens: -1, output_tokens: 1 } }).usage).toBeUndefined();
  });

  it('打ち切られた応答の理由を返す', () => {
    const parsed = parseResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    expect(parsed.status).toBe('incomplete');
    expect(parsed.incompleteReason).toBe('max_output_tokens');
  });

  it('形が崩れていても例外にしない。知らない action は other に数える', () => {
    expect(() => parseResponse(null)).not.toThrow();
    expect(() => parseResponse({ output: 'x' })).not.toThrow();
    const parsed = parseResponse({ output: [{ type: 'web_search_call' }, { type: 'web_search_call', action: { type: 'future' } }, 'junk'] });
    expect(parsed.webSearch).toMatchObject({ calls: 2, other: 2 });
  });

  it('output を持たない SDK 形式では output_text を使う', () => {
    expect(parseResponse({ output_text: 'from sdk' }).text).toBe('from sdk');
    expect(parseResponse({ output_text: 'ignored', output: [] }).text).toBe('');
  });
});

const SECRET = 'sk-test-DO-NOT-LEAK-1234567890';

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

describe('postResponsesRequest', () => {
  it('JSON を送り、レスポンス JSON を返す', async () => {
    const { impl, calls } = fakeFetch(() => new Response(JSON.stringify(researched), { status: 200 }));
    const body = await postResponsesRequest({
      url: 'https://api.example.test/v1/responses',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { model: 'm', input: 'hi' },
      timeoutMs: 1000,
      fetch: impl,
    });
    expect(parseResponse(body).text).toContain('founded');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"model":"m","input":"hi"}');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
  });

  it('署名済みの文字列とヘッダはそのまま送る（content-type を重ねない）', async () => {
    const { impl, calls } = fakeFetch(() => new Response('{}', { status: 200 }));
    await postResponsesRequest({
      url: 'https://x.test',
      headers: { 'Content-Type': 'application/json', authorization: 'AWS4-HMAC-SHA256 Signature=abc', 'x-amz-date': '20260916T000000Z' },
      body: '{"signed":true}',
      timeoutMs: 1000,
      fetch: impl,
    });
    expect(calls[0]?.init.body).toBe('{"signed":true}');
    const sent = new Headers(calls[0]?.init.headers);
    expect(sent.get('content-type')).toBe('application/json');
    expect(sent.get('authorization')).toBe('AWS4-HMAC-SHA256 Signature=abc');
    expect(sent.get('x-amz-date')).toBe('20260916T000000Z');
  });

  it('HTTP エラーは状態コード・コード・リクエスト ID だけを持ち、本文やキーを含めない', async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${SECRET}. private input text` } }),
          { status: 401, headers: { 'x-request-id': 'req_123' } },
        ),
    );
    const error = await postResponsesRequest({
      url: 'https://x.test',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { input: 'private input text' },
      timeoutMs: 1000,
      fetch: impl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponsesApiError);
    const apiError = error as ResponsesApiError;
    expect(apiError).toMatchObject({ kind: 'http', status: 401, code: 'invalid_api_key', requestId: 'req_123' });
    expect(apiError.message).toBe('OpenAI Responses API error: 401 invalid_api_key (request req_123)');
    const serialized = `${apiError.message} ${apiError.stack} ${JSON.stringify(apiError)}`;
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('private input text');
  });

  it('JSON でないエラー本文でも状態コードだけで失敗させる', async () => {
    const { impl } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(postResponsesRequest({ url: 'https://x.test', headers: {}, body: {}, timeoutMs: 1000, fetch: impl, label: 'Bedrock' }))
      .rejects.toThrow(/^Bedrock Responses API error: 502$/);
  });

  it('成功なのに JSON でなければ invalid-json', async () => {
    const { impl } = fakeFetch(() => new Response('not json', { status: 200 }));
    await expect(postResponsesRequest({ url: 'https://x.test', headers: {}, body: {}, timeoutMs: 1000, fetch: impl }))
      .rejects.toMatchObject({ kind: 'invalid-json', status: 200 });
  });

  it('時間内に返らなければ timeout で失敗させる', async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const error = await postResponsesRequest({ url: 'https://x.test', headers: {}, body: {}, timeoutMs: 20, fetch: hanging }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ResponsesApiError', kind: 'timeout' });
    expect((error as Error).message).toBe('OpenAI Responses API timed out after 20ms');
  });

  it('送信できなかったときは network。元のエラーメッセージを持ち込まない', async () => {
    const failing = (async () => {
      throw new TypeError(`fetch failed for https://x.test?key=${SECRET}`);
    }) as typeof fetch;
    const error = await postResponsesRequest({ url: 'https://x.test', headers: {}, body: {}, timeoutMs: 1000, fetch: failing }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'network' });
    expect((error as Error).message).not.toContain(SECRET);
  });
});
