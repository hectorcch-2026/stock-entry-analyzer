#!/usr/bin/env node
'use strict';

/**
 * 版塊輪動選股流程 — 單元測試
 *
 * 測試策略：全部用「注入的假資料」，不打任何上游。
 *   理由：這支模組的價值在**判定邏輯**（哪個版塊算優勢、哪檔進池），
 *   而判定邏輯的正確性必須能在不看真實行情的情況下被證明。
 *   若測試依賴即時行情，市場一變測試就紅，久了就沒人看。
 *
 * 每個斷言都配一個「反向對照」：像「leading 版塊應該入選」這種斷言，
 * 如果 classifySectors 永遠回 FAVORED 也會通過，所以旁邊必須有
 * 「山頂領先者應被降級」的斷言，兩者才構成真正的證明。
 */

const assert = require('assert');
const sectorFlow = require('../lib/sector-flow');
const smAi = require('../lib/sector-macro-ai');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, msg: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

/** 造一個版塊物件（模擬 rankSectors 的輸出）。 */
function sec(key, opts = {}) {
  return {
    key,
    label: opts.label || key,
    short: opts.short || key,
    color: '#888',
    rank: opts.rank || 1,
    ratio: opts.ratio != null ? opts.ratio : 105,
    momentum: opts.momentum != null ? opts.momentum : 104,
    quadrant: opts.quadrant || 'leading',
    quadrantLabel: opts.quadrantLabel || '領先',
    strengthScore: opts.strengthScore != null ? opts.strengthScore : 90,
    cross: opts.cross !== undefined ? opts.cross : null,
  };
}

function cross(next, confidence) {
  return { next, nextCn: next, distance: confidence === 'high' ? 0.4 : 3.0, axis: 'momentum', confidence };
}

console.log('\n=== 版塊輪動選股流程 單元測試 ===\n');

/* ============================================================
   A. topN 正規化
   ============================================================ */

t('A1 預設 topN 為 2（每日成本可控）', () => {
  assert.strictEqual(sectorFlow.DEFAULT_TOP_N, 2);
  assert.strictEqual(sectorFlow.normTopN(undefined), 2);
  assert.strictEqual(sectorFlow.normTopN(null), 2);
  assert.strictEqual(sectorFlow.normTopN(''), 2);
});

t('A2 非法值一律退回預設，不拋錯', () => {
  assert.strictEqual(sectorFlow.normTopN('abc'), 2);
  assert.strictEqual(sectorFlow.normTopN(NaN), 2);
  assert.strictEqual(sectorFlow.normTopN(0), 2);
  assert.strictEqual(sectorFlow.normTopN(-3), 2);
});

t('A3 上限 6，且向下取整', () => {
  assert.strictEqual(sectorFlow.MAX_TOP_N, 6);
  assert.strictEqual(sectorFlow.normTopN(9), 6);
  assert.strictEqual(sectorFlow.normTopN(2.9), 2);
  assert.strictEqual(sectorFlow.normTopN('3'), 3);
  assert.strictEqual(sectorFlow.normTopN(1), 1);
});

/* ============================================================
   B. classifySectors — 象限判定
   ============================================================ */

t('B1 leading 且未指向弱化 → 優勢', () => {
  const r = sectorFlow.classifySectors([sec('XLK', { quadrant: 'leading' })]);
  assert.strictEqual(r[0].verdict, sectorFlow.VERDICT.FAVORED);
  assert.ok(/領先象限/.test(r[0].verdictReason));
});

t('B2 improving → 優勢（佈局期，不是次等）', () => {
  const r = sectorFlow.classifySectors([
    sec('XLF', { quadrant: 'improving', ratio: 97, momentum: 103 }),
  ]);
  assert.strictEqual(r[0].verdict, sectorFlow.VERDICT.FAVORED);
  assert.ok(/改善象限/.test(r[0].verdictReason), '應說明是佈局期而非落後');
});

t('B3【關鍵】leading 但接近轉弱且信心高 → 降級為觀察', () => {
  // 這是整條流程最容易看起來「什麼都沒做」的規則：
  // 若 rankSectors 把 cross 弄丟，這裡會誤判成 FAVORED。
  const r = sectorFlow.classifySectors([
    sec('XLK', { quadrant: 'leading', cross: cross('weakening', 'high') }),
  ]);
  assert.strictEqual(r[0].verdict, sectorFlow.VERDICT.WATCH, '山頂領先者必須降級');
  assert.ok(/弱化/.test(r[0].verdictReason));
  assert.ok(/信心高/.test(r[0].verdictReason), '必須說明降級依據是信心高');
});

t('B4 同為 leading+weakening，但信心非 high → 不降級', () => {
  // 反向對照：證明 B3 的降級不是「只要 next=weakening 就降」，
  // 而是真的看了信心程度。少了這條，B3 可能因為條件寫太寬而假通過。
  for (const conf of ['medium', 'low', 'none']) {
    const r = sectorFlow.classifySectors([
      sec('XLK', { quadrant: 'leading', cross: cross('weakening', conf) }),
    ]);
    assert.strictEqual(r[0].verdict, sectorFlow.VERDICT.FAVORED, `信心 ${conf} 不應降級`);
  }
});

t('B5 weakening 且下一步就是 lagging → 迴避', () => {
  const r = sectorFlow.classifySectors([
    sec('XLE', { quadrant: 'weakening', cross: cross('lagging', 'high') }),
  ]);
  assert.strictEqual(r[0].verdict, sectorFlow.VERDICT.AVOID);
});

t('B6 weakening 但未指向 lagging → 觀察（不是直接砍掉）', () => {
  // 弱化象限但下一步不是落後（例如動能回升、準備轉回領先）→ 留著觀察。
  // 規格 §1.3：WATCH 的條件是「weakening 但 cross.next !== 'lagging'」。
  const r = sectorFlow.classifySectors([
    sec('XLE', { quadrant: 'weakening', cross: cross('leading', 'low') }),
  ]);
  assert.strictEqual(r[0].verdict, sectorFlow.VERDICT.WATCH);
  assert.ok(/尚未跌向落後/.test(r[0].verdictReason));
});

t('B7 lagging 但強力轉向 improving → 觀察；否則迴避', () => {
  const up = sectorFlow.classifySectors([
    sec('XLU', { quadrant: 'lagging', cross: cross('improving', 'high') }),
  ]);
  assert.strictEqual(up[0].verdict, sectorFlow.VERDICT.WATCH);

  const down = sectorFlow.classifySectors([
    sec('XLU', { quadrant: 'lagging', cross: cross('weakening', 'low') }),
  ]);
  assert.strictEqual(down[0].verdict, sectorFlow.VERDICT.AVOID);
});

t('B8 缺象限 → 迴避並說明，不靜默給優勢', () => {
  const r = sectorFlow.classifySectors([{ key: 'XX', ratio: 100, momentum: 100 }]);
  assert.strictEqual(r[0].verdict, sectorFlow.VERDICT.AVOID);
  assert.ok(/資料不足/.test(r[0].verdictReason));
});

t('B9 classifySectors 保留原欄位（rank/strengthScore 不可丟）', () => {
  const r = sectorFlow.classifySectors([
    sec('XLK', { rank: 1, strengthScore: 92.4, ratio: 105.5 }),
  ]);
  assert.strictEqual(r[0].rank, 1);
  assert.strictEqual(r[0].strengthScore, 92.4);
  assert.strictEqual(r[0].ratio, 105.5);
});

t('B10 空輸入不崩', () => {
  assert.deepStrictEqual(sectorFlow.classifySectors([]), []);
  assert.deepStrictEqual(sectorFlow.classifySectors(null), []);
  assert.deepStrictEqual(sectorFlow.classifySectors(undefined), []);
});

/* ============================================================
   C. pickFavored — 取前 N
   ============================================================ */

t('C1 只從 FAVORED 取，且依原排序（不重排）', () => {
  const cls = sectorFlow.classifySectors([
    sec('A', { rank: 1, quadrant: 'leading' }),
    sec('B', { rank: 2, quadrant: 'weakening', cross: cross('lagging', 'high') }),
    sec('C', { rank: 3, quadrant: 'improving' }),
    sec('D', { rank: 4, quadrant: 'lagging', cross: cross('weakening', 'low') }),
  ]);
  const r = sectorFlow.pickFavored(cls, 2);
  assert.deepStrictEqual(r.favored.map((s) => s.key), ['A', 'C']);
  assert.strictEqual(r.eligibleCount, 2);
});

t('C2 降級可讓名次不連續（第 1 名被跳過，第 2、3 名入選）', () => {
  const cls = sectorFlow.classifySectors([
    sec('A', { rank: 1, quadrant: 'leading', cross: cross('weakening', 'high') }),
    sec('B', { rank: 2, quadrant: 'leading' }),
    sec('C', { rank: 3, quadrant: 'improving' }),
  ]);
  const r = sectorFlow.pickFavored(cls, 2);
  assert.deepStrictEqual(r.favored.map((s) => s.key), ['B', 'C']);
  assert.ok(!r.favored.some((s) => s.key === 'A'), '第 1 名不該因為名次高就無條件入選');
});

t('C3 eligibleCount > topN 時要讓人知道「還有名額被成本卡掉」', () => {
  const cls = sectorFlow.classifySectors([
    sec('A', { rank: 1, quadrant: 'leading' }),
    sec('B', { rank: 2, quadrant: 'leading' }),
    sec('C', { rank: 3, quadrant: 'leading' }),
    sec('D', { rank: 4, quadrant: 'improving' }),
  ]);
  const r = sectorFlow.pickFavored(cls, 2);
  assert.strictEqual(r.favored.length, 2);
  assert.strictEqual(r.eligibleCount, 4, '合格數要回全部，不是截斷後的');
});

t('C4 沒有合格版塊 → 空陣列（由呼叫端報 NO_FAVORED_SECTOR）', () => {
  const cls = sectorFlow.classifySectors([
    sec('A', { quadrant: 'lagging', cross: cross('weakening', 'low') }),
    sec('B', { quadrant: 'weakening', cross: cross('lagging', 'high') }),
  ]);
  const r = sectorFlow.pickFavored(cls, 2);
  assert.strictEqual(r.favored.length, 0);
  assert.strictEqual(r.eligibleCount, 0);
});

/* ============================================================
   D. buildDynamicPool — 階段二
   ============================================================ */

/** 造一個 Map<symbol, [{sector, weight, rank}]> 模擬 getSectorIndex().map */
function indexOf(entries) {
  const m = new Map();
  for (const [sym, sector, weight, rank] of entries) {
    if (!m.has(sym)) m.set(sym, []);
    m.get(sym).push({ sector, weight: weight || 10, rank: rank || 1 });
  }
  return m;
}

t('D1 只收優勢版塊成員', () => {
  const index = indexOf([
    ['AAPL', 'XLK', 20, 1], ['MSFT', 'XLK', 18, 2],
    ['CAT', 'XLI', 15, 1], ['JPM', 'XLF', 12, 1],
  ]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['AAPL', 'MSFT', 'CAT', 'JPM'],
    sectorIndex: index,
    favoredSectors: [{ key: 'XLK' }, { key: 'XLI' }],
  });
  assert.deepStrictEqual(r.symbols.sort(), ['AAPL', 'CAT', 'MSFT'].sort());
  assert.strictEqual(r.bySector.XLK, 2);
  assert.strictEqual(r.bySector.XLI, 1);
});

t('D2【關鍵】無版塊歸屬與版塊未入選分開計數', () => {
  // 這兩者的除錯方向完全相反：一個是資料管線異常，一個是策略正常結果。
  // 若合併成一個數字，管線壞掉時使用者只看到一個大數字，無從發現異常。
  const index = indexOf([['AAPL', 'XLK', 20, 1], ['JPM', 'XLF', 12, 1]]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['AAPL', 'JPM', 'GHOST'],   // GHOST 查不到歸屬
    sectorIndex: index,
    favoredSectors: [{ key: 'XLK' }],
  });
  assert.strictEqual(r.excluded.sectorUnknown.count, 1);
  assert.deepStrictEqual(r.excluded.sectorUnknown.symbols, ['GHOST']);
  assert.strictEqual(r.excluded.sectorNotFavored.count, 1);
  assert.strictEqual(r.symbols.length, 1);
  assert.deepStrictEqual(r.symbols, ['AAPL']);
});

t('D3 無歸屬為 0 時，note 要說明「全部成功歸屬」而非留空', () => {
  const index = indexOf([['AAPL', 'XLK', 20, 1]]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['AAPL'], sectorIndex: index, favoredSectors: [{ key: 'XLK' }],
  });
  assert.strictEqual(r.excluded.sectorUnknown.count, 0);
  assert.ok(/全部母體成員皆已成功歸屬/.test(r.excluded.sectorUnknown.note));
});

t('D4 漏斗數字必須自洽（universe = dynamicPool + unknown + notFavored）', () => {
  const index = indexOf([
    ['AAPL', 'XLK', 20, 1], ['MSFT', 'XLK', 18, 2], ['JPM', 'XLF', 12, 1],
  ]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['AAPL', 'MSFT', 'JPM', 'GHOST'],
    sectorIndex: index,
    favoredSectors: [{ key: 'XLK' }],
  });
  const f = r.funnel;
  assert.strictEqual(f.universe, 4);
  assert.strictEqual(f.unknownSector, 1);
  assert.strictEqual(f.notFavored, 1);
  assert.strictEqual(f.dynamicPool, 2);
  assert.strictEqual(f.withSector, 3);
  assert.strictEqual(
    f.dynamicPool + f.unknownSector + f.notFavored, f.universe,
    '三個分類加起來必須等於母體，否則有成員被靜默丟棄'
  );
});

t('D5 版塊代碼大小寫不敏感（xlk 與 XLK 等效）', () => {
  const index = indexOf([['AAPL', 'xlk', 20, 1]]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['AAPL'], sectorIndex: index, favoredSectors: [{ key: 'XLK' }],
  });
  assert.strictEqual(r.symbols.length, 1);
  assert.strictEqual(r.members[0].sector, 'XLK', '輸出一律大寫，避免前端分組出兩個 XLK');
});

t('D6 一檔多版塊時取權重最高者為主場', () => {
  const index = indexOf([
    ['AMZN', 'XLY', 22, 1],
    ['AMZN', 'XLK', 5, 9],     // 次要歸屬，權重較低
  ]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['AMZN'], sectorIndex: index, favoredSectors: [{ key: 'XLY' }],
  });
  assert.strictEqual(r.symbols.length, 1);
  assert.strictEqual(r.members[0].sector, 'XLY');
  assert.deepStrictEqual(r.members[0].otherSectors, ['XLK']);
});

t('D7 主場不在優勢版塊時，不可因為「次要歸屬有中」就收進池', () => {
  // 反向對照 D6：若用「任一個版塊入選就收」，會把主場在弱勢版塊的
  // 股票混進來，等於版塊閘門失效。
  const index = indexOf([
    ['XYZ', 'XLE', 25, 1],      // 主場：能源（未入選）
    ['XYZ', 'XLK', 3, 20],      // 次要：科技（入選）
  ]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['XYZ'], sectorIndex: index, favoredSectors: [{ key: 'XLK' }],
  });
  assert.strictEqual(r.symbols.length, 0, '主場不在優勢版塊就該排除');
  assert.strictEqual(r.excluded.sectorNotFavored.count, 1);
});

t('D8 成員依權重由大到小排序（大市值流動性佳者優先）', () => {
  const index = indexOf([
    ['SMALL', 'XLK', 1, 70], ['BIG', 'XLK', 30, 1], ['MID', 'XLK', 10, 20],
  ]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['SMALL', 'BIG', 'MID'], sectorIndex: index, favoredSectors: [{ key: 'XLK' }],
  });
  assert.deepStrictEqual(r.symbols, ['BIG', 'MID', 'SMALL']);
});

t('D9 代碼正規化：BRK.B 收斂為 BRK-B', () => {
  const index = indexOf([['BRK-B', 'XLF', 15, 1]]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['BRK.B'], sectorIndex: index, favoredSectors: [{ key: 'XLF' }],
  });
  assert.deepStrictEqual(r.symbols, ['BRK-B']);
});

t('D10 空母體／缺 sectorIndex 不崩', () => {
  const a = sectorFlow.buildDynamicPool({ universe: [], sectorIndex: new Map(), favoredSectors: [] });
  assert.strictEqual(a.symbols.length, 0);
  assert.strictEqual(a.funnel.universe, 0);

  const b = sectorFlow.buildDynamicPool({ universe: ['AAPL'], favoredSectors: [{ key: 'XLK' }] });
  assert.strictEqual(b.symbols.length, 0);
  assert.strictEqual(b.excluded.sectorUnknown.count, 1, '沒有 index 時應歸類為「無歸屬」而非崩潰');
});

t('D11 重複代碼只收一次', () => {
  const index = indexOf([['AAPL', 'XLK', 20, 1]]);
  const r = sectorFlow.buildDynamicPool({
    universe: ['AAPL', 'AAPL', 'aapl'], sectorIndex: index, favoredSectors: [{ key: 'XLK' }],
  });
  assert.strictEqual(r.symbols.length, 1);
});

/* ============================================================
   E. cross 傳遞鏈（rankSectors → classifySectors）
   ============================================================ */

t('E1【關鍵】rankSectors 必須保留 cross', () => {
  /*
   * 這條測試存在的理由：rankSectors 早期是「挑欄位重建物件」，
   * 於是 cross 在傳遞中消失，下游 s.cross 永遠 undefined。
   * 後果是 classifySectors 的降級規則變成永不觸發的死碼 ——
   * 沒有任何錯誤、輸出看起來完全正常，只是「山頂領先者不會被降級」。
   * 這種靜默失效只能靠測試釘住。
   */
  const r = smAi.rankSectors([
    sec('XLK', { quadrant: 'leading', cross: cross('weakening', 'high') }),
    sec('XLI', { quadrant: 'leading', ratio: 101, momentum: 101, cross: null }),
  ]);
  const xlk = r.find((s) => s.key === 'XLK');
  assert.ok(xlk.cross, 'cross 不得遺失');
  assert.strictEqual(xlk.cross.confidence, 'high');
  assert.strictEqual(xlk.cross.next, 'weakening');
});

t('E2 rankSectors 的輸出可直接餵給 classifySectors 並觸發降級', () => {
  // 端到端：證明兩個函式串起來語意一致（E1 只證明欄位在，這條證明它有用）
  const ranked = smAi.rankSectors([
    sec('XLK', { quadrant: 'leading', ratio: 106, momentum: 105, cross: cross('weakening', 'high') }),
    sec('XLI', { quadrant: 'leading', ratio: 103, momentum: 102, cross: null }),
  ]);
  const cls = sectorFlow.classifySectors(ranked);
  const byKey = Object.fromEntries(cls.map((s) => [s.key, s]));
  assert.strictEqual(byKey.XLK.verdict, sectorFlow.VERDICT.WATCH, '最高分但山頂 → 觀察');
  assert.strictEqual(byKey.XLI.verdict, sectorFlow.VERDICT.FAVORED);
});

t('E3 rankSectors 保留 analysis 與 trail（資金流向需要）', () => {
  const trail = [{ ratio: 100, momentum: 99 }, { ratio: 104, momentum: 103 }];
  const r = smAi.rankSectors([
    { ...sec('XLK'), trail, analysis: { length: 2 } },
    sec('XLI', { ratio: 101, momentum: 101 }),
  ]);
  const xlk = r.find((s) => s.key === 'XLK');
  assert.ok(Array.isArray(xlk.trail), 'trail 不得遺失');
  assert.strictEqual(xlk.trail.length, 2);
  assert.ok(xlk.analysis, 'analysis 不得遺失');
});

/* ============================================================
   F. 排序（階段三的四鍵排序，經 screener 匯出）
   ============================================================ */

const screener = require('../lib/screener');

function row(symbol, sectorRank, score, distAtr, rrRatio) {
  return { symbol, sectorRank, score, distAtr, rrRatio };
}

t('F1 第 1 鍵：版塊名次 ASC', () => {
  const rows = [row('A', 3, 99, 0, 9), row('B', 1, 60, 2, 1), row('C', 2, 80, 1, 2)];
  const out = screener.sortRows(rows, 'sector', 'desc');
  assert.deepStrictEqual(out.map((r) => r.symbol), ['B', 'C', 'A']);
});

t('F2 第 2 鍵：同版塊內評分 DESC', () => {
  const rows = [row('A', 1, 70, 0, 1), row('B', 1, 90, 0, 1), row('C', 1, 80, 0, 1)];
  const out = screener.sortRows(rows, 'sector', 'desc');
  assert.deepStrictEqual(out.map((r) => r.symbol), ['B', 'C', 'A']);
});

t('F3 第 3 鍵：距買區 ASC（負值＝已進買區，優先於 0）', () => {
  const rows = [row('A', 1, 80, 1.5, 1), row('B', 1, 80, -0.4, 1), row('C', 1, 80, 0.5, 1)];
  const out = screener.sortRows(rows, 'sector', 'desc');
  assert.deepStrictEqual(out.map((r) => r.symbol), ['B', 'C', 'A']);
});

t('F4 第 4 鍵：盈虧比 DESC', () => {
  const rows = [row('A', 1, 80, 0.5, 1.0), row('B', 1, 80, 0.5, 3.2), row('C', 1, 80, 0.5, 2.0)];
  const out = screener.sortRows(rows, 'sector', 'desc');
  assert.deepStrictEqual(out.map((r) => r.symbol), ['B', 'C', 'A']);
});

t('F5 缺值沉底，且不會被誤當成 0（0 是最理想值）', () => {
  // 這是四鍵排序最容易寫錯的地方：null 若被當 0，會排到最前面，
  // 讓「算不出距買區」的標的排在「正好在買區上緣」的標的前面。
  const rows = [
    row('NULLDIST', 1, 80, null, 2),
    row('ZERO', 1, 80, 0, 2),
    row('NULLSCORE', 1, null, 0, 2),
  ];
  const out = screener.sortRows(rows, 'sector', 'desc');
  assert.strictEqual(out[0].symbol, 'ZERO', '缺值者不可排在有值者之前');
  assert.ok(out.slice(1).some((r) => r.symbol === 'NULLDIST'));
});

t('F6 完全同分時以代碼定序（輸出穩定，可重現）', () => {
  const rows = [row('ZZZ', 1, 80, 0, 2), row('AAA', 1, 80, 0, 2)];
  const a = screener.sortRows(rows, 'sector', 'desc').map((r) => r.symbol);
  const b = screener.sortRows(rows.slice().reverse(), 'sector', 'desc').map((r) => r.symbol);
  assert.deepStrictEqual(a, b, '輸入順序不應影響輸出');
  assert.deepStrictEqual(a, ['AAA', 'ZZZ']);
});

t('F7 sortBy=sector 是合法參數，且有中文標籤', () => {
  assert.ok(screener.SORTABLE.has('sector'));
  assert.strictEqual(screener.normalizeOptions({ sortBy: 'sector' }).ok, true);
  assert.ok(screener.SORTABLE_LABEL.sector);
});

/* ============================================================
   G. attachSector / concentration
   ============================================================ */

t('G1 attachSector 注入版塊欄位', () => {
  const meta = new Map([['AAPL', { key: 'XLK', label: '資訊科技', rank: 1, strengthScore: 92.4, quadrant: 'leading' }]]);
  const rows = screener.attachSector([{ symbol: 'AAPL' }], meta);
  assert.strictEqual(rows[0].sector, 'XLK');
  assert.strictEqual(rows[0].sectorLabel, '資訊科技');
  assert.strictEqual(rows[0].sectorRank, 1);
  assert.strictEqual(rows[0].sectorStrength, 92.4);
});

t('G2 attachSector 對查不到的代碼不寫入假值', () => {
  const meta = new Map([['AAPL', { key: 'XLK', rank: 1 }]]);
  const rows = screener.attachSector([{ symbol: 'GHOST' }], meta);
  assert.strictEqual(rows[0].sector, undefined, '不該寫入 null 以外的猜測值');
  assert.strictEqual(rows[0].sectorRank, undefined);
});

t('G3 attachSector 無 meta 時原樣回傳（不崩）', () => {
  const rows = [{ symbol: 'AAPL' }];
  assert.strictEqual(screener.attachSector(rows, null), rows);
  assert.strictEqual(screener.attachSector(rows, undefined), rows);
});

t('G4 concentration 算出集中度與換排序的變動檔數', () => {
  /*
   * 刻意讓「版塊優先」與「評分優先」的前十名不同：
   *   版塊優先前十 = 7 檔 XLK + 3 檔 XLI（名次 1、2）
   *   評分優先前十 = 3 檔 XLF（99/98/97）+ 3 檔 XLI + 4 檔 XLK
   * 兩者交集是 3 檔 XLI + 4 檔 XLK，所以版塊優先的前十有 3 檔被換掉。
   *
   * 若只用 10 列測，兩種排序的前十名必然相同（都是全部），
   * 變動恆為 0 —— 那個斷言會假通過，證明不了任何事。
   */
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push({ symbol: `T${i}`, sector: 'XLK', sectorRank: 1, score: 60 + i, distAtr: 0, rrRatio: 1 });
  for (let i = 0; i < 3; i++) rows.push({ symbol: `I${i}`, sector: 'XLI', sectorRank: 2, score: 95 - i, distAtr: 0, rrRatio: 1 });
  for (let i = 0; i < 3; i++) rows.push({ symbol: `F${i}`, sector: 'XLF', sectorRank: 3, score: 99 - i, distAtr: 0, rrRatio: 1 });

  const c = screener.concentration(rows);
  assert.strictEqual(c.topN, 10);
  assert.strictEqual(c.topSector.key, 'XLK');
  assert.strictEqual(c.topSector.count, 7, '版塊優先的前十有 7 檔來自 XLK');
  assert.strictEqual(c.scoreSortChanged, 3, '改按評分排序會換掉 3 檔');
  assert.ok(/XLK/.test(c.note) && /變動/.test(c.note), 'note 必須可直接顯示給使用者');
  assert.ok(/7 檔/.test(c.note) && /3 檔/.test(c.note), 'note 要帶真實數字，不能是模板字串');
});

t('G5 concentration 空輸入回 null', () => {
  assert.strictEqual(screener.concentration([]), null);
  assert.strictEqual(screener.concentration(null), null);
});

t('G6 concentration 均勻分佈時仍給出正確的最高集中版塊', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({ symbol: `A${i}`, sector: 'XLK', sectorRank: 1, score: 70, distAtr: 0, rrRatio: 1 });
  for (let i = 0; i < 5; i++) rows.push({ symbol: `B${i}`, sector: 'XLI', sectorRank: 2, score: 70, distAtr: 0, rrRatio: 1 });
  const c = screener.concentration(rows);
  assert.strictEqual(c.topSector.count, 5);
  assert.strictEqual(c.distribution.length, 2);
});

/* ============================================================
   H. screen() 的版塊模式整合
   ============================================================ */

/** 造一個假的 analyzer，回傳固定的分析結果。 */
function fakeAnalyzer(scoreMap) {
  const calls = [];
  return {
    calls,
    async analyze(sym) {
      calls.push(sym);
      const score = scoreMap[sym] != null ? scoreMap[sym] : 60;
      return {
        meta: { symbol: sym, name: sym, market: 'us', price: 100 },
        score,
        verdict: 'watch-buy',
        snapshot: { price: 100, atr: 2, atrPct: 2, changePct: 1, volume: { vol20: 1e6 } },
        buyZone: { lower: 96, upper: 98, stopLoss: 92, target: 110 },
        backtest: { samples: 100, horizons: { 20: { winRate: 0.6 } } },
        rationale: [],
      };
    },
  };
}

async function ta(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, msg: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

(async () => {
  await ta('H1 sortBy=sector 但無 sectorMeta → 明確退回評分排序並說明', async () => {
    // 「看起來有用版塊、其實沒有」是最難察覺的失敗模式，必須留下痕跡。
    const analyzer = fakeAnalyzer({ AAPL: 80, MSFT: 70 });
    const out = await screener.screen(
      { analyzer, symbols: ['AAPL', 'MSFT'] },
      { sortBy: 'sector', market: 'all' },
      { concurrency: 2, budgetMs: 5000 }
    );
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.opts.sortBy, 'score', '必須退回 score，不能留在 sector');
    assert.ok(out.stats.notes.some((n) => /退回/.test(n)), '必須在 notes 說明已退回');
  });

  await ta('H2 有 sectorMeta 時，四鍵排序生效且欄位注入', async () => {
    const analyzer = fakeAnalyzer({ AAPL: 90, CAT: 70 });
    const meta = new Map([
      ['AAPL', { key: 'XLK', label: '資訊科技', rank: 2, strengthScore: 80, quadrant: 'leading' }],
      ['CAT', { key: 'XLI', label: '工業', rank: 1, strengthScore: 78, quadrant: 'leading' }],
    ]);
    const out = await screener.screen(
      { analyzer, symbols: ['AAPL', 'CAT'], sectorMeta: meta },
      { sortBy: 'sector', market: 'all' },
      { concurrency: 2, budgetMs: 5000 }
    );
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.rows.map((r) => r.symbol), ['CAT', 'AAPL'],
      '版塊名次 1 的 CAT 應排在評分較高的 AAPL 之前');
    assert.strictEqual(out.rows[0].sector, 'XLI');
    assert.strictEqual(out.rows[0].sectorRank, 1);
    assert.strictEqual(out.stats.sortLabel, '版塊優先');
  });

  await ta('H3 版塊模式會產出集中度 stats', async () => {
    const analyzer = fakeAnalyzer({ AAPL: 90, MSFT: 85, CAT: 70 });
    const meta = new Map([
      ['AAPL', { key: 'XLK', rank: 1 }],
      ['MSFT', { key: 'XLK', rank: 1 }],
      ['CAT', { key: 'XLI', rank: 2 }],
    ]);
    const out = await screener.screen(
      { analyzer, symbols: ['AAPL', 'MSFT', 'CAT'], sectorMeta: meta },
      { sortBy: 'sector', market: 'all' },
      { concurrency: 2, budgetMs: 5000 }
    );
    assert.ok(out.stats.concentration, '版塊模式必須附集中度');
    assert.strictEqual(out.stats.concentration.topSector.key, 'XLK');
  });

  await ta('H4 非版塊模式不算集中度（不產生恆為 0 的噪音）', async () => {
    const analyzer = fakeAnalyzer({ AAPL: 90 });
    const out = await screener.screen(
      { analyzer, symbols: ['AAPL'] },
      { market: 'all' },
      { concurrency: 2, budgetMs: 5000 }
    );
    assert.strictEqual(out.stats.concentration, null);
  });

  console.log(`\n=== 結果：${pass} 通過 / ${fail} 失敗 ===\n`);
  if (fail) {
    failures.forEach((f) => console.log(`  ✗ ${f.name}\n      ${f.msg}`));
    process.exit(1);
  }
})();
