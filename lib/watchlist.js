'use strict';

/**
 * 觀察清單 — 使用者自己挑的「先盯著、還沒買」的股票
 * ==================================================
 *
 * 與推介帳本的差別（為什麼要分成兩個檔案，而不是在帳本裡加一個 flag）：
 *   · 帳本記錄的是**系統的決策**：什麼時候推薦、什麼價位、後來賺賠多少。
 *     它有本金、有損益、有結算狀態，一筆都不能亂動。
 *   · 觀察清單記錄的是**使用者的意向**：我想盯著這檔。
 *     它沒有價格、沒有損益，隨時可加可刪，也不需要歷史。
 *   把兩者混在同一份檔案，會讓「使用者亂點幾下」變成「帳本有異動」，
 *   而帳本是以後要拿來算勝率與報酬的——它必須只被可信的流程改寫。
 *
 * 為什麼獨立成 data/watchlist.json：
 *   同一個 data/ 目錄已在 Render 掛了持久磁碟，跟著帳本一起活過重新部署。
 *   路徑刻意與帳本同層，這樣「持久化」的保證是同一套，不必再證明一次。
 *
 * 併發：本服務是多使用者存取同一個進程，Node 單執行緒下
 *   同步的 read-modify-write 不會交錯；但仍用「先寫 tmp 再 rename」
 *   的原子寫入，避免進程在寫到一半被 Render 重啟而留下半個 JSON。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

/** 預設路徑與帳本同層（data/tracker 的上一層），一起活在同一顆持久磁碟上 */
function resolveFile() {
  const fromEnv = String(process.env.WATCHLIST_FILE || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(__dirname, '..', 'data', 'watchlist.json');
}

/** 代碼正規化：大小寫與空白不一致會導致「同一檔被加兩次」 */
function normSymbol(sym) {
  return String(sym == null ? '' : sym).trim().toUpperCase();
}

/**
 * 代碼格式檢查。
 * 不做到「完全符合交易所規則」——那需要維護一整套代碼表，且會擋掉
 * 未來新增的市場。只擋明顯不是代碼的東西（空白、超長、特殊字元），
 * 避免使用者把一整段文字貼進來後變成永遠對不上的記錄。
 *
 * 為什麼允許開頭的 `^`：那是 Yahoo 對指數的寫法（^HSI 恒生、^GSPC 標普）。
 * 第一版把 ^ 只放在「後續字元」裡，結果恆指加不進觀察清單——
 * 而指數正是使用者最想盯著看的東西之一。
 */
function isValidSymbol(sym) {
  if (!sym) return false;
  if (sym.length > 16) return false;
  return /^\^?[A-Z0-9][A-Z0-9.\-^=_]*$/.test(sym);
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.filePath] 檔案路徑；null = 只在記憶體（測試用）
 * @param {function} [opts.now]    時鐘注入
 */
function create(opts = {}) {
  /* ---- 參數名打錯要立刻爆 ----
     與 picks-tracker 同一個理由：`create({ file: tmp })` 會被忽略並退回
     真實檔案，於是測試跑一跑就把使用者的觀察清單覆蓋掉。
     這種「打錯字 → 指向正式資料」的路徑不會拋錯，最難查。 */
  const typoKeys = ['file', 'path', 'watchlist', 'watchlistFile', 'filepath'];
  for (const k of typoKeys) {
    if (Object.prototype.hasOwnProperty.call(opts, k)) {
      throw new Error(
        `create() 的路徑參數是 opts.filePath，不是 opts.${k}。`
        + `（收到 ${k}=${JSON.stringify(opts[k])}）`
        + ' 若默默忽略，會退回預設檔案並可能覆蓋使用者的觀察清單。'
      );
    }
  }

  const filePath = opts.filePath === undefined ? resolveFile() : opts.filePath;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => new Date();

  const state = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    items: [],
  };

  /** 最近一次載入遇到的問題（損壞檔案），供上層回報而非靜默 */
  let recovered = null;
  let saveCount = 0;

  function load() {
    if (!filePath || !fs.existsSync(filePath)) return { loaded: false };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      // 損壞不清空：觀察清單雖然是使用者的意向、比帳本好重建，
      // 但「默默清空」會讓使用者以為系統吃掉了他的清單。
      const bak = `${filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(filePath, bak); } catch { /* 備份失敗不阻擋啟動 */ }
      recovered = { reason: e.message, backup: bak };
      return { loaded: false, corrupt: true };
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
      const bak = `${filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(filePath, bak); } catch { /* 同上 */ }
      recovered = { reason: '檔案結構不是預期的 { items: [...] }', backup: bak };
      return { loaded: false, corrupt: true };
    }
    if (raw.schemaVersion != null && raw.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `觀察清單版本 ${raw.schemaVersion} 與程式預期的 ${SCHEMA_VERSION} 不符（${filePath}）`
      );
    }
    state.createdAt = raw.createdAt || state.createdAt;
    state.updatedAt = raw.updatedAt || null;
    // 逐筆淨化：檔案是可以被手動編輯的，壞掉的單筆不該讓整份清單讀不進來
    state.items = raw.items
      .filter((x) => x && isValidSymbol(normSymbol(x.symbol)))
      .map((x) => ({
        symbol: normSymbol(x.symbol),
        name: String(x.name || '').trim().slice(0, 80) || null,
        market: x.market ? String(x.market).slice(0, 8) : null,
        currency: x.currency ? String(x.currency).slice(0, 8) : null,
        addedAt: x.addedAt ? String(x.addedAt) : null,
        // 來源：從哪一筆推介加進來的（可能為 null，例如日後手動輸入）
        fromPick: x.fromPick ? String(x.fromPick).slice(0, 80) : null,
        note: x.note ? String(x.note).slice(0, 200) : null,
      }));
    return { loaded: true, count: state.items.length };
  }

  function save() {
    if (!filePath) { saveCount += 1; return { saved: false, reason: '僅記憶體' }; }
    state.updatedAt = new Date(nowFn()).toISOString();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
      // rename 在同一檔案系統上是原子操作：要嘛是舊檔、要嘛是新檔，
      // 不會出現「寫到一半」的半個 JSON
      fs.renameSync(tmp, filePath);
      saveCount += 1;
      return { saved: true };
    } catch (e) {
      return { saved: false, reason: e.message };
    }
  }

  function has(symbol) {
    const s = normSymbol(symbol);
    return state.items.some((x) => x.symbol === s);
  }

  function find(symbol) {
    const s = normSymbol(symbol);
    return state.items.find((x) => x.symbol === s) || null;
  }

  /**
   * 加入觀察清單。
   * 冪等：已在清單中就回 added:false，不新增、不報錯。
   * 為什麼不報錯：前端按鈕可能被連點兩下、或使用者重複整理頁面；
   * 這種情況回「已存在」是正確結果，不是失敗。
   *
   * @returns {{added:boolean, reason?:string, item?:object}}
   */
  function add(input, o = {}) {
    const symbol = normSymbol(input && input.symbol);
    if (!symbol) return { added: false, reason: '缺少股票代碼' };
    if (!isValidSymbol(symbol)) return { added: false, reason: `代碼格式不正確：${symbol}` };

    const existing = find(symbol);
    if (existing) return { added: false, reason: '已在觀察清單', item: existing };

    const item = {
      symbol,
      name: input.name ? String(input.name).trim().slice(0, 80) : null,
      market: input.market ? String(input.market).slice(0, 8) : null,
      currency: input.currency ? String(input.currency).slice(0, 8) : null,
      addedAt: new Date(nowFn()).toISOString(),
      fromPick: o.fromPick ? String(o.fromPick).slice(0, 80) : null,
      note: null,
    };
    state.items.push(item);
    return { added: true, item };
  }

  /**
   * 移出觀察清單。
   * @returns {{removed:boolean, reason?:string, item?:object}}
   */
  function remove(symbol) {
    const s = normSymbol(symbol);
    if (!s) return { removed: false, reason: '缺少股票代碼' };
    const idx = state.items.findIndex((x) => x.symbol === s);
    if (idx === -1) return { removed: false, reason: '不在觀察清單' };
    const [item] = state.items.splice(idx, 1);
    return { removed: true, item };
  }

  /** 清單（依加入時間新到舊；同時間則依代碼，確保輸出穩定可測） */
  function list() {
    return state.items.slice().sort((a, b) => {
      const ta = a.addedAt || '';
      const tb = b.addedAt || '';
      if (ta !== tb) return tb.localeCompare(ta);
      return a.symbol.localeCompare(b.symbol);
    });
  }

  function symbols() {
    return state.items.map((x) => x.symbol);
  }

  function stats() {
    return {
      count: state.items.length,
      file: filePath,
      saves: saveCount,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      recovered,
    };
  }

  /** 給上層在回應裡附帶「哪些股票已在觀察清單」，避免前端逐筆查詢 */
  function symbolSet() {
    return new Set(state.items.map((x) => x.symbol));
  }

  return {
    load, save, add, remove, has, find, list, symbols, stats, symbolSet,
    get state() { return state; },
    get filePath() { return filePath; },
  };
}

module.exports = {
  create, resolveFile, normSymbol, isValidSymbol, SCHEMA_VERSION,
};
