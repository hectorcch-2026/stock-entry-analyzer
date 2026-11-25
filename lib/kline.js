'use strict';

/**
 * K 線時間區間取數
 *
 * 為什麼需要獨立一支：
 *   analyzer.analyze() 只回傳最後 250 根日線（lib/analyzer.js:buildSeries），
 *   這是為了控制 /api/analyze 的回應大小（該端點還帶 4 個進階模組與回測明細）。
 *   但「時間區間切換」本質上需要更長的歷史，若直接放大 analyze 的切片，
 *   會讓既有端點的回應膨脹 10 倍，且會改變既有前端與測試對 250 根的假設。
 *
 *   因此改為獨立端點：預設仍是 250 根（與既有行為逐位元相同），
 *   只有使用者主動切換區間時才另外取數。
 *
 * 復權：這裡刻意使用 datasource.chart()（未復權），與 analyzer 的 2y 管線一致。
 *   圖上的買區／支撐壓力／均線都以未復權價計算，若這裡改用復權價，
 *   同一張圖會出現「K 線是復權價、水平線是未復權價」的錯位。
 *   需要復權價的區間預測（FP）另有 chartWithAdj 管線，兩者不混用。
 */

const RANGES = {
  '3m': { yahoo: '3mo', label: '3 個月', approxBars: 63 },
  '6m': { yahoo: '6mo', label: '6 個月', approxBars: 126 },
  '1y': { yahoo: '1y', label: '1 年', approxBars: 250 },
  '2y': { yahoo: '2y', label: '2 年', approxBars: 501 },
  '5y': { yahoo: '5y', label: '5 年', approxBars: 1255 },
};

const DEFAULT_RANGE = '1y';

/** 預設切片根數：與 analyzer.buildSeries 的 250 完全一致，確保預設畫面不變 */
const DEFAULT_BARS = 250;

/** 快取 TTL。上游本身有 60 秒快取，這裡再保一層避免同時多個分頁重複打 */
const TTL_MS = 60 * 1000;
const cache = new Map();

function normalizeRange(raw) {
  const r = String(raw || '').trim().toLowerCase();
  if (!r || r === 'default' || r === '250') return { ok: true, key: null };
  if (RANGES[r]) return { ok: true, key: r };
  return {
    ok: false,
    code: 'BAD_RANGE',
    message: `不支援的時間區間「${raw}」`,
    hint: `可用值：${Object.keys(RANGES).join('、')}`,
  };
}

/** 只保留繪圖需要的欄位，並把 t 轉成毫秒數（前端 new Date(t) 直接可用） */
function slim(c) {
  return { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
}

/**
 * 取得指定區間的日線。
 *
 * @param {object} datasource lib/datasource
 * @param {string} symbol
 * @param {string} rangeKey  '3m' | '6m' | '1y' | '2y' | '5y' 或空（= 預設 250 根）
 * @param {number} fallbackPrice 當上游回傳空序列時，至少讓前端知道現價（可選）
 */
async function getSeries(datasource, symbol, rangeKey, fallbackPrice) {
  const norm = normalizeRange(rangeKey);
  if (!norm.ok) return norm;

  const key = norm.key;
  const meta = key ? RANGES[key] : null;
  const yahooRange = meta ? meta.yahoo : '2y';
  const bars = meta ? meta.approxBars : DEFAULT_BARS;

  const cacheKey = `${symbol}:${yahooRange}:${bars}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { ok: true, ...hit.value, cached: true };
  }

  const raw = await datasource.chart(symbol, yahooRange, '1d');
  const candles = (raw && raw.candles) || [];
  if (!candles.length) {
    return {
      ok: false,
      code: 'NO_DATA',
      message: `查無 ${symbol} 在此區間的日線資料`,
      hint: '此標的可能新上市或該區間無交易紀錄，請改用其他時間區間',
    };
  }

  // 統一切到「最後 N 根」，確保不同區間的最後一根都是同一天（今日），
  // 否則切換區間時最後一根會跳動，使用者會誤以為資料更新了。
  const slice = candles.length > bars ? candles.slice(-bars) : candles;
  const lastClose = slice.length ? slice[slice.length - 1].c : null;
  const value = {
    symbol,
    range: key || 'default',
    rangeLabel: meta ? meta.label : `${DEFAULT_BARS} 根日線`,
    bars: slice.length,
    requestedBars: bars,
    // shorter 表示上游歷史本身不足（新上市），不是錯誤，前端據此顯示提示
    shorter: candles.length < bars,
    source: datasource.lastSource || 'yahoo',
    candles: slice.map(slim),
    first: slice.length ? slice[0].t : null,
    last: slice.length ? slice[slice.length - 1].t : null,
    // 注意：不能用 isFinite(fallbackPrice) 判斷——isFinite(null) === true，
    // 會把「沒傳」誤判成「傳了 0」。必須明確檢查型別。
    price: typeof fallbackPrice === 'number' && isFinite(fallbackPrice) ? fallbackPrice : lastClose,
    ranges: Object.keys(RANGES).map((k) => ({ key: k, label: RANGES[k].label })),
  };

  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
    for (const [k] of oldest) cache.delete(k);
  }
  return { ok: true, ...value, cached: false };
}

module.exports = { RANGES, DEFAULT_RANGE, DEFAULT_BARS, normalizeRange, getSeries };
