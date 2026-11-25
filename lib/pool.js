'use strict';

/**
 * 選股母體（symbol pool）
 *
 * 來源：lib/alias.js 既有的中英文別名表。
 *
 * 為什麼不另外維護一份清單：
 *   別名表是「使用者輸入 → 代碼」的唯一事實來源，也是搜尋自動完成的來源。
 *   若選股母體另寫一份，兩者會隨時間漂移（新增標的只更新一邊），
 *   使用者會遇到「搜尋得到但選股篩不到」這種無法解釋的落差。
 *
 * 實測規模（2026-11）：ZH 207 個別名 → 153 個代碼、EN 36 個別名 → 34 個代碼，
 * 去重後 154 檔。與規格書 §10.2 記載的 154 一致。
 */

const alias = require('./alias');

/** 把別名表的 value 全部取出來去重、排序 */
function buildPool() {
  const codes = new Set();
  for (const table of [alias.ZH, alias.EN]) {
    if (!table) continue;
    Object.keys(table).forEach((k) => {
      const v = table[k];
      if (typeof v === 'string' && v) codes.add(v.toUpperCase());
    });
  }
  return [...codes].sort();
}

/** 快取：母體是常數，不必每次重算 */
let cached = null;

function all() {
  if (!cached) cached = buildPool();
  return cached;
}

/** 依市場過濾（HK 以 .HK 結尾，其餘視為美股） */
function byMarket(market) {
  const list = all();
  if (!market || market === 'all') return list;
  if (market === 'hk') return list.filter((s) => /\.HK$/i.test(s));
  return list.filter((s) => !/\.HK$/i.test(s));
}

/** 母體摘要，供 API 回應與前端顯示「池子有多大」 */
function summary() {
  const list = all();
  const hk = list.filter((s) => /\.HK$/i.test(s));
  return {
    total: list.length,
    hk: hk.length,
    us: list.length - hk.length,
    source: 'lib/alias.js',
  };
}

module.exports = { all, byMarket, summary };
