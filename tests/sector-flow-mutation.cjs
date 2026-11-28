#!/usr/bin/env node
'use strict';

/**
 * 變異測試：證明 tests/sector-flow-unit.cjs 的斷言真的會失敗
 *
 * 為什麼需要這一支（而不是「單元測試綠了就算」）：
 *   版塊流程的核心斷言都是「某種情況下應該降級／排除」。這類斷言有一個
 *   非常隱蔽的假通過方式：如果實作根本**沒有讀那個條件**，而預設行為
 *   剛好等於斷言期望的結果，測試就會永遠綠。
 *
 *   最真實的例子：rankSectors 曾把 cross 在傳遞中弄丟，於是
 *   classifySectors 的降級規則永遠不觸發。我最初用「leading 應為 FAVORED」
 *   去驗證，全綠——因為降級根本沒機會發生。只有把條件「刻意接上」
 *   與「刻意斷開」兩邊都測，才證明得了它。
 *
 * 每個變異都會：備份 → 改壞 → 跑測試 → 還原 → 檢查結果。
 * 還原一律在 finally 裡做，避免中途崩潰留下壞掉的檔案。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FLOW = path.join(ROOT, 'lib', 'sector-flow.js');
const SCREENER = path.join(ROOT, 'lib', 'screener.js');
const AI = path.join(ROOT, 'lib', 'sector-macro-ai.js');
const TEST = path.join(ROOT, 'tests', 'sector-flow-unit.cjs');
const TEST_INTEGRATION = path.join(ROOT, 'tests', 'sector-flow-integration.cjs');

function runTest() {
  /*
   * 同時跑單元測試與整合測試。
   *
   * 為什麼不能只跑單元測試：有些變異只有在「整條流程真的跑起來」時才會
   * 露出破綻。最明顯的是 period 的取法 —— 單元測試直接餵假的 ranked 陣列
   * 給 classifySectors，根本不會經過 buildRRG，所以「period 是 undefined」
   * 這種錯誤在單元測試裡完全看不到。
   *
   * 兩支都跑，任何一支紅就算捕捉到。
   */
  const run = (file) => {
    const r = spawnSync(process.execPath, [file], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      ok: r.status === 0,
      out: String(r.stdout || '') + String(r.stderr || ''),
    };
  };
  const unit = run(TEST);
  const integ = run(TEST_INTEGRATION);
  return { ok: unit.ok && integ.ok, out: unit.out + '\n' + integ.out };
}

function counts(out) {
  // 兩支測試各有一行「N 通過 / M 失敗」，必須累加，否則只看到其中一支
  const all = [...String(out || '').matchAll(/(\d+)\s*通過\s*\/\s*(\d+)\s*失敗/g)];
  if (!all.length) return null;
  return all.reduce(
    (acc, m) => ({ pass: acc.pass + Number(m[1]), fail: acc.fail + Number(m[2]) }),
    { pass: 0, fail: 0 }
  );
}

const mutations = [];

/** 檔案層級的變異：整段字串替換（必須恰好命中一次，否則視為目標漂移） */
function fileMutation(label, file, from, to) {
  mutations.push({
    label,
    apply() {
      const orig = fs.readFileSync(file, 'utf8');
      if (!orig.includes(from)) throw new Error(`找不到替換目標：${from.slice(0, 70)}`);
      fs.writeFileSync(file, orig.replace(from, to), 'utf8');
      return () => fs.writeFileSync(file, orig, 'utf8');
    },
  });
}

/* ============================================================
   1. 階段一：優勢版塊判定
   ============================================================ */

/* 降級規則失效：山頂領先者不再被降為觀察 */
fileMutation(
  '移除「領先但接近弱化」的降級規則',
  FLOW,
  "      if (next === 'weakening' && conf === 'high') {",
  "      if (false) {"
);

/* 降級條件寫太寬：只要 next=weakening 就降（不看信心） */
fileMutation(
  '降級條件忽略信心程度（只要指向弱化就降）',
  FLOW,
  "      if (next === 'weakening' && conf === 'high') {",
  "      if (next === 'weakening') {"
);

/* 象限門檻失效：任何象限都算優勢 */
fileMutation(
  'FAVORED_QUADRANTS 放寬為全部象限',
  FLOW,
  "const FAVORED_QUADRANTS = ['leading', 'improving'];",
  "const FAVORED_QUADRANTS = ['leading', 'improving', 'weakening', 'lagging'];"
);

/* 象限門檻收窄：只剩 leading（改善象限的佈局機會被砍掉） */
fileMutation(
  'FAVORED_QUADRANTS 收窄為只有 leading',
  FLOW,
  "const FAVORED_QUADRANTS = ['leading', 'improving'];",
  "const FAVORED_QUADRANTS = ['leading'];"
);

/* weakening 一律迴避（觀察名單消失） */
fileMutation(
  'weakening 象限不再有「觀察」這個中間狀態',
  FLOW,
  "      if (next === 'lagging') {\n        verdict = VERDICT.AVOID;\n        reason = '弱化且下一步指向落後，趨勢明確轉差';\n      } else {\n        verdict = VERDICT.WATCH;",
  "      if (true) {\n        verdict = VERDICT.AVOID;\n        reason = '弱化且下一步指向落後，趨勢明確轉差';\n      } else {\n        verdict = VERDICT.WATCH;"
);

/* lagging 轉改善的提前留意被移除 */
fileMutation(
  'lagging 接近改善時不再給「觀察」',
  FLOW,
  "      if (next === 'improving' && conf === 'high') {",
  "      if (false) {"
);

/* ============================================================
   2. topN 控制
   ============================================================ */

fileMutation(
  'DEFAULT_TOP_N 被改為 3（每日成本失控）',
  FLOW,
  'const DEFAULT_TOP_N = 2;',
  'const DEFAULT_TOP_N = 3;'
);

fileMutation(
  'MAX_TOP_N 上限被移除',
  FLOW,
  'return Math.max(1, Math.min(MAX_TOP_N, Math.floor(n)));',
  'return Math.max(1, Math.floor(n));'
);

fileMutation(
  'normTopN 不再擋 0 與負數',
  FLOW,
  'if (!isFinite(n) || n <= 0) return DEFAULT_TOP_N;',
  'if (!isFinite(n)) return DEFAULT_TOP_N;'
);

/* ============================================================
   3. 階段二：動態池建立
   ============================================================ */

/* 無版塊歸屬被併進「版塊未入選」（管線異常被掩蓋） */
fileMutation(
  '把「無版塊歸屬」併入「版塊未入選」（掩蓋資料異常）',
  FLOW,
  '    if (!list || !list.length) {\n      excludedUnknown.push(sym);\n      continue;\n    }',
  '    if (!list || !list.length) {\n      excludedNotFavored.push({ symbol: sym, sector: "" });\n      continue;\n    }'
);

/* 版塊閘門失效：任何有歸屬的都收 */
fileMutation(
  '版塊閘門失效（不檢查主場是否在優勢版塊）',
  FLOW,
  '    if (!favoredKeys.has(sectorKey)) {\n      excludedNotFavored.push({ symbol: sym, sector: sectorKey });\n      continue;\n    }',
  '    if (false) {\n      excludedNotFavored.push({ symbol: sym, sector: sectorKey });\n      continue;\n    }'
);

/* 主場判定改成取最後一個（權重最低） */
fileMutation(
  '主場版塊改取權重最低者（次要歸屬優先）',
  FLOW,
  '    const home = list[0];',
  '    const home = list[list.length - 1];'
);

/* 去重失效 */
fileMutation(
  '母體去重失效（同一檔可重複入池）',
  FLOW,
  '    if (seen.has(sym)) continue;\n    seen.add(sym);',
  '    seen.add(sym);'
);

/* 漏斗數字不自洽 */
fileMutation(
  '漏斗 withSector 計算錯誤（未扣掉無歸屬）',
  FLOW,
  '      withSector: universe.length - excludedUnknown.length,',
  '      withSector: universe.length,'
);

/* ============================================================
   4. cross 傳遞鏈（本次修掉的實際 bug）
   ============================================================ */

/* 回復成「挑欄位重建物件」→ cross 消失 */
fileMutation(
  'rankSectors 不再傳遞 cross（降級規則變成死碼）',
  AI,
  '      cross: p.cross || null,',
  '      cross: null,'
);

fileMutation(
  'rankSectors 不再傳遞 trail（資金流向退化为中性）',
  AI,
  '      trail: Array.isArray(p.trail) ? p.trail : null,',
  '      trail: null,'
);

/* ============================================================
   4b. 平滑週期（本次修掉的 undefined bug）
   ============================================================ */

fileMutation(
  'period 退回讀取不存在的 rrg.DEFAULT_PERIOD（整條流程會 INSUFFICIENT_DATA）',
  FLOW,
  '  const period = rrg.normPeriod(opts.period, timeframe).value;',
  '  const period = Number(opts.period) || rrg.DEFAULT_PERIOD;'
);

fileMutation(
  'period 寫死為 14（月線應為 8）',
  FLOW,
  '  const period = rrg.normPeriod(opts.period, timeframe).value;',
  '  const period = 14;'
);

/* ============================================================
   5. 階段三：排序與注入
   ============================================================ */

/* 第 1 鍵失效：版塊名次不參與排序 */
fileMutation(
  '四鍵排序的第 1 鍵（版塊名次）失效',
  SCREENER,
  '      const r = rankOf(a) - rankOf(b);\n      if (r !== 0) return r;',
  '      const r = 0;\n      if (r !== 0) return r;'
);

/* 第 3 鍵方向寫反（ASC 變 DESC） */
fileMutation(
  '第 3 鍵距買區方向寫反（越遠越優先）',
  SCREENER,
  '      const d = ascOf(a.distAtr) - ascOf(b.distAtr);',
  '      const d = ascOf(b.distAtr) - ascOf(a.distAtr);'
);

/* 空值不沉底：回到 isFinite(null)===true 的錯誤 */
fileMutation(
  '空值檢查退回 isFinite（null 被當成 0，排到最前）',
  SCREENER,
  '    const numOrNull = (v) => (v == null || v === \'\' ? null : (Number.isFinite(+v) ? +v : null));',
  '    const numOrNull = (v) => (isFinite(v) ? +v : null);'
);

/* 沒有 sectorMeta 時靜默假裝成功 */
fileMutation(
  '缺 sectorMeta 時不退回、靜默假裝版塊排序生效',
  SCREENER,
  "  if (sectorMode && !(deps.sectorMeta && deps.sectorMeta.size)) {\n    effectiveSortBy = 'score';",
  "  if (false) {\n    effectiveSortBy = 'score';"
);

/* 集中度不再計算 */
fileMutation(
  '版塊模式不再輸出集中度',
  SCREENER,
  "concentration: effectiveSortBy === 'sector' ? concentration(sorted) : null,",
  'concentration: null,'
);

/* 集中度的「換排序變動數」永遠 0 */
fileMutation(
  '集中度的 scoreSortChanged 永遠回 0',
  SCREENER,
  '  for (const s of a) if (!b.has(s)) changed += 1;',
  '  /* 變異：不計算 */'
);

/* attachSector 少注入 sectorRank（前端「版塊名次」欄會空） */
fileMutation(
  'attachSector 不再注入 sectorRank',
  SCREENER,
  '    row.sectorRank = isFinite(m.rank) ? m.rank : null;',
  '    row.sectorRank = null;'
);

/* attachSector 對未知代碼寫入假值 */
fileMutation(
  'attachSector 對查不到的代碼寫入假版塊',
  SCREENER,
  '    const m = meta.get(String(row.symbol || \'\').toUpperCase());\n    if (!m) continue;',
  '    const m = meta.get(String(row.symbol || \'\').toUpperCase()) || { key: "UNKNOWN", rank: 99 };'
);

console.log('\n=== 變異測試：版塊輪動選股流程 ===\n');

const baseline = runTest();
const baseCounts = counts(baseline.out);
if (!baseline.ok) {
  console.log('✗ 基準測試未通過，無法進行變異測試');
  console.log(baseline.out.split('\n').slice(-20).join('\n'));
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

// 還原後必須回到全綠，否則代表還原不完整
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
