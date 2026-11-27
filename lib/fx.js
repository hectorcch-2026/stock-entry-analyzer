'use strict';

/**
 * 匯率 — 只做「原幣 → 美元」一件事
 * ================================
 *
 * 為什麼需要這個模組：
 *   選股清單同時涵蓋美股（USD）與港股（HKD）。推介追蹤的本金是
 *   **10,000 美元**，若把「港股賺 500 港元」與「美股賺 500 美元」直接相加，
 *   累計盈虧會憑空多出約 7.8 倍的港元部分——這是錯的，而且錯得很隱蔽：
 *   數字看起來「有在動」，只是整體報酬率被系統性放大。
 *
 *   正確做法是每筆交易都記錄「成交當時」與「離場當時」的匯率，
 *   各自折算成美元，差額即為含匯損益。這樣本金（美元）與損益（美元）
 *   同一個幣別，相加才有意義。
 *
 * 為什麼要快取：
 *   一次更新可能處理上百筆記錄，但匯率只有一個（USD/HKD）。
 *   不快取就會對上游打上百次相同請求。快取 TTL 取 6 小時——匯率在
 *   一天之內的變動遠小於股價波動，對「折算」這個用途足夠，
 *   且不會因為上游短暫失敗就讓整批更新掛掉（有 lastGood 兜底）。
 *
 * 失敗策略：
 *   匯率取不到時**不可以用 1 代替**（那等於把港元當美元）。
 *   這裡回退到 7.8（港元掛鉤區間 7.75–7.85 的中位）並標記 `estimated:true`，
 *   讓上層能把「用了估計匯率」這件事顯示給使用者，而不是默默算錯。
 */

/** 港元掛鉤區間中位。僅在完全取不到匯率時使用，且必定標記 estimated。 */
const FALLBACK_HKD_PER_USD = 7.8;

/** 快取存活時間：6 小時 */
const TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map();

function nowMs() {
  return Date.now();
}

/**
 * 取得「1 美元可換多少原幣」。
 * @returns {Promise<{rate:number, pair:string|null, estimated:boolean, source:string, at:string}>}
 */
async function ratePerUsd(currency, datasource, opts = {}) {
  const cur = String(currency || 'USD').toUpperCase();
  if (cur === 'USD') {
    return { rate: 1, pair: null, estimated: false, source: 'identity', at: new Date().toISOString() };
  }

  const ttl = opts.ttlMs == null ? TTL_MS : opts.ttlMs;
  const key = `USD${cur}`;
  const hit = cache.get(key);
  const t = nowMs();
  if (hit && !opts.force && t - hit.atMs < ttl) {
    return { ...hit.value, cached: true };
  }

  // 台股等尚未支援的幣別：明確報錯，不要猜
  if (cur !== 'HKD') {
    const value = {
      rate: null,
      pair: null,
      estimated: true,
      source: 'unsupported',
      at: new Date().toISOString(),
      error: `尚未支援的計價幣別「${cur}」，無法折算成美元`,
    };
    return value;
  }

  try {
    // Yahoo 的匯率代碼格式：USDHKD=X（代表 1 USD = ? HKD）
    const q = await datasource.quote(`USD${cur}=X`);
    const rate = q && Number(q.price);
    if (!isFinite(rate) || rate <= 0) throw new Error('匯率回應無數值');
    const value = {
      rate,
      pair: `USD${cur}=X`,
      estimated: false,
      source: 'yahoo',
      at: new Date().toISOString(),
    };
    cache.set(key, { atMs: t, value });
    return value;
  } catch (e) {
    // 曾經成功過就沿用最後一次已知值（標記 stale），比憑空猜測可信得多
    if (hit) {
      return { ...hit.value, cached: true, stale: true, estimated: true, error: e.message };
    }
    return {
      rate: FALLBACK_HKD_PER_USD,
      pair: `USD${cur}=X`,
      estimated: true,
      source: 'fallback-peg',
      at: new Date().toISOString(),
      error: e.message,
    };
  }
}

/**
 * 把原幣金額折算成美元。
 * rate 為 null 時回傳 null——寧可讓上層看到「算不出來」，
 * 也不要回一個看起來正常、實際上錯誤的數字。
 */
function toUsd(amount, rate) {
  const v = Number(amount);
  if (!isFinite(v)) return null;
  if (rate == null) return null;
  const r = Number(rate);
  if (!isFinite(r) || r <= 0) return null;
  return v / r;
}

/**
 * 把美元金額折算成原幣（`toUsd` 的反向）。
 * 買股數要用這一個：本金是美元，成交價是原幣，必須先換成原幣才除得對。
 */
function toLocal(amountUsd, rate) {
  const v = Number(amountUsd);
  if (!isFinite(v)) return null;
  if (rate == null) return null;
  const r = Number(rate);
  if (!isFinite(r) || r <= 0) return null;
  return v * r;
}

function clearCache() {
  cache.clear();
}

module.exports = { ratePerUsd, toUsd, toLocal, clearCache, FALLBACK_HKD_PER_USD, TTL_MS };
