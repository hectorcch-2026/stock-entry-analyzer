# 上傳到 GitHub —— 你的專屬步驟清單

> 你的帳號：`hectorcch-2026`　·　倉庫：`stock-entry-analyzer`
> **本地已完成**：git 倉庫、首次提交、遠端位址、身分設定。
> **剩下只有 3 步**：建遠端倉庫 → 產生 token → push。

---

## 已完成的部分（不用再做）

| 項目 | 狀態 |
|---|---|
| 本地 git 倉庫 | ✅ 已建立（分支 `main`） |
| 首次提交 | ✅ `0f70dcd`，共 40 個檔案 |
| 提交身分 | ✅ `hectorcch-2026 <hectorcch-2026@users.noreply.github.com>` |
| 遠端位址 origin | ✅ `https://github.com/hectorcch-2026/stock-entry-analyzer.git` |
| `config.json` 排除 | ✅ 含 Telegram token，**未**進入版本控制 |
| `node_modules` 排除 | ✅ 49 MB 依賴**未**上傳 |
| 憑證掃描 | ✅ 全庫無真實 token / chat id |

---

## 第 1 步：在 GitHub 建立空倉庫

1. 開啟 <https://github.com/new>
2. 填寫：
   - **Repository name**：`stock-entry-analyzer`
   - **Description**（選填）：`股票量化分析專業介面`
   - **Visibility**：建議 `Public`（Render 免費方案對私有庫也支援，但公開庫部署最順）
3. **重要**：以下三個選項**全部不要勾**
   - ❌ Add a README file
   - ❌ Add .gitignore
   - ❌ Choose a license
4. 按 **Create repository**

> 為什麼不能勾？因為你本地已經有提交了。若遠端也初始化了 README，
> 兩邊歷史會衝突，push 會被拒絕。保持遠端**完全空白**最省事。

---

## 第 2 步：產生 Personal Access Token（當作密碼用）

GitHub 從 2021 年起**不接受帳號密碼**推送，必須用 token。

1. 開啟 <https://github.com/settings/tokens?type=beta>（Fine-grained token）
2. 按 **Generate new token**
3. 填寫：
   - **Token name**：`stock-analyzer-push`
   - **Expiration**：90 days（過期再產生一個即可）
   - **Repository access**：選 `Only select repositories` → 選 `stock-entry-analyzer`
   - **Permissions** → 展開 `Repository permissions` → 找到 **Contents** → 改成 `Read and write`
4. 按 **Generate token**
5. **立刻複製**那串 `github_pat_...`（離開頁面就看不到了）

> 用 Classic token（<https://github.com/settings/tokens/new>）也可以，
> 勾選 `repo` 範圍即可，步驟更少。

---

## 第 3 步：推送

在 `stock-entry-analyzer` 目錄下執行：

```bash
git push -u origin main
```

它會詢問：

```
Username for 'https://github.com': hectorcch-2026
Password for 'https://hectorcch-2026@github.com': ← 貼上剛剛的 github_pat_...
```

> 貼上 token 時**螢幕不會顯示任何字元**，這是正常的，直接按 Enter。

看到類似下面的輸出就成功了：

```
Enumerating objects: 50, done.
Writing objects: 100% (50/50), 1.21 MiB, done.
To https://github.com/hectorcch-2026/stock-entry-analyzer.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
```

---

## 第 4 步：確認

開啟 <https://github.com/hectorcch-2026/stock-entry-analyzer>

**必看這兩件事**：

1. 檔案列表裡**沒有** `config.json` ✅
2. 檔案列表裡**沒有** `node_modules/` ✅

如果有看到，立刻停止並告訴我——那代表 token 洩漏到公開網路上，需要馬上撤銷。

---

## 第 5 步：接上 Render

倉庫上傳成功後，就可以照 `DEPLOY.md` 部署：

1. <https://dashboard.render.com/blueprints> → **New Blueprint Instance**
2. 選 `stock-entry-analyzer` 倉庫（`render.yaml` 會被自動識別）
3. Render 會要求你填兩個環境變數，值從**本機** `config.json` 複製：
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. 部署完成後驗證：`curl https://<你的網址>/api/health`
   → 必須看到 `"telegram":true`

---

## 之後的日常更新

改完程式碼後，三行搞定：

```bash
git add -A
git commit -m "說明這次改了什麼"
git push
```

Render 會偵測到 push 並自動重新部署（`render.yaml` 裡 `autoDeploy: true`）。

**不想每次輸入 token？** 執行一次這個（存入 Windows 憑證管理員）：

```bash
git config --local credential.helper manager
```

下次 push 輸入一次 token 後就會記住。

---

## 常見錯誤對照

| 錯誤訊息 | 原因 | 解法 |
|---|---|---|
| `Authentication failed` | 用了帳號密碼，或 token 權限不足 | 重做第 2 步，確認 Contents 是 Read and write |
| `remote: Repository not found` | 倉庫名稱拼錯，或 token 沒授權該倉庫 | 確認網址是 `hectorcch-2026/stock-entry-analyzer` |
| `Updates were rejected` | 遠端不是空的（勾了 README） | 見下方「已勾選 README 的補救」 |
| `Support for password authentication was removed` | 同上，用了密碼 | 改用 token |
| push 卡住不動 | 網路 / 代理問題 | 確認能開 github.com，必要時關代理重試 |

### 已勾選 README 的補救

若第 1 步不小心勾了 README，push 會被拒絕。執行：

```bash
git pull --rebase origin main --allow-unrelated-histories
git push -u origin main
```

若出現衝突（通常在 README.md），保留你本地的版本：

```bash
git checkout --ours README.md
git add README.md
git rebase --continue
git push -u origin main
```

---

## 安全提醒

- `config.json` 含你的 Telegram bot token，**永遠不要**上傳、貼給別人、或提交到 git。
  本專案已用 `.gitignore` 擋住，Render 上用環境變數注入。
- token 若不小心洩漏，立刻到 <https://github.com/settings/tokens> 撤銷並重新產生。
- 本清單本身的 token 欄位是空白示範，不會有任何真實憑證寫進 repo。
