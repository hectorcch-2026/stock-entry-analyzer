'use strict';
/* 觀察清單與推介頁操作欄的瀏覽器驗證（真的開 Chromium，不 mock） */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:5299';
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrs = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
  page.on('pageerror', (e) => consoleErrs.push('pageerror: ' + e.message));

  /*
   * 先把觀察清單清空。
   *
   * 為什麼一定要做：這支測試的第一段就斷言「空清單時顯示空狀態」，
   * 而觀察清單是**持久化檔案**（data/watchlist.json），不會隨進程結束重置。
   * 上一輪測試留下的項目（例如上一個案例加的 2015.HK）會讓這一輪從一開始
   * 就不是空清單，於是「空狀態」「有 1 列」「移出後回到空狀態」全數失敗。
   *
   * 症狀很容易誤判成「功能壞了」：錯誤訊息是「觀察清單有 1 列  2 列」，
   * 看起來像多渲染了一列，實際上只是資料沒清。
   *
   * 用 DELETE /api/watchlist?symbol= 逐筆清（就是使用者按「移出觀察」打的
   * 同一個端點），而不是直接刪檔 —— 這樣才會連伺服器記憶體裡的狀態一起清掉。
   */
  try {
    const cur = await (await fetch(`${BASE}/api/watchlist`)).json();
    const items = Array.isArray(cur.items) ? cur.items : [];
    for (const it of items) {
      await fetch(`${BASE}/api/watchlist?symbol=${encodeURIComponent(it.symbol)}`,
        { method: 'DELETE' });
    }
    if (items.length) console.log(`  （前置清理：移除 ${items.length} 筆殘留）`);
  } catch (e) {
    console.log(`  （前置清理失敗，將以現況續跑：${e.message}）`);
  }

  // ---- 1. 觀察清單頁（空狀態） ----
  await page.goto(`${BASE}/#/watch`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  ok('導覽列有「觀察清單」', await page.locator('#mainNav a[href="#/watch"]').count() === 1);
  ok('觀察清單頁有顯示（不是隱藏）', await page.locator('#viewWatch').isVisible());
  ok('空清單時顯示空狀態', await page.locator('#wtEmpty').isVisible());
  ok('空清單時表格隱藏', !(await page.locator('#wtTableWrap').isVisible()));

  // ---- 2. 推介頁的操作欄 ----
  await page.goto(`${BASE}/#/tracker`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const rowCount = await page.locator('#trBody tr.tr-row').count();
  ok('推介頁有資料列', rowCount > 0, `${rowCount} 列`);

  const firstRow = page.locator('#trBody tr.tr-row').first();
  ok('每列都有「個股分析」連結', await firstRow.locator('a.tr-op-detail').count() === 1);
  ok('每列都有「加入觀察」按鈕', await firstRow.locator('button.tr-op-watch').count() === 1);

  const href = await firstRow.locator('a.tr-op-detail').getAttribute('href');
  ok('個股分析連結指向 #/detail/代碼', /^#\/detail\/[A-Z0-9.]+$/.test(href), href);

  const symbol = await firstRow.locator('button.tr-op-watch').getAttribute('data-symbol');
  ok('按鈕帶有股票代碼', !!symbol, symbol);

  // ---- 3. 加入觀察 ----
  await firstRow.locator('button.tr-op-watch').click();
  await page.waitForTimeout(900);
  const btnText = await firstRow.locator('button.tr-op-watch').innerText();
  ok('加入後按鈕變為「已加入觀察」', /已加入/.test(btnText), btnText);
  ok('加入後 aria-pressed=true',
    await firstRow.locator('button.tr-op-watch').getAttribute('aria-pressed') === 'true');

  // 後端真的存了嗎
  const api = await page.evaluate(() => fetch('/api/watchlist').then((r) => r.json()));
  ok('後端清單真的有這筆', api.items.some((x) => x.symbol === symbol),
    JSON.stringify(api.items.map((x) => x.symbol)));

  // ---- 4. 觀察清單頁顯示它 ----
  await page.goto(`${BASE}/#/watch`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  ok('觀察清單表格顯示', await page.locator('#wtTableWrap').isVisible());
  const wtRows = await page.locator('#wtBody tr.tr-row').count();
  ok('觀察清單有 1 列', wtRows === 1, `${wtRows} 列`);
  ok('代碼是連結', await page.locator('#wtBody a.wt-link').count() === 1);
  ok('有「個股分析」連結', await page.locator('#wtBody a.tr-op-detail').count() === 1);
  ok('有「移出觀察」按鈕', await page.locator('#wtBody button.tr-op-remove').count() === 1);
  // 來源欄：類別名是 wt-src-pick（watchlist 前綴），不是 tr-src-pick。
  // 先取字串再斷言——把 innerText() 直接寫在 ok() 的參數裡，
  // 元素不存在時會拋 Timeout 而不是「這一項失敗」，害後面的檢查全部跑不到。
  const srcText = await page.locator('#wtBody td.tr-src').first().innerText();
  const srcPickCount = await page.locator('#wtBody .wt-src-pick').count();
  ok('來源欄顯示「推介 id」而非「手動加入」', srcPickCount === 1, srcText);
  ok('來源內容帶代碼與推介日', /@\d{4}-\d{2}-\d{2}/.test(srcText), srcText);

  // ---- 5. 點個股分析要真的換頁 ----
  await page.locator('#wtBody a.tr-op-detail').first().click();
  await page.waitForTimeout(900);
  ok('點「個股分析」後路由變為 detail', /#\/detail\//.test(page.url()), page.url());
  ok('個股詳情頁可見', await page.locator('#viewChart').isVisible());

  // ---- 6. 移出觀察 ----
  await page.goto(`${BASE}/#/watch`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.locator('#wtBody button.tr-op-remove').first().click();
  await page.waitForTimeout(900);
  ok('移出後回到空狀態', await page.locator('#wtEmpty').isVisible());
  const api2 = await page.evaluate(() => fetch('/api/watchlist').then((r) => r.json()));
  ok('後端清單已清空', api2.items.length === 0, JSON.stringify(api2.items));

  // ---- 7. 重新整理後狀態仍正確（不是只改了前端） ----
  await page.goto(`${BASE}/#/tracker`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  const again = await page.locator('#trBody tr.tr-row').first().locator('button.tr-op-watch').innerText();
  ok('移出後推介頁按鈕回到「加入觀察」', !/已加入/.test(again), again);

  // ---- 8. 沒有 console 錯誤 ----
  const realErrs = consoleErrs.filter((e) => !/favicon|manifest|404/i.test(e));
  ok('無 JS 錯誤', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  // ---- 9. 截圖 ----
  await page.goto(`${BASE}/#/watch`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.evaluate(() => fetch('/api/watchlist', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: '2015.HK', name: 'Li Auto Inc.', market: 'HK', currency: 'HKD', fromPick: '2015.HK@2026-11-26' }),
  }).then((r) => r.json()).then(() => fetch('/api/watchlist', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BEKE', name: 'KE Holdings Inc.', market: 'US', currency: 'USD', fromPick: 'BEKE@2026-11-26' }),
  })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  fs.mkdirSync(path.join(__dirname, '..', '.probe'), { recursive: true });
  await page.screenshot({ path: path.join(__dirname, '..', '.probe', 'watch.png'), fullPage: true });
  await page.goto(`${BASE}/#/tracker`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(__dirname, '..', '.probe', 'tracker-ops.png'), fullPage: true });

  await browser.close();
  console.log(`\n=== 觀察清單 e2e：${pass} 通過 / ${fail} 失敗 ===`);
  if (fail) { console.log('失敗項：' + fails.join('、')); process.exit(1); }
})().catch((e) => { console.error('測試異常：', e && e.stack || e); process.exit(1); });
