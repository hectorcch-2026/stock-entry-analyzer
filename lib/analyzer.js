'use strict';

/**
 * 買入位分析引擎
 *
 * 流程：
 *  1. 抓取日線（1 年）與週線資料
 *  2. 計算均線、RSI、MACD、ATR、布林、量能
 *  3. 由擺動高低點聚類出支撐 / 壓力帶
 *  4. 以「現價相對各技術位」+ 量價 + 動能 產生加權訊號分數
 *  5. 由分數推導建議買入區間，並以歷史回測驗證該區間的勝率
 */

const ind = require('./indicators');
const yahoo = require('./datasource');

/** 訊號評分權重（總和 100） */
const WEIGHTS = {
  maPosition: 22,   // 均線多空排列與現價位置
  supportDist: 18,  // 距主要支撐的距離（越近越好）
  momentum: 16,     // RSI / MACD 動能
  volume: 14,       // 量能配合
  trend: 12,        // 中期趨勢斜率
  resistanceRoom: 12, // 上方空間
  volatility: 6,    // 波動是否合理（ATR 佔比）
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 線性映射：v 在 [a,b] 對應到 [0,1]，超出則夾住 */
function norm(v, a, b) {
  if (v == null || !isFinite(v) || a === b) return 0.5;
  return clamp((v - a) / (b - a), 0, 1);
}

/** 由最近 N 根 K 線推導均線群 */
function buildMovingAverages(candles) {
  const closes = candles.map((c) => c.c);
  const periods = [5, 10, 20, 60, 120];
  const result = [];
  for (const p of periods) {
    const series = ind.sma(closes, p);
    const value = series[series.length - 1];
    if (value == null) continue;
    const prev = series[series.length - 2];
    result.push({
      period: p,
      label: `MA${p}`,
      value,
      slopePct: prev ? ((value - prev) / prev) * 100 : 0,
    });
  }
  return result;
}

/** 建構完整技術快照 */
function buildSnapshot(candles) {
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const volumes = candles.map((c) => c.v);
  const n = candles.length;
  const price = closes[n - 1];

  const mas = buildMovingAverages(candles);
  const rsiSeries = ind.rsi(closes, 14);
  const macdSeries = ind.macd(closes);
  const atrSeries = ind.atr(highs, lows, closes, 14);
  const bb = ind.bollinger(closes, 20, 2);
  const volMA20 = ind.volumeMA(volumes, 20);

  const range20 = ind.recentRange(highs, lows, 20);
  const range60 = ind.recentRange(highs, lows, 60);
  const range252 = ind.recentRange(highs, lows, 252);

  // 擺動點聚類，並補入近期關鍵高低點
  // 補入原因：在單邊行情（如持續破底）下，擺動點可能全部落在現價同側，
  // 導致沒有可用支撐；此時近期低點才是實務上最有效的防守位。
  const swings = ind.swingPoints(highs, lows, 5);
  const derived = [];
  if (range20.low != null) derived.push({ index: n - 1, price: range20.low, type: 'low', derived: true });
  if (range60.low != null) derived.push({ index: n - 1, price: range60.low, type: 'low', derived: true });
  if (range252.low != null) derived.push({ index: Math.max(0, n - 252), price: range252.low, type: 'low', derived: true });
  if (range20.high != null) derived.push({ index: n - 1, price: range20.high, type: 'high', derived: true });
  if (range252.high != null) derived.push({ index: Math.max(0, n - 252), price: range252.high, type: 'high', derived: true });

  const allPoints = swings.concat(derived);
  const clusters = ind.clusterLevels(allPoints, price, 0.02);
  const supports = ind.pickSupports(clusters, price, 3);
  const resistances = ind.pickResistances(clusters, price, 3);
  const fib = ind.fibonacci(range60.high, range60.low);

  const atr = atrSeries[n - 1];
  const atrPct = atr ? (atr / price) * 100 : null;

  // 近期量能：最近 5 日均量 / 20 日均量
  const vol5 = volumes.slice(-5).reduce((a, b) => a + (b || 0), 0) / Math.max(1, Math.min(5, n));
  const vol20 = volMA20[n - 1] || null;
  const volRatio = vol20 ? vol5 / vol20 : null;

  // 近 1 日 / 5 日漲跌幅
  const chg1 = n > 1 && closes[n - 2] ? ((price - closes[n - 2]) / closes[n - 2]) * 100 : null;
  const chg5 = n > 5 && closes[n - 6] ? ((price - closes[n - 6]) / closes[n - 6]) * 100 : null;

  return {
    price,
    mas, rsi: rsiSeries[n - 1], rsiPrev: rsiSeries[n - 2] ?? null,
    macd: {
      dif: macdSeries.dif[n - 1],
      dea: macdSeries.dea[n - 1],
      hist: macdSeries.hist[n - 1],
      histPrev: macdSeries.hist[n - 2] ?? null,
    },
    atr, atrPct,
    boll: {
      upper: bb.upper[n - 1], mid: bb.mid[n - 1], lower: bb.lower[n - 1],
      bandwidthPct: bb.upper[n - 1] && bb.lower[n - 1] && bb.mid[n - 1]
        ? ((bb.upper[n - 1] - bb.lower[n - 1]) / bb.mid[n - 1]) * 100 : null,
    },
    volume: { last: volumes[n - 1], vol5, vol20, ratio: volRatio },
    supports, resistances, clusters,
    range20, range60, range252, fib,
    chg1, chg5,
    trendSlope: ind.linregSlope(closes, 60),
    barCount: n,
  };
}

/**
 * 依技術快照計算加權評分（0-100）與各項說明
 * 分數越高代表「現價越適合進場」。
 */
function scoreEntry(s) {
  const price = s.price;
  const detail = [];
  let total = 0;

  // 1. 均線位置：現價在越短均線之上越多，短線越強；但在所有均線之下則代表弱勢
  const above = s.mas.filter((m) => price >= m.value).length;
  const maRatio = s.mas.length ? above / s.mas.length : 0.5;
  const maScore = norm(maRatio, 0.2, 1);
  total += maScore * WEIGHTS.maPosition;
  detail.push({
    key: 'maPosition',
    label: '均線多空排列',
    score: +(maScore * WEIGHTS.maPosition).toFixed(1),
    max: WEIGHTS.maPosition,
    note: `現價位於 ${s.mas.length} 條均線中的 ${above} 條之上（${s.mas.map((m) => m.label).join(' / ')}）`,
  });

  // 2. 距主要支撐距離：距最近支撐 -2% ~ +8% 為理想
  const nearestSupport = s.supports[0]?.price ?? null;
  let supportScore = 0.5, supportNote = '未偵測到明確支撐，改用布林下軌評估';
  let distToSupport = null;
  if (nearestSupport) {
    distToSupport = ((price - nearestSupport) / nearestSupport) * 100;
    // 距離 0% 給 1.0，距離 ≥6% 給 0.1，跌穿支撐給 0.15
    supportScore = distToSupport < 0 ? 0.15 : norm(6 - distToSupport, 0, 6) * 0.9 + 0.1;
    supportNote = `現價距最近支撐 ${nearestSupport.toFixed(2)} 為 ${distToSupport.toFixed(2)}%`;
  } else if (s.boll.lower) {
    distToSupport = ((price - s.boll.lower) / s.boll.lower) * 100;
    supportScore = norm(6 - distToSupport, 0, 6) * 0.9 + 0.1;
  }
  total += supportScore * WEIGHTS.supportDist;
  detail.push({
    key: 'supportDist', label: '支撐距離', score: +(supportScore * WEIGHTS.supportDist).toFixed(1),
    max: WEIGHTS.supportDist, note: supportNote,
  });

  // 3. 動能：RSI 在 35-60 為回檔可介入區；極高反而不利
  let momScore = 0.5, momNote = '動能數據不足';
  if (s.rsi != null) {
    const r = s.rsi;
    if (r < 25) { momScore = 0.35; momNote = `RSI ${r.toFixed(1)} 超賣但弱勢延續風險高`; }
    else if (r < 40) { momScore = 0.95; momNote = `RSI ${r.toFixed(1)} 接近超賣，回檔佈局勝率較佳`; }
    else if (r <= 60) { momScore = 0.8; momNote = `RSI ${r.toFixed(1)} 在健康區間`; }
    else if (r <= 70) { momScore = 0.5; momNote = `RSI ${r.toFixed(1)} 偏強，追高風險增加`; }
    else { momScore = 0.2; momNote = `RSI ${r.toFixed(1)} 超買，等回檔再進場`; }
    // MACD 加成
    if (s.macd.hist != null && s.macd.histPrev != null) {
      if (s.macd.hist > 0 && s.macd.hist > s.macd.histPrev) { momScore = clamp(momScore + 0.1, 0, 1); momNote += '；MACD 紅柱放大'; }
      else if (s.macd.hist < 0 && s.macd.hist > s.macd.histPrev) { momScore = clamp(momScore + 0.08, 0, 1); momNote += '；MACD 綠柱收窄，轉折初現'; }
      else if (s.macd.hist < 0 && s.macd.hist < s.macd.histPrev) { momScore = clamp(momScore - 0.12, 0, 1); momNote += '；MACD 綠柱擴大，動能轉弱'; }
    }
  }
  total += momScore * WEIGHTS.momentum;
  detail.push({
    key: 'momentum', label: '動能（RSI/MACD）', score: +(momScore * WEIGHTS.momentum).toFixed(1),
    max: WEIGHTS.momentum, note: momNote,
  });

  // 4. 量能：放量上漲最佳，縮量下跌次佳，放量下跌最差
  let volScore = 0.5, volNote = '量能資料不足';
  if (s.volume.ratio != null) {
    const r = s.volume.ratio;
    const up = (s.chg1 ?? 0) >= 0;
    if (up && r > 1.3) { volScore = 1.0; volNote = `量能為 20 日均量 ${r.toFixed(2)} 倍且價漲，量價配合`; }
    else if (up && r > 0.9) { volScore = 0.75; volNote = `量能 ${r.toFixed(2)} 倍、價漲，屬溫和健康`; }
    else if (up) { volScore = 0.5; volNote = `量能 ${r.toFixed(2)} 倍、價漲但量縮，續航力待觀察`; }
    else if (r < 0.8) { volScore = 0.7; volNote = `縮量回檔（${r.toFixed(2)} 倍），賣壓有限`; }
    else if (r <= 1.5) { volScore = 0.4; volNote = `量能 ${r.toFixed(2)} 倍下跌，留意賣壓`; }
    else { volScore = 0.15; volNote = `放量下跌（${r.toFixed(2)} 倍），避免接刀`; }
  }
  total += volScore * WEIGHTS.volume;
  detail.push({
    key: 'volume', label: '量價關係', score: +(volScore * WEIGHTS.volume).toFixed(1),
    max: WEIGHTS.volume, note: volNote,
  });

  // 5. 趨勢：60 日回歸斜率（每日 %）
  let trendScore = 0.5, trendNote = '趨勢樣本不足';
  if (s.trendSlope != null) {
    const t = s.trendSlope;
    trendScore = norm(t, -0.35, 0.35);
    trendNote = `60 日回歸斜率 ${t >= 0 ? '+' : ''}${t.toFixed(3)}%/日，中期${t > 0.05 ? '上升' : t < -0.05 ? '下降' : '橫盤'}`;
  }
  total += trendScore * WEIGHTS.trend;
  detail.push({
    key: 'trend', label: '中期趨勢', score: +(trendScore * WEIGHTS.trend).toFixed(1),
    max: WEIGHTS.trend, note: trendNote,
  });

  // 6. 上方空間：到最近壓力的空間，>8% 為佳
  const nearestRes = s.resistances[0]?.price ?? null;
  let resScore = 0.5, resNote = '上方無明顯壓力，空間充足';
  if (nearestRes) {
    const room = ((nearestRes - price) / price) * 100;
    resScore = room < 0 ? 0.2 : norm(room, 0, 8);
    resNote = `距最近壓力 ${nearestRes.toFixed(2)} 尚有 ${room.toFixed(2)}% 空間`;
    if (room < 2) resNote += '，空間偏窄，需放量突破';
  }
  total += resScore * WEIGHTS.resistanceRoom;
  detail.push({
    key: 'resistanceRoom', label: '上行空間', score: +(resScore * WEIGHTS.resistanceRoom).toFixed(1),
    max: WEIGHTS.resistanceRoom, note: resNote,
  });

  // 7. 波動：ATR 佔價 1.5%-4% 為活躍但可控
  let volaScore = 0.5, volaNote = '波動資料不足';
  if (s.atrPct != null) {
    const a = s.atrPct;
    volaScore = a < 0.8 ? 0.6 : a <= 4 ? 0.9 : a <= 7 ? 0.6 : 0.35;
    volaNote = `ATR 約為股價的 ${a.toFixed(2)}%，${a > 7 ? '波動過大，建議縮小倉位' : a < 0.8 ? '波動偏低，突破可能需要時間' : '波動活躍且可控'}`;
    if (a > 7) volaScore = 0.35;
  }
  total += volaScore * WEIGHTS.volatility;
  detail.push({
    key: 'volatility', label: '波動風險', score: +(volaScore * WEIGHTS.volatility).toFixed(1),
    max: WEIGHTS.volatility, note: volaNote,
  });

  return { score: clamp(total, 0, 100), detail };
}

/**
 * 由支撐、均線、布林與 ATR 計算建議買入區間
 * 邏輯：優先以「最近支撐」與「MA20 / 布林中軌」的下緣交集作為區間下界，
 *       上界則取略高於下界一個 ATR 的比例，形成可執行區間。
 */
function buildBuyZone(s) {
  const price = s.price;
  const atr = s.atr || price * 0.025;
  const candidates = [];

  if (s.supports[0]?.price) candidates.push({ price: s.supports[0].price, why: '最近擺動支撐' });
  if (s.supports[1]?.price) candidates.push({ price: s.supports[1].price, why: '次級支撐' });
  const ma20 = s.mas.find((m) => m.period === 20);
  const ma60 = s.mas.find((m) => m.period === 60);
  if (ma20) candidates.push({ price: ma20.value, why: 'MA20 月線' });
  if (ma60) candidates.push({ price: ma60.value, why: 'MA60 季線' });
  if (s.boll.mid) candidates.push({ price: s.boll.mid, why: '布林中軌' });
  if (s.boll.lower) candidates.push({ price: s.boll.lower, why: '布林下軌' });
  if (s.fib) {
    const f618 = s.fib.levels.find((l) => l.ratio === 0.618);
    const f5 = s.fib.levels.find((l) => l.ratio === 0.5);
    if (f618) candidates.push({ price: f618.price, why: '斐波 61.8% 回撤' });
    if (f5) candidates.push({ price: f5.price, why: '斐波 50% 回撤' });
  }

  // 只考慮現價下方（含現價附近 0.5% 內）的候選位，避免買區高於現價
  const below = candidates.filter((c) => c.price <= price * 1.005 && c.price > 0);
  const pool = below.length ? below : [{ price: price - atr * 0.5, why: 'ATR 回檔估算' }];

  // 加權：多個技術位重合者權重高
  const weighted = pool.map((c) => {
    const overlap = pool.filter((o) => Math.abs(o.price - c.price) / c.price < 0.012).length;
    return { ...c, overlap, w: overlap };
  });
  weighted.sort((a, b) => (b.overlap - a.overlap) || (b.price - a.price));

  const anchor = weighted[0];
  const supporting = pool
    .filter((c) => Math.abs(c.price - anchor.price) / anchor.price < 0.045)
    .map((c) => c.why);

  // 區間：以錨定位為上緣，下緣退一個 ATR 的 0.55 倍，並不高於現價
  let upper = Math.min(anchor.price * 1.004, price * 0.999);
  let lower = Math.max(anchor.price - atr * 0.55, anchor.price * 0.965);
  if (upper <= lower) { upper = anchor.price * 1.002; lower = anchor.price * 0.985; }

  // 停損：區間下緣再退 1 個 ATR
  const stopLoss = lower - atr;
  // 目標：最近壓力，否則區間 + 3 倍 ATR
  const target = s.resistances[0]?.price ?? (upper + atr * 3);

  const rr = (target - upper) / Math.max(0.0001, upper - stopLoss);

  return {
    lower: +lower.toFixed(2),
    upper: +upper.toFixed(2),
    anchorPrice: +anchor.price.toFixed(2),
    anchorWhy: anchor.why,
    overlapCount: anchor.overlap,
    supporting: [...new Set(supporting)],
    stopLoss: +stopLoss.toFixed(2),
    target: +target.toFixed(2),
    riskReward: +rr.toFixed(2),
    atr: +atr.toFixed(2),
    positionHint: rr >= 3 ? '盈虧比優良' : rr >= 2 ? '盈虧比合理' : rr >= 1.2 ? '盈虧比一般，建議輕倉' : '盈虧比偏低，建議等待更好價位',
  };
}

/**
 * 歷史回測：檢驗「股價落入買入區間」後的真實表現
 *
 * 規則：走訪歷史每一根 K 線，若當日最低價觸及 [lower, upper] 區間，
 *      視為一次「觸發進場」，觀察其後 N 日（10/20 日）的收盤表現：
 *      - 勝率 = 報酬 > 0 的比例
 *      - 平均報酬、最大有利 / 不利波動
 * 同時計算基準線（同期隨機進場的機率），得到「相對優勢」。
 *
 * @param {Array} candles 全部歷史 K 線
 * @param {{lower:number, upper:number}} zone
 */
function backtest(candles, zone) {
  const { lower, upper } = zone;
  const horizons = [10, 20];
  const result = {
    samples: 0,
    pending: 0, // 已觸發但尚未走完 20 日的樣本
    horizons: {},
    triggers: [],
  };
  if (!candles.length || !lower || !upper) return result;

  const n = candles.length;

  // 由最後一根往前掃；只要尚有至少一根後續 K 線即可記錄，
  // 未走完 20 日的樣本標記為 pending，僅計入較短週期。
  for (let i = 0; i < n - 1; i++) {
    const c = candles[i];
    const touched = c.l <= upper && c.h >= lower;
    if (!touched) continue;
    const entry = clamp(c.c, lower, upper); // 以收盤價或區間內價位成交
    if (entry <= 0) continue;

    const rec = { index: i, time: c.t, entry, partial: false };
    let any = false;
    for (const h of horizons) {
      const fi = i + h;
      if (fi < n && candles[fi].c != null) {
        rec[`r${h}`] = ((candles[fi].c - entry) / entry) * 100;
        let mfe = -Infinity, mae = Infinity;
        for (let j = i + 1; j <= fi; j++) {
          mfe = Math.max(mfe, ((candles[j].h - entry) / entry) * 100);
          mae = Math.min(mae, ((candles[j].l - entry) / entry) * 100);
        }
        rec[`mfe${h}`] = mfe;
        rec[`mae${h}`] = mae;
        any = true;
      }
    }
    if (!any) {
      // 連 10 日都未走完：只記錄未實現報酬參考
      rec.partial = true;
      const last = candles[n - 1];
      rec.rPart = ((last.c - entry) / entry) * 100;
      result.pending++;
    }
    result.triggers.push(rec);
  }

  // samples 只計入至少完成 10 日觀察窗的樣本，未走完者列為 pending，
  // 避免用未實現的期間充當結論而虛高樣本數。
  result.samples = result.triggers.filter((t) => !t.partial).length;

  // 基準普及率：所有時點的 N 日正報酬機率（用於比較優勢）
  const baseRates = {};
  for (const h of horizons) {
    let up = 0, tot = 0;
    for (let i = 0; i < n - h; i++) {
      const r = ((candles[i + h].c - candles[i].c) / candles[i].c) * 100;
      if (r > 0) up++;
      tot++;
    }
    baseRates[h] = tot ? up / tot : null;
  }

  for (const h of horizons) {
    const rs = result.triggers.map((t) => t[`r${h}`]).filter((v) => v != null);
    if (!rs.length) {
      result.horizons[h] = { n: 0 };
      continue;
    }
    const wins = rs.filter((v) => v > 0);
    const sorted = [...rs].sort((a, b) => a - b);
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
    const winRate = wins.length / rs.length;
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const losses = rs.filter((v) => v <= 0);
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const mfes = result.triggers.map((t) => t[`mfe${h}`]).filter((v) => v != null && isFinite(v));
    const maes = result.triggers.map((t) => t[`mae${h}`]).filter((v) => v != null && isFinite(v));

    result.horizons[h] = {
      n: rs.length,
      winRate,
      avgReturn: avg,
      medianReturn: sorted[Math.floor(sorted.length / 2)],
      avgWin,
      avgLoss,
      profitFactor: avgLoss !== 0 ? Math.abs((winRate * avgWin) / ((1 - winRate) * avgLoss)) : null,
      payoffRatio: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null,
      avgMFE: mfes.length ? mfes.reduce((a, b) => a + b, 0) / mfes.length : null,
      avgMAE: maes.length ? maes.reduce((a, b) => a + b, 0) / maes.length : null,
      baseRate: baseRates[h],
      // 相對優勢：勝率減去基準普及率
      edge: baseRates[h] != null ? winRate - baseRates[h] : null,
    };
  }

  return result;
}

/**
 * 機率合成：
 *  - 樣本充足（≥12）時，以歷史勝率為主，技術分數為輔
 *  - 樣本不足時，以技術分數為主並下調信心，標示為低信心
 */
function composeProbabilities(score, bt) {
  const h20 = bt.horizons[20] || {};
  const h10 = bt.horizons[10] || {};
  const n = bt.samples;

  let confidence;
  if (n >= 30) confidence = 'high';
  else if (n >= 12) confidence = 'medium';
  else if (n >= 5) confidence = 'low';
  else confidence = 'insufficient';

  const techPrior = score / 100; // 技術面隱含機率
  const histWin = h20.winRate ?? h10.winRate ?? null;

  let probUp20, probUp10, probProfit;
  if (histWin != null && n >= 5) {
    // 樣本數導向的貝氏混合：樣本越多越信任歷史
    const w = clamp(n / 40, 0.25, 0.7);
    probUp20 = histWin * w + techPrior * (1 - w);
    probUp10 = (h10.winRate ?? histWin) * w + techPrior * (1 - w);
  } else {
    probUp20 = techPrior * 0.85;
    probUp10 = techPrior * 0.85;
    probUp20 = clamp(probUp20, 0.25, 0.78);
    probUp10 = clamp(probUp10, 0.25, 0.78);
  }

  // 可能獲利機率：同時要求「有正報酬」且「報酬 > 1%」
  // 只採用已走完 20 日觀察窗的樣本，避免近期未實現樣本扭曲機率
  const completed = bt.triggers.filter((t) => t.r20 != null);
  const profitable = completed.filter((t) => t.r20 > 1).length;
  probProfit = completed.length ? profitable / completed.length : null;
  if (probProfit == null) probProfit = clamp(probUp20 * 0.75, 0.15, 0.7);
  else probProfit = probProfit * 0.75 + probUp20 * 0.25;

  // 達標機率：曾觸及目標價
  const targetHits = bt.triggers
    .map((t) => t.mfe20)
    .filter((v) => v != null).length;
  const targetProb = targetHits && h20.avgMFE != null ? clamp(0.5, 0.1, 0.9) : null;

  return {
    confidence,
    sampleSize: n,
    probUp10: clamp(probUp10, 0.05, 0.95),
    probUp20: clamp(probUp20, 0.05, 0.95),
    probProfit: clamp(probProfit, 0.05, 0.95),
    targetProb,
    baseRate20: h20.baseRate ?? null,
    edge20: h20.edge ?? null,
  };
}

/** 產生自然語言判斷依據 */
function buildRationale(s, scoreInfo, zone, probs, meta) {
  const cur = meta.currency;
  const f = (v) => (v == null ? '—' : v.toFixed(2));
  const lines = [];

  const supportsTxt = s.supports.length
    ? s.supports.map((x) => `${f(x.price)}（${x.touches} 次觸及）`).join('、')
    : '未偵測到明確支撐';
  const resTxt = s.resistances.length
    ? s.resistances.map((x) => `${f(x.price)}（${x.touches} 次觸及）`).join('、')
    : '未偵測到明確壓力';

  lines.push({
    title: '現價與技術位關係',
    body: `現價 ${f(s.price)} ${cur}。下方支撐依序為 ${supportsTxt}；上方壓力依序為 ${resTxt}。`
      + (s.supports[0] ? `現價距離最近支撐約 ${(((s.price - s.supports[0].price) / s.supports[0].price) * 100).toFixed(2)}%。` : '')
      + (s.resistances[0] ? ` 距離最近壓力約 ${(((s.resistances[0].price - s.price) / s.price) * 100).toFixed(2)}%。` : ''),
  });

  lines.push({
    title: '均線結構',
    body: s.mas.map((m) => `${m.label} ${f(m.value)}（${m.slopePct >= 0 ? '上彎' : '下彎'} ${m.slopePct.toFixed(2)}%）`).join('；')
      + `。現價${s.price >= (s.mas.find((m) => m.period === 20)?.value ?? s.price) ? '站上' : '跌破'} MA20，`
      + `${s.price >= (s.mas.find((m) => m.period === 60)?.value ?? s.price) ? '且位於季線之上，中期結構偏多' : '且位於季線之下，中期結構偏弱'}。`,
  });

  lines.push({
    title: '量價與異動',
    body: (s.volume.ratio != null
      ? `近 5 日均量為 20 日均量的 ${s.volume.ratio.toFixed(2)} 倍。`
      : '量能樣本不足。')
      + (s.chg1 != null ? ` 最近一個交易日漲跌 ${s.chg1 >= 0 ? '+' : ''}${s.chg1.toFixed(2)}%；` : '')
      + (s.chg5 != null ? `近 5 日累計 ${s.chg5 >= 0 ? '+' : ''}${s.chg5.toFixed(2)}%。` : '')
      + (s.volume.ratio > 1.5 && (s.chg1 ?? 0) < 0
        ? ' 出現放量下跌，代表賣壓實質湧出，即使接近支撐也應分批、縮小倉位。'
        : s.volume.ratio > 1.2 && (s.chg1 ?? 0) > 0
          ? ' 放量上漲有利於確認支撐有效。'
          : ' 量價關係中性，建議等待量能進一步表態。'),
  });

  lines.push({
    title: '波動與風險',
    body: `ATR(14) 約 ${f(s.atr)}，佔股價 ${s.atrPct != null ? s.atrPct.toFixed(2) : '—'}%。`
      + (s.boll.bandwidthPct != null ? ` 布林通道寬度 ${s.boll.bandwidthPct.toFixed(2)}%，` : '')
      + (s.boll.bandwidthPct != null && s.boll.bandwidthPct < 8 ? '屬收斂整理，突破方向未定，適合在區間下緣佈局。' : '屬正常波動區間。'),
  });

  const h20 = probs.histWin20;
  lines.push({
    title: '歷史數據模型',
    body: `以近一年日線回溯，股價進入建議區間 ${f(zone.lower)} ~ ${f(zone.upper)} 的樣本共 ${probs.sampleSize} 次。`
      + (h20 != null
        ? ` 其後 20 個交易日上漲機率為 ${(h20 * 100).toFixed(1)}%`
          + (probs.baseRate20 != null ? `（同期基準機率 ${(probs.baseRate20 * 100).toFixed(1)}%，相對優勢 ${probs.edge20 >= 0 ? '+' : ''}${(probs.edge20 * 100).toFixed(1)} 個百分點）` : '')
          + '。'
        : ' 樣本不足，機率以技術面推估，信心度較低。'),
  });

  lines.push({
    title: '綜合結論',
    body: `技術面綜合評分 ${scoreInfo.score.toFixed(1)} / 100。建議買入區間 ${f(zone.lower)} ~ ${f(zone.upper)} ${cur}`
      + `（依據：${zone.supporting.join('、')}）。停損 ${f(zone.stopLoss)}，目標 ${f(zone.target)}，盈虧比約 ${zone.riskReward}（${zone.positionHint}）。`
      + ` 20 日上漲機率 ${(probs.probUp20 * 100).toFixed(1)}%，獲利機率（報酬 > 1%）${(probs.probProfit * 100).toFixed(1)}%。`,
  });

  return lines;
}

/** 依分數給出操作建議標籤 */
function verdictOf(score) {
  if (score >= 72) return { level: 'buy', label: '可分批佈局', tone: 'positive' };
  if (score >= 58) return { level: 'watch-buy', label: '偏多，等回檔', tone: 'positive' };
  if (score >= 45) return { level: 'watch', label: '中性觀望', tone: 'neutral' };
  if (score >= 32) return { level: 'caution', label: '偏弱，暫不介入', tone: 'negative' };
  return { level: 'avoid', label: '弱勢，建議迴避', tone: 'negative' };
}

/**
 * 主入口：完整分析一檔標的
 * @param {string} symbol 例如 AAPL / 0700.HK
 */
async function analyze(symbol) {
  // 日線取 2 年以增加回測樣本；週線輔助大級別判斷
  const [daily, weekly, q] = await Promise.all([
    yahoo.chart(symbol, '2y', '1d'),
    yahoo.chart(symbol, '5y', '1wk').catch(() => ({ candles: [] })),
    yahoo.quote(symbol),
  ]);

  const candles = daily.candles;
  if (candles.length < 40) {
    const err = new Error('歷史資料不足（少於 40 個交易日），無法進行可靠的技術分析');
    err.code = 'INSUFFICIENT_DATA';
    err.insufficient = true;
    throw err;
  }

  const s = buildSnapshot(candles);
  // 報價以 chart meta 為主，並補上漲跌幅
  const price = s.price;
  const prevClose = candles.length > 1 ? candles[candles.length - 2].c : null;
  s.chg1 = prevClose ? ((price - prevClose) / prevClose) * 100 : s.chg1;

  const scoreInfo = scoreEntry(s);
  const zone = buildBuyZone(s);
  const bt = backtest(candles, zone);
  const probs = composeProbabilities(scoreInfo.score, bt);

  const meta = {
    symbol: q.symbol,
    name: q.name,
    shortName: q.shortName,
    currency: q.currency,
    exchange: q.exchange,
    market: q.market,
    marketTime: q.marketTime,
    timezone: q.timezone,
    price,
    previousClose: prevClose,
    changePercent: s.chg1,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    volume: q.volume,
  };

  const rationale = buildRationale(s, scoreInfo, zone, { ...probs, histWin20: bt.horizons[20]?.winRate ?? null }, meta);
  const verdict = verdictOf(scoreInfo.score);

  return {
    meta,
    verdict,
    score: +scoreInfo.score.toFixed(1),
    scoreBreakdown: scoreInfo.detail,
    snapshot: {
      mas: s.mas,
      rsi: s.rsi,
      macd: s.macd,
      atr: s.atr,
      atrPct: s.atrPct,
      boll: s.boll,
      volume: s.volume,
      trendSlope: s.trendSlope,
    },
    levels: {
      supports: s.supports.map((x) => ({ price: +x.price.toFixed(2), touches: x.touches, distancePct: +(((x.price - price) / price) * 100).toFixed(2) })),
      resistances: s.resistances.map((x) => ({ price: +x.price.toFixed(2), touches: x.touches, distancePct: +(((x.price - price) / price) * 100).toFixed(2) })),
      range20: { high: s.range20.high, low: s.range20.low },
      range60: { high: s.range60.high, low: s.range60.low },
      range252: { high: s.range252.high, low: s.range252.low },
      fib: s.fib,
    },
    buyZone: zone,
    rationale,
    probabilities: {
      confidence: probs.confidence,
      sampleSize: probs.sampleSize,
      probUp10: +probs.probUp10.toFixed(4),
      probUp20: +probs.probUp20.toFixed(4),
      probProfit: +probs.probProfit.toFixed(4),
      baseRate20: probs.baseRate20,
      edge20: probs.edge20,
    },
    backtest: {
      samples: bt.samples,
      pending: bt.pending,
      horizons: {
        10: serializeHorizon(bt.horizons[10]),
        20: serializeHorizon(bt.horizons[20]),
      },
      recentTriggers: bt.triggers.slice(-8).map((t) => ({
        time: t.time, entry: +t.entry.toFixed(2),
        r10: t.r10 != null ? +t.r10.toFixed(2) : null,
        r20: t.r20 != null ? +t.r20.toFixed(2) : null,
        partial: !!t.partial,
      })),
    },
    series: buildSeries(candles, weekly.candles),
    dataUpdatedAt: Date.now(),
    dataSource: (() => {
      const label = {
        yahoo: 'Yahoo Finance',
        eastmoney: '東方財富',
        tencent: '騰訊行情',
        'local-alias': '本地索引',
      }[yahoo.lastSource] || 'Yahoo Finance';
      return `${label}（日線 2 年 / 週線 5 年，即時延遲報價）`;
    })(),
    dataSourceKey: yahoo.lastSource || 'yahoo',
  };
}

function serializeHorizon(h) {
  if (!h || !h.n) return { n: 0 };
  const r = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(4));
  return {
    n: h.n, winRate: r(h.winRate), avgReturn: r(h.avgReturn), medianReturn: r(h.medianReturn),
    avgWin: r(h.avgWin), avgLoss: r(h.avgLoss), profitFactor: r(h.profitFactor),
    payoffRatio: r(h.payoffRatio), avgMFE: r(h.avgMFE), avgMAE: r(h.avgMAE),
    baseRate: r(h.baseRate), edge: r(h.edge),
  };
}

/** 準備前端繪圖資料（近 250 根日線 + 週線摘要） */
function buildSeries(candles, weeklyCandles) {
  const slice = candles.slice(-250);
  return {
    daily: slice.map((c) => ({
      t: c.t, o: +c.o.toFixed(3), h: +c.h.toFixed(3), l: +c.l.toFixed(3), c: +c.c.toFixed(3), v: c.v,
    })),
    weekly: (weeklyCandles || []).slice(-120).map((c) => ({
      t: c.t, o: +c.o.toFixed(3), h: +c.h.toFixed(3), l: +c.l.toFixed(3), c: +c.c.toFixed(3), v: c.v,
    })),
  };
}

module.exports = { analyze, WEIGHTS };
