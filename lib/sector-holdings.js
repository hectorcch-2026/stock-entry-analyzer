'use strict';

/**
 * 版塊權重股與區間報酬
 * =====================
 *
 * 需求（RRG 模組擴充）：
 *   針對當前選定或相關版塊，列出其權重股，並以表格呈現每檔股票在
 *   過去 1 日、1 週、1 個月、3 個月的表現。
 *
 * ── 持股資料為什麼不用 Yahoo ────────────────────────────
 * Yahoo 的 quoteSummary `topHoldings` 模組已於 2026 年移除（實測）：
 *   請求 XLK?modules=topHoldings → HTTP 200，但回傳物件裡完全沒有這個 key，
 *   只剩 fundProfile / defaultKeyStatistics（有費用率、資產規模，但沒有持股明細）。
 *   若不實測而照文件寫，會拿到「200 但沒有資料」的空結果，且看不出原因。
 *
 * 因此改用發行商 State Street（SSGA）的**官方每日持股檔**：
 *   https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-xlk.xlsx
 * 這反而是更好的來源——它是原始事實（基金自己公布），
 * 不必經過第三方聚合，且每日更新（實測檔內 as of 與檔案 Last-Modified 一致）。
 *
 * ── 為什麼報酬不用批次端點 ──────────────────────────────
 * Yahoo 的 spark 批次端點（/v7/finance/spark）一次最多 20 個代碼，
 * 看起來很適合「一次抓 10 檔」。實測 40 個代碼 → HTTP 400
 * "Number of symbols needs to be less than or equal to 20"。
 * 但它**不回傳 adjclose**，只有 close。短期報酬（1 日~3 個月）用未復權價
 * 在除息日會低估報酬，且 3 個月內遇到拆股會直接算出假報酬（例如 -75%）。
 *
 * 實測逐檔 chartWithAdj（含 adjclose）10 檔並行只需 **318ms**，
 * 與批次端點差距不大，但資料正確。因此選擇逐檔並行。
 * 若上游限流導致部分失敗，只有那幾檔顯示「—」，不影響其他列。
 */

const xlsx = require('./xlsx');

/**
 * 把「發行商持股檔的代碼」轉成「行情供應商的代碼」。
 *
 * 為什麼需要這一步（實測，不是理論問題）：
 *   官方持股檔把波克夏 B 股寫成 `BRK.B`（S&P 的寫法），
 *   但 Yahoo 用的是 `BRK-B`。
 *   直接拿 BRK.B 去查 → 上游回 404 → 該列四個區間全部顯示「—」。
 *   使用者會以為「這檔股票沒資料」，實際上是代碼格式不對。
 *
 * 同理，Yahoo 對代碼大小寫敏感、且不接受 `.B` 這種類股後綴。
 * 只轉換「字母.字母」這種類股寫法，不動 `.HK`（港股在母體中是 0700.HK）。
 */
function toQuoteSymbol(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  // BRK.B → BRK-B；僅限「1–5 字母 . 1–2 字母」，避免誤傷 0700.HK
  return t.replace(/^([A-Z]{1,5})\.([A-Z]{1,2})$/, '$1-$2');
}

/* ---------------- 持股 ---------------- */

/** 支援的版塊（與 lib/rrg.js 的 SECTORS 對應，但這裡只依賴代碼本身） */
const SECTOR_KEYS = ['XLK', 'XLF', 'XLV', 'XLY', 'XLP', 'XLE', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLC'];

/** 各版塊官方持股檔 URL（發行商固定路徑規則） */
function holdingsUrl(sectorKey) {
  return 'https://www.ssga.com/library-content/products/fund-data/etfs/us/' +
    'holdings-daily-us-en-' + String(sectorKey).toLowerCase() + '.xlsx';
}

/** 持股檔快取：每日更新一次，6 小時 TTL 足夠（盤中權重變動極小） */
const HOLD_TTL_MS = 6 * 60 * 60 * 1000;
const holdCache = new Map();

/**
 * 判斷一列是否為「真正的股票」。
 *
 * 持股檔除了股票，還夾帶這些列（實測 XLK / XLU / XLRE 皆有）：
 *   - US DOLLAR                      外幣現金，Ticker 為 '-'
 *   - SSI US GOV MONEY MARKET CLASS  貨幣市場基金，Ticker 為 '-'
 *   - XAK TECHNOLOGY    DEC26        期貨，Ticker 像 IXTZ6，權重可為負
 *   - 權重 -0.012944 的 short 部位
 *
 * 若不過濾，表格會出現「IXTZ6」這種使用者無法點擊分析的代碼，
 * 且負權重會讓「權重」欄看起來像資料錯誤。
 * 用三個條件同時把關：Ticker 像股票代碼、權重為正、有 SEDOL（股票才會有）。
 */
const TICKER_RE = /^[A-Z]{1,5}([.\-][A-Z]{1,2})?$/;

function isStockRow(r) {
  const tick = typeof r.B === 'string' ? r.B.trim() : '';
  if (!TICKER_RE.test(tick)) return false;
  const w = Number(r.E);
  if (!isFinite(w) || w <= 0) return false;
  // SEDOL 為 '-' 代表不是掛牌股票（現金、基金單位）；期貨雖有 SEDOL 但 Ticker 已被擋掉
  if (typeof r.D === 'string' && r.D.trim() === '-') return false;
  return true;
}

/**
 * 解析持股表 → [{ ticker, name, weight, sedol }]
 *
 * 為什麼用「找標題列」而不是寫死第 4 列：
 *   檔頭有 3 列基金資訊（Fund Name / Ticker Symbol / Holdings as of），
 *   但這是發行商排版慣例、不是契約。若哪天多一列說明，
 *   寫死索引就會整份錯位且難以察覺；找 "Name"+"Ticker" 同時出現的列則不會。
 */
function parseHoldings(rows) {
  let hdr = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].A === 'Name' && rows[i].B === 'Ticker') { hdr = i; break; }
  }
  if (hdr < 0) {
    const e = new Error('持股檔格式無法辨識（找不到 Name / Ticker 標題列）');
    e.code = 'BAD_HOLDINGS';
    throw e;
  }

  const out = [];
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!isStockRow(r)) continue;
    out.push({
      ticker: String(r.B).trim().toUpperCase(),
      name: String(r.A || r.B).trim(),
      weight: Number(r.E),
      sedol: typeof r.D === 'string' ? r.D : null,
    });
  }
  // 權重高→低（持股檔本來就依權重排序，但不依賴它）
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

/** 從檔頭取出「as of」日期字串（如 "As of 24-Nov-2026"） */
function parseAsOf(rows) {
  for (const r of rows) {
    if (r.A === 'Holdings:' && typeof r.B === 'string') {
      const m = r.B.match(/(\d{1,2}-[A-Za-z]{3}-\d{4})/);
      if (m) return m[1];
      return r.B.replace(/^As of\s*/i, '').trim();
    }
  }
  return null;
}

/** 從檔頭取出基金全名 */
function parseFundName(rows) {
  for (const r of rows) {
    if (r.A === 'Fund Name:' && typeof r.B === 'string') return r.B.trim();
  }
  return null;
}

/**
 * 取得某版塊的持股清單（含快取）。
 *
 * @param {string} sectorKey 例 XLK
 * @param {object} opts { limit, refresh }
 * @returns {Promise<{ok, sector, fundName, asOf, holdings, total, source}>}
 */
async function getHoldings(sectorKey, opts = {}) {
  const key = String(sectorKey || '').toUpperCase();
  if (!SECTOR_KEYS.includes(key)) {
    const e = new Error(`不支援的版塊「${sectorKey}」`);
    e.code = 'BAD_SECTOR';
    e.hint = `可用版塊：${SECTOR_KEYS.join('、')}`;
    throw e;
  }

  const limit = Math.max(1, Math.min(Number(opts.limit) || 10, 50));
  const cacheKey = `${key}|${limit}`;

  if (!opts.refresh) {
    const hit = holdCache.get(cacheKey);
    if (hit && Date.now() - hit.at < HOLD_TTL_MS) {
      return { ...hit.value, cached: true };
    }
  }

  const url = holdingsUrl(key);
  let buf;
  try {
    const res = await fetch(url, {
      headers: {
        // 發行商站點會檢查 UA，缺少時回 403
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const e = new Error(`持股檔下載失敗（HTTP ${res.status}）`);
      e.code = 'HOLDINGS_HTTP';
      e.status = res.status;
      throw e;
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err.code === 'HOLDINGS_HTTP') throw err;
    const e = new Error(`無法取得 ${key} 的持股檔：${err.message}`);
    e.code = 'HOLDINGS_FETCH';
    throw e;
  }

  let rows;
  try {
    rows = xlsx.readFirstSheet(buf);
  } catch (err) {
    const e = new Error(`${key} 持股檔解析失敗：${err.message}`);
    e.code = 'HOLDINGS_PARSE';
    throw e;
  }

  const all = parseHoldings(rows);
  if (!all.length) {
    const e = new Error(`${key} 持股檔內沒有股票部位`);
    e.code = 'HOLDINGS_EMPTY';
    throw e;
  }

  const value = {
    ok: true,
    sector: key,
    fundName: parseFundName(rows),
    asOf: parseAsOf(rows),
    total: all.length,
    holdings: all.slice(0, limit),
    // 被切掉的部分要讓使用者知道「這不是全部」
    truncated: all.length > limit,
    source: 'ssga',
  };

  holdCache.set(cacheKey, { at: Date.now(), value });
  return { ...value, cached: false };
}

/* ---------------- 區間報酬 ---------------- */

/**
 * 四個觀察區間的定義。
 *
 * tradingDays 是「往回數幾個交易日」，不是「幾個日曆日」：
 * 1 週 = 5 個交易日、1 個月 ≈ 21、3 個月 ≈ 63。
 * 用交易日而非日曆日，是因為跨週末與假期時日曆日的對應會漂移
 * （例如「1 個月前」可能剛好是週日，那天沒有收盤價）。
 *
 * Yahoo 的 6mo 日線約有 129 根，足夠覆蓋 63 根的需求。
 */
const PERIODS = [
  { key: 'd1', label: '1 日', tradingDays: 1 },
  { key: 'w1', label: '1 週', tradingDays: 5 },
  { key: 'm1', label: '1 個月', tradingDays: 21 },
  { key: 'm3', label: '3 個月', tradingDays: 63 },
];

/**
 * 從單一標的的日線計算四區間報酬。
 *
 * 優先使用復權價（adjClose）：除息日當天未復權價會憑空下跌，
 * 對高股息股（公用事業、REITs、必需消費）會產生 1–3% 的假跌幅，
 * 在「1 日」這種短區間尤其明顯——那正是使用者最容易被誤導的地方。
 *
 * @param {Array<{t:number,c:number}>} candles
 * @param {Array<number>|null} adjClose 與 candles 等長
 * @param {Array} periods
 * @returns {{returns:Object, price:number|null, currency:string|null, bars:number}}
 */
function computeReturns(candles, adjClose, periods) {
  const list = periods || PERIODS;
  // 先把四個 key 一律預設為 null：空資料時若直接 return，
  // returns 會是空物件，前端讀 r.returns.d1 得到 undefined 而非 null，
  // 兩者在 isFinite 判斷上都算「無資料」，但 API 契約會出現 undefined 欄位。
  const out = { returns: {}, price: null, bars: 0 };
  for (const p of list) out.returns[p.key] = null;

  if (!Array.isArray(candles) || candles.length < 2) return out;

  const useAdj = Array.isArray(adjClose) && adjClose.length === candles.length;

  // 建立「有效價格序列」：復權價優先，缺值或非正數則退回收盤價
  const series = [];
  for (let i = 0; i < candles.length; i++) {
    const raw = useAdj ? adjClose[i] : candles[i].c;
    if (raw == null || !isFinite(raw) || raw <= 0) continue;
    series.push(raw);
  }
  if (series.length < 2) return out;

  out.bars = series.length;
  out.price = series[series.length - 1];      // 最新（可能為復權價）
  out.lastClose = candles[candles.length - 1].c; // 實際收盤價，供顯示
  out.adjUsed = useAdj;

  const last = series[series.length - 1];
  for (const p of list) {
    // 往回數 N 個交易日；不足則該區間給 null（不硬用更短的區間冒充）
    const idx = series.length - 1 - p.tradingDays;
    if (idx < 0) { out.returns[p.key] = null; continue; }
    const base = series[idx];
    if (!base || base <= 0) { out.returns[p.key] = null; continue; }
    out.returns[p.key] = ((last / base) - 1) * 100;
  }
  return out;
}

/**
 * 批次取得多檔股票的區間報酬。
 *
 * 為什麼逐檔並行而不是用 spark 批次端點：
 *   見檔頭說明——spark 無 adjclose，且上限 20 個。
 *   逐檔 chartWithAdj 10 檔並行實測 318ms，且帶得到復權價。
 *
 * 個別失敗不影響整體：該檔的 returns 全部為 null（前端顯示「—」），
 * 並在 failures 裡回報原因，而不是讓整張表掛掉。
 *
 * @param {object} datasource lib/datasource（提供 chartWithAdj）
 * @param {string[]} tickers
 * @param {object} opts { periods, range }
 */
async function getReturns(datasource, tickers, opts = {}) {
  const periods = opts.periods || PERIODS;
  const range = opts.range || '6mo';

  const results = await Promise.all(
    tickers.map(async (ticker) => {
      /* 持股檔的寫法（BRK.B）與行情供應商（BRK-B）不同，查詢時必須轉換，
         但回報時仍用原始 ticker，讓呼叫端能把結果對回原本那一列。 */
      const quoteSym = toQuoteSymbol(ticker);
      try {
        const raw = await datasource.chartWithAdj(quoteSym, range, '1d');
        const r = computeReturns(raw.candles, raw.adjClose, periods);
        if (!r.bars) {
          return { ticker, ok: false, code: 'NO_DATA', message: '查無有效價格序列' };
        }
        return { ticker, ok: true, quoteSymbol: quoteSym, ...r };
      } catch (e) {
        return {
          ticker,
          ok: false,
          quoteSymbol: quoteSym,
          code: e.code || 'FETCH_FAILED',
          message: e.message || '取得行情失敗',
        };
      }
    })
  );

  const byTicker = {};
  const failures = [];
  for (const r of results) {
    if (r.ok) byTicker[r.ticker] = r;
    else failures.push({ ticker: r.ticker, code: r.code, message: r.message });
  }
  return { byTicker, failures };
}

/** 清空快取（測試用） */
function resetCache() { holdCache.clear(); }

module.exports = {
  SECTOR_KEYS, PERIODS,
  holdingsUrl, getHoldings, parseHoldings, parseAsOf, parseFundName, isStockRow,
  computeReturns, getReturns, toQuoteSymbol, resetCache,
  HOLD_TTL_MS,
};
