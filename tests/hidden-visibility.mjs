/**
 * hidden 屬性回歸測試
 *
 * 背景（真實事故）：
 *   CSS 裡 .offline-bar { display: flex } 讓 HTML 的 hidden 屬性失效
 *   （作者樣式優先於瀏覽器預設的 [hidden]{display:none}）。
 *   結果：線上下橫條「目前離線」常駐顯示，使用者以為永遠斷線。
 *   同樣問題影響 10 個依賴 hidden 的元素（載入層、錯誤卡、結果區…）。
 *
 *   修復：styles.css 加入 :where([hidden]){display:none!important}
 *
 * 本測試確保：
 *   1. 所有帶 hidden 的元素，屬性值與視覺實際可見性一致
 *   2. 離線橫條會因斷網而出現、因恢復而消失
 *
 * 用法：
 *   node tests/hidden-visibility.mjs                      # 預設 localhost:5177
 *   BASE=https://xxx.onrender.com/ node tests/hidden-visibility.mjs
 */
import { chromium, devices } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5177/';

const results = [];
const pass = (n, d = '') => {
  results.push({ ok: true, n });
  console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`);
};
const fail = (n, d = '') => {
  results.push({ ok: false, n });
  console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`);
};

/** index.html 中所有帶 hidden 的元素 id */
const HIDDEN_IDS = [
  'offlineBar',
  'iosInstallTip',
  'clearBtn',
  'suggestions',
  'loading',
  'errorBox',
  'result',
  'fuzzyNote',
  'chartTooltip',
  'notifyPreview',
];

console.log(`\nhidden 可見性驗證：${BASE}\n`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
const page = await ctx.newPage();

/** 讀取元素真實可見性 */
const readBar = () =>
  page.evaluate(() => {
    const el = document.getElementById('offlineBar');
    if (!el) return { exists: false };
    const cs = getComputedStyle(el);
    return {
      exists: true,
      hidden: el.hidden,
      display: cs.display,
      height: el.offsetHeight,
      visible: cs.display !== 'none' && el.offsetHeight > 0,
    };
  });

/* ---------- 1. 屬性與視覺一致性 ---------- */
console.log('[1] hidden 屬性與實際可見性是否一致\n');
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);

const rows = await page.evaluate((ids) => {
  return ids.map((id) => {
    const el = document.getElementById(id);
    if (!el) return { id, exists: false };
    const cs = getComputedStyle(el);
    return {
      id,
      exists: true,
      hidden: el.hidden,
      display: cs.display,
      height: el.offsetHeight,
      actuallyHidden: cs.display === 'none' || el.offsetHeight === 0,
    };
  });
}, HIDDEN_IDS);

let inconsistent = 0;
for (const r of rows) {
  if (!r.exists) continue;
  if (r.hidden !== r.actuallyHidden) {
    inconsistent++;
    fail(`${r.id} 屬性與視覺不一致`, `hidden=${r.hidden} display=${r.display} h=${r.height}px`);
  }
}
if (inconsistent === 0) {
  pass(`全部 ${rows.filter((r) => r.exists).length} 個 hidden 元素一致`);
}

// 專項：線上下 hidden=true 時必須真的不可見
const online = await readBar();
online.hidden && !online.visible
  ? pass('線上加載後離線橫條確實隱藏', `display=${online.display}`)
  : fail('線上下離線橫條仍可見（hidden 失效）', `hidden=${online.hidden} display=${online.display} h=${online.height}px`);

/* ---------- 2. 斷網 → 顯示 ---------- */
console.log('\n[2] 斷網時應顯示離線提示\n');
await ctx.setOffline(true);
await page.waitForTimeout(1800);
const offline = await readBar();
!offline.hidden && offline.visible
  ? pass('斷網後離線橫條出現', `h=${offline.height}px`)
  : fail('斷網後未顯示離線提示', `hidden=${offline.hidden} display=${offline.display}`);

/* ---------- 3. 恢復 → 隱藏 ---------- */
console.log('\n[3] 恢復連線後應自動隱藏\n');
await ctx.setOffline(false);
await page.waitForTimeout(2200);
const back = await readBar();
back.hidden && !back.visible
  ? pass('恢復連線後離線橫條消失')
  : fail('恢復連線後橫條未消失', `hidden=${back.hidden} display=${back.display} h=${back.height}px`);

await browser.close();

/* ---------- 彙總 ---------- */
const failed = results.filter((r) => !r.ok);
console.log('\n' + '─'.repeat(58));
console.log(`hidden 可見性驗證： ${results.length - failed.length} / ${results.length} 通過`);
if (failed.length) {
  console.log('\n未通過：');
  failed.forEach((f) => console.log(`  ✗ ${f.n}`));
  process.exit(1);
}
console.log('全部通過。\n');
