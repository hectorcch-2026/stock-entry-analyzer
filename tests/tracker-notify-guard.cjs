'use strict';

/**
 * /api/tracker?notify=1 的存取控制 —— 真的啟動一個伺服器來打，不 mock。
 *
 * 為什麼需要這個測試：
 *   這個端點會**真的發一則 Telegram 訊息到使用者的手機**。它過去的寫法是
 *
 *       if (token && String(q.token) !== token) → 403
 *
 *   也就是「沒設 token 就等於不需要 token」。這個加法守衛在某次探測中
 *   實際把訊息推到了手機上 —— 沒有密碼的門等於沒鎖門。
 *
 *   這類 bug 無法用單元測試抓到：守衛長在路由裡，而路由從來沒被執行過。
 *   所以這裡改用黑箱：spawn 一個真的 server.js，用真的 HTTP 打它，
 *   並且**用假的 bot token**，讓「萬一漏出去」也只會打到 Telegram 的
 *   401，而不是使用者的聊天室。
 *
 * 為什麼用假 token 而不是拔掉 token：
 *   拔掉 token 就變成「有沒有設定」的另一種測試，掩蓋了真正的行為。
 *   假 token 能證明「守衛有擋住、沒有呼叫到發送」。
 *   判定依據是回應：被擋下時 response 不會有 notify 欄位。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? '\n      ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
  }
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 20000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* 非 JSON 就留 null */ }
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('請求逾時')); });
    req.on('error', reject);
  });
}

/** 啟動一個乾淨的 server.js 子進程，等它真的能回應才回傳。 */
async function boot(env) {
  const port = 5100 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port), ENABLE_INPROCESS_CRON: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });

  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`伺服器提前結束（code ${child.exitCode}）：\n${log}`);
    try {
      const r = await get(port, '/api/health');
      if (r.status === 200) break;
    } catch (e) { /* 還沒起來，繼續等 */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`伺服器 30 秒內沒有回應：\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { port, child, log: () => log };
}

function shutdown(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* 已死 */ } resolve(); }, 5000);
  });
}

(async () => {
  console.log('\n[1] 未設定 PICKS_TOKEN：手動推送必須拒絕（fail-closed）');

  // 用假 token 覆蓋掉真實金鑰，避免任何漏網之魚打到使用者的手機
  const FAKE = '123456789:FAKE-TOKEN-FOR-GUARD-TEST';
  let srv = await boot({
    PICKS_TOKEN: '',
    TELEGRAM_BOT_TOKEN: FAKE,
    TELEGRAM_CHAT_ID: '1',
    TRACKER_TELEGRAM: '1',
  });

  try {
    const r = await get(srv.port, '/api/tracker?notify=1');
    ok('未設 token 時回 403', r.status === 403, `實際 ${r.status}`);
    ok('錯誤碼為 NOT_CONFIGURED', Boolean(r.json && r.json.error && r.json.error.code === 'NOT_CONFIGURED'),
      JSON.stringify(r.json && r.json.error));
    ok('提示訊息說明了要怎麼啟用',
      Boolean(r.json && r.json.error && /PICKS_TOKEN/.test(String(r.json.error.hint || ''))),
      String(r.json && r.json.error && r.json.error.hint));
    // 最關鍵的一條：被擋下時**完全不能有** notify 欄位，代表沒走到 push()
    ok('被擋下時不含 notify 結果（證明沒有真的發送）', Boolean(r.json) && !('notify' in r.json),
      r.json ? Object.keys(r.json).join(', ') : 'no json');

    const r2 = await get(srv.port, '/api/tracker?notify=1&token=anything');
    ok('未設 token 時，帶任意 token 也一樣擋', r2.status === 403,
      `實際 ${r2.status}`);

    // 對照組：唯讀端點不能連帶被鎖住，否則 Dashboard 會壞
    const r3 = await get(srv.port, '/api/tracker/status');
    ok('唯讀 status 端點仍然可用', r3.status === 200, `實際 ${r3.status}`);
    const r4 = await get(srv.port, '/api/tracker/status?notifyPreview=1');
    ok('預覽端點仍然可用（不送出，不需 token）', r4.status === 200, `實際 ${r4.status}`);
  } finally {
    await shutdown(srv.child);
  }

  console.log('\n[2] 設定了 PICKS_TOKEN：錯的擋、對的才放行');

  const TOKEN = 'unit-test-token-' + Date.now();
  srv = await boot({
    PICKS_TOKEN: TOKEN,
    TELEGRAM_BOT_TOKEN: FAKE,
    TELEGRAM_CHAT_ID: '1',
    TRACKER_TELEGRAM: '1',
  });

  try {
    const wrong = await get(srv.port, '/api/tracker?notify=1&token=nope');
    ok('token 錯誤回 403', wrong.status === 403, `實際 ${wrong.status}`);
    ok('錯誤碼為 FORBIDDEN',
      Boolean(wrong.json && wrong.json.error && wrong.json.error.code === 'FORBIDDEN'),
      JSON.stringify(wrong.json && wrong.json.error));
    ok('token 錯誤時沒有發出任何訊息', Boolean(wrong.json) && !('notify' in wrong.json),
      wrong.json ? Object.keys(wrong.json).join(', ') : 'no json');

    const missing = await get(srv.port, '/api/tracker?notify=1');
    ok('未帶 token 回 403', missing.status === 403, `實際 ${missing.status}`);

    /* 正確 token：這裡會真的走到 push()。
       因為 bot token 是假的，Telegram 會回 401，所以結果應該是
       「有 notify 欄位，但 ok:false」——這正是我們要的：
       證明守衛放行了、而訊息沒有送達任何人。 */
    const right = await get(srv.port, `/api/tracker?notify=1&token=${TOKEN}`);
    ok('正確 token 會放行並實際執行推送', right.status === 200, `實際 ${right.status}`);
    ok('回應含 notify 結果', Boolean(right.json && right.json.notify),
      right.json ? Object.keys(right.json).join(', ') : 'no json');
    ok('假 bot token 導致發送失敗（證明訊息沒送到任何人手上）',
      Boolean(right.json && right.json.notify && right.json.notify.ok === false),
      right.json && right.json.notify ? `ok=${right.json.notify.ok} error=${right.json.notify.error}` : 'n/a');
  } finally {
    await shutdown(srv.child);
  }

  console.log(`\n=== 存取控制：${pass} 通過 / ${fail} 失敗 ===`);
  if (fail) process.exit(1);
})().catch((e) => {
  console.error('測試異常：', e && e.stack || e);
  process.exit(1);
});
