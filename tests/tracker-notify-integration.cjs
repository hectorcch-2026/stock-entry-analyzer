'use strict';

/**
 * 推送與每日任務的整合測試
 * =========================
 *
 * 單元測試（tracker-notify-unit.cjs）已釘死訊息內容與發送鎖。
 * 這裡補的是「接線」：
 *   · dailyRun 的步驟④ 是否真的被執行
 *   · 推送失敗會不會把整個任務標成失敗（絕對不可以）
 *
 * 第二點特別重要：若 Telegram 掛掉就讓 dailyRun 回報失敗，
 * 使用者會以為帳本沒更新而去手動重跑，反而造成重複建倉/重複計算。
 * 這種「因為通知掛了而弄壞資料」的路徑，必須有測試擋著。
 *
 * 全程用假的 runner / notifier，不連網、不開服務。
 *
 * 執行：node tests/tracker-notify-integration.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('../lib/picks-tracker');
const jobMod = require('../lib/tracker-job');

const TMP = path.join(os.tmpdir(), `tracker-notify-int-${process.pid}`);

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 建立一個不連網的 job。
 * 注意：stateFile / throttleMs 屬於 opts（第二參數），不是 deps。
 * 放錯位置不會報錯，只會「安靜地沿用預設路徑 + 預設節流」，
 * 於是 dailyRun 會被上一輪的節流擋下、根本不執行步驟④——
 * 測試就變成在驗證一個沒跑到的分支（我一開始就踩了這個坑）。
 */
function makeJob(dir, notifier) {
  const tracker = T.create({ file: path.join(dir, 'ledger.json'), capitalUsd: 10000 });
  const job = jobMod.createJob(
    {
      tracker,
      scheduler: { shouldRun: () => ({ run: false }), markRun: () => {} },
      screenDeps: {},
      runner: async () => [],
      notifier,
    },
    { stateFile: path.join(dir, 'job.json'), throttleMs: 0 },
  );
  return { tracker, job };
}

let pass = 0;
let fail = 0;
const failures = [];

async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

(async () => {
  console.log('\n推送 × 每日任務 整合\n');

  await ok('dailyRun 會執行步驟④（推送）且只推一次', async () => {
    const dir = fresh('a');
    let calls = 0;
    const notifier = {
      async push(o) {
        calls += 1;
        return { ok: true, skipped: false, dateKey: 'D', args: o };
      },
    };
    const { job } = makeJob(dir, notifier);
    const res = await job.dailyRun({});
    assert.strictEqual(res.ran, true, '任務應執行');
    assert.strictEqual(calls, 1, `推送應恰好被呼叫 1 次，實際 ${calls}`);
    assert.ok(res.notify, '結果應帶 notify 欄位');
    assert.strictEqual(res.notify.ok, true, 'notify.ok 應為 true');
  });

  await ok('推送結果會回報到 dailyRun 的結果裡', async () => {
    const dir = fresh('b');
    const notifier = {
      async push() { return { ok: true, skipped: false, dateKey: 'X', messages: [{ chars: 300 }] }; },
    };
    const { job } = makeJob(dir, notifier);
    const res = await job.dailyRun({});
    assert.strictEqual(res.notify.dateKey, 'X');
    assert.strictEqual(res.notify.messages[0].chars, 300);
  });

  await ok('推送拋錯不會讓任務失敗（否則會誘發重複計算）', async () => {
    const dir = fresh('c');
    const notifier = { async push() { throw new Error('Telegram 掛了'); } };
    const { job } = makeJob(dir, notifier);
    const res = await job.dailyRun({});
    assert.strictEqual(res.ran, true, '推送失敗時任務仍應算成功');
    assert.ok(res.notify, '仍應回報 notify');
    assert.strictEqual(res.notify.ok, false, 'notify.ok 應為 false');
    assert.ok(String(res.notify.error).includes('Telegram'), '應保留原始錯誤訊息');
  });

  await ok('沒有 notifier 時任務照常執行（向後相容）', async () => {
    const dir = fresh('d');
    const { job } = makeJob(dir, null);
    const res = await job.dailyRun({});
    assert.strictEqual(res.ran, true, '未注入 notifier 也應能執行');
    assert.strictEqual(res.notify, null, 'notify 應為 null');
  });

  await ok('推送失敗後狀態檔仍已寫入（帳本更新是核心，不受通知影響）', async () => {
    const dir = fresh('e');
    const notifier = { async push() { throw new Error('boom'); } };
    const { job } = makeJob(dir, notifier);
    await job.dailyRun({});
    const stateFile = path.join(dir, 'job.json');
    assert.ok(fs.existsSync(stateFile), '任務狀態檔應已寫入');
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(st.lastRunAt > 0, '應記錄 lastRunAt');
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項\n`);
  if (fail) {
    failures.forEach((f) => {
      console.log(`FAILED: ${f.name}`);
      console.log(f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 4).join('\n') : f.error);
    });
    process.exit(1);
  }
})();
