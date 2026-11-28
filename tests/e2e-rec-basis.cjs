'use strict';

/**
 * 「推薦依據」UI 驗證（真的開 Chromium）
 * =====================================
 *
 * 需求：為每筆推介保存推薦原因、推薦參數、推薦當時的新聞 AI 摘要，
 *       並在 K 線圖上標示推介／止蝕／止賺的日期與價位。
 *
 * 這支測試刻意**不連上游**：Yahoo 在沙箱常回 403，
 * 若讓測試依賴它，會變成「網路好不好」的測試而不是功能的測試。
 * 作法是啟動一個帶樁資料源的本機伺服器，帳本用一筆合成的完整記錄。
 *
 * 為什麼要另外造一份帳本而不是用既有 data/tracker：
 *   既有帳本是使用者的真實資料，測試不能改它；而且它是功能上線
 *   前建立的，沒有 reasons/params/newsAi——那正好也是要驗的
 *   「舊記錄不顯示空殼」情境，但主要驗的是新記錄要完整顯示。
 *
 * 用法：node tests/e2e-rec-basis.cjs
 */

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 5311);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

/* ---- 合成一根根可預期的日 K（跳過週末，讓假日對應真的被走到） ---- */
function makeBars(n) {
  const bars = [];
  let day = Date.UTC(2026, 9, 1);
  let px = 100;
  while (bars.length < n) {
    const dow = new Date(day).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      px += (((bars.length * 37) % 11) - 5) * 0.6;
      bars.push({
        t: day,
        o: +px.toFixed(2),
        h: +(px + 1.2).toFixed(2),
        l: +(px - 1.1).toFixed(2),
        c: +(px + (((bars.length * 29) % 5) - 2) * 0.3).toFixed(2),
        v: 1200000,
      });
    }
    day += 86400000;
  }
  return bars;
}
const BARS = makeBars(70);

function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/* ---- 合成記錄：推介在第 30 根、進場在第 35 根、出場在第 60 根 ---- */
const PICK_DATE = dayKeyOf(BARS[30].t);
const ENTRY_DATE = dayKeyOf(BARS[35].t);
const EXIT_DATE = dayKeyOf(BARS[60].t);

const RECORD = {
  id: '2015.HK@' + PICK_DATE,
  symbol: '2015.HK',
  name: 'Li Auto Inc.',
  market: 'HK',
  currency: 'HKD',
  pickDate: PICK_DATE,
  refPrice: 100,
  score: 72.5,
  verdict: 'buy',
  buyLow: 96,
  buyHigh: 99,
  stopPrice: 88,
  targetPrice: 118,
  status: 'target_hit',
  entry: { date: ENTRY_DATE, price: 97.5, shares: 12 },
  exit: { date: EXIT_DATE, price: 118, reason: 'target' },
  pnl: 246,
  settled: true,
  lastCheck: EXIT_DATE,
  history: [],
  reasons: [
    { title: '型態：突破下降趨勢線', body: '過去三週高點層層下移，今日收盤站上趨勢線且量能放大 1.8 倍，屬於有效突破而非假突破。' },
    { title: '風險報酬比 2.6', body: `以 ${'96'}~99 為買區、88 為止蝕、118 為止賺，最壞情況虧 11 元、最好情況賺 19 元，比例 2.6 高於門檻 2.0。` },
    { title: '量價配合', body: '上漲日成交量平均高於下跌日 34%，代表買方願意追價，不是只有少數人在拉抬。' },
  ],
  params: {
    atrPct: 3.42,
    distAtr: 0.8,
    rrRatio: 2.6,
    avgVol: 18200000,
    winRate20: 61.5,
    samples: 42,
    probUp20: 58.2,
    probProfit: 63.1,
    baseRate20: 52.4,
    breakdown: [
      { k: 'trend', l: '趨勢', s: 18, m: 25 },
      { k: 'volume', l: '量能', s: 16, m: 20 },
      { k: 'rr', l: '盈虧比', s: 20, m: 20 },
      { k: 'vol', l: '波動度', s: 9, m: 15 },
      { k: 'base', l: '基準機率', s: 9.5, m: 20 },
    ],
  },
  newsAi: {
    summary: '近一週新聞集中在交付量成長與新車型發表，管理層對第四季毛利率給出正向指引；負面消息為同業價格戰，但對本公司衝擊有限。整體情緒偏多。',
    sentiment: '偏多',
    score: 68,
    confidence: 0.72,
    mode: 'rule',
    newsCount: 9,
    headlines: [
      '理想汽車 10 月交付量同比增長 32%',
      '新車型 L6 訂單超出內部預期',
      '管理層：第四季毛利率有望回升',
      '同業降價促銷，市場擔憂價格戰延續',
      '機構上調目標價至 130 港元',
    ],
    at: new Date().toISOString(),
  },
};

/* ---- 舊記錄（功能上線前），用來驗「不要顯示空殼」 ---- */
const OLD_RECORD = {
  id: 'BEKE@' + dayKeyOf(BARS[20].t),
  symbol: 'BEKE',
  name: 'KE Holdings Inc.',
  market: 'US',
  currency: 'USD',
  pickDate: dayKeyOf(BARS[20].t),
  refPrice: 18,
  score: 60,
  verdict: 'watch',
  buyLow: 17,
  buyHigh: 18,
  stopPrice: 15.5,
  targetPrice: 22,
  status: 'pending',
  entry: null,
  exit: null,
  pnl: null,
  settled: false,
  lastCheck: null,
  history: [],
};

/* ---- 建立臨時環境 ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-basis-'));

function writeLedger() {
  const ledger = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    records: [RECORD, OLD_RECORD],
  };
  const file = path.join(tmp, 'ledger.json');
  fs.writeFileSync(file, JSON.stringify(ledger, null, 1), 'utf8');
  return file;
}

/** 帶樁資料源的啟動器：只替換 chart()，其餘照舊 */
const STUB_ENTRY = path.join(tmp, 'stub-server.js');
fs.writeFileSync(STUB_ENTRY, `
'use strict';
const path = require('path');
const root = ${JSON.stringify(path.join(__dirname, '..'))};
const ds = require(path.join(root, 'lib', 'datasource'));
// 樁：不動上游，直接回固定的 K 線。圖的繪製邏輯完全走正式程式。
ds.chart = async () => ({ candles: ${JSON.stringify(BARS)} });
process.chdir(root);
require(path.join(root, 'server.js'));
`, 'utf8');

async function waitReady(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/api/tracker?preview=1`);
      if (r.ok) return true;
    } catch { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  const ledgerFile = writeLedger();
  const srv = spawn(process.execPath, [STUB_ENTRY], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      TRACKER_LEDGER_FILE: ledgerFile,
      WATCHLIST_FILE: path.join(tmp, 'watchlist.json'),
      PICKS_TOKEN: '',            // 確保手動推送是關閉的（fail-closed）
      TELEGRAM_BOT_TOKEN: '123:FAKE',
      TRACKER_TELEGRAM: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(String(d)));
  srv.stderr.on('data', (d) => srvLog.push(String(d)));

  const browser = await chromium.launch();
  try {
    const ready = await waitReady();
    ok('測試伺服器啟動', ready, ready ? '' : srvLog.join('').slice(-400));
    if (!ready) throw new Error('伺服器沒起來');

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

    /* ---- 1. 圖表端點 ---- */
    const imgRes = await page.request.get(`${BASE}/api/tracker/chart.png?symbol=2015.HK`);
    ok('圖表端點回 200', imgRes.status() === 200, String(imgRes.status()));
    ok('內容型別是 PNG', /image\/png/.test(imgRes.headers()['content-type'] || ''),
      imgRes.headers()['content-type']);
    const buf = await imgRes.body();
    ok('回傳真的是 PNG（簽章正確）', buf.length > 1000 && buf[0] === 0x89 && buf[1] === 0x50,
      `${buf.length} bytes`);
    fs.writeFileSync(path.join(__dirname, '..', '.probe', 'rec-basis-chart.png'), buf);

    /* ---- 2. 推介頁的「推薦依據」按鈕 ---- */
    await page.goto(`${BASE}/#/tracker`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
    const rows = await page.locator('#trBody tr.tr-row').count();
    ok('推介頁有資料列', rows === 2, `${rows} 列`);

    const hasBasisBtn = await page.locator('#trBody tr.tr-row').filter({ hasText: '2015.HK' })
      .locator('button.tr-op-basis').count();
    ok('新記錄有「推薦依據」按鈕', hasBasisBtn === 1);

    const oldBasisBtn = await page.locator('#trBody tr.tr-row').filter({ hasText: 'BEKE' })
      .locator('button.tr-op-basis').count();
    ok('舊記錄（無依據）不顯示該按鈕，避免點了只有空殼', oldBasisBtn === 0);

    /* ---- 3. 展開後顯示什麼 ---- */
    await page.locator('#trBody tr.tr-row').filter({ hasText: '2015.HK' })
      .locator('button.tr-op-basis').click();
    await page.waitForTimeout(1200);

    const panel = page.locator('.tr-basis-row:not([hidden]) .tr-basis');
    ok('展開列出現', await panel.count() === 1);

    const recTitles = await panel.locator('.tr-basis-reason h4').allInnerTexts();
    ok('顯示推薦原因（3 段）', recTitles.length === 3, recTitles.join(' / '));
    ok('推薦原因有實際文字',
      /突破下降趨勢線/.test(recTitles[0] || ''), recTitles[0]);

    const paramText = await panel.locator('.tr-basis-params').innerText();
    ok('顯示推薦參數（盈虧比）', /2\.6/.test(paramText), paramText.split('\n').slice(0, 4).join(' '));
    ok('參數含 20 日勝率與樣本數', /61\.5/.test(paramText) && /42/.test(paramText));

    const bdRows = await panel.locator('.tr-basis-breakdown tr').count();
    ok('顯示分項得分（5 項）', bdRows === 5, `${bdRows} 列`);

    const newsText = await panel.locator('.tr-basis-news').innerText();
    ok('顯示新聞 AI 摘要', /交付量成長/.test(newsText));
    ok('顯示情緒標籤', /偏多/.test(newsText), newsText.split('\n')[0]);
    const heads = await panel.locator('.tr-basis-news-list li').count();
    ok('顯示新聞標題（最多 5 則）', heads === 5, `${heads} 則`);

    ok('展開列顯示 K 線圖', await panel.locator('.tr-basis-img').count() === 1);
    const legend = await panel.locator('.tr-basis-legend').innerText();
    ok('圖例說明 P / X 與日期',
      /P 推介/.test(legend) && /X 止賺/.test(legend), legend);

    const imgOk = await page.locator('.tr-basis-img').evaluate((el) => el.complete && el.naturalWidth > 0);
    ok('K 線圖真的載入成功（不是破圖）', imgOk);

    /* ---- 幾何：圖在左、文字在右，且不撐出橫向捲軸 ----
       這兩件事壞掉時畫面「看起來還在」，只是變得很難讀，
       所以只能用量測釘住。 */
    const geo = await page.evaluate(() => {
      const box = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const img = document.querySelector('.tr-basis-img');
      return {
        chart: box('.tr-basis-chart'),
        info: box('.tr-basis-info'),
        img: box('.tr-basis-img'),
        natural: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    ok('圖表區在左、文字區在右', geo.chart && geo.info && geo.chart.x < geo.info.x,
      geo.chart && geo.info ? `chart.x=${geo.chart.x} info.x=${geo.info.x}` : '');
    ok('圖與文字不重疊', geo.chart && geo.info && geo.chart.x + geo.chart.w <= geo.info.x + 1);
    ok('展開後不產生橫向捲軸', geo.overflowX === false);
    ok('K 線圖以原始尺寸 720x420 提供（不被壓縮變形）',
      !!geo.natural && geo.natural.w === 720 && geo.natural.h === 420,
      geo.natural ? `${geo.natural.w}x${geo.natural.h}` : 'null');

    await page.screenshot({ path: path.join(__dirname, '..', '.probe', 'rec-basis-open.png'), fullPage: true });

    /* ---- 4. 一次只開一筆 ---- */
    const openCount = await page.locator('.tr-basis-row:not([hidden])').count();
    ok('同時只有一筆展開', openCount === 1, `${openCount} 筆`);

    /* ---- 5. 個股詳情頁也有推薦依據 ---- */
    await page.goto(`${BASE}/#/detail/2015.HK`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    /* 注意：這裡驗的是「卡片有沒有被填上內容」，不是 isVisible()。
       本測試的樁不提供 /api/analyze 的真實行情（沙箱連不上上游），
       所以 #result 容器本身是隱藏的，連帶讓卡片 isVisible() 為 false——
       那是行情查詢的狀態，與推薦依據是否載入無關。
       若用 isVisible() 驗，這條測試會變成在驗「沙箱有沒有網路」。 */
    const cardHidden = await page.locator('#recBasisCard').getAttribute('hidden');
    const cardVisible = cardHidden === null;
    ok('個股詳情頁顯示「推薦依據」卡片', cardVisible);

    if (cardVisible) {
      const badge = await page.locator('#recBasisBadge').innerText();
      ok('卡片標頭顯示推介日與狀態',
        new RegExp(PICK_DATE).test(badge) && /已止賺/.test(badge), badge);
      const dlegend = await page.locator('#recBasisLegend').innerText();
      ok('詳情頁圖例含進場與出場日期',
        /B 進場/.test(dlegend) && /X 止賺/.test(dlegend), dlegend);
      const dimg = await page.locator('#recBasisImg').evaluate((el) => el.complete && el.naturalWidth > 0);
      ok('詳情頁 K 線圖載入成功', dimg);
      await page.screenshot({ path: path.join(__dirname, '..', '.probe', 'rec-basis-detail.png'), fullPage: true });
    }

    /* ---- 6. 沒有推介記錄的股票不顯示這張卡 ---- */
    await page.goto(`${BASE}/#/detail/ZZZZ`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const hiddenForUnknown = !(await page.locator('#recBasisCard').isVisible().catch(() => false));
    ok('沒被推介過的股票不顯示該卡片', hiddenForUnknown);

    const realErrs = errs.filter((e) => !/favicon|manifest|404|Failed to load resource/i.test(e));
    ok('無 JS 錯誤', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));
  } catch (e) {
    fail++;
    fails.push('執行異常');
    console.error('測試異常：', (e && e.stack) || e);
  } finally {
    await browser.close().catch(() => {});
    srv.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log(`\n=== 推薦依據 e2e：${pass} 通過 / ${fail} 失敗 ===`);
  if (fail) { console.log('失敗項：' + fails.join('、')); process.exit(1); }
})();
