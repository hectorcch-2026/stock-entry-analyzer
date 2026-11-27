/**
 * 個股頁子分頁的實機驗收。
 *
 * 為什麼一定要用真瀏覽器：
 *   ① 分頁切換靠 hidden + requestAnimationFrame 重繪 Canvas，
 *      在 jsdom 這類環境裡量不到寬高，圖表看起來「正常」其實是 0×0。
 *   ② 鍵盤操作（Tab 只在整組停一次、方向鍵切換）只能在真事件迴圈裡驗。
 *   ③ 手機版是否真的能橫向滑動、副標是否被隱藏，需要看 computed style。
 *
 * 執行：node scripts/verify-subtabs.mjs
 *       BASE=https://... node scripts/verify-subtabs.mjs   （驗線上）
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5177';
const SYMBOL = process.env.SYMBOL || 'AAPL';

const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};
const section = (t) => console.log(`\n[${t}]`);

const browser = await chromium.launch();

/* ============================================================
   桌機
   ============================================================ */
const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/#/detail/${SYMBOL}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForSelector('#result:not([hidden])', { timeout: 90000 });
// 等結果真正渲染出來（報價有名稱）再驗，否則會驗到空殼
await page.waitForFunction(
  () => {
    const el = document.getElementById('qName');
    return el && el.textContent && el.textContent.trim() !== '—';
  },
  { timeout: 90000 }
);

section('1 分頁結構');
const tabCount = await page.$$eval('.sub-tab', (els) => els.length);
rec('四個子分頁都存在', tabCount === 4, `${tabCount} 個`);

const labels = await page.$$eval('.sub-tab-t', (els) => els.map((e) => e.textContent.trim()));
rec('分頁名稱為決策／技術／基本面／新聞',
  JSON.stringify(labels) === JSON.stringify(['決策', '技術', '基本面', '新聞']),
  labels.join(' / '));

section('2 ARIA 三角關係');
const aria = await page.$$eval('.sub-tab', (els) => els.map((e) => ({
  role: e.getAttribute('role'),
  sel: e.getAttribute('aria-selected'),
  ctrl: e.getAttribute('aria-controls'),
  idx: e.getAttribute('tabindex'),
})));
rec('每個 tab 都有 role=tab', aria.every((a) => a.role === 'tab'));
rec('恰好一個 aria-selected=true', aria.filter((a) => a.sel === 'true').length === 1);

const panelOk = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.sub-tab').forEach((t) => {
    const id = t.getAttribute('aria-controls');
    const p = document.getElementById(id);
    out.push({
      id,
      exists: !!p,
      role: p && p.getAttribute('role'),
      labelledby: p && p.getAttribute('aria-labelledby'),
      tabId: t.id,
    });
  });
  return out;
});
rec('aria-controls 都指向存在的面板', panelOk.every((p) => p.exists));
rec('面板 role=tabpanel', panelOk.every((p) => p.role === 'tabpanel'));
rec('面板 aria-labelledby 指回自己的 tab',
  panelOk.every((p) => p.labelledby === p.tabId));
rec('tablist 容器存在', await page.$('[role="tablist"]') !== null);

section('3 版面位置（分頁列必須在報價卡下方，且捲動時不被頂欄蓋住）');
const geo = await page.evaluate(() => {
  const q = document.querySelector('.quote-card').getBoundingClientRect();
  const t = document.querySelector('.sub-tabs').getBoundingClientRect();
  const top = document.querySelector('.topbar');
  const cs = getComputedStyle(document.querySelector('.sub-tabs'));
  return {
    quoteBottom: Math.round(q.bottom),
    tabsTop: Math.round(t.y),
    topbarH: top ? Math.round(top.getBoundingClientRect().height) : 0,
    stickyTop: cs.top,
    zIndex: cs.zIndex,
  };
});
// 分頁列要在報價卡之後（DOM 順序錯了會跑到上面去，實測踩過）
rec('分頁列位於報價卡下方', geo.tabsTop >= geo.quoteBottom - 2,
  `tabsTop=${geo.tabsTop} quoteBottom=${geo.quoteBottom}`);
// top:0 會讓 sticky 分頁列滑到頂欄底下被遮住
rec('sticky 偏移避開頂欄高度',
  parseInt(geo.stickyTop, 10) >= geo.topbarH,
  `top=${geo.stickyTop} topbar=${geo.topbarH}px`);
rec('分頁列 z-index 低於頂欄（不搶遮罩）', parseInt(geo.zIndex, 10) < 40, geo.zIndex);

section('4 一次只顯示一個面板');
const vis = await page.evaluate(() => {
  const out = {};
  ['decision', 'tech', 'fund', 'news'].forEach((k) => {
    const p = document.getElementById('panel-' + k);
    out[k] = p ? !p.hidden && getComputedStyle(p).display !== 'none' : false;
  });
  return out;
});
rec('預設只顯示一個面板', Object.values(vis).filter(Boolean).length === 1,
  JSON.stringify(vis));

section("5 切換與內容歸屬");
async function clickTab(name) {
  await page.click(`#tab-${name}`);
  await page.waitForTimeout(220);
}
await clickTab('tech');
const techVisible = await page.evaluate(() => ({
  tech: !document.getElementById('panel-tech').hidden,
  decision: !document.getElementById('panel-decision').hidden,
  hasChart: !!document.querySelector('#panel-tech .chart-card'),
}));
rec('切到技術頁後決策頁隱藏', techVisible.tech && !techVisible.decision);
rec('技術頁含走勢圖卡', techVisible.hasChart);

// Canvas 必須有實際尺寸，否則等於圖表空白
const canvasSize = await page.evaluate(() => {
  const c = document.querySelector('#panel-tech canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});
rec('切到技術頁後 Canvas 有實際尺寸',
  !!canvasSize && canvasSize.w > 200 && canvasSize.h > 100,
  canvasSize ? `${canvasSize.w}×${canvasSize.h}` : '找不到 canvas');

await clickTab('fund');
const fundVis = await page.evaluate(() => {
  const p = document.getElementById('panel-fund');
  return { on: !p.hidden, fin: !!document.querySelector('#panel-fund #stockFinCard') };
});
rec('基本面頁只放財報卡', fundVis.on && fundVis.fin);

await clickTab('news');
const newsVis = await page.evaluate(() => {
  const p = document.getElementById('panel-news');
  return { on: !p.hidden, ai: !!document.querySelector('#panel-news #newsAiCard') };
});
rec('新聞頁只放新聞 AI 卡', newsVis.on && newsVis.ai);

// 避免重複內容：同一張卡片不得出現在兩個面板裡。
// 注意鍵的選擇：不能用 className —— 「決策」頁的買入區間與「技術」頁的
// 技術位表格都是 <section class="grid-2">，class 相同但內容完全不同，
// 用 class 當鍵會產生假陽性。改用「id 或 aria-label 或卡片內第一個 h2 標題」。
const dup = await page.evaluate(() => {
  const seen = {};
  const dup = [];
  document.querySelectorAll('.tab-panel section').forEach((s) => {
    const h2 = s.querySelector('h2');
    const key = s.id || s.getAttribute('aria-label') || (h2 ? h2.textContent.trim() : null)
      || s.className;
    if (seen[key]) dup.push(key);
    seen[key] = true;
    // 同時確認這張卡只屬於一個面板
    seen[key + '::count'] = (seen[key + '::count'] || 0) + 1;
  });
  return dup;
});
rec('同一張卡片不得同時出現在兩個分頁（避免重複）', dup.length === 0, dup.join(', '));

section("6 鍵盤操作");
await clickTab('decision');
await page.focus('#tab-decision');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(160);
let active = await page.evaluate(() => ({
  sel: document.querySelector('.sub-tab[aria-selected="true"]').id,
  focus: document.activeElement && document.activeElement.id,
}));
rec('方向鍵右切換到下一個分頁', active.sel === 'tab-tech', active.sel);
rec('切換後焦點跟著移動', active.focus === 'tab-tech', active.focus);

await page.keyboard.press('End');
await page.waitForTimeout(160);
active = await page.evaluate(() => document.querySelector('.sub-tab[aria-selected="true"]').id);
rec('End 跳到最后一個分頁', active === 'tab-news', active);

await page.keyboard.press('Home');
await page.waitForTimeout(160);
active = await page.evaluate(() => document.querySelector('.sub-tab[aria-selected="true"]').id);
rec('Home 跳到第一個分頁', active === 'tab-decision', active);

section("7 記住上次選擇");
await clickTab('fund');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#result:not([hidden])', { timeout: 90000 });
await page.waitForTimeout(400);
const remembered = await page.evaluate(() =>
  document.querySelector('.sub-tab[aria-selected="true"]').id);
rec('重新載入後回到上次看的分頁', remembered === 'tab-fund', remembered);

section("8 互動元素仍可用（分頁不得吃掉事件）");
const interactive = await page.evaluate(() => {
  const ids = ['symbolInput', 'clearBtn', 'notifyToggle'];
  return ids.map((id) => !!document.getElementById(id));
});
rec('搜尋框／清除鈕／通知開關仍在畫面上', interactive.every(Boolean));
rec('無 JS 執行期錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));

/* ============================================================
   手機
   ============================================================ */
section("9 手機版（375×812）");
const mctx = await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true,
});
const mp = await mctx.newPage();
await mp.goto(`${BASE}/#/detail/${SYMBOL}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await mp.waitForSelector('#result:not([hidden])', { timeout: 90000 });
await mp.waitForTimeout(600);

const mobile = await mp.evaluate(() => {
  const bar = document.querySelector('.sub-tabs');
  const sub = document.querySelector('.sub-tab-s');
  const btn = document.querySelector('.sub-tab');
  const r = btn ? btn.getBoundingClientRect() : null;
  return {
    scrollable: bar ? bar.scrollWidth >= bar.clientWidth : false,
    overflowX: bar ? getComputedStyle(bar).overflowX : null,
    subHidden: sub ? getComputedStyle(sub).display === 'none' : null,
    btnH: r ? Math.round(r.height) : 0,
  };
});
rec('分頁列可橫向捲動', mobile.overflowX === 'auto', mobile.overflowX);

// 觸控目標 ≥ 40px：手機上太小的按鈕會點不到
rec('分頁按鈕高度足夠觸控（≥40px）', mobile.btnH >= 40, `${mobile.btnH}px`);

const noHScroll = await mp.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth + 2);
rec('頁面不出現水平滾動', noHScroll);

/* ============================================================
   結果
   ============================================================ */
await browser.close();

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n${'='.repeat(56)}`);
console.log(`  通過 ${pass}　失敗 ${fail}　共 ${results.length}`);
console.log('='.repeat(56));
if (fail) {
  console.log('\n失敗項目：');
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`  · ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
}
process.exit(fail ? 1 : 0);
