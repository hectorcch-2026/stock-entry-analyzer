# syntax=docker/dockerfile:1
# Railway 會自動偵測此檔案；Render 也支援 Dockerfile 部署。
# 本專案零執行時依賴，因此映像檔極小、啟動極快。

FROM node:20-alpine

WORKDIR /app

# 僅複製描述檔以利用層快取（dependencies 為空，這一步幾乎瞬間完成）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 複製應用程式原始碼
COPY server.js ./
COPY lib ./lib
COPY public ./public

# 注意：刻意不複製 config.json、tests/、node_modules/
# Telegram 憑證請以環境變數注入（TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）

ENV NODE_ENV=production
# Railway / Render 會注入 PORT，server.js 已讀取 process.env.PORT 並綁定 0.0.0.0
# 下方 EXPOSE 只是「本機預設值」的宣告；實際監聽埠以平台注入的 PORT 為準，
# 不會衝突（server.js 第 26 行：const PORT = process.env.PORT || 5177）。
EXPOSE 5177

# 容器健康檢查：讓平台能判斷服務是否真的可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5177)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
