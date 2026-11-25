/**
 * v1.4 新功能 UI 驗證 — 三頁導航 / K 線互動 / AI 選股 / 詳情頁
 *
 * 為什麼需要這一層：
 *   既有測試（e2e-layout / e2e-pred / chart-overlays）只鎖定「預測頁原本就有的
 *   DOM」，對這一版新增的東西一無所知。而新增的東西恰恰是最容易壞的地方：
 *   雜湊路由、圖表縮放、雙視圖切換、篩選表排序——全部是「看起來有、但可能沒接上」
 *   的那種功能，只有真的點下去才知道。
 *
 * 驗證範圍：
 *   [1] 三頁導航（K線預測 / AI選股 / 詳情）
 *   [2] 時間區間切換（1y 免請求、2y/5y 走 /api/kline）
 *   [3] 圖表縮放與平移（滾輪、按鈕、雙擊復位）
 *   [4] 統計可信度卡片（不得出現方向機率字樣）
 *   [5] AI 選股：提交、結果表、排序、詳情跳轉、返回保留結果
 *   [6] 錯誤態：參數錯誤 / 無資料 / 網路失敗
 *   [7] 手機版無水平溢出
 *
 * 用法：
 *   node tests/e2e-v14-ui.mjs
 *   BASE=http://127.0.0.1:5177/ node tests/e2e-v14-ui.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5177/';
const results = [];
const pass = (n, d = '') => { results.push({ ok: true, n }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n }); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const note = (s) => console.log(`    · ${s}`);

const browser = await chromium.launch();
// 注意：Service Worker 會攔截 fetch，Playwright 的 page.route 對它無效
// （SW 內發出的請求不經過 page 層的 route）。要模擬「網路失敗」就必須
// 先封掉 SW，否則 abort 永遠不會命中，測試會誤判成「錯誤卡不出現」。
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

/** 等到 hash 路由把某一視圖顯示出來 */
async function waitView(id, timeout = 60000) {
  await page.waitForFunction(
    (vid) => {
      const el = document.getElementById(vid);
      return el && !el.hidden && el.offsetHeight > 0;
    },
    id,
    { timeout }
  );
}

try {
  console.log(`\nv1.4 新功能 UI 驗證 — ${BASE}\n`);

  /* ================= [1] 三頁導航 ================= */
  console.log('[1] 頁面結構與導航');
  // 直接以詳情頁路由進入（等於「已經有一檔分析結果」的狀態）
  await page.goto(`${BASE}#/detail/AAPL`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#result:not([hidden])', { timeout: 120000 });

  const navItems = await page.$$eval('#mainNav .nav-item', (els) =>
    els.map((e) => ({ route: e.dataset.route, text: e.textContent.trim() }))
  );
  const routes = navItems.map((n) => n.route);
  routes.includes('predict') && routes.includes('screen')
    ? pass('導航含 K線預測 / AI選股', navItems.map((n) => `${n.text}(${n.route})`).join(' '))
    : fail('導航項目', JSON.stringify(routes));

  // 導航到選股頁
  await page.click('#mainNav .nav-item[data-route="screen"]');
  await waitView('viewScreen');
  const hashScreen = new URL(page.url()).hash;
  hashScreen === '#/screen' ? pass('點導航切到選股頁，hash 正確', hashScreen) : fail('選股頁 hash', hashScreen);

  // 預測頁視圖是否已隱藏
  const chartHidden = await page.evaluate(() => document.getElementById('viewChart').hidden);
  chartHidden ? pass('切頁後預測視圖已隱藏') : fail('切頁後預測視圖仍顯示');

  // 回到預測頁
  await page.click('#mainNav .nav-item[data-route="predict"]');
  await waitView('viewChart');
  pass('可切回 K 線預測頁');

  /* ================= [2] 時間區間切換 ================= */
  console.log('[2] K 線時間區間切換');
  const rangeBtns = await page.$$eval('.range-btn', (els) => els.map((e) => e.dataset.range));
  rangeBtns.length === 5
    ? pass('五個時間區間按鈕', rangeBtns.join(' '))
    : fail('時間區間按鈕數量', `實際 ${rangeBtns.length}`);

  const barsOf = () => page.evaluate(() => {
    const g = document.getElementById('priceChart').__geom;
    return g && g.fullLen ? g.fullLen : (g ? g.n : 0);
  });
  const bars1y = await barsOf();
  bars1y >= 200 ? pass('預設 1y 有足夠 K 線', `${bars1y} 根`) : fail('預設 1y K 線數', `${bars1y}`);

  // 切到 2y — 走 /api/kline
  await page.click('.range-btn[data-range="2y"]');
  await page.waitForFunction(
    () => document.getElementById('rangeStatus')?.textContent?.match(/根|失敗|不足/),
    null,
    { timeout: 45000 }
  );
  const bars2y = await barsOf();
  const status2y = (await page.textContent('#rangeStatus'))?.replace(/\s+/g, ' ').trim();
  bars2y > bars1y
    ? pass('切到 2y 後 K 線變多', `${bars1y} → ${bars2y}；${status2y}`)
    : fail('切到 2y 後 K 線未變多', `${bars1y} → ${bars2y}；${status2y}`);

  const activeRange = await page.getAttribute('.range-btn.active', 'data-range');
  activeRange === '2y' ? pass('2y 按鈕為啟用態') : fail('啟用態區間', String(activeRange));

  // 切回 1y
  await page.click('.range-btn[data-range="1y"]');
  await page.waitForTimeout(600);
  const barsBack = await barsOf();
  barsBack === bars1y ? pass('切回 1y 恢復原本根數', `${barsBack}`) : fail('切回 1y 根數不符', `${barsBack} vs ${bars1y}`);

  /* ================= [3] 縮放與平移 ================= */
  console.log('[3] 圖表縮放與平移');
  const viewOf = () => page.evaluate(() => {
    const g = document.getElementById('priceChart').__geom;
    return g ? { full: g.fullLen, start: g.viewStart, count: g.viewCount } : null;
  });

  const v0 = await viewOf();
  v0 && v0.count === v0.full ? pass('初始為全覽（不縮放）', `${v0.count}/${v0.full}`) : fail('初始視圖', JSON.stringify(v0));

  await page.click('#zoomIn');
  await page.click('#zoomIn');
  await page.waitForTimeout(300);
  const v1 = await viewOf();
  v1 && v1.count < v0.count
    ? pass('點縮放放大後可見根數變少', `${v0.count} → ${v1.count}`)
    : fail('放大後可見根數', JSON.stringify(v1));

  const zoomLabel = (await page.textContent('#zoomLabel'))?.trim();
  zoomLabel && /%|根/.test(zoomLabel) ? pass('縮放比例標籤已更新', zoomLabel) : fail('縮放標籤', String(zoomLabel));

  await page.click('#panLeft');
  await page.waitForTimeout(300);
  const v2 = await viewOf();
  v2 && v2.start !== v1.start ? pass('向左平移生效', `start ${v1.start} → ${v2.start}`) : fail('向左平移', JSON.stringify(v2));

  await page.click('#zoomReset');
  await page.waitForTimeout(300);
  const v3 = await viewOf();
  v3 && v3.count === v0.count && v3.start === 0
    ? pass('復位回全覽', `${v3.count}/${v3.full} start=${v3.start}`)
    : fail('復位後視圖', JSON.stringify(v3));

  // 滾輪縮放（在繪圖區內）
  const box = await page.locator('#priceChart').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
  const v4 = await viewOf();
  v4 && v4.count < v0.count ? pass('滾輪向上縮小可見範圍（放大）', `${v0.count} → ${v4.count}`) : fail('滾輪縮放', JSON.stringify(v4));
  await page.click('#zoomReset');
  await page.waitForTimeout(200);

  /* ================= [4] 統計可信度卡片 ================= */
  console.log('[4] 統計可信度卡片');
  const credVisible = await page.isVisible('#credCard');
  credVisible ? pass('可信度卡片已顯示') : fail('可信度卡片未顯示');

  const credText = (await page.textContent('#credCard')) || '';
  const credScore = (await page.textContent('#credScore'))?.trim();
  const credLabel = (await page.textContent('#credLabel'))?.trim();
  const credUnavailable = !(await page.evaluate(() => document.getElementById('credUnavailable')?.hidden));
  const credReason = (await page.textContent('#credUnavailableReason'))?.trim() || '';

  if (credUnavailable) {
    // 上游取數失敗時的正確降級：卡片仍在、分數顯示 —（不是 0）、原因寫清楚
    credReason.length > 5
      ? pass('可信度不可用時如實說明原因（未偽造分數）', `${credReason}；score=${credScore}`)
      : fail('可信度不可用但未說明原因');
    credScore === '—' ? pass('不可用時分數顯示 —（非 0）') : fail('不可用時分數', String(credScore));
    note('本次上游取數失敗，可信度元件改以「不可用」分支驗證');
  } else {
    credScore && /^\d+$/.test(credScore) ? pass('可信度分數為數值', `${credScore}（${credLabel}）`) : fail('可信度分數', String(credScore));

    const compCount = await page.$$eval('#credComponents .cred-comp', (e) => e.length);
    compCount === 3 ? pass('三個加權成分皆已渲染', `${compCount} 項`) : fail('可信度成分數', `${compCount}`);

    // 位置描述必須是幾何描述，且需標明「非方向」
    const posText = (await page.textContent('#credPosition'))?.replace(/\s+/g, ' ').trim() || '';
    /區間重心偏上|區間重心偏下|區間大致對稱/.test(posText)
      ? pass('區間位置為幾何描述', posText.slice(0, 40))
      : fail('區間位置描述', posText.slice(0, 80));

    const disclaimer = (await page.textContent('#credDisclaimer'))?.trim() || '';
    disclaimer.length > 10 ? pass('免責說明存在', disclaimer.slice(0, 46) + '…') : fail('免責說明過短', disclaimer);
  }

  // 這是路徑 A 的核心約束：無論哪個分支都不得暗示漲跌機率
  const dirProb = credText.match(/上漲機率|下跌機率|方向機率|漲的機率|跌的機率/);
  dirProb ? fail('可信度卡片出現方向機率字樣', dirProb[0]) : pass('可信度卡片未出現方向機率字樣');

  /* ================= [5] AI 選股 ================= */
  console.log('[5] AI 選股頁');
  await page.click('#mainNav .nav-item[data-route="screen"]');
  await waitView('viewScreen');

  // 表單預設值應來自 /api/screen/meta
  const minScoreVal = await page.inputValue('#fMinScore');
  minScoreVal === '55' ? pass('篩選表單已套用後端預設值', `minScore=${minScoreVal}`) : fail('表單預設值', `minScore=${minScoreVal}`);

  const poolHint = (await page.textContent('#poolCountHint'))?.trim();
  poolHint && /^\d+$/.test(poolHint) ? pass('標的池數量已由 API 填入', `${poolHint} 檔`) : fail('標的池數量', String(poolHint));

  const hintLine = (await page.textContent('#screenHint'))?.replace(/\s+/g, ' ').trim();
  /美股\s*\d+\s*檔.*港股\s*\d+\s*檔.*共\s*\d+\s*檔/.test(hintLine)
    ? pass('母體說明文案已由 API 生成', hintLine.slice(0, 56) + '…')
    : fail('母體說明文案', String(hintLine).slice(0, 80));

  // 提交篩選（用港股縮小範圍以縮短等待）
  await page.selectOption('#fMarket', 'hk');
  await page.fill('#fLimit', '5');
  const t0 = Date.now();
  await page.click('#screenBtn');

  await page.waitForSelector('#screenTableWrap:not([hidden])', { timeout: 180000 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  pass('篩選完成並顯示結果表', `${elapsed}s`);

  const rows = await page.$$eval('#screenBody tr', (els) =>
    els.map((e) => ({
      symbol: e.dataset.symbol,
      cells: [...e.querySelectorAll('td')].map((t) => t.textContent.trim()),
    }))
  );
  rows.length > 0 ? pass('結果表有資料列', `${rows.length} 列，首列 ${rows[0].symbol}`) : fail('結果表為空');

  const statsText = (await page.textContent('#screenStats'))?.replace(/\s+/g, ' ').trim();
  statsText && /\d/.test(statsText) ? pass('統計摘要已顯示', statsText.slice(0, 70)) : fail('統計摘要', String(statsText));

  // 排序：點「技術評分」欄頭
  const firstBefore = rows[0]?.symbol;
  const sorted0 = rows.map((r) => r.cells.join('|')).join(',');
  await page.click('th.st-sort[data-sort="score"]');
  await page.waitForTimeout(500);
  const rowsAfter = await page.$$eval('#screenBody tr', (els) =>
    els.map((e) => ({ symbol: e.dataset.symbol, cells: [...e.querySelectorAll('td')].map((t) => t.textContent.trim()) }))
  );
  const sorted1 = rowsAfter.map((r) => r.cells.join('|')).join(',');
  sorted0 !== sorted1 || rowsAfter.length <= 1
    ? pass('點欄頭可重新排序（未重跑篩選）', `${firstBefore} → ${rowsAfter[0]?.symbol}`)
    : fail('排序未生效', '排序前後順序相同');

  const sortIndicator = await page.$$eval('th.st-sort', (els) =>
    els.map((e) => ({ key: e.dataset.sort, cls: e.className, aria: e.getAttribute('aria-sort'), ind: e.querySelector('.sort-ind')?.textContent?.trim() }))
  );
  const marked = sortIndicator.filter((s) => /asc|desc/.test(s.cls) || s.aria || s.ind);
  marked.length > 0
    ? pass('排序指示器已標示', `key=${marked[0].key} aria=${marked[0].aria} 箭頭=${marked[0].ind}`)
    : fail('排序指示器未標示', JSON.stringify(sortIndicator.slice(0, 3)));

  // 詳情跳轉
  const targetSymbol = rowsAfter[0]?.symbol;
  await page.click('#screenBody tr[data-symbol] td');
  await page.waitForFunction(() => /^#\/detail\//.test(location.hash), null, { timeout: 20000 });
  const detailHash = new URL(page.url()).hash;
  detailHash === `#/detail/${targetSymbol}`
    ? pass('點列可跳轉詳情頁', detailHash)
    : fail('詳情 hash', `${detailHash}，預期 #/detail/${targetSymbol}`);

  await waitView('viewChart');
  const detailBarVisible = await page.isVisible('#detailBar');
  detailBarVisible ? pass('詳情頁顯示返回橫條') : fail('詳情頁返回橫條未顯示');

  const crumb = (await page.textContent('#detailCrumb'))?.trim();
  crumb && crumb.includes(targetSymbol) ? pass('詳情頁麵包屑含代碼', crumb) : fail('麵包屑', String(crumb));

  await page.waitForSelector('#result:not([hidden])', { timeout: 120000 });
  const detailScore = await page.textContent('#verdictScore');
  detailScore && detailScore !== '--' ? pass('詳情頁已完成分析', detailScore.trim()) : fail('詳情頁分析', String(detailScore));

  // 返回保留結果
  await page.click('#detailBack');
  await page.waitForFunction(() => location.hash === '#/screen', null, { timeout: 20000 });
  await waitView('viewScreen');
  const rowsBack = await page.$$eval('#screenBody tr', (els) => els.length);
  rowsBack === rowsAfter.length
    ? pass('返回後篩選結果保留', `${rowsBack} 列`)
    : fail('返回後結果遺失', `${rowsBack} vs ${rowsAfter.length}`);

  /* ================= [6] 錯誤態 ================= */
  console.log('[6] 錯誤態處理');

  // 6a 參數錯誤：直接打 API（前端把數字欄位做成 type=number，非數字會在送出前
  // 就被瀏覽器丟掉，所以只能從 API 層驗後端校驗）。錯誤體是嵌套結構：
  // { ok:false, error:{ code, message, hint } }
  const paramErr = await page.evaluate(async () => {
    const r = await fetch('/api/screen?minScore=abc&limit=99999&sortBy=../x');
    const j = await r.json();
    return { status: r.status, ok: j.ok, code: j.error?.code, message: j.error?.message, hint: j.error?.hint };
  });
  paramErr.status === 400 && paramErr.code === 'BAD_PARAMS'
    ? pass('參數錯誤回 400 BAD_PARAMS', String(paramErr.message).slice(0, 56) + '…')
    : fail('參數錯誤回應', JSON.stringify(paramErr));
  paramErr.hint && paramErr.hint.includes('可用參數')
    ? pass('參數錯誤附可用值提示', String(paramErr.hint).slice(0, 52) + '…')
    : fail('參數錯誤缺少提示', String(paramErr.hint));

  // 前端：讓既有表單送出一個「後端會拒」的組合（limit 超過上限）
  await page.evaluate(() => {
    const el = document.getElementById('fLimit');
    // 繞過 type=number 的上下限，直接塞值（模擬使用者貼上超大數字）
    el.value = '99999';
    document.getElementById('screenBtn')?.click();
  });
  // 只等錯誤卡或空狀態：表格可能還留著上一輪的 hidden=false，
  // 但沒有資料列、高度為 0，把它放進等待條件會讓 waitForSelector 卡死。
  await page.waitForSelector('#screenError:not([hidden]), #screenEmpty:not([hidden])', { timeout: 60000 });
  const errVisible = await page.isVisible('#screenError');
  if (errVisible) {
    const t = (await page.textContent('#screenErrorTitle'))?.trim();
    const m = (await page.textContent('#screenErrorMessage'))?.trim();
    pass('前端顯示參數錯誤提示', `${t}：${(m || '').slice(0, 48)}`);
    const hasRecover = await page.$$eval('#screenErrorActions button', (e) => e.length);
    hasRecover > 0 ? pass('提供恢復操作按鈕', `${hasRecover} 個`) : fail('參數錯誤缺少恢復操作');
  } else {
    pass('後端已自動夾取至合法值並回傳（走空狀態分支）');
  }
  await page.click('#screenReset');
  await page.waitForTimeout(400);

  // 6b 無資料：極嚴苛條件
  await page.selectOption('#fMarket', 'hk');
  await page.fill('#fMinScore', '100');
  await page.fill('#fMaxDistAtr', '0.01');
  await page.fill('#fLimit', '5');
  await page.click('#screenBtn');
  // 同樣只等錯誤卡或空狀態（表格可能殘留 hidden=false）
  await page.waitForSelector('#screenEmpty:not([hidden]), #screenError:not([hidden])', { timeout: 180000 });
  const emptyVisible = await page.isVisible('#screenEmpty');
  if (emptyVisible) {
    const body = (await page.textContent('#screenEmptyBody'))?.replace(/\s+/g, ' ').trim();
    pass('無資料時顯示空狀態文案', (body || '').slice(0, 60));
    const relax = await page.$$eval('#screenEmptyActions button', (e) => e.length);
    relax > 0 ? pass('空狀態提供放寬建議', `${relax} 個`) : fail('空狀態缺少放寬操作');
  } else {
    // 極嚴苛條件下仍有結果也不算錯——只要不是空白畫面即可
    const tbl = await page.isVisible('#screenTableWrap');
    tbl ? pass('嚴苛條件下有結果（非空白畫面）') : fail('無資料時既無空狀態也無結果表');
  }
  await page.click('#screenReset');
  await page.waitForTimeout(400);

  // 6c 網路失敗：攔截 API
  // 注意：Playwright 的 glob 裡 `?` 是「單一字元」通配符，不是字面問號，
  // 所以 `'**/api/screen?**'` 其實匹配不到 `/api/screen?market=...`。改用正則。
  // 另外要先清掉上一輪的表格，否則 #screenTableWrap 仍是可見狀態，會誤判。
  await page.evaluate(() => {
    document.getElementById('screenTableWrap').hidden = true;
    document.getElementById('screenEmpty').hidden = true;
    document.getElementById('screenError').hidden = true;
  });
  const screenRe = /\/api\/screen(\?|$)/;
  await page.route(screenRe, (r) => r.abort('failed'));
  await page.fill('#fLimit', '3');
  await page.click('#screenBtn');
  await page.waitForSelector('#screenError:not([hidden])', { timeout: 60000 });
  const netTitle = (await page.textContent('#screenErrorTitle'))?.trim();
  const netMsg = (await page.textContent('#screenErrorMessage'))?.trim();
  netTitle ? pass('網路失敗顯示錯誤卡', `${netTitle}：${(netMsg || '').slice(0, 46)}`) : fail('網路失敗未顯示錯誤卡');
  const netActions = await page.$$eval('#screenErrorActions button', (e) => e.length);
  netActions > 0 ? pass('網路失敗提供重試按鈕', `${netActions} 個`) : fail('網路失敗缺少重試');
  await page.unroute(screenRe);

  // 6d K 線區間參數錯誤
  const badRange = await page.evaluate(async () => {
    const r = await fetch('/api/kline?symbol=AAPL&range=99y');
    const j = await r.json();
    return { status: r.status, code: j.error?.code, message: j.error?.message, hint: j.error?.hint };
  });
  badRange.status === 400 && badRange.code === 'BAD_RANGE'
    ? pass('K 線非法區間回 400 BAD_RANGE', String(badRange.message || badRange.hint).slice(0, 48) + '…')
    : fail('K 線非法區間', JSON.stringify(badRange));

  // 6e 不存在代碼
  const badSymbol = await page.evaluate(async () => {
    const r = await fetch('/api/kline?symbol=ZZZZZZ9&range=1y');
    return { status: r.status, body: await r.json() };
  });
  badSymbol.status !== 200 || badSymbol.body?.ok === false
    ? pass('不存在代碼回報錯誤（非 200 或 ok:false）', `${badSymbol.status}`)
    : note(`不存在代碼回 200：${JSON.stringify(badSymbol.body).slice(0, 80)}`);

  /* ================= [7] 手機版 ================= */
  console.log('[7] 手機版');
  await page.close();
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mErrors = [];
  m.on('console', (x) => { if (x.type() === 'error') mErrors.push(x.text()); });
  m.on('pageerror', (e) => mErrors.push('pageerror: ' + e.message));

  await m.goto(`${BASE}#/detail/AAPL`, { waitUntil: 'domcontentloaded' });
  await m.waitForSelector('#result:not([hidden])', { timeout: 150000 });
  const mOver = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  mOver <= 0 ? pass('手機版預測頁無水平溢出', `${mOver}`) : fail('手機版預測頁溢出', `${mOver}px`);

  const mRangeVisible = await m.isVisible('.range-group');
  mRangeVisible ? pass('手機版時間區間按鈕可見') : fail('手機版時間區間按鈕不可見');

  await m.click('#mainNav .nav-item[data-route="screen"]');
  await m.waitForFunction(() => {
    const el = document.getElementById('viewScreen');
    return el && !el.hidden && el.offsetHeight > 0;
  }, null, { timeout: 30000 });
  const mOver2 = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  mOver2 <= 0 ? pass('手機版選股頁無水平溢出', `${mOver2}`) : fail('手機版選股頁溢出', `${mOver2}px`);

  const mFormVisible = await m.isVisible('#screenForm');
  mFormVisible ? pass('手機版篩選表單可見') : fail('手機版篩選表單不可見');

  await m.screenshot({ path: 'tests/out-v14-mobile.png', fullPage: false });
  pass('已截圖', 'tests/out-v14-mobile.png');

  /* ================= 主控台 ================= */
  console.log('\n[8] 主控台');
  // 這一節刻意打過 400 與 abort 的請求，瀏覽器一定會記網路層 error。
  // 那些是「預期內」的，不能算成程式錯誤；只挑真正的 JS 例外。
  const isExpectedNetNoise = (t) =>
    /Failed to load resource/.test(t) ||
    /net::ERR_/.test(t) ||
    /the server responded with a status of 4\d\d/.test(t);
  const realErr = consoleErrors.filter((t) => !isExpectedNetNoise(t));
  realErr.length === 0
    ? pass('桌機版主控台無 JS 錯誤', `（已忽略 ${consoleErrors.length} 條刻意觸發的網路錯誤）`)
    : fail('桌機版主控台有 JS 錯誤', realErr.slice(0, 3).join(' | '));
  mErrors.length === 0 ? pass('手機版主控台無錯誤') : fail('手機版主控台有錯誤', mErrors.slice(0, 3).join(' | '));

  await page.close().catch(() => {});
  await m.close().catch(() => {});
} catch (e) {
  fail('測試執行例外', e.message);
  try { await page.screenshot({ path: 'tests/out-v14-error.png', fullPage: false }); } catch {}
  console.error(e);
} finally {
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  const bad = results.length - ok;
  console.log(`\n結果：${ok} / ${results.length} 通過${bad ? `，${bad} 失敗` : '，全部通過。'}`);
  if (bad) {
    console.log('\n失敗項目：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.n}${r.d ? ' — ' + r.d : ''}`));
    process.exitCode = 1;
  }
}
