'use strict';

/**
 * Treemap 資料取得層
 * ===================
 *
 * 職責：把「持股 + 市值 + 四週期報酬」三份資料抓齊並組裝，
 * 計算全部交給 lib/treemap.js（純函式，可單獨測試）。
 *
 * ── 為什麼市值獨立於 quote() ─────────────────────────────
 * lib/yahoo.js 的 quote() 走 /v8/chart 的 meta，那條路徑**沒有 marketCap**
 * （實測 AAPL 的 meta 只有 regularMarketPrice 等即時欄位）。
 * 市值只出現在 /v7/finance/quote 的 quoteResponse 裡。
 * 因此另闢一條批次路徑，一次 50 檔（實測 50 檔回 49～50 筆，HTTP 200）。
 *
 * ── 為什麼報酬逐檔抓而不用 spark ─────────────────────────
 * spark 一次可帶 20 檔，但**沒有 adjclose**。年線若不復權，
 * 實測 MO 低估 8.84pp、VZ 低估 7.75pp、PEP 由 -1.49% 翻成 +2.50%
 * （顏色由綠翻紅，也就是畫錯方向）。
 * 逐檔 chartWithAdj 165 檔全部並行實測 2.35 秒，快取後 1ms，成本可接受。
 *
 * ── spark 的另一個陷阱：超量靜默截斷 ─────────────────────
 * 實測 spark 傳 21 檔 → HTTP **200**，但只回 20 筆，沒有任何錯誤訊息。
 * 這種「看起來成功卻少資料」比報錯更危險，也是不用它的另一個理由。
 */

const treemap = require('./treemap');
const sectorHoldings = require('./sector-holdings');

/* 市值快取：盤中市值只隨價格變動，5 分鐘足夠 */
const CAP_TTL_MS = 5 * 60 * 1000;
const capCache = new Map();     // symbol → { at, marketCap, name }

/* 報酬快取：與 yahoo 的 chartWithAdj 快取（60 秒）互補，
   這裡負責「已計算好的四週期結果」，避免重算 165 次序列掃描 */
const RET_TTL_MS = 2 * 60 * 1000;
const retCache = new Map();     // symbol → { at, value }

/** 批次報價的分批大小。實測 50 檔一批回 49～50 筆、約 100ms */
const CAP_BATCH = 50;

/** 同時進行的歷史抓取上限。實測 165 檔全開可行，但留餘裕給其他請求 */
const RET_CONCURRENCY = 12;

/**
 * 簡易併發池。
 *
 * 為什麼不單純 Promise.all 全部：
 *   165 個並行請求在 Yahoo 端可能觸發 429（實測本機沒觸發，
 *   但雲端 IP 較容易被限流）。限制在 12 個同時進行，
 *   總耗時仍在 2～3 秒內，且大幅降低被限流的機率。
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 取得市值（批次）。
 *
 * 失敗策略：市值抓不到時回傳空物件，呼叫端會把該檔標為 noCap
 * 並用最小面積呈現，而不是讓整張圖掛掉。
 * 市值屬「錦上添花」——沒有它圖還是能畫（用權重當面積），
 * 但會偏離需求（需求要市值），所以 API 會明確回報 noCap 的檔數。
 *
 * @param {Array<string>} symbols 已正規化的代碼
 * @param {object} opts { refresh }
 * @returns {Promise<{caps:Object, failures:Array, cached:number}>}
 */
async function getCaps(symbols, opts = {}) {
  const uniq = [...new Set(symbols)].filter(Boolean);
  const caps = {};
  const failures = [];
  let cachedCount = 0;
  const need = [];

  const now = Date.now();
  for (const s of uniq) {
    const hit = capCache.get(s);
    if (!opts.refresh && hit && now - hit.at < CAP_TTL_MS) {
      caps[s] = { marketCap: hit.marketCap, name: hit.name };
      cachedCount++;
    } else {
      need.push(s);
    }
  }

  for (let i = 0; i < need.length; i += CAP_BATCH) {
    const batch = need.slice(i, i + CAP_BATCH);
    try {
      const arr = await fetchQuoteBatch(batch);
      for (const q of arr) {
        const mc = isFinite(q.marketCap) && q.marketCap > 0 ? q.marketCap : null;
        caps[q.symbol] = { marketCap: mc, name: q.shortName || q.longName || q.symbol };
        if (mc) {
          capCache.set(q.symbol, { at: Date.now(), marketCap: mc, name: caps[q.symbol].name });
        }
      }
      // 上游沒回傳的代碼（下市、代碼變更）
      const got = new Set(arr.map((q) => q.symbol));
      for (const s of batch) {
        if (!got.has(s)) failures.push({ symbol: s, code: 'NO_QUOTE', message: '上游未回傳此代碼' });
      }
    } catch (e) {
      for (const s of batch) {
        failures.push({ symbol: s, code: e.code || 'CAP_FAILED', message: e.message });
      }
    }
  }

  // 快取有、但上游這次沒回的，仍視為有值（已在上方填入）
  return { caps, failures, cached: cachedCount };
}

/**
 * 呼叫 /v7/finance/quote 取市值。
 *
 * 為什麼直接寫 fetch 而不用 lib/yahoo.js 的 getJSON：
 *   該函式沒有匯出，且它會自動補 crumb（這點是好的）——
 *   但為了不破壞既有模組介面（yahoo.js 只匯出 7 個函式），
 *   這裡用同一組常數自行請求，行為保持一致。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CAP_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

/* 與 lib/yahoo.js 共用的 cookie / crumb 工作階段（各自維護，
   因為該模組未匯出 getSession；重複建立一次成本僅約 200ms，且會快取 30 分鐘） */
let capSession = null;
/* 最近一次建立工作階段的診斷（給 /api/rrg/treemap/_diag 用），
   雲端拿不到 crumb 時必須看得到是哪一步失敗，否則只能瞎猜。 */
let capDiag = null;

async function getCapSession() {
  const TTL = 30 * 60 * 1000;
  if (capSession && Date.now() - capSession.at < TTL) {
    capDiag = capDiag || { reused: true };
    return capSession;
  }

  const diag = { at: Date.now(), cookie: null, crumb: null };
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
    diag.cookie = { status: r.status, setCookieCount: list.length, len: cookie.length };
  } catch (e) {
    diag.cookie = { error: e.name + ': ' + e.message };
  }

  let crumb = '';
  if (cookie) {
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': UA, Cookie: cookie },
        signal: AbortSignal.timeout(3000),
      });
      const t = (await r.text()).trim();
      const valid = r.ok && /^[\w.\-]{4,24}$/.test(t);
      if (valid) crumb = t;
      diag.crumb = { status: r.status, len: t.length, valid, head: t.slice(0, 24) };
    } catch (e) {
      diag.crumb = { error: e.name + ': ' + e.message };
    }
  } else {
    diag.crumb = { skipped: 'no cookie' };
  }

  capDiag = diag;
  capSession = { cookie, crumb, at: Date.now() };
  return capSession;
}

/** 清空工作階段（測試用） */
function resetSession() { capSession = null; }

/**
 * 抓一批報價。
 *
 * 注意：缺 crumb 時 v7/quote 對雲端 IP 會回 401「Invalid Crumb」。
 * 因此 crumb 拿不到就直接拋錯，讓上層明確回報「市值不可用」，
 * 而不是讓 401 被當成「這些股票都沒有市值」。
 */
async function fetchQuoteBatch(symbols) {
  const s = await getCapSession();
  if (!s.crumb) {
    const e = new Error('無法取得 Yahoo 工作階段（crumb），市值暫不可用');
    e.code = 'CAP_NO_SESSION';
    throw e;
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const host = CAP_HOSTS[attempt % CAP_HOSTS.length];
    try {
      const url = host + '/v7/finance/quote?symbols=' +
        symbols.map(encodeURIComponent).join(',') +
        '&crumb=' + encodeURIComponent(s.crumb);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Cookie: s.cookie, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) {
        // crumb 過期：清掉工作階段，下次重建
        resetSession();
        const e = new Error(`市值端點拒絕（HTTP ${res.status}）`);
        e.code = 'CAP_AUTH';
        throw Object.assign(e, { noRetry: true });
      }
      if (!res.ok) {
        const e = new Error(`市值端點回應 ${res.status}`);
        e.status = res.status;
        e.code = 'CAP_HTTP';
        throw e;
      }
      const j = await res.json();
      const arr = j && j.quoteResponse && j.quoteResponse.result;
      if (!Array.isArray(arr)) {
        const e = new Error('市值端點回應格式異常');
        e.code = 'CAP_BAD_SHAPE';
        throw e;
      }
      return arr;
    } catch (e) {
      lastErr = e;
      if (e.noRetry) throw e;
      if (attempt < 1) await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

/**
 * 取得多檔的四週期報酬。
 *
 * 個別失敗不影響整體：該檔四個週期都是 null（前端畫灰格），
 * 並在 failures 中回報，而不是讓整張圖失敗。
 */
async function getReturns(datasource, symbols, opts = {}) {
  const uniq = [...new Set(symbols)].filter(Boolean);
  const out = {};
  const failures = [];
  let cachedCount = 0;
  const need = [];

  const now = Date.now();
  for (const s of uniq) {
    const hit = retCache.get(s);
    if (!opts.refresh && hit && now - hit.at < RET_TTL_MS) {
      out[s] = hit.value;
      cachedCount++;
    } else {
      need.push(s);
    }
  }

  const results = await mapLimit(need, RET_CONCURRENCY, async (sym) => {
    try {
      /* range 用 2y 而不是 1y：
         年線需要 251 個「回檔點」，1y 區間只有 251 根，
         idx = len-1-251 = -1 會落在陣列外而全部變 null。
         實測 2y 每檔有 501 根，110 檔無一缺漏。 */
      const raw = await datasource.chartWithAdj(sym, '2y', '1d');
      const r = treemap.computeReturns(raw.candles, raw.adjClose);
      if (!r.bars) {
        return { symbol: sym, ok: false, code: 'NO_DATA', message: '查無有效價格序列' };
      }
      return { symbol: sym, ok: true, value: r };
    } catch (e) {
      return {
        symbol: sym, ok: false,
        code: e.code || 'RET_FAILED',
        message: e.message || '取得行情失敗',
      };
    }
  });

  for (const r of results) {
    if (r.ok) {
      out[r.symbol] = r.value;
      retCache.set(r.symbol, { at: Date.now(), value: r.value });
    } else {
      failures.push({ symbol: r.symbol, code: r.code, message: r.message });
    }
  }

  return { returns: out, failures, cached: cachedCount };
}

/**
 * 主入口：組出完整 treemap。
 *
 * @param {object} datasource lib/datasource
 * @param {object} opts { sectors, perSector, period, refresh, sectorMeta }
 * @returns {Promise<object>}
 */
async function getTreemap(datasource, opts = {}) {
  const sectors = Array.isArray(opts.sectors) && opts.sectors.length
    ? opts.sectors
    : sectorHoldings.SECTOR_KEYS;
  const perSector = Math.max(
    1,
    Math.min(Number(opts.perSector) || treemap.DEFAULT_PER_SECTOR, treemap.MAX_PER_SECTOR)
  );
  const period = treemap.PERIOD_KEYS.includes(opts.period) ? opts.period : 'm1';

  /* 1) 持股：11 個版塊並行。個別失敗只影響該版塊（會進 failures） */
  const holdResults = await Promise.all(
    sectors.map(async (k) => {
      try {
        const h = await sectorHoldings.getHoldings(k, {
          // 取 perSector 檔；但 getHoldings 的 limit 上限為 50
          limit: Math.min(perSector, 50),
          refresh: !!opts.refresh,
        });
        return { key: k, ok: true, value: h };
      } catch (e) {
        return { key: k, ok: false, code: e.code || 'HOLDINGS_FAILED', message: e.message };
      }
    })
  );

  const holdingsBySector = {};
  const holdFailures = [];
  for (const r of holdResults) {
    if (r.ok) {
      holdingsBySector[r.key] = {
        holdings: r.value.holdings.map((x) => ({
          ...x,
          // 持股檔用 BRK.B、行情端點要 BRK-B，這裡一次轉好供後續使用
          quoteSymbol: sectorHoldings.toQuoteSymbol(x.ticker),
        })),
        fundName: r.value.fundName,
        asOf: r.value.asOf,
        total: r.value.total,
      };
    } else {
      holdFailures.push({ sector: r.key, code: r.code, message: r.message });
    }
  }

  const activeSectors = sectors.filter((k) => holdingsBySector[k]);

  /* 2) 收集所有需要的代碼（去重） */
  const symbols = [];
  for (const k of activeSectors) {
    for (const h of holdingsBySector[k].holdings) symbols.push(h.quoteSymbol);
  }
  const uniqSyms = [...new Set(symbols)];

  /* 3) 市值與報酬並行（兩者互不依賴，省一半等待時間） */
  const [capRes, retRes] = await Promise.all([
    getCaps(uniqSyms, { refresh: !!opts.refresh }),
    getReturns(datasource, uniqSyms, { refresh: !!opts.refresh }),
  ]);

  /* 4) 組裝 */
  const data = treemap.build({
    sectors: activeSectors,
    perSector,
    holdingsBySector,
    caps: capRes.caps,
    returns: retRes.returns,
    period,
    sectorMeta: opts.sectorMeta || null,
  });

  /* 5) 把資料層的失敗合併進來（分類明確，前端可分別呈現） */
  data.failures = [
    ...holdFailures,
    ...capRes.failures.map((f) => ({ ...f, stage: 'marketCap' })),
    ...retRes.failures.map((f) => ({ ...f, stage: 'returns' })),
    ...data.failures.map((f) => ({ ...f, stage: 'build' })),
  ];

  /* 6) 健全度統計：讓前端能判斷「這是資料稀疏還是真的壞了」 */
  const noCapCount = data.groups.reduce(
    (n, g) => n + g.leaves.filter((l) => l.noCap).length, 0);
  const noDataCount = data.groups.reduce(
    (n, g) => n + g.leaves.filter((l) => l.noData).length, 0);
  data.health = {
    requestedSectors: sectors.length,
    okSectors: data.groups.length,
    leaves: data.totals.leaves,
    noCapCount,
    noDataCount,
    capFailures: capRes.failures.length,
    returnFailures: retRes.failures.length,
    holdingsFailures: holdFailures.length,
    cappedCacheHits: capRes.cached,
    returnsCacheHits: retRes.cached,
  };
  // 資料出處：持股來自發行商官方檔，市值與行情來自 Yahoo
  data.source = { holdings: 'ssga', marketCap: 'yahoo', returns: 'yahoo' };
  data.ok = true;

  return data;
}

/** 清空所有快取（測試用） */
function resetCache() {
  capCache.clear();
  retCache.clear();
  capSession = null;
}

module.exports = {
  getTreemap, getCaps, getReturns, fetchQuoteBatch, mapLimit,
  resetCache, resetSession, getCapSession,
  getCapDiag: () => capDiag,
  CAP_TTL_MS, RET_TTL_MS, CAP_BATCH, RET_CONCURRENCY,
};
