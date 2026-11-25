# 美股與港股 買入位與技術位分析系統

即時查詢美股 / 港股，自動計算建議買入價位區間、關鍵技術位（支撐、壓力、各週期均線、近期高低點），
並以近兩年日線歷史回測推估進場勝率與獲利機率。響應式設計，手機 / 平板 / 桌機皆可操作。

## 快速開始

```bash
cd stock-entry-analyzer
npm start          # 啟動後開啟 http://localhost:5177
```

零外部執行期依賴，僅需 Node.js >= 18（使用內建 `fetch`）。

```bash
PORT=8080 npm start            # 自訂埠號
npm run icons                  # 重新產生 PWA 圖示（需 devDependency: sharp）
```

開啟後可直接輸入，例：`0700.HK`、`0700`、`騰訊`、`AAPL`、`NVDA`、`Apple`。

也支援以網址直接查詢（便於分享與 Power BI 連結）：
`http://localhost:5177/?symbol=0700.HK`

---

## 在手機上使用

本專案已內建完整 PWA 支援（manifest、Service Worker、圖示、iOS 引導）。
以下說明各種存取方式與前置條件。

### 層次 1：同一 WiFi 區網（快速驗證，不含 PWA）

```bash
# 找出電腦區網 IP
ipconfig                     # Windows，看「IPv4 位址」如 192.168.1.100

PORT=5177 node server.js
```

手機瀏覽器輸入 `http://192.168.1.100:5177`。

**前置條件**：手機與電腦連同一 WiFi；Windows 防火牆需放行該埠（首次啟動會彈窗詢問）。

> ⚠️ **此方式的限制**：私有 IP 被瀏覽器視為**不安全來源**，Service Worker 會被拒絕註冊。
> 因此**加入主畫面、離線快取、通知都不會生效**，只能基本瀏覽。
> 頁面 console 會出現提示：`非安全來源（需 HTTPS 或 localhost），Service Worker 未註冊。`

### 層次 2：公網 HTTPS（PWA 功能完整生效的前提）

| 方式 | 適用 | 說明 |
|---|---|---|
| 通道服務（Cloudflare Tunnel / ngrok） | 臨時、自用 | 本機服務不關機即可對外，取得 `https://xxx.trycloudflare.com` |
| 雲端主機（Render / Railway / Fly.io） | 長期穩定 | 服務不依賴你的電腦；免費方案有冷啟動 |
| 自有 VPS + Let's Encrypt | 完全掌控 | 可綁自有網域，最穩定也最費工 |

**HTTPS 是硬性前提**：Service Worker、Web Push、安裝提示都只在安全來源下可用（`localhost` 例外）。
取得 HTTPS 後，PWA 功能才會全部生效。

### 層次 3：加入主畫面

**各平台操作方式**

| 平台 | 操作路徑 | 自動提示 |
|---|---|---|
| **iOS / iPadOS Safari** | 分享鈕（方框向上箭頭）→ 下滑找「加入主畫面」→ 命名 → 加入 | ❌ 沒有，需手動。本專案已內建引導提示 |
| Android Chrome | 右上選單 →「安裝應用程式」；或頁面自動彈出安裝橫幅 | ✅ 有 |
| Android 已安裝 | Chrome 產生真正的 **WebAPK**，圖示進應用程式抽屜 | — |
| 桌面 Chrome / Edge | 網址列右側安裝圖示 | ✅ |

**iOS 26 起的變化**：任何網站加入主畫面後**預設以獨立視窗開啟**，即使沒做 PWA。
WebKit 官方說明為「安裝性已無任何要求，manifest 與 Service Worker 降級為選用增強」。

### 已實作的 PWA 元件

| 檔案 | 作用 |
|---|---|
| `public/manifest.webmanifest` | 名稱、圖示、`display: standalone`、主題色、**捷徑**（快速查詢騰訊 / AAPL） |
| `public/sw.js` | 離線快取（策略見下節） |
| `public/icons/` | 192 / 512 / maskable 512 / apple-touch-icon 180 / favicon 32 / SVG |
| `scripts/make-icons.js` | 圖示產生器（可重新產生） |

### 各平台支援對照（2026 年 11 月實況）

**✅ iOS PWA 能做到**（需先加入主畫面）

- 獨立視窗全螢幕、主畫面圖示、圖示角標（Badging API，iOS 16.4+）
- **Web Push 通知**（iOS 16.4+）
- **離線運作**（Service Worker + IndexedDB，受儲存配額限制）
- 相機 / 麥克風 / 定位（僅前景）、Face ID 登入（WebAuthn）、線上支付

**❌ iOS PWA 做不到（2026 年仍未開放）**

- **Web Bluetooth / Web NFC / WebUSB** — Apple 以指紋追蹤風險為由拒絕實作
- **Background Sync / Periodic Background Sync / Background Fetch** — 完全沒有
- 主畫面小工具、聯絡人選擇器
- 裝載非 WebKit 引擎（即使歐盟 DMA 與日本法案已允許，截至 2026 年初仍無廠商推出）

**🔶 有條件才能用**

- **iOS 通知必須「先安裝、再由使用者點擊」才能請求權限**：
  ```
  ❌ Safari 分頁中直接呼叫 requestPermission() → 靜默失敗，不彈窗
  ✅ 加入主畫面 → 從主畫面圖示開啟 → 使用者點按鈕 → requestPermission()
  ```
- 推播必須顯示可見通知，不能純背景同步資料
- 通知的圖片與自訂按鈕支援較弱

**Android 較寬鬆**：支援 Background Sync、Web Bluetooth，安裝後生成真正的 WebAPK。

### ⚠️ 對本專案的關鍵限制

**iOS 沒有 Background Sync，因此無法在使用者關閉 App 後於背景刷新行情。**
本系統目前的「價格異動通知」走 **Telegram Bot**（由伺服器端 `lib/telegram.js` 發送），
這個選擇**恰好繞過了 iOS 的限制**，不需依賴瀏覽器背景能力。

若未來要改用 Web Push，必須由**伺服器端排程**定時檢查並推播，無法只靠前端。

### 上線前必做的四步實測

```
1. 加入主畫面 → 2. 完全關閉再重新開啟 → 3. 開飛航模式瀏覽 → 4. 授予通知權限並收測試推播
```

這四步能抓出幾乎所有 iOS 意外，且**在桌面模擬器上完全看不出來**，必須用真機。

---

## 系統架構

```
stock-entry-analyzer/
├── server.js              # HTTP 服務、路由、輸入正規化、錯誤處理、靜態資源快取標頭、診斷端點
├── lib/
│   ├── datasource.js      # 來源調度層：自適應排序 + 熔斷器 + 錯誤分類
│   ├── yahoo.js           # 來源 1：搜尋 / K 線 / 報價 / 新聞、TTL 快取、重試
│   ├── eastmoney.js       # 來源 2：東方財富（GBK 解碼，美股 / 港股）
│   ├── tencent.js         # 來源 3：騰訊行情（多端點形狀回退 + 美股後綴還原）
│   ├── alias.js           # 中文名稱→代碼 別名索引（上游不支援中文查詢）
│   ├── indicators.js      # 純函式技術指標：SMA/EMA/RSI/MACD/ATR/布林/擺動點/聚類
│   ├── analyzer.js        # 核心：技術快照 → 加權評分 → 買入區間 → 回測 → 機率合成
│   └── telegram.js        # Telegram 通知（未設定時為模擬模式）
├── public/
│   ├── index.html         # 版面結構、PWA meta、iOS 引導
│   ├── styles.css         # 響應式樣式（含 safe-area-inset 安全區域處理）
│   ├── app.js             # 前端邏輯、Canvas K 線圖、SW 註冊、離線狀態、資料新鮮度
│   ├── sw.js              # Service Worker（分流快取策略）
│   ├── manifest.webmanifest
│   └── icons/             # PWA 圖示（192 / 512 / maskable / apple-touch / favicon）
├── scripts/make-icons.js  # 圖示產生器
└── tests/                 # Playwright 端到端測試
    ├── e2e-pwa.mjs        # 本地 PWA / SW / 離線
    ├── e2e-ios-standalone.mjs  # iPhone 加入主畫面後的獨立視窗模式
    ├── e2e-deployed.mjs   # 公網 HTTPS 部署驗證
    ├── e2e-flow.mjs / e2e-layout.mjs / e2e-detail.mjs / e2e-notify.mjs
    └── analyzer-check.cjs # 分析器離線邏輯檢查
```

### Service Worker 快取策略（分流設計）

這是本專案 PWA 實作**最關鍵的決策**：不同性質的資源，快取策略必須不同。

| 資源類型 | 策略 | 理由 |
|---|---|---|
| **App Shell**<br>HTML / CSS / JS / 圖示 | Precache +<br>Stale-While-Revalidate | 離線時介面仍可開啟，不至於白畫面。先回快取（快），背景同時更新（新） |
| **行情 API**<br>`/api/analyze`、`/api/search` | Network-First，<br>**絕不 Precache** | 這是金融資料。**把舊價當現價顯示，比「打不開」更危險。** 僅在網路失敗時才回退快取 |
| **導覽請求**<br>含 `?symbol=` | Network-First，<br>離線回退 `index.html` | 離線重整仍能看到介面 |
| **非 GET**<br>如 POST `/api/notify` | 直接走網路 | 不快取任何寫入操作 |
| **`/api/health`、`/api/config`** | 永遠走網路 | 狀態查詢不應被快取 |

**資料新鮮度的明確標示**：SW 在離線回退時會加上 `X-From-Cache` 與 `X-Cache-Age` 標頭，
前端據此顯示黃色警示橫幅「以下為約 N 分鐘前的快取資料，可能已偏離現價，請謹慎判讀」。

**過期資料直接丟棄**：快取超過 **30 分鐘**的行情會被直接刪除並改回 `OFFLINE` 錯誤，
不顯示嚴重過時的價格，避免誤導進場判斷。

**快取標頭設定**（`server.js`）：
- `sw.js` → `no-cache, no-store, must-revalidate`（否則瀏覽器會快取 24 小時，更新永不生效）
- `index.html` / `manifest` → `no-cache`
- 其他靜態資源 → `public, max-age=3600`
- 所有 `/api/*` → `no-store`（由 SW 決定離線策略，避免雙層快取互相干擾）

### 模組職責與資料流

| 模組 | 輸入 | 處理邏輯 | 輸出 |
|---|---|---|---|
| `datasource.js` | 代碼 / 關鍵字 | 來源排序（上次成功者優先 + 未冷卻者優先）→ 逐個嘗試 → 錯誤分類決定是否換源 → 成功解除冷卻 / 全失敗則冷卻 | 與來源無關的一致結果 |
| `yahoo.js` | 代碼 / 關鍵字 | 10 分鐘搜尋快取、60 秒行情快取、2 次指數退避重試、跳過停牌缺值 | 正規化 K 線 / 報價 / 新聞 |
| `eastmoney.js` | 代碼 | seclid 映射（`105.` 美股 / `116.` 港股）、GBK 解碼、非 JSON 回應標記為可換源 | 正規化 K 線 / 報價 |
| `tencent.js` | 代碼 | 搜尋解析 → 從 `fullCode` 還原交易所後綴 → 3 路徑 × 3 主機嘗試 K 線，記住成功組合 | 正規化 K 線 / 報價 |
| `alias.js` | 中文關鍵字 | 精確 → 前綴 → 包含 三級匹配，同代碼取最具體別名 | 候選代碼清單 |
| `indicators.js` | 收盤 / 高低 / 量序列 | 純函式計算，資料不足處回 `null`，不拋錯 | 指標序列 |
| `analyzer.js` | 代碼 | 快照 → 7 項加權評分 → 支撐壓力聚類 → 買入區間 → 180 日回溯 | 完整分析 JSON |
| `telegram.js` | 報價 + 訊號 + 新聞 | 組裝 HTML 訊息；未設定 token 時僅回傳預覽 | 發送結果 |

---

## 各功能輸入 / 處理 / 輸出

### 1. 即時互動查詢欄位

- **輸入**：代碼（`AAPL`、`0700.HK`、`0700`、`700`、`00700`）或名稱（`騰訊`、`Apple`）。
- **處理**：
  - 前端即時驗證，依輸入類型辨識出「美股 / 港股」並提示將查詢的完整代碼。
  - 260ms 防抖後呼叫 `/api/search` 取得自動完成建議；支援 `↑` `↓` 選擇、`Enter` 確認、`Esc` 關閉、`/` 快捷聚焦。
  - 送出後顯示骨架屏與輪播載入文案（取得行情 → 計算指標 → 偵測支撐壓力 → 執行回測 → 彙整建議），按鈕進入禁用 + 轉圈狀態。
  - 後端 `normalizeSymbol()` 統一正規化：1–5 位數字一律視為港股並自動補零（`700` / `00700` → `0700.HK`），避免上游把它誤判為台灣股票。
- **輸出**：`/api/search` 回傳依「港股優先」排序的候選清單，含代碼、名稱、交易所、市場別。

### 2. 建議買入區間與關鍵技術位

- **輸入**：日線 2 年 + 週線 5 年 K 線。
- **處理**：
  - **支撐壓力**：以左右各 5 根的擺動高低點為基礎，2% 容差聚類成價位帶，觸及次數即權重；再補入近 20 / 60 / 252 日高低點，確保單邊行情（如持續破底）下仍有有效支撐。
  - **買入區間**：候選位來自擺動支撐、MA20、MA60、布林中軌 / 下軌、斐波那契 50% / 61.8% 回撤；只取現價下方者，並統計各候選位的「重合數」，重合越多越可信，取最優者為錨定價。
  - 區間上緣 = 錨定價 ×1.004（不高於現價），下緣 = 錨定價 − 0.55×ATR。
  - 停損 = 下緣 − 1×ATR；目標 = 最近壓力價，否則上緣 + 3×ATR。
- **輸出**：買入區間、主要依據、重合技術位清單、停損、目標、盈虧比與倉位建議。

### 3. 買入位判斷依據

- **處理**：7 項加權評分（總分 100），每項皆附自然語言說明：

| 項目 | 權重 | 判斷邏輯 |
|---|---|---|
| 均線多空排列 | 22 | 現價站上均線的條數比例 |
| 支撐距離 | 18 | 距最近支撐 0–6% 為理想，跌穿支撐大幅扣分 |
| 動能（RSI/MACD） | 16 | RSI 35–60 回檔區最佳；MACD 柱狀放大 / 收窄加成 |
| 量價關係 | 14 | 放量上漲最佳、縮量下跌次佳、放量下跌最差 |
| 中期趨勢 | 12 | 60 日回歸斜率（每日 %） |
| 上行空間 | 12 | 距最近壓力的空間，>8% 為佳 |
| 波動風險 | 6 | ATR 佔股價 1.5–4% 為活躍且可控 |

- **輸出**：綜合評分、操作建議標籤（可分批佈局 / 偏多等回檔 / 中性觀望 / 偏弱暫不介入 / 弱勢建議迴避），以及 6 段判斷依據解說（現價與技術位關係、均線結構、量價與異動、波動與風險、歷史數據模型、綜合結論）。

### 4. 準確度與獲利機率

- **處理**：走訪近兩年每一根 K 線，凡當日最低價觸及買入區間即視為一次觸發進場，以收盤價（夾在區間內）成交，統計其後 10 / 20 個交易日表現。
  - 勝率、平均 / 中位報酬、平均獲利與虧損、賠率、獲利因子、平均最大浮盈（MFE）與浮虧（MAE）。
  - **基準普及率**：同期「任意時點進場」的 N 日上漲機率，用於計算**相對優勢**（勝率 − 基準），避免把牛市普漲誤認為策略有效。
  - 機率合成採樣本數導向的貝氏混合：樣本越多越信任歷史勝率，樣本不足時以技術分數推估並明確標示低信心。
  - 未走完 20 日觀察窗的近期樣本只列為 `pending`，不計入勝率，避免虛高。
- **輸出**：20 日 / 10 日上漲機率、獲利機率（報酬 > 1%）、歷史樣本數、基準機率、相對優勢、信心等級、回測明細與最近 8 次觸發紀錄。

### 5. 資料更新時間與 Telegram 通知

- **輸出**：頁尾顯示資料更新時間（含「N 秒前」即時刷新）、資料來源、報價延遲與時區說明。
- **通知**：開啟開關後可發送測試通知，內容含現價、漲跌幅、建議買入區間、技術面評分、20 日上漲機率與 3 則相關新聞連結。

啟用實際發送（任選一種）：

```bash
# 方式一：環境變數
TELEGRAM_BOT_TOKEN=123456:ABC... TELEGRAM_CHAT_ID=987654321 npm start

# 方式二：設定檔
cp config.example.json config.json   # 再填入 botToken / chatId
```

未設定時為**模擬模式**：完整產生訊息並在頁面預覽，但不實際發送，方便先驗證流程。

### 6. 進階技術分析四模組

在原有分析之外，`advancedTools` 附加四個模組。**每個模組都固定呈現四段**：
觀察維度 → 最佳進場（下注）信號 → 止損／失效信號 → 常見支援平台。
信號本身帶 `status`（`triggered` / `near` / `not-met` / `invalid` / `unknown`），
前端據此上色並把已觸發者排前，避免使用者在一堆文字裡自己找重點。

| 模組 | 觀察維度 | 進場信號 | 止損／失效信號 | 支援平台 |
|---|---|---|---|---|
| **VRVP / FRVP** 成交量分佈 | 籌碼堆積與重貨區 | 突破 VAH 後回踩確認、回調至 POC 止跌 | 放量跌破 POC 且無法快速收回、跌破 VAL | TradingView、富途牛牛 |
| **Anchored VWAP** 錨定均價 | 特定事件後的資金平均成本 | 回踩重大利好／底部起漲日的 AVWAP 且出現看漲 K 線、多錨點共振 | 收盤明確跌破關鍵 AVWAP | TradingView、Thinkorswim |
| **價格裂口 / FVG** | 短期買賣動能失衡區 | 回調進入 FVG、突破裂口上沿時縮量止跌 | 裂口被完全回補（封閉） | 所有主流看盤軟件 |
| **期權 OI / GEX** | 機構與做市商對沖博弈 | 跌至 Put Wall 且處於正 Gamma | 跌破 Zero Gamma 且 Put Wall 大量平倉 | Unusual Whales、SpotGamma、富途期權異動 |

實作分兩層，計算與解讀分離：

- `lib/advtools.js`：純計算，零依賴、可重現。成交量分佈採「把每根 K 線量能依高低價
  攤分到各價位格」，Value Area 從 POC 往量大的鄰格擴張至 70%。FVG 用三根 K 線的
  失衡判定（看漲 `c1.h < c3.l`、看跌 `c1.l > c3.h`），並向前計算回補率。
- `lib/advtools-interpret.js`：把計算結果翻成上述四段結構與狀態文字。

#### ⚠️ 期權資料的現實限制（本模組的設計依據）

實測 Yahoo 期權鏈端點（AAPL / NVDA / TSLA，各 93～186 個合約）：
**`openInterest` 一律回傳 0**，`volume` 與部分 `impliedVolatility` 才是真實值；
港股（如 `0700.HK`）完全沒有期權鏈。

真正的 GEX = `Gamma × OI × 合約乘數 × 現價² × 0.01`，缺了 OI 就算不出來。
因此採**雙軌且誠實標示**的做法：

- 有 OI → 計算真正的 GEX、Put Wall / Call Wall / Zero Gamma。
- 無 OI → 改用 `volume` 作活躍度權重計算 **VGEX 代理指標**，回傳 `proxy: true`
  與 `proxyReason`，前端在卡片頂端顯示黃色警示，明確說明「這不是真實 GEX」。
- 無期權鏈（港股）→ `available: false`，附上原因與替代平台。
- 取用失敗（限流／連線）→ `available: false` 且 `transient: true`，
  訊息與「本來就沒有期權」明確區隔，並提示稍後重整即可。

> 為何要分得這麼細：把「查不到」和「這檔沒有」講成同一句話，會讓美股使用者
> 誤以為 AAPL 沒有期權鏈。寧可多一個 `transient` 欄位，也不要給出誤導的結論。

`GET /api/analyze` 的回應因此多一個 `advancedTools` 欄位：

```json
{
  "advancedTools": {
    "modules": [ /* 四個模組，結構固定 */ ],
    "availableCount": 4,
    "totalCount": 4,
    "generatedAt": 1795592000000
  }
}
```

**既有欄位完全不動**（`score` / `buyZone` / `backtest` / `levels` / `series` …），
四個模組各自獨立 try，任一失敗只讓該卡片顯示不可用，不影響主分析與 Telegram 通知。

#### 圖表疊加：把價位畫回 K 線圖上

文字卡片講「在哪裡」，圖上看「離多遠」——兩者互補。因此其中兩個模組
同時疊加到互動 K 線圖，並提供獨立開關（圖表右上「籌碼分佈」「FVG 缺口」）：

- **成交量分佈**：橫向柱狀圖畫在**左側**（POC 紅、Value Area 內較深、其餘淡藍），
  並標出 POC / VAH / VAL 三條線與左側價位標籤。
- **FVG 缺口**：從缺口形成的那根 K 線起，**向右延伸**成半透明區間帶
  （看漲紅、看跌綠），上下沿為虛線；缺口起點另加一小段實線表示已回補比例。

三個實作細節值得記下來：

1. **左 VP + 右 FVG 是刻意的分工。** 一開始把成交量分佈也貼右側，
   結果 FVG 的紅色填充被柱狀圖整片蓋掉（取樣到的是紫色混合色）。
   分開之後兩者互不干擾，也符合 TradingView 的慣例。
2. **Y 軸範圍要把技術位納入。** 只用 K 線高低點算範圍時，POC/VAH/VAL
   或 FVG 若落在近期區間外，會被畫到圖外、看起來像「沒畫」。
3. **`barsAgo` 對應圖表索引是 `n - 1 - barsAgo`。** 後端用全部 K 線算 FVG，
   圖表只畫最近 250 根；用「距最後一根幾根」換算，兩邊不必共用常數。

hover 時 tooltip 除了 OHLC 與量，還會多一行顯示「這根收盤價在價值區內/外」
以及「是否落在某個未回補缺口裡」——把線圖上的位置直接翻成一句判斷。

> 對應測試 `npm run test:chart` 不看「畫布有沒有顏色」，而是把 POC/VAH/VAL
> 的價格換算成預期像素列，再去那一列取樣驗證。技術位若畫在錯誤價位，
> 比不畫更危險（使用者會依此下單），所以值得用座標而不是截圖來守。

#### 這些模組怎麼用：多週期交易框架

四個模組提供的是「**價位在哪裡**」，不是「**什麼時候買**」。要把價位轉成可執行
的決策，需要一套多週期流程。完整方法論見
**[docs/三層濾網多週期交易框架.md](docs/三層濾網多週期交易框架.md)**：

| 層 | 週期 | 工具 | 回答的問題 |
|---|---|---|---|
| 一 | 日線 | VRVP、錨定 VWAP、斐波那契 OTE | 大資金的核心防守區在哪？ |
| 二 | 1H ＋ 15M | Liquidity Sweep、FVG | 是真跌破，還是掃損？ |
| 三 | 5M | Footprint、CVD | 現在扣扳機，還是繼續等？ |

該文件把 Elder 三重濾網的「上位週期否決下位」原則，掛接上現代訂單流工具，
並明確標示哪些屬 Elder 原義、哪些屬 2002 年後的延伸（見文件第 10 節）。
本應用負責第一層的客觀計算與第二層的 FVG；第二層的 Sweep 判定與第三層的
逐筆成交分析，屬交易執行端的職責。

---

## 資料來源與更新機制

### 三來源容錯架構

行情資料不綁定單一供應商。`lib/datasource.js` 是調度層，對上層提供與 `yahoo.js`
完全相同的介面（`search` / `chart` / `quote` / `news`），上層（`analyzer`、`server`）
完全無須感知實際來源。

| 順序 | 來源 | 端點 | 涵蓋 | 備註 |
|---|---|---|---|---|
| 1 | **Yahoo Finance** | `query1.finance.yahoo.com` | 美股 / 港股 / 新聞 | 資料最完整，唯一提供新聞 |
| 2 | **東方財富** | `push2.eastmoney.com`<br>`push2his.eastmoney.com` | 美股 / 港股 | 無 IP 限制，GBK 需解碼 |
| 3 | **騰訊行情** | `qt.gtimg.cn`（報價）<br>`smartbox.gtimg.cn`（搜尋）<br>`ifzq.gtimg.cn`（K 線） | 美股 / 港股 | 最後備援；多數雲端沙箱僅放行此家 |

**為什麼一定要多來源**：不同部署環境的對外網路政策差異極大。實測本機可直連三者；
而雲端沙箱對 Yahoo 回 `429 Edge: Too Much Requests`、對東方財富 `UND_ERR_SOCKET`
（連線被拒）、對 Sina 回 `403`，**僅騰訊可達**。單來源版本在雲端會完全無法出資料。

#### 1. 自適應排序（last-success-first）

記住上次成功的來源並優先嘗試。某來源在當前網路環境不可用時，只需付一次探測成本，
後續請求直接命中可用來源。

#### 2. 熔斷器（circuit breaker）

來源失敗後冷卻 **5 分鐘**，冷卻期內排序時排到最後（但不完全排除，全數失敗時仍可嘗試）。
避免每個請求都重複付出數秒逾時代價——部署環境常是「整體封鎖」某來源，而非偶發失敗。
成功即解除冷卻。

#### 3. 錯誤分類：區分「該換來源」與「不該換來源」

這是容錯是否有效的關鍵。錯誤分兩類：

| 類型 | 例子 | 行為 |
|---|---|---|
| **可換來源**（`failover`） | `429`、`5xx`、連線失敗、逾時、DNS 失敗、**回應非 JSON** | 換下一個來源 |
| **業務錯誤**（不換） | 找不到標的、資料不足、參數錯誤 | 直接回給使用者 |

其中「回應非 JSON」最容易漏判：東方財富在部分網路環境會回 jQuery 包裝
（`jQuery3510...`），`JSON.parse` 拋出 `SyntaxError` 且**沒有 `status` 欄位**。
若當成業務錯誤，整個容錯鏈會在此中斷。故 `lib/eastmoney.js` 明確標記 `err.failover = true`，
`datasource.js` 的 `isFailoverWorthy()` 也把 `SyntaxError` / `Unexpected token` 納入判斷。

#### 4. 騰訊來源的兩個實測坑（已在程式中處理）

- **美股代碼必須帶交易所後綴**：`usAAPL` 只回 2 筆佔位資料，`usAAPL.OQ` 才有完整歷史。
  但上游會在批次報價回應中把 `usAAPL.OQ` **正規化成裸 `usAAPL`**，把真正的後綴藏在
  欄位 `f2`（`AAPL.OQ`）。因此 `resolveCode()` 從 `fullCode` / `f2` 還原後綴。
- **K 線端點路徑敏感**：`/appstock/app/fqkline/get` 在部分環境被出口代理擋成 `501`，
  而 `/appstock/app/newfqkline/get` 與 `/appstock/app/kline/kline` 回 `200`。
  這是**路徑差異而非主機差異**，故 `tencent.js` 以 `KLINE_SHAPES`（3 種路徑 × 3 個主機）
  逐一嘗試，並記住成功的那一組。

#### 5. 強制指定來源（除錯用）

```bash
DATA_SOURCE=yahoo     node server.js   # 只走 Yahoo
DATA_SOURCE=eastmoney node server.js
DATA_SOURCE=tencent   node server.js
```

未設定時為自動模式。`/api/health` 與 `/api/diag` 會回報目前環境的實際可達狀況。

### 快取與重試參數

| 項目 | 說明 |
|---|---|
| 日線 | 2 年，用於指標計算與回測樣本 |
| 週線 | 5 年，用於大級別結構參考 |
| 搜尋快取 | 10 分鐘 |
| 行情快取 | 60 秒 |
| 新聞快取 | 15 分鐘 |
| 失敗重試 | 2 次，指數退避（400ms / 800ms），12 秒逾時 |
| 來源熔斷 | 5 分鐘冷卻 |
| 快取清除 | 超過 400 筆時淘汰最舊 100 筆 |

**已知上游限制（已在程式中處理）**：

1. **搜尋 API 不支援中文**：輸入中文關鍵字直接回 `400 Invalid Search Query`。因此建立 `lib/alias.js` 本地別名索引（涵蓋約 180 個港美股常見中文名），並支援簡繁、簡稱（如「工行」「大摩」「B站」）。中文查詢一律先查本地索引，零延遲且不受上游政策影響。
2. **以代碼查新聞通常為 0 筆**：需改用公司名稱（`Tencent Holdings`）才能取得結果。`news()` 會先以代碼查詢，無結果時自動以公司名稱重查，並依 `relatedTickers` 過濾出真正相關的新聞。新聞僅 Yahoo 提供，屬加分項，失敗一律回空陣列而不影響整體分析。
3. **港股代碼格式不一致**：Yahoo 使用 4 位（`0700.HK`）或 5 位（`09988`）格式，騰訊用 `hk00700`，東方財富用 `116.00700`，故 `padHK()` 統一處理。
4. 報價為**延遲報價**（港股約 15 分鐘），頁面已明確標示。

### 來源診斷端點

部署到新環境若出不了資料，用這組端點定位（全部 GET，可直接在瀏覽器開）：

| 端點 | 用途 |
|---|---|
| `/api/diag` | 對 14 個候選主機做可達性測試（狀態碼 / 耗時 / 回應長度） |
| `/api/diag/source?symbol=AAPL` | 逐來源追蹤代碼解析與取資料的每一步 |
| `/api/diag/kline?code=usAAPL.OQ` | K 線主機 × Referer 矩陣 |
| `/api/diag/url?host=&codes=` | URL 編碼變體（原件 / 全編碼 / 僅代碼編碼） |
| `/api/diag/hdr?host=&code=` | UA / Referer 標頭矩陣 |
| `/api/diag/probe?code=` | 14 種候選端點形狀逐一探測 |

---

## 響應式版面與視覺化圖表

### 斷點配置

| 寬度 | 版面調整 |
|---|---|
| > 1024px | 雙欄 grid（買入區間 / 機率、技術位 / 均線並排）、6 欄報價統計、4 欄功能卡 |
| ≤ 1024px | 報價統計降為 3 欄、功能卡 2 欄、圖表高 380px |
| ≤ 860px | 雙欄改單欄、近期高低點改單欄 |
| ≤ 640px | 查詢表單改縱向堆疊、報價統計 2 欄、機率儀表縮小、圖表高 300px、評分列改上下排列、通知列縱向 |
| ≤ 380px | 報價統計 2 欄、斐波清單改單欄 |

其他細節：

- **安全區域**：`viewport-fit=cover` + 9 處 `env(safe-area-inset-*)`，處理瀏海與底部手勢列，
  頂部列在獨立視窗模式下自動避開狀態列。
- **觸控目標 ≥ 44px**：手機版按鈕、輸入框、分頁、建議清單項皆滿足 Apple HIG 建議值。
- **`overscroll-behavior-y: none`**：降低 iOS 橡皮筋回彈在圖表上的誤觸。
- **`prefers-reduced-motion`** 關閉動畫、**列印樣式**隱藏互動元素。
- 所有 grid / flex 子項設 `min-width: 0`，避免內部寬表格撐破容器造成水平滾動
  （實測 390px 寬下 `scrollWidth` 等於視窗寬）。

### 圖表類型

1. **K 線圖（Canvas 自繪）**：紅漲綠跌，可疊加切換——
   - MA5 / MA10 / MA20 / MA60 均線
   - 支撐（綠虛線）、壓力（紅虛線）
   - 建議買入區間（藍色帶）、停損（綠線）、目標（紅線）
   - 布林通道 20,2（含填充帶）
   - 成交量柱狀（獨立下方面板）
   - 滑鼠 / 觸控十字線 + 浮動提示（開高低收、漲跌、量）
2. **環形儀表**：20 日上漲機率、獲利機率，依數值變色並有動畫。
3. **買入區間視覺化**：以 52 週高低為座標軸，標示現價、買入帶、停損、目標。
4. **斐波那契回撤條**：7 個回撤位標記，落在買入區間者高亮標示「★買區」。
5. **評分橫向長條圖**：7 項評分佔比，附文字說明。
6. **技術位表格**：類型、價位、距現價、觸及次數；均線表另含斜率與「現價在上 / 在下」狀態。

---

## 錯誤與邊界情況處理

### 錯誤碼對照

| 情境 | HTTP | 錯誤碼 | 使用者看到的訊息與引導 |
|---|---|---|---|
| 未輸入 | 400 | `EMPTY` | 「請輸入查詢內容」+ 三種格式範例 |
| 格式無法辨識 | 400 | `INVALID_FORMAT` | 「格式無法辨識」+ 一鍵套用範例按鈕 |
| 輸入過長 | 400 | `TOO_LONG` | 「輸入長度超出限制（最多 24 個字元）」 |
| 查無此標的 | 404 | `NOT_FOUND` | 「查無此標的」+ 引導改用名稱搜尋 |
| 資料不足 | 422 | `INSUFFICIENT_DATA` | 「資料不足，無法分析」+ 說明可能原因（新股、停牌、量低）+ 改查其他標的按鈕 |
| 請求過頻 | 429 | `RATE_LIMITED` | 「請求過於頻繁」+ 建議等 10–30 秒 + 重試按鈕 |
| 上游異常 | 500 | `UPSTREAM_ERROR` | 「取得資料失敗」+ 重試按鈕 |
| **離線且無快取** | 503 | `OFFLINE` | 「目前離線」+ 說明介面仍可瀏覽 + 重試按鈕（由 Service Worker 回傳） |
| **離線但有快取** | 200 | — | 正常顯示，但上方出現黃色橫幅標示「約 N 分鐘前的資料」 |
| **快取超過 30 分鐘** | 503 | `OFFLINE` | 主動丟棄過期行情，避免用舊價誤導進場判斷 |
| 離線 | — | 前端判斷 | 「網路連線中斷」+ 重試按鈕 |

### 邊界情況

- **歷史資料 < 40 個交易日**：拒絕分析並回 `INSUFFICIENT_DATA`，附上可一鍵切換的替代標的。
- **日均量缺失 / 停牌**：抓取時直接跳過 `close == null` 的 K 線，不讓缺值污染指標。
- **擺動點全部落在現價同側**（單邊行情）：補入近期高低點，保證支撐 / 壓力不會全空。
- **回測樣本為 0**：明確顯示「過去兩年內股價未曾進入此區間，無法回測」，改為前瞻性參考提示，而非顯示 0% 勝率誤導使用者。
- **樣本不足（< 5）**：信心等級標為 `insufficient`，機率改以技術面推估並在畫面與說明中加註警語。
- **相對優勢為負**：明確提示「此區間歷史表現未優於隨機進場，建議縮小部位或等待更佳價位」。
- **模糊匹配**：找不到完全相符標的時，回傳最相近結果並顯示黃色警示條，同時附上候選清單。
- **港股數字代碼歧義**：後端直接鎖定 `.HK`，不再交給上游搜尋，避免 `00700` 被解析成台灣股票。

### 通知訊息的 HTML 轉義

Telegram 以 `parse_mode: 'HTML'` 發送，因此**所有動態文字都必須轉義**。
這是一個容易漏掉、且症狀不明的坑：公司名含 `&` 或 `<` 時（**AT&T**、**H&M**、
`SK Hynix <holdings>`），Telegram 會把 `<Co>` 當成未支援的標籤，直接回
`400 can't parse entities`，導致整則通知發送失敗——而使用者只看到「發送失敗」，
難以聯想到是公司名裡的 `&` 造成。

`buildMessage()` 現已對 `name` / `symbol` / `currency` / `verdictLabel` /
新聞標題與 `href` 全部轉義，且 `escapeHtml()` 先處理 `&` 再處理其他字元
（否則會產生 `&amp;lt;` 這種重複轉義）。

### 通知載荷的容錯

`POST /api/notify` 的設計是**前端帶完整載荷**（價格、訊號、新聞），
但外部系統或 `curl` 通常只給 `symbol`。若缺少價格，後端會自動補跑一次分析，
避免送出「現價：—」這種沒有資訊量的通知：

```bash
curl -X POST http://localhost:5177/api/notify \
  -H "Content-Type: application/json" -d '{"symbol":"AAPL"}'
```

補資料失敗不會阻擋發送，而是在回應中加 `warning` 欄位說明。

---

## API 參考

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/health` | 健康檢查（含 Telegram 設定狀態） |
| GET | `/api/config` | 取得通知設定狀態與評分權重 |
| GET | `/api/search?q=` | 代碼 / 名稱搜尋（自動完成用） |
| GET | `/api/analyze?symbol=` | 完整分析（買入區間、機率、回測、圖表資料、進階四模組） |
| GET | `/api/news?symbol=&name=` | 相關新聞 |
| POST | `/api/notify` | 發送 Telegram 通知 |
| GET | `/api/diag*` | 來源連線診斷（見「來源診斷端點」） |

已開啟 CORS，方便 Power BI 或外部系統呼叫。

```bash
curl "http://localhost:5177/api/analyze?symbol=0700.HK"
curl "http://localhost:5177/api/search?q=騰訊"
```

---

## 測試

需要 Playwright（已在 `devDependencies`）：

```bash
npm i -D playwright && npx playwright install chromium
npm start                          # 另開一個終端
npm run test:escape                # 通知訊息 HTML 轉義（15 項，純函式不需連網）
npm run test:hidden                # hidden 屬性可見性（4 項，防離線橫條常駐）
npm run test:adv                   # 進階分析四模組 UI 與資料完整性（25 項）
npm run test:chart                 # 圖表技術位疊加的座標正確性（13 項）
npm run test:pwa                   # PWA：manifest、圖示、Service Worker、離線行為（33 項）
npm run test:layout                # 三種螢幕尺寸版面與渲染驗證
npm run test:flow                  # 自動完成、載入狀態、圖表切換
npm run test:notify                # 通知切換與錯誤提示
npm run test:ios                   # iPhone 加入主畫面的獨立視窗模式（34 項）
node tests/e2e-detail.mjs          # 完整結果明細
npm run test:all                   # 以上本地套件一次跑完
```

**公網部署驗證**（需先部署，並取得分享連結）：

```bash
BASE_URL="https://<你的網域>/?sharecode=XXXX" node tests/e2e-deployed.mjs
```

驗證範圍：HTTPS 與靜態資源、公網 API（美股 / 港股 / 中文搜尋 / 錯誤碼）、
iPhone 獨立模式前端行為、PWA 安裝性（以 Chromium `Page.getInstallabilityErrors`
為官方判定依據）、SW 註冊與離線快取、Console 錯誤。

實測結果：

| 套件 | 結果 |
|---|---|
| `test:escape` | 15 / 15 |
| `test:hidden` | 4 / 4 |
| `test:adv` | 25 / 25 |
| `test:chart` | 13 / 13 |
| `test:pwa` | 33 / 33 |
| `test:ios` | 34 / 34 |
| `test:deployed` | **28 / 28** |
| `test:layout` / `test:flow` / `test:notify` | 全數通過 |

### ⚠️ 已知陷阱：`[hidden]` 會被作者樣式覆蓋

HTML 的 `hidden` 屬性只靠瀏覽器預設樣式 `[hidden]{display:none}` 生效，
而**作者樣式的優先級高於瀏覽器預設樣式**。因此只要元件的 CSS 寫了
`display`（例如 `.offline-bar{display:flex}`），`hidden` 就完全失效——
屬性值是 `true`，畫面上照樣顯示。

這個坑實際造成過一個使用者可見的故障：**離線橫條「目前離線」永久常駐**，
使用者誤以為網站一直斷線。當時 `e2e-pwa` 全部通過，因為測試斷言的是
`el.hidden`（屬性為真），而不是元素實際可見性。

修復與防護：

```css
:where([hidden]) { display: none !important; }
```

- 用 `:where()` 把特異性壓到 0，僅作最低限度兜底，不干擾正常 `display` 宣告
- `test:hidden` 會比對「屬性值」與「實際可見性（`display:none` 或高度 0）」是否一致，
  並實測斷網顯示 / 恢復隱藏的完整流程
- 改動 `styles.css` 時務必同步升 `public/sw.js` 的 `VERSION`，
  否則老用戶的 Stale-While-Revalidate 會先回舊 CSS，修復看起來沒生效

> 離線測試說明：`e2e-pwa` 與 `e2e-deployed` 都會刻意斷網，期間的
> `ERR_INTERNET_DISCONNECTED`、`Failed to fetch`、`503` 屬**預期行為**。
> `e2e-deployed` 以「錯誤發生時是否處於斷網階段」的旗標排除這些噪音，
> 而非靠訊息文字比對。另有 1 筆 `HTTP 403 /manifest.webmanifest` 會被排除並在輸出中列出：
> 那是分享連結的 sharecode gate 拒絕**瀏覽器內部**不帶授權 cookie 的主動抓取，
> manifest 內容本身已於 [D] 段以頁面內 `fetch` 驗證正確（`display=standalone`、
> `installabilityErrors = []`），故非應用程式缺陷。

---

## 免責聲明

本系統所有價位、評分與機率均為**歷史資料統計結果**，不保證未來表現，**不構成投資建議**。
技術面訊號可能失效，請自行評估風險並控管部位。
