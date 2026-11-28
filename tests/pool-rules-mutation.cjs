#!/usr/bin/env node
'use strict';

/**
 * 變異測試：證明 tests/pool-rules.cjs 的斷言真的會失敗
 *
 * 為什麼需要這一支：
 *   「恰好 500 檔」這種斷言有一百種意外通過的方式（池子是空的也會通過
 *   某些形式的檢查、排除規則根本沒接上也會通過）。變異測試的做法是
 *   刻意把實作改壞，看測試是否轉紅；若改壞了測試還是綠的，
 *   那條斷言就是裝飾品。
 *
 * 每個變異都會：備份 → 改壞 → 跑測試 → 還原 → 檢查結果。
 * 還原一律在 finally 裡做，避免測試中途崩潰留下壞掉的檔案。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const POOL = path.join(ROOT, 'lib', 'pool.js');
const SCREENER = path.join(ROOT, 'lib', 'screener.js');
const SNAPSHOT = path.join(ROOT, 'lib', 'pool-us-500.json');
const TEST = path.join(ROOT, 'tests', 'pool-rules.cjs');

function runTest() {
  /*
   * 用 spawnSync 而不是 execFileSync：後者成功時只回傳 stdout 的值、
   * 失敗時則丟例外，兩條路徑的回傳形狀不同。這裡需要「不論成功或失敗
   * 都拿得到完整輸出」，才能解析出「N 通過 / M 失敗」。
   */
  const r = spawnSync(process.execPath, [TEST], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return { ok: r.status === 0, out };
}

/** 統計測試輸出中的「N 通過 / M 失敗」 */
function counts(out) {
  const m = String(out || '').match(/(\d+)\s*通過\s*\/\s*(\d+)\s*失敗/);
  if (!m) return null;
  return { pass: Number(m[1]), fail: Number(m[2]) };
}

const mutations = [];

/** 檔案層級的變異：整段字串替換 */
function fileMutation(label, file, from, to) {
  mutations.push({
    label,
    apply() {
      const orig = fs.readFileSync(file, 'utf8');
      if (!orig.includes(from)) throw new Error(`找不到替換目標：${from.slice(0, 60)}`);
      fs.writeFileSync(file, orig.replace(from, to), 'utf8');
      return () => fs.writeFileSync(file, orig, 'utf8');
    },
  });
}

/* ---- 1. 移除中概股閘門 ---- */
fileMutation(
  '篩選器不呼叫 enforceUniverse（中概股直接進分析）',
  SCREENER,
  "const gate = require('./pool').enforceUniverse(requestedPool);\n  const pool = gate.kept;",
  "const gate = { kept: requestedPool, removed: [], removedHK: [] };\n  const pool = gate.kept;"
);

/* ---- 2. 中概股黑名單失效 ---- */
fileMutation(
  'CHINA_ADR 黑名單被清空',
  POOL,
  "'BABA', 'BIDU', 'BILI', 'BEKE', 'EDU', 'IQ', 'JD', 'LI', 'NIO', 'NTES',",
  ''
);

/* ---- 3. 港股不擋 ---- */
fileMutation(
  'enforceUniverse 不排除港股',
  POOL,
  'if (isHK(s)) { removedHK.push(s); continue; }',
  '/* 港股不擋（變異） */'
);

/* ---- 4. .HK 正規化被破壞 ---- */
fileMutation(
  'normalizeTicker 把 .HK 也換成連字號',
  POOL,
  "if (/\\.HK$/.test(s)) return s;      // 港股：點是格式的一部分，不可動",
  '/* 港股不保留（變異） */'
);

/* ---- 5. 名稱比對失去詞邊界 ---- */
fileMutation(
  'CHINA_NAME_RE 拿掉詞邊界（會誤傷 Dominion）',
  POOL,
  'const CHINA_NAME_RE = /\\b(china|chinese|prc|beijing|shanghai|shenzhen|hong\\s*kong)\\b/i;',
  'const CHINA_NAME_RE = /(china|chinese|prc|beijing|shanghai|shenzhen|nio|cn)/i;'
);

/* ---- 6. summary 不再回報排除數 ---- */
fileMutation(
  'summary 移除 excluded.chinaAdr 欄位',
  POOL,
  'excluded: {\n      chinaAdr: {',
  'excludedLegacy: {\n      chinaAdr: {'
);

/* ---- 7. byMarket 讓 hk 回全池 ---- */
fileMutation(
  'byMarket(hk) 誤回全池',
  POOL,
  "if (m === 'hk') return [];",
  "if (m === 'hk') return all();"
);

/* ---- 8. 快照多一檔（破壞 500） ---- */
mutations.push({
  label: '快照被加入第 501 檔（GOOG，雙類股重複）',
  apply() {
    const orig = fs.readFileSync(SNAPSHOT, 'utf8');
    const obj = JSON.parse(orig);
    obj.symbols.push({ symbol: 'GOOG', name: 'Alphabet Inc. (Class C)', sector: 'Communication Services' });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return () => fs.writeFileSync(SNAPSHOT, orig, 'utf8');
  },
});

/* ---- 9. 快照混入中概股 ---- */
mutations.push({
  label: '快照被混入 BABA（中概股）',
  apply() {
    const orig = fs.readFileSync(SNAPSHOT, 'utf8');
    const obj = JSON.parse(orig);
    obj.symbols.push({ symbol: 'BABA', name: 'Alibaba Group', sector: 'Consumer Discretionary' });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return () => fs.writeFileSync(SNAPSHOT, orig, 'utf8');
  },
});

/* ---- 10. stats 不回報排除數 ---- */
fileMutation(
  'stats 移除 chinaExcluded 欄位',
  SCREENER,
  'chinaExcluded: {\n        count: gate.removed.length,',
  'chinaExcludedLegacy: {\n        count: gate.removed.length,'
);

/* ---- 11. 預設 market 改回 all ---- */
fileMutation(
  'DEFAULTS.market 改回 all',
  SCREENER,
  "market: 'us',         // us（母體僅美股；all 等同 us，hk 回空）",
  "market: 'all',"
);

/* ---- 12. 篩選參數被偷改 ---- */
fileMutation(
  'minScore 預設值被改動（55 → 60）',
  SCREENER,
  'minScore: 55,',
  'minScore: 60,'
);

/* ---- 13. 兩份中概股名單漂移 ---- */
fileMutation(
  'build-pool.js 的名單少一檔（與執行期漂移）',
  path.join(ROOT, 'scripts', 'build-pool.js'),
  "'BABA', 'BIDU', 'BILI', 'BEKE', 'EDU', 'IQ', 'JD', 'LI', 'NIO', 'NTES',",
  "'BIDU', 'BILI', 'BEKE', 'EDU', 'IQ', 'JD', 'LI', 'NIO', 'NTES',"
);

console.log('\n=== 變異測試：標的池規則 ===\n');

const baseline = runTest();
const baseCounts = counts(baseline.out);
if (!baseline.ok) {
  console.log('✗ 基準測試未通過，無法進行變異測試');
  console.log(baseline.out.split('\n').slice(-15).join('\n'));
  process.exit(1);
}
console.log(`基準：${baseCounts.pass} 通過 / ${baseCounts.fail} 失敗\n`);

let caught = 0;
const missed = [];

for (const m of mutations) {
  let restore = null;
  try {
    restore = m.apply();
    const res = runTest();
    if (res.ok) {
      missed.push(m.label);
      console.log(`  ✗ 未捕捉：${m.label}`);
    } else {
      caught++;
      const c = counts(res.out);
      const detail = c ? `（${c.pass} 通過 / ${c.fail} 失敗）` : '';
      console.log(`  ✓ 已捕捉：${m.label} ${detail}`);
    }
  } catch (e) {
    missed.push(`${m.label}（套用變異時出錯：${e.message}）`);
    console.log(`  ! 套用失敗：${m.label} — ${e.message}`);
  } finally {
    if (restore) restore();
  }
}

// 還原後必須回到全綠
const after = runTest();
const afterCounts = counts(after.out);
console.log(`\n還原後：${afterCounts ? afterCounts.pass : '?'} 通過 / ${afterCounts ? afterCounts.fail : '?'} 失敗`);
if (!after.ok) {
  console.log('✗ 還原後測試未通過 —— 變異未完全還原，請檢查工作區');
  process.exit(1);
}

console.log(`\n=== 變異測試結果：捕捉 ${caught} / ${mutations.length} ===\n`);
if (missed.length) {
  console.log('未被捕捉的變異（代表對應斷言無效）：');
  missed.forEach((x) => console.log('  - ' + x));
  process.exit(1);
}
