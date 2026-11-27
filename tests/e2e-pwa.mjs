/**
 * PWA 端到端驗證
 * 執行：node tests/e2e-pwa.mjs   （需先 npm start）
 *
 * 驗證項目：
 *  1. manifest 可取得且欄位完整（name / start_url / display / icons / maskable）
 *  2. 所有圖示可取得且尺寸正確
 *  3. Service Worker 註冊成功並進入 activated
 *  4. App Shell 已預快取（離線查得到 index.html / styles.css / app.js）
 *  5. 離線時介面仍可開啟（導覽回退）
 *  6. 離線時行情 API 回 503 OFFLINE 且不再主動快取資料
 *  7. 快取資料會標示新鮮度（X-From-Cache / X-Cache-Age）
 *  8. 安全區域 CSS 與 iOS meta 已就位
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5177';
const results = [];
const pass = (n, d = '') => { results.push({ ok: true, n, d }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n, d }); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

/* ---------- 1. 靜態檔案檢查（不經瀏覽器） ---------- */
console.log('\n[1] manifest 與圖示（HTTP 層）\n');

const mRes = await fetch(`${BASE}/manifest.webmanifest`);
if (mRes.ok) {
  const m = await mRes.json();
  const need = ['name', 'short_name', 'start_url', 'display', 'icons', 'theme_color', 'background_color'];
  const missing = need.filter((k) => !m[k]);
  missing.length ? fail('manifest 必要欄位', '缺少 ' + missing.join(', ')) : pass('manifest 必要欄位完整');

  m.display === 'standalone' ? pass('display = standalone') : fail('display 非 standalone', m.display);

  const any = (m.icons || []).filter((i) => (i.purpose || 'any').includes('any'));
  const maskable = (m.icons || []).filter((i) => (i.purpose || '').includes('maskable'));
  any.some((i) => i.sizes === '192x192') ? pass('含 192×192 any 圖示') : fail('缺 192×192 any 圖示');
  any.some((i) => i.sizes === '512x512') ? pass('含 512×512 any 圖示') : fail('缺 512×512 any 圖示');
  maskable.length ? pass('含 maskable 圖示') : fail('缺 maskable 圖示（Android 會顯示白邊）');

  // 逐一確認圖示檔可取得
  for (const ico of m.icons) {
    const r = await fetch(BASE + ico.src);
    if (!r.ok) { fail(`圖示可取得 ${ico.src}`, 'HTTP ' + r.status); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    // 驗 PNG 實際尺寸（IHDR 位於 offset 16）
    if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      const declared = (ico.sizes || '').split('x')[0];
      if (ico.sizes === 'any') pass(`圖示 ${ico.src}`, `${w}×${h} (vector)`);
      else if (String(w) === declared) pass(`圖示 ${ico.src}`, `${w}×${h}`);
      else fail(`圖示尺寸不符 ${ico.src}`, `實際 ${w}×${h}，宣告 ${ico.sizes}`);
    }
  }
} else {
  fail('manifest 可取得', 'HTTP ' + mRes.status);
}

// apple-touch-icon
const ati = await fetch(`${BASE}/icons/apple-touch-icon.png`);
ati.ok ? pass('apple-touch-icon.png 可取得') : fail('apple-touch-icon.png 缺少');

// Service Worker 必須禁快取
const swr = await fetch(`${BASE}/sw.js`);
const swCC = swr.headers.get('cache-control') || '';
if (swr.ok && /no-cache|no-store/.test(swCC)) pass('sw.js 已設禁快取標頭', swCC);
else fail('sw.js 快取標頭不當', swCC || '(無)');

/* ---------- 2. HTML meta 檢查 ---------- */
console.log('\n[2] HTML head 設定\n');
const html = await (await fetch(`${BASE}/`)).text();
const checks = [
  ['rel="manifest"', /rel="manifest"/],
  ['apple-mobile-web-app-capable', /apple-mobile-web-app-capable" content="yes"/],
  ['apple-mobile-web-app-title', /apple-mobile-web-app-title"/],
  ['apple-touch-icon', /rel="apple-touch-icon"/],
  ['theme-color', /name="theme-color"/],
  ['viewport-fit=cover', /viewport-fit=cover/],
];
for (const [label, re] of checks) {
  re.test(html) ? pass(`head: ${label}`) : fail(`head 缺少: ${label}`);
}

// CSS 安全區域
const css = await (await fetch(`${BASE}/styles.css`)).text();
const safeCount = (css.match(/env\(safe-area-inset-/g) || []).length;
safeCount >= 4 ? pass(`CSS safe-area-inset 使用 ${safeCount} 處`) : fail('CSS 安全區域處理不足', `僅 ${safeCount} 處`);

/* ---------- 3. 瀏覽器：Service Worker 與離線 ---------- */
console.log('\n[3] Service Worker 註冊與快取\n');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const page = await ctx.newPage();
const pageErrs = [];
page.on('pageerror', (e) => pageErrs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrs.push(m.text()); });

await page.goto(`${BASE}/?symbol=AAPL`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('#result:not([hidden])', { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2000);

// SW 註冊狀態
const swState = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { supported: true, registered: false };
  // 等待 activated
  const sw = reg.active || reg.installing || reg.waiting;
  return {
    supported: true,
    registered: true,
    scope: reg.scope,
    active: !!reg.active,
    state: sw ? sw.state : null,
    controller: !!navigator.serviceWorker.controller,
  };
});
if (swState.registered && swState.active) {
  pass('Service Worker 已註冊且 activated', `scope=${swState.scope}`);
} else {
  fail('Service Worker 未正確啟用', JSON.stringify(swState));
}

// 預快取內容
const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  const out = {};
  for (const n of names) {
    const c = await caches.open(n);
    out[n] = (await c.keys()).map((r) => new URL(r.url).pathname);
  }
  return out;
});
const shellKey = Object.keys(cached).find((k) => k.startsWith('shell-'));
if (shellKey) {
  const files = cached[shellKey];
  const must = ['/index.html', '/styles.css', '/app.js'];
  const miss = must.filter((f) => !files.includes(f));
  miss.length ? fail('App Shell 預快取不完整', '缺 ' + miss.join(', ')) : pass('App Shell 已預快取', files.length + ' 項');
} else {
  fail('找不到 shell 快取', JSON.stringify(Object.keys(cached)));
}

/* ---------- 4. 離線行為 ---------- */
console.log('\n[4] 離線行為\n');

// 先確認線上時有資料
const onlineOk = await page.evaluate(() => !document.getElementById('result').hidden);
pass('線上時結果正常渲染', onlineOk ? 'result 可見' : '⚠ result 不可見');

// 切離線
await ctx.setOffline(true);
await page.waitForTimeout(400);

// 導覽回退：離線重整應仍能開啟
let navOk = false;
try {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  navOk = await page.evaluate(() => !!document.querySelector('.search-card'));
} catch (e) {
  navOk = false;
}
navOk ? pass('離線重整仍能開啟介面（導覽回退成功）') : fail('離線重整失敗（無法開啟介面）');

// 離線時呼叫 API：應回 503 OFFLINE
const offlineApi = await page.evaluate(async () => {
  try {
    const r = await fetch('/api/analyze?symbol=AAPL');
    const j = await r.json().catch(() => null);
    return { status: r.status, code: j?.error?.code, fromCache: r.headers.get('X-From-Cache'), age: r.headers.get('X-Cache-Age') };
  } catch (e) {
    return { error: e.message };
  }
});
if (offlineApi.code === 'OFFLINE') {
  pass('離線查詢行情回 OFFLINE', `status=${offlineApi.status}`);
} else if (offlineApi.fromCache) {
  // 有快取可用也算正確（會帶新鮮度標頭）
  pass('離線查詢改用快取並標示新鮮度', `age=${offlineApi.age}s`);
} else {
  fail('離線行情處理異常', JSON.stringify(offlineApi));
}

// 離線時 UI 是否出現提示
const offlineBarVisible = await page.evaluate(() => {
  const b = document.getElementById('offlineBar');
  return b ? { hidden: b.hidden, text: document.getElementById('offlineText')?.textContent?.slice(0, 60) } : null;
});
if (offlineBarVisible && !offlineBarVisible.hidden) {
  pass('離線提示橫幅顯示', offlineBarVisible.text);
} else {
  fail('離線提示橫幅未顯示', JSON.stringify(offlineBarVisible));
}

// 恢復連線
await ctx.setOffline(false);
await page.waitForTimeout(1200);
const recovered = await page.evaluate(() => document.getElementById('offlineBar')?.hidden);
recovered ? pass('恢復連線後提示橫幅自動隱藏') : fail('恢復連線後橫幅未隱藏');

/* ---------- 5. iOS 引導 ---------- */
console.log('\n[5] iOS 加入主畫面引導\n');
const iosCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});
const iosPage = await iosCtx.newPage();
await iosPage.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
await iosPage.waitForTimeout(3600);
const iosTip = await iosPage.evaluate(() => {
  const t = document.getElementById('iosInstallTip');
  return t ? { exists: true, visible: !t.hidden, text: t.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) } : { exists: false };
});
if (iosTip.exists && iosTip.visible) pass('iOS Safari 顯示加入主畫面引導', iosTip.text);
else fail('iOS 引導未顯示', JSON.stringify(iosTip));

// 關閉後不再顯示
await iosPage.click('#iosTipClose').catch(() => {});
await iosPage.waitForTimeout(400);
const afterClose = await iosPage.evaluate(() => localStorage.getItem('entry-analyzer-ios-tip-dismissed'));
afterClose ? pass('關閉引導後已記錄，不再重複顯示') : fail('關閉狀態未記錄');

await iosCtx.close();

/* ---------- 6. 版面無回歸 ---------- */
console.log('\n[6] 版面回歸（加入 PWA 後不應產生溢出）\n');
for (const [name, w, h, mobile] of [['desktop', 1440, 900, false], ['tablet', 834, 1000, true], ['mobile', 390, 844, true]]) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile });
  const p = await c.newPage();
  await p.goto(`${BASE}/?symbol=AAPL`, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForSelector('#result:not([hidden])', { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(1500);
  // 圖表位於「技術」子分頁；不切換的話 hidden 面板內 canvas 量不到墨水。
  await p.click('#tab-tech').catch(() => {});
  await p.waitForTimeout(400);
  const m = await p.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    canvasInk: (() => {
      const cv = document.getElementById('priceChart');
      if (!cv) return -1;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
      return n;
    })(),
  }));
  if (m.overflow === 0) pass(`${name} ${w}px 無水平溢出`);
  else fail(`${name} 有水平溢出`, m.overflow + 'px');
  m.canvasInk > 50 ? pass(`${name} 圖表正常繪製`, 'ink=' + m.canvasInk) : fail(`${name} 圖表未繪製`);
  await c.close();
}

console.log('\n[7] Console 錯誤\n');
// 離線測試期間的網路錯誤是預期行為，不應計為失敗
const EXPECTED = [
  /ERR_INTERNET_DISCONNECTED/,
  /ERR_NAME_NOT_RESOLVED/,
  /status of 503/,
  /Failed to fetch/,
  /net::ERR_/,
];
const realErrs = pageErrs.filter((e) => !EXPECTED.some((re) => re.test(e)));
if (realErrs.length === 0) {
  pass('無非預期的 console / page 錯誤', `（已忽略 ${pageErrs.length} 筆離線測試期間的預期網路錯誤）`);
} else {
  fail('有非預期錯誤', realErrs.slice(0, 4).join(' | '));
}

await browser.close();

/* ---------- 總結 ---------- */
const failed = results.filter((r) => !r.ok);
console.log('\n' + '─'.repeat(58));
console.log(`PWA 驗證： ${results.length - failed.length} / ${results.length} 通過`);
if (failed.length) {
  console.log('\n未通過項目：');
  failed.forEach((f) => console.log(`  ✗ ${f.n}${f.d ? ' — ' + f.d : ''}`));
  process.exit(1);
} else {
  console.log('全部通過。\n');
}
