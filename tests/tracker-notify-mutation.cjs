'use strict';

/**
 * 變異測試 — 證明 tracker-notify 的單元測試「真的會失敗」
 * =====================================================
 *
 * 為什麼要做這件事：
 *   發送鎖、分批、轉義這三件事的錯誤都**不會拋錯**，
 *   程式跑得完、測試若寫成空斷言也照樣全綠。
 *   於是「測試通過」反而給人虛假的安全感。
 *
 *   做法：把原始碼逐一植入「典型錯誤」，重新跑測試，**必須**失敗。
 *   若某個變異沒被測出來，代表對應的斷言是空的。
 *
 * 每個變異都對應一個真實會犯的錯，不是隨便改個字元。
 *
 * 執行：node tests/tracker-notify-mutation.cjs
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'lib', 'tracker-notify.js');
const TEST = path.join(ROOT, 'tests', 'tracker-notify-unit.cjs');
const BACKUP = path.join(ROOT, '.tmpv', 'tracker-notify.orig.js');

/**
 * 變異清單：{ name, find, replace, why }
 * 前提：find 在原始碼中必須恰好出現一次。
 */
const MUTATIONS = [
  {
    name: '發送鎖失效：不檢查是否已推過',
    find: '    if (!force && alreadySent(dateKey)) {',
    replace: '    if (false && !force && alreadySent(dateKey)) {',
    why: 'dailyRun 每 30 分鐘跑一次，一天會推幾十則，使用者第一件事就是封鎖 bot',
  },
  {
    name: '鎖用 UTC 日期（香港凌晨會重複推）',
    find: '    const dateKey = dateKeyArg || hkDateKey(nowFn());',
    replace: '    const dateKey = dateKeyArg || new Date(nowFn()).toISOString().slice(0, 10);',
    why: '香港 00:00–08:00 之間 UTC 還在前一天，「今天」算成昨天，早上的推送會重複',
  },
  {
    name: '失敗也標記已推',
    find: '    if (allOk) {\n      const st = state();',
    replace: '    if (true) {\n      const st = state();',
    why: 'Telegram 掛掉後那天就永遠不會再推，且系統顯示「已推送」，完全看不出漏推',
  },
  {
    name: '不檢查長度上限（單則超過 4096）',
    find: '    if (len + need > MAX_LEN && body.length > 0) flush();',
    replace: '    if (false && len + need > MAX_LEN && body.length > 0) flush();',
    why: 'Telegram 超過 4096 是整則 400 失敗（不是截斷），使用者什麼都收不到',
  },
  {
    name: '轉義失效：公司名直接輸出',
    find: '  lines.push(`${emoji} <b>${esc(r.name || r.symbol)}</b>（${esc(r.symbol)}）`);',
    replace: '  lines.push(`${emoji} <b>${r.name || r.symbol}</b>（${r.symbol}）`);',
    why: 'AT&T、SK Hynix <holdings> 會讓整則訊息 400 can\'t parse entities',
  },
  {
    name: '持有 0 天仍顯示「0 天」',
    find: "  if (n === 0) return '今日買入';",
    replace: "  if (false) return '今日買入';",
    why: '「持有 0 天」讀起來像欄位沒抓到，使用者會懷疑資料',
  },
  {
    name: '持倉段落不排除今日新推介（同一檔列兩次）',
    find: "      .filter((r) => !r.settled && r.status === 'holding' && r.pickDate !== dateKey)",
    replace: "      .filter((r) => !r.settled && r.status === 'holding')",
    why: '今天剛成交的股票會同時出現在「新推介」與「持倉」，看起來像重複建倉',
  },
  {
    name: '較早待買入的記錄完全不提（安靜消失）',
    find: '  if (pendingElsewhere.length) {',
    replace: '  if (false) {',
    why: '使用者會以為那幾檔被放棄了，實際上還在等買區',
  },
  {
    name: '持有的股票不顯示買入價',
    find: '    if (o.showEntry && r.entry && r.entry.price > 0) {',
    replace: '    if (false && o.showEntry && r.entry && r.entry.price > 0) {',
    why: '只看到現價無法判斷賺賠怎麼來的，也不知道自己當初買在哪',
  },
  {
    name: '狀態檔不裁剪（無限長大）',
    find: '      if (keys.length > 60) {',
    replace: '      if (false) {',
    why: '狀態檔會無限成長，最終拖慢每次請求（每次 push 都讀寫整個檔）',
  },
  {
    name: '金額沒有千分位',
    find: "  return `${int.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')}.${dec}`;",
    replace: '  return `${int}.${dec}`;',
    why: '五位數金額一眼難辨，1,145.71 與 114571 容易誤讀',
  },
  {
    name: '標題不重複（續則沒有標題，看不出是哪則）',
    find: "    body = ['（續）'];",
    replace: '    body = [];',
    why: '第二則起失去上下文，使用者不知道這是什麼的續篇',
  },
];

function backup() {
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  fs.copyFileSync(SRC, BACKUP);
}

function restore() {
  fs.copyFileSync(BACKUP, SRC);
}

function runTest() {
  try {
    execFileSync(process.execPath, [TEST], { stdio: 'pipe', cwd: ROOT });
    return { pass: true, out: '' };
  } catch (e) {
    return { pass: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

console.log('\n變異測試：tracker-notify\n');

// 先確認原始碼是綠的，否則後面的「失敗」不代表變異被測到
const baseline = runTest();
if (!baseline.pass) {
  console.log('  ✗ 基準測試本身沒通過，變異測試無意義。先修好測試。');
  console.log(baseline.out.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
console.log('  ✓ 基準：原始碼測試全數通過\n');

const src = fs.readFileSync(SRC, 'utf8');
backup();

let caught = 0;
let missed = 0;

for (const m of MUTATIONS) {
  const occurrences = src.split(m.find).length - 1;
  if (occurrences !== 1) {
    console.log(`  ! 跳過「${m.name}」— find 出現 ${occurrences} 次（需恰好 1 次）`);
    missed += 1;
    continue;
  }

  const mutated = src.replace(m.find, m.replace);
  fs.writeFileSync(SRC, mutated, 'utf8');

  const res = runTest();
  restore();

  if (res.pass) {
    missed += 1;
    console.log(`  ✗ 未被測出：${m.name}`);
    console.log(`      ${m.why}`);
  } else {
    caught += 1;
    console.log(`  ✓ 已測出：${m.name}`);
  }
}

// 確保還原乾淨
restore();

console.log(`\n捕捉 ${caught} / ${MUTATIONS.length} 個變異，漏接 ${missed} 個\n`);

if (missed > 0) {
  console.log('漏接的變異代表對應斷言是空的 —— 那段測試沒有價值，必須補強。\n');
  process.exit(1);
}
