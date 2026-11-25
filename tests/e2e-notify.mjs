import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await p.goto('http://localhost:5177/?symbol=0700.HK', { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForSelector('#result:not([hidden])', { timeout: 60000 });
await p.waitForTimeout(2000);

// 點擊 label 切換（模擬真實使用者操作）
console.log('切換前 checked:', await p.isChecked('#notifyToggle'));
await p.click('.switch-track');
await p.waitForTimeout(400);
console.log('切換後 checked:', await p.isChecked('#notifyToggle'), '| 按鈕禁用:', await p.isDisabled('#notifyBtn'));

await p.click('#notifyBtn');
await p.waitForSelector('#notifyPreview:not([hidden])', { timeout: 45000 });
console.log('--- 通知預覽內容 ---');
console.log(await p.textContent('#notifyPreview'));

// 通知設定狀態說明
console.log('--- 通知設定提示 ---');
console.log((await p.textContent('#notifyStatus')).slice(0, 260));

// 錯誤情境：格式錯誤 + 找不到
const p2 = await ctx.newPage();
await p2.goto('http://localhost:5177/', { waitUntil: 'networkidle' });
await p2.fill('#symbolInput', 'ZZZZQQ');
await p2.click('#searchBtn');
await p2.waitForSelector('#errorBox:not([hidden])', { timeout: 45000 });
console.log('--- 找不到代碼 ---');
console.log(JSON.stringify(await p2.evaluate(() => ({
  title: document.getElementById('errorTitle').textContent,
  msg: document.getElementById('errorMessage').textContent,
  hint: document.getElementById('errorHint').textContent,
  actions: [...document.querySelectorAll('#errorActions .err-btn')].map(b=>b.textContent),
})), null, 1));

console.log('errors:', errs.length ? errs : 'none');
await b.close();
