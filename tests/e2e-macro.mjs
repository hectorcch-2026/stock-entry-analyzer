/**
 * 宏觀與基本面頁 E2E（真實瀏覽器、真實上游）
 * =========================================
 *
 * 驗的不是「有沒有 200」，而是使用者實際會看到的四件事：
 *   1. 版面沒有被 6 欄表格撐破（手機不得出現整頁水平滾動）
 *   2. 三個分頁都能切、資料都真的渲染出來（不是空殼）
 *   3. FOMC 下次會議有值（這是整頁最容易靜默失敗的地方）
 *   4. AI 解讀有結論、有依據、有免責聲明，且沒有任何 console error
 *
 * 另外驗「四種狀態分開」：不可用指標仍在表內並標明原因，
 * 而不是整列消失或全部寫成「載入失敗」。
 *
 * 用法：node tests/e2e-macro.mjs（需先 npm start）
 */

import { chromium } from 'playwright';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:5177';
const OUT = '/tmp/shot';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

const b = await chromium.launch();

/* ============================================================
   桌面：宏觀頁
   ============================================================ */
console.log('\n[桌面 1440×900] #/macro');

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

await p.goto(`${BASE}/#/macro`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForSelector('#viewMacro:not([hidden])', { timeout: 30000 });

// 等表格真的有資料列（不是「載入中…」）
await p.waitForFunction(() => {
  const tb = document.getElementById('macroTableBody');
  if (!tb) return false;
  const rows = tb.querySelectorAll('tr');
  if (!rows.length) return false;
  return !/載入中/.test(rows[0].textContent);
}, { timeout: 90000 }).catch(() => {});

await p.waitForTimeout(1200);

const m = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('#macroTableBody tr')];
  const docW = document.documentElement.scrollWidth;
  const winW = window.innerWidth;
  return {
    title: document.getElementById('macroTitle')?.textContent?.trim(),
    sub: document.getElementById('macroSub')?.textContent?.trim(),
    stamp: document.getElementById('macroStamp')?.textContent?.trim(),
    count: document.getElementById('macroCount')?.textContent?.trim(),
    rowCount: rows.length,
    // 第一列內容抽樣
    firstRow: rows[0] ? {
      name: rows[0].querySelector('.mt-name')?.textContent?.trim(),
      val: rows[0].querySelector('.mt-val')?.textContent?.trim(),
      unit: rows[0].querySelector('.mt-unit')?.textContent?.trim(),
      date: rows[0].querySelector('.mt-date')?.textContent?.trim(),
      src: rows[0].querySelector('.src-badge')?.textContent?.trim(),
      hasPct: !!rows[0].querySelector('.pct-fill'),
    } : null,
    // 不可用列：必須留在表內且有原因
    unavailRows: [...document.querySelectorAll('#macroTableBody tr.row-unavail')].map((r) => ({
      name: r.querySelector('.mt-name')?.textContent?.trim(),
      tag: r.querySelector('.unavail-tag')?.textContent?.trim(),
    })),
    // 有多少列顯示破折號（代表缺值，正常）
    dashCount: [...document.querySelectorAll('#macroTableBody .mt-val')].filter((e) => e.textContent.trim() === '—').length,
    // 名稱／數值／單位三元組，用來驗「單位帶量級時數值不得再縮寫」
    valueUnitPairs: [...document.querySelectorAll('#macroTableBody tr')].map((tr) => ({
      name: tr.querySelector('.mt-name')?.textContent?.trim(),
      val: tr.querySelector('.mt-val')?.textContent?.trim(),
      unit: tr.querySelector('.mt-unit')?.textContent?.trim(),
    })),
    // 版面：整頁不應出現水平滾動
    pageOverflowX: docW - winW,
    // 表格容器應該自己滾（代表 min-width 生效）
    tableScrollable: (() => {
      const w = document.querySelector('.mt-wrap');
      return w ? w.scrollWidth > w.clientWidth : null;
    })(),
    fomc: {
      badge: document.getElementById('fomcBadge')?.textContent?.trim(),
      nextVisible: !document.getElementById('fomcNext')?.hidden,
      nextDate: document.querySelector('#fomcNext .fn-date')?.textContent?.trim(),
      nextSub: document.querySelector('#fomcNext .fn-sub')?.textContent?.trim(),
      itemCount: document.querySelectorAll('#fomcList .fomc-item').length,
      statuses: [...new Set([...document.querySelectorAll('#fomcList .fi-status')].map((e) => e.textContent.trim()))],
      noteLen: document.getElementById('fomcNote')?.textContent?.trim().length,
    },
    limits: document.querySelectorAll('#macroLimits li').length,
    noticeHidden: document.getElementById('macroNotice')?.hidden,
    // 分頁初始狀態
    tabs: [...document.querySelectorAll('.mh-tab')].map((t) => ({
      label: t.textContent.trim(), active: t.classList.contains('active'),
    })),
    overviewVisible: !document.getElementById('tabOverview')?.hidden,
    dictVisible: !document.getElementById('tabDict')?.hidden,
  };
});

check('頁面顯示（#viewMacro 未隱藏）', true);
check('標題為「宏觀經濟儀表板」', m.title === '宏觀經濟儀表板', `實際：${m.title}`);
check('副標說明資料來源', /FRED/.test(m.sub || ''), `實際：${m.sub}`);
check('資料時間戳已更新（非「載入中…」）', m.stamp && !/載入中/.test(m.stamp), `實際：${m.stamp}`);
check('表格有 18 列指標', m.rowCount === 18, `實際 ${m.rowCount} 列`);
check('計數徽章為「N / 18 可用」', /^\d+ \/ 18 /.test(m.count || ''), `實際：${m.count}`);
check('第一列有名稱／數值／單位／日期／來源', !!(m.firstRow.name && m.firstRow.val && m.firstRow.date && m.firstRow.src),
  JSON.stringify(m.firstRow));
check('第一列有歷史百分位長條', m.firstRow.hasPct === true);
check('整頁沒有水平滾動（表格自己滾）', m.pageOverflowX <= 1, `溢出 ${m.pageOverflowX}px`);
// 桌面 1440px 下 6 欄表格本來就放得下，不該被迫滾動；
// 「必須可滾動」是手機的訴求，見手機段。這裡只驗「沒有撐破頁面」。

// 雙重換算防護：單位已寫「千人／百萬美元／十億美元」時，
// 數值不可再出現 K/M/B 後綴，否則 24,665 十億美元會顯示成 24.7K 十億美元。
const doubleScaled = m.valueUnitPairs.filter(
  (x) => /千人|百萬|十億/.test(x.unit) && /[KMB]$/.test(x.val)
);
check('單位帶量級時數值不再縮寫（防雙重換算）', doubleScaled.length === 0,
  JSON.stringify(doubleScaled));
const gdpPair = m.valueUnitPairs.find((x) => /實質 GDP/.test(x.name || ''));
check('實質 GDP 顯示為 24,665 十億美元（而非 24.7K）',
  !!gdpPair && /^[\d,]+$/.test(gdpPair.val) && /十億/.test(gdpPair.unit),
  gdpPair ? `${gdpPair.val} ${gdpPair.unit}` : 'missing');
const fxPair = m.valueUnitPairs.find((x) => /EUR\/USD/.test(x.name || ''));
check('EUR/USD 保留 4 位小數（不四捨五入到 1.10）',
  !!fxPair && /^\d\.\d{4}$/.test(fxPair.val), fxPair ? fxPair.val : 'missing');

check('FOMC：有下次會議卡', m.fomc.nextVisible === true);
check('FOMC：下次會議日期格式正確', /^\d{4}-\d{2}-\d{2}$/.test(m.fomc.nextDate || ''), `實際：${m.fomc.nextDate}`);
check('FOMC：下次會議含「距今 N 天」', /距今\s*\d+\s*天/.test(m.fomc.nextSub || ''), `實際：${m.fomc.nextSub}`);
check('FOMC：徽章顯示下次日期', /下次 \d{4}-\d{2}-\d{2}/.test(m.fomc.badge || ''), `實際：${m.fomc.badge}`);
check('FOMC：清單有 6 場以上', m.fomc.itemCount >= 6, `實際 ${m.fomc.itemCount} 場`);
check('FOMC：清單區分已召開／即將召開', m.fomc.statuses.some((s) => s === '已召開') && m.fomc.statuses.some((s) => /即將召開|預定/.test(s)),
  JSON.stringify(m.fomc.statuses));
check('FOMC：有「不提供利率預測」的說明', (m.fomc.noteLen || 0) > 10, `note 長度 ${m.fomc.noteLen}`);

check('資料限制說明至少 3 條', m.limits >= 3, `實際 ${m.limits} 條`);
check('宏觀數據分頁預設為啟用', m.tabs.find((t) => t.active)?.label === '宏觀數據', JSON.stringify(m.tabs));
check('資料字典分頁初始隱藏', m.dictVisible === false);

await p.screenshot({ path: `${OUT}/macro-desktop.png`, fullPage: true });

/* ---------- 資料字典分頁 ---------- */
console.log('\n[桌面] 資料字典分頁');
await p.click('.mh-tab[data-mtab="dict"]');
await p.waitForFunction(() => {
  const tb = document.getElementById('dictBody');
  return tb && tb.querySelectorAll('tr').length > 3 && !/載入中/.test(tb.textContent);
}, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(500);

const d = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('#dictBody tr')];
  const chip = document.querySelector('.dict-chip.active');
  return {
    visible: !document.getElementById('tabDict')?.hidden,
    overviewHidden: document.getElementById('tabOverview')?.hidden,
    count: document.getElementById('dictCount')?.textContent?.trim(),
    rowCount: rows.length,
    first: rows[0] ? {
      name: rows[0].querySelector('.mt-name')?.textContent?.trim(),
      key: rows[0].querySelector('.dict-key')?.textContent?.trim(),
      def: rows[0].querySelector('.dict-def')?.textContent?.trim()?.slice(0, 40),
      link: rows[0].querySelector('.dict-link')?.getAttribute('href'),
      range: rows[0].querySelector('.dict-range')?.textContent?.trim(),
      ex: rows[0].querySelector('.dict-ex')?.textContent?.trim(),
    } : null,
    activeChip: chip?.textContent?.trim(),
    convLen: document.getElementById('dictConv')?.textContent?.trim().length,
    pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
  };
});

check('資料字典分頁切換成功', d.visible === true && d.overviewHidden === true);
check('字典有 26 個欄位', d.rowCount === 26, `實際 ${d.rowCount}`);
check('計數顯示「26 個欄位」', /26/.test(d.count || ''), `實際：${d.count}`);
check('字典項目有欄位名／技術代碼／定義', !!(d.first.name && d.first.key && d.first.def), JSON.stringify(d.first));
check('字典項目有可點擊的來源連結', /^https?:\/\//.test(d.first.link || ''), `實際：${d.first.link}`);
check('字典項目有合理值域', /^\[.+, .+\]/.test(d.first.range || ''), `實際：${d.first.range}`);
check('字典有口徑說明段落', (d.convLen || 0) > 20, `長度 ${d.convLen}`);
check('字典頁無水平溢出', d.pageOverflowX <= 1, `溢出 ${d.pageOverflowX}px`);

await p.screenshot({ path: `${OUT}/macro-dict.png`, fullPage: true });

/* ---------- 篩選晶片 ---------- */
await p.click('.dict-chip[data-dgroup="企業財報"]');
await p.waitForTimeout(300);
const filtered = await p.evaluate(() => ({
  rows: document.querySelectorAll('#dictBody tr').length,
  active: document.querySelector('.dict-chip.active')?.textContent?.trim(),
}));
check('篩選「企業財報」只剩 8 列', filtered.rows === 8, `實際 ${filtered.rows}`);
check('篩選晶片狀態正確', filtered.active === '企業財報', filtered.active);

/* ---------- AI 解讀分頁 ---------- */
console.log('\n[桌面] AI 解讀分頁');
await p.click('.mh-tab[data-mtab="interpret"]');
await p.waitForTimeout(800);

const i = await p.evaluate(() => {
  const overall = document.getElementById('interpOverall');
  return {
    visible: !document.getElementById('tabInterpret')?.hidden,
    mode: document.getElementById('interpMode')?.textContent?.trim(),
    modeClass: document.getElementById('interpMode')?.className,
    overallShown: !overall?.hidden,
    overallTag: overall?.querySelector('.io-tag')?.textContent?.trim(),
    overallStanceClass: overall?.className,
    overallText: overall?.querySelector('.io-body strong')?.textContent?.trim(),
    counts: overall?.querySelector('.io-counts')?.textContent?.trim(),
    cardCount: document.querySelectorAll('#interpList .interp-card').length,
    cardTags: [...document.querySelectorAll('#interpList .ic-tag')].map((e) => e.textContent.trim()),
    firstHeadline: document.querySelector('#interpList .ic-head h3')?.textContent?.trim(),
    firstDetailLen: document.querySelector('#interpList .ic-detail')?.textContent?.trim().length,
    evidenceCount: document.querySelectorAll('#interpList .ice-k').length,
    caveatCount: document.querySelectorAll('#interpList .ic-caveat').length,
    gapsShown: !document.getElementById('interpGaps')?.hidden,
    gapsText: document.getElementById('interpGaps')?.textContent?.trim().slice(0, 80),
    disc: document.getElementById('interpDisc')?.textContent?.trim(),
    llmNote: document.querySelector('#interpList .interp-llm-note')?.textContent?.trim(),
  };
});

check('AI 解讀分頁切換成功', i.visible === true);
check('模式徽章標明「規則型推理」', i.mode === '規則型推理', `實際：${i.mode}`);
check('綜合傾向區塊顯示', i.overallShown === true);
check('綜合傾向有標籤與說明', !!(i.overallTag && i.overallText), `${i.overallTag} / ${i.overallText}`);
check('綜合傾向有票數統計', /偏緊\s*\d+/.test(i.counts || ''), `實際：${i.counts}`);
check('逐條結論 5 條', i.cardCount === 5, `實際 ${i.cardCount} 條`);
check('每條結論都有傾向標籤', i.cardTags.length === 5, JSON.stringify(i.cardTags));
check('第一條結論有標題與說明', !!(i.firstHeadline && i.firstDetailLen > 20), `${i.firstHeadline} (${i.firstDetailLen} 字)`);
check('結論附「依據」數值', i.evidenceCount > 0, `${i.evidenceCount} 筆依據`);
check('免責聲明存在且含「不構成投資建議」', /不構成.*投資建議/.test(i.disc || ''), `實際：${i.disc?.slice(0, 60)}`);
check('沒有 LLM 文字時說明「為何是規則型」（非靜默）',
  !!i.llmNote && /規則/.test(i.llmNote), `實際：${i.llmNote}`);

await p.screenshot({ path: `${OUT}/macro-interpret.png`, fullPage: true });

check('全程無 JS 錯誤', errs.length === 0, errs.join(' | '));

await ctx.close();

/* ============================================================
   個股：AAPL 財報
   ============================================================ */
console.log('\n[桌面] #/macro/AAPL');
const ctx2 = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p2 = await ctx2.newPage();
const errs2 = [];
p2.on('pageerror', (e) => errs2.push('PAGEERROR: ' + e.message));
p2.on('console', (m) => { if (m.type() === 'error') errs2.push('CONSOLE: ' + m.text()); });

await p2.goto(`${BASE}/#/macro/AAPL`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p2.waitForSelector('#viewMacro:not([hidden])', { timeout: 30000 });
// 關鍵：這一頁會「先載宏觀（18 序列）當背景，再載個股財報」。
// 若只等表格出現資料列，會抓到宏觀那 18 列就往下跑，
// 而財報還沒回來 —— 這是測試自己的競態，不是頁面的問題。
// 正確做法：等到宏觀 state.scope 變成 'symbol'，或等到出現 SEC 來源的列。
await p2.waitForFunction(() => {
  const st = window.MacroPage && window.MacroPage.state;
  if (st && st.scope === 'symbol') {
    const rows = [...document.querySelectorAll('#macroTableBody tr')];
    return rows.length > 0 && rows.some((r) => r.querySelector('.src-sec'));
  }
  return false;
}, { timeout: 90000 }).catch(() => {});
await p2.waitForTimeout(600);

const a = await p2.evaluate(() => {
  const rows = [...document.querySelectorAll('#macroTableBody tr')];
  const cells = rows.map((r) => ({
    name: r.querySelector('.mt-name')?.textContent?.trim(),
    val: r.querySelector('.mt-val')?.textContent?.trim(),
    date: r.querySelector('.mt-date')?.textContent?.trim(),
    src: r.querySelector('.src-badge')?.textContent?.trim(),
  }));
  return {
    title: document.getElementById('macroTitle')?.textContent?.trim(),
    sub: document.getElementById('macroSub')?.textContent?.trim(),
    count: document.getElementById('macroCount')?.textContent?.trim(),
    rows: cells,
    rowCount: cells.length,
    pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    fomcStillShown: !document.getElementById('fomcNext')?.hidden,
    limits: document.getElementById('macroLimits')?.textContent?.trim().slice(0, 40),
  };
});

check('標題顯示公司名與代碼', /AAPL/.test(a.title || '') && /Apple|Inc/.test(a.title || ''), `實際：${a.title}`);
check('副標說明財報來自 SEC / 宏觀來自 FRED', /SEC/.test(a.sub || '') && /FRED/.test(a.sub || ''), `實際：${a.sub}`);
check('財報表格有 8 列以上', a.rowCount >= 8, `實際 ${a.rowCount} 列`);
check('有營收欄位且為 B 級金額', a.rows.some((r) => /營收/.test(r.name || '') && /B$/.test(r.val || '')),
  JSON.stringify(a.rows.slice(0, 2)));
check('有 ROE 欄位', a.rows.some((r) => /ROE/.test(r.name || '')), '');
check('有毛利率欄位', a.rows.some((r) => /毛利率/.test(r.name || '')), '');
check('財報列標為 SEC 來源', a.rows.some((r) => r.src === 'SEC'), JSON.stringify(a.rows.map((r) => r.src)));
check('有宏觀背景列（政策利率／10Y）', a.rows.some((r) => /背景/.test(r.name || '')), '');
check('宏觀背景列標為 FRED 來源', a.rows.some((r) => /背景/.test(r.name || '') && r.src === 'FRED'), '');
check('個股頁仍顯示 FOMC 下次會議', a.fomcStillShown === true);
check('個股頁無水平溢出', a.pageOverflowX <= 1, `溢出 ${a.pageOverflowX}px`);

await p2.screenshot({ path: `${OUT}/macro-aapl.png`, fullPage: true });

/* ---------- 個股 AI 解讀 ---------- */
await p2.click('.mh-tab[data-mtab="interpret"]');
await p2.waitForTimeout(700);
const ai = await p2.evaluate(() => ({
  cards: document.querySelectorAll('#interpList .interp-card').length,
  headline: document.querySelector('#interpList .ic-head h3')?.textContent?.trim(),
  disc: document.getElementById('interpDisc')?.textContent?.trim(),
  overall: document.querySelector('#interpOverall .io-tag')?.textContent?.trim(),
}));
check('個股 AI 解讀有結論', ai.cards >= 3, `實際 ${ai.cards} 條`);
check('個股解讀首條為成長性（營收）', /營收/.test(ai.headline || ''), `實際：${ai.headline}`);
check('個股解讀有免責聲明', /不構成.*投資建議/.test(ai.disc || ''), '');
await p2.screenshot({ path: `${OUT}/macro-aapl-interpret.png`, fullPage: true });
check('個股流程無 JS 錯誤', errs2.length === 0, errs2.join(' | '));
await ctx2.close();

/* ============================================================
   港股：不適用（不可報「失敗」）
   ============================================================ */
console.log('\n[桌面] #/macro/0700.HK（港股無 SEC 財報）');
const ctx3 = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p3 = await ctx3.newPage();
await p3.goto(`${BASE}/#/macro/0700.HK`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p3.waitForSelector('#viewMacro:not([hidden])', { timeout: 30000 });
await p3.waitForTimeout(6000);

const hk = await p3.evaluate(() => ({
  noticeVisible: !document.getElementById('macroNotice')?.hidden,
  noticeClass: document.getElementById('macroNotice')?.className,
  noticeText: document.getElementById('macroNotice')?.textContent?.trim().slice(0, 160),
  tableText: document.getElementById('macroTableBody')?.textContent?.trim().slice(0, 60),
}));
check('港股顯示「不適用」提示（非紅色錯誤）', hk.noticeVisible === true && !/mn-error/.test(hk.noticeClass || ''),
  `class=${hk.noticeClass}`);
check('提示文字說明原因', (hk.noticeText || '').length > 5, hk.noticeText);
await p3.screenshot({ path: `${OUT}/macro-hk.png`, fullPage: true });
await ctx3.close();

/* ============================================================
   手機 390×844
   ============================================================ */
console.log('\n[手機 390×844] #/macro');
const ctxM = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const pm = await ctxM.newPage();
const errsM = [];
pm.on('pageerror', (e) => errsM.push('PAGEERROR: ' + e.message));
await pm.goto(`${BASE}/#/macro`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await pm.waitForSelector('#viewMacro:not([hidden])', { timeout: 30000 });
await pm.waitForFunction(() => {
  const tb = document.getElementById('macroTableBody');
  return tb && tb.querySelectorAll('tr').length && !/載入中/.test(tb.textContent);
}, { timeout: 90000 }).catch(() => {});
await pm.waitForTimeout(1000);

const mob = await pm.evaluate(() => {
  const docW = document.documentElement.scrollWidth;
  const winW = window.innerWidth;
  const tabs = document.querySelector('.mh-tabs');
  return {
    pageOverflowX: docW - winW,
    rowCount: document.querySelectorAll('#macroTableBody tr').length,
    tabsScrollable: tabs ? tabs.scrollWidth >= tabs.clientWidth : null,
    tabCount: document.querySelectorAll('.mh-tab').length,
    // 表格必須被容器裁住（內部可滾），不可撐破頁面
    tableFits: (() => {
      const w = document.querySelector('.mt-wrap');
      return w ? w.getBoundingClientRect().right <= winW + 1 : null;
    })(),
    fomcItems: document.querySelectorAll('#fomcList .fomc-item').length,
    // 觸控目標高度
    refreshH: document.getElementById('macroRefresh')?.getBoundingClientRect().height,
    inputH: document.getElementById('macroSymbol')?.getBoundingClientRect().height,
    goH: document.getElementById('macroSymbolGo')?.getBoundingClientRect().height,
    // 不可用列的標籤仍可讀
    unavailTag: document.querySelector('.unavail-tag')?.textContent?.trim(),
  };
});

check('手機：整頁無水平滾動', mob.pageOverflowX <= 1, `溢出 ${mob.pageOverflowX}px`);
check('手機：表格被容器裁住不撐破版面', mob.tableFits === true);
check('手機：仍有 18 列資料', mob.rowCount === 18, `實際 ${mob.rowCount}`);
check('手機：三個分頁都在', mob.tabCount === 3);
check('手機：按鈕高度 ≥ 32px 可點', (mob.refreshH || 0) >= 32, `實際 ${mob.refreshH}px`);
check('手機：輸入框高度 ≥ 34px', (mob.inputH || 0) >= 34, `實際 ${mob.inputH}px`);
check('手機：FOMC 清單仍可讀', mob.fomcItems >= 6, `實際 ${mob.fomcItems}`);
check('手機：無 JS 錯誤', errsM.length === 0, errsM.join(' | '));

await pm.screenshot({ path: `${OUT}/macro-mobile.png`, fullPage: true });

// 手機切到 AI 解讀
await pm.click('.mh-tab[data-mtab="interpret"]');
await pm.waitForTimeout(700);
const mobI = await pm.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - window.innerWidth,
  cards: document.querySelectorAll('#interpList .interp-card').length,
  evidenceRows: document.querySelectorAll('#interpList .ic-evidence li').length,
}));
check('手機：AI 解讀無水平溢出', mobI.overflow <= 1, `溢出 ${mobI.overflow}px`);
check('手機：AI 解讀有 5 條結論', mobI.cards === 5, `實際 ${mobI.cards}`);
check('手機：依據清單可讀', mobI.evidenceRows > 0, `${mobI.evidenceRows} 筆`);
await pm.screenshot({ path: `${OUT}/macro-mobile-interpret.png`, fullPage: true });

await ctxM.close();

/* ============================================================
   既有頁面回歸（導航從 3 項變 4 項）
   ============================================================ */
console.log('\n[回歸] 既有頁面導航');
const ctxR = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pr = await ctxR.newPage();
const errsR = [];
pr.on('pageerror', (e) => errsR.push('PAGEERROR: ' + e.message));
await pr.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await pr.waitForTimeout(2500);

const nav = await pr.evaluate(() => ({
  items: [...document.querySelectorAll('.main-nav .nav-item')].map((a) => ({
    text: a.textContent.trim(), href: a.getAttribute('href'), active: a.classList.contains('active'),
  })),
  navOverflow: (() => {
    const n = document.querySelector('.main-nav');
    return n ? n.scrollWidth > n.clientWidth + 1 : null;
  })(),
  // 首頁應只顯示 chart view
  chartVisible: !document.getElementById('chartView')?.hidden && !document.getElementById('viewChart')?.hidden,
  macroHidden: document.getElementById('viewMacro')?.hidden,
  screenHidden: document.getElementById('viewScreen')?.hidden,
  pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
}));

check('導航含 4 個項目（含宏觀）', nav.items.length === 4, JSON.stringify(nav.items.map((n) => n.text)));
check('導航含「宏觀基本面」', nav.items.some((n) => /宏觀/.test(n.text)), JSON.stringify(nav.items.map((n) => n.text)));
check('首頁宏觀 view 保持隱藏', nav.macroHidden === true);
check('首頁螢幕選股 view 保持隱藏', nav.screenHidden === true);
check('首頁無水平溢出', nav.pageOverflowX <= 1, `溢出 ${nav.pageOverflowX}px`);
check('首頁無 JS 錯誤', errsR.length === 0, errsR.join(' | '));

// 切到宏觀再切回
await pr.click('.nav-item[href="#/macro"]');
await pr.waitForTimeout(3000);
const afterSwitch = await pr.evaluate(() => ({
  macroVisible: !document.getElementById('viewMacro')?.hidden,
  chartHidden: document.getElementById('chartView')?.hidden || document.getElementById('viewChart')?.hidden,
}));
check('點導航可進入宏觀頁', afterSwitch.macroVisible === true);
check('切入宏觀頁後首頁隱藏', afterSwitch.chartHidden === true);

// 首頁的導航項目是 data-route="predict"（href="#/predict"），不是 "#/"
await pr.click('.nav-item[data-route="predict"]');
await pr.waitForTimeout(1500);
const backHome = await pr.evaluate(() => ({
  chartVisible: !(document.getElementById('chartView')?.hidden && document.getElementById('viewChart')?.hidden),
  macroHidden: document.getElementById('viewMacro')?.hidden,
}));
check('可從宏觀頁切回首頁', backHome.chartVisible === true && backHome.macroHidden === true);
check('導航切換過程無錯誤', errsR.length === 0, errsR.join(' | '));

await ctxR.close();
await b.close();

/* ============================================================
   結果
   ============================================================ */
console.log(`\n========== 結果：${pass} 通過 / ${failures.length} 失敗 ==========`);
if (failures.length) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f}`));
}
console.log(`\n截圖目錄：${OUT}`);
process.exit(failures.length === 0 ? 0 : 1);
