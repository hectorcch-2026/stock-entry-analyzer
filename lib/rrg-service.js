'use strict';

/**
 * RRG 資料取得與快取
 * ===================
 *
 * 計算本身在 lib/rrg.js（純函式）。這裡只負責「把資料抓回來、對齊、算好、快取」。
 *
 * ── 為什麼要獨立一層而且必須快取 ──────────────────────────
 * 一次完整的 RRG 需要 **16 條序列 × 10 年日線**（11 版塊 + 5 個可能的基準）。
 * 即使上游有 60 秒快取，未快取時仍要建立 16 個 HTTPS 連線、傳輸約 3–5 MB。
 * 使用者在 RRG 頁切換「尾跡 5 → 8」時完全不該重抓 —— 尾跡長度只影響
 * 切哪幾個點，不影響已算好的序列。
 *
 * 因此快取鍵只包含「真正影響計算」的三個維度：
 *   timeframe + benchmark + period
 * 尾跡長度、觀察區間、版塊子集都是**在已算好的結果上切片**，不進快取鍵。
 * 這樣切換 UI 控制項幾乎是零延遲。
 *
 * ── 為什麼快取整個對齊矩陣而不是最終輸出 ──────────────────
 * 對齊矩陣（dates + rows）是計算成本最高的部分（16 條序列取數 + 交集）。
 * 從它出發算 ratio/momentum 只需毫秒級。若快取最終輸出，換一個尾跡長度
 * 就得重算全部，等於白快取。
 */

const rrg = require('./rrg');

/** 對齊矩陣快取。TTL 30 分鐘：日線在收盤後才變，盤中變動不影響週線／月線的結論。 */
const MATRIX_TTL_MS = 30 * 60 * 1000;
const MATRIX_MAX = 12;

const matrixCache = new Map();

function cacheKey(timeframe, benchmarkKey) {
  return `${timeframe}|${benchmarkKey}`;
}

function cacheGet(key) {
  const hit = matrixCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MATRIX_TTL_MS) {
    matrixCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  matrixCache.set(key, { at: Date.now(), value });
  if (matrixCache.size > MATRIX_MAX) {
    const oldest = [...matrixCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of oldest.slice(0, Math.ceil(MATRIX_MAX / 2))) matrixCache.delete(k);
  }
}

/**
 * 抓取單一標的的**復權**日線。
 *
 * 為什麼一定用 chartWithAdj：
 *   見 lib/rrg.js 開頭的實測數據——XLU 十年價格報酬 81%，復權報酬 149%。
 *   用未復權價會讓高股息版塊被系統性低估。
 *
 * 取不到復權價時的處理：
 *   不靜默退回未復權價（那會讓結果錯得不知不覺），而是明確標記
 *   `adjFallback: true` 並在 API 回應裡列出，讓前端顯示警示。
 *   目前實測 Yahoo 對這些 ETF 都回得出 adjclose，但來源切換到
 *   騰訊／東方財富時 adjClose 可能是 null，這條路徑必須存在。
 */
async function fetchAdjBars(datasource, symbol, yahooRange) {
  const raw = await datasource.chartWithAdj(symbol, yahooRange, '1d');
  const candles = (raw && raw.candles) || [];
  if (!candles.length) {
    const e = new Error(`查無 ${symbol} 的日線資料`);
    e.code = 'NO_DATA';
    throw e;
  }
  const adj = raw.adjClose;
  const useAdj = Array.isArray(adj) && adj.length === candles.length;
  const bars = [];
  for (let i = 0; i < candles.length; i++) {
    const v = useAdj ? adj[i] : candles[i].c;
    if (v == null || !isFinite(v) || v <= 0) continue;
    bars.push({ t: candles[i].t, c: v });
  }
  return { bars, adjUsed: useAdj, source: raw.source || 'unknown' };
}

/**
 * 建立（或取用快取的）對齊矩陣。
 *
 * 抓取策略：16 條序列**並行**抓取，但個別失敗不影響整體——
 * 只要「基準 + 至少一個版塊」成功就能出圖。
 * 失敗的標的記在 `failures` 裡回報，前端可顯示「XLC 暫時取不到資料」。
 *
 * @param {object} datasource lib/datasource
 * @param {object} opts { timeframe, benchmarkKey }
 */
async function getMatrix(datasource, opts) {
  const { timeframe, benchmarkKey } = opts;
  const tf = rrg.TIMEFRAMES[timeframe];
  if (!tf) {
    const e = new Error(`未知時間週期 ${timeframe}`);
    e.code = 'BAD_TIMEFRAME';
    throw e;
  }

  const key = cacheKey(timeframe, benchmarkKey);
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };

  // 需要抓的：基準（若在版塊清單內則只抓一次）+ 全部 11 版塊
  const sectorKeys = rrg.SECTORS.map((s) => s.key);
  const needed = [...new Set([benchmarkKey, ...sectorKeys])];

  const results = await Promise.all(
    needed.map(async (sym) => {
      try {
        const r = await fetchAdjBars(datasource, sym, tf.yahooRange);
        return { sym, ok: true, ...r };
      } catch (e) {
        return { sym, ok: false, code: e.code || 'FETCH_FAILED', message: e.message };
      }
    })
  );

  const failures = results.filter((r) => !r.ok).map((r) => ({
    symbol: r.sym, code: r.code, message: r.message,
  }));
  const good = results.filter((r) => r.ok);

  const bench = good.find((r) => r.sym === benchmarkKey);
  if (!bench) {
    return {
      ok: false,
      code: 'NO_BENCHMARK',
      message: `基準 ${benchmarkKey} 的資料取不到，無法計算相對強度`,
      hint: '請確認網路可連上行情來源，或改用其他基準指數',
      failures,
    };
  }

  // 重取樣 → 對齊
  const seriesList = good.map((r) => ({
    key: r.sym,
    bars: rrg.resample(r.bars, timeframe),
  }));
  const aligned = rrg.alignSeries(seriesList);

  const emptyTfCount = seriesList.filter((s) => !s.bars.length).length;

  const value = {
    ok: true,
    timeframe,
    benchmarkKey,
    dates: aligned.dates,
    t: aligned.t,
    rows: aligned.rows,
    failures,
    emptyTfCount,
    adjFallback: good.filter((r) => !r.adjUsed).map((r) => r.sym),
    source: bench.source,
    fetchedAt: new Date().toISOString(),
    // 對齊後才發現被砍掉的期數（各標的交易日不一致造成）
    rawPeriods: Math.max(...seriesList.map((s) => s.bars.length), 0),
    alignedPeriods: aligned.dates.length,
  };

  // 只有健康結果才快取——失敗結果若也快取，使用者重試會一直被卡住
  if (aligned.dates.length) cacheSet(key, value);
  return { ...value, cached: false };
}

/** 清空快取（測試與 /api/rrg?refresh=1 使用） */
function resetCache() { matrixCache.clear(); }

module.exports = { getMatrix, resetCache, fetchAdjBars, MATRIX_TTL_MS };
