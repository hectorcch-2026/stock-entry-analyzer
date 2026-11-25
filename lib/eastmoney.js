'use strict';

/**
 * 東方財富（Eastmoney）資料來源 —— Yahoo 的主要備援
 *
 * 為何需要：
 *   Yahoo Finance 對資料中心（雲端）IP 會直接限流（持續回 429），
 *   即使補齊瀏覽器標頭、建立 cookie/crumb 工作階段仍無法通過。
 *   東方財富的行情介面無此限制，且同時涵蓋美股與港股，正好對應本系統範圍。
 *
 * 覆蓋範圍：美股（NASDAQ / NYSE / AMEX）與港股。
 * 舊版 Yahoo 仍是首選（新聞較完整）；本模組僅在上游不可用時接手。
 *
 * secid 規則：`${market}.${code}`
 *   market: 105=NASDAQ, 106=NYSE, 107=AMEX, 116=香港
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };

const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';
const MARKET_LABEL = { 105: 'NASDAQ', 106: 'NYSE', 107: 'AMEX', 116: 'HKEX' };

const cache = new Map();
function cacheGet(k, ttl) {
  const h = cache.get(k);
  if (!h) return null;
  if (Date.now() - h.at > ttl) { cache.delete(k); return null; }
  return h.value;
}
function cacheSet(k, v) {
  cache.set(k, { at: Date.now(), value: v });
  if (cache.size > 300) {
    for (const [key] of [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 80)) cache.delete(key);
  }
}

async function getJSON(url, timeout = 10000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    const err = new Error(`東方財富回應 ${res.status}`);
    err.status = res.status;
    // 501 / 403 等代表被出口代理阻擋，屬「可換來源」的環境問題
    if (res.status >= 500 || res.status === 403) err.status = 502;
    err.failover = true;
    throw err;
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // 被代理攔截時常回 HTML 或 jQuery 包裝，屬環境問題而非標的錯誤，
    // 必須標記為可換來源，否則會中斷整個備援鏈。
    const err = new Error('東方財富回應非 JSON（可能被網路代理攔截）');
    err.status = 502;
    err.failover = true;
    throw err;
  }
}

/* ==================== 代碼 ↔ secid 轉換 ==================== */

/** 應用代碼（AAPL / 0700.HK）→ 東方財富代碼（AAPL / 00700）+ market */
function toEmCode(symbol) {
  const s = String(symbol || '').trim();
  const m = s.match(/^(\d{1,5})\.HK$/i);
  if (m) return { code: m[1].padStart(5, '0'), market: 116 };
  // 無後綴的純數字視為港股
  if (/^\d{1,5}$/.test(s)) return { code: s.padStart(5, '0'), market: 116 };
  return { code: s.toUpperCase(), market: null }; // 美股：market 由搜尋決定
}

/** 東方財富代碼 + market → 應用代碼 */
function toAppSymbol(code, market) {
  if (Number(market) === 116) {
    // 00700 → 0700.HK（去掉前導零，最少 4 位）
    const digits = String(code).replace(/^0+/, '') || '0';
    return digits.padStart(4, '0') + '.HK';
  }
  return String(code).toUpperCase();
}

/** 解析出可用的 secid（美股需查詢 market） */
async function resolveSecid(symbol) {
  const { code, market } = toEmCode(symbol);
  if (market) return `${market}.${code}`;
  // 美股：用搜尋取得正確 market（105 / 106 / 107）
  const rows = await suggest(code);
  const hit = rows.find((r) => r.code.toUpperCase() === code.toUpperCase() && US_MARKETS.has(r.market));
  if (hit) return `${hit.market}.${hit.code}`;
  // 找不到時預設 NASDAQ，多數美股可解析
  return `105.${code}`;
}

const US_MARKETS = new Set([105, 106, 107]);

/* ==================== 搜尋 ==================== */

async function suggest(input) {
  const key = `suggest:${input.toLowerCase()}`;
  const hit = cacheGet(key, 10 * 60 * 1000);
  if (hit) return hit;

  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(input)}&type=14&token=${SUGGEST_TOKEN}&count=12`;
  const data = await getJSON(url);
  const rows = (data?.QuotationCodeTable?.Data || [])
    .filter((d) => d.Code && (d.Classify === 'UsStock' || d.Classify === 'HK' || Number(d.MktNum) === 116))
    .map((d) => ({
      code: d.Code,
      name: d.Name,
      market: Number(d.MktNum),
      classify: d.Classify,
      exchange: d.JYS || MARKET_LABEL[Number(d.MktNum)] || '',
    }));
  cacheSet(key, rows);
  return rows;
}

/**
 * 搜尋（介面與 yahoo.search 一致）
 * @returns {Promise<Array>} 正規化候選清單
 */
async function search(q) {
  const trimmed = String(q || '').trim();
  if (!trimmed) return [];
  const key = `search:${trimmed.toLowerCase()}`;
  const hit = cacheGet(key, 10 * 60 * 1000);
  if (hit) return hit;

  const rows = await suggest(trimmed);
  const results = rows.map((r) => {
    const isHK = r.market === 116;
    return {
      symbol: toAppSymbol(r.code, r.market),
      name: r.name,
      shortName: r.name,
      exchange: isHK ? 'Hong Kong' : r.exchange,
      exchangeCode: r.exchange,
      type: 'EQUITY',
      market: isHK ? 'HK' : 'US',
      score: 0,
      fromEastmoney: true,
    };
  });

  // 去重（同一 symbol 可能有多筆）
  const seen = new Set();
  const dedup = results.filter((r) => (seen.has(r.symbol) ? false : (seen.add(r.symbol), true)));
  // 港股優先，與原有排序一致
  dedup.sort((a, b) => (a.market === b.market ? 0 : a.market === 'HK' ? -1 : 1));
  cacheSet(key, dedup);
  return dedup;
}

/* ==================== K 線 ==================== */

const RANGE_TO_LMT = {
  '1d': 2, '5d': 6, '1mo': 24, '3mo': 66, '6mo': 130,
  '1y': 260, '2y': 520, '5y': 1300, '10y': 2600, max: 6000,
};

/**
 * 抓取 K 線（介面與 yahoo.chart 一致）
 * @param {string} symbol 應用代碼
 * @param {string} range  1d/5d/1mo/3mo/6mo/1y/2y/5y/max
 * @param {string} interval 1d / 1wk / 1mo
 */
async function chart(symbol, range = '2y', interval = '1d') {
  const key = `chart:${symbol}:${range}:${interval}`;
  const hit = cacheGet(key, 60 * 1000);
  if (hit) return hit;

  const secid = await resolveSecid(symbol);
  const klt = interval === '1wk' ? 102 : interval === '1mo' ? 103 : 101;
  const lmt = RANGE_TO_LMT[range] || 520;

  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
    + `?secid=${encodeURIComponent(secid)}`
    + '&fields1=f1,f2,f3,f4,f5,f6'
    + '&fields2=f51,f52,f53,f54,f55,f56,f57'
    + `&klt=${klt}&fqt=1&end=20500101&lmt=${lmt}`;
  const data = await getJSON(url);
  const d = data?.data;
  if (!d || !Array.isArray(d.klines) || !d.klines.length) {
    const err = new Error('查無此標的的行情資料');
    err.code = 'NOT_FOUND';
    err.notFound = true;
    throw err;
  }

  // 格式：date,open,close,high,low,volume,amount
  const candles = [];
  for (const line of d.klines) {
    const p = String(line).split(',');
    if (p.length < 6) continue;
    const [date, o, c, h, l, v] = p;
    const close = Number(c);
    if (!Number.isFinite(close)) continue;
    candles.push({
      t: Date.parse(date + 'T00:00:00Z'),
      o: Number(o) || close,
      h: Number(h) || close,
      l: Number(l) || close,
      c: close,
      v: Number(v) || 0,
    });
  }

  const payload = {
    meta: {
      symbol: toAppSymbol(d.code, d.market),
      longName: d.name,
      shortName: d.name,
      currency: Number(d.market) === 116 ? 'HKD' : 'USD',
      exchangeName: MARKET_LABEL[Number(d.market)] || '',
      regularMarketPrice: candles.length ? candles[candles.length - 1].c : null,
      exchangeTimezoneName: Number(d.market) === 116 ? 'Asia/Hong_Kong' : 'America/New_York',
      fromEastmoney: true,
    },
    candles,
  };
  cacheSet(key, payload);
  return payload;
}

/**
 * 取 K 線並附帶復權資訊（供 FP 使用，介面與 yahoo.chartWithAdj 一致）。
 *
 * 東方財富的 kline 端點已固定帶 fqt=1（原生前復權），因此回傳的
 * candles **本身就是復權價**，不需要再乘任何因子。
 * 這裡的 adjClose 固定為 null，由 lib/adjust.js 依來源名稱判定為
 * 'qfq-native'，避免上層誤以為需要再做一次 Yahoo 式調整（會重複復權）。
 *
 * @param {string} symbol
 * @param {string} range
 * @param {string} interval
 * @returns {Promise<Object>} {candles, adjClose:null, meta, source, bars}
 */
async function chartWithAdj(symbol, range = '10y', interval = '1d') {
  const payload = await chart(symbol, range, interval);
  return {
    candles: payload.candles,
    adjClose: null,          // 無需調整：資料源已復權
    meta: payload.meta,
    source: 'eastmoney',
    bars: payload.candles.length,
  };
}

/* ==================== 即時報價 ==================== */

async function quote(symbol) {
  const secid = await resolveSecid(symbol);
  const url = 'https://push2.eastmoney.com/api/qt/stock/get'
    + `?secid=${encodeURIComponent(secid)}`
    + '&fields=f43,f44,f45,f46,f47,f48,f57,f58,f59,f60,f86,f107,f116,f169,f170';
  const data = await getJSON(url);
  const d = data?.data;
  if (!d || d.f43 == null) {
    const err = new Error('查無此標的的即時報價');
    err.code = 'NOT_FOUND';
    err.notFound = true;
    throw err;
  }

  // f59 為小數位數；報價欄位為整數，需據此還原
  const scale = Math.pow(10, Number.isFinite(d.f59) ? d.f59 : 3);
  const px = (v) => (v == null || v === '-' ? null : Number(v) / scale);
  const market = Number(d.f107) === 116 ? 'HK' : 'US';

  return {
    symbol: toAppSymbol(d.f57, d.f107),
    name: d.f58 || d.f57,
    shortName: d.f58 || d.f57,
    currency: market === 'HK' ? 'HKD' : 'USD',
    exchange: MARKET_LABEL[market === 'HK' ? 116 : 105] || (market === 'HK' ? 'HKEX' : 'US'),
    market,
    price: px(d.f43),
    previousClose: px(d.f60),
    changePercent: d.f170 == null ? null : Number(d.f170) / 100,
    dayHigh: px(d.f44),
    dayLow: px(d.f45),
    volume: d.f47 == null ? null : Number(d.f47),
    marketTime: d.f86 ? Number(d.f86) * 1000 : null,
    timezone: market === 'HK' ? 'Asia/Hong_Kong' : 'America/New_York',
    fromEastmoney: true,
  };
}

module.exports = { search, chart, chartWithAdj, quote, suggest, toAppSymbol, toEmCode, resolveSecid };
