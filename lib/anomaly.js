'use strict';

/**
 * 異常與缺資料處理（FP-5）
 *
 * 依規格 §7，偵測規則全部具體化、可驗證：
 *   1. 價格異常根：abs(ln(c_t / c_{t-1})) > 0.35（約 ±42%）
 *   2. 成交量異常根：v_t > 20 × 近 60 根中位數
 *   3. 停滯根：連續 5 根 h == l（無波動，疑似停牌或資料凍結）
 *   4. 斷裂：相鄰兩根間隔 > 10 個日曆日（長假或停牌）
 *   5. 樣本不足：< 250 根
 *
 * 設計原則：**標記但不刪除**。
 *   直接刪除異常根會讓「t 到 t+h」的期間對齊失真（少了幾根就不知道
 *   真實經過幾個交易日），因此本模組只產生 quality 報告供模型降權，
 *   並在極端情況（根數不足）回報不可用。
 */

const PRICE_LOG_THRESHOLD = 0.35;   // 單日絕對對數報酬上限
const VOLUME_MULTIPLE = 20;         // 量能異常倍數
const STAGNATION_BARS = 5;          // 連續無波動根數
const GAP_CALENDAR_DAYS = 10;       // 斷裂判定（日曆日）
const MIN_BARS = 250;               // 最少樣本

/** 取中位數（不修改來源陣列） */
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 掃描序列，回傳品質報告。
 *
 * @param {Array} candles 已復權的 K 線
 * @returns {{
 *   ok:boolean, reason:string|null, reasonCode:string|null, bars:number,
 *   outliers:Array<{date:string, logRet:number}>,
 *   volumeSpikes:Array<{date:string, ratio:number}>,
 *   stagnation:Array<{from:string, to:string, bars:number}>,
 *   gaps:Array<{from:string, to:string, days:number}>,
 *   quality:'high'|'medium'|'low'
 * }}
 */
function inspect(candles) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const report = {
    ok: true,
    reason: null,
    bars: n,
    outliers: [],
    volumeSpikes: [],
    stagnation: [],
    gaps: [],
    quality: 'high',
  };

  if (n < MIN_BARS) {
    report.ok = false;
    // reason 直接流入 API 的對使用者訊息，必須是中文說明而非代碼。
    // 另以 reasonCode 保留機器可判讀的代碼，避免兩者混用。
    report.reason = `可用日線 ${n} 根，少於最低需求 ${MIN_BARS} 根`;
    report.reasonCode = 'insufficient';
    report.available = n;
    report.required = MIN_BARS;
    report.quality = 'low';
    return report;
  }

  // 1. 價格異常根
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1].c;
    const cur = candles[i].c;
    if (!isFinite(prev) || !isFinite(cur) || prev <= 0 || cur <= 0) continue;
    const lr = Math.log(cur / prev);
    if (Math.abs(lr) > PRICE_LOG_THRESHOLD) {
      report.outliers.push({
        date: new Date(candles[i].t).toISOString().slice(0, 10),
        logRet: +lr.toFixed(4),
      });
    }
  }

  // 2. 成交量異常根（用滾動 60 根中位數，避免被異常值本身拉高）
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - 60);
    const win = [];
    for (let k = from; k < i; k++) {
      const v = candles[k].v;
      if (isFinite(v) && v > 0) win.push(v);
    }
    if (win.length < 20) continue;
    const med = median(win);
    const cur = candles[i].v;
    if (med && med > 0 && isFinite(cur) && cur > med * VOLUME_MULTIPLE) {
      report.volumeSpikes.push({
        date: new Date(candles[i].t).toISOString().slice(0, 10),
        ratio: +(cur / med).toFixed(1),
      });
    }
  }

  // 3. 停滯根（連續 h == l）
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    const flat = candles[i].h === candles[i].l;
    if (flat && runStart < 0) runStart = i;
    if ((!flat || i === n - 1) && runStart >= 0) {
      const end = flat ? i : i - 1;
      const len = end - runStart + 1;
      if (len >= STAGNATION_BARS) {
        report.stagnation.push({
          from: new Date(candles[runStart].t).toISOString().slice(0, 10),
          to: new Date(candles[end].t).toISOString().slice(0, 10),
          bars: len,
        });
      }
      runStart = -1;
    }
  }

  // 4. 斷裂（相鄰間隔 > 10 日曆日）
  for (let i = 1; i < n; i++) {
    const days = (candles[i].t - candles[i - 1].t) / 86400000;
    if (days > GAP_CALENDAR_DAYS) {
      report.gaps.push({
        from: new Date(candles[i - 1].t).toISOString().slice(0, 10),
        to: new Date(candles[i].t).toISOString().slice(0, 10),
        days: Math.round(days),
      });
    }
  }

  // 品質分級：異常根佔比決定
  const badRatio = report.outliers.length / n;
  if (badRatio > 0.02 || report.gaps.length > 10) {
    report.quality = 'low';
  } else if (badRatio > 0.005 || report.gaps.length > 3 || report.stagnation.length) {
    report.quality = 'medium';
  }

  return report;
}

/**
 * 產生供模型使用的樣本權重。
 * 異常根本身權重降為 0.3，其前一根（受污染）也降為 0.6。
 * 這樣既保留期間對齊，又降低異常值對分位數的影響。
 *
 * @param {number} n 根數
 * @param {{outliers:Array<{date:string}>}} report 品質報告
 * @param {Array} candles 原始序列（用於日期比對）
 * @returns {Float64Array} 每根權重
 */
function sampleWeights(n, report, candles) {
  const w = new Float64Array(n).fill(1);
  const badDates = new Set(report.outliers.map((o) => o.date));
  for (let i = 0; i < n; i++) {
    const d = new Date(candles[i].t).toISOString().slice(0, 10);
    if (badDates.has(d)) {
      w[i] = 0.3;
      if (i > 0) w[i - 1] = Math.min(w[i - 1], 0.6);
    }
  }
  return w;
}

module.exports = {
  PRICE_LOG_THRESHOLD,
  VOLUME_MULTIPLE,
  STAGNATION_BARS,
  GAP_CALENDAR_DAYS,
  MIN_BARS,
  inspect,
  sampleWeights,
  median,
};
