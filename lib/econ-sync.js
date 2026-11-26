'use strict';

/**
 * 經濟資料庫 — 同步層
 * ====================
 *
 * 把上游（目前是 FRED）的序列寫進 econ-store。
 *
 * ── 這個模組存在的理由 ──────────────────────────────────
 * `lib/macro.js` 的快取是**記憶體內**的 TTL 快取：進程一重啟就全空，
 * 而且只存「最新一筆 + 統計摘要」，不存歷史序列。
 * 這裡要解決的是另一件事：**把歷史序列持久化**，讓
 *
 *   ① 重啟後圖表仍有資料（不必等上游回應）
 *   ② 上游暫時故障時仍能顯示上次抓到的資料
 *   ③ 同一批資料不必每次重抓（比對期間鍵就知道有沒有新的）
 *
 * ── 與既有快取的關係 ────────────────────────────────────
 * 兩者不互相取代，是不同層：
 *   macro.js 的 Map  → 避免「同一秒內重複打上游」
 *   econ-store 的檔案 → 避免「每次啟動都重新下載整條歷史」
 *
 * ── 「避免每次重新抓取」怎麼做到 ──────────────────────────
 * 寫入時比對 `seriesKey + period`：
 *   值相同 → 不寫檔、不記修訂（report.unchanged 會累加）
 *   值不同 → 更新並記修訂
 * 所以「同步」是冪等的，跑幾次結果都一樣，可以放心排程。
 */

const fred = require('./fred');
const { openStore, normalizePeriod } = require('./econ-store');

/** 單例，避免每次呼叫都重新讀檔 */
let singleton = null;

function getStore(opts) {
  const o = opts || {};
  if (o.dir !== undefined) return openStore(o); // 明確指定目錄時不共用單例（測試用）
  if (!singleton) singleton = openStore({});
  return singleton;
}

function resetSingleton() {
  singleton = null;
}

/**
 * FRED 序列定義 → series 表的一列。
 * 欄位對映刻意顯式寫出來，不靠 `...def` 展開——
 * 這樣上游新增欄位時不會意外漏進來污染資料庫 schema。
 */
function seriesMetaFromFred(def) {
  return {
    seriesKey: def.key,
    label: def.label,
    unit: def.unit,
    frequency: def.freq,
    source: 'FRED',
    sourceId: def.id,
    sourceUrl: `https://fred.stlouisfed.org/series/${def.id}`,
    definition: def.definition,
    note: def.note,
  };
}

/**
 * 同步單一序列。
 *
 * 注意：FRED 的 `getSeries` 只回「最新一筆 + 統計」，不含完整歷史。
 * 因此這裡同步的是**最新觀測值**。若日後要回補整條歷史，
 * 應另寫 `fred.fetchSeries` 的歷史抓取，再用 `writeMany` 批次寫入
 * （store 已支援，且天然去重）。
 *
 * @param {string} key SERIES 的 key
 * @param {object} [opts]
 * @param {object} [opts.store] 指定 store（測試用）
 * @param {boolean} [opts.force] 強制向上游重抓
 */
async function syncSeries(key, opts) {
  const o = opts || {};
  const store = o.store || getStore();

  // 注意：fred.BY_KEY 是 Map，不是普通物件。
  // 用 `fred.BY_KEY[key]` 會永遠是 undefined（Map 要用 .get），
  // 這會讓所有同步都回 UNKNOWN_SERIES——已實測踩過。
  const def = fred.BY_KEY && fred.BY_KEY.get ? fred.BY_KEY.get(key) : null;
  if (!def) {
    return { key, ok: false, code: 'UNKNOWN_SERIES', message: `未註冊的序列：${key}` };
  }

  // 先確保主檔存在，即使這次抓不到資料，指標定義也應該留下來
  const metaResult = store.writeSeries(seriesMetaFromFred(def));

  let raw;
  try {
    raw = await fred.getSeries(key, { force: o.force });
  } catch (e) {
    return {
      key, ok: false, code: 'UPSTREAM', message: e.message,
      series: metaResult.action,
    };
  }

  if (!raw || raw.available !== true) {
    // 抓不到就**不要動既有資料**。這是本專案一貫原則：
    // 一次上游故障不該把好的歷史資料洗掉。
    return {
      key,
      ok: false,
      code: (raw && raw.unavailable) || 'UNAVAILABLE',
      message: (raw && raw.reason) || '上游未回傳可用資料',
      series: metaResult.action,
      stored: 0,
    };
  }

  const write = store.write({
    seriesKey: key,
    period: raw.asOf,
    value: raw.value,
    source: 'FRED',
    sourceUpdatedAt: raw.fetchedAt ? new Date(raw.fetchedAt).toISOString() : null,
    frequency: def.freq,
  });

  return {
    key,
    ok: true,
    label: def.label,
    asOf: raw.asOf,
    period: normalizePeriod(raw.asOf, def.freq),
    value: raw.value,
    plausible: raw.plausible,
    write,
    series: metaResult.action,
  };
}

/**
 * 同步多條序列。
 * @param {string[]} keys 不給則同步全部已註冊序列
 */
async function syncAll(keys, opts) {
  const o = opts || {};
  const store = o.store || getStore();
  const list = Array.isArray(keys) && keys.length ? keys : fred.SERIES.map((s) => s.key);

  const results = [];
  // 循序執行：FRED 對短時間大量請求會回 ZIP，並行反而更慢（見 lib/fred.js 的註解）
  for (const k of list) {
    // eslint-disable-next-line no-await-in-loop
    const r = await syncSeries(k, { ...o, store });
    results.push(r);
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    inserted: results.filter((r) => r.write && r.write.action === 'inserted').length,
    updated: results.filter((r) => r.write && r.write.action === 'updated').length,
    unchanged: results.filter((r) => r.write && r.write.action === 'unchanged').length,
    skipped: results.filter((r) => r.write && r.write.action === 'skipped').length,
  };

  return {
    ok: summary.failed === 0,
    generatedAt: new Date().toISOString(),
    summary,
    results,
    stats: store.stats(),
  };
}

/**
 * 判斷某序列是否需要向上游重抓。
 *
 * 這是「避免每次重新抓取」在呼叫端的介面：先問一句，再決定要不要打。
 * 規則用該頻率的天然更新週期，不寫死固定秒數——
 * 日頻資料在收盤前根本不會變，用 5 分鐘去抓只是浪費上游請求。
 */
function needsRefresh(key, opts) {
  const o = opts || {};
  const store = o.store || getStore();
  // 同上：BY_KEY 是 Map
  const def = fred.BY_KEY && fred.BY_KEY.get ? fred.BY_KEY.get(key) : null;
  if (!def) return { needed: true, reason: 'unknown-series' };

  const last = store.latest(key);
  if (!last) return { needed: true, reason: 'no-local-data' };

  const now = o.now != null ? o.now : Date.now();
  const storedAt = last.updatedAt ? Date.parse(last.updatedAt) : null;
  if (!storedAt || Number.isNaN(storedAt)) return { needed: true, reason: 'no-timestamp' };

  const ageMs = now - storedAt;
  const ttl = def.freq === 'D' ? 6 * 3600 * 1000
    : def.freq === 'Q' ? 30 * 24 * 3600 * 1000
      : 24 * 3600 * 1000; // 月頻

  if (ageMs >= ttl) {
    return { needed: true, reason: 'age-exceeded', ageMs, ttlMs: ttl, lastPeriod: last.period };
  }
  return { needed: false, reason: 'fresh', ageMs, ttlMs: ttl, lastPeriod: last.period };
}

module.exports = {
  getStore,
  resetSingleton,
  syncSeries,
  syncAll,
  needsRefresh,
  seriesMetaFromFred,
};
