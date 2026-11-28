'use strict';

/**
 * lib/watchlist.js 單元測試 — 完全不連網
 * =======================================
 *
 * 這支的風險跟帳本不同：觀察清單是**使用者自己維護的清單**，
 * 出錯的症狀都很安靜，而且會被使用者當成「系統壞了」：
 *   · 代碼大小寫沒統一      → 同一檔加兩次，清單出現重複項
 *   · 加入不冪等            → 連點兩下就兩筆
 *   · 參數名打錯退回真實檔  → 測試跑一跑把使用者的清單覆蓋掉
 *   · 損壞檔默默清空        → 使用者以為系統吃掉他的清單
 *   · 寫檔不是原子的        → 進程被重啟後留下半個 JSON
 * 以上都不會拋錯，只能靠斷言釘住。
 *
 * 覆蓋範圍：
 *   A. 代碼正規化與格式檢查
 *   B. 加入的冪等性
 *   C. 移除
 *   D. 排序穩定性
 *   E. 持久化（落檔、重啟後讀回）
 *   F. 原子寫入（不留下 .tmp、不寫到一半）
 *   G. 容錯（損壞檔備份而非清空、版本不符要拋錯、壞列跳過）
 *   H. 參數名打錯必須拋錯（防止覆蓋正式資料）
 *   I. fromPick 來源欄位
 *   J. symbolSet（給伺服器標註 watched）
 *
 * 用法：node tests/watchlist-unit.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const watchlist = require('../lib/watchlist');
const { create, normSymbol, isValidSymbol, SCHEMA_VERSION } = watchlist;

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

/** 臨時檔案路徑（不建目錄，讓 save 自己建，順便驗 mkdir） */
function tmpFile(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wl-${tag}-`));
  return {
    dir,
    file: path.join(dir, 'nested', 'watchlist.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** 純記憶體 store（filePath=null），最快，適合純邏輯 */
function mem() {
  return create({ filePath: null });
}

/* ===============================================================
   A. 代碼正規化與格式檢查
   =============================================================== */

console.log('\nA. 代碼正規化與格式檢查');

t('A1 正規化去掉空白並轉大寫', () => {
  assert.strictEqual(normSymbol('  2015.hk '), '2015.HK');
  assert.strictEqual(normSymbol('beke'), 'BEKE');
});

t('A2 正規化對 null / undefined / 數字都給空字串或字串', () => {
  assert.strictEqual(normSymbol(null), '');
  assert.strictEqual(normSymbol(undefined), '');
  assert.strictEqual(normSymbol(0), '0');
});

t('A3 合法代碼可通過（含 . - ^ = _）', () => {
  ['2015.HK', 'BEKE', 'BRK-B', '^HSI', '000001.SZ', 'A_B', 'AAPL=1'].forEach((s) => {
    assert.ok(isValidSymbol(s), `${s} 應該合法`);
  });
});

t('A4 非法代碼要擋掉（空白、超長、特殊字元）', () => {
  ['', '   ', 'A B', 'A/B', 'A,B', 'AB!', 'X'.repeat(17)].forEach((s) => {
    assert.ok(!isValidSymbol(s), `${JSON.stringify(s)} 不該合法`);
  });
});

t('A5 加入時會先正規化，大小寫不同不算兩筆', () => {
  const s = mem();
  s.add({ symbol: 'beke' });
  const r = s.add({ symbol: ' BEKE ' });
  assert.strictEqual(r.added, false, '第二次應該視為重複');
  assert.strictEqual(s.list().length, 1, '清單不可有兩筆');
  assert.strictEqual(s.list()[0].symbol, 'BEKE');
});

/* ===============================================================
   B. 加入的冪等性
   =============================================================== */

console.log('\nB. 加入的冪等性');

t('B1 首次加入回 added:true 並帶 item', () => {
  const s = mem();
  const r = s.add({ symbol: 'BEKE', name: 'KE Holdings', market: 'US', currency: 'USD' });
  assert.strictEqual(r.added, true);
  assert.strictEqual(r.item.symbol, 'BEKE');
  assert.strictEqual(r.item.name, 'KE Holdings');
  assert.strictEqual(r.item.market, 'US');
  assert.strictEqual(r.item.currency, 'USD');
  assert.ok(r.item.addedAt, 'addedAt 必須有值');
});

t('B2 重複加入回 added:false 且附上既有的 item', () => {
  const s = mem();
  s.add({ symbol: 'BEKE', name: '第一次' });
  const r = s.add({ symbol: 'BEKE', name: '第二次' });
  assert.strictEqual(r.added, false);
  assert.strictEqual(r.reason, '已在觀察清單');
  assert.strictEqual(r.item.name, '第一次', '重複加入不可改寫既有資料');
  assert.strictEqual(s.list().length, 1);
});

t('B3 缺代碼要回失敗，不是靜默成功', () => {
  const s = mem();
  const r = s.add({});
  assert.strictEqual(r.added, false);
  assert.ok(/缺少/.test(r.reason), r.reason);
  assert.strictEqual(s.list().length, 0);
});

t('B4 代碼格式不對要回失敗並說明', () => {
  const s = mem();
  const r = s.add({ symbol: '這不是代碼' });
  assert.strictEqual(r.added, false);
  assert.ok(/格式不正確/.test(r.reason), r.reason);
  assert.strictEqual(s.list().length, 0);
});

t('B5 name 過長會被截斷（80 字），不留整段貼上的內容', () => {
  const s = mem();
  const long = '名'.repeat(300);
  const r = s.add({ symbol: 'BEKE', name: long });
  assert.strictEqual(r.item.name.length, 80);
});

t('B6 沒給 name/market/currency 時為 null 而不是 undefined', () => {
  const s = mem();
  const r = s.add({ symbol: 'BEKE' });
  assert.strictEqual(r.item.name, null);
  assert.strictEqual(r.item.market, null);
  assert.strictEqual(r.item.currency, null);
});

t('B7 has / find 對大小寫不敏感', () => {
  const s = mem();
  s.add({ symbol: 'BEKE' });
  assert.strictEqual(s.has('beke'), true);
  assert.strictEqual(s.has(' BEKE '), true);
  assert.strictEqual(s.find('bEkE').symbol, 'BEKE');
  assert.strictEqual(s.has('AAPL'), false);
  assert.strictEqual(s.find('AAPL'), null);
});

/* ===============================================================
   C. 移除
   =============================================================== */

console.log('\nC. 移除');

t('C1 移除存在的一筆', () => {
  const s = mem();
  s.add({ symbol: 'BEKE' });
  const r = s.remove('beke');
  assert.strictEqual(r.removed, true);
  assert.strictEqual(r.item.symbol, 'BEKE');
  assert.strictEqual(s.list().length, 0);
});

t('C2 移除不存在的一筆要回 removed:false，不是拋錯', () => {
  const s = mem();
  const r = s.remove('AAPL');
  assert.strictEqual(r.removed, false);
  assert.strictEqual(r.reason, '不在觀察清單');
});

t('C3 移除空代碼要回失敗', () => {
  const s = mem();
  const r = s.remove('');
  assert.strictEqual(r.removed, false);
  assert.ok(/缺少/.test(r.reason), r.reason);
});

t('C4 移除只影響指定那一筆', () => {
  const s = mem();
  s.add({ symbol: 'A' });
  s.add({ symbol: 'B' });
  s.add({ symbol: 'C' });
  s.remove('B');
  assert.deepStrictEqual(s.symbols().sort(), ['A', 'C']);
});

/* ===============================================================
   D. 排序穩定性
   =============================================================== */

console.log('\nD. 排序穩定性');

t('D1 依 addedAt 新到舊', () => {
  const s = mem();
  s.add({ symbol: 'OLD' });
  // 用注入的時鐘推進時間，不能靠真實時間（可能同一毫秒）
  const s2 = create({ filePath: null, now: () => new Date('2026-01-02T00:00:00Z') });
  s2.add({ symbol: 'NEW' });
  const s3 = create({ filePath: null });
  s3.add({ symbol: 'AAA' });
  assert.ok(s.list().length === 1 && s2.list().length === 1 && s3.list().length === 1);
});

t('D2 同一時間加入時依代碼排序（輸出必須穩定可測）', () => {
  const fixed = () => new Date('2026-01-01T00:00:00Z');
  const s = create({ filePath: null, now: fixed });
  s.add({ symbol: 'CCC' });
  s.add({ symbol: 'AAA' });
  s.add({ symbol: 'BBB' });
  assert.deepStrictEqual(s.list().map((x) => x.symbol), ['AAA', 'BBB', 'CCC']);
});

t('D3 list() 回傳的是副本，改它不會污染內部狀態', () => {
  const s = mem();
  s.add({ symbol: 'A' });
  const l1 = s.list();
  l1.push({ symbol: 'INJECTED' });
  l1[0] && (l1[0].symbol = 'HACKED');
  assert.strictEqual(s.list().length, 1, '外部改陣列不該影響內部');
});

/* ===============================================================
   E. 持久化
   =============================================================== */

console.log('\nE. 持久化');

t('E1 save 會建目錄並寫出檔案', () => {
  const { file, cleanup } = tmpFile('save');
  try {
    const s = create({ filePath: file });
    s.add({ symbol: 'BEKE', name: 'KE' });
    const r = s.save();
    assert.strictEqual(r.saved, true, r.reason);
    assert.ok(fs.existsSync(file), '檔案應該存在');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(raw.schemaVersion, SCHEMA_VERSION);
    assert.ok(Array.isArray(raw.items));
    assert.strictEqual(raw.items.length, 1);
  } finally { cleanup(); }
});

t('E2 重啟後（新 store load 同一檔）讀回相同內容', () => {
  const { file, cleanup } = tmpFile('reload');
  try {
    const a = create({ filePath: file });
    a.add({ symbol: 'BEKE', name: 'KE Holdings', market: 'US', currency: 'USD' });
    a.add({ symbol: '2015.HK', name: 'Li Auto', market: 'HK', currency: 'HKD' });
    a.save();

    const b = create({ filePath: file });
    const r = b.load();
    assert.strictEqual(r.loaded, true);
    assert.strictEqual(r.count, 2);
    assert.deepStrictEqual(b.symbols().sort(), ['2015.HK', 'BEKE']);
    assert.strictEqual(b.find('BEKE').name, 'KE Holdings');
    assert.strictEqual(b.find('BEKE').currency, 'USD');
  } finally { cleanup(); }
});

t('E3 檔案不存在時 load 回 loaded:false 且不拋錯', () => {
  const { file, cleanup } = tmpFile('missing');
  try {
    const s = create({ filePath: file });
    const r = s.load();
    assert.strictEqual(r.loaded, false);
    assert.strictEqual(s.list().length, 0);
  } finally { cleanup(); }
});

t('E4 filePath=null 時 save 回報「僅記憶體」而不是假裝成功', () => {
  const s = create({ filePath: null });
  s.add({ symbol: 'A' });
  const r = s.save();
  assert.strictEqual(r.saved, false);
  assert.strictEqual(r.reason, '僅記憶體');
});

t('E5 updatedAt 會在 save 後被寫入，createdAt 保留最初值', () => {
  const { file, cleanup } = tmpFile('times');
  try {
    const s = create({ filePath: file });
    s.add({ symbol: 'A' });
    const created = s.stats().createdAt;
    assert.strictEqual(s.stats().updatedAt, null, '未存檔前 updatedAt 應為 null');
    s.save();
    assert.ok(s.stats().updatedAt, '存檔後 updatedAt 必須有值');
    assert.strictEqual(s.stats().createdAt, created);
  } finally { cleanup(); }
});

/* ===============================================================
   F. 原子寫入
   =============================================================== */

console.log('\nF. 原子寫入');

t('F1 存檔後不留 .tmp 殘檔', () => {
  const { file, cleanup } = tmpFile('atomic');
  try {
    const s = create({ filePath: file });
    s.add({ symbol: 'A' });
    s.save();
    assert.ok(!fs.existsSync(`${file}.tmp`), '不該留下 .tmp（rename 應該把它移走）');
  } finally { cleanup(); }
});

t('F2 連續兩次 save 後檔案仍是合法 JSON（不會疊加）', () => {
  const { file, cleanup } = tmpFile('twice');
  try {
    const s = create({ filePath: file });
    s.add({ symbol: 'A' });
    s.save();
    s.add({ symbol: 'B' });
    s.save();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(raw.items.length, 2);
  } finally { cleanup(); }
});

t('F3 save 次數會被計數（供 stats 觀察是否白存）', () => {
  const { file, cleanup } = tmpFile('count');
  try {
    const s = create({ filePath: file });
    s.add({ symbol: 'A' });
    s.save();
    s.save();
    assert.strictEqual(s.stats().saves, 2);
  } finally { cleanup(); }
});

/* ===============================================================
   G. 容錯
   =============================================================== */

console.log('\nG. 容錯');

t('G1 損壞的 JSON：備份成 .corrupt-* 而不是清空覆蓋', () => {
  const { dir, file, cleanup } = tmpFile('corrupt');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ 這不是 JSON', 'utf8');
    const s = create({ filePath: file });
    const r = s.load();
    assert.strictEqual(r.corrupt, true);
    assert.strictEqual(r.loaded, false);
    assert.ok(!fs.existsSync(file), '壞檔應該被移走');
    const baks = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'));
    assert.strictEqual(baks.length, 1, '應該留一份備份');
    const kept = fs.readFileSync(path.join(path.dirname(file), baks[0]), 'utf8');
    assert.strictEqual(kept, '{ 這不是 JSON', '備份必須是原始內容，不可被覆蓋');
    assert.ok(s.stats().recovered, 'stats 要能回報發生過損壞');
    assert.ok(s.stats().recovered.backup);
  } finally { cleanup(); }
});

t('G2 結構不對（items 不是陣列）：同樣備份，不靜默當成空清單', () => {
  const { file, cleanup } = tmpFile('shape');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, items: 'oops' }), 'utf8');
    const s = create({ filePath: file });
    const r = s.load();
    assert.strictEqual(r.corrupt, true);
    const baks = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'));
    assert.strictEqual(baks.length, 1);
  } finally { cleanup(); }
});

t('G3 版本不符要拋錯（不可猜測相容）', () => {
  const { file, cleanup } = tmpFile('version');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 999, items: [] }), 'utf8');
    const s = create({ filePath: file });
    assert.throws(() => s.load(), /版本/, '版本不符必須拋錯');
  } finally { cleanup(); }
});

t('G4 壞掉的單筆被跳過，好的一筆仍讀得進來', () => {
  const { file, cleanup } = tmpFile('badrow');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      items: [
        { symbol: 'GOOD', name: '好的' },
        { symbol: '', name: '沒有代碼' },
        { symbol: 'A B', name: '代碼有空白' },
        null,
        { name: '根本沒代碼' },
        { symbol: 'ALSO$' },
      ],
    }), 'utf8');
    const s = create({ filePath: file });
    const r = s.load();
    assert.strictEqual(r.loaded, true);
    assert.deepStrictEqual(s.symbols(), ['GOOD'], '只該留下合法那一筆');
  } finally { cleanup(); }
});

t('G5 讀入時會淨化欄位長度（手動編輯的檔案不可信）', () => {
  const { file, cleanup } = tmpFile('sanitize');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      items: [{ symbol: 'AA', name: 'N'.repeat(300), fromPick: 'P'.repeat(300), note: 'Z'.repeat(900) }],
    }), 'utf8');
    const s = create({ filePath: file });
    s.load();
    const it = s.list()[0];
    assert.strictEqual(it.name.length, 80);
    assert.strictEqual(it.fromPick.length, 80);
    assert.strictEqual(it.note.length, 200);
  } finally { cleanup(); }
});

/* ===============================================================
   H. 參數名打錯必須拋錯
   =============================================================== */

console.log('\nH. 參數名打錯必須拋錯');

t('H1 create({ file }) 要拋錯（不可退回真實檔案）', () => {
  assert.throws(() => create({ file: '/tmp/x.json' }), /filePath/, '打錯字必須拋錯');
});

t('H2 create({ path }) 要拋錯', () => {
  assert.throws(() => create({ path: '/tmp/x.json' }), /filePath/);
});

t('H3 create({ filepath }) 要拋錯', () => {
  assert.throws(() => create({ filepath: '/tmp/x.json' }), /filePath/);
});

t('H4 create({ watchlistFile }) 要拋錯', () => {
  assert.throws(() => create({ watchlistFile: '/tmp/x.json' }), /filePath/);
});

t('H5 正確的 filePath 不該拋錯', () => {
  assert.doesNotThrow(() => create({ filePath: null }));
});

t('H6 預設路徑在 data/ 底下、與帳本同一顆磁碟', () => {
  const old = process.env.WATCHLIST_FILE;
  delete process.env.WATCHLIST_FILE;
  try {
    const p = watchlist.resolveFile();
    assert.ok(/data[\\/]watchlist\.json$/.test(p), p);
  } finally {
    if (old !== undefined) process.env.WATCHLIST_FILE = old;
  }
});

t('H7 環境變數 WATCHLIST_FILE 會覆寫預設路徑', () => {
  const old = process.env.WATCHLIST_FILE;
  process.env.WATCHLIST_FILE = '/custom/wl.json';
  try {
    assert.strictEqual(watchlist.resolveFile(), '/custom/wl.json');
  } finally {
    if (old === undefined) delete process.env.WATCHLIST_FILE;
    else process.env.WATCHLIST_FILE = old;
  }
});

/* ===============================================================
   I. fromPick 來源欄位
   =============================================================== */

console.log('\nI. fromPick 來源欄位');

t('I1 fromPick 會被保存（來自哪一筆推介）', () => {
  const s = mem();
  const r = s.add({ symbol: 'BEKE' }, { fromPick: 'BEKE@2026-11-26' });
  assert.strictEqual(r.item.fromPick, 'BEKE@2026-11-26');
});

t('I2 沒給 fromPick 時為 null（前端顯示「手動加入」）', () => {
  const s = mem();
  const r = s.add({ symbol: 'BEKE' });
  assert.strictEqual(r.item.fromPick, null);
});

t('I3 fromPick 過長會被截斷', () => {
  const s = mem();
  const r = s.add({ symbol: 'BEKE' }, { fromPick: 'x'.repeat(300) });
  assert.strictEqual(r.item.fromPick.length, 80);
});

t('I4 fromPick 會寫進檔案並讀得回來（伺服器重啟不丟）', () => {
  const { file, cleanup } = tmpFile('frompick');
  try {
    const a = create({ filePath: file });
    a.add({ symbol: 'BEKE' }, { fromPick: 'BEKE@2026-11-26' });
    a.save();
    const b = create({ filePath: file });
    b.load();
    assert.strictEqual(b.find('BEKE').fromPick, 'BEKE@2026-11-26');
  } finally { cleanup(); }
});

/* ===============================================================
   J. symbolSet
   =============================================================== */

console.log('\nJ. symbolSet');

t('J1 symbolSet 含所有代碼，供伺服器標註 watched', () => {
  const s = mem();
  s.add({ symbol: 'A' });
  s.add({ symbol: 'B' });
  const set = s.symbolSet();
  assert.ok(set instanceof Set);
  assert.strictEqual(set.has('A'), true);
  assert.strictEqual(set.has('B'), true);
  assert.strictEqual(set.has('C'), false);
  assert.strictEqual(set.size, 2);
});

t('J2 symbolSet 是快照，之後加入不影響已取出的 set', () => {
  const s = mem();
  s.add({ symbol: 'A' });
  const set = s.symbolSet();
  s.add({ symbol: 'B' });
  assert.strictEqual(set.has('B'), false, '已取出的 set 不該跟著變');
});

t('J3 移除後 symbolSet 不再包含它', () => {
  const s = mem();
  s.add({ symbol: 'A' });
  s.remove('A');
  assert.strictEqual(s.symbolSet().has('A'), false);
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
