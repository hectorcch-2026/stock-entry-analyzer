'use strict';

/**
 * 四大進階分析工具 —— 計算引擎
 *
 *  1. VRVP / FRVP  成交量分佈（Volume Profile）：籌碼堆積、POC、Value Area
 *  2. Anchored VWAP 錨定均價：特定事件後的資金平均成本
 *  3. FVG / 價格裂口  Fair Value Gap：短期買賣動能失衡區
 *  4. 期權 OI / GEX   機構與做市商對沖博弈
 *
 * 設計原則
 * ────────
 * ‧ 純函式、零外部依賴、不使用亂數，同一輸入必得同一輸出（可測試）。
 * ‧ 每個模組都回傳統一結構，包含使用者要求的四個欄位：
 *     dimension（觀察維度）、entry（最佳進場信號）、
 *     stop（止損／失效信號）、platforms（常見支援平台）
 * ‧ 資料不足時不猜測、不編造。available=false + reason 明確說明缺什麼、
 *   以及可以去哪裡取得，讓使用者知道「這是工具限制」而非「標的沒訊號」。
 */

/* ============================================================
   共用小工具
   ============================================================ */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = (v) => typeof v === 'number' && isFinite(v);
const round = (v, d = 2) => (isNum(v) ? +v.toFixed(d) : null);
const pctOf = (v, base) => (isNum(v) && isNum(base) && base !== 0 ? ((v - base) / base) * 100 : null);

/** 標準常態分佈機率密度函數 */
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** 標準常態累積分佈（Abramowitz & Stegun 近似，誤差 < 7.5e-8） */
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/* ============================================================
   模組 1：VRVP / FRVP —— 成交量分佈
   ============================================================ */

/**
 * 建立成交量分佈（Volume Profile）
 *
 * VRVP = Visible Range Volume Profile：對「目前畫面可見的區間」統計
 * FRVP = Fixed Range Volume Profile：對「指定的固定區間」統計
 *
 * 本實作對應 FRVP（固定區間），並可指定回看根數模擬 VRVP 的可視範圍。
 *
 * 演算法：把區間高低切成 N 個價位格（bin），把每根 K 線的成交量
 * 依其「高低價涵蓋的格數」平均攤分。這比只用收盤價歸屬更接近
 * 真實籌碼分佈（盤中成交會分佈在整根 K 線的價格帶內）。
 *
 * Value Area：從 POC 開始，每次往「成交量較大的相鄰格」擴張，
 * 直到累計成交量達總量的 70%（業界慣例）。VAH / VAL 即其上下界。
 */
function buildVolumeProfile(candles, opts = {}) {
  const lookback = opts.lookback || 120;   // 回看根數（FRVP 固定區間）
  const bins = opts.bins || 40;            // 價位格數
  const vaPct = opts.valueAreaPct || 0.7;  // Value Area 佔比

  const slice = candles.slice(-lookback);
  if (slice.length < 20) {
    return {
      available: false,
      reason: `成交量分佈需要至少 20 根 K 線，目前僅 ${slice.length} 根。`,
    };
  }

  const highs = slice.map((c) => c.h);
  const lows = slice.map((c) => c.l);
  const vols = slice.map((c) => c.v || 0);

  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  if (!isNum(hi) || !isNum(lo) || hi <= lo) {
    return { available: false, reason: '區間高低價無效，無法建立價位格。' };
  }

  const step = (hi - lo) / bins;
  const buckets = new Array(bins).fill(0);

  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    const v = c.v || 0;
    if (v <= 0) continue;
    const bLo = clamp(Math.floor((c.l - lo) / step), 0, bins - 1);
    const bHi = clamp(Math.floor((c.h - lo) / step), 0, bins - 1);
    const span = bHi - bLo + 1;
    const share = v / span;
    for (let b = bLo; b <= bHi; b++) buckets[b] += share;
  }

  const total = buckets.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return { available: false, reason: '區間內無有效成交量資料。' };
  }

  // POC：成交量最大的格（取其中點為代表價位）
  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (buckets[i] > buckets[pocIdx]) pocIdx = i;
  const priceOfBin = (i) => lo + step * (i + 0.5);
  const poc = priceOfBin(pocIdx);

  // Value Area 擴張
  let acc = buckets[pocIdx];
  let up = pocIdx, down = pocIdx;
  const target = total * vaPct;
  while (acc < target && (up < bins - 1 || down > 0)) {
    const upVal = up < bins - 1 ? buckets[up + 1] : -1;
    const downVal = down > 0 ? buckets[down - 1] : -1;
    if (upVal < 0 && downVal < 0) break;
    if (upVal >= downVal) { up++; acc += Math.max(0, upVal); }
    else { down--; acc += Math.max(0, downVal); }
  }
  const vah = lo + step * (up + 1);
  const val = lo + step * down;

  const price = candles[candles.length - 1].c;
  const posInVA = price > vah ? 'above-vah' : price < val ? 'below-val' : 'inside-va';

  // 高量區（重貨區）：成交量達 POC 的 70% 以上者
  const heavyThreshold = buckets[pocIdx] * 0.7;
  const heavyZones = buckets
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v >= heavyThreshold)
    .map((x) => ({ from: round(lo + step * x.i), to: round(lo + step * (x.i + 1)) }));

  // 回傳給前端的格狀圖（由低到高）
  const profile = buckets.map((v, i) => ({
    from: round(lo + step * i),
    to: round(lo + step * (i + 1)),
    mid: round(priceOfBin(i)),
    volume: Math.round(v),
    pct: round((v / total) * 100, 2),
    isPOC: i === pocIdx,
    inVA: i <= up && i >= down,
  }));

  // 最近一次觸及 POC 的距離與次數（衡量 POC 是否仍有效）
  let pocTouches = 0;
  for (let i = slice.length - 20; i < slice.length; i++) {
    if (i < 0) continue;
    const c = slice[i];
    if (c.l <= poc * 1.005 && c.h >= poc * 0.995) pocTouches++;
  }

  // 現價突破 VAH 的量能確認：近 3 根是否放量
  const recentVol = slice.slice(-3).reduce((a, c) => a + (c.v || 0), 0) / 3;
  const avgVol = total / slice.length;
  const volRatio = avgVol > 0 ? recentVol / avgVol : null;

  return {
    available: true,
    lookback: slice.length,
    bins,
    priceRange: { high: round(hi), low: round(lo) },
    poc: round(poc),
    vah: round(vah),
    val: round(val),
    valueAreaPct: round((acc / total) * 100, 1),
    price,
    posInVA,
    distToPOCPct: round(pctOf(price, poc), 2),
    distToVAHPct: round(pctOf(price, vah), 2),
    distToVALPct: round(pctOf(price, val), 2),
    heavyZones,
    profile,
    pocTouches,
    volRatio: round(volRatio, 2),
    // 訊號判定所需的原始事實
    facts: {
      aboveVAH: price > vah,
      belowVAL: price < val,
      nearPOC: Math.abs(pctOf(price, poc) ?? 999) <= 1.5,
      nearVAH: Math.abs(pctOf(price, vah) ?? 999) <= 1.5,
      heavyVol: (volRatio ?? 0) >= 1.3,
    },
  };
}

/* ============================================================
   模組 2：Anchored VWAP —— 錨定均價
   ============================================================ */

/**
 * 尋找錨定點（事件日）
 *
 * 實務上 AVWAP 的錨點是「特定事件」：財報日、重大利好消息、底部起漲日。
 * 我們無法從 K 線得知新聞事件，但可以辨識「事件在價格上留下的足跡」：
 *
 *  1. 底部起漲日：近期最低點之後，出現「放量大陽線」
 *  2. 突破日：放量突破前 N 日高點
 *  3. 最大量日：區間內成交量最大的一天（通常對應消息面事件）
 *
 * 回傳多個候選錨點，並各自計算 AVWAP，讓使用者對照。
 */
function findAnchors(candles, count = 3) {
  const n = candles.length;
  if (n < 30) return [];

  const vols = candles.map((c) => c.v || 0);
  const avgVol = vols.slice(-60).reduce((a, b) => a + b, 0) / Math.min(60, n);
  const anchors = [];

  // 候選 1：近期最低點（底部起漲候選）
  let lowIdx = n - 1;
  for (let i = Math.max(0, n - 60); i < n; i++) if (candles[i].l < candles[lowIdx].l) lowIdx = i;
  if (lowIdx < n - 1) {
    anchors.push({
      index: lowIdx,
      time: candles[lowIdx].t,
      price: candles[lowIdx].l,
      type: 'bottom',
      label: '近期最低點',
      why: '區間內最低價所在日，常是波段起漲的錨點',
    });
  }

  // 候選 2：最大量日（對應消息面事件）
  let bigVolIdx = n - 1;
  for (let i = Math.max(0, n - 120); i < n; i++) if (vols[i] > vols[bigVolIdx]) bigVolIdx = i;
  if (bigVolIdx !== lowIdx) {
    anchors.push({
      index: bigVolIdx,
      time: candles[bigVolIdx].t,
      price: candles[bigVolIdx].c,
      type: 'volume',
      label: '最大成交量日',
      why: `成交量 ${Math.round(vols[bigVolIdx] / Math.max(1, avgVol) * 100) / 100} 倍均量，通常反映重大事件`,
    });
  }

  // 候選 3：放量突破日（突破前 20 日高點且量增）
  for (let i = n - 2; i >= Math.max(20, n - 120); i--) {
    const prevHigh = Math.max(...candles.slice(i - 20, i).map((c) => c.h));
    if (candles[i].c > prevHigh && vols[i] > avgVol * 1.5) {
      anchors.push({
        index: i,
        time: candles[i].t,
        price: candles[i].c,
        type: 'breakout',
        label: '放量突破日',
        why: '收盤突破前 20 日高點且成交量放大 1.5 倍以上',
      });
      break;
    }
  }

  // 去重（同一根 K 線只留一個）並依時間新到舊排序
  const seen = new Set();
  const unique = [];
  for (const a of anchors) {
    if (seen.has(a.index)) continue;
    seen.add(a.index);
    unique.push(a);
  }
  unique.sort((a, b) => b.index - a.index);
  return unique.slice(0, count);
}

/** 從某個索引開始計算 VWAP 序列 */
function vwapFrom(candles, startIdx) {
  const out = [];
  let cumPV = 0, cumV = 0;
  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];
    // 典型價 = (H+L+C)/3，比只用收盤價更貼近當日成交均價
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.v || 0;
    cumPV += tp * v;
    cumV += v;
    out.push(cumV > 0 ? cumPV / cumV : tp);
  }
  return out;
}

/**
 * 建立 Anchored VWAP 分析
 * 對每個候選錨點計算 AVWAP，並判定現價與它的關係。
 */
function buildAnchoredVWAP(candles, opts = {}) {
  if (candles.length < 30) {
    return {
      available: false,
      reason: `錨定均價需要至少 30 根 K 線，目前僅 ${candles.length} 根。`,
    };
  }

  const anchors = findAnchors(candles, opts.maxAnchors || 3);
  if (!anchors.length) {
    return { available: false, reason: '近期無明顯的事件型錨點（如放量突破、最大量日）。' };
  }

  const price = candles[candles.length - 1].c;
  const atr = opts.atr || null;

  const series = anchors.map((a) => {
    const vals = vwapFrom(candles, a.index);
    const vwap = vals[vals.length - 1];
    const prev = vals.length > 1 ? vals[vals.length - 2] : vwap;
    const slope = prev ? vwap - prev : 0;

    // 現價相對 AVWAP 的距離
    const distPct = pctOf(price, vwap);

    // 自錨點以來的表現
    const gainSince = pctOf(price, a.price);

    // 錨點後是否曾跌破 AVWAP（用來判斷該線是否仍具支撐意義）
    let breaches = 0;
    for (let i = 0; i < vals.length; i++) {
      const ci = a.index + i;
      if (ci >= candles.length) break;
      if (candles[ci].c < vals[i] * 0.998) breaches++;
    }

    // 觸及次數：收盤價在 AVWAP ±1.5% 內
    let touches = 0;
    for (let i = Math.max(0, vals.length - 40); i < vals.length; i++) {
      const ci = a.index + i;
      if (ci >= candles.length) break;
      if (Math.abs((candles[ci].c - vals[i]) / vals[i]) <= 0.015) touches++;
    }

    // 最近 3 根 K 線是否出現看漲型態（收盤高於開盤，且下影線收復）
    const last3 = candles.slice(-3);
    const bullishBar = last3.some((c) => c.c > c.o && (c.c - c.l) / Math.max(0.01, c.h - c.l) > 0.5);

    return {
      anchor: {
        time: a.time,
        price: round(a.price),
        type: a.type,
        label: a.label,
        why: a.why,
        barsAgo: candles.length - 1 - a.index,
      },
      vwap: round(vwap),
      slope: round(slope, 3),
      distPct: round(distPct, 2),
      gainSince: round(gainSince, 2),
      aboveVWAP: price > vwap,
      breaches,
      touches,
      holding: breaches === 0 || (distPct ?? 0) > 0,
      // 進場判定的原始事實
      nearVWAP: Math.abs(distPct ?? 999) <= 1.5,
      bullishBar,
    };
  });

  // 主要錨點：取最接近現價且仍在現價下方（可作為支撐）者，否則取最近錨點
  const supports = series.filter((s) => s.aboveVWAP);
  const primary = supports.length
    ? supports.reduce((best, s) => (s.distPct < best.distPct ? s : best))
    : series[0];

  return {
    available: true,
    price,
    atr,
    count: series.length,
    series,
    primary,
    // 整體評估：幾條 AVWAP 在現價之上（多方掌控）
    aboveCount: series.filter((s) => s.aboveVWAP).length,
  };
}

/* ============================================================
   模組 3：FVG / 價格裂口 —— 動能失衡區
   ============================================================ */

/**
 * 偵測 Fair Value Gap（FVG，價格效率缺口）
 *
 * 三根 K 線構成的失衡：
 *   看漲 FVG：第 1 根的高點 < 第 3 根的低點  → 中間留下未成交的真空帶
 *   看跌 FVG：第 1 根的低點 > 第 3 根的高點
 *
 * 與傳統「裂口（Gap）」的差異：
 *   傳統裂口只看「今開 vs 昨收」的跳空；
 *   FVG 看的是三根 K 線的結構性失衡，更適合日內與短波段。
 *   本模組兩者都偵測，並分別標示。
 *
 * 回補判定：後續價格進入該區間即為「部分回補」，
 * 完全穿越另一側為「完全回補（封閉）」。
 */
function buildFVG(candles, opts = {}) {
  const lookback = opts.lookback || 120;
  const minGapPct = opts.minGapPct || 0.25;  // 最小缺口幅度（佔價 %），過濾雜訊
  const maxKeep = opts.maxKeep || 8;         // 最多保留幾個未回補的缺口

  const slice = candles.slice(-lookback);
  if (slice.length < 10) {
    return {
      available: false,
      reason: `缺口偵測需要至少 10 根 K 線，目前僅 ${slice.length} 根。`,
    };
  }

  const price = candles[candles.length - 1].c;
  const gaps = [];

  /* ---- A. 結構性 FVG（三根 K 線）---- */
  for (let i = 2; i < slice.length; i++) {
    const c1 = slice[i - 2];
    const c3 = slice[i];

    // 看漲 FVG：c1.high < c3.low
    if (c1.h < c3.l) {
      const lower = c1.h;
      const upper = c3.l;
      if ((upper - lower) / lower * 100 >= minGapPct) {
        gaps.push({
          kind: 'fvg-bull',
          direction: 'bullish',
          lower: round(lower),
          upper: round(upper),
          createdIndex: i,
          time: c3.t,
          label: '看漲 FVG',
        });
      }
    }
    // 看跌 FVG：c1.low > c3.high
    if (c1.l > c3.h) {
      const lower = c3.h;
      const upper = c1.l;
      if ((upper - lower) / upper * 100 >= minGapPct) {
        gaps.push({
          kind: 'fvg-bear',
          direction: 'bearish',
          lower: round(lower),
          upper: round(upper),
          createdIndex: i,
          time: c3.t,
          label: '看跌 FVG',
        });
      }
    }
  }

  /* ---- B. 傳統裂口（跳空）---- */
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const cur = slice[i];
    // 向上跳空：今低 > 昨高
    if (cur.l > prev.h) {
      const gapPct = ((cur.l - prev.h) / prev.h) * 100;
      if (gapPct >= minGapPct) {
        gaps.push({
          kind: 'gap-up',
          direction: 'bullish',
          lower: round(prev.h),
          upper: round(cur.l),
          createdIndex: i,
          time: cur.t,
          label: '向上裂口',
        });
      }
    }
    // 向下跳空：今高 < 昨低
    if (cur.h < prev.l) {
      const gapPct = ((prev.l - cur.h) / prev.l) * 100;
      if (gapPct >= minGapPct) {
        gaps.push({
          kind: 'gap-down',
          direction: 'bearish',
          lower: round(cur.h),
          upper: round(prev.l),
          createdIndex: i,
          time: cur.t,
          label: '向下裂口',
        });
      }
    }
  }

  /* ---- 回補狀態判定 ---- */
  for (const g of gaps) {
    let fillRatio = 0;      // 回補比例 0~1
    let fullyFilled = false;
    let filledAt = null;

    for (let j = g.createdIndex + 1; j < slice.length; j++) {
      const c = slice[j];
      const height = g.upper - g.lower;
      if (height <= 0) break;
      // 多頭缺口：價格向下進入區間即回補
      if (g.direction === 'bullish') {
        if (c.l <= g.lower) {
          fillRatio = 1; fullyFilled = true; filledAt = c.t; break;
        } else if (c.l < g.upper) {
          fillRatio = Math.max(fillRatio, (g.upper - c.l) / height);
        }
      } else {
        if (c.h >= g.upper) {
          fillRatio = 1; fullyFilled = true; filledAt = c.t; break;
        } else if (c.h > g.lower) {
          fillRatio = Math.max(fillRatio, (c.h - g.lower) / height);
        }
      }
    }

    g.fillRatio = round(fillRatio, 2);
    g.fullyFilled = fullyFilled;
    g.filledAt = filledAt;
    g.heightPct = round(((g.upper - g.lower) / g.lower) * 100, 2);
    g.barsAgo = slice.length - 1 - g.createdIndex;
    g.distPct = round(pctOf(price, (g.upper + g.lower) / 2), 2);

    // 是否有量能配合（缺口形成當根的量 / 區間均量）
    const avgV = slice.reduce((a, c) => a + (c.v || 0), 0) / slice.length;
    g.volRatio = avgV > 0 ? round((slice[g.createdIndex].v || 0) / avgV, 2) : null;
  }

  // 只保留「未完全回補」且「在現價附近」的缺口，新的優先
  const active = gaps
    .filter((g) => !g.fullyFilled)
    .sort((a, b) => b.createdIndex - a.createdIndex)
    .slice(0, maxKeep);

  // 已完全回補者另外統計（用來呈現「動能失敗」的歷史）
  const filled = gaps.filter((g) => g.fullyFilled);
  const filledRecently = filled
    .sort((a, b) => b.createdIndex - a.createdIndex)
    .slice(0, 3)
    .map((g) => ({
      label: g.label,
      lower: g.lower,
      upper: g.upper,
      filledAt: g.filledAt,
      barsAgo: g.barsAgo,
    }));

  if (!gaps.length) {
    return {
      available: true,
      price,
      totalFound: 0,
      active: [],
      filledRecently: [],
      nearest: null,
      message: `近 ${slice.length} 根 K 線內未偵測到幅度 ≥ ${minGapPct}% 的缺口或失衡區。`,
    };
  }

  // 最近的缺口（依與現價的距離）
  const nearest = active.length
    ? active.reduce((best, g) => (Math.abs(g.distPct) < Math.abs(best.distPct) ? g : best))
    : null;

  // 現價是否正處於某個未回補缺口內
  const inside = active.find((g) => price >= g.lower && price <= g.upper) || null;

  return {
    available: true,
    lookback: slice.length,
    price,
    minGapPct,
    totalFound: gaps.length,
    activeCount: active.length,
    filledCount: filled.length,
    active,
    filledRecently,
    nearest,
    inside,
    facts: {
      inGap: !!inside,
      aboveActiveBullish: active.some((g) => g.direction === 'bullish' && price > g.upper),
      belowActiveBearish: active.some((g) => g.direction === 'bearish' && price < g.lower),
    },
  };
}

/* ============================================================
   模組 4：期權 OI / GEX —— 機構對沖博弈
   ============================================================ */

/**
 * 計算單一合約的 Black-Scholes Gamma
 *
 * Gamma = N'(d1) / (S · σ · √T)
 * d1    = [ln(S/K) + (r + σ²/2)·T] / (σ·√T)
 *
 * Gamma 衡量「標的價格變動 1 元時，delta 變化多少」，
 * 是做市商對沖行為的核心：正 Gamma 時追漲殺跌被抑制（壓波動），
 * 負 Gamma 時對沖行為會放大波動。
 *
 * 注意：Gamma 只需要 S/K/T/σ，不需要 OI。所以 gamma 本身可以真實計算。
 */
function bsGamma(S, K, T, sigma, r = 0.045) {
  if (!isNum(S) || !isNum(K) || S <= 0 || K <= 0 || T <= 0 || !isNum(sigma) || sigma <= 0) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const g = normPdf(d1) / (S * sigma * sqrtT);
  return isNum(g) && g > 0 ? g : null;
}

/**
 * 建立期權 OI / GEX 分析
 *
 * ⚠️ 資料現實（這決定了本模組的設計）
 * ────────────────────────────────────
 * Yahoo Finance 的期權鏈端點（/v7/finance/options）目前回傳的
 * openInterest 全部為 0（實測 AAPL / NVDA / TSLA 皆如此），
 * volume 與部分 impliedVolatility 則仍是真實資料。
 *
 * 真正的 GEX 需要：OI × Gamma × 合約乘數 × 現價² × 0.01，
 * 其中 OI 是權重核心，缺了它就算不出真正的 dealer gamma exposure。
 *
 * 因此本模組採取誠實的雙軌設計：
 *   ‧ 有 OI → 計算真正的 GEX、Put Wall / Call Wall / Zero Gamma
 *   ‧ 無 OI → 以 volume 作為「活躍度權重」計算 VGEX（代理指標），
 *             並在回傳中明確標示 proxy: true 與原因，
 *             前端據此顯示「這是代理指標，非真 GEX」的警示。
 *   ‧ 無期權鏈（如港股）→ available: false + 明確說明與替代方案。
 *
 * 這樣使用者永遠知道自己在看什麼，不會把代理指標誤當成真 GEX。
 */
function buildGEX(optionChain, spot, opts = {}) {
  const now = opts.now || Date.now();

  if (!optionChain) {
    return {
      available: false,
      reason: '此標的無期權鏈資料。港股與部分小型股在 Yahoo 無期權市場。',
      hint: '可改用富途牛牛的「期權異動」頁籤，或 Unusual Whales / SpotGamma 查看完整 GEX。',
    };
  }

  const { calls = [], puts = [], expiration } = optionChain;
  const totalContracts = calls.length + puts.length;
  if (totalContracts === 0) {
    return {
      available: false,
      reason: '期權鏈為空，無法計算履約價分佈。',
      hint: '可至 Unusual Whales 或富途期權異動查看。',
    };
  }

  // 到期時間（年）
  const T = expiration ? Math.max(1 / 365, (expiration * 1000 - now) / (365 * 864e5)) : 30 / 365;
  const dte = Math.round(T * 365);

  // 判斷 OI 是否真的可用
  const oiTotal = [...calls, ...puts].reduce((a, c) => a + (c.openInterest || 0), 0);
  const hasOI = oiTotal > 0;
  const proxy = !hasOI;

  /**
   * 逐履約價聚合
   * 權重優先序：OI（真實）→ volume（代理）
   */
  const byStrike = new Map();
  const push = (row, side) => {
    const K = row.strike;
    if (!isNum(K)) return;
    if (!byStrike.has(K)) {
      byStrike.set(K, { strike: K, callOI: 0, putOI: 0, callVol: 0, putVol: 0, callGamma: null, putGamma: null });
    }
    const e = byStrike.get(K);
    const weightSrc = hasOI ? row.openInterest || 0 : row.volume || 0;
    if (side === 'call') {
      e.callOI = row.openInterest || 0;
      e.callVol = row.volume || 0;
      e.callWeight = weightSrc;
      e.callGamma = bsGamma(spot, K, T, row.impliedVolatility);
      e.callIv = row.impliedVolatility;
    } else {
      e.putOI = row.openInterest || 0;
      e.putVol = row.volume || 0;
      e.putWeight = weightSrc;
      e.putGamma = bsGamma(spot, K, T, row.impliedVolatility);
      e.putIv = row.impliedVolatility;
    }
  };
  calls.forEach((c) => push(c, 'call'));
  puts.forEach((p) => push(p, 'put'));

  const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike);

  // 有效 IV 的合約比例（判斷 gamma 可信度）
  const ivValid = rows.filter((r) => (r.callIv || 0) > 0.01 || (r.putIv || 0) > 0.01).length;
  const ivValidPct = rows.length ? (ivValid / rows.length) * 100 : 0;

  // 計算每檔的曝險（有 gamma 才計入）
  const contractSize = 100;
  for (const r of rows) {
    const cG = r.callGamma || 0;
    const pG = r.putGamma || 0;
    // 做市商視角：call 賣方為 short gamma（負），put 買方同理；
    // 標準 GEX 慣例：call OI 對 dealer 為正、put OI 為負
    const wC = hasOI ? r.callOI : r.callVol;
    const wP = hasOI ? r.putOI : r.putVol;
    r.callExposure = cG * wC * contractSize * spot * spot * 0.01;
    r.putExposure = -pG * wP * contractSize * spot * spot * 0.01;
    r.netExposure = r.callExposure + r.putExposure;
    r.totalWeight = wC + wP;
  }

  const withGamma = rows.filter((r) => r.callGamma != null || r.putGamma != null);
  if (!withGamma.length) {
    return {
      available: false,
      reason: '期權鏈缺少有效的隱含波動率（IV），無法計算 gamma。',
      hint: 'Yahoo 部分合約 IV 回傳接近 0 的無效值。可改用 Unusual Whales / SpotGamma。',
    };
  }

  // Put Wall / Call Wall：權重最大的履約價
  const putWallRow = rows.reduce((best, r) => {
    const w = hasOI ? r.putOI : r.putVol;
    const bw = best ? (hasOI ? best.putOI : best.putVol) : -1;
    return w > bw ? r : best;
  }, null);
  const callWallRow = rows.reduce((best, r) => {
    const w = hasOI ? r.callOI : r.callVol;
    const bw = best ? (hasOI ? best.callOI : best.callVol) : -1;
    return w > bw ? r : best;
  }, null);

  // Zero Gamma：累積 net exposure 由負轉正（或由正轉負）的履約價
  // 這是 GEX 分析中判別「壓波動 / 放大波動」環境的關鍵位
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  let cum = 0;
  let zeroGamma = null;
  let prevCum = null;
  for (const r of sorted) {
    prevCum = cum;
    cum += r.netExposure || 0;
    if (prevCum != null && prevCum < 0 && cum >= 0 && r.strike >= spot * 0.9) {
      zeroGamma = r.strike;
      break;
    }
  }
  const totalNetExposure = sorted.reduce((a, r) => a + (r.netExposure || 0), 0);
  const positiveGamma = totalNetExposure > 0;

  // 現價附近的 gamma 環境
  const nearRows = sorted.filter((r) => Math.abs(r.strike - spot) / spot <= 0.05);
  const nearNet = nearRows.reduce((a, r) => a + (r.netExposure || 0), 0);

  // 最大 Put Wall / Call Wall 距離
  const putWall = putWallRow ? putWallRow.strike : null;
  const callWall = callWallRow ? callWallRow.strike : null;

  // Put/Call 活躍度比
  const totalPutW = rows.reduce((a, r) => a + (hasOI ? r.putOI : r.putVol), 0);
  const totalCallW = rows.reduce((a, r) => a + (hasOI ? r.callOI : r.callVol), 0);
  const pcr = totalCallW > 0 ? totalPutW / totalCallW : null;

  // 前端圖表用：精簡的履約價分佈（只取現價 ±20% 以內，避免圖表過寬）
  const chartRows = sorted
    .filter((r) => Math.abs(r.strike - spot) / spot <= 0.2)
    .map((r) => ({
      strike: r.strike,
      callW: hasOI ? r.callOI : r.callVol,
      putW: hasOI ? r.putOI : r.putVol,
      netExposure: Math.round(r.netExposure || 0),
      isPutWall: r.strike === putWall,
      isCallWall: r.strike === callWall,
    }));

  return {
    available: true,
    proxy,                          // true = 用 volume 代替 OI
    proxyReason: proxy
      ? '上游（Yahoo）期權鏈的未平倉量（OI）全數回傳 0，因此以「成交量」作為活躍度權重計算 VGEX 代理指標。方向性判讀仍具參考價值，但數值不等同真實 GEX。'
      : null,
    spot: round(spot),
    expiration: expiration ? new Date(expiration * 1000).toISOString().slice(0, 10) : null,
    dte,
    contracts: { calls: calls.length, puts: puts.length },
    strikes: rows.length,
    ivValidPct: round(ivValidPct, 1),

    putWall: round(putWall),
    callWall: round(callWall),
    zeroGamma: round(zeroGamma),
    totalNetExposure: Math.round(totalNetExposure),
    positiveGamma,
    nearNetExposure: Math.round(nearNet),
    pcr: round(pcr, 2),

    putWallDistPct: round(pctOf(spot, putWall), 2),
    callWallDistPct: round(pctOf(spot, callWall), 2),
    zeroGammaDistPct: round(pctOf(spot, zeroGamma), 2),

    chartRows,
    topStrikes: sorted
      .slice()
      .sort((a, b) => (b.totalWeight || 0) - (a.totalWeight || 0))
      .slice(0, 5)
      .map((r) => ({ strike: r.strike, weight: hasOI ? r.putOI + r.callOI : r.putVol + r.callVol })),

    facts: {
      aboveZeroGamma: zeroGamma != null ? spot > zeroGamma : null,
      nearPutWall: putWall != null ? Math.abs(pctOf(spot, putWall) ?? 999) <= 3 : false,
      belowZeroGamma: zeroGamma != null ? spot < zeroGamma : null,
    },
  };
}

module.exports = {
  buildVolumeProfile,
  buildAnchoredVWAP,
  buildFVG,
  buildGEX,
  // 匯出以供測試
  bsGamma,
  normPdf,
  normCdf,
};
