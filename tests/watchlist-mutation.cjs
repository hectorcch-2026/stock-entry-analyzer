'use strict';

/**
 * lib/watchlist.js 變異測試
 * =========================
 *
 * 為什麼需要這一支：「單元測試全綠」不代表測試有用。
 * 一個永遠會通過的斷言，跟沒有斷言是一樣的——它只給你假的信心。
 * 這裡的作法是把原始碼逐條改成**錯誤版本**，確認測試會變紅；
 * 若某個變異仍然全綠，表示對應的測試根本沒在驗那件事。
 *
 * 每個變異都對應一個真實會發生的錯誤，不是憑空捏造：
 *   1. 代碼不正規化      → 大小寫不同就變兩筆（使用者會看到重複）
 *   2. 不冪等            → 連點兩下就多一筆
 *   3. 損壞檔默默清空    → 使用者的清單被吃掉，且沒有備份
 *   4. 非原子寫入        → 進程被重啟後留下半個 JSON
 *   5. 參數名不打錯也放行 → 測試跑到正式資料上
 *   6. 壞列不跳過        → 一筆壞資料讓整份清單讀不進來
 *   7. fromPick 不存     → 「這檔是從哪筆推介加進來的」永遠是空的
 *   8. 移除不判斷存在    → 移不掉也不講，按鈕看起來沒反應
 *   9. 排序不穩定        → 每次重載順序都變，使用者找不到東西
 *  10. symbolSet 不更新  → 推介頁的「已加入」永遠是錯的
 *
 * 用法：node tests/watchlist-mutation.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'lib', 'watchlist.js');
const TEST = path.join(__dirname, 'watchlist-unit.cjs');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

/** 跑一次單元測試，回傳 { code, out } */
function runUnit(tmpDir) {
  const env = { ...process.env };
  try {
    const out = execFileSync(process.execPath, [TEST], {
      cwd: path.join(__dirname, '..'),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const original = fs.readFileSync(SRC, 'utf8');

/** 套用一個變異，跑測試，還原。回傳測試輸出 */
function mutate(label, from, to) {
  const idx = original.indexOf(from);
  if (idx === -1) {
    ok(`${label}｜變異可套用`, false, '找不到目標字串');
    return null;
  }
  const mutated = original.slice(0, idx) + to + original.slice(idx + from.length);
  assert.notStrictEqual(mutated, original, '變異必須真的改變內容');
  fs.writeFileSync(SRC, mutated, 'utf8');
  try {
    const r = runUnit();
    return r;
  } finally {
    fs.writeFileSync(SRC, original, 'utf8');
  }
}

console.log('\n觀察清單變異測試：把正確程式改成錯誤版本，確認測試會變紅\n');

/* ---- 先確認基準是綠的，否則後面的「變紅」沒有意義 ---- */
const baseline = runUnit();
ok('基準：原始程式測試全綠', baseline.code === 0,
  baseline.code === 0 ? '' : '基準就不是綠的，後續變異結果不可信');

/* ---- 1. 代碼不正規化 ---- */
{
  const r = mutate('代碼不正規化',
    '  return String(sym == null ? \'\' : sym).trim().toUpperCase();',
    '  return String(sym == null ? \'\' : sym);');
  if (r) ok('1 代碼不正規化 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗正規化');
}

/* ---- 2. 加入不冪等 ---- */
{
  const r = mutate('加入不冪等',
    '    if (existing) return { added: false, reason: \'已在觀察清單\', item: existing };',
    '    if (false) return { added: false, reason: \'已在觀察清單\', item: existing };');
  if (r) ok('2 加入不冪等 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗冪等');
}

/* ---- 3. 損壞檔默默清空（不備份） ---- */
{
  const r = mutate('損壞檔不備份',
    '      const bak = `${filePath}.corrupt-${Date.now()}`;\n      try { fs.renameSync(filePath, bak); } catch { /* 備份失敗不阻擋啟動 */ }\n      recovered = { reason: e.message, backup: bak };\n      return { loaded: false, corrupt: true };',
    '      try { fs.unlinkSync(filePath); } catch { /* 直接刪掉 */ }\n      return { loaded: false, corrupt: true };');
  if (r) ok('3 損壞檔直接刪除 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗備份');
}

/* ---- 4. 非原子寫入（直接寫目標檔） ---- */
{
  const r = mutate('非原子寫入',
    '      const tmp = `${filePath}.tmp`;\n      fs.writeFileSync(tmp, JSON.stringify(state, null, 1), \'utf8\');',
    '      const tmp = `${filePath}.tmp`;\n      fs.writeFileSync(filePath, JSON.stringify(state, null, 1), \'utf8\');');
  if (r) ok('4 不寫 tmp → 測試該變紅（會留下 .tmp 或壞檔）', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗原子性');
}

/* ---- 5. 參數名打錯也放行 ---- */
{
  const r = mutate('不打錯也放行',
    '    if (Object.prototype.hasOwnProperty.call(opts, k)) {',
    '    if (false) {');
  if (r) ok('5 移除參數名守衛 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗守衛');
}

/* ---- 6. 壞列不跳過 ---- */
{
  const r = mutate('壞列不跳過',
    '      .filter((x) => x && isValidSymbol(normSymbol(x.symbol)))',
    '      .filter(() => true)');
  if (r) ok('6 壞列不跳過 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗壞列');
}

/* ---- 7. fromPick 不存 ---- */
{
  const r = mutate('fromPick 不存',
    '      fromPick: o.fromPick ? String(o.fromPick).slice(0, 80) : null,',
    '      fromPick: null,');
  if (r) ok('7 丟棄 fromPick → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗來源');
}

/* ---- 8. 移除不判斷存在 ---- */
{
  const r = mutate('移除不判斷存在',
    '    if (idx === -1) return { removed: false, reason: \'不在觀察清單\' };',
    '    if (idx === -1) return { removed: true };');
  if (r) ok('8 移除不存在的也回成功 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗移除');
}

/* ---- 9. 排序不穩定 ---- */
{
  const r = mutate('排序不穩定',
    '      return a.symbol.localeCompare(b.symbol);',
    '      return 0;');
  if (r) ok('9 同時間加入不依代碼排序 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗穩定排序');
}

/* ---- 10. symbolSet 不更新 ---- */
{
  const r = mutate('symbolSet 失效',
    '    return new Set(state.items.map((x) => x.symbol));',
    '    return new Set();');
  if (r) ok('10 symbolSet 永遠空 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠，測試沒在驗 symbolSet');
}

/* ---- 還原後必須回到全綠（確認還原成功，不是留下壞檔） ---- */
const after = runUnit();
ok('結束後原始碼已還原且測試全綠', after.code === 0, after.code === 0 ? '' : '還原失敗');

console.log(`\n========== 變異測試：${pass} 通過 / ${fail} 失敗 ==========`);
if (fail) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
