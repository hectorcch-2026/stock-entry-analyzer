#!/usr/bin/env node
'use strict';

/**
 * 標的池規則測試（美股限定、恰好 500 檔、排除中概股）
 *
 * 為什麼這些測試要「同時」驗證正向與負向：
 *   像「恰好 500 檔」這種斷言，只要池子是空的、或任何錯誤讓它變成 500，
 *   都會通過。所以每一個正向斷言旁邊都要有「它不會意外通過」的證據：
 *   例如池子裡確實有 AAPL（證明不是空集合），也確實沒有 BABA
 *   （證明排除規則真的有作用，而不是資料本來就少）。
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const pool = require('../lib/pool');
const screener = require('../lib/screener');

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

console.log('\n=== 標的池規則 ===\n');

/* ---------- 快照檔本身 ---------- */

t('A1 快照檔存在且可解析', () => {
  assert.ok(fs.existsSync(pool.SNAPSHOT_FILE), '找不到 lib/pool-us-500.json');
  const snap = JSON.parse(fs.readFileSync(pool.SNAPSHOT_FILE, 'utf8'));
  assert.strictEqual(snap.schemaVersion, 1);
  assert.ok(Array.isArray(snap.symbols));
});

t('A2 快照恰好 500 檔', () => {
  const snap = JSON.parse(fs.readFileSync(pool.SNAPSHOT_FILE, 'utf8'));
  assert.strictEqual(snap.symbols.length, 500, `實際 ${snap.symbols.length} 檔`);
});

t('A3 快照無重複代碼', () => {
  const snap = JSON.parse(fs.readFileSync(pool.SNAPSHOT_FILE, 'utf8'));
  const syms = snap.symbols.map((x) => x.symbol);
  assert.strictEqual(new Set(syms).size, syms.length, '存在重複代碼');
});

t('A4 快照全部是美股格式（無 .HK）', () => {
  const snap = JSON.parse(fs.readFileSync(pool.SNAPSHOT_FILE, 'utf8'));
  const hk = snap.symbols.filter((x) => /\.HK$/i.test(x.symbol));
  assert.strictEqual(hk.length, 0, `含港股：${hk.map((x) => x.symbol).join(',')}`);
});

t('A5 快照不含任何中概股代碼', () => {
  const snap = JSON.parse(fs.readFileSync(pool.SNAPSHOT_FILE, 'utf8'));
  const hit = snap.symbols.filter((x) => pool.CHINA_ADR.has(pool.normalizeTicker(x.symbol)));
  assert.strictEqual(hit.length, 0, `仍有中概股：${hit.map((x) => x.symbol).join(',')}`);
});

t('A6 快照不含名稱帶中國字樣的標的', () => {
  const snap = JSON.parse(fs.readFileSync(pool.SNAPSHOT_FILE, 'utf8'));
  const hit = snap.symbols.filter((x) => pool.CHINA_NAME_RE.test(x.name || ''));
  assert.strictEqual(hit.length, 0, `名稱命中：${hit.map((x) => x.symbol).join(',')}`);
});

t('A7 同一公司第二類股只留一個（Alphabet 留 GOOGL）', () => {
  const snap = JSON.parse(fs.readFileSync(pool.SNAPSHOT_FILE, 'utf8'));
  const syms = new Set(snap.symbols.map((x) => x.symbol));
  assert.ok(syms.has('GOOGL'), '應保留 GOOGL');
  assert.ok(!syms.has('GOOG'), '不應同時保留 GOOG（同一公司 C 股）');
  assert.ok(syms.has('FOXA') && !syms.has('FOX'), 'Fox 應留 FOXA 而非 FOX');
  assert.ok(syms.has('NWSA') && !syms.has('NWS'), 'News Corp 應留 NWSA 而非 NWS');
});

t('A8 兩份中概股名單一致（腳本與執行期不可漂移）', () => {
  /*
   * 名單刻意寫兩份：一份在 build-pool.js（產生快照時用）、一份在 pool.js
   * （執行期閘門用）。分開寫是為了避免「改了名單卻沒生效」的誤會 ——
   * 快照是靜態檔。但分開寫就有漂移風險，所以用這條測試釘住兩者相等。
   * 只改一份，這裡就會紅。
   */
  const builder = require('../scripts/build-pool.js');
  const a = [...pool.CHINA_ADR].sort();
  const b = [...new Set(builder.CHINA_ADR.map(pool.normalizeTicker))].sort();
  assert.deepStrictEqual(b, a, 'build-pool.js 與 pool.js 的中概股名單不一致');
});

t('A9 中概股名單本身無重複項', () => {
  const builder = require('../scripts/build-pool.js');
  assert.strictEqual(
    builder.CHINA_ADR.length,
    new Set(builder.CHINA_ADR).size,
    'build-pool.js 的 CHINA_ADR 有重複項（會讓「排除 N 檔」的數字失真）'
  );
});

/* ---------- pool 模組行為 ---------- */

t('B1 all() 回 500 檔', () => {
  assert.strictEqual(pool.all().length, 500);
});

t('B2 all() 包含代表性美股（證明不是空集合）', () => {
  const a = pool.all();
  ['AAPL', 'MSFT', 'NVDA', 'JPM', 'XOM'].forEach((s) => {
    assert.ok(a.includes(s), `缺少 ${s}`);
  });
});

t('B3 類股代碼以連字號表示（BRK-B，非 BRK.B）', () => {
  const a = pool.all();
  assert.ok(a.includes('BRK-B'), 'BRK-B 應存在');
  assert.ok(!a.includes('BRK.B'), '不應存在點號形式 BRK.B');
});

t('B4 byMarket(us) 與 all() 相同', () => {
  assert.deepStrictEqual(pool.byMarket('us'), pool.all());
});

t('B5 byMarket(hk) 回空陣列（母體不含港股）', () => {
  assert.deepStrictEqual(pool.byMarket('hk'), []);
});

t('B6 summary 回報 total=500、hk=0', () => {
  const s = pool.summary();
  assert.strictEqual(s.total, 500);
  assert.strictEqual(s.hk, 0);
  assert.strictEqual(s.us, 500);
});

t('B7 summary 標註中概股排除數（即使為 0 也要有欄位）', () => {
  const s = pool.summary();
  assert.ok(s.excluded && s.excluded.chinaAdr, '缺少 excluded.chinaAdr');
  assert.strictEqual(typeof s.excluded.chinaAdr.count, 'number');
  assert.ok(typeof s.adjustedNote === 'string' && s.adjustedNote.length > 0);
  assert.ok(/中概股/.test(s.adjustedNote), '調整說明須提到中概股');
});

t('B8 summary 未處於 degraded 模式', () => {
  assert.strictEqual(pool.summary().degraded, false, '母體快照應可正常載入');
});

/* ---------- 閘門本身 ---------- */

t('C1 enforceUniverse 移除中概股', () => {
  const r = pool.enforceUniverse(['AAPL', 'BABA', 'MSFT', 'PDD']);
  assert.deepStrictEqual(r.kept, ['AAPL', 'MSFT']);
  assert.deepStrictEqual(r.removed, ['BABA', 'PDD']);
});

t('C2 enforceUniverse 移除港股', () => {
  const r = pool.enforceUniverse(['AAPL', '0700.HK', '9988.HK']);
  assert.deepStrictEqual(r.kept, ['AAPL']);
  assert.deepStrictEqual(r.removedHK, ['0700.HK', '9988.HK']);
});

t('C3 enforceUniverse 去重（大小寫視為同一檔）', () => {
  const r = pool.enforceUniverse(['AAPL', 'aapl', 'AaPl']);
  assert.deepStrictEqual(r.kept, ['AAPL']);
});

t('C4 enforceUniverse 不把去重算成「排除中概股」', () => {
  const r = pool.enforceUniverse(['AAPL', 'AAPL']);
  assert.strictEqual(r.removed.length, 0, '去重不應計入中概股排除數');
});

t('C5 enforceUniverse 保留港股點號（不可變成 0700-HK）', () => {
  const r = pool.enforceUniverse(['0700.HK']);
  assert.deepStrictEqual(r.removedHK, ['0700.HK'], '.HK 必須原樣保留，否則會被誤判為美股');
});

t('C6 normalizeTicker 把 BRK.B 轉為 BRK-B', () => {
  assert.strictEqual(pool.normalizeTicker('BRK.B'), 'BRK-B');
});

t('C7 名稱比對不會誤傷 Dominion / Union Pacific（詞邊界）', () => {
  assert.strictEqual(pool.CHINA_NAME_RE.test('Dominion Energy'), false, 'Dominion 不應命中');
  assert.strictEqual(pool.CHINA_NAME_RE.test('Union Pacific Corporation'), false, 'Union Pacific 不應命中');
  assert.strictEqual(pool.CHINA_NAME_RE.test('Yum! Brands'), false, 'Yum 不應命中');
  assert.strictEqual(pool.CHINA_NAME_RE.test('China Mobile Ltd'), true, '真正的中國公司應命中');
});

/* ---------- 篩選器層的強制執行 ---------- */

console.log('\n=== 篩選器強制排除 ===\n');

function mkAnalysis(sym) {
  return {
    meta: { symbol: sym, name: sym, market: /\.HK$/i.test(sym) ? 'HK' : 'US', currency: 'USD', price: 100 },
    score: 80,
    snapshot: { price: 100, atr: 2, atrPct: 2, changePct: 1, volume: { vol20: 1e6 } },
    buyZone: { lower: 95, upper: 98, stopLoss: 90, target: 110 },
    backtest: { horizons: { 20: { winRate: 0.6 } }, samples: 50 },
  };
}

async function runScreen(symbols, query) {
  const analyzed = [];
  const deps = {
    symbols,
    analyzer: {
      analyze: async (sym) => { analyzed.push(sym); return mkAnalysis(sym); },
    },
  };
  const out = await screener.screen(deps, query || { minScore: 50 }, { concurrency: 2 });
  return { out, analyzed };
}

(async () => {
  await ta('D1 中概股不會被送去分析（連上游請求都不該發生）', async () => {
    const { analyzed } = await runScreen(['AAPL', 'BABA', 'PDD']);
    assert.deepStrictEqual(analyzed.sort(), ['AAPL']);
  });

  await ta('D2 港股不會被送去分析', async () => {
    const { analyzed } = await runScreen(['AAPL', '0700.HK', '9988.HK']);
    assert.deepStrictEqual(analyzed.sort(), ['AAPL']);
  });

  await ta('D3 stats 回報中概股排除數與代碼', async () => {
    const { out } = await runScreen(['AAPL', 'BABA', 'NIO']);
    assert.strictEqual(out.stats.chinaExcluded.count, 2);
    assert.deepStrictEqual(out.stats.chinaExcluded.symbols.sort(), ['BABA', 'NIO']);
  });

  await ta('D4 stats 回報 requestedPool 與有效 pool 的差額', async () => {
    const { out } = await runScreen(['AAPL', 'BABA', '0700.HK', 'MSFT']);
    assert.strictEqual(out.stats.requestedPool, 4);
    assert.strictEqual(out.stats.pool, 2);
    assert.strictEqual(out.stats.chinaExcluded.count + out.stats.nonUsExcluded.count, 2);
  });

  await ta('D5 notes 明講「已排除中概股」與檔數', async () => {
    const { out } = await runScreen(['AAPL', 'BABA']);
    const joined = out.stats.notes.join(' ');
    assert.ok(/已排除中概股\s*1\s*檔/.test(joined), `notes 未說明：${joined}`);
  });

  await ta('D6 全為中概股時回 0 檔而不是崩潰', async () => {
    const { out, analyzed } = await runScreen(['BABA', 'PDD', 'NIO']);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.rows.length, 0);
    assert.strictEqual(analyzed.length, 0);
    assert.strictEqual(out.stats.pool, 0);
  });

  await ta('D7 正常美股仍可通過（證明排除沒有過度攔截）', async () => {
    const { out, analyzed } = await runScreen(['AAPL', 'MSFT', 'NVDA']);
    assert.strictEqual(out.rows.length, 3);
    assert.strictEqual(analyzed.length, 3);
    assert.strictEqual(out.stats.chinaExcluded.count, 0);
  });

  await ta('D8 預設 market 為 us', async () => {
    assert.strictEqual(screener.DEFAULTS.market, 'us');
  });

  await ta('D9 篩選參數未被改動（minScore/maxDistAtr 等維持原值）', async () => {
    assert.strictEqual(screener.DEFAULTS.minScore, 55);
    assert.strictEqual(screener.DEFAULTS.maxDistAtr, 3.0);
    assert.strictEqual(screener.DEFAULTS.minPrice, 1);
    assert.strictEqual(screener.DEFAULTS.maxAtrPct, 12);
    assert.strictEqual(screener.DEFAULTS.limit, 30);
    assert.strictEqual(screener.DEFAULTS.sortBy, 'score');
    assert.strictEqual(screener.DEFAULT_CONCURRENCY, 4);
    assert.strictEqual(screener.MAX_CONCURRENCY, 8);
  });

  await ta('D10 母體 500 檔全部通過閘門（不會被誤攔）', async () => {
    const r = pool.enforceUniverse(pool.all());
    assert.strictEqual(r.kept.length, 500, `閘門誤攔 ${500 - r.kept.length} 檔`);
    assert.strictEqual(r.removed.length, 0);
    assert.strictEqual(r.removedHK.length, 0);
  });

  await ta('D11 快照與 alias 的一致性：母體不含中概股別名', async () => {
    // BABA/PDD 等仍在 alias 表裡（搜尋要用），但不可出現在母體
    const alias = require('../lib/alias');
    const aliasCodes = new Set(Object.values(alias.EN).map(pool.normalizeTicker));
    const cnInAlias = ['BABA', 'PDD', 'NIO', 'BIDU'].filter((s) => aliasCodes.has(s));
    assert.ok(cnInAlias.length > 0, '前提：別名表仍保留中概股（供搜尋）');
    const inPool = cnInAlias.filter((s) => pool.all().includes(s));
    assert.strictEqual(inPool.length, 0, `母體不應含 ${inPool.join(',')}`);
  });

  console.log(`\n=== 結果：${pass} 通過 / ${fail} 失敗 ===\n`);
  if (fail) {
    failures.forEach((f) => console.log(`  ✗ ${f.name}\n      ${f.msg}`));
    process.exit(1);
  }
})();
