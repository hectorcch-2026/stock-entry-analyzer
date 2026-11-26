'use strict';

/**
 * 經濟資料庫（econ-store）單元測試 — 完全不連網
 * ===============================================
 *
 * 這個模組的核心不是「怎麼存」，而是「**已存在的資料遇到新資料時怎麼辦**」。
 * 那段邏輯一旦被改回去，症狀非常安靜：
 *   - null 蓋掉真值   → 圖表出現莫名缺口，看起來像上游沒資料
 *   - 同值重複寫      → 檔案越長越大、修訂紀錄被灌爆，但畫面完全正常
 *   - 舊回應蓋新資料  → 數值退回上一期，只會偶爾發生一次，極難重現
 * 所以每一條規則都必須被測試鎖住。
 *
 * 覆蓋範圍：
 *   A. 期間正規化（去重的基礎）
 *   B. 寫入與唯一鍵
 *   C. 六種更新決策（insert / unchanged / update / null / stale / 無時間戳）
 *   D. 持久化與重啟
 *   E. 查詢（範圍／排序／limit／最新）
 *   F. 更新既有紀錄（含 NOT_FOUND）
 *   G. 修訂軌跡
 *   H. 容錯（損壞檔、版本不符、壞列）
 *
 * 用法：node tests/econ-store-unit.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/econ-store');

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

/** 建一個臨時目錄；回傳 { dir, cleanup } */
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `econ-${tag}-`));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 記憶體 store（不落地），每次都是乾淨的 */
function mem() {
  return store.openStore({ dir: null });
}

/** 建好主檔的記憶體 store */
function memWithSeries(over) {
  const s = mem();
  s.writeSeries({
    seriesKey: 'cpiYoy',
    label: 'CPI 年增率',
    unit: '%',
    frequency: 'M',
    source: 'FRED',
    sourceId: 'CPIAUCSL',
    ...(over || {}),
  });
  return s;
}

/* ===============================================================
   A. 期間正規化
   =============================================================== */

console.log('\nA. 期間正規化（去重的基礎）');

t('A1 月頻：不同「日」必須收斂成同一個年月', () => {
  const { normalizePeriod } = store;
  assert.strictEqual(normalizePeriod('2026-10-01', 'M'), '2026-10');
  assert.strictEqual(normalizePeriod('2026-10-31', 'M'), '2026-10');
  assert.strictEqual(normalizePeriod('2026-10-15T00:00:00', 'M'), '2026-10');
  // 這三個若不收斂，同一個月會變三筆，圖表出現「同月多點」
});

t('A2 月頻：個位數月份補零（否則字串排序會錯）', () => {
  const { normalizePeriod } = store;
  assert.strictEqual(normalizePeriod('2026-9-1', 'M'), '2026-09');
  // 若輸出 '2026-9'，則 '2026-9' > '2026-10'（字串比較），期間排序會整個亂掉
  assert.ok(normalizePeriod('2026-09', 'M') < normalizePeriod('2026-10', 'M'));
});

t('A3 日頻：保留完整日期', () => {
  const { normalizePeriod } = store;
  assert.strictEqual(normalizePeriod('2026-10-01', 'D'), '2026-10-01');
  assert.strictEqual(normalizePeriod('2026-10-02', 'D'), '2026-10-02');
});

t('A4 日頻缺日 → null（不可猜成月初，否則兩筆日資料會撞在一起）', () => {
  const { normalizePeriod } = store;
  assert.strictEqual(normalizePeriod('2026-10', 'D'), null);
});

t('A5 季頻：月份換算成 Q1–Q4', () => {
  const { normalizePeriod } = store;
  assert.strictEqual(normalizePeriod('2026-01-01', 'Q'), '2026-Q1');
  assert.strictEqual(normalizePeriod('2026-04-01', 'Q'), '2026-Q2');
  assert.strictEqual(normalizePeriod('2026-07-01', 'Q'), '2026-Q3');
  assert.strictEqual(normalizePeriod('2026-10-01', 'Q'), '2026-Q4');
  assert.strictEqual(normalizePeriod('2026-12-31', 'Q'), '2026-Q4');
});

t('A6 年頻：只留年份', () => {
  const { normalizePeriod } = store;
  assert.strictEqual(normalizePeriod('2026-10-01', 'Y'), '2026');
});

t('A7 無法解析 → null（呼叫端必須跳過，不可寫入空鍵）', () => {
  const { normalizePeriod } = store;
  for (const bad of ['', null, undefined, 'abc', '2026-13-01', '2026-00-01']) {
    assert.strictEqual(normalizePeriod(bad, 'M'), null, `應為 null：${JSON.stringify(bad)}`);
  }
});

t('A8 唯一標識格式固定為 seriesKey|period', () => {
  const { observationId, splitObservationId } = store;
  assert.strictEqual(observationId('cpiYoy', '2026-10'), 'cpiYoy|2026-10');
  assert.deepStrictEqual(splitObservationId('cpiYoy|2026-10'), {
    seriesKey: 'cpiYoy', period: '2026-10',
  });
  // 沒有分隔符 → null（不可誤拆）
  assert.strictEqual(splitObservationId('cpiYoy'), null);
});

/* ===============================================================
   B. 寫入與唯一鍵
   =============================================================== */

console.log('\nB. 寫入與唯一鍵');

t('B1 首次寫入 → inserted', () => {
  const s = memWithSeries();
  const r = s.write({ seriesKey: 'cpiYoy', period: '2026-10-01', value: 3.72 });
  assert.strictEqual(r.action, 'inserted');
  assert.strictEqual(r.id, 'cpiYoy|2026-10');
  assert.strictEqual(s.stats().counts.observations, 1);
});

t('B2 同月不同日 → 只有一筆（唯一鍵真的生效）', () => {
  const s = memWithSeries();
  s.write({ seriesKey: 'cpiYoy', period: '2026-10-01', value: 3.72 });
  s.write({ seriesKey: 'cpiYoy', period: '2026-10-31', value: 3.72 });
  s.write({ seriesKey: 'cpiYoy', period: '2026-10-15', value: 3.72 });
  assert.strictEqual(s.stats().counts.observations, 1);
});

t('B3 不同序列同期間 → 兩筆（唯一鍵含 seriesKey）', () => {
  const s = memWithSeries();
  s.writeSeries({ seriesKey: 'coreCpiYoy', label: '核心 CPI', unit: '%', frequency: 'M' });
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
  s.write({ seriesKey: 'coreCpiYoy', period: '2026-10', value: 3.31 });
  assert.strictEqual(s.stats().counts.observations, 2);
});

t('B4 缺 seriesKey → 拋錯（不可寫入無主資料）', () => {
  const s = memWithSeries();
  assert.throws(() => s.write({ period: '2026-10', value: 1 }), /seriesKey|missing-seriesKey/);
});

t('B5 期間無法解析 → 拋錯（不可用空鍵入庫）', () => {
  const s = memWithSeries();
  assert.throws(() => s.write({ seriesKey: 'cpiYoy', period: 'not-a-date', value: 1 }), /period/i);
});

t('B6 批次寫入會回報統計，且同批次重複不產生兩列', () => {
  const s = memWithSeries();
  const r = s.writeMany([
    { seriesKey: 'cpiYoy', period: '2026-08-01', value: 3.91 },
    { seriesKey: 'cpiYoy', period: '2026-09-01', value: 3.72 },
    { seriesKey: 'cpiYoy', period: '2026-09-30', value: 3.72 }, // 同月 → 去重
    { seriesKey: 'cpiYoy', period: '2026-10-01', value: 3.55 },
  ]);
  assert.strictEqual(r.inserted, 3);
  assert.strictEqual(r.duplicatesInBatch, 1);
  assert.strictEqual(s.stats().counts.observations, 3);
});

/* ===============================================================
   C. 六種更新決策 —— 本模組的核心
   =============================================================== */

console.log('\nC. 更新決策（已存在時怎麼辦）');

t('C1 值相同 → unchanged，且不記修訂、不改 updatedAt', () => {
  const s = memWithSeries();
  const first = s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
  const before = s.get('cpiYoy', '2026-10');
  const r = s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
  assert.strictEqual(r.action, 'unchanged');
  assert.strictEqual(s.stats().counts.revisions, 0);
  const after = s.get('cpiYoy', '2026-10');
  assert.strictEqual(after.updatedAt, before.updatedAt, 'unchanged 不該更新 updatedAt');
  assert.strictEqual(first.action, 'inserted');
});

t('C2 值變了 → updated，且記一筆修訂（含前後值）', () => {
  const s = memWithSeries();
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
  const r = s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.69 });
  assert.strictEqual(r.action, 'updated');
  assert.strictEqual(s.get('cpiYoy', '2026-10').value, 3.69);
  assert.strictEqual(s.get('cpiYoy', '2026-10').revisionCount, 1);

  const revs = s.revisionsOf('cpiYoy', '2026-10');
  assert.strictEqual(revs.length, 1);
  assert.strictEqual(revs[0].prevValue, 3.72);
  assert.strictEqual(revs[0].newValue, 3.69);
});

t('C3 null 不覆蓋既有真值（最重要的一條）', () => {
  const s = memWithSeries();
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
  const r = s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: null });
  assert.strictEqual(r.action, 'skipped');
  assert.strictEqual(r.reason, 'null-does-not-overwrite');
  assert.strictEqual(s.get('cpiYoy', '2026-10').value, 3.72, '值必須沒變');
  assert.strictEqual(s.stats().counts.revisions, 0);
});

t('C4 null 不可寫成新紀錄（null 是「沒資料」，不是 0）', () => {
  const s = memWithSeries();
  const r = s.write({ seriesKey: 'cpiYoy', period: '2026-11', value: null });
  assert.strictEqual(r.action, 'skipped');
  assert.strictEqual(r.reason, 'null-value');
  assert.strictEqual(s.get('cpiYoy', '2026-11'), null, '不該長出一筆 null 紀錄');
  // 若這條失守，圖表會把 null 畫成 0，看起來像「CPI 歸零」
});

t('C5 非數值（NaN／字串）不可入庫', () => {
  const s = memWithSeries();
  assert.strictEqual(s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 'abc' }).action, 'skipped');
  assert.strictEqual(s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: NaN }).action, 'skipped');
  assert.strictEqual(s.get('cpiYoy', '2026-10'), null);
});

t('C6 來源時間較舊 → skip stale（遲到的舊回應不可蓋新資料）', () => {
  const s = memWithSeries();
  s.write({
    seriesKey: 'cpiYoy', period: '2026-10', value: 3.69,
    sourceUpdatedAt: '2026-11-20T00:00:00.000Z',
  });
  const r = s.write({
    seriesKey: 'cpiYoy', period: '2026-10', value: 3.72,
    sourceUpdatedAt: '2026-11-10T00:00:00.000Z', // 較舊
  });
  assert.strictEqual(r.action, 'skipped');
  assert.strictEqual(r.reason, 'stale-source');
  assert.strictEqual(s.get('cpiYoy', '2026-10').value, 3.69, '應保留較新的值');
});

t('C7 來源時間較新 → 正常更新', () => {
  const s = memWithSeries();
  s.write({
    seriesKey: 'cpiYoy', period: '2026-10', value: 3.69,
    sourceUpdatedAt: '2026-11-10T00:00:00.000Z',
  });
  const r = s.write({
    seriesKey: 'cpiYoy', period: '2026-10', value: 3.72,
    sourceUpdatedAt: '2026-11-20T00:00:00.000Z',
  });
  assert.strictEqual(r.action, 'updated');
  assert.strictEqual(s.get('cpiYoy', '2026-10').value, 3.72);
});

t('C8 只有一方有時間戳 → 以值為準（保守，不可因此漏更新）', () => {
  const s = memWithSeries();
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.69 });
  const r = s.write({
    seriesKey: 'cpiYoy', period: '2026-10', value: 3.72,
    sourceUpdatedAt: '2020-01-01T00:00:00.000Z',
  });
  // 既有沒有時間戳可比，不能判定為 stale，應更新
  assert.strictEqual(r.action, 'updated');
});

t('C9 同值不觸發更新；浮點尾差目前會視為「不同」（已知限制）', () => {
  const s = memWithSeries();
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
  const same = s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
  assert.strictEqual(same.action, 'unchanged');

  // 誠實記錄限制：目前用嚴格相等比較，3.72 與 3.7200000001 會被當成不同值。
  // 對「同一上游、同一格式」的資料不會發生；但若日後接入會自行計算的上游
  // （例如自己算 YoY），必須改成容差比較，否則會灌出一堆假修訂。
  const tiny = s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.7200000001 });
  assert.strictEqual(tiny.action, 'updated', '此為預期行為，不是 bug；改為容差時請同步改本測試');
});

/* ===============================================================
   D. 持久化
   =============================================================== */

console.log('\nD. 持久化與重啟');

t('D1 寫入後檔案存在，重啟後資料還在', () => {
  const { dir, cleanup } = tmpDir('persist');
  try {
    const s1 = store.openStore({ dir });
    s1.writeSeries({ seriesKey: 'cpiYoy', label: 'CPI', unit: '%', frequency: 'M' });
    s1.writeMany([
      { seriesKey: 'cpiYoy', period: '2026-08-01', value: 3.91 },
      { seriesKey: 'cpiYoy', period: '2026-09-01', value: 3.72 },
    ]);
    assert.ok(fs.existsSync(path.join(dir, 'state.json')), '應寫出 state.json');

    const s2 = store.openStore({ dir });
    assert.strictEqual(s2.loadResult.loaded, true);
    assert.strictEqual(s2.stats().counts.observations, 2);
    assert.strictEqual(s2.latest('cpiYoy').value, 3.72);
    assert.strictEqual(s2.getSeries('cpiYoy').label, 'CPI', '主檔也要還原');
  } finally { cleanup(); }
});

t('D2 重啟後再寫入，不會產生重複（冪等）', () => {
  const { dir, cleanup } = tmpDir('idem');
  try {
    const s1 = store.openStore({ dir });
    s1.writeSeries({ seriesKey: 'cpiYoy', label: 'CPI', unit: '%', frequency: 'M' });
    s1.write({ seriesKey: 'cpiYoy', period: '2026-10-01', value: 3.72 });

    const s2 = store.openStore({ dir });
    const r = s2.write({ seriesKey: 'cpiYoy', period: '2026-10-01', value: 3.72 });
    assert.strictEqual(r.action, 'unchanged');
    assert.strictEqual(s2.stats().counts.observations, 1);
  } finally { cleanup(); }
});

t('D3 autoSave=false 時不落地，手動 save 才寫檔', () => {
  const { dir, cleanup } = tmpDir('manual');
  try {
    const s = store.openStore({ dir, autoSave: false });
    s.writeSeries({ seriesKey: 'cpiYoy', label: 'CPI', unit: '%', frequency: 'M' });
    s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
    assert.ok(!fs.existsSync(path.join(dir, 'state.json')), '不該自動寫檔');
    s.save();
    assert.ok(fs.existsSync(path.join(dir, 'state.json')));
  } finally { cleanup(); }
});

t('D4 原子寫入：不留下 .tmp 殘檔', () => {
  const { dir, cleanup } = tmpDir('atomic');
  try {
    const s = store.openStore({ dir });
    s.writeSeries({ seriesKey: 'cpiYoy', label: 'CPI', unit: '%', frequency: 'M' });
    s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], `不應有 .tmp：${leftovers}`);
  } finally { cleanup(); }
});

t('D5 記憶體模式不寫任何檔案', () => {
  const s = mem();
  s.writeSeries({ seriesKey: 'x', label: 'X', unit: '', frequency: 'M' });
  s.write({ seriesKey: 'x', period: '2026-10', value: 1 });
  assert.strictEqual(s.memoryOnly, true);
  assert.strictEqual(s.filePath, null);
  assert.strictEqual(s.stats().counts.observations, 1);
});

/* ===============================================================
   E. 查詢
   =============================================================== */

console.log('\nE. 查詢');

function seeded() {
  const s = memWithSeries();
  s.writeMany([
    { seriesKey: 'cpiYoy', period: '2026-01-01', value: 3.1 },
    { seriesKey: 'cpiYoy', period: '2026-02-01', value: 3.2 },
    { seriesKey: 'cpiYoy', period: '2026-03-01', value: 3.3 },
    { seriesKey: 'cpiYoy', period: '2026-04-01', value: 3.4 },
  ]);
  return s;
}

t('E1 依 seriesKey 查全部，期間升冪', () => {
  const s = seeded();
  const rows = s.query({ seriesKey: 'cpiYoy' });
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.map((r) => r.period), ['2026-01', '2026-02', '2026-03', '2026-04']);
});

t('E2 期間排序是字典序正確的（補零的驗證）', () => {
  const s = memWithSeries();
  s.writeMany([
    { seriesKey: 'cpiYoy', period: '2026-09-01', value: 1 },
    { seriesKey: 'cpiYoy', period: '2026-10-01', value: 2 },
    { seriesKey: 'cpiYoy', period: '2026-11-01', value: 3 },
  ]);
  const periods = s.query({ seriesKey: 'cpiYoy' }).map((r) => r.period);
  assert.deepStrictEqual(periods, ['2026-09', '2026-10', '2026-11']);
});

t('E3 from / to 範圍查詢（含端點）', () => {
  const s = seeded();
  const rows = s.query({ seriesKey: 'cpiYoy', from: '2026-02', to: '2026-03' });
  assert.deepStrictEqual(rows.map((r) => r.period), ['2026-02', '2026-03']);
});

t('E4 order=desc + limit 取最新 N 筆', () => {
  const s = seeded();
  const rows = s.query({ seriesKey: 'cpiYoy', order: 'desc', limit: 2 });
  assert.deepStrictEqual(rows.map((r) => r.period), ['2026-04', '2026-03']);
});

t('E5 不給 seriesKey 則查全部（跨序列）', () => {
  const s = seeded();
  s.writeSeries({ seriesKey: 'unrate', label: '失業率', unit: '%', frequency: 'M' });
  s.write({ seriesKey: 'unrate', period: '2026-01-01', value: 4.1 });
  assert.strictEqual(s.query({}).length, 5);
  assert.strictEqual(s.query({ seriesKey: 'unrate' }).length, 1);
});

t('E6 latest 取最新一筆（依期間，不是依寫入順序）', () => {
  const s = memWithSeries();
  // 刻意先寫較新期，再寫較舊期
  s.write({ seriesKey: 'cpiYoy', period: '2026-04', value: 3.4 });
  s.write({ seriesKey: 'cpiYoy', period: '2026-01', value: 3.1 });
  assert.strictEqual(s.latest('cpiYoy').period, '2026-04');
});

t('E7 查無資料回 null，不拋錯', () => {
  const s = memWithSeries();
  assert.strictEqual(s.latest('cpiYoy'), null);
  assert.strictEqual(s.get('cpiYoy', '2026-01'), null);
  assert.deepStrictEqual(s.query({ seriesKey: 'cpiYoy' }), []);
});

t('E8 periods 回傳已存期間清單（判斷是否需重抓用）', () => {
  const s = seeded();
  assert.deepStrictEqual(s.periods('cpiYoy'), ['2026-01', '2026-02', '2026-03', '2026-04']);
});

t('E9 查詢回傳副本，外部修改不污染內部狀態', () => {
  const s = seeded();
  const rows = s.query({ seriesKey: 'cpiYoy' });
  rows[0].value = 999;
  assert.notStrictEqual(s.get('cpiYoy', '2026-01').value, 999);
});

/* ===============================================================
   F. 更新既有紀錄
   =============================================================== */

console.log('\nF. 更新既有紀錄');

t('F1 update 既有紀錄 → 改值並記修訂', () => {
  const s = seeded();
  const r = s.update('cpiYoy', '2026-03-01', { value: 3.35 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action, 'updated');
  assert.strictEqual(s.get('cpiYoy', '2026-03').value, 3.35);
});

t('F2 update 不存在的紀錄 → NOT_FOUND（不偷偷插入）', () => {
  const s = seeded();
  const r = s.update('cpiYoy', '2030-01-01', { value: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'NOT_FOUND');
  // 更新與寫入語義必須分開，否則打錯 key 會憑空長出資料
  assert.strictEqual(s.stats().counts.observations, 4);
});

t('F3 update 期間格式非法 → BAD_PERIOD', () => {
  const s = seeded();
  const r = s.update('cpiYoy', 'xxx', { value: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BAD_PERIOD');
});

t('F4 update 同值 → unchanged（不記假修訂）', () => {
  const s = seeded();
  const r = s.update('cpiYoy', '2026-03-01', { value: 3.3 });
  assert.strictEqual(r.action, 'unchanged');
  assert.strictEqual(s.stats().counts.revisions, 0);
});

t('F5 update 傳 null value → touched（只動中介資料，不清值）', () => {
  const s = seeded();
  const r = s.update('cpiYoy', '2026-03-01', { value: null, sourceUpdatedAt: '2026-11-01T00:00:00Z' });
  assert.strictEqual(r.action, 'touched');
  assert.strictEqual(s.get('cpiYoy', '2026-03').value, 3.3, '值不可被清掉');
});

/* ===============================================================
   G. 修訂軌跡
   =============================================================== */

console.log('\nG. 修訂軌跡');

t('G1 同一筆多次修訂 → 每次都有紀錄，順序保留', () => {
  const s = memWithSeries();
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 });
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.69 });
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.65 });
  const revs = s.revisionsOf('cpiYoy', '2026-10');
  assert.strictEqual(revs.length, 2);
  assert.deepStrictEqual(revs.map((r) => [r.prevValue, r.newValue]), [[3.72, 3.69], [3.69, 3.65]]);
  assert.strictEqual(s.get('cpiYoy', '2026-10').revisionCount, 2);
});

t('G2 revisionsOf 可只查某序列（不給期間）', () => {
  const s = memWithSeries();
  s.writeMany([{ seriesKey: 'cpiYoy', period: '2026-09', value: 3.7 }]);
  s.write({ seriesKey: 'cpiYoy', period: '2026-09', value: 3.8 });
  s.writeMany([{ seriesKey: 'cpiYoy', period: '2026-10', value: 3.6 }]);
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 3.5 });
  assert.strictEqual(s.revisionsOf('cpiYoy').length, 2);
  assert.strictEqual(s.revisionsOf('cpiYoy', '2026-09').length, 1);
});

t('G3 修訂紀錄有上限，超過時丟最舊並記帳', () => {
  const s = store.openStore({ dir: null, maxRevisions: 3 });
  s.writeSeries({ seriesKey: 'cpiYoy', label: 'CPI', unit: '%', frequency: 'M' });
  s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: 1 });
  for (let i = 2; i <= 7; i += 1) s.write({ seriesKey: 'cpiYoy', period: '2026-10', value: i });
  const st = s.stats();
  assert.strictEqual(st.counts.revisions, 3);
  assert.ok(st.droppedRevisions >= 3, `應有丟棄記帳，實際 ${st.droppedRevisions}`);
});

/* ===============================================================
   H. 容錯
   =============================================================== */

console.log('\nH. 容錯');

t('H1 檔案損壞 → 備份後以空庫啟動，不覆蓋原檔', () => {
  const { dir, cleanup } = tmpDir('corrupt');
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json');
    const s = store.openStore({ dir });
    assert.ok(s.stats().recovered, '應回報 recovered');
    assert.strictEqual(s.stats().counts.observations, 0);
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.strictEqual(backups.length, 1, '必須留下備份，不可直接刪掉使用者資料');
  } finally { cleanup(); }
});

t('H2 版本不符 → 明確報錯（不可默默誤讀）', () => {
  const { dir, cleanup } = tmpDir('version');
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      schemaVersion: 999, tables: { series: [], observations: [], revisions: [] },
    }));
    assert.throws(() => store.openStore({ dir }), /版本 999/);
  } finally { cleanup(); }
});

t('H3 批次中的壞列被跳過，好列照常寫入', () => {
  const s = memWithSeries();
  const r = s.writeMany([
    { seriesKey: 'cpiYoy', period: '2026-10', value: 3.72 },
    { period: '2026-10', value: 1 },              // 缺 seriesKey
    null,                                          // 非物件
    { seriesKey: 'cpiYoy', period: 'bad', value: 1 }, // 期間壞
    { seriesKey: 'cpiYoy', period: '2026-11', value: 3.6 },
  ]);
  assert.strictEqual(r.inserted, 2);
  assert.strictEqual(r.errors.length, 3);
  assert.strictEqual(s.stats().counts.observations, 2);
});

t('H4 主檔缺失時仍可寫觀測值，並自動補最小主檔（否則寫得進去卻查不出來）', () => {
  const s = mem();
  // 沒有先 writeSeries，直接用預設月頻
  const r = s.write({ seriesKey: 'ghost', period: '2026-10', value: 1 });
  assert.strictEqual(r.action, 'inserted');
  assert.strictEqual(s.get('ghost', '2026-10').frequency, 'M');

  // 實測踩過：只寫觀測值而不補主檔時，查詢端點會因為「沒有這個指標」回 404，
  // 使用者明明寫成功卻什麼都讀不到。所以寫入時必須自動補主檔。
  const meta = s.getSeries('ghost');
  assert.ok(meta, '應自動建立主檔');
  assert.strictEqual(meta.autoCreated, true, '應標記為自動建立，方便日後補真定義');
  assert.strictEqual(s.query({ seriesKey: 'ghost' }).length, 1, '寫入後必須查得到');

  // 補上真定義後，標記應消失、筆數不變
  s.writeSeries({ seriesKey: 'ghost', label: 'Ghost', unit: '', frequency: 'M', definition: '真定義' });
  assert.strictEqual(s.getSeries('ghost').label, 'Ghost');
  assert.strictEqual(s.getSeries('ghost').autoCreated, undefined, '補完定義後應清掉標記');
  assert.strictEqual(s.stats().counts.series, 1, '不可產生第二筆主檔');
  assert.strictEqual(s.stats().counts.observations, 1, '觀測值不可受影響');
});

t('H5 主檔重複寫入 → update 而非新增', () => {
  const s = memWithSeries();
  const r = s.writeSeries({ seriesKey: 'cpiYoy', label: 'CPI 年增率（新名稱）', unit: '%', frequency: 'M' });
  assert.strictEqual(r.action, 'updated');
  assert.strictEqual(s.stats().counts.series, 1);
  assert.strictEqual(s.getSeries('cpiYoy').label, 'CPI 年增率（新名稱）');
});

t('H6 主檔更新不會用空值清掉既有說明', () => {
  const s = mem();
  s.writeSeries({
    seriesKey: 'cpiYoy', label: 'CPI', unit: '%', frequency: 'M', definition: '重要定義',
  });
  s.writeSeries({ seriesKey: 'cpiYoy', label: 'CPI', unit: '%', frequency: 'M', definition: '' });
  assert.strictEqual(s.getSeries('cpiYoy').definition, '重要定義', '空字串不可覆蓋既有定義');
});

/* ===============================================================
   結果
   =============================================================== */

console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
if (fail) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f.name}: ${f.msg}`));
}
process.exit(fail === 0 ? 0 : 1);
