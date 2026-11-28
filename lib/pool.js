'use strict';

/**
 * 選股母體（symbol pool）
 *
 * 來源：lib/pool-us-500.json（由 scripts/build-pool.js 產生的可稽核快照）。
 *
 * 為什麼改成「快照檔 + 產生腳本」，而不是繼續從 lib/alias.js 推導：
 *   舊做法把母體當成別名表的副產物，好處是「搜尋得到就篩得到」，但代價是
 *   母體大小與組成完全不受控 —— 有人為了讓搜尋更好用而加一個中概股別名，
 *   選股母體就跟著長出一檔中概股，而且沒有人會發現。需求要求「恰好 500 檔、
 *   只含美股、排除中概股」，這種硬性規格不能靠副作用維持。
 *
 *   現在母體是一份進版控的 JSON，變動就是一次 diff；要重生用
 *   `node scripts/build-pool.js`，要驗證用 `node scripts/build-pool.js --check`。
 *
 * 為什麼保留 alias.js 作為退路（degraded 模式）：
 *   若部署時漏帶 JSON（例如 .gitignore 誤設、Docker COPY 漏檔），整個選股
 *   功能會變成「0 檔」而不是壞掉 —— 使用者只會看到空清單，不知道原因。
 *   這裡退回合名表推導的美股，並在 summary.degraded 標記，讓 API 與前端
 *   能明講「母體快照遺失，已退回舊來源」，而不是靜默給出錯誤答案。
 *
 * 中概股排除為何放在這一層（而不是只在快照產生時做）：
 *   母體可以被呼叫方直接餵入（測試、外部 cron、未來的 API、scheduler）。
 *   若排除只寫在「產生快照」那一步，繞過快照的呼叫就完全不受限制，
 *   那就不是「固定規則」而是「預設值」。enforceUniverse() 是唯一的入口，
 *   任何人都得經過它，規則才算真的固定。
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = path.join(__dirname, 'pool-us-500.json');

/**
 * 中概股黑名單（在美上市中國概念股）。
 *
 * 為什麼這份名單與 scripts/build-pool.js 裡的重複：
 *   那一份是「產生快照時」用的，這一份是「執行期閘門」用的。
 *   兩者刻意不共用同一個常數 —— 共用會讓人以為只要改一處就同時生效，
 *   但快照是靜態檔，改名單不會改變已產生的快照。分開寫，並且都在
 *   enforceUniverse() 這條路上生效，才不會有「改了名單卻沒生效」的誤會。
 *
 * 為什麼是代碼黑名單而不是「註冊地」判斷：
 *   執行期拿不到可靠的註冊地（Yahoo quote 不提供），額外查 SEC 又要多一個
 *   上游請求。代碼黑名單是唯一能在篩選熱路徑上零成本執行的方式。
 *   它的失效模式是「漏掉新上市的中概股」，因此搭配名稱比對（下方）雙重把關。
 */
const CHINA_ADR = new Set([
  'BABA', 'BIDU', 'BILI', 'BEKE', 'EDU', 'IQ', 'JD', 'LI', 'NIO', 'NTES',
  'PDD', 'TAL', 'TME', 'XPEV', 'WB', 'YY', 'MOMO', 'ZH', 'HUYA', 'DOYU',
  'TIGR', 'FUTU', 'KC', 'GOTU', 'RERE', 'YQ', 'BEST', 'CAN', 'CANG', 'DAO',
  'EH', 'FANH', 'GDS', 'HTHT', 'JFIN', 'JKS', 'LU', 'LX', 'MNSO', 'NOAH',
  'QFIN', 'RLX', 'SINA', 'SOHU', 'STG', 'TCOM', 'TUYA', 'VIPS', 'VNET',
  'WIMI', 'XNET', 'YJ', 'ZLAB', 'ZTO', 'ATAT', 'ATHM', 'BZ', 'DQ', 'FINV',
  'HCM', 'HSAI', 'LEGN', 'NIU', 'QD', 'RENN', 'SECO', 'UXIN', 'PPC',
]);

/**
 * 名稱含下列「整詞」者視為中概股。
 *
 * 為什麼一定要詞邊界（這裡踩過坑）：
 *   用寬鬆的 /nio/ 去比對名稱，"Dom**inio**n Energy"、"U**nio**n Pacific"
 *   都會命中；用 /cn/ 去比對，"Old Dominion" 這類字也會被掃到。
 *   誤傷的代價是把正常美股踢出母體，而且使用者看到的理由是「已排除中概股」，
 *   完全無從理解。詞邊界把規則限定在「這是一個獨立的詞」，才不會亂咬。
 */
const CHINA_NAME_RE = /\b(china|chinese|prc|beijing|shanghai|shenzhen|hong\s*kong)\b/i;

/**
 * 代碼正規化。
 *
 * 這裡有個必須先擋掉的陷阱：把 `.` 一律換成 `-` 是為了讓 Wikipedia 的
 * `BRK.B` 變成 Yahoo 慣用的 `BRK-B`，但同一個替換會把港股的 `0700.HK`
 * 變成 `0700-HK` —— 那就不是港股了，會被當成美股送去上游，結果是
 * 「查無此代碼」而不是「格式錯誤」，非常難追。
 *
 * 因此順序是：先認出 .HK 並原樣保留，其餘才做點換線。
 */
function normalizeTicker(t) {
  const s = String(t == null ? '' : t).trim().toUpperCase();
  if (!s) return '';
  if (/\.HK$/.test(s)) return s;      // 港股：點是格式的一部分，不可動
  return s.replace(/\./g, '-');
}

/** 港股判斷：維持專案既有慣例（.HK 結尾） */
function isHK(sym) {
  return /\.HK$/i.test(String(sym || ''));
}

/** 從快照檔載入。任何異常都回 null，由呼叫端決定退路。 */
function loadSnapshot() {
  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.symbols) || !obj.symbols.length) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

/** 退路：用別名表推導「美股」清單（仍會經過中概股閘門） */
function fallbackFromAlias() {
  const alias = require('./alias');
  const codes = new Set();
  for (const table of [alias.ZH, alias.EN]) {
    if (!table) continue;
    Object.keys(table).forEach((k) => {
      const v = table[k];
      if (typeof v === 'string' && v) codes.add(normalizeTicker(v));
    });
  }
  return [...codes].filter((s) => !isHK(s)).sort();
}

let cached = null;

/**
 * 取得完整母體（已套用中概股排除）。
 *
 * @returns {{symbols:string[], meta:object}}
 */
function load() {
  if (cached) return cached;

  const snap = loadSnapshot();
  if (snap) {
    const rows = snap.symbols
      .map((x) => ({
        symbol: normalizeTicker(x.symbol),
        name: x.name || null,
        sector: x.sector || null,
      }))
      .filter((x) => x.symbol);

    const enforced = enforceUniverse(rows.map((r) => r.symbol));
    const bySym = new Map(rows.map((r) => [r.symbol, r]));
    cached = {
      rows: enforced.kept.map((s) => bySym.get(s) || { symbol: s, name: null, sector: null }),
      meta: {
        source: 'lib/pool-us-500.json',
        degraded: false,
        generatedAt: snap.generatedAt || null,
        targetSize: snap.targetSize || null,
        excludedChina: enforced.removed,
        excludedChinaCount: enforced.removed.length,
      },
    };
    return cached;
  }

  const fb = fallbackFromAlias();
  const enforced = enforceUniverse(fb);
  cached = {
    rows: enforced.kept.map((s) => ({ symbol: s, name: null, sector: null })),
    meta: {
      source: 'lib/alias.js（退路）',
      degraded: true,
      degradedReason: '找不到 lib/pool-us-500.json 或內容無效，已退回別名表推導的美股清單',
      generatedAt: null,
      targetSize: null,
      excludedChina: enforced.removed,
      excludedChinaCount: enforced.removed.length,
    },
  };
  return cached;
}

/**
 * 唯一的母體閘門：把任何來源的代碼清單過濾成「合法母體」。
 *
 * 這是「只納入美國上市個股」與「排除中概股」兩條固定規則的落點。
 * 選股、回測、排程、外部 cron 全部都得經過這裡，所以規則不可能被繞過。
 *
 * 為什麼港股要在這裡就擋掉，而不是留給 applyFilters 的 market 條件：
 *   applyFilters 是在 analyzer.analyze() **之後**才跑的。若港股留到那裡才被
 *   排除，每一檔港股都已經白打了 3 個上游請求（而且港股本來就不在母體裡，
 *   打了也是浪費）。更糟的是排除原因會顯示成「市場不符」，
 *   使用者會以為只要把 market 改成 all 就能看到港股 —— 事實上是母體
 *   根本沒有港股。在閘門擋掉，理由才誠實。
 *
 * @param {string[]} symbols
 * @returns {{kept:string[], removed:string[], removedHK:string[]}}
 */
function enforceUniverse(symbols) {
  const list = Array.isArray(symbols) ? symbols : [];
  const seen = new Set();
  const kept = [];
  const removed = [];
  const removedHK = [];

  for (const raw of list) {
    const s = normalizeTicker(raw);
    if (!s) continue;
    if (isHK(s)) { removedHK.push(s); continue; }
    if (CHINA_ADR.has(s)) { removed.push(s); continue; }
    if (seen.has(s)) continue;   // 去重但不回報為「排除」，避免統計誤導
    seen.add(s);
    kept.push(s);
  }
  return { kept, removed, removedHK };
}

/** 母體全部代碼 */
function all() {
  return load().rows.map((r) => r.symbol);
}

/**
 * 依市場過濾。
 *
 * 現在母體只有美股，因此：
 *   'all' / 'us' → 全池
 *   'hk'         → 空陣列（母體已不含港股，這是預期行為）
 * 保留 hk 分支是為了 API 相容：舊連結與呼叫端仍可能帶 market=hk，
 * 回空陣列並附說明，比回 400 錯誤更不破壞既有整合。
 */
function byMarket(market) {
  const m = String(market || 'all').toLowerCase();
  if (m === 'hk') return [];
  return all();
}

/** 帶名稱與版塊的完整資料列（前端要顯示名稱時用） */
function rows() {
  return load().rows.slice();
}

/** 依代碼取單檔中介資料（名稱、版塊） */
function get(symbol) {
  const s = normalizeTicker(symbol);
  const hit = load().rows.find((r) => r.symbol === s);
  return hit || null;
}

/** 中概股黑名單（供 API 公開「排除了哪些」） */
function chinaAdrList() {
  return [...CHINA_ADR].sort();
}

/**
 * 母體摘要，供 API 回應與前端顯示。
 *
 * excludedChinaCount 這個欄位是需求明確要求的：輸出必須標註「已排除中概股，
 * 以及因而調整的標的數量」。即使目前是 0（因為 S&P 500 結構上不含中概股），
 * 也必須回報，否則使用者無法分辨「規則跑了但沒命中」與「規則根本沒生效」。
 */
function summary() {
  const l = load();
  const list = l.rows.map((r) => r.symbol);
  const hk = list.filter(isHK);
  return {
    total: list.length,
    hk: hk.length,
    us: list.length - hk.length,
    source: l.meta.source,
    universe: 'us',
    targetSize: l.meta.targetSize,
    generatedAt: l.meta.generatedAt,
    degraded: !!l.meta.degraded,
    degradedReason: l.meta.degradedReason || null,
    excluded: {
      chinaAdr: {
        count: l.meta.excludedChinaCount,
        symbols: l.meta.excludedChina.slice(0, 60),
        rule: '在美上市中國概念股（代碼黑名單 + 名稱詞邊界比對）',
        note: '母體為 S&P 500（美國註冊），結構上不含中概股；此閘門確保任何繞過母體的呼叫同樣受限',
      },
    },
    adjustedNote: l.meta.excludedChinaCount > 0
      ? `已排除中概股 ${l.meta.excludedChinaCount} 檔，母體調整為 ${list.length} 檔`
      : `已套用中概股排除規則，本次命中 0 檔（母體為美國註冊的 S&P 500，結構上不含中概股），母體維持 ${list.length} 檔`,
  };
}

/** 測試用：清掉快取（改檔案後重讀） */
function _resetCache() {
  cached = null;
}

module.exports = {
  all,
  rows,
  get,
  byMarket,
  summary,
  enforceUniverse,
  chinaAdrList,
  normalizeTicker,
  isHK,
  CHINA_ADR,
  CHINA_NAME_RE,
  SNAPSHOT_FILE,
  _resetCache,
};
