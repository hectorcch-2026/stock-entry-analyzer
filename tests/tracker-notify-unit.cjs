'use strict';

/**
 * lib/tracker-notify.js 單元測試（零依賴，純 node assert）
 * =======================================================
 *
 * 這一支的核心風險不是「拋錯」，而是**安靜地做錯事**：
 *   · 發送鎖失效 → 一天推幾十則 → 使用者封鎖 bot
 *   · 訊息超過 4096 → 整則 400，使用者什麼都收不到
 *   · 公司名未轉義 → 400 can't parse entities，同樣什麼都收不到
 *   · 失敗卻記成「已推」→ 那天就永遠不會再推了
 * 以上四種在程式碼上都「跑得完、不報錯」，只能靠斷言釘死。
 *
 * 全程用 stub 的 telegram（絕不連網），並注入 nowFn 控制日期。
 *
 * 執行：node tests/tracker-notify-unit.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const N = require('../lib/tracker-notify');

let pass = 0;
let fail = 0;
const failures = [];

/**
 * 先收集、後逐一 await。
 * 理由同 picks-tracker-unit：async 函式若在同步的 ok() 裡被呼叫，
 * 回傳的 Promise 會被丟掉，assert 失敗不會變成 throw，測試恆為通過。
 */
const queue = [];
function ok(name, fn) {
  queue.push({ name, fn });
}
async function runAll() {
  for (const t of queue) {
    try {
      await t.fn();
      pass += 1;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      fail += 1;
      failures.push({ name: t.name, error: e });
      console.log(`  ✗ ${t.name}\n      ${e.message}`);
    }
  }
}

/* ── 測試替身 ─────────────────────────────────────────── */

const TMP = path.join(os.tmpdir(), `tracker-notify-test-${process.pid}`);

function tmpState(name) {
  fs.mkdirSync(TMP, { recursive: true });
  return path.join(TMP, name || `st-${Math.random().toString(36).slice(2)}.json`);
}

function cleanTmp() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

/** 只做轉義、不連網的 telegram stub */
function tgStub(opts) {
  const o = opts || {};
  const sent = [];
  return {
    sent,
    escapeHtml: require('../lib/telegram').escapeHtml,
    isConfigured: () => true,
    sendText: async (text) => {
      sent.push(text);
      if (o.failOn && o.failOn(sent.length - 1, text)) {
        return { ok: false, mode: 'error', error: o.failOn(sent.length - 1, text) };
      }
      return { ok: true, mode: 'captured' };
    },
  };
}

/** 造一筆帳本記錄 */
function rec(over) {
  const r = {
    id: 'x',
    symbol: 'AAA',
    name: 'AAA Corp',
    market: 'US',
    currency: 'USD',
    pickDate: '2026-11-20',
    refPrice: 10,
    score: 50,
    buyLow: 9,
    buyHigh: 10,
    stopPrice: 8,
    targetPrice: 14,
    status: 'pending',
    entry: null,
    exit: null,
    pnl: null,
    settled: false,
  };
  return Object.assign(r, over || {});
}

/** 造一筆「已建倉、有浮動損益」的記錄 */
function holding(over) {
  return rec(Object.assign({
    status: 'holding',
    entry: { date: '2026-11-21', price: 9.5, fxRate: 1, shares: 1052, costLocal: 9994, costUsd: 10000 },
    pnl: { amountLocal: 500, amountUsd: 500, returnPct: 5, markPrice: 10, holdingDays: 3 },
  }, over || {}));
}

function trackerStub(records, summaryOver) {
  return {
    records,
    summary: () => Object.assign({
      totalPnlUsd: 0,
      counts: { holding: 0, pending: 0, closed: 0 },
      winRate: null,
      avgHoldingDays: null,
    }, summaryOver || {}),
  };
}

/** 去掉合法標籤後，不應殘留裸 & 或角括號 */
function rawAmp(text) {
  const s = text.replace(/<\/?(b|i|a)(\s[^>]*)?>/g, '');
  return /&(?!(amp|lt|gt|quot);)/.test(s);
}
function rawAngle(text) {
  const s = text.replace(/<\/?(b|i|a)(\s[^>]*)?>/g, '');
  return /[<>]/.test(s);
}

/* ── ① 日期與鎖 ──────────────────────────────────────── */

console.log('\n[1] 發送鎖：一天一次\n');

ok('同一發送日第二次呼叫會 skipped', async () => {
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-27T10:00:00+08:00') },
  );
  const a = await n.push({});
  assert.strictEqual(a.ok, true, '第一次應成功');
  assert.strictEqual(a.skipped, false);
  const b = await n.push({});
  assert.strictEqual(b.skipped, true, '第二次應被鎖擋下');
  assert.strictEqual(tg.sent.length, 1, '實際只應送出 1 則');
});

ok('跨日會再推一次（鎖不鎖死）', async () => {
  const tg = tgStub();
  const stateFile = tmpState();
  const mk = (iso) => N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: tg },
    { stateFile, nowFn: () => Date.parse(iso) },
  );
  await mk('2026-11-27T10:00:00+08:00').push({});
  const r2 = await mk('2026-11-28T10:00:00+08:00').push({});
  assert.strictEqual(r2.skipped, false, '隔天應再推');
  assert.strictEqual(tg.sent.length, 2);
});

ok('force 可覆寫鎖（手動觸發用）', async () => {
  const tg = tgStub();
  const stateFile = tmpState();
  const n = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: tg },
    { stateFile, nowFn: () => Date.parse('2026-11-27T10:00:00+08:00') },
  );
  await n.push({});
  const r = await n.push({ force: true });
  assert.strictEqual(r.skipped, false, 'force 應無視已推');
  assert.strictEqual(tg.sent.length, 2);
});

ok('鎖以「發送日」為準：今天沒有新推介也照樣推（不會整天靜默）', async () => {
  const tg = tgStub();
  // 帳本只有 11-20 的舊推介，但今天是 11-27
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ pickDate: '2026-11-20' })]) , telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-27T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.strictEqual(r.ok, true, '沒有新推介仍應成功推送');
  assert.strictEqual(r.skipped, false);
  assert.strictEqual(tg.sent.length, 1, '仍應送出持倉摘要');
  assert.ok(tg.sent[0].includes('持倉表現'), '應含持倉段落');
});

ok('TRACKER_TELEGRAM=0 時完全不推', async () => {
  const old = process.env.TRACKER_TELEGRAM;
  process.env.TRACKER_TELEGRAM = '0';
  try {
    const tg = tgStub();
    const n = N.createNotifier(
      { tracker: trackerStub([rec({})]), telegram: tg },
      { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-27T10:00:00+08:00') },
    );
    const r = await n.push({});
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(tg.sent.length, 0, '關閉時不得送出任何訊息');
  } finally {
    if (old === undefined) delete process.env.TRACKER_TELEGRAM;
    else process.env.TRACKER_TELEGRAM = old;
  }
});

ok('空帳本：明確回報，不推空訊息', async () => {
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.now() },
  );
  const r = await n.push({});
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(tg.sent.length, 0);
});

/* ── ② 香港時區 ──────────────────────────────────────── */

console.log('\n[2] 香港時區（凌晨邊界）\n');

ok('UTC 16:30 = 香港隔日 00:30，不可算成前一天', () => {
  // 2026-11-27T16:30Z → 香港 2026-11-28 00:30
  const k = N.hkDateKey(Date.parse('2026-11-27T16:30:00Z'));
  assert.strictEqual(k, '2026-11-28', `實際得到 ${k}`);
});

ok('UTC 23:59 = 香港隔日 07:59，仍算隔日', () => {
  const k = N.hkDateKey(Date.parse('2026-11-27T23:59:00Z'));
  assert.strictEqual(k, '2026-11-28', `實際得到 ${k}`);
});

ok('香港 08:00（UTC 00:00）回到同一日', () => {
  const k = N.hkDateKey(Date.parse('2026-11-28T00:00:00Z'));
  assert.strictEqual(k, '2026-11-28');
});

ok('凌晨邊界不會讓鎖失效（同一香港日只推一次）', async () => {
  const tg = tgStub();
  const stateFile = tmpState();
  /**
   * 這兩個時刻是關鍵：
   *   A：香港 2026-11-28 00:10  → UTC 2026-11-27 16:10（UTC 還在 27 日）
   *   B：香港 2026-11-28 09:00  → UTC 2026-11-28 01:00（UTC 已到 28 日）
   * 兩者是**同一個香港日**，但**不同的 UTC 日**。
   * 若鎖用 UTC 日期，B 會被當成新的一天而重複推送——
   * 這正是早班使用者每天上班前會遇到的時間點。
   */
  const a = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: tg },
    { stateFile, nowFn: () => Date.parse('2026-11-27T16:10:00Z') },
  );
  const b = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: tg },
    { stateFile, nowFn: () => Date.parse('2026-11-28T01:00:00Z') },
  );
  await a.push({});
  const r = await b.push({});
  assert.strictEqual(r.skipped, true, '同一個香港日應被鎖擋下（UTC 跨日不代表新的一天）');
  assert.strictEqual(tg.sent.length, 1, '不得因 UTC 跨日而重複推送');
});

/* ── ③ 長度與分批 ────────────────────────────────────── */

console.log('\n[3] 長度上限與分批\n');

ok('正常檔數只會產生一則，且未超過上限', async () => {
  const tg = tgStub();
  const recs = [holding({ symbol: 'A' }), rec({ symbol: 'B' }), rec({ symbol: 'C' })];
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-21T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.strictEqual(pv.messages.length, 1, '三檔應只用一則');
  assert.ok(pv.messages[0].length <= N.MAX_LEN);
});

ok('大量檔數會分批，且每一則都不超過 4096', async () => {
  const tg = tgStub();
  const recs = [];
  for (let i = 0; i < 60; i += 1) {
    recs.push(rec({
      symbol: `SYM${i}`,
      name: `Company Number ${i} Holdings International Limited`,
      pickDate: '2026-11-20',
    }));
  }
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.ok(pv.messages.length > 1, `應分批，實際 ${pv.messages.length} 則`);
  pv.messages.forEach((m, i) => {
    assert.ok(m.length <= 4096, `第 ${i + 1} 則 ${m.length} 字超過 Telegram 4096 上限`);
    assert.ok(m.length <= N.MAX_LEN, `第 ${i + 1} 則超過自訂上限 ${N.MAX_LEN}`);
  });
});

ok('分批時不會把單一檔股票切成兩半', async () => {
  const tg = tgStub();
  const recs = [];
  for (let i = 0; i < 60; i += 1) {
    recs.push(rec({
      symbol: `SYM${i}`,
      name: `Company Number ${i} Holdings International Limited`,
      pickDate: '2026-11-20',
    }));
  }
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  // 每一檔都必須「完整」出現在某一則裡（股票名＋止蝕同一則）
  for (let i = 0; i < 60; i += 1) {
    const sym = `SYM${i}`;
    const host = pv.messages.filter((m) => m.includes(`（${sym}）`));
    assert.strictEqual(host.length, 1, `${sym} 應恰好出現在一則訊息中，實際 ${host.length}`);
    assert.ok(host[0].includes('止蝕'), `${sym} 所在的那一則必須含止蝕價（不得被切斷）`);
  }
});

ok('分批後每一則都有標題，續則標「（續）」', async () => {
  const tg = tgStub();
  const recs = [];
  for (let i = 0; i < 60; i += 1) {
    recs.push(rec({ symbol: `S${i}`, name: `Long Company Name Number ${i} Limited`, pickDate: '2026-11-20' }));
  }
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.ok(pv.messages.length > 1);
  pv.messages.forEach((m, i) => {
    assert.ok(m.includes('每日推介追蹤'), `第 ${i + 1} 則缺標題`);
    if (i > 0) assert.ok(m.includes('（續）'), `第 ${i + 1} 則應標「（續）」`);
  });
});

/* ── ④ 轉義 ──────────────────────────────────────────── */

console.log('\n[4] HTML 轉義\n');

ok('公司名含 & 與角括號仍可發送', async () => {
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([
      rec({ symbol: 'T', name: 'AT&T Inc.' }),
      rec({ symbol: 'H', name: 'SK Hynix <holdings>' }),
    ]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  const all = pv.messages.join('\n');
  assert.ok(all.includes('AT&amp;T'), '應轉義為 AT&amp;T');
  pv.messages.forEach((m, i) => {
    assert.ok(!rawAmp(m), `第 ${i + 1} 則有裸 &：${m}`);
    assert.ok(!rawAngle(m), `第 ${i + 1} 則有裸角括號：${m}`);
  });
});

/* ── ⑤ 內容正確性 ────────────────────────────────────── */

console.log('\n[5] 內容正確性\n');

ok('未觸及買區的記錄顯示「等待中」', async () => {
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([rec({ status: 'pending' })]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.ok(pv.messages[0].includes('尚未觸及買區'), pv.messages[0]);
});

ok('holdingDays=0 顯示「今日買入」，不顯示「0 天」', async () => {
  const tg = tgStub();
  const h = holding({
    pickDate: '2026-11-20',
    entry: { date: '2026-11-20', price: 9.5, fxRate: 1, shares: 1052, costLocal: 9994, costUsd: 10000 },
    pnl: { amountLocal: 0, amountUsd: 0, returnPct: 0, markPrice: 9.5, holdingDays: 0 },
  });
  const n = N.createNotifier(
    { tracker: trackerStub([h]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.ok(pv.messages[0].includes('今日買入'), pv.messages[0]);
  assert.ok(!pv.messages[0].includes('持有 0 天'), '不應出現「持有 0 天」');
});

ok('holdingDays=3 顯示「持有 3 天」', async () => {
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ pickDate: '2026-11-17' })]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.ok(pv.messages[0].includes('持有 3 天'), pv.messages[0]);
});

ok('持倉中的股票會顯示當初買入價（否則無法判斷損益從何而來）', async () => {
  const tg = tgStub();
  // 買入 9.50，現價 10.00：訊息裡必須同時出現兩者才能對照
  const h = holding({
    pickDate: '2026-11-17',
    entry: { date: '2026-11-17', price: 9.5, fxRate: 1, shares: 1052, costLocal: 9994, costUsd: 10000 },
    pnl: { amountLocal: 500, amountUsd: 500, returnPct: 5, markPrice: 10, holdingDays: 3 },
  });
  const n = N.createNotifier(
    { tracker: trackerStub([h]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  const msg = pv.messages[0];
  assert.ok(msg.includes('買入 US$9.50'), `應顯示買入價 9.50：${msg}`);
  assert.ok(msg.includes('現價 US$10.00'), `應顯示現價 10.00：${msg}`);
});

ok('金額有千分位（1145.71 → 1,145.71）', async () => {
  const tg = tgStub();
  const h = holding({
    pickDate: '2026-11-17',
    pnl: { amountLocal: 1145.71, amountUsd: 1145.71, returnPct: 11.46, markPrice: 10.6, holdingDays: 3 },
  });
  const n = N.createNotifier(
    { tracker: trackerStub([h], { totalPnlUsd: 1145.71 }), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.ok(pv.messages[0].includes('1,145.71'), pv.messages[0]);
});

ok('今日新推介與持倉不重複列同一檔', async () => {
  const tg = tgStub();
  const recs = [
    holding({ symbol: 'DUP', pickDate: '2026-11-20' }),   // 今天建立且已成交
    holding({ symbol: 'OLD', pickDate: '2026-11-10' }),   // 之前建立
  ];
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.deepStrictEqual(pv.newPicks, ['DUP']);
  assert.deepStrictEqual(pv.positions, ['OLD']);
  const count = (pv.messages.join('\n').match(/（DUP）/g) || []).length;
  assert.strictEqual(count, 1, `DUP 應只出現一次，實際 ${count}`);
});

ok('較早推介仍待買入的用一行交代，不逐檔列出', async () => {
  const tg = tgStub();
  const recs = [];
  for (let i = 0; i < 7; i += 1) {
    recs.push(rec({ symbol: `P${i}`, pickDate: '2026-11-10' }));
  }
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.ok(pv.messages[0].includes('另有 7 檔較早推介仍在等待買區'), pv.messages[0]);
  // 不得逐檔列出（訊息應很短）
  assert.ok(pv.messages[0].length < 500, `不應逐檔列出，實際 ${pv.messages[0].length} 字`);
});

ok('持倉段落按損益由高到低排序', async () => {
  const tg = tgStub();
  const recs = [
    holding({ symbol: 'LOW', pickDate: '2026-11-10',
      pnl: { amountLocal: 100, amountUsd: 100, returnPct: 1, markPrice: 10, holdingDays: 5 } }),
    holding({ symbol: 'HIGH', pickDate: '2026-11-10',
      pnl: { amountLocal: 900, amountUsd: 900, returnPct: 9, markPrice: 10, holdingDays: 5 } }),
  ];
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.deepStrictEqual(pv.positions, ['HIGH', 'LOW']);
});

/* ── ⑥ 失敗處理 ──────────────────────────────────────── */

console.log('\n[6] 失敗處理\n');

ok('發送失敗不標記已推（下次會重試）', async () => {
  const tg = tgStub({ failOn: () => 'network down' });
  const stateFile = tmpState();
  const n = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: tg },
    { stateFile, nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.strictEqual(r.ok, false, '失敗應回報 ok:false');
  assert.ok(r.error, '應帶錯誤訊息');
  // 同一實例再推一次：因為沒標記已推，應再次嘗試
  const r2 = await n.push({});
  assert.strictEqual(r2.skipped, false, '失敗後不得被鎖擋下（否則永遠不會再推）');
  assert.strictEqual(tg.sent.length, 2, '應實際重試一次');
});

ok('成功才寫入狀態檔', async () => {
  const stateFile = tmpState();
  const bad = tgStub({ failOn: () => 'boom' });
  const n1 = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: bad },
    { stateFile, nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  await n1.push({});
  assert.ok(!fs.existsSync(stateFile), '失敗不應產生狀態檔');

  const good = tgStub();
  const n2 = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: good },
    { stateFile, nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  await n2.push({});
  assert.ok(fs.existsSync(stateFile), '成功應寫入狀態檔');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(st.sent['2026-11-20'], '應記錄該發送日');
});

ok('分批時某一則失敗，整批不標記已推', async () => {
  const recs = [];
  for (let i = 0; i < 60; i += 1) {
    recs.push(rec({ symbol: `S${i}`, name: `Very Long Company Name Number ${i} Limited`, pickDate: '2026-11-20' }));
  }
  const stateFile = tmpState();
  // 第二則開始失敗
  const tg = tgStub({ failOn: (i) => (i >= 1 ? 'second message failed' : null) });
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile, nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.strictEqual(r.ok, false);
  assert.ok(!fs.existsSync(stateFile), '只要有一則失敗就不應標記已推');
});

ok('狀態檔損壞時視為沒推過（寧可多推一次）', async () => {
  const stateFile = tmpState();
  fs.writeFileSync(stateFile, '{ this is not json', 'utf8');
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: tg },
    { stateFile, nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.strictEqual(r.skipped, false, '壞檔不應被當成「已推」而靜默');
  assert.strictEqual(tg.sent.length, 1);
});

ok('狀態檔只保留最近 60 天', async () => {
  const stateFile = tmpState();
  const sent = {};
  for (let i = 0; i < 70; i += 1) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    sent[d] = { at: '2026-01-01T00:00:00.000Z', messages: 1 };
  }
  fs.writeFileSync(stateFile, JSON.stringify({ sent }), 'utf8');

  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: tg },
    { stateFile, nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  await n.push({});
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(Object.keys(st.sent).length, 60, `應裁剪到 60 天，實際 ${Object.keys(st.sent).length}`);
  assert.ok(st.sent['2026-11-20'], '最新那天必須保留');
});

/* ── ⑦ status ────────────────────────────────────────── */

console.log('\n[7] status 回報\n');

ok('status 回報今日是否已推', async () => {
  const stateFile = tmpState();
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([rec({})]), telegram: tg },
    { stateFile, nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const before = n.status();
  assert.strictEqual(before.sentToday, false);
  assert.strictEqual(before.enabled, true);
  await n.push({});
  const after = n.status();
  assert.strictEqual(after.sentToday, true);
  assert.strictEqual(after.lastSent.date, '2026-11-20');
});

ok('push 結果帶出本日新推介與持倉清單', async () => {
  const tg = tgStub();
  const recs = [
    rec({ symbol: 'NEW', pickDate: '2026-11-20' }),
    holding({ symbol: 'HELD', pickDate: '2026-11-10' }),
  ];
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.deepStrictEqual(r.newPicks, ['NEW']);
  assert.deepStrictEqual(r.positions, ['HELD']);
  assert.strictEqual(r.dateKey, '2026-11-20');
});

/* ── 執行 ────────────────────────────────────────────── */

runAll().then(() => {
  cleanTmp();
  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項\n`);
  if (fail) {
    failures.forEach((f) => {
      console.log(`FAILED: ${f.name}`);
      console.log(f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 4).join('\n') : f.error);
      console.log('');
    });
    process.exit(1);
  }
});
