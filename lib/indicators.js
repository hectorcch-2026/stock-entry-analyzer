'use strict';

/**
 * 技術指標計算模組（純函式，無外部依賴）
 * 所有輸入皆為由舊到新的時間序列陣列；輸出長度與輸入一致，資料不足處為 null。
 */

/** 簡單移動平均 */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v == null ? 0 : v;
    if (i >= period) sum -= values[i - period] == null ? 0 : values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指數移動平均 */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out[i] = prev; continue; }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 標準差（用於布林通道） */
function stdev(values, period, means) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = means[i];
    if (m == null) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += Math.pow(values[j] - m, 2);
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

/** 相對強弱指標 RSI（Wilder 平滑） */
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** MACD（12,26,9） */
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) =>
    emaFast[i] == null || emaSlow[i] == null ? null : emaFast[i] - emaSlow[i]
  );
  const clean = dif.map((v) => (v == null ? 0 : v));
  const dea = ema(clean, signalPeriod);
  const hist = dif.map((v, i) =>
    v == null || dea[i] == null ? null : (v - dea[i]) * 2
  );
  return { dif, dea, hist };
}

/** 真實波幅 ATR（Wilder） */
function atr(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  const tr = [null];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  if (closes.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < closes.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** 布林通道 */
function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period, mid);
  const upper = mid.map((m, i) => (m == null || sd[i] == null ? null : m + mult * sd[i]));
  const lower = mid.map((m, i) => (m == null || sd[i] == null ? null : m - mult * sd[i]));
  return { upper, mid, lower, sd };
}

/** 成交量移動平均 */
function volumeMA(volumes, period = 20) {
  return sma(volumes.map((v) => (v == null ? 0 : v)), period);
}

/**
 * 擺動高低點（swing high / low）
 * 以左右各 lookback 根作為確認窗，回傳由舊到新的 {index, price, type}
 */
function swingPoints(highs, lows, lookback = 5) {
  const points = [];
  for (let i = lookback; i < highs.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isHigh = false;
      if (lows[j] <= lows[i]) isLow = false;
    }
    if (isHigh) points.push({ index: i, price: highs[i], type: 'high' });
    if (isLow) points.push({ index: i, price: lows[i], type: 'low' });
  }
  return points;
}

/** 近 N 根的最高 / 最低 */
function recentRange(highs, lows, n) {
  const h = highs.slice(-n), l = lows.slice(-n);
  if (!h.length) return { high: null, low: null };
  return { high: Math.max(...h), low: Math.min(...l) };
}

/** 斐波那契回撤位 */
function fibonacci(high, low) {
  if (high == null || low == null || high <= low) return null;
  const diff = high - low;
  return {
    high, low,
    levels: [
      { ratio: 0, price: high, label: '0% (高點)' },
      { ratio: 0.236, price: high - diff * 0.236, label: '23.6%' },
      { ratio: 0.382, price: high - diff * 0.382, label: '38.2%' },
      { ratio: 0.5, price: high - diff * 0.5, label: '50.0%' },
      { ratio: 0.618, price: high - diff * 0.618, label: '61.8%' },
      { ratio: 0.786, price: high - diff * 0.786, label: '78.6%' },
      { ratio: 1, price: low, label: '100% (低點)' },
    ],
  };
}

/**
 * 由擺動點聚類出支撐 / 壓力帶
 * 原理：把相近價位的擺動點合併成一個價位帶，觸及次數越多權重越高。
 */
function clusterLevels(points, currentPrice, tolerancePct = 0.02) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(p.price - last.center) / last.center <= tolerancePct) {
      last.prices.push(p.price);
      last.touches += 1;
      last.center = last.prices.reduce((a, b) => a + b, 0) / last.prices.length;
      last.lastIndex = Math.max(last.lastIndex, p.index);
      last.types.add(p.type);
    } else {
      clusters.push({
        center: p.price,
        prices: [p.price],
        touches: 1,
        lastIndex: p.index,
        types: new Set([p.type]),
      });
    }
  }
  return clusters.map((c) => ({
    price: c.center,
    touches: c.touches,
    lastIndex: c.lastIndex,
    role: c.center < currentPrice ? 'support' : 'resistance',
    // 權重：觸及次數 + 越近期越重要
    weight: c.touches * 1.0,
  }));
}

/** 由高到低排序的主要支撐（低於現價） */
function pickSupports(clusters, currentPrice, count = 3) {
  return clusters
    .filter((c) => c.price < currentPrice * 0.999)
    .sort((a, b) => (b.touches - a.touches) || (b.price - a.price))
    .slice(0, count)
    .sort((a, b) => b.price - a.price);
}

/** 由低到高排序的主要壓力（高於現價） */
function pickResistances(clusters, currentPrice, count = 3) {
  return clusters
    .filter((c) => c.price > currentPrice * 1.001)
    .sort((a, b) => (b.touches - a.touches) || (a.price - b.price))
    .slice(0, count)
    .sort((a, b) => a.price - b.price);
}

/** 線性回歸斜率（正規化為每日百分比變化），用於趨勢判斷 */
function linregSlope(values, period = 60) {
  const arr = values.slice(-period).filter((v) => v != null);
  const n = arr.length;
  if (n < 10) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += arr[i]; sxy += i * arr[i]; sxx += i * i; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const mean = sy / n;
  return mean === 0 ? null : (slope / mean) * 100;
}

module.exports = {
  sma, ema, stdev, rsi, macd, atr, bollinger, volumeMA,
  swingPoints, recentRange, fibonacci, clusterLevels,
  pickSupports, pickResistances, linregSlope,
};
