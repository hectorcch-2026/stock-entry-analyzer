'use strict';

/**
 * E2E：宏觀走勢圖（需求 4）與利率期貨隱含路徑（需求 5）
 * =====================================================
 *
 * 這份測試驗的是「使用者真的看得到」：
 *   - 圖卡有沒有出現、canvas 有沒有真的畫出東西（不是空白畫布）
 *   - 利率表有沒有 8 列、時間範圍／更新頻率／來源有沒有顯示
 *   - 桌機與手機都不溢出、不裁切
 *   - 沒有 JS 錯誤
 *
 * 為什麼要檢查 canvas 的像素而不是只看元素存在：
 *   本專案踩過「元素在、但畫布全白」的情況（DPR 設定錯誤時
 *   setTransform 會讓內容畫到畫布外）。只看 DOM 存在會漏掉這種。
 *
 * 用法：node tests/e2e-macro-charts.mjs [baseUrl]
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:5177';
const PASS = [];
const FAIL = [];

function ok(name, cond, detail) {
  if (cond) { PASS.push(name); console.log(`  PASS  ${name}`); }
  else { FAIL.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
}

/** 檢查 canvas 是否有實際繪製內容（掃 alpha 通道） */
async function canvasPainted(page, selector) {
  return page.evaluate((sel) => {
    const cv = document.querySelector(sel);
    if (!cv || !cv.width || !cv.height) return { ok: false, why: 'canvas 不存在或尺寸為 0' };
    try {
      const g = cv.getContext('2d');
      const w = Math.min(cv.width, 400);
      const h = Math.min(cv.height, 300);
      const d = g.getImageData(0, 0, w, h).data;
      let painted = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) painted++;
      return { ok: painted > 50, painted, w: cv.width, h: cv.height };
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }, selector);
}

async function run() {
  const browser = await chromium.launch();

  /* ================= 桌機 ================= */
  console.log('\nA. 桌機 1440px：走勢圖');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();

  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); });

  await page.goto(BASE + '/#/macro', { waitUntil: 'domcontentloaded' });

  const loaded = await page.waitForFunction(() => {
    return document.querySelectorAll('#macroCharts .mc-card').length > 0
      && document.querySelectorAll('#ratesForecast .rf-card').length > 0;
  }, { timeout: 120000 }).then(() => true).catch(() => false);

  ok('A1 走勢圖與利率模組都完成載入', loaded,
    loaded ? '' : '等待逾時：可能是上游無回應或 JS 拋錯');

  if (loaded) {
    const n = await page.locator('#macroCharts .mc-card').count();
    ok('A2 走勢圖卡數量 = 6', n === 6, `實際 ${n} 張`);

    // 逐張檢查畫布真的有內容
    const cards = await page.locator('#macroCharts .mc-card').evaluateAll((els) => els.map((e) => ({
      id: e.getAttribute('data-chart'),
      title: (e.querySelector('.mc-title') || {}).textContent,
      legend: e.querySelectorAll('.mc-legend-item').length,
      hasCanvas: !!e.querySelector('canvas'),
    })));

    ok('A3 每張圖卡都有標題與圖例', cards.every((c) => c.title && c.legend > 0),
      JSON.stringify(cards.filter((c) => !c.title || c.legend === 0)));

    for (const c of cards) {
      const p = await canvasPainted(page, `#macroCharts .mc-card[data-chart="${c.id}"] canvas`);
      ok(`A4-${c.id} 畫布已實際繪製（非空白）`, p.ok,
        p.ok ? '' : `${p.why || ('painted=' + p.painted)}`);
    }

    const idList = cards.map((c) => c.id);
    for (const want of ['rates', 'spread', 'inflation', 'labor', 'activity', 'sentiment']) {
      ok(`A5 含圖表 ${want}`, idList.indexOf(want) >= 0, `實際：${idList.join(',')}`);
    }

    /* ---- 利率預測 ---- */
    console.log('\nB. 利率期貨隱含路徑');
    const rows = await page.locator('#ratesForecast .rf-table tbody tr').count();
    ok('B1 預測表有 8 列（未來 8 季）', rows === 8, `實際 ${rows} 列`);

    const quarters = await page.locator('#ratesForecast .rf-q').evaluateAll((els) => els.map((e) => e.textContent.trim()));
    ok('B2 季度標籤連續且格式正確', (() => {
      if (quarters.length !== 8) return false;
      const re = /^\d{4}Q[1-4]$/;
      if (!quarters.every((q) => re.test(q))) return false;
      // 季別必須依序遞增（含跨年）
      const idx = quarters.map((q) => Number(q.slice(0, 4)) * 4 + Number(q.slice(5)));
      for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return false;
      return true;
    })(), quarters.join(','));

    const metaKeys = await page.locator('#ratesForecast .rf-meta dt').evaluateAll((els) => els.map((e) => e.textContent.trim()));
    ok('B3 已顯示時間範圍', metaKeys.some((k) => k === '時間範圍'), metaKeys.join(','));
    ok('B4 已顯示更新頻率', metaKeys.some((k) => k === '更新頻率'), metaKeys.join(','));
    ok('B5 已顯示基準利率（可追溯的比較基礎）', metaKeys.some((k) => k === '基準利率'), metaKeys.join(','));

    const srcCount = await page.locator('#ratesForecast .rf-src li').count();
    ok('B6 已列出資料來源（≥2 筆）', srcCount >= 2, `實際 ${srcCount}`);

    const formula = await page.locator('#ratesForecast .rf-formula').first().textContent().catch(() => '');
    ok('B7 已說明換算式（100 − 價格）', /100\s*[−-]\s*.{0,6}價格|100\s*[−-]\s*\S{0,4}price/.test(formula || ''),
      (formula || '').trim().slice(0, 80));

    const p2 = await canvasPainted(page, '#ratesForecast canvas');
    ok('B8 利率曲線圖已實際繪製', p2.ok, p2.why || `painted=${p2.painted}`);

    // 每個季度點都必須有合約代碼（可追溯）
    const contractCells = await page.locator('#ratesForecast .rf-c').evaluateAll((els) => els.map((e) => e.textContent.trim()));
    const filled = contractCells.filter((t) => t && t !== '—');
    ok('B9 至少 6 個季度有合約代碼可回查', filled.length >= 6, `實際 ${filled.length}/8：${contractCells.join(',')}`);

    const implRates = await page.locator('#ratesForecast .rf-table tbody tr td:nth-child(4)').evaluateAll((els) => els.map((e) => e.textContent.trim()));
    ok('B10 隱含利率數值合理（0–20% 之間）', (() => {
      const nums = implRates.map((t) => parseFloat(t)).filter((v) => isFinite(v));
      return nums.length >= 6 && nums.every((v) => v > 0 && v < 20);
    })(), implRates.join(','));

    /* ---- 版面 ---- */
    console.log('\nC. 版面（不得溢出、不得裁切）');
    const layout = await page.evaluate(() => {
      const docW = document.documentElement.clientWidth;
      const clipped = [];
      document.querySelectorAll('#macroCharts .mc-title, #macroCharts .mc-sub, .rf-headline, .mc-foot').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.overflow === 'hidden' && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
          clipped.push((el.className || '') + ':' + el.textContent.slice(0, 20));
        }
      });
      const canvases = Array.from(document.querySelectorAll('#macroCharts canvas, #ratesForecast canvas')).map((cv) => {
        const wb = cv.parentNode.getBoundingClientRect();
        const cb = cv.getBoundingClientRect();
        return { fit: Math.abs(cb.width - wb.width) <= 3, w: Math.round(cb.width) };
      });
      return {
        docW,
        scrollW: document.documentElement.scrollWidth,
        clipped,
        canvases,
      };
    });

    ok('C1 頁面無橫向溢出', layout.scrollW <= layout.docW + 1,
      `scrollW=${layout.scrollW} clientW=${layout.docW}`);
    ok('C2 無文字被裁切', layout.clipped.length === 0, layout.clipped.join(' | '));
    ok('C3 所有畫布寬度與容器一致', layout.canvases.every((c) => c.fit && c.w > 250),
      JSON.stringify(layout.canvases));

    ok('C4 無 JS 錯誤', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
  }

  await ctx.close();

  /* ================= 手機 ================= */
  console.log('\nD. 手機 390px');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mctx.newPage();
  const mErrs = [];
  mp.on('pageerror', (e) => mErrs.push(e.message));

  await mp.goto(BASE + '/#/macro', { waitUntil: 'domcontentloaded' });
  const mLoaded = await mp.waitForFunction(() => {
    return document.querySelectorAll('#ratesForecast .rf-card').length > 0;
  }, { timeout: 120000 }).then(() => true).catch(() => false);

  ok('D1 手機寬度下正常載入', mLoaded);

  if (mLoaded) {
    const ml = await mp.evaluate(() => {
      const tw = document.querySelector('.rf-table-wrap');
      return {
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        tableScrollable: tw ? tw.scrollWidth > tw.clientWidth : null,
        tableOverflowX: tw ? getComputedStyle(tw).overflowX : null,
        cardCount: document.querySelectorAll('#macroCharts .mc-card').length,
      };
    });

    ok('D2 手機無橫向溢出', ml.scrollW <= ml.clientW + 1,
      `scrollW=${ml.scrollW} clientW=${ml.clientW}`);
    ok('D3 表格可橫向捲動（不強行壓縮）',
      ml.tableScrollable === true && ml.tableOverflowX === 'auto',
      JSON.stringify(ml));
    ok('D4 手機仍顯示 6 張圖卡', ml.cardCount === 6, `實際 ${ml.cardCount}`);
    ok('D5 手機無 JS 錯誤', mErrs.length === 0, mErrs.slice(0, 3).join(' | '));
  }

  await mctx.close();
  await browser.close();

  /* ================= 結果 ================= */
  console.log(`\n========== 結果：${PASS.length} 通過 / ${FAIL.length} 失敗 ==========`);
  if (FAIL.length) {
    console.log('\n失敗明細：');
    FAIL.forEach((f) => console.log(` - ${f.name}: ${f.detail || ''}`));
  }
  process.exit(FAIL.length === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('E2E 執行失敗：', e);
  process.exit(1);
});
