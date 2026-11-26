# Trading Economics API 評估 — CPI 資料的「取得」與「更新」

| 項目 | 內容 |
|---|---|
| 評估日期 | 2026-11-26 |
| 評估對象 | Trading Economics API（`api.tradingeconomics.com`） |
| 核心問題 | 是否支援 CPI 的「取得」與「更新」 |
| 結論（先講） | **取得：支援。更新（寫入）：不支援，且架構上不可能。** |
| 實測依據 | 本文所有 HTTP 狀態碼與端點行為皆為當日實測，非文件轉述 |
| 對應專案現況 | 本專案 CPI 目前走 FRED（`CPIAUCSL`／`CPILFESL`），未依賴 TE |

---

## 摘要：一句話回答

**Trading Economics 的 API 是純讀取（read-only）的資料下載介面，不存在任何寫入端點。**

那個看起來像「更新」的 `/updates` 端點，回傳的是**Trading Economics 自己**何時更新了哪條序列的時間戳，不是讓你更新資料。它是「增量拉取」的輔助工具，仍屬讀取。

> 方向極易誤解：「API 可以更新」的正確意思是「**TE 更新後，你能拉到他更新了什麼**」，不是「你能透過 API 更新 TE 的資料」。

---

## 1. 可用端點（與 CPI 相關）

所有端點皆為 `GET`，base 為 `https://api.tradingeconomics.com`。

### 1.1 取得 CPI 數值

| 端點 | 用途 | 說明 |
|---|---|---|
| `/country/{country}` | 該國**全部**指標快照 | 回傳陣列，含 CPI、通膨率等；資料量大，需自行篩 `Category` |
| `/country/{country}?group=prices` | 該國**物價類**指標 | **實務首選**。CPI 屬 `prices` 類，大幅縮小回應 |
| `/country/{country}/{indicator}` | 指定指標 | 如 `/country/united states/inflation rate` |
| `/country/all/{indicator}` | **所有國家**的同一指標 | 跨國 CPI 比較用 |
| `/country/ticker/{ticker}` | 以 TE 內部代碼取得 | 官方文件範例為失業率的 `usurtot`；**CPI 的代碼本文不做推測**，請以 `/indicators` 或 `/country/{country}?group=prices` 回傳的 `HistoricalDataSymbol` 為準（TE 未公開完整代碼對照表） |
| `/historical/country/{country}/indicator/{indicator}` | **歷史序列** | CPI 時間序列的主力端點 |
| `/historical/country/{country}/indicator/{indicator}/{d1}/{d2}` | 指定日期範圍的歷史 | `d1`/`d2` 格式 `yyyy-mm-dd` |

### 1.2 探索可用指標與國家

| 端點 | 用途 |
|---|---|
| `/indicators` | 列出**所有**可用指標（`Category` + `CategoryGroup`） |
| `/indicators?calendar=1` | 只列有行事曆（會定期發布）的指標 |
| `/country` | 列出所有國家（含 `ISO3`／`ISO2`） |
| `/country/{country}/indicator` | 該國有哪些指標可用 |

### 1.3 「更新」相關（**皆為讀取**）

| 端點 | 實際語義 |
|---|---|
| `/updates` | TE 最近更新了哪些序列（全域） |
| `/updates/{date}?time={hh:mm}` | 指定時點之後的更新 |
| `/updates/country/{country}` | 該國的更新紀錄 |
| `/updates/country/{country}/{date}` | 該國指定日期後的更新 |
| `/historical/updates?d1=&d2=` | 歷史資料的更新紀錄（可在期間內篩選） |
| `/historical/updates?lu={date}` | 以「最後更新日」篩選 |

`/updates` 回傳只有四個欄位：

```json
[
  { "Country": "Tanzania", "Category": "Inflation Rate",
    "HistoricalDataSymbol": "TANZANIAIR", "LastUpdate": "2023-10-09T17:17:49.073" }
]
```

**這四個欄位裡沒有任何「值」**——它只告訴你「哪條序列在什麼時候被動過」，要拿值還得再打一次快照或歷史端點。這正是它屬於讀取的鐵證。

### 1.4 不存在的端點

以下端點是「你以為會有、但官方文件沒有」的，別浪費時間找：

- ❌ `POST /country/{country}`（寫入指標值）
- ❌ `PUT /historical/...`（修改歷史值）
- ❌ `POST /indicators`（新增自訂指標）
- ❌ REST 版的「訂閱推送」（推送走的是另一套 WebSocket：`wss://stream.tradingeconomics.com`，且只涵蓋行事曆與市場報價，**不含 CPI 這類指標的歷史值寫入**）

---

## 2. 必要與選用參數

### 2.1 認證參數（必要）

| 參數 | 位置 | 格式 | 說明 |
|---|---|---|---|
| `c` 或 `client` | query string | 你的 API key | 如 `?c=abc123` |
| `Authorization` | HTTP header | 你的 API key | 與上者二選一，建議用 header（避免金鑰留在 log） |

> **注意**：TE 的 header 認證是**直接放 key**，不是 `Bearer {key}`。實測無 key 呼叫回：

```
HTTP 401
You must provide a valid authorization. Contact Us: https://tradingeconomics.com/contact.aspx?subject=api+error
```

### 2.2 國家／地區代碼

| 寫法 | 範例 | 說明 |
|---|---|---|
| 國名（小寫、空格用 `%20` 或 `-`） | `united states`、`mexico`、`south korea` | 最直觀，建議用此 |
| 多國逗號分隔 | `mexico,sweden` | 一次取多國 |
| `all` | `/country/all/gdp` | 所有國家 |
| ISO3／ISO2 | `USA`／`US` | 文件未明確保證路徑可用，**建議先用 `/country` 取得官方國名** |

**實務建議**：不要自己猜國名拼法。先打一次 `/country` 拿到官方清單（含 `ISO3`、`ISO2`），在本機建一張對照表。這是因為「South Korea」在 TE 是 `south korea` 而非 `korea`，寫錯會回空陣列而不是報錯——**空陣列最難查**。

### 2.3 指標／分類參數

| 參數 | 值 | 說明 |
|---|---|---|
| `{indicator}` | 指標名稱 | CPI 相關：`inflation rate`、`core inflation rate`、`cpi`、`food inflation`、`core cpi` |
| `{ticker}` | TE 內部代碼 | 需查 `/indicators`；穩定性高於名稱，但無公開對照表 |
| `group` | `prices`／`gdp`／`labour`／`trade`／`money`／`government`／`housing`／`consumer`／`business`／`health`／`markets`／`taxes`／`climate` | 取「物價類」用 `prices` |

**CPI 最常用的三個指標名**（建議以此為起點）：

| 指標 | 典型 `Category` | 單位 |
|---|---|---|
| 整體 CPI 年增率 | `Inflation Rate` / `CPI YoY` | `percent` |
| 核心 CPI 年增率 | `Core Inflation Rate` | `percent` |
| CPI 指數（水準值） | `CPI` | `Index` |

> **陷阱**：各國對「CPI」的命名不一致。有些國家 `inflation rate` 就是 CPI 年增率，有些另有 `CPI` 指數。**必須先打 `/country/{country}?group=prices` 看實際 `Category` 名稱**，不要假設。

### 2.4 時間範圍參數（僅歷史端點）

| 參數 | 格式 | 說明 |
|---|---|---|
| `/{d1}/{d2}` | `yyyy-mm-dd` | 路徑參數，如 `/2020-01-01/2026-11-26` |
| `d1` / `d2` | `yyyy-mm-dd` | `/historical/updates` 用的 query 參數 |
| `lu` | `yyyy-mm-dd` | 以「最後更新日」篩選 |

### 2.5 格式參數

| 參數 | 值 | 說明 |
|---|---|---|
| `f` | `json`（預設）／`csv`／`html` | **官方 get started 頁寫「JSON or CSV」**，但多數端點文件同時示範 HTML |

> **重要：CSV 與 JSON 的數值欄位名不同！**
>
> | 格式 | 數值欄位 |
> |---|---|
> | JSON | `Value`（歷史端點）／`LatestValue`（快照端點） |
> | CSV | **`Close`** |
>
> 文件原句：「*Python package response field returns Value instead of 'Close'」*。若你的解析器同時吃 JSON 與 CSV，**必須處理這個欄名差異**，否則 CSV 那條路會拿到 `undefined`。

---

## 3. 回傳格式與欄位

### 3.1 快照端點（`/country/{country}`）的完整欄位

> **此處示範的是「欄位名稱與型別」，數值僅為示意**，不是任何一國的真實資料。寫解析器時請只依賴欄名，不要抄數值。

```json
[{
  "Country": "United States",
  "Category": "Inflation Rate",
  "Title": "United States Inflation Rate",
  "LatestValueDate": "2026-09-30T00:00:00",
  "LatestValue": 3.72,
  "Source": "U.S. Bureau of Labor Statistics",
  "SourceURL": "https://www.bls.gov/",
  "Unit": "percent",
  "URL": "/united-states/inflation-rate",
  "CategoryGroup": "Prices",
  "Adjustment": "NSA",
  "Frequency": "Monthly",
  "HistoricalDataSymbol": "{{請以 /indicators 查得的實際代碼填此}}",
  "CreateDate": "2012-02-23T11:41:00",
  "FirstValueDate": "1914-01-31T00:00:00",
  "PreviousValue": 3.91,
  "PreviousValueDate": "2026-08-31T00:00:00",
  "HighestValue": 23.7,
  "HighestValueDate": "1920-06-30T00:00:00",
  "LowestValue": -15.8,
  "LowestValueDate": "1921-06-30T00:00:00"
}]
```

| 欄位 | 型別 | 含義 | 使用注意 |
|---|---|---|---|
| `Country` | string | 國名 | 與你請求的寫法可能不同（正規化後） |
| `Category` | string | 指標名稱 | **各國命名不一**，程式判斷應以此為準 |
| `Title` | string | `Country` + `Category` | 顯示用 |
| `LatestValueDate` | string | **最新值所屬期間**（UTC） | 這是「資料期間」，不是「發布時間」 |
| `LatestValue` | number | 最新值 | 可能是 `null` |
| `Source` | string | 原始統計機構 | 如 BLS，可作可信度參考 |
| `SourceURL` | string | 原始來源網址 | 建議在 UI 顯示，利於回溯 |
| `Unit` | string | 單位 | `percent`／`Index`／`USD Billion` 等，**不可自行假設** |
| `URL` | string | TE 網頁路徑 | 可組 `https://tradingeconomics.com{URL}` |
| `CategoryGroup` | string | 大類 | `prices` 用於篩 CPI |
| `Adjustment` | string | 季節調整 | `SA`／`NSA`／`Current USD`／空字串。**比較時必須同 adjustment** |
| `Frequency` | string | 頻率 | `Monthly`／`Yearly`／`Quarterly`／`Daily` |
| `HistoricalDataSymbol` | string | TE 內部序列代碼 | 與 `ticker` 端點搭配用 |
| `CreateDate` | string | 加入 TE 資料庫的時間 | 餵給模型時**不可**當資料時點 |
| `FirstValueDate` | string | 該序列最早資料 | 判斷可回溯長度 |
| `PreviousValue` | number | 前一期值 | 算 MoM 變化用 |
| `PreviousValueDate` | string | 前期所屬期間 | |
| `HighestValue` / Date | number/string | 歷史最高與其日期 | 百分位計算可用 |
| `LowestValue` / Date | number/string | 歷史最低與其日期 | |

### 3.2 歷史端點的欄位差異

```json
[
  { "Country": "Mexico", "Category": "GDP", "DateTime": "2022-12-31T00:00:00",
    "Value": 1414.19, "Frequency": "Yearly",
    "HistoricalDataSymbol": "WGDPMEXI", "LastUpdate": "2023-06-30T15:54:00" }
]
```

| 差異 | 快照端點 | 歷史端點 |
|---|---|---|
| 日期欄位 | `LatestValueDate` | **`DateTime`** |
| 數值欄位 | `LatestValue` | **`Value`**（CSV 為 `Close`） |
| 更新時間 | 無 | **`LastUpdate`**（TE 何時寫入/修訂） |
| 單位／來源 | 有 | **無**（需回頭查快照） |

> **`DateTime` 的語義陷阱**：對月頻 CPI，`2026-09-30T00:00:00` 通常代表「2026 年 9 月」，但**日的部分不可靠**（可能是月末、月初或發布日）。做月對月 YoY 對齊時，**只取年月**，不要用完整日期做加減。
>
> 這一點與本專案 FRED 的處理一致——FRED 的 `CPIAUCSL` 也用「月初日期」代表月份，YoY 必須用「同月」對齊而非「365 天前」。

### 3.3 三種格式的取捨

| 格式 | 優點 | 缺點 | 建議 |
|---|---|---|---|
| **JSON** | 欄位完整、型別明確、有 `LastUpdate` | 體積較大 | **首選** |
| **CSV** | 體積小、易入 Excel | 數值欄名變 `Close`、日期變地區格式（`12/31/2020 12:00:00 AM`） | 批次匯出用 |
| **HTML** | 可直接貼報表 | 非結構化、解析脆弱 | 人工檢視用 |

---

## 4. 更新頻率與資料延遲

這裡要分成兩個完全不同的概念，混在一起就會做出錯誤的系統設計。

### 4.1 「資料本身的頻率」

| 指標 | 頻率 | 說明 |
|---|---|---|
| CPI／通膨率 | `Monthly`（月頻） | 多數國家 |
| 部分國家 CPI | `Quarterly` | 少數 |
| 市場報價類 | `Daily`／即時 | 與 CPI 無關 |

**CPI 是月頻**。這意味著：即使你每秒輪詢，一個月內也只會有 **1 次**真正的資料變化。輪詢頻率再高都不會讓資料變新。

### 4.2 「TE 的更新頻率」（`LastUpdate`）

`LastUpdate` 是 TE 自己寫入或修訂該筆資料的時間。**它與資料期間無關**。

實際會發生三種情況：

| 情況 | 表現 | 影響 |
|---|---|---|
| 正常發布 | `DateTime` 前進一個月，`LastUpdate` 為發布當天 | 正常 |
| **事後修訂** | `DateTime` **不變**，`LastUpdate` 更新 | 同一期間的值被改，若不重抓會一直用舊值 |
| 基期調整 | 整條歷史序列重算 | 所有歷史值都變，快取必須全部失效 |

> **這是 TE 相對 FRED 的一個優勢**：FRED 的 `fredgraph.csv` **不提供**「這筆資料何時被修訂」的欄位，只能靠重抓全量比對。TE 的 `LastUpdate` 讓你能做真正的增量更新。

### 4.3 發布延遲（真正的痛點）

`LatestValueDate` 與實際「可取得時間」之間有延遲，來源有三層：

| 延遲層 | 典型量級 | 說明 |
|---|---|---|
| 統計機構發布週期 | CPI 月頻，通常次月中旬公布上月 | BLS 約每月 10–15 日公布上月 CPI |
| TE 抓取與入庫 | 分鐘到數小時 | 取決於 TE 的排程 |
| 你的快取 | 你設定的 TTL | 自行控制 |

**結論**：`LatestValueDate` 落後「當前月份」1–2 個月是**正常現象**，不是資料壞了。

> **本專案的既有實測可佐證這個量級**：複驗當日（2026-11-26）直接拉 `fredgraph.csv?id=CPIAUCSL`，末四筆為 `2026-07`、`2026-08`、`2026-09`、`2026-10`——最新資料點是 **2026 年 10 月**，相對查詢時點落後約 1.5–2 個月。這與理論上的發布延遲一致。
>
> **注意這句本身也會過期**：不要把它當常數寫進程式或文件。任何把「最新 CPI 應該等於本月」寫進邏輯的程式都會誤報；正確做法是**永遠以回傳資料的最後一筆 `DateTime` 為準**，而不是以系統時鐘推算。

### 4.4 建議的快取策略

| 資料 | 建議 TTL | 理由 |
|---|---|---|
| 月頻 CPI 快照 | 6–24 小時 | 一個月才變一次，抓太勤純浪費配額 |
| 歷史序列 | 7 天 | 只有基期調整才會整條變 |
| `/updates` 檢查 | 1–6 小時 | 用 `LastUpdate` 判斷要不要重抓，省配額 |

> **配額意識**：標準方案每月僅 500 次請求（見 §5）。每天輪詢一次 CPI 就用掉 30 次/月。若監控 10 個國家 × 每天輪詢 = 300 次/月，**配額幾乎見底**。這就是為什麼必須用 `LastUpdate` 做條件式重抓，而不是無腦定時全抓。

---

## 5. 認證方式與使用限制

### 5.1 金鑰取得流程

1. 至 `tradingeconomics.com/api/pricing.aspx` 選方案
2. 訂閱後到 `developer.tradingeconomics.com` 取得 API key
3. 以 `?c={key}` 或 `Authorization: {key}` header 呼叫

### 5.2 實測的認證失敗行為（重要）

| 情況 | HTTP | 回應內容 |
|---|---|---|
| **無金鑰** | **401** | `You must provide a valid authorization. Contact Us: ...` |
| **`guest:guest`（舊訪客帳號）** | **410** | `We are sorry, but the guest account has been discontinued.` + 導向 pricing |
| **寫入方法**（POST/PUT/DELETE/PATCH） | **401** | 同上（認證先於方法檢查，故無法從狀態碼證明方法不支援——見下方說明） |

> **410 這個狀態碼值得記住**：本專案在評估 ISM PMI 時已踩過一次（`docs/ISM_PMI_接入方案.md` 記錄「Trading Economics ❌ 不可行：訪客帳號已停用 HTTP 410、API 需付費金鑰 HTTP 401」）。本次複驗**結論不變**。410 的語義是「資源永久不存在」，重試無用——這是專案既有的 `unavailable: 'retired'` 分類，不是 `transient`。

### 5.3 速率與配額限制（官方數字）

| 限制 | 數值 | 說明 |
|---|---|---|
| 請求速率 | **5 req/s**（官方）；部分第三方整理為 2 req/s | 官方要求**連續請求間隔至少 200ms** |
| 歷史資料單次上限 | **10,000 列** | 超過需用日期範圍分頁 |
| 行事曆單次上限 | **1,000 列** | |
| URL 長度上限 | **260 字元** | 多國多指標要拆成多次呼叫 |
| 試用帳號 | 100,000 資料點／100 次請求 | 試用期限制 |

> 速率數字有兩個版本（官方 5 req/s、第三方 2 req/s），**保守起見請按 2 req/s 設計**。這與本專案 SEC 模組的節流器思路一致（`lib/sec.js` 用 120ms 間隔 ≈ 8.3 req/s，官方限 10 req/s）。

### 5.4 方案差異

| 方案 | 月費 | 請求/月 | 序列匯出/月 | 指標 | 市場報價 | 新聞/警報 | 行事曆 | 即時串流 |
|---|---|---|---|---|---|---|---|---|
| **Standard** | $199（試用 $49/週） | **500** | 500 | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Professional** | $399（試用 $99/週） | **5,000** | 5,000 | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Enterprise** | 洽談 | 最高 **100 萬** | 最高 100 萬 | ✅ | ✅ | ✅ | ✅ | ✅ |

**關鍵觀察**：

1. **行事曆（Economic Calendar）的歸屬在定價頁上並不清楚，本文不敢下定論**。可以確定的是：Standard 與 Professional 的方案對照表都標示行事曆為 ❌，只有 Enterprise 明確標示 ✅。但 `/calendar` 端點確實存在且是官方主推功能之一，Professional 標 ❌ 看起來像是**對照表本身的可信度問題**（或另有加購項）。
   → **實務結論：若你的用途包含「CPI 公布時刻提醒」，在付費前必須直接向 TE 業務確認「哪個方案可用 `/calendar`、是否需加購」**。這是本節唯一會影響採購決策卻無法從公開頁面查證的項目，本文以「未經確認」標記，不做推測。
2. **500 次/月非常少**。以本專案 18 條宏觀序列計算，一輪全量抓取就用掉 3.6% 的月配額。
3. 價格與方案內容為評估日查得，**可能變動**，以官網為準。

### 5.5 對本專案的可行性判斷

| 面向 | 判斷 |
|---|---|
| 技術可行性 | ✅ 完全可行，REST + JSON，與現有 `lib/fred.js` 架構一致 |
| 成本 | ⚠️ $199/月起，且 500 次/月對 18 條序列偏緊 |
| 相對 FRED 的增益 | ① 有 `LastUpdate` 可做增量更新 ② 覆蓋 196 國（FRED 以美國為主）③ 有 `HighestValue`/`LowestValue` 可直接算百分位 |
| 相對 FRED 的劣勢 | FRED 免費、無限額、且本專案已完整實作並測試 |

**建議**：若只是要美國 CPI，**維持 FRED**。若要做**跨國 CPI 比較**或**需要修訂偵測**，TE 才有明顯價值，此時建議從 Professional（5,000 次/月）起，Standard 的 500 次會很快卡住。

---

## 6. 無法透過 API 更新的替代做法

既然 TE 不能寫入，而 CPI 原始資料本來就來自官方統計機構，替代方案要解決的是兩個不同問題：**(A) 我要的資料 TE 沒有**、**(B) 我要自己維護一份可更新的 CPI**。

### 6.1 方案比較（問題 A：取得 CPI）

| 方案 | 可行性 | 成本 | 更新方式 | 適合情境 |
|---|---|---|---|---|
| **FRED**（本專案現用） | ✅ **最高** | 免費 | 重抓 CSV，無修訂時間戳 | 美國 CPI；已實作、已測試 |
| **Trading Economics** | ✅ 高 | $199+/月 | `LastUpdate` 增量 | 跨國 CPI、需修訂偵測 |
| **BLS 官方 API** | ✅ 高 | 免費 | 需自行處理修訂 | 只做美國、要最原始資料 |
| **DBnomics** | ⚠️ 中 | 免費 | 聚合多源，穩定性看上游 | 免費跨國（本專案 ISM 曾用） |
| **Eurostat / OECD API** | ✅ 高（區域限定） | 免費 | 官方 SDMX | 歐元區／OECD 國家 |
| **各國統計局官網爬取** | ❌ **不建議** | 免費 | 極不穩定 | 已被本專案排除（反爬、格式常改） |
| **世界銀行 API** | ⚠️ 低 | 免費 | 年頻為主 | 長期結構分析，非月度 CPI |

### 6.2 為什麼不建議「爬官網」

本專案在 ISM PMI 的評估中已明確排除網頁爬取（`docs/ISM_PMI_接入方案.md`：ISM 官網有表單／反爬）。同理由適用於各國統計局：

- 版面一改就壞，且**壞了不會報錯**（抓到空值或錯位）
- 沒有 `LastUpdate`，無法判斷資料新舊
- 無法分辨「本月未發布」與「本月已發布但抓取失敗」

### 6.3 建議的架構（問題 B：自行維護可更新的 CPI）

若最終決定自建，建議三層設計，**與本專案既有的 `unavailable` 分類一致**：

```
① 抓取層（多源、可替換）
   FRED（美國，免費）→ 主源
   TE（跨國，付費）→ 補充源
   任一源失敗 → 標記 transient / blocked / retired，不當 0

② 正規化層
   統一為 { country, category, period(yyyy-mm), value, unit, adjustment, sourceUpdatedAt }
   ⚠️ period 只取年月，丟掉日（見 §3.2）
   ⚠️ adjustment 必須記錄（SA/NSA 不可混比）
   ⚠️ 空值一律 null，絕不補 0（否則圖表出現假跌）

③ 更新判定層（省配額的關鍵）
   有 lastUpdate → 比對上次儲存值，變了才覆寫
   無 lastUpdate（FRED）→ 比對最新期間 + 值，變了才覆寫
   兩者都只「下載後比對」，不做「上傳更新」
```

**核心觀念**：所謂「更新 CPI」，在你的系統裡永遠是 **「重新下載 → 比對 → 覆寫本地快取」**。不存在「把新 CPI 推回給資料源」這回事——因為你不是統計機構，資料源也不會接受你的寫入。

### 6.4 各方案可行性評分

| 方案 | 資料正確性 | 維護成本 | 長期穩定 | 綜合 |
|---|---|---|---|---|
| FRED（現況） | ★★★★★ | ★★★★★ | ★★★★★ | **★★★★★** |
| TE（付費） | ★★★★☆ | ★★★☆☆ | ★★★★☆ | ★★★☆☆ |
| BLS API | ★★★★★ | ★★★☆☆ | ★★★★☆ | ★★★★☆ |
| DBnomics | ★★★☆☆ | ★★★★☆ | ★★☆☆☆ | ★★★☆☆ |
| 爬官網 | ★★☆☆☆ | ★☆☆☆☆ | ★☆☆☆☆ | **★☆☆☆☆（不建議）** |

**最終建議**：**維持 FRED 作為美國 CPI 來源**（已實作、90+ 測試鎖定），TE 僅在明確需要跨國比較時才引入，且需先確認預算與行事曆權限。不要為了「有付費 API」而付費——本專案已驗證 FRED 的資料品質與穩定性完全足夠。

---
---

# 第二部分：個股分析中「AI 生成買賣建議」的設計

> **先講最重要的一句**：AI 不應該「生成」買賣建議，只應該「**解釋已經算好的**建議」。
>
> 原因是可驗證性。若讓模型直接看 K 線輸出「建議買進」，你無法回答「為什麼是現在」「憑什麼是這個價位」「同樣輸入會不會得到同樣答案」。這與本專案既有原則一致：**寧可沒有預測，也不要錯的預測**。

---

## 7. 所需輸入資料

本專案已有一個完整的技術面分析器（`lib/analyzer.js`），AI 層應**只吃它的輸出**，不自行取數。

### 7.1 輸入結構（取自 `analyze()` 實際回傳）

> 下表**逐欄對照 `lib/analyzer.js` 的 `return` 物件核對過**，不是憑印象列的。凡本文未列出的欄位，就是本文主張「不該餵給模型」的。

| 類別 | 欄位 | 用途 |
|---|---|---|
| **基本** | `meta.symbol`、`meta.name`、`meta.currency`、`meta.price`、`meta.exchange`、`meta.marketTime` | 標的識別與現價 |
| **技術指標** | `snapshot.mas`、`rsi`、`macd{dif,dea,hist}`、`atr`、`atrPct`、`boll{upper,mid,lower,bandwidthPct}`、`volume{last,ratio}`、`trendSlope` | 判斷趨勢與位階 |
| **價位** | `levels.supports[]`、`resistances[]`、`range20/60/252`、`fib` | 支撐壓力與區間 |
| **評分** | `score`（0–100）、`scoreBreakdown[]`（各因子與說明） | **建議的量化依據** |
| **結論** | `verdict{level,label,tone}` | 五級分類（見下） |
| **區間** | `buyZone{lower,upper,anchorPrice,anchorWhy,overlapCount,supporting[],stopLoss,target,riskReward,atr,positionHint}` | 可執行價位 |
| **機率** | `probabilities{probUp10,probUp20,probProfit,baseRate20,edge20,confidence,sampleSize}` | 統計期望，**必附樣本數** |
| **回測** | `backtest{samples,pending,horizons{10,20},recentTriggers[]}` | 歷史驗證強度 |
| **理由** | `rationale[]` | 規則層已寫好的說明 |

> **兩個容易寫錯的欄位（皆經核對）**：
> 1. **`meta` 沒有 `asOf`**。報價時點是 `meta.marketTime`（毫秒時間戳，三個資料源統一）。本文撰寫期間發現 `server.js` 曾寫成 `d.meta.asOf || null`，導致 `priceAsOf` **恆為 `null`**，已修正為 `marketTime` 並轉成 `YYYY-MM-DD`。
> 2. **`backtest` 沒有 `horizons` 以外的摘要欄位**，且 `horizons` 的 key 是數字 `10`／`20`（JS 物件中會變成字串），取值請用 `backtest.horizons[20]`。

### 7.1.1 各欄位的取值風險

| 欄位 | 風險 | 建議 |
|---|---|---|
| `meta.price` | 延遲報價（`dataSource` 註明「即時延遲報價」） | 顯示時必須同時標 `marketTime` |
| `probabilities.*` | 由回測樣本推得，非未來機率 | **一律附 `sampleSize`**，少於門檻不顯示 |
| `buyZone` | 由技術位推算，非預測 | 措辭用「參考區間」，不可寫成「目標價」 |
| `levels.supports/resistances` | 觸及次數少的價位不穩定 | 只取 `touches >= 2` 者給模型 |

### 7.2 既有的五級結論（`verdictOf`）

| score | level | label | tone |
|---|---|---|---|
| ≥ 72 | `buy` | 可分批佈局 | positive |
| ≥ 58 | `watch-buy` | 偏多，等回檔 | positive |
| ≥ 45 | `watch` | 中性觀望 | neutral |
| ≥ 32 | `caution` | 偏弱，暫不介入 | negative |
| < 32 | `avoid` | 弱勢，建議迴避 | negative |

**AI 層不得修改這五級的分界**。它只能解釋為什麼落在這一級，不能自己判定成另一級。這是防止「模型心情好就說買」的硬約束。

### 7.3 應該排除的輸入

| 不要餵 | 原因 |
|---|---|
| 原始 K 線陣列（數百根） | 模型無法可靠計算，只會產生看似合理的廢話 |
| 未來日期／財報預測日期 | 會誘發預測性語言 |
| 使用者的持倉成本、資金規模 | 會誘發「個人化建議」，法律風險升高 |
| 未經計算的新聞情緒分數 | 無法驗證，且與技術面混談會互相污染 |

---

## 8. 分析流程

採「**規則為骨、模型為皮**」四階段。前三階段完全不涉及模型。

```
① 取數（既有）
   Yahoo Finance → analyzer.analyze(symbol)
   產出 score / verdict / buyZone / probabilities / rationale

② 規則計算（既有，確定性）
   加權評分 → 五級 verdict → 買入區間 → 停損位
   ⚠️ 所有數字在此階段已固定，之後不可被改寫

③ 證據組裝（新增，確定性）
   把 ② 的結果整理成結構化 evidence[]：
   { key, label, value, unit, asOf, note }
   並計算 confidence（依 sampleSize 與指標齊備度）

④ 模型潤飾（選用，可關閉）
   只餵 ③ 的 evidence + ③ 的 verdict
   prompt 硬規則：只可改寫語氣、不可新增數字、不可改變結論
   後置檢查：輸出若出現 evidence 中沒有的數字 → 整段棄用
```

### 8.1 為什麼一定要有第 ③ 階段

若直接把 `analyze()` 的完整 JSON 丟給模型，會出兩個問題：

1. **模型會挑著講**——只提 MACD 黃金交叉，不提成交量萎縮。
2. **無法檢查幻覺**——輸出裡的數字太多，你沒有白名單可以比對。

先抽出 `evidence[]` 白名單，第 ④ 階段的後置檢查才有依據。做法與本專案 `lib/interpret.js` 的 `collectNumbers` 完全一致（白名單須含**所有餵給模型的文字**，否則正確引用會被誤判成幻覺）。

### 8.2 各階段的失敗處理

| 階段 | 失敗情況 | 處理 |
|---|---|---|
| ① | 歷史資料 < 40 根 | 直接報 `INSUFFICIENT_DATA`，**不進入後續**（既有行為） |
| ② | 單一指標算不出 | 該因子權重排除並記錄，`confidence` 降級 |
| ③ | 證據不足 3 條 | 標記 `low confidence`，前端明確顯示 |
| ④ | 逾時／無金鑰／含幻覺 | **靜默退回 ③ 的規則文字**，並說明原因 |

> **絕不可讓第 ④ 階段失敗導致整頁空白**。本專案已用同樣原則處理宏觀解讀：`llm.mode='rule'` + `note` 說明，主結果完整保留。

---

## 9. 建議的輸出格式

### 9.1 結構（JSON）

> **此為格式示意，數值不可當真**。範例中的 `symbol` 借用了 `AAPL`，但價格、MA20、機率等數字是為了展示「欄位該長什麼樣」而填的，**與 AAPL 的真實行情無關**（實測 AAPL 現價約 355.6，範例寫的 271.6 對不上）。實作時所有數字都必須由 `analyze()` 產生。
>
> `"mode"` 在實際回傳中是**單一值** `"rule"` 或 `"llm"`，不是這裡示範的 `"rule | llm"`（那是型別標註寫法）。

```json
{
  "symbol": "AAPL",
  "generatedAt": "2026-11-26T03:40:00.000Z",
  "mode": "rule | llm",
  "verdict": {
    "level": "buy",
    "label": "可分批佈局",
    "score": 72.4,
    "tone": "positive"
  },
  "action": {
    "buyZone": { "lower": 268.5, "upper": 274.2 },
    "stopRef": 259.8,
    "positionHint": "分 2–3 批，不一次性滿倉"
  },
  "evidence": [
    { "key": "rsi", "label": "RSI(14)", "value": 43.2, "unit": "", "asOf": "2026-11-25" },
    { "key": "ma20", "label": "MA20", "value": 271.6, "unit": "USD", "asOf": "2026-11-25" },
    { "key": "volRatio", "label": "成交量／20 日均量", "value": 0.78, "unit": "倍", "asOf": "2026-11-25" }
  ],
  "probability": {
    "horizonDays": 20,
    "probUp": 0.61,
    "baseRate": 0.54,
    "edge": 0.07,
    "sampleSize": 148,
    "confidence": "medium"
  },
  "narrative": "規則層：現價回落至 MA20 下方 0.6%，RSI 43 未超賣……",
  "llmText": null,
  "disclaimer": "本輸出為技術面統計結果，不構成投資建議。",
  "gaps": ["本益比（未提供股價）"],
  "unavailable": null
}
```

### 9.2 設計要點

| 要點 | 理由 |
|---|---|
| `verdict` 與 `narrative` **分開** | 前者是機器可讀的結論，後者只是解釋。前端不該從文字裡抓結論 |
| `action.buyZone` 用**區間**不用單一價 | 單一價位會誘導「掛單等它來」，區間才符合執行現實 |
| `probability` **必帶 `sampleSize` 與 `baseRate`** | 61% 的上漲機率若基準率是 54%，edge 只有 7%。不講基準率就是誤導 |
| `mode` 明確標示 | 使用者要知道這段是規則還是模型寫的 |
| `gaps` 列出算不出來的 | 「沒算」比「算錯」安全，但**必須說出來**，不能靜默省略 |
| `llmText` 與 `narrative` 並存 | 模型失敗時直接不顯示 `llmText`，`narrative` 仍在 |

### 9.3 前端呈現建議

| 元素 | 做法 |
|---|---|
| 結論徽章 | 五級分類 + 分數，紅漲綠跌配色（本專案既有慣例） |
| 買入區間 | 藍色標示（本專案已將藍色保留給「建議買入區間」，不可挪用） |
| 機率 | 顯示「61%（歷史基準 54%，樣本 148 次）」，**不可只顯示 61%** |
| 依據 | 逐條列出 evidence，可展開 |
| AI 段落 | 明確標「AI 改寫」徽章，與規則文字視覺區隔 |
| 免責 | **固定顯示，不可折疊隱藏** |

---

## 10. 風險揭露與適用限制

### 10.1 必須揭露的事實（不可省略）

| # | 事實 | 為什麼必須講 |
|---|---|---|
| R1 | 所有機率為**歷史統計**，非未來預測 | 「61% 上漲」聽起來像預測，實際是同類形態在過去的頻率 |
| R2 | **未計入交易成本** | 手續費、稅、滑價可能吃掉全部 edge。7% 的 edge 在高頻交易下可能為負 |
| R3 | 技術分析在**趨勢市有效、盤整市失效** | 本專案用 2 年日線，若標的長期橫盤，訊號品質會顯著下降 |
| R4 | **樣本數可能不足** | 信心分級取自 `composeProbabilities`：`n≥30` → `high`、`12≤n<30` → `medium`、`5≤n<12` → `low`、`n<5` → `insufficient`。**`n<12` 時機率已無統計意義，必須在 UI 明示** |
| R5 | 財報、政策、黑天鵝**不在模型內** | 純技術面無法預知突發事件 |
| R6 | 港股／美股**交易制度不同** | 漲跌幅限制、T+0/T+2、放空規則不同，同一套參數不可直接套用 |
| R7 | AI 文字**可能出錯** | 即使有防護，模型仍可能語意偏差（結論對但語氣誤導） |

### 10.2 適用限制

| 限制 | 說明 |
|---|---|
| **不適用於短線當沖** | 訊號基於日線，10/20 日 horizon，不是分鐘級 |
| **不適用於流動性差的標的** | 成交量低的股票，支撐壓力位不可靠、滑價大 |
| **不適用於重大事件前後** | 財報公布、FOMC、除權息前後，技術訊號會失真 |
| **不適用於全自動下單** | 本設計輸出「建議」而非「指令」，**沒有人工確認不應送單** |
| **不構成個人化建議** | 未考慮使用者的風險承受度、稅務、資金規模、投資期限 |

### 10.3 合規措辭（**建議版，尚未落地**）

以下是把既有兩句免責文字合併、並補上「未計入交易成本」後的**建議文案**。目前程式裡**沒有**這段文字，實施前請以實際 `public/index.html` 為準：

> ⚠️ **本工具輸出為技術面統計分析，不構成投資建議。**
> 所有機率均為歷史資料統計結果，不保證未來表現，且未計入交易成本。
> 市場有風險，請自行評估並控管部位。

本專案前端**已有兩處**免責文字（皆在 `public/index.html`），措辭略有不同：

| 位置 | 現有文字 |
|---|---|
| 行 155（主頁 `p.disclaimer`） | ⚠️ 本工具輸出為技術面統計分析，不構成投資建議。市場有風險，請自行評估並控管部位。 |
| 行 502（宏觀頁 `p.disclaimer`） | 本頁面所有價位與機率均為歷史資料統計結果，不保證未來表現，不構成投資建議。 |

> **注意**：上述兩句**都沒有提到「未計入交易成本」**（實測 `grep -c "交易成本" public/index.html` → 0）。而 R2 認為這是最容易誤導使用者的一項。若要在 AI 輸出強化揭露，**建議補上這一句而非另寫一套**——不一致的免責聲明本身就是風險。

### 10.4 讓 AI 建議「可被質疑」的三個機制

這是本設計與「叫 AI 猜漲跌」的根本差別：

| 機制 | 作用 |
|---|---|
| **每個結論都可回溯到 evidence** | 使用者能問「你憑什麼說偏多」，答案指向具體數值 |
| **同一份資料得到同一結果** | `mode=rule` 是可重現的，可被測試鎖定（本專案已用 94 項單元測試做到） |
| **模型不得引入新數字** | 後置白名單過濾，出現來源沒有的數字就整段棄用 |

---

## 附錄：本文實測指令

> 以下指令於 **2026-11-26 複驗通過**（401 / 410 / 401 皆重現）。若你的環境有 HTTP 代理，`curl` 會被代理攔截而得到 `os error 10061` 之類的連線錯誤——請加 `--noproxy '*'`，那是環境問題，不是 TE 的行為。

```bash
# 1. 無金鑰 → 401（證明需付費金鑰）
curl -s -m 20 --noproxy '*' -o /dev/null -w "%{http_code}\n" \
  "https://api.tradingeconomics.com/country/united%20states/inflation%20rate"

# 2. 舊訪客帳號 → 410（證明已停用，重試無用）
curl -s -m 20 --noproxy '*' -w "\n%{http_code}\n" \
  "https://api.tradingeconomics.com/country/united%20states/inflation%20rate?c=guest:guest"

# 3. 寫入方法 → 401（認證先於方法檢查，故無法由狀態碼證明；
#    方法不支援的結論來自官方文件僅記載 GET 與「下載」語義）
for m in GET POST PUT DELETE PATCH; do
  echo -n "$m -> "
  curl -s -m 15 --noproxy '*' -o /dev/null -w "%{http_code}\n" -X $m \
    "https://api.tradingeconomics.com/country/united%20states/inflation%20rate"
done
```

**官方文件依據（評估日的原文要點）**：

| 來源 | 原文要點 |
|---|---|
| `tradingeconomics.com/api/` | 「allows clients to **download** millions of rows of historical data, to **query** our real-time economic calendar and **subscribe to updates**」——全為下載／查詢／訂閱，無寫入 |
| `docs.tradingeconomics.com/get_started/` | 認證可用 `c`／`client` URL 參數或 `Authorization` header；格式支援 JSON、CSV |
| `docs.tradingeconomics.com/indicators/latest_updates/` | `/updates` 回傳「a list of the latest updates, additions, or revisions **applied to** datasets」——被動語態，由 TE 施加 |
| `docs.tradingeconomics.com/get_started/rate-limits/` | 5 req/s、最小間隔 200ms、歷史單次 10,000 列、行事曆 1,000 列、URL 260 字元 |
| `tradingeconomics.com/api/pricing.aspx` | Standard $199／500 請求；Professional $399／5,000；Enterprise 最高 100 萬 |
