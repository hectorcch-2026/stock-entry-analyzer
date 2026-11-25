'use strict';

/**
 * Yahoo Finance 資料存取層
 * - 搜尋（代碼 / 名稱，支援美股與港股）
 * - 日線 / 週線 K 線資料
 * - 即時報價與新聞
 * 內建 TTL 快取與重試，避免對上游過度請求。
 */

const HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 上游請求標頭：補齊真實瀏覽器會送出的欄位。
 * Yahoo 對資料中心（雲端）IP 相當敏感，缺少這些標頭更容易直接被限流。
 */
const BASE_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
  Referer: 'https://finance.yahoo.com/',
  Origin: 'https://finance.yahoo.com',
};

const alias = require('./alias');

const cache = new Map();

function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 400) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) cache.delete(k);
  }
}

/* ---------------------------------------------------------------
 * Cookie / crumb 工作階段
 *
 * Yahoo 對「無工作階段」的資料中心 IP 會直接限流（429）。
 * 標準解法是先取得 cookie 與 crumb，再帶著它們請求，
 * 讓請求看起來像已造訪過網站的瀏覽器。
 * --------------------------------------------------------------- */
let session = null;          // { cookie, crumb, at }
let sessionPending = null;   // 避免併發時重複建立

async function buildSession() {
  // 1) 向 Yahoo 取一組 cookie（fc.yahoo.com 會回 404 但附帶 Set-Cookie）
  let cookie = '';
  try {
    const r = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    const list = typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie()
      : [r.headers.get('set-cookie')].filter(Boolean);
    cookie = list.map((c) => String(c).split(';')[0]).join('; ');
  } catch { /* 拿不到 cookie 仍可嘗試無狀態請求 */ }

  // 2) 以 cookie 換取 crumb
  let crumb = '';
  if (cookie) {
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': UA, Cookie: cookie },
        signal: AbortSignal.timeout(3000),
      });
      const t = (await r.text()).trim();
      // crumb 為短英數字串；若回 HTML 代表被擋，視為無效
      if (r.ok && /^[\w.\-]{4,24}$/.test(t)) crumb = t;
    } catch { /* 忽略 */ }
  }

  return { cookie, crumb, at: Date.now(), failed: !cookie };
}

let sessionBuilds = 0;   // 限制工作階段重建次數，避免在被封鎖環境中反覆等待

async function getSession(force = false) {
  const TTL = 30 * 60 * 1000;
  // 已嘗試過且失敗：短期內不再重建（否則每次重試都要等逾時）
  if (!force && session && session.failed && Date.now() - session.at < 5 * 60 * 1000) return session;
  if (!force && session && Date.now() - session.at < TTL) return session;
  if (sessionBuilds >= 6) {
    if (!session) session = { cookie: '', crumb: '', at: Date.now(), failed: true };
    return session;
  }
  if (sessionPending) return sessionPending;
  sessionBuilds++;
  sessionPending = buildSession()
    .then((s) => { session = s; return s; })
    .finally(() => { sessionPending = null; });
  return sessionPending;
}

/**
 * 帶重試、主機輪替、工作階段與 429 退避的 JSON 抓取。
 *
 * Yahoo 對雲端 IP 常回 429。策略：
 *   - 附上 cookie / crumb 工作階段，降低被視為匿名流量的機率
 *   - 每次嘗試輪替 query1 / query2 主機
 *   - 429 時退避重試（指數 + 抖動）；非 429 的 4xx 直接拋出
 *   - 逾時縮短至 6 秒並限制重試次數，確保在被封鎖環境中快速失敗，
 *     交由上層資料來源調度層切換備援，而非讓使用者久候
 * @param {string} path 相對路徑
 * @param {number} retries 重試次數
 */
async function getJSON(path, retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    try {
      const s = await getSession(false);
      const headers = { ...BASE_HEADERS };
      if (s.cookie) headers.Cookie = s.cookie;

      // 部分端點需帶 crumb；帶上無害（無 crumb 時不加）
      let url = host + path;
      if (s.crumb) url += (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(s.crumb);

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });

      if (!res.ok) {
        const err = new Error(`上游回應 ${res.status}`);
        err.status = res.status;
        if (res.status !== 429 && res.status < 500) throw Object.assign(err, { noRetry: true });
        throw err;
      }

      // Yahoo 有時以 200 回傳「錯誤」JSON，交由呼叫端判斷 result 是否存在
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        const err = new Error('上游回應非 JSON');
        err.status = 502;
        throw err;
      }
    } catch (e) {
      lastErr = e;
      if (e.noRetry) throw e;
      if (attempt < retries) {
        // 429 退避久一點，其餘短退避；加入抖動避免同步重試
        const base = e.status === 429 ? 700 : 300;
        const wait = base * (attempt + 1) + Math.floor(Math.random() * 200);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

/** 判斷市場別：US / HK */
function marketOf(symbol) {
  return /\.HK$/i.test(symbol) ? 'HK' : 'US';
}

/**
 * 搜尋股票（代碼或名稱）
 * 上游限制：Yahoo 搜尋 API 對中文關鍵字直接回 400，故中文查詢走本地別名索引。
 * @returns {Promise<Array>} 正規化後的候選清單
 */
async function search(q) {
  const key = `search:${q.toLowerCase()}`;
  const cached = cacheGet(key, 10 * 60 * 1000);
  if (cached) return cached;

  const trimmed = String(q || '').trim();
  let results = [];

  if (alias.hasChinese(trimmed)) {
    // 中文：完全依賴本地別名索引
    results = alias.suggestions(trimmed);
  } else {
    // 英文 / 代碼：走上游；若上游無結果再用本地英文索引補
    try {
      const data = await getJSON(
        `/v1/finance/search?q=${encodeURIComponent(trimmed)}&quotesCount=12&newsCount=0&enableFuzzyQuery=true`
      );
      const quotes = Array.isArray(data.quotes) ? data.quotes : [];
      results = quotes
        .filter((x) => x.symbol && /EQUITY|ETF/.test(x.quoteType || ''))
        .map((x) => ({
          symbol: x.symbol,
          name: x.longname || x.shortname || x.symbol,
          shortName: x.shortname || x.symbol,
          exchange: x.exchDisp || x.exchange || '',
          exchangeCode: x.exchange || '',
          type: x.quoteType,
          market: /HKG|HKSE|HKS/.test(x.exchange || '') || /\.HK$/.test(x.symbol) ? 'HK' : 'US',
          score: x.score || 0,
        }));
    } catch (e) {
      // 上游不可用時仍嘗試本地索引，避免整體失敗
      const local = alias.lookupEnglish(trimmed);
      if (!local) throw e;
      results = alias.suggestions(trimmed);
    }
    // 上游無結果時，補上本地英文別名
    if (!results.length) {
      const localSym = alias.lookupEnglish(trimmed);
      if (localSym) {
        results = [{
          symbol: localSym, name: trimmed, shortName: trimmed,
          exchange: /\.HK$/.test(localSym) ? 'Hong Kong' : 'United States',
          market: /\.HK$/.test(localSym) ? 'HK' : 'US', type: 'EQUITY', fromAlias: true,
        }];
      }
    }
  }

  // 港股排前，其次美股，方便華語使用者
  results.sort((a, b) => {
    if (a.market !== b.market) return a.market === 'HK' ? -1 : 1;
    return (b.score || 0) - (a.score || 0);
  });

  cacheSet(key, results);
  return results;
}

/** 抓取 K 線（含 meta 報價） */
async function chart(symbol, range, interval) {
  const key = `chart:${symbol}:${range}:${interval}`;
  const cached = cacheGet(key, 60 * 1000);
  if (cached) return cached;

  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div,split`;
  const data = await getJSON(path);
  const result = data?.chart?.result?.[0];
  const error = data?.chart?.error;

  if (!result) {
    const desc = error?.description || '查無此標的的行情資料';
    const err = new Error(desc);
    err.code = error?.code || 'NOT_FOUND';
    // 上游限流會以 200 回傳錯誤 JSON，不可誤判為「找不到標的」
    if (/rate|too many|limit|throttl/i.test(desc) || /TooManyRequests/i.test(err.code)) {
      err.status = 429;
    } else {
      err.notFound = true;
    }
    throw err;
  }

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null) continue; // 跳過停牌 / 缺值
    candles.push({
      t: ts[i] * 1000,
      o: q.open?.[i] ?? c,
      h: q.high?.[i] ?? c,
      l: q.low?.[i] ?? c,
      c,
      v: q.volume?.[i] ?? 0,
    });
  }

  const payload = { meta: result.meta || {}, candles };
  cacheSet(key, payload);
  return payload;
}

/**
 * 抓取 K 線「並附上 adjclose」（供 FP 使用，不影響 chart() 的回傳形狀）
 *
 * 為什麼不直接改 chart()：
 *   chart() 的回傳物件被 analyzer 與多處既有邏輯共用，
 *   多塞一個欄位會讓既有測試的深度比對（AC-01）產生差異。
 *   這裡回傳獨立結構，只有 FP 會呼叫。
 *
 * 實測：indicators.adjclose[0].adjclose 與 quote[0].close 等長，
 *       且確實做了股息調整（KO 五年最舊一根 close=53.73 / adjclose=46.42）。
 *
 * @param {string} symbol
 * @param {string} range
 * @param {string} interval
 * @returns {Promise<{candles:Array, adjClose:Array|null, meta:Object, source:'yahoo', bars:number}>}
 */
async function chartWithAdj(symbol, range = '10y', interval = '1d') {
  const key = `chartAdj:${symbol}:${range}:${interval}`;
  const cached = cacheGet(key, 60 * 1000);
  if (cached) return cached;

  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div,split`;
  const data = await getJSON(path);
  const result = data?.chart?.result?.[0];
  const error = data?.chart?.error;

  if (!result) {
    const desc = error?.description || '查無此標的的行情資料';
    const err = new Error(desc);
    err.code = error?.code || 'NOT_FOUND';
    if (/rate|too many|limit|throttl/i.test(desc) || /TooManyRequests/i.test(err.code)) {
      err.status = 429;
    } else {
      err.notFound = true;
    }
    throw err;
  }

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  // adjclose 為獨立陣列，與 quote 平行對齊同一組 timestamp
  const adj = result.indicators?.adjclose?.[0]?.adjclose || null;

  const candles = [];
  const adjClose = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null) continue;          // 跳過停牌 / 缺值
    candles.push({
      t: ts[i] * 1000,
      o: q.open?.[i] ?? c,
      h: q.high?.[i] ?? c,
      l: q.low?.[i] ?? c,
      c,
      v: q.volume?.[i] ?? 0,
    });
    // 逐根對齊：剔除的根，adjclose 也要同步剔除，否則索引錯位
    adjClose.push(adj ? (adj[i] ?? null) : null);
  }

  const payload = {
    candles,
    adjClose: adj ? adjClose : null,
    meta: result.meta || {},
    source: 'yahoo',
    bars: candles.length,
  };
  cacheSet(key, payload);
  return payload;
}

/** 即時報價（用 chart meta，最穩定） */
async function quote(symbol) {
  const { meta, candles } = await chart(symbol, '5d', '1d');
  const last = candles[candles.length - 1];
  return {
    symbol: meta.symbol || symbol,
    name: meta.longName || meta.shortName || symbol,
    shortName: meta.shortName || symbol,
    currency: meta.currency || 'USD',
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    market: marketOf(meta.symbol || symbol),
    price: meta.regularMarketPrice ?? last?.c ?? null,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    changePercent: null,
    dayHigh: meta.regularMarketDayHigh ?? last?.h ?? null,
    dayLow: meta.regularMarketDayLow ?? last?.l ?? null,
    volume: meta.regularMarketVolume ?? last?.v ?? null,
    marketTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : last?.t ?? null,
    timezone: meta.exchangeTimezoneName || '',
  };
}

/**
 * 相關新聞（用於 Telegram 通知）
 * 注意：上游以「代碼」查詢（如 0700.HK）通常回 0 筆，
 * 必須改用公司名稱（如 Tencent Holdings）才會有結果，故支援傳入 name。
 */
async function news(symbol, count = 5, name = null) {
  const key = `news:${symbol}:${name || ''}:${count}`;
  const cached = cacheGet(key, 15 * 60 * 1000);
  if (cached) return cached;

  async function query(q) {
    const data = await getJSON(
      `/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=${count}`
    );
    return (data.news || []).map((n) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      time: n.providerPublishTime ? n.providerPublishTime * 1000 : null,
      relatedTickers: n.relatedTickers || [],
    }));
  }

  try {
    let items = await query(symbol);
    // 以代碼查無新聞時，退用公司名稱再查一次
    if (!items.length) {
      let q = name;
      if (!q) {
        try { q = (await quote(symbol)).name; } catch { q = null; }
      }
      if (q) items = await query(q);
    }
    // 只保留與本標的相關的新聞（若有標記 relatedTickers）
    const related = items.filter((n) => !n.relatedTickers.length || n.relatedTickers.includes(symbol));
    const final = related.length ? related : items;
    cacheSet(key, final);
    return final;
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------
 * 期權鏈
 *
 * Yahoo 的期權端點需要有效 crumb 才會回傳資料，而 crumb 綁在
 * 既有的 cookie 工作階段上（見上方 getJSON），因此這裡直接複用
 * 同一條路徑，不需另建認證流程。
 *
 * ⚠️ 實測（AAPL / NVDA / TSLA）：openInterest 一律回傳 0，
 *    volume 與部分 impliedVolatility 為真實值；港股（如 0700.HK）
 *    完全沒有期權鏈。上層 buildGEX 已針對這兩種情況分流處理。
 * --------------------------------------------------------------- */
async function options(symbol, expiration = null) {
  const key = `options:${symbol}:${expiration || 'nearest'}`;
  const cached = cacheGet(key, 5 * 60 * 1000);
  if (cached) return cached;

  let path = `/v7/finance/options/${encodeURIComponent(symbol)}`;
  if (expiration) path += `?date=${expiration}`;

  let data;
  try {
    data = await getJSON(path);
  } catch (e) {
    // 404 / 無期權市場：回 null 讓上層顯示「無期權鏈」而非整體失敗
    if (e.status === 404 || e.notFound) return null;
    throw e;
  }

  const result = data?.optionChain?.result?.[0];
  if (!result) return null;   // 港股等無期權標的

  const norm = (rows) =>
    (Array.isArray(rows) ? rows : []).map((r) => ({
      strike: r.strike,
      openInterest: r.openInterest ?? 0,
      volume: r.volume ?? 0,
      impliedVolatility: r.impliedVolatility ?? 0,
      lastPrice: r.lastPrice ?? null,
      inTheMoney: !!r.inTheMoney,
    }));

  const chain = result.options?.[0] || {};
  const calls = norm(chain.calls);
  const puts = norm(chain.puts);

  // 港股（如 0700.HK）會回傳「有 result 但兩邊都是空陣列」，
  // 這等同沒有期權市場，一律視為無期權鏈，讓上層給出明確提示，
  // 而不是顯示「期權鏈為空」這種含糊訊息。
  if (calls.length === 0 && puts.length === 0) return null;

  const payload = {
    symbol: result.underlyingSymbol || symbol,
    spot: result.quote?.regularMarketPrice ?? null,
    expiration: chain.expirationDate ?? null,
    expirations: result.expirationDates || [],
    calls,
    puts,
  };

  cacheSet(key, payload);
  return payload;
}

module.exports = { search, chart, chartWithAdj, quote, news, options, marketOf };
