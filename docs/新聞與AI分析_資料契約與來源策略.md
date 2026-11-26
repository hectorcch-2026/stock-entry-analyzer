# 新聞與 AI 分析 暨 版塊輪動 × 宏觀關聯 — 資料契約與來源策略

> 版本：v1.0（2026-11-26）
> 對應任務：#37 設計 → #38 新聞聚合 → #39 個股 AI 分析 → #40 宏觀輪動關聯
> 本文件是全鏈路的**唯一契約來源**。程式、測試、前端文案都必須與此一致；
> 若實作需要偏離，先改本文件再改程式。

---

## 0. 一句話結論（先講最重要的三個實測限制）

在動工前先用真實資料驗證了三件事，它們直接決定設計形狀：

| # | 實測事實 | 對設計的強制影響 |
|---|---|---|
| 1 | `Bloomberg` 在 Yahoo 一般新聞聚合中只佔 **約 1/100** 標題 | 不能宣稱「全部來源皆權威」。必須做**來源分級**，並讓使用者看見哪一則屬於哪一級 |
| 2 | 但改用 Google News RSS 的 `site:bloomberg.com` 定向查詢，單一標的可取回 **100 則彭博報導**；`(site:bloomberg.com OR site:reuters.com OR site:wsj.com)` 一次回 **79 則**（Reuters 31 / Bloomberg 27 / WSJ 12 / Bloomberg 9），耗時 **398ms** | 「整合權威財經媒體」是**可達成**的，前提是走定向查詢而非被動聚合 |
| 3 | LLM 在要求「先說明思路再輸出 JSON」時回 `我的分析思路是：…\n{"score":0.5}`，`JSON.parse` 擲 `Unexpected token '我'`；且要求繁體卻回簡體（「苹果财报超预期」） | 契約必須**同時**包含：容錯 JSON 解析器 + 繁體強制後置檢查。只寫 schema 不足以防禦 |

---

## 1. 資料來源登記表（含更新頻率）

每個區塊在畫面上都必須標示「來源」與「資料時間」。以下為唯一允許的來源清單。

### 1.1 新聞來源

| 代號 | 名稱 | 端點 | 認證 | 更新頻率 | 快取 TTL | 特性與限制 |
|---|---|---|---|---|---|---|
| `gnews` | Google News RSS | `news.google.com/rss/search?q=…` | 免 Key | 上游約 15–30 分鐘 | **10 分鐘** | 支援 `site:`、`when:7d`、`OR`。**連結為 Google 轉址**，非原始網址 |
| `yahoo-rss` | Yahoo Finance RSS | `feeds.finance.yahoo.com/rss/2.0/headline?s=` | 免 Key | 上游約 15 分鐘 | **10 分鐘** | 附 `description` 摘要（可直接餵 AI，價值高）。品質偏財經入口網站 |
| `yahoo-api` | Yahoo Finance Search | `query1…/v1/finance/search` | 需 cookie+crumb（可退回無 crumb） | 約 15 分鐘 | **15 分鐘**（沿用既有） | 附 `thumbnail` 與 `relatedTickers`（可做相關性過濾）。**雲端 IP 易被 429** |

**三者互補而非替代**：
`gnews` 給權威深度，`yahoo-rss` 給摘要文本，`yahoo-api` 給縮圖與 ticker 標記。
任一失敗不影響其他（見 §5 降級策略）。

### 1.2 行情來源

| 代號 | 用途 | 端點 | 更新頻率 | 快取 TTL |
|---|---|---|---|---|
| `yahoo-chart` | 個股日線（含復權） | `/v8/finance/chart/…` | 盤中延遲約 0–15 分鐘 | 60 秒 |
| `yahoo-chart` | 版塊 ETF 日線 | 同上 | 同上 | 60 秒 |

行情一律取 **`adjclose`（復權）**。理由見 `lib/rrg.js` 開頭實測：XLU 十年價格報酬 81.4% vs 復權 148.7%，未復權會系統性低估高股息版塊。

### 1.3 宏觀來源

| 代號 | 名稱 | 端點 | 認證 | 更新頻率 | 快取 TTL |
|---|---|---|---|---|---|
| `fred` | FRED（聖路易斯聯準銀行） | `fredgraph.csv?id=` | 免 Key | 日頻序列每日 16:15 ET 後更新；月頻每月中旬 | 日頻 6 小時 / 月頻 24 小時 |

使用序列（18 條，見 `lib/fred.js` `SERIES`）。本模組**只取其中 8 條**作為輪動解釋的輸入，理由見 §3.2。

### 1.4 AI 來源

| 代號 | 名稱 | 端點 | 更新頻率 |
|---|---|---|---|
| `llm` | DeepSeek-V4.1-flash（可換） | `{baseUrl}/chat/completions` | 每次請求即時運算，不快取（分析結果另做 30 分鐘內容快取） |

**實測延遲**：單則情緒分類 1.2 秒；5 欄位結構化輸出 1.8 秒；批次 5 則新聞 2.1 秒。
**實測 token**：`reasoning_tokens: 0`（已設 `enable_thinking:false`）。
→ 因此 30 秒逾時足夠，不必用 60 秒拖住使用者。

---

## 2. 個股「新聞與 AI 分析」區塊

### 2.1 輸入（AI 收到什麼）

**嚴格原則：模型不得自行取數。** 所有數字由後端算好後餵入，模型只做歸納與措辭。

```
輸入 = {
  標的      : { symbol, name, market, currency, price, changePercent }
  價格脈絡  : { atrPct, rsi, range20Position, change5d, change20d, change60d }
  技術立場  : { verdictLabel, score, buyZone:{lower,upper}, probUp20 }
  版塊歸屬  : { sectorKey, sectorLabel, quadrant, quadrantLabel }   // 可為 null（港股常無）
  新聞清單  : [ { i, title, publisher, tier, ageHours, summary? } ]  // 最多 8 則
  時間範圍  : { newsFrom, newsTo, priceAsOf }
}
```

**為什麼要餵價格脈絡**：使用者的需求是「結合該個股股價數據做綜合研判」。
若不給模型價格狀態，它只能對新聞做孤立解讀，無法回答「這則消息對目前價位是雪上加霜還是已反映」。

**為什麼新聞上限 8 則**：實測 5 則批次 2.1 秒、輸出仍精簡；8 則是
「足夠覆蓋多空」與「不讓模型失焦」的平衡點。超過 8 則時按
`tier 優先 → 時間近者優先` 截斷，並在輸出標明 `newsConsidered / newsAvailable`。

### 2.2 輸出（AI 回傳什麼）— 固定 schema

```jsonc
{
  "summary": "繁體中文 120–200 字，說明這批新聞共同指向什麼",
  "sentiment": "positive | negative | neutral | mixed",
  "score": -1.0,                    // 連續值，-1 極空 → +1 極多；與 sentiment 必須一致
  "confidence": "high | medium | low",
  "keyEvents": [                    // 1–4 條，去重後的最重要事件
    { "event": "…", "impact": "positive|negative|neutral", "horizon": "short|medium|long" }
  ],
  "drivers": [                      // 權重和必須為 1.0（若無法給出則整欄省略）
    { "factor": "…", "weight": 0.45, "direction": "positive|negative" }
  ],
  "priceImpact": {
    "direction": "up | down | neutral",
    "magnitude": "large | moderate | small",
    "reasoning": "繁體中文，必須引用提供的價格脈絡數字",
    "alreadyPricedIn": "yes | partially | no | unknown"
  },
  "sectorContext": "繁體中文一句話；若無版塊資料則為 null",
  "caveats": ["資料不足之處必須明說，不可粉飾"]
}
```

**欄位語義硬規則**

1. `score` 與 `sentiment` 必須一致：
   `positive ⇔ score > 0.15`、`negative ⇔ score < -0.15`、`neutral ⇔ |score| ≤ 0.15`、
   `mixed` 允許 |score| ≤ 0.3 且 drivers 方向相反。不一致時以後端校正 `sentiment`，
   並記 `adjusted: ['sentiment']`，不靜默採用。
2. `drivers[].weight` 和不在 `[0.98, 1.02]` 內時，**整欄丟棄**（不可縮放偽裝成合法）。
3. `keyEvents` 超過 4 條只取前 4；`event` 為空字串的條目丟棄。
4. `priceImpact.reasoning` 若不含任何來自白名單的數字 → 降級為 `null` 並記 `adjusted`。
   （因為「對股價的潛在影響」若不錨定在實際價位與波動上，就是空話。）
5. **禁止**輸出目標價、買賣建議、時間點預測。違反時整段 `priceImpact` 丟棄。

### 2.3 規則層（無 LLM 金鑰時的退化輸出）

必須與 LLM 版**同一個 schema**，讓前端只有一條渲染路徑。

| 欄位 | 規則層怎麼算 |
|---|---|
| `sentiment` / `score` | 標題關鍵詞計分（正面詞表 vs 負面詞表），以 `tier` 加權：tier1 權重 1.0、tier2 0.7、tier3 0.4。分數正規化到 [-1,1] |
| `summary` | 模板句：「共 N 則新聞，其中 M 則偏向正面…」＋列出 tier1 標題 |
| `keyEvents` | 取 tier1 標題前 4 條，`impact` 由該標題的詞表判定 |
| `drivers` | 固定三因子：`新聞情緒`／`技術面位置`／`版塊相對強弱`，權重由可得性分配 |
| `priceImpact` | 方向 = 情緒方向；幅度由 `atrPct` 分級（>3% 大、1.5–3% 中、<1.5% 小）；`reasoning` 說明用的是哪個數字 |
| `confidence` | 依 `tier1 則數` 與 `新聞總數` 給 high/medium/low |

**為什麼規則層必須完整**：本專案的既有立場是「無金鑰也要能用」。
若規則層只回一句「請設定 API Key」，整塊就變成空殼，而使用者的需求是
看到分析結果，不是看到安裝說明。

### 2.4 時間範圍與來源標註（每筆結果都必帶）

```jsonc
"provenance": {
  "newsWindow": { "from": "2026-11-19T00:00:00Z", "to": "2026-11-26T08:17:00Z", "days": 7 },
  "priceAsOf":  "2026-11-26T08:17:14Z",
  "macroAsOf":  "2026-11-25",          // 僅輪動區塊
  "sources": [
    { "id": "gnews",      "name": "Google News RSS", "count": 79, "tier1": 48 },
    { "id": "yahoo-rss",  "name": "Yahoo Finance RSS", "count": 16, "tier1": 0 }
  ],
  "publishers": [ { "name": "Bloomberg", "tier": 1, "count": 27 }, … ],
  "aiMode": "llm | rule",
  "aiModel": "DeepSeek-V4.1-flash",     // rule 模式為 null
  "generatedAt": "2026-11-26T08:20:00Z",
  "degraded": [ "yahoo-api 429，已略過" ]
}
```

前端必須渲染 `newsWindow`（「新聞區間：近 7 天」）、`aiMode`（「AI 分析」或「規則分析」）、
以及至少 tier1 出版者名稱。**不得只寫「來源：網路」這種無資訊量的標註。**

### 2.5 端點

```
GET /api/stock-news-ai?symbol=AAPL&days=7&limit=8&refresh=1
```

| 參數 | 預設 | 範圍 | 說明 |
|---|---|---|---|
| `symbol` | 必填 | — | 代碼或名稱 |
| `days` | 7 | 1–30 | 新聞時間窗 |
| `limit` | 8 | 3–15 | 餵給 AI 的則數 |
| `mode` | `auto` | `auto`/`rule` | `rule` 強制不使用 LLM（供測試與成本控制） |
| `refresh` | 0 | 0/1 | 略過內容快取 |

---

## 3. 版塊輪動 × 宏觀經濟 AI 分析

### 3.1 輸入

```
輸入 = {
  輪動快照 : [ { key, label, ratio, momentum, quadrant, quadrantLabel,
                 trailStart:{ratio,momentum}, displacement, angleDeg,
                 efficiency, signal, signalCn, nextQuadrant } ]   // 11 版塊
  輪動參數 : { timeframe, timeframeLabel, window, benchmark, period, asOf }
  宏觀快照 : [ { key, label, value, unit, asOf, percentile, change, direction } ]  // 8 條
  版塊報酬 : [ { key, d1, w1, m1, m3 } ]     // 來自 treemap/returns，可為 null
  時間範圍 : { rotationAsOf, macroFrom, macroTo }
}
```

### 3.2 宏觀輸入只取 8 條（不是全部 18 條）

| key | 為什麼納入 | 對哪些版塊有解釋力 |
|---|---|---|
| `fedTargetUpper` | 折現率基準，主導成長股估值 | XLK、XLY、XLRE、XLU |
| `dgs10` | 長端利率，房貸與企業融資成本 | XLRE、XLF、XLU |
| `termSpread` | 10Y-2Y，景氣循環與銀行淨利差 | XLF、XLI、XLB |
| `realYield10` | 實質利率，黃金／高股息資產機會成本 | XLU、XLB、XLRE |
| `cpiYoy` | 通膨總量，成本轉嫁能力 | XLE、XLP、XLB |
| `coreCpiYoy` | 核心通膨，Fed 政策路徑 | 全市場 |
| `unrate` | 勞動市場，消費韌性 | XLY、XLP、XLI |
| `indpro` | 實體產出，循環性需求 | XLI、XLB、XLE |

**排除的 10 條與理由**（必須寫在文件裡，否則日後沒人知道為什麼）：
`fedTargetLower`（與 upper 只差 25bp，資訊重複）、`dgs2`／`dgs30`（已被
`dgs10` + `termSpread` 涵蓋）、`payems`（與 `unrate` 高度共線）、
`umcsent`（問卷性質，與實際支出落差大）、`dollarBroad`／`eurusd`
（匯率對 11 個美股版塊的解釋力弱，主要影響跨國營收比例，本模組無法取得該比例）、
`deficit12m`（月度波動大且與版塊輪動的時間尺度不符）、`gdpReal`（季頻、會多次修正）、
`manemp`（長期趨勢向下，屬結構性而非輪動性）。

> 這份篩選本身就是方法論的一部分：把 18 條全丟給模型只會讓它挑最順口的講，
> 而不是講最有解釋力的。

### 3.3 輸出 schema

```jsonc
{
  "ranking": [                       // 版塊強弱排名，**由後端計算，非模型生成**
    { "rank": 1, "key": "XLK", "label": "資訊科技",
      "ratio": 93.08, "momentum": 95.93, "quadrant": "lagging",
      "aboveBenchmark": false,       // ratio > 100 ⇔ 跑贏基準（象限的判準）
      "strengthScore": 41.2,         // 0–100，同期版塊間的相對位置
      "flow": "outflow | inflow | neutral",
      "flowBasis": "momentum<100 且 ratio 續降，判定為資金流出",
      "rankNote": null }             // 排名與象限明顯不同調時的說明，否則 null
  ],
  "rotationNarrative": "繁體中文 150–250 字：目前輪動處於哪個相位、誰在接力",
  "macroLinks": [                    // 宏觀指標 ↔ 版塊 的關聯說明
    { "indicator": "dgs10", "label": "10 年期公債殖利率",
      "value": 4.91, "unit": "%", "asOf": "2026-11-24",
      "percentile": 45.3, "direction": "down",
      "thesis": "長端利率自高點回落，理論上有利長天期成長股評價…",
      "supports": ["XLK","XLRE"], "pressures": ["XLF"],
      "confidence": "high | medium | low",
      "basis": "rule | llm" }
  ],
  "consistency": {                   // 輪動 vs 宏觀 是否互相印證
    "verdict": "consistent | divergent | unclear",
    "note": "繁體中文：若背離，指出背離在哪"
  },
  "watchpoints": ["繁體中文 1–3 條：接下來該看什麼才會證實/推翻上述判讀"],
  "caveats": ["…"],
  "provenance": { … 同 §2.4，另加 rotationAsOf / macroWindow … }
}
```

### 3.4 呈現方式（使用者要求的「板塊強弱排名、資金流向、宏觀指標關聯說明」）

三段式，順序固定：

1. **排名條（Ranking bars）** — 11 條水平條，長度 = `strengthScore`，
   顏色依 `quadrant`（領先／弱化／落後／改善四色），
   條上標 `rank` 與 `flow` 箭頭。**這是純後端計算，不經 LLM**，
   因此每次重整都完全可重現（LLM 版敘述可能每次不同，數字不會）。
2. **宏觀關聯卡（Macro links）** — 每張卡：指標名 + 當前值 + 歷史百分位 +
   方向箭頭 + `thesis` 一段 + 受影響版塊 chips（綠=支撐、紅=壓力）。
   紅漲綠跌慣例在此**不適用**：這裡的紅綠表示「壓力／支撐」，必須在
   卡片上加文字標籤，不可只靠顏色。
3. **一致性裁決（Consistency verdict）** — 一句話：輪動與宏觀是互相印證
   還是背離。這是整個區塊最有價值的部分，因為背離通常才是訊號。

### 3.4.1 必須處理的語義衝突：排名 ≠ 象限

**這不是 bug，是兩個不同基準的必然結果，但若不說明會被當成 bug。**

- **象限**看的是 `ratio`／`momentum` 與 **100（基準 = SPY）** 的關係：
  `ratio > 100` 就是「跑贏大盤」。
- **排名**看的是 `strengthScore`，而它是**同期 11 個版塊之間的百分位**：
  第 1 名一定 100 分、最後 1 名一定 0 分，**與絕對水位無關**。

實測（2026-11-26）11 個版塊中有 **9 個** `ratio > 100`——整個版塊群同時跑贏 SPY。
在這種盤面下必然出現「第 9 名（24 分）卻是『領先』象限」：

```
# 9 通訊服務  24 分  ratio 100.05  momentum 101.60  領先
```

三個處理（缺一不可）：

1. `ranking[].aboveBenchmark` — 明確區分「贏過大盤」與「贏過同儕」。
2. `ranking[].rankNote` — 只在**明顯不同調**時給一句人話說明：
   - 貼線（`ratio` 距 100 在 ±0.5 內）：講「幾乎貼在基準線上、絕對水位毫無優勢」
   - 偏多象限但排名落在後 40%：講「贏過大盤、輸給其他版塊」
   - 偏空象限但排名在前 40%：講「輸給大盤、贏過其他版塊」
   門檻取 40%/60% 而非 50%：11 個版塊的第 6 名就是中位數，
   「領先但排第 6」不構成矛盾，硬要解釋只是噪音。
3. 餵進 prompt 並在規則裡要求模型**照 `rankNote` 說明、不得另編理由**，
   否則模型會自行發明一套（實測會寫成「排名靠後反映相對弱勢」，
   把「輸給同儕」誤述成「弱於大盤」）。

### 3.5 端點

```
GET /api/sector-macro-ai?timeframe=weekly&window=1y&benchmark=SPY&trail=5&mode=auto
```

---

## 4. 來源權威性分級（tier）

分級必須是**可解釋的規則**，不是憑感覺。以下為完整對照表。

### Tier 1 — 通訊社與一線財經媒體（原始採訪、有編輯台）

`Bloomberg` / `Bloomberg.com` / `Breakingviews`（彭博評論）、
`Reuters` / `Reuters.com`、`The Wall Street Journal` / `WSJ`、
`Financial Times` / `FT`、`Barron's` / `Barrons`、
`Associated Press` / `AP`、`Agence France-Presse` / `AFP`、
`CNBC`、`Nikkei` / `Nikkei Asia`

### Tier 2 — 專業財經媒體與研究機構（有方法論揭露，非原始採訪）

`Yahoo Finance`、`MarketWatch`、`Investing.com`、`MT Newswires`、
`Zacks Investment Research`、`The Motley Fool`、`Seeking Alpha`、
`Investor's Business Daily` / `IBD`、`Trefis`、`Simply Wall St`、
`Benzinga`、`TipRanks`、`GuruFocus`、`Morningstar`、`S&P Global`、
`MarketBeat`、`Barchart.com`、`Business Wire` / `GlobeNewswire` / `PR Newswire`（公告轉載）

### Tier 3 — 社群、聚合器、非財經媒體轉載

`Stocktwits`、`24/7 Wall St.`、`BeInCrypto`、`Blockchain News`、
`Traders Union`、`StockInvest.us`、`JournalArta`、`MLQ.ai`、
`MacRumors`、`9to5Mac`、`TechCrunch`、`Quartz`、`TechRepublic`、
`AskTraders.com`、`Foreign Policy Journal`、`Root-Nation.com`、
以及**任何未列入上表者**（預設 tier 3，寧可低估）

**分級不改變事實，只改變呈現權重。** 畫面必須同時顯示 tier，
讓使用者自己判斷，而不是把 tier 3 藏起來假裝沒有。

### 去重規則

同一事件常被 5 家轉載。去重鍵 = `正規化標題的前 8 個詞`（去標點、去大小寫）。
重複時**保留 tier 最高者**；tier 相同則保留時間最新者。
被合併的來源記在 `alsoReportedBy: ["…"]`，因為「多家同時報導」本身就是重要性訊號。

---

## 5. 降級策略（每個失敗點都必須有定義）

| 失敗 | 行為 | 使用者看到 |
|---|---|---|
| `gnews` 失敗 | 用 `yahoo-rss` + `yahoo-api` 繼續 | 來源卡顯示 `gnews` 不可用；`degraded` 列出原因 |
| `yahoo-api` 429 | 直接用 `gnews`（不需 crumb） | `degraded: "yahoo-api 429，已略過"` |
| 三個新聞源全失敗 | 回 `200` 但 `news: []`、`ai: null` | 「目前取不到新聞」＋重試按鈕。**不可回 500** |
| 新聞 0 則但行情正常 | 只回規則層的技術面判讀 | 「無相關新聞，以下為技術面判讀」 |
| LLM 無金鑰 | 規則層 | badge = 「規則分析」 |
| LLM 逾時／HTTP 錯 | 規則層 | badge = 「規則分析」＋ `note` 說明原因 |
| LLM JSON 解析失敗 | 規則層 | 同上，`note` 明確寫「輸出無法解析」 |
| LLM 回簡體 | 高頻詞替換；仍殘留則標記 | 「AI 回應含簡體字」小字提示 |
| LLM 數字不在白名單 | 該欄位置 `null` 並記 `adjusted` | 不顯示該欄，不顯示可疑數字 |
| FRED 部分序列失敗 | 用其餘序列產生關聯 | 「N/8 項宏觀指標可用」 |
| RRG 失敗 | 輪動區塊整塊顯示不可用 | 「版塊輪動資料暫時無法取得」 |

**統一原則：任何單點失敗都不得讓整個頁面或整個區塊變成空白。**
這與本專案先前 Treemap「靜默失敗、卡片永遠停在載入中」的教訓直接相關。

---

## 6. 內容快取

| 資料 | TTL | 理由 |
|---|---|---|
| 新聞聚合結果 | 10 分鐘 | 上游約 15–30 分鐘更新，抓更勤只是浪費請求 |
| AI 分析結果 | 30 分鐘 | 同一標的同一批新聞重複分析是純浪費；且結果需穩定才看得出前後差異 |
| 輪動快照 | 30 分鐘（沿用 `rrg-service`） | 週線結論收盤前不變 |
| 宏觀序列 | 6 / 24 小時（沿用 `fred`） | 日頻／月頻更新頻率 |
| AI 輪動分析結果 | 30 分鐘 | 同上 |

快取鍵：`symbol|days|limit|mode` 與 `timeframe|window|benchmark|trail|mode`。
**LLM 結果快取必須包含 `mode`**，否則測試用 `mode=rule` 會污染真實結果。

---

## 7. 前端契約

### 7.1 DOM id（測試會鎖這些 id）

個股頁（`#result` 內，「進階技術分析」之後、「通知」之前）：

| id | 用途 |
|---|---|
| `newsAiCard` | 外層 `<section>` |
| `newsAiBadge` | 「AI 分析」/「規則分析」/「不可用」 |
| `newsAiSummary` | 摘要段落 |
| `newsAiGauge` | 情緒分數視覺（SVG 弧） |
| `newsAiScore` | 分數數字 |
| `newsAiSentiment` | 情緒文字 |
| `newsAiEvents` | 關鍵事件清單 |
| `newsAiImpact` | 對股價潛在影響 |
| `newsAiImpactDir` | 方向標籤 |
| `newsAiDrivers` | 驅動因子權重條 |
| `newsAiList` | 新聞清單 |
| `newsAiProv` | 來源與時間範圍標註 |
| `newsAiNote` | 降級／限制說明 |

輪動頁（`#viewRrg` 內，Treemap 之後、明細表之前）：

| id | 用途 |
|---|---|
| `macroAiCard` | 外層區塊 |
| `macroAiBadge` | 模式 badge |
| `macroAiRank` | 強弱排名條容器 |
| `macroAiNarrative` | 輪動敘述 |
| `macroAiLinks` | 宏觀關聯卡容器 |
| `macroAiConsistency` | 一致性裁決 |
| `macroAiWatch` | 觀察重點 |
| `macroAiProv` | 來源與時間標註 |

### 7.2 前端限制

- **ES5 語法**（`var` / `function`，禁 `const` `let` 箭頭函式 模板字串）— 與 `app.js` 一致
- **零外部依賴**（無框架、無 CDN）
- 顏色：漲紅 `#d92b2b` / 跌綠 `#0f9d58`
- 所有使用者可見文字用 `esc()` 轉義（`notify-escape.cjs` 會驗）
- `[hidden]` 屬性切換依賴 `:where([hidden]){display:none!important}`，不得移除

---

## 8. 驗收清單

- [x] `GET /api/stock-news-ai?symbol=AAPL` 回 200，含 `summary/sentiment/score/keyEvents/priceImpact/provenance`
- [x] `score` 與 `sentiment` 一致；不一致時 `adjusted` 有記錄
- [x] `drivers[].weight` 和 ≈ 1.0，否則整欄缺席
- [x] `provenance.newsWindow` 與 `publisher` 清單存在且非空
- [x] `mode=rule` 時 `aiMode === 'rule'` 且 schema 完全相同
- [x] 無金鑰環境下仍回 200 且規則層完整
- [x] `GET /api/sector-macro-ai` 回 200，`ranking` 11 筆、`strengthScore` 可排序
- [x] `macroLinks` 每筆有 `value/asOf/percentile/thesis/supports|pressures`
- [x] 簡體輸出被偵測並修正；仍殘留則 `hantOk:false`
- [x] 模型講廢話再吐 JSON 時解析成功（容錯解析器）
- [x] 單一來源失敗不影響整體；全失敗回 200 空結果而非 500
- [x] 兩區塊皆顯示資料來源與時間範圍

---

## 9. 測試與已知陷阱（實作期實際踩到的）

### 9.1 測試入口

| 指令 | 檔案 | 範圍 | 目前 |
|---|---|---|---|
| `npm run test:news-ai` | `tests/news-ai-unit.cjs` | 純函式、契約、降級 | 52 / 52 |
| `npm run test:e2e-news-ai` | `tests/e2e-news-ai.mjs` | 真實瀏覽器渲染、版面、失敗態 | 44 / 44 |

兩者都已接入 `npm run test:all`（e2e 需要一個跑在 5177 的伺服器，與其他 e2e 相同慣例）。

E2E 的設計原則是**只相信畫面上的字與像素**，不讀原始碼也比不讀 API 契約——因為這一輪最貴的缺陷正是「照著契約文件寫前端」。

### 9.2 已修復的缺陷（每一條都有對應測試釘住）

| # | 缺陷 | 症狀 | 根因 | 鎖住它的測試 |
|---|---|---|---|---|
| 1 | 前端欄位名與後端輸出不匹配 | T 級徽章全變 T3、時間與摘要全空白 | 依**契約文件的想像欄位**（`publisherTier`/`publishedAt`/`description`）取值，實際輸出是 `tier`/`time`/`excerpt` | E2E B2 B3 B4、單元 H3 |
| 2 | 徽章文字對、顏色全錯 | 顯示「T1 一線媒體」卻掛 `t3` 灰標 | 文字由 `it.tierShort` 撐住，CSS class 走另一條路徑算出的階梯值 | E2E B3（同時驗文字與 class 一致） |
| 3 | `looksHant` 語義相反 | 純簡體輸入被判為繁體 | 用 `enforceHant(text).ok` 判斷，而 `ok` 表示「修正後沒有殘留」——對任何輸入恆為 true | 單元 B4 |
| 4 | 分數缺席時量表近似 0 分 | 空白半圓被讀成「中性」 | 只做了「不畫指針」，沒留文字出口 | E2E C2、單元 H12 |
| 5 | 排名與象限自相矛盾 | 「第 9 名 · 領先」同時出現且無解釋 | 11 個版塊常有 9 個高於基準，兩把尺不同 | E2E E5 + 契約 §3.4.1 |
| 6 | 排名落差說明貼線自打嘴巴 | `ratio=100.05` 卻寫「仍高於基準（100）」 | `trimNum` 把 100.05 印成 `100.0` | 單元 G 段 |
| 7 | 0 分排名條像壞掉 | 條寬 `0%` 完全空白 | 真實值為 0，但視覺上與渲染失敗無法區分 | E2E E4 |
| 8 | 版塊歸屬缺失且靜默 | 研判少了第三個因子、LLM 只能自己在 caveat 裡抱怨 | 未接 `sector-holdings` 的 symbol→sector 反查 | E2E C8 |
| 9 | LLM 教科書文字 | thesis 沒有任何數字 | 只驗長度不驗內容 | 單元 G6、E2E E7 |
| 10 | 行動版因子名撐破卡片 | `scrollWidth 429 > clientWidth 96` | grid 子項預設 `min-width:auto`，`text-overflow` 永不觸發 | E2E H1 G2 |
| 11 | 失敗後無限轉圈 | 錯誤時仍停在 loading | `catch` 未收掉 loading | E2E I1 I3 |
| 12 | 空結果誤用錯誤樣式 | 「零則新聞」顯示成紅色錯誤 | 空與錯未區分 | E2E I2 |

### 9.3 兩個容易重犯的測試寫法錯誤

1. **拿單邊清單去測「背離」**。`termSpread` 的 `down` 方向 `supportsWhen` 為空，`judgeLink` 依設計拒絕在單邊清單上宣稱背離，所以用它測背離永遠測不到。必須挑雙邊都有的指標（`unrate`、`fedTargetUpper`、`dgs10`、`cpiYoy`）。已加 G3b 反向鎖住這個設計。
2. **用字串比版號**。`'v1.0.10' >= 'v1.0.7'` 在 JS 字串比較下是 **false**（`'1' < '7'`）。`treemap-unit` 與 `holdings-unit` 原本如此寫，升到 v1.0.10 就雙雙誤報。已改為逐段數字比較。

### 9.4 負向對照（測試本身必須能失敗）

44 條 E2E 首跑全綠不足以證明它們有效。實際做法：把缺陷 #1 重新注入 `public/news-ai.js`（`it.tier` → `it.publisherTier`、`it.ageText||it.time` → `it.publishedAt`、`it.excerpt` → `it.description`），重跑：

```
FAIL  B2 每則都有標題、媒體名、時間（不得空白）
FAIL  B3 徽章顯示 T1 但樣式 class 是 tier-badge t3（顏色會與分級脫節）
FAIL  B4 所有摘要都是空的（前端可能讀 it.description 而非 it.excerpt）
結果：41 通過 / 3 失敗
```

還原後回到 44 / 44。**B3 是被這次對照逼出來的**——它原本只驗文字，注入缺陷後仍然通過，說明那條測試當時是鬆的。

