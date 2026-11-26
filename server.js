'use strict';

/**
 * 股票買入位與技術位分析 — 後端服務
 *
 * 路由：
 *   GET  /api/health                 健康檢查
 *   GET  /api/search?q=              代碼 / 名稱搜尋（自動完成）
 *   GET  /api/analyze?symbol=        完整分析（含買入區間、機率、回測）
 *   GET  /api/kline?symbol=&range=   K 線序列（時間區間切換用）
 *   GET  /api/screen?…               AI 選股：依條件即時篩選
 *   GET  /api/picks[?run=1]          每日候選清單（惰性補跑）
 *   GET  /api/news?symbol=           相關新聞
 *   GET  /api/macro                  宏觀儀表板（全市場）
 *   GET  /api/macro/:symbol          個股財報 + 宏觀背景
 *   GET  /api/data-dict              資料字典（欄位定義／來源／值域／範例值）
 *   GET  /api/interpret              宏觀／財報 AI 解讀（scope=macro|fundamentals）
 *   POST /api/notify                 發送 Telegram 通知
 *   GET  /api/config                 通知設定狀態
 *
 * 零外部依賴，使用 Node 內建 http / fs。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const yahoo = require('./lib/datasource');
const analyzer = require('./lib/analyzer');
const forecast = require('./lib/forecast');
const datasource = require('./lib/datasource');
const telegram = require('./lib/telegram');
const kline = require('./lib/kline');
const screener = require('./lib/screener');
const scheduler = require('./lib/scheduler');
const pool = require('./lib/pool');
const credibility = require('./lib/credibility');
const macro = require('./lib/macro');
const interpret = require('./lib/interpret');
const econSync = require('./lib/econ-sync');
const rrg = require('./lib/rrg');
const rrgService = require('./lib/rrg-service');
const sectorHoldings = require('./lib/sector-holdings');
const treemap = require('./lib/treemap');
const treemapService = require('./lib/treemap-service');

const PORT = process.env.PORT || 5177;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function sendJSON(res, status, data, extraHeaders) {
  const body = JSON.stringify(data);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    // API 一律不快取：由 Service Worker 決定離線回退策略，
    // 避免瀏覽器 HTTP 快取與 SW 快取互相干擾造成資料不一致。
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  }, extraHeaders || {}));
  res.end(body);
}

function sendError(res, status, code, message, hint) {
  sendJSON(res, status, { ok: false, error: { code, message, hint: hint || null } });
}

/**
 * 港股代碼補零：Yahoo 使用 4 位（0005.HK、0700.HK）或 5 位（09988→9988）。
 * 先去除前導零，再依 Yahoo 實際格式補齊：<=4 位補到 4 位，>4 位補到 5 位。
 */
function padHK(digits) {
  const d = String(digits).replace(/^0+/, '') || '0';
  return d.length <= 4 ? d.padStart(4, '0') : d.padStart(5, '0');
}

/**
 * 輸入驗證與正規化
 * 支援：
 *   - 美股：AAPL、BRK.B、MSFT
 *   - 港股：0700.HK、0700、700、00700（1-5 位數字一律視為港股，自動校正補零）
 *   - ETF：SPY、2800.HK
 */
function normalizeSymbol(raw) {
  if (!raw) return { ok: false, code: 'EMPTY', message: '請輸入股票代碼或名稱' };
  let s = String(raw).trim();

  if (s.length > 24) {
    return { ok: false, code: 'TOO_LONG', message: '輸入長度超出限制（最多 24 個字元）' };
  }
  // 中文名稱走搜尋流程，不需正規化為代碼
  if (/[\u4e00-\u9fff]/.test(s)) return { ok: true, value: s, isName: true };

  s = s.toUpperCase().replace(/\s+/g, '');

  // 已是完整港股代碼：去除前導零後補足 4 位（Yahoo 港股格式為 4-5 位）
  if (/^\d{3,5}\.HK$/.test(s)) {
    return { ok: true, value: padHK(s.replace(/\.HK$/, '')) + '.HK', isName: false, market: 'HK' };
  }
  // 純數字：1-5 位一律視為港股（含 00700 這類多補零的寫法）
  if (/^\d{1,5}$/.test(s)) {
    return { ok: true, value: padHK(s) + '.HK', isName: false, market: 'HK' };
  }
  if (/^[A-Z0-9]{1,6}(\.[A-Z]{1,3})?$/.test(s)) {
    return { ok: true, value: s, isName: false, market: 'US' };
  }
  if (/^[A-Z.\-]{1,10}$/.test(s)) return { ok: true, value: s, isName: false, market: 'US' };

  return { ok: false, code: 'INVALID_FORMAT', message: `「${raw}」格式無法辨識`, hint: '美股請輸入如 AAPL，港股請輸入如 0700 或 0700.HK' };
}

/** 解析查詢：若為名稱或模糊輸入，先搜尋再取最相符代碼 */
async function resolveSymbol(input) {
  const norm = normalizeSymbol(input);
  if (!norm.ok) {
    const err = new Error(norm.message);
    err.code = norm.code;
    err.hint = norm.hint;
    err.badInput = true;
    throw err;
  }

  if (!norm.isName) {
    // 數字輸入已明確判定為港股，直接用 .HK 代碼，
    // 不再退回搜尋（上游會把 00700 誤判為台灣股票 00700.TW）
    try {
      await yahoo.quote(norm.value);
      return { symbol: norm.value, assumed: norm.market === 'HK' ? 'HK' : null };
    } catch (e) {
      // 上游限流 / 連線異常時不可謊報「查無此代碼」，否則使用者會誤以為代碼錯誤
      if (e && (e.status === 429 || (e.status >= 500 && e.status < 600))) throw e;
      if (norm.market === 'HK') {
        const err = new Error(`查無港股代碼「${input}」`);
        err.code = 'NOT_FOUND';
        err.hint = '請確認代碼是否正確（港股為 1-5 位數字，如 0700、9988），或改用公司名稱搜尋';
        throw err;
      }
    }
    // 美股：嘗試搜尋校正
    try {
      const list = await yahoo.search(norm.value);
      const exact = list.find((x) => x.symbol.toUpperCase() === norm.value.toUpperCase());
      if (exact) return { symbol: exact.symbol, assumed: null };
      if (list.length) {
        return { symbol: list[0].symbol, assumed: null, fuzzy: true, candidates: list.slice(0, 5) };
      }
    } catch { /* 落至下方統一錯誤 */ }
    const err = new Error(`查無代碼「${input}」對應的股票`);
    err.code = 'NOT_FOUND';
    err.hint = '請確認代碼是否正確，或改用股票名稱搜尋';
    throw err;
  }

  const list = await yahoo.search(norm.value);
  if (!list.length) {
    const err = new Error(`查無「${input}」相關的股票`);
    err.code = 'NOT_FOUND';
    err.hint = '請嘗試其他關鍵字，或直接輸入股票代碼（美股 AAPL、港股 0700）';
    throw err;
  }
  // 名稱完全相符優先
  const exact = list.find((x) => x.name.toLowerCase() === norm.value.toLowerCase() || x.shortName.toLowerCase() === norm.value.toLowerCase());
  return { symbol: (exact || list[0]).symbol, assumed: null, fuzzy: !exact, candidates: list.slice(0, 5) };
}

/** 靜態檔案服務 */
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // 防止路徑穿越
  const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'FORBIDDEN', '拒絕存取');

  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA 回退
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return sendError(res, 404, 'NOT_FOUND', '頁面不存在');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
    }
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };

    // Service Worker 必須「不快取（或極短快取）」，否則更新永遠不會生效。
    // 瀏覽器對 sw.js 預設有 24 小時快取上限，需明確覆寫。
    if (base === 'sw.js') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Service-Worker-Allowed'] = '/';
    } else if (base === 'manifest.webmanifest') {
      headers['Cache-Control'] = 'no-cache';
    } else if (ext === '.html') {
      // HTML 不快取，確保使用者拿到最新的 PWA meta 與資源版本
      headers['Cache-Control'] = 'no-cache';
    } else {
      // 其他靜態資源交由 Service Worker 管理快取，此處給合理長度
      headers['Cache-Control'] = 'public, max-age=3600';
    }

    res.writeHead(200, headers);
    res.end(buf);
  });
}

async function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error('請求內容過大')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const q = parsed.query;

  // CORS（方便 Power BI / 外部呼叫）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (pathname === '/api/health') {
      return sendJSON(res, 200, { ok: true, service: 'stock-entry-analyzer', time: Date.now(), telegram: telegram.isConfigured() });
    }

    if (pathname === '/api/config') {
      return sendJSON(res, 200, { ok: true, telegramConfigured: telegram.isConfigured(), weights: analyzer.WEIGHTS });
    }

    // 資料來源連線診斷：部署環境若封鎖對外網路，可由此確認
    if (pathname === '/api/diag') {
      const targets = [
        ['yahoo', 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d'],
        ['yahoo2', 'https://query2.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d'],
        ['eastmoney', 'https://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f43,f57'],
        ['em-his', 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=105.AAPL&fields1=f1&fields2=f51,f53&klt=101&lmt=2&end=20500101'],
        ['sina', 'https://hq.sinajs.cn/list=gb_aapl'],
        ['tencent', 'https://qt.gtimg.cn/q=usAAPL'],
        ['tc-kline-web', 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=usAAPL.OQ,day,,,5,qfq'],
        ['tc-kline', 'https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=usAAPL.OQ,day,,,5,qfq'],
        ['tc-kline-px', 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=usAAPL.OQ,day,,,5,qfq'],
        ['tc-search', 'https://smartbox.gtimg.cn/s3/?v=2&q=AAPL&t=all'],
        ['stooq', 'https://stooq.com/q/d/l/?s=aapl.us&i=d'],
        ['telegram', 'https://api.telegram.org/'],
        ['cloudflare', 'https://1.1.1.1/cdn-cgi/trace'],
        ['example', 'https://example.com/'],
      ];
      const out = {};
      await Promise.all(targets.map(async ([name, url]) => {
        const t0 = Date.now();
        try {
          const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.yahoo.com/' },
            signal: AbortSignal.timeout(8000),
          });
          const body = await r.text().catch(() => '');
          out[name] = { ok: r.ok, status: r.status, ms: Date.now() - t0, len: body.length, head: body.slice(0, 60).replace(/\s+/g, ' ') };
        } catch (e) {
          out[name] = { ok: false, error: (e.cause?.code || e.name || e.message || '').toString().slice(0, 60), ms: Date.now() - t0 };
        }
      }));
      return sendJSON(res, 200, { ok: true, env: { node: process.version, dataSource: process.env.DATA_SOURCE || 'auto' }, targets: out });
    }

    // 來源內部路徑診斷：針對指定代碼追蹤各來源的解析與取資料過程
    if (pathname === '/api/diag/source') {
      const sym = (q.symbol || 'AAPL').trim();
      const trace = {};
      try {
        const tc = require('./lib/tencent');
        const t0 = Date.now();
        const resolved = await tc.resolveCode(sym);
        trace.tencentResolve = {
          ms: Date.now() - t0,
          qq: resolved.qq,
          suffix: resolved.suffix,
          price: resolved.quote?.price ?? null,
          fullCode: resolved.quote?.fullCode ?? null,
          name: resolved.quote?.name ?? null,
        };
      } catch (e) { trace.tencentResolve = { error: (e.message || String(e)).slice(0, 120) }; }
      try {
        const tc = require('./lib/tencent');
        const t0 = Date.now();
        const ch = await tc.chart(sym, '2y', '1d');
        trace.tencentChart = { ms: Date.now() - t0, candles: ch.candles.length, last: ch.candles.slice(-1)[0]?.c ?? null, symbol: ch.meta.symbol };
      } catch (e) { trace.tencentChart = { error: (e.message || String(e)).slice(0, 120), code: e.code }; }
      try {
        const tc = require('./lib/tencent');
        const t0 = Date.now();
        const qt = await tc.quote(sym);
        trace.tencentQuote = { ms: Date.now() - t0, symbol: qt.symbol, price: qt.price, currency: qt.currency };
      } catch (e) { trace.tencentQuote = { error: (e.message || String(e)).slice(0, 120), code: e.code }; }
      try {
        const em = require('./lib/eastmoney');
        const t0 = Date.now();
        const ch = await em.chart(sym, '2y', '1d');
        trace.eastmoneyChart = { ms: Date.now() - t0, candles: ch.candles.length };
      } catch (e) { trace.eastmoneyChart = { error: (e.message || String(e)).slice(0, 120), code: e.code }; }
      try {
        const yh = require('./lib/yahoo');
        const t0 = Date.now();
        const ch = await yh.chart(sym, '2y', '1d');
        trace.yahooChart = { ms: Date.now() - t0, candles: ch.candles.length };
      } catch (e) { trace.yahooChart = { error: (e.message || String(e)).slice(0, 120), code: e.code, status: e.status }; }
      return sendJSON(res, 200, { ok: true, symbol: sym, trace });
    }

    // K 線主機 / 標頭矩陣診斷：釐清部署環境對 K 線子網域的放行條件
    if (pathname === '/api/diag/kline') {
      const code = (q.code || 'usAAPL.OQ').trim();
      const hosts = [
        'https://web.ifzq.gtimg.cn',
        'https://ifzq.gtimg.cn',
        'https://proxy.finance.qq.com/ifzqgtimg',
      ];
      const referers = [
        ['gu', 'https://gu.qq.com/'],
        ['yahoo', 'https://finance.yahoo.com/'],
        ['none', null],
      ];
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const out = {};
      await Promise.all(hosts.flatMap((h) => referers.map(async ([rname, ref]) => {
        const label = h.replace('https://', '') + '|' + rname;
        const t0 = Date.now();
        const headers = { 'User-Agent': ua };
        if (ref) headers.Referer = ref;
        const url = `${h}/appstock/app/fqkline/get?param=${encodeURIComponent(`${code},day,,,5,qfq`)}`;
        try {
          const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
          const buf = Buffer.from(await r.arrayBuffer());
          const txt = new TextDecoder('gbk').decode(buf);
          let rows = null, keys = null, parseErr = null;
          try {
            const j = JSON.parse(txt);
            keys = Object.keys(j?.data || {});
            const d = j?.data?.[code];
            rows = (d?.day || d?.qfqday || []).length;
          } catch (e) { parseErr = e.message.slice(0, 60); }
          out[label] = { ok: r.ok, status: r.status, ms: Date.now() - t0, len: buf.length, keys, rows, parseErr, head: txt.slice(0, 90).replace(/\s+/g, ' ') };
        } catch (e) {
          out[label] = { ok: false, error: (e.cause?.code || e.name || e.message || '').toString().slice(0, 60), ms: Date.now() - t0 };
        }
      })));
      return sendJSON(res, 200, { ok: true, code, results: out });
    }

    // URL 編碼變體診斷：釐清出口代理是否對 %2C（逗號）等編碼敏感
    if (pathname === '/api/diag/url') {
      const host = (q.host || 'https://ifzq.gtimg.cn').trim();
      const codes = (q.codes || 'usAAPL.OQ,hk00700,usAAPL').split(',').map((s) => s.trim()).filter(Boolean);
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const out = [];
      for (const code of codes) {
        const raw = `${code},day,,,5,qfq`;
        const variants = [
          ['raw', raw],
          ['enc', encodeURIComponent(raw)],
          ['encCodeOnly', encodeURIComponent(code) + ',day,,,5,qfq'],
        ];
        for (const [label, param] of variants) {
          const url = `${host}/appstock/app/fqkline/get?param=${param}`;
          const t0 = Date.now();
          try {
            const r = await fetch(url, { headers: { 'User-Agent': ua, Referer: 'https://gu.qq.com/' }, signal: AbortSignal.timeout(8000) });
            const buf = Buffer.from(await r.arrayBuffer());
            const txt = new TextDecoder('gbk').decode(buf);
            let rows = null;
            try { const j = JSON.parse(txt); const d = j?.data?.[code]; rows = (d?.day || d?.qfqday || []).length; } catch { /* 非 JSON */ }
            out.push({ code, label, status: r.status, ms: Date.now() - t0, len: buf.length, rows, head: txt.slice(0, 55).replace(/\s+/g, ' ') });
          } catch (e) {
            out.push({ code, label, error: (e.cause?.code || e.name || e.message || '').toString().slice(0, 50), ms: Date.now() - t0 });
          }
        }
      }
      return sendJSON(res, 200, { ok: true, host, results: out });
    }

    // 標頭矩陣診斷：比對 UA / Referer 對出口代理放行的影響
    if (pathname === '/api/diag/hdr') {
      const code = (q.code || 'usAAPL.OQ').trim();
      const host = (q.host || 'https://ifzq.gtimg.cn').trim();
      const url = `${host}/appstock/app/fqkline/get?param=${code},day,,,5,qfq`;
      const variants = [
        ['ua-short-yahoo', { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.yahoo.com/' }],
        ['ua-short-gu', { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' }],
        ['ua-short-none', { 'User-Agent': 'Mozilla/5.0' }],
        ['ua-chrome-yahoo', { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', Referer: 'https://finance.yahoo.com/' }],
        ['ua-chrome-gu', { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', Referer: 'https://gu.qq.com/' }],
        ['ua-curltc', { 'User-Agent': 'curl/8.0' }],
        ['no-headers', {}],
      ];
      const out = {};
      for (const [label, headers] of variants) {
        const t0 = Date.now();
        try {
          const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
          const buf = Buffer.from(await r.arrayBuffer());
          const txt = new TextDecoder('gbk').decode(buf);
          let rows = null;
          try { const j = JSON.parse(txt); const d = j?.data?.[code]; rows = (d?.day || d?.qfqday || []).length; } catch { /* 非 JSON */ }
          out[label] = { status: r.status, ms: Date.now() - t0, len: buf.length, rows, head: txt.slice(0, 50).replace(/\s+/g, ' ') };
        } catch (e) {
          out[label] = { error: (e.cause?.code || e.name || e.message || '').toString().slice(0, 50), ms: Date.now() - t0 };
        }
      }
      return sendJSON(res, 200, { ok: true, code, host, results: out });
    }

    // 端點形狀探測：在多個候選 URL 中找出部署環境可用的 K 線端點
    if (pathname === '/api/diag/probe') {
      const code = (q.code || 'usAAPL.OQ').trim();
      const cands = [
        ['qt-kline', `https://qt.gtimg.cn/q=${code}`],
        ['ifzq-fqkline', `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,20,qfq`],
        ['ifzq-kline', `https://ifzq.gtimg.cn/appstock/app/kline/kline?param=${code},day,,,20`],
        ['ifzq-newfq', `https://ifzq.gtimg.cn/appstock/app/newfqkline/get?param=${code},day,,,20,qfq`],
        ['web-fqkline', `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,20,qfq`],
        ['web-kline', `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${code},day,,,20`],
        ['web-newfq', `https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get?param=${code},day,,,20,qfq`],
        ['px-fqkline', `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=${code},day,,,20,qfq`],
        ['px-newfq', `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${code},day,,,20,qfq`],
        ['px-min', `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query?code=${code}`],
        ['ifzq-min', `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`],
        ['qt-kline2', `https://qt.gtimg.cn/q=${code},day`],
        ['sinajs', `https://hq.sinajs.cn/list=gb_aapl`],
        ['em-push2', `https://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f43,f57`],
      ];
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const out = {};
      await Promise.all(cands.map(async ([label, url]) => {
        const t0 = Date.now();
        try {
          const r = await fetch(url, { headers: { 'User-Agent': ua, Referer: 'https://gu.qq.com/' }, signal: AbortSignal.timeout(8000) });
          const buf = Buffer.from(await r.arrayBuffer());
          // 嘗試以 UTF-8 與 GBK 解碼，看哪個能得到 JSON
          const utf8 = buf.toString('utf8');
          let gbk = ''; try { gbk = new TextDecoder('gbk').decode(buf); } catch { /* 忽略 */ }
          const pick = utf8.trim().startsWith('{') ? utf8 : gbk;
          let rows = null;
          try { const j = JSON.parse(pick); const d = j?.data?.[code]; const k = d ? (d.day || d.qfqday || d.data) : null; rows = Array.isArray(k) ? k.length : null; } catch { /* 非 JSON */ }
          out[label] = { status: r.status, ms: Date.now() - t0, len: buf.length, rows, head: pick.slice(0, 60).replace(/\s+/g, ' ') };
        } catch (e) {
          out[label] = { error: (e.cause?.code || e.name || e.message || '').toString().slice(0, 46), ms: Date.now() - t0 };
        }
      }));
      return sendJSON(res, 200, { ok: true, code, results: out });
    }

    if (pathname === '/api/search') {
      const query = (q.q || '').trim();
      if (!query) return sendError(res, 400, 'EMPTY', '請輸入搜尋關鍵字', '可輸入代碼（AAPL / 0700）或名稱（騰訊 / Apple）');
      if (query.length > 40) return sendError(res, 400, 'TOO_LONG', '搜尋關鍵字過長');
      const results = await yahoo.search(query);
      if (!results.length) {
        return sendJSON(res, 200, { ok: true, count: 0, results: [], message: `查無「${query}」相關結果，請嘗試其他關鍵字` });
      }
      return sendJSON(res, 200, { ok: true, count: results.length, results });
    }

    if (pathname === '/api/analyze') {
      const raw = (q.symbol || q.s || '').trim();
      if (!raw) return sendError(res, 400, 'EMPTY', '請輸入股票代碼或名稱', '例如 AAPL、0700.HK、騰訊');
      const resolved = await resolveSymbol(raw);
      const data = await analyzer.analyze(resolved.symbol);

      /*
       * FP（K 線區間預測）與既有分析並行取數，但**不共用序列**：
       * FP 需要 10y 已復權序列，既有分析用 2y 未復權序列。
       * 兩者互不干擾，AC-01 要求的 probabilities / backtest 逐位元相同
       * 才得以成立（見 docs/K線預測與AI選股規格書_v1.1.md §2.4）。
       *
       * 以附帶方式（不是必要欄位）加入：FP 失敗時僅少一個卡片，
       * 不影響既有分析結果的可用性。
       */
      try {
        // analyzer 提供 snapshot.atrPct（ATR 佔現價百分比），作為
        // judge() 在回測未回傳 meanSigma 時的備援基準
        const atrPct = data?.snapshot?.atrPct;
        data.pred = await forecast.buildPrediction(datasource, resolved.symbol, {
          atrPct: typeof atrPct === 'number' ? atrPct : null,
        });
      } catch (e) {
        // 保底：即使建構過程意外擲出，也回傳結構完整的 pred
        data.pred = {
          symbol: resolved.symbol,
          status: 'error',
          reason: `預測模組異常：${e.message}`,
          horizons: {},
          note: '此為歷史分位數推估的價格區間，非價格預測，不構成投資建議',
        };
      }

      if (resolved.assumed) data.assumedMarket = resolved.assumed;
      if (resolved.fuzzy) data.fuzzyMatchNote = '未找到完全相符的標的，已顯示最相近的結果，請確認是否正確。';
      if (resolved.candidates) data.candidates = resolved.candidates;

      /*
       * 統計可信度（取代方向機率，見 lib/credibility.js 的說明）。
       *
       * 這裡只用**已經算好的** pred 做加權評估，不重新取數、不重跑回測，
       * 因此對 /api/analyze 的耗時影響可忽略（純計算，< 1ms）。
       * 失敗時回傳 available:false，不影響主分析。
       */
      try {
        data.predCredibility = credibility.assess(data.pred, data.meta?.price);
      } catch (e) {
        data.predCredibility = { available: false, reason: `可信度評估失敗：${e.message}` };
      }

      data.ok = true;
      return sendJSON(res, 200, data);
    }

    /*
     * K 線序列 — 時間區間切換
     *
     * 為什麼獨立於 /api/analyze：
     *   analyze 只回 250 根（控制回應大小），但切換到 2y/5y 需要更長歷史。
     *   若把 analyze 的切片放大，既有前端與 15 項 AC-01 斷言會全部受影響。
     */
    if (pathname === '/api/kline') {
      const raw = (q.symbol || '').trim();
      if (!raw) return sendError(res, 400, 'EMPTY', '請提供股票代碼', '例如 AAPL、0700.HK');

      // range 先驗證，避免為了「非法區間」白跑一次上游取數
      const norm = kline.normalizeRange(q.range);
      if (!norm.ok) return sendError(res, 400, norm.code, norm.message, norm.hint);

      const resolved = await resolveSymbol(raw);
      const res1 = await kline.getSeries(datasource, resolved.symbol, q.range || null, null);
      if (!res1.ok) return sendError(res, 404, res1.code, res1.message, res1.hint);

      return sendJSON(res, 200, { ok: true, ...res1, requestedSymbol: raw });
    }

    /*
     * AI 選股 — 即時篩選
     *
     * 全部條件走 URL query，由 screener.normalizeOptions 統一驗證。
     * 參數錯誤一律 400 BAD_PARAMS，並把「哪一個欄位錯、錯在哪」寫在人話裡，
     * 讓前端能直接顯示，而不是丟一句「請求失敗」。
     */
    if (pathname === '/api/screen') {
      const norm = screener.normalizeOptions(q);
      if (!norm.ok) {
        return sendError(res, 400, norm.code, norm.message,
          `可用參數：market（all/us/hk）、minScore、maxDistAtr、minPrice、minAvgVol、maxAtrPct、`
          + `requirePred、limit（1-200）、sortBy（${[...screener.SORTABLE].join('/')}）、sortDir（asc/desc）`);
      }

      // 母體可限縮到單一市場，減少不必要的上游請求
      const symbols = pool.byMarket(norm.opts.market);
      const p = pool.summary();
      if (!symbols.length) {
        return sendJSON(res, 200, {
          ok: true, opts: norm.opts, rows: [],
          stats: { pool: 0, checked: 0, passed: 0, returned: 0, excluded: 0, failed: 0, excludeReasons: [], notes: ['此市場在標的池中沒有成員'] },
          poolSummary: p,
        });
      }

      const out = await screener.screen(
        { analyzer, forecast, datasource, symbols },
        q,
        { concurrency: Number(process.env.SCREEN_CONCURRENCY) || screener.DEFAULT_CONCURRENCY }
      );
      if (!out.ok) {
        return sendError(res, 400, out.error.code, out.error.message);
      }
      return sendJSON(res, 200, { ...out, poolSummary: p });
    }

    /*
     * 每日候選清單 — 惰性補跑（lazy catch-up）
     *
     * 這個端點同時扮演三個角色（見 lib/scheduler.js）：
     *   1. 一般訪問（預設）：今日已有資料就毫秒級回傳；今日尚無資料則
     *      當場補跑一次（約 8–40 秒）。這正是「休眠再久，第一個訪問者
     *      也會補上當日清單」的實作方式。
     *   2. ?preview=1：只讀不跑。前端要「先問有沒有、再決定要不要等」時使用。
     *   3. ?run=1：強制重跑（外部 cron 用）。若設定了 PICKS_TOKEN 則需帶 token。
     */
    if (pathname === '/api/picks') {
      const force = q.run === '1' || q.force === '1';
      const previewOnly = q.preview === '1';
      const token = process.env.PICKS_TOKEN || '';
      if (force && token && String(q.token || '') !== token) {
        return sendError(res, 403, 'FORBIDDEN', '強制重跑需要有效的 token', '請在 query 帶上 token=…（伺服器端設定 PICKS_TOKEN）');
      }

      let out;
      if (previewOnly && !force) {
        // 純讀取：不觸發計算，只回報「今日有沒有、最近幾天有」
        const cutoff = scheduler.lastSettledCutoff();
        const key = scheduler.dateKey(cutoff);
        const existing = scheduler.readDaily(key);
        out = {
          ran: false,
          key,
          reason: existing ? '今日已有資料' : '今日尚無資料（一般訪問會自動補跑）',
          payload: existing,
        };
      } else {
        out = await scheduler.maybeRun(
          { analyzer, forecast, datasource, symbols: pool.byMarket('all') },
          screener,
          { force }
        );
      }

      const payload = out.payload || null;
      return sendJSON(res, 200, {
        ok: true,
        key: out.key,
        ran: out.ran,
        reason: out.reason,
        generatedAt: payload ? payload.generatedAt : null,
        cutoffUtc: payload ? payload.cutoffUtc : null,
        durationMs: payload ? payload.durationMs : null,
        opts: payload ? payload.opts : null,
        rows: payload ? payload.rows : [],
        stats: payload ? payload.stats : null,
        history: scheduler.listRecent(10),
        poolSummary: pool.summary(),
        schedule: {
          settleMinutes: scheduler.SETTLE_MINUTES,
          inProcessCron: String(process.env.ENABLE_INPROCESS_CRON || '') === '1',
          note: '本服務採「訪問觸發 + 當日鎖」補跑：休眠再久，第一個訪問者也會補上當日清單。',
        },
      });
    }

    /* 篩選條件中繼資料：讓前端不必硬編碼預設值 */
    if (pathname === '/api/screen/meta') {
      return sendJSON(res, 200, {
        ok: true,
        defaults: screener.DEFAULTS,
        sortable: [...screener.SORTABLE].map((k) => ({ key: k, label: screener.SORTABLE_LABEL[k] || k })),
        pool: pool.summary(),
      });
    }

    if (pathname === '/api/news') {
      const raw = (q.symbol || '').trim();
      if (!raw) return sendError(res, 400, 'EMPTY', '請提供股票代碼');
      const items = await yahoo.news(raw, 8, (q.name || '').trim() || null);
      return sendJSON(res, 200, { ok: true, count: items.length, news: items });
    }

    /* ==========================================================
       宏觀經濟與基本面
       ----------------------------------------------------------
       四個端點，職責各自獨立：

         GET /api/macro              宏觀儀表板（全市場，不帶代碼）
         GET /api/macro/:symbol      個股財報 + 宏觀背景
         GET /api/data-dict          資料字典（欄位定義／來源／值域／範例）
         GET /api/interpret          解讀（可指定 scope 與 symbol）

       全部回傳統一信封 {ok, ...}，失敗時 {ok:false, error:{code,message,hint}}，
       與本專案既有端點一致，前端可用同一套 SA.api() 處理。
       ========================================================== */

    if (pathname === '/api/macro' && req.method === 'GET') {
      if (q.preview === '1') {
        // 只回報快取狀態，不觸發上游抓取（前端用來決定要不要求 Loading）
        const hit = macro.cache.get('macro:series');
        return sendJSON(res, 200, {
          ok: true, preview: true, cached: !!hit,
          note: hit ? '已有快取，載入會很快' : '無快取，首次載入需抓取 18 個序列（約 5–15 秒）',
        });
      }
      const out = await macro.getMacroOverview({ force: q.refresh === '1' });
      return sendJSON(res, 200, out);
    }

    // /api/macro/AAPL
    if (pathname.startsWith('/api/macro/') && req.method === 'GET') {
      const raw = decodeURIComponent(pathname.slice('/api/macro/'.length)).trim();
      if (!raw) return sendError(res, 400, 'EMPTY', '請在路徑提供股票代碼，例如 /api/macro/AAPL');

      const norm = normalizeSymbol(raw);
      if (!norm.ok) return sendError(res, 400, norm.code, norm.message, norm.hint);

      // 市值／股價由既有 analyze 提供，供本益比計算；失敗不影響財報本身
      let ctx = null;
      try {
        const d = await analyzer.analyze(norm.value);
        ctx = {
          price: d.meta.price, currency: d.meta.currency,
          // meta 沒有 asOf 欄位（曾誤寫成 d.meta.asOf，導致 priceAsOf 恆為 null）。
          // 報價時點應取 marketTime：三個資料源（yahoo/eastmoney/tencent）都統一為毫秒時間戳。
          // 轉成 YYYY-MM-DD，與其他 evidence 的 asOf 格式一致（如 CPI 的 2026-10-01）。
          priceAsOf: d.meta.marketTime ? new Date(d.meta.marketTime).toISOString().slice(0, 10) : null,
          name: d.meta.name,
        };
      } catch (e) {
        ctx = { price: null, note: `無法取得股價（${e.message}），本益比將不計算` };
      }

      const out = await macro.getSymbolOverview(norm.value, {
        force: q.refresh === '1', ctx,
      });
      if (!out.ok) return sendError(res, 400, out.code, out.message, out.hint);
      return sendJSON(res, 200, { ...out, requestedSymbol: raw });
    }

    if (pathname === '/api/data-dict' && req.method === 'GET') {
      const out = await macro.getDataDictionary();
      return sendJSON(res, 200, out);
    }

    /*
     * 經濟資料庫（econ-store）端點
     * ==============================
     *
     * GET  /api/econ/status            資料庫概況（各表筆數、檔案大小）
     * GET  /api/econ/series            指標主檔清單
     * GET  /api/econ/query             查觀測值
     *        ?series=cpiYoy&from=2026-01&to=2026-10&order=desc&limit=12
     * POST /api/econ/sync              從上游同步（預設只補過期的）
     *        body: { keys?: string[], force?: boolean }
     * POST /api/econ/observations      寫入觀測值（upsert）
     *        body: { rows: [{ seriesKey, period, value, ... }] }
     * PATCH /api/econ/observations     更新既有紀錄（找不到回 404，不新增）
     *        body: { seriesKey, period, value }
     *
     * 為什麼查詢走 GET、寫入走 POST/PATCH：
     *   語義要跟 HTTP 方法一致，否則快取與重試語義會錯亂
     *   （重試一個 GET 永遠安全，重試一個 POST 可能重複寫入——
     *    這也是 upsert 必須冪等的原因）。
     */
    if (pathname === '/api/econ/status' && req.method === 'GET') {
      const store = econSync.getStore();
      return sendJSON(res, 200, {
        ok: true,
        storage: store.memoryOnly ? 'memory' : 'file',
        file: store.filePath,
        schemaVersion: require('./lib/econ-store').SCHEMA_VERSION,
        ...store.stats(),
      });
    }

    if (pathname === '/api/econ/series' && req.method === 'GET') {
      const store = econSync.getStore();
      return sendJSON(res, 200, { ok: true, series: store.listSeries() });
    }

    if (pathname === '/api/econ/query' && req.method === 'GET') {
      const store = econSync.getStore();
      const seriesKey = q.series || q.seriesKey || null;
      if (seriesKey && !store.getSeries(seriesKey)) {
        // 明確區分「沒這個指標」與「有指標但沒資料」，否則使用者無從判斷
        return sendError(res, 404, 'UNKNOWN_SERIES', `資料庫沒有指標 ${seriesKey}`,
          '先呼叫 POST /api/econ/sync 建立指標主檔');
      }
      const limit = q.limit != null ? Number(q.limit) : undefined;
      if (q.limit != null && (!Number.isFinite(limit) || limit <= 0)) {
        return sendError(res, 400, 'BAD_LIMIT', 'limit 必須是正整數');
      }
      const rows = store.query({
        seriesKey,
        from: q.from,
        to: q.to,
        order: q.order === 'desc' ? 'desc' : 'asc',
        limit,
      });
      return sendJSON(res, 200, {
        ok: true,
        series: seriesKey,
        count: rows.length,
        rows,
      });
    }

    if (pathname === '/api/econ/sync' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const keys = Array.isArray(body.keys) ? body.keys : null;
      const store = econSync.getStore();

      // 先無條件補主檔（純本地操作，不打上游）。
      // 實測踩過：手動 POST 進來的序列會被自動補成 { label: 'cpiYoy' }，
      // 若只在需要重抓時才寫主檔，這些序列永遠停在「label 等於 key」的狀態。
      // 補主檔很便宜（一個 Map 賦值），每次 sync 都做，讓它自我修復。
      const allKeys = keys || require('./lib/fred').SERIES.map((s) => s.key);
      let metaFilled = 0;
      for (const k of allKeys) {
        const def = require('./lib/fred').BY_KEY.get(k);
        if (def) {
          const r = store.writeSeries(econSync.seriesMetaFromFred(def));
          if (r.action !== 'unchanged') metaFilled += 1;
        }
      }

      // 未指定 force 時，先篩掉還新鮮的序列，避免無謂打上游
      let targets = keys;
      let skippedFresh = [];
      if (!body.force) {
        targets = [];
        for (const k of allKeys) {
          const need = econSync.needsRefresh(k, { store });
          if (need.needed) targets.push(k); else skippedFresh.push({ key: k, reason: need.reason });
        }
        if (!targets.length) {
          return sendJSON(res, 200, {
            ok: true,
            synced: false,
            message: '所有序列的本地資料都還新鮮，未向上游發出任何請求',
            metaFilled,
            skippedFresh,
            stats: store.stats(),
          });
        }
      }

      const out = await econSync.syncAll(targets, { force: !!body.force });
      return sendJSON(res, 200, { ...out, metaFilled, skippedFresh });
    }

    if (pathname === '/api/econ/observations' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const rows = Array.isArray(body.rows) ? body.rows : (body.seriesKey ? [body] : null);
      if (!rows || !rows.length) {
        return sendError(res, 400, 'EMPTY', '請提供 rows 陣列，或單筆 { seriesKey, period, value }');
      }
      const store = econSync.getStore();
      const report = store.writeMany(rows);
      // 全部被拒才算失敗；部分成功仍回 200 並在 errors 說明
      const status = report.inserted + report.updated + report.unchanged > 0 ? 200 : 422;
      return sendJSON(res, status, { ok: status === 200, ...report });
    }

    if (pathname === '/api/econ/observations' && req.method === 'PATCH') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.seriesKey || body.period == null) {
        return sendError(res, 400, 'EMPTY', '請提供 seriesKey 與 period 以定位既有紀錄');
      }
      const store = econSync.getStore();
      const out = store.update(body.seriesKey, body.period, body);
      if (!out.ok) {
        const status = out.code === 'NOT_FOUND' ? 404 : 400;
        return sendError(res, status, out.code, out.message,
          out.code === 'NOT_FOUND' ? '更新不會自動新增；若這是新資料請用 POST' : null);
      }
      return sendJSON(res, 200, { ok: true, ...out });
    }

    /*
     * 解讀端點。
     *
     * scope=macro        宏觀解讀（含 LLM 潤飾，若已設定 Key）
     * scope=fundamentals 財報解讀（需 symbol）
     *
     * mode 參數：
     *   mode=rule（預設）  只回規則層結果
     *   mode=llm          額外嘗試 LLM 潤飾，失敗自動退回 rule 並在 note 說明
     */
    if (pathname === '/api/interpret' && req.method === 'GET') {
      const scope = (q.scope || 'macro').toLowerCase();
      const wantLlm = String(q.mode || 'rule').toLowerCase() === 'llm';

      if (scope === 'macro') {
        const ov = await macro.getMacroOverview({ force: q.refresh === '1' });
        let llm = null;
        if (wantLlm) llm = await interpret.polishWithLlm(ov.interpretation);
        return sendJSON(res, 200, {
          ok: true,
          scope: 'macro',
          interpretation: ov.interpretation,
          llm: llm ? { text: llm.text, mode: llm.mode, note: llm.note } : null,
          generatedAt: ov.generatedAt,
        });
      }

      if (scope === 'fundamentals') {
        const raw = (q.symbol || '').trim();
        if (!raw) return sendError(res, 400, 'EMPTY', 'scope=fundamentals 需提供 symbol 參數');
        const norm = normalizeSymbol(raw);
        if (!norm.ok) return sendError(res, 400, norm.code, norm.message, norm.hint);

        const out = await macro.getSymbolOverview(norm.value, {});
        let llm = null;
        if (wantLlm && out.interpretation && out.interpretation.available !== false) {
          llm = await interpret.polishWithLlm(out.interpretation);
        }
        return sendJSON(res, 200, {
          ok: true,
          scope: 'fundamentals',
          symbol: out.symbol,
          interpretation: out.interpretation,
          llm: llm ? { text: llm.text, mode: llm.mode, note: llm.note } : null,
          generatedAt: out.generatedAt,
        });
      }

      return sendError(res, 400, 'BAD_SCOPE', `不支援的 scope：${scope}`, '可用：macro、fundamentals');
    }

    /**
     * RRG 版塊輪動地圖
     * ────────────────────────────────────────────────────────
     * GET /api/rrg?timeframe=weekly&window=1y&trail=5&period=14
     *             &benchmark=SPY&sectors=XLK,XLF&refresh=1
     *
     * 參數全部可省略，一律走 lib/rrg.js 的預設值。
     * 非法值不靜默忽略 —— 回 400 並在 hint 列出合法選項，
     * 因為「打了錯字卻得到一張看起來正常的圖」比報錯更危險。
     */
    if (pathname === '/api/rrg' && req.method === 'GET') {
      const tf = rrg.normTimeframe(q.timeframe);
      if (!tf.ok) return sendError(res, 400, tf.code, tf.message, tf.hint);

      const win = rrg.normWindow(q.window, tf.key);
      if (!win.ok) return sendError(res, 400, win.code, win.message, win.hint);

      const trail = rrg.normTrail(q.trail);
      if (!trail.ok) return sendError(res, 400, trail.code, trail.message, trail.hint);

      const period = rrg.normPeriod(q.period, tf.key);
      if (!period.ok) return sendError(res, 400, period.code, period.message, period.hint);

      const bench = rrg.normBenchmark(q.benchmark);
      if (!bench.ok) return sendError(res, 400, bench.code, bench.message, bench.hint);

      const sec = rrg.normSectors(q.sectors);
      if (!sec.ok) return sendError(res, 400, sec.code, sec.message, sec.hint);
      if (!sec.keys.length) {
        return sendError(res, 400, 'NO_SECTORS', '版塊清單為空，無法繪圖',
          `可用版塊：${rrg.SECTORS.map((s) => s.key).join(', ')}`);
      }

      if (q.refresh === '1') rrgService.resetCache();

      const m = await rrgService.getMatrix(datasource, {
        timeframe: tf.key, benchmarkKey: bench.key,
      });
      if (!m.ok) return sendError(res, 503, m.code, m.message, m.hint);

      const out = rrg.buildRRG({
        dates: m.dates,
        t: m.t,
        rows: m.rows,
        benchmarkKey: bench.key,
        sectorKeys: sec.keys,
        period: period.value,
        windowBars: win.bars,
        trail: trail.value,
        meta: { sectors: rrg.SECTORS },
      });

      if (!out.ok) {
        // INSUFFICIENT_DATA 屬「資料真的不夠」，用 422 與其他模組一致
        const status = out.code === 'INSUFFICIENT_DATA' ? 422 : 503;
        return sendJSON(res, status, {
          ok: false,
          error: { code: out.code, message: out.message, hint: out.hint },
          coverage: out.coverage || [],
          diagnostics: out.diagnostics || null,
        });
      }

      return sendJSON(res, 200, {
        ok: true,
        timeframe: tf.key,
        timeframeLabel: rrg.TIMEFRAMES[tf.key].label,
        window: win.key,
        windowLabel: rrg.WINDOWS[win.key].label,
        windowNote: win.note || null,
        trail: trail.value,
        period: period.value,
        periodIsDefault: !!period.isDefault,
        benchmark: bench.key,
        benchmarkLabel: bench.def.label,
        benchmarkNote: bench.def.note,
        asOf: out.points[0] ? out.points[0].asOf : null,
        points: out.points,
        coverage: out.coverage,
        diagnostics: out.diagnostics,
        // 資料健全度：前端需要主動提示，不能假裝沒這回事
        unknownSectors: sec.unknown,
        failures: m.failures,
        adjFallback: m.adjFallback,
        source: m.source,
        cached: !!m.cached,
        fetchedAt: m.fetchedAt,
        meta: {
          sectors: rrg.SECTORS,
          benchmarks: rrg.BENCHMARKS,
          timeframes: Object.entries(rrg.TIMEFRAMES).map(([k, v]) => ({ key: k, label: v.label })),
          windows: Object.entries(rrg.WINDOWS).map(([k, v]) => ({ key: k, label: v.label })),
          trailMin: rrg.TRAIL_MIN,
          trailMax: rrg.TRAIL_MAX,
        },
      });
    }

    /**
     * 版塊權重股 + 四區間報酬
     * ────────────────────────────────────────────────────────
     * GET /api/rrg/holdings?sector=XLK&limit=10
     *
     * 為什麼放在 /api/rrg 之下：
     *   它服務的是同一個檢視（版塊輪動），使用者心智上是「點開 XLK 看裡面有誰」。
     *   獨立成 /api/holdings 會讓兩個端點的版塊代碼驗證各自為政，
     *   日後新增版塊容易只改一邊。
     *
     * 為什麼持股與報酬合成一支端點：
     *   前端若分兩次請求，會出現「表格已長出 10 列但數字全是空白」的中間狀態，
     *   使用者會誤以為資料壞了。合成一支讓「有列就有數」成為不變式。
     */
    if (pathname === '/api/rrg/holdings' && req.method === 'GET') {
      const sectorKey = String(q.sector || '').toUpperCase().trim();
      if (!sectorKey) {
        return sendError(res, 400, 'MISSING_SECTOR', '缺少 sector 參數',
          `可用版塊：${sectorHoldings.SECTOR_KEYS.join('、')}`);
      }

      const limitRaw = q.limit;
      let limit = 10;
      if (limitRaw != null && limitRaw !== '') {
        const n = Number(limitRaw);
        if (!Number.isFinite(n) || n < 1 || n > 50) {
          return sendError(res, 400, 'BAD_LIMIT', `limit 必須是 1–50 的整數（收到「${limitRaw}」）`,
            '不帶此參數時預設列出前 10 大權重股');
        }
        limit = Math.floor(n);
      }

      let h;
      try {
        h = await sectorHoldings.getHoldings(sectorKey, {
          limit,
          refresh: q.refresh === '1',
        });
      } catch (e) {
        // 版塊代碼錯 → 400（使用者可修正）；上游抓不到 → 503（稍後再試）
        const status = e.code === 'BAD_SECTOR' ? 400 : 503;
        return sendError(res, status, e.code || 'HOLDINGS_FAILED', e.message, e.hint);
      }

      const tickers = h.holdings.map((x) => x.ticker);
      const ret = await sectorHoldings.getReturns(datasource, tickers);

      const sectorMeta = rrg.SECTORS.find((s) => s.key === sectorKey) || { key: sectorKey };

      const rows = h.holdings.map((x) => {
        const d = ret.byTicker[x.ticker];
        const failed = ret.failures.find((f) => f.ticker === x.ticker);
        return {
          ticker: x.ticker,
          name: x.name,
          weight: x.weight,
          /* 行情代碼可能與顯示代碼不同（BRK.B → BRK-B）。
             前端跳轉分析頁要用能查得到資料的那一個，否則點進去會 404。 */
          quoteSymbol: d && d.quoteSymbol ? d.quoteSymbol : sectorHoldings.toQuoteSymbol(x.ticker),
          // 四個區間的報酬（%）。null 代表資料不足或取用失敗，前端顯示「—」
          returns: d ? {
            d1: d.returns.d1,
            w1: d.returns.w1,
            m1: d.returns.m1,
            m3: d.returns.m3,
          } : { d1: null, w1: null, m1: null, m3: null },
          lastClose: d ? d.lastClose : null,
          adjUsed: d ? !!d.adjUsed : false,
          bars: d ? d.bars : 0,
          // 取用失敗的那幾檔要說清楚原因，不要讓「—」變成無解的謎
          unavailable: d ? null : (failed ? failed.message : '無資料'),
        };
      });

      return sendJSON(res, 200, {
        ok: true,
        sector: sectorKey,
        sectorLabel: sectorMeta.label || sectorKey,
        sectorShort: sectorMeta.short || sectorKey,
        sectorColor: sectorMeta.color || null,
        fundName: h.fundName,
        asOf: h.asOf,
        limits: {
          requested: limit,
          returned: rows.length,
          totalInFund: h.total,
          truncated: !!h.truncated,
        },
        periods: sectorHoldings.PERIODS.map((p) => ({
          key: p.key, label: p.label, tradingDays: p.tradingDays,
        })),
        rows,
        failures: ret.failures,
        source: h.source,
        holdingsCached: !!h.cached,
      });
    }

    /**
     * 版塊 Treemap（矩形樹狀圖）
     * ────────────────────────────────────────────────────────
     * GET /api/rrg/treemap?period=m1&sectors=XLK,XLF&perSector=10
     *
     * 為什麼四個週期合成一支端點（回傳所有週期都算好）：
     *   若前端每切一次週期就打一次 API，切換會有 1～3 秒延遲，
     *   而需求明確要求「切換後即時更新」。實測四個週期共用同一次
     *   行情抓取（251 根 K 棒已經包含 1/5/21 根的資訊），
     *   多算三個週期的成本是**零**——只是同一組序列多取三個索引。
     *
     * 因此設計成：一次請求回傳全部週期，前端切換是純本地重繪。
     * 這也讓「快速連點日→週→月→年」不會產生四個競態請求。
     *
     * 參數：
     *   period     d1|w1|m1|y1（預設 m1）——決定預設顯示哪個週期，不影響回傳內容
     *   sectors    逗號分隔版塊代碼（預設全部 11 個）
     *   perSector  每版塊檔數 1–30（預設 10）
     *   refresh=1  略過快取
     */
    if (pathname === '/api/rrg/treemap' && req.method === 'GET') {
      // 版塊驗證：與 /api/rrg 共用同一套規則，避免兩邊各自為政
      const sectorCheck = rrg.normSectors(q.sectors);
      if (!sectorCheck.ok) {
        return sendError(res, 400, sectorCheck.code, sectorCheck.message, sectorCheck.hint);
      }
      if (!sectorCheck.keys.length) {
        return sendError(res, 400, 'NO_SECTORS', '版塊清單為空，無法繪圖',
          `可用版塊：${rrg.SECTORS.map((s) => s.key).join(', ')}`);
      }

      const periodRaw = q.period == null || q.period === '' ? 'm1' : String(q.period).toLowerCase();
      if (!treemap.PERIOD_KEYS.includes(periodRaw)) {
        return sendError(res, 400, 'BAD_PERIOD',
          `不支援的週期「${q.period}」`,
          `可用週期：${treemap.PERIODS.map((p) => `${p.key}（${p.full}）`).join('、')}`);
      }

      let perSector = treemap.DEFAULT_PER_SECTOR;
      const tsRaw = q.perSector;
      if (tsRaw != null && tsRaw !== '') {
        const n = Number(tsRaw);
        if (!Number.isFinite(n) || n < 1 || n > treemap.MAX_PER_SECTOR) {
          return sendError(res, 400, 'BAD_PER_SECTOR',
            `perSector 必須是 1–${treemap.MAX_PER_SECTOR} 的整數（收到「${tsRaw}」）`,
            `不帶此參數時預設每版塊前 ${treemap.DEFAULT_PER_SECTOR} 檔`);
        }
        perSector = Math.floor(n);
      }

      const sectorMeta = {};
      for (const s of rrg.SECTORS) sectorMeta[s.key] = s;

      let data;
      try {
        data = await treemapService.getTreemap(datasource, {
          sectors: sectorCheck.keys,
          perSector,
          period: periodRaw,
          refresh: q.refresh === '1',
          sectorMeta,
        });
      } catch (e) {
        return sendError(res, 503, e.code || 'TREEMAP_FAILED', e.message, e.hint);
      }

      /* 四個週期一次算好，前端切換零延遲。
         做法：把每個葉節點的四個週期數值都附上。 */
      const periods = treemap.PERIODS.map((p) => ({
        key: p.key, label: p.label, full: p.full, tradingDays: p.tradingDays,
      }));

      return sendJSON(res, 200, {
        ...data,
        periods,
        /* 圖例刻度：每個週期的分級門檻，讓前端能畫出「顏色 ↔ 漲跌幅」對照。
           由後端提供而不是前端寫死，確保圖例與實際著色永遠一致。 */
        legend: treemap.PERIODS.map((p) => ({
          key: p.key,
          label: p.label,
          full: p.full,
          thresholdPct: treemap.SCALE[p.key],
          levels: treemap.LEVELS,
          // 各級別的門檻值（由淺到深），供圖例標示
          steps: Array.from({ length: treemap.LEVELS }, (_, i) => ({
            level: i + 1,
            minPct: (treemap.SCALE[p.key] / treemap.LEVELS) * i,
            maxPct: i === treemap.LEVELS - 1
              ? treemap.SCALE[p.key]
              : (treemap.SCALE[p.key] / treemap.LEVELS) * (i + 1),
          })),
        })),
      });
    }

    if (pathname === '/api/notify' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.symbol) return sendError(res, 400, 'EMPTY', '缺少 symbol 參數');

      // 前端會帶完整載荷（價格、訊號、新聞），但外部系統 / curl 常只給 symbol。
      // 缺價格時自動補一次分析，避免送出「現價：—」這種無資訊量的通知。
      if (body.price == null || !body.name) {
        try {
          const d = await analyzer.analyze(body.symbol);
          body.name = body.name || d.meta.name || body.symbol;
          body.price = body.price ?? d.meta.price;
          body.changePercent = body.changePercent ?? d.meta.changePercent;
          body.currency = body.currency || d.meta.currency;
          body.signals = body.signals || {
            buyZone: d.buyZone, score: d.score,
            verdictLabel: d.verdict?.label, probUp20: d.probabilities?.probUp20,
          };
          if (!Array.isArray(body.news)) {
            body.news = await yahoo.news(d.meta.symbol, 3, d.meta.name).catch(() => []);
          }
        } catch (e) {
          // 補資料失敗不阻擋通知：仍送出既有內容，並附上提示
          body.__enrichError = e.message;
        }
      }

      const result = await telegram.send(body);
      if (body.__enrichError) result.warning = `自動補齊行情失敗：${body.__enrichError}`;
      return sendJSON(res, result.ok ? 200 : 502, result);
    }

    if (pathname.startsWith('/api/')) {
      return sendError(res, 404, 'UNKNOWN_ENDPOINT', `未知的 API 端點：${pathname}`);
    }

    return serveStatic(req, res, pathname);
  } catch (e) {
    // 統一錯誤處理
    if (e.badInput) return sendError(res, 400, e.code || 'BAD_INPUT', e.message, e.hint);
    if (e.insufficient) return sendError(res, 422, 'INSUFFICIENT_DATA', e.message, '此標的可能為新上市、成交量過低或資料缺漏，建議改用其他標的');
    if (e.notFound || e.code === 'NOT_FOUND' || e.status === 404) {
      return sendError(res, 404, 'NOT_FOUND', e.message || '查無此股票代碼', '請確認代碼格式：美股如 AAPL，港股如 0700.HK');
    }
    if (e.status === 429) return sendError(res, 429, 'RATE_LIMITED', '資料來源請求過於頻繁，請稍候再試');
    console.error('[error]', pathname, e.message);
    return sendError(res, 500, 'UPSTREAM_ERROR', '取得資料時發生問題，請稍後重試', e.message);
  }
});

// 綁定 0.0.0.0 以便在容器 / 反向代理環境（如雲端沙箱）中接受外部連線
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  股票買入位與技術位分析系統`);
  console.log(`  服務已啟動： http://0.0.0.0:${PORT}`);
  console.log(`  Telegram 通知： ${telegram.isConfigured() ? '已設定' : '未設定（模擬模式）'}`);
  const ps = pool.summary();
  console.log(`  選股母體： ${ps.total} 檔（港股 ${ps.hk} / 美股 ${ps.us}）`);
  console.log(`  資料來源： Yahoo Finance\n`);

  // L2 進程內定時（預設不啟用，見 lib/scheduler.js 的說明）
  scheduler.startInterval(
    { analyzer, forecast, datasource, symbols: pool.byMarket('all') },
    screener,
    30 * 60 * 1000
  );
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
