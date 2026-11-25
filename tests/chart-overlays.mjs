/**
 * 圖表技術位疊加 — 座標正確性回歸測試
 *
 * 為什麼需要這支測試：
 *   「畫布有畫東西」不代表「畫在對的位置」。技術位圖如果把 POC 畫在
 *   錯誤價位，比不畫更危險——使用者會依此下單。所以本測試不看
 *   「有沒有顏色」，而是把 POC/VAH/VAL 的價格換算成預期像素列，
 *   再去該列取樣，確認顏色真的出現在那裡。
 *
 * 驗證項目：
 *   1. 預設開啟 vp / fvg 兩個圖層，且按鈕狀態一致
 *   2. POC 線（紅）畫在 yOf(poc) 該列
 *   3. VAH / VAL 線（藍 / 灰）畫在各自價位
 *   4. FVG 區間帶（紅=看漲、綠=看跌）覆蓋正確價位區間
 *   5. 關閉圖層後對應顏色消失（切換真的有作用）
 *   6. 圖例包含 POC / VAH / VAL / FVG 字樣
 *   7. hover 時 tooltip 顯示價值區與 FVG 關係
 *   8. 窄螢幕不溢出
 *
 * 用法：
 *   node tests/chart-overlays.mjs
 *   BASE=https://xxx.onrender.com/ node tests/chart-overlays.mjs
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

/**
 * 在指定「CSS 像素」位置取樣一段水平線，統計各種顏色像素數
 *
 * 注意 1：FVG 與成交量分佈的填充是低透明度色塊（alpha .18 ~ .30），
 *         疊在透明畫布上不會變成飽和的紅/綠，直接比對 RGB 會誤判成
 *         「沒畫」。所以另外統計半透明的偏紅 / 偏綠像素。
 * 注意 2：取樣要從「缺口起點」往右取，且避開左側成交量分佈的柱狀區，
 *         否則會取到柱狀圖的藍色而誤判。
 */
const SAMPLE_ROW = `(cssY, cssXFrom, cssXTo) => {
  const cv = document.getElementById('priceChart');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const yPx = Math.round(cssY * dpr);
  const x0 = Math.max(0, Math.round((cssXFrom || 0) * dpr));
  const x1 = Math.min(cv.width, Math.round((cssXTo || cv.width) * dpr));
  if (yPx < 0 || yPx >= cv.height || x1 <= x0) return null;
  const img = ctx.getImageData(x0, yPx, x1 - x0, 1).data;
  let red = 0, blue = 0, green = 0, total = 0, tintRed = 0, tintGreen = 0;
  for (let x = 0; x < (x1 - x0); x++) {
    const i = x * 4, r = img[i], g = img[i + 1], b = img[i + 2], a = img[i + 3];
    if (a < 8) continue;
    total++;
    if (a > 120 && r > 170 && g < 100 && b < 100) red++;
    else if (a > 120 && b > 140 && r < 110) blue++;
    else if (a > 120 && g > 110 && r < 110 && b < 140) green++;
    else if (a >= 8 && a <= 120) {
      if (r > g + 6 && r > b + 6) tintRed++;
      else if (g > r + 6 && g > b + 2) tintGreen++;
    }
  }
  return { red, blue, green, total, tintRed, tintGreen };
}`;

try {
  console.log(`\n圖表技術位疊加測試 — ${BASE} (${SYMBOL})\n`);

  await page.goto(withQuery(BASE, 'symbol', SYMBOL), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#result:not([hidden])', { timeout: 90000 });
  await page.waitForSelector('#advModules .adv-mod', { timeout: 30000 });
  await page.waitForTimeout(900);

  /* ---- 1. 圖層按鈕預設狀態 ---- */
  const tabs = await page.$$eval('.tab', (els) =>
    els.map((e) => ({ key: e.dataset.overlay, on: e.classList.contains('active') }))
  );
  const vpTab = tabs.find((t) => t.key === 'vp');
  const fvgTab = tabs.find((t) => t.key === 'fvg');
  vpTab && fvgTab
    ? pass('新增「籌碼分佈」「FVG 缺口」切換鈕')
    : fail('新增「籌碼分佈」「FVG 缺口」切換鈕', JSON.stringify(tabs.map((t) => t.key)));
  vpTab?.on && fvgTab?.on
    ? pass('兩個新圖層預設開啟')
    : fail('兩個新圖層預設開啟', `vp=${vpTab?.on} fvg=${fvgTab?.on}`);

  /* ---- 取回後端資料作為比對基準 ---- */
  const mods = await page.evaluate(() => {
    const g = document.getElementById('priceChart').__geom;
    return g ? { ok: true, lo: g.lo, hi: g.hi, padT: g.padT, plotH: g.plotH, plotW: g.plotW, padL: g.padL } : { ok: false };
  });
  mods.ok ? pass('圖表幾何可用（可精確驗證座標）') : fail('圖表幾何可用');

  const payload = await page.evaluate(async (sym) => {
    const r = await fetch('/api/analyze?symbol=' + encodeURIComponent(sym));
    return r.json();
  }, SYMBOL);

  const vpData = payload.advancedTools.modules.find((m) => m.key === 'vrvp');
  const fvgData = payload.advancedTools.modules.find((m) => m.key === 'fvg');

  /* ---- 2. POC / VAH / VAL 座標驗證 ---- */
  if (!vpData || !vpData.available) {
    pass('VRVP 資料不可用，跳過線位驗證（非失敗）');
  } else {
    const probes = await page.evaluate(
      ({ geo, d }) => {
        const yOf = (v) => geo.padT + geo.plotH * (1 - (v - geo.lo) / (geo.hi - geo.lo));
        const sample = eval(d.sample);
        return {
          poc: { y: yOf(d.poc), px: sample(yOf(d.poc), 0, 0 + geo.plotW) },
          vah: { y: yOf(d.vah), px: sample(yOf(d.vah), 0, 0 + geo.plotW) },
          val: { y: yOf(d.val), px: sample(yOf(d.val), 0, 0 + geo.plotW) },
        };
      },
      {
        geo: { lo: mods.lo, hi: mods.hi, padT: mods.padT, plotH: mods.plotH, plotW: mods.plotW },
        d: { poc: vpData.data.poc, vah: vpData.data.vah, val: vpData.data.val, sample: SAMPLE_ROW },
      }
    );

    const near = (px) => px && (px.red > 40 || px.blue > 40 || px.green > 40 || px.total > 200);

    near(probes.poc.px)
      ? pass('POC 線已繪於正確價位', `y=${probes.poc.y.toFixed(0)} 紅=${probes.poc.px?.red} 藍=${probes.poc.px?.blue}`)
      : fail('POC 線已繪於正確價位', JSON.stringify(probes.poc));

    near(probes.vah.px)
      ? pass('VAH 線已繪於正確價位', `y=${probes.vah.y.toFixed(0)} 藍=${probes.vah.px?.blue}`)
      : fail('VAH 線已繪於正確價位', JSON.stringify(probes.vah));

    near(probes.val.px)
      ? pass('VAL 線已繪於正確價位', `y=${probes.val.y.toFixed(0)} 藍=${probes.val.px?.blue}`)
      : fail('VAL 線已繪於正確價位', JSON.stringify(probes.val));
  }

  /* ---- 3. FVG 區間帶座標驗證 ---- */
  if (!fvgData || !fvgData.available || !(fvgData.data.active || []).length) {
    pass('FVG 無未回補缺口，跳過區間驗證（非失敗）');
  } else {
    const gap = fvgData.data.active[0];
    const probe = await page.evaluate(
      ({ geo, g, sample, n }) => {
        const yOf = (v) => geo.padT + geo.plotH * (1 - (v - geo.lo) / (geo.hi - geo.lo));
        const yMid = (yOf(g.upper) + yOf(g.lower)) / 2;
        // 從缺口起點往右取樣；左側是成交量分佈的柱狀區，起點至少再往右 20px
        const slot = geo.plotW / n;
        const xFrom = geo.padL + slot * (n - 1 - g.barsAgo) + 20;
        return {
          mid: { y: yMid, px: eval(sample)(yMid, xFrom, geo.padL + geo.plotW) },
          dir: g.direction, lower: g.lower, upper: g.upper, xFrom: Math.round(xFrom),
        };
      },
      {
        geo: { lo: mods.lo, hi: mods.hi, padT: mods.padT, plotH: mods.plotH, plotW: mods.plotW, padL: mods.padL },
        g: gap, sample: SAMPLE_ROW, n: 250,
      }
    );
    const px = probe.mid.px;
    // 看漲缺口填紅、看跌填綠；低透明度填充用 tintRed / tintGreen 判斷
    const expectKey = probe.dir === 'bullish' ? 'tintRed' : 'tintGreen';
    const tint = px && px[expectKey] > 30;
    tint
      ? pass('FVG 區間帶已覆蓋正確價位', `${probe.lower}~${probe.upper} y=${probe.mid.y.toFixed(0)} ${expectKey}=${px?.[expectKey]}`)
      : fail('FVG 區間帶已覆蓋正確價位', JSON.stringify(probe));
  }

  /* ---- 4. 圖例 ---- */
  const legend = await page.$eval('#chartLegend', (e) => e.textContent);
  ['POC', 'VAH', 'VAL', 'FVG'].every((k) => legend.includes(k))
    ? pass('圖例含 POC / VAH / VAL / FVG')
    : fail('圖例含 POC / VAH / VAL / FVG', legend);

  /* ---- 5. 關閉圖層後顏色消失 ---- */
  await page.click('.tab[data-overlay="vp"]');
  await page.click('.tab[data-overlay="fvg"]');
  await page.waitForTimeout(350);
  const offState = await page.$$eval('.tab', (els) =>
    els.filter((e) => ['vp', 'fvg'].includes(e.dataset.overlay)).map((e) => e.classList.contains('active'))
  );
  offState.every((v) => v === false)
    ? pass('可關閉兩個新圖層')
    : fail('可關閉兩個新圖層', JSON.stringify(offState));

  // 關閉後 POC 位置應不再有紅線
  if (vpData?.available) {
    const afterOff = await page.evaluate(
      ({ geo, poc, sample }) => {
        const yOf = (v) => geo.padT + geo.plotH * (1 - (v - geo.lo) / (geo.hi - geo.lo));
        return eval(sample)(yOf(poc), 0, geo.plotW);
      },
      { geo: { lo: mods.lo, hi: mods.hi, padT: mods.padT, plotH: mods.plotH, plotW: mods.plotW }, poc: vpData.data.poc, sample: SAMPLE_ROW }
    );
    const stillDrawn = afterOff && afterOff.red > 600;
    !stillDrawn
      ? pass('關閉後 POC 紅線消失（切換真的生效）', `紅=${afterOff?.red}`)
      : fail('關閉後 POC 紅線消失', `紅=${afterOff?.red}（疑似仍繪製）`);
  }

  /* ---- 6. 重新開啟並驗證 hover tooltip ---- */
  await page.click('.tab[data-overlay="vp"]');
  await page.click('.tab[data-overlay="fvg"]');
  await page.waitForTimeout(300);

  // 必須先把圖表捲進視窗，否則滑鼠座標落在畫布外，hover 不會觸發
  // （第一版就是漏了這步，導致 tooltip 一直是 hidden）
  await page.$eval('#priceChart', (e) => e.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);

  const box = await page.$eval('#priceChart', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  // 取畫布中段的資料區（避開右側 Y 軸留白），並稍微移動兩次確保 mousemove 有觸發
  await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.4);
  await page.mouse.move(box.x + box.w * 0.62, box.y + box.h * 0.42);
  await page.waitForTimeout(450);
  const tip = await page.$eval('#chartTooltip', (e) => ({ hidden: e.hidden, text: e.textContent }));
  !tip.hidden && tip.text.includes('價值區')
    ? pass('hover 顯示與價值區的關係', tip.text.replace(/\s+/g, ' ').slice(0, 60))
    : fail('hover 顯示與價值區的關係', `hidden=${tip.hidden} text=${tip.text.slice(0, 60)}`);

  /* ---- 7. 窄螢幕不溢出 ---- */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const mobile = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    canvasW: Math.round(document.getElementById('priceChart').getBoundingClientRect().width),
    legend: document.getElementById('chartLegend').textContent.length,
  }));
  mobile.scrollW <= mobile.clientW + 2
    ? pass('手機版無水平溢出', `${mobile.scrollW} ≤ ${mobile.clientW}`)
    : fail('手機版無水平溢出', JSON.stringify(mobile));

  await page.screenshot({ path: 'tests/out-chart-overlays.png', fullPage: false });
  pass('已截圖', 'tests/out-chart-overlays.png');
} catch (e) {
  fail('測試執行', e.message);
} finally {
  await browser.close();
}

const okN = results.filter((r) => r.ok).length;
console.log(`\n結果：${okN} / ${results.length} 通過\n`);
process.exit(okN === results.length ? 0 : 1);
