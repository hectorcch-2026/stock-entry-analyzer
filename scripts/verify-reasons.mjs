/**
 * 驗證「無結果時的原因說明」在瀏覽器上的實際呈現。
 *
 * 重點：excludeReasons 必須是可讀的中文標籤，不能出現 N 佔位字元；
 * 且放寬建議的第一顆按鈕要對應最主要的原因。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5177';
const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(BASE + '/#/screen', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#screenForm');

// 用極嚴苛條件製造「必然無結果」，才會走到原因說明區塊
await page.fill('#fMinScore', '99');
await page.click('#screenBtn');

await page.waitForSelector('#screenReasons:not([hidden])', { timeout: 180000 });
await page.waitForTimeout(500);

const dump = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#screenReasons .sr-item')].map((el) => el.textContent.trim());
  const btns = [...document.querySelectorAll('#screenEmptyActions .err-btn')].map((b) => b.textContent.trim());
  return { items, btns, empty: document.querySelector('#screenEmpty')?.hidden === false };
});

console.log('原因項目：');
dump.items.forEach((t) => console.log('  •', t));
console.log('放寬建議：', dump.btns.join(' / '));

const hasPlaceholder = dump.items.some((t) => /(^|[^A-Za-z])N([^A-Za-z]|$)/.test(t));
const firstBtnIsScore = dump.btns[0] === '評分放寬到 40';

console.log('');
console.log(`[${dump.items.length ? 'PASS' : 'FAIL'}] 有顯示原因項目（${dump.items.length} 項）`);
console.log(`[${hasPlaceholder ? 'FAIL' : 'PASS'}] 原因不含 N 佔位字元`);
console.log(`[${firstBtnIsScore ? 'PASS' : 'FAIL'}] 主要原因是評分，第一顆建議為評分放寬`);
console.log(`[${errors.length ? 'FAIL' : 'PASS'}] 無 JS 錯誤${errors.length ? '：' + errors.join('; ') : ''}`);

await page.screenshot({ path: 'tests/out-reasons.png', fullPage: false });
await browser.close();

const ok = dump.items.length > 0 && !hasPlaceholder && firstBtnIsScore && errors.length === 0;
console.log(ok ? '\n全部通過。' : '\n有項目未通過。');
process.exit(ok ? 0 : 1);
