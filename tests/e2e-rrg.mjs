/**
 * RRG 版塊輪動頁 — 端對端測試（需要執行中的伺服器）
 *
 * 用法：
 *   node tests/e2e-rrg.mjs                       # 預設打 http://127.0.0.1:5177
 *   BASE=http://127.0.0.1:5411 node tests/e2e-rrg.mjs
 *
 * 為什麼要這一支（而不是只靠 rrg-unit.cjs）：
 *   單元測試證明「計算對」，但證明不了「畫得出來」。
 *   實際開發時就發生過：計算全對、API 回 200、表格有 11 列、
 *   console 沒有任何錯誤——但整頁 0 寬 0 高，因為 <div> 漏收一個結尾，
 *   #viewRrg 變成了 hidden 的 #viewMacro 的子節點。
 *   這種錯只有真的把頁面開起來量尺寸才抓得到。
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5177';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else {
    fail += 1;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

console.log(`\n=== RRG e2e（${BASE}）===\n`);

/* ---------- 1. 載入並等到有資料 ---------- */
await page.goto(`${BASE}/#/rrg`, { waitUntil: 'domcontentloaded' });

let loaded = true;
try {
  await page.waitForFunction(() => {
    const t = document.getElementById('rrgTableBody');
    return t && t.querySelectorAll('tr[data-key]').length > 0;
  }, { timeout: 60000 });
} catch {
  loaded = false;
}

check('頁面載入後表格有資料列', loaded);
if (!loaded) {
  console.log('\n無法取得資料，後續檢查略過。');
  await browser.close();
  process.exit(1);
}

/* ---------- 2. 佈局真的可見（漏 </div> 的回歸測試） ---------- */
const layout = await page.evaluate(() => {
  const v = document.getElementById('viewRrg');
  const r = v.getBoundingClientRect();
  const cv = document.getElementById('rrgCanvas');
  return {
    viewVisible: !v.hidden,
    viewW: Math.round(r.width),
    viewH: Math.round(r.height),
    canvasW: cv.width,
    canvasH: cv.height,
    cssW: parseFloat(cv.style.width) || 0,
    cssH: parseFloat(cv.style.height) || 0,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});
check('檢視容器可見且有實際尺寸', layout.viewVisible && layout.viewW > 300 && layout.viewH > 300,
  `w=${layout.viewW} h=${layout.viewH}`);
check('畫布有實際像素尺寸', layout.canvasW > 0 && layout.canvasH > 0 && layout.cssW > 0,
  `canvas=${layout.canvasW}x${layout.canvasH} css=${layout.cssW}x${layout.cssH}`);
check('桌面寬度無水平溢出', !layout.overflowX);

/* ---------- 3. 畫布確實畫了東西 ---------- */
const drawn = await page.evaluate(() => {
  const c = document.getElementById('rrgCanvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let nonWhite = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) nonWhite += 1;
  }
  return nonWhite;
});
check('畫布非空白（有實際繪製內容）', drawn > 5000, `非白像素 ${drawn}`);

/* ---------- 4. 控制項齊全且有選項 ---------- */
const controls = await page.evaluate(() => ({
  timeframes: document.querySelectorAll('#rrgTimeframe option').length,
  windows: document.querySelectorAll('#rrgWindow option').length,
  benchmarks: document.querySelectorAll('#rrgBenchmark option').length,
  chips: document.querySelectorAll('#rrgSectorChips .rrg-chip').length,
  hasTrail: !!document.getElementById('rrgTrail'),
  hasPeriod: !!document.getElementById('rrgPeriod'),
}));
check('週期選單有 3 個選項', controls.timeframes === 3, `實際 ${controls.timeframes}`);
check('觀察區間選單有 5 個選項', controls.windows === 5, `實際 ${controls.windows}`);
check('基準指數選單有 5 個選項', controls.benchmarks === 5, `實際 ${controls.benchmarks}`);
check('版塊勾選有 11 個', controls.chips === 11, `實際 ${controls.chips}`);
check('尾跡與平滑週期滑桿存在', controls.hasTrail && controls.hasPeriod);

/* ---------- 5. 表格欄位真的有值 ---------- */
const row = await page.evaluate(() => {
  const tr = document.querySelector('#rrgTableBody tr[data-key]');
  const tds = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
  return { cells: tds, count: document.querySelectorAll('#rrgTableBody tr[data-key]').length };
});
check('表格有 11 列', row.count === 11, `實際 ${row.count}`);
check('表格 9 個欄位都有內容（無 undefined / NaN / —）',
  row.cells.length === 9 &&
  row.cells.every((c) => c && c !== 'undefined' && c !== 'NaN' && c !== '—'),
  row.cells.join(' | '));

/* ---------- 6. 懸停顯示 tooltip（含數值與象限） ---------- */
const tip = await page.evaluate(() => {
  const c = document.getElementById('rrgCanvas');
  const r = c.getBoundingClientRect();
  for (let y = 20; y < r.height; y += 10) {
    for (let x = 20; x < r.width; x += 10) {
      c.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
      const t = document.getElementById('rrgTip');
      if (t && !t.hidden && t.textContent.trim()) {
        const b = t.getBoundingClientRect();
        return {
          text: t.textContent.replace(/\s+/g, ' ').trim(),
          insideViewport: b.left >= 0 && b.top >= 0 &&
                          b.right <= window.innerWidth + 1 && b.bottom <= window.innerHeight + 1,
        };
      }
    }
  }
  return null;
});
check('懸停能命中資料點並顯示 tooltip', !!tip, '掃描整個畫布未命中');
if (tip) {
  check('tooltip 含 RS-Ratio 與 RS-Momentum', /RS-Ratio/.test(tip.text) && /RS-Momentum/.test(tip.text));
  check('tooltip 含所在象限', /領先|弱化|落後|改善/.test(tip.text));
  check('tooltip 完整落在視口內', tip.insideViewport);
}

/* ---------- 7. 切換基準指數 ---------- */
const beforeSwitch = await page.evaluate(() => document.getElementById('rrgStamp').textContent);
await page.selectOption('#rrgBenchmark', 'QQQ');
await page.waitForTimeout(3000);
const afterSwitch = await page.evaluate(() => ({
  stamp: document.getElementById('rrgStamp').textContent,
  rows: document.querySelectorAll('#rrgTableBody tr[data-key]').length,
  sel: document.getElementById('rrgBenchmark').value,
}));
check('切換基準指數後仍正常出圖', afterSwitch.rows === 11 && afterSwitch.sel === 'QQQ',
  `rows=${afterSwitch.rows} sel=${afterSwitch.sel}`);

/* ---------- 8. 切換時間週期 ---------- */
await page.selectOption('#rrgTimeframe', 'monthly');
await page.waitForTimeout(3500);
const monthly = await page.evaluate(() => ({
  rows: document.querySelectorAll('#rrgTableBody tr[data-key]').length,
  stamp: document.getElementById('rrgStamp').textContent,
  period: document.getElementById('rrgPeriodVal').textContent,
}));
check('切換月線後仍正常出圖', monthly.rows === 11, `rows=${monthly.rows}`);
check('月線的預設平滑週期套用為 8', monthly.period === '8', `實際 ${monthly.period}`);

/* ---------- 9. 短區間要出現警告 ---------- */
await page.selectOption('#rrgWindow', '3m');
await page.waitForTimeout(3000);
const shortWin = await page.evaluate(() => {
  const n = document.getElementById('rrgNotice');
  return { hidden: n.hidden, cls: n.className, text: n.textContent.replace(/\s+/g, ' ').trim() };
});
check('月線 3 個月會提示尾跡太短', !shortWin.hidden && /尾跡/.test(shortWin.text),
  `hidden=${shortWin.hidden} text=${shortWin.text}`);

/* ---------- 10. 版塊篩選 ---------- */
await page.selectOption('#rrgTimeframe', 'weekly');
await page.waitForTimeout(3200);
await page.evaluate(() => {
  const box = document.querySelector('#rrgSectorChips input[type="checkbox"]:checked');
  if (box) { box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.waitForTimeout(3200);
const filtered = await page.evaluate(() => document.querySelectorAll('#rrgTableBody tr[data-key]').length);
check('取消一個版塊後剩 10 列', filtered === 10, `實際 ${filtered}`);

/* ---------- 11. 無 JS 錯誤 ---------- */
check('無未捕捉的頁面錯誤', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
check('無 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

/* ---------- 12. 手機寬度不破版 ---------- */
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await mctx.newPage();
await mp.goto(`${BASE}/#/rrg`, { waitUntil: 'domcontentloaded' });
let mLoaded = true;
try {
  await mp.waitForFunction(() => document.querySelectorAll('#rrgTableBody tr[data-key]').length > 0,
    { timeout: 60000 });
} catch { mLoaded = false; }
check('手機寬度下能載入', mLoaded);
if (mLoaded) {
  const mb = await mp.evaluate(() => {
    const c = document.getElementById('rrgCanvas');
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      canvasFits: parseFloat(c.style.width) <= window.innerWidth,
      tableScrollable: document.querySelector('.rrg-table-wrap').scrollWidth >
                       document.querySelector('.rrg-table-wrap').clientWidth,
    };
  });
  check('手機無水平溢出', !mb.overflowX);
  check('手機畫布寬度不超出視口', mb.canvasFits);
  check('手機表格可橫向捲動（預期行為）', mb.tableScrollable);
}

/* ---------- 13. 其他路由未被破壞 ---------- */
const otherRoutes = ['#/predict', '#/screen', '#/macro'];
for (const r of otherRoutes) {
  await page.goto(`${BASE}/${r}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  const st = await page.evaluate(() => {
    const views = ['viewChart', 'viewScreen', 'viewMacro', 'viewRrg'];
    const visible = views.filter((v) => {
      const e = document.getElementById(v);
      return e && !e.hidden;
    });
    return { visible, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
  check(`${r} 只顯示一個檢視且不破版`,
    st.visible.length === 1 && !st.overflow,
    `visible=${JSON.stringify(st.visible)}`);
}

await browser.close();

console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
if (fail) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f.name}${f.detail ? '：' + f.detail : ''}`));
}
process.exit(fail === 0 ? 0 : 1);
