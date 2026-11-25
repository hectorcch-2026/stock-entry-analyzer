import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await p.goto('http://localhost:5177/?symbol=AAPL', { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForSelector('#result:not([hidden])', { timeout: 60000 });
await p.waitForTimeout(2500);
const info = await p.evaluate(() => ({
  symbol: document.getElementById('qSymbol').textContent,
  name: document.getElementById('qName').textContent,
  score: document.getElementById('verdictScore').textContent,
  verdict: document.getElementById('verdictLabel').textContent,
  zone: document.getElementById('zoneLower').textContent + ' ~ ' + document.getElementById('zoneUpper').textContent,
  rr: document.getElementById('zoneRR').textContent,
  probUp20: document.getElementById('valUp20').textContent,
  probProfit: document.getElementById('valProfit').textContent,
  samples: document.getElementById('valSamples').textContent,
  base: document.getElementById('valBase').textContent,
  edge: document.getElementById('valEdge').textContent,
  conf: document.getElementById('confidenceBadge').textContent,
  btCells: document.querySelectorAll('#btGrid .bt-cell').length,
  btRows: document.querySelectorAll('#btBody tr').length,
  btBadge: document.getElementById('btBadge').textContent,
  rationaleFirst: document.querySelector('#rationale .rat-item p')?.textContent?.slice(0,120),
  zoneHint: document.getElementById('zoneHint').textContent.slice(0,140),
  probHint: document.getElementById('probHint').textContent.slice(0,180),
}));
console.log(JSON.stringify(info, null, 1));
console.log('errors:', errs.length ? errs : 'none');
await p.screenshot({ path: '/tmp/shot/aapl-full.png', fullPage: true });
// 錯誤情境截圖
const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const p2 = await ctx2.newPage();
await p2.goto('http://localhost:5177/?symbol=ZZZZINVALID', { waitUntil: 'networkidle', timeout: 60000 });
await p2.waitForSelector('#errorBox:not([hidden])', { timeout: 40000 }).catch(()=>{});
await p2.waitForTimeout(800);
const errInfo = await p2.evaluate(() => ({
  title: document.getElementById('errorTitle').textContent,
  msg: document.getElementById('errorMessage').textContent,
  hint: document.getElementById('errorHint').textContent,
  actions: [...document.querySelectorAll('#errorActions .err-btn')].map(b=>b.textContent),
  visible: !document.getElementById('errorBox').hidden,
}));
console.log('ERROR CASE:', JSON.stringify(errInfo, null, 1));
await p2.screenshot({ path: '/tmp/shot/m-error.png', fullPage: true });
await b.close();
