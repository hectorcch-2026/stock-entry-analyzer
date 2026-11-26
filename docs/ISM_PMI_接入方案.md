# ISM 製造業 PMI 雙源接入方案

> 實作：`scripts/ism_pmi_pipeline.py`　測試：`scripts/test_ism_pmi_pipeline.py`
> 撰寫日期：2026-11-26　環境：Python 3.13.14 / dbnomics 1.2.7 / akshare 1.20.70 / pandas 3.1.0

---

## 0. 一頁摘要

| 項目 | 結論 |
|---|---|
| 主源 DBnomics `ISM/pmi/pm` | **可連線、可拉取 68 筆**，但**自 2025-09 起數值損壞**（11.1/10.0/10.0/10.3） |
| 備援 AKShare `ak.macro_usa_pmi()` | **接口已於 1.20.42 移除**，AKShare 已無任何美國 ISM/PMI 函式 |
| 目前可取得的最新「可信」值 | **2025-08 = 48.7**（歷史值，距今 15 個月） |
| 管線狀態 | 已實作完成、35 個單元測試全通過；每次執行輸出 `status=critical` + `is_stale=true` |
| 核心設計取捨 | **寧可回報「資料壞了」，也不把 10.3 當成 PMI 送給下游** |

兩源目前都無法提供當期讀數，這是**資料來源的客觀現況**，不是程式缺陷。管線的價值在於：
把這件事變成機器可判讀的結構化告警，並在任一源修復後**自動恢復**正常比對，無需改程式。

---

## 1. 需求與設計目標

使用者要求的六項能力，逐一對應到實作位置：

| # | 需求 | 實作 |
|---|---|---|
| 1 | 以序列代碼取得資料的函式 | `fetch_dbnomics(series_id="ISM/pmi/pm")` |
| 2 | 欄位正規化與時間對齊 | `to_month()` / `SeriesPoint` / `months_between()` |
| 3 | 交叉驗證比對邏輯 | `compare_sources()` |
| 4 | 例外與重試處理 | `retry_call()` + 各 `fetch_*` 的 try/except |
| 5 | 每月第一個工作日 10:00 美東觸發 | `first_business_day()` / `now_eastern()` / `--watch` / cron |
| 6 | 不一致／缺漏／失敗時明確警示 | 9 種告警代碼，見 §5 |

---

## 2. 架構

```
                    ┌──────────────────────────────┐
                    │  run_once()                  │
                    │  每月第一個工作日 10:00 ET   │
                    └───────────┬──────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
    ┌──────────────────┐                ┌──────────────────┐
    │ fetch_dbnomics() │                │  fetch_akshare() │
    │ ISM/pmi/pm       │                │ macro_usa_pmi()  │
    └────────┬─────────┘                └────────┬─────────┘
             │ 重試+退避                          │ 重試+退避
             ▼                                   ▼
    ┌──────────────────┐                ┌──────────────────┐
    │ FetchResult      │                │ FetchResult      │
    │ points[]         │                │ ok=False         │
    └────────┬─────────┘                └────────┬─────────┘
             └─────────────┬─────────────────────┘
                           ▼
              ┌────────────────────────────┐
              │  compare_sources()         │
              │  ① 拉取成敗 ② 期間         │
              │  ③ 數值     ④ 拉取時間     │
              │  ⑤ 合理性／新鮮度          │
              │  ⑥ 決定建議值              │
              └────────────┬───────────────┘
                           ▼
              ┌────────────────────────────┐
              │  StatusReport              │
              │  → print_report()          │
              │  → latest.json + 歷史檔    │
              │  → 退出碼 0/1/2            │
              └────────────────────────────┘
```

**為什麼要兩輪選值**：早期版本「先碰到合理值就採用」，會讓尾段損壞的主源（修剪後仍有 2025-08=48.7）
打敗完整健康的備援源。現在分兩輪——整條乾淨的優先，其次才是修剪出的歷史值。這是本次修正的實質 bug，
由 `test_implausible_primary_falls_back_to_clean_backup` 守住。

---

## 3. 資料模型

正規化後的最小單位是 `SeriesPoint`，所有來源都收斂到這個形狀：

```python
@dataclass
class SeriesPoint:
    period: str      # 一律 YYYY-MM
    value: float
    source: str      # "dbnomics" | "akshare"
    fetched_at: str  # ISO 8601 UTC
```

**時間對齊以「月」為單位**，而非日粒度。原因：兩源的日期欄一個是 `2025-08-01`（DBnomics 已正規化）、
一個是 `2025年08月份` 等中文格式；若比對到日，會因為「月初 vs 月底」的表示差異產生假不一致。
`to_month()` 支援 6 種實測格式：

| 輸入 | 輸出 |
|---|---|
| `2025-08-01` | `2025-08` |
| `2025-08` | `2025-08` |
| `2025/08/01` | `2025-08` |
| `2025年08月份` | `2025-08` |
| `2025年8月` | `2025-08` |
| `2025-08-01 00:00:00` | `2025-08` |

---

## 4. 兩源實測結果

### 4.1 主源 DBnomics

```python
from dbnomics import fetch_series
df = fetch_series("ISM/pmi/pm")   # 68 × 12
```

回傳欄位含 `period`（已正規化 `2025-08-01`）與 `original_period`（`2025-08`）。
**無需任何網頁反爬處理**——走的是官方 JSON API（`api.db.nomics.world/v22`）。

但資料本身有問題：

| 期間 | 數值 | 判定 |
|---|---|---|
| 2025-08 | 48.7 | ✅ 唯一可信的最新值 |
| 2025-09 | **11.1** | 🚨 不可能 |
| 2025-10 | **10.0** | 🚨 不可能 |
| 2025-11 | **10.0** | 🚨 不可能 |
| 2025-12 | **10.3** | 🚨 不可能 |

**為何能斷定是資料錯誤而非「製造業真的崩了」**：PMI 是擴散指數，榮枯線固定 50，
理論下限為 0 但實務上從未低於 30（2008-12 金融海嘯最低 34.5）。
本資料集 2020-05 起 64 筆合理值全部落在 **43.1 ~ 63.7** 之間，無一例外。
同時 12 個分項（`neword`/`production`/`employment`/`prices`/...）在 2025-08→2025-09 之間**全部平滑連續**，
只有主序列 `pmi` 斷裂（48.7→11.1，跳 37.6 點）。這排除「換源／改單位／全表重算」，
指向**單一欄位抓取錯誤**。

### 4.2 備援 AKShare

```python
import akshare as ak
hasattr(ak, "macro_usa_pmi")   # → False（1.20.70）
```

**已於 1.20.42 移除**。原因：金十數據 2025-09 停止更新 `datacenter.jin10.com` 經濟指標頁面、
遷移至微信小程序，官方明示「美国、欧元区的其余指标暂无替代接口」。

AKShare 內已無任何美國 ISM/PMI 函式（`macro_usa_pmi`、`macro_usa_ism_pmi`、
`macro_usa_services_pmi` 的 `hasattr` 全為 False），僅剩中國 PMI 相關函式。

因此 `fetch_akshare()` 會回傳 `ok=False` 並附上完整原因，**不會中斷流程**。
若未來 AKShare 恢復該函式，本模組無需修改即可自動開始真正比對。

---

## 5. 告警代碼

| 代碼 | 級別 | 觸發條件 | 下游該做什麼 |
|---|---|---|---|
| `PRIMARY_FETCH_FAILED` | 🚨 critical | 主源連線／解析失敗 | 檢查網路或 DBnomics 服務狀態 |
| `BACKUP_UNAVAILABLE` | ⚠️ warning | 備援源不可用 | 已知狀況，無替代接口 |
| `PERIOD_MISMATCH` | ⚠️ warning | 兩源最新月份不同 | 其中一源尚未更新，等下輪 |
| `VALUE_MISMATCH` | 🚨 critical | 同月數值差 > 0.05 | **需人工確認哪一源正確** |
| `DBNOMICS_IMPLAUSIBLE` | 🚨 critical | 數值超出 [30, 80] 或單月跳 > 20 | 不可使用該源數值 |
| `AKSHARE_IMPLAUSIBLE` | 🚨 critical | 同上（備援源） | 同上 |
| `DBNOMICS_STALE` / `AKSHARE_STALE` | ⚠️ warning | 最新月份距今 > 90 天 | 資料過期，非當期讀數 |
| `ONLY_TRIMMED_HISTORY` | ⚠️ warning | 僅能修剪出歷史值 | **這是歷史值，不可當月讀數用** |
| `NO_USABLE_VALUE` | 🚨 critical | 兩源皆無合理值 | 完全無資料 |

設計要點：**告警是結構化資料**（`level` + `code` + `message`），不是只有人類可讀的字串。
`code` 可直接餵給監控系統做路由，`message` 給人看。

---

## 6. 合理性防線（本方案的核心）

三道檢查，缺一不可：

1. **值域檢查**：`30 ≤ PMI ≤ 80`，超出即判不合理。
2. **跳動檢查**：單月變動 > 20 點視為可疑（歷史最大單月波動約 15 點）。
3. **新鮮度檢查**：最新月份距今 > 90 天視為過期。

`drop_implausible()` 採「從最新月往前掃，遇到第一個不合理值就砍掉它與其後所有值」的策略，
因為資料損壞通常是「從某月開始一路錯下去」，而非單點跳動。

**關鍵設計**：當兩源尾段都損壞時，管線**不會**回傳 `None`，而是回傳最後一個可信的歷史值
並標記 `recommended_is_stale=true`。理由：`None` 讓下游無法區分「沒資料」與「資料壞了」，
而明確的歷史值 + 過期旗標能讓下游做出正確判斷。輸出 JSON 長這樣：

```json
"recommended": {
  "value": 48.7,
  "period": "2025-08",
  "source": "dbnomics",
  "is_stale": true,
  "note": "已過期，僅為最後一個可信的歷史值，不可視為當月最新值"
}
```

---

## 7. 排程：每月第一個工作日 10:00 美東

### 7.1 兩個容易出錯的地方

**① 第一個工作日 ≠ 1 號。** ISM 在「每月第一個**工作日**」發布，而 1 號可能是週末或聯邦假日：

| 年月 | 1 號狀況 | 正確的第一個工作日 |
|---|---|---|
| 2026-01 | 元旦（週四） | **2026-01-02（週五）** |
| 2026-08 | 週六 | **2026-08-03（週一）** |
| 2027-01 | 元旦（週五） | **2027-01-04（週一）** |

若只排除週末，2026-01 會排在元旦當天執行——比 ISM 發布**早一天**，比對必然拿到舊資料。

**② 美東不能寫死 UTC-5。** 3 月第二個週日至 11 月第一個週日為 EDT（UTC-4），
其餘為 EST（UTC-5）。用固定 UTC-5 會讓夏令時期間的排程**晚一小時**到 11:00 ET。
實作改用 `zoneinfo.ZoneInfo("America/New_York")`，自動處理切換。

### 7.2 觸發方式

標準 cron 無法表達「第一個工作日」，因此採「1~3 日都觸發 + 程式內部過濾」：

```cron
CRON_TZ=America/New_York
0 10 1-3 * * cd /path/to/repo && python -m ism_pmi_pipeline --once --business-day-guard
```

`--business-day-guard` 會用美東時間判斷今天是否為當月第一個工作日，不是就靜默跳過（退出碼 0）。

不想用系統排程時，可直接長駐：

```bash
python scripts/ism_pmi_pipeline.py --watch   # 每分鐘檢查，命中才執行，同月只跑一次
```

`--watch` 在 10:05 觸發（而非 10:00），留 5 分鐘緩衝讓資料源完成更新。

---

## 8. 使用方式

```bash
python scripts/ism_pmi_pipeline.py --once            # 跑一次，印出報告
python scripts/ism_pmi_pipeline.py --check-env       # 檢查依賴與兩源可用性
python scripts/ism_pmi_pipeline.py --health          # 有問題時退出碼 1（適合監控）
python scripts/ism_pmi_pipeline.py --install-cron    # 印出排程安裝說明
python scripts/ism_pmi_pipeline.py --no-write        # 只印出，不寫檔
python scripts/test_ism_pmi_pipeline.py              # 35 個單元測試
```

退出碼約定：

| 碼 | 意義 |
|---|---|
| 0 | `status == "ok"` |
| 1 | `--health` 且狀態非 ok |
| 2 | 一般執行且 `status == "critical"` |

輸出檔：`data/ism_pmi/latest.json`（最新狀態）+ `data/ism_pmi/run_<timestamp>.json`（歷史留痕）。

---

## 9. 目前狀態與後續

### 9.1 現況

```
[OK ] dbnomics  筆數=68   最新=2025-12 = 10.3     耗時=6920ms
[FAIL] akshare  筆數=0    最新=—                  耗時=2682ms

【建議採用值】
  2025-08 = 48.7 （來自 dbnomics）  ⚠️ 已過期（非當期值）

【警示】
  ⚠️ [BACKUP_UNAVAILABLE]
  🚨 [DBNOMICS_IMPLAUSIBLE] 4 筆超出合理值域 [30.0, 80.0]
  ⚠️ [DBNOMICS_STALE] 最新月份 2025-12 距今 360 天
  ⚠️ [ONLY_TRIMMED_HISTORY]
```

### 9.2 要拿到當期 PMI，只能換來源

以下方案已評估，**都不在本次雙源架構內**，若需要請另行確認：

| 方案 | 可行性 | 障礙 |
|---|---|---|
| ISM 官網 `ismworld.org` | 需網頁抓取 | 有表單／反爬，超出「不需反爬」的前提 |
| Trading Economics | ❌ 不可行 | 訪客帳號已停用（HTTP 410）、API 需付費金鑰（HTTP 401） |
| FRED `MANEMP` 等 | ❌ 不可行 | ISM 系列在 FRED 已下架（404），`MANEMP` 是就業人數非 PMI |
| 券商／Bloomberg 終端 | 需授權 | 有商業授權成本 |

**建議**：短期接受「PMI 不可得」，在報告中明確標註；中期若要串接，優先考慮 ISM 官方的
資料授權或既有付費終端，而非繼續在免費源之間尋找替代。

### 9.3 維護提醒

- 本模組**依賴自動恢復**：任一源修復後，`status` 會自動從 `critical` 轉為 `warn`/`ok`，無需改碼。
- 若 DBnomics 修正了 `pmi` 欄位，`DBNOMICS_IMPLAUSIBLE` 會消失，`ONLY_TRIMMED_HISTORY` 也會消失。
- 監控建議：對 `--health` 的退出碼做告警，或讀 `latest.json` 的 `status` 欄位。
