'use strict';

/**
 * 利率期貨隱含路徑（未來 8 個季度）
 * ==================================
 *
 * 這個模組回答一個問題：**市場現在對未來兩年的政策利率定價是多少？**
 *
 * ---------------------------------------------------------------------------
 * 為什麼是「期貨隱含」而不是「預測」
 * ---------------------------------------------------------------------------
 * Fed 官方不公布未來利率路徑——點陣圖（dot plot）是與會者的匿名預測，
 * 不是委員會的決議（見 lib/fomc.js 的 forecastNote）。因此任何「預測」
 * 若要可追溯，唯一紮實的來源就是**市場自己交易的價格**。
 *
 * 所以本模組不做迴歸、不做外插、不猜測。它只做一件事：
 *   把市場上真實成交的期貨價格，換算成隱含利率，按季排成一條曲線。
 * 每一個點都能回查「哪一張合約、什麼價格、換算式是什麼」。
 *
 * ---------------------------------------------------------------------------
 * 為什麼用 SOFR 期貨（SR3）而不是 Fed Funds 期貨（ZQ）
 * ---------------------------------------------------------------------------
 * 實測（2026-11-27 快照）：
 *
 *   ZQZ26.CBT  4.055     ZQH27.CBT  4.370    ZQM27.CBT  4.565
 *   ZQU27.CBT  4.580     ZQZ27.CBT  4.495    ZQH28.CBT  404（不存在）
 *   ZQM28.CBT  404        ZQU28.CBT  404      ZQZ28.CBT  404
 *
 *   → 30 天 Fed Funds 期貨在 Yahoo 只報到 2027-12，且**成交量極低**
 *     （ZQZ27 當日 158 口）。用它做 8 季預測，後 4 季會全部缺值。
 *
 *   SR3Z26.CME  4.272    SR3H27.CME  4.530    SR3M27.CME  4.635
 *   SR3U27.CME  4.620    SR3Z27.CME  4.540    SR3H28.CME  4.440
 *   SR3M28.CME  4.375    SR3U28.CME  4.330    SR3Z28.CME  4.310
 *   → 3 個月 SOFR 期貨 9 張全部有價，成交量 5–10 萬口，涵蓋到 2028-12。
 *
 * 兩者在重疊季度上互相印證（SOFR 比 Fed Funds 高 16–22 bp），
 * 差值方向一致且量級合理（SOFR 為有擔保隔夜利率，通常略高於 EFFR）。
 * 這代表拿到的不是插值出來的假曲線，而是真實的市場定價。
 *
 * ---------------------------------------------------------------------------
 * 合約月份 → 季度標籤（最容易搞錯的地方）
 * ---------------------------------------------------------------------------
 * CME 3 個月 SOFR 期貨的結算參考期，是**從合約月份的第三個星期三起算三個月**：
 *   SR3H27（2027-03）→ 參考期約 2027-03-17 ~ 2027-06-16
 * 也就是說「3 月合約」定價的其實主要是第 2 季，不是第 1 季。
 *
 * 若直接拿合約月份當季度標籤，整條曲線會錯位一季——而且錯得很隱蔽，
 * 因為數字本身看起來完全正常。
 *
 * 本模組的處理：以參考期中點所屬的季為標籤（12 月合約 → 次年 Q1，
 * 3 月 → Q2，6 月 → Q3，9 月 → Q4），並在每個點保留
 * `referencePeriod` 明確寫出參考期，讓使用者能自行核對。
 *
 * ---------------------------------------------------------------------------
 * 報價慣例
 * ---------------------------------------------------------------------------
 * 利率期貨用「100 − 價格」表示殖利率：
 *   價格 95.470 → 隱含利率 4.530%
 * 這是 CME 的標準慣例，不是本專案自創。模組會在輸出中帶上
 * `formula` 欄位說明，避免使用者以為 95.47% 是利率。
 */

const yahoo = require('./yahoo');
const fred = require('./fred');

/* ============================================================
   契約與常數
   ============================================================ */

/** 季度合約月份（3/6/9/12）。H=Mar, M=Jun, U=Sep, Z=Dec */
const QUARTER_MONTHS = [3, 6, 9, 12];
const MONTH_CODE = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' };

/** 預設預測季數 */
const DEFAULT_QUARTERS = 8;

/** Yahoo 的報價是延遲的；不宣稱即時，只寫「盤中延遲」並附抓取時間 */
const QUOTE_TTL = 5 * 60 * 1000;

const cache = new Map();
function cacheGet(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(k); return null; }
  return hit.value;
}
function cacheSet(k, v) { cache.set(k, { value: v, expires: Date.now() + QUOTE_TTL }); }

/* ============================================================
   日期工具（全部用 UTC，避免時區把「今天」算成不同天）
   ============================================================ */

/** 今天的 UTC 日期 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** 某日所屬的季度（1–4）與年份 */
function quarterOf(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return { year: y, q: Math.ceil(m / 3) };
}

/** 季度 → 該季第一天（ISO） */
function quarterStart(year, q) {
  return `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
}

/** 季度標籤 e.g. 2027Q1 */
function qLabel(year, q) {
  return `${year}Q${q}`;
}

/** 把季度往前推 n 季 */
function addQuarters(year, q, n) {
  const idx = year * 4 + (q - 1) + n;
  return { year: Math.floor(idx / 4), q: (idx % 4) + 1 };
}

/**
 * 合約月份 → 參考期中點所屬季度。
 *
 * 3M SOFR 期貨的參考期 = 合約月第三個星期三起算三個月，
 * 中點約在合約月 + 2 個月（3→5月→Q2、6→8月→Q3、9→11月→Q4、12→次年2月→Q1）。
 */
function quarterOfContract(contractYear, contractMonth) {
  const mid = contractMonth + 2;
  if (mid > 12) return { year: contractYear + 1, q: Math.ceil((mid - 12) / 3) };
  return { year: contractYear, q: Math.ceil(mid / 3) };
}

/** 由季度回推合約月份（quarterOfContract 的反函數） */
function contractMonthOfQuarter(year, q) {
  // 參考期中點落在該季 → 合約月 = 該季第一個月 + 2
  //   Q1 ← 12 月（前一年）; Q2 ← 3 月; Q3 ← 6 月; Q4 ← 9 月
  // 驗算：Q2 的參考期 3/17–6/16，中點約 5/1，屬 Q2 ✓
  if (q === 1) return { year: year - 1, month: 12 };
  return { year, month: (q - 1) * 3 };
}

/** 合約代碼 e.g. SR3H27 */
function contractSymbol(contractYear, contractMonth) {
  const code = MONTH_CODE[contractMonth];
  return `SR3${code}${String(contractYear % 100).padStart(2, '0')}.CME`;
}

/** 參考期文字（估算；實際以 CME 公告為準） */
function referencePeriod(contractYear, contractMonth) {
  const startMonth = contractMonth;
  const endMonth = contractMonth + 3;
  const endYear = endMonth > 12 ? contractYear + 1 : contractYear;
  const em = endMonth > 12 ? endMonth - 12 : endMonth;
  return `${contractYear}-${String(startMonth).padStart(2, '0')} 第三個星期三起至 `
    + `${endYear}-${String(em).padStart(2, '0')} 第三個星期三`;
}

/* ============================================================
   抓取單一合約
   ============================================================ */

/**
 * 取單一合約的最新價與前一日收盤。
 * 任何失敗都回 {ok:false}，**不拋錯**——單一合約 404 不該讓整個模組掛掉。
 */
async function fetchContract(symbol, opts) {
  const force = !!(opts && opts.force);
  if (!force) {
    const hit = cacheGet('c:' + symbol);
    if (hit) return hit;
  }

  try {
    const r = await yahoo.chart(symbol, '1mo', '1d');
    const cs = (r && r.candles) || [];
    if (!cs.length) {
      return { ok: false, symbol, reason: '上游沒有回傳任何報價' };
    }

    const last = cs[cs.length - 1];
    const prev = cs.length > 1 ? cs[cs.length - 2] : null;
    const meta = r.meta || {};

    const price = last.c;
    if (typeof price !== 'number' || !isFinite(price)) {
      return { ok: false, symbol, reason: '最後一筆收盤價不是有效數字' };
    }

    const out = {
      ok: true,
      symbol,
      name: meta.shortName || meta.longName || symbol,
      price: +price.toFixed(4),
      impliedRate: +(100 - price).toFixed(4),
      asOf: new Date(last.t).toISOString().slice(0, 10),
      prevClose: prev && typeof prev.c === 'number' ? +prev.c.toFixed(4) : null,
      dayChange: prev && typeof prev.c === 'number' ? +(price - prev.c).toFixed(4) : null,
      volume: typeof last.v === 'number' ? last.v : null,
      sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    };
    cacheSet('c:' + symbol, out);
    return out;
  } catch (e) {
    return { ok: false, symbol, reason: e.message, code: e.code || null };
  }
}

/* ============================================================
   主函式
   ============================================================ */

/**
 * 建立未來 N 個季度的期貨隱含利率路徑。
 *
 * @param {{quarters?:number, force?:boolean}} [opts]
 * @returns {Promise<object>}
 */
async function getRateForecast(opts) {
  const o = opts || {};
  const n = Math.max(1, Math.min(Number(o.quarters) || DEFAULT_QUARTERS, 12));

  const today = todayUtc();
  const cur = quarterOf(today);

  /* ---- 1. 決定要取哪 N 個季度（從「下一季」起算，不含當前季）---- */
  const targets = [];
  for (let i = 1; i <= n; i++) {
    const t = addQuarters(cur.year, cur.q, i);
    const cm = contractMonthOfQuarter(t.year, t.q);
    targets.push({
      year: t.year,
      q: t.q,
      label: qLabel(t.year, t.q),
      contractYear: cm.year,
      contractMonth: cm.month,
      index: i,
    });
  }

  /* ---- 2. 並行取所有合約 + 現貨錨點 + 政策利率 ---- */
  const spotSymbol = 'ZQ=F';
  const contractP = Promise.all(targets.map((t) => {
    const sym = contractSymbol(t.contractYear, t.contractMonth);
    return fetchContract(sym, o).then((r) => ({ ...r, symbol: sym }));
  }));

  const [contracts, spotZq, fedUpper, fedLower, sofr] = await Promise.all([
    contractP,
    fetchContract(spotSymbol, o),
    fred.getSeries('fedTargetUpper').catch(() => null),
    fred.getSeries('fedTargetLower').catch(() => null),
    // SOFR 未在 fred.SERIES 註冊表內，直接用 fetchSeries（它是本模組的定價基準）
    fred.fetchSeriesMemo('SOFR', o).catch(() => null),
  ]);

  /* ---- 3. 組出每個季度的點 ---- */
  const points = targets.map((t, i) => {
    const c = contracts[i] || { ok: false };
    return {
      index: t.index,
      quarter: t.label,
      year: t.year,
      q: t.q,
      periodStart: quarterStart(t.year, t.q),
      contract: c.symbol,
      contractName: c.name || null,
      referencePeriod: referencePeriod(t.contractYear, t.contractMonth),
      available: !!c.ok,
      price: c.ok ? c.price : null,
      impliedRate: c.ok ? c.impliedRate : null,
      asOf: c.ok ? c.asOf : null,
      prevClose: c.ok ? c.prevClose : null,
      dayChange: c.ok ? c.dayChange : null,
      volume: c.ok ? c.volume : null,
      sourceUrl: c.ok ? c.sourceUrl : null,
      // 先宣告為 null，不可留 undefined：前端把 undefined 當數字算會得到 NaN，
      // 而 JSON 序列化時 undefined 會被整個丟掉，契約就破了。
      vsAnchorBp: null,
      vsAnchorPct: null,
      reason: c.ok ? null : (c.reason || '無法取得報價'),
    };
  });

  /* ---- 4. 現貨錨點 ---- */
  const policyUpper = fedUpper && fedUpper.available ? fedUpper.value : null;
  const policyLower = fedLower && fedLower.available ? fedLower.value : null;
  const policyMid = policyUpper != null && policyLower != null
    ? +(((policyUpper + policyLower) / 2)).toFixed(4) : null;
  const sofrLast = (() => {
    if (!sofr || !sofr.ok || !sofr.points || !sofr.points.length) return null;
    const p = sofr.points[sofr.points.length - 1];
    return { value: +p.value.toFixed(4), asOf: p.date };
  })();

  const zqImplied = spotZq && spotZq.ok ? spotZq.impliedRate : null;

  /* 基準利率：優先序
       1. SOFR 現值 —— 與 SR3 期貨同一個標的，比較最有意義
       2. 30 天 Fed Funds 期貨隱含值 —— 有市場定價但屬另一標的
       3. 政策利率中點 —— 一定拿得到，但比市場定價落後
     一定要記錄用了哪一個，否則「較基準上升 22 bp」無法查核。 */
  let anchor = null;
  let anchorKind = null;
  if (sofrLast) { anchor = sofrLast.value; anchorKind = 'SOFR'; }
  else if (zqImplied != null) { anchor = zqImplied; anchorKind = 'ZQ_IMPLIED'; }
  else if (policyMid != null) { anchor = policyMid; anchorKind = 'POLICY_MID'; }

  /* ---- 5. 相對基準的變化（bp）---- */
  if (anchor != null) {
    for (const p of points) {
      if (!p.available || p.impliedRate == null) continue;
      p.vsAnchorBp = Math.round((p.impliedRate - anchor) * 100);
      p.vsAnchorPct = +((p.impliedRate - anchor)).toFixed(4);
    }
  }

  /* ---- 6. 路徑摘要（只陳述市場定價，不做判斷）---- */
  const usable = points.filter((p) => p.available && p.impliedRate != null);
  const path = (() => {
    if (!usable.length) {
      return {
        available: false,
        reason: '本次未取得任何有效報價，無法計算路徑',
        direction: null,
        totalBp: null,
        peak: null,
        trough: null,
      };
    }

    const first = usable[0];
    const last = usable[usable.length - 1];
    const totalBp = (first.impliedRate != null && last.impliedRate != null)
      ? Math.round((last.impliedRate - first.impliedRate) * 100) : null;

    let peak = usable[0];
    let trough = usable[0];
    for (const p of usable) {
      if (p.impliedRate > peak.impliedRate) peak = p;
      if (p.impliedRate < trough.impliedRate) trough = p;
    }

    let direction = 'flat';
    if (totalBp != null) {
      if (totalBp >= 5) direction = 'up';
      else if (totalBp <= -5) direction = 'down';
    }

    // 25 bp 為一次典型政策調整的步伐（不是必然，Fed 也做過 50/75 bp）
    const impliedMoves25bp = totalBp == null ? null : Math.round(totalBp / 25);

    return {
      available: true,
      direction,
      totalBp,
      impliedMoves25bp,
      firstQuarter: first.quarter,
      lastQuarter: last.quarter,
      firstRate: first.impliedRate,
      lastRate: last.impliedRate,
      peak: { quarter: peak.quarter, rate: peak.impliedRate, contract: peak.contract },
      trough: { quarter: trough.quarter, rate: trough.impliedRate, contract: trough.contract },
      covered: usable.length,
      missing: points.length - usable.length,
    };
  })();

  /* ---- 7. 時間範圍 ---- */
  const timeRange = {
    from: points.length ? points[0].quarter : null,
    to: points.length ? points[points.length - 1].quarter : null,
    fromPeriod: points.length ? points[0].periodStart : null,
    toPeriod: points.length
      ? (() => {
        // 最後一季的結束日 = 該季最後一天
        const lp = points[points.length - 1];
        const endMonth = lp.q * 3;
        const d = new Date(Date.UTC(lp.year, endMonth, 0));
        return d.toISOString().slice(0, 10);
      })()
      : null,
    quarters: points.length,
    asOf: today,
  };

  return {
    ok: true,
    scope: 'rates-forecast',
    generatedAt: new Date().toISOString(),

    // 預測結果
    points,
    path,

    // 基準（當前市場利率）
    anchor: {
      kind: anchorKind,
      value: anchor,
      label: anchorKind === 'SOFR' ? 'SOFR 隔夜擔保融資利率'
        : anchorKind === 'ZQ_IMPLIED' ? '30 天聯邦基金期貨隱含利率'
          : anchorKind === 'POLICY_MID' ? '政策利率區間中點' : '無法取得',
      asOf: anchorKind === 'SOFR' ? sofrLast.asOf
        : anchorKind === 'ZQ_IMPLIED' ? (spotZq && spotZq.asOf) : null,
    },

    // 當前政策利率與現值
    spot: {
      policyUpper,
      policyLower,
      policyMid,
      policyAsOf: fedUpper && fedUpper.available ? fedUpper.asOf : null,
      sofr: sofrLast ? sofrLast.value : null,
      sofrAsOf: sofrLast ? sofrLast.asOf : null,
      zqSymbol: spotSymbol,
      zqPrice: spotZq && spotZq.ok ? spotZq.price : null,
      zqImplied,
      zqAsOf: spotZq && spotZq.ok ? spotZq.asOf : null,
    },

    // 時間範圍（使用者要求：必須顯示）
    timeRange,

    // 更新頻率（使用者要求：必須顯示）
    updateFrequency: {
      quote: '盤中延遲報價（Yahoo Finance，通常延遲約 10–15 分鐘）',
      quoteTtlMinutes: QUOTE_TTL / 60000,
      contractRoll: '季度合約到期後自動換到下一張（每次請求依當日日期重算）',
      policyRate: '僅在 FOMC 決議後變動（來源 FRED，日頻）',
      note: '本模組不快取過夜：每次請求最多重用 5 分鐘內的報價。',
    },

    // 資料來源（使用者要求：必須顯示）
    sources: [
      {
        name: 'CME 3 個月 SOFR 期貨（SR3）',
        via: 'Yahoo Finance',
        usage: '未來 8 季隱含利率',
        url: 'https://www.cmegroup.com/markets/interest-rates/stirs/three-month-sofr.html',
        auth: '免 Key',
        delayed: true,
      },
      {
        name: '30 天聯邦基金期貨（ZQ=F）',
        via: 'Yahoo Finance',
        usage: '當前市場對近期政策利率的定價（交叉驗證）',
        url: 'https://finance.yahoo.com/quote/ZQ%3DF',
        auth: '免 Key',
        delayed: true,
      },
      {
        name: 'FRED — SOFR（Secured Overnight Financing Rate）',
        via: 'FRED',
        usage: '期貨定價的基準現值',
        url: 'https://fred.stlouisfed.org/series/SOFR',
        auth: '免 Key',
        delayed: false,
      },
      {
        name: 'FRED — DFEDTARU / DFEDTARL',
        via: 'FRED',
        usage: '當前政策利率區間',
        url: 'https://fred.stlouisfed.org/series/DFEDTARU',
        auth: '免 Key',
        delayed: false,
      },
    ],

    // 可追溯性：每一點都能回查
    traceability: {
      formula: '隱含利率（%）= 100 − 期貨價格',
      formulaNote: 'CME 利率期貨的標準報價慣例；價格 95.470 對應 4.530%，不是 95.47%。',
      perPoint: [
        'contract：期貨合約代碼（可直接在上游查價）',
        'price：該合約最新成交價',
        'impliedRate：100 − price',
        'asOf：報價所屬交易日',
        'referencePeriod：該合約的結算參考期',
        'sourceUrl：可直接點開核對的行情頁',
      ],
      anchorRule: '與基準的比較一律使用 anchor.kind 指出的來源；混合不同標的比較會產生不可解釋的基差。',
    },

    limitations: [
      '這是市場定價，不是預測模型：期貨隱含利率反映的是「現在的價格」，會隨消息與流動性每日變動。',
      'SR3 期貨以 SOFR 為標的，SOFR 通常略高於 EFFR（有擔保 vs 無擔保）；與政策利率中點直接相減會含約 5–15 bp 的基差。',
      '季度標籤取「參考期中點所屬季」，因此 12 月合約對應次年 Q1、3 月合約對應 Q2；實際參考期已逐點列在 referencePeriod。',
      '遠月合約流動性較低，價格可能在單日出現數個基點的跳動，不代表預期改變。',
      '期貨隱含利率不含期限溢價與風險溢價，不能直接當成未來的實際利率。',
      '報價為延遲資料，不適合用於即時交易決策。',
    ],
  };
}

module.exports = {
  getRateForecast,
  fetchContract,
  // 供測試使用的純函式
  quarterOf,
  quarterOfContract,
  contractMonthOfQuarter,
  contractSymbol,
  referencePeriod,
  addQuarters,
  quarterStart,
  qLabel,
  QUARTER_MONTHS,
  DEFAULT_QUARTERS,
};
