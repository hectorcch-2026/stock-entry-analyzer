'use strict';

/**
 * 自動起伺服器的 e2e 測試跑手（給 `npm run test:all` 用）
 * ======================================================
 *
 * ── 解決的問題 ─────────────────────────────────────────
 * `test:all` 裡的 e2e 測試假設「外面已經有一台跑在 5177 的伺服器」，
 * 但這件事沒有任何地方檢查或保證。實際後果：
 *
 *   1. 忘記先開伺服器 → 第一個 e2e 就以 ERR_CONNECTION_REFUSED 掛掉，
 *      而且錯誤訊息長得像「測試壞了」，不像「你少做一個準備步驟」。
 *   2. 更麻煩的是**埠號不一致**：大部分 e2e 用 5177，但
 *      `e2e-tracker.cjs` 預設 5199、`e2e-watchlist.cjs` 預設 5299。
 *      就算你記得開伺服器，只開 5177 還是會掛 —— 而且掛在整套測試的
 *      很後面（tracker 是第 33 個），前面的結果都已經跑完，看起來像
 *      「快完成了才出錯」，實際上從一開始就不可能全綠。
 *
 * 這個跑手把「需要三台伺服器」這件事收進程式碼：進去時偵測每個埠，
 * 沒開的就自己 spawn 一台，跑完再只關掉自己開的那些。外部已經在跑的
 * 伺服器不會被碰（不關別人的東西）。
 *
 * ── 為什麼不改成統一用一個埠 ───────────────────────────
 * 那需要改三個測試檔的預設值。改是對的，但那是另一件事：若某個測試
 * 真的需要「乾淨的伺服器狀態」（例如追蹤頁依賴伺服器啟動時載入的帳本），
 * 共用一台會讓測試互相污染。這裡先保證「跑得起來且可重現」，
 * 不改動各測試自己的埠約定。
 *
 * 用法：
 *   node scripts/run-e2e-suite.cjs                     # 依序跑所有 e2e
 *   node scripts/run-e2e-suite.cjs tests/e2e-flow.mjs  # 只跑指定檔案
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const HEALTH_TIMEOUT_MS = 60000;

/** e2e 測試會用到的埠。與各測試檔的預設值一致，改測試時這裡要同步。 */
const PORTS = [5177, 5199, 5299];

/**
 * 預設要跑的 e2e 清單。
 *
 * 這份清單刻意**排除**會自己起伺服器的檔案（`e2e-sector-flow.cjs`、
 * `e2e-rec-basis.cjs`），它們由 `test:all` 直接呼叫。若放進來，會變成
 * 兩層伺服器同時搶同一個埠。
 */
const DEFAULT_E2E = [
  'tests/hidden-visibility.mjs',
  'tests/adv-modules.mjs',
  'tests/chart-overlays.mjs',
  'tests/e2e-layout.mjs',
  'tests/e2e-flow.mjs',
  'tests/e2e-notify.mjs',
  'tests/e2e-pwa.mjs',
  'tests/e2e-ios-standalone.mjs',
  'tests/e2e-news-ai.mjs',
  'tests/e2e-macro-charts.mjs',
  'tests/e2e-tracker.cjs',
  'tests/e2e-watchlist.cjs',
  'scripts/verify-subtabs.mjs',
];

const started = [];
let shuttingDown = false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function isUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUp(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isUp(port)) return true;
    await sleep(300);
  }
  return false;
}

function startServer(port) {
  /*
   * 一定要用 detached: false + 自己管生命週期：若用 detached，
   * 測試跑手被中斷時子進程會變成孤兒繼續佔住埠，下一次執行就
   * 會以為「伺服器已經在了」而接到一台狀態不明的舊伺服器。
   */
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ENABLE_INPROCESS_CRON: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.__port = port;
  return child;
}

async function ensureServers() {
  const owned = [];
  for (const port of PORTS) {
    if (await isUp(port)) {
      console.log(`  · 埠 ${port} 已有伺服器，沿用`);
      continue;
    }
    console.log(`  · 埠 ${port} 無伺服器，自動啟動`);
    const child = startServer(port);
    started.push(child);
    owned.push(port);
    if (!(await waitUp(port, HEALTH_TIMEOUT_MS))) {
      throw new Error(`埠 ${port} 的伺服器在 ${HEALTH_TIMEOUT_MS / 1000}s 內未就緒`);
    }
  }
  return owned;
}

async function killAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of started) {
    try { child.kill('SIGTERM'); } catch { /* 已結束 */ }
  }
  // 給它一點時間收尾，之後強制清掉，避免殘留佔埠
  await sleep(500);
  for (const child of started) {
    try { child.kill('SIGKILL'); } catch { /* 已結束 */ }
  }
}

function runOne(rel) {
  return new Promise((resolve) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.log(`\n✗ 找不到測試檔：${rel}`);
      resolve(1);
      return;
    }
    console.log(`\n──────── ${rel} ────────`);
    const child = spawn(process.execPath, [abs], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code || 0)));
    child.on('error', () => resolve(1));
  });
}

(async () => {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_E2E;

  console.log('啟動 e2e 前置伺服器');
  let ownedPorts;
  try {
    ownedPorts = await ensureServers();
  } catch (e) {
    console.error(`\n前置失敗：${e.message}`);
    await killAll();
    process.exit(1);
  }
  if (ownedPorts.length) console.log(`  （本次自行啟動：${ownedPorts.join('、')}）`);

  // 中斷時也要收乾淨，否則埠會被佔住
  const onSignal = async (sig) => {
    console.log(`\n收到 ${sig}，清理伺服器…`);
    await killAll();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const failed = [];
  for (const f of files) {
    const code = await runOne(f);
    if (code !== 0) failed.push(f);
  }

  await killAll();

  console.log('\n════════ e2e 彙總 ════════');
  if (!failed.length) {
    console.log(`  全部通過（${files.length} 個檔案）`);
    process.exit(0);
  }
  console.log(`  失敗 ${failed.length} / ${files.length}：`);
  failed.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
})();
