# 執行 `git push -u origin main` 的完整說明

> 環境實測：Git 2.55.0 + **Git Credential Manager 2.9.0**（已安裝）
> 這個組合很重要 —— 它決定了你按下 Enter 之後**會看到什麼**。

---

## 一、先確認你站在正確的位置

`git push` 必須在**有 `.git` 的目錄**裡執行。你的倉庫在：

```
C:\Users\user\WorkBuddy\2026-11-24-15-41-36\stock-entry-analyzer
```

### 方法 A：用 Git Bash（推薦）

從開始選單開啟 **Git Bash**，然後貼上這一行（含引號，因為路徑沒有空格但保險）：

```bash
cd "/c/Users/user/WorkBuddy/2026-11-24-15-41-36/stock-entry-analyzer"
```

> 注意 Git Bash 的路徑寫法：`C:` 要寫成 `/c/`，反斜線 `\` 要改成斜線 `/`。

### 方法 B：用檔案總管

1. 開啟 `C:\Users\user\WorkBuddy\2026-11-24-15-41-36\stock-entry-analyzer` 資料夾
2. 在**位址列**（不是搜尋框）輸入 `cmd` 或 `powershell` 後按 Enter
3. 終端機會直接在該目錄開啟

### 方法 C：用 VS Code

把資料夾拖進 VS Code → 選單 `Terminal → New Terminal`，終端機自動就在該目錄。

### 驗證你在對的位置

執行：

```bash
git status
```

**正確**會顯示：

```
On branch main
nothing to commit, working tree clean
```

**錯誤**會顯示 `fatal: not a git repository` —— 表示你不在該目錄，回到上面重做。

---

## 二、確認遠端已設定

```bash
git remote -v
```

應該看到：

```
origin  https://github.com/hectorcch-2026/stock-entry-analyzer.git (fetch)
origin  https://github.com/hectorcch-2026/stock-entry-analyzer.git (push)
```

沒有的話執行：

```bash
git remote add origin https://github.com/hectorcch-2026/stock-entry-analyzer.git
```

---

## 三、執行推送

```bash
git push -u origin main
```

`-u` 的意思是「把 `origin/main` 設為 `main` 的上游」，設定一次之後，
未來只要打 `git push` 和 `git pull`，不必再寫 `origin main`。

---

## 四、會發生什麼（依你的環境實測）

你的機器裝了 **GCM 2.9.0，且 GitHub 認證方式預設是「瀏覽器 OAuth 優先」**。
所以按下 Enter 後，**不會**出現那種「輸入密碼但螢幕沒反應」的畫面，而是：

### 情況 1：彈出瀏覽器視窗（最可能）

1. 彈出一個瀏覽器分頁，標題類似 **「Sign in to GitHub」**
2. 如果已經登入 GitHub，會直接顯示授權頁 → 按 **Authorize**
3. 回到終端機，會看到推送進度：

```
Enumerating objects: 43, done.
Counting objects: 100% (43/43), done.
Delta compression using up to 8 threads
Compressing objects: 100% (35/35), done.
Writing objects: 100% (43/43), 1.18 MiB | 2.30 MiB/s, done.
Total 43 (delta 8), reused 0 (delta 0)
To https://github.com/hectorcch-2026/stock-entry-analyzer.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
```

`* [new branch] main -> main` 這行就是成功標誌。

### 情況 2：彈出小視窗要你選認證方式

GCM 可能先問你要用哪種方式登入，選 **Browser** 或 **Sign in with your browser** 即可。

### 情況 3：終端機直接要求輸入

如果你之前設定過 `credential.gitHubAuthModes`，可能會看到：

```
Username for 'https://github.com': hectorcch-2026
Password for 'https://hectorcch-2026@github.com':
```

這時 **Password 要貼 Personal Access Token（不是 GitHub 登入密碼）**。
產生方式：<https://github.com/settings/tokens/new> → 勾 `repo` → 產生 → 複製 `ghp_...`
**貼上時螢幕不會顯示任何字元，這是正常的**，直接按 Enter。

> ⚠️ 這一點我上一輪講得太絕對了。真相是：**GCM 裝好且走瀏覽器 OAuth 時，
> 你根本不需要手動生成 token**。只有在 OAuth 失敗或你強制指定 PAT 模式時才需要。

---

## 五、驗證成功

推送完成後執行：

```bash
git status
```

應該顯示：

```
On branch main
Your branch is up to date with 'origin/main'.
nothing to commit, working tree clean
```

`Your branch is up to date with 'origin/main'` 就是成功了。

再去網頁確認：<https://github.com/hectorcch-2026/stock-entry-analyzer>

**必看兩件事**：
- ❌ 不應該看到 `config.json`（含你的 Telegram token）
- ❌ 不應該看到 `node_modules/`（49 MB 依賴）

只要這兩個都沒出現，`.gitignore` 就正確生效了。

---

## 六、如果失敗了

| 訊息 | 原因 | 解法 |
|---|---|---|
| `fatal: not a git repository` | 不在專案目錄 | 重做第一步，用 `git status` 驗證 |
| `remote origin already exists` | 重複加遠端 | 改用 `git remote set-url origin <網址>` |
| `Authentication failed` | OAuth 取消，或 token 無效 | 重跑 `git push`，或重新產生 token |
| `Repository not found` | 網址錯 / 帳號無權限 | 比對 `git remote -v` 的網址 |
| `Updates were rejected` | 遠端不是空的 | 執行 `git pull --rebase origin main` 再 push |
| `Support for password authentication was removed` | 輸入了帳號密碼 | 改用瀏覽器 OAuth 或 PAT |
| 卡住完全沒反應 | 網路 / 代理阻塞 | 檢查是否能開 github.com；必要時關代理 |
| `Permission denied (publickey)` | 誤用了 SSH 網址 | `git remote set-url origin https://...`（改 https） |

### 想清掉已記住的錯誤憑證重來

```bash
# Windows：開啟憑證管理員，刪掉 github.com 那筆
control keymgr.dll
```

或在 Git Bash：

```bash
git credential-manager erase
```

然後重新 `git push`。

---

## 七、之後的日常更新

```bash
git add -A
git commit -m "說明這次改了什麼"
git push
```

因為第三步用了 `-u`，現在只要 `git push` 兩個字。
Render 會偵測到 push 並自動重新部署（`render.yaml` 裡 `autoDeploy: true`）。

---

## 一句話總結

```bash
cd "/c/Users/user/WorkBuddy/2026-11-24-15-41-36/stock-entry-analyzer"
git push -u origin main
```

然後**等瀏覽器彈出、按 Authorize**，就完成了。
