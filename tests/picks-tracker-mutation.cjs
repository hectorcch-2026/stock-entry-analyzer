'use strict';

/**
 * 變異測試 — 證明 picks-tracker 的單元測試「真的會失敗」
 * =====================================================
 *
 * 為什麼要做這件事：
 *   規格型的測試（「同日同股要被擋下」）很容易寫成永遠通過的空斷言，
 *   例如斷言了一個恆為 true 的條件，或忘了 await 非同步函式。
 *   這種測試在 CI 上永遠是綠燈，卻抓不到任何回歸問題——
 *   比沒有測試更危險，因為它給人虛假的安全感。
 *
 *   做法：把原始碼逐一植入「典型錯誤」，重新跑測試，**必須**失敗。
 *   若某個變異沒被測出來，代表對應的斷言是空的。
 *
 * 每個變異都對應一個真實會犯的錯，不是隨便改個字元。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'lib', 'picks-tracker.js');
const FX_SRC = path.join(ROOT, 'lib', 'fx.js');
const TEST = path.join(ROOT, 'tests', 'picks-tracker-unit.cjs');

/**
 * 變異清單：{ name, file, find, replace, why }
 * 每個變異都對應一個真實會犯的錯，而不是隨便改個字元。
 * 前提：find 在原始碼中必須恰好出現一次。
 */
const MUTATIONS = [
  {
    name: '前視偏差：允許用推介日當天的 K 線判定',
    file: SRC,
    find: ".filter((c) => c.key && c.key > record.pickDate)",
    replace: ".filter((c) => c.key && c.key >= record.pickDate)",
    why: '最經典的回測作弊：用收盤後才知道的當日價格去決定當天該不該買',
  },
  {
    name: '匯率：把原幣金額當美元直接用（不折算）',
    file: FX_SRC,
    // 這是真的會被執行到的那一行。先前的變異改成 `if (rate == null) return null;`
    // 屬於無效變異——`rate == null` 為真時本來就會 return null，改掉不改變行為。
    find: "  const r = Number(rate);\n  if (!isFinite(r) || r <= 0) return null;\n  return v / r;",
    replace: "  const r = Number(rate);\n  if (!isFinite(r) || r <= 0) return null;\n  return v;",
    why: '港元損益不折算就直接加總，累計盈虧會被放大大約 7.8 倍',
  },
  {
    name: '去重：移除同日同股檢查',
    file: SRC,
    find: "    if (state.records.some((r) => r.id === id)) {",
    replace: "    if (false && state.records.some((r) => r.id === id)) {",
    why: '同一天重跑排程就會對同一檔重複建倉',
  },
  {
    name: '不重複計算：已結案的記錄仍會進入每日更新',
    file: SRC,
    find: "    const open = state.records.filter((r) => !r.settled);",
    replace: "    const open = state.records.slice();",
    why: '同一筆交易每天被重算一次，損益會隨排程次數膨脹',
  },
  {
    name: '不重複計算：已結案的記錄不再被計為已實現',
    file: SRC,
    find: "    const closed = all.filter((r) => r.settled && r.pnl);",
    replace: "    const closed = all.filter((r) => !r.settled && r.pnl);",
    why: '已實現與未實現被對調，累計盈虧會顯示成浮動損益',
  },
  {
    name: '報酬率：分母誤用單筆本金 10,000',
    file: SRC,
    find: "      realizedReturnPct: deployedUsd > 0 ? round2((realizedUsd / deployedUsd) * 100) : null,",
    replace: "      realizedReturnPct: round2((realizedUsd / capitalUsd) * 100),",
    why: '十筆各賺 5% 會被算成 +50%，因為分母沒跟著筆數放大',
  },
  {
    name: '同日雙觸：改取止賺（樂觀假設）',
    file: SRC,
    find: "          closeExit(record, Math.min(record.stopPrice, o), bar.key, 'stop_hit',\n            '同日觸及止蝕與止賺，日線無法判定先後，保守取止蝕', fx);",
    replace: "          closeExit(record, Math.max(record.targetPrice, o), bar.key, 'target_hit',\n            '同日觸及止蝕與止賺，日線無法判定先後，保守取止蝕', fx);",
    why: '事後看起來很賺的假帳，實務上當天可能先被打穿停損',
  },
  {
    name: '建倉當天即判出場（同一天 high 觸及止賺就結案）',
    file: SRC,
    // 有效的變異：把「建倉當天 continue」改成「繼續往下跑出場判定」，
    // 於是買入當天的 high 就會被當成「已觸及止賺」。
    find: "        if (record.status !== 'holding') continue;      // 這根沒成交，看下一根\n        // ③ 建倉當天不判出場\n        record.lastCheck = { date: bar.key, price: cpx };\n        continue;",
    replace: "        if (record.status !== 'holding') continue;      // 這根沒成交，看下一根\n        record.lastCheck = { date: bar.key, price: cpx };",
    why: '買入當天的日線分不清「先買後跌」還是「先跌後買」，會誤判出場',
  },
  {
    name: '狀態守衛：移除已結案凍結',
    file: SRC,
    // 有效的變異：guard 取消後，已結案的記錄會被後續 K 線重新推進，
    // 同一筆交易會被算出第二組完全不同的數字。
    find: "    if (record.settled) return { changed: false, reason: '已結案' };",
    replace: "    if (record.settled) { record.settled = false; }   // 變異：解除凍結",
    why: '已結案記錄會被後續 K 線改寫，同一筆交易算出第二組數字',
  },
];

function runTest() {
  try {
    const out = execFileSync(process.execPath, [TEST], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

console.log('\n=== 變異測試：證明測試會失敗 ===\n');

const originals = new Map();
originals.set(SRC, fs.readFileSync(SRC, 'utf8'));
originals.set(FX_SRC, fs.readFileSync(FX_SRC, 'utf8'));

function restoreAll() {
  for (const [f, src] of originals) fs.writeFileSync(f, src, 'utf8');
}

let pass = 0;
let fail = 0;

try {
  // 先確認基準是綠的，否則後面的「失敗」沒有意義
  const base = runTest();
  if (base.code !== 0) {
    console.error('基準測試未通過，先修好再談變異測試：');
    console.error(base.out.slice(-800));
    process.exit(1);
  }
  console.log(`基準：測試全數通過（exit 0）\n`);

  for (const m of MUTATIONS) {
    const file = m.file || SRC;
    const base0 = originals.get(file);
    const count = base0.split(m.find).length - 1;
    if (count !== 1) {
      console.log(`  ✗ ${m.name}`);
      console.log(`      變異目標在 ${path.basename(file)} 出現 ${count} 次（預期 1 次）——原始碼已變動，請更新此變異`);
      fail += 1;
      continue;
    }

    let r;
    try {
      fs.writeFileSync(file, base0.replace(m.find, m.replace), 'utf8');
      r = runTest();
    } finally {
      restoreAll();   // 立刻還原，避免測試殘留被改壞的原始碼
    }

    if (r.code !== 0) {
      console.log(`  ✓ ${m.name}`);
      console.log(`      測試抓到了（exit ${r.code}）— ${m.why}`);
      pass += 1;
    } else {
      console.log(`  ✗ ${m.name}`);
      console.log(`      測試仍然全綠 —— 這個錯誤不會被任何斷言發現！`);
      fail += 1;
    }
  }
} finally {
  // 無論如何都要還原，避免留下被改壞的原始碼
  restoreAll();
}

console.log(`\n=== 結果：${pass} 個變異被抓到 / ${fail} 個逃逸 ===\n`);
if (fail) {
  console.error('有錯誤沒被測試抓住，請補強對應斷言。');
  process.exit(1);
}
