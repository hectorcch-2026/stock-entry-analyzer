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
 * （日線／週線／報價）。154 檔 × 3 = 462 個請求，全併發會直接被上游限流
 * （429），後果是「整批都是失敗」而不是「慢一點」。
 * 實測：併發 4 時單檔平均 0.2–0.6 秒，154 檔約 12–25 秒；併發 8 開始出現
 * 零星 429。故預設 4，上限 8。
 */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

/** 單輪篩選的硬性時間上限，避免卡住整個請求 */
const DEFAULT_BUDGET_MS = 90 * 1000;

/** 預設篩選條件。全部可被請求參數覆寫。 */
const DEFAULTS = {
  market: 'all',        // all | us | hk
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

const SORTABLE = new Set(['score', 'distAtr', 'atrPct', 'rrRatio', 'changePct', 'price', 'avgVol']);

const SORTABLE_LABEL = {
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

/** 多欄位排序。null 一律排到最後（不論 asc 或 desc），避免「空值佔滿第一頁」。 */
function sortRows(rows, sortBy, sortDir) {
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
 * 併發受限的批次執行器。
 *
 * 不用 Promise.all(pool.map(...))：那會同時對 154 檔 × 3 個上游請求
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
  const pool = Array.isArray(deps.symbols) ? deps.symbols : [];

  // requirePred 需要逐檔計算 FP（多一次 10y 取數），沒有 forecast 就明確關閉，
  // 不要靜默回傳「0 檔」讓使用者以為市場上沒有符合條件的標的。
  let notes = [];
  let requirePred = opts.requirePred;
  if (requirePred && !deps.forecast) {
    requirePred = false;
    notes.push('未提供預測模組，本次已忽略「僅保留預測可用」條件');
  }
  const effectiveOpts = { ...opts, requirePred };

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

  const sorted = sortRows(rows, opts.sortBy, opts.sortDir);
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
      checked: done,
      analyzed: done - failures.length,
      passed: sorted.length,
      returned: limited.length,
      excluded: excluded.length,
      failed: failures.length,
      truncated: sorted.length > limited.length,
      timedOut,
      elapsedMs: Date.now() - startedAt,
      // 被排除的原因分佈，讓使用者知道「放寬哪個條件最有效」
      excludeReasons: topReasons(excluded),
      failures: failures.slice(0, 20),
      excludedSample: excluded.slice(0, 40),
      sortLabel: SORTABLE_LABEL[opts.sortBy] || opts.sortBy,
      notes,
    },
  };
}

/**
 * 統計排除原因出現次數，取前 6 名。用來回答「為什麼只有 N 檔」。
 *
 * 以原因代碼分組（而非把訊息裡的數字換成 N），輸出的是「評分低於下限」
 * 這類可直接閱讀的標籤。若拿不到代碼（例如舊快取），退回用訊息本身。
 */
function topReasons(excluded) {
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

module.exports = {
  DEFAULTS,
  SORTABLE,
  SORTABLE_LABEL,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  screen,
  normalizeOptions,
  flatten,
  applyFilters,
  sortRows,
  topReasons,
  runPool,
  readCache,
  writeCache,
  cacheKey,
  CACHE_DIR,
};
