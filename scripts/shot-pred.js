'use strict';

/**
 * 前端視覺驗證：載入頁面、搜尋標的、截圖預測卡片。
 * 用法：node scripts/shot-pred.js KO
 */

const { chromium } = require('playwright');

const SYM = process.argv[2] || 'KO';
const PORT = process.env.PORT || 5199;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  // 輸入代碼並送出
  await page.fill('#symbolInput', SYM).catch(async () => {
    // 備援：找第一個 text input
    const inputs = await page.$$('input[type=text]');
    if (inputs.length) await inputs[0].fill(SYM);
  });
  await page.keyboard.press('Enter');

  // 等待結果區出現
  await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
  await page.waitForTimeout(2500);

  // 卡片截圖
  const card = await page.$('#predCard');
  if (card) {
    await card.screenshot({ path: `/tmp/pred-${SYM}.png` });
    console.log(`卡片截圖：/tmp/pred-${SYM}.png`);
  } else {
    console.log('找不到 #predCard');
  }

  // 全文截圖（含上方脈絡，便於檢查版面）
  await page.screenshot({ path: `/tmp/full-${SYM}.png`, fullPage: true });
  console.log(`全頁截圖：/tmp/full-${SYM}.png`);

  // 檢查卡片內容
  const info = await page.evaluate(() => {
    const c = document.getElementById('predCard');
    if (!c) return { found: false };
    return {
      found: true,
      hidden: c.hidden,
      badge: document.getElementById('predBadge')?.textContent,
      base: document.getElementById('predBase')?.textContent,
      rows: [...c.querySelectorAll('.pred-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
      picp: document.getElementById('predPicp')?.textContent,
      adj: document.getElementById('predAdj')?.textContent,
      quality: document.getElementById('predQuality')?.textContent,
      note: document.getElementById('predNote')?.textContent?.slice(0, 60),
      unavailable: !document.getElementById('predUnavailable')?.hidden,
    };
  });

  console.log('\n--- 卡片內容 ---');
  console.log(JSON.stringify(info, null, 1));

  if (errors.length) {
    console.log('\n--- 主控台錯誤 ---');
    errors.slice(0, 10).forEach((e) => console.log(' ' + e));
  } else {
    console.log('\n主控台無錯誤');
  }

  await browser.close();
})();
