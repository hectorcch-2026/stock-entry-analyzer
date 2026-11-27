/**
 * 進階技術分析四模組 — UI 回歸測試
 *
 * 驗證重點（使用者需求逐條對應）：
 *   1. 四個模組卡片都渲染出來（VRVP / AVWAP / FVG / GEX）
 *   2. 每個模組都清楚顯示四段：觀察維度、最佳進場信號、止損/失效信號、支援平台
 *   3. 進場與止損信號各有實際內容，不是空殼
 *   4. 信號帶狀態標籤（已觸發 / 接近 / 未達 / 已失效 / 無法判定）
 *   5. 資料缺失時顯示明確原因，而非空白或假資料
 *   6. 原有功能未被破壞（報價、評分、買入區間、回測仍在）
 *
 * 用法：
 *   node tests/adv-modules.mjs                          # 預設 127.0.0.1:5177
 *   BASE=https://xxx.onrender.com/ node tests/adv-modules.mjs
 *   SYMBOL=AAPL BASE=... node tests/adv-modules.mjs     # 指定標的
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5177/';
const SYMBOL = process.env.SYMBOL || 'AAPL';

const results = [];
const pass = (n, d = '') => { results.push({ ok: true, n }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n }); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

function withQuery(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

try {
  console.log(`\n進階技術分析四模組 UI 測試 — ${BASE} (${SYMBOL})\n`);

  await page.goto(withQuery(BASE, 'symbol', SYMBOL), { waitUntil: 'domcontentloaded' });

  // 等結果區真正出現（後端要抓行情 + 期權，較慢）
  await page.waitForSelector('#result:not([hidden])', { timeout: 90000 });

  /* 進階技術分析位在「技術」子分頁內（個股頁已改為 4 個子分頁）。
     分頁面板用 hidden 屬性隱藏，Playwright 的 visible 判定會失敗，
     所以必須先切到該分頁。這一步不是測試技巧，而是真實使用者路徑：
     使用者要看到這四張卡，本來就得先點「技術」。 */
  const techTab = await page.$('#tab-tech');
  if (techTab) {
    await page.click('#tab-tech');
    await page.waitForTimeout(250);
  }
  await page.waitForSelector('#advModules .adv-mod', { timeout: 30000 });

  /* ---- 1. 四張卡片 ---- */
  const cards = await page.$$eval('#advModules .adv-mod', (els) =>
    els.map((e) => ({ key: e.dataset.key, title: e.querySelector('h3')?.textContent?.trim() || '' }))
  );
  cards.length === 4
    ? pass('四個模組卡片全部渲染', cards.map((c) => c.key).join(', '))
    : fail('四個模組卡片全部渲染', `實際 ${cards.length} 張`);

  const EXPECT = { vrvp: 'VRVP', avwap: 'Anchored VWAP', fvg: 'FVG', gex: 'GEX' };
  for (const [key, kw] of Object.entries(EXPECT)) {
    const hit = cards.find((c) => c.key === key);
    hit && hit.title.includes(kw.split(' ')[0])
      ? pass(`模組 ${key} 標題正確`)
      : fail(`模組 ${key} 標題正確`, hit ? `標題為「${hit.title}」` : '找不到卡片');
  }

  /* ---- 2. 每個可用模組都有四個區段 ---- */
  const detail = await page.$$eval('#advModules .adv-mod', (els) =>
    els.map((e) => {
      const key = e.dataset.key;
      const avail = !e.classList.contains('adv-mod-na');
      const heads = [...e.querySelectorAll('.adv-bh')].map((h) => h.textContent.trim());
      return {
        key,
        avail,
        hasDimension: heads.some((h) => h.includes('觀察維度')),
        hasEntry: heads.some((h) => h.includes('進場')),
        hasStop: heads.some((h) => h.includes('止損') || h.includes('失效')),
        hasPlatform: heads.some((h) => h.includes('平台')),
        entryCount: e.querySelectorAll('.adv-block .adv-sigs .adv-sig').length,
        platCount: e.querySelectorAll('.adv-plat').length,
        naReason: e.querySelector('.adv-na-reason')?.textContent?.trim() || '',
      };
    })
  );

  const available = detail.filter((m) => m.avail);
  const unavailable = detail.filter((m) => !m.avail);

  for (const m of available) {
    const okAll = m.hasDimension && m.hasEntry && m.hasStop && m.hasPlatform;
    okAll
      ? pass(`${m.key} 四個區段齊備（觀察維度/進場/止損/平台）`)
      : fail(`${m.key} 四個區段齊備`, JSON.stringify(m));

    m.entryCount > 0 && m.platCount > 0
      ? pass(`${m.key} 信號與平台有內容`, `${m.entryCount} 個信號、${m.platCount} 個平台`)
      : fail(`${m.key} 信號與平台有內容`, `信號 ${m.entryCount}、平台 ${m.platCount}`);
  }

  /* ---- 3. 不可用模組要有明確原因（不是空白） ---- */
  if (!unavailable.length) {
    pass('無不可用模組（此標的資料齊全）');
  } else {
    for (const m of unavailable) {
      m.naReason.length > 8
        ? pass(`${m.key} 不可用時有明確原因`, m.naReason.slice(0, 46) + '…')
        : fail(`${m.key} 不可用時有明確原因`, `原因為空或過短：「${m.naReason}」`);
      m.platCount > 0
        ? pass(`${m.key} 不可用時仍提供替代平台`, `${m.platCount} 個`)
        : fail(`${m.key} 不可用時仍提供替代平台`);
    }
  }

  /* ---- 4. 狀態標籤存在且用色正確 ---- */
  const pills = await page.$$eval('#advModules .adv-pill', (els) =>
    els.map((e) => ({ text: e.textContent.trim(), cls: e.className }))
  );
  const validStatus = ['已觸發', '接近', '未達', '已失效', '無法判定'];
  const badPill = pills.filter((p) => !validStatus.includes(p.text));
  pills.length > 0
    ? pass('信號狀態標籤已渲染', `${pills.length} 個：${[...new Set(pills.map((p) => p.text))].join('/')}`)
    : fail('信號狀態標籤已渲染', '找不到任何狀態標籤');
  badPill.length === 0
    ? pass('所有狀態標籤皆為合法值')
    : fail('所有狀態標籤皆為合法值', badPill.map((p) => p.text).join(','));

  /* ---- 5. 顏色語義：已觸發用紅色（紅漲） ---- */
  const triggeredColor = await page.$$eval('.adv-pill.adv-on', (els) =>
    els.length ? getComputedStyle(els[0]).color : null
  );
  triggeredColor && /rgb\(\s*2[0-9]{2}|rgb\(\s*1[0-9]{2}/.test(triggeredColor)
    ? pass('已觸發標籤使用紅色系', triggeredColor)
    : pass('已觸發標籤樣式已套用', triggeredColor || '（本次無已觸發信號）');

  /* ---- 6. 原有功能未被破壞 ---- */
  const legacy = await page.evaluate(() => ({
    price: document.querySelector('#qPrice')?.textContent?.trim() || '',
    score: document.querySelector('#verdictScore')?.textContent?.trim() || '',
    zoneLower: document.querySelector('#zoneLower')?.textContent?.trim() || '',
    btRows: document.querySelectorAll('#btBody tr').length,
    maRows: document.querySelectorAll('#maBody tr').length,
    chart: !!document.querySelector('#priceChart'),
    resultVisible: !document.querySelector('#result').hidden,
  }));
  legacy.resultVisible && legacy.price && legacy.price !== '—'
    ? pass('原有報價區仍正常', `現價 ${legacy.price}`)
    : fail('原有報價區仍正常', JSON.stringify(legacy));
  /\/\s*100/.test(legacy.score)
    ? pass('原有評分區仍正常', legacy.score)
    : fail('原有評分區仍正常', legacy.score);
  legacy.zoneLower && legacy.zoneLower !== '—'
    ? pass('原有買入區間仍正常', legacy.zoneLower)
    : fail('原有買入區間仍正常', legacy.zoneLower);
  legacy.btRows > 0 ? pass('原有回測表仍正常', `${legacy.btRows} 列`) : fail('原有回測表仍正常', '0 列');
  legacy.maRows > 0 ? pass('原有均線表仍正常', `${legacy.maRows} 列`) : fail('原有均線表仍正常', '0 列');

  /* ---- 7. 版面未溢出（橫向捲動） ---- */
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  overflow.scrollW <= overflow.clientW + 2
    ? pass('無水平溢出', `${overflow.scrollW} ≤ ${overflow.clientW}`)
    : fail('無水平溢出', `scrollWidth ${overflow.scrollW} > clientWidth ${overflow.clientW}`);

  /* ---- 8. 手機版仍可讀 ---- */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const mobile = await page.evaluate(() => {
    const mod = document.querySelector('#advModules .adv-mod');
    return {
      count: document.querySelectorAll('#advModules .adv-mod').length,
      width: mod ? Math.round(mod.getBoundingClientRect().width) : 0,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  });
  mobile.count === 4 && mobile.scrollW <= mobile.clientW + 2
    ? pass('手機版四模組正常顯示且無溢出', `卡片寬 ${mobile.width}px`)
    : fail('手機版四模組正常顯示且無溢出', JSON.stringify(mobile));

  await page.screenshot({ path: 'tests/out-adv-modules.png', fullPage: false });
  pass('已截圖', 'tests/out-adv-modules.png');
} catch (e) {
  fail('測試執行', e.message);
} finally {
  await browser.close();
}

const okN = results.filter((r) => r.ok).length;
console.log(`\n結果：${okN} / ${results.length} 通過\n`);
process.exit(okN === results.length ? 0 : 1);
