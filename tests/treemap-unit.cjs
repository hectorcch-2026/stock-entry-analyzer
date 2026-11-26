'use strict';

/**
 * 版塊 Treemap — 單元測試
 * =========================
 * 執行：node tests/treemap-unit.cjs  或  npm run test:treemap
 *
 * 分組：
 *   A 佈局演算法（面積精確性、無重疊、無越界、覆蓋率）
 *   B 報酬計算（復權、交易日、資料不足、契約完整性）
 *   C 顏色分級（單調、平盤 vs 無資料、邊界）
 *   D 組裝（佔比、加權、面積權值、失敗處理）
 *   E 前端契約（DOM id、ES5、四週期、圖例、跳轉、漲紅跌綠）
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tm = require('../lib/treemap');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/* ============================================================
   A 佈局演算法
   ============================================================ */

section('A 佈局：squarified treemap');

/** 把 items 排成矩形並回傳統計 */
function layoutStats(values, W, H) {
  const items = values.map((v, i) => ({ value: v, id: i }));
  const rects = tm.squarify(items, 0, 0, W, H);
  const total = values.reduce((a, b) => a + b, 0);
  const target = W * H;

  let maxAreaErr = 0;
  for (const r of rects) {
    const want = (r.item.value / total) * target;
    const got = r.w * r.h;
    if (want > 0) maxAreaErr = Math.max(maxAreaErr, Math.abs(got - want) / want);
  }

  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0.01 && oy > 0.01) overlaps++;
    }
  }

  let oob = 0;
  for (const r of rects) {
    if (r.x < -0.01 || r.y < -0.01 || r.x + r.w > W + 0.01 || r.y + r.h > H + 0.01) oob++;
  }

  const covered = rects.reduce((s, r) => s + r.w * r.h, 0);
  const ars = rects.filter((r) => r.w > 0 && r.h > 0)
    .map((r) => Math.max(r.w / r.h, r.h / r.w)).sort((a, b) => a - b);

  return {
    rects, maxAreaErr, overlaps, oob,
    coverage: covered / target,
    maxAR: ars.length ? ars[ars.length - 1] : 0,
    medAR: ars.length ? ars[Math.floor(ars.length / 2)] : 0,
    count: rects.length,
  };
}

t('A1 每個輸入都得到一個矩形', () => {
  const s = layoutStats([5, 3, 2, 1], 400, 300);
  assert.strictEqual(s.count, 4);
});

t('A2 面積比 == 輸入值比（誤差 < 1e-9）', () => {
  const s = layoutStats([5167, 3605, 3638, 1436, 672, 680, 394, 371, 292, 289], 1140, 560);
  assert.ok(s.maxAreaErr < 1e-9, `面積比誤差 ${s.maxAreaErr}`);
});

t('A3 覆蓋率 100%（無空隙）', () => {
  for (const v of [Array(10).fill(1), [1, 2, 3, 4, 5], [1000, 1, 1, 1]]) {
    const s = layoutStats(v, 800, 600);
    assert.ok(Math.abs(s.coverage - 1) < 1e-9,
      `覆蓋率 ${s.coverage}（值 ${v.join(',')}）`);
  }
});

t('A4 矩形互不重疊', () => {
  const s = layoutStats(Array(11).fill(1), 1174, 520);
  assert.strictEqual(s.overlaps, 0);
});

t('A5 矩形不越界', () => {
  for (const [W, H] of [[1140, 560], [360, 460], [1200, 80], [80, 1200]]) {
    const s = layoutStats([7, 5, 3, 11, 13, 2, 1], W, H);
    assert.strictEqual(s.oob, 0, `${W}x${H} 有 ${s.oob} 個越界`);
  }
});

/* 這是本輪最關鍵的回歸測試。
   初版把「列的跨度」誤寫成短邊（應為長邊），導致覆蓋率只剩 47–75%
   且大量越界——但長寬比看起來很正常，光看圖不容易發現。
   因此必須用「覆蓋率 + 越界數」這兩個硬指標鎖住。 */
t('A6 迴歸：跨度必須用長邊（覆蓋率 > 99.99%）', () => {
  const s = layoutStats(Array(10).fill(1), 800, 600);
  assert.ok(s.coverage > 0.9999, `覆蓋率 ${s.coverage}，疑似誤用短邊當跨度`);
  assert.strictEqual(s.oob, 0);
});

t('A7 squarified 的長寬比優於 slice-and-dice', () => {
  const vals = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const s = layoutStats(vals, 800, 600);
  assert.ok(s.medAR < 4, `中位長寬比 ${s.medAR} 過大，失去 squarified 的意義`);
});

t('A8 空輸入 / 全零 / 負值 → 空結果', () => {
  assert.strictEqual(tm.squarify([], 0, 0, 100, 100).length, 0);
  assert.strictEqual(tm.squarify([{ value: 0 }], 0, 0, 100, 100).length, 0);
  assert.strictEqual(tm.squarify([{ value: -5 }], 0, 0, 100, 100).length, 0);
});

t('A9 零寬或零高 → 空結果（不可除以零）', () => {
  assert.strictEqual(tm.squarify([{ value: 1 }], 0, 0, 0, 100).length, 0);
  assert.strictEqual(tm.squarify([{ value: 1 }], 0, 0, 100, 0).length, 0);
});

t('A10 單一項目鋪滿整個容器', () => {
  const r = tm.squarify([{ value: 42 }], 0, 0, 200, 100);
  assert.strictEqual(r.length, 1);
  assert.ok(Math.abs(r[0].w * r[0].h - 200 * 100) < 1e-6);
});

t('A11 起點座標正確（非 0,0 也能排）', () => {
  const r = tm.squarify([{ value: 1 }, { value: 1 }], 50, 30, 200, 100);
  for (const x of r) {
    assert.ok(x.x >= 50 - 0.01 && x.y >= 30 - 0.01);
    assert.ok(x.x + x.w <= 250 + 0.01 && x.y + x.h <= 130 + 0.01);
  }
});

/* ============================================================
   B 報酬計算
   ============================================================ */

section('B 報酬：四週期復權計算');

function mk(n, fn) {
  const candles = [];
  const adj = [];
  for (let i = 0; i < n; i++) {
    candles.push({ t: i, c: fn(i) });
    adj.push(fn(i));
  }
  return { candles, adj };
}

t('B1 期間以交易日計（1/5/21/251）', () => {
  const keys = tm.PERIODS.map((p) => p.key);
  assert.deepStrictEqual(keys, ['d1', 'w1', 'm1', 'y1']);
  const td = {};
  for (const p of tm.PERIODS) td[p.key] = p.tradingDays;
  assert.strictEqual(td.d1, 1);
  assert.strictEqual(td.w1, 5);
  assert.strictEqual(td.m1, 21);
  assert.strictEqual(td.y1, 251);
});

t('B2 報酬 = 最新 ÷ N 根前 − 1', () => {
  const { candles, adj } = mk(300, (i) => 100 + i);
  const r = tm.computeReturns(candles, adj);
  for (const p of tm.PERIODS) {
    const last = adj[299];
    const base = adj[299 - p.tradingDays];
    const want = ((last / base) - 1) * 100;
    assert.ok(Math.abs(r[p.key] - want) < 1e-9, `${p.key} 期望 ${want} 得到 ${r[p.key]}`);
  }
});

t('B3 復權價優先於收盤價', () => {
  /* 收盤價完全平盤，但復權價上漲 → 報酬必須是正的。
     若實作誤用 close，這裡會得到 0。 */
  const candles = Array.from({ length: 300 }, (_, i) => ({ t: i, c: 100 }));
  const adj = Array.from({ length: 300 }, (_, i) => 100 + i * 0.1);
  const r = tm.computeReturns(candles, adj);
  assert.ok(r.m1 > 0, `套用復權價應為正，得到 ${r.m1}`);
  assert.strictEqual(r.adjUsed, true);
});

t('B4 復權價長度不符時退回收盤價', () => {
  const candles = Array.from({ length: 300 }, (_, i) => ({ t: i, c: 100 + i }));
  const adj = [1, 2, 3];   // 長度不符
  const r = tm.computeReturns(candles, adj);
  assert.strictEqual(r.adjUsed, false);
  assert.ok(r.m1 > 0);
});

t('B5 資料不足 → 該週期為 null（不硬用更短區間冒充）', () => {
  const { candles, adj } = mk(100, (i) => 100 + i);
  const r = tm.computeReturns(candles, adj);
  assert.strictEqual(r.y1, null, '只有 100 根不足以算年線');
  assert.ok(r.m1 != null, '21 根足夠算月線');
});

t('B6 空輸入 → 四個 key 都存在且為 null（API 契約）', () => {
  const r = tm.computeReturns([], null);
  for (const p of tm.PERIODS) {
    assert.ok(p.key in r, `${p.key} 缺少`);
    assert.strictEqual(r[p.key], null);
  }
  assert.strictEqual(r.bars, 0);
});

t('B7 單根或零根 → bars 為 0', () => {
  assert.strictEqual(tm.computeReturns([{ t: 0, c: 100 }], null).bars, 0);
  assert.strictEqual(tm.computeReturns(null, null).bars, 0);
});

t('B8 含 null / 負值的序列會被跳過', () => {
  const candles = [];
  for (let i = 0; i < 300; i++) {
    candles.push({ t: i, c: i % 37 === 0 ? null : (i % 41 === 0 ? -5 : 100 + i) });
  }
  const r = tm.computeReturns(candles, null);
  assert.ok(r.bars > 200 && r.bars < 300, `有效根數 ${r.bars}`);
  for (const p of tm.PERIODS) {
    assert.ok(r[p.key] == null || isFinite(r[p.key]));
  }
});

t('B9 price 回報實際收盤價（非復權價）', () => {
  const candles = Array.from({ length: 300 }, (_, i) => ({ t: i, c: 200 + i }));
  const adj = Array.from({ length: 300 }, (_, i) => 50 + i * 0.1);
  const r = tm.computeReturns(candles, adj);
  assert.strictEqual(r.price, 499, 'price 應為最後一根的收盤價');
});

/* ============================================================
   C 顏色分級
   ============================================================ */

section('C 顏色：強度與分級');

t('C1 強度隨 |漲跌幅| 單調遞增', () => {
  for (const key of tm.PERIOD_KEYS) {
    const sc = tm.SCALE[key];
    let prev = -1;
    for (let v = 0; v <= sc * 1.2; v += sc / 40) {
      const it = tm.colorIntensity(v, sc);
      assert.ok(it >= prev - 1e-12, `${key} 在 ${v} 處不單調`);
      prev = it;
    }
  }
});

t('C2 強度上界為 1（超額不溢出）', () => {
  for (const key of tm.PERIOD_KEYS) {
    const sc = tm.SCALE[key];
    assert.strictEqual(tm.colorIntensity(sc * 100, sc), 1);
    assert.strictEqual(tm.colorIntensity(sc, sc), 1);
  }
});

t('C3 級別範圍 1..LEVELS（有資料時）', () => {
  for (const key of tm.PERIOD_KEYS) {
    const sc = tm.SCALE[key];
    for (const v of [0, 0.001, sc * 0.3, sc * 0.7, sc, sc * 5, -sc * 0.5]) {
      const lv = tm.colorLevel(v, sc);
      assert.ok(lv >= 1 && lv <= tm.LEVELS, `${key} ${v}% → L${lv}`);
    }
  }
});

t('C4 平盤是 1 級，無資料才是 0 級（兩者不可混淆）', () => {
  assert.strictEqual(tm.colorLevel(0, 5), 1, '平盤必須可辨識，不能與無資料同級');
  assert.strictEqual(tm.colorLevel(null, 5), 0);
  assert.strictEqual(tm.colorLevel(undefined, 5), 0);
  assert.strictEqual(tm.colorLevel(NaN, 5), 0);
});

t('C5 正負漲跌幅級別對稱', () => {
  for (const key of tm.PERIOD_KEYS) {
    const sc = tm.SCALE[key];
    for (const v of [sc * 0.2, sc * 0.55, sc, 0]) {
      assert.strictEqual(tm.colorLevel(v, sc), tm.colorLevel(-v, sc),
        `${key} ±${v} 級別不對稱`);
    }
  }
});

t('C6 各週期閾值遞增（日 < 週 < 月 < 年）', () => {
  assert.ok(tm.SCALE.d1 < tm.SCALE.w1);
  assert.ok(tm.SCALE.w1 < tm.SCALE.m1);
  assert.ok(tm.SCALE.m1 < tm.SCALE.y1);
});

/* 這條防止「固定閾值」的回歸：
   若有人把閾值改成所有週期共用，月線與年線會有 82%／92% 的格子飽和，
   整張圖變成一色。用「同一漲跌幅在不同週期得到不同級別」來鎖住。 */
t('C7 迴歸：同一漲跌幅在不同週期級別不同', () => {
  const v = 5;   // +5%
  const levels = tm.PERIOD_KEYS.map((k) => tm.colorLevel(v, tm.SCALE[k]));
  assert.notStrictEqual(levels[0], levels[3],
    `5% 在日線與年線得到同一級別 ${levels[0]}，閾值可能被寫死成共用`);
});

t('C8 Infinity / -Infinity 不會產生 NaN 級別', () => {
  assert.strictEqual(tm.colorIntensity(Infinity, 5), 0);
  assert.strictEqual(tm.colorIntensity(-Infinity, 5), 0);
});

/* ============================================================
   D 組裝
   ============================================================ */

section('D 組裝：佔比、加權、面積權值');

function mkInput(over) {
  const o = over || {};
  return {
    sectors: o.sectors || ['XLK', 'XLF'],
    perSector: o.perSector || 2,
    holdingsBySector: o.holdingsBySector || {
      XLK: {
        holdings: [
          { ticker: 'AAPL', quoteSymbol: 'AAPL', name: 'Apple', weight: 17.9 },
          { ticker: 'NVDA', quoteSymbol: 'NVDA', name: 'Nvidia', weight: 13.1 },
        ],
        fundName: 'Technology Select Sector SPDR',
        asOf: '24-Nov-2026', total: 76,
      },
      XLF: {
        holdings: [
          { ticker: 'BRK.B', quoteSymbol: 'BRK-B', name: 'Berkshire', weight: 13.6 },
          { ticker: 'JPM', quoteSymbol: 'JPM', name: 'JPMorgan', weight: 10.2 },
        ],
        fundName: 'Financial Select Sector SPDR',
        asOf: '24-Nov-2026', total: 76,
      },
    },
    caps: o.caps || {
      AAPL: { marketCap: 5.0e12, name: 'Apple Inc.' },
      NVDA: { marketCap: 3.6e12, name: 'NVIDIA' },
      'BRK-B': { marketCap: 1.1e12, name: 'Berkshire Hathaway' },
      JPM: { marketCap: 0.8e12, name: 'JPMorgan Chase' },
    },
    returns: o.returns || {
      AAPL: { d1: 0.43, w1: 0.89, m1: 2.52, y1: 28.83, bars: 501, adjUsed: true },
      NVDA: { d1: -3.91, w1: -5.2, m1: -31.49, y1: 40.0, bars: 501, adjUsed: true },
      'BRK-B': { d1: 0.1, w1: 0.5, m1: 1.2, y1: 12.0, bars: 501, adjUsed: true },
      JPM: { d1: -0.2, w1: 0.3, m1: 3.1, y1: 18.0, bars: 501, adjUsed: true },
    },
    period: o.period || 'm1',
    sectorMeta: o.sectorMeta || {
      XLK: { label: '資訊科技', short: '科技', color: '#2563eb' },
      XLF: { label: '金融', short: '金融', color: '#0891b2' },
    },
  };
}

t('D1 組出兩個版塊、四個葉節點', () => {
  const d = tm.build(mkInput());
  assert.strictEqual(d.groups.length, 2);
  assert.strictEqual(d.totals.leaves, 4);
});

t('D2 市值佔比合計為 100%', () => {
  const d = tm.build(mkInput());
  const sum = d.groups.reduce((a, g) => a + g.sharePct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-6, `合計 ${sum}`);
});

t('D3 版塊漲跌幅為市值加權（非簡單平均）', () => {
  const d = tm.build(mkInput());
  const xlk = d.groups.find((g) => g.key === 'XLK');
  const wA = 5.0e12, wN = 3.6e12;
  const want = (2.52 * wA + (-31.49) * wN) / (wA + wN);
  assert.ok(Math.abs(xlk.returnPct - want) < 1e-9,
    `市值加權期望 ${want} 得到 ${xlk.returnPct}`);
  const simple = (2.52 + (-31.49)) / 2;
  assert.notStrictEqual(Math.round(xlk.returnPct * 100), Math.round(simple * 100),
    '加權平均不應等於簡單平均');
});

t('D4 葉節點四週期數值齊全', () => {
  const d = tm.build(mkInput());
  for (const g of d.groups) {
    for (const lf of g.leaves) {
      for (const k of tm.PERIOD_KEYS) {
        assert.ok(k in lf.returns, `${lf.ticker} 缺 ${k}`);
      }
    }
  }
});

t('D5 切換週期只改變 returnPct，不改變面積', () => {
  const a = tm.build(mkInput({ period: 'd1' }));
  const b = tm.build(mkInput({ period: 'y1' }));
  for (let i = 0; i < a.groups.length; i++) {
    assert.strictEqual(a.groups[i].areaValue, b.groups[i].areaValue,
      '面積權值不應隨週期改變');
    assert.strictEqual(a.groups[i].marketCap, b.groups[i].marketCap);
  }
});

t('D6 缺市值的股票標記 noCap 但仍有節點', () => {
  const input = mkInput();
  input.caps.NVDA = { marketCap: null, name: 'NVIDIA' };
  const d = tm.build(input);
  const nvda = d.groups[0].leaves.find((l) => l.ticker === 'NVDA');
  assert.ok(nvda, '缺市值不應讓節點消失');
  assert.strictEqual(nvda.noCap, true);
  assert.ok(nvda.areaValue > 0, '仍要有面積才能畫');
});

t('D7 缺行情的股票標記 noData、級別為 0', () => {
  const input = mkInput();
  input.returns.NVDA = { d1: null, w1: null, m1: null, y1: null, bars: 0, adjUsed: false };
  const d = tm.build(input);
  const nvda = d.groups[0].leaves.find((l) => l.ticker === 'NVDA');
  assert.strictEqual(nvda.noData, true);
  assert.strictEqual(nvda.level, 0);
});

t('D8 版塊無持股 → 進 failures 而非崩潰', () => {
  const input = mkInput();
  input.holdingsBySector.XLF = { holdings: [], fundName: null, asOf: null, total: 0 };
  const d = tm.build(input);
  assert.strictEqual(d.groups.length, 1);
  assert.ok(d.failures.some((f) => f.sector === 'XLF'));
});

t('D9 perSector 限制生效', () => {
  const d = tm.build(mkInput({ perSector: 1 }));
  for (const g of d.groups) assert.strictEqual(g.leaves.length, 1);
});

t('D10 未知週期回退到 m1（不崩潰）', () => {
  const d = tm.build(mkInput({ period: 'zzz' }));
  assert.strictEqual(d.period, 'm1');
});

t('D11 回傳包含 sampling 說明（面積不是完整版塊市值）', () => {
  const d = tm.build(mkInput());
  assert.ok(d.sampling, '缺少 sampling 區塊');
  assert.ok(/市值/.test(d.sampling.note));
  assert.ok(d.sampling.perSector > 0);
});

/* ---- 市值全體缺失的退化（雲端 crumb 被限流時會發生） ----
   這是實測過的線上故障：Render 上 getcrumb 持續 429，
   導致 110 檔全部 noCap，舊版會讓每格面積都等於同一個 floor，
   畫出一張「每格一樣大」卻看起來正常的圖。 */
t('D13 市值全缺時改用權重當面積，不可全體等大', () => {
  const input = mkInput();
  for (const k of Object.keys(input.caps)) input.caps[k] = { marketCap: null, name: k };
  const d = tm.build(input);

  assert.strictEqual(d.areaBasis, 'weight', '應標示面積來源為權重');
  assert.strictEqual(d.totals.marketCap, 0);

  /* 關鍵：不同股票的面積必須不同（依權重），不能全部同值 */
  const all = [].concat(...d.groups.map((g) => g.leaves));
  const areas = all.map((l) => l.areaValue);
  assert.ok(areas.every((a) => a > 0), '每格仍要有面積');
  const uniq = new Set(areas.map((a) => a.toFixed(6)));
  assert.ok(uniq.size > 1, `面積全部相同（${uniq.size} 種），等於失去面積語意`);

  /* 面積比例要等於權重比例 */
  const a = all.find((l) => l.ticker === 'NVDA');
  const b = all.find((l) => l.ticker === 'AAPL');
  const ratio = a.areaValue / b.areaValue;
  const wRatio = a.weight / b.weight;
  assert.ok(Math.abs(ratio - wRatio) < 1e-9, `面積比 ${ratio} 與權重比 ${wRatio} 不符`);
});

t('D14 市值正常時 areaBasis 為 marketCap', () => {
  const d = tm.build(mkInput());
  assert.strictEqual(d.areaBasis, 'marketCap');
});

t('D15 市值與權重皆缺時才退到 equal', () => {
  const input = mkInput();
  for (const k of Object.keys(input.caps)) input.caps[k] = { marketCap: null, name: k };
  for (const sec of Object.keys(input.holdingsBySector)) {
    for (const row of input.holdingsBySector[sec].holdings) row.weight = 0;
  }
  const d = tm.build(input);
  assert.strictEqual(d.areaBasis, 'equal');
});

t('D12 版塊標籤沿用 sectorMeta', () => {
  const d = tm.build(mkInput());
  const xlk = d.groups.find((g) => g.key === 'XLK');
  assert.strictEqual(xlk.label, '資訊科技');
  assert.strictEqual(xlk.short, '科技');
  assert.strictEqual(xlk.color, '#2563eb');
});

/* ============================================================
   E 前端契約
   ============================================================ */

section('E 前端契約');

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public/rrg-treemap.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

t('E1 必要的 DOM id 都存在', () => {
  const ids = ['rrgTmPeriods', 'rrgTmMeta', 'rrgTmWrap', 'rrgTmCanvas',
    'rrgTmTip', 'rrgTmEmpty', 'rrgTmLegend'];
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
    assert.ok(js.includes(`'${id}'`), `rrg-treemap.js 沒有引用 #${id}`);
  }
});

t('E2 動態建立的 id 出現在前端字串中', () => {
  /* rrgTmRetry 由 renderError 以 innerHTML 產生，靜態 HTML 不會有。
     這種 id 要驗「前端程式碼裡有」，而不是驗 index.html。 */
  assert.ok(js.includes('rrgTmRetry'), '重試按鈕 id 未出現在前端程式碼');
});

t('E3 四週期按鈕（日／週／月／年）', () => {
  for (const label of ['日', '週', '月', '年']) {
    assert.ok(js.includes(`'${label}'`) || js.includes(`"${label}"`),
      `未找到週期標籤 ${label}`);
  }
  assert.ok(js.includes('data-period'), '缺少 data-period 屬性');
});

t('E4 切換週期為本地重繪（不重新請求）', () => {
  /* setPeriod 內不得出現 load( 或 fetch( —— 否則切換會打 API */
  const start = js.indexOf('function setPeriod');
  assert.ok(start > 0, '找不到 setPeriod');
  const body = js.slice(start, js.indexOf('\n  }', start));
  assert.ok(!/load\s*\(/.test(body), 'setPeriod 內呼叫了 load()，會產生多餘請求');
  assert.ok(!/fetch\s*\(/.test(body), 'setPeriod 內呼叫了 fetch()');
  assert.ok(/draw\s*\(/.test(body), 'setPeriod 必須重繪');
});

t('E5 Tooltip 含版塊名稱、市值佔比、所選週期漲跌幅', () => {
  for (const kw of ['市值', '佔全體', '漲跌', '版塊內']) {
    assert.ok(js.includes(kw), `tooltip 缺少「${kw}」`);
  }
  assert.ok(js.includes('g.label') || js.includes('g.key'), 'tooltip 未顯示版塊名稱');
});

t('E6 圖例說明顏色對應的漲跌幅', () => {
  assert.ok(js.includes('renderLegend'), '缺少圖例渲染');
  assert.ok(js.includes('thresholdPct'), '圖例未使用 API 的門檻值');
  assert.ok(/漲跌幅/.test(js), '圖例未標示「漲跌幅」');
  assert.ok(css.includes('.rrg-tm-leg-bar'), '缺少圖例樣式');
});

t('E7 漲紅跌綠（與本專案慣例一致）', () => {
  assert.ok(js.includes('217, 43, 43') || js.includes('#d92b2b'),
    '未找到紅色（漲）');
  assert.ok(js.includes('15, 157, 88') || js.includes('#0f9d58'),
    '未找到綠色（跌）');
  /* 確認 UP 用紅、DOWN 用綠，而不是反過來 */
  const upIdx = js.indexOf('UP_BASE');
  const downIdx = js.indexOf('DOWN_BASE');
  assert.ok(upIdx > 0 && downIdx > upIdx, '常數順序異常');
  const upLine = js.slice(upIdx, upIdx + 80);
  const downLine = js.slice(downIdx, downIdx + 80);
  assert.ok(/217,\s*43,\s*43/.test(upLine), `UP_BASE 應為紅色，實際：${upLine}`);
  assert.ok(/15,\s*157,\s*88/.test(downLine), `DOWN_BASE 應為綠色，實際：${downLine}`);
});

t('E8 點擊跳到個股 AI 分析頁', () => {
  assert.ok(js.includes("'#/detail/'") || js.includes('"#/detail/"'),
    '未使用 #/detail/ 路由');
  assert.ok(js.includes('SA.navigate'), '未使用 SA.navigate（會漏掉路由派發）');
  /* 必須精確檢查 navigate 那一行用的是 symbol（報價代碼 BRK-B），
     而不是 ticker（持股檔寫法 BRK.B，Yahoo 查不到 → 點進去 404）。
     只檢查「字串 hit.leaf.symbol 存在於檔案」是不夠的：
     懸停邏輯也用 symbol，破壞跳轉後那個字串依然存在，測試會假通過。 */
  const navLine = js.split('\n').find((l) => l.includes('SA.navigate') && l.includes('#/detail/'));
  assert.ok(navLine, '找不到跳轉那行');
  assert.ok(/hit\.leaf\.symbol/.test(navLine),
    `跳轉應使用 quoteSymbol/hit.leaf.symbol，實際：${navLine.trim()}`);
  assert.ok(!/hit\.leaf\.ticker/.test(navLine), '跳轉不可使用原始 ticker（BRK.B 會 404）');
});

t('E9 三種狀態都有處理（載入／無資料／錯誤）', () => {
  assert.ok(js.includes('載入中'), '缺少載入狀態');
  assert.ok(js.includes('rrgTmEmpty'), '缺少空狀態');
  assert.ok(js.includes('renderError'), '缺少錯誤處理');
  assert.ok(/可重試|重試/.test(js), '缺少重試機制');
});

t('E10 前端只用 ES5（本專案既有約束）', () => {
  /* 移除註解與字串後再檢查，避免誤判 */
  const stripped = js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.ok(!/\bconst\s/.test(stripped), '使用了 const');
  assert.ok(!/\blet\s/.test(stripped), '使用了 let');
  assert.ok(!/=>/.test(stripped), '使用了箭頭函式');
  assert.ok(!/`/.test(stripped), '使用了模板字串');
});

t('E11 支援高 DPI 螢幕', () => {
  assert.ok(js.includes('devicePixelRatio'), '未處理 DPR，高階螢幕會模糊');
});

t('E12 視窗尺寸變化會重繪', () => {
  assert.ok(/addEventListener\('resize'/.test(js), '缺少 resize 監聽');
});

t('E13 Service Worker 已升版並納入新資源', () => {
  const m = sw.match(/^\s*const\s+VERSION\s*=\s*'([^']+)'/m);
  assert.ok(m, '找不到 VERSION');
  assert.ok(m[1] >= 'v1.0.7', `VERSION 為 ${m[1]}，應 >= v1.0.7`);
  assert.ok(sw.includes("'/rrg-treemap.js'"), 'SHELL_ASSETS 未包含 rrg-treemap.js');
});

t('E14 index.html 引入 rrg-treemap.js（僅一次）', () => {
  const n = (html.match(/rrg-treemap\.js/g) || []).length;
  assert.strictEqual(n, 1, `引入 ${n} 次`);
  /* 必須在 rrg-client.js 之後（前者依賴後者建立的路由掛鉤） */
  assert.ok(html.indexOf('rrg-client.js') < html.indexOf('rrg-treemap.js'),
    '載入順序錯誤：rrg-treemap.js 應在 rrg-client.js 之後');
});

t('E15 端點存在且驗證週期參數', () => {
  assert.ok(server.includes("'/api/rrg/treemap'"), 'server.js 缺少端點');
  assert.ok(server.includes('BAD_PERIOD'), '缺少週期驗證');
  assert.ok(server.includes('BAD_PER_SECTOR'), '缺少 perSector 驗證');
  assert.ok(server.includes('treemapService.getTreemap'), '未呼叫服務層');
});

t('E16 週期按鈕有無障礙屬性', () => {
  assert.ok(js.includes('aria-pressed'), '週期按鈕缺少 aria-pressed');
  assert.ok(html.includes('aria-label'), '缺少 aria-label');
});

t('E17 CSS 有行動版與列印樣式', () => {
  assert.ok(/\.rrg-tm-pbtn[^{]*\{[\s\S]{0,200}flex/.test(css) ||
    css.includes('.rrg-tm-pbtn { flex: 1 1 0'), '行動版週期按鈕未撐滿');
  assert.ok(/@media print[\s\S]{0,300}rrg-tm/.test(css), '缺少列印樣式');
});

t('E18 CSS 大括號平衡', () => {
  let o = 0, c = 0;
  for (const ch of css) { if (ch === '{') o++; if (ch === '}') c++; }
  assert.strictEqual(o, c, `${o} 個 { vs ${c} 個 }`);
});

t('E19 面積權值來自後端（前端不自行改比例）', () => {
  assert.ok(/areaValue/.test(js), '前端未使用 areaValue');
  /* 前端可以依容器重算座標，但不可重新定義權值 */
  assert.ok(!/marketCap\s*\/\s*\d/.test(js), '前端疑似自行縮放市值');
});

t('E20 tooltip 定位以視窗為約束（不被容器裁切）', () => {
  assert.ok(js.includes('clientWidth') && js.includes('clientHeight'),
    'tooltip 未考慮視窗邊界');
  assert.ok(/position:\s*fixed/.test(css), 'tooltip 應為 fixed 定位');
});

/* 線上實測到的故障：Render 上 crumb 被限流 → 110 檔市值全缺。
   面積因此退化成權重。若前端不說明，使用者會把面積讀成市值。 */
t('E21 面積非市值時，前端必須明說', () => {
  assert.ok(/areaBasis/.test(js), '前端未讀取 areaBasis');
  assert.ok(/'weight'/.test(js) || /"weight"/.test(js), '前端未處理 weight 退化情形');
  assert.ok(/權重/.test(js), '缺少「以權重代替」的提示文字');
});

t('E22 市值抓取有無 crumb 的備援（不可只依賴 v7/quote）', () => {
  const svcSrc = fs.readFileSync(path.join(ROOT, 'lib/treemap-service.js'), 'utf8');
  assert.ok(/fetchCapsResilient/.test(svcSrc), '缺少韌性抓取函式');
  assert.ok(/ordinarySharesNumber|trailingMarketCap/.test(svcSrc),
    '缺少無 crumb 的市值來源');
  /* crumb 正則必須允許 base64 字元的 '/' 與 '+'，
     否則有效的 crumb 會被誤丟（實測 "ewxKRKH/qVL"） */
  assert.ok(/A-Za-z0-9\._\\-\+\/|A-Za-z0-9._\\-+\//.test(svcSrc),
    'crumb 驗證正則未允許 base64 字元');
});

/* ============================================================
   結果
   ============================================================ */

console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${pass} 通過 / ${fail} 失敗`);
if (fail) {
  console.log('\n失敗詳情：');
  for (const f of failures) {
    console.log(`\n[${f.name}]`);
    console.log(f.error.stack || f.error.message);
  }
}
console.log('='.repeat(50));
process.exit(fail ? 1 : 0);
