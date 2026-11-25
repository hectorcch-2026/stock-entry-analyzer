'use strict';

/**
 * FP（K 線區間預測）單元測試 — 不需連網
 *
 * 為什麼要另寫一份不連網的測試：
 *   網路測試（tests/e2e-*.mjs）只能驗「有資料時長什麼樣」，
 *   無法穩定製造「復權不可用」「樣本不足」這些分支。
 *   但這些分支恰恰是規格 §4.4 最在意的部分：
 *   「寧可沒有預測，也不要錯的預測」—— 說錯話比不說話嚴重得多。
 *   因此這裡用注入的假 datasource 直接驅動每個狀態。
 *
 * 覆蓋範圍：
 *   A. 復權拒絕（tencent / 未知來源 / Yahoo 缺 adjclose）
 *   B. 樣本不足
 *   C. 正常輸出結構與確定性（AC-11：同輸入必得同輸出）
 *   D. FP-0 換算禁令：pred 不得讀取或推導自 buyZone / probabilities
 *   E. 異常值偵測與權重
 *   F. judge() 門檻（另見 scripts/test-gate-negative.js）
 *
 * 用法：node tests/forecast-unit.cjs
 */

const assert = require('assert');
const forecast = require('../lib/forecast');
const adjust = require('../lib/adjust');
const anomaly = require('../lib/anomaly');

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

/** 產生確定性的合成 K 線（幾何隨機漫步 + 可選的波動率變化） */
function makeCandles(n, opts = {}) {
  const start = opts.start || 100;
  const drift = opts.drift || 0.0003;
  const vol = opts.vol || 0.015;
  let seed = opts.seed || 12345;
  const rnd = () => {
    // LCG，確保跨平台跨版本完全可重現
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9);
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    c = c * Math.exp(drift + vol * gauss());
    const o = c * (1 + 0.004 * gauss());
    const h = Math.max(o, c) * (1 + Math.abs(0.006 * gauss()));
    const l = Math.min(o, c) * (1 - Math.abs(0.006 * gauss()));
    out.push({
      t: Date.UTC(2020, 0, 1) + i * 86400000,
      o: +o.toFixed(4), h: +h.toFixed(4), l: +l.toFixed(4), c: +c.toFixed(4),
      v: Math.round(1e6 * (1 + 0.3 * gauss())),
    });
  }
  return out;
}

/** 假 datasource：回傳指定來源與復權狀態 */
function stubDS(sourceName, candles, adjClose) {
  return {
    async chartWithAdj() {
      return {
        candles,
        adjClose: adjClose === undefined ? null : adjClose,
        adj: sourceName === 'tencent' ? 'none' : null,
        source: sourceName,
        bars: candles.length,
        meta: { symbol: 'TEST' },
      };
    },
  };
}

console.log('\n========== FP 單元測試（離線）==========\n');

/* ============ A. 復權拒絕 ============ */
console.log('[A] 復權不可用必須明確拒絕，不得降級使用');

t('A1 騰訊來源 → status=adj_unavailable，且不給任何區間數值', () => {
  const c = makeCandles(600);
  return forecast.buildPrediction(stubDS('tencent', c), 'TEST', {}).then((p) => {
    assert.strictEqual(p.status, 'adj_unavailable');
    assert.deepStrictEqual(p.horizons, {}, '不可輸出任何 horizons');
    assert.ok(/復權/.test(p.reason), 'reason 應說明復權問題');
  });
});

t('A2 未知來源 → 一律拒絕（不做任何假設）', () => {
  const c = makeCandles(600);
  const s = adjust.buildAdjustedSeries('somebroker', c, null);
  assert.strictEqual(s.adj, 'none');
  assert.strictEqual(adjust.isUsable(s.adj), false);
});

t('A3 Yahoo 但 adjClose 為 null → 拒絕（不可當成已復權）', () => {
  const c = makeCandles(600);
  const s = adjust.buildAdjustedSeries('yahoo', c, null);
  assert.strictEqual(s.adj, 'none');
  assert.strictEqual(adjust.isUsable(s.adj), false);
});

t('A4 Yahoo 且 adjClose 長度不符 → 拒絕（不可錯位對齊）', () => {
  const c = makeCandles(600);
  const s = adjust.buildAdjustedSeries('yahoo', c, new Array(599).fill(1));
  assert.strictEqual(s.adj, 'none');
});

t('A5 predict() 直接收到 adj=none 時回 adj_unavailable', () => {
  const c = makeCandles(600);
  const p = forecast.predict(c, { adj: 'none', minSamples: 250 });
  assert.strictEqual(p.status, 'adj_unavailable');
  assert.deepStrictEqual(p.horizons, {});
});

/* ============ B. 樣本不足 ============ */
console.log('\n[B] 樣本不足必須明確回 insufficient');

t('B1 100 根 < 250 根門檻 → insufficient，附 available/required', () => {
  const c = makeCandles(100);
  const p = forecast.predict(c, { adj: 'yahoo-adjclose', minSamples: 250 });
  assert.strictEqual(p.status, 'insufficient');
  assert.strictEqual(p.available, 100);
  assert.strictEqual(p.required, 250);
  assert.deepStrictEqual(p.horizons, {}, '不可輸出區間');
});

t('B2 序列為空 → 不拋錯，回 insufficient', () => {
  const p = forecast.predict([], { adj: 'yahoo-adjclose' });
  assert.strictEqual(p.status, 'insufficient');
});

/* ============ C. 正常輸出與確定性 ============ */
console.log('\n[C] 正常輸出的結構、單調性與確定性');

const goodSeries = (() => {
  const raw = makeCandles(1200, { seed: 999, vol: 0.018 });
  return adjust.buildAdjustedSeries('yahoo', raw, raw.map((b) => b.c));
})();

t('C1 1200 根已復權 → status=ok，三個週期齊備', () => {
  const p = forecast.predict(goodSeries.candles, { adj: goodSeries.adj });
  assert.strictEqual(p.status, 'ok');
  for (const h of [5, 10, 20]) {
    assert.strictEqual(p.horizons[h].status, 'ok', `h${h} 應為 ok`);
  }
});

t('C2 分位數必須單調：q10 ≤ q25 ≤ q50 ≤ q75 ≤ q90', () => {
  const p = forecast.predict(goodSeries.candles, { adj: goodSeries.adj });
  for (const h of [5, 10, 20]) {
    const o = p.horizons[h];
    const seq = [o.q10, o.q25, o.q50, o.q75, o.q90];
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] >= seq[i - 1], `h${h} 分位數不單調：${seq.join(',')}`);
    }
    assert.ok(o.q10 > 0, '價格下界必須為正（對數空間保證）');
  }
});

t('C3 週期越長區間越寬（√h 縮放）', () => {
  const p = forecast.predict(goodSeries.candles, { adj: goodSeries.adj });
  const w = (h) => p.horizons[h].q90 - p.horizons[h].q10;
  assert.ok(w(10) > w(5), `h10 (${w(10).toFixed(2)}) 應寬於 h5 (${w(5).toFixed(2)})`);
  assert.ok(w(20) > w(10), `h20 (${w(20).toFixed(2)}) 應寬於 h10 (${w(10).toFixed(2)})`);
});

t('C4 確定性：同輸入連續呼叫兩次結果完全相同（AC-11）', () => {
  const a = forecast.predict(goodSeries.candles, { adj: goodSeries.adj });
  const b = forecast.predict(goodSeries.candles, { adj: goodSeries.adj });
  assert.deepStrictEqual(a.horizons, b.horizons);
});

t('C5 確定性：同一序列重新複製一份，結果仍相同', () => {
  const copy = goodSeries.candles.map((c) => ({ ...c }));
  const a = forecast.predict(goodSeries.candles, { adj: goodSeries.adj });
  const b = forecast.predict(copy, { adj: goodSeries.adj });
  assert.deepStrictEqual(a.horizons, b.horizons);
});

t('C6 不確定性說明必須存在且非空（規格 §8.4）', () => {
  const p = forecast.predict(goodSeries.candles, { adj: goodSeries.adj });
  assert.ok(p.note && p.note.length > 10, 'note 不可為空');
  assert.ok(/非價格預測|不構成投資建議/.test(p.note), 'note 必須含免責語意');
});

t('C7 不得輸出方向機率欄位（路徑 A 已刪除方向）', () => {
  const p = forecast.predict(goodSeries.candles, { adj: goodSeries.adj });
  const dump = JSON.stringify(p);
  assert.ok(!/p_up|pUp|direction|probUp/.test(dump), `不應出現方向機率欄位：${dump.slice(0, 200)}`);
});

/* ============ D. FP-0 換算禁令 ============ */
console.log('\n[D] FP-0：pred 不得與既有分析數值互相換算');

t('D1 predict() 不讀取 buyZone / probabilities（注入誘餌不被採用）', () => {
  const bait = {
    ...goodSeries.candles[0],
    buyZone: { lower: 1, upper: 2 },
    probabilities: { probUp20: 0.99 },
  };
  // 誘餌掛在陣列上，若模型誤讀會產生極端值
  const arr = goodSeries.candles.slice();
  arr.buyZone = { lower: 1, upper: 2 };
  arr.probabilities = { probUp20: 0.99 };
  void bait;
  const p = forecast.predict(arr, { adj: goodSeries.adj });
  const base = forecast.predict(goodSeries.candles, { adj: goodSeries.adj });
  assert.deepStrictEqual(p.horizons, base.horizons, '結果不應受額外欄位影響');
});

t('D2 模組不 export 任何由 probabilities 轉換的函式', () => {
  const names = Object.keys(forecast);
  assert.ok(!names.some((n) => /prob|brier|direction/i.test(n)), `不應有方向機率相關匯出：${names.join(',')}`);
});

/* ============ E. 異常值 ============ */
console.log('\n[E] 異常值偵測與處理');

t('E1 插入 +60% 跳空 → 被標記為 outlier', () => {
  const c = makeCandles(400, { seed: 7, vol: 0.01 }).map((x) => ({ ...x }));
  const i = 300;
  const f = 1.6;
  c[i] = { ...c[i], o: c[i].o * f, h: c[i].h * f, l: c[i].l * f, c: c[i].c * f };
  const rep = anomaly.inspect(c);
  assert.ok(rep.outliers.length > 0, '應偵測到異常根');
  // outliers 回傳的是 {date, logRet} 而非索引，故以日期比對
  const wantDate = new Date(c[i].t).toISOString().slice(0, 10);
  const dates = rep.outliers.map((o) => o.date);
  assert.ok(dates.includes(wantDate), `異常日期應含 ${wantDate}，實際 ${dates.join(',')}`);
});

t('E2 異常根不刪除，只降權（維持 t→t+h 期間對齊）', () => {
  const c = makeCandles(400, { seed: 8, vol: 0.01 });
  const rep = anomaly.inspect(c);
  const w = anomaly.sampleWeights(c.length, rep, c);
  assert.strictEqual(w.length, c.length, '權重長度必須等於序列長度');
});

t('E3 連續 5 根 h==l → 標記停滯', () => {
  const c = makeCandles(400, { seed: 9, vol: 0.01 }).map((x) => ({ ...x }));
  for (let i = 200; i < 206; i++) {
    c[i] = { ...c[i], o: c[i].c, h: c[i].c, l: c[i].c };
  }
  const rep = anomaly.inspect(c);
  assert.ok(rep.stagnation.length > 0, '應偵測到停滯');
});

t('E4 少於 250 根 → inspect 回 ok=false 並說明原因（訊息須為人可讀）', () => {
  const rep = anomaly.inspect(makeCandles(100));
  assert.strictEqual(rep.ok, false);
  assert.strictEqual(rep.reasonCode, 'insufficient');
  assert.ok(/250|不足/.test(rep.reason || ''), `reason 應為中文說明而非代碼：${rep.reason}`);
  assert.ok(!/^[a-z_]+$/.test(rep.reason), `reason 不可只是代碼：${rep.reason}`);
});

t('E5 乾淨序列 → quality=high，無異常', () => {
  const c = makeCandles(800, { seed: 11, vol: 0.01 });
  const rep = anomaly.inspect(c);
  assert.strictEqual(rep.outliers.length, 0);
  assert.strictEqual(rep.quality, 'high');
});

/* ============ F. 回測與門檻 ============ */
console.log('\n[F] 回測與門檻行為');

t('F1 回測只用已完成標籤，不洩漏未來（可重現）', () => {
  const c = goodSeries.candles;
  const a = forecast.backtestIntervals(c, { minOrigins: 30 });
  const b = forecast.backtestIntervals(c, { minOrigins: 30 });
  assert.deepStrictEqual(a.horizons, b.horizons, '回測必須可重現');
});

t('F2 回測回傳 meanSigma 供寬度基準使用（A-33）', () => {
  const bt = forecast.backtestIntervals(goodSeries.candles, { minOrigins: 30 });
  for (const h of [5, 10, 20]) {
    const o = bt.horizons[h];
    if (o && o.status === 'ok') {
      assert.ok(o.meanSigma > 0, `h${h} 應有正的平均波動率，實際 ${o.meanSigma}`);
    }
  }
});

t('F3 序列過短 → 回測回 insufficient 而非拋錯', () => {
  const bt = forecast.backtestIntervals(makeCandles(100), { minTraining: 250 });
  assert.strictEqual(bt.status, 'insufficient');
});

console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
if (fail) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f.name}: ${f.msg}`));
}
process.exit(fail === 0 ? 0 : 1);
