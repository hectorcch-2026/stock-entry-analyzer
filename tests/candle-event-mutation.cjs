'use strict';

/**
 * 圖上事件標記的變異測試
 * =====================
 *
 * 這支要回答的問題是：「candle-event-markers.cjs 那 27 條斷言，
 * 到底能不能抓到錯？」若某個變異仍然全綠，表示對應的斷言沒在驗那件事。
 *
 * 每個變異對應一個真實會犯的錯：
 *   1. 日期對到「之後」最近的一根   → 標記提前出現，看起來像早知道
 *   2. 週末事件直接丟棄            → 標記消失，使用者以為功能沒做
 *   3. 早於第一根仍畫在邊界        → 標記出現在圖左端，位置是假的
 *   4. 同型別同日不去重            → 同一個標籤疊兩次，顏色變深看起來像另一種
 *   5. 垂直線畫成實線              → 與網格線混淆，看不出是事件
 *   6. 垂直線位置少算半格          → 標記落在兩根 K 線中間
 *   7. 標籤畫回圖內                → 與價格參考線標籤互相遮蓋
 *   8. 事件顏色等於漲色            → 被誤讀成 K 線
 *   9. 價位 0 被當成有效            → 標記貼在圖底
 *  10. 佈局常數被改動              → 34 條既有幾何斷言失效
 *
 * 用法：node tests/candle-event-mutation.cjs
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'lib', 'candle-chart.js');
const TEST = path.join(__dirname, 'candle-event-markers.cjs');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

function run() {
  try {
    const out = execFileSync(process.execPath, [TEST], { cwd: ROOT, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const original = fs.readFileSync(SRC, 'utf8');

function mutate(label, from, to) {
  const idx = original.indexOf(from);
  if (idx === -1) {
    ok(`${label}｜變異可套用`, false, '找不到目標字串');
    return null;
  }
  const mutated = original.slice(0, idx) + to + original.slice(idx + from.length);
  if (mutated === original) {
    ok(`${label}｜變異可套用`, false, '變異沒有改變內容');
    return null;
  }
  fs.writeFileSync(SRC, mutated, 'utf8');
  try { return run(); } finally { fs.writeFileSync(SRC, original, 'utf8'); }
}

console.log('\n事件標記變異測試：把正確程式改成錯誤版本，確認測試會變紅\n');

const base = run();
ok('基準：原始程式測試全綠', base.code === 0,
  base.code === 0 ? '' : '基準不是綠的，後續結果不可信');

/* 1. 週末對到「之後」最近的一根 */
{
  const r = mutate('對到之後那一根',
    '    let best = -1;\n    for (const d of days) {\n      if (d <= key) best = indexByDay.get(d);\n      else break;\n    }\n    return best;',
    '    let best = -1;\n    for (let i = days.length - 1; i >= 0; i -= 1) {\n      if (days[i] >= key) best = indexByDay.get(days[i]);\n    }\n    return best;');
  if (r) ok('1 日期對到之後最近的一根 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠');
}

/* 2. 週末／缺日直接丟棄 */
{
  const r = mutate('缺日直接丟棄',
    '    let best = -1;\n    for (const d of days) {\n      if (d <= key) best = indexByDay.get(d);\n      else break;\n    }\n    return best;',
    '    return -1;');
  if (r) ok('2 沒有對應 K 線就丟棄 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠');
}

/* 3. 早於第一根仍畫在邊界（clamp 到 0） */
{
  const r = mutate('早於第一根夾到 0',
    '    if (idx < 0) continue;                         // ① 區間外（含早於第一根）',
    '    if (idx < 0) continue;\n    // mutated placeholder');
  if (r) {
    // 這個變異本身不改變行為，改成真正會壞的：把 idx<0 改成夾到 0
    const r2 = mutate('早於第一根夾到 0',
      '    const idx = indexFor(ev.date);\n    if (idx < 0) continue;',
      '    let idx = indexFor(ev.date);\n    if (idx < 0) idx = 0;');
    if (r2) ok('3 區間外事件被夾到第一根 → 測試該變紅', r2.code !== 0, r2.code !== 0 ? '已變紅' : '仍全綠');
  }
}

/* 4. 同型別同日不去重 */
{
  const r = mutate('同型別同日不去重',
    '    if (seen.has(key)) continue;                   // ③ 同種類同日只留一個',
    '    if (false) continue;');
  if (r) ok('4 同型別同日重複保留 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠');
}

/* 5. 垂直線畫成實線：把 dash 加大到超過繪圖區高度 → 一筆到底 */
{
  // dashedV 在 lib/png.js，這裡改呼叫端的 dash 參數（4 → 10000）
  const r = mutate('垂直線變實線',
    'canvas.dashedV(cx, plotY, plotY + plotH - 1, ev.color, 4, 3, 1);',
    'canvas.dashedV(cx, plotY, plotY + plotH - 1, ev.color, 10000, 3, 1);');
  if (r) ok('5 垂直線不分段（變實線）→ 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠');
}

/* 6. 位置少算半格 */
{
  const r = mutate('位置少算半格',
    'Math.round(plotX + slot * (ev.index + 0.5))',
    'Math.round(plotX + slot * ev.index)');
  if (r) ok('6 垂直線少算半格 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠');
}

/* 7. 標籤畫回圖內 */
{
  const r = mutate('標籤畫回圖內',
    '  const labelY = Math.max(17, PAD_T - 10);',
    '  const labelY = PAD_T + 40;');
  if (r) ok('7 標籤下移到圖內 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠');
}

/* 8. 事件顏色等於漲色 */
{
  const r = mutate('事件色等於漲色',
    "  pick: { tag: 'P', color: { r: 24, g: 102, b: 204 } },",
    '  pick: { tag: \'P\', color: COLOR.up },');
  if (r) ok('8 推介色改成漲色 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠');
}

/* 9. 價位 0 被當成有效 */
{
  const r = mutate('價位 0 視為有效',
    '      price: isFinite(px) && px > 0 ? px : null,',
    '      price: isFinite(px) ? px : null,');
  if (r) ok('9 價位 0 被接受 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠');
}

/* 10. 佈局常數被改動 */
{
  const r = mutate('佈局高度改動',
    '  const H = opts.height || 420;',
    '  const H = opts.height || 460;');
  if (r) ok('10 圖高被改 → 測試該變紅', r.code !== 0, r.code !== 0 ? '已變紅' : '仍全綠');
}

const after = run();
ok('結束後原始碼已還原且測試全綠', after.code === 0, after.code === 0 ? '' : '還原失敗');

console.log(`\n========== 變異測試：${pass} 通過 / ${fail} 失敗 ==========`);
if (fail) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
