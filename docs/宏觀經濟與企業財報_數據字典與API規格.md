# 宏觀經濟與企業財報 — 數據字典與 AI API 規格

| 項目 | 內容 |
|---|---|
| 文件版本 | v1.0 |
| 產出日期 | 2026-11-26 |
| 對應實作 | `lib/fred.js`、`lib/sec.js`、`lib/fomc.js`、`lib/macro.js`、`lib/interpret.js`、`server.js`、`public/macro.js` |
| 驗證狀態 | 單元測試 90/90、E2E 82/82、既有回歸 118/118 全通過 |
| 文件性格 | **所有範例值都取自實際 API 回應**，非示意數字。文末附完整可複製的驗證指令 |

---

## 摘要：這份文件回答什麼

| 你的要求 | 對應章節 | 交付形式 |
|---|---|---|
| 一份包含合理數據的列表，明確每個資料項的**欄位定義、資料來源、數值範圍與範例值** | 第二章 | 26 個欄位的完整字典（18 宏觀 + 8 財報），可線上取得：`GET /api/data-dict` |
| 設計用於解讀宏觀數據與企業財報的 **AI API 接口**，說明**用途、輸入參數、輸出結構與錯誤處理** | 第三章 | 4 個實際運行的端點，含逐欄位 JSON schema 與 8 種錯誤碼 |
| 將接口**整合到前端頁面**，呈現數據列表與 AI 解讀，確保清晰、載入與顯示正常、易於使用 | 第四章 | `#/macro`、`#/macro/:symbol` 兩個路由，三個分頁 |

**一句話總結設計取向**：本模組的「AI 解讀」是**規則優先、模型可選**。所有數字由程式自來源計算，模型只負責潤飾語氣，且不得引入任何新數字。理由是這個頁面的用途是輔助決策，一個編造出來的 GDP 數字比沒有數字更糟。

---

## 第一章 資料來源與整體架構

### 1.1 四個來源，各自的授權條件

| 來源 | 用途 | 認證要求 | 實測狀態 |
|---|---|---|---|
| **FRED**（聖路易斯聯準銀行） | 利率、通膨、就業、生產、匯率共 18 條序列 | **免 API Key**，但 `fredgraph.csv` **必須帶 User-Agent** | ✅ 可用 |
| **SEC EDGAR**（XBRL companyfacts） | 美股財報三表數字 | 免 Key，但需 `User-Agent: app contact-email`，限 10 req/s | ✅ 可用 |
| **Federal Reserve**（FOMC 行事曆） | 未來 8 場會議日期 | 公開頁面 | ✅ 可用 |
| **FRED `NAPM`（ISM 製造業 PMI）** | 曾用於製造業景氣 | — | ❌ **已下線，回 404** |

### 1.2 為什麼是「自己算」而不是「抓現成」

通膨年增率、TTM、各項比率這些數字，FRED 與 SEC 都不直接提供對應欄位。本模組的做法是**抓原始序列 / 原始財報科目，自己計算**，並把計算方式寫進資料字典的 `transform` 欄位。這樣做有兩個好處：

- 計算過程可被單元測試鎖定（90 個測試中 8 個專門測 TTM 推導、4 個測 YoY 對齊）。
- 出錯時能定位到「是抓錯」還是「算錯」，而不是只能說「來源給的就是這樣」。

### 1.3 資料流

```
使用者輸入
   │
   ├── #/macro ──────────► GET /api/macro ──────────► FRED × 18 + FOMC 行事曆
   │                                                    │
   ├── #/macro/AAPL ─────► GET /api/macro/AAPL ─────► SEC companyfacts
   │                                                    │
   ├── 資料字典分頁 ─────► GET /api/data-dict
   │
   └── AI 解讀分頁 ──────► GET /api/interpret?scope=…
                              │
                              ├─ 規則引擎（必然執行）
                              └─ LLM 潤飾（可選，未設 Key 則跳過）
```

---

## 第二章 資料列表（26 個欄位）

### 2.1 快速總覽

| 群組 | 欄位數 | 來源 | 更新頻率 |
|---|---|---|---|
| 宏觀經濟 | 18 | FRED | 日頻 8 項、月頻 8 項、季頻 1 項（另 1 項為計算值） |
| 企業財報 | 8 | SEC EDGAR | 依申報（季報／年報） |

> 以下每一列都同時給出「單位」「值域」「實際範例值」。**範例值全部取自 2026-11-26 的實際 API 回應**，可直接對照。

### 2.2 宏觀經濟（18 項）

#### 利率與殖利率

| 欄位 key | 名稱 | 單位 | 值域 | 範例值 | 資料時點 |
|---|---|---|---|---|---|
| `fedTargetUpper` | 聯邦基金目標利率**上限** | % | [0, 20] | **4** | 2026-11-25 |
| `fedTargetLower` | 聯邦基金目標利率**下限** | % | [0, 20] | **3.75** | 2026-11-25 |
| `dgs10` | 10 年期公債殖利率 | % | [0, 25] | **4.91** | 2026-11-24 |
| `dgs2` | 2 年期公債殖利率 | % | [0, 25] | **4.63** | 2026-11-24 |
| `dgs30` | 30 年期公債殖利率 | % | [0, 25] | **5.3** | 2026-11-24 |
| `termSpread` | 10Y−2Y 期限利差 | %（百分點） | [−5, 5] | **0.24** | 2026-11-25 |
| `realYield10` | 10 年期實質殖利率（TIPS） | % | [−3, 8] | **2.79** | 2026-11-24 |

**欄位定義**

- `fedTargetUpper` / `fedTargetLower`：FOMC 設定的目標區間上下緣。這是**政策利率**，不是市場成交利率（後者是 EFFR）。兩者寬度應恆為 25 個基點，若實測不是 25bp，代表資料本身有問題。
- `dgs10` / `dgs2` / `dgs30`：由財政部每日公布的 constant maturity 殖利率。**是市場價格衍生的利率，不是 Fed 決定的**。
- `termSpread`：10 年期減 2 年期。負值即俗稱的「殖利率倒掛」。使用 FRED 現成序列 `T10Y2Y` 而非自行相減，避免兩序列採樣日不同造成微幅差異。
- `realYield10`：TIPS 殖利率，可視為市場的實質利率預期。2003 年才有資料，金融海嘯期間曾為負值。

> **注意方向**：`dgs2` 對政策利率預期最敏感，但歷史起點（1976）比 `dgs10` 晚，做長跨度比較時起點不同會影響百分位判讀。

#### 通膨

| 欄位 key | 名稱 | 單位 | 值域 | 範例值 | 資料時點 |
|---|---|---|---|---|---|
| `cpiYoy` | CPI 年增率 | % | [−5, 25] | **3.7173** | 2026-09-01 |
| `coreCpiYoy` | 核心 CPI 年增率 | % | [−5, 25] | **2.5658** | 2026-09-01 |

**欄位定義**

- `cpiYoy`：都市消費者物價指數（未季調）的同比變化。**本模組自行計算 YoY**，需至少 13 個月的歷史點才能算出。
- `coreCpiYoy`：剔除食品與能源後的核心通膨，Fed 更關注的潛在通膨指標。

> **實務重點**：兩者背離時，代表能源或食品價格正在擾動。目前 `cpiYoy 3.72%` 與 `coreCpiYoy 2.57%` 相差 **+1.15 個百分點**，解讀引擎會自動指出這一點。

#### 就業與實體產出

| 欄位 key | 名稱 | 單位 | 值域 | 範例值 | 資料時點 |
|---|---|---|---|---|---|
| `unrate` | 失業率 | % | [0, 30] | **4.1** | 2026-10-01 |
| `payems` | 非農就業人數 | **千人** | [10000, 300000] | **159293** | 2026-10-01 |
| `manemp` | 製造業就業人數 | **千人** | [5000, 25000] | **12681** | 2026-10-01 |
| `indpro` | 工業生產指數 | 指數（2017=100） | [0, 200] | **102.2421** | 2026-10-01 |

**欄位定義**

- `unrate`：失業人口佔勞動力比例（BLS 家戶調查）。**是落後指標**——企業先減少招聘才裁員，失業率往往在衰退中期才明顯上升。
- `payems`：企業調查的就業人數，不含農業。**絕對水準值意義有限，實務看月增減**（本模組另提供 `change`）。
- `manemp`：製造業就業。長期趨勢向下（自動化），絕對值下滑不必然代表景氣衰退。
- `indpro`：製造業、礦業、公用事業的實體產出**量**。

> **兩個容易混用的東西**：`indpro` 是產出的「量」，ISM PMI 是「擴散指數」（多少比例企業回報改善）。兩者概念不同，**不可互稱、不可互相替代**。這也是 ISM 下線後本模組改用 `indpro` 的原因，但必須在畫面上明確說明替代關係。

#### 需求與外部環境

| 欄位 key | 名稱 | 單位 | 值域 | 範例值 | 資料時點 |
|---|---|---|---|---|---|
| `umcsent` | 密西根大學消費者信心 | 指數 | [0, 150] | **48** | 2026-10-01 |
| `dollarBroad` | 美元廣義指數 | 指數（2006-01=100） | [50, 200] | **123.5978** | 2026-11-20 |
| `eurusd` | EUR/USD 匯率 | 美元/歐元 | [0.3, 2.5] | **1.0981** | 2026-11-20 |
| `deficit12m` | 聯邦財政赤字（月度） | **百萬美元** | [−1500000, 500000] | **−404063.55** | 2026-10-01 |

**欄位定義**

- `umcsent`：月度調查的消費者信心指數，**長期均值約 85**。目前 48 屬歷史極低區間。這是調查型「軟指標」，與實體消費數據可能背離，不宜單獨作為景氣結論。
- `dollarBroad`：對一籃子主要貿易夥伴貨幣的加權匯率。**與 DXY（ICE 美元指數）成分不同、基期不同，數值不可互相比較或替換。**
- `eurusd`：1 歐元可兌換的美元數（Fed H.10）。**數值越大代表美元越弱**，方向勿搞反。
- `deficit12m`：當月聯邦收支差額，**負值代表赤字**。單月數字受一次性收支影響極大，另提供 12 個月滾動合計。

#### 總量

| 欄位 key | 名稱 | 單位 | 值域 | 範例值 | 資料時點 |
|---|---|---|---|---|---|
| `gdpReal` | 實質 GDP | **十億美元**（2017 年連鎖） | [1000, 40000] | **24665.201** | 2026-07-01 |

**欄位定義**：經通膨調整後的國內生產總值，季頻、年化水準。

> **三重陷阱，三者都必須正確**：
> 1. 這是**季頻**資料，最新一季通常還會被修正（初值／修正／最終）。
> 2. 單位已是「十億美元」，範例值 24,665 代表 **24.7 兆美元**，不是 24,665 美元。
> 3. 顯示時**不可再套用 K/M/B 縮寫**，否則會變成「24.7K 十億美元」，讀起來是 24.7 千兆。此坑已實際踩過並修正（見 5.2）。

### 2.3 企業財報（8 項）

財報欄位不綁定 FRED 序列，而是由 SEC XBRL 概念推導。**每一列的口徑（TTM 或年度）都必須標明**，因為混用會產生完全錯誤的成長率。

| 欄位 key | 名稱 | 單位 | 值域 | 範例值（AAPL） | 計算方式 |
|---|---|---|---|---|---|
| `revenue` | 營收 | USD | [0, 1e13] | **478,834,000,000** | TTM 或年度值 |
| `netIncome` | 淨利 | USD | [−1e12, 1e12] | **132,175,000,000** | TTM 或年度值 |
| `epsDiluted` | 稀釋每股盈餘 | USD/share | [−100, 1000] | **8.98** | 原始值 |
| `grossMargin` | 毛利率 | % | [−100, 100] | **48.79** | 毛利 / 營收 |
| `netMargin` | 淨利率 | % | [−100, 100] | **27.6** | 淨利 / 營收 |
| `roe` | 股東權益報酬率 | % | [−500, 500] | **117.92** | 淨利(TTM) / 股東權益 |
| `debtRatio` | 負債比 | % | [0, 200] | **72.29** | 總負債 / 總資產 |
| `revenueYoy` | 營收年增率 | % | [−100, 500] | **15.06** | （本期 − 去年同期）/ 去年同期 |

**欄位定義與口徑**

- `revenue`：公司主要營業活動收入總額。XBRL 概念優先序為
  `RevenueFromContractWithCustomerExcludingAssessedTax` → `...IncludingAssessedTax` → `Revenues` → `SalesRevenueNet` → `SalesRevenueGoodsNet`。
  **`Revenues` 概念已廢棄**（AAPL 的資料停在 2018-09-29），因此必須同時做「概念優先序」與「資料新鮮度檢查」，否則會拿 8 年前的營收當今年。
- `netIncome`：扣除所有費用與稅後的淨利。含一次性項目（資產減損、訴訟和解），與營業利益不同。
- `epsDiluted`：計入選擇權、可轉債稀釋效果後的 EPS。計算本益比應使用稀釋 EPS。
- `grossMargin` / `netMargin`：**分子分母必須同期配對**，跨期相除會得到無意義數字。
- `roe`：分子是期間值（淨利）、分母是時點值（權益），口徑已在定義中標明。
- `debtRatio`：兩者皆為時點值。高負債比不一定不好，需看負債性質與產業慣例。
- `revenueYoy`：**TTM 必須對 TTM、年度必須對年度**，不可混用。52/53 週財年的公司需用 **364 天**對齊，不能用 365 天。

> **一個必須解釋的異常值**：AAPL 的 ROE 是 **117.92%**，超過 100%。這不是算錯——大規模庫藏股使股東權益縮小，淨利大於權益。此時 ROE 不宜與同業直接比較，API 會回傳 `roeNote` 說明，前端顯示在數值旁。若權益為負，ROE 在數學上無意義。

### 2.4 欄位 schema（`GET /api/data-dict` 回傳的每個 `fields[]` 元素）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `group` | string | `宏觀經濟` / `企業財報` |
| `key` | string | 程式內唯一識別碼，如 `cpiYoy` |
| `seriesId` | string\|null | 上游序列 ID（FRED 如 `CPIAUCSL`）；財報欄位為 `null` |
| `label` | string | 顯示名稱（繁體中文） |
| `unit` | string | 單位，**可能已含量級**（千人／百萬美元／十億美元） |
| `freq` | string | 日頻／月頻／季頻／依財報 |
| `transform` | string | 計算方式，如 `年增率（自行計算）`、`TTM 或年度值` |
| `definition` | string | **欄位定義**（這欄是本文重點） |
| `source` | string | `FRED` / `SEC EDGAR XBRL` |
| `sourceUrl` | string | 可點擊回溯的原始出處 |
| `range` | `[number, number]` | **合理值域**，超出即視為資料異常 |
| `rangeNote` | string | 值域說明 |
| `example` | number | **實際範例值**（取自 live API） |
| `exampleAsOf` | string | 範例值的資料時點 |
| `note` | string\|null | 使用時機與常見誤解 |

---

## 第三章 AI API 接口規格

### 3.0 共同約定

**統一回應信封**：所有端點成功時回 `{ok: true, ...}`，失敗時回

```json
{ "ok": false, "error": { "code": "...", "message": "...", "hint": "..." } }
```

`hint` 可能為 `null`。前端可用同一套 `SA.api()` 處理，不需為每個端點寫特例。

> **一個刻意的設計選擇**：資料「查不到」與「請求錯誤」在 HTTP 層被區分開。
> - **請求本身不合法**（格式錯、缺參數、scope 不支援）→ **HTTP 400** + `ok:false`
> - **請求合法但資料不存在**（HK 股、代碼查無）→ **HTTP 200** + `ok:true` + `available:false`
>
> 理由：後者是一個**有效的答案**（「這檔沒有 SEC 申報」），不是伺服器錯誤。若回 4xx，前端瀏覽器 console 會滿是紅字，且 CDN 可能快取錯誤頁。

---

### 3.1 `GET /api/macro` — 宏觀儀表板

**用途**：一次取得 18 條宏觀序列的當前值、歷史百分位、變化量，加上 FOMC 會議日程與規則型解讀。這是宏觀頁的主資料來源。

**輸入參數**

| 參數 | 型別 | 必填 | 預設 | 說明 |
|---|---|---|---|---|
| `refresh` | `1` | 否 | — | 強制繞過快取重抓上游 |
| `preview` | `1` | 否 | — | **只回報快取狀態，不觸發上游抓取**，回應 < 10ms。前端用它決定要不要顯示 Loading |

**輸出結構**（實測）

```json
{
  "ok": true,
  "scope": "macro",
  "generatedAt": "2026-11-26T03:17:04.009Z",
  "series": [
    {
      "key": "fedTargetUpper",
      "id": "DFEDTARU",
      "label": "聯邦基金目標利率上限",
      "unit": "%",
      "freq": "D",
      "transform": "level",
      "definition": "FOMC 設定的聯邦基金目標區間上緣。這是政策利率，不是市場成交利率。",
      "note": "日頻但只在 FOMC 決議後變動，兩個月之間通常完全不變。",
      "source": "FRED",
      "sourceUrl": "https://fred.stlouisfed.org/series/DFEDTARU",
      "available": true,
      "plausible": "ok",
      "value": 4,
      "asOf": "2026-11-25",
      "points": 6554,
      "span": { "from": "2008-12-16", "to": "2026-11-25" },
      "stats": { "min": 0.25, "max": 5.5, "percentile": 81.6, "prev": 4, "change": 0 },
      "fetchedAt": "2026-11-26T03:17:04.009Z"
    }
  ],
  "fomc": {
    "available": true,
    "source": "Federal Reserve",
    "sourceUrl": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    "asOf": "...",
    "byYear": { "2026": [...], "2027": [...] },
    "upcoming": [ /* 未來 6 場 */ ],
    "recent": [ /* 過去 4 場 */ ],
    "next": { "date": "2026-12-09", "month": "December", "days": "8-9",
              "label": "December 8-9", "daysUntil": 13 },
    "validations": [
      { "year": 2026, "ok": true, "expected": 8, "parsed": 8, "issues": [] },
      { "year": 2027, "ok": true, "expected": 8, "parsed": 8, "issues": [] }
    ],
    "forecastNote": "...",
    "fetchedAt": "..."
  },
  "interpretation": { /* 見 3.4 */ },
  "status": {
    "total": 18, "available": 18, "unavailable": 0,
    "degraded": false, "unavailableKeys": []
  },
  "sources": [
    { "name": "FRED（聖路易斯聯準銀行）", "url": "https://fred.stlouisfed.org",
      "usage": "利率／通膨／就業／生產序列", "auth": "免 Key（fredgraph CSV）" },
    { "name": "Federal Reserve",
      "url": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
      "usage": "FOMC 會議日程", "auth": "公開頁面" }
  ],
  "limitations": [ "..." ]
}
```

**關鍵欄位語義**

| 欄位 | 語義 | 前端應如何處理 |
|---|---|---|
| `series[].available` | `false` 表示此序列取不到 | 該列顯示原因與 `unavailable` 代碼，**不可顯示 0** |
| `series[].plausible` | `'ok'` / `'out_of_range'` | 非 ok 時加註警示，但不隱藏數值 |
| `series[].stats.percentile` | 當前值在歷史分佈的位置（0–100） | 以進度條呈現，**不可用紅綠**（紅綠已被漲跌佔用） |
| `status.degraded` | 有任何序列取不到即為 `true` | 顯示降級提示條，但頁面仍要可用 |
| `fomc.validations` | 每年應有 8 場會議的自我檢查 | `ok:false` 時顯示警告，代表解析可能出錯 |

> **`preview=1` 的回應長得不一樣**，只有四個欄位，這是刻意的：
> ```json
> {"ok":true,"preview":true,"cached":false,
>  "note":"無快取，首次載入需抓取 18 個序列（約 5–15 秒）"}
> ```
> 它不碰上游，所以能在 10ms 內回答「要不要給使用者看 Loading」。

**錯誤處理**：無 400。上游失敗不會讓端點失敗——單一序列失敗會反映在該 `series` 的 `available:false`，整體仍是 `ok:true`（這是「部分成功」的處理原則：18 個指標壞 1 個，不該讓整個頁面掛掉）。

---

### 3.2 `GET /api/macro/:symbol` — 個股財報 + 宏觀背景

**用途**：取得單一公司的 SEC 財報數字、比率、資產負債摘要、近期申報紀錄，加上**精簡版**宏觀背景（只 3 項，避免個股頁變成宏觀頁）與財報解讀。

**輸入參數**

| 參數 | 位置 | 必填 | 說明 |
|---|---|---|---|
| `:symbol` | 路徑 | 是 | 股票代碼。美股 `AAPL`、港股 `0700` 或 `0700.HK` |
| `refresh` | query | 否 | `1` 時繞過快取 |

**輸出結構**（實測 AAPL，省略部分欄位）

```json
{
  "ok": true,
  "scope": "fundamentals",
  "generatedAt": "2026-11-26T03:17:10.280Z",
  "symbol": "AAPL",
  "requestedSymbol": "AAPL",
  "fundamentals": {
    "symbol": "AAPL",
    "cik": "0000320193",
    "entityName": "Apple Inc.",
    "available": true,
    "source": "SEC EDGAR XBRL",
    "sourceUrl": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K",
    "asOf": "2026-09-26",
    "concepts": {
      "revenue": "RevenueFromContractWithCustomerExcludingAssessedTax",
      "netIncome": "NetIncomeLoss",
      "eps": "EarningsPerShareDiluted"
    },
    "metrics": {
      "revenue": {
        "value": 478834000000, "basis": "FY",
        "method": "最新財報為年度，財年結束時 TTM 等於年度值",
        "from": "2025-09-28", "to": "2026-09-26", "yoy": 15.06
      },
      "netIncome": { "value": 132175000000, "basis": "FY", "method": "...", "to": "2026-09-26" },
      "epsDiluted": { "value": 8.98, "period": "year", "to": "2026-09-26" },
      "grossMargin": 48.79, "operatingMargin": 33.01, "netMargin": 27.6,
      "debtRatio": 72.29, "roe": 117.92,
      "roeNote": "ROE 超過 100%：淨利大於股東權益，通常來自大規模庫藏股使權益縮小（非計算錯誤）。此時 ROE 不宜與同業直接比較。"
    },
    "balance": {
      "assets":      { "value": 404548000000, "asOf": "2026-09-26" },
      "liabilities": { "value": 292455000000, "asOf": "2026-09-26" },
      "equity":      { "value": 112093000000, "asOf": "2026-09-26" }
    },
    "gaps": ["TTM（改以年度值呈現）"],
    "filings": [
      { "form": "8-K", "filedAt": "2026-11-09", "description": "", "url": "https://www.sec.gov/..." },
      { "form": "10-K", "filedAt": "2026-11-03", "description": "10-K", "url": "https://www.sec.gov/..." }
    ],
    "fetchedAt": "..."
  },
  "interpretation": { /* 見 3.4 */ },
  "macroBackdrop": {
    "fedTargetUpper": { "value": 4,    "asOf": "2026-11-25" },
    "dgs10":          { "value": 4.91, "asOf": "2026-11-24" },
    "termSpread":     { "value": 0.24, "asOf": "2026-11-25" }
  },
  "sources": [ /* ... */ ]
}
```

**關鍵欄位語義**

| 欄位 | 語義 | 為什麼重要 |
|---|---|---|
| `metrics.*.basis` | `FY`（年度）或 `TTM` | **口徑必須跟著數字一起走**。前端顯示成長率時要標明口徑，否則使用者會誤解 |
| `metrics.*.method` | 人類可讀的推導說明 | 讓「這個 TTM 怎麼來的」可被追溯，而不是黑箱 |
| `gaps` | 無法取得的欄位與原因 | 例如 `TTM（改以年度值呈現）`、`本益比（未提供股價）` |
| `roeNote` | ROE 異常時的解釋 | 防止使用者以為 117.92% 是 bug |
| `interpretation.available:false` + `unavailable` | 財報整體取不到 | 見下方 HK 範例 |

**TTM 推導的三條路線**（`lib/sec.js` `deriveTtm`）

財報**第四季從不單獨申報**，所以 TTM 不能簡單「四季相加」。實作按順序嘗試：

1. **四季連續**：最近四個季度齊全 → 直接相加。
2. **最新點是年度**：落在財年結束時 → **TTM 等於年度值**（AAPL 目前走這條，所以 `basis: "FY"`）。
3. **年度 + 當年 YTD − 去年同期同長度**：以 `latest` 為錨點回推，避免錯位（MSFT 走這條，實測 346.45B）。

**HK 股的回應**（`0700.HK`，HTTP **200**）

```json
{
  "ok": true, "scope": "fundamentals", "symbol": "0700.HK",
  "fundamentals": {
    "symbol": "0700.HK", "available": false,
    "unavailable": "not_applicable",
    "code": "NOT_APPLICABLE",
    "reason": "0700.HK 為港股，沒有 SEC 申報紀錄",
    "hint": "港股財報請參考公司年報或港交所披露易；本頁不提供港股基本面。"
  },
  "interpretation": { "available": false, "unavailable": "not_applicable", "findings": [], ... },
  "macroBackdrop": { /* 仍然提供 */ }
}
```

> 注意 `macroBackdrop` **仍然有值**——港股沒有財報，但宏觀環境一樣適用。這是「部分可用就部分給」的落實。

**錯誤處理**

| 情況 | HTTP | code | 說明 |
|---|---|---|---|
| 路徑空白 | 400 | `EMPTY` | `/api/macro/` |
| 格式無法辨識 | 400 | `INVALID_FORMAT` | `/api/macro/!!!` |
| 輸入過長 | 400 | `TOO_LONG` | > 24 字元 |
| 港股 | **200** | `NOT_APPLICABLE` | 在 `fundamentals.code` 內，不是 `error` |
| 美股但查無 CIK | **200** | `NOT_FOUND` | 同上 |
| SEC 限流 | **200** | `RATE_LIMITED` → `unavailable:'blocked'` | 可稍後重試 |

---

### 3.3 `GET /api/data-dict` — 資料字典

**用途**：回傳第二章那 26 個欄位的完整中繼資料。前端「資料字典」分頁直接渲染這份資料，本文第二章的表格也是由它產生（確保文件與程式不會不同步）。

**輸入參數**：無。

**輸出結構**

```json
{
  "ok": true,
  "generatedAt": "2026-11-26T03:15:57.852Z",
  "fields": [
    {
      "group": "宏觀經濟",
      "key": "fedTargetUpper",
      "seriesId": "DFEDTARU",
      "label": "聯邦基金目標利率上限",
      "unit": "%", "freq": "日頻", "transform": "原始值",
      "definition": "FOMC 設定的聯邦基金目標區間上緣。這是政策利率，不是市場成交利率。",
      "source": "FRED",
      "sourceUrl": "https://fred.stlouisfed.org/series/DFEDTARU",
      "range": [0, 20],
      "rangeNote": "合理值域，超出即視為資料異常",
      "example": 4,
      "exampleAsOf": "2026-11-25",
      "note": "日頻但只在 FOMC 決議後變動，兩個月之間通常完全不變。"
    }
  ]
}
```

**實作要點**：`example` 必須是真的範例值，不能是 `null`。初版只取了 7 條序列，導致 **26 個欄位中有 11 個 `example` 為 `null`**——正好是「範例值」這項要求的核心，屬於實質缺陷。修正方式為：先重用宏觀快取，再對缺的序列補抓，確保 **26/26 都有值**。

**錯誤處理**：無 400。個別序列補抓失敗時，該欄位 `example` 為 `null`，其餘照常回傳。

---

### 3.4 `GET /api/interpret` — AI 解讀

**用途**：這是使用者需求中「AI 解讀」的主體。輸入一組已算好的數據，輸出**結構化的判讀結論**：每個主題的立場、依據、信心度、注意事項。

**輸入參數**

| 參數 | 型別 | 必填 | 預設 | 說明 |
|---|---|---|---|---|
| `scope` | `macro` \| `fundamentals` | 否 | `macro` | 解讀範圍 |
| `symbol` | string | `scope=fundamentals` 時必填 | — | 股票代碼 |
| `mode` | `rule` \| `llm` | 否 | `rule` | `rule` 只回規則結果；`llm` 額外嘗試模型潤飾 |
| `refresh` | `1` | 否 | — | 繞過快取（僅 `scope=macro`） |

**輸出結構**

```json
{
  "ok": true,
  "scope": "macro",
  "interpretation": {
    "scope": "macro",
    "generatedAt": "...",
    "mode": "rule",
    "overall": {
      "stance": "mixed",
      "text": "指標彼此矛盾，沒有單一方向",
      "counts": { "hawkish": 1, "dovish": 0, "mixed": 1, "unknown": 0 }
    },
    "findings": [
      {
        "id": "inflation",
        "topic": "inflation",
        "stance": "neutral",
        "headline": "核心 CPI 年增率 2.57%，接近目標（2% 目標）",
        "detail": "核心 CPI 年增率目前為 2.57%，接近目標。……整體 CPI（3.72%）與核心 CPI（2.57%）相差 +1.15 個百分點，代表能源或食品價格正在推高通膨，這部分波動大、可逆。",
        "evidence": [
          { "label": "CPI 年增率", "value": 3.7173, "unit": "%",
            "asOf": "2026-09-01", "seriesId": "CPIAUCSL", "percentile": 66.8 },
          { "label": "核心 CPI 年增率", "value": 2.5658, "unit": "%",
            "asOf": "2026-09-01", "seriesId": "CPILFESL", "percentile": 45.1 }
        ],
        "confidence": "high",
        "caveat": "最新 CPI 資料為 2026-09-01，距今超過兩個月，可能已有更新一期。"
      }
    ],
    "gaps": [],
    "disclaimer": "本解讀為規則型推理，描述「已公布的數據」與「相對歷史位置」，不構成任何投資建議，也不預測未來走勢。所有數值皆可回溯至來源，請自行覆核。"
  },
  "llm": null,
  "generatedAt": "..."
}
```

**`findings` 的主題清單**

| scope | `id` / `topic` | 判讀什麼 |
|---|---|---|
| macro | `inflation` | 通膨水準與趨勢，整體 vs 核心背離 |
| macro | `rates` | 政策利率位置、期限利差（倒掛） |
| macro | `labor` | 失業率水準與歷史百分位 |
| macro | `activity` | 工業生產、製造業就業 |
| macro | `external` | 美元、匯率、財政赤字 |
| fundamentals | `growth` | 營收成長 |
| fundamentals | `margins` | 毛利／營業利益／淨利率結構 |
| fundamentals | `roe` | 股東權益報酬率（含異常說明） |
| fundamentals | `leverage` | 負債比 |
| fundamentals | `eps` | 稀釋 EPS |

**`stance` 的六種值與其視覺語義**

| stance | 意義 | 用於 |
|---|---|---|
| `hawkish` | 偏緊縮（利空風險資產） | macro |
| `dovish` | 偏寬鬆（利多風險資產） | macro |
| `neutral` | 中性 | 兩者 |
| `mixed` | 內部矛盾，無單一方向 | 兩者 |
| `positive` / `negative` | 偏正面／偏負面 | fundamentals |
| `unknown` | **資料不足，無法判讀** | 兩者 |

> **`unknown` 不是 `neutral`。** 這是一個實測抓到的設計缺陷：初版在所有指標都取不到時輸出 `neutral`，但那是一個「判斷」，而實際情況是「沒有觀測」。兩者混同會讓使用者以為「環境中性」，事實上是「我們什麼都不知道」。修正後：全部不可用時 `overall.stance = 'unknown'`，文案為「所有指標皆無法取得，無法判讀目前環境」。

**`mode=llm` 的行為**

```json
{ "llm": { "text": null, "mode": "rule", "note": "未設定 LLM API Key，使用規則型解讀" } }
```

**這是刻意的優雅降級**：即使明確要求 `mode=llm` 而環境沒有 Key，端點仍回 **HTTP 200**，`interpretation` 完整，只是 `llm.text` 為 `null` 並附說明。使用者不會因為一個可選功能而拿不到主要結果。

LLM 的防護措施（`lib/interpret.js` `polishWithLlm`）：

| 措施 | 實作 |
|---|---|
| 不給模型新數字 | prompt 明令「**絕對不可新增或推測任何數值**」，只提供已算好的 `headline`/`detail` |
| 幻覺硬過濾 | 回應中若有 **> 3 個** `\d+\.\d+` 數字在輸入中找不到對應 → **整段棄用**，退回規則結果 |
| 不可預測 | prompt 明令不可給投資建議、不可預測價格或走勢 |
| 不可粉飾矛盾 | prompt 明令若結論互相矛盾必須說出，不可粉飾 |
| 逾時保護 | `AbortSignal.timeout(20000)` |
| 參數 | `temperature: 0.3`、`max_tokens: 700`、模型預設 `gpt-4o-mini`（可用 `OPENAI_MODEL` 覆寫） |

**錯誤處理**

| 情況 | HTTP | code | message |
|---|---|---|---|
| `scope` 不支援 | 400 | `BAD_SCOPE` | `不支援的 scope：bad` / hint `可用：macro、fundamentals` |
| `fundamentals` 缺 `symbol` | 400 | `EMPTY` | `scope=fundamentals 需提供 symbol 參數` |
| `symbol` 格式錯 | 400 | `INVALID_FORMAT` | `「!!!」格式無法辨識` |
| 港股 / 查無代碼 | **200** | — | 在 `interpretation.unavailable`，`findings: []` |
| LLM 失敗 | **200** | — | `llm.mode:'rule'` + `note` 說明，主結果不受影響 |

### 3.5 錯誤碼總表

| code | HTTP | 意義 | 前端建議文案 | 可重試 |
|---|---|---|---|---|
| `EMPTY` | 400 | 缺少必要參數 | 「請輸入股票代碼」 | ❌ |
| `INVALID_FORMAT` | 400 | 格式無法辨識 | 顯示 `hint` 的範例格式 | ❌ |
| `TOO_LONG` | 400 | 超過 24 字元 | 「輸入過長」 | ❌ |
| `BAD_SCOPE` | 400 | scope 不支援 | 「不支援的解讀範圍」 | ❌ |
| `NOT_FOUND` | **200** | 查無此代碼的申報 | 「查無申報紀錄，可能非美國註冊公司」 | ❌ |
| `NOT_APPLICABLE` | **200** | 本來就沒有（港股） | 「港股無 SEC 申報」 | ❌ |
| `RATE_LIMITED` | **200** | 被來源限流 | 「來源限流，請稍後重試」 | ✅ |
| `UPSTREAM` / `NETWORK` | **200** | 上游或網路失敗 | 「暫時無法取得，請稍後重試」 | ✅ |

**「不可用」的分級（`unavailable` 欄位）** —— 這幾種**不可混為一談**，混在一起使用者會反覆重試一個註定失敗的模組。以下四種是目前程式**實際會輸出**的值：

| 值 | 情況 | 文案 | 重試 | 出處 |
|---|---|---|---|---|
| `retired` | 404，來源已下線（如 ISM PMI） | 「此指標已停止公開提供」 | ❌ 重試無用 | `lib/fred.js:387` |
| `blocked` | 403/429，來源限制 | 「來源限制存取」 | ⚠️ 可能稍後恢復 | `lib/fred.js:387`、`lib/sec.js:491` |
| `transient` | 逾時／連線失敗 | 「暫時無法取得，請稍後重試」 | ✅ | `lib/fred.js:387`、`lib/macro.js:81` |
| `not_applicable` | 港股查 SEC、查無 CIK | 「港股無 SEC 申報」 | ❌ 本來就沒有 | `lib/sec.js:469` |

> **一個規格與實作的差異，必須說清楚**：早期規劃文件曾列出第五種 `stale`（「抓到但資料過舊」）。實作時**沒有**採用這個值——因為「資料過舊」不是「取不到」，把它塞進 `unavailable` 會讓一個其實有數字的欄位被當成空白。目前的實際做法是在概念挑選階段**直接跳過過舊的概念並改用下一個**（`lib/sec.js:331` 記錄為 `stale (last ...)` 於內部 `tried` 陣列），最後若全部概念都過舊才整體回報不可用。因此 `stale` 只是內部除錯字串，**不是 API 對外的 `unavailable` 值**。

---

## 第四章 前端整合

### 4.1 路由與頁面

| 路由 | 頁面 | 呼叫的端點 |
|---|---|---|
| `#/macro` | 宏觀儀表板 | `/api/macro`、`/api/data-dict`、`/api/interpret?scope=macro` |
| `#/macro/AAPL` | 個股財報 + 宏觀背景 | `/api/macro/AAPL`、`/api/interpret?scope=fundamentals&symbol=AAPL` |

導覽列共 4 項：`#/predict`（K 線預測）、`#/screen`（AI 選股）、`#/macro`（宏觀與基本面）、個股詳情（隱藏路由）。

### 4.2 三個分頁

| 分頁 | 內容 | 對應需求 |
|---|---|---|
| **宏觀數據** | 18 列指標表（值／單位／資料時點／歷史百分位／來源徽章）＋ FOMC 下一場會議卡片與日程清單 ＋ 限制說明卡 | 數據列表 |
| **資料字典** | 26 列欄位表（定義／來源／值域／範例值）＋ 關鍵字過濾 | **欄位定義、來源、值域、範例值** |
| **AI 解讀** | 總體立場摘要 ＋ 各主題判讀卡（標題／說明／依據／注意事項）＋ 資料缺口 ＋ 免責聲明 | **AI 解讀結果** |

### 4.3 幾個易用性決定

| 問題 | 做法 | 理由 |
|---|---|---|
| 首次載入要抓 18 條序列（5–15 秒） | 先打 `preview=1`（<10ms）判斷有無快取，再決定 Loading 文案 | 讓使用者知道要等多久，而不是無盡的轉圈 |
| 資料「缺」與「值為 0」 | 缺 → `—` + 原因標籤；0 → 顯示 `0` | **空值絕不可當 0**，否則圖表會出現假跌到 0 的線段 |
| 百分位怎麼畫 | 進度條用**琥珀色**（高）與**石板色**（其他） | 藍色已被「建議買入區間」佔用、紅綠已被漲跌佔用，不能搶語義 |
| 四種立場怎麼區分 | 用圖示與文字，`hawkish`/`dovish`/`neutral`/`mixed` 視覺等重 | 避免暗示「偏緊縮」比「偏寬鬆」重要 |
| 資料過舊 | 該列顯示 `asOf`，超過預期落後天數則加註 | CPI 若停在 2 個月前，必須說出來（實測就是這樣） |
| 使用者可能誤讀 ROE | `roeNote` 直接顯示在數值旁 | 117.92% 需要一句解釋，否則看起來像 bug |

### 4.4 響應式

表格使用 `table-layout: fixed` + `<colgroup>` 固定欄寬。**這裡有一個必須知道的陷阱**：

> 若各 `<col>` 寬度總和 ≥ 表格的 `min-width`，設為 `width: auto` 的那一欄會被壓成 **0px**，內容完全被裁掉。
>
> 因此每個斷點都必須**同時**重算 `min-width` 與各欄寬，且 `.macro-table` 與 `.dict-table` 兩張表都要各自覆寫（同一優先級下後者勝出，漏寫一張就會壞掉）。

實測結果：1440 / 768 / 390 / 360 四個寬度下，**0 個被裁切的儲存格、0 個欄位重疊、頁面水平溢出為 0**。

---

## 第五章 刻意的限制（不是待辦事項）

這些限制是**基於實測**的取捨，寫在這裡是為了避免後來的人「把它當 bug 修掉」。

### 5.1 硬限制

| # | 限制 | 實測證據 | 處理方式 |
|---|---|---|---|
| L1 | **ISM 製造業 PMI 已從 FRED 下線** | `NAPM`/`NAPMPI`/`NAPMEI` 全回 404 | 改用工業生產 `INDPRO` 呈現實體產出，**並在畫面明確說明兩者概念不同** |
| L2 | **港股無 SEC 申報** | `.HK$` 在 `company_tickers.json` 匹配 **0 筆** | 回 `NOT_APPLICABLE`，仍提供宏觀背景 |
| L3 | **Fed 不發布未來利率路徑** | 點陣圖是匿名預測，非委員會決議 | **不提供利率預測**，只給「已知會議時程 + 當前水準」 |
| L4 | **CME FedWatch 不可達** | 連線逾時 | 不顯示期貨隱含機率 |
| L5 | **SEC `companyfacts` 單檔 3.86MB** | 實測 | 只在個股頁抓，不快取全池 |
| L6 | **SEC 限 10 req/s** | 官方公告 | 自建節流器（120ms 間隔），選股頁絕不批次抓 |

### 5.2 三個實際踩過並修正的坑（留作警示）

| 坑 | 現象 | 根因 | 修正 |
|---|---|---|---|
| **單位重複縮放** | 畫面出現 `24.7K 十億美元`（讀起來是 24.7 千兆）、`159.3K 千人` | 單位欄已含量級（十億／千人），格式化函式又套了一次 K/M/B 縮寫 | 偵測單位是否已含量級，是則只格式化不縮寫 |
| **空值被當成 0** | `percentileRank(points, null)` 回 `0`，顯示成「歷史第 0 百分位」 | `isFinite(null) === true`（JS 陷阱） | 加 `typeof value !== 'number'` 前置檢查 |
| **無資料被判為中性** | 全部指標取不到時，`overall.stance` 回 `neutral` | 把「未觀測」誤當成「觀測到中性」 | 新增 `allUnknown` 分支回 `unknown` |

### 5.3 環境限制

- **本環境未設定 `OPENAI_API_KEY`**，因此 `mode=llm` 一律回 `llm: null` 並說明。這是預期行為，不是故障。規則型解讀完整可用。
- 日頻序列在週末與假日無新值，不同序列的最新日期本來就會不一致（API 已在每列標明 `asOf`）。
- 部分月份資料可能因政府停擺等原因缺漏，年增率計算會因此缺基期（畫面會標示）。

---

## 第六章 驗證方式

### 6.1 自動化測試

| 測試 | 規模 | 內容 |
|---|---|---|
| `npm run test:macro` | **90 / 90** | 離線單元測試：CSV 解析、ZIP 偵測、YoY 對齊、百分位、SEC 期間分類、概念優先序、TTM 三路線、FOMC 解析、解讀引擎、LLM 幻覺防護、資料字典完整性、前端契約 |
| `npm run test:e2e-macro` | **82 / 82** | 真實瀏覽器：1440 桌面／390 手機、三分頁、18 列、26 列、5 張判讀卡、港股降級、無溢出、雙重縮放守門、導覽回歸 |
| `npm run test:all` | 含既有回歸 | 把宏觀單元測試插進既有全量測試鏈，確保新模組沒破壞原有功能 |
| 一次性事實校驗 | **118 / 118** | 開發期用的一次性腳本，逐條比對「文件寫的」與「程式實際做的」是否一致。**未納入版控**（位於 gitignore 的 `.p/`），僅供本次交付的自我檢查紀錄 |

其中幾個值得指名的測試：

- `F2 Revenues 停在 8 年前 → 跳過`：鎖住「廢棄概念 + 新鮮度」雙重檢查。
- `G5 deriveTtm 路線 2：最新點是年度 → TTM == FY`：鎖住 AAPL 走的路線。
- `G6` MSFT 走路線 3 → 346.45B。
- `I12 全部指標不可用 → unknown 不可說中性`：鎖住 5.2 的第三個坑。
- `J3 含大量來源沒有的數字 → 整段棄用`：鎖住幻覺過濾。
- `L8 單位已帶量級時不得再縮寫`：鎖住 5.2 的第一個坑。
- `L9 面向前端的文字不得含 Markdown 標記`：因為前端用 `textContent`，`**粗體**` 會原樣顯示星號。

### 6.2 手動驗證指令

```bash
# 1. 資料字典：應回 26 個欄位，且沒有一個 example 為 null
curl -s localhost:5177/api/data-dict | node -e "
const j=JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log('fields:', j.fields.length,
            '| example=null:', j.fields.filter(f=>f.example==null).length);
"

# 2. 宏觀儀表板：18/18 可用，FOMC 下一場 2026-12-09
curl -s localhost:5177/api/macro | node -e "
const j=JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log(j.status, j.fomc.next);
"

# 3. 財報：AAPL
curl -s localhost:5177/api/macro/AAPL | node -e "
const j=JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log(j.fundamentals.metrics);
"

# 4. 解讀（規則型）
curl -s 'localhost:5177/api/interpret?scope=macro' | node -e "
const j=JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log(j.interpretation.mode, j.interpretation.overall);
"

# 5. 錯誤處理：應回 BAD_SCOPE / 400
curl -s -w '\n%{http_code}\n' 'localhost:5177/api/interpret?scope=bad'
```

### 6.3 本次實測基準值（2026-11-26）

| 項目 | 實測值 |
|---|---|
| 宏觀序列 | `available: 18 / 18`，`degraded: false` |
| FOMC 下一場 | `2026-12-09`，`daysUntil: 13`；2026 與 2027 各解析 8 場，驗證通過 |
| AAPL | 營收 478.83B／淨利 132.175B／EPS 8.98／毛利率 48.79%／ROE 117.92%／負債比 72.29%／營收 YoY +15.06% |
| 資料字典 | 26 欄位，`example=null` 為 **0** |
| 解讀 | `mode: rule`，5 個 findings（inflation/rates/labor/activity/external） |
| 港股 `0700.HK` | HTTP 200，`NOT_APPLICABLE`，前端顯示警告非錯誤 |

---

## 附錄：檔案對照

| 檔案 | 職責 | 行數 |
|---|---|---|
| `lib/fred.js` | FRED CSV 抓取、解析、YoY、百分位 | 452 |
| `lib/sec.js` | CIK 解析、XBRL 概念優先序、期間分類、TTM 推導 | 643 |
| `lib/fomc.js` | FOMC 行事曆 HTML 解析與驗證 | 197 |
| `lib/macro.js` | 快取編排、資料字典組裝、端點資料聚合 | 329 |
| `lib/interpret.js` | 規則引擎、LLM 潤飾與幻覺防護 | 706 |
| `server.js` | 4 個端點的路由與信封 | 679–773 |
| `public/macro.js` | 頁面控制器、渲染、格式化 | 789 |
| `public/styles.css` | 宏觀模組樣式 | 新增 ~540 |
| `tests/macro-unit.cjs` | 離線單元測試 | 1202（90 測試） |
| `tests/e2e-macro.mjs` | 瀏覽器 E2E | 490（82 檢查） |
