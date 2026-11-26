'use strict';

/**
 * RRG 版塊輪動 — 單元測試（完全不連網）
 * ======================================
 *
 * 為什麼一定要有不連網的測試：
 *   這個模組在開發過程中有**三個指標被實測推翻**，每一次都是「看起來很合理、
 *   測試也過，但算出來的東西與畫面對不上」。若不把正確行為鎖死，
 *   下次重構時很容易又寫回其中一種。
 *
 * 覆蓋範圍（每一組對應一次實際踩到的坑）：
 *   A. DEMA / indexTo100 的定義正確性
 *   B. 暖機期推導（period 不足以算出兩次平滑時必須回 insufficient）
 *   C. 重取樣分桶（週線歸屬、月線、日線原樣）
 *   D. 交集對齊（缺漏期間必須整段剔除，不可補值）
 *   E. 象限分類邊界（100 屬於右/上側）
 *   F. 曲率：弦弓量對「半徑」完全不敏感 ← 前兩種算法在此徹底失敗
 *   G. 曲率：順時針必須為負（符號搞反＝方向性結論全錯）
 *   H. 曲率：筆直路徑必須接近 0 且不報轉向 ← XLRE 181.5 度假警報的回歸測試
 *   I. 每期位移門檻與尾跡長度無關（絕對門檻 bug 的回歸測試）
 *   J. 尾跡分析只吃尾跡、不吃整個窗口（錯吃窗口 bug 的回歸測試）
 *   K. 參數正規化（非法值報錯、預設值正確）
 *   L. buildRRG 的缺資料處理與 diagnostics
 *   M. 前端契約（rrg-client.js 用到的 DOM id 必須存在於 index.html）
 *
 * 用法：node tests/rrg-unit.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rrg = require('../lib/rrg');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, msg: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

/* ---------------------------------------------------------------
   小工具
   --------------------------------------------------------------- */

/** 近似比較 */
function near(a, b, eps, msg) {
  eps = eps == null ? 1e-6 : eps;
  assert.ok(Math.abs(a - b) <= eps, `${msg || ''} 期望 ${b}，實際 ${a}（容差 ${eps}）`);
}

/** 產生一段等差序列 */
function ramp(n, start, step) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(start + i * step);
  return out;
}

/** 每日（跳過週末）的 K 線陣列，t 為 UTC 毫秒 */
function dailyBars(startISO, count, priceFn) {
  const out = [];
  let d = new Date(startISO + 'T00:00:00Z').getTime();
  let i = 0;
  while (out.length < count) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push({ t: d, c: priceFn(out.length, i) });
      i += 1;
    }
    d += 86400000;
  }
  return out;
}

/** 依已知掃角產生一段圓弧（供曲率校準用） */
function arc(sweepDeg, n, radius) {
  const r = radius == null ? 6 : radius;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = ((sweepDeg * (i / (n - 1))) - 90) * Math.PI / 180;
    out.push({ ratio: 100 + r * Math.cos(a), momentum: 100 + r * Math.sin(a) });
  }
  return out;
}

/** 標準的順時針 RRG 路徑：領先 → 弱化 → 落後 → 改善 */
const CW_PATH = [
  { ratio: 106, momentum: 106 },
  { ratio: 106, momentum: 103 },
  { ratio: 106, momentum: 98 },
  { ratio: 104, momentum: 95 },
];

/* ============================================================
   A. DEMA / indexTo100
   ============================================================ */
console.log('\n--- A. DEMA 與標準化 ---');

t('A1 DEMA 長度與輸入一致，且首值有定義（indicators.ema 以首值為種子）', () => {
  const v = ramp(40, 100, 1);
  const out = rrg.dema(v, 10);
  assert.strictEqual(out.length, v.length);
  /* indicators.ema 以第一個有效值直接當種子（prev == null 時 prev = v），
     所以 out[0] 不是 null 而是首值本身。註記此行為，
     避免日後誤以為開頭一定有空窗而重複跳過資料。 */
  assert.ok(isFinite(out[0]), '首值應有定義（種子即首值）');
  near(out[0], v[0], 1e-9, '首值應等於原始首值');
});

t('A1b 輸入含 null 時，EMA 會沿用前值而非中斷', () => {
  const v = [10, 11, null, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  const out = rrg.dema(v, 3);
  assert.ok(isFinite(out[2]), 'null 位置應沿用前值，不可變成 null');
});

t('A2 DEMA 對線性序列會收斂到趨勢線附近', () => {
  const v = ramp(200, 100, 1);
  const out = rrg.dema(v, 10);
  const tail = out[199];
  assert.ok(isFinite(tail), '尾端必須有值');
  /* 線性序列的 DEMA 幾乎不落後，應接近原值 */
  near(tail, v[199], 2, 'DEMA 對線性趨勢應貼近原值');
});

t('A3 indexTo100 對「恆定序列」回傳 100', () => {
  const v = new Array(80).fill(50);
  const out = rrg.indexTo100(v, 10);
  const tail = out[79];
  assert.ok(isFinite(tail), '尾端必須有值');
  near(tail, 100, 1e-9, '恆定序列的標準化結果必須是 100');
});

t('A4 indexTo100 對上升序列回傳 > 100', () => {
  const v = ramp(120, 100, 1);
  const out = rrg.indexTo100(v, 10);
  assert.ok(out[119] > 100, `上升序列應 > 100，實際 ${out[119]}`);
});

t('A5 indexTo100 基準為 0 時回傳 null（不可除以零）', () => {
  const v = new Array(80).fill(0);
  const out = rrg.indexTo100(v, 10);
  assert.strictEqual(out[79], null, '基準為 0 時必須是 null，不能是 Infinity');
});

/* ============================================================
   B. 暖機期
   ============================================================ */
console.log('\n--- B. 暖機期 ---');

t('B1 warmupBars = ceil(period × 2.5)', () => {
  assert.strictEqual(rrg.warmupBars(14), 35);
  assert.strictEqual(rrg.warmupBars(8), 20);
  assert.strictEqual(rrg.warmupBars(3), 8);
});

t('B2 暖機期隨平滑週期單調遞增', () => {
  let prev = 0;
  for (const p of [3, 5, 10, 20, 40]) {
    const w = rrg.warmupBars(p);
    assert.ok(w > prev, `period ${p} 的暖機期應大於前一個`);
    prev = w;
  }
});

/* ============================================================
   C. 重取樣
   ============================================================ */
console.log('\n--- C. 重取樣分桶 ---');

t('C1 日線原樣返回，不改動時間戳', () => {
  const bars = dailyBars('2024-01-01', 30, (i) => 100 + i);
  const out = rrg.resample(bars, 'daily');
  assert.strictEqual(out.length, bars.length);
  assert.strictEqual(out[0].t, bars[0].t);
});

t('C2 週線：每週只留一個點', () => {
  /* 10 週的交易日約 50 天 */
  const bars = dailyBars('2024-01-01', 50, (i) => 100 + i);
  const out = rrg.resample(bars, 'weekly');
  assert.ok(out.length >= 9 && out.length <= 11,
    `10 週應聚成約 10 個點，實際 ${out.length}`);
});

t('C3 週線取「該週最後一個交易日」的收盤', () => {
  /* 造一個每週五收盤特別高的序列，確認留下的是週五而非週一 */
  const bars = [];
  let d = new Date('2024-01-01T00:00:00Z').getTime();   /* 週一 */
  for (let w = 0; w < 4; w++) {
    for (let k = 0; k < 5; k++) {
      const ts = d + (w * 7 + k) * 86400000;
      bars.push({ t: ts, c: k === 4 ? 999 : 100 });      /* k=4 為週五 */
    }
  }
  const out = rrg.resample(bars, 'weekly');
  out.forEach((o) => assert.strictEqual(o.c, 999, '每週應保留週五的收盤價 999'));
});

t('C4 月線：每月一個點', () => {
  const bars = dailyBars('2024-01-01', 130, (i) => 100 + i);
  const out = rrg.resample(bars, 'monthly');
  assert.ok(out.length >= 5 && out.length <= 7,
    `約 6 個月應聚成 5–7 個點，實際 ${out.length}`);
});

t('C5 空輸入回傳空陣列（不可拋錯）', () => {
  assert.deepStrictEqual(rrg.resample([], 'weekly'), []);
  assert.deepStrictEqual(rrg.resample(null, 'weekly'), []);
});

/* ============================================================
   D. 交集對齊
   ============================================================ */
console.log('\n--- D. 交集對齊 ---');

t('D1 只有共同期間會被保留（交集，非聯集）', () => {
  /* A 從 1 月開始、B 從 3 月開始 → 結果必須從 3 月起 */
  const a = rrg.resample(dailyBars('2024-01-01', 200, (i) => 100 + i), 'monthly');
  const b = rrg.resample(dailyBars('2024-03-01', 200, (i) => 100 + i), 'monthly');
  const out = rrg.alignSeries([{ key: 'A', bars: a }, { key: 'B', bars: b }]);
  const aKeys = new Set(a.map((x) => x.key || x.t));
  const bKeys = new Set(b.map((x) => x.key || x.t));
  out.dates.forEach((dk, i) => {
    assert.ok(aKeys.has(dk) || bKeys.has(dk), '每個日期都應存在於至少一條序列');
  });
  /* 關鍵：B 沒有 1、2 月，所以結果不可能有 2 個月以上「只有 A」的期間 */
  const onlyA = out.dates.filter((dk) => !bKeys.has(dk));
  assert.strictEqual(onlyA.length, 0, '對齊後不應留下只有 A 有的期間');
});

t('D2 對齊後每條序列長度一致，且 null 不會出現在 rows 裡', () => {
  const a = rrg.resample(dailyBars('2024-01-01', 200, (i) => 100 + i), 'monthly');
  const b = rrg.resample(dailyBars('2024-02-01', 200, (i) => 50 + i), 'monthly');
  const out = rrg.alignSeries([{ key: 'A', bars: a }, { key: 'B', bars: b }]);
  assert.strictEqual(out.rows.A.length, out.dates.length);
  assert.strictEqual(out.rows.B.length, out.dates.length);
  out.rows.A.forEach((v) => assert.ok(v != null && isFinite(v), '不應有 null（交集保證有值）'));
  out.rows.B.forEach((v) => assert.ok(v != null && isFinite(v), '不應有 null（交集保證有值）'));
});

t('D3 沒有共同期間時回傳空結果（不可硬湊）', () => {
  const a = rrg.resample(dailyBars('2020-01-01', 60, () => 100), 'monthly');
  const b = rrg.resample(dailyBars('2024-01-01', 60, () => 200), 'monthly');
  const out = rrg.alignSeries([{ key: 'A', bars: a }, { key: 'B', bars: b }]);
  assert.strictEqual(out.dates.length, 0, '完全不重疊時必須是空，不能補值造假');
});

t('D4 空清單回傳空結構（不可拋錯）', () => {
  const out = rrg.alignSeries([]);
  assert.deepStrictEqual(out.dates, []);
});

/* ============================================================
   E. 象限分類
   ============================================================ */
console.log('\n--- E. 象限分類 ---');

t('E1 四象限對應正確', () => {
  assert.strictEqual(rrg.classifyQuadrant(105, 105).key, 'leading');
  assert.strictEqual(rrg.classifyQuadrant(105, 95).key, 'weakening');
  assert.strictEqual(rrg.classifyQuadrant(95, 95).key, 'lagging');
  assert.strictEqual(rrg.classifyQuadrant(95, 105).key, 'improving');
});

t('E2 邊界值 100 屬於「右」與「上」（>= 判定）', () => {
  assert.strictEqual(rrg.classifyQuadrant(100, 100).key, 'leading');
  assert.strictEqual(rrg.classifyQuadrant(100, 99).key, 'weakening');
  assert.strictEqual(rrg.classifyQuadrant(99, 100).key, 'improving');
});

t('E3 null / NaN 回傳 unknown（不可誤判成某個象限）', () => {
  assert.strictEqual(rrg.classifyQuadrant(null, 105).key, 'unknown');
  assert.strictEqual(rrg.classifyQuadrant(105, null).key, 'unknown');
  assert.strictEqual(rrg.classifyQuadrant(NaN, 105).key, 'unknown');
  assert.strictEqual(rrg.classifyQuadrant(undefined, undefined).key, 'unknown');
});

/* ============================================================
   F. 曲率：半徑不敏感性（前兩種算法在此徹底失敗）
   ============================================================ */
console.log('\n--- F. 曲率：尺度不變性 ---');

t('F1 同一掃角、不同半徑 → 曲率完全相同', () => {
  /* 這是「繞中心極角」算法最致命的地方：半徑越小，極角跳動越劇烈。
     弦弓量必須對半徑完全不敏感，否則 RRG（點永遠聚在中心附近）
     就會不斷產生假轉向。 */
  const c2 = rrg.analyzeTrail(arc(45, 8, 2)).curvature;
  const c6 = rrg.analyzeTrail(arc(45, 8, 6)).curvature;
  const c15 = rrg.analyzeTrail(arc(45, 8, 15)).curvature;
  assert.ok(c2 != null && c6 != null && c15 != null, '三種半徑都必須算得出曲率');
  near(c2, c6, 1e-9, '半徑 2 vs 6 必須相同');
  near(c6, c15, 1e-9, '半徑 6 vs 15 必須相同');
});

t('F2 曲率對掃角嚴格單調遞增', () => {
  let prev = -1;
  for (const deg of [10, 20, 45, 90, 180]) {
    const c = Math.abs(rrg.analyzeTrail(arc(deg, 8, 6)).curvature);
    assert.ok(c > prev, `掃角 ${deg}° 的曲率應大於前一個（實際 ${c}）`);
    prev = c;
  }
});

t('F3 曲率有界（不可能出現 1107 度那種荒謬值）', () => {
  /* 「相鄰段轉角累加」在 52 週窗口曾算出 1107 度；
     弦弓量的理論上界是 0.5（半圓），必須遠小於 1。 */
  for (const deg of [10, 45, 90, 180]) {
    const c = Math.abs(rrg.analyzeTrail(arc(deg, 20, 6)).curvature);
    assert.ok(c <= 0.55, `掃角 ${deg}° 的曲率 ${c} 超出合理上界`);
  }
});

/* ============================================================
   G. 曲率符號
   ============================================================ */
console.log('\n--- G. 曲率符號（順時針＝負） ---');

t('G1 順時針路徑 → 曲率為負 → turning-cw', () => {
  const a = rrg.analyzeTrail(CW_PATH);
  assert.ok(a.curvature < 0, `順時針應為負，實際 ${a.curvature}`);
  assert.strictEqual(a.signal, 'turning-cw', `順時針應判為 turning-cw，實際 ${a.signal}`);
});

t('G2 逆時針路徑 → 曲率為正 → turning-ccw', () => {
  const a = rrg.analyzeTrail(CW_PATH.slice().reverse());
  assert.ok(a.curvature > 0, `逆時針應為正，實際 ${a.curvature}`);
  assert.strictEqual(a.signal, 'turning-ccw', `逆時針應判為 turning-ccw，實際 ${a.signal}`);
});

t('G3 順逆時針的曲率互為相反數（對稱性）', () => {
  const cw = rrg.analyzeTrail(CW_PATH).curvature;
  const ccw = rrg.analyzeTrail(CW_PATH.slice().reverse()).curvature;
  near(cw, -ccw, 1e-9, '同一條路徑反著走，曲率必須變號且等值');
});

/* ============================================================
   H. 筆直路徑不得報轉向（XLRE 假警報回歸測試）
   ============================================================ */
console.log('\n--- H. 筆直路徑回歸測試 ---');

t('H1 幾乎筆直的路徑 → 曲率接近 0 且不報轉向', () => {
  /* 這條資料就是實測時被誤判 181.5 度的 XLRE 尾跡：
     它從 (96.55,97.7) 幾乎直線走到 (104.07,102.88)，
     但因為中段擦過 (100,100)，舊算法算出「逆時針迴游」。
     正確行為是：曲率接近 0，訊號不得為 turning-*。 */
  const straight = [
    { ratio: 96.55, momentum: 97.70 },
    { ratio: 98.88, momentum: 98.74 },
    { ratio: 100.30, momentum: 99.92 },
    { ratio: 102.53, momentum: 101.40 },
    { ratio: 104.07, momentum: 102.88 },
  ];
  const a = rrg.analyzeTrail(straight);
  assert.ok(Math.abs(a.curvature) < 0.06,
    `筆直路徑的曲率應接近 0，實際 ${a.curvature}`);
  assert.ok(a.signal !== 'turning-cw' && a.signal !== 'turning-ccw',
    `筆直路徑不該被判為轉向，實際 ${a.signal}`);
});

t('H2 完全共線的點 → 曲率為 0', () => {
  const line = [
    { ratio: 95, momentum: 95 },
    { ratio: 97, momentum: 97 },
    { ratio: 100, momentum: 100 },
    { ratio: 103, momentum: 103 },
    { ratio: 105, momentum: 105 },
  ];
  const a = rrg.analyzeTrail(line);
  near(a.curvature, 0, 1e-9, '完全共線時曲率必須為 0');
  assert.strictEqual(a.signal === 'turning-cw' || a.signal === 'turning-ccw', false,
    '共線時不得報轉向');
});

t('H3 首尾重疊（原地打轉）→ 曲率 null，不可除以零', () => {
  const loop = [
    { ratio: 100, momentum: 105 },
    { ratio: 105, momentum: 100 },
    { ratio: 100, momentum: 95 },
    { ratio: 95, momentum: 100 },
    { ratio: 100, momentum: 105 },
  ];
  const a = rrg.analyzeTrail(loop);
  assert.strictEqual(a.curvature, null, '弦長為 0 時曲率必須是 null');
  assert.strictEqual(a.signal, 'flat', `原地打轉應判為 flat，實際 ${a.signal}`);
});

/* ============================================================
   I. 每期位移門檻與尾跡長度無關
   ============================================================ */
console.log('\n--- I. 每期門檻的尺度不變性 ---');

t('I1 直線路徑：尾跡拉長，speedPerBar 保持不變', () => {
  /* 絕對門檻的 bug：同一市場狀態在 3 點顯示「移動」、20 點顯示「快速移動」。
     除以段數後，同一條直線的速度必須與點數無關。 */
  function lineOf(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ ratio: 100 + i * 1.0, momentum: 100 + i * 1.0 });
    return out;
  }
  const s3 = rrg.analyzeTrail(lineOf(3)).speedPerBar;
  const s10 = rrg.analyzeTrail(lineOf(10)).speedPerBar;
  const s20 = rrg.analyzeTrail(lineOf(20)).speedPerBar;
  near(s3, s10, 1e-9, '3 點 vs 10 點');
  near(s10, s20, 1e-9, '10 點 vs 20 點');
  near(s20, Math.SQRT2, 1e-9, '每期位移應為 √2');
});

t('I2 極慢移動 → flat（不論點數）', () => {
  function slow(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ ratio: 100 + i * 0.05, momentum: 100 });
    return out;
  }
  assert.strictEqual(rrg.analyzeTrail(slow(5)).signal, 'flat', '5 點極慢應為 flat');
  assert.strictEqual(rrg.analyzeTrail(slow(20)).signal, 'flat', '20 點極慢應為 flat');
});

t('I3 極快移動 → fast（不論點數）', () => {
  function fast(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ ratio: 100 + i * 2.0, momentum: 100 });
    return out;
  }
  assert.strictEqual(rrg.analyzeTrail(fast(5)).signal, 'fast', '5 點極快應為 fast');
  assert.strictEqual(rrg.analyzeTrail(fast(20)).signal, 'fast', '20 點極快應為 fast');
});

/* ============================================================
   J. 尾跡分析只吃尾跡
   ============================================================ */
console.log('\n--- J. 尾跡長度正確性 ---');

t('J1 length 等於「首尾直線距離」，與中間點無關', () => {
  const a = { ratio: 100, momentum: 100 };
  const b = { ratio: 103, momentum: 104 };
  const straight = [a, { ratio: 101, momentum: 102 }, b];
  const zigzag = [a, { ratio: 105, momentum: 95 }, b];
  const l1 = rrg.analyzeTrail(straight).length;
  const l2 = rrg.analyzeTrail(zigzag).length;
  near(l1, 5, 1e-9, '首尾距離應為 5');
  assert.strictEqual(l1, l2, '中間點不同不影響首尾距離');
});

t('J2 efficiency 對直線為 1、對來回震盪明顯小於 1', () => {
  const straight = rrg.analyzeTrail([
    { ratio: 100, momentum: 100 }, { ratio: 102, momentum: 102 },
    { ratio: 104, momentum: 104 }, { ratio: 106, momentum: 106 },
  ]);
  near(straight.efficiency, 1, 1e-9, '直線的直線度應為 1');

  const zigzag = rrg.analyzeTrail([
    { ratio: 100, momentum: 100 }, { ratio: 110, momentum: 100 },
    { ratio: 100, momentum: 100 }, { ratio: 110, momentum: 100 },
  ]);
  assert.ok(zigzag.efficiency < 0.5,
    `來回震盪的直線度應遠小於 1，實際 ${zigzag.efficiency}`);
});

t('J3 只有 2 點時曲率為 null（無法量彎曲）', () => {
  const a = rrg.analyzeTrail([{ ratio: 100, momentum: 100 }, { ratio: 103, momentum: 102 }]);
  assert.strictEqual(a.curvature, null, '兩點無法構成彎曲，必須是 null');
  assert.ok(isFinite(a.length), '但長度仍應算得出來');
});

t('J4 0/1 點不拋錯，回 unknown', () => {
  assert.strictEqual(rrg.analyzeTrail([]).signal, 'unknown');
  assert.strictEqual(rrg.analyzeTrail([{ ratio: 100, momentum: 100 }]).signal, 'unknown');
  assert.strictEqual(rrg.analyzeTrail(null).signal, 'unknown');
});

/* ============================================================
   K. 參數正規化
   ============================================================ */
console.log('\n--- K. 參數正規化 ---');

t('K1 時間週期：預設週線、非法值報錯', () => {
  assert.strictEqual(rrg.normTimeframe('').key, 'weekly');
  assert.strictEqual(rrg.normTimeframe('daily').key, 'daily');
  assert.strictEqual(rrg.normTimeframe('MONTHLY').key, 'monthly', '需容錯大小寫');
  assert.strictEqual(rrg.normTimeframe('yearly').ok, false);
});

t('K2 尾跡長度：預設 5，超出範圍報錯', () => {
  assert.strictEqual(rrg.normTrail('').value, 5);
  assert.strictEqual(rrg.normTrail(8).value, 8);
  assert.strictEqual(rrg.normTrail(1).ok, false);
  assert.strictEqual(rrg.normTrail(999).ok, false);
});

t('K3 基準指數：預設第一個、非法值報錯', () => {
  assert.strictEqual(rrg.normBenchmark('').key, rrg.BENCHMARKS[0].key);
  assert.strictEqual(rrg.normBenchmark('QQQ').key, 'QQQ');
  assert.strictEqual(rrg.normBenchmark('AAPL').ok, false);
});

t('K4 版塊清單：未知代碼要回報而非靜默丟棄', () => {
  const r = rrg.normSectors('XLK,FAKE,XLF');
  assert.deepStrictEqual(r.keys.sort(), ['XLF', 'XLK']);
  assert.deepStrictEqual(r.unknown, ['FAKE']);
});

t('K5 版塊清單：空值代表全選', () => {
  const r = rrg.normSectors('');
  assert.strictEqual(r.keys.length, rrg.SECTORS.length);
  assert.deepStrictEqual(r.unknown, []);
});

t('K6 平滑週期：預設依週期不同，超出範圍報錯', () => {
  assert.strictEqual(rrg.normPeriod('', 'weekly').value, 14);
  assert.strictEqual(rrg.normPeriod('', 'monthly').value, 8);
  assert.strictEqual(rrg.normPeriod(2, 'weekly').ok, false);
  assert.strictEqual(rrg.normPeriod(61, 'weekly').ok, false);
});

/* ============================================================
   L. buildRRG 端到端（合成資料）
   ============================================================ */
console.log('\n--- L. buildRRG ---');

/** 建構一份可用的對齊矩陣：基準穩定上漲，各版塊有不同斜率 */
function syntheticMatrix(nPeriods, opts) {
  opts = opts || {};
  const dates = [];
  const t = [];
  const base = Date.UTC(2020, 0, 3);
  for (let i = 0; i < nPeriods; i++) {
    dates.push('2020-W' + String(i + 1).padStart(2, '0'));
    t.push(base + i * 7 * 86400000);
  }
  const rows = {};
  const bench = [];
  for (let i = 0; i < nPeriods; i++) bench.push(100 * Math.pow(1.004, i));
  rows[opts.benchKey || 'SPY'] = bench;

  const keys = opts.sectorKeys || ['XLK', 'XLF'];
  keys.forEach((k, idx) => {
    /* 每個版塊不同斜率：idx=0 較強、idx=1 較弱，形成可預期的象限分佈 */
    const slope = 1.006 - idx * 0.004;
    const arr = [];
    for (let i = 0; i < nPeriods; i++) arr.push(100 * Math.pow(slope, i));
    rows[k] = arr;
  });
  return { dates, t, rows };
}

t('L1 資料充足時回傳 11 個點（預設全部版塊）與正確的 diagnostics', () => {
  const m = syntheticMatrix(120, { sectorKeys: ['XLK', 'XLF'] });
  /* 只給兩個版塊的資料，其餘視為缺資料 → coverage 應標記 */
  const out = rrg.buildRRG({
    dates: m.dates, t: m.t, rows: m.rows,
    benchmarkKey: 'SPY', sectorKeys: ['XLK', 'XLF'],
    period: 14, windowBars: 52, trail: 5,
    meta: { sectors: rrg.SECTORS },
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.points.length, 2, '應只有 2 個可計算的版塊');
  assert.strictEqual(out.diagnostics.totalPeriods, 120);
  assert.strictEqual(out.diagnostics.warmup, 35);
  assert.strictEqual(out.diagnostics.period, 14);
  assert.strictEqual(out.diagnostics.trail, 5);
});

t('L2 尾跡點數等於 trail 設定', () => {
  const m = syntheticMatrix(120, { sectorKeys: ['XLK'] });
  [3, 5, 8, 15].forEach((trail) => {
    const out = rrg.buildRRG({
      dates: m.dates, t: m.t, rows: m.rows,
      benchmarkKey: 'SPY', sectorKeys: ['XLK'],
      period: 14, windowBars: 52, trail,
      meta: { sectors: rrg.SECTORS },
    });
    assert.strictEqual(out.points[0].trail.length, trail, `trail=${trail} 的尾跡應有 ${trail} 點`);
  });
});

t('L3 尾跡分析只基於尾跡，不含整個窗口（回歸測試）', () => {
  /* 曾誤把 52 點窗口餵給 analyzeTrail，算出長度 14.5，
     而畫面上一條 5 點尾跡只走了 1.6。這裡比對「尾跡長度」與
     「前端算得出來的尾跡首尾距離」是否一致。 */
  const m = syntheticMatrix(120, { sectorKeys: ['XLK'] });
  const out = rrg.buildRRG({
    dates: m.dates, t: m.t, rows: m.rows,
    benchmarkKey: 'SPY', sectorKeys: ['XLK'],
    period: 14, windowBars: 52, trail: 5,
    meta: { sectors: rrg.SECTORS },
  });
  const p = out.points[0];
  const t0 = p.trail[0];
  const t1 = p.trail[p.trail.length - 1];
  const geo = Math.hypot(t1.ratio - t0.ratio, t1.momentum - t0.momentum);
  near(p.analysis.length, geo, 0.02,
    'analysis.length 必須等於尾跡首尾距離（曾誤用整個窗口）');
});

t('L4 基準缺失 → NO_BENCHMARK', () => {
  const m = syntheticMatrix(120, { sectorKeys: ['XLK'] });
  const out = rrg.buildRRG({
    dates: m.dates, t: m.t, rows: { XLK: m.rows.XLK },
    benchmarkKey: 'SPY', sectorKeys: ['XLK'],
    period: 14, windowBars: 52, trail: 5,
    meta: { sectors: rrg.SECTORS },
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'NO_BENCHMARK');
});

t('L5 資料不足以暖機 → INSUFFICIENT_DATA 並附 hint', () => {
  const m = syntheticMatrix(20, { sectorKeys: ['XLK'] });   /* 20 < 暖機 35 */
  const out = rrg.buildRRG({
    dates: m.dates, t: m.t, rows: m.rows,
    benchmarkKey: 'SPY', sectorKeys: ['XLK'],
    period: 14, windowBars: 52, trail: 5,
    meta: { sectors: rrg.SECTORS },
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'INSUFFICIENT_DATA');
  assert.ok(/需.*期間/.test(out.hint) || out.hint.length > 0, '必須提供可操作的提示');
  assert.strictEqual(out.diagnostics.warmup, 35);
});

t('L6 部分版塊缺資料 → 其餘仍可出圖，coverage 標記原因', () => {
  const m = syntheticMatrix(120, { sectorKeys: ['XLK', 'XLF'] });
  const out = rrg.buildRRG({
    dates: m.dates, t: m.t, rows: m.rows,
    benchmarkKey: 'SPY', sectorKeys: ['XLK', 'XLF', 'XLE'],
    period: 14, windowBars: 52, trail: 5,
    meta: { sectors: rrg.SECTORS },
  });
  assert.strictEqual(out.ok, true, '缺一個版塊不該讓整張圖失敗');
  assert.strictEqual(out.points.length, 2);
  const missing = out.coverage.find((c) => c.key === 'XLE');
  assert.ok(missing, 'coverage 應包含 XLE');
  assert.strictEqual(missing.ok, false);
});

t('L7 每個點都帶齊前端需要的欄位', () => {
  const m = syntheticMatrix(120, { sectorKeys: ['XLK'] });
  const out = rrg.buildRRG({
    dates: m.dates, t: m.t, rows: m.rows,
    benchmarkKey: 'SPY', sectorKeys: ['XLK'],
    period: 14, windowBars: 52, trail: 5,
    meta: { sectors: rrg.SECTORS },
  });
  const p = out.points[0];
  ['key', 'label', 'short', 'color', 'ratio', 'momentum', 'quadrant',
    'quadrantLabel', 'asOf', 'trail', 'analysis', 'cross', 'series']
    .forEach((f) => assert.ok(f in p, `point 缺少欄位 ${f}`));
  ['length', 'angleDeg', 'curvature', 'efficiency', 'speedPerBar', 'bars', 'signal', 'signalCn']
    .forEach((f) => assert.ok(f in p.analysis, `analysis 缺少欄位 ${f}`));
});

t('L8 強勢版塊落在右側、弱勢落在左側（方向正確性）', () => {
  const m = syntheticMatrix(200, { sectorKeys: ['XLK', 'XLF'] });
  const out = rrg.buildRRG({
    dates: m.dates, t: m.t, rows: m.rows,
    benchmarkKey: 'SPY', sectorKeys: ['XLK', 'XLF'],
    period: 14, windowBars: 52, trail: 5,
    meta: { sectors: rrg.SECTORS },
  });
  const xlk = out.points.find((p) => p.key === 'XLK');   /* slope 1.006 > 基準 1.004 */
  const xlf = out.points.find((p) => p.key === 'XLF');   /* slope 1.002 < 基準 1.004 */
  assert.ok(xlk.ratio > 100, `跑贏基準的版塊 RS-Ratio 應 > 100，實際 ${xlk.ratio}`);
  assert.ok(xlf.ratio < 100, `跑輸基準的版塊 RS-Ratio 應 < 100，實際 ${xlf.ratio}`);
});

/* ============================================================
   M. 前端契約
   ============================================================ */
console.log('\n--- M. 前端契約 ---');

t('M1 index.html 包含 rrg-client.js 用到的所有 id', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ids = [
    'viewRrg', 'rrgCanvas', 'rrgChartWrap', 'rrgTip', 'rrgEmpty', 'rrgNotice',
    'rrgLegend', 'rrgStamp', 'rrgTableBody', 'rrgTable', 'rrgDiag',
    'rrgTimeframe', 'rrgWindow', 'rrgBenchmark', 'rrgTrail', 'rrgPeriod',
    'rrgTrailVal', 'rrgPeriodVal', 'rrgSectorChips', 'rrgSectorSummary', 'rrgRefresh',
  ];
  ids.forEach((id) => {
    assert.ok(html.indexOf('id="' + id + '"') >= 0, `index.html 缺少 id="${id}"`);
  });
});

t('M2 index.html 載入了 rrg-client.js 且順序在 common.js 之後', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const iCommon = html.indexOf('src="/common.js"');
  const iRrg = html.indexOf('src="/rrg-client.js"');
  assert.ok(iCommon >= 0, '必須載入 common.js');
  assert.ok(iRrg >= 0, '必須載入 rrg-client.js');
  assert.ok(iRrg > iCommon, 'rrg-client.js 依賴 window.SA，必須在 common.js 之後載入');
});

t('M3 導航有 rrg 入口，且 common.js 註冊了 rrg 路由', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const common = fs.readFileSync(path.join(__dirname, '..', 'public', 'common.js'), 'utf8');
  assert.ok(html.indexOf('data-route="rrg"') >= 0, '導航需有 data-route="rrg"');
  assert.ok(/rrg:\s*'rrg'/.test(common), 'ROUTES 需包含 rrg');
  assert.ok(/onRrg/.test(common), 'handlers 需包含 onRrg');
});

t('M4 sw.js 預快取清單包含新資產且版本已遞增', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.ok(sw.indexOf("'/rrg-client.js'") >= 0, 'SHELL_ASSETS 需包含 rrg-client.js');
  const m = sw.match(/const VERSION = '([^']+)'/);
  assert.ok(m, '必須有 VERSION 常數');
  /* 斷言「不低於某個下限」而不是「等於某個值」：
     寫死等於版本的話，每次為了新功能升版都會讓這條測試失敗，
     而失敗訊息（「必須升版」）在升版後反而變成誤導。
     真正要鎖的是「不能退回舊版」——只要 >= v1.0.5 就代表殼會更新。 */
  const ver = m[1];
  const num = ver.replace(/^v/, '').split('.').map(Number);
  const min = [1, 0, 5];
  const cmp = num[0] - min[0] || num[1] - min[1] || (num[2] || 0) - min[2];
  assert.ok(cmp >= 0, `版本必須 >= v1.0.5（新頁面需要升版才會更新殼），目前 ${ver}`);
});

t('M5 rrg-client.js 不使用 ES6+ 語法（與其他前端檔案一致，走 ES5）', () => {
  /* app.js / screen.js / macro.js 都是 ES5（var + function），
     混用箭頭函式或 const 會讓樣式不一致，也讓既有 lint 假設失效。 */
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'rrg-client.js'), 'utf8');
  /* 去掉字串與註解後再檢查，避免誤判文案裡的符號 */
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.strictEqual(/=>/.test(stripped), false, '不應使用箭頭函式');
  assert.strictEqual(/\bconst\b/.test(stripped), false, '不應使用 const');
  assert.strictEqual(/\blet\b/.test(stripped), false, '不應使用 let');
});

t('M6 SECTORS 涵蓋 11 個 SPDR 版塊，且各有顏色與簡稱', () => {
  assert.strictEqual(rrg.SECTORS.length, 11, `應有 11 個版塊，實際 ${rrg.SECTORS.length}`);
  rrg.SECTORS.forEach((s) => {
    assert.ok(/^XL/.test(s.key), `${s.key} 不是 SPDR 版塊代碼`);
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(s.color), `${s.key} 的顏色格式不對：${s.color}`);
    assert.ok(s.label && s.short, `${s.key} 缺少 label 或 short`);
  });
  /* 顏色不可重複，否則圖上分不出來 */
  const colors = rrg.SECTORS.map((s) => s.color.toLowerCase());
  assert.strictEqual(new Set(colors).size, colors.length, '版塊顏色不可重複');
});

t('M7 BENCHMARKS 至少含 S&P 500，且第一個是預設', () => {
  assert.ok(rrg.BENCHMARKS.length >= 2, '至少要有兩個基準可選');
  assert.strictEqual(rrg.BENCHMARKS[0].key, 'SPY');
  rrg.BENCHMARKS.forEach((b) => {
    /* 欄位名是 note 而非 cn —— 曾在前端誤讀 .cn 導致選單顯示「（undefined）」。 */
    assert.ok(b.key && b.label && b.note, `${b.key} 缺少 label 或 note`);
  });
});

t('M9 三個檢視容器是兄弟節點（不可互為父子）', () => {
  /* 實際踩到的坑：加 #viewRrg 時漏掉 #viewMacro 的收尾 </div>，
     導致 #viewRrg 變成 #viewMacro 的子節點。
     因為 #viewMacro 帶 hidden，整頁 RRG 就永遠是 0 寬 0 高——
     沒有 JS 錯誤、資料也抓到了、表格也有內容，但畫面上什麼都看不到。
     這種「靜默佈局壞掉」只能靠結構檢查抓。 */
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));

  /* div 必須配對 */
  const open = (main.match(/<div\b/g) || []).length;
  const close = (main.match(/<\/div>/g) || []).length;
  assert.strictEqual(open, close, `<main> 內 div 未配對：開 ${open} / 收 ${close}`);

  /* 每個檢視容器都要有明確的收尾註解，順序必須是 開→收 交錯而非嵌套 */
  const marks = [];
  const re = /<div id="(viewChart|viewScreen|viewMacro|viewRrg)"|<\/div><!-- \/#(viewChart|viewScreen|viewMacro|viewRrg) -->/g;
  let m;
  while ((m = re.exec(main)) !== null) {
    if (m[1]) marks.push({ kind: 'open', name: m[1], at: m.index });
    else marks.push({ kind: 'close', name: m[2], at: m.index });
  }
  assert.strictEqual(marks.length, 8,
    `應有 4 個檢視的開與收共 8 個標記，實際 ${marks.length}`);

  const stack = [];
  marks.forEach((mk) => {
    if (mk.kind === 'open') stack.push(mk.name);
    else {
      const top = stack.pop();
      assert.strictEqual(top, mk.name,
        `收尾順序錯誤：${mk.name} 收尾時，最內層是 ${top}（表示發生嵌套）`);
    }
  });
  assert.strictEqual(stack.length, 0, '有檢視容器沒有收尾');
});

t('M8 API 回應不含 undefined 欄位（benchmarkCn 曾誤讀 .cn）', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.indexOf('benchmarkNote: bench.def.note') >= 0,
    'server.js 應回傳 benchmarkNote（BENCHMARKS 的欄位是 note 不是 cn）');
  assert.strictEqual(/benchmarkCn\s*:/.test(server), false,
    '不應回傳 benchmarkCn（該欄位在 BENCHMARKS 中不存在，值必為 undefined）');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'rrg-client.js'), 'utf8');
  assert.strictEqual(/b\.cn\b/.test(client), false,
    '前端不應讀取 b.cn（會顯示 undefined）');
});

/* ============================================================
   結果
   ============================================================ */
console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
if (fail) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f.name}: ${f.msg}`));
}
process.exit(fail === 0 ? 0 : 1);
