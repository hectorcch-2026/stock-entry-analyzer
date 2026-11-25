'use strict';

/**
 * 價格復權層（Adjustment Layer）—— 供 FP（K 線預測）專用
 *
 * 為什麼需要獨立一層而不直接改 lib/yahoo.js：
 *   FP 需要「已復權」的價格序列才能算出有意義的報酬與區間；
 *   但既有分析管線（score / buyZone / backtest / levels / advancedTools）
 *   全部建立在目前未復權的 close 上，且驗收標準 AC-01 要求
 *   「FP 上線前後 probabilities 與 backtest 逐位元相同」。
 *
 *   因此本模組**只被 FP 呼叫**，不介入既有管線。
 *   既有管線的復權修復是另一個獨立議題（GAP-2），不在本次範圍。
 *
 * 復權能力判定（實測依據見 docs/K線預測與AI選股規格書_v1.1.md §0.5）：
 *   - Yahoo：回傳 indicators.adjclose，但 lib/yahoo.js 未讀取
 *   - 東方財富：fqt=1，原生前復權
 *   - 騰訊：qfq/hfq 參數無效，回傳原始價（跨拆股日誤差達 10 倍）
 */

/** 可接受的復權狀態（只有這兩種能進入 FP） */
const ACCEPTED_ADJ = new Set(['yahoo-adjclose', 'qfq-native']);

/**
 * 以 Yahoo 的 adjclose 建立復權因子序列。
 *
 * 前復權定義：最新一根因子 = 1，越往前因子越小（除以累積配息與拆股）。
 * 因此把 OHLC 乘上 factor 即得復權價；成交量反向除，保持成交金額不變。
 *
 * @param {Array} candles 原始 K 線 [{t,o,h,l,c,v}]
 * @param {Array|null} adjClose 與 candles 等長的 adjclose 陣列
 * @returns {{candles:Array, adj:string, factor:Array|null, covered:number}}
 */
function applyYahooAdj(candles, adjClose) {
  if (!Array.isArray(adjClose) || adjClose.length !== candles.length) {
    return { candles, adj: 'none', factor: null, covered: 0 };
  }

  const out = [];
  const factors = [];
  let covered = 0;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const a = adjClose[i];
    // adjclose 缺值（停牌或上游缺失）時，該根不調整，但記錄覆蓋率
    if (a == null || !isFinite(a) || a <= 0 || !isFinite(bar.c) || bar.c <= 0) {
      out.push({ ...bar });
      factors.push(null);
      continue;
    }
    const f = a / bar.c;
    covered += 1;
    factors.push(f);
    out.push({
      t: bar.t,
      o: +(bar.o * f).toFixed(6),
      h: +(bar.h * f).toFixed(6),
      l: +(bar.l * f).toFixed(6),
      c: +(bar.c * f).toFixed(6),
      // 成交量反向調整：復權後價格變小，量須放大以維持成交金額守恆
      v: f > 0 ? +(bar.v / f).toFixed(2) : bar.v,
    });
  }

  return { candles: out, adj: 'yahoo-adjclose', factor: factors, covered };
}

/**
 * 東方財富回傳的已是前復權價，無需再調整，只需標記來源。
 *
 * @param {Array} candles 東方財富回傳的 K 線
 * @returns {{candles:Array, adj:string, factor:null, covered:number}}
 */
function applyEastmoneyNative(candles) {
  return {
    candles: candles.map((c) => ({ ...c })),
    adj: 'qfq-native',
    factor: null,
    covered: candles.length,
  };
}

/**
 * 騰訊來源：回傳原始價，且 qfq/hfq 參數無效。
 * 依規格 §4.1 FP-2-R1，**不得**降級使用，直接標記為不可用。
 *
 * @returns {{candles:Array, adj:string, factor:null, covered:number}}
 */
function rejectTencent(candles) {
  return { candles: [], adj: 'none', factor: null, covered: 0 };
}

/**
 * 依來源名稱與原始回應建立復權序列。
 *
 * @param {string} sourceName 'yahoo' | 'eastmoney' | 'tencent'
 * @param {Array} candles 原始 K 線
 * @param {Array|null} adjClose Yahoo 的 adjclose 陣列（其他來源傳 null）
 * @returns {{candles:Array, adj:string, factor:Array|null, covered:number, source:string}}
 */
function buildAdjustedSeries(sourceName, candles, adjClose) {
  const src = String(sourceName || '').toLowerCase();
  let r;

  if (src === 'yahoo') {
    r = applyYahooAdj(candles, adjClose);
  } else if (src === 'eastmoney') {
    r = applyEastmoneyNative(candles);
  } else if (src === 'tencent') {
    r = rejectTencent(candles);
  } else {
    // 未知來源一律拒絕，不做任何假設（寧可沒有預測，也不要錯的預測）
    r = { candles: [], adj: 'none', factor: null, covered: 0 };
  }

  return { ...r, source: src };
}

/** 該復權狀態是否可用於 FP */
function isUsable(adj) {
  return ACCEPTED_ADJ.has(adj);
}

/**
 * 驗證復權是否真的生效：找序列中最大的單日對數報酬絕對值。
 * 用來偵測「宣稱已復權但實際沒有」的情況（例如上游行為改變）。
 *
 * @param {Array} candles 復權後序列
 * @returns {{maxAbsLogRet:number, at:string|null}}
 */
function maxAbsLogReturn(candles) {
  let maxV = 0;
  let at = null;
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].c;
    const cur = candles[i].c;
    if (!isFinite(prev) || !isFinite(cur) || prev <= 0 || cur <= 0) continue;
    const v = Math.abs(Math.log(cur / prev));
    if (v > maxV) {
      maxV = v;
      at = new Date(candles[i].t).toISOString().slice(0, 10);
    }
  }
  return { maxAbsLogRet: maxV, at };
}

module.exports = {
  ACCEPTED_ADJ,
  applyYahooAdj,
  applyEastmoneyNative,
  rejectTencent,
  buildAdjustedSeries,
  isUsable,
  maxAbsLogReturn,
};
