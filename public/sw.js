'use strict';

/**
 * Service Worker — 買入位與技術位分析系統
 *
 * 快取策略（依資源性質區分，這是本檔案最重要的設計）：
 *
 *  1. App Shell（HTML / CSS / JS / 圖示）→ Precache + Stale-While-Revalidate
 *     目的：離線時介面仍可開啟，不至於白畫面。
 *
 *  2. 行情 API（/api/analyze、/api/search…）→ Network-First，絕不主動 Precache
 *     關鍵理由：這是金融資料。把舊價當現價顯示，比「打不開」更危險。
 *     做法：優先走網路；僅在網路失敗時才回退快取，
 *     並在回應加上 X-From-Cache 標頭與 X-Cache-Age 秒數，
 *     讓前端能明確標示「這是 N 分鐘前的資料」。
 *
 *  3. 導覽請求（含 ?symbol= 查詢）→ Network-First，離線回退到快取的 index.html
 */

const VERSION = 'v1.0.0';
const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;

/** 僅在「網路失敗」時才使用的行情快取上限 */
const DATA_TTL_MS = 30 * 60 * 1000; // 超過 30 分鐘的行情快取直接丟棄，不顯示

/** App Shell 預快取清單 */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/icon.svg',
];

/* ==================== 安裝：預快取 App Shell ==================== */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐一加入，個別失敗不影響整體（避免一個圖示 404 就讓 SW 安裝失敗）
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (res.ok) await cache.put(url, res);
          } catch {
            /* 忽略單一資源失敗 */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

/* ==================== 啟用：清除舊版快取 ==================== */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const keep = new Set([SHELL_CACHE, ASSET_CACHE, DATA_CACHE]);
      await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      // 啟用立即接管，避免使用者需重整兩次才拿到新版
      await self.clients.claim();
    })()
  );
});

/* ==================== 訊息：手動控制 ==================== */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CLEAR_DATA_CACHE') {
    event.waitUntil(caches.delete(DATA_CACHE).then(() => {
      if (event.source) event.source.postMessage({ type: 'DATA_CACHE_CLEARED' });
    }));
  }
});

/* ==================== 工具函式 ==================== */

/** 判斷是否為行情 / 資料類 API */
function isDataAPI(url) {
  return url.pathname.startsWith('/api/');
}

/** 判斷是否為導覽請求 */
function isNavigation(req) {
  return req.mode === 'navigate' || (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'));
}

/** 建立「離線且無快取」的標準化錯誤回應 */
function offlineResponse(message) {
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'OFFLINE',
        message: message || '目前處於離線狀態，且沒有可用的快取資料。',
        hint: '請恢復網路連線後重試。介面本身仍可瀏覽，但即時行情需要連線。',
      },
    }),
    { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
}

/**
 * 行情 API：Network-First
 * 網路失敗時才回退快取，並標示資料新鮮度。
 */
async function handleDataRequest(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req);
    // 只快取成功的 GET 回應（POST 如 /api/notify 不快取）
    if (req.method === 'GET' && res.ok) {
      const copy = res.clone();
      const headers = new Headers(copy.headers);
      headers.set('X-Cached-At', String(Date.now()));
      const body = await copy.blob();
      await cache.put(req, new Response(body, { status: copy.status, statusText: copy.statusText, headers }));
    }
    return res;
  } catch (err) {
    // 網路失敗 → 嘗試用快取
    const cached = await cache.match(req);
    if (cached) {
      const cachedAt = Number(cached.headers.get('X-Cached-At') || 0);
      const age = Date.now() - cachedAt;
      // 過期行情直接丟棄，避免顯示嚴重過時的價格
      if (!cachedAt || age > DATA_TTL_MS) {
        await cache.delete(req);
        return offlineResponse('快取的行情資料已過期（超過 30 分鐘），為避免誤判進場時機，已停止顯示。');
      }
      const headers = new Headers(cached.headers);
      headers.set('X-From-Cache', 'true');
      headers.set('X-Cache-Age', String(Math.round(age / 1000)));
      const body = await cached.blob();
      return new Response(body, { status: 200, statusText: 'OK (from cache)', headers });
    }
    return offlineResponse();
  }
}

/**
 * 靜態資源：Stale-While-Revalidate
 * 先回快取（快），同時背景更新（新）。
 */
async function handleAssetRequest(req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);

  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    // 有快取就先回，背景繼續更新
    network.catch(() => {});
    return cached;
  }
  const res = await network;
  if (res) return res;

  // 靜態資源找不到時回退 shell 快取
  const shell = await caches.open(SHELL_CACHE);
  return (await shell.match(req)) || new Response('', { status: 504 });
}

/** 導覽請求：Network-First，離線回退 index.html */
async function handleNavigation(req) {
  try {
    const res = await fetch(req);
    const shell = await caches.open(SHELL_CACHE);
    shell.put('/index.html', res.clone());
    return res;
  } catch {
    const shell = await caches.open(SHELL_CACHE);
    const cached = (await shell.match('/index.html')) || (await shell.match('/'));
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-Offline', 'true');
      const body = await cached.blob();
      return new Response(body, { status: 200, statusText: 'OK (offline shell)', headers });
    }
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>離線</title><body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto"><h1 style="font-size:1.25rem">目前離線</h1><p>無法載入應用程式介面，且裝置上沒有可用的快取。請恢復網路連線後重試。</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* ==================== 請求攔截 ==================== */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 只處理同源請求（行情 API 同源；避免干擾外部資源）
  if (url.origin !== self.location.origin) return;

  // 非 GET：直接走網路（如 POST /api/notify）
  if (req.method !== 'GET') return;

  // 健康檢查與設定：永遠走網路，不快取
  if (url.pathname === '/api/health' || url.pathname === '/api/config') return;

  if (isDataAPI(url)) {
    event.respondWith(handleDataRequest(req));
    return;
  }

  if (isNavigation(req)) {
    event.respondWith(handleNavigation(req));
    return;
  }

  event.respondWith(handleAssetRequest(req));
});

/* ==================== 推播（預留：供未來伺服器端價格異動通知） ==================== */
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = payload.title || '買入位分析 · 價格異動';
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    tag: payload.tag || 'price-alert',
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(target); return c.focus(); }
      }
      return self.clients.openWindow(target);
    })
  );
});
