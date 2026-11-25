'use strict';

/**
 * 統計可信度（路徑 A 下的「信心度」與「趨勢判斷」）
 *
 * ============ 為什麼不是方向機率 ============
 *
 * 規格書 v1.3 的 A-31 裁決否決了「輸出上漲機率」這條路：48 個測試單元
 * 全部無法穩定贏過滾動基準，Brier Score 反而退化 1.1%–15.9%。
 * 因此正式輸出只有價格區間，沒有 p_up、沒有 p_target。
 *
 * 但使用者需要一個「這個區間可信嗎」的訊號，所以這裡做兩件不同的事：
 *
 *   1. 趨勢判斷 → 改成「區間相對現價的位置描述」
 *      描述的是「這個區間的數值分佈長什麼樣」，不是「未來會漲會跌」。
 *      用詞必須是可觀測的（重心偏上／大致對稱／重心偏下），
 *      並且明確標示 notDirection，前端必須一併顯示說明。
 *
 *   2. 信心度 → 改成「統計可信度」
 *      衡量的是「這份區間估計本身有多可靠」，由三個可量測的部分組成：
 *        a. 校準（PICP 是否真的落在 80% 附近）  ← 權重最高，這是區間的本質
 *        b. 樣本量（回測原點數、各週期樣本數）
 *        c. 資料品質（復權狀態、異常值密度）
 *      三者都是「關於模型」的事實，與「未來漲跌」無關。
 *
 * 這個設計讓 UI 可以誠實地說出「區間校準良好、樣本充足 → 可信度高」，
 * 而不必編造一個沒有統計基礎的方向機率。
 */

/** 目標覆蓋率：80% 區間 */
const TARGET_PICP = 0.8;

/** 80% 區間的合理容許帶（規格 §6.2 的驗收上下限） */
const PICP_BAND = { lo: 0.75, hi: 0.85 };

const WEIGHTS = { calibration: 0.45, samples: 0.30, quality: 0.25 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 校準分數：PICP 越接近 80% 越高。
 *
 * 注意這裡是「雙向」評分：PICP 只有 45% 一樣要扣分。
 * 只獎勵高覆蓋率會導致「把區間放寬到 100%」這種退化，
 * 那不是準，那是沒有資訊量。
 */
function scoreCalibration(picp) {
  if (!isFinite(picp)) return { score: null, note: '未執行回測，無法評估校準' };
  const dev = Math.abs(picp - TARGET_PICP);
  let score;
  if (dev <= 0.02) score = 100;
  else if (dev <= 0.05) score = 100 - ((dev - 0.02) / 0.03) * 30;      // 100 → 70
  else if (dev <= 0.10) score = 70 - ((dev - 0.05) / 0.05) * 35;       // 70  → 35
  else score = clamp(35 - (dev - 0.10) * 350, 0, 35);                  // 35  → 0
  return {
    score: Math.round(score),
    note: `實際覆蓋 ${(picp * 100).toFixed(1)}%，目標 80%（容許 ${PICP_BAND.lo * 100}–${PICP_BAND.hi * 100}%）`,
  };
}

/**
 * 樣本分數：回測原點數越多越可靠。
 *
 * 為什麼用「原點數」而不是「總樣本數」：walk-forward 的原點數才是真正
 * 獨立可比較的實驗次數；同一段序列上的 h 日報酬彼此重疊，不能當作獨立樣本。
 */
function scoreSamples(origins) {
  if (!isFinite(origins) || origins <= 0) return { score: null, note: '無回測樣本' };
  let score;
  if (origins >= 300) score = 100;
  else if (origins >= 150) score = 70 + ((origins - 150) / 150) * 30;  // 70 → 100
  else if (origins >= 60) score = 40 + ((origins - 60) / 90) * 30;     // 40 → 70
  else score = (origins / 60) * 40;                                    // 0  → 40
  return {
    score: Math.round(score),
    note: `回測原點 ${origins} 個${origins >= 300 ? '（充足）' : origins >= 150 ? '（可接受）' : '（偏少）'}`,
  };
}

/** 資料品質分數：復權是否可用 + 異常值密度 */
function scoreQuality(quality, adj, anomaly) {
  const qMap = { high: 100, medium: 72, low: 35 };
  let score = qMap[quality] != null ? qMap[quality] : 50;
  const reasons = [];

  // 復權不可用時 FP 根本不會進到這裡（status 會是 adj_unavailable），
  // 所以此處只作二次確認，避免上游狀態變更時悄悄放行
  if (adj !== 'yahoo-adjclose' && adj !== 'qfq-native') {
    score = Math.min(score, 25);
    reasons.push('未取得復權價，除權日附近會失真');
  } else {
    reasons.push(adj === 'yahoo-adjclose' ? '已復權（adjclose）' : '已復權（前復權原始資料）');
  }
  if (anomaly && isFinite(anomaly.outliers)) {
    if (anomaly.outliers > 12) { score -= 15; reasons.push(`異常跳空 ${anomaly.outliers} 處偏多`); }
    else if (anomaly.outliers > 0) reasons.push(`異常跳空 ${anomaly.outliers} 處`);
  }
  if (anomaly && isFinite(anomaly.gaps) && anomaly.gaps > 20) {
    score -= 8;
    reasons.push(`停牌缺口 ${anomaly.gaps} 處`);
  }

  return { score: Math.round(clamp(score, 0, 100)), note: reasons.join('；') };
}

/** 由加權分數給等級。門檻刻意偏嚴：可信度是拿來勸退過度自信的。 */
function gradeOf(score) {
  if (score == null) return { grade: 'unknown', label: '無法評估' };
  if (score >= 75) return { grade: 'high', label: '可信度高' };
  if (score >= 55) return { grade: 'medium', label: '可信度中等' };
  if (score >= 35) return { grade: 'low', label: '可信度偏低' };
  return { grade: 'very-low', label: '可信度不足' };
}

/**
 * 趨勢判斷 → 位置描述。
 *
 * 只描述「區間」這個物件本身：
 *   - 80% 區間有多少比例落在現價之上
 *   - 中位數相對現價的偏移
 *
 * 刻意不使用「偏多／偏空」這種方向詞，避免被讀成買賣建議。
 */
function positionOf(horizons, basePrice) {
  const detail = {};
  const shares = [];

  for (const h of Object.keys(horizons || {})) {
    const o = horizons[h];
    if (!o || o.status !== 'ok' || !isFinite(o.q10) || !isFinite(o.q90)) continue;
    const span = o.q90 - o.q10;
    const above = span > 0 ? clamp((o.q90 - basePrice) / span, 0, 1) : 0.5;
    const medianOffset = isFinite(o.q50) && basePrice > 0 ? (o.q50 - basePrice) / basePrice : null;
    let label, key;
    if (above >= 0.65) { key = 'upper'; label = '重心偏上'; }
    else if (above <= 0.35) { key = 'lower'; label = '重心偏下'; }
    else { key = 'balanced'; label = '大致對稱'; }
    detail[h] = {
      key,
      label,
      // 區間內高於現價的比例（0..1）。這是純幾何量，不是機率。
      shareAbove: +above.toFixed(3),
      medianOffsetPct: medianOffset == null ? null : +(medianOffset * 100).toFixed(2),
      q10: o.q10,
      q50: o.q50,
      q90: o.q90,
    };
    shares.push(above);
  }

  if (!shares.length) {
    return { available: false, label: '無法判斷', detail: {}, notDirection: true };
  }

  const avg = shares.reduce((a, b) => a + b, 0) / shares.length;
  let key, label;
  if (avg >= 0.62) { key = 'upper'; label = '區間重心偏上'; }
  else if (avg <= 0.38) { key = 'lower'; label = '區間重心偏下'; }
  else { key = 'balanced'; label = '區間大致對稱'; }

  return {
    available: true,
    key,
    label,
    shareAbove: +avg.toFixed(3),
    detail,
    // 前端必須顯示這段話，否則「重心偏上」會被誤讀成「看漲」
    notDirection: true,
    explain: '此處描述的是 80% 價格區間相對現價的**位置分佈**，'
      + '不是漲跌預測。區間重心偏上代表歷史上同波動狀態下的收盤價分佈偏在高處，'
      + '不代表未來會上漲。',
  };
}

/**
 * 主入口：把 pred 物件轉成「可信度 + 位置描述」。
 *
 * @param {object} pred  forecast.buildPrediction 的回傳
 * @param {number} basePrice 今日收盤（pred.price 優先）
 * @returns {object} { available, score, grade, label, components[], position, note }
 */
function assess(pred, basePrice) {
  if (!pred || (pred.status !== 'ok' && pred.status !== 'partial')) {
    return {
      available: false,
      reason: (pred && pred.reason) || '預測不可用，無法評估可信度',
      status: pred ? pred.status : 'error',
    };
  }

  const bt = pred.backtest || {};
  const hs = bt.horizons || {};

  // 校準取所有週期的加權平均（樣本數加權：h20 的原點數最少但最有代表性，
  // 這裡不做特殊處理，直接以原點數為權重，避免短週期主導）
  let calibScore = null, calibNote = '';
  const picps = [];
  [5, 10, 20].forEach((h) => {
    const r = hs[h];
    if (r && r.status === 'ok' && isFinite(r.picp)) picps.push(r.picp);
  });
  if (picps.length) {
    const avg = picps.reduce((a, b) => a + b, 0) / picps.length;
    const c = scoreCalibration(avg);
    calibScore = c.score;
    calibNote = c.note;
  } else {
    const c = scoreCalibration(NaN);
    calibNote = c.note;
  }

  const s = scoreSamples(bt.origins);
  const q = scoreQuality(pred.quality, pred.adj, pred.anomaly);

  const parts = [
    { key: 'calibration', label: '區間校準', weight: WEIGHTS.calibration, score: calibScore, note: calibNote },
    { key: 'samples', label: '樣本充足度', weight: WEIGHTS.samples, score: s.score, note: s.note },
    { key: 'quality', label: '資料品質', weight: WEIGHTS.quality, score: q.score, note: q.note },
  ];

  // 缺項時重新分配權重，而不是當成 0 分——否則「沒跑回測」會被誤報成
  // 「校準極差」，兩者是完全不同的事。
  const valid = parts.filter((p) => p.score != null);
  const wSum = valid.reduce((a, p) => a + p.weight, 0);
  let total = null;
  if (valid.length && wSum > 0) {
    total = Math.round(valid.reduce((a, p) => a + p.score * p.weight, 0) / wSum);
  }
  const g = gradeOf(total);

  const base = isFinite(pred.price) ? pred.price : basePrice;
  const position = positionOf(pred.horizons, base);

  const notes = [];
  if (!picps.length) notes.push('未執行回測，可信度僅由樣本量與資料品質推估');
  if (bt.pass === false) notes.push('區間寬度或覆蓋率未達驗收門檻，請謹慎解讀');
  if (pred.status === 'partial') notes.push('部分週期樣本不足，該週期不提供區間');

  return {
    available: true,
    score: total,
    grade: g.grade,
    label: g.label,
    components: parts.map((p) => ({
      key: p.key, label: p.label, score: p.score,
      weight: p.weight, note: p.note,
    })),
    position,
    backtestPass: bt.pass == null ? null : bt.pass,
    notes,
    // 明確聲明：這是「關於估計品質」的評估，不是方向機率
    disclaimer: '可信度衡量的是「這個價格區間本身有多可靠」，'
      + '由區間校準、樣本量與資料品質加權得出，與未來漲跌方向無關，也不構成投資建議。',
  };
}

module.exports = {
  TARGET_PICP,
  PICP_BAND,
  WEIGHTS,
  scoreCalibration,
  scoreSamples,
  scoreQuality,
  gradeOf,
  positionOf,
  assess,
};
