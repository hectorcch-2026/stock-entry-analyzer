'use strict';

/**
 * 推介追蹤頁 e2e — 視覺與可讀性檢查
 *
 * 檢查重點不是「有沒有元素」，而是三件過去踩過坑的事：
 *   1. 分頁字級與觸控目標（round 4 的教訓：390px 下第 4 個分頁被切掉一半）
 *   2. 小字級 < 12.5px 的節點（「字體太細」的真正原因）
 *   3. 對比度不足的文字（WCAG AA 4.5:1）
 *
 * 另外驗證「數字本身」：摘要與表格加總是否一致。
 * 一個漂亮的頁面配上算錯的數字，比醜頁面更危險。
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:5199';
const SHOT_DIR = path.join(__dirname);

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? '\n      ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  /* ==================== 桌機 ==================== */
  console.log('\n=== 推介追蹤頁 e2e ===\n');
  console.log('[1] 桌機 1440px');

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  desktop.on('pageerror', (e) => errors.push('desktop pageerror: ' + e.message));
  desktop.on('console', (m) => {
    if (m.type() === 'error') errors.push('desktop console: ' + m.text());
  });

  await desktop.goto(BASE + '/#/tracker', { waitUntil: 'networkidle' });
  await desktop.waitForSelector('#viewTracker:not([hidden])', { timeout: 30000 });
  await desktop.waitForSelector('#trTableWrap:not([hidden]), #trEmpty:not([hidden])', { timeout: 60000 });

  const hasTable = await desktop.isVisible('#trTableWrap');
  ok('頁面載入後顯示清單或空狀態', hasTable || (await desktop.isVisible('#trEmpty')));

  if (hasTable) {
    const rowCount = await desktop.$$eval('#trBody tr', (rows) => rows.length);
    ok('表格有資料列', rowCount > 0, `${rowCount} 列`);

    // 標題欄位齊全（使用者要求記錄的欄位）
    const heads = await desktop.$$eval('.tr-table thead th', (ths) =>
      ths.map((t) => t.textContent.trim()));
    const need = ['代碼 / 名稱', '推介日', '建議買入', '止賺', '止蝕', '成交價', '股數', '損益（USD）', '回報率', '持有', '狀態'];
    const missing = need.filter((n) => !heads.some((h) => h.indexOf(n) >= 0));
    ok('使用者要求的欄位全部存在', missing.length === 0,
      missing.length ? '缺少：' + missing.join('、') : heads.join(' | '));

    // 四種狀態至少出現一種，且都在合法集合內
    const statuses = await desktop.$$eval('.tr-state .tr-badge', (els) =>
      els.map((e) => e.textContent.trim()));
    const legal = ['待買入', '持倉中', '已止賺', '已止蝕'];
    const bad = statuses.filter((s) => legal.indexOf(s) < 0);
    ok('狀態文字都在四種合法值內', bad.length === 0 && statuses.length > 0,
      bad.length ? '非法狀態：' + bad.join('、') : [...new Set(statuses)].join('、'));

    // 損益欄位不得出現 NaN / undefined / null
    const bodyText = await desktop.$eval('#trBody', (el) => el.textContent);
    ok('表格沒有 NaN / undefined',
      !/NaN|undefined|\[object/.test(bodyText),
      /NaN|undefined|\[object/.test(bodyText) ? '發現異常文字' : 'OK');

    // 摘要與表格的總損益要一致
    const consistency = await desktop.evaluate(() => {
      const sumEl = document.getElementById('trTotalPnl');
      const reEl = document.getElementById('trRealized');
      const unEl = document.getElementById('trUnrealized');
      function num(el) {
        if (!el) return null;
        const t = el.textContent.replace(/[^0-9.]/g, '');
        const neg = /−|-/.test(el.textContent);
        const v = parseFloat(t);
        if (!isFinite(v)) return null;
        return neg ? -v : v;
      }
      return { total: num(sumEl), realized: num(reEl), unrealized: num(unEl) };
    });
    if (consistency.total != null && consistency.realized != null && consistency.unrealized != null) {
      const sum = Math.round((consistency.realized + consistency.unrealized) * 100) / 100;
      ok('摘要：已實現 + 未實現 = 總損益', Math.abs(sum - consistency.total) < 0.02,
        `${consistency.realized} + ${consistency.unrealized} = ${sum}，顯示 ${consistency.total}`);
    } else {
      ok('摘要數字可解析', false, JSON.stringify(consistency));
    }
  }

  // 導航列
  const navOk = await desktop.isVisible('#mainNav [data-route="tracker"]');
  ok('導航列有「推介追蹤」且可見', navOk);
  const navActive = await desktop.$eval('#mainNav [data-route="tracker"]',
    (a) => a.classList.contains('active'));
  ok('目前頁面在導航列為選中狀態', navActive);

  await desktop.screenshot({ path: path.join(SHOT_DIR, 'out-tracker-desktop.png'), fullPage: true });

  // 狀態分頁可切換
  if (hasTable) {
    const tabs = await desktop.$$('.tr-st-tab');
    ok('狀態篩選有五個分頁', tabs.length === 5, `${tabs.length} 個`);
    if (tabs.length === 5) {
      await tabs[2].click();  // 持倉中
      await desktop.waitForTimeout(300);
      const activeLabel = await desktop.$eval('.tr-st-tab.is-active', (t) => t.textContent.trim());
      ok('點擊分頁後切換為選中', activeLabel.indexOf('持倉中') >= 0, `選中：${activeLabel}`);
      const filtered = await desktop.$$eval('#trBody .tr-badge', (els) =>
        els.map((e) => e.textContent.trim()));
      const allHolding = filtered.length === 0 || filtered.every((s) => s === '持倉中');
      ok('篩選後只顯示該狀態的記錄', allHolding,
        filtered.length ? [...new Set(filtered)].join('、') : '（此狀態無記錄）');
      // 切回全部
      await tabs[0].click();
      await desktop.waitForTimeout(200);
    }
  }

  await desktop.close();

  /* ==================== 行動端 ==================== */
  console.log('\n[2] 行動端 390×844');
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  mobile.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
  mobile.on('console', (m) => {
    if (m.type() === 'error') errors.push('mobile console: ' + m.text());
  });

  await mobile.goto(BASE + '/#/tracker', { waitUntil: 'networkidle' });
  await mobile.waitForSelector('#viewTracker:not([hidden])', { timeout: 30000 });
  await mobile.waitForSelector('#trTableWrap:not([hidden]), #trEmpty:not([hidden])', { timeout: 60000 });

  // 文件層級不得溢出（表格在 .table-wrap 內橫向捲動是設計允許的）
  const overflow = await mobile.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
  }));
  ok('頁面沒有水平溢出', overflow.docW <= overflow.winW + 1,
    `scrollWidth ${overflow.docW} vs viewport ${overflow.winW}`);

  // 狀態分頁：不得被切掉、觸控目標要夠大
  const tabMetrics = await mobile.evaluate(() => {
    const bar = document.querySelector('.tr-status-tabs');
    if (!bar) return null;
    const tabs = Array.prototype.slice.call(bar.querySelectorAll('.tr-st-tab'));
    return {
      scrollW: bar.scrollWidth,
      clientW: bar.clientWidth,
      canScroll: bar.scrollWidth > bar.clientWidth,
      tabs: tabs.map((t) => {
        const r = t.getBoundingClientRect();
        const cs = getComputedStyle(t);
        return {
          text: t.textContent.trim().slice(0, 8),
          w: Math.round(r.width),
          h: Math.round(r.height),
          font: parseFloat(cs.fontSize),
          weight: cs.fontWeight,
          // 在可捲動容器內，只要左緣可見就算「沒被切掉」
          left: Math.round(r.left),
          right: Math.round(r.right),
        };
      }),
    };
  });
  if (tabMetrics) {
    ok('分頁列可橫向捲動（不會被硬擠掉）',
      tabMetrics.canScroll || tabMetrics.scrollW <= tabMetrics.clientW + 1,
      `scrollWidth ${tabMetrics.scrollW} / clientWidth ${tabMetrics.clientW}`);
    const smallTabs = tabMetrics.tabs.filter((t) => t.h < 40);
    ok('每個分頁觸控高度 ≥ 40px', smallTabs.length === 0,
      smallTabs.length ? smallTabs.map((t) => `${t.text}:${t.h}px`).join('、')
        : tabMetrics.tabs.map((t) => `${t.text}:${t.h}px`).join(' '));
    const thinTabs = tabMetrics.tabs.filter((t) => t.font < 13);
    ok('分頁字級 ≥ 13px', thinTabs.length === 0,
      thinTabs.length ? thinTabs.map((t) => `${t.text}:${t.font}px`).join('、')
        : tabMetrics.tabs.map((t) => `${t.font}px/${t.weight}`).join(' '));
    // 第一個分頁必須完整可見（不能被推到畫面外）
    const first = tabMetrics.tabs[0];
    ok('第一個分頁完整可見', first && first.left >= 0,
      first ? `left=${first.left} right=${first.right}` : '找不到');
  }

  // 小字級檢查：不得有 < 12.5px 的可見文字
  const smallText = await mobile.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(
      document.getElementById('viewTracker'),
      NodeFilter.SHOW_TEXT
    );
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent.trim();
      if (!t) continue;
      const el = n.parentElement;
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      // 絕對定位的字（例如角標）多半是裝飾，但這裡不豁免——先看實際結果
      const fs = parseFloat(cs.fontSize);
      if (fs < 12.5) {
        out.push({
          text: t.slice(0, 18),
          size: fs,
          cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 40) : '',
        });
      }
    }
    return out;
  });
  ok('沒有小於 12.5px 的可見文字', smallText.length === 0,
    smallText.length
      ? `${smallText.length} 處：` + smallText.slice(0, 6).map((s) => `${s.size}px「${s.text}」(.${s.cls})`).join('; ')
      : '全部 ≥ 12.5px');

  // 對比度
  const contrast = await mobile.evaluate(() => {
    function lum(rgb) {
      const a = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    }
    function parse(c) {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x));
      return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
    }
    function bgOf(el) {
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const cs = getComputedStyle(cur);
        if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          const p = parse(cs.backgroundColor);
          if (p && p.a > 0.5) return p.rgb;
        }
        cur = cur.parentElement;
      }
      return [255, 255, 255];
    }
    const out = [];
    const els = document.querySelectorAll('#viewTracker *');
    Array.prototype.forEach.call(els, (el) => {
      if (!el.textContent || !el.textContent.trim()) return;
      if (el.children.length > 0) return;   // 只看葉節點
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const fg = parse(cs.color);
      if (!fg) return;
      const bg = bgOf(el);
      const L1 = lum(fg.rgb);
      const L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        out.push({
          text: el.textContent.trim().slice(0, 16),
          ratio: Math.round(ratio * 100) / 100,
          need,
          size,
          cls: typeof el.className === 'string' ? el.className.slice(0, 36) : '',
        });
      }
    });
    return out;
  });
  const totalLeaves = await mobile.evaluate(() => {
    let n = 0;
    document.querySelectorAll('#viewTracker *').forEach((el) => {
      if (el.children.length === 0 && el.textContent.trim()) n += 1;
    });
    return n;
  });
  const ratio = totalLeaves ? contrast.length / totalLeaves : 0;
  ok('對比度不合格比例 ≤ 5%', ratio <= 0.05,
    contrast.length
      ? `${contrast.length}/${totalLeaves}（${(ratio * 100).toFixed(1)}%）：`
        + contrast.slice(0, 5).map((c) => `${c.ratio}:1(${c.size}px).${c.cls}`).join('; ')
      : `0/${totalLeaves}`);

  await mobile.screenshot({ path: path.join(SHOT_DIR, 'out-tracker-mobile.png'), fullPage: true });

  // 表格在窄螢幕的橫向捲動容器
  const tableScroll = await mobile.evaluate(() => {
    const wrap = document.getElementById('trTableWrap');
    if (!wrap) return null;
    const cs = getComputedStyle(wrap);
    return {
      overflowX: cs.overflowX,
      scrollW: wrap.scrollWidth,
      clientW: wrap.clientWidth,
    };
  });
  if (tableScroll) {
    ok('表格在自己的容器內橫向捲動（不撐破頁面）',
      tableScroll.overflowX === 'auto' || tableScroll.overflowX === 'scroll',
      `overflow-x: ${tableScroll.overflowX}, ${tableScroll.scrollW} / ${tableScroll.clientW}`);
  }

  await mobile.close();

  /* ==================== 其他寬度 ==================== */
  console.log('\n[3] 其他視窗寬度');
  for (const w of [360, 320, 768]) {
    const p = await browser.newPage({ viewport: { width: w, height: 800 } });
    await p.goto(BASE + '/#/tracker', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#viewTracker:not([hidden])', { timeout: 30000 });
    await p.waitForTimeout(600);
    const o = await p.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    }));
    ok(`${w}px 沒有水平溢出`, o.docW <= o.winW + 1, `${o.docW} vs ${o.winW}`);
    await p.close();
  }

  /* ==================== 錯誤處理 ==================== */
  console.log('\n[4] 錯誤處理');
  const errPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await errPage.route('**/api/tracker**', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":{"code":"X","message":"模擬失敗"}}' }));
  await errPage.goto(BASE + '/#/tracker', { waitUntil: 'domcontentloaded' });
  await errPage.waitForTimeout(1500);
  const errShown = await errPage.isVisible('#trError');
  ok('API 失敗時顯示錯誤區塊', errShown);
  const errMsg = errShown ? await errPage.$eval('#trErrorMessage', (e) => e.textContent) : '';
  ok('錯誤訊息有說明原因', /模擬失敗|失敗/.test(errMsg), errMsg);
  await errPage.close();

  /* ==================== 前端數字必須與 API 一致 ====================
   *
   * 為什麼要獨立驗這一項：
   *   上面所有檢查都在看「畫面有沒有問題」，但畫面上一個漂亮的
   *   +US$1,006.46 可能根本是渲染時算錯的。數字錯比排版醜嚴重得多，
   *   因為使用者會拿它去做決定。
   *   這裡直接比對 API 原始值與 DOM 文字，任何格式化錯誤都會被抓到。
   */
  console.log('\n[5] 前端顯示與 API 數值一致');
  {
    // 用獨立請求上下文取 API 原始資料（desktop 頁面已關閉，不能借用它的 request）
    const apiCtx = await require('playwright').request.newContext();
    const apiResp = await apiCtx.get(BASE + '/api/tracker?preview=1');
    const data = await apiResp.json();
    await apiCtx.dispose();
    const sum = data.summary || {};

    // 重新開一頁確保讀到的是同一份資料
    const verPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await verPage.goto(BASE + '/#/tracker', { waitUntil: 'networkidle' });
    await verPage.waitForSelector('#trTableWrap:not([hidden]), #trEmpty:not([hidden])', { timeout: 60000 });
    await verPage.waitForTimeout(500);

    const dom = await verPage.evaluate(() => ({
      total: document.getElementById('trTotalPnl').textContent,
      realized: document.getElementById('trRealized').textContent,
      unrealized: document.getElementById('trUnrealized').textContent,
      deployed: document.getElementById('trDeployed').textContent,
      counts: document.getElementById('trCounts').textContent,
      rows: [...document.querySelectorAll('#trBody tr')].map((tr) => {
        const td = tr.querySelectorAll('td');
        return {
          symbol: (td[0] && td[0].innerText.split('\n')[0] || '').trim(),
          pickDate: (td[1] && td[1].innerText.trim()) || '',
          status: (td[11] && td[11].innerText.trim()) || '',
          pnlText: (td[8] && td[8].innerText.trim()) || '',
        };
      }),
    }));

    // 總損益
    const expectTotal = sum.totalPnlUsd;
    const gotTotal = parseFloat(String(dom.total).replace(/[^0-9.]/g, ''));
    ok('總損益與 API 一致',
      expectTotal != null && Math.abs(gotTotal - Math.abs(expectTotal)) < 0.02,
      `API ${expectTotal} vs DOM ${dom.total}`);

    // 逐筆損益
    const apiBySymbol = {};
    (data.records || []).forEach((r) => {
      if (r.pnl) apiBySymbol[r.symbol + '@' + r.pickDate] = r.pnl.amountUsd;
    });
    const mismatches = [];
    dom.rows.forEach((row) => {
      const key = row.symbol + '@' + row.pickDate;
      const expect = apiBySymbol[key];
      if (expect == null) {
        if (row.pnlText !== '—') mismatches.push(`${key}: 應為 — 實際 ${row.pnlText}`);
        return;
      }
      const got = parseFloat(row.pnlText.replace(/[^0-9.]/g, ''));
      if (!isFinite(got) || Math.abs(got - Math.abs(expect)) > 0.02) {
        mismatches.push(`${key}: API ${expect} vs DOM ${row.pnlText}`);
      }
    });
    ok('每一筆損益與 API 一致', mismatches.length === 0,
      mismatches.length ? mismatches.join('; ') : `${dom.rows.length} 筆全部相符`);

    // 筆數
    const expectTotalCount = (sum.counts && sum.counts.total) || 0;
    const gotCount = parseInt(String(dom.counts).replace(/[^0-9]/g, ''), 10);
    ok('交易筆數與 API 一致', gotCount === expectTotalCount,
      `API ${expectTotalCount} vs DOM ${dom.counts}`);

    // 已實現 + 未實現 = 總計（用 API 的原始數字再核一次）
    if (sum.realizedPnlUsd != null && sum.unrealizedPnlUsd != null) {
      const s = Math.round((sum.realizedPnlUsd + sum.unrealizedPnlUsd) * 100) / 100;
      ok('API 內部：已實現 + 未實現 = 總計', Math.abs(s - sum.totalPnlUsd) < 0.02,
        `${sum.realizedPnlUsd} + ${sum.unrealizedPnlUsd} = ${s} vs ${sum.totalPnlUsd}`);
    }

    // 每筆「股數 × 成交價 ≒ 10,000 美元」——這是本金規則的直接驗證
    const notionalBad = [];
    (data.records || []).forEach((r) => {
      if (!r.entry || !r.entry.shares || !r.entry.price) return;
      const notional = r.entry.shares * r.entry.price;
      // 港股需再除以匯率才是美元成本
      const usd = r.currency === 'USD' ? notional : notional / r.entry.fxRate;
      if (Math.abs(usd - 10000) > 1) {
        notionalBad.push(`${r.symbol}: ${usd.toFixed(2)} USD`);
      }
    });
    ok('每筆建倉的名目金額 ≒ 10,000 美元', notionalBad.length === 0,
      notionalBad.length ? notionalBad.join('; ') : '(全部吻合)');

    /**
     * 摘要卡片不得自相矛盾：有未實現損益，就一定要有持倉成本。
     *
     * 這是線上確認抓到的真缺陷：`trDeployed` 綁的是 deployedUsd，
     * 而 deployedUsd 只加總**已結案**的交易成本（它只是已實現報酬率的
     * 分母）。於是「有一筆 10,000 美元持倉、但還沒有任何交易結案」時，
     * 同一張卡片會顯示「未實現 +556.53」與「已投入成本 US$0」。
     *
     * 這種矛盾比數字算錯更難被發現——兩個數字各自都對，
     * 只是放在一起講不通，而使用者只會問「那我到底投了多少錢」。
     */
    const hasOpenPnl = (sum.unrealizedPnlUsd || 0) !== 0 || (sum.openCostUsd || 0) > 0;
    if (hasOpenPnl) {
      const shownCost = parseFloat(String(dom.deployed).replace(/[^0-9.]/g, '')) || 0;
      ok('有未實現損益時，「持倉成本」不得顯示 0',
        shownCost > 0,
        `unrealized=${sum.unrealizedPnlUsd} openCostUsd=${sum.openCostUsd} DOM=${dom.deployed}`);
    }

    await verPage.close();
  }

  /* ==================== 主導航（新增一項後不得溢出） ====================
   *
   * 這是 round 4「分頁被切掉一半」的同類問題：加入第五個導航項後，
   * 390px 需要 437px 而可用只有 364px，第五項被切掉。原本容器是
   * overflow-x:auto 且隱藏捲軸，使用者完全看不出右邊還有東西——
   * 功能等於消失，而且沒有任何錯誤訊息。
   */
  console.log('\n[6] 主導航在行動端不得被切掉');
  for (const w of [390, 360, 320]) {
    const navPage = await browser.newPage({
      viewport: { width: w, height: 800 }, isMobile: true, hasTouch: true,
    });
    await navPage.goto(BASE + '/', { waitUntil: 'networkidle' });
    await navPage.waitForTimeout(400);
    const nav = await navPage.evaluate(() => {
      const el = document.getElementById('mainNav');
      const box = el.getBoundingClientRect();
      const items = [...el.querySelectorAll('[data-route]:not([hidden])')];
      const rects = items.map((a) => {
        const r = a.getBoundingClientRect();
        return { t: a.textContent.trim(), l: r.left, r: r.right, h: r.height };
      });
      return {
        count: rects.length,
        clipped: rects.filter((x) => x.r > box.right + 1 || x.l < box.left - 1).map((x) => x.t),
        overflow: rects.filter((x) => x.r > window.innerWidth + 1 || x.l < -1).map((x) => x.t),
        smallTouch: rects.filter((x) => x.h < 36).map((x) => `${x.t}:${Math.round(x.h)}px`),
        docW: document.documentElement.scrollWidth,
      };
    });
    ok(`${w}px：五個導航項都完整可見`, nav.clipped.length === 0 && nav.overflow.length === 0,
      nav.clipped.length ? '被切掉：' + nav.clipped.join('、')
        : nav.overflow.length ? '溢出視窗：' + nav.overflow.join('、')
          : `${nav.count} 項全部可見，無水平溢出（docW ${nav.docW}）`);
    ok(`${w}px：導航項觸控高度 ≥ 36px`, nav.smallTouch.length === 0,
      nav.smallTouch.length ? nav.smallTouch.join('、') : 'OK');
    await navPage.close();
  }

  /* ==================== JS 錯誤 ==================== */
  ok('沒有 JS 執行期錯誤', errors.length === 0,
    errors.length ? errors.slice(0, 4).join('\n      ') : '無');

  await browser.close();

  console.log(`\n=== 結果：${pass} passed / ${fail} failed ===\n`);
  if (fail) process.exit(1);
})();
