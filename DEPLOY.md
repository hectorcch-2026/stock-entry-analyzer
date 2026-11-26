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
- 目前版本：`f509093`（v1.4：K 線預測與 AI 選股）

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

