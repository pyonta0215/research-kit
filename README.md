# research-kit

LLM で調べものをする機能で繰り返し書いていた処理をまとめた、小さなヘルパー集です。依存パッケージはありません（Node 20 以上と Cloudflare Workers の `fetch` / `AbortSignal` だけを使います）。

| サブパス | 中身 |
|---|---|
| `@pyonta0215/research-kit/responses` | Responses API の結果から本文・使用量・出典（引用 / 検索結果 / 開いたページ）を取り出す。タイムアウト付きの送信と、キーや本文を含まないエラー |
| `@pyonta0215/research-kit/json` | コードフェンスや前置きに包まれた出力から JSON を取り出す |
| `@pyonta0215/research-kit/cost` | 使用量 × 単価の費用計算。単価が分からないモデルを 0 円にしない。実測 / 推定 / 未計測の区別 |
| `@pyonta0215/research-kit/budget` | 1回の実行の中の予約・精算の台帳 |

npm には公開していません。git タグで参照します。

```bash
npm install github:pyonta0215/research-kit#v0.1.0
```

## ここに入れないもの

- プロンプト、ツールの設定（`tools` / `include` / `text.format`）、業務スキーマ、出典の採否、URL の正規化ルール
- 単価表そのもの（転記日と出典を利用側で管理する）
- 月額などの、実行をまたいだ予算の管理（後述）
- 汎用の LLM SDK。送信は `fetch` 1回分だけで、再試行やストリーミングは持たない。公式 SDK で足りる場面では SDK を使い、そのレスポンスを `parseResponse` に渡せる

## responses

```ts
import { OPENAI_RESPONSES_URL, parseResponse, postResponsesRequest, sourceUrlsOf } from '@pyonta0215/research-kit/responses';

const raw = await postResponsesRequest({
  url: OPENAI_RESPONSES_URL,
  headers: { authorization: `Bearer ${apiKey}` },
  body: {
    model,
    input,
    tools: [{ type: 'web_search' }],
    include: ['web_search_call.action.sources'], // 検索結果の URL が欲しいとき
  },
  timeoutMs: 180_000,
});

const { text, usage, sources, webSearch } = parseResponse(raw);
```

### 出典の3種類

| 種類 | 取り出し元 | 注意 |
|---|---|---|
| `citation` | 本文の `url_citation` 注釈 | 同じ呼び出しでも付く回と付かない回がある |
| `search-result` | `web_search_call.action.sources` | `include` に指定したときだけ返る |
| `opened-page` | `open_page` / `find_in_page` の `action.url` | |

- `sources.urls` は3種類の和集合で、URL ごとにどの経路で現れたかを持ちます
- **モデルが本文に書いただけの URL は含めません**
- 出典集合に URL があることは、そのページが主張を裏付けることを意味しません。主張との対応（どの事実をどの出典が支えるか）は利用側で扱います
- 出典が無い呼び出しは空のまま返します

### 使用量と失敗

- 使用量が返らなければ `usage: undefined`（0 で埋めません）。キャッシュ済み入力は `input_tokens_details.cached_tokens` から読みます
- `webSearch` は `web_search_call` を検索 / ページを開く / ページ内検索に分けて数えます。どれを課金単位として数えるかは `cost` の `webSearchCostUsd` で利用側が選びます
- `ResponsesApiError` は `kind`（`http` / `timeout` / `network` / `invalid-json`）、状態コード、エラーコード、リクエスト ID だけを持ちます。API キー、送った本文、レスポンス本文、API のエラーメッセージ（伏せ字のキーや入力の一部が入ることがある）は含めません

## json

```ts
import { parseJsonFromText } from '@pyonta0215/research-kit/json';

const parsed = parseJsonFromText(text);
if (parsed.ok) schema.safeParse(parsed.value);
```

`detail`（JSON.parse のメッセージ）はモデル出力の断片を含むことがあります。修復を促すプロンプトには使えますが、ログには出さないでください。

## cost

```ts
import { requirePrice, tokenCostUsd, webSearchCostUsd } from '@pyonta0215/research-kit/cost';

const price = requirePrice(MODEL_PRICES, model); // 表に無ければ UnknownPriceError
const usd =
  tokenCostUsd(price, { inputTokens, cachedInputTokens, outputTokens }) +
  webSearchCostUsd(webSearch, { perCallUsd: 0.01, count: 'all-calls' });
```

**ここで出る金額は請求額ではありません。** API が返した使用量に、利用側が転記した単価を掛けた見積もりです。表示するときは「推定」と書いてください。

| basis | 意味 |
|---|---|
| `metered` | API が返した使用量 × 公開単価（推測は入らないが、請求額ではない） |
| `estimated` | 設定した単価 × 観測した時間など、仮定を含む |
| `unmeasured` | 求められなかった。0 円として足さない |

- キャッシュ単価を設定していないモデルでは、キャッシュ済み入力も通常の入力単価で数えます（少なく見積もらない側）
- `cacheWritePerMillionUsd`（任意）を設定すると、キャッシュされなかった入力はすべてキャッシュに書き込まれたとみなしてその単価で数えます。Responses API の使用量には書き込んだトークン数が返らないため、実際より多めの上限値です
- `longContext`（任意、`{ aboveInputTokens, inputMultiplier, outputMultiplier }`）を設定すると、入力トークン数が `aboveInputTokens` を**超える**リクエストは全体に倍率がかかります（入力・キャッシュ済み入力・書き込みに `inputMultiplier`、出力に `outputMultiplier`）。判定は1リクエスト単位なので、`tokenCostUsd` は呼び出しごとに使ってください。複数回分を合算した使用量で計算すると多めに出ます
- どちらも設定しなければ、金額は以前の版と同じです

```ts
// 例: OpenAI GPT-6 Sol（2026-09-29 に公式のモデル別ページで確認した値）
const GPT_6_SOL = {
  inputPerMillionUsd: 2,
  cachedInputPerMillionUsd: 0.2,
  cacheWritePerMillionUsd: 2.5, // 入力の 1.25 倍
  outputPerMillionUsd: 10,
  longContext: { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
};
```
- 検索の件数と課金単位は同じとは限りません。`count: 'search-actions'`（検索だけ）と `'all-calls'`（ページを開く操作も数える、多めの見積もり）を利用側が選びます。検索結果として読んだ内容のトークンは入力トークンとして別に数えられます
- `billedDurationCost` は実行基盤やブラウザのように時間で課金されるものを、設定した単価で `estimated` として見積もります
- `sumCosts` は未計測を 0 として足さず、分かった分の合計と未計測の件数を分けて返します

## budget

```ts
import { BudgetExceededError, CostLedger } from '@pyonta0215/research-kit/budget';

const ledger = new CostLedger(['llm', 'browser'], { limitUsd: 0.5 });

const reservation = ledger.reserve(estimateUsd); // 上限を超えるなら BudgetExceededError
try {
  const result = await callModel();
  ledger.settle(reservation, 'llm', { usd: costOf(result), basis: 'metered' });
} catch (error) {
  // 費用が分からない。予約額を上限の判定に残したまま、未計測として数える
  ledger.settle(reservation, 'llm', { usd: null, basis: 'unmeasured' });
  throw error;
}
```

| 操作 | 使いどころ |
|---|---|
| `reserve` → `settle` | 払う前に見積もりを押さえ、終わったら実際の費用で精算する |
| `settle(..., unmeasured)` | 失敗して費用が分からない。予約額を戻さない |
| `release` | 予約した処理を始めなかった（費用が発生していないと分かっている）とき |
| `record` | 予約なしで、終わってから費用を記録する。未計測は件数だけ数え、上限の判定には入らない |

### この台帳が保証しないこと

- **メモリ上の台帳です。** 1回の実行の中の上限にしか効きません。月額などの上限は、利用側が永続化した支出の合計と、同時に走る実行どうしの排他（条件付き書き込みなど）で守ってください。台帳を「製品全体の月額上限」と呼ばないでください
- **見積もりが実際より小さければ上限を超えます。** 厳密な上限には、呼び出しごとの費用の上限が事前に決まること（出力トークンとツール呼び出し回数の上限、入力の大きさが分かること）が要ります。Web 検索のように読んだページの量で入力が増える呼び出しでは成り立たないので、上限は「超えにくくする歯止め」として扱ってください
- 金額は `cost` と同じく請求額ではありません

## ここに入れるものの条件

1. 2つ以上のプロダクトで、同じ責務の処理が実際に書かれている
2. 特定のドメイン・アカウント・プロダクト名・個人の調査方針を含まない
3. 合成データだけでテストできる

## 開発

```bash
npm ci
npm run check   # typecheck → test → build → dist に差分が無いことを確認
```

`dist/` はコミットします。git タグで参照したとき、利用側でビルドを走らせずに使えるようにするためです。

## License

MIT
