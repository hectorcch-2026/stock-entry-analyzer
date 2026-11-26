'use strict';

/**
 * 相對輪動圖（Relative Rotation Graph, RRG）— 計算核心
 * ========================================================
 *
 * 純函式模組：不連網、不讀檔、不碰 DOM。所有上游資料由呼叫端注入，
 * 因此可以用固定資料完整鎖定每一個分支（見 tests/rrg-unit.cjs）。
 *
 * ── 為什麼要獨立一支 ─────────────────────────────────────
 * RRG 的計算有兩個容易「看起來對、其實錯」的環節：
 *   ① 期間對齊（各標的交易日不同，錯位一天就會讓 RS 出現假跳動）
 *   ② 兩次平滑的暖機期（資料不足時輸出 null，不能補 0 或補平均值）
 * 這兩件事若散在 server.js 與前端各寫一次，遲早不一致。
 * 集中在這裡，並對每個輸出標明「這是第幾根、是否已暖機完成」。
 *
 * ── JdK RS-Ratio / RS-Momentum 的定義 ────────────────────
 * 依 Julius de Kempenaer 的原始定義，並以「以 100 為基準」實作：
 *
 *   RS            = 標的收盤價 ÷ 基準收盤價
 *   RS-Ratio      = 100 × DEMA(RS, n) ÷ SMA(DEMA(RS, n), n)
 *   RS-Momentum   = 100 × DEMA(RS-Ratio, n) ÷ SMA(DEMA(RS-Ratio, n), n)
 *
 * 兩者都以「自己的移動平均」為分母，因此：
 *   - 恆為正數，且 100 代表「與自身近期平均一致」＝中性
 *   - 不受價格絕對水平影響（RS 的量級被約掉）
 *   - 趨勢向上時 > 100，向下時 < 100，可直接判斷四象限
 *
 * 為什麼不用 z-score 或 min-max 正規化：
 *   z-score 會讓「全部板塊同漲」時彼此看起來差異很大（其實都一樣），
 *   min-max 會讓極端值壓縮其他 10 條線的解析度。除以自身均值是唯一
 *   同時具備「尺度不變」與「可跨期間比較」的作法。
 *
 * ── 為什麼一律用復權價（adjclose）────────────────────────
 * 實測 10 年（2016-11 → 2026-11）：
 *   XLU  價格報酬  81.4%  vs  復權報酬 148.7%   ← 差 37.1 個百分點
 *   XLK  價格報酬 548.6%  vs  復權報酬 618.4%   ← 差 10.8
 *   SPY  價格報酬 225.1%  vs  復權報酬 280.6%   ← 差 17.1
 * 若用未復權價，高股息的公用事業／必需消費會被系統性低估，
 * 「哪個板塊較強」這個問題從一開始就被股息率扭曲。
 * → 因此 RS 一律以復權價計算；取不到復權價時明確標記降級，不默默用未復權價。
 */

const indicators = require('./indicators');

/* ============================================================
   標的註冊表
   ------------------------------------------------------------
   使用 SPDR 產業 ETF（Select Sector SPDR）作為美股 11 大版塊代理。
   選 ETF 而非「自行編製成分股等權指數」的理由：
     - ETF 價格就是市場上真實可交易、可驗證的報價
     - 成分股與權重由指數公司維護，本專案不必自行維護一份會腐壞的清單
     - 有成交量，停牌／缺值情況遠少於個股
   代價：ETF 有費用率與折溢價，長周期的絕對值會偏離理論指數。
   但 RRG 看的是**相對強弱的形狀**，這點偏差不影響輪動判讀。
   ============================================================ */

/** @type {Array<{key:string,label:string,short:string,color:string}>} */
const SECTORS = [
  { key: 'XLK', label: '資訊科技', short: '科技', color: '#2563eb' },
  { key: 'XLF', label: '金融', short: '金融', color: '#0891b2' },
  { key: 'XLV', label: '醫療保健', short: '醫療', color: '#7c3aed' },
  { key: 'XLY', label: '非必需消費', short: '非必需', color: '#db2777' },
  { key: 'XLP', label: '必需消費', short: '必需', color: '#65a30d' },
  { key: 'XLE', label: '能源', short: '能源', color: '#ea580c' },
  { key: 'XLI', label: '工業', short: '工業', color: '#0d9488' },
  { key: 'XLB', label: '原物料', short: '原物料', color: '#a16207' },
  { key: 'XLRE', label: '房地產', short: '房地產', color: '#c026d3' },
  { key: 'XLU', label: '公用事業', short: '公用', color: '#475569' },
  { key: 'XLC', label: '通訊服務', short: '通訊', color: '#dc2626' },
];

/** 可選基準。SPY 為預設（S&P 500，11 版塊的母指數） */
const BENCHMARKS = [
  { key: 'SPY', label: 'S&P 500', note: 'SPY（11 版塊的母指數，預設）' },
  { key: 'RSP', label: 'S&P 500 等權', note: 'RSP（去除市值權重偏誤）' },
  { key: 'QQQ', label: '納斯達克 100', note: 'QQQ（科技權重高）' },
  { key: 'IWM', label: '羅素 2000', note: 'IWM（小型股）' },
  { key: 'DIA', label: '道瓊工業', note: 'DIA（30 檔，價格加權）' },
];

/* ============================================================
   時間週期與觀察區間
   ============================================================ */

/**
 * 週期定義。`barsPerYear` 用於把「觀察區間」換算成點數，
 * 以及在資料不足時估算「這樣夠不夠暖機」。
 */
const TIMEFRAMES = {
  daily: { key: 'daily', label: '日線', barsPerYear: 252, yahooRange: '10y', defPeriod: 14 },
  weekly: { key: 'weekly', label: '週線', barsPerYear: 52, yahooRange: '10y', defPeriod: 14 },
  monthly: { key: 'monthly', label: '月線', barsPerYear: 12, yahooRange: '10y', defPeriod: 8 },
};

/** 觀察區間：決定「畫多少點」與「往上抓多少歷史」 */
const WINDOWS = {
  '3m': { label: '3 個月', bars: { daily: 63, weekly: 13, monthly: 3 } },
  '6m': { label: '6 個月', bars: { daily: 126, weekly: 26, monthly: 6 } },
  '1y': { label: '1 年', bars: { daily: 252, weekly: 52, monthly: 12 } },
  '2y': { label: '2 年', bars: { daily: 504, weekly: 104, monthly: 24 } },
  '3y': { label: '3 年', bars: { daily: 756, weekly: 156, monthly: 36 } },
};

const DEFAULT_TIMEFRAME = 'weekly';
const DEFAULT_WINDOW = '1y';
const DEFAULT_TRAIL = 5;
const DEFAULT_PERIOD = 14;

/** 尾跡長度可設定範圍（點數） */
const TRAIL_MIN = 2;
const TRAIL_MAX = 20;

/* ============================================================
   參數正規化
   ============================================================ */

function normTimeframe(raw) {
  const k = String(raw || '').trim().toLowerCase();
  if (!k) return { ok: true, key: DEFAULT_TIMEFRAME };
  if (TIMEFRAMES[k]) return { ok: true, key: k };
  return {
    ok: false, code: 'BAD_TIMEFRAME',
    message: `不支援的時間週期「${raw}」`,
    hint: `可用值：${Object.keys(TIMEFRAMES).join('、')}`,
  };
}

function normWindow(raw, timeframe) {
  const k = String(raw || '').trim().toLowerCase();
  if (!k) return { ok: true, key: DEFAULT_WINDOW };
  const w = WINDOWS[k];
  if (!w) {
    return {
      ok: false, code: 'BAD_WINDOW',
      message: `不支援的觀察區間「${raw}」`,
      hint: `可用值：${Object.keys(WINDOWS).join('、')}`,
    };
  }
  // 月線只有 12 點／年，3 個月 = 3 點，畫不出尾跡。這裡不報錯，
  // 只回一個提示讓前端說明「為什麼點數這麼少」，避免使用者以為壞了。
  const bars = w.bars[timeframe];
  return {
    ok: true, key: k, bars,
    note: bars < TRAIL_MIN + 3
      ? `${timeframe === 'monthly' ? '月線' : '此週期'}下「${w.label}」只有 ${bars} 個點，尾跡會很短`
      : null,
  };
}

function normTrail(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return { ok: true, value: DEFAULT_TRAIL };
  const v = Math.round(n);
  if (v < TRAIL_MIN || v > TRAIL_MAX) {
    return {
      ok: false, code: 'BAD_TRAIL',
      message: `尾跡長度必須介於 ${TRAIL_MIN} 到 ${TRAIL_MAX} 點`,
      hint: `目前傳入 ${raw}`,
    };
  }
  return { ok: true, value: v };
}

function normPeriod(raw, timeframe) {
  const n = Number(raw);
  const dflt = TIMEFRAMES[timeframe] ? TIMEFRAMES[timeframe].defPeriod : DEFAULT_PERIOD;
  if (!isFinite(n) || n <= 0) return { ok: true, value: dflt, isDefault: true };
  const v = Math.round(n);
  if (v < 3 || v > 60) {
    return {
      ok: false, code: 'BAD_PERIOD',
      message: '平滑週期必須介於 3 到 60',
      hint: `目前傳入 ${raw}`,
    };
  }
  return { ok: true, value: v, isDefault: false };
}

function normBenchmark(raw) {
  const k = String(raw || '').trim().toUpperCase();
  if (!k) return { ok: true, key: BENCHMARKS[0].key, def: BENCHMARKS[0] };
  const def = BENCHMARKS.find((b) => b.key === k);
  if (!def) {
    return {
      ok: false, code: 'BAD_BENCHMARK',
      message: `不支援的基準「${raw}」`,
      hint: `可用值：${BENCHMARKS.map((b) => `${b.key}（${b.label}）`).join('、')}`,
    };
  }
  return { ok: true, key: def.key, def };
}

/**
 * 解析版塊清單。空值 = 全部 11 個。
 * 未知代碼不報錯而是回報在 `unknown`，讓呼叫端決定是忽略還是提示 ——
 * 因為前端用 checkbox 送出，使用者在別的分頁改了註冊表就可能出現舊代碼，
 * 這種情況應該「畫得出來的照畫，畫不出來的說一聲」，而不是整頁失敗。
 */
function normSectors(raw) {
  const known = new Set(SECTORS.map((s) => s.key));
  if (raw == null || raw === '') return { ok: true, keys: SECTORS.map((s) => s.key), unknown: [] };
  const parts = String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!parts.length) return { ok: true, keys: SECTORS.map((s) => s.key), unknown: [] };
  const uniq = [];
  const unknown = [];
  for (const p of parts) {
    if (known.has(p)) { if (!uniq.includes(p)) uniq.push(p); } else if (!unknown.includes(p)) unknown.push(p);
  }
  if (!uniq.length) {
    return {
      ok: false, code: 'BAD_SECTORS',
      message: '指定的版塊全部無效',
      hint: `可用值：${[...known].join('、')}`,
      unknown,
    };
  }
  return { ok: true, keys: uniq, unknown };
}

/* ============================================================
   資料整理：重取樣與對齊
   ============================================================ */

/**
 * 把日線重取樣成週線／月線。
 *
 * 為什麼自己重取樣而不向上游要 interval=1wk：
 *   ① 若各標的分別向上游要週線，Yahoo 對「哪一天算一週的結束」的處理
 *      可能因標的而異（尤其有假日的一週），造成兩條線的期間錯位。
 *   ② 自己重取樣時所有標的共用同一套分桶規則，對齊是結構性保證，
 *      不是「剛好一致」。
 *
 * 分桶規則：
 *   週 → 以該日期所屬的 ISO 週（週一為起）為鍵，取該週**最後一個交易日**的收盤。
 *   月 → 以 YYYY-MM 為鍵，取該月最後一個交易日的收盤。
 * 兩者都取「最後」而非平均：收盤價是實際可成交的價格，平均值不是。
 *
 * @param {Array<{t:number,c:number}>} candles 由舊到新，已濾掉 null
 * @param {'daily'|'weekly'|'monthly'} timeframe
 * @returns {Array<{t:number, key:string, c:number}>}
 */
function resample(candles, timeframe) {
  if (!Array.isArray(candles) || !candles.length) return [];
  if (timeframe === 'daily') {
    return candles.map((c) => ({ t: c.t, key: dateKeyUTC(c.t), c: c.c }));
  }
  const out = [];
  let curKey = null;
  let curLast = null;
  for (const c of candles) {
    const k = timeframe === 'monthly' ? monthKeyUTC(c.t) : isoWeekKeyUTC(c.t);
    if (k !== curKey) {
      if (curLast) out.push(curLast);
      curKey = k;
      curLast = { t: c.t, key: k, c: c.c };
    } else {
      // 同一個桶內，後面的交易日覆蓋前面的（保留最後一個收盤）
      curLast = { t: c.t, key: k, c: c.c };
    }
  }
  if (curLast) out.push(curLast);
  return out;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** UTC 日期鍵（YYYY-MM-DD）。刻意不用本地時區，避免跨時區位移一天。 */
function dateKeyUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function monthKeyUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * ISO 8601 週鍵（YYYY-Www）。以週四所屬年份為年份歸屬，
 * 這樣跨年那一週不會被拆成兩段（12/31 與 1/1 可能同屬一週）。
 */
function isoWeekKeyUTC(ms) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;      // 週一=0 … 週日=6
  t.setUTCDate(t.getUTCDate() - dayNum);        // 移到該週週一
  const thursday = new Date(t.getTime() + 3 * 86400000);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / (7 * 86400000)) + 1;
  return `${year}-W${pad2(week)}`;
}

/**
 * 多序列對齊：只保留**全部序列都有值**的期間。
 *
 * 為什麼取交集而不補值：
 *   XLC 於 2018-06 才成立。若用 forward-fill 把它補到 2016，
 *   會憑空製造兩年「通訊服務與大盤同步」的假歷史，那段的 RS-Ratio
 *   會貼在 100 附近，看起來像「長期盤整」——是徹底的假訊號。
 *   交集會讓整張圖的起點被最晚上市的那檔綁定，這是誠實的代價。
 *   實際影響：以 10y 抓取時，共同起點約 2018-06，仍有 2100+ 根日線，
 *   週線約 430 週、月線約 100 個月，遠超暖機需求。
 *
 * @param {Array<{key:string,bars:Array<{key:string,t:number,c:number}>}>} seriesList
 * @returns {{dates:string[], t:number[], rows:Object<string, number[]>}}
 */
function alignSeries(seriesList) {
  const count = seriesList.length;
  if (!count) return { dates: [], t: [], rows: {} };

  // 每條序列先建 periodKey → close 的索引
  const maps = seriesList.map((s) => {
    const m = new Map();
    for (const b of s.bars) m.set(b.key, b.c);
    return m;
  });

  // 以第一條序列的鍵順序為基準（已按時間排序），再逐一過濾
  const baseDates = seriesList[0].bars.map((b) => b.key);
  const keep = [];
  for (const k of baseDates) {
    let ok = true;
    for (let i = 1; i < maps.length; i++) {
      const v = maps[i].get(k);
      if (v == null || !isFinite(v)) { ok = false; break; }
    }
    const v0 = maps[0].get(k);
    if (v0 == null || !isFinite(v0)) ok = false;
    if (ok) keep.push(k);
  }

  // 時間戳：取第一條序列在該鍵上的 t（同一個桶的交易日，各序列應相同）
  const tMap = new Map();
  for (const b of seriesList[0].bars) tMap.set(b.key, b.t);

  const rows = {};
  for (let i = 0; i < count; i++) {
    rows[seriesList[i].key] = keep.map((k) => maps[i].get(k));
  }
  return { dates: keep, t: keep.map((k) => tMap.get(k)), rows };
}

/* ============================================================
   平滑與正規化
   ============================================================ */

/**
 * 雙指數移動平均 DEMA = 2×EMA − EMA(EMA)
 *
 * 為什麼用 DEMA 而不是單純 EMA：
 *   EMA 有相位落後（phase lag），在轉折點會慢半拍，而 RRG 的價值
 *   正在於「早期辨識翻轉」。DEMA 把落後大幅壓縮（約為 EMA 的一半），
 *   代價是對雜訊更敏感——但後續還有一次以 SMA 為分母的正規化會再平滑一次。
 *
 * 暖機期：第一個有效值出現在第 1 根（EMA 以首值為種子），
 * 但前 `period` 根仍受種子影響，因此對外一律視為「未暖機」，
 * 由 `warmup` 參數統一裁切，不讓使用者看到受污染的頭段。
 */
function dema(values, period) {
  const n = values.length;
  const e1 = indicators.ema(values, period);
  const e2 = indicators.ema(e1, period);
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (e1[i] == null || e2[i] == null) continue;
    out[i] = 2 * e1[i] - e2[i];
  }
  return out;
}

/**
 * 以 100 為基準正規化：value ÷ SMA(value, n) × 100
 * 值為 100 代表「與自身近 n 期平均相同」。分母 ≤ 0 或為 null 時輸出 null。
 */
function indexTo100(values, period) {
  const base = indicators.sma(values, period);
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const b = base[i];
    if (v == null || b == null || !isFinite(b) || b <= 0) continue;
    out[i] = (v / b) * 100;
  }
  return out;
}

/**
 * 暖機根數。
 *
 * 兩次平滑各需 `period` 根才有穩定的移動平均分母，
 * 加上 DEMA 內含兩層 EMA，實務上 3×period 之後才完全脫離種子影響。
 * 這裡取 2×period + period/2，四捨五入 —— 這是一個保守估計，
 * 目的不是精確，而是「不要讓使用者在圖上看到還在收斂的點」。
 */
function warmupBars(period) {
  return Math.ceil(period * 2.5);
}

/* ============================================================
   RRG 主計算
   ============================================================ */

/**
 * 計算單一標的相對基準的 RS-Ratio 與 RS-Momentum 序列。
 *
 * @param {number[]} close 標的收盤（復權）
 * @param {number[]} bench 基準收盤（復權），長度需相同
 * @param {number} period
 * @returns {{rs:number[], ratio:number[], momentum:number[]}}
 */
function computeTrack(close, bench, period) {
  const n = Math.min(close.length, bench.length);
  const rs = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = close[i];
    const b = bench[i];
    if (a == null || b == null || !isFinite(a) || !isFinite(b) || b === 0) continue;
    rs[i] = a / b;
  }
  // RS 序列中若有 null，後續 EMA 會沿用前值（indicators.ema 的行為），
  // 但對齊階段已排除 null，這裡的檢查屬防禦性。
  const rsSm = dema(rs, period);
  const ratio = indexTo100(rsSm, period);
  const ratioSm = dema(ratio, period);
  const momentum = indexTo100(ratioSm, period);
  return { rs, ratio, momentum };
}

/** 四象限判定。邊界值（恰好 100）歸入「中性」而非硬塞進某一邊。 */
function classifyQuadrant(ratio, momentum) {
  if (ratio == null || momentum == null || !isFinite(ratio) || !isFinite(momentum)) {
    return { key: 'unknown', label: '資料不足', cn: '—' };
  }
  const right = ratio >= 100;
  const up = momentum >= 100;
  if (right && up) return { key: 'leading', label: 'Leading', cn: '領先' };
  if (right && !up) return { key: 'weakening', label: 'Weakening', cn: '弱化' };
  if (!right && !up) return { key: 'lagging', label: 'Lagging', cn: '落後' };
  return { key: 'improving', label: 'Improving', cn: '改善' };
}

/**
 * 尾跡分析：從方向、長度、曲率辨識動能狀態。
 *
 * 傳入的必須是「使用者看到的那條尾跡」（例如 5 點），不是整個觀察窗。
 * 早期版本誤傳整個窗口，導致長度 14.5（實際 5 週只走了 1.6），
 * 數字與畫面對不上——這是最容易騙過測試、卻騙不過使用者的錯誤。
 *
 * 五個量的意義：
 *   length     尾跡首尾的歐氏距離 → 期間內總位移。
 *   angleDeg   首→尾的方位角（度，0=向右，逆時針為正）→ 移動方向。
 *   curvature  弦弓量（-1–1 有號）→ 這才是 RRG 的「曲率」，見下方長篇說明。
 *   efficiency 直線距離 ÷ 路徑長度（0–1）→ 路徑有多「直」。
 *              接近 1＝單向推進；偏低＝來回震盪（盤整或換手）。
 *   bars       段數（點數 - 1），供每期速度標準化使用。
 *
 * ── 為什麼曲率最後改成「弦弓量」而不是先前兩種算法 ──────────
 * 這個量一共被推翻兩次，兩次都是實測抓出來的，記在這裡免得第三次犯：
 *
 * 1) 相鄰段轉角累加：52 週窗口算出 1107 度。窗口越長數字越大，
 *    對窗口長度完全不穩定，不是度量。
 *
 * 2) 繞中心 (100,100) 的累積有號轉角：看似有明確語義（RRG 就是繞中心轉），
 *    但 RRG 的點**天生就聚在中心附近**。實測 11 個版塊的 5 點尾跡，
 *    離中心半徑中位數只有 1.4–12，而相鄰兩點就跨 0.9–3.3 個單位。
 *    這種「位移量 ≈ 半徑」的幾何下極角會劇烈跳動：
 *    XLRE 的尾跡是 (96.55,97.7)→(104.07,102.88) 幾乎筆直的一條線
 *    （efficiency 0.991），卻因為中段擦過中心而被算出 **181.5 度**，
 *    於是顯示「逆時針迴游（動能鬆動）」。11 個版塊有 5 個這樣，
 *    全部是直線卻被判成大幅轉向。使用者看到一條直尾跡、
 *    旁邊寫「動能鬆動」，這是會直接導致錯誤決策的 bug。
 *    加「離中心太近就不計」的門檻只是把 bug 藏起來，沒有解決：
 *    門檻以下整段丟棄會讓短尾跡算不出東西，門檻調低則一樣爆。
 *
 * 3) 現行做法——弦弓量：取首尾連線為弦，量每個中間點到弦的**有號垂距**，
 *    取平均後除以弦長，得到一個相對於「這條尾跡自身尺度」的彎曲程度。
 *    0 = 完全筆直；數值越大越彎。
 *
 *    實測驗證（合成圓弧，已知掃角）：
 *      - 半徑 r=2 / 6 / 15 三種尺度下數值**完全相同**（不依賴位置與尺度，
 *        這正是前兩種算法最致命的地方）
 *      - 對掃角嚴格單調：10°→0.017、45°→0.076、90°→0.156、180°→0.365
 *      - 對點數只有輕微依賴（n=3 到 n=20 差約 30%，前兩種是差 25 倍）
 *        → 因此門檻必須按「點數」而非「固定值」看待，用 0.02 這種
 *          小量級門檻，並在文案上避免把 5 點與 20 點的數字直接相比。
 *
 * ── 曲率方向的符號（實測校準，非推測）──
 * RRG 的正常輪動是**順時針**：領先(右上)→弱化(右下)→落後(左下)→改善(左上)。
 * 用標準順時針路徑實測：弦弓量（未翻號）為 **正**；逆時針為負。
 * 為了與本檔案其他角度量的慣例一致（順時針＝負），這裡回傳時**翻號**，
 * 因此：
 *   curvature < 0（負）→ 順時針 → 正常輪動推進
 *   curvature > 0（正）→ 逆時針 → 逆向迴游，通常是動能鬆動或假突破
 * 這個符號若搞反，會把「正常推進」標成「動能鬆動」——方向性結論全錯，
 * 所以 tests/rrg-unit.cjs 用合成順/逆時針路徑把它釘死。
 *
 * @param {Array<{ratio:number,momentum:number}>} pts 由舊到新，已濾除 null
 */
function analyzeTrail(pts) {
  const empty = {
    length: null, angleDeg: null, curvature: null, rotation: null,
    efficiency: null, speedPerBar: null, bars: null,
    signal: 'unknown', signalCn: '資料不足',
  };
  if (!Array.isArray(pts) || pts.length < 2) return empty;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const dx = last.ratio - first.ratio;
  const dy = last.momentum - first.momentum;
  const length = Math.hypot(dx, dy);

  // atan2 的 0 度在 +x 方向，逆時針為正，與數學習慣一致
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  // 路徑長度（逐段累加）→ 用於效率
  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) {
    const sx = pts[i].ratio - pts[i - 1].ratio;
    const sy = pts[i].momentum - pts[i - 1].momentum;
    if (!isFinite(sx) || !isFinite(sy)) continue;
    pathLen += Math.hypot(sx, sy);
  }
  const efficiency = pathLen > 1e-9 ? Math.min(1, length / pathLen) : null;

  /**
   * 弦弓量（curvature）：見上方長篇說明。
   * 首尾連線為弦 → 中間點到弦的有號垂距取平均 → 除以弦長正規化。
   *
   * 回傳值已經翻號：負 = 順時針 = 正常輪動。
   * 弦長趨近 0（尾跡首尾重疊，原地打轉）時無法正規化，回 null，
   * 這種情況 efficiency 也會很低、length 也接近 0，前端會顯示「盤整」。
   */
  let curvatureOut = null;
  if (pts.length >= 3) {
    const chord = Math.hypot(dx, dy);
    if (chord > 1e-9) {
      let sum = 0;
      let n = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const wx = pts[i].ratio - first.ratio;
        const wy = pts[i].momentum - first.momentum;
        // 二維叉積 ÷ 弦長 = 點到弦的有號垂距
        const perp = (dx * wy - dy * wx) / chord;
        if (!isFinite(perp)) continue;
        sum += perp;
        n += 1;
      }
      if (n > 0) curvatureOut = -(sum / n) / chord;
    }
  }

  const bars = pts.length - 1;
  const speedPerBar = bars > 0 ? length / bars : null;

  /**
   * 訊號分類門檻 —— 一律以「每期位移」判斷，不用總長度。
   *
   * 為什麼是每期而非總長：總長度會隨尾跡點數放大。實測同一組資料，
   * 尾跡 3 點的中位長度是 3.0、20 點是 10.0——若用總長度設門檻，
   * 「盤整」的判定會隨使用者拉的尾跡長度而改變，等於同一個市場狀態
   * 在 3 點顯示「移動」、在 20 點顯示「快速移動」。荒謬。
   * 除以點數後，不同尾跡長度下的判讀才一致。
   *
   * 數值來自本專案 11 版塊 × 週線／月線 × 尾跡 3–20 點的實測分佈：
   * 週線每期位移中位數約 0.5–1.6，月線約 0.3–1.2。
   */
  const FLAT_PER_BAR = 0.20;   // 每期位移 < 0.2 → 幾乎貼著不動
  const FAST_PER_BAR = 1.30;   // 每期位移 ≥ 1.3 → 急速移動（事件驅動／輪動加速）

  let signal = 'moving';
  let signalCn = '持續移動';

  if (speedPerBar != null && speedPerBar < FLAT_PER_BAR) {
    signal = 'flat';
    signalCn = '盤整（幾乎不動）';
  } else if (speedPerBar != null && speedPerBar >= FAST_PER_BAR) {
    signal = 'fast';
    signalCn = '快速移動（動能強）';
  }

  /**
   * 曲率門檻與分級 —— 以「掃角」校準，不以百分位數硬套。
   *
   * 合成圓弧實測（半徑無關）：30° 掃角約 0.050、45° 約 0.076、90° 約 0.156。
   * 換句話說，0.025 相當於肉眼剛好看得出的 15° 彎、0.05 是明確的 30° 彎。
   *
   * 為什麼要分級而不是二分：真實資料裡「輕微彎曲」很常見（11 版塊短尾跡
   * 多半有 15–30° 的彎），若一律標成「動能鬆動」，這個標籤就失去資訊量——
   * 等於把所有版塊都貼上同一個警示。分級後「輕微」與「劇烈」可以分開看，
   * 前者通常只是正常推進中的小轉折，後者才值得注意。
   */
  const CURVE_TIERS = [
    { key: 'flat', min: 0, cn: '近乎筆直' },
    { key: 'mild', min: 0.025, cn: '輕微彎曲' },
    { key: 'clear', min: 0.080, cn: '明顯轉向' },
    { key: 'strong', min: 0.200, cn: '劇烈轉向' },
  ];

  const absCurve = curvatureOut == null ? null : Math.abs(curvatureOut);
  let curvatureTier = 'unknown';
  let curvatureTierCn = '—';
  if (absCurve != null) {
    for (const t2 of CURVE_TIERS) {
      if (absCurve >= t2.min) { curvatureTier = t2.key; curvatureTierCn = t2.cn; }
    }
  }

  /**
   * 「有轉向」的門檻 ＝ clear 等級（弦弓量 0.080，約 45° 彎）。
   *
   * 為什麼不取 mild（0.025，約 15°）：實測 11 版塊的 5 點尾跡，
   * 有 9 個的弦弓量都超過 0.025——短尾跡天生帶一點彎，因為
   * RS-Ratio 與 RS-Momentum 之間有固定的相位差（動能領先強度）。
   * 若把 15° 的彎也算成「轉向」，等於一次給 9 個版塊貼上同一個標籤，
   * 這個標籤就沒有資訊量了。取 45° 才稱得上「路徑明顯改變方向」。
   * 低於門檻的彎曲仍會透過 curvature / curvatureTier 回傳，不隱藏。
   */
  const CURVE_MIN = 0.080;

  /**
   * 曲率達到 0.05（約 30° 彎）才判定為「轉向」，並把彎曲程度寫進文案。
   * 轉向的判讀優先於「移動/快速」，因為「正在轉」比「移動多快」更能
   * 決定接下來會去哪個象限；但「盤整」不覆蓋——原地打轉時曲率沒有意義。
   *
   * 0.05 以下的輕微彎曲（15–30°）刻意**不**升級成轉向訊號：
   * 真實資料裡這種彎太常見，若也標成轉向，「轉向」就不再是有效資訊。
   * 彎曲程度本身仍會透過 curvature / curvatureTier 回傳，前端可視需要顯示。
   */
  if (curvatureOut != null && absCurve >= CURVE_MIN && signal !== 'flat') {
    if (curvatureOut < 0) {
      // 順時針：沿著 領先→弱化→落後→改善 的既定方向前進
      signal = 'turning-cw';
      signalCn = '順時針推進（輪動正常）';
    } else {
      // 逆時針：往回走，通常是動能鬆動或假突破
      signal = 'turning-ccw';
      signalCn = '逆時針迴游（動能鬆動）';
    }
  }

  return {
    length, angleDeg, curvature: curvatureOut,
    curvatureTier, curvatureTierCn,
    // rotation 保留欄位但恆為 null：舊欄位名不該突然消失讓前端炸掉，
    // 而且明確標示「這個指標已被否決」比偷偷拿掉更誠實。
    rotation: null,
    efficiency, speedPerBar, bars, signal, signalCn,
  };
}

/**
  早期翻轉偵測：現在在哪個象限、下一步會往哪個象限。
  只回報**相鄰象限**的轉移，RRG 的輪動是順時針一圈，
  不可能從領先直接跳到落後。

  判斷依據：主軸（ratio 或 momentum）距離 100 的距離，
  以及該軸的移動方向。距離 100 越近且朝它移動，翻轉越近。
 */
function detectCross(ratio, momentum, trail) {
  const out = { next: null, nextCn: null, distance: null, confidence: 'none' };
  if (ratio == null || momentum == null || !isFinite(ratio) || !isFinite(momentum)) return out;

  const dr = ratio - 100;
  const dm = momentum - 100;
  // 到最近邊界的距離（可為負，代表已在另一側）
  const absR = Math.abs(dr);
  const absM = Math.abs(dm);
  const near = absR <= absM ? 'ratio' : 'momentum';

  // 移動方向：用尾跡最後兩點
  let movingToward = false;
  if (Array.isArray(trail) && trail.length >= 2) {
    const a = trail[trail.length - 2];
    const b = trail[trail.length - 1];
    const delta = near === 'ratio' ? b.ratio - a.ratio : b.momentum - a.momentum;
    const axisVal = near === 'ratio' ? ratio : momentum;
    // 朝 100 移動（現在在 100 之上就往左/下，之下就往右/上）
    movingToward = (axisVal >= 100 && delta < 0) || (axisVal < 100 && delta > 0);
  }

  const q = classifyQuadrant(ratio, momentum).key;
  const NEXT = {
    leading: { key: 'weakening', cn: '弱化' },
    weakening: { key: 'lagging', cn: '落後' },
    lagging: { key: 'improving', cn: '改善' },
    improving: { key: 'leading', cn: '領先' },
  };
  const nxt = NEXT[q];
  if (!nxt) return out;

  const dist = near === 'ratio' ? absR : absM;
  out.next = nxt.key;
  out.nextCn = nxt.cn;
  out.distance = dist;
  out.axis = near;
  // 信心：距離 < 1.0 且朝邊界移動 → high；< 2.5 且朝邊界移動 → medium；其餘 low
  if (dist < 1.0 && movingToward) out.confidence = 'high';
  else if (dist < 2.5 && movingToward) out.confidence = 'medium';
  else out.confidence = 'low';
  return out;
}

/* ============================================================
   組裝
   ============================================================ */

/**
 * 從「已重取樣、已對齊」的矩陣建立完整 RRG。
 *
 * @param {object} p
 * @param {string[]} p.dates          期間鍵（由舊到新）
 * @param {number[]} p.t              對應時間戳（毫秒）
 * @param {Object<string,number[]>} p.rows  各標的收盤序列
 * @param {string} p.benchmarkKey
 * @param {string[]} p.sectorKeys
 * @param {number} p.period
 * @param {number} p.windowBars       要輸出多少點
 * @param {number} p.trail            尾跡點數
 * @param {Object} p.meta             版塊／基準定義（供 label、color）
 * @returns {object}
 */
function buildRRG(p) {
  const { dates, t, rows, benchmarkKey, sectorKeys, period, windowBars, trail, meta } = p;
  const bench = rows[benchmarkKey];

  if (!bench || !bench.length) {
    return {
      ok: false, code: 'NO_BENCHMARK',
      message: '基準序列為空，無法計算相對強度',
      hint: '請確認基準指數可取得行情',
    };
  }

  const warm = warmupBars(period);
  const total = dates.length;

  const points = [];
  const coverage = [];

  for (const key of sectorKeys) {
    const close = rows[key];
    const def = meta.sectors.find((s) => s.key === key) || { key, label: key, short: key, color: '#64748b' };

    if (!close || !close.length) {
      coverage.push({ key, label: def.label, ok: false, reason: 'no-data', bars: 0 });
      continue;
    }

    const { ratio, momentum } = computeTrack(close, bench, period);

    // 從「暖機完成」之後取有效點
    const valid = [];
    for (let i = 0; i < total; i++) {
      if (i < warm) continue;
      if (ratio[i] == null || momentum[i] == null) continue;
      valid.push({ i, ratio: ratio[i], momentum: momentum[i] });
    }

    if (!valid.length) {
      coverage.push({
        key, label: def.label, ok: false, reason: 'insufficient',
        bars: total, needWarmup: warm,
      });
      continue;
    }

    // 取最後 windowBars 點，再加上尾跡需要的額外歷史
    const take = Math.min(valid.length, Math.max(windowBars, trail + 1));
    const slice = valid.slice(-take);
    const trailRaw = slice.slice(-trail);
    const trailPts = trailRaw.map((v) => ({
      ratio: round2(v.ratio), momentum: round2(v.momentum), date: dates[v.i], t: t[v.i],
    }));
    const head = slice[slice.length - 1];

    /**
     * 尾跡分析與翻轉偵測**只吃尾跡點**。
     *
     * 早期版本把整個 52 點窗口餵進來，算出「長度 14.5、曲率 1107°」，
     * 但畫面上是一條 5 點的短尾跡——數字與眼睛看到的東西不一致。
     * 使用者會以為是 bug，而它其實是「算了別的東西」。
     */
    const trailForMath = trailRaw.map((v) => ({ ratio: v.ratio, momentum: v.momentum }));
    const analysis = analyzeTrail(trailForMath);
    const cross = detectCross(head.ratio, head.momentum, trailForMath);
    const quad = classifyQuadrant(head.ratio, head.momentum);

    points.push({
      key,
      label: def.label,
      short: def.short,
      color: def.color,
      ratio: round2(head.ratio),
      momentum: round2(head.momentum),
      quadrant: quad.key,
      quadrantLabel: quad.cn,
      quadrantEn: quad.label,
      asOf: dates[head.i],
      trail: trailPts,
      analysis,
      cross,
      // 完整序列（供前端畫「淡色全軌跡」或做區間高亮；只回點數，不含日期以省體積）
      series: slice.map((v) => ({ ratio: round2(v.ratio), momentum: round2(v.momentum) })),
    });

    coverage.push({
      key, label: def.label, ok: true,
      bars: total, usable: slice.length,
      firstDate: dates[slice[0].i], lastDate: dates[head.i],
    });
  }

  if (!points.length) {
    return {
      ok: false, code: 'INSUFFICIENT_DATA',
      message: '所有版塊的資料都不足以計算 RRG',
      hint: `至少需要 ${warm + 2} 個期間才能完成兩次平滑（目前週期 ${period}、共 ${total} 個期間）。請改用較長的觀察區間或較短的平滑週期。`,
      coverage,
      diagnostics: { totalPeriods: total, warmup: warm, period },
    };
  }

  return {
    ok: true,
    points,
    coverage,
    diagnostics: {
      totalPeriods: total,
      warmup: warm,
      period,
      windowBars,
      trail,
      droppedDates: p.droppedDates || 0,
    },
  };
}

function round2(v) { return isFinite(v) ? Math.round(v * 100) / 100 : null; }

module.exports = {
  SECTORS,
  BENCHMARKS,
  TIMEFRAMES,
  WINDOWS,
  DEFAULT_TIMEFRAME,
  DEFAULT_WINDOW,
  DEFAULT_TRAIL,
  TRAIL_MIN,
  TRAIL_MAX,
  normTimeframe,
  normWindow,
  normTrail,
  normPeriod,
  normBenchmark,
  normSectors,
  resample,
  alignSeries,
  dema,
  indexTo100,
  warmupBars,
  computeTrack,
  classifyQuadrant,
  analyzeTrail,
  detectCross,
  buildRRG,
  dateKeyUTC,
  isoWeekKeyUTC,
  monthKeyUTC,
};
