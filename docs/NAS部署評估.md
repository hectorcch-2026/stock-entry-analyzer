# NAS 部署評估

> 評估對象：`stock-entry-analyzer`（美股／港股買入位與技術位分析系統，v1.4 + 經濟資料庫）
> 評估日期：2026-11-26　｜　程式版本：`05bb85a`
> 評估方式：**實測為主**。凡本文標「實測」者，均在本機以指令驗證；標「未實測」者，明確說明原因。

---

## 〇、一句話結論

**可以部署，而且條件相當寬鬆。** 本專案零執行時依賴（`dependencies: {}`），實測在**完全沒有 `node_modules`** 的目錄下即可啟動並完成真實上游抓取，閒置記憶體約 47 MB、冷啟動 155 ms。

真正需要留意的不是「跑不跑得動」，而是三件事：

| # | 事項 | 嚴重度 | 一句話 |
|---|---|---|---|
| 1 | **Service Worker 需安全來源** | 中 | 用 `http://內網IP:埠` 存取時，離線快取與「加入主畫面」全部失效 |
| 2 | **`data/` 必須外部持久化** | 高 | 容器重建即清空；且程式**沒有** `DATA_DIR` 環境變數，掛載點只能是 `/app/data` |
| 3 | **只能單一實例** | 中 | 經濟資料庫是整檔覆蓋寫入、無檔案鎖，兩個實例共用同一 `data/` 會互相蓋掉資料（實測已重現） |

另外有一項**不能用**的部署位置：**子路徑**（例如 `https://nas/screener/`）。實測會整站壞掉，原因見 §5.1。必須部署在**根路徑**或**獨立子網域／獨立埠**。

---

## 一、支援的 NAS 平台與系統需求

### 1.1 CPU 架構：不是問題

決定性事實：**本專案不安裝、不編譯任何原生模組**。實測 `grep` 全部 `require()`，除 `fs` / `path` / `http` / `url` 外沒有任何第三方套件；`devDependencies` 的 `playwright`、`sharp` 只在跑測試與產生圖示時使用，執行期完全不載入。

因此：

- **原生安裝**：任何架構都能跑，只要該架構有對應的 Node.js 執行檔。ARM 的「編譯地獄」不存在，因為根本沒有東西要編譯。
- **容器化**：基礎映像 `node:20-alpine` 是官方多架構映像，涵蓋 `linux/amd64`、`linux/arm64`、`linux/arm/v6`、`linux/arm/v7`、`ppc64le`、`s390x`。ARM NAS 直接拉取即可，不需要 `buildx` 交叉編譯。

> 這兩點是「零依賴」帶來的實質紅利。若當初選了 SQLite（`better-sqlite3`），ARM NAS 上就得在機器上編譯，或依賴預編譯檔是否覆蓋該 ABI——那才是 NAS 部署最常見的失敗點。

### 1.2 Node.js 版本：18 以上，建議 20

程式碼用到的現代 API 只有 `globalThis.fetch` 與 `AbortSignal.timeout`，兩者都是 **Node 18.0 引入**（`package.json` 亦宣告 `engines.node >= 18`）。

但請注意一個容易誤判的陷阱：**本機開發環境是 Node 22，部署環境是 Node 20**（`Dockerfile` 為 `FROM node:20-alpine`，`render.yaml` 為 `NODE_VERSION: "20"`）。若未來的改動用到 `node:sqlite`（需 22.5+）、`structuredClone` 之外的 22 專屬 API，會出現「本機全綠、上線 `MODULE_NOT_FOUND`」。目前**未使用**任何 22 專屬 API，實測安全。

實測各版本建議：

| 版本 | 判定 | 說明 |
|---|---|---|
| Node 20 | ✅ 建議 | 與 `Dockerfile`、`render.yaml` 一致；Synology 官方套件中心有 v20 |
| Node 22 / 24 | ✅ 可用 | 本機即以此開發與測試 |
| Node 18 | ⚠️ 可用但不建議 | 已進入維護期尾聲，且多數 NAS 套件中心不提供 |
| Node 16 及以下 | ❌ 不可用 | 無全域 `fetch` |

### 1.3 記憶體：512 MB 機型就夠

實測（Windows，Node 22；Linux 上通常略低）：

| 狀態 | RSS |
|---|---|
| 閒置（僅啟動，未收任何請求） | **47–49 MB** |
| 完整載入首頁並取得行情後 | **98.6 MB** |
| 觀測到的峰值（含選股批次） | **116.4 MB** |

結論：**1 GB 機型綽綽有餘；512 MB 機型可跑，但需避免同時執行 DSM／QTS 的其他重型套件**（如相簿索引、虛擬機）。DSM 本身常佔 300–500 MB，故 512 MB 機型建議只在本機內網、低併發使用。

選股批次是記憶體尖峰來源：母體 154 檔（港股 70／美股 84），併發預設 4（`SCREEN_CONCURRENCY`，預設值寫死為 `DEFAULT_CONCURRENCY = 4`）。若要在低記憶體機型上跑選股，可調降此值。

### 1.4 儲存空間：以「程式」與「資料」分別看

**程式本體極小**（實測 `du -sh`）：

| 項目 | 大小 |
|---|---|
| `server.js` | 48 KB |
| `lib/`（25 個模組） | 428 KB |
| `public/`（前端 + 圖示） | 388 KB |
| **合計（實際部署所需）** | **872 KB** |
| 對照：`node_modules/`（開發用，部署不需要） | 49 MB |

**資料會持續成長，但成長很慢**：

| 目錄 | 內容 | 現況 | 成長估算 |
|---|---|---|---|
| `data/picks/` | 每日選股結果，一天一檔 JSON | 29 KB／檔 | **約 7.1 MB／年**（250 交易日） |
| `data/picks/`（篩選快取） | 同目錄，依查詢參數命名 | 少量 | 隨使用量成長，**無自動清理** |
| `data/econ-store/` | 經濟資料庫 `state.json` | 4 KB（4 筆） | 18 條序列 × 約 1000 期 ≈ 2 萬列，估 **2–5 MB** |
| `data/ism_pmi/` | ISM PMI 快照 | 2 KB | 幾乎不成長 |

> **注意：`data/picks/` 沒有保留期限，只增不減。** 實測 `grep` 未找到任何 `unlink`／`rmSync`／retention 邏輯。一年 7 MB 不算問題，但三年後是 21 MB 加篩選快取；若要無限期運行，建議自行加一個 cron 清理超過 N 天的舊檔。

**建議配置**：系統磁區 ≥ 500 MB 可用（含 Node 執行檔與映像層），資料磁區 ≥ 1 GB。

---

## 二、可用的部署方式

三條路徑，按推薦度排序。

### 2.1 容器化（推薦）

`Dockerfile` 已存在且可直接使用：`node:20-alpine`、零依賴安裝、`HEALTHCHECK` 打 `/api/health`、`CMD node server.js`、`EXPOSE 5177`。

| NAS 品牌 | 套件名稱 | 架構支援 | 備註 |
|---|---|---|---|
| **Synology**（DSM 7.2+） | Container Manager | **x86_64 確定支援**；ARM 說法不一，需自行確認 | 見下方說明 |
| **Synology**（DSM 7.0–7.1） | Docker | 同上 | 舊套件名稱即為 Docker |
| **QNAP**（QTS / QuTS hero） | Container Station | **x86 與 ARM 皆支援**（官方明示） | ARM 機型也能用 Compose 部署 |
| **Asustor** | App Central → Docker / Portainer | 依機型 | ADM 4.x 以上 |
| **TrueNAS SCALE** | 內建 Apps（K3s） | x86_64 | 以「Custom App」形式匯入映像 |
| **unRAID / OMV** | Docker 外掛 | x86_64 | — |

**關於 Synology ARM 機型：現有資料互相矛盾，不宜當作已知事實**

- **Synology 官方** Container Manager 頁面的「Applied Models」清單**明確包含** ARM 機型：`DS223`、`DS223j`、`DS124`（24/23 系列）、`DS220j`、`DS120j`（20 系列）。
- 但多篇**社群教學文章**（含中文與英文）都稱「Container Manager 只支援 x86，ARM 機型如 DS124／DS223／DS223j 不支援」。
- 讓上述官方清單更值得存疑的一點：Container Manager 與 Node.js v20 這兩份官方頁面的 Applied Models 清單**幾乎逐字相同**（同樣從 FS 系列列到 16 系列）。兩個套件的能力需求天差地遠，清單卻一致，暗示該清單可能是**套件家族層級的通用列表**，而非逐一驗證過的機型相容性。因此也不宜拿它當「ARM 一定可裝 Docker」的正面證據。

兩者直接衝突，且清單本身可信度存疑；**本次評估無實機可驗證**，故不對此下結論。

**實務建議——用套件中心自己判斷，這是最可靠的**：

1. 登入 DSM → 套件中心 → 搜尋 `Container Manager`
2. **搜得到且能安裝** → 走容器化路線
3. **搜不到** → 走 §2.2 原生安裝（本專案零依賴，原生安裝同樣簡單）

> 這個判斷方式的好處是不依賴任何二手資訊：套件中心只顯示與你的機型相容的套件。

**即使 ARM 真的不支援容器，也不影響本專案的可部署性**——因為零依賴，原生安裝只要能裝 Node 20 就行。這正是本專案相對於「需要編譯原生模組」的專案的優勢所在。

#### 建議的 `docker-compose.yml`

**目前專案沒有 compose 檔**（`ls | grep compose` 無結果）。以下為依實測事實撰寫的版本，可直接落地：

```yaml
services:
  stock-analyzer:
    image: node:20-alpine
    container_name: stock-analyzer
    working_dir: /app
    # 不 build，直接把程式碼掛進去——因為零依賴，不需要 npm install
    volumes:
      - /volume1/docker/stock-analyzer/app:/app:ro          # 程式碼唯讀
      - /volume1/docker/stock-analyzer/data:/app/data       # 資料可寫（必須）
    command: ["node", "server.js"]
    environment:
      - PORT=5177
      - TZ=Asia/Hong_Kong
      # - TELEGRAM_BOT_TOKEN=xxx        # 可改用環境變數取代 config.json
      # - TELEGRAM_CHAT_ID=xxx
      # - SCREEN_CONCURRENCY=2          # 低記憶體機型建議調降
      # - ENABLE_INPROCESS_CRON=1       # 常駐 NAS 可開啟，見 §6.3
    ports:
      - "5177:5177"                     # 內網用；對外請走反向代理，見 §4.2
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:5177/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    mem_limit: 256m                     # 峰值 116 MB，留一倍餘裕
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

三個關鍵設計，都有實測依據：

1. **不 `build`，直接掛載 `node:20-alpine` 執行** — 因為 `dependencies: {}`，不需要 `npm install`。這讓部署變成「複製 872 KB 檔案」而非「建置映像」，在 ARM NAS 上尤其省事（不需要編譯工具鏈，也不會遇到 QEMU 慢速建置）。
2. **`/app/data` 必須獨立掛載** — 見 §5.2。程式把資料路徑寫死為 `path.join(__dirname, '..', 'data')`，**沒有環境變數可改**，所以掛載點只能是 `/app/data`。
3. **`mem_limit: 256m`** — 依實測峰值 116.4 MB 設定，留約一倍餘裕；避免異常情況吃光 NAS 記憶體拖垮 DSM。

> 若偏好 `build` 路線也可以：`docker compose build` 會用現有 `Dockerfile`，建出的映像約 130–160 MB（主要是 Alpine + Node 基底）。兩種方式功能相同，掛載式的好處是**改程式不用重建映像**。

### 2.2 原生安裝（無 Docker 或不用 Docker 的機型）

因為零依賴，步驟比一般 Node 專案短很多：

1. 套件中心安裝 **Node.js v20**（Synology 官方套件，按機型提供）
2. 用 File Station 建立共享資料夾，例如 `stock-analyzer`
3. 上傳四個項目：`server.js`、`lib/`、`public/`、`package.json`
   （**不需要** `node_modules/`、`tests/`、`scripts/`、`config.json`）
4. 開 SSH，用 `nohup`／`screen`／或 DSM 工作排程器啟動：

```bash
cd /volume1/stock-analyzer
PORT=5177 node server.js
```

5. 若要常駐與開機自啟，用 **DSM 工作排程器**建立「開機時觸發」的使用者自訂指令碼（比手寫 systemd unit 簡單，且升級 DSM 不會被覆蓋）。

**原生安裝的注意事項**：

- Synology 的 Node.js 官方套件安裝後**不會**把 `node` 放進預設 `$PATH`，路徑類似 `/volume1/@appstore/Node.js_v20/usr/local/bin/node`，指令碼裡要用絕對路徑。
- **Node.js v20 套件的機型覆蓋很廣**：官方頁面的 Applied Models 從 16 系列一路列到 26 系列，含大量 ARM 機型（DS223、DS220j、DS218、DS218j、DS124、DS120j 等都在列）。這代表絕大多數還在服役的 Synology 機型都能直接裝到 v20。若你的機型真的不在列（多為更舊的 15 系列以前），再考慮手動安裝——但要留意下一條的 glibc 風險。
- 從 `nodejs.org` 直接下載的官方 Linux 二進位在 DSM 上**常因 glibc 版本不符而報 `Unsupported platform`**（Node 18/20 需要 glibc 2.28+，部分舊 ARM 機型不滿足）。優先用套件中心的版本；真的必須手動安裝時，先用 `ldd --version` 確認 glibc ≥ 2.28。
- 原生安裝沒有 `restart: unless-stopped` 的保護，行程掛掉不會自動重啟。建議搭配 DSM 工作排程器每 5 分鐘檢查一次 `/api/health`。

### 2.3 不建議：Railway / Render 等 PaaS

技術上完全可行（`DEPLOY.md` 已有完整說明），但與 NAS 部署的訴求相反：

- **Render 免費方案檔案系統是暫時性的**，且**不能掛載持久磁碟**。執行期寫入 `data/` 的內容（經濟資料庫、選股結果）會在重新部署或閒置回收後消失。
- 閒置 15 分鐘休眠，冷啟動 30–60 秒。

放上 NAS 的核心動機通常正是「資料要留在自己手上」，這點 PaaS 給不了。

---

## 三、必要的相依服務與網路連接埠

### 3.1 入站（Inbound）：只需 1 個 TCP 埠

| 埠 | 用途 | 說明 |
|---|---|---|
| **5177**（預設） | HTTP 服務 | 可用 `PORT` 環境變數覆蓋；`server.js:43` 為 `process.env.PORT \| 5177` |
| 5000 / 5001 | ❌ **勿用** | DSM 管理介面佔用，衝突時錯誤訊息不會告訴你原因 |
| 80 / 443 | 反向代理用（選用） | 見 §4.2 |

**只綁 `0.0.0.0`**（`server.js:965`：`server.listen(PORT, '0.0.0.0', ...)`），因此容器外的 NAS 主機與內網裝置都連得到，不需要額外設定。

### 3.2 出站（Outbound）：HTTPS 443，15 個實際請求網域

這是 NAS 部署**最容易漏掉**的一環。若 NAS 防火牆或路由器封鎖出站，服務本身「看起來正常」（首頁能開），但所有行情查詢都會失敗。

清單來自 `grep` 全部 `lib/*.js` 與 `server.js`，並**區分「真正發出請求」與「只當 `Referer` 標頭」**——這個區分很重要，因為只當 `Referer` 的網域不會產生任何 DNS 查詢或 TCP 連線，防火牆不需要放行它：

| 分組 | 實際請求的網域 | 用途 | 不用會怎樣 |
|---|---|---|---|
| **Yahoo** | `query1.finance.yahoo.com`<br>`query2.finance.yahoo.com`<br>`fc.yahoo.com` | 主要行情、復權 K 線（10 年）、crumb／cookie 工作階段 | **預測模組失效**、行情退化為備援來源 |
| **東方財富** | `push2.eastmoney.com`<br>`push2his.eastmoney.com`<br>`searchapi.eastmoney.com` | 備援行情、港股 K 線 | 備援失效 |
| **騰訊** | `qt.gtimg.cn`<br>`web.ifzq.gtimg.cn`<br>`ifzq.gtimg.cn`<br>`proxy.finance.qq.com`<br>`smartbox.gtimg.cn` | 港股行情、中文搜尋、K 線 | 港股功能與中文搜尋失效 |
| **新浪** | `hq.sinajs.cn` | 備援報價 | 備援失效 |
| **Stooq** | `stooq.com` | 最後備援日線 | 備援失效 |
| **FRED** | `fred.stlouisfed.org` | 宏觀經濟指標（18 條序列） | **宏觀頁全空** |
| **SEC** | `data.sec.gov`<br>`www.sec.gov` | 企業財報（XBRL） | 財報功能失效 |
| **聯準會** | `www.federalreserve.gov` | FOMC 會議日程 | FOMC 倒數失效 |
| **Telegram** | `api.telegram.org` | 價格通知推送 | 通知退回模擬模式 |
| **LLM** | 預設 `api.openai.com`<br>（本機 `config.json` 實際指向 `www.moyu.cn`） | AI 潤飾（選用） | 退回規則型解讀，功能不受損 |

**只需列在 `Referer`、不必放行的網域**（實測 `grep` 確認無任何 `fetch()` 指向它們）：

| 網域 | 角色 |
|---|---|
| `finance.yahoo.com` | Yahoo 請求的 `Referer` / `Origin` 標頭 |
| `gu.qq.com` | 騰訊請求的 `Referer` 標頭 |
| `quote.eastmoney.com` | 東方財富請求的 `Referer` 標頭 |

> 若你的防火牆是「白名單模式」且以 FQDN 為單位，這三個可以省下；但它們只是標頭內容，瀏覽器端也不會去連，所以**不需要**放行。若你的防火牆會檢查 `Referer` 中的網域並要求可解析，再加即可。

**驗證方法（強烈建議部署後第一步就做）**：

```bash
curl -s "http://<NAS-IP>:5177/api/diag" | head -c 2000
```

這個端點會逐一探測 14 個目標（含 Cloudflare 與 example.com 作對照），回傳每個目標的 `ok`、`status`、`ms`。**這比逐條 `curl` 快得多，而且是專案內建的**。

實測本機完整輸出（逐項）：

```
cloudflare     OK   200          tencent        OK   200
example        OK   200          tc-kline       OK   200
yahoo          OK   200          tc-kline-web   OK   200
yahoo2         OK   200          tc-kline-px    OK   200
em-his         OK   200          tc-search      OK   200
telegram       OK   200
eastmoney      FAIL UND_ERR_SOCKET
sina           FAIL 403
stooq          FAIL 403
```

**這裡有一個很容易誤判的地方**：上面三個 `FAIL` 是**正常的**，不代表 NAS 出網有問題。

- `sina`、`stooq` 回 403 是因為診斷請求只帶了通用 User-Agent／Referer，這兩家對裸請求就回 403。程式正式呼叫時會帶對應的 `Referer`，實測行情查詢正常。
- `eastmoney` 的 `UND_ERR_SOCKET` 在本機屬間歇性（`em-his` 同一家的另一個端點是 200）。它是**備援來源**，不影響主流程。

**正確的判讀方式**：不要看通過數量，要看**關鍵目標**。

| 目標 | 判讀 |
|---|---|
| `cloudflare` | `false` → NAS 根本沒有出網（防火牆／路由問題） |
| `example` | `false` → DNS 有問題 |
| `yahoo` + `yahoo2` | 兩者皆 `false` → **主要行情來源不通，預測模組會失效** |
| `tencent` + `tc-*` | 任一 `false` → 港股功能／中文搜尋受影響 |
| `sina` / `stooq` / `eastmoney` | `false` → **可忽略**，僅備援 |

> 注意 `/api/diag` **不包含** FRED、SEC、FOMC、LLM 這四組。要驗證宏觀頁，需另外直接打 `/api/macro`（見 §6.2 第 ⑥ 步）。

### 3.3 不需要的相依服務

明確說明「不需要什麼」，可以省下很多排查時間：

- ❌ **不需要資料庫**（沒有 MySQL／PostgreSQL／Redis）
- ❌ **不需要反向代理才能啟動**（可直連 5177）
- ❌ **不需要編譯工具鏈**（無 `gcc`／`make`／`python`）
- ❌ **不需要 `npm install`**（實測無 `node_modules` 亦可運行）
- ❌ **不需要外網域名**（純內網 IP 即可用，代價是 PWA 失效，見 §6.2）

---

## 四、權限與資料存放位置

### 4.1 唯一的可寫路徑：`data/`

實測 `grep -rn "path.join(__dirname, '..'"`，執行期會碰到的路徑只有五處，其中**寫入**的只有 `data/` 下的三個子目錄：

| 路徑 | 讀寫 | 用途 | 遺失後果 |
|---|---|---|---|
| `data/picks/` | 讀 + 寫 | 每日選股結果、篩選快取 | 重算即可，**可安全丟棄** |
| `data/econ-store/state.json` | 讀 + 寫 | 經濟資料庫（三表） | 需重新同步，**會丟修訂軌跡** |
| `data/ism_pmi/latest.json` | 讀 | ISM PMI 快照 | 需重新抓取 |
| `config.json`（專案根目錄） | **只讀** | Telegram／LLM 憑證 | 退回模擬／規則模式 |
| `public/` | **只讀** | 靜態資源 | — |

**關鍵：`data/` 目錄本身不存在時，程式會自動建立**（`econ-store.js` 的 `save()` 內有 `fs.mkdirSync(dir, { recursive: true })`）。實測：全新目錄啟動 → `data/` 不存在 → 寫入一筆觀測值後 → `data/econ-store/state.json` 自動出現，4 KB。這個行為對部署友善，但也意味著**若掛載點權限不對，錯誤會在第一次寫入時才爆出來**（見 §4.3）。

### 4.2 容器權限：目前以 root 執行

`Dockerfile` **沒有 `USER` 指令**，容器內行程以 `root`（UID 0）執行。在 NAS 上這會產生一個具體麻煩：

> 掛載 `/volume1/docker/stock-analyzer/data` 進容器後，容器內 root 寫出的檔案在 NAS 上會變成 **root 擁有**。之後用 DSM 的 File Station 或一般使用者帳號可能無法讀取／刪除，備份套件也可能跳過。

三種處理方式，按簡便度排序：

| 做法 | 指令 | 評價 |
|---|---|---|
| **A. 指定執行 UID**（推薦） | 在 compose 加 `user: "1026:100"`（`1026` 為 NAS 上你的使用者 UID，可用 `id` 查） | 檔案擁有權與 NAS 一致，最乾淨 |
| **B. 事前 chown** | `sudo chown -R 1026:100 /volume1/docker/stock-analyzer/data` | 簡單，但容器重建後若 UID 變動需重做 |
| **C. 放行 root 寫入** | 什麼都不做 | 能用，但檔案擁有權混亂，長期難維護 |

> UID 取得方式：SSH 進 NAS 執行 `id`，第一欄 `uid=1026(yourname)` 的數字即是。Synology 首個建立的使用者通常是 `1026`。

### 4.3 權限錯誤的表現方式（實測）

這一點值得寫清楚，因為錯誤訊息會誤導人。

實測：把 `data` 位置換成一個**同名檔案**（模擬路徑被佔用／掛載失敗），然後寫入一筆資料。結果：

```json
{"ok":false,"error":{
  "code":"UPSTREAM_ERROR",
  "message":"取得資料時發生問題，請稍後重試",
  "hint":"ENOTDIR: not a directory, mkdir '...\\data\\econ-store'"}}
```

兩個觀察：

1. **錯誤是「響」的，不是靜默的** — `ok:false`，寫入確實失敗，不會假裝成功。
2. **但錯誤碼是錯的** — 回傳 `UPSTREAM_ERROR`（上游錯誤），實際上是本機檔案系統錯誤。訊息文案「取得資料時發生問題」也會讓人以為是網路問題。

**排查提示**：若 `/api/econ/observations` 回 `UPSTREAM_ERROR` 但 `hint` 裡有 `ENOTDIR`／`EACCES`／`EPERM`，那是**掛載或權限問題，不是網路問題**。請直接看 `hint` 欄位，不要看 `message`。

另外實測：`/api/econ/status` 這類**只讀**端點在同樣情況下仍回 `ok:true`（因為它只讀記憶體狀態，不碰磁碟）。所以「status 正常」**不能**證明寫入正常——驗證持久化必須實際寫一筆。

### 4.4 資料持久化的驗證清單

部署後依序執行，四步全部通過才算真的持久化：

```bash
# 1. 寫入一筆
curl -s -X POST http://<NAS-IP>:5177/api/econ/observations \
  -H "Content-Type: application/json" \
  -d '{"rows":[{"seriesKey":"nasTest","period":"2026-11","value":1}]}'
# 預期：{"ok":true,...,"inserted":1,"ids":["nasTest|2026-11"]}

# 2. 確認檔案落地（在 NAS 上執行）
ls -la /volume1/docker/stock-analyzer/data/econ-store/state.json

# 3. 重啟容器
docker restart stock-analyzer

# 4. 確認資料還在
curl -s "http://<NAS-IP>:5177/api/econ/query?seriesKey=nasTest"
# 預期：看得到 period 2026-11、value 1
```

第 2 步是關鍵：**這是唯一能確認「掛載真的生效」的方式**。若第 2 步找不到檔案而第 1 步回 `ok:true`，代表資料寫進了容器的可寫層（重啟即消失）。

---

## 五、可能的功能限制與不相容情況

按嚴重度排序，全部經實測。

### 5.1 【高】子路徑部署會整站壞掉

**症狀**：把服務掛在 `https://nas/screener/` 這種子路徑下，首頁能開，但樣式、腳本、圖示全部失效。

**實測證據**：

```
GET /screener/app.js              → 200, Content-Type: text/html  ← 錯！應為 text/javascript
GET /screener/styles.css          → 200, Content-Type: text/html  ← 錯！
GET /screener/sw.js               → 200, Content-Type: text/html  ← 錯！
GET /screener/manifest.webmanifest→ 200, Content-Type: text/html  ← 錯！
```

回傳的內容其實是 `index.html` 的內容。原因有兩層：

1. **`index.html` 使用絕對路徑**：`src="/app.js"`、`href="/styles.css"`、`href="/manifest.webmanifest"`（共 8 處）。瀏覽器會向網域根目錄要檔案，而非子路徑。
2. **`serveStatic()` 有 SPA 回退**：找不到檔案時一律回 `index.html`（`server.js:180-186`），且固定帶 `text/html`。所以請求 `app.js` 會拿到一份 HTML，瀏覽器因 MIME 不符而拒絕執行。

**可行做法**：

| 做法 | 評價 |
|---|---|
| **獨立子網域**（`stock.example.com` → 反代到 `:5177`） | ✅ 最乾淨，PWA 的 `scope: "/"` 也正確 |
| **獨立埠**（`http://nas:5177` 直連） | ✅ 最簡單 |
| **反代到根路徑**（`https://nas/` → `:5177`） | ✅ 可行，但會與 DSM 自身的 `/` 衝突 |
| 子路徑（`https://nas/screener/`） | ❌ **不可用**，需改程式才能支援 |

> 副檔名 MIME 對照在 `server.js:46-55`，`sw.js` 另設 `Cache-Control: no-cache` 與 `Service-Worker-Allowed: /`。這些都假設「部署在根路徑」。

### 5.2 【高】Service Worker 需安全來源 → 內網 HTTP 失去 PWA

**這是 NAS 部署最實質的功能損失**，且無法用程式繞過（瀏覽器安全策略）。

**實測對照**：

| 存取方式 | `isSecureContext` | `'serviceWorker' in navigator` | 結果 |
|---|---|---|---|
| `http://127.0.0.1:5177` | `true` | `true` | ✅ SW 註冊成功、離線可用 |
| `http://192.168.108.249:5177` | **`false`** | **`false`** | ❌ SW 完全不註冊 |

程式本身有正確的防護（`public/app.js:74-80`），遇到非安全來源會明確 `console.info` 說明原因並跳過註冊，不會報錯——這是好的設計，但也意味著**使用者不會看到任何錯誤提示，只會發現「怎麼不能加到主畫面」**。

**受影響的功能**：

| 功能 | 內網 HTTP | HTTPS |
|---|---|---|
| 離線瀏覽介面 | ❌ | ✅ |
| 加入主畫面（iOS / Android） | ❌ | ✅ |
| 離線看 30 分鐘內行情 | ❌ | ✅ |
| 所有線上功能（查詢、分析、選股） | ✅ 正常 | ✅ 正常 |

**解法**（任選一）：

1. **反向代理 + 自簽憑證**：Synology DSM 內建「登入入口 → 進階 → 反向代理」，QNAP 有「反向代理」應用。配合 DSM 內建的憑證申請（Let's Encrypt）或自簽憑證。
   - 注意：自簽憑證在 iOS 上需要手動「信任」描述檔才能被視為安全來源，步驟繁瑣但一次性。
2. **用 Tailscale / Cloudflare Tunnel 提供 HTTPS**，不需開任何入站埠，憑證自動。
3. **接受沒有 PWA**：純內網、桌機瀏覽器使用時，這個損失其實可以接受——所有分析功能都不受影響。

> 補充：專案的 `DEPLOY.md` §五已記載「部署在 HTTPS 域名下，PWA 全部功能正常」。NAS 部署時若走 HTTP，該節內容不成立。

### 5.3 【中】只能單一實例——整檔覆蓋寫入、無檔案鎖

**實測已重現資料遺失**：

```js
// 兩個獨立 store 實例指向同一檔案（模擬兩個容器共用一個 data/）
const a = openStore({ dir });   // 讀入空狀態
const b = openStore({ dir });   // 讀入空狀態
a.writeMany([{ seriesKey:'k', period:'2026-01', value:1 }]);  // a 寫入並整檔存檔
b.writeMany([{ seriesKey:'k', period:'2026-02', value:2 }]);  // b 用「自己記憶體裡的舊狀態」整檔覆蓋

// 最終檔案內容：
//   k|2026-02  value:2
//   （k|2026-01 已消失）
```

原因：`econ-store` 是**把整個 `state.json` 從記憶體序列化後覆寫**，並非增量寫入；且 `grep` 全部程式碼**找不到任何 `flock`／`O_EXCL`／檔案鎖**實作。

**這在 NAS 上的具體風險**：

- ❌ 不要用兩個容器指向同一 `data/`（例如為了「藍綠部署」或「多埠」）
- ❌ 不要同時跑原生安裝與容器版本
- ❌ 不要設 `restart: always` 又手動 `docker run` 一份（會短暫雙實例）
- ✅ 單一容器 + `restart: unless-stopped` 完全安全

> 註：**單實例內**的併發是安全的。Node 是單執行緒，`writeMany` 是同步執行完才 `save()`，且原子寫入（見 §5.6）保證檔案不會寫壞。問題只在「多個行程／多個 store 實例」。

### 5.4 【中】無任何存取控制，`CORS: *`

實測 `server.js:230-232`：

```js
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
```

且 `grep` 全專案**沒有** `rateLimit`、沒有 IP 限流、沒有登入機制。唯一的「認證」是 `PICKS_TOKEN`，且只保護 `/api/picks?run=1`（強制重跑），不保護其他任何端點。

**NAS 部署的含意**：

- ✅ **純內網使用（推薦）**：風險可接受。這是個人分析工具，不是公開服務。
- ⚠️ **若透過 DDNS／連接埠轉發對外開放**：任何人只要知道網址，就能
  - 觸發 `/api/picks?run=1`（**跑滿 154 檔的完整掃描**，CPU 與上游請求量都不小）
  - 讀寫經濟資料庫（`POST /api/econ/observations` 無認證）
  - 透過 `/api/notify` **用你的 Telegram Bot 發訊息**（若已設定憑證）
  - 透過 `/api/interpret?mode=llm` **消耗你的 LLM 額度**

**若真的需要對外**，至少做兩層：

1. 在 NAS 反向代理層加 **Basic Auth**（Synology／QNAP 都支援）
2. 設定 `PICKS_TOKEN`，並考慮在反向代理層限制 `/api/econ/*` 只允許內網來源

### 5.5 【低】寫入效能：NAS 硬碟約慢 3–10 倍

實測（本機 SSD）：

```
5000 筆觀測值 → state.json 240 KB
100 次寫入（每次含全量序列化 + 原子替換）耗時 405 ms → 4.0 ms／次
```

換算到 NAS 的 5400 rpm 硬碟（隨機寫入約慢 3–10 倍）：**約 12–40 ms／次**。若資料落在 SSD 快取或 NVMe 儲存池，接近本機數字。

**這個量級會不會有問題**：不會。經濟資料庫的寫入頻率極低（每天同步一次，或使用者手動觸發），40 ms 完全無感。**唯一需要注意的是「一次寫入大量歷史資料」**——例如首次同步 18 條序列、每條 1000 期，會觸發 18 次全量存檔（每次約 240 KB），總計不到 1 秒。

> 效能上**不要**把 `data/` 放在網路磁碟（SMB／NFS 掛載）上。原子寫入用 `rename`，跨檔案系統會 `EXDEV`。本專案的 `tmp` 檔是 `${filePath}.tmp`（同目錄），所以**本機路徑安全**；但若整個 `data/` 是 NFS 掛載點，`writeFileSync` 的可靠性與 `rename` 的原子性都取決於 NFS 實作，不建議。

### 5.6 【低】原子寫入的邊界：保護檔案，不保護行程

正面事實（實測）：`save()` 用 `writeFileSync(tmp)` → `renameSync(tmp, target)`，`tmp` 與目標**同目錄**，因此：

- ✅ 不會有 `EXDEV` 跨檔案系統錯誤
- ✅ 中途斷電不會留下半個 JSON（`rename` 是原子操作）
- ✅ 實測 200 次連續寫入 0 錯誤，檔案仍是合法 JSON
- ✅ 讀到損壞檔時會改名為 `state.json.corrupt-<timestamp>` 並重建，**不覆蓋原檔**

風險（如實說明）：`server.js` **沒有** `SIGTERM` / `SIGINT` 處理器（只有 `unhandledRejection`）。`docker stop` 送 `SIGTERM` 時，行程會直接結束，**正在進行中的寫入會被中斷**。因為是原子替換，最壞結果是「這一筆沒寫進去」，不會是「檔案壞掉」。對本專案的資料性質（可重新同步）而言，這個取捨合理。

### 5.7 【低】時區：設計正確，但別忘了設 `TZ`

實測 `grep` 全部 `getHours`／`getDate`／`toLocaleDateString`，**只有一處**使用本地時區，且該處**明確指定**了時區：

```js
// lib/telegram.js:73
`更新時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Hong_Kong' })}`
```

其餘排程邏輯（`lastSettledCutoff`、`dateKey`）全部使用 `getUTC*`，以 UTC 20:00 為統一切盤點。**這是正確的做法**——不依賴主機時區。

因此容器時區設不設都不影響正確性。但仍建議設 `TZ=Asia/Hong_Kong`，理由是**便於看日誌**（`console.log` 的時間戳會是本地時間）。

### 5.8 【低】`config.json` 的處理

`lib/telegram.js:19-27` 與 `lib/interpret.js:642-651` 的讀取順序是：**環境變數優先，`config.json` 次之**。所以有兩條路：

| 做法 | 適用 |
|---|---|
| 環境變數注入（`TELEGRAM_BOT_TOKEN` 等） | ✅ 容器部署推薦，憑證不落地 |
| 掛載 `config.json` 進 `/app/config.json` | 原生安裝較方便 |

注意 `.dockerignore` 已排除 `config.json`，所以**建置映像時它不會被複製進去**。若走 build 路線，必須用環境變數或額外掛載。

> 憑證留空的後果是「優雅降級」而非報錯：Telegram 退回模擬模式（`/api/health` 的 `telegram: false`）、LLM 退回規則型解讀。功能不受損，只是沒有推送與 AI 潤飾。

---

## 六、部署前置檢查清單

### 6.1 開工前（在 NAS 上確認）

| # | 檢查項 | 指令／位置 | 通過標準 |
|---|---|---|---|
| 1 | CPU 架構 | SSH：`uname -m` | 容器：`x86_64` 或 `aarch64`；原生：任何 |
| 2 | 是否有 Docker | 套件中心搜 Container Manager | 搜得到 → 容器化；**搜不到 → 走原生安裝**（§2.2） |
| 3 | Node 版本 | `node -v`（原生安裝） | ≥ 18，建議 20 |
| 4 | 記憶體 | 資源監控 | ≥ 1 GB 建議；512 MB 可用但別跑其他重套件 |
| 5 | 可用空間 | 儲存空間 | ≥ 500 MB（程式）+ 1 GB（資料） |
| 6 | 埠 5177 是否被佔 | `sudo netstat -tulpn \| grep :5177` | 無輸出 |
| 7 | 出網是否正常 | 部署後打 `/api/diag` | `cloudflare.ok === true` |
| 8 | 資料夾權限 | `ls -ld <data 目錄>` | 執行 UID 可寫 |

### 6.2 部署後（依序執行，全部通過才算成功）

```bash
BASE=http://<NAS-IP>:5177

# ① 服務活著
curl -s $BASE/api/health
#    預期 {"ok":true,...}；telegram 欄位依是否設定憑證而定

# ② 出網正常（14 個目標逐項回報）
curl -s $BASE/api/diag
#    判讀「關鍵目標」而非通過數量：cloudflare、example、yahoo、yahoo2、tencent 必須為 true
#    sina / stooq / eastmoney 為 false 屬正常（見 §3.2）

# ③ 靜態資源 MIME 正確（驗證不是子路徑部署）
curl -s -o /dev/null -w "%{content_type}\n" $BASE/app.js
#    預期 text/javascript  ← 若是 text/html，代表路徑配置有問題

# ④ 真實行情（驗證上游連通）
curl -s "$BASE/api/analyze?symbol=AAPL" | head -c 300
#    預期含 score、verdict、buyZone

# ⑤ 港股管線
curl -s "$BASE/api/analyze?symbol=0700.HK" | grep -o '"currency":"[A-Z]*"'
#    預期 "HKD"

# ⑥ 宏觀頁上游（FRED／SEC／FOMC 不在 /api/diag 的探測範圍內，需單獨驗）
curl -s "$BASE/api/macro?refresh=0" | head -c 300
#    預期含各指標 key 與 latest 值；全空代表 FRED 被封鎖

# ⑦ 持久化（四步，見 §4.4）
#    寫入 → 檢查檔案存在 → 重啟容器 → 再查詢

# ⑧ PWA（選用，需 HTTPS）
#    瀏覽器 DevTools → Application → Service Workers
#    預期看到已啟用的 SW；若在 http://內網IP 下看不到，屬預期行為
```

### 6.3 一次性設定建議

| 設定 | 值 | 理由 |
|---|---|---|
| `PORT` | `5177`（或自訂） | 避開 DSM 的 5000/5001 |
| `TZ` | `Asia/Hong_Kong` | 日誌可讀性（不影響計算正確性） |
| `SCREEN_CONCURRENCY` | `2`（低記憶體機型） | 預設 4；記憶體吃緊時降載 |
| `ENABLE_INPROCESS_CRON` | 常駐 NAS 建議 `1` | 見下方說明 |
| `PICKS_TOKEN` | 隨機字串 | 若需對外開放，至少擋住強制重跑 |

**關於 `ENABLE_INPROCESS_CRON`**：專案預設**不啟用**進程內定時器，設計理由是「在多數免費 PaaS 上它無效，開了反而製造『以為有排程』的假象」。但這條理由**在 NAS 上不成立**——NAS 是常駐機器，定時器確實會跑。

因此：

- **常駐 NAS**：設 `ENABLE_INPROCESS_CRON=1`，程式會每 30 分鐘檢查一次是否該產生當日選股結果。
- 若不設，則靠「訪問觸發」（開啟選股頁時自動補跑）。對個人使用來說兩者差別不大，但若要每天收 Telegram 通知，**必須**開啟定時器或設定外部 cron。

> 若偏好外部 cron（較可控），保持 `ENABLE_INPROCESS_CRON` 未設，改用 DSM 工作排程器每天定時打一次 `curl "$BASE/api/picks?run=1&token=<PICKS_TOKEN>"`。

---

## 七、後續維護重點

### 7.1 更新程式碼

因為零依賴，更新就是「覆蓋四個項目」：

```bash
# 容器（掛載式部署）
git pull                                    # 在 NAS 的 app 目錄
docker restart stock-analyzer               # 重啟即生效

# 容器（build 式部署）
git pull && docker compose up -d --build

# 原生安裝
git pull && <重啟 node 行程>
```

**沒有 `npm install` 這一步**（除非改了 `devDependencies`，而那只影響測試）。

### 7.2 備份

只有兩個東西值得備份：

| 對象 | 頻率 | 說明 |
|---|---|---|
| `data/econ-store/state.json` | 每週 | 經濟資料庫；丟了要重新同步，且修訂軌跡不可重建 |
| `config.json`（或環境變數） | 變更時 | 憑證 |

`data/picks/` **不需要備份**（每日重算，歷史價值低）。用 DSM Hyper Backup 排除該子目錄即可。

### 7.3 監控

| 項目 | 方法 | 告警條件 |
|---|---|---|
| 服務存活 | 定期打 `/api/health` | 連續 3 次非 200 |
| 出網可用 | 定期打 `/api/diag` | 任一主要來源連續失敗 |
| 磁碟空間 | NAS 內建監控 | `data/` 所在磁區 < 10% |
| 記憶體 | 容器 stats | 持續 > 80% of `mem_limit` |
| 日誌 | `docker logs --tail 100 stock-analyzer` | 出現 `ENOTDIR`／`EACCES` → 掛載或權限問題 |

`/api/health` 的回應帶 `telegram` 布林值，可一併監控通知管道是否還通。

### 7.4 已知的長期維護事項

| 事項 | 現況 | 建議 |
|---|---|---|
| **`data/picks/` 無清理機制** | 只增不減，約 7 MB／年 | 若長期運行，加 cron 刪除 90 天前的檔案 |
| **`server.js` 無 `SIGTERM` 處理** | `docker stop` 可能中斷進行中的寫入 | 因為是原子替換，風險僅限「這一筆沒寫進去」，可不處理 |
| **子路徑部署不支援** | `index.html` 用絕對路徑 | 若真有需求，需改成相對路徑 + `<base>`，屬程式改動 |
| **無認證機制** | 全部端點開放 | 僅內網使用；對外必加反向代理 Basic Auth |
| **Node 版本漂移** | 部署 20、本機 22 | 升級前先確認未引入 22 專屬 API |
| **經濟資料庫無 `DATA_DIR` 環境變數** | 路徑寫死 `../data` | 容器掛載點只能是 `/app/data`；若要改需動程式 |

### 7.5 何時該重新評估

出現以下任一情況，本文的部分結論需要更新：

- 引入任何 `dependencies`（→ ARM 原生安裝可能失敗，需重新驗證）
- 改用 SQLite（→ `node:sqlite` 需 Node 22.5+，或 `better-sqlite3` 需編譯）
- 經濟資料庫改為多實例部署（→ §5.3 的單實例限制變成阻礙）
- 需要對外公開（→ §5.4 的無認證問題變成阻擋級）

---

## 附錄 A：評估方法與未實測項目

**已實測**（本機 Windows / Node 22.22.2）：

- 零依賴啟動：複製 `server.js`、`lib/`、`public/`、`package.json` 到空目錄，無 `node_modules`，`/api/health` 回 `ok:true`，`/api/macro/AAPL` 完成真實 FRED 抓取
- 記憶體：閒置 47–49 MB、載入後 98.6 MB、峰值 116.4 MB
- 冷啟動：155 ms（spawn 到第一個 200）
- 寫入吞吐：4.0 ms／次，5000 筆 = 240 KB
- 原子寫入：200 次連續寫入 0 錯誤，檔案仍為合法 JSON
- 權限失敗：`data` 被檔案佔用 → 回 `UPSTREAM_ERROR` + `hint: ENOTDIR`
- 多實例覆蓋：兩 store 共用檔案 → 先寫入的資料被覆蓋丟失
- 子路徑：`/screener/app.js` 回 `200 + text/html`（實為 `index.html`）
- Service Worker：`127.0.0.1` → `isSecureContext:true`；`192.168.108.249` → `false`（`'serviceWorker' in navigator` 為 `false`）
- 資料自動建立：全新目錄 → 首次寫入後 `data/econ-store/state.json` 自動出現
- 出網清單：`grep` 全部 `lib/*.js` + `server.js`，並以 `/api/diag` 實際探測
- 環境變數清單：`grep process.env.*` 全專案

**未實測**（如實說明）：

| 項目 | 原因 | 影響 |
|---|---|---|
| **Docker 映像建置與執行** | 本機無 Docker | 已用「無 `node_modules` 直接跑」等效驗證零依賴假設；`Dockerfile` 邏輯簡單，風險低，但**未實際 build 過** |
| **ARM 架構實機執行** | 無 ARM 機器 | 零依賴 + 純 JS，理論上無風險；`node:20-alpine` 為官方多架構映像 |
| **NAS 硬碟寫入延遲** | 無 NAS 環境 | 以「慢 3–10 倍」估算，並說明明確為估算 |
| **DSM／QTS 實際操作流程** | 無 NAS 環境 | 平台能力（Node 套件按機型提供、Container Manager 的 ARM 支援存疑）來自官方頁面與社群文件，兩者對 ARM 的記載**互相矛盾**，已於 §2.1 如實標註並改為「以套件中心實際可安裝為準」 |

**平台資訊來源**：Synology 官方套件頁（Node.js v20、Container Manager 支援機型清單）、SynoCommunity 相容性文件、QNAP Container Station 官方說明、Docker 官方 `node` 映像架構清單。此類資訊隨版本變動，部署前請以**套件中心實際可搜尋到的項目**為準——套件中心只會顯示與你的機型相容的套件，這是最可靠的判斷方式。

---

## 附錄 B：三種部署情境的推薦配置

| 情境 | 機型示例 | 推薦方式 | PWA | 關鍵設定 |
|---|---|---|---|---|
| **純內網、桌機為主** | 任意 x86 NAS | 容器（掛載式） | ❌ 不需要 | 直連 `:5177`；`user` 指定 UID；掛載 `data/` |
| **內網 + 手機加到主畫面** | Synology x86 | 容器 + 反代 HTTPS | ✅ | 獨立子網域 + Let's Encrypt；根路徑部署 |
| **ARM 機型（若無 Docker）** | DS223 / DS220j | 原生安裝 | ❌ | 套件中心裝 Node 20；DSM 工作排程器做自啟與健康檢查；絕對路徑呼叫 node |
| **需要在外網存取** | 任意 | 容器 + Tailscale／CF Tunnel | ✅（Tunnel 提供 HTTPS） | 不開入站埠；反代層加 Basic Auth |
