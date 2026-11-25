import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });

// 延遲 analyze API，讓載入狀態可被觀察
await p.route('**/api/analyze*', async route => {
  await new Promise(r => setTimeout(r, 2500));
  await route.continue();
});

await p.goto('http://localhost:5177/', { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForTimeout(600);

// 載入狀態
await p.fill('#symbolInput', '騰訊');
await p.waitForTimeout(1000);
const sug = await p.evaluate(() => {
  const ul = document.getElementById('suggestions');
  return { hidden: ul.hidden, count: ul.children.length, items: [...ul.children].map(c=>c.textContent.trim().slice(0,24)) };
});
console.log('1) 自動完成(騰訊):', JSON.stringify(sug));

await p.click('#suggestions li');
await p.waitForTimeout(600);
const loading = await p.evaluate(() => ({
  skeletonVisible: !document.getElementById('loading').hidden,
  loadingText: document.getElementById('loadingText').textContent,
  btnDisabled: document.getElementById('searchBtn').disabled,
  btnLabel: document.querySelector('#searchBtn .btn-label').textContent,
  spinnerVisible: !document.querySelector('#searchBtn .spinner').hidden,
  status: document.getElementById('statusText').textContent,
  resultHidden: document.getElementById('result').hidden,
}));
console.log('2) 載入狀態:', JSON.stringify(loading));

await p.waitForSelector('#result:not([hidden])', { timeout: 60000 });
await p.waitForTimeout(2000);
const done = await p.evaluate(() => ({
  skeletonHidden: document.getElementById('loading').hidden,
  btnDisabled: document.getElementById('searchBtn').disabled,
  btnLabel: document.querySelector('#searchBtn .btn-label').textContent,
  status: document.getElementById('statusText').textContent,
  symbol: document.getElementById('qSymbol').textContent,
  inputVal: document.getElementById('symbolInput').value,
}));
console.log('3) 完成狀態:', JSON.stringify(done));

// 圖表 overlay 切換
const inkOf = () => p.evaluate(() => {
  const cv=document.getElementById('priceChart'); const c=cv.getContext('2d');
  const d=c.getImageData(0,0,cv.width,cv.height).data; let n=0;
  for(let i=3;i<d.length;i+=400) if(d[i]>0) n++; return n;
});
console.log('4) canvas 墨水 (預設 ma+levels):', await inkOf());
for (const t of ['boll','vol']) { await p.click(`.tab[data-overlay="${t}"]`); await p.waitForTimeout(500); }
console.log('4b) canvas 墨水 (+boll+vol):', await inkOf(), '| legend:', (await p.textContent('#chartLegend')).slice(0,90));

// 通知
// 注意：notifyToggle 是視覺隱藏的 checkbox（由 label 包覆），
// 必須點擊 .switch-track 而非 input 本身。
await p.click('.switch-track');
await p.waitForTimeout(400);
console.log('5) 通知開關已切換:', await p.isChecked('#notifyToggle'), '| 按鈕啟用:', !(await p.isDisabled('#notifyBtn')));
await p.click('#notifyBtn');
await p.waitForSelector('#notifyPreview:not([hidden])', { timeout: 45000 });
console.log('5b) 通知預覽:\n' + (await p.textContent('#notifyPreview')).slice(0, 400));

console.log('errors:', errs.length ? errs : 'none');
await b.close();
