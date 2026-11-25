import { chromium } from 'playwright';

const URL = 'http://localhost:5177/?symbol=0700.HK';
const b = await chromium.launch();

async function shot(name, w, h, mobile) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: !!mobile, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await p.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForSelector('#result:not([hidden])', { timeout: 60000 }).catch(()=>{});
  await p.waitForTimeout(2500);

  const info = await p.evaluate(() => {
    const res = document.getElementById('result');
    const cv = document.getElementById('priceChart');
    const canvasHasInk = (() => {
      try {
        const c = cv.getContext('2d');
        const d = c.getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
        return n;
      } catch (e) { return -1; }
    })();
    const overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return {
      resultVisible: res && !res.hidden,
      score: document.getElementById('verdictScore')?.textContent,
      zone: document.getElementById('zoneLower')?.textContent + ' ~ ' + document.getElementById('zoneUpper')?.textContent,
      probUp20: document.getElementById('valUp20')?.textContent,
      probProfit: document.getElementById('valProfit')?.textContent,
      samples: document.getElementById('valSamples')?.textContent,
      levelsRows: document.querySelectorAll('#levelsBody tr').length,
      maRows: document.querySelectorAll('#maBody tr').length,
      btCells: document.querySelectorAll('#btGrid .bt-cell').length,
      breakdownRows: document.querySelectorAll('#scoreBreakdown .bd-row').length,
      rationale: document.querySelectorAll('#rationale .rat-item').length,
      fibItems: document.querySelectorAll('#fibList .fib-item').length,
      canvasCSS: cv.clientWidth + 'x' + cv.clientHeight,
      canvasPixels: cv.width + 'x' + cv.height,
      canvasHasInk,
      overflowX,
      legend: document.getElementById('chartLegend')?.textContent?.slice(0, 80),
      updated: document.getElementById('fUpdated')?.textContent,
    };
  });
  await p.screenshot({ path: `/tmp/shot/${name}.png`, fullPage: true });
  console.log('===', name, w + 'x' + h, '===');
  console.log(JSON.stringify(info, null, 1));
  if (errs.length) console.log('CONSOLE ERRORS:', errs.slice(0, 6));
  await ctx.close();
}

await shot('desktop', 1440, 900, false);
await shot('tablet', 834, 1000, true);
await shot('mobile', 390, 844, true);
await b.close();
