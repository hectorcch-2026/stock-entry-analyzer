# 部署到 Railway / Render

本專案零執行時依賴（`dependencies: {}`），只需 `node server.js`，並已綁定
`0.0.0.0:$PORT`，因此可直接部署到任何支援 Node 的 PaaS。

比 WorkBuddy 沙箱的優勢：**出網不受限**。實測 WorkBuddy 沙箱封鎖
`api.telegram.org` 與 Yahoo，導致線上發不出通知；Railway / Render 沒有此限制。

---

## 一、上傳到 GitHub

```bash
cd stock-entry-analyzer
git init
git add .
git commit -m "init: 股票量化分析專業介面"
git branch -M main
git remote add origin https://github.com/<你的帳號>/stock-entry-analyzer.git
git push -u origin main
```

> **提交前務必確認 `config.json` 沒有被推上去。** 它已在 `.gitignore` 中，
> 但請自行再確認一次：
> ```bash
> git status --porcelain | grep config.json   # 應該沒有輸出
> ```
> 若曾誤傳，請立即到 BotFather `/revoke` 換掉 token。

---

## 二、在 Render 部署（推薦，有免費方案）

1. 註冊 [render.com](https://render.com)，用 GitHub 帳號登入
2. **New → Web Service** → 選擇你的 repo
3. Render 會自動讀取 `render.yaml`，確認以下設定：
   - Runtime：`Node`
   - Build：`npm install`
   - Start：`node server.js`
   - Health Check：`/api/health`
4. 在 **Environment** 分頁加入兩個變數（必要）：

   | Key | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | 你的 Bot token（形如 `1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`，從 `config.json` 複製） |
   | `TELEGRAM_CHAT_ID` | 你的 chat id（同上，從 `config.json` 複製） |

5. 按 **Create Web Service**

首次部署約 1–2 分鐘。完成後你會拿到 `https://<name>.onrender.com`。

> **免費方案注意事項**
> - 閒置 15 分鐘後會休眠，下次訪問需約 30–50 秒冷啟動。
> - 若不能接受冷啟動，可升級付費方案，或改用 Railway（有 $5 試用額度）。

---

## 三、在 Railway 部署（更簡單，但需額度）

1. 註冊 [railway.app](https://railway.app)，用 GitHub 登入
2. **New Project → Deploy from GitHub repo** → 選你的 repo
3. Railway 會自動偵測 `Dockerfile` 並建置（無需任何設定）
4. 在 **Variables** 加入：

   ```
   TELEGRAM_BOT_TOKEN = 1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TELEGRAM_CHAT_ID   = 123456789
   ```
   （實際值從本機 `config.json` 複製；該檔已被 `.gitignore` 排除，不會進 repo）

5. **Settings → Networking → Generate Domain** 產生公開網址

Railway 不會休眠，冷啟動問題不存在；但免費額度用完後需付費（約 $5/月）。

---

## 四、部署後驗證

把 `<你的網址>` 換成實際域名：

```bash
# 1. 服務活著（最重要的一條）
curl https://<你的網址>/api/health
# 預期：{"ok":true,"service":"stock-entry-analyzer","time":...,"telegram":true}
#                                                          ↑ 必須是 true

# 2. 美股分析
curl "https://<你的網址>/api/analyze?symbol=AAPL"
# 預期含：score、verdict.label、buyZone.{lower,upper,stopLoss,target}、dataSourceKey:"yahoo"

# 3. 港股分析
curl "https://<你的網址>/api/analyze?symbol=0700.HK"
# 預期：currency 為 "HKD"，代表港股管線正常

# 4. 中文搜尋
curl "https://<你的網址>/api/search?q=騰訊"
# 預期：{"ok":true,"count":2,"results":[{"symbol":"0700.HK","name":"騰訊控股",...}]}

# 5. 真實發送 Telegram（會在你手機收到一則訊息）
curl -X POST https://<你的網址>/api/notify \
  -H "Content-Type: application/json" -d '{"symbol":"AAPL"}'
# 預期：{"ok":true,"mode":"telegram","message":"🔴 <b>Apple Inc.</b>（AAPL）..."}
```

**關鍵判別**：`/api/health` 的 `telegram` 欄位。
- `true` → 環境變數已正確注入，通知可用
- `false` → 變數沒設好，回到平台後台檢查

> 若第 1 條回 `telegram:false`，通常是變數名稱拼錯（區分大小寫）或值帶了多餘空白。
> 若第 5 條回 `mode:"simulated"`，同理——憑證沒生效，訊息只在本機產生、未實際送出。

### 本機已完成同等驗證

部署前我已在「只含 `server.js` / `package.json` / `lib` / `public`」的乾淨目錄中，
以**僅環境變數、沒有 `config.json`** 的方式啟動，實測結果：

| 項目 | 結果 |
|---|---|
| `/api/health` | `{"ok":true,...,"telegram":true}` |
| `/api/config` | `telegramConfigured:true` |
| AAPL | 354.07 USD · score 65 · 買入區 331.34~337.27 · 來源 yahoo |
| 0700.HK | 340.60 HKD · score 51.2 · 買入區 326.10~334.33 |
| 中文搜尋「騰訊」 | `count:2`（0700.HK 騰訊控股、1698.HK） |
| 靜態資源 | `/`、`/app.js`、`/styles.css`、`/manifest.webmanifest`、`/sw.js` 全部 200 |
| **真實 Telegram 發送** | **`ok:true`、`mode:"telegram"`、首行 `🔴 <b>Apple Inc.</b>（AAPL）`** |

這代表上傳到 Render / Railway 後，只要環境變數填對，功能就是立即可用的。

---

## 五、PWA 功能說明

部署在 Railway / Render 的 HTTPS 域名下，PWA 全部功能正常：

| 功能 | 狀態 |
|---|---|
| Service Worker | ✅（`sw.js` 已設 `no-cache`，更新會生效） |
| 加入主畫面（iOS） | ✅ 需 HTTPS，兩個平台都提供 |
| 離線瀏覽介面 | ✅ App Shell 預快取 |
| 離線看行情 | ⚠️ 僅 30 分鐘內的快取，過期主動丟棄 |

手機使用：Safari / Chrome 打開網址 → 分享 → 加入主畫面。

---

## 六、與 WorkBuddy 版的差異

| 項目 | WorkBuddy 沙箱 | Railway / Render |
|---|---|---|
| 行情來源 | 僅騰訊可達（Yahoo 429） | 三來源全部可達 |
| Telegram 通知 | ❌ 出網被封鎖 | ✅ 可用 |
| 冷啟動 | 無 | Render 免費方案有 |
| 雲服務（登入/資料庫） | ✅ 已啟用 | ❌ 換域名後失效 |
| 費用 | 由平台提供 | 需自行負擔 |

> **雲服務取捨**：WorkBuddy 的雲服務綁定精確 Origin，
> 換到 `<name>.onrender.com` 後登入與資料讀寫會被拒絕。
> 目前該應用**已激活雲服務環境，但程式碼尚未接入任何雲端功能**
> （登入、資料庫、檔案皆未使用），因此搬遷不會損失既有功能。
> 若後續需要使用者登入 / 收藏同步，需在目標平台自建
> （例如 Railway 的 PostgreSQL + 自寫認證）。

---

## 七、更新程式碼

推送即自動部署（兩個平台都預設開啟）：

```bash
git add .
git commit -m "fix: 調整買入區間計算"
git push
```

Render 約 1–2 分鐘完成，Railway 約 30–60 秒。

---

## 八、線上站台現況（Render）

- 網址：https://stock-entry-analyzer.onrender.com
- 來源：GitHub `hectorcch-2026/stock-entry-analyzer` 分支 `main`，`autoDeploy: true`
- 目前版本：見下方「版本記錄」
- 前端快取版本：Service Worker `v1.0.13`

### 版本記錄

| 版本 | 內容 |
|---|---|
| v1.7 | 宏觀數據層新增 **6 張走勢圖**（利率／利差／通膨／就業／生產／信心），折線只連實際觀測值、缺值斷線，長跨度序列以 LTTB 降採樣但保留極值；新增 **利率期貨模組**，用 CME 3 個月 SOFR 期貨（SR3）推出未來 8 季隱含利率，逐點附合約代碼／價格／報價日／來源連結，並顯示時間範圍、更新頻率與資料來源 |
| v1.6 | 個股新聞分析新增三塊：①「關鍵字與主題」自動提煉並分組；②「由關鍵字衍生的觀點」每條附支撐新聞原句與反向證據數；③「結構化匯報」含摘要／關鍵字／觀點／來源，可整份複製。三者皆為純函式、不依賴 LLM，`mode=rule` 時照常運作 |
| v1.5 | 個股頁改為 4 個子分頁（決策／技術／基本面／新聞）；新聞卡改為「AI 讀正文 + 看好／看跌雙欄 + 財務解讀」；修正新聞清單品質（剔除持股異動自動稿與非本檔公關稿、同一事件多來源合併、正文主體非標的時摘要作廢） |
| v1.4 | 更名「股票量化分析專業介面」；個股財報移至個股模塊；新增新聞 AI 分析、版塊輪動 × 宏觀 |
| v1.3 | Treemap 與 RRG 明細 |

> **v1.5 需要環境變數才能使用 LLM 解讀。** 本機的 `config.json`（已 gitignore）
> 不會上傳；Render 沒有金鑰時會自動落在規則層（`ai.mode === 'rule'`），
> 功能仍完整但解讀文字較機械。若要在線上啟用 LLM，請在 Render 的
> Environment 加入 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`。
>
> **v1.6 的三個新區塊不需要 LLM。** 關鍵字提煉、觀點生成、結構化匯報
> 全部由程式計算（`lib/news-keywords.js` + `lib/news-viewpoints.js`），
> 引文一律從正文原句抓取並經主體檢查，不會因沒有金鑰而缺席或降級。

> **v1.7 的走勢圖與利率模組也不需要 LLM。** 走勢圖由 FRED 歷史點直接繪製
> （`lib/macro-charts.js` + `public/macro-charts.js`），利率路徑由期貨報價換算
> （`lib/rates-forecast.js`）。三者都是確定性計算，`ai.mode === 'rule'` 時完全相同。
>
> **v1.7 的利率模組不是預測模型。** Fed 官方不公布未來利率路徑（點陣圖為匿名
> 預測，非委員會決議），因此本模組只把市場**已成交**的期貨價格換算成隱含利率，
> 每個點都附合約代碼、價格與報價日供回查。資料源實測：
> SR3 期貨 9 張合約全部有價（成交量 5–10 萬口），涵蓋到 2028-12；
> 30 天 Fed Funds 期貨（ZQ）只到 2027-12 且流動性低（最遠月僅 158 口），
> 僅用於交叉驗證。兩者在重疊季度上的基差為 4–22 bp，方向一致。

> 更新程式碼後，Render 約 30 秒～2 分鐘完成部署。可用下列指令確認新版是否已生效
> （`<title>` 會隨版本改變，比看時間戳可靠）：
>
> ```bash
> curl -s https://stock-entry-analyzer.onrender.com/ | grep -oE "<title>[^<]*</title>"
> ```

### 啟用 LLM 解讀（DeepSeek）

線上站台預設跑**規則層**（`ai.mode === 'rule'`）：所有數字由程式計算、解讀文字機械但完整。
要改用 LLM 改寫語氣，需在 Render 設定三個環境變數。

> **為什麼一定要用環境變數**：`config.json` 已列入 `.gitignore`，不會被部署到
> Render，所以線上的 LLM 只能從環境變數讀取。本機則是環境變數優先、`config.json` 次之。

**Render Dashboard → 該服務 → Environment → Add Environment Variable**

| Key | Value | 備註 |
|---|---|---|
| `LLM_BASE_URL` | `https://www.moyu.cn/v1` | 必須含 `/v1`；這裡是 OpenAI 相容端點 |
| `LLM_API_KEY` | `sk-…` | DeepSeek 金鑰；**只存在 Render，不進 repo** |
| `LLM_MODEL` | `DeepSeek-V4.1-flash` | 模型名需與供應商完全一致（含大小寫與版本號） |

另外兩個**必須**一起設（`render.yaml` 已預先寫好，手動設定時別漏）：

| Key | Value | 為什麼 |
|---|---|---|
| `LLM_DISABLE_THINKING` | `1` | 推理型模型會先產生 `reasoning_content`，且其 token **計入 `max_tokens`**。實測推理量在 1340–6167 之間波動，會把正文擠成空字串——症狀是「有金鑰、呼叫成功、但內文空白」。本專案只需分類與改寫語氣，關閉思考後延遲由 12–29 秒降到 1–2 秒 |
| `LLM_MAX_TOKENS` | `3000` | 關閉思考後 3000 足夠；若之後改回推理模型需調到 8000 |

**設定後驗證**（不要只看有沒有填值——填錯時「有值」也是 true）：

```bash
npm run verify:llm
```

這支腳本會檢查五件事，並**實際呼叫一次模型**要求 `mode === 'llm'`：

1. `/api/health` 是否讀到金鑰（`llm.configured`）
2. 來源是否為 `env`（若顯示 `file`，代表 Render 上讀到了不該存在的 `config.json`）
3. `baseUrl` 是否以 `/v1` 結尾
4. `disableThinking` 是否為 true
5. 模型是否真的產生非空繁體中文輸出

> **一個容易誤判的點**：`/api/interpret` 預設是 `mode=rule`，只有明確帶
> `?mode=llm` 才會呼叫模型（避免使用者只是開頁面就燒 API 額度）。
> 少了這個參數會永遠看到 `mode=rule`，但**那不是金鑰失效**。
> 驗證腳本已內含此參數。

> **回應中的 `llm.mode` 與 `interpretation.mode` 是兩件事**：
> `interpretation` 是規則層結果（`mode` 固定 `rule`，永遠都有），
> `llm` 才是模型潤飾結果（可能成功 `llm`、或失敗退回 `rule` 並在 `note` 說明原因）。

### 線上驗收

```bash
npm run test:live     # 對 Render 站台跑 26 項驗收（含 API、UI、手機版）
```

也可指定其他站台：

```bash
BASE=https://你的網址 npm run test:live
```

本機另有 `npm run test:reasons`，驗證「篩選無結果」的原因說明與放寬建議。

### 與 WorkBuddy 版的行為差異（實測）

**預測功能在 Render 可用，在 WorkBuddy 沙箱不可用。** 這是兩邊差異最大的一項：

| 項目 | WorkBuddy 沙箱 | Render |
|---|---|---|
| `pred.status` | `unavailable` | `ok` |
| 統計可信度 | 無法計算（顯示原因） | 可計算（AAPL 為 100 / 高） |
| K 線來源 | tencent | yahoo |
| 5 年 K 線 | 不支援 | 支援（約 1229 根） |

原因不是程式差異，而是出網限制：預測需要 10 年**復權**序列做滾動校準，
沙箱只能連上騰訊，而騰訊不支援 10 年且不提供復權價（`adj: 'none'`）。
依「寧可沒有預測，也不要錯的預測」原則，沙箱上會明確降級並顯示原因，
而不是給出未經校準的區間。

### 免費方案注意事項

Render 免費方案閒置後會休眠，冷啟動首次請求約需 30–60 秒。
`/api/health` 是健康檢查路徑，可用來喚醒服務：

```bash
curl https://stock-entry-analyzer.onrender.com/api/health
```

