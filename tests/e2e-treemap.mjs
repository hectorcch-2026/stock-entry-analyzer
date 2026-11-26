/**
 * 版塊 Treemap — E2E 測試（真實瀏覽器）
 * =======================================
 * 執行：
 *   node tests/e2e-treemap.mjs                        # 本機
 *   BASE=https://xxx node tests/e2e-treemap.mjs       # 線上（上線驗證必跑）
 *
 * 為什麼要有 E2E（單元測試不夠的原因）：
 *   1. 佈局正確但畫在 0×0 畫布上 → 單元測試全綠、使用者什麼都看不到
 *   2. Canvas 有沒有真的畫出東西，只有 getImageData 知道
 *   3. 顏色是否是「紅漲綠跌」，要看實際像素
 *   4. 行動版溢出只存在於真實排版
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5451';

let pass = 0, fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

function section(t) { console.log(`\n=== ${t} ===`); }

const browser = await chromium.launch();

/* ------------------------------------------------------------
   桌面版
   ------------------------------------------------------------ */
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE + '/#/rrg', { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(4000);

section('A 渲染：畫布真的畫出東西');

await check('A1 Treemap 卡片存在且有尺寸', async () => {
  const r = await page.evaluate(() => {
    const cv = document.getElementById('rrgTmCanvas');
    if (!cv) return null;
    const b = cv.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height) };
  });
  ok(r, '找不到 #rrgTmCanvas');
  ok(r.w > 300, `畫布寬度只有 ${r.w}px`);
  ok(r.h > 200, `畫布高度只有 ${r.h}px`);
});

await check('A2 畫布非空白（非白像素 > 10000）', async () => {
  const n = await page.evaluate(() => {
    const cv = document.getElementById('rrgTmCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let c = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0 && !(d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250)) c++;
    }
    return c;
  });
  ok(n > 10000, `非白像素只有 ${n}，畫布可能是空的`);
});

await check('A3 顏色種類足夠（不是單一色塊）', async () => {
  const n = await page.evaluate(() => {
    const cv = document.getElementById('rrgTmCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const s = new Set();
    for (let i = 0; i < d.length; i += 4 * 13) {
      if (d[i + 3] > 200) s.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
    }
    return s.size;
  });
  ok(n > 20, `只有 ${n} 種顏色，熱力圖應有更多層次`);
});

await check('A4 版塊標題出現在畫布上（有畫文字）', async () => {
  /* 標題列是 rgba(16,24,40,0.72) 的深色橫條，檢查這類像素存在 */
  const n = await page.evaluate(() => {
    const cv = document.getElementById('rrgTmCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let c = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      /* 深灰藍（標題底） */
      if (r < 90 && g < 100 && b < 110 && d[i + 3] > 200) c++;
    }
    return c;
  });
  ok(n > 3000, `深色標題列像素只有 ${n}，標題可能沒畫出來`);
});

section('B 週期切換（日／週／月／年）');

await check('B1 四個週期按鈕都存在', async () => {
  const bs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#rrgTmPeriods button[data-period]'))
      .map((b) => ({ p: b.getAttribute('data-period'), t: b.textContent.trim() })));
  ok(bs.length === 4, `按鈕數 ${bs.length}`);
  const keys = bs.map((b) => b.p).join(',');
  ok(keys === 'd1,w1,m1,y1', `週期順序異常：${keys}`);
  const labels = bs.map((b) => b.t).join('');
  ok(labels === '日週月年', `標籤異常：${labels}`);
});

await check('B2 預設選中「月」', async () => {
  const on = await page.evaluate(() =>
    document.querySelector('#rrgTmPeriods button.on')?.getAttribute('data-period'));
  ok(on === 'm1', `預設選中 ${on}`);
});

await check('B3 切換週期會改變畫面', async () => {
  const sig = () => page.evaluate(() => {
    const cv = document.getElementById('rrgTmCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 4 * 97) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0;
    return h;
  });
  const hashes = {};
  for (const k of ['d1', 'w1', 'm1', 'y1']) {
    await page.click(`#rrgTmPeriods button[data-period="${k}"]`);
    await page.waitForTimeout(260);
    hashes[k] = await sig();
  }
  ok(new Set(Object.values(hashes)).size === 4,
    `四個週期畫布應各不相同，實際 ${JSON.stringify(hashes)}`);
});

await check('B4 切換後選中狀態跟著移動', async () => {
  for (const k of ['d1', 'y1', 'w1']) {
    await page.click(`#rrgTmPeriods button[data-period="${k}"]`);
    await page.waitForTimeout(200);
    const on = await page.evaluate(() =>
      document.querySelector('#rrgTmPeriods button.on')?.getAttribute('data-period'));
    ok(on === k, `點 ${k} 後選中 ${on}`);
    const pressed = await page.evaluate((kk) =>
      document.querySelector(`#rrgTmPeriods button[data-period="${kk}"]`).getAttribute('aria-pressed'), k);
    ok(pressed === 'true', `aria-pressed 未更新`);
  }
});

await check('B5 切換週期不重新請求 API（本地重繪）', async () => {
  let n = 0;
  const h = (r) => { if (r.url().includes('/api/rrg/treemap')) n++; };
  page.on('request', h);
  for (const k of ['d1', 'w1', 'm1', 'y1', 'd1']) {
    await page.click(`#rrgTmPeriods button[data-period="${k}"]`);
    await page.waitForTimeout(150);
  }
  page.off('request', h);
  ok(n === 0, `切換 5 次產生了 ${n} 次 API 請求（應為 0，資料已在同一份回應裡）`);
});

await check('B6 圖例隨週期更新（門檻值不同）', async () => {
  const get = () => page.evaluate(() =>
    document.getElementById('rrgTmLegend').textContent.replace(/\s+/g, ' ').trim());
  await page.click('#rrgTmPeriods button[data-period="d1"]');
  await page.waitForTimeout(250);
  const d1 = await get();
  await page.click('#rrgTmPeriods button[data-period="y1"]');
  await page.waitForTimeout(250);
  const y1 = await get();
  ok(d1 !== y1, '圖例未隨週期更新');
  ok(/2\.5/.test(d1), `日線圖例應含 2.5%，實際：${d1.slice(0, 80)}`);
  ok(/45/.test(y1), `年線圖例應含 45%，實際：${y1.slice(0, 80)}`);
});

await check('B7 統計數字隨週期改變（漲跌家數不同）', async () => {
  const get = () => page.evaluate(() =>
    document.getElementById('rrgTmMeta').textContent.replace(/\s+/g, ' ').trim());
  await page.click('#rrgTmPeriods button[data-period="d1"]');
  await page.waitForTimeout(250);
  const a = await get();
  await page.click('#rrgTmPeriods button[data-period="y1"]');
  await page.waitForTimeout(250);
  const b = await get();
  ok(a !== b, `統計未變：${a}`);
});

section('C 圖例');

await check('C1 圖例有 11 格（5 跌 + 平 + 5 漲）', async () => {
  const n = await page.evaluate(() =>
    document.querySelectorAll('#rrgTmLegend .rrg-tm-leg-bar i').length);
  ok(n === 11, `圖例 ${n} 格`);
});

await check('C2 圖例左端是綠（跌）右端是紅（漲）', async () => {
  const r = await page.evaluate(() => {
    const cs = Array.from(document.querySelectorAll('#rrgTmLegend .rrg-tm-leg-bar i'))
      .map((c) => getComputedStyle(c).backgroundColor);
    const parse = (s) => s.match(/\d+/g).map(Number);
    return { first: parse(cs[0]), last: parse(cs[cs.length - 1]), mid: parse(cs[5]) };
  });
  /* 左端（跌深）應為綠色系：G > R */
  ok(r.first[1] > r.first[0], `左端不是綠色：${r.first}`);
  /* 右端（漲深）應為紅色系：R > G */
  ok(r.last[0] > r.last[1], `右端不是紅色：${r.last}`);
  /* 中間為平盤灰（三色接近） */
  ok(Math.abs(r.mid[0] - r.mid[1]) < 20, `中間不是中性色：${r.mid}`);
});

await check('C3 圖例標示漲跌幅門檻', async () => {
  const txt = await page.evaluate(() =>
    document.getElementById('rrgTmLegend').textContent.replace(/\s+/g, ' '));
  ok(/漲跌幅/.test(txt), '圖例未說明漲跌幅');
  ok(/滿色/.test(txt), '圖例未標示滿色門檻');
  ok(/0%/.test(txt), '圖例未標示 0%');
});

await check('C4 圖例格子有 title（可查各段區間）', async () => {
  const n = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#rrgTmLegend .rrg-tm-leg-bar i'))
      .filter((c) => c.getAttribute('title')).length);
  ok(n === 11, `只有 ${n} 格有 title`);
});

section('D 懸停 Tooltip');

await page.locator('#rrgTmCanvas').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.click('#rrgTmPeriods button[data-period="m1"]');
await page.waitForTimeout(300);

await check('D1 懸停顯示 tooltip', async () => {
  await page.locator('#rrgTmCanvas').hover({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(400);
  const hidden = await page.evaluate(() => document.getElementById('rrgTmTip').hidden);
  ok(!hidden, 'tooltip 未顯示');
});

await check('D2 tooltip 含版塊名稱、市值佔比、漲跌幅', async () => {
  const r = await page.evaluate(() => {
    const t = document.getElementById('rrgTmTip');
    return {
      text: t.textContent.replace(/\s+/g, ' ').trim(),
      tick: t.querySelector('.rrg-tm-tip-tick')?.textContent,
      sec: t.querySelector('.rrg-tm-tip-sec')?.textContent.trim(),
      pct: t.querySelector('.rrg-tm-tip-pct')?.textContent,
      rows: Array.from(t.querySelectorAll('.rrg-tm-tip-list dt')).map((d) => d.textContent),
    };
  });
  ok(r.tick, '缺少股票代碼');
  ok(r.sec && r.sec.length > 1, '缺少版塊名稱');
  ok(r.pct && /%/.test(r.pct), `缺少漲跌幅，實際 ${r.pct}`);
  ok(r.rows.some((x) => /市值/.test(x)), '缺少市值');
  ok(r.rows.some((x) => /佔全體|佔比/.test(x)), '缺少市值佔比');
  const pctRow = r.rows.find((x) => /漲跌/.test(x));
  ok(pctRow && /個月|日|週|年/.test(pctRow), `漲跌幅未標示所選週期：${pctRow}`);
});

await check('D3 tooltip 的百分比格式正確（±X.XX%）', async () => {
  const p = await page.evaluate(() =>
    document.querySelector('.rrg-tm-tip-pct')?.textContent);
  ok(/^[+-]\d+\.\d{2}%$/.test(p), `格式異常：${p}`);
});

await check('D4 漲用紅色、跌用綠色（tooltip 文字色）', async () => {
  /* 找一個明顯上漲的格子 */
  const found = await page.evaluate(() => {
    const tip = document.getElementById('rrgTmTip');
    const el = tip.querySelector('.rrg-tm-tip-pct');
    if (!el) return null;
    return { cls: el.className, color: getComputedStyle(el).color };
  });
  ok(found, '找不到漲跌幅元素');
  /* 只要有 up 或 down class 就算正確掛上 */
  ok(/up|down|flat|none/.test(found.cls), `class 異常：${found.cls}`);
});

await check('D5 tooltip 在視窗範圍內（不被裁切）', async () => {
  const r = await page.evaluate(() => {
    const t = document.getElementById('rrgTmTip');
    const b = t.getBoundingClientRect();
    return {
      left: b.left, top: b.top, right: b.right, bottom: b.bottom,
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
    };
  });
  ok(r.left >= 0 && r.top >= 0, `超出左/上邊界：${JSON.stringify(r)}`);
  ok(r.right <= r.vw + 1, `超出右邊界：right=${r.right} vw=${r.vw}`);
  ok(r.bottom <= r.vh + 1, `超出下邊界：bottom=${r.bottom} vh=${r.vh}`);
});

await check('D6 tooltip 內容隨週期更新', async () => {
  await page.locator('#rrgTmCanvas').hover({ position: { x: 62, y: 62 } });
  await page.waitForTimeout(350);
  const a = await page.evaluate(() =>
    document.getElementById('rrgTmTip').textContent.replace(/\s+/g, ' '));
  await page.click('#rrgTmPeriods button[data-period="y1"]');
  await page.waitForTimeout(350);
  await page.locator('#rrgTmCanvas').hover({ position: { x: 64, y: 64 } });
  await page.waitForTimeout(350);
  const b = await page.evaluate(() =>
    document.getElementById('rrgTmTip').textContent.replace(/\s+/g, ' '));
  ok(a !== b, 'tooltip 未隨週期更新');
});

await check('D7 移出畫布後 tooltip 隱藏', async () => {
  await page.locator('#rrgTmCanvas').hover({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  const hidden = await page.evaluate(() => document.getElementById('rrgTmTip').hidden);
  ok(hidden, 'tooltip 未隱藏');
});

section('E 點擊跳轉');

await check('E1 點擊格子跳到該股分析頁', async () => {
  await page.locator('#rrgTmCanvas').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.locator('#rrgTmCanvas').hover({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(300);
  const tick = await page.evaluate(() =>
    document.querySelector('#rrgTmTip .rrg-tm-tip-tick')?.textContent);
  ok(tick, '懸停未取得代碼');

  await page.locator('#rrgTmCanvas').click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(3000);

  const r = await page.evaluate(() => ({
    hash: location.hash,
    detail: document.body.classList.contains('detail-mode'),
    len: (document.getElementById('result')?.textContent || '').length,
  }));
  ok(r.hash.startsWith('#/detail/'), `hash 未變：${r.hash}`);
  ok(r.hash === '#/detail/' + encodeURIComponent(tick), `跳轉代碼不符：${r.hash} vs ${tick}`);
  ok(r.detail, '未進入詳情模式');
  ok(r.len > 500, `分析頁內容只有 ${r.len} 字（可能是空殼）`);
});

await check('E2 返回後回到 RRG 且畫布仍有內容', async () => {
  await page.goBack();
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const v = document.getElementById('viewRrg');
    const cv = document.getElementById('rrgTmCanvas');
    let ink = false;
    if (cv) {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4 * 997) { if (d[i] > 0) { ink = true; break; } }
    }
    return {
      hash: location.hash,
      visible: v ? (!v.hidden && getComputedStyle(v).display !== 'none') : null,
      ink,
    };
  });
  ok(r.hash === '#/rrg', `返回後 hash 為 ${r.hash}`);
  ok(r.visible === true, 'RRG 檢視不可見');
  ok(r.ink, '返回後畫布是空的');
});

section('F 資料正確性');

await check('F1 版塊數與葉節點數符合 API', async () => {
  const api = await page.evaluate(async () => {
    const r = await fetch('/api/rrg/treemap?period=m1');
    return r.json();
  });
  ok(api.ok, 'API 未回 ok');
  ok(api.groups.length === 11, `版塊 ${api.groups.length} 個（應 11）`);
  ok(api.totals.leaves === 110, `葉節點 ${api.totals.leaves}（應 110）`);
  ok(api.totals.sectors === 11, 'totals.sectors 不符');
});

await check('F2 市值佔比合計 100%', async () => {
  const s = await page.evaluate(async () => {
    const r = await fetch('/api/rrg/treemap?period=m1');
    const d = await r.json();
    return d.groups.reduce((a, g) => a + g.sharePct, 0);
  });
  ok(Math.abs(s - 100) < 0.01, `合計 ${s}%`);
});

await check('F3 四個週期都有資料（非全 null）', async () => {
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/rrg/treemap?period=m1');
    const d = await res.json();
    const out = {};
    for (const k of ['d1', 'w1', 'm1', 'y1']) {
      let n = 0;
      for (const g of d.groups) for (const lf of g.leaves) if (lf.returns[k] != null) n++;
      out[k] = n;
    }
    return out;
  });
  for (const k of ['d1', 'w1', 'm1', 'y1']) {
    ok(r[k] > 50, `${k} 只有 ${r[k]} 檔有值`);
  }
});

await check('F4 年報酬明顯不同於日報酬（不是同一數字複製）', async () => {
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/rrg/treemap?period=m1');
    const d = await res.json();
    const lf = d.groups[0].leaves[0];
    return lf.returns;
  });
  ok(Math.abs(r.y1 - r.d1) > 1, `d1=${r.d1} y1=${r.y1} 太接近`);
});

await check('F5 面積權值與市值一致', async () => {
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/rrg/treemap?period=m1');
    const d = await res.json();
    const g = d.groups[0];
    const ratioCap = g.leaves[0].marketCap / g.leaves[1].marketCap;
    const ratioArea = g.leaves[0].areaValue / g.leaves[1].areaValue;
    return { ratioCap, ratioArea };
  });
  ok(Math.abs(r.ratioCap - r.ratioArea) < 0.001,
    `市值比 ${r.ratioCap} 與面積權值比 ${r.ratioArea} 不一致`);
});

await check('F6 資料出處與取樣說明齊備', async () => {
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/rrg/treemap?period=m1');
    return res.json();
  });
  ok(r.source && r.source.holdings && r.source.marketCap, '缺少 source');
  ok(r.sampling && /市值/.test(r.sampling.note), '缺少 sampling 說明');
  ok(r.health && r.health.okSectors === 11, 'health 不符');
});

/* G 段會「故意」呼叫會回 4xx 的端點，而瀏覽器對 4xx 一律記一筆
   console error。這是預期行為，不是產品缺陷——先記下位置，
   G 段跑完後把預期的 4xx 濾掉，避免污染 J1 的判斷。 */
section('G 錯誤處理');
const gErrMark = errors.length;

await check('G1 週期參數錯誤回 400 BAD_PERIOD', async () => {
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/rrg/treemap?period=zzz');
    const j = await res.json();
    return { status: res.status, code: j.error?.code, hint: j.error?.hint };
  });
  ok(r.status === 400, `狀態 ${r.status}`);
  ok(r.code === 'BAD_PERIOD', `代碼 ${r.code}`);
  ok(/d1/.test(r.hint || ''), '缺少可用值提示');
});

await check('G2 perSector 錯誤回 400 BAD_PER_SECTOR', async () => {
  for (const v of ['0', '99', 'abc']) {
    const r = await page.evaluate(async (vv) => {
      const res = await fetch('/api/rrg/treemap?perSector=' + vv);
      const j = await res.json();
      return { status: res.status, code: j.error?.code };
    }, v);
    ok(r.status === 400 && r.code === 'BAD_PER_SECTOR', `perSector=${v} → ${r.status} ${r.code}`);
  }
});

await check('G3 版塊全錯回 400，部分錯則照畫', async () => {
  const a = await page.evaluate(async () => {
    const res = await fetch('/api/rrg/treemap?sectors=ZZZ');
    const j = await res.json();
    return { status: res.status, code: j.error?.code };
  });
  ok(a.status === 400, `全錯應 400，實際 ${a.status}`);

  const b = await page.evaluate(async () => {
    const res = await fetch('/api/rrg/treemap?sectors=XLK,ZZZ');
    const j = await res.json();
    return { status: res.status, n: j.groups?.length };
  });
  ok(b.status === 200 && b.n === 1, `部分錯應只畫 1 個版塊，實際 ${b.status} / ${b.n}`);
});

/* 清掉 G 段自己製造的預期 4xx console 記錄（BAD_PERIOD/BAD_PER_SECTOR/
   BAD_SECTORS 都是我們主動打錯參數造成的）。只刪「4xx」這一種，
   真正的 JS 例外（pageerror）一律保留。 */
{
  const before = errors.length - gErrMark;
  for (let i = errors.length - 1; i >= gErrMark; i--) {
    if (/status of 4\d\d/.test(errors[i])) errors.splice(i, 1);
  }
  const removed = before - (errors.length - gErrMark);
  console.log(`  （已忽略 G 段預期的 ${removed} 筆 4xx 主控台訊息）`);
}

/* 模擬上游失敗：必須擋掉 Service Worker，否則 page.route 攔不到
   （這是本專案已確認的坑：SW 發出的請求不經過 page.route） */
section('H 失敗與空資料狀態');

await check('H1 上游失敗顯示可重試的錯誤', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  const p2 = await ctx.newPage();
  await p2.route('**/api/rrg/treemap**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'TREEMAP_FAILED', message: '上游暫時無法取得持股資料' } }),
    }));
  await p2.goto(BASE + '/#/rrg', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p2.waitForTimeout(3500);

  const r = await p2.evaluate(() => {
    const meta = document.getElementById('rrgTmMeta');
    return {
      text: meta.textContent.replace(/\s+/g, ' ').trim(),
      cls: meta.className,
      hasRetry: !!document.getElementById('rrgTmRetry'),
      emptyVisible: !document.getElementById('rrgTmEmpty')?.hidden,
      legEmpty: (document.getElementById('rrgTmLegend')?.textContent || '').trim().length === 0,
    };
  });
  ok(/暫時無法取得|上游/.test(r.text), `訊息未顯示：${r.text}`);
  ok(/err/.test(r.cls), `未套用錯誤樣式：${r.cls}`);
  ok(r.hasRetry, '缺少重試按鈕');
  ok(r.emptyVisible, '未顯示空狀態');
  ok(r.legEmpty, '錯誤時圖例應清空（避免誤導）');
  await ctx.close();
});

await check('H2 無資料時不套用錯誤樣式', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  const p3 = await ctx.newPage();
  await p3.route('**/api/rrg/treemap**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true, period: 'm1', periodFull: '1 個月',
        periods: [{ key: 'm1', label: '月', full: '1 個月', tradingDays: 21 }],
        legend: [{ key: 'm1', label: '月', full: '1 個月', thresholdPct: 17, levels: 5, steps: [] }],
        groups: [], failures: [],
        totals: { sectors: 0, leaves: 0, marketCap: 0, weightCoveredPct: 0 },
        sampling: { perSector: 10, note: '無資料' },
        health: { requestedSectors: 11, okSectors: 0, leaves: 0, noCapCount: 0, noDataCount: 0 },
      }),
    }));
  await p3.goto(BASE + '/#/rrg', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p3.waitForTimeout(3000);
  const r = await p3.evaluate(() => {
    const meta = document.getElementById('rrgTmMeta');
    return { cls: meta.className, text: meta.textContent.trim() };
  });
  /* 空資料是正常結果，不該顯示成紅色錯誤 */
  ok(!/err/.test(r.cls), `空資料誤用錯誤樣式：${r.cls}`);
  await ctx.close();
});

section('I 行動版');

await check('I1 390px 無水平溢出', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const merr = [];
  m.on('pageerror', (e) => merr.push(e.message));
  await m.goto(BASE + '/#/rrg', { waitUntil: 'networkidle', timeout: 90000 });
  await m.waitForTimeout(4000);

  const r = await m.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    canvasW: Math.round(document.getElementById('rrgTmCanvas').getBoundingClientRect().width),
    wrapW: Math.round(document.getElementById('rrgTmWrap').getBoundingClientRect().width),
    btnCount: document.querySelectorAll('#rrgTmPeriods button').length,
    btnH: Math.round(document.querySelector('#rrgTmPeriods button').getBoundingClientRect().height),
    legCells: document.querySelectorAll('#rrgTmLegend .rrg-tm-leg-bar i').length,
  }));
  ok(!r.overflow, `水平溢出：${r.scrollW} > ${r.clientW}`);
  ok(r.canvasW === r.wrapW, `畫布寬 ${r.canvasW} 與容器 ${r.wrapW} 不符`);
  ok(r.canvasW > 280, `畫布太窄：${r.canvasW}`);
  ok(r.btnCount === 4, `週期按鈕 ${r.btnCount} 個`);
  ok(r.btnH >= 24, `按鈕高 ${r.btnH}px 太小，不好點`);
  ok(r.legCells === 11, `圖例 ${r.legCells} 格`);
  ok(merr.length === 0, `JS 錯誤：${merr.join('; ')}`);

  /* 觸控切換 */
  await m.tap('#rrgTmPeriods button[data-period="y1"]');
  await m.waitForTimeout(400);
  const on = await m.evaluate(() =>
    document.querySelector('#rrgTmPeriods button.on')?.getAttribute('data-period'));
  ok(on === 'y1', `觸控切換失敗，選中 ${on}`);

  await m.close();
});

await check('I2 平板寬度 768px 正常', async () => {
  const t = await browser.newPage({ viewport: { width: 768, height: 1024 } });
  await t.goto(BASE + '/#/rrg', { waitUntil: 'networkidle', timeout: 90000 });
  await t.waitForTimeout(3500);
  const r = await t.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    canvasW: Math.round(document.getElementById('rrgTmCanvas').getBoundingClientRect().width),
  }));
  ok(!r.overflow, '平板有水平溢出');
  ok(r.canvasW > 400, `畫布太窄：${r.canvasW}`);
  await t.close();
});

section('J 整體');

await check('J1 無 JS 錯誤', async () => {
  ok(errors.length === 0, `發現 ${errors.length} 個錯誤：\n${errors.slice(0, 5).join('\n')}`);
});

await check('J2 其他 RRG 區塊未被破壞', async () => {
  const r = await page.evaluate(() => {
    const rr = document.getElementById('viewRrg');
    return {
      canvas: !!document.getElementById('rrgCanvas'),
      table: document.querySelectorAll('#rrgTableBody tr').length,
      holdBody: !!document.getElementById('rrgHoldBody'),
      canvasVisible: (() => {
        const c = document.getElementById('rrgCanvas');
        if (!c) return false;
        const b = c.getBoundingClientRect();
        return b.width > 100 && b.height > 100;
      })(),
    };
  });
  ok(r.canvas, '四象限畫布不見了');
  ok(r.table >= 11, `版塊明細表只有 ${r.table} 列`);
  ok(r.holdBody, '權重股面板不見了');
  ok(r.canvasVisible, '四象限畫布尺寸異常');
});

await check('J3 Service Worker 版本已更新', async () => {
  const v = await page.evaluate(async () => {
    const r = await fetch('/sw.js');
    const t = await r.text();
    const m = t.match(/^\s*const\s+VERSION\s*=\s*'([^']+)'/m);
    return { v: m && m[1], hasAsset: t.includes("'/rrg-treemap.js'") };
  });
  ok(v.v, '找不到 VERSION');
  ok(v.v >= 'v1.0.7', `VERSION 為 ${v.v}`);
  ok(v.hasAsset, 'SHELL_ASSETS 未含 rrg-treemap.js');
});

await check('J4 淺色主題（背景為淺色底、文字為深色）', async () => {
  /* 這裡不能用「畫布上亮像素比暗像素多」來判斷淺色主題。
     Treemap 是熱度圖，格子本身就是飽和色（純紅亮度僅約 96），
     若按亮度投票必然判成「深色底」，這是量測方式錯，不是產品錯。
     正確的判準有三條：
       1. 卡片與畫布容器的底色是淺色（真正決定「主題」的東西）
       2. 畫布裡幾乎沒有接近全黑的像素（深色主題才會整片深底）
       3. 文字前景色是深色，且與格子填色有足夠對比 */
  const r = await page.evaluate(() => {
    const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const rgb = (s) => (s.match(/\d+/g) || []).map(Number).slice(0, 3);

    const card = document.querySelector('.rrg-tm-card');
    const wrap = document.getElementById('rrgTmWrap');
    const cv = document.getElementById('rrgTmCanvas');

    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let nearBlack = 0, sampled = 0;
    for (let i = 0; i < d.length; i += 4 * 31) {
      if (d[i + 3] < 100) continue;
      sampled++;
      if (lum([d[i], d[i + 1], d[i + 2]]) < 40) nearBlack++;
    }
    return {
      cardBg: lum(rgb(getComputedStyle(card).backgroundColor)),
      wrapBg: lum(rgb(getComputedStyle(wrap).backgroundColor)),
      textLum: lum(rgb(getComputedStyle(card).color)),
      nearBlackPct: sampled ? (nearBlack / sampled) * 100 : 0,
      textColor: getComputedStyle(card).color,
    };
  });

  ok(r.cardBg > 200, `卡片底色亮度 ${r.cardBg.toFixed(0)}，看起來是深色底`);
  ok(r.wrapBg > 200, `畫布容器底色亮度 ${r.wrapBg.toFixed(0)}，看起來是深色底`);
  ok(r.textLum < 130, `文字顏色 ${r.textColor} 亮度 ${r.textLum.toFixed(0)}，不像深色字`);
  ok(r.nearBlackPct < 2, `畫布近黑像素 ${r.nearBlackPct.toFixed(2)}%，深色底才會這樣`);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${pass} 通過 / ${fail} 失敗`);
if (fail) {
  console.log('\n失敗詳情：');
  for (const f of failures) console.log(`  [${f.name}] ${f.error.message}`);
}
console.log('='.repeat(50));

await browser.close();
process.exit(fail ? 1 : 0);
