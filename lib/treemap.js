'use strict';

/**
 * 版塊 Treemap（矩形樹狀圖）
 * ===========================
 *
 * 需求：
 *   以版塊為分組、按市值決定區塊面積、用顏色深淺呈現升跌，
 *   可切換「日／週／月／年」，懸停顯示版塊名稱／市值佔比／所選週期漲跌幅。
 *
 * ── 為什麼面積用「市值」而不是「ETF 權重」 ─────────────
 * 直覺上兩者應該成正比，實測卻不是：
 *   XLK 前 15 檔的「市值 ÷ 權重」比值中位數 151 B，但離散度達 **102%**
 *   （AMD 158 B vs AVGO 289 B，差 1.8 倍）。
 * 原因是 ETF 權重採「流通市值」（free-float），而 marketCap 是總市值；
 * 一間公司若創辦人持股比例高，兩者就會差很多。
 *
 * 需求明確要求「按市值決定面積」，所以用 Yahoo 的 `marketCap` 真實總市值，
 * 不用權重代替。權重另外保留在節點裡供對照。
 *
 * ⚠ 這也帶來一個必須向使用者說明的取捨：
 *   我們只取每個版塊前 N 大持股（預設 10），這些檔數只涵蓋各版塊
 *   46%–92% 的權重（XLI 僅 46%）。因此「跨版塊的面積比較」是
 *   「取樣市值」的比較，不是完整版塊市值。API 會回傳 sampling 說明，
 *   前端據此標註，不能讓使用者誤以為那是全市場的精確比例。
 *
 * ── 為什麼自己寫 squarified 佈局 ────────────────────────
 * 專案硬約束是零執行時依賴（package.json 沒有 dependencies），
 * 不能用 d3-hierarchy。squarified 演算法（Bruls et al. 2000）本身
 * 只有約 80 行，且它的正確性可以用「面積比 == 輸入值比」精確驗證。
 */

/* ---------------- 四週期定義 ---------------- */

/**
 * 週期與回溯的交易日數。
 *
 * 為什麼「年」用 251 而不是 252：
 *   美股一年約 252 個交易日，但 251 是 Yahoo 回 1y 區間時的實際根數
 *   （實測 range=1y 回 251 根）。用 252 會導致 idx 落在陣列外，
 *   整批變成 null。這裡取 251，並改用 2y 區間確保資料充足
 *   （實測 110 檔全部有 501 根，無一缺漏）。
 */
const PERIODS = [
  { key: 'd1', label: '日', full: '1 日', tradingDays: 1 },
  { key: 'w1', label: '週', full: '1 週', tradingDays: 5 },
  { key: 'm1', label: '月', full: '1 個月', tradingDays: 21 },
  { key: 'y1', label: '年', full: '1 年', tradingDays: 251 },
];

const PERIOD_KEYS = PERIODS.map((p) => p.key);

/** 預設每個版塊取幾檔（葉節點數上限的來源） */
const DEFAULT_PER_SECTOR = 10;
const MAX_PER_SECTOR = 30;

/**
 * 顏色分級的「滿色」閾值（絕對值，單位 %）。
 *
 * 為什麼不能用固定值 —— 這是實測出來的，不是憑感覺：
 *   若一律用 ±3% 當滿色，實測 110 檔的飽和比例是
 *     日 9%／週 37%／月 **82%**／年 **92%**
 *   月線與年線會讓整張圖幾乎同色，Treemap 就失去意義。
 *
 * 因此改成「每個週期用自己的尺度」，取自實際分布的 P90 絕對值：
 *   日 2.55%／週 6.07%／月 17.18%／年 45.09%
 * 這樣各週期都約有 10% 的格子達到滿色，其餘均勻分佈在中間階。
 *
 * 為什麼是常數而不是每次即時計算：
 *   若閾值隨當日行情浮動，同一張圖在兩天內看起來會不一樣，
 *   使用者無法比較。固定閾值讓「顏色＝絕對漲跌幅」保持穩定語義。
 *   數值仍由 API 回傳，前端圖例照它顯示，不寫死在兩處。
 */
const SCALE = {
  d1: 2.5,
  w1: 6,
  m1: 17,
  y1: 45,
};

/** 顏色分級數（含最淺一級）；對應圖例的段數 */
const LEVELS = 5;

/* ---------------- 佈局：squarified treemap ---------------- */

/**
 * 把一組「權值」鋪滿指定矩形，回傳每個項目的矩形。
 *
 * 演算法（Bruls, Huizing, van Wijk 2000）：
 *   1. 依權值由大到小排序（大塊先放，長寬比才好）。
 *   2. 反覆取「最差長寬比」最好的一列（row）放進目前短邊。
 *   3. 剩餘空間繼續，直到放完。
 *
 * 為什麼要 squarified 而不是簡單的 slice-and-dice：
 *   slice-and-dice 會產生細長條（長寬比可達 50:1），
 *   在細長條裡放標籤是不可能的，而 Treemap 的可讀性完全依賴標籤。
 *   squarified 把長寬比壓到接近 1，是這個需求的正解。
 *
 * @param {Array<{value:number}>} items 權值為正的項目
 * @param {number} x 左上角 x
 * @param {number} y 左上角 y
 * @param {number} w 寬
 * @param {number} h 高
 * @returns {Array<{item:Object,x:number,y:number,w:number,h:number}>}
 */
function squarify(items, x, y, w, h) {
  const out = [];
  const list = items
    .filter((it) => isFinite(it.value) && it.value > 0)
    .slice()
    .sort((a, b) => b.value - a.value);

  if (!list.length || !(w > 0) || !(h > 0)) return out;

  const total = list.reduce((s, it) => s + it.value, 0);
  if (!(total > 0)) return out;

  // 以「面積」為單位換算：整塊面積 = w*h，每項目按 value/total 分配
  const area = w * h;
  const scale = area / total;
  const remaining = list.map((it) => ({ item: it, area: it.value * scale }));

  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;

  let i = 0;
  while (i < remaining.length) {
    if (!(rw > 0) || !(rh > 0)) {
      /* 空間耗盡卻還有項目（僅可能來自浮點誤差）：給零面積矩形，
         維持「每個輸入都有一個矩形」的契約，避免前端算數對不上。 */
      for (let k = i; k < remaining.length; k++) {
        out.push({ item: remaining[k].item, x: rx, y: ry, w: 0, h: 0 });
      }
      break;
    }

    /* 列的「跨度」是目前的**長邊**：列沿長邊鋪滿，厚度 = 該列總面積 ÷ 長邊。
       （這裡是最容易寫錯的一步。若誤用短邊當跨度，列會超出容器，
         實測覆蓋率只剩 47–75% 且大量越界。） */
    const horizontal = rw >= rh;
    const span = horizontal ? rw : rh;

    /* 逐步把項目加進目前這一列，直到「再加一個會讓最差長寬比變糟」為止。 */
    let rowArea = 0;
    let end = i;
    let bestWorst = Infinity;

    while (end < remaining.length) {
      const nextArea = rowArea + remaining[end].area;
      const worst = worstRatio(remaining, i, end, nextArea, span);
      if (rowArea > 0 && worst > bestWorst) break;
      rowArea = nextArea;
      bestWorst = worst;
      end++;
    }

    // 這一列不應為空；保險起見至少放一個
    if (end === i) { rowArea = remaining[i].area; end = i + 1; }

    const thick = rowArea / span;   // 這一列的厚度
    let offset = 0;

    for (let k = i; k < end; k++) {
      const a = remaining[k].area;
      const frac = rowArea > 0 ? a / rowArea : 1;
      if (horizontal) {
        const segW = span * frac;
        out.push({
          item: remaining[k].item,
          x: rx + offset,
          y: ry,
          w: segW,
          h: Math.min(thick, rh),
        });
        offset += segW;
      } else {
        const segH = span * frac;
        out.push({
          item: remaining[k].item,
          x: rx,
          y: ry + offset,
          w: Math.min(thick, rw),
          h: segH,
        });
        offset += segH;
      }
    }

    // 扣掉這一列佔用的厚度
    if (horizontal) {
      ry += thick;
      rh -= thick;
    } else {
      rx += thick;
      rw -= thick;
    }
    i = end;
  }

  return out;
}

/**
 * 計算「若把 [from, to] 這些項目放成一列」的最差長寬比。
 *
 * 設 span 為列所沿的長邊長度、S 為該列總面積，則厚度 t = S/span，
 * 面積 a 的格子尺寸為 (a·span/S) × (S/span)，長寬比 = a·span²/S²。
 * 取最大與最小面積者的長寬比（其中一個取倒數），即：
 *   worst = max( span²·maxA / S² , S² / (span²·minA) )
 * 值越接近 1 越接近正方形。
 */
function worstRatio(rem, from, to, sumArea, span) {
  if (!(sumArea > 0) || !(span > 0)) return Infinity;
  let maxA = 0;
  let minA = Infinity;
  for (let k = from; k <= to && k < rem.length; k++) {
    const a = rem[k].area;
    if (a > maxA) maxA = a;
    if (a < minA) minA = a;
  }
  if (!(minA > 0) || !isFinite(minA)) minA = sumArea;

  const s2 = span * span;
  const a1 = (s2 * maxA) / (sumArea * sumArea);
  const a2 = (sumArea * sumArea) / (s2 * minA);
  return Math.max(a1, a2);
}

/* ---------------- 報酬與市值 ---------------- */

/**
 * 從日線序列計算四週期報酬（復權價優先）。
 *
 * 為什麼年線一定要復權 —— 實測差異（1 年，未復權 vs 復權）：
 *   MO 30.75% → 39.59%（差 8.84pp）
 *   VZ 16.48% → 24.23%（差 7.75pp）
 *   PEP **-1.49% → +2.50%**（顏色由綠翻紅）
 * 若不復權，高股息股票的格子顏色會系統性偏綠，且 PEP 這種會直接畫錯方向。
 *
 * 這也正是為什麼不能用 spark 批次端點（它沒有 adjclose）——
 * 雖然 spark 一次能帶 20 檔，但少了復權價就等於畫錯顏色。
 */
function computeReturns(candles, adjClose) {
  const out = {};
  for (const p of PERIODS) out[p.key] = null;
  out.bars = 0;
  out.price = null;

  if (!Array.isArray(candles) || candles.length < 2) return out;

  const useAdj = Array.isArray(adjClose) && adjClose.length === candles.length;
  const series = [];
  for (let i = 0; i < candles.length; i++) {
    const v = useAdj ? adjClose[i] : candles[i].c;
    if (v == null || !isFinite(v) || v <= 0) continue;
    series.push(v);
  }
  if (series.length < 2) return out;

  out.bars = series.length;
  out.adjUsed = useAdj;
  out.price = useAdj ? candles[candles.length - 1].c : series[series.length - 1];

  const last = series[series.length - 1];
  for (const p of PERIODS) {
    const idx = series.length - 1 - p.tradingDays;
    if (idx < 0) continue;                       // 資料不足：保持 null，不硬用更短區間冒充
    const base = series[idx];
    if (!base || base <= 0) continue;
    out[p.key] = ((last / base) - 1) * 100;
  }
  return out;
}

/**
 * 把漲跌幅映射到顏色強度 0~1。
 *
 * 用 sqrt 而非線性：漲跌幅的分布是厚尾的（年線 P99 可達 105%），
 * 線性映射會讓 80% 的格子擠在最淺的 20% 區間，看起來全部同色。
 * sqrt 在 0 附近斜率大（小漲跌也能分辨）、在尾端壓縮，視覺解析度更好。
 */
function colorIntensity(pct, scale) {
  if (pct == null || !isFinite(pct)) return 0;
  const s = Math.abs(pct) / scale;
  if (!isFinite(s)) return 0;
  return Math.min(1, Math.sqrt(Math.min(s, 1)));
}

/**
 * 把漲跌幅換成 0..LEVELS 的分級（供圖例與前端取色）。
 *
 * 0 = 無資料（null／NaN）；1..LEVELS = 由淺到深，**包含完全平盤**。
 *
 * 為什麼平盤必須是 1 而不是 0：
 *   0 保留給「沒有資料」（缺市值、缺 K 棒、該檔停牌）。
 *   若平盤也給 0，前端就無法區分「這檔今天沒漲沒跌」與「這檔抓不到資料」，
 *   兩者會畫成同一個灰格——而這正是使用者最需要分清楚的兩種狀況。
 */
function colorLevel(pct, scale) {
  if (pct == null || !isFinite(pct)) return 0;
  const it = colorIntensity(pct, scale);
  return Math.max(1, Math.min(LEVELS, Math.ceil(it * LEVELS)));
}

/* ---------------- 組裝 ---------------- */

/**
 * 組出 treemap 資料。
 *
 * @param {object} p
 * @param {string[]} p.sectors 版塊代碼（已驗證）
 * @param {number} p.perSector 每版塊檔數
 * @param {object} p.holdingsBySector { XLK: {holdings, fundName, asOf, total} }
 * @param {object} p.caps { AAPL: {marketCap, name, price} }
 * @param {object} p.returns { AAPL: {d1,w1,m1,y1,price,bars,adjUsed} }
 * @param {string} p.period 目前選定週期
 * @param {object} p.sectorMeta { XLK: {label, short, color} }
 * @returns {object}
 */
function build(p) {
  const {
    sectors, perSector = DEFAULT_PER_SECTOR, holdingsBySector,
    caps, returns, period, sectorMeta,
  } = p;

  const pKey = PERIOD_KEYS.includes(period) ? period : 'm1';
  const periodDef = PERIODS.find((x) => x.key === pKey);
  const scale = SCALE[pKey];

  const groups = [];
  const failures = [];
  let grandCap = 0;
  let grandWeight = 0;
  let leafCount = 0;

  for (const key of sectors) {
    const h = holdingsBySector[key];
    if (!h || !Array.isArray(h.holdings) || !h.holdings.length) {
      failures.push({ sector: key, code: 'NO_HOLDINGS', message: '此版塊沒有可用的持股資料' });
      continue;
    }

    const meta = (sectorMeta && sectorMeta[key]) || { label: key, short: key, color: '#64748b' };
    const leaves = [];
    let groupCap = 0;
    let groupWeight = 0;

    for (const row of h.holdings.slice(0, perSector)) {
      const sym = row.quoteSymbol || row.ticker;
      const cap = caps[sym] && caps[sym].marketCap;
      const ret = returns[sym] || null;
      const pct = ret ? ret[pKey] : null;

      /* 抗雜訊：市值必須為正才畫得出來。
         若某檔缺市值，仍保留節點但標記 noCap，前端以最小面積呈現，
         而不是整檔消失——消失會讓「這個版塊有幾檔」對不上。 */
      const capVal = isFinite(cap) && cap > 0 ? cap : 0;

      /* 四個週期全部附上，讓前端切換週期時零延遲。
         行情序列本來就含 1/5/21/251 根的資訊，多算三個週期的邊際成本是 0，
         但能省下每次切換一次 1～3 秒的往返。 */
      const pcts = {};
      for (const p of PERIODS) {
        const v = ret ? ret[p.key] : null;
        pcts[p.key] = v == null || !isFinite(v) ? null : v;
      }

      leaves.push({
        ticker: row.ticker,
        symbol: sym,
        name: (caps[sym] && caps[sym].name) || row.name,
        weight: row.weight,
        marketCap: capVal || null,
        returnPct: pct == null || !isFinite(pct) ? null : pct,
        returns: pcts,          // 四週期數值，供前端即時切換
        level: colorLevel(pct, scale),
        bars: ret ? ret.bars : 0,
        adjUsed: ret ? !!ret.adjUsed : false,
        noCap: !capVal,
        noData: pct == null || !isFinite(pct),
      });

      groupCap += capVal;
      groupWeight += row.weight;
      leafCount++;
    }

    if (!leaves.length) {
      failures.push({ sector: key, code: 'NO_LEAVES', message: '此版塊過濾後沒有股票' });
      continue;
    }

    /* 版塊的漲跌幅：以市值加權。
       不用簡單平均——版塊漲跌應該由大公司主導，
       簡單平均會讓一檔小型股與 NVDA 等權，失去代表性。
       四個週期各算一次（成本可忽略），供前端切換即時更新。 */
    const groupPcts = {};
    for (const p of PERIODS) {
      let s = 0;
      let w = 0;
      for (const lf of leaves) {
        const v = lf.returns[p.key];
        if (v == null) continue;
        const capW = lf.marketCap || 0;
        if (capW <= 0) continue;
        s += v * capW;
        w += capW;
      }
      groupPcts[p.key] = w > 0 ? s / w : null;
    }
    const groupPct = groupPcts[pKey];

    groups.push({
      key,
      label: meta.label,
      short: meta.short,
      color: meta.color,
      fundName: h.fundName || null,
      asOf: h.asOf || null,
      totalInFund: h.total || leaves.length,
      shown: leaves.length,
      marketCap: groupCap,
      weightPct: Number(groupWeight.toFixed(4)),
      returnPct: groupPct == null || !isFinite(groupPct) ? null : groupPct,
      returns: groupPcts,       // 四週期，供前端切換
      level: colorLevel(groupPct, scale),
      leaves,
    });

    grandCap += groupCap;
    grandWeight += groupWeight;
  }

  /* 面積權值：市值為 0 的版塊（極端情況）用極小值撐開，避免整組消失。
     用 grandCap 的 0.1% 當下限，確保它仍可見但不誤導。 */
  const floor = grandCap > 0 ? grandCap * 0.001 : 1;
  for (const g of groups) {
    g.areaValue = g.marketCap > 0 ? g.marketCap : floor;
    // 市值佔比：分母是「本次取樣的總市值」，不是全市場
    g.sharePct = grandCap > 0 ? (g.marketCap / grandCap) * 100 : 0;
    for (const lf of g.leaves) {
      lf.sharePct = grandCap > 0 ? ((lf.marketCap || 0) / grandCap) * 100 : 0;
      lf.sectorSharePct = g.marketCap > 0 ? ((lf.marketCap || 0) / g.marketCap) * 100 : 0;
      lf.areaValue = lf.marketCap > 0 ? lf.marketCap : floor / Math.max(g.leaves.length, 1);
    }
  }

  return {
    period: pKey,
    periodLabel: periodDef ? periodDef.label : pKey,
    periodFull: periodDef ? periodDef.full : pKey,
    periodTradingDays: periodDef ? periodDef.tradingDays : null,
    scale: { thresholdPct: scale, levels: LEVELS },
    groups,
    failures,
    totals: {
      sectors: groups.length,
      leaves: leafCount,
      marketCap: grandCap,
      // 取樣的權重覆蓋率：讓使用者知道「看到的不是全部」
      weightCoveredPct: Number(grandWeight.toFixed(2)),
    },
    sampling: {
      perSector,
      note: '面積為各版塊前 ' + perSector + ' 大持股的總市值；' +
        '非該版塊完整市值，跨版塊比較請以此為前提。',
    },
  };
}

module.exports = {
  PERIODS, PERIOD_KEYS, SCALE, LEVELS, DEFAULT_PER_SECTOR, MAX_PER_SECTOR,
  squarify, worstRatio, computeReturns, colorIntensity, colorLevel, build,
};
