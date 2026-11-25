'use strict';

/**
 * K 線區間預測模型（路徑 A）
 *
 * 定位（規格 §2.1 / §5.4.2 路徑 A）：
 *   回答「從今日收盤出發，未來 h 個交易日的收盤價會落在哪個區間」。
 *   **不輸出方向機率**。理由見規格 §5.4.1：Brier 優於 B0 達 2% 的門檻
 *   在 48 個測試單元中全數未達標（劣化 1.1%–15.9%），日線 OHLCV 無法
 *   導出可校準的方向機率。區間（分位數）則是可驗證的（PICP/MPIW）。
 *
 * 與既有 probabilities / backtest 的關係（規格 §2.4 FP-0 換算禁令）：
 *   - 既有 backtest 是**條件式**（須觸及 buyZone 才取樣）
 *   - 本模型是**無條件式**（從每個收盤點出發，不看買區）
 *   - 兩者母體不同，任何數值互換都會產生看似合理但無統計意義的結果
 *   - 因此本模組**不讀取** buyZone / probabilities / backtest
 *
 * 方法：以歷史 h 日對數報酬的經驗分位數作為區間。
 *   這是最樸素但**可校準**的估計器：宣稱 80% 區間，若 PICP 落在 75–85%，
 *   即代表區間聲稱可信。相較之下，任何「預測方向」的嘗試都已被實測否定。
 */

const anomaly = require('./anomaly');

/** 對外宣稱的區間（q10–q90 為 80%） */
const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9];
const HORIZONS = [5, 10, 20];

/** 分位數（線性插值，與回測報告的計算方式一致以確保可重現） */
function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 由收盤序列產生「h 日對數報酬」樣本。
 *
 * 注意：樣本 i 的標籤（i+h 的報酬）在時間上必須「已經完成」才能進訓練集，
 * 這是避免未來函數洩漏的核心。呼叫端負責切割。
 *
 * @param {Array} candles 已復權序列
 * @param {number} h 週期
 * @param {number} endExclusive 樣本結束索引（不含；樣本 i 需 i+h < endExclusive）
 * @param {Float64Array|null} weights 每根權重
 * @returns {number[]} h 日對數報酬陣列
 */
function hReturns(candles, h, endExclusive, weights) {
  const out = [];
  const end = endExclusive == null ? candles.length : endExclusive;
  for (let i = 0; i + h < end; i++) {
    const c0 = candles[i].c;
    const c1 = candles[i + h].c;
    if (!isFinite(c0) || !isFinite(c1) || c0 <= 0 || c1 <= 0) continue;
    const r = Math.log(c1 / c0);
    // 依權重稀釋：權重 0.3 的樣本以 0.3 的機率計入
    // 這裡採「確定性稀釋」而非隨機抽樣，以確保同輸入必定同輸出（AC-11）
    if (weights) {
      const w = weights[i];
      if (w != null && w < 1) {
        if (w <= 0.3) continue;             // 異常根直接排除，避免污染分位數
      }
    }
    out.push(r);
  }
  return out;
}

/**
 * 由 h 日報酬樣本估計未來價格分位數。
 *
 * 價格區間 = 今日收盤 × exp(報酬分位數)。用對數空間的理由：
 * 報酬的分布更接近對稱，且區間下界恆為正（不會算出負價格）。
 *
 * @param {number} price 今日收盤
 * @param {number[]} rets h 日對數報酬樣本
 * @returns {{q10:number,q25:number,q50:number,q75:number,q90:number}|null}
 */
function forecastFromReturns(price, rets) {
  if (!rets.length || !isFinite(price) || price <= 0) return null;
  const sorted = [...rets].sort((a, b) => a - b);
  const out = {};
  for (const p of QUANTILES) {
    const r = quantile(sorted, p);
    out['q' + Math.round(p * 100)] = +(price * Math.exp(r)).toFixed(4);
  }
  return out;
}

/**
 * 滾動報酬標準差（波動率）。
 *
 * 為什麼需要它：
 *   直接對「h 日報酬」取經驗分位數會 under-cover（實測 PICP 72–79%，
 *   名義 80%）。原因是報酬分布**非平穩**：波動率有聚集性，
 *   用全窗平均寬度去覆蓋高波動期必然不足、低波動期必然過寬。
 *
 *   解法是把報酬除以「當期波動率」得到近似同分布的 z 值，
 *   取 z 的分位數後再乘回**當前**波動率。這樣區間寬度會隨波動狀態
 *   自動收放，覆蓋率才可能接近名義值。
 *
 * @param {Array} candles 序列
 * @param {number} i 索引
 * @param {number} win 波動率窗口（預設 20）
 * @returns {number|null} 日報酬標準差
 */
function rollingVol(candles, i, win = 20) {
  const from = Math.max(1, i - win + 1);
  const rets = [];
  for (let k = from; k <= i; k++) {
    const c0 = candles[k - 1].c;
    const c1 = candles[k].c;
    if (!isFinite(c0) || !isFinite(c1) || c0 <= 0 || c1 <= 0) continue;
    rets.push(Math.log(c1 / c0));
  }
  if (rets.length < Math.min(10, win)) return null;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) * (x - m), 0) / rets.length;
  return Math.sqrt(v);
}

/**
 * 波動率歸一化的分位數估計（主要預測方法）。
 *
 * 步驟：
 *   1. 對訓練窗內每個 i，算 z_i = r_{i→i+h} / (σ_i × √h)
 *   2. 取 z 的經驗分位數 z_q
 *   3. 預測區間 = price_t × exp(z_q × σ_t × √h)
 *
 * 相較於直接取 r 的分位數，此法把「波動率水平」與「形狀」分離，
 * 使區間能隨當前波動狀態縮放。
 *
 * @param {Array} series 序列
 * @param {number} t 原點索引
 * @param {number} h 週期
 * @param {number} trainStart 訓練窗起點
 * @returns {{z:Object, sigma:number}|null}
 */
function fitVolNormalized(series, t, h, trainStart) {
  const sigmaT = rollingVol(series, t);
  if (!sigmaT || sigmaT <= 0) return null;

  const zs = [];
  const denom = Math.sqrt(h);
  for (let i = trainStart; i + h <= t; i++) {
    // 標籤必須在 t 之前完成，避免未來資訊洩漏
    if (i + h > t) break;
    const sig = rollingVol(series, i);
    if (!sig || sig <= 0) continue;
    const c0 = series[i].c;
    const c1 = series[i + h].c;
    if (!isFinite(c0) || !isFinite(c1) || c0 <= 0 || c1 <= 0) continue;
    zs.push(Math.log(c1 / c0) / (sig * denom));
  }
  if (zs.length < 60) return null;

  const sorted = [...zs].sort((a, b) => a - b);
  const z = {};
  for (const p of QUANTILES) z[p] = quantile(sorted, p);
  return { z, sigma: sigmaT, n: zs.length };
}

/**
 * 由波動率歸一化模型產生價格區間。
 *
 * @param {number} price 今日收盤
 * @param {{z:Object, sigma:number}} fit
 * @param {number} h 週期
 * @returns {Object|null}
 */
function forecastVolNormalized(price, fit, h) {
  if (!fit || !isFinite(price) || price <= 0) return null;
  const scale = fit.sigma * Math.sqrt(h);
  const out = {};
  for (const p of QUANTILES) {
    const r = fit.z[p] * scale;
    out['q' + Math.round(p * 100)] = +(price * Math.exp(r)).toFixed(4);
  }
  return out;
}

/**
 * 主預測入口（單一標的，無條件式）。
 *
 * @param {Array} candles 已復權且已通過異常檢查的序列
 * @param {Object} opts
 * @param {number} opts.lookback 訓練窗根數上限（預設 500）
 * @param {number} opts.minSamples 最少樣本（預設 250）
 * @param {Object} opts.quality 異常報告（供 quality 標記）
 * @param {string} opts.adj 復權狀態
 * @returns {Object} pred 物件
 */
function predict(candles, opts = {}) {
  const lookback = opts.lookback || 500;
  const minSamples = opts.minSamples || 250;
  const quality = opts.quality || null;
  const adjState = opts.adj || 'none';

  const n = candles.length;
  const asOf = n ? new Date(candles[n - 1].t).toISOString().slice(0, 10) : null;
  const base = { asOf, horizons: {}, _diag: { bars: n, lookback, minSamples, adj: adjState } };

  // 邊界：樣本不足 → 明確輸出 insufficient，不給任何數值（AC-10）
  if (n < minSamples) {
    return {
      ...base,
      status: 'insufficient',
      reason: `可用日線 ${n} 根，少於最低需求 ${minSamples} 根`,
      available: n,
      required: minSamples,
      quality: 'low',
    };
  }

  // 復權不可用 → 不預測（規格 §4.1 FP-2-R1）
  if (!['yahoo-adjclose', 'qfq-native'].includes(adjState)) {
    return {
      ...base,
      status: 'adj_unavailable',
      reason: '資料來源不支援復權，除權日附近數字會嚴重失真',
      quality: 'low',
    };
  }

  // 訓練窗：取最後 lookback 根（確保預測原點是今日）
  const start = Math.max(0, n - lookback);
  const series = candles.slice(start);
  const weights = quality ? anomaly.sampleWeights(series.length, quality, series) : null;
  const price = series[series.length - 1].c;

  const horizons = {};
  let allOk = true;
  const coverage = {};

  for (const h of HORIZONS) {
    // 只用「標籤已完成」的樣本：i+h 必須落在序列內，且不含今日之後
    const rets = hReturns(series, h, series.length, weights);
    const fit = fitVolNormalized(series, series.length - 1, h, 0);
    // 優先用波動率歸一化（可隨波動狀態縮放）；樣本不足時退回純經驗分位數
    const q = fit
      ? forecastVolNormalized(price, fit, h)
      : (rets.length >= 60 ? forecastFromReturns(price, rets) : null);
    if (!q) {
      horizons[h] = { status: 'insufficient', samples: rets.length };
      allOk = false;
      continue;
    }
    horizons[h] = {
      status: 'ok',
      samples: fit ? fit.n : rets.length,
      method: fit ? 'vol-normalized' : 'empirical-quantile',
      ...q,
    };
    coverage[h] = q;
  }

  // 週期覆蓋率（多少比例的樣本被保留）
  return {
    ...base,
    status: allOk ? 'ok' : 'partial',
    price: +price.toFixed(4),
    horizons,
    quality: quality ? quality.quality : 'high',
    // 明確的不確定性標示（規格 §8.4 強制）
    note: '此為歷史分位數推估的價格區間，非價格預測，不構成投資建議',
    method: 'vol-normalized-quantile',
    interval: 'q10-q90 (80%)',
  };
}

/**
 * Walk-forward 回測（規格 §5.2）
 *
 * 對每個原點 t，只用 [t-lookback, t) 的樣本建立區間，
 * 再檢查實際的 t+h 收盤是否落在區間內。累積計算 PICP。
 *
 * 關鍵：**不做隨機切分**。時間序列隨機切分會讓訓練集看到未來，
 * 導致 PICP 虛高。
 *
 * 方法必須與 predict() 使用的完全一致（波動率歸一化分位數），
 * 否則此處測到的不是實際出貨的模型，Go/No-Go 判定就沒有意義。
 *
 * @param {Array} candles 已復權序列
 * @param {Object} opts
 * @returns {Object} 回測報告
 */
function backtestIntervals(candles, opts = {}) {
  const lookback = opts.lookback || 500;
  const minTraining = opts.minTraining || 250;
  const minOrigins = opts.minOrigins || 60;
  const n = candles.length;

  const result = {
    lookback,
    minTraining,
    origins: 0,
    status: 'insufficient',
    method: 'vol-normalized-quantile',
    horizons: {},
  };

  if (n < minTraining + 20) {
    result.reason = `序列僅 ${n} 根，不足訓練 ${minTraining} + 驗證所需`;
    return result;
  }

  // 波動率只需算一次（每個索引一個值），供所有週期與原點共用
  const sigma = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = rollingVol(candles, i);
    sigma[i] = s && s > 0 ? s : NaN;
  }

  for (const h of HORIZONS) {
    // 每個索引的 h 日對數報酬（標籤 i+h）
    const hret = new Float64Array(n);
    hret.fill(NaN);
    for (let i = 0; i + h < n; i++) {
      const c0 = candles[i].c;
      const c1 = candles[i + h].c;
      if (!isFinite(c0) || !isFinite(c1) || c0 <= 0 || c1 <= 0) continue;
      hret[i] = Math.log(c1 / c0);
    }
    const denom = Math.sqrt(h);
    // z 值與 h 無關的排序等價性不作假設，直接按 h 預先算好
    const z = new Float64Array(n);
    z.fill(NaN);
    for (let i = 0; i + h < n; i++) {
      if (!isFinite(hret[i]) || !isFinite(sigma[i])) continue;
      z[i] = hret[i] / (sigma[i] * denom);
    }

    let origins = 0;
    let covered = 0;
    const widths = [];
    const pinballs = [];
    let sigmaSum = 0;

    // 原點從「訓練窗填滿」之後開始，且需有 h 根未來可驗證
    for (let t = minTraining; t + h < n; t++) {
      if (!isFinite(sigma[t])) continue;
      const trainStart = Math.max(0, t - lookback);
      // 訓練樣本：只取標籤在 t 之前已完成的（i+h <= t-1 → i < t-h）
      const zs = [];
      for (let i = trainStart; i + h < t; i++) {
        if (isFinite(z[i])) zs.push(z[i]);
      }
      if (zs.length < minTraining) continue;

      const sorted = zs.sort((a, b) => a - b);
      const scale = sigma[t] * denom;
      const r10 = quantile(sorted, 0.1) * scale;
      const r50 = quantile(sorted, 0.5) * scale;
      const r90 = quantile(sorted, 0.9) * scale;

      const p0 = candles[t].c;
      const q10 = p0 * Math.exp(r10);
      const q90 = p0 * Math.exp(r90);
      const actual = candles[t + h].c;

      origins += 1;
      sigmaSum += sigma[t];
      if (actual >= q10 && actual <= q90) covered += 1;
      widths.push((q90 - q10) / p0);

      // Pinball loss（內部指標，對外不呈現）
      const rActual = Math.log(actual / p0);
      const pl = (q, r) => {
        const e = rActual - r;
        return e >= 0 ? q * e : (q - 1) * e;
      };
      pinballs.push((pl(0.1, r10) + pl(0.5, r50) + pl(0.9, r90)) / 3);
    }

    if (origins < minOrigins) {
      result.horizons[h] = { status: 'insufficient', origins };
      continue;
    }

    const picp = covered / origins;
    const mpiw = widths.reduce((s, x) => s + x, 0) / widths.length;
    result.horizons[h] = {
      status: 'ok',
      origins,
      picp: +picp.toFixed(4),
      mpiw: +mpiw.toFixed(4),
      // 回測期內的平均日波動率。寬度上限必須用「與回測同期」的波動率，
      // 不能用最後 14 根的 ATR：當近期波動低於歷史均值時，
      // 會把正常寬度誤判為過寬（實測 AAPL 近期 ATR 2.30%，但其
      // 10 年 σ_d 1.84% 對應 ATR 約 2.9%）。
      meanSigma: +(sigmaSum / origins).toFixed(6),
      pinball: +(pinballs.reduce((s, x) => s + x, 0) / pinballs.length).toFixed(6),
    };
  }

  const okH = Object.values(result.horizons).filter((x) => x.status === 'ok');
  result.origins = okH.length ? Math.max(...okH.map((x) => x.origins)) : 0;
  if (okH.length) result.status = okH.length === HORIZONS.length ? 'ok' : 'partial';

  return result;
}

/**
 * 判定是否達標（規格 §5.5.1 路徑 A，A-32 / A-33 / A-34 修訂）
 *
 * 條件：
 *   主門檻  PICP ∈ [75%, 85%]
 *   防退化  MPIW ≤ 4.0 × σ̄ × √h
 *           σ̄ = 回測期內各原點日波動率的平均（backtestIntervals 回傳 meanSigma）
 *
 * ── 為什麼門檻改過三次（每次都源於診斷出的缺陷，不是「沒過就放寬」）──
 *
 * v1.1 原案：絕對上限 8%/12%/18%。A-32 證明**數學上不可滿足**：
 *   要覆蓋 80% 觀測，寬度下限 = 2×1.2816×σ_d×√h。
 *   h=5 要 ≤8% 需 σ_d ≤ 1.56%；h=10 要 ≤12% 需 σ_d ≤ 1.48%；
 *   h=20 要 ≤18% 需 σ_d ≤ 1.40%。
 *   實測 20 檔 σ_d 中位約 2.0%，僅 KO(1.17%)、WMT 能過 → 可達 2/20。
 *   與 A-09 的 Brier 門檻同屬一類缺陷：固定絕對閾值套在異質波動上。
 *
 * 第二版：2.0 × ATR% × √h。A-33 證明**基準期間錯配**：
 *   MPIW 是回測期內數千個原點的平均寬度（長期量），
 *   14 根 ATR 是當下波動（短期量）。AAPL 10 年 σ_d 1.84%（對應 ATR 約 2.9%），
 *   但近期 ATR 僅 2.30%，用短期量當長期量的上限 → 正常寬度被誤判超標。
 *   改為使用回測同期 meanSigma。
 *
 * 第三版（現行）：4.0 × σ̄ × √h。A-34 釐清**門檻的職責**：
 *   「區間灌寬」其實已被 PICP 上界 85% 擋住 —— 灌寬的模型 PICP 會衝到
 *   90%+ 而直接不通過。因此寬度上限不是校準門檻，而是**防退化護欄**，
 *   用途是攔住「寬度與波動率脫鉤」的模型（例如對任何標的都吐 ±50%）。
 *
 *   4.0 的依據：等效於「不得超過常態理論 80% 寬度的 1.56 倍」。
 *   實測 60 個（20 標的 × 3 週期）觀測的比值為 1.00–1.38
 *   （中位 1.07/1.13/1.14），即厚尾溢價最多 38%。
 *   取 1.56 倍留約 13% 餘裕 —— 刻意**不**設在觀測最大值 3.54σ̄√h，
 *   那只會變成對樣本過擬合；而一個 ±50% 的退化區間在 2% 波動股上
 *   約為理論寬度的 20 倍，會被此護欄明確攔下。
 *
 * @param {Object} bt backtestIntervals 結果
 * @param {number} atrPct 備援：當回測未提供 meanSigma 時，用 ATR% 換算 σ
 * @returns {{pass:boolean, detail:Object}}
 */
function judge(bt, atrPct) {
  const MPIW_SIGMA_MULT = 4.0;
  const detail = {};
  let pass = true;
  let judged = 0;
  let widthOk = true;

  for (const h of HORIZONS) {
    const r = bt.horizons[h];
    if (!r || r.status !== 'ok') {
      detail[h] = { pass: false, reason: 'not-computed' };
      pass = false;
      widthOk = false;
      continue;
    }

    // 優先用回測同期波動率；沒有時用傳入的 ATR% 換算（σ_d ≈ ATR%/1.596）
    let sigma = r.meanSigma;
    if (!isFinite(sigma) || sigma <= 0) {
      sigma = isFinite(atrPct) && atrPct > 0 ? (atrPct / 100) / 1.596 : null;
    }
    const cap = sigma ? MPIW_SIGMA_MULT * sigma * Math.sqrt(h) : null;
    const theory = sigma ? 2 * 1.2816 * sigma * Math.sqrt(h) : null;

    const picpOk = r.picp >= 0.75 && r.picp <= 0.85;
    const mpiwOk = cap != null && r.mpiw <= cap;
    detail[h] = {
      // PICP 決定是否達標；寬度僅作防退化護欄，二者皆需成立
      pass: picpOk && mpiwOk,
      picp: r.picp,
      picpOk,
      mpiw: r.mpiw,
      sigma: sigma ? +sigma.toFixed(6) : null,
      cap: cap == null ? null : +cap.toFixed(4),
      theory: theory == null ? null : +theory.toFixed(4),
      // 實測寬度 ÷ 常態理論寬度；>1.56 觸發防退化護欄
      widthRatio: theory ? +(r.mpiw / theory).toFixed(3) : null,
      mpiwOk,
    };
    if (!picpOk) pass = false;
    if (!mpiwOk) widthOk = false;
    judged += 1;
  }

  return {
    pass: pass && widthOk && judged === HORIZONS.length,
    detail,
    capRule: 'mpiw <= 4.0 * meanSigma * sqrt(h)  (等同 <= 1.56 × 常態理論 80% 寬度)',
  };
}

/**
 * FP 完整管線：取數 → 復權 → 異常檢查 → 預測 + 回測 + 判定
 *
 * 這是 server.js 唯一需要呼叫的入口，把四個模組的串接細節收在這裡，
 * 避免上層自行拼裝時漏掉某一步（例如忘記檢查復權就預測）。
 *
 * 任一階段失敗都不會擲出錯誤，而是回傳帶 status 的物件，
 * 讓 API 永遠能回應一個結構完整的 pred 欄位（AC-10 / AC-15）。
 *
 * @param {Object} datasource lib/datasource 模組
 * @param {string} symbol 已解析的標的代碼
 * @param {Object} opts
 * @param {number} opts.atrPct ATR 佔價格百分比（備援用）
 * @param {boolean} opts.withBacktest 是否附帶回測（預設 true）
 * @returns {Promise<Object>} pred 物件
 */
async function buildPrediction(datasource, symbol, opts = {}) {
  const adjust = require('./adjust');
  const withBacktest = opts.withBacktest !== false;

  const base = {
    symbol,
    status: 'error',
    asOf: null,
    horizons: {},
    note: '此為歷史分位數推估的價格區間，非價格預測，不構成投資建議',
    method: 'vol-normalized-quantile',
    interval: 'q10-q90 (80%)',
  };

  let raw;
  try {
    raw = await datasource.chartWithAdj(symbol, '10y', '1d');
  } catch (e) {
    return { ...base, status: 'unavailable', reason: `取數失敗：${e.message}` };
  }

  // 騰訊等來源會自行標記 'none'，優先採用；否則由 adjust 依來源判定
  const series = raw.adj
    ? { candles: raw.candles, adj: raw.adj, source: raw.source, covered: raw.adj === 'none' ? 0 : raw.candles.length, factor: null }
    : adjust.buildAdjustedSeries(raw.source, raw.candles, raw.adjClose);

  if (!adjust.isUsable(series.adj)) {
    return {
      ...base,
      status: 'adj_unavailable',
      reason: `資料來源（${raw.source}）不提供復權價，除權日附近會嚴重失真`,
      source: raw.source,
      adj: series.adj,
      bars: raw.candles.length,
    };
  }

  const report = require('./anomaly').inspect(series.candles);
  if (!report.ok) {
    return {
      ...base,
      status: 'insufficient',
      reason: report.reason,
      available: report.bars,
      quality: 'low',
      source: raw.source,
      adj: series.adj,
    };
  }

  const pred = predict(series.candles, {
    lookback: 500,
    minSamples: 250,
    quality: report,
    adj: series.adj,
  });

  pred.source = raw.source;
  pred.adj = series.adj;
  pred.anomaly = {
    outliers: report.outliers.length,
    volumeSpikes: report.volumeSpikes.length,
    stagnation: report.stagnation.length,
    gaps: report.gaps.length,
    quality: report.quality,
  };

  if (pred.status !== 'ok' && pred.status !== 'partial') return pred;

  if (withBacktest) {
    const bt = backtestIntervals(series.candles, { lookback: 500, minTraining: 250, minOrigins: 60 });
    const verdict = judge(bt, opts.atrPct);
    pred.backtest = {
      status: bt.status,
      origins: bt.origins,
      horizons: bt.horizons,
      pass: verdict.pass,
      capRule: verdict.capRule,
    };
  }

  return pred;
}

module.exports = {
  QUANTILES,
  HORIZONS,
  quantile,
  hReturns,
  forecastFromReturns,
  rollingVol,
  fitVolNormalized,
  forecastVolNormalized,
  predict,
  backtestIntervals,
  judge,
  buildPrediction,
};
