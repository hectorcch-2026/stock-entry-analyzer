/**
 * 新聞與 AI 分析（個股頁）＋ 版塊輪動 × 宏觀（RRG 頁）— E2E 測試
 * =================================================================
 * 執行：
 *   node tests/e2e-news-ai.mjs                        # 本機（預設 5177，與 test:all 其他 e2e 一致）
 *   BASE=https://xxx node tests/e2e-news-ai.mjs       # 線上（上線驗證必跑）
 *
 * 前置：需要先有一個跑著的伺服器（npm start）。
 *   本檔不會自己 spawn —— 與 e2e-layout / e2e-pwa 等既有 E2E 慣例一致。
 *
 * 為什麼單元測試不夠（這一輪實際踩到的坑）：
 *   1. 前端讀了後端根本不存在的欄位（publisherTier / publishedAt /
 *      description），單元測試照著同一份錯誤假設寫，兩邊一起錯。
 *      只有真的把畫面渲染出來、數 T1 徽章才會發現「全部變 T3」。
 *   2. 情緒量表在分數缺席時畫了一條 0 分的指針，看起來像「中性」。
 *   3. 排名第 9 卻標「領先」——文案矛盾，只有讀畫面文字才看得出來。
 *   4. 行動版因子名稱把卡片撐破（grid min-width:auto 的老問題）。
 *   5. 卡片「有內容」但整塊是空的（轉圈卡死、body 沒解 hidden）。
 *
 * 因此本檔的原則是：**只相信畫面上的字與像素**，不讀原始碼、不讀 API 契約。
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5177';
const SYMBOL = process.env.SYMBOL || 'AAPL';

let pass = 0;
let fail = 0;
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
   共用：等卡片「真的畫完」
   ------------------------------------------------------------ */
async function waitCardSettled(page, prefix, timeoutMs = 75000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await page.evaluate((p) => {
      const loading = document.getElementById(p + 'Loading');
      const body = document.getElementById(p + 'Body');
      const empty = document.getElementById(p + 'Empty');
      const visible = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
      return {
        loading: visible(loading),
        body: visible(body),
        empty: visible(empty),
        bodyLen: body ? body.textContent.replace(/\s+/g, '').length : 0,
      };
    }, prefix);
    if (!s.loading && ((s.body && s.bodyLen > 40) || s.empty)) return s;
    await page.waitForTimeout(500);
  }
  throw new Error(`#${prefix} 在 ${timeoutMs}ms 內沒有結束載入（一直轉圈）`);
}

/* ------------------------------------------------------------
   桌面版：個股頁「新聞與 AI 分析」
   ------------------------------------------------------------ */
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

section('A 個股頁：區塊存在且畫得出來');

await page.goto(BASE + '/#/detail/' + encodeURIComponent(SYMBOL), { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(6000);

/* 必須先切到「新聞」分頁。
   個股頁在 v1.5 改為 4 個子分頁後，新聞卡位於預設隱藏的 panel-news 裡；
   不切過去時，卡片雖然「存在且有內容」，但 getBoundingClientRect 是 0×0，
   於是 A2／C1 這種量尺寸的檢查會全部失敗。
   這不是測試取巧——使用者真實路徑就是先點分頁，才看得到這張卡。 */
async function goNewsTab(pg) {
  const tab = await pg.$('#tab-news');
  if (!tab) throw new Error('找不到 #tab-news（子分頁結構可能被改壞）');
  await tab.click();
  await pg.waitForTimeout(600);
}
await goNewsTab(page);

await check('A1 卡片存在、可見、且沒有卡在載入中', async () => {
  const s = await waitCardSettled(page, 'newsAi');
  ok(s.body, '主體未顯示（可能一直停在載入中）');
  ok(s.empty === false, '落到了空狀態，這是失敗而不是成功');
});

await check('A2 卡片有實際高度與寬度（不是 0×0 隱形區塊）', async () => {
  const r = await page.evaluate(() => {
    const c = document.getElementById('newsAiCard');
    const b = c.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height) };
  });
  ok(r.w > 500, `卡片寬只有 ${r.w}px`);
  ok(r.h > 400, `卡片高只有 ${r.h}px（內容可能沒渲染）`);
});

await check('A3 卡片位於個股頁的合理位置（在進階區塊之後）', async () => {
  const r = await page.evaluate(() => {
    const card = document.getElementById('newsAiCard');
    const result = document.getElementById('result');
    // 不能只比「上一個兄弟」，因為中間可能插入其他卡片
    // （例如個股財報由宏觀模塊搬來後就排在兩者之間）。
    // 正確的做法是比文件順序：進階區塊在前、新聞卡在後。
    const adv = result ? result.querySelector('.adv-section') : null;
    const pos = (a, b) => (a && b)
      ? (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before')
      : null;
    return {
      inResult: !!result && result.contains(card),
      visible: !card.hidden && getComputedStyle(card).display !== 'none',
      advBeforeNews: adv ? pos(adv, card) : null,
      hasFinSibling: !!document.getElementById('stockFinCard'),
    };
  });
  ok(r.inResult, '不在 #result 內（個股頁容器）');
  ok(r.visible, '卡片被隱藏');
  ok(r.advBeforeNews === 'after',
    `新聞卡應排在進階分析之後，實際在 ${r.advBeforeNews}`);
});

section('B 新聞清單：欄位真的對上了嗎');

await check('B1 新聞清單至少 1 則', async () => {
  const n = await page.evaluate(() =>
    document.querySelectorAll('#newsAiList li').length);
  ok(n >= 1, `清單只有 ${n} 則`);
});

await check('B2 每則都有標題、媒體名、時間（不得空白）', async () => {
  const r = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#newsAiList li'));
    return rows.map((li) => ({
      title: (li.querySelector('.news-ai-item-title')?.textContent || '').trim(),
      pub: (li.querySelector('.news-ai-item-pub')?.textContent || '').trim(),
      when: (li.querySelector('.news-ai-item-time')?.textContent || '').trim(),
      text: li.textContent.replace(/\s+/g, ''),
    })).filter((x) => x.text.length > 10);
  });
  ok(r.length >= 1, '沒有可判讀的清單列');
  for (const it of r) {
    ok(it.title.length > 3, `標題空白或太短：${JSON.stringify(it)}`);
    ok(it.pub.length > 1, `媒體名空白：${it.title.slice(0, 20)}`);
    ok(it.when.length > 1, `時間空白（前端可能讀錯欄位）：${it.title.slice(0, 20)}`);
  }
});

await check('B3 媒體分級徽章不是全部退化成 T3', async () => {
  // 這段刻意同時驗「文字」與「CSS class」。
  // 只驗文字會漏掉一個真實缺陷：徽章文字由 it.tierShort 撐住（顯示 T1），
  // 但顏色 class 用的是階梯欄位算出的 t → 全部掛成 t3（灰）。
  // 使用者看到「T1 一線媒體」卻是灰色徽章，顏色與語義脫節。
  const r = await page.evaluate(() => {
    const marks = Array.from(document.querySelectorAll('#newsAiList .tier-badge'))
      .map((b) => ({
        text: (b.textContent || '').trim(),
        cls: b.className,
        color: getComputedStyle(b).color,
      }));
    const dist = {};
    for (const m of marks) dist[m.text] = (dist[m.text] || 0) + 1;
    return { marks, dist };
  });
  ok(r.marks.length >= 1, '一個分級徽章都沒有（前端讀錯 tier 欄位）');
  const uniq = Object.keys(r.dist);
  ok(uniq.length >= 2,
    `分級只有 ${JSON.stringify(r.dist)} 一種 —— 典型的「全部退化成 T3」缺陷`);
  ok((r.dist.T1 || 0) >= 1, `沒有任何 T1 一線媒體：${JSON.stringify(r.dist)}`);

  // 文字分級與樣式分級必須一致
  for (const m of r.marks) {
    const shown = (m.text.match(/T(\d)/) || [])[1];
    const styled = (m.cls.match(/\bt(\d)\b/) || [])[1];
    ok(shown, `徽章文字沒有分級：${m.text}`);
    ok(shown === styled,
      `徽章顯示 ${m.text} 但樣式 class 是 ${m.cls}（顏色會與分級脫節）`);
  }
  // 不同分級應有不同顏色，否則分級形同虛設
  const colorOf = {};
  for (const m of r.marks) colorOf[(m.text.match(/T(\d)/) || [])[1]] = m.color;
  const colors = Object.values(colorOf);
  ok(new Set(colors).size >= 2,
    `不同分級的顏色完全相同（${JSON.stringify(colorOf)}），分級沒有視覺區分`);
});

await check('B4 至少一則有摘要（excerpt 有渲染）', async () => {
  const n = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#newsAiList .news-ai-item-desc'))
      .filter((p) => (p.textContent || '').trim().length > 10).length);
  ok(n >= 1, '所有摘要都是空的（前端可能讀 it.description 而非 it.excerpt）');
});

await check('B5 清單顯示張數與時間範圍', async () => {
  const t = await page.evaluate(() =>
    (document.getElementById('newsAiListHint')?.textContent || '').replace(/\s+/g, ' ').trim());
  ok(/共\s*\d+\s*則/.test(t), `未顯示則數：${t}`);
  ok(/\d{2}-\d{2}/.test(t), `未顯示時間範圍：${t}`);
});

section('C 情緒量表與研判');

await check('C1 情緒量表有畫出 SVG（不是空白容器）', async () => {
  const r = await page.evaluate(() => {
    const g = document.getElementById('newsAiGauge');
    const svg = g.querySelector('svg');
    const b = g.getBoundingClientRect();
    return {
      hasSvg: !!svg,
      paths: svg ? svg.querySelectorAll('path').length : 0,
      w: Math.round(b.width), h: Math.round(b.height),
    };
  });
  ok(r.hasSvg, '沒有 SVG');
  ok(r.paths >= 3, `只有 ${r.paths} 段弧線（應有負/中性/正三段底色）`);
  ok(r.w > 100 && r.h > 60, `量表尺寸 ${r.w}×${r.h} 太小`);
});

await check('C2 有分數時指針存在；無分數時明確寫「無情緒評分」', async () => {
  const r = await page.evaluate(() => {
    const g = document.getElementById('newsAiGauge');
    const svg = g.querySelector('svg');
    const score = (document.getElementById('newsAiScore')?.textContent || '').trim();
    return {
      line: svg.querySelectorAll('line').length,
      text: svg.textContent,
      score,
    };
  });
  if (r.score === '—') {
    ok(/無情緒評分/.test(r.text), '分數缺席時量表是空白的，會被誤讀成 0 分');
    ok(r.line === 0, '分數缺席卻畫了指針（假裝有值）');
  } else {
    ok(/^[+-]?\d+\.\d{2}$/.test(r.score), `分數格式異常：${r.score}`);
    ok(r.line >= 1, '有分數卻沒有指針');
  }
});

await check('C3 情緒文字標籤齊備（不可只有顏色）', async () => {
  const r = await page.evaluate(() => ({
    senti: (document.getElementById('newsAiSentiment')?.textContent || '').trim(),
    cls: document.getElementById('newsAiScore')?.className || '',
  }));
  ok(/偏多|偏空|中性|多空分歧/.test(r.senti), `情緒標籤異常：${r.senti}`);
  ok(/s-(pos|neg|neu|mix)/.test(r.cls), `情緒色 class 未掛上：${r.cls}`);
});

await check('C4 情緒色不得用漲跌紅綠（語義分離）', async () => {
  // 漲跌色：--up #d92b2b / --down #0f9d58
  const c = await page.evaluate(() =>
    getComputedStyle(document.getElementById('newsAiScore')).color);
  const rgb = (c.match(/\d+/g) || []).map(Number);
  const isUpRed = Math.abs(rgb[0] - 217) < 24 && Math.abs(rgb[1] - 43) < 24;
  const isDownGreen = Math.abs(rgb[1] - 157) < 24 && Math.abs(rgb[0] - 15) < 30;
  ok(!isUpRed, `情緒色用了漲紅 ${c}，會被誤讀成股價上漲`);
  ok(!isDownGreen, `情緒色用了跌綠 ${c}，會被誤讀成股價下跌`);
});

await check('C5 摘要與關鍵事件有內容', async () => {
  const r = await page.evaluate(() => ({
    summary: (document.getElementById('newsAiSummary')?.textContent || '').trim(),
    events: Array.from(document.querySelectorAll('#newsAiEvents li'))
      .map((x) => x.textContent.trim()).filter((x) => x.length > 4),
  }));
  ok(r.summary.length > 10, `摘要太短：${r.summary}`);
  ok(r.events.length >= 1, '沒有任何關鍵事件');
  ok(r.events.length <= 4, `關鍵事件 ${r.events.length} 個（契約上限 4）`);
});

await check('C6 對股價的潛在影響有方向／幅度／是否已反映', async () => {
  const r = await page.evaluate(() => ({
    dir: (document.getElementById('newsAiImpactDir')?.textContent || '').trim(),
    mag: (document.getElementById('newsAiImpactMag')?.textContent || '').trim(),
    priced: (document.getElementById('newsAiImpactPriced')?.textContent || '').trim(),
    text: (document.getElementById('newsAiImpactText')?.textContent || '').trim(),
  }));
  ok(r.dir.length > 1, '缺少影響方向');
  ok(r.mag.length > 1, '缺少影響幅度');
  ok(r.priced.length > 1, '缺少「是否已反映」');
  ok(r.text.length > 10, `影響說明太短：${r.text}`);
});

await check('C7 研判依據有權重且合計約 100%', async () => {
  const r = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#newsAiDrivers .news-ai-drv'));
    return rows.map((d) => ({
      name: (d.querySelector('.news-ai-drv-name')?.textContent || '').trim(),
      w: (d.querySelector('.news-ai-drv-w')?.textContent || '').trim(),
      barW: d.querySelector('.news-ai-drv-bar i')?.style.width || '',
    }));
  });
  ok(r.length >= 2, `只有 ${r.length} 個因子`);
  let sum = 0;
  for (const x of r) {
    ok(x.name.length > 0, '因子名空白');
    const v = parseInt(x.w, 10);
    ok(isFinite(v), `權重無法解析：${x.w}`);
    ok(x.barW, '權重條沒有寬度');
    sum += v;
  }
  ok(sum >= 95 && sum <= 105, `權重合計 ${sum}%（應約 100%）`);
});

await check('C8 版塊標籤（能取得時）或明確說明取不到', async () => {
  const r = await page.evaluate(() => {
    const tags = (document.getElementById('newsAiTags')?.textContent || '').replace(/\s+/g, ' ');
    const note = (document.getElementById('newsAiNote')?.textContent || '');
    return { tags, note };
  });
  const hasTag = /領先|落後|改善|弱化/.test(r.tags);
  const hasCaveat = /版塊|未取得/.test(r.note);
  ok(hasTag || hasCaveat,
    `既沒有版塊標籤也沒有說明原因（靜默缺失）：tags=${r.tags.slice(0, 60)}`);
});

section('D2 關鍵字／觀點＋依據／結構化匯報（需求 1–3）');

await check('D2a 關鍵字區塊有標籤、權重條與主題分組', async () => {
  const r = await page.evaluate(() => {
    const block = document.getElementById('newsAiKwBlock');
    const chips = [...document.querySelectorAll('.news-ai-kw')];
    return {
      visible: !!block && !block.hidden,
      chips: chips.length,
      /* 每個 chip 必須同時有標籤文字、類別、以及寬度 > 0 的權重條——
         只有文字沒有條＝強度資訊消失，只有條沒有文字＝看不懂在比什麼 */
      wellFormed: chips.filter((c) => {
        const label = c.querySelector('.news-ai-kw-label');
        const bar = c.querySelector('.news-ai-kw-bar > i');
        const cat = c.querySelector('.news-ai-kw-cat');
        if (!label || !label.textContent.trim()) return false;
        if (!bar || bar.getBoundingClientRect().width <= 0) return false;
        if (!cat || !cat.textContent.trim()) return false;
        return true;
      }).length,
      topics: document.querySelectorAll('.news-ai-topic-row').length,
      line: (document.getElementById('newsAiKwLine')?.textContent || '').trim(),
    };
  });
  ok(r.visible, '關鍵字區塊未顯示');
  ok(r.chips >= 2, `關鍵字只有 ${r.chips} 個，太少`);
  ok(r.wellFormed === r.chips,
    `有 ${r.chips - r.wellFormed} 個關鍵字缺少標籤／權重條／類別`);
  ok(r.topics >= 1, '沒有主題分組列');
  ok(r.line.length > 0 && r.line !== '—', '缺少一句話主題摘要');
});

await check('D2b 權重條寬度必須與權重成正比（不是全部同寬）', async () => {
  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('.news-ai-kw-bar > i')]
      .map((b) => Math.round(b.getBoundingClientRect().width)));
  const uniq = [...new Set(widths)];
  ok(widths.length >= 3, `權重條只有 ${widths.length} 條，無法比較`);
  /* 全部同寬代表寬度沒綁到 weight，強度資訊等於沒有 */
  ok(uniq.length >= 2,
    `所有權重條寬度都一樣（${uniq.join(',')}），權重沒有生效`);
});

await check('D2c 每條觀點都有關鍵字、方向、以及至少 1 條引文（需求 2）', async () => {
  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.news-ai-vp')];
    return {
      count: cards.length,
      broken: cards.filter((c) => {
        const kw = c.querySelector('.news-ai-vp-kw');
        const dir = c.querySelector('.news-ai-vp-dir');
        const claim = c.querySelector('.news-ai-vp-claim');
        const quotes = c.querySelectorAll('.news-ai-vp-quote');
        return !kw || !kw.textContent.trim()
          || !dir || !dir.textContent.trim()
          || !claim || !claim.textContent.trim()
          || quotes.length === 0;
      }).length,
      /* 引文必須有實際長度，不能是空字串或只剩引號 */
      emptyQuotes: [...document.querySelectorAll('.news-ai-vp-quote')]
        .filter((q) => q.textContent.replace(/[「」\s]/g, '').length < 10).length,
    };
  });
  ok(r.count >= 1, '沒有任何觀點卡');
  ok(r.broken === 0, `有 ${r.broken} 條觀點缺少關鍵字／方向／引文`);
  ok(r.emptyQuotes === 0, `有 ${r.emptyQuotes} 條引文是空的`);
});

await check('D2d 每條引文的編號都可點回原文，且編號與清單對得上', async () => {
  const r = await page.evaluate(() => {
    const idxs = [...document.querySelectorAll('.news-ai-vp-ev-idx a')]
      .map((a) => ({ n: a.textContent.trim(), href: a.getAttribute('href') || '' }));
    const listCount = document.querySelectorAll('#newsAiList > li').length;
    return {
      total: idxs.length,
      bad: idxs.filter((x) => !/^#\d+$/.test(x.n) || !/^https?:/.test(x.href)).length,
      over: idxs.filter((x) => parseInt(x.n.replace('#', ''), 10) > listCount).length,
      listCount,
    };
  });
  ok(r.total >= 1, '沒有任何可追溯的引文編號');
  ok(r.bad === 0, `有 ${r.bad} 條引文的編號或連結格式不對`);
  ok(r.over === 0,
    `有 ${r.over} 條引文指向不存在的新聞（清單只有 ${r.listCount} 則）`);
});

await check('D2e 匯報必須含四個區段標題與來源連結', async () => {
  const r = await page.evaluate(() => {
    const block = document.getElementById('newsAiReportBlock');
    const txt = (document.getElementById('newsAiReport')?.textContent || '').replace(/\s+/g, '');
    return {
      visible: !!block && !block.hidden,
      txt,
      secs: document.querySelectorAll('.news-ai-rep-sec').length,
      srcLinks: [...document.querySelectorAll('.news-ai-rep-src li a')]
        .filter((a) => /^https?:/.test(a.getAttribute('href') || '')).length,
    };
  });
  ok(r.visible, '匯報區塊未顯示');
  for (const h of ['新聞摘要', '關鍵字', '相關觀點', '資料來源']) {
    ok(r.txt.includes(h), `匯報缺少「${h}」區段`);
  }
  ok(r.secs >= 4, `匯報只有 ${r.secs} 個區段`);
  ok(r.srcLinks >= 1, '匯報的資料來源沒有可點的原始連結（不可追溯）');
});

await check('D2f 匯報純文字可複製，且含真正的內容（不是空字串）', async () => {
  const t = await page.evaluate(() =>
    (document.getElementById('newsAiCopyReport')?.getAttribute('data-report-text') || ''));
  ok(t.length > 200, `可複製的純文字只有 ${t.length} 字，太短`);
  for (const h of ['一、新聞摘要', '二、關鍵字', '三、相關觀點', '四、資料來源']) {
    ok(t.includes(h), `純文字匯報缺少「${h}」`);
  }
  /* 必須真的引用到新聞，而不是只有標題框架 */
  ok(/依據 #\d+/.test(t), '純文字匯報沒有引用任何新聞依據');
});

section('D 來源與時間標註（需求明確要求）');
await check('D1 六個必要標註欄位都在畫面上', async () => {
  const t = await page.evaluate(() =>
    (document.getElementById('newsAiProv')?.textContent || '').replace(/\s+/g, ' '));
  for (const k of ['新聞時間範圍', '價格資料', '新聞來源', '媒體分佈', '分析方法', '產生時間']) {
    ok(t.includes(k), `缺少「${k}」`);
  }
});

await check('D2 標註裡有真實的時間與數字（不是佔位符）', async () => {
  const t = await page.evaluate(() =>
    (document.getElementById('newsAiProv')?.textContent || '').replace(/\s+/g, ' '));
  ok(/\d{2}-\d{2}\s*\d{2}:\d{2}/.test(t), `時間戳格式異常：${t.slice(0, 120)}`);
  ok(/近\s*\d+\s*天/.test(t), `缺少時間窗天數：${t.slice(0, 120)}`);
  ok(/×\d+/.test(t), `媒體分佈缺少則數：${t.slice(0, 120)}`);
  ok(!/\bundefined\b|\bNaN\b/.test(t), '標註出現 undefined / NaN');
});

section('E 版塊輪動 × 宏觀（RRG 頁）');

const rrg = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const rrgErrors = [];
rrg.on('pageerror', (e) => rrgErrors.push('pageerror: ' + e.message));
rrg.on('console', (m) => { if (m.type() === 'error') rrgErrors.push('console: ' + m.text()); });

await rrg.goto(BASE + '/#/rrg', { waitUntil: 'domcontentloaded', timeout: 90000 });
await rrg.waitForTimeout(7000);

await check('E1 宏觀卡片存在且畫完', async () => {
  const s = await waitCardSettled(rrg, 'macroAi');
  ok(s.body, '主體未顯示');
  ok(s.empty === false, '落到空狀態（RRG 有資料時不該如此）');
});

await check('E2 版塊強弱排名 11 筆、名次連續 1..11', async () => {
  const r = await rrg.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#macroAiRank .macro-ai-rank-row'));
    return rows.map((x) => ({
      no: (x.querySelector('.macro-ai-rank-no')?.textContent || '').trim(),
      name: (x.querySelector('.macro-ai-rank-name')?.textContent || '').trim(),
      score: (x.querySelector('.macro-ai-rank-score')?.textContent || '').trim(),
      quad: (x.querySelector('.macro-ai-rank-quad')?.textContent || '').trim(),
      flow: (x.querySelector('.macro-ai-rank-flow')?.textContent || '').trim(),
      barW: x.querySelector('.macro-ai-rank-bar i')?.style.width || '',
    }));
  });
  ok(r.length === 11, `排名只有 ${r.length} 筆（應 11 個版塊）`);
  r.forEach((x, i) => {
    ok(x.no === String(i + 1), `第 ${i + 1} 列名次為 ${x.no}`);
    ok(x.name.length > 0, `第 ${i + 1} 列版塊名空白`);
    ok(/^[\d.]+$/.test(x.score), `分數無法解析：${x.score}`);
    ok(/領先|落後|改善|弱化/.test(x.quad), `象限文字異常：${x.quad}`);
    ok(/流入|流出|中性/.test(x.flow), `資金流向文字異常：${x.flow}`);
    ok(x.barW, '強弱條沒有寬度');
  });
});

await check('E3 強弱分數遞減（排名真的照分數排）', async () => {
  const sc = await rrg.evaluate(() =>
    Array.from(document.querySelectorAll('#macroAiRank .macro-ai-rank-score'))
      .map((x) => parseFloat(x.textContent)));
  for (let i = 1; i < sc.length; i++) {
    ok(sc[i] <= sc[i - 1] + 0.05,
      `第 ${i + 1} 名分數 ${sc[i]} 高於第 ${i} 名 ${sc[i - 1]}，排序錯誤`);
  }
  ok(sc[0] > sc[sc.length - 1], '首末名分數相同，排名沒有區分度');
});

await check('E4 排名條寬度與分數成正比（0 分也要有可見寬度）', async () => {
  const r = await rrg.evaluate(() =>
    Array.from(document.querySelectorAll('#macroAiRank .macro-ai-rank-row')).map((x) => ({
      score: parseFloat(x.querySelector('.macro-ai-rank-score').textContent),
      w: parseFloat(x.querySelector('.macro-ai-rank-bar i').style.width),
    })));
  for (const x of r) {
    ok(Math.abs(x.w - x.score) < 1.5,
      `分數 ${x.score} 但條寬 ${x.w}%`);
  }
  // 0 分的條若寬度為 0px 會看起來像渲染失敗
  const zeroPx = await rrg.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#macroAiRank .macro-ai-rank-row'))
      .filter((x) => parseFloat(x.querySelector('.macro-ai-rank-score').textContent) === 0);
    if (!rows.length) return null;
    return Math.round(rows[0].querySelector('.macro-ai-rank-bar i').getBoundingClientRect().width);
  });
  if (zeroPx != null) {
    ok(zeroPx >= 2, `0 分版塊的條寬只有 ${zeroPx}px，看起來像壞掉`);
  }
});

await check('E5 排名與象限落差時有解釋文字（不可自相矛盾）', async () => {
  // 這是本功能的已知陷阱：11 個版塊常有 9 個高於基準，
  // 於是「第 9 名 + 領先象限」會同時出現。若不解釋就是自相矛盾。
  const r = await rrg.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#macroAiRank .macro-ai-rank-row'));
    const notes = Array.from(document.querySelectorAll('#macroAiRank .macro-ai-rank-note'))
      .map((x) => x.textContent.trim());
    const foot = (document.querySelector('#macroAiRank .macro-ai-rank-foot')?.textContent || '')
      .replace(/\s+/g, ' ');
    const conflict = rows.filter((x) => {
      const quad = (x.querySelector('.macro-ai-rank-quad')?.textContent || '').trim();
      const no = parseInt((x.querySelector('.macro-ai-rank-no')?.textContent || '0'), 10);
      const isPos = /領先|改善/.test(quad);
      return isPos && no > 6;
    }).length;
    return { conflict, notes, foot };
  });
  ok(r.foot.includes('基準線'), '缺少「兩把尺」的整體說明');
  ok(/相對位置|第 1 名 100 分/.test(r.foot), '未說明分數是同期相對位置');
  if (r.conflict > 0) {
    ok(r.notes.length >= 1,
      `有 ${r.conflict} 個「正象限但排名後段」的版塊卻沒有任何解釋`);
    ok(r.notes.some((n) => /贏過大盤|輸給|貼線|基準/.test(n)),
      `落差說明沒有講清楚基準與排名的差別：${r.notes.join(' | ').slice(0, 120)}`);
  }
});

await check('E6 宏觀指標關聯卡 8 筆，且每筆標明可用性', async () => {
  const r = await rrg.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#macroAiLinks .macro-ai-link'));
    return cards.map((c) => ({
      text: c.textContent.replace(/\s+/g, ' ').trim(),
      unavailable: !!c.querySelector('.macro-ai-link-un'),
      hasThesis: (c.querySelector('.macro-ai-link-thesis')?.textContent || '').trim().length > 10,
    }));
  });
  ok(r.length === 8, `宏觀指標只有 ${r.length} 筆（應 8）`);
  for (const c of r) {
    ok(c.text.length > 8, '指標卡是空的');
    if (c.unavailable) {
      ok(/不可用|無資料|未取得/.test(c.text), `標為不可用卻沒說原因：${c.text.slice(0, 60)}`);
    } else {
      ok(c.hasThesis, `可用指標缺少理論說明：${c.text.slice(0, 60)}`);
    }
  }
});

await check('E7 宏觀關聯文字必須引用具體數字（不可教科書空話）', async () => {
  const r = await rrg.evaluate(() =>
    Array.from(document.querySelectorAll('#macroAiLinks .macro-ai-link'))
      .filter((c) => !c.querySelector('.macro-ai-link-un'))
      .map((c) => (c.querySelector('.macro-ai-link-thesis')?.textContent || '').trim()));
  ok(r.length >= 4, `可用指標太少（${r.length}），無法驗證`);
  const withNum = r.filter((t) => /\d/.test(t)).length;
  ok(withNum === r.length,
    `${r.length - withNum}/${r.length} 筆說明沒有引用任何數字（教科書文字）`);
});

await check('E8 一致性判定有結論與依據說明', async () => {
  const r = await rrg.evaluate(() => ({
    verdict: (document.querySelector('#macroAiConsistency .macro-ai-cons-verdict')?.textContent || '').trim(),
    basis: (document.querySelector('#macroAiConsistency .macro-ai-cons-basis')?.textContent || '').trim(),
    note: (document.querySelector('#macroAiConsistency .macro-ai-cons-note')?.textContent || '').trim(),
  }));
  ok(/互相印證|出現背離|難以判定/.test(r.verdict), `判定文字異常：${r.verdict}`);
  ok(/規則層|AI/.test(r.basis), `未標明判定來源：${r.basis}`);
  ok(r.note.length > 10, `判定說明太短：${r.note}`);
});

await check('E9 輪動敘述有內容且不是通用套話', async () => {
  const t = await rrg.evaluate(() =>
    (document.getElementById('macroAiNarrative')?.textContent || '').trim());
  ok(t.length > 40, `敘述只有 ${t.length} 字`);
  ok(/\d/.test(t), '敘述完全沒有數字，可能是通用套話');
  ok(/版塊|輪動|資金|強弱/.test(t), '敘述沒有談到版塊輪動');
});

await check('E10 觀察重點有清單', async () => {
  const n = await rrg.evaluate(() =>
    Array.from(document.querySelectorAll('#macroAiWatch li'))
      .filter((x) => x.textContent.trim().length > 6).length);
  ok(n >= 1, '沒有觀察重點');
});

await check('E11 來源與時間標註齊備', async () => {
  const t = await rrg.evaluate(() =>
    (document.getElementById('macroAiProv')?.textContent || '').replace(/\s+/g, ' '));
  for (const k of ['輪動資料', '宏觀數據', '資料來源', '產生時間']) {
    ok(t.includes(k), `缺少「${k}」`);
  }
  ok(/\d+\/\d+\s*項可用/.test(t), `宏觀可用數未標示：${t.slice(0, 140)}`);
  ok(/\d{2}-\d{2}/.test(t), `缺少日期：${t.slice(0, 140)}`);
  ok(!/\bundefined\b|\bNaN\b/.test(t), '標註出現 undefined / NaN');
});

await check('E12 排名用的時間框架與 RRG 圖一致（不可各講各的）', async () => {
  const r = await rrg.evaluate(() => {
    const sel = document.getElementById('rrgTimeframe');
    const prov = (document.getElementById('macroAiProv')?.textContent || '');
    return { sel: sel ? sel.value : null, prov };
  });
  ok(r.sel, '找不到 RRG 時間框架控制項');
  // 週線 → 「週」；日線 → 「日」
  const map = { daily: '日', weekly: '週', monthly: '月' };
  const cn = map[r.sel];
  if (cn) {
    ok(r.prov.includes(cn) || /週|日|月/.test(r.prov),
      `RRG 選 ${r.sel} 但標註沒提時間框架：${r.prov.slice(0, 100)}`);
  }
});

section('F 回歸：不得破壞既有區塊');

await check('F1 個股頁原有區塊完好', async () => {
  const r = await page.evaluate(() => ({
    summary: !!document.getElementById('result'),
    reasons: document.querySelectorAll('.adv-section').length,
    notify: !!document.querySelector('.notify-card'),
    len: (document.getElementById('result')?.textContent || '').length,
  }));
  ok(r.summary, '找不到 #result');
  ok(r.reasons >= 1, '進階分析區塊消失了');
  ok(r.notify, '通知卡消失了');
  ok(r.len > 2000, `頁面內容只有 ${r.len} 字`);
});

await check('F2 RRG 頁原有區塊完好', async () => {
  const r = await rrg.evaluate(() => {
    const cv = document.getElementById('rrgCanvas');
    const b = cv ? cv.getBoundingClientRect() : null;
    return {
      canvas: !!cv && b.width > 200 && b.height > 200,
      tableRows: document.querySelectorAll('#rrgTableBody tr').length,
      treemap: !!document.getElementById('rrgTmCanvas'),
      holdings: !!document.getElementById('rrgHoldBody'),
    };
  });
  ok(r.canvas, '四象限畫布尺寸異常');
  ok(r.tableRows >= 11, `明細表只有 ${r.tableRows} 列`);
  ok(r.treemap, 'Treemap 卡片不見了');
  ok(r.holdings, '權重股面板不見了');
});

section('G 版面：不得溢出、不得截斷');

await check('G1 1280px 卡片無水平溢出', async () => {
  const r = await page.evaluate(() => {
    const card = document.getElementById('newsAiCard');
    const b = card.getBoundingClientRect();
    let worst = 0, worstId = '';
    card.querySelectorAll('*').forEach((el) => {
      const r2 = el.getBoundingClientRect();
      if (r2.width === 0) return;
      const over = r2.right - b.right;
      if (over > worst) { worst = over; worstId = el.id || el.className; }
    });
    return { worst: Math.round(worst), worstId, docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  ok(r.worst <= 2, `內容超出卡片右緣 ${r.worst}px（${r.worstId}）`);
  ok(!r.docOverflow, '整頁出現水平捲軸');
});

await check('G2 因子名稱沒有被截斷（不是省略號）', async () => {
  const r = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#newsAiDrivers .news-ai-drv-name')).map((n) => ({
      text: n.textContent.trim(),
      sw: n.scrollWidth,
      cw: n.clientWidth,
    })));
  ok(r.length >= 1, '沒有因子列');
  for (const x of r) {
    ok(x.sw <= x.cw + 2,
      `「${x.text}」被裁切（內容 ${x.sw}px > 容器 ${x.cw}px）`);
  }
});

await check('G3 宏觀卡片無水平溢出', async () => {
  const r = await rrg.evaluate(() => {
    const card = document.getElementById('macroAiCard');
    const b = card.getBoundingClientRect();
    let worst = 0, worstId = '';
    card.querySelectorAll('*').forEach((el) => {
      const r2 = el.getBoundingClientRect();
      if (r2.width === 0) return;
      const over = r2.right - b.right;
      if (over > worst) { worst = over; worstId = el.id || el.className; }
    });
    return { worst: Math.round(worst), worstId, docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  ok(r.worst <= 2, `內容超出卡片右緣 ${r.worst}px（${r.worstId}）`);
  ok(!r.docOverflow, '整頁出現水平捲軸');
});

section('H 行動版 390px');

await check('H1 個股頁 390px：無溢出、量表與清單可讀', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const merr = [];
  m.on('pageerror', (e) => merr.push(e.message));
  await m.goto(BASE + '/#/detail/' + encodeURIComponent(SYMBOL), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await m.waitForTimeout(7000);
  await waitCardSettled(m, 'newsAi');
  await goNewsTab(m);   // 同上：不切分頁量到的寬度是 0

  const r = await m.evaluate(() => {
    const card = document.getElementById('newsAiCard');
    const b = card.getBoundingClientRect();
    let worst = 0;
    card.querySelectorAll('*').forEach((el) => {
      const r2 = el.getBoundingClientRect();
      if (r2.width === 0) return;
      if (r2.right - b.right > worst) worst = r2.right - b.right;
    });
    const names = Array.from(document.querySelectorAll('#newsAiDrivers .news-ai-drv-name'))
      .map((n) => ({ t: n.textContent.trim(), sw: n.scrollWidth, cw: n.clientWidth }));
    return {
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      worst: Math.round(worst),
      gaugeW: Math.round(document.getElementById('newsAiGauge').getBoundingClientRect().width),
      items: document.querySelectorAll('#newsAiList li').length,
      names,
      events: document.querySelectorAll('#newsAiEvents li').length,
    };
  });
  ok(!r.docOverflow, `水平溢出：${r.scrollW} > ${r.clientW}`);
  ok(r.worst <= 2, `卡片內元素超出右緣 ${r.worst}px`);
  ok(r.gaugeW > 80, `量表只有 ${r.gaugeW}px 寬`);
  ok(r.items >= 1, '清單是空的');
  ok(r.events >= 1, '關鍵事件是空的');
  for (const n of r.names) {
    ok(n.sw <= n.cw + 2, `390px 下「${n.t}」被裁切（${n.sw} > ${n.cw}）`);
  }
  ok(merr.length === 0, `JS 錯誤：${merr.join('; ')}`);
  await m.close();
});

await check('H2 RRG 頁 390px：無溢出、排名可讀', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const merr = [];
  m.on('pageerror', (e) => merr.push(e.message));
  await m.goto(BASE + '/#/rrg', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await m.waitForTimeout(8000);
  await waitCardSettled(m, 'macroAi');

  const r = await m.evaluate(() => {
    const card = document.getElementById('macroAiCard');
    const b = card.getBoundingClientRect();
    let worst = 0;
    card.querySelectorAll('*').forEach((el) => {
      const r2 = el.getBoundingClientRect();
      if (r2.width === 0) return;
      if (r2.right - b.right > worst) worst = r2.right - b.right;
    });
    return {
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      worst: Math.round(worst),
      rows: document.querySelectorAll('#macroAiRank .macro-ai-rank-row').length,
      links: document.querySelectorAll('#macroAiLinks .macro-ai-link').length,
    };
  });
  ok(!r.docOverflow, `水平溢出：${r.scrollW} > ${r.clientW}`);
  ok(r.worst <= 2, `卡片內元素超出右緣 ${r.worst}px`);
  ok(r.rows === 11, `排名只有 ${r.rows} 列`);
  ok(r.links === 8, `宏觀卡只有 ${r.links} 筆`);
  ok(merr.length === 0, `JS 錯誤：${merr.join('; ')}`);
  await m.close();
});

section('I 失敗與空狀態（不可無限轉圈）');

await check('I1 新聞 API 失敗 → 顯示可重試錯誤、不卡轉圈', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
  const p2 = await ctx.newPage();
  await p2.route('**/api/stock-news-ai**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'NEWS_AI_FAILED', message: '上游暫時無法取得新聞' } }),
    }));
  await p2.goto(BASE + '/#/detail/' + encodeURIComponent(SYMBOL), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p2.waitForTimeout(7000);

  const r = await p2.evaluate(() => {
    const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
    return {
      loading: vis(document.getElementById('newsAiLoading')),
      empty: vis(document.getElementById('newsAiEmpty')),
      emptyText: (document.getElementById('newsAiEmpty')?.textContent || '').replace(/\s+/g, ' ').trim(),
      retry: !!document.getElementById('newsAiRetry'),
      cardVisible: vis(document.getElementById('newsAiCard')),
    };
  });
  ok(!r.loading, '失敗後仍停在載入中（無限轉圈）');
  ok(r.empty, '未顯示空狀態');
  ok(/暫時無法|失敗|錯誤/.test(r.emptyText), `錯誤訊息不明確：${r.emptyText.slice(0, 100)}`);
  ok(r.retry, '缺少重試按鈕');
  ok(r.cardVisible, '卡片整塊消失了');
  await ctx.close();
});

await check('I2 新聞 API 回 200 但零則 → 空狀態不得誤用錯誤樣式', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
  const p3 = await ctx.newPage();
  await p3.route('**/api/stock-news-ai**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        symbol: SYMBOL,
        news: { count: 0, items: [], totalBeforeLimit: 0, tiers: {}, window: { days: 7, from: '2026-11-19', to: '2026-11-26' } },
        ai: { mode: 'rule', sentiment: 'neutral', score: null, summary: '期間內無相關新聞。', keyEvents: [], drivers: [], caveats: ['沒有新聞'], confidence: 'low' },
        provenance: { sources: [], publishers: [], generatedAt: '2026-11-26T08:00:00.000Z', hantOk: true },
        priceContextAvailable: true,
      }),
    }));
  await p3.goto(BASE + '/#/detail/' + encodeURIComponent(SYMBOL), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p3.waitForTimeout(7000);

  const r = await p3.evaluate(() => {
    const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
    return {
      loading: vis(document.getElementById('newsAiLoading')),
      body: vis(document.getElementById('newsAiBody')),
      gaugeText: (document.getElementById('newsAiGauge')?.textContent || '').trim(),
      score: (document.getElementById('newsAiScore')?.textContent || '').trim(),
      listText: (document.getElementById('newsAiList')?.textContent || '').trim(),
      errCls: /err/.test(document.getElementById('newsAiEmpty')?.className || ''),
    };
  });
  ok(!r.loading, '仍停在載入中');
  ok(r.body, '零則新聞時主體未顯示（應顯示「無新聞」而非空白）');
  ok(r.score === '—', `零則新聞卻給了分數 ${r.score}`);
  ok(/無情緒評分/.test(r.gaugeText), '零則新聞時量表沒有標示「無情緒評分」');
  ok(/查無相關新聞/.test(r.listText), `清單沒有說明查無資料：${r.listText.slice(0, 80)}`);
  ok(!r.errCls, '零則新聞是正常結果，不該套用錯誤樣式');
  await ctx.close();
});

await check('I3 宏觀 API 失敗 → 不卡轉圈、有重試', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
  const p4 = await ctx.newPage();
  await p4.route('**/api/sector-macro-ai**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'SECTOR_MACRO_FAILED', message: '宏觀資料暫時無法取得' } }),
    }));
  await p4.goto(BASE + '/#/rrg', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p4.waitForTimeout(8000);

  const r = await p4.evaluate(() => {
    const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
    return {
      loading: vis(document.getElementById('macroAiLoading')),
      empty: vis(document.getElementById('macroAiEmpty')),
      retry: !!document.getElementById('macroAiRetry'),
      text: (document.getElementById('macroAiEmpty')?.textContent || '').replace(/\s+/g, ' ').trim(),
      // 宏觀卡失敗不得連累 RRG 主圖
      canvas: (() => {
        const c = document.getElementById('rrgCanvas');
        const b = c ? c.getBoundingClientRect() : null;
        return !!b && b.width > 200;
      })(),
    };
  });
  ok(!r.loading, '失敗後仍停在載入中');
  ok(r.empty, '未顯示空狀態');
  ok(r.retry, '缺少重試按鈕');
  ok(r.canvas, '宏觀卡失敗連帶把 RRG 主圖弄壞了（失敗未隔離）');
  await ctx.close();
});

section('J 全域');

await check('J1 個股頁無 JS 錯誤', async () => {
  const real = errors.filter((e) => !/status of 4\d\d/.test(e));
  ok(real.length === 0, `${real.length} 個錯誤：\n${real.slice(0, 4).join('\n')}`);
});

await check('J2 RRG 頁無 JS 錯誤', async () => {
  const real = rrgErrors.filter((e) => !/status of 4\d\d/.test(e));
  ok(real.length === 0, `${real.length} 個錯誤：\n${real.slice(0, 4).join('\n')}`);
});

await check('J3 Service Worker 已收錄新聞模組且版本已升', async () => {
  const v = await page.evaluate(async () => {
    const r = await fetch('/sw.js');
    const t = await r.text();
    const m = t.match(/^\s*(?:const|var)\s+VERSION\s*=\s*'([^']+)'/m);
    return { v: m && m[1], hasAsset: t.includes("'/news-ai.js'") };
  });
  ok(v.v, '找不到 VERSION');
  // 逐段比數字：字串比較下 'v1.0.10' < 'v1.0.7'，會誤判成「沒升版」
  const num = (s) => (s.match(/\d+/g) || []).map(Number);
  const cmp = (a, b) => {
    const x = num(a), y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  ok(cmp(v.v, 'v1.0.10') >= 0, `VERSION 為 ${v.v}，舊殼會被快取`);
  ok(v.hasAsset, 'SHELL_ASSETS 未含 /news-ai.js');
});

await check('J4 淺色主題：卡片底淺、文字深', async () => {
  const r = await page.evaluate(() => {
    const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const rgb = (s) => (s.match(/\d+/g) || []).map(Number).slice(0, 3);
    const card = document.getElementById('newsAiCard');
    const body = document.getElementById('newsAiBody');
    return {
      cardBg: lum(rgb(getComputedStyle(card).backgroundColor)),
      bodyBg: lum(rgb(getComputedStyle(body).backgroundColor)),
      text: lum(rgb(getComputedStyle(card).color)),
      textColor: getComputedStyle(card).color,
    };
  });
  ok(r.cardBg > 200, `卡片底亮度 ${r.cardBg.toFixed(0)}，像深色主題`);
  ok(r.text < 140, `文字 ${r.textColor} 亮度 ${r.text.toFixed(0)}，不像深色字`);
});

/* ------------------------------------------------------------ */

section('K 行動版可讀性（字級下限／分頁可達性）');

/* 實機回報：「手機版的 AI 個股分析分頁字體太細，無法正常運行」。
   拆開來看其實是兩個獨立缺陷，且都只有真的量像素才會發現：

   1. 分頁列在 390px 下溢出：min-width:92px × 4 + gap + padding = 392px，
      可用寬只有 364px，第 4 格「新聞」（AI 多空所在）有一半在畫面外，
      不橫滑就看不到。DOM 存在、click 也能用，但使用者找不到。
   2. 小字級沿用桌面值：282 處 <=12.5px，配上 --text-3 (#8a94a6)
      對白底只有 3.06:1（低於 AA 4.5），於是「又小又淡」。

   這兩個問題的共通點：**沒有任何既有測試會失敗**。
   H1 只驗溢出與裁切，分頁本身不溢出；字級與對比完全沒驗。
   所以這一節直接量 computed style 與實際對比度。 */

await check('K1 390px 分頁四格全在畫面內、不需橫滑', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await m.goto(BASE + '/#/detail/' + encodeURIComponent(SYMBOL), { waitUntil: 'domcontentloaded', timeout: 90000 });
    /* 固定等待不足：線上冷啟動時 #result 尚未解除 hidden，
       分頁列高度會量到 0，測試就變成「看誰的機器快」的擲骰子。
       改成明確等元素可見——那才是被測的狀態本身。 */
    await m.waitForSelector('.sub-tabs', { state: 'visible', timeout: 60000 });
    await m.waitForTimeout(1500);

    const r = await m.evaluate(() => {
      const bar = document.querySelector('.sub-tabs');
      if (!bar) return { missing: true };
      const btns = Array.from(bar.querySelectorAll('.sub-tab'));
      return {
        // 溢出判準：分頁列自身是否還需要橫向捲動
        needScroll: bar.scrollWidth > bar.clientWidth + 1,
        scrollW: bar.scrollWidth,
        clientW: bar.clientWidth,
        // 每一格是否完整落在視窗內（右緣不得超出）
        vw: document.documentElement.clientWidth,
        tabs: btns.map((b) => {
          const rect = b.getBoundingClientRect();
          const t = b.querySelector('.sub-tab-t');
          const cs = t ? getComputedStyle(t) : null;
          return {
            name: b.getAttribute('data-tab'),
            right: Math.round(rect.right),
            left: Math.round(rect.left),
            h: Math.round(rect.height),
            fs: cs ? parseFloat(cs.fontSize) : null,
            fw: cs ? cs.fontWeight : null,
          };
        }),
      };
    });

    ok(!r.missing, '找不到分頁列');
    ok(!r.needScroll,
      `分頁列仍需橫滑（scrollWidth ${r.scrollW} > clientWidth ${r.clientW}）——` +
      '最後一格會落在畫面外，使用者找不到 AI 多空分頁');
    for (const t of r.tabs) {
      ok(t.right <= r.vw, `分頁「${t.name}」右緣 ${t.right}px 超出視窗 ${r.vw}px`);
      ok(t.left >= 0, `分頁「${t.name}」左緣 ${t.left}px 為負（被推出畫面）`);
      // 觸控目標下限（Apple HIG 44px）
      ok(t.h >= 44, `分頁「${t.name}」高度只有 ${t.h}px（觸控下限 44px）`);
      // 標籤字級不可小於內文；15px/700 是本專案手機版分頁的標準
      ok(t.fs >= 15, `分頁「${t.name}」字級 ${t.fs}px 偏小（應 >= 15px）`);
      ok(Number(t.fw) >= 700, `分頁「${t.name}」字重 ${t.fw} 偏細（應 >= 700）`);
    }
  } finally {
    await m.close();
  }
});

await check('K2 四個分頁的內容皆無小於 12.5px 的可見文字', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await m.goto(BASE + '/#/detail/' + encodeURIComponent(SYMBOL), { waitUntil: 'domcontentloaded', timeout: 90000 });
    await m.waitForSelector('.sub-tabs', { state: 'visible', timeout: 60000 });
    await m.waitForTimeout(1500);

    for (const tab of ['decision', 'tech', 'fund', 'news']) {
      const btn = await m.$('.sub-tab[data-tab="' + tab + '"]');
      if (!btn) { ok(false, `找不到分頁 ${tab}`); continue; }
      await btn.click();
      await m.waitForTimeout(900);

      const small = await m.evaluate((t) => {
        const panel = document.getElementById('panel-' + t);
        if (!panel || panel.hidden) return [{ text: '(面板未顯示)', fs: 0 }];
        const out = [];
        panel.querySelectorAll('*').forEach((el) => {
          const direct = Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
          if (direct.length < 2) return;
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') return;
          const fs = parseFloat(cs.fontSize);
          // 12.5px 是手機版下限；absolute 的圖表刻度另外處置（見 K3）
          if (fs >= 12.5 || cs.position === 'absolute') return;
          out.push({ fs, text: direct.slice(0, 16), cls: (el.getAttribute('class') || '').slice(0, 28) });
        });
        return out;
      }, tab);

      ok(small.length === 0,
        `${tab} 分頁仍有 ${small.length} 處小於 12.5px：` +
        small.slice(0, 4).map((s) => `${s.fs}px「${s.text}」.${s.cls}`).join('、'));
    }
  } finally {
    await m.close();
  }
});

await check('K3 手機版文字對比度：不合格者 <= 5%（且不含圖表刻度）', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await m.goto(BASE + '/#/detail/' + encodeURIComponent(SYMBOL), { waitUntil: 'domcontentloaded', timeout: 90000 });
    await m.waitForSelector('.sub-tabs', { state: 'visible', timeout: 60000 });
    await m.waitForTimeout(1500);

    let total = 0;
    const bad = [];
    for (const tab of ['decision', 'tech', 'fund', 'news']) {
      const btn = await m.$('.sub-tab[data-tab="' + tab + '"]');
      if (!btn) continue;
      await btn.click();
      await m.waitForTimeout(900);

      const r = await m.evaluate((t) => {
        const parse = (c) => {
          const mm = c.match(/[\d.]+/g);
          if (!mm) return null;
          return [Number(mm[0]), Number(mm[1]), Number(mm[2]), mm[3] === undefined ? 1 : Number(mm[3])];
        };
        const lum = (rgb) => {
          const c2 = rgb.slice(0, 3).map((v) => {
            const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * c2[0] + 0.7152 * c2[1] + 0.0722 * c2[2];
        };
        // 往上合成實際背景色（卡片、面板、soft 底色都要算進去）
        const bgOf = (el) => {
          const chain = [];
          let p = el;
          while (p) { chain.push(p); p = p.parentElement; }
          let acc = [255, 255, 255, 1];
          for (let i = chain.length - 1; i >= 0; i--) {
            const c2 = parse(getComputedStyle(chain[i]).backgroundColor);
            if (c2 && c2[3] > 0) {
              acc = [
                c2[0] * c2[3] + acc[0] * (1 - c2[3]),
                c2[1] * c2[3] + acc[1] * (1 - c2[3]),
                c2[2] * c2[3] + acc[2] * (1 - c2[3]),
                1,
              ];
            }
          }
          return acc;
        };
        const panel = document.getElementById('panel-' + t);
        if (!panel || panel.hidden) return { n: 0, bad: [] };
        let n = 0;
        const bad = [];
        panel.querySelectorAll('*').forEach((el) => {
          const direct = Array.from(el.childNodes)
            .filter((x) => x.nodeType === 3).map((x) => x.textContent.trim()).join('');
          if (direct.length < 2) return;
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') return;
          const fg = parse(cs.color);
          if (!fg) return;
          n++;
          // 圖表上的絕對定位刻度空間受限，不以 AA 標準要求（見 K4）
          if (cs.position === 'absolute') return;
          // 紅漲綠跌等語意色另有規範，不在此判定
          if (/v-neg|v-pos|\.neg|\.pos|adv-bad|adv-on/.test(el.className || '')) return;
          const lf = lum(fg);
          const lb = lum(bgOf(el));
          const cr = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
          if (cr < 4.5) {
            bad.push({ cr: Math.round(cr * 100) / 100, text: direct.slice(0, 16), cls: (el.className || '').slice(0, 24) });
          }
        });
        return { n, bad };
      }, tab);

      total += r.n;
      bad.push(...r.bad.map((x) => ({ ...x, tab })));
    }

    // 基準：改動前 335/950（35%）不合格。目標 <= 5%。
    const ratio = total ? bad.length / total : 0;
    ok(total > 300, `只量到 ${total} 個文字節點，量測可能失效`);
    ok(ratio <= 0.05,
      `${bad.length}/${total}（${(ratio * 100).toFixed(1)}%）文字對比度 < 4.5：` +
      bad.slice(0, 4).map((x) => `${x.cr}:1「${x.text}」.${x.cls}`).join('、'));
  } finally {
    await m.close();
  }
});

await check('K4 圖表刻度標籤放大後不重疊', async () => {
  /* 斐波那契刻度原本 9.5px + --text-3（對比 2.12）。
     這些標籤間距由百分比決定，放大字級有重疊風險，
     所以不能只驗「有沒有放大」，必須驗「放大後還排得下」。 */
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await m.goto(BASE + '/#/detail/' + encodeURIComponent(SYMBOL), { waitUntil: 'domcontentloaded', timeout: 90000 });
    await m.waitForSelector('.sub-tabs', { state: 'visible', timeout: 60000 });
    await m.waitForTimeout(1500);
    const btn = await m.$('.sub-tab[data-tab="tech"]');
    if (btn) { await btn.click(); await m.waitForTimeout(1500); }

    const r = await m.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('.fib-mark-label'));
      if (!labels.length) return { n: 0 };
      const items = labels.map((l) => {
        const b = l.getBoundingClientRect();
        return { t: l.textContent.trim(), x: b.x, right: b.right, fs: parseFloat(getComputedStyle(l).fontSize) };
      }).sort((a, b) => a.x - b.x);
      const overlaps = [];
      for (let i = 1; i < items.length; i++) {
        if (items[i].x < items[i - 1].right - 0.5) overlaps.push(`${items[i - 1].t}×${items[i].t}`);
      }
      return { n: items.length, overlaps, minFs: Math.min.apply(null, items.map((i) => i.fs)) };
    });

    ok(r.n === 0 || r.overlaps.length === 0,
      `斐波那契刻度重疊：${(r.overlaps || []).join('、')}`);
    ok(r.n === 0 || r.minFs >= 11,
      `刻度字級只有 ${r.minFs}px（原本 9.5px，應 >= 11px）`);
  } finally {
    await m.close();
  }
});

await check('K5 降級路徑（模組不可用）也不得有小於 12.5px 的文字', async () => {
  /* 為什麼要單獨驗降級路徑：
     第一次修完在本機全綠，部署後線上卻抓到 .adv-na-hint 仍是 12px。
     原因是那個元素只在「上游資料不可用」時才渲染——本機 happy path
     永遠碰不到它，只有線上（上游 503）才會出現。

     這一類「只在失敗時才顯示」的元素是最容易漏的：使用者真正需要
     看清楚的時候（出錯了、要判斷怎麼辦），字反而最小。

     做法：攔截 /api/analyze 並改寫回應，把進階模組全標為不可用，
     不讓請求真的失敗（否則整個 #result 會 hidden，分頁根本看不到）。 */
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await m.route('**/api/analyze**', async (route) => {
      const resp = await route.fetch();
      let json;
      try { json = await resp.json(); } catch { return route.fulfill({ response: resp }); }
      const at = json.advancedTools;
      if (at && Array.isArray(at.modules)) {
        at.modules = at.modules.map((mod) => Object.assign({}, mod, {
          available: false,
          blocked: true,
          hint: '此模組需要期權鏈資料，目前上游未提供。可改用券商平台查看。',
          reason: '上游資料來源未回傳此標的的期權鏈，因此無法計算。',
        }));
        at.availableCount = 0;
        at.totalCount = at.modules.length;
      }
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(json),
      });
    });

    await m.goto(BASE + '/#/detail/' + encodeURIComponent(SYMBOL), { waitUntil: 'domcontentloaded', timeout: 90000 });
    await m.waitForSelector('.sub-tabs', { state: 'visible', timeout: 60000 });
    await m.waitForTimeout(2000);

    let found = [];
    for (const tab of ['decision', 'tech', 'fund', 'news']) {
      const btn = await m.$('.sub-tab[data-tab="' + tab + '"]');
      if (!btn) continue;
      await btn.click();
      await m.waitForTimeout(1000);
      const small = await m.evaluate((t) => {
        const panel = document.getElementById('panel-' + t);
        if (!panel || panel.hidden) return [];
        const out = [];
        panel.querySelectorAll('*').forEach((el) => {
          const d = Array.from(el.childNodes).filter((n) => n.nodeType === 3)
            .map((n) => n.textContent.trim()).join('');
          if (d.length < 2) return;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') return;
          if (cs.position === 'absolute') return;
          const fs = parseFloat(cs.fontSize);
          if (fs >= 12.5) return;
          out.push({ fs, cls: (el.getAttribute('class') || '') || '<' + el.tagName.toLowerCase() + '>', text: d.slice(0, 18) });
        });
        return out;
      }, tab);
      found = found.concat(small.map((s) => Object.assign({ tab }, s)));
    }

    ok(found.length === 0,
      `降級路徑仍有 ${found.length} 處小字：` +
      found.slice(0, 5).map((s) => `${s.tab}/${s.fs}px .${s.cls}「${s.text}」`).join('、'));
  } finally {
    await m.close();
  }
});

/* ------------------------------------------------------------ */

console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${pass} 通過 / ${fail} 失敗`);
if (fail) {
  console.log('\n失敗詳情：');
  for (const f of failures) console.log(`  [${f.name}] ${f.error.message}`);
}
console.log('='.repeat(50));

await browser.close();
process.exit(fail ? 1 : 0);
