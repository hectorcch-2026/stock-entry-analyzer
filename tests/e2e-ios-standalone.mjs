/**
 * iPhone「加入主畫面」獨立視窗模式驗證
 * 執行：node tests/e2e-ios-standalone.mjs   （需先 npm start）
 *
 * 模擬原理（三條互補路線，各自對應真實瀏覽器行為）：
 *
 *  1. navigator.standalone = true
 *     ── iOS Safari 專屬屬性，加入主畫面後由 Safari 設為 true。
 *        以 addInitScript 在頁面腳本執行前注入，驗證 app.js 的 iOS 判定分支。
 *
 *  2. window.matchMedia('(display-mode: standalone)').matches = true
 *     ── Android Chrome / 桌機 PWA 的判定訊號，也是 isStandalone() 的第二個分支。
 *        以 addInitScript 包裝 matchMedia（僅攔截 display-mode 查詢，其餘委派原生實作）。
 *
 *  3. Chromium 自身的安裝性驗證（Page.getAppManifest + Page.getInstallabilityErrors）
 *     ── 這是瀏覽器決定「是否顯示加入主畫面」的真正依據，權威性高於任何前端模擬。
 *
 * 為何不用 CDP Emulation.setEmulatedMedia 模擬 display-mode？
 *   Chromium 的 display-mode 媒體特性由「瀏覽器視窗實際模式」驅動，
 *   Emulation.setEmulatedMedia 無法覆寫它 —— 實測即使下達該指令，
 *   @media (display-mode: standalone) 仍不匹配、matchMedia 仍回報 browser。
 *   因此改以上述三條路線驗證，避免測試給出虛假的通過。
 */

import { chromium, devices } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5177';
const results = [];
const pass = (n, d = '') => { results.push({ ok: true, n, d }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n, d }); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/**
 * 建立 iPhone 環境。
 * @param {boolean} standalone  是否模擬「已加入主畫面」
 * @param {'ios'|'media'} mode  standalone 的判定來源：
 *        'ios'   → 注入 navigator.standalone（iOS 路線）
 *        'media' → 包裝 matchMedia（通用路線）
 */
async function iPhone(browser, { standalone = false, mode = 'ios' } = {}) {
  const ctx = await browser.newContext({
    ...devices['iPhone 15 Pro'],   // 393×852, DPR 3, 觸控
    userAgent: IPHONE_UA,
  });

  if (standalone && mode === 'ios') {
    // iOS Safari 加入主畫面後，Safari 會把 navigator.standalone 設為 true
    await ctx.addInitScript(() => {
      Object.defineProperty(window.navigator, 'standalone', {
        get: () => true,
        configurable: true,
      });
    });
  }

  if (standalone && mode === 'media') {
    // 通用 PWA 訊號：只改寫 display-mode 查詢，其餘媒體查詢全數委派原生實作
    await ctx.addInitScript(() => {
      const orig = window.matchMedia.bind(window);
      window.matchMedia = function (query) {
        const mql = orig(query);
        if (typeof query === 'string' && /display-mode\s*:\s*standalone/.test(query)) {
          // 用 Proxy 覆寫 matches，其餘屬性與方法（addEventListener 等）照舊
          return new Proxy(mql, {
            get(target, prop) {
              if (prop === 'matches') return true;
              const v = target[prop];
              return typeof v === 'function' ? v.bind(target) : v;
            },
          });
        }
        return mql;
      };
    });
  }

  const page = await ctx.newPage();
  return { ctx, page };
}

const browser = await chromium.launch();

/* ==================== 對照組：一般 Safari 分頁 ==================== */
console.log('\n[A] 對照組 — 一般 Safari 分頁模式\n');

{
  const { ctx, page } = await iPhone(browser, { standalone: false });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3600);

  const st = await page.evaluate(() => ({
    standaloneAttr: window.navigator.standalone === true,
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
    tipVisible: !document.getElementById('iosInstallTip')?.hidden,
  }));

  !st.standaloneAttr ? pass('navigator.standalone 為 false') : fail('navigator.standalone 應為 false');
  !st.displayModeStandalone ? pass('display-mode 非 standalone') : fail('display-mode 不應為 standalone');
  st.tipVisible ? pass('分頁模式顯示「加入主畫面」引導（正確）') : fail('分頁模式應顯示引導');
  await ctx.close();
}

/* ==================== 實驗組：iOS 獨立視窗模式 ==================== */
console.log('\n[B] 獨立視窗模式 — 已加入主畫面（navigator.standalone）\n');

const { ctx, page } = await iPhone(browser, { standalone: true, mode: 'ios' });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`${BASE}/?symbol=AAPL`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('#result:not([hidden])', { timeout: 60000 }).catch(() => {});
// 等待超過引導提示的 2.5s 延遲，確認它確實沒被觸發
await page.waitForTimeout(3600);

/* --- 環境判定 --- */
const env = await page.evaluate(() => ({
  standaloneAttr: window.navigator.standalone === true,
  displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
  tipHidden: document.getElementById('iosInstallTip')?.hidden,
  tipExists: !!document.getElementById('iosInstallTip'),
  isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent),
}));

env.standaloneAttr ? pass('navigator.standalone = true 已生效') : fail('navigator.standalone 未生效');

// 核心行為：已安裝後不應再顯示安裝引導
if (env.tipExists && env.tipHidden === true) {
  pass('獨立模式隱藏「加入主畫面」引導（正確）', 'tip.hidden = true');
} else {
  fail('獨立模式仍顯示安裝引導', `hidden=${env.tipHidden}`);
}

env.isIOS ? pass('iOS UA 已識別') : fail('iOS UA 未識別');
// 註：Chromium 無法模擬 display-mode，故此處預期為 false；該分支改於 [B2] 驗證
!env.displayModeStandalone
  ? pass('Chromium 無法模擬 display-mode（已知限制，另於 [B2] 驗證該分支）')
  : fail('display-mode 意外為 true，測試前提改變');

/* --- manifest 經瀏覽器引擎解析 --- */
const manifestCheck = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return { found: false };
  try {
    const res = await fetch(link.href);
    const m = await res.json();
    return {
      found: true,
      href: link.href,
      name: m.name,
      display: m.display,
      startUrl: m.start_url,
      themeColor: m.theme_color,
      iconCount: (m.icons || []).length,
      hasMaskable: (m.icons || []).some((i) => (i.purpose || '').includes('maskable')),
    };
  } catch (e) { return { found: false, error: e.message }; }
});
if (manifestCheck.found && manifestCheck.display === 'standalone') {
  pass('manifest 可被解析且 display 正確', `${manifestCheck.name} / ${manifestCheck.iconCount} 圖示`);
} else {
  fail('manifest 解析異常', JSON.stringify(manifestCheck));
}
manifestCheck.hasMaskable ? pass('manifest 含 maskable 圖示') : fail('manifest 缺 maskable 圖示');

/* --- 應用程式狀態列 / 主題色 --- */
const shellMeta = await page.evaluate(() => ({
  themeColor: document.querySelector('meta[name="theme-color"]')?.content,
  appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
  appleTitle: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
  appleStatusBar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content,
  title: document.title,
}));
shellMeta.appleCapable === 'yes' ? pass('apple-mobile-web-app-capable = yes') : fail('apple 標記缺失', shellMeta.appleCapable);
shellMeta.appleTitle ? pass('apple-mobile-web-app-title 已設定', shellMeta.appleTitle) : fail('apple 標題缺失');
shellMeta.themeColor ? pass('theme-color 已設定', shellMeta.themeColor) : fail('theme-color 缺失');

/* --- 安全區域 CSS 是否套用於關鍵容器 --- */
const safeArea = await page.evaluate(() => {
  const topbar = document.querySelector('.topbar');
  const body = document.body;
  const cs = topbar ? getComputedStyle(topbar) : null;
  const bcs = getComputedStyle(body);
  // 檢查 env() 是否被解析（Chromium 無 safe-area 時解析為 0px，但不應為無效值）
  return {
    topbarPaddingTop: cs?.paddingTop,
    topbarPosition: cs?.position,
    bodyPaddingBottom: bcs.paddingBottom,
    bodyPaddingLeft: bcs.paddingLeft,
    overflowBehavior: bcs.overscrollBehaviorY,
  };
});
safeArea.topbarPaddingTop !== undefined && /^\d/.test(safeArea.topbarPaddingTop)
  ? pass('頂部列已套用安全區域 padding', safeArea.topbarPaddingTop)
  : fail('頂部列 padding 異常', JSON.stringify(safeArea));
safeArea.topbarPosition === 'sticky' ? pass('頂部列為 sticky') : fail('頂部列非 sticky', safeArea.topbarPosition);
safeArea.overflowBehavior === 'none' ? pass('已關閉垂直橡皮筋回彈') : fail('overscroll 設定未生效', safeArea.overflowBehavior);

/* --- 版面與圖表在獨立模式下正常 --- */
const layout = await page.evaluate(() => {
  const cv = document.getElementById('priceChart');
  const ink = (() => {
    if (!cv) return -1;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
    return n;
  })();
  return {
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vw: window.innerWidth,
    canvasCss: cv ? cv.clientWidth + 'x' + cv.clientHeight : null,
    canvasInk: ink,
    resultVisible: !document.getElementById('result')?.hidden,
    symbol: document.getElementById('qSymbol')?.textContent,
    score: document.getElementById('verdictScore')?.textContent,
    zone: document.getElementById('zoneLower')?.textContent + ' ~ ' + document.getElementById('zoneUpper')?.textContent,
    levelsRows: document.querySelectorAll('#levelsBody tr').length,
    maRows: document.querySelectorAll('#maBody tr').length,
    rationale: document.querySelectorAll('#rationale .rat-item').length,
  };
});
layout.overflow === 0 ? pass('獨立模式無水平溢出') : fail('獨立模式有水平溢出', layout.overflow + 'px');
layout.resultVisible ? pass('分析結果正常渲染', `${layout.symbol} 評分 ${layout.score}`) : fail('結果未渲染');
layout.canvasInk > 100 ? pass('K 線圖正常繪製', 'ink=' + layout.canvasInk + ', ' + layout.canvasCss) : fail('圖表未繪製', 'ink=' + layout.canvasInk);
layout.levelsRows > 0 && layout.maRows > 0 ? pass('技術位與均線表格已填充', `${layout.levelsRows} / ${layout.maRows} 列`) : fail('表格未填充');
layout.rationale > 0 ? pass('判斷依據已渲染', layout.rationale + ' 段') : fail('判斷依據未渲染');

/* --- 觸控目標尺寸（獨立模式無瀏覽器縮放輔助，更需合規） --- */
const tapTargets = await page.evaluate(() => {
  const sel = ['#searchBtn', '#symbolInput', '.chip', '.tab', '.clear-btn'];
  const out = {};
  for (const s of sel) {
    const el = document.querySelector(s);
    if (!el) { out[s] = null; continue; }
    const r = el.getBoundingClientRect();
    out[s] = { w: Math.round(r.width), h: Math.round(r.height) };
  }
  return out;
});
// 主要操作元件須 ≥ 44px 高（Apple HIG）
const critical = ['#searchBtn', '#symbolInput'];
const tooSmall = critical.filter((s) => tapTargets[s] && tapTargets[s].h < 44);
tooSmall.length === 0
  ? pass('主要操作元件高度 ≥ 44px', critical.map((s) => `${s}:${tapTargets[s]?.h}px`).join(' '))
  : fail('主要操作元件過小', tooSmall.map((s) => `${s}:${tapTargets[s]?.h}px`).join(' '));

/* --- 捲動與黏性頂部列行為 --- */
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(500);
const stickyCheck = await page.evaluate(() => {
  const t = document.querySelector('.topbar');
  const r = t.getBoundingClientRect();
  return { top: Math.round(r.top), scrollY: Math.round(window.scrollY) };
});
stickyCheck.top === 0 && stickyCheck.scrollY > 0
  ? pass('捲動後頂部列固定於頂端', `scrollY=${stickyCheck.scrollY}`)
  : fail('頂部列未正確固定', JSON.stringify(stickyCheck));

/* --- Service Worker 在獨立模式仍註冊（快取可用） --- */
const sw = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const reg = await navigator.serviceWorker.getRegistration();
  return { supported: true, active: !!reg?.active, scope: reg?.scope };
});
sw.active ? pass('獨立模式下 Service Worker 仍啟用', sw.scope) : fail('SW 未啟用', JSON.stringify(sw));

/* --- 螢幕截圖存檔供人工檢視 --- */
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(400);
await page.screenshot({ path: 'tests/out-ios-standalone.png', fullPage: true });
console.log('\n  截圖已存：tests/out-ios-standalone.png');

/* ==================== 實驗組 2：通用獨立視窗（matchMedia 分支） ==================== */
console.log('\n[B2] 獨立視窗模式 — 通用訊號（display-mode 媒體特性分支）\n');

{
  const { ctx: ctx2, page: page2 } = await iPhone(browser, { standalone: true, mode: 'media' });
  await page2.goto(`${BASE}/?symbol=AAPL`, { waitUntil: 'networkidle', timeout: 60000 });
  await page2.waitForTimeout(3600);

  const m = await page2.evaluate(() => ({
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
    standaloneAttr: window.navigator.standalone === true,
    // 確認其他媒體查詢未被破壞
    widthMatches: window.matchMedia('(min-width: 100px)').matches,
    darkWorks: typeof window.matchMedia('(prefers-color-scheme: dark)').matches === 'boolean',
    tipHidden: document.getElementById('iosInstallTip')?.hidden,
  }));

  m.displayModeStandalone ? pass('display-mode: standalone 已生效（matchMedia 分支）') : fail('matchMedia 覆寫未生效');
  !m.standaloneAttr ? pass('此路線下 navigator.standalone 保持 false（分支獨立）') : fail('navigator.standalone 不應為 true');
  m.widthMatches && m.darkWorks ? pass('其他媒體查詢未受影響') : fail('媒體查詢被破壞');
  m.tipHidden === true ? pass('通用獨立模式下亦隱藏安裝引導') : fail('通用獨立模式仍顯示引導');
  await ctx2.close();
}

/* ==================== Chromium 安裝性驗證（權威來源） ==================== */
console.log('\n[B3] Chromium 安裝性驗證 — 瀏覽器自身的「加入主畫面」判定\n');

{
  const ctx3 = await browser.newContext({ ...devices['iPhone 15 Pro'], userAgent: IPHONE_UA });
  const page3 = await ctx3.newPage();
  const cdp = await ctx3.newCDPSession(page3);
  await page3.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
  await page3.waitForTimeout(2000);

  try {
    const man = await cdp.send('Page.getAppManifest');
    const errors = man.errors || [];
    errors.length === 0
      ? pass('manifest 無解析錯誤', man.url)
      : fail('manifest 有解析錯誤', JSON.stringify(errors).slice(0, 200));

    const parsed = JSON.parse(man.data || '{}');
    parsed.display === 'standalone' && parsed.start_url === '/'
      ? pass('manifest display/start_url 合規', `${parsed.display} / ${parsed.start_url}`)
      : fail('manifest display/start_url 不合規', `${parsed.display} / ${parsed.start_url}`);

    const sizes = (parsed.icons || []).map((i) => i.sizes || i.size);
    const has192 = sizes.some((s) => String(s).includes('192'));
    const has512 = sizes.some((s) => String(s).includes('512'));
    has192 && has512
      ? pass('具備 192px 與 512px 圖示（安裝必要條件）', sizes.join(', '))
      : fail('圖示尺寸不足', sizes.join(', '));
  } catch (e) {
    fail('getAppManifest 呼叫失敗', e.message.split('\n')[0]);
  }

  try {
    const ie = await cdp.send('Page.getInstallabilityErrors');
    const list = ie.installabilityErrors || [];
    list.length === 0
      ? pass('Chromium 認可為「可安裝」— 無安裝性錯誤', 'installabilityErrors = []')
      : fail('存在安裝性錯誤，無法加入主畫面', list.map((x) => x.errorId).join(', '));
  } catch (e) {
    fail('getInstallabilityErrors 呼叫失敗', e.message.split('\n')[0]);
  }

  await ctx3.close();
}

/* ==================== 對照：裝置旋轉（橫向） ==================== */
console.log('\n[C] 獨立模式 + 橫向（landscape）\n');
await page.setViewportSize({ width: 852, height: 393 });
await page.waitForTimeout(900);
const land = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  canvasInk: (() => {
    const cv = document.getElementById('priceChart');
    if (!cv) return -1;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
    return n;
  })(),
}));
land.overflow === 0 ? pass('橫向無水平溢出') : fail('橫向有水平溢出', land.overflow + 'px');
land.canvasInk > 100 ? pass('橫向圖表正常重繪', 'ink=' + land.canvasInk) : fail('橫向圖表未重繪');

/* ==================== Console 錯誤 ==================== */
console.log('\n[D] Console 錯誤\n');
const realErrs = errs.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|status of 50\d/.test(e));
realErrs.length === 0 ? pass('無非預期錯誤') : fail('有錯誤', realErrs.slice(0, 3).join(' | '));

await ctx.close();
await browser.close();

/* ==================== 總結 ==================== */
const failed = results.filter((r) => !r.ok);
console.log('\n' + '─'.repeat(58));
console.log(`iPhone 獨立視窗驗證： ${results.length - failed.length} / ${results.length} 通過`);
if (failed.length) {
  console.log('\n未通過項目：');
  failed.forEach((f) => console.log(`  ✗ ${f.n}${f.d ? ' — ' + f.d : ''}`));
  process.exit(1);
} else {
  console.log('全部通過。\n');
}
