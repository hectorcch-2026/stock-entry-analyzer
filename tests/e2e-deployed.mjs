/**
 * 公網 HTTPS 部署驗證
 *
 * 執行：
 *   BASE_URL="https://xxx.app.workbuddy.host/?sharecode=XXXX" node tests/e2e-deployed.mjs
 *
 * 重點：
 *  - 分享連結帶 sharecode，會以 cookie（__wb_rsc）形式授權後續請求。
 *    因此所有 API 驗證都走「瀏覽器 context 的 request」而非 Node 原生 fetch，
 *    才能帶上該 cookie（Node fetch 無 cookie jar，會拿到 403 連結不完整）。
 *  - /api/analyze 與 /api/search 為 GET + query 參數；只有 /api/notify 收 POST body。
 *  - 驗證真正的 PWA 能力：Secure Context、SW 註冊、Chromium 安裝性檢查、離線快取。
 */

import { chromium, devices } from 'playwright';

const SHARE_URL = process.env.BASE_URL;
if (!SHARE_URL) {
  console.error('請設定 BASE_URL，例如：\n  BASE_URL="https://xxx.app.workbuddy.host/?sharecode=XXXX" node tests/e2e-deployed.mjs');
  process.exit(1);
}
const ORIGIN = new URL(SHARE_URL).origin;

const results = [];
const pass = (n, d = '') => { results.push({ ok: true, n, d }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n, d }); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

console.log(`\n驗證目標：${SHARE_URL}\n`);

const browser = await chromium.launch();

/* ==================== [A] HTTPS 與靜態資源（經瀏覽器 cookie jar） ==================== */
console.log('[A] HTTPS 連線與靜態資源\n');

const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], userAgent: IPHONE_UA });
// 模擬 iOS 已加入主畫面
await ctx.addInitScript(() => {
  Object.defineProperty(window.navigator, 'standalone', { get: () => true, configurable: true });
});
const page = await ctx.newPage();
// 逐筆標記錯誤發生時是否處於「刻意斷網」階段。
// [E] 會主動 setOffline(true) 重載頁面，此時瀏覽器自身的資源／manifest 抓取
// 必然失敗，這些是測試手法造成的噪音，不應算進「線上是否有非預期錯誤」。
let offlinePhase = false;
const errs = [];
const rec = (msg, loc = '') => errs.push({ msg, loc, offline: offlinePhase });
page.on('pageerror', (e) => rec(e.message, e.stack || ''));
// 記錄錯誤訊息 + 來源 URL。瀏覽器對 4xx/5xx 資源的 console 訊息常不含 URL，
// 只有 location() 才知道是哪個請求被拒，過濾時才判斷得準。
page.on('console', (m) => {
  if (m.type() === 'error') {
    const l = m.location();
    rec(m.text(), l && l.url ? `${l.url}:${l.lineNumber ?? 0}` : '');
  }
});
// 直接記錄失敗的網路請求（含狀態碼與 URL）——比解析 console 文字可靠得多
const failedReqs = [];
page.on('requestfailed', (r) => failedReqs.push({ url: r.url(), err: r.failure()?.errorText || '', offline: offlinePhase }));
page.on('response', (r) => { if (r.status() >= 400) failedReqs.push({ url: r.url(), err: `HTTP ${r.status()}`, offline: offlinePhase }); });

// 帶 sharecode 進入，取得 __wb_rsc cookie 授權
const nav = await page.goto(SHARE_URL, { waitUntil: 'networkidle', timeout: 60000 });
nav.status() === 200 ? pass('HTTPS 首頁載入成功', `HTTP ${nav.status()}`) : fail('首頁載入失敗', `HTTP ${nav.status()}`);

const cookies = await ctx.cookies();
cookies.some((c) => c.name === '__wb_rsc')
  ? pass('已取得分享授權 cookie', cookies.find((c) => c.name === '__wb_rsc').name)
  : fail('未取得分享授權 cookie');

// 之後所有請求改用 context.request —— 與瀏覽器共用 cookie jar
const api = ctx.request;

{
  const h = await api.get(`${ORIGIN}/api/health`);
  const hj = h.ok() ? await h.json() : null;
  hj?.ok ? pass('API health 正常', `service=${hj.service}`) : fail('API health 異常', `HTTP ${h.status()}`);
}

{
  const m = await api.get(`${ORIGIN}/manifest.webmanifest`);
  const ct = m.headers()['content-type'] || '';
  let mj = null; try { mj = JSON.parse(await m.text()); } catch {}
  mj ? pass('manifest 可取得且為合法 JSON', ct) : fail('manifest 取得失敗', `HTTP ${m.status()} ${ct}`);
  mj?.display === 'standalone' ? pass('manifest display = standalone', mj.short_name) : fail('manifest display 不正確', mj?.display);
}

{
  const s = await api.get(`${ORIGIN}/sw.js`);
  const cc = s.headers()['cache-control'] || '';
  const allowed = s.headers()['service-worker-allowed'] || '';
  /no-cache|no-store/.test(cc) ? pass('sw.js 不被快取（更新可生效）', cc) : fail('sw.js 快取標頭不當', cc);
  allowed === '/' ? pass('Service-Worker-Allowed = /', allowed) : fail('Service-Worker-Allowed 未設定', allowed || '(空)');
}

/* ==================== [B] 公網 API（GET + query） ==================== */
console.log('\n[B] 公網 API 端點\n');
{
  const analyze = async (sym) => {
    const r = await api.get(`${ORIGIN}/api/analyze?symbol=${encodeURIComponent(sym)}`);
    const j = r.ok() ? await r.json() : null;
    return { status: r.status(), j };
  };

  const a = await analyze('AAPL');
  a.j?.ok
    ? pass('美股分析（AAPL）線上可用', `${a.j.meta?.symbol} 評分 ${a.j.score} / ${a.j.verdict?.label}`)
    : fail('美股分析失敗', `HTTP ${a.status} ${JSON.stringify(a.j).slice(0, 140)}`);

  const hk = await analyze('0700.HK');
  hk.j?.ok
    ? pass('港股分析（0700.HK）線上可用', `${hk.j.meta?.symbol} 評分 ${hk.j.score} / ${hk.j.verdict?.label}`)
    : fail('港股分析失敗', `HTTP ${hk.status} ${JSON.stringify(hk.j).slice(0, 140)}`);

  // 港股指數代碼正規化（00700 → 0700.HK，不應誤判為台灣股）
  const hkPad = await analyze('00700');
  (hkPad.j?.meta?.symbol || hkPad.j?.meta?.inputSymbol) === '0700.HK'
    ? pass('港股代碼自動正規化（00700 → 0700.HK）', hkPad.j.meta.symbol)
    : fail('港股代碼正規化異常', `${hkPad.status} ${hkPad.j?.meta?.symbol ?? hkPad.j?.error?.code}`);

  const sr = await api.get(`${ORIGIN}/api/search?q=${encodeURIComponent('騰訊')}`);
  const sj = sr.ok() ? await sr.json() : null;
  sj?.results?.length
    ? pass('中文搜尋（騰訊）線上可用', `${sj.count} 筆，首筆 ${sj.results[0]?.symbol}`)
    : fail('中文搜尋失敗', `HTTP ${sr.status} ${JSON.stringify(sj).slice(0, 140)}`);

  const nw = await api.get(`${ORIGIN}/api/news?symbol=AAPL`);
  const nj = nw.ok() ? await nw.json() : null;
  nj?.ok ? pass('新聞端點線上可用', `${nj.count} 則`) : fail('新聞端點失敗', `HTTP ${nw.status}`);

  const bad = await api.get(`${ORIGIN}/api/analyze?symbol=ZZZZ9`);
  const bj = await bad.json().catch(() => null);
  bad.status() >= 400 && bj?.error?.code
    ? pass('無效代碼回傳友善錯誤', `${bad.status()} ${bj.error.code}`)
    : fail('無效代碼未正確報錯', `HTTP ${bad.status()} ${JSON.stringify(bj).slice(0, 120)}`);

  const empt = await api.get(`${ORIGIN}/api/analyze?symbol=`);
  empt.status() === 400 ? pass('空輸入回傳 400 並附提示', `400 EMPTY`) : fail('空輸入處理異常', `HTTP ${empt.status()}`);
}

/* ==================== [C] 前端在公網的實際行為 ==================== */
console.log('\n[C] 前端線上行為 — iPhone 獨立模式\n');
await page.goto(`${SHARE_URL}&symbol=AAPL`.replace('?sharecode=', '?sharecode=').replace(/[&?]symbol=/, (m) => m), { waitUntil: 'networkidle', timeout: 60000 }).catch(async () => {
  await page.goto(`${SHARE_URL}${SHARE_URL.includes('?') ? '&' : '?'}symbol=AAPL`, { waitUntil: 'networkidle', timeout: 60000 });
});
await page.waitForSelector('#result:not([hidden])', { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3600);

const ui = await page.evaluate(() => ({
  secure: window.isSecureContext,
  protocol: location.protocol,
  resultVisible: !document.getElementById('result')?.hidden,
  errorVisible: !document.getElementById('error')?.hidden,
  errorText: document.getElementById('errorMsg')?.textContent?.slice(0, 100),
  symbol: document.getElementById('qSymbol')?.textContent,
  score: document.getElementById('verdictScore')?.textContent,
  zone: `${document.getElementById('zoneLower')?.textContent} ~ ${document.getElementById('zoneUpper')?.textContent}`,
  tipHidden: document.getElementById('iosInstallTip')?.hidden,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  chartInk: (() => {
    const cv = document.getElementById('priceChart');
    if (!cv) return -1;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
    return n;
  })(),
  rationale: document.querySelectorAll('#rationale .rat-item').length,
  maRows: document.querySelectorAll('#maBody tr').length,
}));

ui.secure ? pass('公網為 Secure Context（PWA 前提）', ui.protocol) : fail('非 Secure Context');
ui.resultVisible
  ? pass('線上 iPhone 完整分析結果渲染', `${ui.symbol} 評分 ${ui.score}，買入區 ${ui.zone}`)
  : fail('線上結果未渲染', ui.errorVisible ? '錯誤：' + ui.errorText : '結果區塊仍隱藏');
ui.chartInk > 100 ? pass('線上 K 線圖繪製正常', 'ink=' + ui.chartInk) : fail('線上圖表未繪製', 'ink=' + ui.chartInk);
ui.maRows > 0 && ui.rationale > 0 ? pass('線上均線表與判斷依據已填充', `${ui.maRows} 列 / ${ui.rationale} 段`) : fail('線上內容未填充');
ui.overflow === 0 ? pass('線上無水平溢出') : fail('線上水平溢出', ui.overflow + 'px');
ui.tipHidden === true ? pass('獨立模式隱藏「加入主畫面」引導（正確）') : fail('獨立模式仍顯示引導');

/* ==================== [D] PWA 安裝性（Chromium 官方判定） ==================== */
console.log('\n[D] PWA 安裝性 — 瀏覽器官方判定\n');
{
  const cdp = await ctx.newCDPSession(page);
  try {
    const man = await cdp.send('Page.getAppManifest');
    (man.errors || []).length === 0
      ? pass('公網 manifest 無解析錯誤', man.url)
      : fail('公網 manifest 有錯誤', JSON.stringify(man.errors).slice(0, 200));

    // 注意：公網為分享連結（sharecode gate），CDP getAppManifest 取回 dataLen=0，
    // 無法解析內容。改由頁面內 fetch（帶瀏覽器 cookie）取得真實 manifest 內容。
    const parsed = await page.evaluate(async () => {
      try {
        const r = await fetch('/manifest.webmanifest', { cache: 'no-store' });
        if (!r.ok) return { __err: 'HTTP ' + r.status };
        return await r.json();
      } catch (e) { return { __err: e.message }; }
    });
    parsed.display === 'standalone' && parsed.start_url === '/'
      ? pass('公網 manifest display / start_url 合規', `${parsed.display} / ${parsed.start_url}`)
      : fail('公網 manifest 不合規', `${parsed.display ?? parsed.__err} / ${parsed.start_url}`);
  } catch (e) { fail('getAppManifest 呼叫失敗', e.message.split('\n')[0]); }

  try {
    const ie = await cdp.send('Page.getInstallabilityErrors');
    const list = ie.installabilityErrors || [];
    list.length === 0
      ? pass('Chromium 認可公網版本「可安裝」— 可加入主畫面', 'installabilityErrors = []')
      : fail('公網版本存在安裝性錯誤', list.map((x) => x.errorId + ' [' + (x.errorArguments || []).join(',') + ']').join(' | '));
  } catch (e) { fail('getInstallabilityErrors 呼叫失敗', e.message.split('\n')[0]); }
}

/* ==================== [E] Service Worker 註冊與離線快取 ==================== */
console.log('\n[E] Service Worker 與離線快取\n');
{
  // 輪詢等待 SW 啟用（首次註冊需時間下載與安裝）
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.active) return { supported: true, active: true, scope: reg.scope, controlled: !!navigator.serviceWorker.controller };
      await new Promise((r) => setTimeout(r, 300));
    }
    const reg = await navigator.serviceWorker.getRegistration();
    return { supported: true, active: !!reg?.active, scope: reg?.scope, controlled: !!navigator.serviceWorker.controller };
  });
  sw.active ? pass('Service Worker 於公網註冊並啟用', sw.scope) : fail('Service Worker 未啟用', JSON.stringify(sw));

  // 重新載入以讓 SW 接管（首次載入時 SW 尚未控制頁面）
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  controlled ? pass('SW 已接管頁面（controller 就緒）') : fail('SW 未接管頁面');

  // 斷網重載：應由快取提供介面外殼
  offlinePhase = true;
  await ctx.setOffline(true);
  const ok = await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).then(() => true).catch(() => false);

  // 離線提示條由 app.js 的 bindConnectionState() 依 navigator.onLine 決定。
  // 公網上 SW 需先接管、app.js 需先執行，時序比本地慢，故輪詢等待而非只讀一次。
  const off = await page.evaluate(async () => {
    const deadline = Date.now() + 8000;
    let bar = null;
    while (Date.now() < deadline) {
      const el = document.getElementById('offlineBar');
      if (el && !el.hidden) {
        bar = { hidden: false, text: document.getElementById('offlineText')?.textContent || '' };
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!bar) {
      const el = document.getElementById('offlineBar');
      bar = el ? { hidden: el.hidden, text: document.getElementById('offlineText')?.textContent || '' } : null;
    }
    return {
      hasApp: !!document.getElementById('symbolInput'),
      onLine: navigator.onLine,
      swControlled: !!navigator.serviceWorker?.controller,
      offlineBar: !!bar && !bar.hidden,
      barText: bar?.text || '',
    };
  }).catch(() => ({ hasApp: false, offlineBar: false }));

  ok && off.hasApp ? pass('斷網後仍可載入介面（快取生效）') : fail('斷網後無法載入', JSON.stringify(off));
  off.offlineBar
    ? pass('斷網時顯示離線提示條', off.barText.slice(0, 40))
    : fail('斷網未提示使用者', `onLine=${off.onLine} swControlled=${off.swControlled}`);
  await ctx.setOffline(false);
  offlinePhase = false;
}

/* ==================== 截圖 ==================== */
await page.goto(SHARE_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'tests/out-deployed.png', fullPage: true });
console.log('\n  線上截圖已存：tests/out-deployed.png');

/* ==================== [F] Console 錯誤 ==================== */
console.log('\n[F] Console 錯誤\n');
// 分兩層判定，不靠猜訊息文字：
//
// 第 1 層｜階段：發生於 [E] 刻意斷網期間的錯誤一律排除（以 offline 旗標判定）。
//
// 第 2 層｜歸因：對「線上階段」失敗的 HTTP 請求逐筆檢查 URL。若失敗請求全部來自
//   瀏覽器對 /manifest.webmanifest 的主動抓取，則屬分享連結 sharecode gate 的行為
//   （瀏覽器內部抓取不帶授權 cookie），不是應用程式的錯；manifest 內容已於 [D]
//   段用頁面內 fetch 驗證正確。若有任何其他路徑失敗，就是真的問題。
const BENIGN_MSG = [/ERR_INTERNET_DISCONNECTED/, /net::ERR_/];
const onlineFailed = failedReqs.filter((r) => !r.offline);
const onlineErrs = errs.filter((e) => !e.offline);

// 是否為 sharecode gate 造成的 manifest 抓取失敗
const isGateNoise = (r) =>
  /\/manifest\.webmanifest(\?|$)/.test(r.url) && /^HTTP 40[13]$/.test(r.err);

const realFailed = onlineFailed.filter((r) => !isGateNoise(r));
// console 錯誤：排除已知斷網殘留訊息，且若該訊息對應的 location 是 manifest 則視為 gate 噪音
const realErrs = [...new Set(onlineErrs
  .filter((e) => !BENIGN_MSG.some((re) => re.test(e.msg)))
  .filter((e) => !(/\/manifest\.webmanifest/.test(e.loc) || /manifest/i.test(e.msg + e.loc)))
  .map((e) => e.msg))];

const okAll = realFailed.length === 0 && realErrs.length === 0;
if (okAll) {
  const note = onlineFailed.length
    ? `已排除 ${onlineFailed.length} 筆 sharecode gate 的 manifest 抓取（非應用缺陷）`
    : (errs.length ? `已排除 ${errs.length} 筆斷網噪音` : '零錯誤');
  pass('線上無非預期錯誤', note);
  if (onlineFailed.length) console.log(`      ↳ 被排除的請求：${onlineFailed.map((r) => `${r.err} ${r.url}`).join(', ')}`);
} else {
  const detail = [
    ...realErrs.slice(0, 2),
    ...realFailed.slice(0, 2).map((r) => `${r.err} ${r.url}`),
  ].join(' | ');
  fail('線上有錯誤', detail);
  if (realFailed.length) console.log(`      ↳ 失敗請求：\n${realFailed.map((r) => `        ${r.err}  ${r.url}`).join('\n')}`);
}

await ctx.close();
await browser.close();

/* ==================== 總結 ==================== */
const failed = results.filter((r) => !r.ok);
console.log('\n' + '─'.repeat(58));
console.log(`公網部署驗證： ${results.length - failed.length} / ${results.length} 通過`);
if (failed.length) {
  console.log('\n未通過項目：');
  failed.forEach((f) => console.log(`  ✗ ${f.n}${f.d ? ' — ' + f.d : ''}`));
  process.exit(1);
} else {
  console.log('全部通過。\n');
}
