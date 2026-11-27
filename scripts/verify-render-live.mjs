/**
 * Render 線上站台驗收（v1.4）。
 *
 * 與本機測試的差異：Render 出網不受限，因此 pred.status 應為 ok，
 * 統計可信度應可計算。此腳本以此為驗收前提。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://stock-entry-analyzer.onrender.com';
const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch();

/* ---------- 桌機 ---------- */
const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForSelector('#mainNav', { timeout: 60000 });

console.log('[1] 導航與頁面結構');
// 只數「使用者看得到」的導航項。#mainNav 內另有一個 nav-detail（個股詳情專用，
// 由路由動態顯示），它不是獨立入口。原本寫死 ===3 的斷言在新增「版塊輪動」
// 與「宏觀與基本面」後失效，且會把隱藏項一起數進去。
const navItems = await page.$$eval('#mainNav [data-route]', (els) =>
  els
    .filter((e) => !e.hidden && getComputedStyle(e).display !== 'none')
    .map((e) => e.getAttribute('data-route'))
);
const EXPECTED_ROUTES = ['predict', 'screen', 'macro', 'rrg'];
rec(
  '四個主要導航項存在（K線預測 / AI選股 / 宏觀基本面 / 版塊輪動）',
  EXPECTED_ROUTES.every((r) => navItems.includes(r)),
  `${navItems.length} 項可見：${navItems.join(', ')}`
);

const views = await page.evaluate(() => ({
  predict: !!document.querySelector('#viewChart'),
  screen: !!document.querySelector('#viewScreen'),
  cred: !!document.querySelector('#credCard'),
}));
rec('K 線預測頁容器存在', views.predict);
rec('AI 選股頁容器存在', views.screen);
rec('統計可信度卡片存在', views.cred);

console.log('[2] K 線資料與圖表');
await page.goto(BASE + '/#/predict', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#symbolInput', { timeout: 60000 });
await page.fill('#symbolInput', 'AAPL');
await page.click('#searchBtn');

// 等分析完成（K 線畫出來）
await page.waitForFunction(() => {
  const c = document.querySelector('#chartCanvas');
  return c && c.width > 0 && window.__saChartDrawn !== false;
}, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(4000);

/* 時間區間按鈕與圖表都在「技術」子分頁內（個股頁已改為 4 個子分頁），
   面板用 hidden 屬性隱藏，不切分頁就點不到。這也是真實使用者路徑。 */
const techTab = await page.$('#tab-tech');
if (techTab) {
  await page.click('#tab-tech');
  await page.waitForTimeout(600);
}

const rangeBtns = await page.locator('.range-btn[data-range]').count();
rec('時間區間按鈕 5 個', rangeBtns === 5, `${rangeBtns} 個`);

const klineInfo = await page.evaluate(async () => {
  const r = await fetch('/api/kline?symbol=AAPL&range=2y');
  const j = await r.json();
  return { ok: j.ok, bars: j.bars, source: j.source, price: j.price };
});
rec('2 年區間取得 500+ 根 K 線', klineInfo.ok && klineInfo.bars >= 490, `${klineInfo.bars} 根 / 來源 ${klineInfo.source}`);

// 切換區間
await page.click('.range-btn[data-range="6m"]');
await page.waitForTimeout(2500);
const activeRange = await page.evaluate(() => {
  const b = document.querySelector('.range-btn[data-range].active');
  return b ? b.dataset.range : null;
});
rec('切換到 6 個月後按鈕為選中狀態', activeRange === '6m', activeRange || '無');

console.log('[3] K 線預測（區間）');
const pred = await page.evaluate(async () => {
  const r = await fetch('/api/analyze?symbol=AAPL');
  const j = await r.json();
  return {
    ok: j.ok,
    status: j.pred && j.pred.status,
    horizons: j.pred && j.pred.horizons ? Object.keys(j.pred.horizons) : [],
    cred: j.predCredibility ? { score: j.predCredibility.score, grade: j.predCredibility.grade, available: j.predCredibility.available } : null,
  };
});
rec('預測在線上可用（Render 出網不受限）', pred.status === 'ok', `status=${pred.status}`);
rec('三個期間區間（5/10/20 日）', pred.horizons.length === 3, pred.horizons.join(','));
rec('統計可信度可計算', !!(pred.cred && pred.cred.available), pred.cred ? `${pred.cred.score} / ${pred.cred.grade}` : '無');

const credVisible = await page.evaluate(() => {
  const card = document.querySelector('#credCard');
  const score = document.querySelector('#credScore');
  const dis = document.querySelector('#credDisclaimer');
  return {
    cardShown: card && !card.hidden,
    scoreText: score ? score.textContent.trim() : '',
    disclaimer: dis ? dis.textContent.trim().slice(0, 40) : '',
  };
});
rec('可信度卡片在頁面上顯示', credVisible.cardShown, `分數顯示「${credVisible.scoreText}」`);
rec('免責說明存在', credVisible.disclaimer.length > 0, credVisible.disclaimer);

console.log('[4] AI 選股');
await page.goto(BASE + '/#/screen', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#screenForm', { timeout: 60000 });

const meta = await page.evaluate(async () => {
  const r = await fetch('/api/screen/meta');
  const j = await r.json();
  return j;
});
rec('篩選母體 154 檔', meta.ok && meta.pool?.total === 154, `total=${meta.pool?.total}（港股 ${meta.pool?.hk} / 美股 ${meta.pool?.us}）`);

const t0 = Date.now();
await page.click('#screenBtn');
await page.waitForSelector('#screenTableWrap:not([hidden]), #screenError:not([hidden]), #screenEmpty:not([hidden])', { timeout: 240000 });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const screenState = await page.evaluate(() => {
  const rows = document.querySelectorAll('#screenBody tr.sc-row').length;
  const err = document.querySelector('#screenError');
  const empty = document.querySelector('#screenEmpty');
  const stats = document.querySelector('#screenStats');
  return {
    rows,
    errShown: err ? !err.hidden : false,
    emptyShown: empty ? !empty.hidden : false,
    statsText: stats ? stats.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
  };
});
rec('篩選回傳結果或明確空狀態', screenState.rows > 0 || screenState.emptyShown, `${screenState.rows} 列，耗時 ${elapsed}s`);
if (screenState.rows > 0) {
  rec('結果統計有顯示', screenState.statsText.length > 0, screenState.statsText);

  // 排序
  const before = await page.evaluate(() => document.querySelector('#screenBody tr.sc-row')?.dataset.symbol);
  await page.click('th[data-sort="changePct"]').catch(() => {});
  await page.waitForTimeout(300);
  const ariaSort = await page.evaluate(() => document.querySelector('th[data-sort="changePct"]')?.getAttribute('aria-sort'));
  rec('點欄位標題可排序（aria-sort 更新）', !!ariaSort && ariaSort !== 'none', `aria-sort=${ariaSort}`);

  // 進詳情頁
  await page.click('#screenBody tr.sc-row .row-btn');
  await page.waitForFunction(() => location.hash.startsWith('#/detail/'), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const detail = await page.evaluate(() => ({
    hash: location.hash,
    crumb: document.querySelector('#detailCrumb')?.textContent.trim() || '',
    backShown: !document.querySelector('#detailBar')?.hidden,
  }));
  rec('點列進入詳情頁', detail.hash.startsWith('#/detail/'), detail.hash);
  rec('詳情頁麵包屑顯示代碼', detail.crumb.includes('個股詳情') && /\S/.test(detail.crumb.replace('個股詳情', '')), `「${detail.crumb}」`);
  rec('詳情頁返回列可見', detail.backShown);
}

console.log('[5] 錯誤處理');
const errCases = await page.evaluate(async () => {
  const out = {};
  let r = await fetch('/api/kline?symbol=AAPL&range=99y');
  out.badRange = { status: r.status, body: await r.json() };
  r = await fetch('/api/screen?minScore=999');
  out.badParam = { status: r.status, body: await r.json() };
  r = await fetch('/api/analyze?symbol=ZZZZNOTREAL');
  out.badSymbol = { status: r.status, body: await r.json() };
  return out;
});
rec('非法區間回 400 BAD_RANGE', errCases.badRange.status === 400 && errCases.badRange.body.error?.code === 'BAD_RANGE', errCases.badRange.body.error?.message || '');
rec('非法參數回 400 BAD_PARAMS', errCases.badParam.status === 400 && errCases.badParam.body.error?.code === 'BAD_PARAMS', (errCases.badParam.body.error?.message || '').slice(0, 50));
rec('不存在代碼有明確錯誤', errCases.badSymbol.body.ok === false || errCases.badSymbol.status >= 400, `status=${errCases.badSymbol.status}`);

console.log('[6] 手機版');
const mob = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await mob.newPage();
await mp.goto(BASE + '/#/screen', { waitUntil: 'domcontentloaded', timeout: 120000 });
await mp.waitForSelector('#screenForm', { timeout: 60000 });
const mobScreen = await mp.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  formVisible: !!document.querySelector('#screenForm')?.offsetParent,
}));
rec('手機版選股頁無水平溢出', mobScreen.overflow <= 0, `overflowX=${mobScreen.overflow}`);
rec('手機版表單可見', mobScreen.formVisible);

await mp.goto(BASE + '/#/predict', { waitUntil: 'domcontentloaded' });
await mp.waitForTimeout(3000);
const mobPred = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
rec('手機版預測頁無水平溢出', mobPred <= 0, `overflowX=${mobPred}`);

console.log('[7] 主控台');
const realErrors = errors.filter((e) => !/Failed to load resource|net::ERR_|status of 4\d\d/i.test(e));
rec('桌機版無 JS 錯誤', realErrors.length === 0, realErrors.slice(0, 2).join('; ') || '無');

await browser.close();

const pass = results.filter((r) => r.pass).length;
console.log('');
console.log(`${'='.repeat(50)}`);
console.log(`結果：${pass} / ${results.length} 通過`);
if (pass !== results.length) {
  console.log('未通過項目：');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  ✗ ${r.name} — ${r.detail}`));
}
process.exit(pass === results.length ? 0 : 1);
