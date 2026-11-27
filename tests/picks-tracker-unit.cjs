'use strict';

/**
 * lib/picks-tracker.js 單元測試（零依賴，純 node assert）
 *
 * 這裡刻意用「假 K 線」把所有判定都釘死。理由：
 * 狀態機的錯誤通常不是拋錯，而是**算錯但看起來正常**——
 * 例如用了推介日當天的 K 線（前視偏差）、或把港元損益直接當美元加總。
 * 這種錯在畫面上完全看不出來，只能靠固定輸入的斷言抓。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('../lib/picks-tracker');

let pass = 0;
let fail = 0;
const failures = [];

/**
 * 測試收集器。
 *
 * 為什麼要「先收集、後依序執行」，而不是直接在 ok() 裡呼叫：
 *   `update()` 是非同步的。若 ok() 同步呼叫 fn()，async 函式回傳的 Promise
 *   會被直接丟掉——裡面的 assert 失敗**不會變成 throw**，於是測試恆為通過。
 *   這正是「空測試」最常見的成因，而且完全看不出來：console 一樣印 ✓。
 *   因此這裡改成收集後逐個 await，非同步失敗才會真的算失敗。
 */
const queue = [];

function ok(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const t of queue) {
    try {
      await t.fn();
      pass += 1;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      fail += 1;
      failures.push({ name: t.name, message: e.message });
      console.log(`  ✗ ${t.name}\n      ${e.message}`);
    }
  }
}

/** 造 K 線：t 用毫秒，date 為 UTC 日期 */
function bar(date, o, h, l, c) {
  return { t: Date.parse(`${date}T00:00:00Z`), o, h, l, c, v: 1000000 };
}

/** 假 datasource：依代碼給固定 K 線與匯率 */
function fakeDs(charts, quotes) {
  return {
    async chart(symbol) {
      const c = charts[symbol];
      if (!c) throw new Error(`找不到 ${symbol}`);
      return { candles: c, meta: {} };
    },
    async quote(symbol) {
      const q = quotes[symbol];
      if (!q) throw new Error(`找不到報價 ${symbol}`);
      return { symbol, price: q, currency: 'USD' };
    },
  };
}

const USD_FX = { rate: 1, estimated: false, source: 'identity' };
const HKD_FX = { rate: 7.8, estimated: false, source: 'yahoo' };

function mkRow(over = {}) {
  return {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    market: 'US',
    currency: 'USD',
    price: 105,
    score: 80,
    verdict: { level: 'buy' },
    zoneLower: 98,
    zoneUpper: 102,
    zoneStop: 92,
    zoneTarget: 120,
    ...over,
  };
}

let tmpDir;
function tmpFile(name) {
  return path.join(tmpDir, name);
}

console.log('\n=== picks-tracker 單元測試 ===\n');

tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'));

/* ---------------------------------------------------------------- */
console.log('[1] 去重：同日同股不得重複推薦');
/* ---------------------------------------------------------------- */
ok('同日同股第二次會被擋下（duplicate-day）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}), now: () => new Date('2026-03-02T12:00:00Z') });
  const a = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  assert.strictEqual(a.action, 'inserted');
  const b = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  assert.strictEqual(b.action, 'duplicate-day', `應為 duplicate-day，實際 ${b.action}`);
  assert.strictEqual(t.records.length, 1, `帳本應只有 1 筆，實際 ${t.records.length}`);
});

ok('大小寫／空白不同也算同一檔', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  t.addPick(mkRow({ symbol: 'aapl' }), { pickDate: '2026-03-02' });
  const b = t.addPick(mkRow({ symbol: ' AAPL ' }), { pickDate: '2026-03-02' });
  assert.strictEqual(b.action, 'duplicate-day', `應擋下，實際 ${b.action}`);
});

ok('不同日期：待買入時不重複建立記錄（duplicate-pending）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  t.addPick(mkRow(), { pickDate: '2026-03-02' });
  const b = t.addPick(mkRow(), { pickDate: '2026-03-03' });
  // 前一筆還掛著單在等價格 → 不再掛第二張一樣的單
  assert.strictEqual(b.action, 'duplicate-pending', `應為 duplicate-pending，實際 ${b.action}`);
  assert.strictEqual(t.records.length, 1, '不得長出第二筆記錄');
});

ok('不同日期：持倉中時擋下（duplicate-open）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  // 讓它成交
  t.applyCandles(record, [bar('2026-03-03', 106, 108, 100, 104)], USD_FX);
  assert.strictEqual(record.status, 'holding');
  const b = t.addPick(mkRow(), { pickDate: '2026-03-04' });
  assert.strictEqual(b.action, 'duplicate-open', `應為 duplicate-open，實際 ${b.action}`);
});

ok('待買入的重複不佔每日名額，會讓位給次優標的', () => {
  // 這是實際踩到的坑：11-24 的 PDD（78 分）待買入，
  // 若把它算成「重複」而佔掉 11-26 的名額，補位上來的會是 72 分的股票，
  // 清單就不再是「當日條件最佳」。
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  t.addPick(mkRow({ symbol: 'PDD', score: 78 }), { pickDate: '2026-03-02' });

  const rows = [
    mkRow({ symbol: 'TOP', score: 90 }),
    mkRow({ symbol: 'PDD', score: 78 }),      // 已在待買入
    mkRow({ symbol: 'THIRD', score: 70 }),
    mkRow({ symbol: 'FOURTH', score: 60 }),
  ];
  const out = t.addPicks(rows, { pickDate: '2026-03-03', limit: 3 });

  // 名額 3：TOP、THIRD、FOURTH —— PDD 被跳過但不佔位
  assert.deepStrictEqual(out.inserted.map((r) => r.symbol), ['TOP', 'THIRD', 'FOURTH'],
    `實際收錄 ${out.inserted.map((r) => r.symbol).join(',')}`);
  assert.strictEqual(out.duplicatesPending.length, 1);
  assert.strictEqual(out.duplicatesPending[0].symbol, 'PDD');
});

ok('持倉中的重複**會**佔用名額（不讓位）', () => {
  // 與上面相反：已持倉代表本金真的投進去了，
  // 這時不該再為同一檔投入第二份本金，名額直接消耗掉。
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow({ symbol: 'HELD', score: 90 }), { pickDate: '2026-03-02' });
  t.applyCandles(record, [bar('2026-03-03', 106, 108, 100, 104)], USD_FX);
  assert.strictEqual(record.status, 'holding');

  const rows = [
    mkRow({ symbol: 'HELD', score: 90 }),
    mkRow({ symbol: 'B', score: 80 }),
    mkRow({ symbol: 'C', score: 70 }),
  ];
  const out = t.addPicks(rows, { pickDate: '2026-03-04', limit: 2 });
  assert.deepStrictEqual(out.inserted.map((r) => r.symbol), ['B', 'C']);
  assert.strictEqual(out.duplicatesOpen.length, 1);
});

ok('allowOpenDuplicate 可放行同日以外的重複開倉', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  t.addPick(mkRow(), { pickDate: '2026-03-02' });
  const b = t.addPick(mkRow(), { pickDate: '2026-03-03', allowOpenDuplicate: true });
  assert.strictEqual(b.action, 'inserted', `應放行，實際 ${b.action}`);
});

ok('已結案後可再推介同一檔（不視為重複開倉）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}), now: () => new Date('2026-03-10T00:00:00Z') });
  const a = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  // 手動結案
  t.applyCandles(a.record, [
    bar('2026-03-03', 100, 101, 99, 100),
    bar('2026-03-04', 100, 121, 100, 121),
  ], USD_FX);
  assert.strictEqual(a.record.status, 'target_hit');
  const b = t.addPick(mkRow(), { pickDate: '2026-03-05' });
  assert.strictEqual(b.action, 'inserted', `結案後應可再推介，實際 ${b.action}`);
});

/* ---------------------------------------------------------------- */
console.log('\n[2] 價格合理性：不合理的區間不得寫入帳本');
/* ---------------------------------------------------------------- */
ok('缺止賺價 → invalid', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const r = t.addPick(mkRow({ zoneTarget: null }), { pickDate: '2026-03-02' });
  assert.strictEqual(r.action, 'invalid');
  assert.strictEqual(t.records.length, 0);
});

ok('止蝕高於買區（順序顛倒）→ invalid', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const r = t.addPick(mkRow({ zoneStop: 110 }), { pickDate: '2026-03-02' });
  assert.strictEqual(r.action, 'invalid');
});

ok('止賺低於買區 → invalid', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const r = t.addPick(mkRow({ zoneTarget: 100 }), { pickDate: '2026-03-02' });
  assert.strictEqual(r.action, 'invalid');
});

/* ---------------------------------------------------------------- */
console.log('\n[3] 狀態機：待買入 → 持倉中');
/* ---------------------------------------------------------------- */
ok('low 觸及買區上沿即以買區價成交', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [bar('2026-03-03', 106, 108, 100, 104)], USD_FX);
  assert.strictEqual(record.status, 'holding');
  assert.strictEqual(record.entry.price, 102, '開盤 106 高於買區上沿，應以 102 成交');
  assert.strictEqual(record.entry.date, '2026-03-03');
});

ok('跳空低開則以開盤價成交（拿到更好價格）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [bar('2026-03-03', 95, 96, 94, 95)], USD_FX);
  assert.strictEqual(record.entry.price, 95, '開盤 95 低於買區上沿，應以 95 成交');
});

ok('未觸及買區則維持待買入', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [bar('2026-03-03', 110, 112, 104, 108)], USD_FX);
  assert.strictEqual(record.status, 'pending');
  assert.strictEqual(record.entry, null);
});

/* ---------------------------------------------------------------- */
console.log('\n[4] 前視偏差：推介日當天的 K 線不得參與判定');
/* ---------------------------------------------------------------- */
ok('推介日當天跌進買區不算成交', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  // 同一天（03-02）就跌到買區 — 這是事後資訊，必須忽略
  t.applyCandles(record, [bar('2026-03-02', 105, 106, 99, 100)], USD_FX);
  assert.strictEqual(record.status, 'pending', '推介日當天不得成立成交');
  assert.strictEqual(record.entry, null);
});

ok('推介日之後的交易日才算數', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-02', 105, 106, 99, 100),   // 應被忽略
    bar('2026-03-03', 103, 104, 101, 102),  // 這根才有效
  ], USD_FX);
  assert.strictEqual(record.status, 'holding');
  assert.strictEqual(record.entry.date, '2026-03-03');
});

/* ---------------------------------------------------------------- */
console.log('\n[5] 狀態機：持倉中 → 已止賺 / 已止蝕');
/* ---------------------------------------------------------------- */
ok('建倉當天不判出場（同日觸及止賺也不算）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  // 03-03 成交，同一天 high 就已超過止賺價 120
  t.applyCandles(record, [bar('2026-03-03', 100, 130, 99, 128)], USD_FX);
  assert.strictEqual(record.status, 'holding', '建倉當天不得結案');
  assert.strictEqual(record.settled, false);
});

ok('次一交易日觸及止賺 → 已止賺', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 100, 105, 99, 104),
    bar('2026-03-04', 110, 121, 109, 120),
  ], USD_FX);
  assert.strictEqual(record.status, 'target_hit');
  assert.strictEqual(record.exit.price, 120);
  assert.strictEqual(record.settled, true);
});

ok('次一交易日觸及止蝕 → 已止蝕', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 100, 105, 99, 104),
    bar('2026-03-04', 100, 101, 90, 91),
  ], USD_FX);
  assert.strictEqual(record.status, 'stop_hit');
  assert.strictEqual(record.exit.price, 92);
  assert.strictEqual(record.settled, true);
});

ok('同日兩邊都觸及 → 保守取止蝕', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 100, 105, 99, 104),
    bar('2026-03-04', 101, 125, 90, 100),  // high>止賺 且 low<止蝕
  ], USD_FX);
  assert.strictEqual(record.status, 'stop_hit', '同日兩邊應保守取止蝕');
  assert.ok(record.exit.note && record.exit.note.includes('保守'), '應註記保守假設');
});

ok('跳空高開穿越止賺 → 以開盤價成交（優於止賺價）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 100, 105, 99, 104),
    bar('2026-03-04', 130, 132, 129, 131),
  ], USD_FX);
  assert.strictEqual(record.exit.price, 130, '跳空開高應以 130 成交，而非 120');
});

ok('跳空低開穿越止蝕 → 以開盤價成交（劣於止蝕價）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 100, 105, 99, 104),
    bar('2026-03-04', 85, 86, 84, 85),
  ], USD_FX);
  assert.strictEqual(record.exit.price, 85, '跳空開低應以 85 成交，而非 92');
});

/* ---------------------------------------------------------------- */
console.log('\n[6] 不重複計算：已結案記錄不得被改寫');
/* ---------------------------------------------------------------- */
ok('已止賺後再跑 K 線，數字完全凍結', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  const candles = [
    bar('2026-03-03', 100, 105, 99, 104),
    bar('2026-03-04', 110, 121, 109, 120),
  ];
  t.applyCandles(record, candles, USD_FX);
  const before = t.summary();
  const snap = JSON.stringify({ s: record.status, e: record.entry, x: record.exit, p: record.pnl });

  // 再灌入更多、更極端的 K 線
  const r2 = t.applyCandles(record, candles.concat([
    bar('2026-03-05', 120, 200, 118, 199),
    bar('2026-03-06', 199, 210, 50, 60),
  ]), USD_FX);

  assert.strictEqual(r2.changed, false, '已結案不得再變更');
  assert.strictEqual(JSON.stringify({ s: record.status, e: record.entry, x: record.exit, p: record.pnl }), snap);

  // settled 這個旗標本身也必須守住。
  // 它不是「顯示用欄位」——summary() 的 closed 集合就是靠它篩的。
  // 若不釘住，一個「只把 settled 設回 false」的錯誤會讓已實現損益
  // 悄悄從累計數字裡消失，而畫面上完全看不出異狀。
  assert.strictEqual(record.settled, true, 'settled 不得被後續更新改回 false');
  assert.ok(record.pnl.realized === true, 'pnl.realized 不得被改回 false');

  const after = t.summary();
  assert.strictEqual(after.counts.closed, 1, '結案筆數不得因重跑而改變');
  assert.strictEqual(after.realizedPnlUsd, before.realizedPnlUsd, '已實現損益不得因重跑而改變');
});

ok('重複呼叫 update 不會重複計入損益', async () => {
  // 這是使用者明確要求的「避免重複計算同一筆交易」。
  // 真實情境：每日排程跑一次，但使用者手動重新整理又觸發一次。
  const ds = fakeDs({
    AAPL: [
      // 開盤 106 高於買區上沿 102 → 以 102 成交（不是 106）
      bar('2026-03-03', 106, 108, 100, 104),
      bar('2026-03-04', 110, 121, 109, 120),
    ],
  }, { 'USDHKD=X': 7.8 });
  const t = T.create({ filePath: null, datasource: ds, now: () => new Date('2026-03-05T00:00:00Z') });
  t.addPick(mkRow(), { pickDate: '2026-03-02' });

  await t.update();
  const first = t.summary();
  assert.strictEqual(first.realizedPnlUsd, 1764.71, '第一次更新後已實現損益應為 1764.71');

  // 第二次更新：記錄已結案，不會被再次處理
  const out2 = await t.update();
  const second = t.summary();
  assert.strictEqual(out2.ran, false, '已無未結案記錄，第二次應直接跳過');
  assert.strictEqual(out2.checked, 0);
  assert.strictEqual(second.realizedPnlUsd, first.realizedPnlUsd,
    `損益不得因重複更新而變化：${first.realizedPnlUsd} → ${second.realizedPnlUsd}`);
  assert.strictEqual(second.counts.closed, 1, '結案筆數不得變成 2');
});

ok('結案記錄不會再被 update 撈出來處理', async () => {
  // 直接把已結案記錄放進帳本，update 的 open 集合必須把它排除
  const ds = fakeDs({}, { 'USDHKD=X': 7.8 });
  const t = T.create({ filePath: null, datasource: ds, now: () => new Date('2026-03-05T00:00:00Z') });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 100, 105, 99, 104),
    bar('2026-03-04', 110, 121, 109, 120),
  ], USD_FX);
  assert.strictEqual(record.settled, true, '應已結案');

  const out = await t.update();
  assert.strictEqual(out.checked, 0, '已結案記錄不得進入更新集合');
  assert.strictEqual(out.ran, false);
});

ok('settled 標記必須為 true，否則摘要會漏算已實現損益', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 100, 105, 99, 104),
    bar('2026-03-04', 110, 121, 109, 120),
  ], USD_FX);
  // 這兩個欄位共同決定「這筆算不算已實現」，缺一不可
  assert.strictEqual(record.settled, true, 'settled 必須為 true');
  assert.ok(record.pnl && record.pnl.realized === true, 'pnl.realized 必須為 true');
  const s = t.summary();
  assert.strictEqual(s.counts.closed, 1);
  assert.ok(s.realizedPnlUsd > 0, '已實現損益應被計入');
});

/* ---------------------------------------------------------------- */
console.log('\n[7] 股數與損益：10,000 美元本金、允許碎股');
/* ---------------------------------------------------------------- */
ok('以 102 成交、本金 10,000 → 98.039216 股', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [bar('2026-03-03', 106, 108, 100, 104)], USD_FX);
  assert.strictEqual(record.entry.shares, 98.039216,
    `股數應為 98.039216，實際 ${record.entry.shares}`);
});

ok('止賺 120 出場：損益 = (120-102) × 98.039216 ≈ 1764.71', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 106, 108, 100, 104),
    bar('2026-03-04', 110, 121, 109, 120),
  ], USD_FX);
  const expect = Math.round(98.039216 * 120 * 100) / 100 - 10000;
  assert.ok(Math.abs(record.pnl.amountUsd - expect) < 0.02,
    `損益應約 ${expect.toFixed(2)}，實際 ${record.pnl.amountUsd}`);
  // 102 → 120 約 +17.65%
  assert.ok(Math.abs(record.pnl.priceReturnPct - 17.65) < 0.02,
    `價格報酬應約 17.65%，實際 ${record.pnl.priceReturnPct}`);
});

ok('持倉天數以日曆日計算（建倉日 → 出場日）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 106, 108, 100, 104),
    bar('2026-03-10', 110, 121, 109, 120),
  ], USD_FX);
  assert.strictEqual(record.pnl.holdingDays, 7, `應為 7 天，實際 ${record.pnl.holdingDays}`);
});

/* ---------------------------------------------------------------- */
console.log('\n[8] 匯率：港元不得當美元直接加總');
/* ---------------------------------------------------------------- */
ok('港股以 HKD 成交，股數以港幣本金計算', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  // 10,000 USD × 7.8 = 78,000 HKD；成交價 100 HKD → 780 股
  const { record } = t.addPick(mkRow({
    symbol: '0700.HK', name: 'Tencent', market: 'HK', currency: 'HKD',
    price: 110, zoneLower: 96, zoneUpper: 100, zoneStop: 90, zoneTarget: 130,
  }), { pickDate: '2026-03-02' });
  t.applyCandles(record, [bar('2026-03-03', 101, 102, 99, 100)], HKD_FX);
  assert.strictEqual(record.entry.shares, 780, `應為 780 股，實際 ${record.entry.shares}`);
  assert.strictEqual(record.entry.costUsd, 10000);
});

ok('港股止賺出場：美元損益已折算，不含 7.8 倍放大', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow({
    symbol: '0700.HK', name: 'Tencent', market: 'HK', currency: 'HKD',
    price: 110, zoneLower: 96, zoneUpper: 100, zoneStop: 90, zoneTarget: 130,
  }), { pickDate: '2026-03-02' });
  t.applyCandles(record, [
    bar('2026-03-03', 101, 102, 99, 100),
    bar('2026-03-04', 125, 131, 124, 130),
  ], HKD_FX);

  assert.strictEqual(record.status, 'target_hit');
  // 780 股 × (130-100) = 23,400 HKD，÷7.8 = 3,000 USD
  assert.strictEqual(record.pnl.amountLocal, 23400, `原幣損益應為 23400，實際 ${record.pnl.amountLocal}`);
  assert.strictEqual(record.pnl.amountUsd, 3000, `美元損益應為 3000，實際 ${record.pnl.amountUsd}`);
  // 不可出現「23400 美元」這種未折算的數字
  assert.ok(record.pnl.amountUsd < 5000, '美元損益不應被匯率放大');
});

ok('匯差會反映在損益中（同價離場仍因匯率變動而有盈虧）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow({
    symbol: '0700.HK', name: 'Tencent', market: 'HK', currency: 'HKD',
    price: 110, zoneLower: 96, zoneUpper: 100, zoneStop: 90, zoneTarget: 130,
  }), { pickDate: '2026-03-02' });
  // 進場 7.8、出場 7.5（港元升值）→ 同價離場但美元變多
  t.applyCandles(record, [bar('2026-03-03', 101, 102, 99, 100)], HKD_FX);
  // 直接指定出場匯率
  record.status = 'holding';
  t.aside.closeExit(record, 100, '2026-03-04', 'target_hit', null, { rate: 7.5, estimated: false });
  // 780 股 × 100 = 78,000 HKD；÷7.5 = 10,400 USD；成本 10,000 → +400
  assert.strictEqual(record.pnl.amountUsd, 400, `應為 +400 美元，實際 ${record.pnl.amountUsd}`);
  assert.strictEqual(record.pnl.priceReturnPct, 0, '純價格報酬應為 0%');
});

ok('匯率取不到時不建倉（不可用 1 冒充）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const { record } = t.addPick(mkRow({
    symbol: '0700.HK', name: 'Tencent', market: 'HK', currency: 'HKD',
    price: 110, zoneLower: 96, zoneUpper: 100, zoneStop: 90, zoneTarget: 130,
  }), { pickDate: '2026-03-02' });
  t.applyCandles(record, [bar('2026-03-03', 101, 102, 99, 100)], { rate: null, estimated: true });
  assert.strictEqual(record.status, 'pending', '無匯率時應維持待買入，不可用 1 折算');
  assert.strictEqual(record.entry, null);
});

/* ---------------------------------------------------------------- */
console.log('\n[9] 累計摘要：報酬率分母必須是已投入成本');
/* ---------------------------------------------------------------- */
ok('兩筆各 10,000、各賺 1000 → 累計報酬率 10%（不是 20%）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });

  // 兩檔不同股票，各投入 10,000，各賺 1,000
  const specs = [
    { symbol: 'AAA', buy: 100, target: 110 },
    { symbol: 'BBB', buy: 200, target: 220 },
  ];
  specs.forEach((s, i) => {
    const { record } = t.addPick(mkRow({
      symbol: s.symbol, zoneLower: s.buy - 4, zoneUpper: s.buy, zoneStop: s.buy * 0.9, zoneTarget: s.target,
    }), { pickDate: `2026-03-0${i + 2}` });
    const d1 = `2026-03-0${i + 3}`;
    const d2 = `2026-03-0${i + 4}`;
    t.applyCandles(record, [
      bar(d1, s.buy + 1, s.buy + 2, s.buy - 1, s.buy),
      bar(d2, s.target, s.target + 1, s.target - 1, s.target),
    ], USD_FX);
  });

  const s = t.summary();
  assert.strictEqual(s.counts.closed, 2, `應有 2 筆結案，實際 ${s.counts.closed}`);
  assert.strictEqual(s.deployedUsd, 20000, `已投入成本應為 20000，實際 ${s.deployedUsd}`);
  assert.strictEqual(s.realizedPnlUsd, 2000, `已實現損益應為 2000，實際 ${s.realizedPnlUsd}`);
  // 2000 / 20000 = 10%
  assert.strictEqual(s.realizedReturnPct, 10,
    `累計報酬率應為 10%（2000/20000），實際 ${s.realizedReturnPct}`);
});

ok('勝率／平均持有天數統計正確', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const mk = (sym, target, stop) => {
    const { record } = t.addPick(mkRow({
      symbol: sym, zoneLower: 96, zoneUpper: 100, zoneStop: stop, zoneTarget: target,
    }), { pickDate: '2026-03-02' });
    t.applyCandles(record, [
      bar('2026-03-03', 101, 102, 99, 100),
      bar('2026-03-06', 100, target + (target > 110 ? 5 : 0), stop - (target > 110 ? 0 : 5), 100),
    ], USD_FX);
    return record;
  };
  // allowOpenDuplicate 讓不同代碼都能進；同一代碼不重複
  mk('WIN1', 120, 92);
  mk('LOSS1', 120, 92);
  // LOSS1 實際上也會止賺（因為 high 到 125）→ 直接手動造一筆虧損
  const recs = t.records;
  assert.ok(recs.length >= 2);
  const s = t.summary();
  assert.ok(s.counts.closed >= 2, '應有至少 2 筆結案');
  assert.ok(s.winRate != null && s.winRate >= 0 && s.winRate <= 100);
});

ok('沒有結案記錄時，報酬率為 null 而非 0（不可假裝「打和」）', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  t.addPick(mkRow(), { pickDate: '2026-03-02' });
  const s = t.summary();
  assert.strictEqual(s.realizedReturnPct, null);
  assert.strictEqual(s.winRate, null);
  assert.strictEqual(s.avgHoldingDays, null);
});

/* ---------------------------------------------------------------- */
console.log('\n[10] 持久化：原子寫入、損壞復原、歷史保留');
/* ---------------------------------------------------------------- */
ok('存檔後重新載入，記錄與狀態完全一致', () => {
  const f = tmpFile('ledger1.json');
  const t1 = T.create({ filePath: f, datasource: fakeDs({}, {}) });
  const { record } = t1.addPick(mkRow(), { pickDate: '2026-03-02' });
  t1.applyCandles(record, [
    bar('2026-03-03', 100, 105, 99, 104),
    bar('2026-03-04', 110, 121, 109, 120),
  ], USD_FX);
  t1.save();

  const t2 = T.create({ filePath: f, datasource: fakeDs({}, {}) });
  const l = t2.load();
  assert.strictEqual(l.loaded, true);
  assert.strictEqual(t2.records.length, 1);
  assert.strictEqual(t2.records[0].status, 'target_hit');
  assert.strictEqual(t2.records[0].pnl.amountUsd, record.pnl.amountUsd);
});

ok('不留下 .tmp 殘檔', () => {
  const f = tmpFile('ledger2.json');
  const t = T.create({ filePath: f, datasource: fakeDs({}, {}) });
  t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.save();
  assert.ok(!fs.existsSync(`${f}.tmp`), '.tmp 應已被 rename 消耗掉');
  assert.ok(fs.existsSync(f));
});

ok('損壞的帳本會備份後重建，不會靜默清空', () => {
  const f = tmpFile('ledger-corrupt.json');
  fs.writeFileSync(f, '{ this is not json', 'utf8');
  const t = T.create({ filePath: f, datasource: fakeDs({}, {}) });
  const l = t.load();
  assert.strictEqual(l.corrupt, true);
  assert.ok(t.recovered && t.recovered.backup, '應留下備份路徑');
  assert.ok(fs.existsSync(t.recovered.backup), '備份檔應真的存在');
});

ok('版本不符時明確拋錯，不誤讀歷史', () => {
  const f = tmpFile('ledger-ver.json');
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: 999, records: [] }), 'utf8');
  const t = T.create({ filePath: f, datasource: fakeDs({}, {}) });
  assert.throws(() => t.load(), /版本 999/);
});

/* ---------------------------------------------------------------- */
console.log('\n[11] update()：批次更新與失敗隔離');
/* ---------------------------------------------------------------- */
ok('update 會推進狀態並保存', async () => {
  const f = tmpFile('ledger-upd.json');
  const ds = fakeDs(
    { AAPL: [
      bar('2026-03-03', 100, 105, 99, 104),
      bar('2026-03-04', 110, 121, 109, 120),
    ] },
    { 'USDHKD=X': 7.8 }
  );
  const t = T.create({ filePath: f, datasource: ds, now: () => new Date('2026-03-05T00:00:00Z') });
  t.addPick(mkRow(), { pickDate: '2026-03-02' });
  t.save();

  const out = await t.update();
  assert.strictEqual(out.checked, 1);
  assert.strictEqual(out.changed, 1);
  assert.strictEqual(t.records[0].status, 'target_hit');
  assert.ok(fs.existsSync(f), '更新後應已存檔');
});

ok('單檔抓取失敗不影響其他檔（失敗隔離）', async () => {
  const ds = fakeDs(
    { GOOD: [bar('2026-03-03', 100, 105, 99, 104)] },
    { 'USDHKD=X': 7.8 }
  );
  const t = T.create({ filePath: null, datasource: ds, now: () => new Date('2026-03-05T00:00:00Z') });
  t.addPick(mkRow({ symbol: 'GOOD', zoneLower: 96, zoneUpper: 100 }), { pickDate: '2026-03-02' });
  t.addPick(mkRow({ symbol: 'BAD', zoneLower: 96, zoneUpper: 100 }), { pickDate: '2026-03-02' });

  const out = await t.update();
  assert.strictEqual(out.checked, 2);
  assert.strictEqual(out.failed, 1, `應有 1 檔失敗，實際 ${out.failed}`);
  const bad = t.records.find((r) => r.symbol === 'BAD');
  assert.ok(bad.lastError, '失敗檔應留下 lastError 供排查');
  assert.strictEqual(bad.status, 'pending', '失敗檔狀態不應被亂改');
  const good = t.records.find((r) => r.symbol === 'GOOD');
  assert.strictEqual(good.status, 'holding', '成功檔仍應正常推進');
});

ok('沒有未結案記錄時 update 直接回 ran:false', async () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}), now: () => new Date('2026-03-05T00:00:00Z') });
  const out = await t.update();
  assert.strictEqual(out.ran, false);
  assert.strictEqual(out.checked, 0);
});

/* ---------------------------------------------------------------- */
console.log('\n[12] addPicks：只收條件最佳的前 N 檔');
/* ---------------------------------------------------------------- */
ok('依評分排序後只收前 N 檔', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const rows = [
    mkRow({ symbol: 'LOW', score: 50 }),
    mkRow({ symbol: 'HIGH', score: 90 }),
    mkRow({ symbol: 'MID', score: 70 }),
  ];
  const out = t.addPicks(rows, { pickDate: '2026-03-02', limit: 2 });
  assert.strictEqual(out.inserted.length, 2);
  assert.deepStrictEqual(out.inserted.map((r) => r.symbol), ['HIGH', 'MID']);
});

ok('minScore 以下的不收', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const rows = [mkRow({ symbol: 'LOW', score: 40 }), mkRow({ symbol: 'HIGH', score: 80 })];
  const out = t.addPicks(rows, { pickDate: '2026-03-02', limit: 5, minScore: 60 });
  assert.strictEqual(out.inserted.length, 1);
  assert.strictEqual(out.inserted[0].symbol, 'HIGH');
});

ok('重跑同日 addPicks 不會產生重複記錄', () => {
  const t = T.create({ filePath: null, datasource: fakeDs({}, {}) });
  const rows = [mkRow({ symbol: 'A', score: 90 }), mkRow({ symbol: 'B', score: 80 })];
  const first = t.addPicks(rows, { pickDate: '2026-03-02', limit: 5 });
  const second = t.addPicks(rows, { pickDate: '2026-03-02', limit: 5 });
  assert.strictEqual(first.inserted.length, 2);
  assert.strictEqual(second.inserted.length, 0, '第二次不得新增');
  assert.strictEqual(t.records.length, 2, '帳本總數不變');
});

/* ---------------------------------------------------------------- */
console.log('\n[13] 狀態中文對照表');
/* ---------------------------------------------------------------- */
ok('四個狀態的中文與使用者需求一致', () => {
  assert.strictEqual(T.STATUS_LABEL.pending, '待買入');
  assert.strictEqual(T.STATUS_LABEL.holding, '持倉中');
  assert.strictEqual(T.STATUS_LABEL.target_hit, '已止賺');
  assert.strictEqual(T.STATUS_LABEL.stop_hit, '已止蝕');
  assert.strictEqual(T.STATUS_ORDER.length, 4);
});

/* ---------------------------------------------------------------- */
console.log('\n[14] 日期工具');
/* ---------------------------------------------------------------- */
ok('daysBetween 跨月正確', () => {
  assert.strictEqual(T.daysBetween('2026-02-27', '2026-03-02'), 3);
  assert.strictEqual(T.daysBetween('2026-03-02', '2026-03-02'), 0);
  assert.strictEqual(T.daysBetween('bad', '2026-03-02'), null);
});

ok('dateKeyFromMs 以 UTC 輸出', () => {
  assert.strictEqual(T.dateKeyFromMs(Date.parse('2026-03-02T00:00:00Z')), '2026-03-02');
  assert.strictEqual(T.dateKeyFromMs(null), null);
});

/* ---------------------------------------------------------------- */
console.log('[15] 帳本落地位置與持久性偵測');
/* ---------------------------------------------------------------- */

ok('TRACKER_LEDGER_FILE 會覆寫帳本路徑', () => {
  const old = process.env.TRACKER_LEDGER_FILE;
  try {
    process.env.TRACKER_LEDGER_FILE = path.join(tmpDir, 'custom', 'ledger.json');
    assert.strictEqual(T.resolveLedgerFile(), path.resolve(process.env.TRACKER_LEDGER_FILE));
    const t = T.create({ datasource: fakeDs({}, {}) });
    assert.strictEqual(t.stats().file, path.resolve(process.env.TRACKER_LEDGER_FILE),
      'create 應採用覆寫後的路徑');
  } finally {
    if (old === undefined) delete process.env.TRACKER_LEDGER_FILE;
    else process.env.TRACKER_LEDGER_FILE = old;
  }
});

ok('未設定時落在專案 data/tracker/ledger.json', () => {
  const old = process.env.TRACKER_LEDGER_FILE;
  try {
    delete process.env.TRACKER_LEDGER_FILE;
    assert.strictEqual(T.resolveLedgerFile(), T.DEFAULT_FILE);
  } finally {
    if (old !== undefined) process.env.TRACKER_LEDGER_FILE = old;
  }
});

ok('本機（非雲端平台）一律視為持久，不亂報警', () => {
  const old = { R: process.env.RENDER, D: process.env.DYNO, F: process.env.FLY_APP_NAME };
  try {
    delete process.env.RENDER; delete process.env.DYNO; delete process.env.FLY_APP_NAME;
    // 即使裝置相同也不該警告：本機的檔案系統本來就由使用者掌控
    const r = T.persistenceInfo('/whatever/ledger.json', { statSync: () => ({ dev: 1 }) });
    assert.strictEqual(r.persistent, true);
  } finally {
    if (old.R !== undefined) process.env.RENDER = old.R;
    if (old.D !== undefined) process.env.DYNO = old.D;
    if (old.F !== undefined) process.env.FLY_APP_NAME = old.F;
  }
});

ok('雲端主機且同一裝置 → 警告重啟即消失', () => {
  const old = { R: process.env.RENDER, E: process.env.TRACKER_LEDGER_FILE };
  try {
    process.env.RENDER = 'true';
    delete process.env.TRACKER_LEDGER_FILE;
    const r = T.persistenceInfo('/var/data/ledger.json', { statSync: () => ({ dev: 111 }) });
    assert.strictEqual(r.persistent, false, '同檔案系統必須判定為不持久');
    assert.ok(/TRACKER_LEDGER_FILE/.test(r.reason), '提示要說明怎麼修，否則等於只報錯不給路');
  } finally {
    if (old.R === undefined) delete process.env.RENDER; else process.env.RENDER = old.R;
    if (old.E !== undefined) process.env.TRACKER_LEDGER_FILE = old.E;
  }
});

ok('已設定路徑但仍在同裝置 → 提示指向「磁碟沒掛上」而非重複同一句', () => {
  const old = { R: process.env.RENDER, E: process.env.TRACKER_LEDGER_FILE };
  try {
    process.env.RENDER = 'true';
    process.env.TRACKER_LEDGER_FILE = '/var/data/ledger.json';
    const r = T.persistenceInfo('/var/data/ledger.json', { statSync: () => ({ dev: 111 }) });
    assert.strictEqual(r.persistent, false);
    assert.ok(/未掛載|掛載點/.test(r.reason),
      `設了路徑卻不持久，訊息要指出掛載問題，實際：${r.reason}`);
  } finally {
    if (old.R === undefined) delete process.env.RENDER; else process.env.RENDER = old.R;
    if (old.E === undefined) delete process.env.TRACKER_LEDGER_FILE;
    else process.env.TRACKER_LEDGER_FILE = old.E;
  }
});

ok('雲端主機且帳本在獨立掛載點 → 判定為持久', () => {
  const old = process.env.RENDER;
  try {
    process.env.RENDER = 'true';
    const statSync = (p) => ({ dev: String(p).startsWith('/var/data') ? 999 : 111 });
    const r = T.persistenceInfo('/var/data/ledger.json', { statSync });
    assert.strictEqual(r.persistent, true, '跨掛載點才是真正持久，這條若永遠 false 就只是無用的狼來了');
  } finally {
    if (old === undefined) delete process.env.RENDER; else process.env.RENDER = old;
  }
});

ok('無法確認裝置時保守判定為不持久', () => {
  const old = process.env.RENDER;
  try {
    process.env.RENDER = 'true';
    const r = T.persistenceInfo('/var/data/ledger.json', {
      statSync: () => { throw new Error('ENOENT'); },
    });
    assert.strictEqual(r.persistent, false, '不確定時不可以給出「應該沒事」的安心感');
  } finally {
    if (old === undefined) delete process.env.RENDER; else process.env.RENDER = old;
  }
});

ok('記憶體模式回報 null 而非 true', () => {
  assert.strictEqual(T.persistenceInfo(null).persistent, null);
});

/* ---------------------------------------------------------------- */
// 依序執行所有測試（含非同步），最後清理
/* ---------------------------------------------------------------- */
runAll().then(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n=== 結果：${pass} passed / ${fail} failed ===\n`);
  if (fail) {
    failures.forEach((f) => console.log(`  ✗ ${f.name}\n      ${f.message}`));
    process.exit(1);
  }
}).catch((e) => {
  console.error('測試執行器本身出錯：', e);
  process.exit(1);
});
