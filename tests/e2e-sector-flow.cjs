'use strict';

/**
 * 版塊輪動選股流程 — UI 驗證（真的開 Chromium）
 * ==========================================
 *
 * 驗證三件事，全部都是「使用者看不到就會誤解」的：
 *   1. 表 A（版塊總覽）11 列都出現，優勢／觀察／迴避三種判定都看得到
 *   2. 表 B（漏斗）四個數字能相加對得上，且「無版塊歸屬」非 0 時要標紅
 *   3. 選股結果表出現「所屬版塊／版塊名次」兩欄，且集中度提示有顯示
 *
 * 為什麼一定要開瀏覽器：
 *   前端有大量字串拼接。斷言「API 回了什麼」證明不了「畫面顯示什麼」——
 *   上一次就發生過 API 正確但表格欄位對不上的情況（版塊兩欄插入位置錯開，
 *   資料整體右移一欄）。只有真的渲染出來才看得見。
 *
 * 全離線：起一個替換 datasource.chartWithAdj 與 sectorHoldings.getSectorIndex
 * 的本機伺服器，不碰 Yahoo、也不抓發行商持股檔。
 *
 * 用法：node tests/e2e-sector-flow.cjs
 */

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 5317);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-e2e-'));

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

const STUB_ENTRY = path.join(tmp, 'stub-server.js');
fs.writeFileSync(STUB_ENTRY, `
'use strict';
const path = require('path');
const root = ${JSON.stringify(ROOT)};

/* ---- 樁 1：合成 K 線，讓版塊強弱可預期 ---- */
function synth(days, s0, s1) {
  const candles = [], adjClose = [];
  const start = Date.UTC(2020, 0, 6);
  let px = 100;
  for (let i = 0; i < days; i++) {
    const f = i / (days - 1);
    const cagr = s0 + (s1 - s0) * f;
    const daily = Math.pow(1 + cagr, 1 / 252) - 1;
    px = px * (1 + daily + Math.sin(i / 9) * 0.004);
    candles.push({ t: start + i * 86400000, o: px, h: px * 1.005, l: px * 0.995, c: px, v: 1e6 });
    adjClose.push(px);
  }
  return { candles, adjClose, source: 'stub' };
}

const RATES = {};
const rrg = require(path.join(root, 'lib', 'rrg'));
for (const s of rrg.SECTORS) RATES[s.key] = { start: 0.06, end: 0.06 };
RATES.SPY = { start: 0.06, end: 0.06 };
RATES.XLK = { start: 0.05, end: 0.42 };
RATES.XLI = { start: 0.05, end: 0.30 };
RATES.XLF = { start: 0.06, end: 0.14 };
RATES.XLE = { start: 0.07, end: -0.30 };
RATES.XLU = { start: 0.06, end: -0.12 };

const ds = require(path.join(root, 'lib', 'datasource'));
ds.chartWithAdj = async (symbol) => {
  const r = RATES[symbol] || { start: 0.05, end: 0.05 };
  return synth(900, r.start, r.end);
};
// analyze 也會用到 chart()，一併給樁避免打上游
ds.chart = async () => synth(900, 0.12, 0.20);

/*
 * quote 也必須給樁 —— 這是本測試原本的漏洞。
 *
 * analyzer.analyze() 每檔併發打三個上游（見 analyzer.js 的 Promise.all）：
 *   chart('2y','1d')、chart('5y','1wk')、quote()
 * 前面兩個走 ds.chart，被上面的樁接住了；但 quote 沒有，它會真的
 * 打到 Yahoo。於是這支「聽起來是離線」的 e2e 其實每一檔都在連網：
 * 92 檔就是 92 次真實 quote 請求。
 *
 * 為什麼以前是綠的：Yahoo 沒限流時 quote 成功，測試就過了。等到上游
 * 回 403/429（跑太多輪、或沙箱網路受限），統計就變成
 * analyzed:0 / failed:92，畫面自然是 0 列 —— 然後「所屬版塊」等 4 條
 * 斷言紅掉，看起來像前端把欄位弄丟了，實際上是資料根本沒進來。
 *
 * 教訓：「有樁」不等於「離線」。要斷言的是三個請求都被接住，
 * 而不是「我樁了兩個」。
 */
ds.quote = async function (symbol) {
  var sym = String(symbol).toUpperCase();
  var s30 = synth(30, 0.12, 0.20);
  var price = s30.candles[s30.candles.length - 1].close;
  return {
    symbol: sym,
    name: sym,
    shortName: sym,
    currency: 'USD',
    exchange: 'Stub Exchange',
    market: 'us',
    price: price,
    previousClose: price * 0.995,
    changePercent: 0.5,
    dayHigh: price * 1.01,
    dayLow: price * 0.99,
    volume: 1e6,
    marketTime: Date.now(),
    timezone: 'America/New_York',
  };
};

/* ---- 樁 2：版塊持股索引，把母體平均分進 11 個版塊 ---- */
const pool = require(path.join(root, 'lib', 'pool'));
const sh = require(path.join(root, 'lib', 'sector-holdings'));
const buckets = {};
pool.all().forEach((sym, i) => {
  const key = rrg.SECTORS[i % rrg.SECTORS.length].key;
  if (!buckets[key]) buckets[key] = [];
  buckets[key].push(sym);
});
sh.getSectorIndex = async () => {
  const m = new Map();
  for (const [sector, syms] of Object.entries(buckets)) {
    syms.forEach((s, i) => {
      if (!m.has(s)) m.set(s, []);
      m.get(s).push({ sector, weight: 30 - (i % 30), rank: i + 1 });
    });
  }
  return { ok: true, size: m.size, map: m, failed: [] };
};

process.chdir(root);
require(path.join(root, 'server.js'));
`, 'utf8');

async function waitReady(ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  const srv = spawn(process.execPath, [STUB_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ENABLE_INPROCESS_CRON: '0',
      TELEGRAM_BOT_TOKEN: '',
      WATCHLIST_FILE: path.join(tmp, 'watchlist.json'),
      TRACKER_LEDGER_FILE: path.join(tmp, 'ledger.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(String(d)));
  srv.stderr.on('data', (d) => srvLog.push(String(d)));

  const browser = await chromium.launch();
  try {
    const ready = await waitReady();
    ok('測試伺服器啟動', ready, ready ? '' : srvLog.join('').slice(-500));
    if (!ready) throw new Error('伺服器沒起來');

    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

    /* ==================== 1. 表單控制項 ==================== */
    await page.goto(`${BASE}/#/screen`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    ok('「版塊輪動前置」開關存在且預設開啟',
      await page.locator('#fSectorFlow').isChecked());

    ok('「優勢版塊數」預設為 2',
      (await page.locator('#fSectorTopN').inputValue()) === '2');

    ok('版塊模式開啟時市場下拉被禁用（避免切 hk 卻沒反應）',
      await page.locator('#fMarket').isDisabled());

    /* ==================== 2. 執行篩選 ==================== */
    // 放寬條件，確保有足夠的通過標的可以驗排序
    await page.locator('#fMinScore').fill('40');
    await page.locator('#fMaxDistAtr').fill('10');
    await page.locator('#fLimit').fill('40');
    await page.locator('#screenBtn').click();

    // 等結果卡出現（最多 150 秒：要跑 500→動態池的分析）
    await page.locator('#screenResult').waitFor({ state: 'visible', timeout: 150000 });
    await page.waitForFunction(
      () => {
        const w = document.getElementById('sectorFlowWrap');
        const ld = document.getElementById('screenLoading');
        return w && !w.hidden && (!ld || ld.hidden);
      },
      { timeout: 150000 }
    );

    ok('結果卡顯示', await page.locator('#screenResult').isVisible());

    /* ==================== 3. 表 A：版塊總覽 ==================== */
    const sectorRows = await page.locator('#sectorFlowBody tr').count();
    ok('表 A 列出全部 11 個版塊', sectorRows === 11, `實際 ${sectorRows} 列`);

    const verdictChipCount = await page.locator('#sectorFlowBody .sf-verdict').count();
    ok('每一列都有判定標籤', verdictChipCount === 11, `實際 ${verdictChipCount}`);

    /*
     * 「優勢」在表 A 有兩個層次，測試必須分辨：
     *   tr.is-favored       = 實際被取用（只有前 topN 名，且綠底）
     *   標籤「優勢・未取」   = 象限合格但名次在 topN 外
     * 若只數「優勢」字樣，會得到 6 個；若只數綠底，會得到 2 個。
     * 兩者都要驗，否則就看不出「合格」與「取用」的差別有沒有正確呈現。
     */
    const favoredRows = await page.locator('#sectorFlowBody tr.is-favored').count();
    ok('至少有一個版塊被實際取用（綠底）', favoredRows > 0, `實際 ${favoredRows} 列`);
    ok('實際取用的版塊數不超過 topN(2)', favoredRows <= 2, `實際 ${favoredRows} 列`);

    const qualifiedRows = await page.locator('#sectorFlowBody tr', { hasText: '優勢' }).count();
    ok('「象限合格」的版塊可以多於取用數（表 A 必須看得到這個差別）',
      qualifiedRows >= favoredRows, `合格 ${qualifiedRows}、取用 ${favoredRows}`);

    const basisText = await page.locator('#sectorFlowBasis').textContent();
    ok('「版塊依據」說明有內容（需求要求明示）',
      !!basisText && basisText.includes('版塊'), (basisText || '').slice(0, 60));

    // 版塊代碼與中文名都要出現，不能只有代碼
    const firstSectorCell = await page.locator('#sectorFlowBody tr').first().textContent();
    ok('版塊列同時顯示代碼與名稱',
      /X[LKDVLYPIEBRUC]{1,3}/.test(firstSectorCell) && firstSectorCell.trim().length > 3);

    /* ==================== 4. 表 B：漏斗 ==================== */
    const funnelRows = await page.locator('#sectorFunnel .funnel-row').count();
    ok('漏斗有 4 列（母體／無歸屬／未入選／入池）', funnelRows === 4, `實際 ${funnelRows}`);

    const funnelNums = await page.locator('#sectorFunnel .funnel-count').allTextContents();
    const nums = funnelNums.map((t) => Number(String(t).replace(/[^\d]/g, '')));
    ok('漏斗數字可解析', nums.length === 4 && nums.every((n) => !isNaN(n)), JSON.stringify(nums));

    const [universe, unknown, notFavored, dynamic] = nums;
    ok('漏斗自洽：母體 = 入池 + 無歸屬 + 未入選',
      universe === dynamic + unknown + notFavored,
      `${universe} vs ${dynamic}+${unknown}+${notFavored}=${dynamic + unknown + notFavored}`);
    ok('母體為 500', universe === 500, String(universe));
    ok('無版塊歸屬為 0（樁覆蓋全部母體，非 0 即管線異常）', unknown === 0, String(unknown));

    const covText = await page.locator('#sectorCoverage').textContent();
    ok('覆蓋率說明提到 0 檔未歸屬', /0 檔未歸屬/.test(covText || ''), (covText || '').slice(0, 60));

    /* ==================== 5. 表 C：結果的版塊欄 ==================== */
    const rows = await page.locator('#screenBody tr.sc-row').count();
    ok('結果表有資料列', rows > 0, `${rows} 列`);

    if (rows > 0) {
      const sectorThVisible = await page.locator('#screenTableWrap thead .st-sector').isVisible();
      ok('「所屬版塊」欄可見', sectorThVisible);

      const rankThVisible = await page.locator('#screenTableWrap thead .st-sector-rank').isVisible();
      ok('「版塊名次」欄可見', rankThVisible);

      // 逐列檢查欄位數一致 —— 之前踩過「插入位置錯開導致整列右移」
      const colCounts = await page.$$eval('#screenBody tr.sc-row', (trs) => trs.map((tr) => tr.children.length));
      const headerCols = await page.locator('#screenTableWrap thead tr th').count();
      ok('每一列的儲存格數與表頭一致',
        colCounts.every((c) => c === headerCols),
        `表頭 ${headerCols}，列 ${JSON.stringify([...new Set(colCounts)])}`);

      // 版塊名次必須單調不減（第 1 鍵 ASC）
      const ranks = await page.$$eval('#screenBody tr.sc-row', (trs) => trs.map((tr) => {
        const td = tr.querySelector('td.st-sector-rank');
        return td ? td.textContent.trim() : '';
      }));
      const numeric = ranks.filter(Boolean).map((t) => Number(t.replace('#', '')));
      ok('版塊名次欄有值', numeric.length === rows, `${numeric.length}/${rows}`);
      let monotonic = true;
      for (let i = 1; i < numeric.length; i++) if (numeric[i] < numeric[i - 1]) monotonic = false;
      ok('版塊名次單調不減（版塊優先排序生效）', monotonic, `前 5 名次：${numeric.slice(0, 5)}`);

      // 集中度提示（需求明確要求這句話）
      const note = await page.locator('#screenNote').textContent();
      ok('集中度提示有顯示',
        /來自/.test(note || '') && /變動/.test(note || ''), (note || '').slice(0, 80));
    }

    /* ==================== 6. 關閉版塊模式的行為 ==================== */
    await page.locator('#fSectorFlow').uncheck();
    await page.waitForTimeout(200);
    ok('關閉版塊前置後，優勢版塊數被禁用',
      await page.locator('#fSectorTopN').isDisabled());
    ok('關閉版塊前置後，市場下拉恢復可用',
      await page.locator('#fMarket').isEnabled());

    /* ==================== 7. 無 JS 錯誤 ==================== */
    ok('過程中沒有 JS 錯誤', errs.length === 0, errs.slice(0, 3).join(' | '));

    // 存一張截圖供人工核對
    await page.screenshot({ path: path.join(ROOT, '.probe', 'sector-flow.png'), fullPage: true });
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log(`\n=== 結果：${pass} 通過 / ${fail} 失敗 ===\n`);
  if (fail) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('測試崩潰：', e.message);
  process.exit(1);
});
