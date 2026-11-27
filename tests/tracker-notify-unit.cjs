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

/* ── ⑤-b 等待買入段落（使用者明確要求：要看到買入價位） ── */

ok('等待買入段落會列出代碼與買入價區間', async () => {
  const tg = tgStub();
  const recs = [
    rec({ symbol: 'P0', pickDate: '2026-11-10', buyLow: 9, buyHigh: 10 }),
    rec({ symbol: 'P1', pickDate: '2026-11-10', buyLow: 78.98, buyHigh: 80.37, currency: 'HKD' }),
  ];
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  const msg = pv.messages[0];

  assert.ok(msg.includes('等待買入'), `應有等待買入段落：${msg}`);
  assert.ok(msg.includes('（2 檔）'), `段落標題應帶檔數：${msg}`);
  assert.ok(msg.includes('P0'), '應列出 P0');
  assert.ok(msg.includes('P1'), '應列出 P1');
  // 關鍵：買入價要出現，而且要帶幣別（否則不知道是 HK$ 還是 US$）
  assert.ok(msg.includes('買入 US$9.00 ~ 10.00'), `應顯示 USD 買區：${msg}`);
  assert.ok(msg.includes('買入 HK$78.98 ~ 80.37'), `應顯示 HKD 買區：${msg}`);
});

ok('等待買入的單一價位（buyLow===buyHigh）不顯示區間符號', async () => {
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([rec({ symbol: 'ONE', pickDate: '2026-11-10', buyLow: 12, buyHigh: 12 })]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.ok(pv.messages[0].includes('買入 US$12.00'), pv.messages[0]);
  assert.ok(!pv.messages[0].includes('US$12.00 ~'), '單一價位不該出現 ~');
});

ok('等待買入不與今日新推介重複列同一檔', async () => {
  const tg = tgStub();
  // 今天才建立、仍是 pending：會同時符合「今日新推介」與「等待買入」
  const n = N.createNotifier(
    { tracker: trackerStub([rec({ symbol: 'TODAY', pickDate: '2026-11-20' })]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  const msg = pv.messages[0];
  assert.ok(msg.includes('今日新推介'), msg);
  assert.ok(
    !msg.includes('等待買入'),
    `今日新推介已列過，等待買入段落不該出現（否則同一檔講兩次）：${msg}`,
  );
});

ok('等待買入按分數由高到低排（最值得掛單的排前面）', async () => {
  const tg = tgStub();
  const recs = [
    rec({ symbol: 'LOW', pickDate: '2026-11-10', score: 10 }),
    rec({ symbol: 'HIGH', pickDate: '2026-11-10', score: 90 }),
    rec({ symbol: 'MID', pickDate: '2026-11-10', score: 50 }),
  ];
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const msg = n.preview('2026-11-20').messages[0];
  const iHigh = msg.indexOf('HIGH');
  const iMid = msg.indexOf('MID');
  const iLow = msg.indexOf('LOW');
  assert.ok(iHigh < iMid && iMid < iLow,
    `排序應為 HIGH→MID→LOW，實際位置 ${iHigh}/${iMid}/${iLow}`);
});

ok('等待買入超過上限時只列前幾檔，並交代還有幾檔未列出', async () => {
  const tg = tgStub();
  const recs = [];
  for (let i = 0; i < 15; i += 1) {
    recs.push(rec({ symbol: `P${i}`, pickDate: '2026-11-10', score: 100 - i }));
  }
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00'), maxPending: 12 },
  );
  const msg = n.preview('2026-11-20').messages[0];

  // 標題要看得出總數與被省略的數量，否則使用者以為只有 12 檔
  assert.ok(msg.includes('（15 檔，另有 3 檔未列出）'), `標題應交代省略數量：${msg}`);
  // 前 12 檔要列出，後 3 檔不列
  for (let i = 0; i < 12; i += 1) assert.ok(msg.includes(`P${i}`), `應列出 P${i}`);
  for (let i = 12; i < 15; i += 1) assert.ok(!msg.includes(`P${i}`), `不應列出 P${i}`);
});

ok('等待買入的公司名要轉義（否則整則訊息 400 送不出去）', async () => {
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([rec({ symbol: 'T', name: 'AT&T <holdings>', pickDate: '2026-11-10' })]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const msg = n.preview('2026-11-20').messages[0];
  assert.ok(msg.includes('AT&amp;T'), `& 應轉義：${msg}`);
  assert.ok(msg.includes('&lt;holdings&gt;'), `< > 應轉義：${msg}`);
  assert.ok(!msg.includes('AT&T <'), '不應留下未轉義的原字串');
});

ok('preview 帶出會畫圖的股票清單（讓使用者知道會收到幾張圖）', async () => {
  const tg = tgStub();
  const recs = [
    holding({ symbol: 'HELD', pickDate: '2026-11-10' }),
    rec({ symbol: 'NEW', pickDate: '2026-11-20' }),
    rec({ symbol: 'WAIT', pickDate: '2026-11-10' }),   // 等待買入 → 不畫圖
  ];
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const pv = n.preview('2026-11-20');
  assert.deepStrictEqual(
    pv.chartTargets.map((t) => t.symbol),
    ['HELD', 'NEW'],
    '只畫持倉與今日新推介，等待買入不畫；持倉優先',
  );
  assert.deepStrictEqual(pv.chartTargets.map((t) => t.tag), ['持倉', '新推介']);
});

ok('chartTargets 對同一檔去重（防禦性：帳本重複或未來放寬分組時不會發兩張）', async () => {
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ pickDate: '2026-11-10' })]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );

  /* 這個去重目前走不到：positionRows 要求 pickDate !== dateKey，
     todayRows 要求 ===，兩邊天生互斥，所以 assemble() 不會產出重疊的料。
     但它仍是必要的防禦——帳本裡同一檔被記兩次（重跑、人工補資料）
     就會同時出現在兩邊。因此直接餵重疊的 built 給 chartTargets 驗證合約，
     而不是靠 assemble() 的輸出（那樣測到的是分組，不是去重）。 */
  const dupHolding = holding({ symbol: 'DUP', pickDate: '2026-11-10' });
  const dupToday = rec({ symbol: 'DUP', pickDate: '2026-11-20' });
  const targets = n.chartTargets({
    positionRows: [dupHolding],
    todayRows: [dupToday],
    pendingRows: [],
  });

  assert.strictEqual(targets.length, 1, `同一檔只該畫一次，實際 ${targets.length}`);
  assert.strictEqual(targets[0].record.symbol, 'DUP');
  assert.strictEqual(targets[0].tag, '持倉', '持倉優先，標籤應為持倉');
});

ok('assemble 的分組天生互斥（持倉與今日新推介不會重疊）', async () => {
  const tg = tgStub();
  // 今天建立且已成交 → 只算今日新推介；不能同時被當成持倉
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ symbol: 'TODAY', pickDate: '2026-11-20' })]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const built = n.assemble('2026-11-20');
  assert.deepStrictEqual(built.todayRows.map((r) => r.symbol), ['TODAY']);
  assert.deepStrictEqual(built.positionRows.map((r) => r.symbol), []);
});

ok('maxCharts 上限生效（避免一次跳十幾則通知）', async () => {
  const tg = tgStub();
  const recs = [];
  for (let i = 0; i < 9; i += 1) {
    recs.push(holding({ symbol: `H${i}`, pickDate: '2026-11-10' }));
  }
  const n = N.createNotifier(
    { tracker: trackerStub(recs), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00'), maxCharts: 3 },
  );
  assert.strictEqual(n.preview('2026-11-20').chartTargets.length, 3);
});

ok('maxCharts=0 時完全不畫圖', async () => {
  const tg = tgStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ pickDate: '2026-11-10' })]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00'), maxCharts: 0 },
  );
  assert.strictEqual(n.preview('2026-11-20').chartTargets.length, 0);
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

/* ── ⑦ K 線圖推送 ─────────────────────────────────────── */

console.log('\n[7] K 線圖推送\n');

/** 帶 sendPhoto 的 telegram stub */
function tgPhotoStub(opts) {
  const o = opts || {};
  const t = tgStub(opts);
  t.photos = [];
  t.sendPhoto = async (png, caption) => {
    t.photos.push({ png, caption });
    if (o.failPhoto) return { ok: false, mode: 'error', error: o.failPhoto };
    return { ok: true, mode: 'captured' };
  };
  return t;
}

/** 假的行情來源：回傳一段遞增的 K 線 */
function dsStub(opts) {
  const o = opts || {};
  return {
    calls: [],
    async chart(symbol, range, interval) {
      this.calls.push({ symbol, range, interval });
      if (o.fail) throw new Error(o.fail);
      if (o.empty) return { candles: [] };
      const n = o.bars || 30;
      const candles = [];
      for (let i = 0; i < n; i += 1) {
        const base = 100 + i;
        candles.push({
          t: Date.parse('2026-09-01') + i * 86400000,
          o: base,
          h: base + 1,
          l: base - 1,
          c: base + 0.5,
          v: 1000,
        });
      }
      return { candles };
    },
  };
}

ok('有 datasource 時會為持倉股票發一張 K 線圖', async () => {
  const tg = tgPhotoStub();
  const ds = dsStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ symbol: 'HELD', pickDate: '2026-11-10' })]), telegram: tg, datasource: ds },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(tg.photos.length, 1, '應送出 1 張圖');
  assert.strictEqual(r.charts.length, 1);
  assert.strictEqual(r.charts[0].symbol, 'HELD');
  assert.strictEqual(r.charts[0].ok, true);
  assert.strictEqual(r.chartsOk, 1);
  // 真的是 PNG（簽名正確），不是空 buffer
  assert.strictEqual(tg.photos[0].png.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(r.charts[0].bytes > 1000, `圖應有合理大小，實際 ${r.charts[0].bytes}`);
});

ok('圖說只放關鍵價位，且不超過 Telegram 的 1024 上限', async () => {
  const tg = tgPhotoStub();
  const n = N.createNotifier(
    {
      tracker: trackerStub([holding({ symbol: 'HELD', pickDate: '2026-11-10', name: 'A'.repeat(200) })]),
      telegram: tg,
      datasource: dsStub(),
    },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  await n.push({});
  const cap = tg.photos[0].caption;
  assert.ok(cap.includes('買區'), `圖說應有買區：${cap}`);
  assert.ok(cap.includes('止賺'), `圖說應有止賺：${cap}`);
  assert.ok(cap.includes('止蝕'), `圖說應有止蝕：${cap}`);
  assert.ok(cap.length <= 1024, `圖說不得超過 1024 字，實際 ${cap.length}`);
});

ok('畫圖失敗不讓整天推送失敗（否則隔天會重推文字）', async () => {
  const tg = tgPhotoStub();
  const ds = dsStub({ fail: '行情 API 掛了' });
  const stateFile = tmpState();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ symbol: 'HELD', pickDate: '2026-11-10' })]), telegram: tg, datasource: ds },
    { stateFile, nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});

  assert.strictEqual(r.ok, true, '文字送達就算成功，不該因畫圖失敗而 ok:false');
  assert.strictEqual(r.chartsOk, 0);
  assert.strictEqual(r.charts[0].ok, false);
  assert.ok(/行情 API 掛了/.test(r.charts[0].error), `應保留失敗原因：${r.charts[0].error}`);

  // 關鍵：已標記已推。否則明天（同一發送日）會把文字再送一次
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(st.sent['2026-11-20'], '文字成功就應標記已推');
});

ok('sendPhoto 本身失敗也只記在 charts 裡，不影響 ok', async () => {
  const tg = tgPhotoStub({ failPhoto: 'photo too large' });
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ symbol: 'HELD', pickDate: '2026-11-10' })]), telegram: tg, datasource: dsStub() },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.charts[0].ok, false);
  assert.strictEqual(r.charts[0].error, 'photo too large');
});

ok('文字就失敗時不發圖（省下無謂的失敗請求）', async () => {
  const tg = tgPhotoStub({ failOn: () => 'token 失效' });
  const ds = dsStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ symbol: 'HELD', pickDate: '2026-11-10' })]), telegram: tg, datasource: ds },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(tg.photos.length, 0, '文字沒送出就不該發圖');
  assert.strictEqual(ds.calls.length, 0, '也不該去抓行情');
});

ok('charts:false 可明確關閉附圖', async () => {
  const tg = tgPhotoStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ symbol: 'HELD', pickDate: '2026-11-10' })]), telegram: tg, datasource: dsStub() },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({ charts: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(tg.photos.length, 0);
});

ok('沒有注入 datasource 時照樣推送文字，只是不附圖', async () => {
  const tg = tgPhotoStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ symbol: 'HELD', pickDate: '2026-11-10' })]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.strictEqual(r.ok, true, '畫圖是加分項，不該因缺少行情來源而推送失敗');
  assert.strictEqual(tg.photos.length, 0);
  assert.strictEqual(r.chartsOk, 0);
});

ok('行情回空時不崩，只記錄查無資料', async () => {
  const tg = tgPhotoStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ symbol: 'HELD', pickDate: '2026-11-10' })]), telegram: tg, datasource: dsStub({ empty: true }) },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const r = await n.push({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.charts[0].ok, false);
  assert.ok(/行情/.test(r.charts[0].error), r.charts[0].error);
  assert.strictEqual(tg.photos.length, 0);
});

ok('chartFor 用對的參數抓行情（6mo / 1d）', async () => {
  const tg = tgPhotoStub();
  const ds = dsStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({ symbol: 'HELD', pickDate: '2026-11-10' })]), telegram: tg, datasource: ds },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  await n.push({});
  assert.deepStrictEqual(ds.calls[0], { symbol: 'HELD', range: '6mo', interval: '1d' });
});

ok('K 線圖會畫上該檔的買區／止賺／止蝕參考線', async () => {
  const tg = tgPhotoStub();
  // K 線在 100~130 之間，參考線放在區間內才畫得出來
  const r = holding({
    symbol: 'HELD',
    pickDate: '2026-11-10',
    buyLow: 105,
    buyHigh: 108,
    stopPrice: 95,
    targetPrice: 125,
  });
  const n = N.createNotifier(
    { tracker: trackerStub([r]), telegram: tg, datasource: dsStub() },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  await n.push({});
  // 用圖說確認參考線的數值有進到圖裡（圖說與圖共用同一組 pick）
  const cap = tg.photos[0].caption;
  assert.ok(cap.includes('105.00') && cap.includes('108.00'), `買區應為 105/108：${cap}`);
  assert.ok(cap.includes('125.00'), `止賺應為 125：${cap}`);
  assert.ok(cap.includes('95.00'), `止蝕應為 95：${cap}`);
});

ok('status 回報圖表設定（讓使用者知道會收幾張圖）', async () => {
  const tg = tgPhotoStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({})]), telegram: tg, datasource: dsStub() },
    { stateFile: tmpState(), maxCharts: 4, chartBars: 45, nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  const s = n.status();
  assert.strictEqual(s.charts.enabled, true);
  assert.strictEqual(s.charts.maxCharts, 4);
  assert.strictEqual(s.charts.bars, 45);
});

ok('沒有 datasource 時 status 說圖表未啟用', async () => {
  const tg = tgPhotoStub();
  const n = N.createNotifier(
    { tracker: trackerStub([holding({})]), telegram: tg },
    { stateFile: tmpState(), nowFn: () => Date.parse('2026-11-20T10:00:00+08:00') },
  );
  assert.strictEqual(n.status().charts.enabled, false);
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
