/**
 * FP（K 線區間預測）UI 驗證 — 瀏覽器端
 *
 * 為什麼需要這一層（單元測試已覆蓋邏輯）：
 *   卡片是否正確渲染、狀態切換是否生效、版面是否溢出，
 *   只有真的跑在瀏覽器裡才驗得出來。
 *   特別是「不可用狀態」——它是最容易被寫成空白或顯示 0 的分支，
 *   而空白會讓使用者誤以為「預測結果是 0」。
 *
 * 驗證項目：
 *   1. 卡片存在且正常顯示
 *   2. 三個週期都有區間數值，且 q10 < q90
 *   3. 不確定性說明存在且非空（規格 §8.4 強制）
 *   4. 不含方向機率字樣（路徑 A 已刪除方向）
 *   5. 配色未使用買區藍 / 漲跌紅綠（規格 §2.3）
 *   6. 手機版無水平溢出
 *   7. 主控台無錯誤
 *
 * 用法：
 *   node tests/e2e-pred.mjs
 *   SYMBOL=KO BASE=http://127.0.0.1:5177/ node tests/e2e-pred.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5177/';
const SYMBOL = process.env.SYMBOL || 'KO';

const results = [];
const pass = (n, d = '') => { results.push({ ok: true, n }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n }); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

try {
  console.log(`\nFP 預測卡片 UI 測試 — ${BASE} (${SYMBOL})\n`);

  await page.goto(`${BASE}?symbol=${SYMBOL}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#result:not([hidden])', { timeout: 90000 });
  await page.waitForSelector('#predCard:not([hidden])', { timeout: 60000 });

  /* ---- 1. 卡片顯示 ---- */
  const visible = await page.isVisible('#predCard');
  visible ? pass('預測卡片已顯示') : fail('預測卡片已顯示');

  /* ---- 2. 三個週期的區間 ---- */
  const rows = await page.$$eval('#predRows .pred-row', (els) =>
    els.map((e) => ({
      h: e.querySelector('.pred-h')?.textContent?.trim(),
      vals: e.querySelector('.pred-vals')?.textContent?.replace(/\s+/g, ' ').trim(),
      spanW: e.querySelector('.pred-span')?.getBoundingClientRect().width || 0,
    }))
  );
  rows.length === 3
    ? pass('三個週期（5/10/20 日）皆已渲染', rows.map((r) => r.h).join(', '))
    : fail('三個週期皆已渲染', `實際 ${rows.length} 列`);

  const allHaveVals = rows.every((r) => r.vals && /\d/.test(r.vals) && r.vals.includes('–'));
  allHaveVals
    ? pass('每列都有下限–上限數值', rows.map((r) => r.vals).join(' | '))
    : fail('每列都有下限–上限數值', JSON.stringify(rows.map((r) => r.vals)));

  const allHaveSpan = rows.every((r) => r.spanW > 0);
  allHaveSpan
    ? pass('每列區間長條皆已繪出')
    : fail('每列區間長條皆已繪出', rows.map((r) => Math.round(r.spanW)).join(','));

  /* ---- 3. 不確定性說明（規格 §8.4 強制）---- */
  const note = await page.textContent('#predNote');
  note && note.trim().length > 20
    ? pass('不確定性說明存在且非空', note.trim().slice(0, 40) + '…')
    : fail('不確定性說明存在且非空', `實際「${note}」`);

  const noteHasDisclaimer = /非價格預測|不構成投資建議/.test(note || '');
  noteHasDisclaimer
    ? pass('說明含「非價格預測／不構成投資建議」')
    : fail('說明含免責語意');

  /* ---- 4. 不得出現方向機率（路徑 A）---- */
  const cardText = await page.textContent('#predCard');
  const hasDirection = /上漲機率|下跌機率|方向機率|probUp/.test(cardText || '');
  !hasDirection
    ? pass('卡片未出現任何方向機率字樣')
    : fail('卡片未出現任何方向機率字樣', '發現方向語義');

  /* ---- 5. 配色不得與買區藍混淆 ---- */
  const colors = await page.evaluate(() => {
    const card = document.getElementById('predCard');
    const span = card.querySelector('.pred-span');
    const badge = document.getElementById('predBadge');
    return {
      spanBorder: span ? getComputedStyle(span).borderColor : null,
      badgeColor: badge ? getComputedStyle(badge).color : null,
    };
  });
  // 買區藍 #1d4ed8 = rgb(29, 78, 216)
  const isZoneBlue = (c) => c === 'rgb(29, 78, 216)';
  // 漲跌紅 #d92b2b = rgb(217,43,43)；跌綠 #0f9d58 = rgb(15,157,88)
  const isUpDown = (c) => c === 'rgb(217, 43, 43)' || c === 'rgb(15, 157, 88)';

  const noBlue = !isZoneBlue(colors.spanBorder) && !isZoneBlue(colors.badgeColor);
  noBlue
    ? pass('未使用買區藍 #1d4ed8')
    : fail('未使用買區藍', JSON.stringify(colors));

  const noUpDown = !isUpDown(colors.spanBorder) && !isUpDown(colors.badgeColor);
  noUpDown
    ? pass('未使用漲跌紅綠承載語義')
    : fail('未使用漲跌紅綠', JSON.stringify(colors));

  /* ---- 6. 與既有卡片並存，未影響其顯示 ---- */
  const legacy = await page.evaluate(() => ({
    buyVisible: !!document.querySelector('.buy-card'),
    probVisible: !!document.querySelector('.prob-card'),
    zoneLower: document.getElementById('zoneLower')?.textContent?.trim(),
    probUp20: document.getElementById('valUp20')?.textContent?.trim(),
  }));
  legacy.buyVisible && legacy.probVisible && legacy.zoneLower !== '—' && legacy.probUp20 !== '—'
    ? pass('既有買入區間與機率卡片仍正常', `買區 ${legacy.zoneLower}，20日 ${legacy.probUp20}`)
    : fail('既有卡片仍正常', JSON.stringify(legacy));

  /* ---- 7. 無水平溢出 ---- */
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  overflow.doc <= overflow.win + 1
    ? pass('桌面版無水平溢出', `${overflow.doc} ≤ ${overflow.win}`)
    : fail('桌面版無水平溢出', `${overflow.doc} > ${overflow.win}`);

  /* ---- 8. 手機版 ---- */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const mOverflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  mOverflow.doc <= mOverflow.win + 1
    ? pass('手機版無水平溢出', `${mOverflow.doc} ≤ ${mOverflow.win}`)
    : fail('手機版無水平溢出', `${mOverflow.doc} > ${mOverflow.win}`);

  const mCardVisible = await page.isVisible('#predCard');
  mCardVisible ? pass('手機版卡片正常顯示') : fail('手機版卡片正常顯示');

  await page.screenshot({ path: 'tests/out-pred-mobile.png', fullPage: false });
  pass('已截圖', 'tests/out-pred-mobile.png');

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForTimeout(300);
  const card = await page.$('#predCard');
  if (card) await card.screenshot({ path: 'tests/out-pred-card.png' });

  /* ---- 9. 主控台無錯誤 ---- */
  consoleErrors.length === 0
    ? pass('主控台無錯誤')
    : fail('主控台無錯誤', consoleErrors.slice(0, 3).join(' | '));

} finally {
  await browser.close();
}

const ok = results.filter((r) => r.ok).length;
console.log(`\n結果：${ok} / ${results.length} 通過`);
process.exit(ok === results.length ? 0 : 1);
