'use strict';

/**
 * 資料來源調度層 —— 對外提供與 lib/yahoo 相同的介面，
 * 內部自動在多個行情來源之間選擇，讓上層（analyzer / server）無須感知來源差異。
 *
 * 來源優先序：
 *   1. Yahoo Finance  —— 資料最完整（含新聞）
 *   2. 東方財富       —— 涵蓋美股與港股，無 IP 限制
 *   3. 騰訊行情       —— 最後備援；實測部署沙箱僅放行此來源
 *
 * 自適應排序：記住上次成功的來源並優先嘗試，
 * 讓「某來源在當前網路環境不可用」的情況只需付一次探測成本。
 *
 * 為何需要多來源：不同部署環境的對外網路政策不同。
 * 實測本機可直連三者；雲端沙箱則僅騰訊可達（Yahoo 回 429、東方財富連線被拒）。
 */

const yahoo = require('./yahoo');
const em = require('./eastmoney');
const tencent = require('./tencent');
const alias = require('./alias');

/**
 * 強制指定來源（除錯／驗證用）：DATA_SOURCE=yahoo|eastmoney|tencent。
 * 未設定時為自動模式。
 */
const FORCE = String(process.env.DATA_SOURCE || '').toLowerCase();

const ALL = [
  { name: 'yahoo', mod: yahoo },
  { name: 'eastmoney', mod: em },
  { name: 'tencent', mod: tencent },
];

// 上一次成功使用的來源
let lastSource = null;

/**
 * 來源熔斷（circuit breaker）
 *
 * 部署環境常會「整體封鎖」某個來源（例如沙箱對 Yahoo 一直回 429、
 * 對東方財富連線被拒）。若每次都從頭嘗試，每個請求都要付出數秒逾時代價。
 * 這裡在來源失敗後將其冷卻一段時間，冷卻期內直接略過，改由其他來源接手。
 */
const PENALTY_MS = 5 * 60 * 1000;   // 冷卻 5 分鐘
const penalty = new Map();          // name -> 解除時間戳

function isPenalized(name) {
  const until = penalty.get(name);
  if (!until) return false;
  if (Date.now() > until) { penalty.delete(name); return false; }
  return true;
}
function penalize(name) { penalty.set(name, Date.now() + PENALTY_MS); }
function clearPenalty(name) { penalty.delete(name); }

/** 依「上次成功者優先 → 未冷卻者優先」重排來源順序 */
function orderedProviders() {
  if (FORCE) return ALL.filter((p) => p.name === FORCE);

  const base = ALL.slice();
  // 已冷卻者排到最後，但不完全排除（冷卻到期或全數失敗時仍可嘗試）
  base.sort((a, b) => (isPenalized(a.name) ? 1 : 0) - (isPenalized(b.name) ? 1 : 0));

  if (!lastSource) return base;
  const preferred = base.find((p) => p.name === lastSource);
  if (!preferred) return base;
  return [preferred, ...base.filter((p) => p.name !== lastSource)];
}

/** 判斷錯誤是否屬於「可換來源重試」的類型（限流 / 連線 / 上游故障） */
function isFailoverWorthy(e) {
  if (!e) return false;
  // 明確標記（解析失敗、被代理攔截等）優先採用
  if (e.failover) return true;
  if (e.status === 429) return true;
  if (e.status >= 500 && e.status < 600) return true;
  // 連線類錯誤（ECONNRESET / 逾時 / DNS / 連線被拒）沒有 status
  if (e.status === undefined) {
    const msg = (e.message || '') + ' ' + (e.cause?.code || '') + ' ' + (e.name || '');
    if (/fetch failed|timeout|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|aborted|UND_ERR_SOCKET|SyntaxError|not valid JSON|Unexpected token/i.test(msg)) return true;
  }
  return false;
}

/**
 * 依序嘗試多個來源，回傳第一個成功的結果。
 * 業務性錯誤（找不到標的、資料不足）不換來源，直接拋出。
 */
async function firstSuccess(method, args) {
  const providers = orderedProviders();
  if (!providers.length) throw new Error(`未知的 DATA_SOURCE：${FORCE}`);

  let lastErr = null;
  const failed = [];
  for (const p of providers) {
    const fn = p.mod[method];
    if (typeof fn !== 'function') continue;
    try {
      const value = await fn.apply(p.mod, args);
      // 空陣列（例：搜尋無結果）不算成功，讓下一個來源有機會嘗試
      if (method === 'search' && Array.isArray(value) && value.length === 0) {
        lastErr = new Error('查無結果');
        continue;
      }
      lastSource = p.name;
      clearPenalty(p.name);            // 成功即解除冷卻
      return value;
    } catch (e) {
      lastErr = e;
      if (!isFailoverWorthy(e)) throw e;
      failed.push(p.name);
    }
  }
  // 全部可換來源都失敗 → 冷卻它們，避免後續請求重複付逾時代價
  for (const name of failed) penalize(name);
  throw lastErr;
}

/* 搜尋：
 * 中文一律優先查本地別名索引（最穩定且零延遲），
 * 其次才走上游；英文 / 代碼直接走上游多來源。
 */
async function search(q) {
  const trimmed = String(q || '').trim();
  if (!trimmed) return [];

  if (alias.hasChinese(trimmed)) {
    const local = alias.suggestions(trimmed);
    if (local.length) { lastSource = 'local-alias'; return local; }
  }

  try {
    return await firstSuccess('search', [q]);
  } catch (e) {
    const local = alias.suggestions(trimmed);
    if (local.length) { lastSource = 'local-alias'; return local; }
    throw e;
  }
}

/* K 線 */
async function chart(symbol, range, interval) {
  return firstSuccess('chart', [symbol, range, interval]);
}

/**
 * K 線（附復權資訊）—— 供 FP 使用
 *
 * 與 chart() 的差異：額外回傳 adjClose（Yahoo）或標記 adj（其他來源），
 * 讓上層能判斷「這份序列是否可用於計算報酬」。
 *
 * 為什麼不重用 firstSuccess：
 *   一般 K 線取數「有資料就可用」，但 FP 對復權的要求是硬性的。
 *   若沿用 firstSuccess，Yahoo 失敗時會自動落到騰訊，回傳一份
 *   **未復權**的序列；上層若沒檢查 adj 就會算出跨拆股日 -90% 的
 *   假報酬。這裡改為把 adj 一併帶出，讓 predict() 依 adj 決定
 *   是否預測（規格 §4.1 FP-2-R1）。
 *
 * 沒有 chartWithAdj 的來源直接略過（目前 Yahoo / 東方財富 / 騰訊皆有）。
 *
 * @param {string} symbol
 * @param {string} range 預設 10y：FP 需要 ≥250 根訓練樣本，
 *                       且 10y 與既有 2y 管線的尾部逐位元相同，
 *                       不影響 AC-01
 * @param {string} interval
 * @returns {Promise<{candles:Array, adjClose:Array|null, adj:string, source:string, bars:number}>}
 */
async function chartWithAdj(symbol, range = '10y', interval = '1d') {
  const providers = orderedProviders();
  if (!providers.length) throw new Error(`未知的 DATA_SOURCE：${FORCE}`);

  let lastErr = null;
  const failed = [];
  for (const p of providers) {
    const fn = p.mod.chartWithAdj;
    if (typeof fn !== 'function') continue;
    try {
      const value = await fn(symbol, range, interval);
      if (!value || !Array.isArray(value.candles) || !value.candles.length) {
        lastErr = new Error('查無此標的的行情資料');
        lastErr.notFound = true;
        continue;
      }
      lastSource = p.name;
      clearPenalty(p.name);
      return {
        candles: value.candles,
        adjClose: value.adjClose || null,
        // 來源若自行標記 adj（如騰訊 'none'）則沿用，否則交由 adjust 判定
        adj: value.adj || null,
        source: p.name,
        bars: value.candles.length,
        meta: value.meta || null,
      };
    } catch (e) {
      lastErr = e;
      if (!isFailoverWorthy(e)) throw e;
      failed.push(p.name);
    }
  }
  for (const name of failed) penalize(name);
  throw lastErr;
}

/* 即時報價 */
async function quote(symbol) {
  return firstSuccess('quote', [symbol]);
}

/**
 * 新聞：僅 Yahoo 提供。
 * 新聞屬加分項，任何失敗都回空陣列，不應導致整體分析失敗。
 */
async function news(symbol, count = 5, name = null) {
  // 若已知 Yahoo 不可用，直接略過以免拖慢回應
  if (lastSource && lastSource !== 'yahoo') return [];
  try {
    return await yahoo.news(symbol, count, name);
  } catch {
    return [];
  }
}

/**
 * 期權鏈：僅 Yahoo 提供（東方財富 / 騰訊皆無此端點）。
 *
 * 回傳契約（重要，上層據此區分不同的「不可用」原因）：
 *   - 回傳物件 → 取得期權鏈
 *   - 回傳 null → 上游明確表示「此標的無期權市場」（如港股）
 *   - 擲出錯誤 → 取用失敗（限流 / 連線 / 逾時），屬暫時性問題
 *
 * 差異很關鍵：前者是「本來就沒有」，後者是「這次沒抓到」，
 * 若混為一談，使用者會誤以為美股沒有期權鏈。
 * 期權屬進階加分項，無論哪種情況都不影響整體分析。
 */
async function options(symbol, expiration = null) {
  if (FORCE && FORCE !== 'yahoo') {
    const e = new Error(`目前資料來源（${FORCE}）不提供期權鏈，僅 Yahoo 提供。`);
    e.noOptionsProvider = true;
    throw e;
  }
  if (lastSource && lastSource !== 'yahoo') {
    // Yahoo 已知不可用（被冷卻或最後成功者非 Yahoo），不必白等一次逾時
    const e = new Error('目前連線環境無法連上 Yahoo，期權鏈暫時無法取得。');
    e.noOptionsProvider = true;
    throw e;
  }
  return yahoo.options(symbol, expiration);
}

module.exports = {
  search,
  chart,
  chartWithAdj,
  quote,
  news,
  options,
  marketOf: yahoo.marketOf,
  get lastSource() { return lastSource; },
  get providers() { return ALL.map((p) => p.name); },
};
