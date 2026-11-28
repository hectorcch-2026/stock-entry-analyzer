'use strict';

/**
 * AI 選股 — 篩選引擎
 *
 * 定位：把「篩選」從「每日不可靠的背景排程」改為「使用者觸發的批次計算」。
 *
 * 為什麼這樣設計（重要，對應 docs/ 規格書 A-21）：
 * 原規格 AS-9 要求「每交易日自動產出 3–10 檔清單」。但 Render 免費方案閒置
 * 15 分鐘即休眠（DEPLOY.md:53），進程內 setInterval 不會執行，因此背景排程
 * 在現行部署下不可靠。折衷做法是：
 *   1. 使用者按下「開始篩選」→ 立刻在請求內批次計算（本模組核心）
 *   2. 結果落地成 JSON，下次同參數查詢直接讀檔（省上游請求）
 *   3. 若有外部 cron 或付費方案，可用 /api/picks?run=1 觸發預熱
 *
 * 這樣「每日清單」變成「每日第一次有人看時就產生」，功能可用性不依賴排程。
 *
 * 排序依據刻意不使用方向機率（A-31 裁決：不輸出 p_up）。
 * 使用的是四個已在既有系統中可驗證的量：
 *   score（技術面綜合分）／distAtr（距買區的 ATR 倍數）／
 *   atrPct（波動）／rrRatio（盈虧比）
 */

const fs = require('fs');
const path = require('path');

/** 篩選結果落地目錄。首次寫入時自動建立。 */
const CACHE_DIR = path.join(__dirname, '..', 'data', 'picks');

/**
 * 併發上限。
 *
 * 為什麼不是「有多少跑多少」：analyzer.analyze() 每檔要打 3 個上游請求
 * （日線／週線／報價）。母體 500 檔 × 3 = 1500 個請求，全併發會直接被上游
 * 限流（429），後果是「整批都是失敗」而不是「慢一點」。
 * 實測：併發 4 時單檔平均 0.2–0.6 秒；併發 8 開始出現零星 429。故上限 8。
 *
 * ⚠ 母體由 154 擴到 500 後，單輪跑完全池的時間約為原本的 3.2 倍。
 *   90 秒的預算在多數情況下跑不完 500 檔，這是**預期行為**而非故障：
 *   screen() 會在達標時停止、回報 timedOut，並在 notes 說明「僅檢查 N/500 檔」。
 *   若要跑完全池，請把 SCREEN_BUDGET_MS 調高（見下方 budgetMs）。
 */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

 /** 單輪篩選的硬性時間上限，避免卡住整個請求 */
const DEFAULT_BUDGET_MS = 90 * 1000;

/** 預設篩選條件。全部可被請求參數覆寫。 */
const DEFAULTS = {
  market: 'us',         // us（母體僅美股；all 等同 us，hk 回空）
  minScore: 55,         // 技術面評分下限（0–100）
  maxDistAtr: 3.0,      // 距買區上限（ATR 倍數）。A-26 實測：百分比門檻無區分度，須用 ATR 正規化
  minPrice: 1,          // 收盤價下限（過濾低價噪音股）
  minAvgVol: 0,         // 20 日均量下限（0 = 不過濾，因為池子小）
  maxAtrPct: 12,        // 波動上限（%）。超過此值的標的區間預測本身不可靠
  requirePred: false,   // 是否只保留 FP 預測 status=ok 的標的
  limit: 30,            // 回傳上限
  sortBy: 'score',      // score | distAtr | atrPct | rrRatio | changePct
  sortDir: 'desc',
};

const SORTABLE = new Set(['sector', 'score', 'distAtr', 'atrPct', 'rrRatio', 'changePct', 'price', 'avgVol']);

const SORTABLE_LABEL = {
  /*
   * 'sector' 不是單一欄位，而是「版塊優先」這個四鍵排序模式的代號。
   * 之所以放進 SORTABLE 而不是另開一個 bool 參數：前端的下拉選單、
   * 參數驗證、快取 key 三處都共用 SORTABLE，另開參數等於要在三處
   * 各加一次分支，而且會出現「sortBy=rrRatio 同時 sectorPriority=true」
   * 這種互相矛盾的組合。用一個鍵表達一種排序模式，語意唯一。
   */
  sector: '版塊優先',
  score: '技術評分',
  distAtr: '距買區（ATR）',
  atrPct: '波動（ATR%）',
  rrRatio: '盈虧比',
  changePct: '當日漲跌',
  price: '價格',
  avgVol: '均量',
};

/**
 * 參數正規化與驗證。
 *
 * 為什麼要獨立成一個函式：篩選條件全部來自 URL query，使用者可能傳
 * `minScore=abc`、`limit=99999`、`sortBy=../../etc/passwd`。
 * 這裡一次擋掉，不讓非法值滲進計算層。
 *
 * @returns {{ok:true, opts:object} | {ok:false, code:string, message:string}}
 */
function normalizeOptions(raw) {
  const q = raw || {};
  const opts = { ...DEFAULTS };
  const errs = [];

  const num = (key, min, max, label) => {
    if (q[key] === undefined || q[key] === '') return;
    const v = Number(q[key]);
    if (!isFinite(v)) {
      errs.push(`${label}必須是數字（收到「${q[key]}」）`);
      return;
    }
    if (v < min || v > max) {
      errs.push(`${label}必須介於 ${min} 與 ${max} 之間（收到 ${v}）`);
      return;
    }
    opts[key] = v;
  };

  if (q.market !== undefined && q.market !== '') {
    const m = String(q.market).toLowerCase();
    if (!['all', 'us', 'hk'].includes(m)) {
      errs.push(`市場必須是 all／us／hk 之一（收到「${q.market}」）`);
    } else {
      opts.market = m;
    }
  }

  num('minScore', 0, 100, '評分下限');
  num('maxDistAtr', 0, 50, '距買區上限（ATR 倍數）');
  num('minPrice', 0, 1e7, '價格下限');
  num('minAvgVol', 0, 1e12, '均量下限');
  num('maxAtrPct', 0.1, 100, '波動上限');
  num('limit', 1, 200, '回傳筆數');

  if (q.requirePred !== undefined && q.requirePred !== '') {
    opts.requirePred = q.requirePred === '1' || q.requirePred === 'true';
  }

  if (q.sortBy !== undefined && q.sortBy !== '') {
    const s = String(q.sortBy);
    if (!SORTABLE.has(s)) {
      errs.push(`排序欄位必須是 ${[...SORTABLE].join('／')} 之一（收到「${s}」）`);
    } else {
      opts.sortBy = s;
    }
  }

  if (q.sortDir !== undefined && q.sortDir !== '') {
    const d = String(q.sortDir).toLowerCase();
    if (!['asc', 'desc'].includes(d)) {
      errs.push('排序方向必須是 asc 或 desc');
    } else {
      opts.sortDir = d;
    }
  }

  if (errs.length) {
    return { ok: false, code: 'BAD_PARAMS', message: errs.join('；') };
  }
  return { ok: true, opts };
}

/**
 * 把 analyzer 的評分明細壓成可長期保存的精簡陣列。
 *
 * 為什麼不直接存原物件：detail 內的 note 是給人看的長句，七項加起來
 * 約 1KB／檔。帳本每天 append，長期下來是無謂的膨脹。這裡只留
 * 「哪一項、得幾分、滿分多少」，讓前端能畫出「85 分怎麼來的」，
 * 需要完整說明時再回個股分析頁看。
 *
 * @returns {Array<{k:string,l:string,s:number|null,m:number|null}>}
 */
function snapshotScore(detail) {
  if (!Array.isArray(detail)) return [];
  return detail.slice(0, 12).map((d) => ({
    k: String((d && d.key) || '').slice(0, 24),
    l: String((d && d.label) || '').slice(0, 24),
    s: isFinite(d && d.score) ? +(+d.score).toFixed(1) : null,
    m: isFinite(d && d.max) ? +(+d.max).toFixed(1) : null,
  }));
}

/** 從 analyzer 的單檔輸出抽出篩選所需的扁平欄位。缺值一律回 null，不補 0。 */
function flatten(analysis) {
  // 注意：analyzer.analyze() 的成功結果**沒有** ok 欄位（ok 是 server.js
  // 在送出路徑上才補的）。若在這裡檢查 analysis.ok，會把所有成功結果
  // 都判成失敗——這正是第一版「70 檔全部失敗」的原因。
  // 正確的判準是「有沒有 meta 與 score」這些必然存在的欄位。
  if (!analysis || typeof analysis !== 'object') return null;
  if (!analysis.meta || analysis.score == null) return null;
  const snap = analysis.snapshot || {};

  const zone = analysis.buyZone || {};
  const bt = analysis.backtest || {};
  const meta = analysis.meta || {};

  const price = snap.price != null ? snap.price : meta.price;
  // distAtr：距買區上緣的 ATR 倍數。ATR 缺值時回 null（不猜）
  const atr = snap.atr;
  let distAtr = null;
  if (isFinite(price) && isFinite(zone.upper) && isFinite(atr) && atr > 0) {
    distAtr = +((price - zone.upper) / atr).toFixed(2);
  }
  // rrRatio：盈虧比。停損或目標缺值時回 null
  let rrRatio = null;
  const stop = zone.stopLoss != null ? zone.stopLoss : zone.stop;
  if (isFinite(zone.target) && isFinite(stop) && isFinite(price)) {
    const reward = zone.target - price;
    const risk = price - stop;
    if (risk > 0) rrRatio = +(reward / risk).toFixed(2);
  }

  return {
    symbol: analysis.meta?.symbol || meta.symbol || null,
    name: meta.name || null,
    market: meta.market || null,
    currency: meta.currency || null,
    price: isFinite(price) ? +price.toFixed(3) : null,
    changePct: isFinite(snap.changePct) ? +snap.changePct.toFixed(2)
      : (isFinite(meta.changePercent) ? +meta.changePercent.toFixed(2) : null),
    score: isFinite(analysis.score) ? Math.round(analysis.score) : null,
    verdict: analysis.verdict || null,
    atrPct: isFinite(snap.atrPct) ? +snap.atrPct.toFixed(2) : null,
    distAtr,
    rrRatio,
    zoneLower: isFinite(zone.lower) ? +zone.lower.toFixed(3) : null,
    zoneUpper: isFinite(zone.upper) ? +zone.upper.toFixed(3) : null,
    zoneStop: isFinite(stop) ? +stop.toFixed(3) : null,
    zoneTarget: isFinite(zone.target) ? +zone.target.toFixed(3) : null,
    avgVol: isFinite(snap.volume?.vol20) ? Math.round(snap.volume.vol20) : null,
    winRate20: isFinite(bt.horizons?.[20]?.winRate) ? +bt.horizons[20].winRate.toFixed(4) : null,
    samples: isFinite(bt.samples) ? bt.samples : null,
    predStatus: analysis.pred?.status || null,
    predAdj: analysis.pred?.adj || null,

    /* ---- 推薦原因與參數 ----
       rationale 是 analyzer 產生的六段自然語言判斷依據（技術位、均線、量價、
       波動、歷史模型、綜合結論）。它原本**只存在於個股分析結果裡**，選股
       這條路徑完全沒帶上，於是帳本只能記下分數與幾個價位——使用者問
       「當初為什麼推薦這檔」時無從回答。

       為什麼不在帳本裡「事後重算」：
         帳本要回答的是「當時為什麼推薦」，重算會用到今天的線圖，
         等於用後見之明改寫歷史。必須在建立推介的當下就存下來。

       為什麼用 slice 截斷：rationale 六段全文約 2–3KB，五檔就是 15KB，
       帳本是每天都會 append 的檔案，長期會明顯膨脹。這裡只保留
       每段的前段文字（完整內容仍可在個股分析頁重看）。 */
    rationale: Array.isArray(analysis.rationale)
      ? analysis.rationale.map((r) => ({
        title: String(r.title || '').slice(0, 40),
        body: String(r.body || '').slice(0, 400),
      }))
      : [],

    // 推薦參數：分子項讓使用者看得出「85 分是怎麼來的」，而不是只有一個數字
    scoreBreakdown: snapshotScore(analysis.scoreBreakdown),
    probUp20: isFinite(analysis.probabilities?.probUp20)
      ? +analysis.probabilities.probUp20.toFixed(4) : null,
    probProfit: isFinite(analysis.probabilities?.probProfit)
      ? +analysis.probabilities.probProfit.toFixed(4) : null,
    baseRate20: isFinite(analysis.probabilities?.baseRate20)
      ? +analysis.probabilities.baseRate20.toFixed(4) : null,
  };
}

/**
 * 排除原因的類別標籤。
 *
 * 彙總時必須用「類別」分組，不能拿訊息字串硬把數字換成 N —— 那樣
 * 前端會直接顯示「評分 N 低於 N」這種像壞掉的字，使用者讀不出意思。
 * 這裡為每個原因保留一個代碼，訊息本身仍帶真實數值（給單檔說明用）。
 */
const REASON_LABEL = {
  market: '市場不符',
  noScore: '缺少評分',
  score: '評分低於下限',
  noZone: '無法計算距買區',
  distAtr: '距買區超過上限',
  noPrice: '缺少價格',
  price: '價格低於下限',
  avgVol: '均量低於下限',
  atrPct: '波動超過上限',
  pred: '區間預測不可用',
};

/**
 * 對單一標的套用硬性條件。
 *
 * 回傳 { pass, reasons[], codes[] }。reasons 會累積，讓前端能顯示
 * 「為什麼這檔被排除」，而不是只給一個空清單；codes 與 reasons 一一
 * 對應，供 topReasons() 彙總時使用。
 */
function applyFilters(row, opts) {
  const reasons = [];
  const codes = [];

  /** 同時記錄訊息與代碼，避免兩邊索引對不上。 */
  const add = (code, text) => {
    codes.push(code);
    reasons.push(text);
  };

  if (opts.market !== 'all') {
    if (String(row.market || '').toLowerCase() !== opts.market) add('market', `市場不符（${row.market || '未知'}）`);
  }
  if (row.score == null) {
    add('noScore', '缺少評分');
  } else if (row.score < opts.minScore) {
    add('score', `評分 ${row.score} 低於 ${opts.minScore}`);
  }
  if (row.distAtr == null) {
    add('noZone', '無法計算距買區（缺 ATR 或買區）');
  } else if (row.distAtr > opts.maxDistAtr) {
    add('distAtr', `距買區 ${row.distAtr} ATR 超過 ${opts.maxDistAtr}`);
  }
  if (row.price == null) {
    add('noPrice', '缺少價格');
  } else if (row.price < opts.minPrice) {
    add('price', `價格 ${row.price} 低於 ${opts.minPrice}`);
  }
  if (opts.minAvgVol > 0 && row.avgVol != null && row.avgVol < opts.minAvgVol) {
    add('avgVol', `均量 ${row.avgVol} 低於 ${opts.minAvgVol}`);
  }
  if (row.atrPct != null && row.atrPct > opts.maxAtrPct) {
    add('atrPct', `波動 ${row.atrPct}% 超過 ${opts.maxAtrPct}%`);
  }
  if (opts.requirePred && row.predStatus !== 'ok') {
    add('pred', `區間預測不可用（${row.predStatus || 'none'}）`);
  }

  return { pass: reasons.length === 0, reasons, codes };
}

/**
 * 多欄位排序。null 一律排到最後（不論 asc 或 desc），避免「空值佔滿第一頁」。
 *
 * sortBy === 'sector' 時走四鍵排序（見 docs/版塊輪動選股流程_設計規格.md §3.3）：
 *   1. 版塊名次      ASC   名次 1 的版塊優先
 *   2. 個股技術評分   DESC
 *   3. 距買區 ATR     ASC   越接近買區越好（負值＝已進入買區）
 *   4. 盈虧比        DESC
 *
 * 為什麼版塊名次放第一鍵、而不是把版塊分數混進個股分數加權：
 *   版塊的 strengthScore 是同儕百分位（11 個版塊之間比），個股的 score 是
 *   技術面絕對分。兩套尺度相加後得到的數字無法回答「這 81 分裡多少來自
 *   版塊」，也就無法回測、無法解釋。分段排序則每一段都能單獨驗證。
 *
 * 代價是集中度：前 10 名可能全來自同一個版塊。這不是 bug，因此不隱藏，
 * 而是算出來明示（見 concentrationNote）。
 */
function sortRows(rows, sortBy, sortDir) {
  if (sortBy === 'sector') {
    /*
     * 四鍵排序的每一鍵都要有「空值沉底」規則，否則缺 distAtr 的標的
     * 會因為 null 被當成 0 而意外排到最前面（0 是「正好在買區上緣」，
     * 是最理想的值）。
     *
     * ⚠ 這裡**不能用 isFinite()**：`isFinite(null) === true`（null 會被
     * 轉成 0），所以 `isFinite(null)` 的檢查會讓所有空值通過並以 0 參與
     * 排序——正是要防的那個錯誤。必須先排除 null/undefined/空字串。
     */
    const numOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));

    const rankOf = (r) => { const v = numOrNull(r.sectorRank); return v == null ? Number.MAX_SAFE_INTEGER : v; };
    // 方向：desc 鍵缺值視為最小、asc 鍵缺值視為最大，兩者都沉底
    const descOf = (v) => { const n = numOrNull(v); return n == null ? -Infinity : n; };
    const ascOf = (v) => { const n = numOrNull(v); return n == null ? Infinity : n; };

    return rows.slice().sort((a, b) => {
      const r = rankOf(a) - rankOf(b);
      if (r !== 0) return r;
      const s = descOf(b.score) - descOf(a.score);
      if (s !== 0) return s;
      const d = ascOf(a.distAtr) - ascOf(b.distAtr);
      if (d !== 0) return d;
      const x = descOf(b.rrRatio) - descOf(a.rrRatio);
      if (x !== 0) return x;
      // 最後以代碼定序，讓同分標的的輸出穩定（否則每次排序結果可能不同）
      return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    });
  }

  const dir = sortDir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    const aNull = av == null || !isFinite(av);
    const bNull = bv == null || !isFinite(bv);
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (av === bv) return 0;
    return (av - bv) * dir;
  });
}

/**
 * 把版塊歸屬注入每一列，讓前端能顯示「所屬版塊／版塊名次」兩欄。
 *
 * 為什麼由呼叫端以 deps.sectorMeta 注入、而不是在 screener 內自己去算：
 *   版塊歸屬來自 sector-flow 階段二的動態池，那是已經算好的結果。
 *   若在這裡重新呼叫 getSectorIndex()，同一輪會多抓一次 11 個持股檔
 *   （實測約 3–8 秒），而結果必然相同。
 *
 * @param {Array} rows  flatten() 產出的列
 * @param {Map}   meta  Map<symbol, {key,label,rank,strengthScore,quadrant}>
 */
function attachSector(rows, meta) {
  if (!meta || typeof meta.get !== 'function') return rows;
  for (const row of rows) {
    const m = meta.get(String(row.symbol || '').toUpperCase());
    if (!m) continue;
    row.sector = m.key || null;
    row.sectorLabel = m.label || null;
    row.sectorRank = isFinite(m.rank) ? m.rank : null;
    row.sectorStrength = isFinite(m.strengthScore) ? m.strengthScore : null;
    row.sectorQuadrant = m.quadrant || null;
  }
  return rows;
}

/**
 * 集中度與「換排序會差幾檔」的對照。
 *
 * 需求要求明示「前 10 名有 7 檔來自 XLK。若改按個股評分排序，前 10 名會變動 4 檔」。
 * 這兩個數字必須真的算出來，不能寫死或省略——集中度是版塊優先排序的
 * 已知代價，使用者要靠這兩個數字判斷要「順風集中」還是「分散」。
 *
 * @param {Array} sectorSorted  已按四鍵排序的列（未截斷）
 * @returns {object|null}
 */
function concentration(sectorSorted) {
  const list = Array.isArray(sectorSorted) ? sectorSorted : [];
  if (!list.length) return null;

  const top = list.slice(0, 10);
  const bySector = {};
  for (const r of top) {
    const k = r.sector || '未知';
    bySector[k] = (bySector[k] || 0) + 1;
  }
  const ranked = Object.entries(bySector).sort((a, b) => b[1] - a[1]);
  const topSector = ranked.length ? { key: ranked[0][0], count: ranked[0][1] } : null;

  // 若改按個股評分排序，前 10 名的成員會換掉幾檔
  const scoreSorted = sortRows(list, 'score', 'desc').slice(0, 10);
  const a = new Set(top.map((r) => r.symbol));
  const b = new Set(scoreSorted.map((r) => r.symbol));
  let changed = 0;
  for (const s of a) if (!b.has(s)) changed += 1;

  return {
    topN: top.length,
    topSector,
    distribution: ranked.map(([key, count]) => ({ sector: key, count })),
    scoreSortChanged: changed,
    note: topSector
      ? `前 ${top.length} 名有 ${topSector.count} 檔來自 ${topSector.key}；`
        + `若改按個股評分排序，前 ${top.length} 名會變動 ${changed} 檔`
      : null,
  };
}

/**
 * 併發受限的批次執行器。
 *
 * 不用 Promise.all(pool.map(...))：那會同時對 500 檔 × 3 個上游請求
 * 開火，直接被限流。這裡維持固定 worker 數，一個完成才接下一個。
 */
async function runPool(items, worker, concurrency) {
  const limit = Math.max(1, Math.min(MAX_CONCURRENCY, concurrency || DEFAULT_CONCURRENCY));
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/**
 * 主流程：逐一分析 → 過濾 → 排序 → 截斷。
 *
 * @param {object} deps   { analyzer, forecast?, symbols }
 *                        由呼叫方注入，方便測試替換
 * @param {object} rawQuery  原始 query 參數
 * @param {object} hooks  { onProgress(done,total,row), concurrency, budgetMs }
 */
async function screen(deps, rawQuery, hooks = {}) {
  const norm = normalizeOptions(rawQuery);
  if (!norm.ok) {
    return {
      ok: false,
      error: { code: norm.code, message: norm.message },
      opts: null,
      rows: [],
      stats: null,
    };
  }
  const opts = norm.opts;
  const requestedPool = Array.isArray(deps.symbols) ? deps.symbols : [];

  /*
   * 中概股排除 —— 這是固定規則，不是預設值。
   *
   * 為什麼要放在 screen() 內部、而不是只靠呼叫方傳進來的 symbols 已經乾淨：
   *   deps.symbols 是外部注入的（scheduler、外部 cron、測試、未來的新端點）。
   *   若只依賴注入方自己過濾，任何一個新呼叫端忘了套用，規則就破功，
   *   而且不會有任何徵兆。這裡是最靠近「實際要分析的每一檔」的位置，
   *   放在這裡，繞過去的唯一方法是不要用 screen() —— 那等於不用選股功能。
   *
   * 為什麼排除發生在分析之前而不是之後：
   *   analyzer.analyze() 每檔要打 3 個上游請求。先排除就省下 3 個請求，
   *   而且「被排除的中概股」不會出現在 excluded 清單裡被誤讀成
   *   「因為評分不足而被排除」—— 那是兩件完全不同的事，混在一起
   *   會讓使用者以為放寬評分就能看到中概股。
   */
  const gate = require('./pool').enforceUniverse(requestedPool);
  const pool = gate.kept;

  // requirePred 需要逐檔計算 FP（多一次 10y 取數），沒有 forecast 就明確關閉，
  // 不要靜默回傳「0 檔」讓使用者以為市場上沒有符合條件的標的。
  let notes = [];
  if (gate.removed.length) {
    notes.push(`已排除中概股 ${gate.removed.length} 檔（${gate.removed.slice(0, 10).join('、')}`
      + `${gate.removed.length > 10 ? ' 等' : ''}），實際檢查 ${pool.length} 檔`);
  }
  if (gate.removedHK.length) {
    notes.push(`已排除非美股 ${gate.removedHK.length} 檔（母體僅納入美國交易所上市個股）`);
  }
  let requirePred = opts.requirePred;
  if (requirePred && !deps.forecast) {
    requirePred = false;
    notes.push('未提供預測模組，本次已忽略「僅保留預測可用」條件');
  }

  /*
   * 版塊排序模式需要版塊歸屬才有意義。
   *
   * 若使用者帶了 sortBy=sector 卻沒有走版塊流程（沒注入 sectorMeta），
   * 四鍵排序的第一鍵會全部是 MAX_SAFE_INTEGER，等於靜默退化成
   * 「按評分排序」——使用者以為自己在用版塊優先，其實沒有。
   * 這種「看起來成功、其實沒生效」的失敗最難察覺，所以明確退回並說明。
   */
  const sectorMode = opts.sortBy === 'sector';
  let effectiveSortBy = opts.sortBy;
  if (sectorMode && !(deps.sectorMeta && deps.sectorMeta.size)) {
    effectiveSortBy = 'score';
    notes.push('未提供版塊歸屬資料，本次「版塊優先」排序已退回「技術評分」排序');
  }

  const effectiveOpts = { ...opts, requirePred, sortBy: effectiveSortBy };

  const rows = [];
  const excluded = [];
  const failures = [];
  let done = 0;
  const startedAt = Date.now();
  const budgetMs = hooks.budgetMs || DEFAULT_BUDGET_MS;
  let timedOut = false;

  await runPool(pool, async (sym) => {
    if (timedOut) return;
    if (Date.now() - startedAt > budgetMs) { timedOut = true; return; }
    done++;
    try {
      const analysis = await deps.analyzer.analyze(sym);
      const row = flatten(analysis);
      if (!row) {
        failures.push({ symbol: sym, reason: '分析無結果' });
      } else {
        if (requirePred && deps.forecast) {
          try {
            // withBacktest:false —— 篩選只需要「有沒有可用區間」，
            // 不需要整份 walk-forward 回測（那會讓每檔多花 300–800ms）
            const pred = await deps.forecast.buildPrediction(
              deps.datasource || require('./datasource'),
              row.symbol || sym,
              { atrPct: row.atrPct, withBacktest: false }
            );
            row.predStatus = pred.status || null;
            row.predAdj = pred.adj || null;
          } catch (e) {
            row.predStatus = 'error';
          }
        }
        const verdict = applyFilters(row, effectiveOpts);
        if (verdict.pass) {
          row._reasons = [];
          /*
           * 版塊欄位在「通過篩選後」才注入 —— 因為被判定的行不需要版塊資訊，
           * 而 excludedSample 最多只放 40 筆，逐檔注入只是白做。
           * 另外 attachSector 是就地修改，這裡傳單一元素陣列即可。
           */
          if (deps.sectorMeta && deps.sectorMeta.size) attachSector([row], deps.sectorMeta);
          rows.push(row);
        } else {
          excluded.push({ symbol: row.symbol || sym, name: row.name, reasons: verdict.reasons, codes: verdict.codes });
        }
      }
    } catch (e) {
      // 單檔失敗不得中斷整批：這是「部分成功優於全部失敗」原則
      failures.push({ symbol: sym, reason: e.message });
    }
    if (typeof hooks.onProgress === 'function') {
      try { hooks.onProgress(done, pool.length, rows[rows.length - 1] || null); } catch (_) { /* 進度回呼不得影響主流程 */ }
    }
  }, hooks.concurrency || DEFAULT_CONCURRENCY);

  const sorted = sortRows(rows, effectiveSortBy, opts.sortDir);
  const limited = sorted.slice(0, opts.limit);

  if (timedOut) {
    notes.push(`已達單輪時間上限（${Math.round(budgetMs / 1000)} 秒），本輪僅檢查 ${done} / ${pool.length} 檔`);
  }

  return {
    ok: true,
    opts: effectiveOpts,
    rows: limited,
    stats: {
      pool: pool.length,
      requestedPool: requestedPool.length,
      checked: done,
      analyzed: done - failures.length,
      passed: sorted.length,
      returned: limited.length,
      excluded: excluded.length,
      failed: failures.length,
      truncated: sorted.length > limited.length,
      timedOut,
      elapsedMs: Date.now() - startedAt,
      /*
       * 中概股排除結果必須出現在 stats 裡，而不是只寫在 notes 的一句話。
       * notes 是給人讀的敘述，stats 是給程式與表格讀的數字；需求要求
       * 「在輸出結果中標註已排除中概股，以及因而調整的標的數量」，
       * 兩者都要有，否則前端無法把「排除數」放進統計列。
       */
      chinaExcluded: {
        count: gate.removed.length,
        symbols: gate.removed.slice(0, 60),
        requestedPool: requestedPool.length,
        effectivePool: pool.length,
        note: '固定規則：在美上市中國概念股一律不納入篩選、回測與分析',
      },
      nonUsExcluded: {
        count: gate.removedHK.length,
        symbols: gate.removedHK.slice(0, 60),
        note: '固定規則：母體僅納入在美國交易所上市的個股',
      },
      // 被排除的原因分佈，讓使用者知道「放寬哪個條件最有效」
      excludeReasons: topReasons(excluded),
      failures: failures.slice(0, 20),
      excludedSample: excluded.slice(0, 40),
      sortLabel: SORTABLE_LABEL[effectiveSortBy] || effectiveSortBy,
      /*
       * 集中度只在前端真的按版塊排序時才算 —— 那是集中度風險唯一存在的場景。
       * 按評分排序時算「若改按評分排序會差幾檔」是恆等於 0，只是噪音。
       */
      concentration: effectiveSortBy === 'sector' ? concentration(sorted) : null,
      notes,
    },
  };
}

/**
 * 統計排除原因出現次數，取前 6 名。用來回答「為什麼只有 N 檔」。
 *
 * 以原因代碼分組（而非把訊息裡的數字換成 N），輸出的是「評分低於下限」
 * 這類可直接閱讀的標籤。若拿不到代碼（例如舊快取），退回用訊息本身。
 */function topReasons(excluded) {
  const m = new Map();
  for (const e of excluded) {
    const codes = Array.isArray(e.codes) ? e.codes : [];
    const list = Array.isArray(e.reasons) ? e.reasons : [];
    // 以較長的一邊為準，避免兩個欄位長度不一致時漏計
    const n = Math.max(codes.length, list.length);
    for (let i = 0; i < n; i += 1) {
      const code = codes[i];
      const label = (code && REASON_LABEL[code]) || list[i];
      if (!label) continue; // 兩邊都缺就跳過，不要產生空字串條目
      const prev = m.get(label) || { count: 0, code: code || null };
      prev.count += 1;
      m.set(label, prev);
    }
  }
  return [...m.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([reason, meta]) => ({ reason, count: meta.count, code: meta.code }));
}

/* ==================== 落地快取 ==================== */

function cacheKey(opts) {
  const o = { ...opts };
  return Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join('&');
}

function ensureDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (_) { /* 唯讀檔案系統下靜默失敗，快取屬加分項 */ }
}

function readCache(opts, ttlMs) {
  try {
    const file = path.join(CACHE_DIR, `${cacheKey(opts).replace(/[^a-z0-9=&.-]/gi, '_')}.json`);
    if (!fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeCache(opts, payload) {
  try {
    ensureDir();
    const file = path.join(CACHE_DIR, `${cacheKey(opts).replace(/[^a-z0-9=&.-]/gi, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  } catch (_) { /* 快取失敗不影響回應 */ }
}

/**
 * 從環境變數取單輪時間上限。
 *
 * 為什麼要可設定：母體從 154 擴到 500 後，90 秒在多數情況下跑不完全池。
 * 對「使用者按下開始篩選」而言，90 秒已經太長（沒人會等）；但對
 * 「每日清單」的背景批次而言，跑完 500 檔才有意義。同一個常數要服務
 * 兩種情境是不可能的，所以讓部署端用 SCREEN_BUDGET_MS 決定背景批次的野心，
 * 互動查詢仍走較短的預設值。
 */
function budgetFromEnv(def) {
  const v = Number(process.env.SCREEN_BUDGET_MS);
  if (!isFinite(v) || v <= 0) return def;
  return Math.max(5000, Math.min(15 * 60 * 1000, v));
}

module.exports = {
  DEFAULTS,
  SORTABLE,
  SORTABLE_LABEL,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  DEFAULT_BUDGET_MS,
  budgetFromEnv,
  screen,
  normalizeOptions,
  flatten,
  applyFilters,
  sortRows,
  attachSector,
  concentration,
  topReasons,
  runPool,
  readCache,
  writeCache,
  cacheKey,
  CACHE_DIR,
};
