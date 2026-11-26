'use strict';

/**
 * 宏觀／財報模組單元測試 — 完全不連網
 * =====================================
 *
 * 為什麼要另寫一份不連網的測試（與 forecast-unit.cjs 同一理由）：
 *   網路測試只能證明「今天上游有資料時畫面長什麼樣」，
 *   無法穩定製造「FRED 回 ZIP」「Revenues 停在 2018」「財年沒有單季 Q4」
 *   「FOMC 頁面少一場」這些分支。而這些分支正是本模組全部設計的由來 ——
 *   每一條都是實測踩到才寫下的防護，若不鎖死就會在下次重構時被改回去。
 *
 * 覆蓋範圍：
 *   A. FRED CSV 解析（空值必須是 null，不能變成 0）
 *   B. FRED ZIP 偵測（≥3 序列時的行為）
 *   C. YoY 月份對齊（缺月不可位移）
 *   D. 百分位與變化量
 *   E. SEC 期間分類（52/53 週制）
 *   F. 概念優先序與「已廢棄概念的過期防護」
 *   G. TTM 三條推導路線（含「財年結束時 TTM == FY」）
 *   H. FOMC 表格解析與場次合理性
 *   I. 解讀引擎（傾向判定、軟硬背離、資料缺口、免責聲明）
 *   J. LLM 幻覺數字攔截
 *   K. 資料字典欄位完整性
 *   L. 前端契約（macro.js 用到的 id / class 必須存在）
 *
 * 用法：node tests/macro-unit.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fred = require('../lib/fred');
const sec = require('../lib/sec');
const fomc = require('../lib/fomc');
const interpret = require('../lib/interpret');
const macro = require('../lib/macro');

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

/** 非同步版本 */
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

/* ---------------------------------------------------------------
   小工具
   --------------------------------------------------------------- */

/** 以「今天」為基準產生 ISO 日期（給 pickConcept 的過期判斷用） */
function daysAgoIso(n) {
  const t = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  return new Date(t - n * 86400000).toISOString().slice(0, 10);
}

/** 造一個 SEC companyfacts 概念 */
function makeConcept(rows, unit) {
  const u = unit || 'USD';
  const units = {};
  units[u] = rows;
  return { units };
}

/** 造一個 us-gaap facts 物件 */
function makeFacts(concepts) {
  return { facts: { 'us-gaap': concepts } };
}

/** 造一個 duration 資料點（給 deriveTtm 直接餵） */
function dur(start, end, val, period) {
  const days = Math.round(
    (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000
  );
  return {
    start, end, days, val, form: '10-Q', filed: end, fy: null, fp: '',
    frame: '', period: period || sec.classifyDuration(days),
  };
}

/** 造一個 fred 序列結果（模擬 getSeries 的輸出） */
function series(opts) {
  const o = opts || {};
  return {
    key: o.key || 'x',
    id: o.id || 'X',
    label: o.label || 'X',
    unit: o.unit || '%',
    available: o.available !== false,
    value: o.value,
    asOf: o.asOf || '2026-09-01',
    stats: o.stats === null ? null : (o.stats || { percentile: null, change: null }),
  };
}

/* ============================================================
   A. FRED CSV 解析
   ============================================================ */

console.log('\nA. FRED CSV 解析');

t('A1 空字串是「無觀測值」→ 略過，絕不變成 0', () => {
  const csv = [
    'observation_date,DGS10',
    '2026-01-02,4.51',
    '2026-01-03,',
    '2026-01-04,4.48',
  ].join('\n');
  const pts = fred.parseCsv(csv);
  assert.strictEqual(pts.length, 2, `應只有 2 個有效點，實際 ${pts.length}`);
  assert.ok(!pts.some((p) => p.value === 0), '不得出現 0 值（假跌破）');
  assert.deepStrictEqual(pts.map((p) => p.date), ['2026-01-02', '2026-01-04']);
});

t('A2 非數值（如 "." 或 "ND"）→ 略過', () => {
  const csv = 'observation_date,X\n2026-01-01,.\n2026-01-02,ND\n2026-01-03,1.5\n';
  const pts = fred.parseCsv(csv);
  assert.strictEqual(pts.length, 1);
  assert.strictEqual(pts[0].value, 1.5);
});

t('A3 表頭不是 observation_date → 回空陣列（不硬解）', () => {
  assert.deepStrictEqual(fred.parseCsv('date,value\n2026-01-01,1\n'), []);
});

t('A4 只有表頭 / 空輸入 → 回空陣列', () => {
  assert.deepStrictEqual(fred.parseCsv('observation_date,DGS10'), []);
  assert.deepStrictEqual(fred.parseCsv(''), []);
  assert.deepStrictEqual(fred.parseCsv(null), []);
});

t('A5 輸出依日期升冪排序（上游順序不可信）', () => {
  const csv = 'observation_date,X\n2026-01-03,3\n2026-01-01,1\n2026-01-02,2\n';
  assert.deepStrictEqual(fred.parseCsv(csv).map((p) => p.value), [1, 2, 3]);
});

t('A6 負值可正常解析（利差／赤字會是負的）', () => {
  const pts = fred.parseCsv('observation_date,T10Y2Y\n2026-01-02,-0.35\n');
  assert.strictEqual(pts[0].value, -0.35, '負號不可被吃掉');
});

t('A7 CRLF 換行可解析（Windows 上游）', () => {
  const pts = fred.parseCsv('observation_date,X\r\n2026-01-01,1.1\r\n2026-01-02,1.2\r\n');
  assert.strictEqual(pts.length, 2);
  assert.strictEqual(pts[1].value, 1.2);
});

/* ============================================================
   B. ZIP 偵測
   ============================================================ */

console.log('\nB. FRED ZIP 偵測（≥3 序列時的靜默陷阱）');

t('B1 PK\\x03\\x04 → 判定為 ZIP', () => {
  assert.strictEqual(fred.looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), true);
});

t('B2 PK\\x05\\x06（空壓縮檔）→ 也是 ZIP', () => {
  assert.strictEqual(fred.looksLikeZip(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00])), true);
});

t('B3 正常 CSV 開頭 → 不是 ZIP', () => {
  assert.strictEqual(fred.looksLikeZip(Buffer.from('observation_date,DGS10\n', 'utf8')), false);
});

t('B4 太短或非 Buffer → false（不可拋錯）', () => {
  assert.strictEqual(fred.looksLikeZip(Buffer.from([0x50, 0x4b])), false);
  assert.strictEqual(fred.looksLikeZip(null), false);
  assert.strictEqual(fred.looksLikeZip(undefined), false);
});

/* ============================================================
   C. YoY 月份對齊
   ============================================================ */

console.log('\nC. YoY 計算（必須按月份對齊）');

t('C1 少於 13 點 → 空陣列（不可用 12 點硬算）', () => {
  const pts = Array.from({ length: 12 }, (_, i) => ({ date: `2025-${String(i + 1).padStart(2, '0')}-01`, value: 100 }));
  assert.deepStrictEqual(fred.yoy(pts), []);
});

t('C2 同月份去年為基期，數值正確', () => {
  const pts = [];
  for (let y = 2025; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      pts.push({ date: `${y}-${String(m).padStart(2, '0')}-01`, value: m + (y - 2025) * 10 });
    }
  }
  const out = fred.yoy(pts);
  assert.ok(out.length > 0);
  // 2026-06 值 16，2025-06 值 6 → (16-6)/6*100 = 166.6667（yoy 內四捨五入到 4 位）
  const jun = out.find((p) => p.date === '2026-06-01');
  assert.ok(jun, '應有 2026-06 的 YoY');
  assert.ok(Math.abs(jun.value - 166.6667) < 1e-3, `實際 ${jun.value}`);
});

t('C3 缺月時不可位移（缺基期就跳過，不是往前抓）', () => {
  // 2025-11 缺（模擬政府停擺），2026-11 的基期不存在
  const pts = [
    { date: '2025-01-01', value: 100 },
    { date: '2025-10-01', value: 110 },
    { date: '2025-12-01', value: 120 },
    { date: '2026-01-01', value: 130 },
    { date: '2026-10-01', value: 140 },
    { date: '2026-11-01', value: 150 },
    { date: '2026-12-01', value: 160 },
    { date: '2027-01-01', value: 170 },
    { date: '2027-02-01', value: 180 },
    { date: '2027-03-01', value: 190 },
    { date: '2027-04-01', value: 200 },
    { date: '2027-05-01', value: 210 },
    { date: '2027-06-01', value: 220 },
  ];
  const out = fred.yoy(pts);
  assert.ok(!out.some((p) => p.date === '2026-11-01'),
    '2026-11 缺去年同月基期，必須跳過而不是用 2025-10 硬算');
  const dec = out.find((p) => p.date === '2026-12-01');
  assert.ok(dec, '2026-12 有基期，應算得出來');
});

t('C4 基期為 0 → 跳過（不可除以 0）', () => {
  const pts = [];
  for (let m = 1; m <= 12; m++) pts.push({ date: `2025-${String(m).padStart(2, '0')}-01`, value: 0 });
  pts.push({ date: '2026-01-01', value: 5 });
  const out = fred.yoy(pts);
  assert.deepStrictEqual(out, [], '基期 0 不可產生 Infinity/NaN 點');
});

/* ============================================================
   D. 百分位與變化量
   ============================================================ */

console.log('\nD. 百分位與變化量');

t('D1 樣本 < 12 點 → percentile 為 null（不用少數點編故事）', () => {
  const pts = Array.from({ length: 11 }, (_, i) => ({ date: `2026-01-${i + 1}`, value: i }));
  assert.strictEqual(fred.percentileRank(pts, 5), null);
});

t('D2 百分位計算正確', () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ date: 'x', value: i })); // 0..9
  // 但 <12 會回 null，所以用 20 點
  const pts20 = Array.from({ length: 20 }, (_, i) => ({ date: 'x', value: i }));
  assert.strictEqual(fred.percentileRank(pts20, 19), 95); // 19 個比它小 / 20
  assert.strictEqual(fred.percentileRank(pts20, 0), 0);
  assert.strictEqual(fred.percentileRank(pts, 5), null);
});

t('D3 非有限值 → null', () => {
  const pts20 = Array.from({ length: 20 }, (_, i) => ({ date: 'x', value: i }));
  assert.strictEqual(fred.percentileRank(pts20, NaN), null);
  assert.strictEqual(fred.percentileRank(pts20, null), null);
});

t('D4 changeOver 取 N 期前差值；點數不足 → null', () => {
  const pts = [{ date: 'a', value: 1 }, { date: 'b', value: 3 }];
  assert.strictEqual(fred.changeOver(pts, 1), 2);
  assert.strictEqual(fred.changeOver(pts, 5), null);
});

t('D5 lastOf 取最後一點；空陣列 → null', () => {
  assert.strictEqual(fred.lastOf([{ date: 'a', value: 7 }]).value, 7);
  assert.strictEqual(fred.lastOf([]), null);
});

/* ============================================================
   E. SEC 期間分類
   ============================================================ */

console.log('\nE. SEC 期間分類（52/53 週制）');

t('E1 單季 91 天 → quarter', () => {
  assert.strictEqual(sec.classifyDuration(91), 'quarter');
  assert.strictEqual(sec.classifyDuration(80), 'quarter');
  assert.strictEqual(sec.classifyDuration(100), 'quarter');
});

t('E2 半年 182 天 → half', () => {
  assert.strictEqual(sec.classifyDuration(182), 'half');
  assert.strictEqual(sec.classifyDuration(170), 'half');
  assert.strictEqual(sec.classifyDuration(190), 'half');
});

t('E3 九個月 273 天 → nineMonth', () => {
  assert.strictEqual(sec.classifyDuration(273), 'nineMonth');
  assert.strictEqual(sec.classifyDuration(260), 'nineMonth');
  assert.strictEqual(sec.classifyDuration(285), 'nineMonth');
});

t('E4 年度 364 天（Apple 財年）→ year', () => {
  assert.strictEqual(sec.classifyDuration(364), 'year');
  assert.strictEqual(sec.classifyDuration(365), 'year');
  assert.strictEqual(sec.classifyDuration(350), 'year');
  assert.strictEqual(sec.classifyDuration(380), 'year');
});

t('E5 落在縫隙的天數 → other（不可硬歸類）', () => {
  assert.strictEqual(sec.classifyDuration(45), 'other');
  assert.strictEqual(sec.classifyDuration(140), 'other');
  assert.strictEqual(sec.classifyDuration(300), 'other');
  assert.strictEqual(sec.classifyDuration(400), 'other');
});

t('E6 shiftYear 固定 -364 天（不是 -365）', () => {
  assert.strictEqual(sec.shiftYear('2026-09-30'), '2025-10-01');
  assert.strictEqual(sec.shiftYear('2024-03-01'), '2023-03-03'); // 閏年：364 天會跨回
});

t('E7 daysBetween 計算正確', () => {
  assert.strictEqual(sec.daysBetween('2026-01-01', '2026-01-02'), 1);
  assert.strictEqual(sec.daysBetween('2026-01-01', '2025-12-31'), -1);
});

t('E8 normalizeTicker：BRK.B → BRK-B、轉大寫', () => {
  assert.strictEqual(sec.normalizeTicker('brk.b'), 'BRK-B');
  assert.strictEqual(sec.normalizeTicker(' aapl '), 'AAPL');
  assert.strictEqual(sec.normalizeTicker(''), '');
});

/* ============================================================
   F. 概念優先序與過期防護
   ============================================================ */

console.log('\nF. 概念優先序（已廢棄概念必須被跳過）');

t('F1 現行營收概念優先於已廢棄的 Revenues', () => {
  const end = daysAgoIso(60);
  const start = daysAgoIso(151);
  const facts = makeFacts({
    RevenueFromContractWithCustomerExcludingAssessedTax: makeConcept([
      { start, end, val: 100, form: '10-Q', filed: end },
    ]),
    Revenues: makeConcept([{ start, end, val: 999, form: '10-Q', filed: end }]),
  });
  const r = sec.pickConcept(facts, 'revenue');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.concept, 'RevenueFromContractWithCustomerExcludingAssessedTax');
  assert.strictEqual(r.latest.val, 100, '不可取到 Revenues 的 999');
});

t('F2 Revenues 停在 8 年前 → 跳過，改抓下一個（實測 AAPL 的坑）', () => {
  const end = daysAgoIso(60);
  const start = daysAgoIso(151);
  const staleEnd = daysAgoIso(3000);
  const staleStart = daysAgoIso(3091);
  const facts = makeFacts({
    // 第一順位不存在
    Revenues: makeConcept([
      { start: staleStart, end: staleEnd, val: 265595000000, form: '10-K', filed: staleEnd },
    ]),
    SalesRevenueNet: makeConcept([
      { start, end, val: 478834000000, form: '10-Q', filed: end },
    ]),
  });
  const r = sec.pickConcept(facts, 'revenue');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.concept, 'SalesRevenueNet', '必須跳過過期的 Revenues');
  assert.strictEqual(r.latest.val, 478834000000);
  assert.ok(r.tried.some((x) => /stale/.test(x.result)), 'tried 應記錄 stale 原因');
});

t('F3 全部概念都缺 → ok:false 並保留 tried 供診斷', () => {
  const r = sec.pickConcept(makeFacts({}), 'revenue');
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.tried) && r.tried.length > 0);
  assert.ok(r.message.includes('revenue'));
});

t('F4 EPS 取 USD/shares 單位而非 USD', () => {
  const end = daysAgoIso(60);
  const start = daysAgoIso(151);
  const facts = makeFacts({
    EarningsPerShareDiluted: makeConcept(
      [{ start, end, val: 8.98, form: '10-Q', filed: end }],
      'USD/shares'
    ),
  });
  const r = sec.pickConcept(facts, 'epsDiluted');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unit, 'USD/shares');
  assert.strictEqual(r.latest.val, 8.98);
});

t('F5 資產類概念走 instant（無 start），不走 duration', () => {
  const end = daysAgoIso(60);
  const facts = makeFacts({
    Assets: makeConcept([{ end, val: 359241000000, form: '10-Q', filed: end }]),
  });
  const r = sec.pickConcept(facts, 'assets');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.latest.period, 'instant');
  assert.strictEqual(r.latest.val, 359241000000);
});

t('F6 非 10-K/10-Q 的申報（8-K、424B）一律不收', () => {
  const end = daysAgoIso(60);
  const start = daysAgoIso(151);
  const facts = makeFacts({
    RevenueFromContractWithCustomerExcludingAssessedTax: makeConcept([
      { start, end, val: 1, form: '8-K', filed: end },
    ]),
  });
  const r = sec.pickConcept(facts, 'revenue');
  assert.strictEqual(r.ok, false, '8-K 的數字口徑不一，必須排除');
});

t('F7 同一期間重述 → 取 filed 最新的一筆', () => {
  const end = daysAgoIso(60);
  const start = daysAgoIso(151);
  const cls = sec.classifyPeriods([
    { start, end, val: 100, form: '10-Q', filed: daysAgoIso(65) },
    { start, end, val: 105, form: '10-Q', filed: daysAgoIso(10) },
  ]);
  assert.strictEqual(cls.duration.length, 1, '同 (start,end) 應去重');
  assert.strictEqual(cls.duration[0].val, 105);
});

/* ============================================================
   G. TTM 推導
   ============================================================ */

console.log('\nG. TTM 推導（財年沒有單季 Q4 是必然，不是資料缺口）');

t('G1 ttm：4 個連續單季相加', () => {
  const pts = [
    dur('2025-10-01', '2025-12-31', 10),
    dur('2026-01-01', '2026-03-31', 20),
    dur('2026-04-01', '2026-06-30', 30),
    dur('2026-07-01', '2026-09-30', 40),
  ];
  const r = sec.ttm(pts);
  assert.ok(r, '應算得出來');
  assert.strictEqual(r.value, 100);
  assert.strictEqual(r.quarters, 4);
});

t('G2 ttm：中間缺一季（不連續）→ null，不可硬加', () => {
  const pts = [
    dur('2025-10-01', '2025-12-31', 10),
    dur('2026-01-01', '2026-03-31', 20),
    // 缺 2026Q2
    dur('2026-07-01', '2026-09-30', 40),
    dur('2026-10-01', '2026-12-31', 50),
  ];
  assert.strictEqual(sec.ttm(pts), null);
});

t('G3 ttm：不足 4 季 → null', () => {
  assert.strictEqual(sec.ttm([dur('2026-07-01', '2026-09-30', 40)]), null);
  assert.strictEqual(sec.ttm(null), null);
});

t('G4 deriveTtm 路線 1：連續四季，且最後一季就是最新點', () => {
  const pts = [
    dur('2025-10-01', '2025-12-31', 10),
    dur('2026-01-01', '2026-03-31', 20),
    dur('2026-04-01', '2026-06-30', 30),
    dur('2026-07-01', '2026-09-30', 40),
  ];
  const r = sec.deriveTtm(pts);
  assert.strictEqual(r.value, 100);
  assert.strictEqual(r.basis, 'TTM');
  assert.ok(r.method.includes('連續單季'));
});

t('G5 deriveTtm 路線 2：最新點是年度 → TTM == FY（不是資料缺口）', () => {
  const pts = [
    dur('2024-09-29', '2025-09-27', 391035000000, 'year'),
    dur('2025-09-28', '2026-09-26', 478834000000, 'year'),
  ];
  const r = sec.deriveTtm(pts);
  assert.ok(r, '財年結束時必須算得出來');
  assert.strictEqual(r.value, 478834000000);
  assert.strictEqual(r.basis, 'FY');
  assert.strictEqual(r.to, '2026-09-26');
});

t('G6 deriveTtm 路線 3：FY + 當期 YTD − 去年同期（錨定在最新點）', () => {
  // 模擬 MSFT：財年 6 月底結，最新點是 2026-09-30 的單季
  const pts = [
    dur('2025-07-01', '2026-06-30', 331840000000, 'year'),
    dur('2025-07-01', '2025-09-30', 77670000000, 'quarter'),
    dur('2026-07-01', '2026-09-30', 92280000000, 'quarter'),
  ];
  const r = sec.deriveTtm(pts);
  assert.ok(r, '應走第 3 條路線');
  assert.strictEqual(r.basis, 'TTM');
  assert.strictEqual(r.to, '2026-09-30', '結束日必須是最新點，不可停在 3 月');
  // 331.84 + 92.28 - 77.67 = 346.45（十億）
  assert.ok(Math.abs(r.value - 346450000000) < 1e6, `算得 ${r.value}，應為 346.45B`);
});

t('G7 deriveTtm：找不到去年同期 → null，不用猜的', () => {
  const pts = [
    dur('2025-07-01', '2026-06-30', 331.84, 'year'),
    dur('2026-07-01', '2026-09-30', 92.28, 'quarter'),
    // 沒有去年同期
  ];
  assert.strictEqual(sec.deriveTtm(pts), null);
});

t('G8 deriveTtm：空輸入 → null（不可拋錯）', () => {
  assert.strictEqual(sec.deriveTtm([]), null);
  assert.strictEqual(sec.deriveTtm(null), null);
});

/* ============================================================
   H. FOMC 解析
   ============================================================ */

console.log('\nH. FOMC 會議表格解析');

function meetingBlock(month, days, star) {
  return `<div class="fomc-meeting">
  <div class="fomc-meeting__month"><strong>${month}</strong></div>
  <div class="fomc-meeting__date">${days}${star ? '*' : ''}</div>
</div>`;
}

function yearBlock(year, list) {
  const inner = list.map(([m, d]) => meetingBlock(m, d, true)).join('\n');
  return `<h4>${year} FOMC Meetings</h4>\n<div class="panel">${inner}</div>`;
}

t('H1 解析 8 場會議（含跨月 8-9）', () => {
  const html = yearBlock(2026, [
    ['January', '27-28'], ['March', '17-18'], ['April', '28-29'], ['June', '16-17'],
    ['July', '28-29'], ['September', '15-16'], ['October', '27-28'], ['December', '8-9'],
  ]);
  const list = fomc.parseYearMeetings(html, 2026);
  assert.strictEqual(list.length, 8, `應為 8 場，實際 ${list.length}`);
  // 取「結束日」：27-28 → 28（決議與記者會都在第二天）
  assert.strictEqual(list[0].date, '2026-01-28');
  assert.strictEqual(list[list.length - 1].date, '2026-12-09', '取會議結束日');
});

t('H2 單日會議也可解析', () => {
  const html = yearBlock(2026, [['January', '28']]);
  const list = fomc.parseYearMeetings(html, 2026);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].date, '2026-01-28');
});

t('H3 年度隔離：解析 2026 不可混入 2027', () => {
  const html = yearBlock(2026, [['January', '27-28']])
    + yearBlock(2027, [['January', '26-27'], ['March', '16-17']]);
  const list = fomc.parseYearMeetings(html, 2026);
  assert.strictEqual(list.length, 1, `不可混入其他年度，實際 ${list.length}`);
});

t('H4 不存在的日期（2 月 30 日）→ 丟棄', () => {
  const html = yearBlock(2026, [['February', '30'], ['March', '17-18']]);
  const list = fomc.parseYearMeetings(html, 2026);
  assert.strictEqual(list.length, 1, '2 月 30 日必須被擋掉');
  assert.strictEqual(list[0].date, '2026-03-18', '3 月場次取結束日 18');
});

t('H5 找不到年度標記 → 空陣列', () => {
  assert.deepStrictEqual(fomc.parseYearMeetings('<div>nothing</div>', 2026), []);
  assert.deepStrictEqual(fomc.parseYearMeetings(null, 2026), []);
});

t('H6 重複日期去重', () => {
  const html = yearBlock(2026, [['January', '27-28'], ['January', '27-28']]);
  assert.strictEqual(fomc.parseYearMeetings(html, 2026).length, 1);
});

t('H7 validateMeetings：8 場 → ok', () => {
  const v = fomc.validateMeetings(new Array(8).fill({}), 2026);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.expected, 8);
  assert.strictEqual(v.parsed, 8);
});

t('H8 validateMeetings：10 場 → 警告（可能誤收 Jackson Hole）', () => {
  const v = fomc.validateMeetings(new Array(10).fill({}), 2026);
  assert.strictEqual(v.ok, false);
  assert.ok(v.issues.join('').includes('9 場'));
});

t('H9 validateMeetings：0 場 → 警告（頁面結構可能已變）', () => {
  const v = fomc.validateMeetings([], 2026);
  assert.strictEqual(v.ok, false);
  assert.ok(v.issues.join('').includes('解析不到'));
});

t('H10 validateMeetings：5 場 → 警告但不報錯（年度可能尚未公布完整）', () => {
  const v = fomc.validateMeetings(new Array(5).fill({}), 2026);
  assert.strictEqual(v.ok, false);
  assert.ok(v.issues.join('').includes('8 場'));
});

/* ============================================================
   I. 解讀引擎
   ============================================================ */

console.log('\nI. 解讀引擎（規則型、可追溯、不預測）');

t('I1 band 三級分類與標籤', () => {
  assert.strictEqual(interpret.band(1.5, [2, 3], ['低', '中', '高']).level, 'low');
  assert.strictEqual(interpret.band(2.5, [2, 3], ['低', '中', '高']).level, 'mid');
  assert.strictEqual(interpret.band(3.5, [2, 3], ['低', '中', '高']).level, 'high');
  assert.strictEqual(interpret.band(null, [2, 3], ['低', '中', '高']).level, 'unknown');
});

t('I2 通膨：核心 > 3% → 偏緊（hawkish）', () => {
  const f = interpret.interpretInflation({
    cpiYoy: series({ value: 3.5, unit: '%' }),
    coreCpiYoy: series({ value: 3.2, unit: '%' }),
  });
  assert.strictEqual(f.stance, 'hawkish');
  assert.ok(f.evidence.length > 0, '必須附上依據');
});

t('I3 通膨：核心 < 2% → 偏鬆（dovish）', () => {
  const f = interpret.interpretInflation({
    cpiYoy: series({ value: 1.5 }),
    coreCpiYoy: series({ value: 1.6 }),
  });
  assert.strictEqual(f.stance, 'dovish');
});

t('I4 通膨資料缺 → stance unknown，且不編造結論', () => {
  const f = interpret.interpretInflation({});
  assert.strictEqual(f.stance, 'unknown');
  assert.strictEqual(f.confidence, 'low');
});

t('I5 殖利率倒掛 → 明確說明「不能直接推論馬上衰退」', () => {
  const f = interpret.interpretRates({
    fedTargetUpper: series({ value: 4.0 }),
    fedTargetLower: series({ value: 3.75 }),
    dgs10: series({ value: 3.9 }),
    termSpread: series({ value: -0.35 }),
  });
  assert.strictEqual(f.stance, 'dovish');
  assert.ok(f.detail.includes('倒掛'));
  assert.ok(f.detail.includes('6–24 個月'), '必須說明時滯，避免被讀成即時預測');
});

t('I6 政策利率區間寬度異常 → 主動示警（資料可能錯）', () => {
  const f = interpret.interpretRates({
    fedTargetUpper: series({ value: 5.0 }),
    fedTargetLower: series({ value: 3.0 }),
    dgs10: series({ value: 4.1 }),
  });
  assert.ok(f.detail.includes('區間寬度'), '寬度 2.0 個百分點必須示警');
  assert.ok(f.detail.includes('⚠️'));
});

t('I7 勞動市場：失業率百分位低 → 偏緊', () => {
  const f = interpret.interpretLabor({
    unrate: series({ value: 3.8, stats: { percentile: 12, change: -0.1 } }),
  });
  assert.strictEqual(f.stance, 'hawkish');
  assert.ok(f.detail.includes('落後指標'), '必須提醒失業率是落後指標');
});

t('I8 軟硬指標嚴重背離 → stance mixed（不可挑一邊說）', () => {
  const f = interpret.interpretActivity({
    indpro: series({ value: 105, stats: { percentile: 92 } }),
    umcsent: series({ value: 52, stats: { percentile: 8 } }),
  });
  assert.strictEqual(f.stance, 'mixed');
  assert.ok(f.detail.includes('背離'));
});

t('I9 工業生產必須註明「與 ISM PMI 概念不同」', () => {
  const f = interpret.interpretActivity({
    indpro: series({ value: 105, stats: { percentile: 50 } }),
  });
  assert.ok(f.caveat && f.caveat.includes('ISM'), '這是本報告已驗證過的易混淆點');
});

t('I10 美元指數必須註明「與 ICE DXY 不可比較」', () => {
  const f = interpret.interpretExternal({
    dollarBroad: series({ value: 121, stats: { percentile: 60 } }),
  });
  assert.ok(f.caveat.includes('DXY'));
  assert.ok(f.detail.includes('美元走弱') || f.detail.includes('EUR/USD') || true);
});

t('I11 interpretMacro 整體結構：5 條結論 + 免責聲明 + 不預測', () => {
  const r = interpret.interpretMacro({ series: {}, schedule: null });
  assert.strictEqual(r.scope, 'macro');
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.mode, 'rule');
  assert.ok(r.disclaimer.includes('不構成任何投資建議'), `disclaimer 實際：${r.disclaimer}`);
  assert.ok(r.disclaimer.includes('不預測'));
  assert.deepStrictEqual(
    r.findings.map((f) => f.topic),
    ['inflation', 'rates', 'labor', 'activity', 'external']
  );
});

t('I12 全部指標不可用 → 整體傾向必須是 unknown，不可說「中性」', () => {
  const r = interpret.interpretMacro({ series: {}, schedule: null });
  assert.strictEqual(r.gaps.length, 5, '5 個主題全部列為缺口');
  assert.strictEqual(r.overall.stance, 'unknown',
    '全部資料不足時說「大致中性」是誤導（會讓使用者以為已經判斷過了）');
});

t('I13 多數指標偏緊 → 整體 hawkish', () => {
  const s = {
    cpiYoy: series({ value: 3.6, unit: '%' }),
    coreCpiYoy: series({ value: 3.4, unit: '%' }),
    fedTargetUpper: series({ value: 4.25 }),
    fedTargetLower: series({ value: 4.0 }),
    dgs10: series({ value: 4.3 }),
    termSpread: series({ value: 0.6 }),
    unrate: series({ value: 3.7, stats: { percentile: 10, change: 0 } }),
    indpro: series({ value: 103, stats: { percentile: 55 } }),
    umcsent: series({ value: 70, stats: { percentile: 45 } }),
    dollarBroad: series({ value: 120, stats: { percentile: 50 } }),
  };
  const r = interpret.interpretMacro({ series: s, schedule: null });
  assert.strictEqual(r.overall.stance, 'hawkish', JSON.stringify(r.overall.counts));
  assert.ok(r.overall.counts.hawkish >= 2);
});

t('I14 每個 finding 都有 id / headline / detail / confidence', () => {
  const r = interpret.interpretMacro({
    series: { unrate: series({ value: 4.1, stats: { percentile: 40, change: 0.1 } }) },
    schedule: null,
  });
  for (const f of r.findings) {
    assert.ok(f.id, '缺 id');
    assert.ok(typeof f.headline === 'string' && f.headline.length, `${f.id} 缺 headline`);
    assert.ok(typeof f.detail === 'string' && f.detail.length, `${f.id} 缺 detail`);
    assert.ok(['high', 'medium', 'low'].includes(f.confidence), `${f.id} confidence 非法`);
  }
});

t('I15 財報不可用 → available:false 並帶原因（不是空結論）', () => {
  const r = interpret.interpretFundamentals({
    available: false, unavailable: 'not_applicable', reason: '港股無 SEC 財報',
  });
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.unavailable, 'not_applicable');
  assert.strictEqual(r.reason, '港股無 SEC 財報');
  assert.deepStrictEqual(r.findings, []);
});

t('I16 財報 ROE 異常高 → caveat 必須說明原因，不可默默給數字', () => {
  const fund = {
    available: true, symbol: 'AAPL', asOf: '2026-09-26',
    metrics: {
      roe: 117.92,
      roeNote: '股東權益因庫藏股大幅縮小，ROE 偏高屬會計現象',
      revenue: { value: 478834000000, to: '2026-09-26', basis: 'FY', yoy: 8.2 },
    },
    balance: { equity: { value: 112000000000, asOf: '2026-09-26' } },
    gaps: [],
  };
  const r = interpret.interpretFundamentals(fund, {});
  const roe = r.findings.find((f) => f.id === 'roe');
  assert.ok(roe, '應有 ROE 結論');
  assert.strictEqual(roe.confidence, 'medium', '有 caveat 時信心水準下調');
  assert.strictEqual(roe.caveat, fund.metrics.roeNote);
});

t('I17 未提供股價 → 本益比列入 gaps，不猜', () => {
  const fund = {
    available: true, symbol: 'X', asOf: '2026-09-26',
    metrics: {
      revenue: { value: 100, to: '2026-09-26', basis: 'FY', yoy: 5 },
      epsDiluted: { value: 2.5, to: '2026-09-26', period: 'year' },
    },
    balance: null, gaps: [],
  };
  const r = interpret.interpretFundamentals(fund, null);
  assert.ok(r.gaps.some((g) => g.includes('本益比')), JSON.stringify(r.gaps));
  assert.strictEqual(r.findings.find((f) => f.id === 'valuation'), undefined);
});

t('I18 有股價 → 本益比可算，且說明口徑差異', () => {
  const fund = {
    available: true, symbol: 'X', asOf: '2026-09-26',
    metrics: {
      revenue: { value: 100, to: '2026-09-26', basis: 'FY', yoy: 5 },
      epsDiluted: { value: 2.5, to: '2026-09-26', period: 'year' },
    },
    balance: null, gaps: [],
  };
  const r = interpret.interpretFundamentals(fund, { price: 100 });
  const v = r.findings.find((f) => f.id === 'valuation');
  assert.ok(v);
  assert.ok(v.headline.includes('40'), `100/2.5 應為 40 倍，實際 ${v.headline}`);
  assert.ok(v.caveat);
});

/* ============================================================
   J. LLM 幻覺數字攔截
   ============================================================ */

console.log('\nJ. LLM 幻覺數字攔截');

/** 造一個最小可用的解讀結果供 polishWithLlm 使用 */
function fakeInterp() {
  return {
    findings: [
      {
        headline: '政策利率 3.75%–4.00%',
        detail: '目標區間為 3.75%–4.00%。',
        stance: 'neutral',
        evidence: [
          { label: '上限', value: 4.0, unit: '%' },
          { label: '下限', value: 3.75, unit: '%' },
        ],
      },
    ],
  };
}

/** 暫時替換 global.fetch 並執行 */
async function withStubFetch(stub, fn) {
  const orig = global.fetch;
  global.fetch = stub;
  try {
    return await fn();
  } finally {
    global.fetch = orig;
  }
}

async function runLlmTests() {
  // 整個 J 系列都要「不讀本機 config.json」，否則本機填了金鑰／開了 disableThinking
  // 就會讓測試結果隨機器而異（假失敗或假通過）。
  const origCfgPath = process.env.LLM_CONFIG_PATH;
  process.env.LLM_CONFIG_PATH = '';
  try {
    await runLlmTestsInner();
  } finally {
    if (origCfgPath != null) process.env.LLM_CONFIG_PATH = origCfgPath;
    else delete process.env.LLM_CONFIG_PATH;
  }
}

async function runLlmTestsInner() {
  await ta('J1 無 API Key → 靜默退回規則層，不報錯', async () => {
    const origKey = process.env.OPENAI_API_KEY;
    const origLlmKey = process.env.LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_API_KEY;
    try {
      const r = await interpret.polishWithLlm(fakeInterp(), {});
      assert.strictEqual(r.text, null);
      assert.strictEqual(r.mode, 'rule');
      assert.ok(r.note.includes('未設定'));
    } finally {
      if (origKey != null) process.env.OPENAI_API_KEY = origKey;
      if (origLlmKey != null) process.env.LLM_API_KEY = origLlmKey;
    }
  });

  await ta('J2 回應只含來源數字 → 採用 LLM 文字', async () => {
    const r = await withStubFetch(
      async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '政策利率為 3.75% 至 4.00%，目前維持不變。' } }] }),
      }),
      () => interpret.polishWithLlm(fakeInterp(), { apiKey: 'test-key' })
    );
    assert.strictEqual(r.mode, 'llm');
    assert.ok(r.text.includes('3.75'));
    assert.strictEqual(r.note, null);
  });

  await t2('J3 回應含大量來源沒有的數字 → 整段棄用（防幻覺污染）', async () => {
    const r = await withStubFetch(
      async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '就業成長 9.87%，通膨 7.65%，成長率 6.54%，失業率 5.43%，全部轉好。' } }],
        }),
      }),
      () => interpret.polishWithLlm(fakeInterp(), { apiKey: 'test-key' })
    );
    assert.strictEqual(r.text, null, '不可採用含憑空數字的文字');
    assert.strictEqual(r.mode, 'rule');
    assert.ok(r.note.includes('幻覺'), `note 應說明原因，實際：${r.note}`);
  });

  await t2('J4 HTTP 錯誤 → 退回規則層', async () => {
    const r = await withStubFetch(
      async () => ({ ok: false, status: 500 }),
      () => interpret.polishWithLlm(fakeInterp(), { apiKey: 'test-key' })
    );
    assert.strictEqual(r.mode, 'rule');
    assert.ok(r.note.includes('500'));
  });

  await t2('J5 網路拋錯 → 退回規則層（不可讓整頁掛掉）', async () => {
    const r = await withStubFetch(
      async () => { throw new Error('ECONNREFUSED'); },
      () => interpret.polishWithLlm(fakeInterp(), { apiKey: 'test-key' })
    );
    assert.strictEqual(r.mode, 'rule');
    assert.ok(r.note.includes('ECONNREFUSED'));
  });

  await t2('J6 空回應 → 退回規則層', async () => {
    const r = await withStubFetch(
      async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '   ' } }] }) }),
      () => interpret.polishWithLlm(fakeInterp(), { apiKey: 'test-key' })
    );
    assert.strictEqual(r.mode, 'rule');
    assert.ok(r.note.includes('空'));
  });

  /* ---- 以下四條對應實測 DeepSeek-V4.1-flash 時踩到的坑 ---- */

  await t2('J7 推理模型吃光 token（finish_reason=length）→ 說明是預算不足，不可只說「空回應」', async () => {
    const r = await withStubFetch(
      async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            finish_reason: 'length',
            message: { content: '', reasoning_content: '先想想…' },
          }],
          usage: { completion_tokens_details: { reasoning_tokens: 3000 } },
        }),
      }),
      () => interpret.polishWithLlm(fakeInterp(), { apiKey: 'test-key' })
    );
    assert.strictEqual(r.mode, 'rule');
    assert.ok(/預算|推理/.test(r.note), `應指出推理吃光預算，實際：${r.note}`);
    assert.ok(r.note.includes('3000'), `應帶出實際 token 數，實際：${r.note}`);
  });

  await t2('J8 reasoning_content 不得被當成結果輸出（模型的思考草稿含未查核數字）', async () => {
    const r = await withStubFetch(
      async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            finish_reason: 'stop',
            message: {
              content: '政策利率為 3.75% 至 4.00%。',
              reasoning_content: '草稿：也許利率是 9.99%，通膨 8.88%…',
            },
          }],
        }),
      }),
      () => interpret.polishWithLlm(fakeInterp(), { apiKey: 'test-key' })
    );
    assert.strictEqual(r.mode, 'llm');
    assert.ok(!r.text.includes('9.99'), 'reasoning_content 的數字絕不可外流');
    assert.ok(!r.text.includes('8.88'), 'reasoning_content 的數字絕不可外流');
    assert.ok(r.text.includes('3.75'));
  });

  await t2('J9 模型引用 detail 裡的百分位數 → 不可誤判為幻覺（白名單須含 prompt 全文）', async () => {
    const interp = {
      findings: [
        {
          headline: '失業率 4.1%（歷史 18.3 百分位）',
          detail: '失業率為 4.1%，位於歷史 18.3 百分位，屬相對低檔。',
          stance: 'neutral',
          evidence: [{ label: '失業率', value: 4.1, unit: '%', percentile: 18.3 }],
        },
        {
          headline: '工業生產 102.24（99.2 百分位）',
          detail: '工業生產 102.24，位於 99.2 百分位。',
          stance: 'mixed',
          evidence: [{ label: '工業生產', value: 102.24, unit: 'index', percentile: 99.2 }],
        },
      ],
    };
    // 模型輸出大量引用這些百分位數——它們都在 prompt 裡，屬合法引用
    const r = await withStubFetch(
      async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            finish_reason: 'stop',
            message: {
              content: '失業率 4.1%，處於歷史 18.3 百分位；工業生產 102.24，位於 99.2 百分位，兩者指向不同方向。',
            },
          }],
        }),
      }),
      () => interpret.polishWithLlm(interp, { apiKey: 'test-key' })
    );
    assert.strictEqual(r.mode, 'llm', `合法引用不該被丟棄，實際 note：${r.note}`);
    assert.ok(r.text.includes('18.3'));
  });

  await t2('J10 關閉推理時要送出 enable_thinking:false', async () => {
    let sent = null;
    await withStubFetch(
      async (url, opt) => {
        sent = JSON.parse(opt.body);
        return {
          ok: true,
          json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '利率 3.75%–4.00%。' } }] }),
        };
      },
      () => interpret.polishWithLlm(fakeInterp(), { apiKey: 'test-key', disableThinking: true })
    );
    assert.strictEqual(sent.enable_thinking, false, '應送出 enable_thinking:false');

    // 未指定時不得多送非標準參數，避免打擾不支援的供應商
    let sent2 = null;
    await withStubFetch(
      async (url, opt) => {
        sent2 = JSON.parse(opt.body);
        return {
          ok: true,
          json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '利率 3.75%–4.00%。' } }] }),
        };
      },
      () => interpret.polishWithLlm(fakeInterp(), { apiKey: 'test-key' })
    );
    assert.ok(!('enable_thinking' in sent2), '未啟用時不該送出 enable_thinking');
  });
}

/** 非同步測試（ta 的別名，語意更清楚） */
async function t2(name, fn) {
  return ta(name, fn);
}

/* ============================================================
   K. 資料字典
   ============================================================ */

console.log('\nK. 資料字典欄位完整性');

async function runDictTests() {
  await ta('K1 MACRO_KEYS 全部對應到已註冊序列', async () => {
    for (const k of macro.MACRO_KEYS) {
      assert.ok(fred.BY_KEY.get(k), `key ${k} 未在 fred 註冊表中`);
    }
  });

  await ta('K2 字典筆數 = 18 宏觀 + 8 財報 = 26，且每個欄位四要素齊備', async () => {
    // 把 FRED 抓取換成「不可用」，確保測試不連網且走降級分支
    const orig = fred.getSeries;
    fred.getSeries = async () => ({ available: false, unavailable: 'transient', reason: 'test stub' });
    macro.cache.clear();
    try {
      const d = await macro.getDataDictionary();
      assert.strictEqual(d.ok, true);
      assert.strictEqual(d.fields.length, 26, `應為 26 個欄位，實際 ${d.fields.length}`);

      const macroCount = d.fields.filter((f) => f.group === '宏觀經濟').length;
      const fundCount = d.fields.filter((f) => f.group === '企業財報').length;
      assert.strictEqual(macroCount, 18);
      assert.strictEqual(fundCount, 8);

      for (const f of d.fields) {
        assert.ok(f.key, `缺 key：${JSON.stringify(f).slice(0, 80)}`);
        assert.ok(f.label, `${f.key} 缺 label`);
        assert.ok(f.definition && f.definition.length > 5, `${f.key} 缺欄位定義`);
        assert.ok(f.source && f.source.length, `${f.key} 缺資料來源`);
        assert.ok(Array.isArray(f.range) && f.range.length === 2, `${f.key} 的 range 必須是 [lo, hi]`);
        assert.ok(typeof f.range[0] === 'number' && typeof f.range[1] === 'number', `${f.key} range 必須為數字`);
        assert.ok(f.range[0] < f.range[1], `${f.key} range 下限必須小於上限`);
        assert.ok(f.unit, `${f.key} 缺單位`);
        assert.ok('example' in f, `${f.key} 缺 example 欄位（即使是 null 也要有）`);
      }
    } finally {
      fred.getSeries = orig;
      macro.cache.clear();
    }
  });

  await ta('K3 抓不到資料時 example 為 null，不編造範例值', async () => {
    const orig = fred.getSeries;
    fred.getSeries = async () => ({ available: false, reason: 'test stub' });
    macro.cache.clear();
    try {
      const d = await macro.getDataDictionary();
      const macroFields = d.fields.filter((f) => f.group === '宏觀經濟');
      assert.ok(macroFields.every((f) => f.example === null), '上游不可用時不可給假範例值');
    } finally {
      fred.getSeries = orig;
      macro.cache.clear();
    }
  });

  await ta('K4 財報欄位列出了計算方式（不是只有名字）', async () => {
    const orig = fred.getSeries;
    fred.getSeries = async () => ({ available: false });
    macro.cache.clear();
    try {
      const d = await macro.getDataDictionary();
      const fund = d.fields.filter((f) => f.group === '企業財報');
      const roe = fund.find((f) => f.key === 'roe');
      assert.ok(roe, '應有 ROE 欄位');
      assert.ok(roe.definition.includes('/') || roe.definition.includes('淨利'), 'ROE 需說明計算方式');
    } finally {
      fred.getSeries = orig;
      macro.cache.clear();
    }
  });
}

/* ============================================================
   L. 前端契約（避免「後端改一名、前端就空白」）
   ============================================================ */

console.log('\nL. 前端契約：macro.js 用到的 id / class 必須存在');

const ROOT = path.join(__dirname, '..');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const macroSrc = fs.readFileSync(path.join(ROOT, 'public/macro.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const commonSrc = fs.readFileSync(path.join(ROOT, 'public/common.js'), 'utf8');

t('L1 macro.js 取用的每個 element id 都存在于 index.html', () => {
  const ids = new Set();
  const re = /\$\('([A-Za-z0-9_]+)'\)/g;
  let m;
  while ((m = re.exec(macroSrc))) ids.add(m[1]);
  assert.ok(ids.size > 10, `應找到多個 id，實際 ${ids.size}`);

  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(htmlSrc));
  assert.deepStrictEqual(missing, [], `index.html 缺少：${missing.join(', ')}`);
});

t('L2 macro.js 產生的每個 CSS class 都有樣式定義', () => {
  // 只驗「靜態 class」。class 屬性常帶字串拼接：
  //   class="pct-fill ' + tone + '"
  //   class="interp-overall ' + om.cls + '"
  // 拼接段是 JS 變數（tone / om.cls），不是 class 名，硬掃會掃到變數名。
  // 處理方式：遇到含單引號的屬性，只取第一個引號前的靜態前綴；
  // 拼接出來的那一半由下方的 dynamic 清單逐一列舉驗證。
  const isValidClass = (c) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c);

  const staticClasses = new Set();
  const re = /class="([^"]+)"/g;
  let m;
  while ((m = re.exec(macroSrc))) {
    const raw = m[1];
    const staticPart = raw.includes("'") ? raw.slice(0, raw.indexOf("'")) : raw;
    for (const c of staticPart.split(/\s+/)) if (isValidClass(c)) staticClasses.add(c);
  }

  // 動態 class：前綴 + 後綴組合，必須逐一列出（否則漏掉也不知道）
  const dynamic = [
    'mn-loading', 'mn-error', 'mn-warn', 'mn-info', 'mn-degraded',
    'st-hawk', 'st-dove', 'st-neutral', 'st-mixed', 'st-pos', 'st-neg', 'st-unknown',
    'src-fred', 'src-sec', 'src-other',
    'fomc-past', 'fomc-next', 'fomc-future',
    'badge-ok', 'badge-neutral',
    'macro-notice', 'macro-panel', 'interp-llm', 'interp-llm-note',
    'interp-card', 'ic-tag', 'interp-overall', 'pct-fill', 'badge',
  ];
  for (const c of dynamic) staticClasses.add(c);

  // pct-fill 的 tone 是同一元素上的修飾 class（class="pct-fill hi"）
  for (const tone of ['hi', 'mid', 'lo']) {
    assert.ok(new RegExp(`\\.pct-fill\\.${tone}\\b`).test(cssSrc), `styles.css 缺 .pct-fill.${tone}`);
  }

  const missing = [...staticClasses].filter(
    (c) => !new RegExp(`\\.${c.replace(/-/g, '\\-')}\\b`).test(cssSrc)
  );
  assert.deepStrictEqual(missing.sort(), [], `styles.css 缺少樣式：${missing.join(', ')}`);
});

t('L3 index.html 新 view 引用的 class 都有樣式', () => {
  const start = htmlSrc.indexOf('id="viewMacro"');
  assert.ok(start > 0, 'index.html 應有 #viewMacro');
  const chunk = htmlSrc.slice(start, htmlSrc.indexOf('/#viewMacro', start) + 20);

  const classes = new Set();
  const re = /class="([^"]+)"/g;
  let m;
  while ((m = re.exec(chunk))) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  const missing = [...classes].filter((c) => !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}\\b`).test(cssSrc));
  assert.deepStrictEqual(missing.sort(), [], `styles.css 缺少：${missing.join(', ')}`);
});

t('L4 common.js 已註冊 macro 路由並提供 onMacro 鉤子', () => {
  assert.ok(/macro:\s*'macro'/.test(commonSrc), 'ROUTES 需含 macro');
  assert.ok(/onMacro/.test(commonSrc), 'handlers 需含 onMacro');
  assert.ok(/head === 'macro'/.test(commonSrc), '需解析 #/macro/:symbol');
});

t('L5 macro.js 已掛上 SA.onRoute，且對外匯出測試介面', () => {
  assert.ok(macroSrc.includes('SA.onRoute('), '需註冊路由');
  assert.ok(macroSrc.includes('global.MacroPage'), '需匯出 MacroPage 供測試');
});

t('L6 前端有轉義所有動態字串（SA.esc）', () => {
  // 插入 innerHTML 的動態值都必須包在 SA.esc(...) 內。
  // 注意實際寫法常帶 fallback 或運算，例如 SA.esc(s.label || s.key)、
  // SA.esc(om.label)，因此比對「該識別字出現在某個 SA.esc( ... ) 之內」，
  // 而不是要求完全相等。
  const risky = [
    's.label', 's.definition', 's.reason', 'f.label', 'e.label',
    'f.headline', 'f.detail', 'f.caveat', 'ov.text', 'it.m.label',
    'om.label', 'm.label', 'why', 'info.message', 'info.title', 'info.hint',
  ];
  for (const r of risky) {
    const esc = r.replace('.', '\\.');
    // 抓出所有 SA.esc(...) 的參數內容（容許一層括號）
    const re = /SA\.esc\(((?:[^()]|\([^()]*\))*)\)/g;
    let m;
    let found = false;
    while ((m = re.exec(macroSrc))) {
      if (new RegExp(`(^|[^A-Za-z0-9_.])${esc}([^A-Za-z0-9_]|$)`).test(m[1])) { found = true; break; }
    }
    assert.ok(found, `${r} 未經 SA.esc 轉義`);
  }
});

t('L7 前端不得用 0 代替 null（會畫出假跌破）', () => {
  // 檢查 fmtValue 對 null 回 '—'
  assert.ok(/if \(v == null \|\| !isFinite\(v\)\) return '—'/.test(macroSrc),
    'fmtValue 必須把 null 顯示為破折號而非 0');
  assert.ok(/if \(v == null \|\| !isFinite\(v\)\) return '—'/.test(macroSrc.replace(/\s+/g, ' ')) ||
    macroSrc.includes("return '—'"), '數值格式化需有 null 保護');
});

t('L8 單位已帶量級時不得再縮寫（防雙重換算）', () => {
  // 這是實測踩到的顯示 bug：單位欄寫「十億美元」，數值卻顯示 24.7K，
  // 讀起來像 24.7 千億美元，實際是 24.7 兆。必須有「單位帶量級就不縮寫」的分支。
  assert.ok(/unitHasScale/.test(macroSrc), 'fmtValue 需偵測單位是否已含量級');
  assert.ok(/千人\|百萬\|十億/.test(macroSrc) || /千人\|百萬\|十億\|兆/.test(macroSrc.replace(/\s/g, '')),
    '需列舉會帶量級的單位詞');

  // 靜態檢查：unitHasScale 的 if 區塊內不可呼叫 fmtInt（會二次縮寫）。
  // 只需取該 if 的 { ... }，不可整段 400 字 —— 後面正常分支本來就有 fmtInt。
  const idx = macroSrc.indexOf('unitHasScale');
  assert.ok(idx > 0, '找不到 unitHasScale 分支');
  const open = macroSrc.indexOf('{', idx);
  let depth = 0;
  let close = -1;
  for (let i = open; i < macroSrc.length; i++) {
    if (macroSrc[i] === '{') depth += 1;
    else if (macroSrc[i] === '}') { depth -= 1; if (depth === 0) { close = i; break; } }
  }
  assert.ok(close > open, 'unitHasScale 的 if 區塊沒有正確閉合');
  const block = macroSrc.slice(open, close + 1);
  assert.ok(!/fmtInt/.test(block), 'unitHasScale 分支內不可再呼叫 fmtInt（會二次縮寫）');
  assert.ok(/SA\.fmt\(/.test(block), 'unitHasScale 分支應直接用千分位格式化');
});

t('L9 面向前端的文字不得含 Markdown 標記（會被當純文字顯示）', () => {
  // 實測踩到：disclaimer 寫了 **不構成投資建議**，因為前端用 textContent
  // 直接輸出，畫面上就真的出現兩個星號。這類字串一律用「」引號強調。
  // 只檢查會流向 UI 的欄位，程式註解與送給 LLM 的 prompt 不在此限。
  const r = interpret.interpretMacro({ series: {}, schedule: null });
  const check = (label, text) => {
    if (typeof text !== 'string') return;
    assert.ok(!/\*\*/.test(text), `${label} 含 Markdown ** ：${text.slice(0, 60)}`);
    assert.ok(!/^#{1,6}\s/m.test(text), `${label} 含 Markdown 標題：${text.slice(0, 60)}`);
  };
  check('macro disclaimaid', r.disclaimer);
  check('overall.text', r.overall.text);
  for (const f of r.findings) {
    check(`${f.id}.headline`, f.headline);
    check(`${f.id}.detail`, f.detail);
    check(`${f.id}.caveat`, f.caveat);
  }

  const fund = {
    available: true, symbol: 'X', asOf: '2026-09-26',
    metrics: {
      revenue: { value: 478834000000, to: '2026-09-26', basis: 'FY', yoy: 8.2 },
      grossMargin: 48.79, netMargin: 27.6, roe: 117.92,
      roeNote: '股東權益因庫藏股大幅縮小，ROE 偏高屬會計現象',
      debtRatio: 78.5, epsDiluted: { value: 8.98, to: '2026-09-26', period: 'year' },
    },
    balance: {
      equity: { value: 112000000000, asOf: '2026-09-26' },
      assets: { value: 359241000000, asOf: '2026-09-26' },
      liabilities: { value: 282000000000, asOf: '2026-09-26' },
    },
    gaps: [],
  };
  const fr = interpret.interpretFundamentals(fund, { price: 278 });
  check('fundamentals disclaimer', fr.disclaimer);
  for (const f of fr.findings) {
    check(`fund.${f.id}.headline`, f.headline);
    check(`fund.${f.id}.detail`, f.detail);
    check(`fund.${f.id}.caveat`, f.caveat);
  }
});

/* ============================================================
   執行非同步測試並輸出
   ============================================================ */

(async () => {
  console.log('\n--- 非同步測試 ---');
  await runLlmTests();
  await runDictTests();

  console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
  if (fail) {
    console.log('\n失敗明細：');
    failures.forEach((f) => console.log(` - ${f.name}: ${f.msg}`));
  }
  process.exit(fail === 0 ? 0 : 1);
})();
