'use strict';

/**
 * 騰訊行情資料來源（qt.gtimg.cn / web.ifzq.gtimg.cn）
 *
 * 為何採用：
 *   實測部署沙箱的對外網路僅放行騰訊行情主機，Yahoo（429）與東方財富（socket 拒絕）皆不可用。
 *   騰訊同時涵蓋美股與港股，且提供日線 / 週線，足以支撐本系統的技術分析。
 *   本模組作為最後一道備援，確保線上環境仍能提供即時資料。
 *
 * 覆蓋範圍：美股（需交易所後綴如 .OQ / .N）與港股。
 *
 * 代碼規則：
 *   美股 us{SYMBOL}.{EXCH}  例：usAAPL.OQ（NASDAQ）、usBABA.N（NYSE）
 *   港股 hk{5 位數字}        例：hk00700
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://gu.qq.com/' };

const alias = require('./alias');

// 騰訊行情介面以 GBK 編碼回傳中文名稱
const gbk = new TextDecoder('gbk');

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

async function getText(url, timeout = 10000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    const err = new Error(`騰訊行情回應 ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return gbk.decode(buf);
}

async function getJSON(url, timeout = 10000) {
  const text = await getText(url, timeout);
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('騰訊行情回應非 JSON');
    err.status = 502;
    throw err;
  }
}

/* ==================== 報價解析 ==================== */

/**
 * 解析 qt.gtimg.cn 的 `v_usAAPL.OQ="..."` 格式。
 * 欄位以 ~ 分隔：
 *   美股（實測 73 欄）：[1] 名稱 [2] 帶後綴代碼 [3] 現價 [4] 昨收 [5] 開盤
 *     [6] 成交量 [30] 時間 [31] 漲跌 [32] 漲跌幅% [33] 最高 [34] 最低 [35] 幣別 [46] 英文全名
 *   港股（實測 78 欄）：[35] 為現價而非幣別，且無幣別欄位（港股固定 HKD）
 */
function parseQuoteLine(line) {
  const m = line.match(/^v_([^=]+)="([^"]*)"/);
  if (!m) return null;
  const code = m[1];
  const f = m[2].split('~');
  if (f.length < 36) return null;
  const isHK = /^hk/i.test(code);
  const num = (i) => (f[i] === '' || f[i] === undefined ? null : Number(f[i]));
  const withSuffix = f[2] || '';
  return {
    code,
    name: f[1] || '',
    fullCode: withSuffix,
    price: num(3),
    previousClose: num(4),
    open: num(5),
    volume: num(6),
    time: f[30] || '',
    change: num(31),
    changePercent: num(32),
    dayHigh: num(33),
    dayLow: num(34),
    // 港股無幣別欄位，固定為 HKD
    currency: isHK ? 'HKD' : (f[35] || 'USD'),
    englishName: f[46] || '',
    market: isHK ? 'HK' : 'US',
    exchangeSuffix: withSuffix.includes('.') ? withSuffix.split('.').pop() : '',
  };
}

/** 批次取得報價（騰訊一次最多可查多檔） */
async function rawQuotes(codes) {
  if (!codes.length) return [];
  const text = await getText('https://qt.gtimg.cn/q=' + codes.join(','));
  return text.split('\n').map((l) => parseQuoteLine(l.trim())).filter(Boolean);
}

/* ==================== 代碼轉換 ==================== */

/** 應用代碼（AAPL / 0700.HK）→ 可能的騰訊代碼（含交易所後綴候選） */
function candidatesFor(symbol) {
  const s = String(symbol || '').trim();
  const hk = s.match(/^(\d{1,5})\.HK$/i);
  if (hk) return [{ qq: 'hk' + hk[1].padStart(5, '0'), suffix: '' }];
  if (/^\d{1,5}$/.test(s)) return [{ qq: 'hk' + s.padStart(5, '0'), suffix: '' }];
  const up = s.toUpperCase();
  // 美股：先嘗試帶交易所後綴（NASDAQ .OQ / NYSE .N / AMEX .A），再試無後綴
  return [
    { qq: `us${up}.OQ`, suffix: 'OQ' },
    { qq: `us${up}.N`, suffix: 'N' },
    { qq: `us${up}.A`, suffix: 'A' },
    { qq: `us${up}`, suffix: '' },
  ];
}

/** 騰訊代碼 → 應用代碼 */
function toAppSymbol(code, row) {
  if (/^hk/i.test(code)) {
    const digits = code.replace(/^hk/i, '').replace(/^0+/, '') || '0';
    return digits.padStart(4, '0') + '.HK';
  }
  // 美股：由 fullCode（AAPL.OQ）或原始輸入取主代碼
  const base = (row?.fullCode || code.replace(/^us/i, '')).split('.')[0];
  return base.toUpperCase();
}

/** 找出可用且帶資料的騰訊代碼（快取結果避免重複探測） */
async function resolveCode(symbol) {
  const key = `resolve:${String(symbol).toUpperCase()}`;
  const hit = cacheGet(key, 30 * 60 * 1000);
  if (hit) return hit;

  const cands = candidatesFor(symbol);
  const quotes = await rawQuotes(cands.map((c) => c.qq));
  // 取第一個「有價格」的候選；無後綴候選排最後，避免抓到空殼
  let best = null;
  for (const c of cands) {
    const q = quotes.find((x) => x.code.toLowerCase() === c.qq.toLowerCase());
    if (q && q.price != null) { best = { ...c, quote: q }; break; }
  }
  if (!best) {
    // 沒有任何候選有資料時，仍回傳第一個候選以便後續報錯路徑一致
    best = { ...cands[0], quote: null };
  }

  // 關鍵：上游會把 `usAAPL.OQ` 正規化為無後綴的 `usAAPL` 回傳，
  // 真正帶交易所後綴的代碼藏在欄位 f2（如 AAPL.OQ）。
  // K 線介面必須帶後綴才能取得完整歷史（無後綴僅回 2 筆邊界資料），
  // 因此這裡要從 fullCode 還原後綴，否則 chart 會拿到殘缺資料。
  if (best.quote) {
    const full = best.quote.fullCode || '';       // 例：AAPL.OQ / 00700
    const suffix = full.includes('.') ? full.split('.').pop().toUpperCase() : '';
    // 只在美股、且有後綴時改寫 qq（港股代碼不含後綴）
    if (suffix && !/^hk/i.test(best.qq)) {
      best.qq = `us${full.split('.')[0].toUpperCase()}.${suffix}`;
      best.suffix = suffix;
      best.exchangeSuffix = suffix;
    }
  }

  cacheSet(key, best);
  return best;
}

/** 解析騰訊時間字串：港股用 `2026/11/24 16:08:15`，美股用 `2026-11-23 16:00:01` */
function parseQqTime(s) {
  if (!s) return null;
  const t = s.trim().replace(/-/g, '/');
  const d = new Date(t.replace(' ', 'T') + (/[Z+]/.test(s) ? '' : (s.includes(' ') ? '' : '')));
  // 以本地時間解讀（兩地皆為 UTC+8，與使用者時區一致）
  const m = t.match(/^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

/* ==================== 搜尋 ==================== */

/**
 * 搜尋（smartbox），支援英文與中文。
 * 回傳格式：v_hint="us~aapl.oq~Apple~apple~GP^hk~00700~腾讯控股~txkg~GP"
 */
async function search(q) {
  const trimmed = String(q || '').trim();
  if (!trimmed) return [];
  const key = `search:${trimmed.toLowerCase()}`;
  const hit = cacheGet(key, 10 * 60 * 1000);
  if (hit) return hit;

  // 上游索引以簡體中文建立，繁體查詢需先轉換
  const queries = [trimmed];
  const simplified = alias.toSimplified(trimmed);
  if (simplified !== trimmed) queries.push(simplified);

  let out = [];
  for (const query of queries) {
    const text = await getText('https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(query) + '&t=all');
    const m = text.match(/v_hint="([^"]*)"/);
    if (!m || !m[1]) continue;

    for (const item of m[1].split('^')) {
      const p = item.split('~');
      if (p.length < 5) continue;
      const [mkt, code, name, , type] = p;
      // 只保留美股與港股股票，排除基金 / 權證 / A 股等
      if (mkt !== 'us' && mkt !== 'hk') continue;
      if (type && !/^GP/.test(type)) continue;

      const isHK = mkt === 'hk';
      const appSymbol = isHK
        ? (code.replace(/^0+/, '') || '0').padStart(4, '0') + '.HK'
        : code.split('.')[0].toUpperCase();

      out.push({
        symbol: appSymbol,
        name,
        shortName: name,
        exchange: isHK ? 'Hong Kong' : (/\.n$/i.test(code) ? 'NYSE' : /\.oq$/i.test(code) ? 'NASDAQ' : 'US'),
        exchangeCode: code,
        type: 'EQUITY',
        market: isHK ? 'HK' : 'US',
        score: 0,
        fromTencent: true,
      });
    }
    if (out.length) break;
  }

  const seen = new Set();
  const dedup = out.filter((r) => (seen.has(r.symbol) ? false : (seen.add(r.symbol), true)));
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
 * K 線端點形狀候選（主機 × 路徑）。
 *
 * 不同網路環境對不同端點的放行差異極大，且與主機無關而與「路徑」有關：
 *   實測雲端沙箱：`.../appstock/app/fqkline/get` 一律回 501（被出口代理阻擋），
 *   但 `.../appstock/app/newfqkline/get` 與 `.../appstock/app/kline/kline` 皆正常。
 *   本機則三者皆可用。
 * 因此這裡列出所有形狀，逐一嘗試、取第一個可回應者，並記住成功的組合。
 *
 * 回傳的資料鍵名也不同（qfqday / day），由呼叫端一併嘗試。
 */
const KLINE_SHAPES = [
  { path: '/appstock/app/newfqkline/get', param: (code, period, lmt) => `${code},${period},,,${lmt},qfq`, key: 'newfqkline' },
  { path: '/appstock/app/kline/kline', param: (code, period, lmt) => `${code},${period},,,${lmt}`, key: 'kline' },
  { path: '/appstock/app/fqkline/get', param: (code, period, lmt) => `${code},${period},,,${lmt},qfq`, key: 'fqkline' },
];

const KLINE_HOSTS = [
  'https://web.ifzq.gtimg.cn',
  'https://ifzq.gtimg.cn',
  'https://proxy.finance.qq.com/ifzqgtimg',
];

/** 已驗證可用的端點組合（形狀 + 主機），優先重用避免重複探測 */
let klineShape = null;
let klineHost = null;

/** 從上游回應取出 K 線陣列（鍵名與週期有關，需逐一嘗試） */
function extractRows(d, period) {
  if (!d || typeof d !== 'object') return [];
  const names = period === 'day'
    ? ['qfqday', 'day', 'newqfqday', 'kline']
    : [`qfq${period}`, period, `newqfq${period}`];
  for (const n of names) {
    if (Array.isArray(d[n]) && d[n].length) return d[n];
  }
  // 最後退而求其次：找第一個看起來像 K 線的陣列
  for (const v of Object.values(d)) {
    if (Array.isArray(v) && v.length && Array.isArray(v[0]) && v[0].length >= 5) return v;
  }
  return [];
}

/**
 * 抓取 K 線（介面與 yahoo.chart 一致）
 *
 * 注意：美股必須帶交易所後綴（如 usAAPL.OQ）才會回傳完整歷史；
 * 缺少後綴時上游僅回 2 筆邊界資料。
 */
async function chart(symbol, range = '2y', interval = '1d') {
  const key = `chart:${symbol}:${range}:${interval}`;
  const hit = cacheGet(key, 60 * 1000);
  if (hit) return hit;

  const resolved = await resolveCode(symbol);
  const period = interval === '1wk' ? 'week' : interval === '1mo' ? 'month' : 'day';
  const lmt = RANGE_TO_LMT[range] || 520;

  // 依序嘗試候選代碼，取回傳最多資料者
  const cands = resolved.suffix
    ? [{ qq: resolved.qq }]
    : candidatesFor(symbol);

  // 已驗證的組合優先，其餘依序
  const shapes = klineShape
    ? [klineShape, ...KLINE_SHAPES.filter((s) => s.key !== klineShape.key)]
    : KLINE_SHAPES;
  const hosts = klineHost ? [klineHost, ...KLINE_HOSTS.filter((h) => h !== klineHost)] : KLINE_HOSTS;

  let bestRows = [];
  let bestCode = resolved.qq;

  // 取「第一個能回傳資料」的代碼 + 端點 + 主機組合即可。
  // 不可用「筆數門檻」提前跳出：美股缺少交易所後綴時上游仍會回 2 筆邊界資料，
  // 若以筆數判斷會誤把殘缺資料當成結果。
  outer:
  for (const c of cands) {
    for (const shape of shapes) {
      const param = encodeURIComponent(shape.param(c.qq, period, lmt));
      for (const host of hosts) {
        let data;
        try {
          data = await getJSON(`${host}${shape.path}?param=${param}`, 8000);
        } catch {
          continue;   // 該端點不可用，換下一個
        }
        const d = data?.data?.[c.qq];
        if (!d) continue;
        const rows = extractRows(d, period);
        // 筆數過少視為該代碼不正確（美股缺後綴的情況），繼續找下一組
        if (rows.length < 5 && cands.length > 1) continue;
        if (rows.length) {
          bestRows = rows;
          bestCode = c.qq;
          klineShape = shape;   // 記住有效端點形狀
          klineHost = host;     // 記住有效主機
          break outer;
        }
      }
    }
  }

  if (!bestRows.length) {
    const err = new Error('查無此標的的行情資料');
    err.code = 'NOT_FOUND';
    err.notFound = true;
    throw err;
  }

  const candles = [];
  for (const row of bestRows) {
    // 格式：date, open, close, high, low, volume
    const [date, o, c, h, l, v] = row;
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

  const isHK = /^hk/i.test(bestCode);
  const appSymbol = toAppSymbol(bestCode, { fullCode: resolved.quote?.fullCode });
  const payload = {
    meta: {
      symbol: appSymbol,
      longName: resolved.quote?.englishName || resolved.quote?.name || appSymbol,
      shortName: resolved.quote?.name || appSymbol,
      currency: resolved.quote?.currency || (isHK ? 'HKD' : 'USD'),
      exchangeName: isHK ? 'HKEX' : '',
      regularMarketPrice: candles.length ? candles[candles.length - 1].c : null,
      exchangeTimezoneName: isHK ? 'Asia/Hong_Kong' : 'America/New_York',
      fromTencent: true,
    },
    candles,
  };
  cacheSet(key, payload);
  return payload;
}

/* ==================== 即時報價 ==================== */

async function quote(symbol) {
  const resolved = await resolveCode(symbol);
  const q = resolved.quote;
  if (!q || q.price == null) {
    const err = new Error('查無此標的的即時報價');
    err.code = 'NOT_FOUND';
    err.notFound = true;
    throw err;
  }
  const isHK = /^hk/i.test(resolved.qq);
  return {
    symbol: toAppSymbol(resolved.qq, q),
    name: q.englishName || q.name || q.fullCode,
    shortName: q.name || q.fullCode,
    currency: q.currency || (isHK ? 'HKD' : 'USD'),
    exchange: isHK ? 'HKEX' : (q.exchangeSuffix === 'N' ? 'NYSE' : q.exchangeSuffix === 'A' ? 'AMEX' : 'NASDAQ'),
    market: isHK ? 'HK' : 'US',
    price: q.price,
    previousClose: q.previousClose,
    changePercent: q.changePercent,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    volume: q.volume,
    marketTime: parseQqTime(q.time),
    timezone: isHK ? 'Asia/Hong_Kong' : 'America/New_York',
    fromTencent: true,
  };
}

/**
 * 取 K 線並附帶復權資訊（供 FP 使用，介面與 yahoo.chartWithAdj 一致）。
 *
 * **重要：騰訊不提供復權價。**
 * 實測（規格 §0.5）：`qfq` / `hfq` 參數被上游靜默忽略，回傳的鍵名
 * 永遠是 `day`，從未出現 `qfqday`。跨拆股日的誤差達 10–20 倍
 * （NVDA 1:10、GOOGL 1:20、AMZN 1:20 皆實測驗證）。
 *
 * 因此本函式**不假裝**能提供復權資料：adjClose 一律為 null，
 * adj 明確標為 'none'。由 lib/adjust.js 據此拒絕進入 FP
 * （規格 §4.1 FP-2-R1：「寧可沒有預測，也不要錯的預測」）。
 *
 * 這裡刻意仍回傳 candles，讓上層可以計算 ATR 等不涉復權的輔助指標，
 * 但 predict() 會因 adj='none' 直接回 status='adj_unavailable'。
 *
 * @param {string} symbol
 * @param {string} range
 * @param {string} interval
 * @returns {Promise<Object>} {candles, adjClose:null, adj:'none', meta, source, bars}
 */
async function chartWithAdj(symbol, range = '10y', interval = '1d') {
  const payload = await chart(symbol, range, interval);
  return {
    candles: payload.candles,
    adjClose: null,
    adj: 'none',             // 明確標記：未復權，不得進入 FP
    meta: payload.meta,
    source: 'tencent',
    bars: payload.candles.length,
  };
}

module.exports = { search, chart, chartWithAdj, quote, rawQuotes, parseQuoteLine, toAppSymbol, candidatesFor, resolveCode };
