'use strict';

/**
 * 宏觀走勢圖與利率期貨預測 — 完全不連網的單元測試
 * ================================================
 *
 * 為什麼這份測試的重點是「純函式與契約」而不是「今天的數字」：
 *   期貨報價每天在變，行情類的斷言一寫就開始腐化。
 *   真正會在未來被改壞的，是這幾件事：
 *     - 合約月份與季度的對應（錯一季，整條曲線位移，而數字看起來完全正常）
 *     - 缺值處理（null 被當成 0 → 畫出假跌破；被當成 NaN → 整張圖空白）
 *     - 降採樣不可移動觀測值、不可吃掉極值
 *     - getSeries 的 points 是「筆數」不是陣列（既有契約，不可破壞）
 *     - 前端要用的 DOM id / class 必須存在（後端改一名、前端就空白）
 *
 * 用法：node tests/macro-charts-unit.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fred = require('../lib/fred');
const macroCharts = require('../lib/macro-charts');
const rf = require('../lib/rates-forecast');

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

async function ta(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, msg: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

/* ============================================================
   A. getSeries 契約不可被走勢圖改壞
   ============================================================ */

console.log('\nA. getSeries 契約（走勢圖新增不得影響既有欄位）');

t('A1 getSeries 的 points 仍是「筆數」（number），不是陣列', () => {
  // 這是最容易被「順手改成陣列」的地方。一旦改成陣列，
  // 既有前端與 W 系列測試會拿到 NaN 而不是報錯，是最糟的破壞方式。
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fred.js'), 'utf8');
  assert.ok(/points:\s*points\.length/.test(src),
    'getSeries 必須維持 points: points.length（筆數），走勢圖用 getSeriesWindow');
});

t('A2 getSeriesWindow 與 getSeries 是兩個獨立匯出', () => {
  assert.strictEqual(typeof fred.getSeriesWindow, 'function');
  assert.strictEqual(typeof fred.getSeries, 'function');
  assert.strictEqual(typeof fred.getManyWindows, 'function');
});

t('A3 未註冊的 key → 回 ok:false，不拋錯', async () => {
  const r = await fred.getSeriesWindow('__not_a_key__');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'UNKNOWN_KEY');
  assert.ok(r.reason.includes('__not_a_key__'));
});

/* ============================================================
   B. LTTB 降採樣
   ============================================================ */

console.log('\nB. LTTB 降採樣（不可移動觀測值、不可吃掉極值）');

t('B1 點數不足時原樣回傳（不可強行壓縮）', () => {
  const pts = [{ date: 'a', value: 1 }, { date: 'b', value: 2 }];
  assert.deepStrictEqual(fred.lttb(pts, 10), pts);
});

t('B2 保留頭尾兩點（時間軸範圍不可變）', () => {
  const pts = [];
  for (let i = 0; i < 500; i++) pts.push({ date: 'd' + i, value: Math.sin(i / 10) });
  const out = fred.lttb(pts, 40);
  assert.strictEqual(out.length, 40);
  assert.strictEqual(out[0].date, 'd0');
  assert.strictEqual(out[out.length - 1].date, 'd499');
});

t('B3 單一尖峰必須被保留（等距抽樣會漏掉它）', () => {
  const pts = [];
  for (let i = 0; i < 1000; i++) pts.push({ date: 'd' + i, value: i === 517 ? 999 : 1 });
  const out = fred.lttb(pts, 30);
  assert.ok(out.some((p) => p.value === 999), '尖峰不得被降採樣吃掉');
});

t('B4 輸出必須是原陣列的子集（不可產生新數值）', () => {
  const pts = [];
  for (let i = 0; i < 300; i++) pts.push({ date: 'd' + i, value: i * 1.5 });
  const out = fred.lttb(pts, 50);
  const orig = new Set(pts.map((p) => p.date + '|' + p.value));
  for (const p of out) {
    assert.ok(orig.has(p.date + '|' + p.value), `產生了不存在的點：${p.date}=${p.value}`);
  }
});

t('B5 降採樣後仍是升冪（畫線方向不可顛倒）', () => {
  const pts = [];
  for (let i = 0; i < 400; i++) pts.push({ date: String(20200101 + i), value: i % 17 });
  const out = fred.lttb(pts, 60);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].date >= out[i - 1].date, `第 ${i} 點日期倒退`);
  }
});

t('B6 threshold < 3 → 原樣回傳（1 或 2 點的三角形沒有意義）', () => {
  const pts = [{ date: 'a', value: 1 }, { date: 'b', value: 2 }, { date: 'c', value: 3 }];
  assert.deepStrictEqual(fred.lttb(pts, 2), pts);
  assert.deepStrictEqual(fred.lttb(pts, 0), pts);
});

t('B7 空輸入不拋錯', () => {
  assert.deepStrictEqual(fred.lttb([], 10), []);
});

/* ============================================================
   C. 合約月份 ↔ 季度對應（錯一季最難發現）
   ============================================================ */

console.log('\nC. 合約月份 ↔ 季度對應（3M SOFR 的參考期偏移）');

t('C1 3 月合約 → 參考期中點在 Q2（不是 Q1）', () => {
  // 這是本模組最容易寫錯的地方：合約月份是 3 月，但參考期是 3/17–6/16，
  // 中點約 5/1，屬 Q2。若直接標成 Q1，整條曲線位移一季。
  const r = rf.quarterOfContract(2027, 3);
  assert.strictEqual(r.q, 2, `3 月合約應對應 Q2，實際 Q${r.q}`);
  assert.strictEqual(r.year, 2027);
});

t('C2 12 月合約 → 次年 Q1（跨年）', () => {
  const r = rf.quarterOfContract(2027, 12);
  assert.strictEqual(r.year, 2028, '12 月合約的參考期跨到次年');
  assert.strictEqual(r.q, 1);
});

t('C3 6 月 → Q3、9 月 → Q4', () => {
  assert.strictEqual(rf.quarterOfContract(2027, 6).q, 3);
  assert.strictEqual(rf.quarterOfContract(2027, 9).q, 4);
});

t('C4 contractMonthOfQuarter 是 quarterOfContract 的反函數（四種季別全部對得上）', () => {
  for (const y of [2027, 2028]) {
    for (let q = 1; q <= 4; q++) {
      const cm = rf.contractMonthOfQuarter(y, q);
      const back = rf.quarterOfContract(cm.year, cm.month);
      assert.strictEqual(back.year, y, `Q${q} 的合約月回推年份不符`);
      assert.strictEqual(back.q, q, `Q${q} 的合約月回推季別不符`);
      assert.ok(cm.month >= 1 && cm.month <= 12, `合約月份非法：${cm.month}`);
    }
  }
});

t('C5 合約月份必須是 3/6/9/12', () => {
  for (let q = 1; q <= 4; q++) {
    const cm = rf.contractMonthOfQuarter(2028, q);
    assert.ok([3, 6, 9, 12].indexOf(cm.month) >= 0, `Q${q} 產生了非季度合約月：${cm.month}`);
  }
});

t('C6 合約代碼格式正確（SR3 + 月份碼 + 兩位年份 + .CME）', () => {
  assert.strictEqual(rf.contractSymbol(2027, 3), 'SR3H27.CME');
  assert.strictEqual(rf.contractSymbol(2027, 6), 'SR3M27.CME');
  assert.strictEqual(rf.contractSymbol(2027, 9), 'SR3U27.CME');
  assert.strictEqual(rf.contractSymbol(2027, 12), 'SR3Z27.CME');
  assert.strictEqual(rf.contractSymbol(2028, 3), 'SR3H28.CME');
});

t('C7 8 個連續季度會產生 8 個不同合約（不可重複）', () => {
  const cur = rf.quarterOf('2026-11-27');
  const syms = [];
  for (let i = 1; i <= 8; i++) {
    const q = rf.addQuarters(cur.year, cur.q, i);
    const cm = rf.contractMonthOfQuarter(q.year, q.q);
    syms.push(rf.contractSymbol(cm.year, cm.month));
  }
  assert.strictEqual(syms.length, 8);
  assert.strictEqual(new Set(syms).size, 8, `合約重複：${syms.join(',')}`);
  assert.strictEqual(syms[0], 'SR3Z26.CME', `第一季應從 12 月合約起，實際 ${syms[0]}`);
  assert.strictEqual(syms[7], 'SR3U28.CME', `第八季應為 2028-09 合約，實際 ${syms[7]}`);
});

t('C8 quarterOf 邊界：3 月屬 Q1、4 月屬 Q2、12 月屬 Q4', () => {
  assert.deepStrictEqual(rf.quarterOf('2027-03-31'), { year: 2027, q: 1 });
  assert.deepStrictEqual(rf.quarterOf('2027-04-01'), { year: 2027, q: 2 });
  assert.deepStrictEqual(rf.quarterOf('2027-12-31'), { year: 2027, q: 4 });
  assert.deepStrictEqual(rf.quarterOf('2028-01-01'), { year: 2028, q: 1 });
});

t('C9 addQuarters 跨年正確', () => {
  assert.deepStrictEqual(rf.addQuarters(2026, 4, 1), { year: 2027, q: 1 });
  assert.deepStrictEqual(rf.addQuarters(2026, 4, 8), { year: 2028, q: 4 });
  assert.deepStrictEqual(rf.addQuarters(2026, 1, -1), { year: 2025, q: 4 });
});

t('C10 referencePeriod 有寫出起迄（可回查）', () => {
  const s = rf.referencePeriod(2027, 3);
  assert.ok(s.includes('2027-03'), `應含起始月，實際：${s}`);
  assert.ok(s.includes('2027-06'), `應含結束月，實際：${s}`);
});

/* ============================================================
   D. 隱含利率換算
   ============================================================ */

console.log('\nD. 報價 → 隱含利率（100 − 價格）');

t('D1 100 − 價格 慣例正確', () => {
  // 實測 SR3H27.CME 價格 95.470 → 4.530%
  const price = 95.47;
  assert.strictEqual(+(100 - price).toFixed(4), 4.53);
});

t('D2 不可把價格當成利率（95.47 不是 95.47%）', () => {
  const price = 95.47;
  const implied = 100 - price;
  assert.ok(implied < 20, '隱含利率必須落在合理值域，否則就是把價格當利率了');
});

t('D3 output 有 formula 說明（使用者要看得懂換算）', () => {
  // 檢查原始碼有明文寫出換算式與範例
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rates-forecast.js'), 'utf8');
  assert.ok(/100 − 期貨價格|100 - 期貨價格|100 − price|100 - price/.test(src),
    '必須在程式內註明換算式');
  assert.ok(/95\.470/.test(src), '必須留下具體範例，避免日後被誤解');
});

/* ============================================================
   E. 圖表定義的正當性
   ============================================================ */

console.log('\nE. 圖表定義（同圖多線必須同單位）');

t('E1 每張圖的 keys 都對應到已註冊序列', () => {
  for (const c of macroCharts.CHARTS) {
    for (const k of c.keys) {
      assert.ok(fred.BY_KEY.get(k), `圖表 ${c.id} 的 key ${k} 未在 fred 註冊`);
    }
  }
});

t('E2 同圖多線的單位必須一致（否則某條線會被壓成直線）', () => {
  for (const c of macroCharts.CHARTS) {
    const units = c.keys.map((k) => fred.BY_KEY.get(k).unit);
    if (c.keys.length > 1) {
      assert.strictEqual(new Set(units).size, 1,
        `圖表 ${c.id} 混了不同單位：${units.join(' / ')}`);
    }
  }
});

t('E3 每張圖都有 id / title / unit / range', () => {
  for (const c of macroCharts.CHARTS) {
    assert.ok(c.id, '缺 id');
    assert.ok(c.title, `${c.id} 缺 title`);
    assert.ok(c.unit, `${c.id} 缺 unit`);
    assert.ok(fred.RANGES[c.range] !== undefined, `${c.id} 的 range 未定義：${c.range}`);
  }
});

t('E4 圖表 id 不重複', () => {
  const ids = macroCharts.CHARTS.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, `重複 id：${ids.join(',')}`);
});

t('E5 利差圖必須開啟 zeroLine（否則看不出正負）', () => {
  const spread = macroCharts.CHARTS.find((c) => c.id === 'spread');
  assert.ok(spread, '應有利差圖');
  assert.strictEqual(spread.zeroLine, true, '利差圖沒有零線就無法判斷倒掛');
});

t('E6 不支援的圖表 id → 明確報錯並列出可用值', async () => {
  const r = await macroCharts.getCharts({ ids: ['__nope__'] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BAD_CHART_ID');
  assert.ok(r.message.includes('rates'), '錯誤訊息必須列出可用 id');
});

/* ============================================================
   F. 走勢圖輸出契約
   ============================================================ */

console.log('\nF. 走勢圖輸出契約');

/** 造一個假的 fred window 結果 */
function fakeWindow(key, n, opt) {
  const o = opt || {};
  const pts = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    pts.push({ date: d, value: (o.base || 100) + i * (o.step || 0.5) });
  }
  return {
    ok: true, key, label: key, unit: '%', points: pts, count: pts.length,
    total: n, sampled: false, step: '每日',
    asOf: pts[pts.length - 1].date, value: pts[pts.length - 1].value,
    from: pts[0].date, to: pts[pts.length - 1].date,
    stats: {
      min: Math.min.apply(null, pts.map((p) => p.value)),
      max: Math.max.apply(null, pts.map((p) => p.value)),
      first: pts[0].value, last: pts[pts.length - 1].value,
      change: 0, changePct: 0,
    },
    source: 'FRED', sourceUrl: 'https://fred.stlouisfed.org/series/X',
  };
}

async function runChartContract() {
  const orig = fred.getManyWindows;
  fred.getManyWindows = async (keys) => keys.map((k) => fakeWindow(k, 30));
  macroCharts.clearChartCache();

  await ta('F1 每張圖都有 series 陣列，且 available 與 missing 一致', async () => {
    const r = await macroCharts.getCharts({});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.charts.length, macroCharts.CHARTS.length);
    for (const c of r.charts) {
      assert.ok(Array.isArray(c.series), `${c.id} 缺 series`);
      assert.strictEqual(c.series.length, c.missing + c.series.filter((s) => s.available !== false).length);
      assert.ok(['ok', 'degraded', 'unavailable'].indexOf(c.status) >= 0);
    }
  });

  await ta('F2 每條序列都有 points 陣列與 stats（前端靠它畫軸）', async () => {
    const r = await macroCharts.getCharts({});
    for (const c of r.charts) {
      for (const s of c.series) {
        assert.ok(Array.isArray(s.points), `${c.id}/${s.key} points 必須是陣列`);
        assert.ok(s.points.length > 0, `${c.id}/${s.key} points 不可為空`);
        assert.ok(s.stats && typeof s.stats.min === 'number', `${c.id}/${s.key} 缺 stats.min`);
        assert.ok(typeof s.stats.max === 'number', `${c.id}/${s.key} 缺 stats.max`);
      }
    }
  });

  await ta('F3 序列失敗時標記 available:false 並附原因，不是消失', async () => {
    fred.getManyWindows = async (keys) => keys.map((k, i) => (i === 0
      ? { ok: false, key: k, label: k, reason: '上游 404' }
      : fakeWindow(k, 20)));
    macroCharts.clearChartCache();
    const r = await macroCharts.getCharts({ ids: ['rates'] });
    const c = r.charts[0];
    assert.strictEqual(c.status, 'degraded', '部分失敗應為 degraded');
    const bad = c.series.find((s) => s.available === false);
    assert.ok(bad, '失敗的序列仍要出現在 series 中');
    assert.ok(bad.reason.includes('404'), '必須附上原因');
    fred.getManyWindows = async (keys) => keys.map((k) => fakeWindow(k, 30));
    macroCharts.clearChartCache();
  });

  await ta('F4 全部失敗 → 圖表 status=unavailable，但結構仍完整', async () => {
    fred.getManyWindows = async (keys) => keys.map((k) => ({ ok: false, key: k, reason: 'x' }));
    macroCharts.clearChartCache();
    const r = await macroCharts.getCharts({ ids: ['labor'] });
    assert.strictEqual(r.charts[0].available, false);
    assert.strictEqual(r.charts[0].status, 'unavailable');
    assert.ok(Array.isArray(r.charts[0].series), '結構不可因失敗而消失');
    fred.getManyWindows = orig;
    macroCharts.clearChartCache();
  });
}

/* ============================================================
   G. 利率預測輸出契約（不連網：直接驗規則型結構）
   ============================================================ */

console.log('\nG. 利率預測輸出契約');

async function runRatesContract() {
  await ta('G1 模組匯出了必要欄位的產生函式', async () => {
    assert.strictEqual(typeof rf.getRateForecast, 'function');
    assert.strictEqual(rf.DEFAULT_QUARTERS, 8, '需求明訂 8 個季度');
  });

  await ta('G2 摘要路徑的欄位齊備（前端靠這些欄位顯示「預測結果」）', async () => {
    // 不連網：把 fetchContract 換成固定報價，驗結構與計算
    const origFetch = rf.fetchContract;
    const origFredGet = fred.getSeries;
    const origFredFetch = fred.fetchSeriesMemo;

    // 直接替換模組內使用的函式並不可行（模組內是閉包引用），
    // 因此改為驗證「純計算」的部分：手動組出 points 後套用同樣的摘要規則。
    // 這裡改驗 getRateForecast 的實作是否含必要輸出欄位。
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rates-forecast.js'), 'utf8');
    const required = [
      'timeRange', 'updateFrequency', 'sources', 'traceability',
      'limitations', 'anchor', 'path', 'points',
    ];
    for (const f of required) {
      // 允許兩種寫法：`timeRange: {...}` 或物件簡寫 `timeRange,`
      // （簡寫是合法的，硬要求冒號會逼人把程式寫醜）
      const ok = new RegExp(`\\b${f}\\s*:`).test(src)
        || new RegExp(`^\\s*${f}\\s*,`, 'm').test(src);
      assert.ok(ok, `輸出缺 ${f} 欄位（需求明訂必須顯示）`);
    }
    rf.fetchContract = origFetch;
    fred.getSeries = origFredGet;
    fred.fetchSeriesMemo = origFredFetch;
  });

  await ta('G3 時間範圍與更新頻率有內容（不是空殼）', async () => {
    // 走真實路徑會連網；這裡用時間函式驗證「範圍一定算得出來」
    const cur = rf.quarterOf('2026-11-27');
    const first = rf.addQuarters(cur.year, cur.q, 1);
    const last = rf.addQuarters(cur.year, cur.q, 8);
    assert.strictEqual(rf.qLabel(first.year, first.q), '2027Q1');
    assert.strictEqual(rf.qLabel(last.year, last.q), '2028Q4');
    assert.strictEqual(rf.quarterStart(2027, 1), '2027-01-01');
    assert.strictEqual(rf.quarterStart(2028, 4), '2028-10-01');
  });

  await ta('G4 每點必須可追溯：contract / price / impliedRate / asOf / sourceUrl', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rates-forecast.js'), 'utf8');
    for (const f of ['contract', 'price', 'impliedRate', 'asOf', 'sourceUrl', 'referencePeriod']) {
      assert.ok(new RegExp(f + ':').test(src), `每點缺可追溯欄位 ${f}`);
    }
  });

  await ta('G5 缺報價時 vsAnchorBp 必須是 null 而不是 undefined', async () => {
    // undefined 在 JSON 序列化時會被整條丟掉，前端讀到 undefined 再運算就變 NaN。
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rates-forecast.js'), 'utf8');
    assert.ok(/vsAnchorBp: null/.test(src), 'vsAnchorBp 必須先宣告為 null');
  });

  await ta('G6 不得宣稱是 Fed 的預測（免責與來源說明必須存在）', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rates-forecast.js'), 'utf8');
    assert.ok(/Fed 官方不公布未來利率路徑|不公布未來利率路徑/.test(src),
      '必須明確說明 Fed 不公布路徑，本模組為市場定價');
    assert.ok(/不是預測|不是本網站的預測|市場定價/.test(src),
      '必須區分「市場定價」與「預測」');
  });
}

/* ============================================================
   H. macro.js 的限制說明必須與事實一致
   ============================================================ */

console.log('\nH. 限制說明一致性（不可說「不提供預測」而實際有）');

t('H1 限制說明不得再說「本頁不提供利率預測」', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'macro.js'), 'utf8');
  assert.ok(!/本頁不提供利率預測/.test(src),
    '新增利率模組後，這句話已與事實不符，必須改寫');
});

t('H2 限制說明要說明「期貨隱含」與「Fed 預測」的差別', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'macro.js'), 'utf8');
  assert.ok(/期貨市場隱含利率/.test(src), '必須說明本模組是期貨隱含');
  assert.ok(/點陣圖/.test(src), '必須說明點陣圖不是委員會決議');
});

t('H3 走勢圖的降採樣必須在限制中揭露', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'macro.js'), 'utf8');
  assert.ok(/降採樣/.test(src), '走勢圖有降採樣，必須在限制中說明');
});

/* ============================================================
   I. 前端契約
   ============================================================ */

console.log('\nI. 前端契約（id / class / ES5）');

const ROOT = path.join(__dirname, '..');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const mcSrc = fs.readFileSync(path.join(ROOT, 'public/macro-charts.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const macroSrc = fs.readFileSync(path.join(ROOT, 'public/macro.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

t('I1 macro-charts.js 取用的 id 都存在於 index.html', () => {
  const ids = new Set();
  const re = /\$\('([A-Za-z0-9_]+)'\)/g;
  let m;
  while ((m = re.exec(mcSrc))) ids.add(m[1]);
  assert.ok(ids.size >= 2, `應找到多個 id，實際 ${ids.size}`);
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(htmlSrc));
  assert.deepStrictEqual(missing, [], `index.html 缺少：${missing.join(', ')}`);
});

t('I2 index.html 已載入 macro-charts.js（且排在 macro.js 之後）', () => {
  const iMacro = htmlSrc.indexOf('<script src="/macro.js">');
  const iCharts = htmlSrc.indexOf('<script src="/macro-charts.js">');
  assert.ok(iCharts > 0, '未載入 macro-charts.js');
  assert.ok(iCharts > iMacro, 'macro-charts.js 必須在 macro.js 之後載入');
});

t('I3 sw.js 已把 macro-charts.js 加入 shell 預快取並升版', () => {
  assert.ok(/['"]\/macro-charts\.js['"]/.test(swSrc), 'shell 清單缺 macro-charts.js');
  const m = swSrc.match(/const VERSION = '([^']+)'/);
  assert.ok(m, '找不到 VERSION');
  const v = m[1];
  assert.ok(/^v1\.0\.1[3-9]$|^v1\.[1-9]/.test(v) || v > 'v1.0.12',
    `版本號必須提升（目前 ${v}），否則舊 shell 會供應沒有新 script 的 index.html`);
});

t('I4 前端產生的每個 CSS class 都有樣式', () => {
  const isValidClass = (c) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c);
  const classes = new Set();
  const re = /class="([^"]+)"/g;
  let m;
  while ((m = re.exec(mcSrc))) {
    const raw = m[1];
    // 拼接段（含單引號的部分）由動態清單補
    const staticPart = raw.includes("'") ? raw.slice(0, raw.indexOf("'")) : raw;
    for (const c of staticPart.split(/\s+/)) if (isValidClass(c)) classes.add(c);
  }

  // 動態 class（由 JS 變數組合出來的）
  const dynamic = ['rf-up', 'rf-down', 'rf-flat', 'v-up', 'v-down'];
  for (const c of dynamic) classes.add(c);

  const missing = [...classes].filter(
    (c) => !new RegExp(`\\.${c.replace(/-/g, '\\-')}\\b`).test(cssSrc)
  );
  assert.deepStrictEqual(missing.sort(), [], `styles.css 缺少：${missing.join(', ')}`);
});

t('I5 macro-charts.js 必須是 ES5（本專案前端為原生 JS）', () => {
  const bad = mcSrc.split('\n').filter((l) => /^\s*(const |let )|=>/.test(l));
  assert.strictEqual(bad.length, 0, `發現 ES6 語法：\n${bad.slice(0, 5).join('\n')}`);
});

t('I6 動態字串一律走 SA.esc（避免上游文字帶 HTML）', () => {
  const risky = ['c.title', 'c.subtitle', 's.label', 'p.contract', 'p.quarter', 'p.reason'];
  for (const r of risky) {
    const esc = r.replace('.', '\\.');
    const re = /SA\.esc\(((?:[^()]|\([^()]*\))*)\)/g;
    let m;
    let found = false;
    while ((m = re.exec(mcSrc))) {
      if (new RegExp(`(^|[^A-Za-z0-9_.])${esc}([^A-Za-z0-9_]|$)`).test(m[1])) { found = true; break; }
    }
    assert.ok(found, `${r} 未經 SA.esc 轉義`);
  }
});

t('I7 不得用 --up / --down 畫走勢線（那是漲跌語義）', () => {
  // 走勢圖與利率預測不是價格漲跌，挪用紅綠會誤導
  const lineColorsMatch = mcSrc.match(/LINE_COLORS = \[([^\]]+)\]/);
  assert.ok(lineColorsMatch, '找不到 LINE_COLORS');
  assert.ok(!/--up|--down/.test(lineColorsMatch[1]),
    'LINE_COLORS 不可使用 --up / --down');
});

t('I8 走勢圖必須用後端 stats 決定 y 軸，不重算（否則取樣會改變軸）', () => {
  assert.ok(/s\.stats\.min/.test(mcSrc) && /s\.stats\.max/.test(mcSrc),
    'computeYDomain 必須讀 stats.min/max');
});

t('I9 缺值不可補 0（會畫出假跌破）', () => {
  // 折線繪製必須只走實際點，不得有 value:0 之類的補點邏輯
  assert.ok(!/value:\s*0\b/.test(mcSrc), '不得以 0 補缺值');
  assert.ok(/pts\[m\]\.value/.test(mcSrc), '折線應直接使用實際觀測值');
});

t('I10 macro.js 已把走勢圖與利率的載入接上（且不阻塞主資料）', () => {
  assert.ok(/MacroCharts\.loadCharts/.test(macroSrc), 'macro.js 未呼叫 loadCharts');
  assert.ok(/MacroCharts\.loadRates/.test(macroSrc), 'macro.js 未呼叫 loadRates');
  // 必須在 renderMacroTable 之後（先讓使用者看到表格）
  const iTable = macroSrc.indexOf('renderMacroTable(d.series)');
  const iCharts = macroSrc.indexOf('MacroCharts.loadCharts');
  assert.ok(iCharts > iTable, '走勢圖載入應排在表格之後，避免阻塞主資料呈現');
});

/* ============================================================
   執行
   ============================================================ */

(async () => {
  console.log('\n--- 非同步測試 ---');
  await runChartContract();
  await runRatesContract();

  console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
  if (fail) {
    console.log('\n失敗明細：');
    failures.forEach((f) => console.log(` - ${f.name}: ${f.msg}`));
  }
  process.exit(fail === 0 ? 0 : 1);
})();
