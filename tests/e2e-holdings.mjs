/**
 * 版塊權重股 — 瀏覽器 e2e（需先啟動伺服器）
 * ==========================================
 *
 * 為什麼這塊一定要有 e2e：
 *   上一個 RRG 版本最大的 bug（#viewRrg 尺寸 0×0）在單元測試、API 測試、
 *   甚至 DOM id 檢查中全部通過，只有實際量測 element 寬高才發現。
 *   同理，這次的風險是：
 *     - 表格長出 10 列但四個區間全是空白（資料有到、渲染沒到）
 *     - 整列可點但點下去沒反應（事件綁在錯的節點）
 *     - 跳轉後分析頁是空的（路由對了但查詢沒觸發）
 *   這些都只有真的開瀏覽器才驗得出來。
 *
 * 用法：
 *   BASE=http://127.0.0.1:5432 node tests/e2e-holdings.mjs
 *   預設 BASE=http://127.0.0.1:3000
 */

import { chromium } from 'playwright';

const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

console.log(`\n=== 版塊權重股 e2e（${BASE}）===\n`);

try {
  await page.goto(`${BASE}/#/rrg`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForSelector('#rrgHoldBody tr[data-symbol]', { timeout: 90000 });
  await page.waitForTimeout(1500);

  /* ---------- 基本渲染 ---------- */
  const base = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#rrgHoldBody tr')];
    const tbl = document.getElementById('rrgHoldTable');
    const wrap = tbl.closest('.rrg-table-wrap');
    const card = document.querySelector('.rrg-hold-card');
    const first = rows[0];
    return {
      rowCount: rows.length,
      clickable: rows.filter((r) => r.hasAttribute('data-symbol')).length,
      firstCells: first ? [...first.querySelectorAll('td')].map((td) => td.textContent.trim()) : [],
      headers: [...document.querySelectorAll('#rrgHoldTable thead th')].map((t) => t.textContent.trim()),
      cardW: Math.round(card.getBoundingClientRect().width),
      cardH: Math.round(card.getBoundingClientRect().height),
      tableW: Math.round(tbl.getBoundingClientRect().width),
      wrapScrollW: wrap.scrollWidth,
      meta: (document.getElementById('rrgHoldMeta') || {}).textContent || '',
      sectorOpts: document.getElementById('rrgHoldSector')?.options.length || 0,
      limitOpts: document.getElementById('rrgHoldLimit')?.options.length || 0,
    };
  });

  ok('權重股表格有資料列', base.rowCount === 10, `實際 ${base.rowCount} 列`);
  ok('每一列都可點擊（有 data-symbol）', base.clickable === base.rowCount,
    `可點 ${base.clickable} / 共 ${base.rowCount}`);
  ok('卡片有實際尺寸（非 0×0）', base.cardW > 400 && base.cardH > 100,
    `${base.cardW}×${base.cardH}`);
  ok('七個欄位標題正確', base.headers.length === 7 &&
    /代碼/.test(base.headers[0]) && /權重/.test(base.headers[1]) &&
    /1\s*日/.test(base.headers[2]) && /1\s*週/.test(base.headers[3]) &&
    /1\s*個月/.test(base.headers[4]) && /3\s*個月/.test(base.headers[5]) &&
    /分析/.test(base.headers[6]),
    JSON.stringify(base.headers));

  /* 每列七個儲存格都要有內容，不能是 undefined / NaN */
  const cellCheck = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#rrgHoldBody tr')];
    const bad = [];
    rows.forEach((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      if (tds.length !== 7) { bad.push(`${tr.getAttribute('data-symbol')}: ${tds.length} 格`); return; }
      tds.forEach((td, i) => {
        const t = td.textContent.trim();
        if (!t || t === 'undefined' || t === 'NaN' || t === 'null') {
          bad.push(`${tr.getAttribute('data-symbol')} 第 ${i + 1} 格為「${t}」`);
        }
      });
    });
    return bad;
  });
  ok('所有列的七個儲存格都有內容（無 undefined / NaN）', cellCheck.length === 0,
    cellCheck.slice(0, 5).join('；'));

  /* 報酬數值必須是「數字%」格式，且有正負 */
  const fmtCheck = await page.evaluate(() => {
    const rets = [...document.querySelectorAll('#rrgHoldBody .rrg-ret')].map((e) => e.textContent.trim());
    const isPct = (s) => /^[+\-]\d+\.\d{2}%$/.test(s);
    const valid = rets.filter(isPct).length;
    const dashed = rets.filter((s) => s === '—').length;
    return { total: rets.length, valid, dashed, sample: rets.slice(0, 6) };
  });
  ok('報酬格式為「±X.XX%」', fmtCheck.valid > 0 && fmtCheck.valid + fmtCheck.dashed === fmtCheck.total,
    `有效 ${fmtCheck.valid} / 共 ${fmtCheck.total}，範例 ${JSON.stringify(fmtCheck.sample)}`);

  /* 權重格式 */
  const wCheck = await page.evaluate(() =>
    [...document.querySelectorAll('#rrgHoldBody .rrg-hold-w')].map((e) => e.textContent.trim()));
  ok('權重顯示為百分比', wCheck.length === 10 && wCheck.every((s) => /^\d+\.\d{2}%$/.test(s)),
    JSON.stringify(wCheck.slice(0, 4)));

  /* 正負顏色不同 */
  const colors = await page.evaluate(() => {
    const up = document.querySelector('#rrgHoldBody .rrg-ret.up');
    const down = document.querySelector('#rrgHoldBody .rrg-ret.down');
    return {
      up: up ? getComputedStyle(up).color : null,
      down: down ? getComputedStyle(down).color : null,
    };
  });
  ok('上漲與下跌使用不同顏色', colors.up !== null && colors.down !== null && colors.up !== colors.down,
    `上漲 ${colors.up} / 下跌 ${colors.down}`);
  ok('上漲為紅色系（台／港／陸股慣例）', /rgb\(2[0-4]\d,\s*\d{1,2},\s*\d{1,2}\)/.test(colors.up || ''),
    `實際 ${colors.up}`);

  /* meta 資訊 */
  ok('顯示版塊、基金名、基準日與檔數', /資訊科技|金融|科技/.test(base.meta) && /持股基準日/.test(base.meta),
    base.meta.slice(0, 100));

  /* 控制項 */
  ok('版塊下拉有 11 個選項', base.sectorOpts === 11, `實際 ${base.sectorOpts}`);
  ok('檔數下拉有 4 個選項', base.limitOpts === 4, `實際 ${base.limitOpts}`);

  /* ---------- 切換版塊 ---------- */
  const beforeFirst = await page.evaluate(() =>
    document.querySelector('#rrgHoldBody tr[data-symbol]')?.getAttribute('data-symbol'));
  await page.selectOption('#rrgHoldSector', 'XLU');
  await page.waitForTimeout(3000);
  const afterSwitch = await page.evaluate(() => ({
    first: document.querySelector('#rrgHoldBody tr[data-symbol]')?.getAttribute('data-symbol'),
    rows: document.querySelectorAll('#rrgHoldBody tr[data-symbol]').length,
    meta: (document.getElementById('rrgHoldMeta') || {}).textContent || '',
    sel: document.getElementById('rrgHoldSector')?.value,
  }));
  ok('切換版塊後持股隨之改變', afterSwitch.first !== beforeFirst && afterSwitch.rows > 0,
    `${beforeFirst} → ${afterSwitch.first}`);
  ok('切換後 meta 更新為新版塊', /公用事業/.test(afterSwitch.meta), afterSwitch.meta.slice(0, 80));
  ok('下拉值同步為 XLU', afterSwitch.sel === 'XLU', afterSwitch.sel);

  /* ---------- 切換檔數 ---------- */
  await page.selectOption('#rrgHoldLimit', '5');
  await page.waitForTimeout(2500);
  const lim = await page.evaluate(() => document.querySelectorAll('#rrgHoldBody tr[data-symbol]').length);
  ok('切換為前 5 大後只剩 5 列', lim === 5, `實際 ${lim}`);

  await page.selectOption('#rrgHoldLimit', '20');
  await page.waitForTimeout(4000);
  const lim20 = await page.evaluate(() => document.querySelectorAll('#rrgHoldBody tr[data-symbol]').length);
  ok('切換為前 20 大後有 20 列（XLU 共 31 檔，足夠）', lim20 === 20, `實際 ${lim20}`);

  /* ---------- 跳轉 AI 分析頁 ---------- */
  await page.selectOption('#rrgHoldSector', 'XLK');
  await page.waitForTimeout(3000);
  await page.selectOption('#rrgHoldLimit', '10');
  await page.waitForTimeout(2500);

  await page.click('#rrgHoldBody tr[data-symbol] a.rrg-hold-go');
  await page.waitForURL(/#\/detail\//, { timeout: 30000 });
  await page.waitForFunction(() => {
    const r = document.getElementById('result');
    if (!r || r.hidden) return false;
    const t = r.textContent || '';
    return t.length > 200 && /\d/.test(t);
  }, { timeout: 90000 });
  await page.waitForTimeout(1200);

  const detail = await page.evaluate(() => ({
    hash: location.hash,
    crumb: (document.getElementById('detailCrumb') || {}).textContent || '',
    detailMode: document.body.classList.contains('detail-mode'),
    rrgHidden: document.getElementById('viewRrg')?.hidden,
    chartHidden: document.getElementById('viewChart')?.hidden,
    resultLen: (document.getElementById('result')?.textContent || '').length,
    backVisible: !document.getElementById('detailBack')?.hidden,
  }));
  ok('點「分析」會跳到 #/detail/<代碼>', /^#\/detail\/[A-Z.\-]+$/.test(detail.hash), detail.hash);
  ok('分析頁真的渲染出內容（不只是空殼）', detail.resultLen > 500, `${detail.resultLen} 字元`);
  ok('麵包屑顯示代碼', /個股詳情/.test(detail.crumb), detail.crumb);
  ok('詳情模式正確切換（RRG 隱藏、圖表顯示）',
    detail.rrgHidden === true && detail.chartHidden === false,
    `rrg hidden=${detail.rrgHidden}, chart hidden=${detail.chartHidden}`);
  ok('返回列可見', detail.backVisible === true);

  /* 返回應回到 RRG */
  await page.click('#detailBack');
  await page.waitForTimeout(2500);
  const back = await page.evaluate(() => ({
    hash: location.hash,
    rrgVisible: document.getElementById('viewRrg')?.hidden === false,
  }));
  ok('返回後回到 RRG 檢視', back.hash === '#/rrg' && back.rrgVisible,
    `${back.hash} / visible=${back.rrgVisible}`);

  /* ---------- 點整列（非連結）也要能跳 ---------- */
  await page.waitForSelector('#rrgHoldBody tr[data-symbol]', { timeout: 60000 });
  await page.waitForTimeout(1000);
  const rowSym = await page.evaluate(() =>
    document.querySelectorAll('#rrgHoldBody tr[data-symbol]')[1]?.getAttribute('data-symbol'));
  await page.click('#rrgHoldBody tr[data-symbol]:nth-of-type(2) td.rrg-hold-w');
  await page.waitForTimeout(3000);
  const rowJump = await page.evaluate(() => location.hash);
  ok('點整列（非「分析」連結）也能跳轉', rowJump === `#/detail/${rowSym}`,
    `期望 #/detail/${rowSym}，得 ${rowJump}`);

  /* ---------- 手機版 ---------- */
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mob.goto(`${BASE}/#/rrg`, { waitUntil: 'networkidle', timeout: 120000 });
  await mob.waitForSelector('#rrgHoldBody tr[data-symbol]', { timeout: 90000 });
  await mob.waitForTimeout(1500);
  const m = await mob.evaluate(() => {
    const doc = document.documentElement;
    const tbl = document.getElementById('rrgHoldTable');
    const wrap = tbl.closest('.rrg-table-wrap');
    const go = document.querySelector('.rrg-hold-go');
    return {
      docOverflow: doc.scrollWidth > doc.clientWidth + 1,
      scrollW: doc.scrollWidth, clientW: doc.clientWidth,
      tableScrollable: wrap.scrollWidth > wrap.clientWidth + 1,
      wrapW: Math.round(wrap.getBoundingClientRect().width),
      tableW: Math.round(tbl.getBoundingClientRect().width),
      rows: document.querySelectorAll('#rrgHoldBody tr[data-symbol]').length,
      goH: go ? Math.round(go.getBoundingClientRect().height) : 0,
    };
  });
  ok('手機版無水平溢出', m.docOverflow === false, `${m.scrollW} vs ${m.clientW}`);
  ok('手機版表格在容器內橫向捲動', m.tableScrollable === true,
    `wrap ${m.wrapW} / table ${m.tableW}`);
  ok('手機版仍載入 10 列', m.rows === 10, `實際 ${m.rows}`);
  ok('手機版「分析」點擊目標不為 0', m.goH > 0, `高 ${m.goH}px`);
  await mob.close();

  /* ---------- 錯誤處理 ---------- */
  ok('無未捕捉的頁面錯誤', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
  ok('無 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join('; '));

  /* API 錯誤路徑 */
  const badSector = await page.evaluate(async (base) => {
    const r = await fetch(base + '/api/rrg/holdings?sector=ZZZ');
    const j = await r.json();
    return { status: r.status, code: j.error && j.error.code, hint: j.error && j.error.hint };
  }, BASE);
  ok('無效版塊回 400 並附可用清單', badSector.status === 400 &&
    badSector.code === 'BAD_SECTOR' && /XLK/.test(badSector.hint || ''),
    JSON.stringify(badSector));

  const badLimit = await page.evaluate(async (base) => {
    const r = await fetch(base + '/api/rrg/holdings?sector=XLK&limit=999');
    const j = await r.json();
    return { status: r.status, code: j.error && j.error.code };
  }, BASE);
  ok('無效 limit 回 400 BAD_LIMIT', badLimit.status === 400 && badLimit.code === 'BAD_LIMIT',
    JSON.stringify(badLimit));

  /* ---------- 錯誤 / 空資料狀態（攔截 API 模擬） ---------- */
  /* 必須封鎖 Service Worker：fetch 會由 SW 接管，page.route 攔不到，
     模擬會「看起來生效但實際打到真後端」，測出來的結果毫無意義。 */
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const p2 = await ctx2.newPage();

  await p2.route('**/api/rrg/holdings**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { code: 'HOLDINGS_FETCH', message: '無法取得持股檔', hint: '請稍後重試' } }),
  }));
  await p2.goto(`${BASE}/#/rrg`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p2.waitForSelector('#rrgHoldRetry', { timeout: 90000 });
  const errState = await p2.evaluate(() => ({
    meta: (document.getElementById('rrgHoldMeta') || {}).textContent || '',
    metaErr: (document.getElementById('rrgHoldMeta') || {}).className || '',
    hasRetry: !!document.getElementById('rrgHoldRetry'),
    chartRows: document.querySelectorAll('#rrgTableBody tr[data-key]').length,
  }));
  ok('上游失敗時顯示可重試的錯誤訊息', errState.hasRetry && /無法取得持股檔/.test(errState.meta),
    errState.meta.slice(0, 80));
  ok('錯誤狀態套用警示樣式', /err/.test(errState.metaErr), errState.metaErr);
  ok('持股失敗不影響上方輪動圖', errState.chartRows === 11, `${errState.chartRows} 列`);

  /* 空資料（200 但 0 列） */
  await p2.unroute('**/api/rrg/holdings**');
  await p2.route('**/api/rrg/holdings**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true, sector: 'XLK', sectorLabel: '資訊科技', sectorShort: '科技',
      fundName: 'Test Fund', asOf: '24-Nov-2026',
      limits: { requested: 10, returned: 0, totalInFund: 0, truncated: false },
      periods: [], rows: [], failures: [], source: 'ssga', holdingsCached: false,
    }),
  }));
  await p2.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await p2.waitForTimeout(4000);
  const emptyState = await p2.evaluate(() => ({
    meta: (document.getElementById('rrgHoldMeta') || {}).textContent || '',
    metaCls: (document.getElementById('rrgHoldMeta') || {}).className || '',
    body: (document.getElementById('rrgHoldBody') || {}).textContent || '',
    colSpan: document.querySelector('#rrgHoldBody td')?.getAttribute('colspan'),
  }));
  ok('無資料時有明確說明', /沒有可顯示的股票部位/.test(emptyState.meta) || /無持股資料/.test(emptyState.body),
    emptyState.meta.slice(0, 60));
  ok('無資料的訊息占滿七欄（不破版）', emptyState.colSpan === '7', `colspan=${emptyState.colSpan}`);
  ok('無資料不套用錯誤色（不是系統壞了）', !/err/.test(emptyState.metaCls), emptyState.metaCls);

  /* 400 參數錯誤要與 503 訊息不同 */
  await p2.unroute('**/api/rrg/holdings**');
  await p2.route('**/api/rrg/holdings**', (route) => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { code: 'BAD_SECTOR', message: '不支援的版塊「ZZZ」', hint: '可用版塊：XLK、XLF' } }),
  }));
  await p2.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await p2.waitForTimeout(4000);
  const badState = await p2.evaluate(() =>
    (document.getElementById('rrgHoldMeta') || {}).textContent || '');
  ok('參數錯誤的訊息與上游失敗不同（使用者才知道該改什麼）',
    /持股檔無法取得/.test(badState) && !/取得資料失敗/.test(badState),
    badState.slice(0, 80));

  await ctx2.close();

} catch (e) {
  fail++;
  failures.push({ name: '執行時發生例外', detail: e.message });
  console.log(`  FAIL  執行時發生例外\n        ${e.message}`);
}

await browser.close();

console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
if (fail) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f.name}${f.detail ? '：' + f.detail : ''}`));
}
process.exit(fail === 0 ? 0 : 1);
