'use strict';

/**
 * 每日精選推介追蹤 — 持久化帳本與狀態機
 * ======================================
 *
 * 一句話：把「今天篩出來的推介」變成一筆**有生命週期、可結算、不重複計算**的交易帳。
 *
 * ── 為什麼不放進 data/picks/ ────────────────────────────────
 * `data/picks/YYYY-MM-DD.json` 是「當日篩選快照」，一份一份、互不相干，
 * 而且每天由排程整份重寫（scheduler.maybeRun force 時）。
 * 追蹤帳本必須是**跨日期累積、只增不改**的，兩者生命週期完全不同，
 * 放同一個檔會在重跑當日清單時把歷史交易洗掉。
 * 因此獨立一個 `data/tracker/ledger.json`。
 *
 * ── 狀態機（使用者指定的四個狀態）──────────────────────────
 *
 *      建立推介
 *         │
 *         ▼
 *     ┌────────┐  日線 low 觸及買區上沿   ┌────────┐
 *     │ 待買入 │ ───────────────────────▶ │ 持倉中 │
 *     └────────┘                          └────────┘
 *                                              │
 *                        ┌─────────────────────┴─────────────────────┐
 *                        │ high ≥ 止賺價              low ≤ 止蝕價     │
 *                        ▼                                            ▼
 *                   ┌────────┐                                  ┌────────┐
 *                   │ 已止賺 │                                  │ 已止蝕 │
 *                   └────────┘                                  └────────┘
 *
 * 「已止賺／已止蝕」皆為終態：一旦成立即 `settled=true`，之後任何更新都跳過，
 * 數字就此凍結。這是「不重複計算同一筆交易」的實作方式——
 * 不是靠「檢查有沒有算過」這種容易漏的判斷，而是靠**狀態不可逆**。
 *
 * ── 三個必須想清楚的坑 ───────────────────────────────────
 *
 * ① 前視偏差（look-ahead bias）
 *    推介是「當日收盤後」用當日 K 線算出來的。若允許用推介日當天的
 *    最高／最低價去判定「已觸及」，等於用結果去解釋成因。
 *    因此**推介日當天的 K 線一律不參與判定**，從下一個交易日開始追。
 *
 * ② 同日觸及兩邊（資料解析度不足）
 *    日線只有 O/H/L/C。若某天 low ≤ 止蝕 且 high ≥ 止賺，
 *    從日線無法得知當天是先跌後漲還是先漲後跌。
 *    這裡一律**假設先觸及止蝕**（保守）。寧可低估績效，
 *    也不要做出一個「事後看起來很賺」的假帳。
 *
 * ③ 建倉當天不判出場
 *    買入當天同樣無法區分「先買後跌到停損」還是「先跌到停損再買回來」。
 *    這一天的出場判定跳過，從**次一交易日**起算。
 *
 * ── 成交價怎麼定（限價單模型）────────────────────────────
 *    建議買入價是一個「區間」（buyLow〜buyHigh）。實務上等於掛
 *    限价單在 buyHigh：
 *      · 當日開盤 ≤ buyHigh  → 以開盤價成交（跳空低開，拿到更好價格）
 *      · 當日開盤 >  buyHigh → 以 buyHigh 成交（盤中回落觸價）
 *    止賺／止蝕同理，跳空穿越時以開盤價成交（對買方更差／更好，符合實況）。
 *
 * ── 本金與損益 ───────────────────────────────────────────
 *    本金固定 10,000 美元，**每一筆各自獨立計算**：
 *       股數 = 10,000 × 成交時匯率 ÷ 成交價      （允許碎股，取 6 位小數）
 *    港股以 HKD 計價，故先換成港幣再算股數；離場時再折回美元。
 *    兩次折算的匯差會反映在損益裡——這是真的，持有港股就有匯率風險。
 *
 *    累計報酬率 **不是** 單筆報酬率的平均，也不是「總損益 ÷ 10,000」。
 *    因為有 N 筆各自 10,000 本金的交易，實際動用的資金是 Σ成本。
 *    正確算法：總損益 ÷ 已投入總成本。詳見 `summary()`。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'tracker', 'ledger.json');

/** 預設本金（美元） */
const DEFAULT_CAPITAL_USD = 10000;

/** 狀態代碼 → 使用者看到的字（前端也用這份，避免兩邊各寫一次而漂移） */
const STATUS_LABEL = {
  pending: '待買入',
  holding: '持倉中',
  target_hit: '已止賺',
  stop_hit: '已止蝕',
};

const STATUS_ORDER = ['pending', 'holding', 'target_hit', 'stop_hit'];

/** 終態：不再變動 */
const FINAL_STATUS = new Set(['target_hit', 'stop_hit']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 毫秒時間戳 → YYYY-MM-DD（UTC）。兩市開盤時間換算成 UTC 都仍在同一日，故安全。 */
function dateKeyFromMs(ms) {
  // 必須先擋 null／undefined／空字串：`Number(null)` 是 0，
  // 會讓「缺 t 的 K 線」變成 1970-01-01。那不是拋錯，而是安靜地變成
  // 「一個永遠落在推介日之前的日期」，於是這根 K 線被當成前視偏差過濾掉，
  // 症狀是「某檔股票明明觸價卻一直不動」——極難從結果反推原因。
  if (ms == null || ms === '') return null;
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (!isFinite(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function todayKey(now) {
  const d = now ? new Date(now) : new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 兩個 YYYY-MM-DD 之間的天數（b - a）。手動解析，避免時區位移。 */
function daysBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a || ''));
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b || ''));
  if (!pa || !pb) return null;
  const ta = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]);
  const tb = Date.UTC(+pb[1], +pb[2] - 1, +pb[3]);
  return Math.round((tb - ta) / 86400000);
}

/** 碎股允許，取 6 位小數。刻意不取整，否則低價股會被截掉可觀比例。 */
function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/* ==========================================================================
   帳本（持久化）
   ========================================================================== */

/**
 * @param {object} opts
 * @param {string} [opts.filePath]   帳本路徑；null = 只在記憶體（測試用）
 * @param {object} opts.datasource   lib/datasource（取 K 線與匯率）
 * @param {number} [opts.capitalUsd] 每筆本金，預設 10,000
 * @param {function} [opts.now]      時鐘注入，測試用
 */
function create(opts = {}) {
  const filePath = opts.filePath === undefined ? DEFAULT_FILE : opts.filePath;
  const datasource = opts.datasource || null;
  const capitalUsd = num(opts.capitalUsd) > 0 ? num(opts.capitalUsd) : DEFAULT_CAPITAL_USD;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => new Date();

  const state = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    capitalUsd,
    records: [],
  };

  /** 最近一次載入遇到的問題（損壞檔案、版本不符），供上層回報而非靜默 */
  let recovered = null;
  let saveCount = 0;

  function load() {
    if (!filePath || !fs.existsSync(filePath)) return { loaded: false };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      // 損壞的帳本不可以直接蓋掉——那是歷史交易紀錄。
      const bak = `${filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(filePath, bak); } catch { /* 備份失敗不阻擋啟動 */ }
      recovered = { reason: e.message, backup: bak };
      return { loaded: false, corrupt: true };
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.records)) {
      recovered = { reason: '檔案結構不是預期的 { records: [...] }', backup: null };
      return { loaded: false, corrupt: true };
    }
    if (raw.schemaVersion != null && raw.schemaVersion !== SCHEMA_VERSION) {
      // 版本不同不強行解讀：寧可明確報錯，也不要默默誤讀歷史交易
      throw new Error(
        `推介帳本版本 ${raw.schemaVersion} 與程式預期的 ${SCHEMA_VERSION} 不符，請先遷移（${filePath}）`
      );
    }
    state.createdAt = raw.createdAt || state.createdAt;
    state.updatedAt = raw.updatedAt || null;
    state.records = raw.records;
    if (num(raw.capitalUsd) > 0) state.capitalUsd = num(raw.capitalUsd);
    return { loaded: true, count: state.records.length };
  }

  function save() {
    if (!filePath) return { ok: true, memoryOnly: true };
    state.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 原子寫入：tmp → rename。程式中途崩潰時，讀者只會看到舊版或新版，不會看到半個檔。
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, filePath);
    saveCount += 1;
    return { ok: true, file: filePath, bytes: fs.statSync(filePath).size };
  }

  /* ------------------------------------------------------------------
     建立推介記錄
     ------------------------------------------------------------------ */

  /**
   * 主鍵。`(推介日, 代碼)` 唯一 —— 這就是「同日不得重複推薦同一股票」的實作，
   * 用字串比對而非陣列搜尋，避免大小寫與前後空白造成漏判。
   */
  function recordId(symbol, pickDate) {
    return `${String(symbol).trim().toUpperCase()}@${pickDate}`;
  }

  function hasOpenFor(symbol) {
    const s = String(symbol).trim().toUpperCase();
    return state.records.some(
      (r) => String(r.symbol).toUpperCase() === s && !FINAL_STATUS.has(r.status)
    );
  }

  /**
   * 從一筆篩選結果建立推介。
   *
   * @param {object} row        lib/screener 的輸出（需含 symbol/name/zoneLower/zoneUpper/zoneStop/zoneTarget）
   * @param {object} o          { pickDate, source, allowOpenDuplicate }
   * @returns {{action:string, reason?:string, record?:object}}
   *   action: inserted | duplicate-day | duplicate-open | invalid
   */
  function addPick(row, o = {}) {
    if (!row || !row.symbol) return { action: 'invalid', reason: '缺少股票代碼' };

    const pickDate = o.pickDate || todayKey(nowFn());
    const symbol = String(row.symbol).trim().toUpperCase();
    const id = recordId(symbol, pickDate);

    // ① 同日同股：直接擋下
    if (state.records.some((r) => r.id === id)) {
      return { action: 'duplicate-day', reason: `${symbol} 在 ${pickDate} 已有推介記錄` };
    }

    const buyLow = num(row.zoneLower);
    const buyHigh = num(row.zoneUpper);
    const stopPrice = num(row.zoneStop);
    const targetPrice = num(row.zoneTarget);
    const refPrice = num(row.price);

    // 價格齊全才可追蹤。缺價格的記錄不可能結算，收進來只會讓帳本長出一堆死列。
    if (!(buyLow > 0) || !(buyHigh > 0) || !(stopPrice > 0) || !(targetPrice > 0)) {
      return {
        action: 'invalid',
        reason: `${symbol} 缺少完整的買區／止賺／止蝕價，無法追蹤`,
      };
    }
    // 區間順序顛倒代表上游算錯，寧可不收也不要算錯
    if (!(stopPrice < buyLow && buyLow <= buyHigh && buyHigh < targetPrice)) {
      return {
        action: 'invalid',
        reason: `${symbol} 價格區間不合理（止蝕 ${stopPrice} / 買區 ${buyLow}–${buyHigh} / 止賺 ${targetPrice}）`,
      };
    }

    // ② 同股仍有未結案交易：預設不再開新的一筆。
    //    理由：本金只有 10,000，同一時間不可能在同一檔上投入兩份本金；
    //    若允許，累計報酬的分母會失真。可用 allowOpenDuplicate 覆寫。
    if (!o.allowOpenDuplicate && hasOpenFor(symbol)) {
      const open = state.records.find(
        (r) => String(r.symbol).toUpperCase() === symbol && !FINAL_STATUS.has(r.status)
      );
      return {
        action: 'duplicate-open',
        reason: `${symbol} 已有未結案記錄（${STATUS_LABEL[open.status]}，${open.pickDate} 推介）`,
        record: open,
      };
    }

    const record = {
      id,
      symbol,
      name: String(row.name || symbol).trim(),
      market: row.market || null,
      currency: row.currency || (row.market === 'HK' ? 'HKD' : 'USD'),
      pickDate,
      // 篩選當時的參考價與評分，純記錄用途（不參與損益計算）
      refPrice,
      score: num(row.score),
      verdict: row.verdict && row.verdict.level ? row.verdict.level : null,
      // 使用者要求的四個價：建議買入價（區間）、止賺、止蝕
      buyLow,
      buyHigh,
      stopPrice,
      targetPrice,
      status: 'pending',
      entry: null,
      exit: null,
      pnl: null,
      settled: false,
      lastCheck: null,
      history: [{
        at: new Date(nowFn()).toISOString(),
        status: 'pending',
        change: '建立推介',
        source: o.source || 'manual',
      }],
    };

    state.records.push(record);
    return { action: 'inserted', record };
  }

  /**
   * 批次建立：把某日清單中「條件最佳」的前 N 檔收進來。
   * @param {Array} rows
   * @param {object} o { pickDate, limit, minScore, allowOpenDuplicate, source }
   */
  function addPicks(rows, o = {}) {
    const limit = num(o.limit) > 0 ? num(o.limit) : 5;
    const minScore = num(o.minScore) == null ? 0 : num(o.minScore);
    const list = Array.isArray(rows) ? rows : [];

    // 依技術評分排序（分數相同時用代碼排序，確保同一天重跑結果穩定可重現）
    const ranked = list
      .filter((r) => r && r.symbol && (num(r.score) == null || num(r.score) >= minScore))
      .slice()
      .sort((a, b) => {
        const d = (num(b.score) || 0) - (num(a.score) || 0);
        if (d !== 0) return d;
        return String(a.symbol).localeCompare(String(b.symbol));
      });

    const out = { inserted: [], duplicatesDay: [], duplicatesOpen: [], invalid: [], considered: ranked.length };

    for (const row of ranked) {
      if (out.inserted.length >= limit) break;
      const r = addPick(row, o);
      if (r.action === 'inserted') out.inserted.push(r.record);
      else if (r.action === 'duplicate-day') out.duplicatesDay.push({ symbol: row.symbol, reason: r.reason });
      else if (r.action === 'duplicate-open') out.duplicatesOpen.push({ symbol: row.symbol, reason: r.reason });
      else out.invalid.push({ symbol: row.symbol, reason: r.reason });
    }
    return out;
  }

  /* ------------------------------------------------------------------
     更新：取價 → 套狀態機
     ------------------------------------------------------------------ */

  /** 依最舊未結案記錄決定要抓多長的 K 線，避免每檔都拉整年 */
  function neededRange(oldestDate) {
    const d = daysBetween(oldestDate, todayKey(nowFn()));
    if (d == null) return '1y';
    if (d <= 80) return '3mo';
    if (d <= 160) return '6mo';
    if (d <= 320) return '1y';
    return '2y';
  }

  /**
   * 對單一記錄套用日線，回傳是否變更。
   * 這是整個模組的核心，所有價格判定都在這裡，且只依賴傳入的 K 線——
   * 不自己去抓資料，因此可以完全離線單元測試。
   */
  function applyCandles(record, candles, fx) {
    if (record.settled) return { changed: false, reason: '已結案' };
    const before = JSON.stringify({ s: record.status, e: record.entry, x: record.exit });

    // 只保留「推介日之後」的 K 線 —— ①前視偏差防護
    const bars = (candles || [])
      .map((c) => ({ ...c, key: dateKeyFromMs(c.t) }))
      .filter((c) => c.key && c.key > record.pickDate)
      .sort((a, b) => (a.t > b.t ? 1 : a.t < b.t ? -1 : 0));

    for (const bar of bars) {
      const o = num(bar.o), h = num(bar.h), l = num(bar.l), cpx = num(bar.c);
      if (!(o > 0) || !(h > 0) || !(l > 0)) continue;

      /* ---- 待買入 → 持倉中 ---- */
      if (record.status === 'pending') {
        // 限價單掛在買區上沿
        if (o <= record.buyHigh) {
          fillEntry(record, o, bar.key, fx);
        } else if (l <= record.buyHigh) {
          fillEntry(record, record.buyHigh, bar.key, fx);
        }
        if (record.status !== 'holding') continue;      // 這根沒成交，看下一根
        // ③ 建倉當天不判出場
        record.lastCheck = { date: bar.key, price: cpx };
        continue;
      }

      /* ---- 持倉中 → 已止賺 / 已止蝕 ---- */
      if (record.status === 'holding') {
        const hitStop = l <= record.stopPrice;
        const hitTarget = h >= record.targetPrice;

        if (hitStop && hitTarget) {
          // ② 同日兩邊都碰到 → 保守假設先止蝕
          closeExit(record, Math.min(record.stopPrice, o), bar.key, 'stop_hit',
            '同日觸及止蝕與止賺，日線無法判定先後，保守取止蝕', fx);
        } else if (hitStop) {
          // 跳空低開 → 以開盤價成交（比止蝕價更差，符合實況）
          closeExit(record, o < record.stopPrice ? o : record.stopPrice, bar.key, 'stop_hit', null, fx);
        } else if (hitTarget) {
          // 跳空高開 → 以開盤價成交（比止賺價更好，符合實況）
          closeExit(record, o > record.targetPrice ? o : record.targetPrice, bar.key, 'target_hit', null, fx);
        }

        record.lastCheck = { date: bar.key, price: cpx };
      }

      if (record.settled) break;
    }

    // 尚未結案的，用最後一根收盤價算浮動損益
    if (!record.settled && record.status === 'holding') markToMarket(record, fx);

    const after = JSON.stringify({ s: record.status, e: record.entry, x: record.exit });
    return { changed: before !== after, status: record.status };
  }

  function fillEntry(record, price, date, fx) {
    const fxMod = require('./fx');
    const fxRate = fx && isFinite(fx.rate) ? fx.rate : (record.currency === 'USD' ? 1 : null);

    // 本金 10,000 美元 → 先換成原幣，再除以成交價得股數（允許碎股）。
    // 換算一律走 fx.toLocal／fx.toUsd，不在這裡自己寫乘除：
    // 匯率的方向（乘還是除）是這種程式最容易寫反的一行，
    // 集中在一處才只有一個地方會錯，也才只有一處需要測試。
    const capitalLocal = fxMod.toLocal(capitalUsd, fxRate);
    if (capitalLocal == null) return;   // 算不出匯率就不建倉，避免寫入一筆永遠算不對的交易

    const shares = round6(capitalLocal / price);
    if (!(shares > 0)) return;

    record.status = 'holding';
    record.entry = {
      date,
      price: round2(price),
      fxRate,
      fxEstimated: !!(fx && fx.estimated),
      shares,
      costLocal: round2(shares * price),
      costUsd: round2(capitalUsd),
    };
    record.history.push({
      at: new Date(nowFn()).toISOString(),
      status: 'holding',
      change: `觸及買區，以 ${round2(price)} 成交`,
      price: round2(price),
    });
  }

  function closeExit(record, price, date, status, note, fx) {
    if (!record.entry) return;
    const fxMod = require('./fx');
    const fxRate = fx && isFinite(fx.rate) ? fx.rate : (record.currency === 'USD' ? 1 : null);

    const px = round2(price);
    const proceedsLocal = round2(record.entry.shares * px);
    const pnlLocal = round2(proceedsLocal - record.entry.costLocal);
    const proceedsUsd = round2(fxMod.toUsd(proceedsLocal, fxRate));
    if (proceedsUsd == null) return;
    const pnlUsd = round2(proceedsUsd - record.entry.costUsd);

    record.status = status;
    record.exit = {
      date,
      price: px,
      fxRate,
      fxEstimated: !!(fx && fx.estimated),
      proceedsLocal,
      proceedsUsd,
      reason: status === 'target_hit' ? '觸及止賺價' : '觸及止蝕價',
      note: note || null,
    };
    record.pnl = {
      amountLocal: pnlLocal,
      amountUsd: pnlUsd,
      // 回報率以美元本金為分母（與「10,000 美元本金」同一個口徑）
      returnPct: round2((pnlUsd / record.entry.costUsd) * 100),
      // 純價格報酬：排除匯率影響，讓使用者能分辨「是股票賺還是匯率賺」
      priceReturnPct: round2(((px - record.entry.price) / record.entry.price) * 100),
      holdingDays: daysBetween(record.entry.date, date),
      realized: true,
    };
    record.settled = true;    // 終態，之後不再重算
    record.history.push({
      at: new Date(nowFn()).toISOString(),
      status,
      change: `${record.exit.reason}，以 ${px} 出場`,
      price: px,
      note: note || null,
    });
  }

  /** 未結案的持倉：用最新收盤價算浮動損益（不寫入 settled，僅供顯示） */
  function markToMarket(record, fx) {
    if (!record.entry) return;
    const last = record.lastCheck && num(record.lastCheck.price);
    if (!(last > 0)) return;
    const fxMod = require('./fx');
    const fxRate = fx && isFinite(fx.rate) ? fx.rate : (record.currency === 'USD' ? 1 : null);

    const valueLocal = round2(record.entry.shares * last);
    const pnlLocal = round2(valueLocal - record.entry.costLocal);
    const valueUsd = round2(fxMod.toUsd(valueLocal, fxRate));
    if (valueUsd == null) return;
    record.pnl = {
      amountLocal: pnlLocal,
      amountUsd: round2(valueUsd - record.entry.costUsd),
      returnPct: round2(((valueUsd - record.entry.costUsd) / record.entry.costUsd) * 100),
      priceReturnPct: round2(((last - record.entry.price) / record.entry.price) * 100),
      holdingDays: daysBetween(record.entry.date, todayKey(nowFn())),
      realized: false,
      markPrice: last,
    };
  }

  /** 簡單併發池：一次跑 N 檔，避免對上游瞬間打出上百個請求 */
  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await fn(items[idx], idx); }
        catch (e) { out[idx] = { ok: false, error: e.message }; }
      }
    });
    await Promise.all(workers);
    return out;
  }

  /**
   * 每日更新：抓未結案記錄的日線，推進狀態，算損益，存檔。
   * @param {object} o { concurrency, force }
   */
  async function update(o = {}) {
    if (!datasource) throw new Error('update() 需要 datasource');
    const fxMod = require('./fx');

    const open = state.records.filter((r) => !r.settled);
    if (!open.length) return { ran: false, reason: '沒有未結案記錄', checked: 0, changed: 0, records: [] };

    const concurrency = num(o.concurrency) > 0 ? num(o.concurrency) : 4;
    const oldest = open.map((r) => r.pickDate).sort()[0];
    const range = neededRange(oldest);

    // 匯率只需一次（同一批更新共用），快取在 fx 模組內
    const fxByCurrency = {};
    for (const cur of new Set(open.map((r) => r.currency || 'USD'))) {
      try { fxByCurrency[cur] = await fxMod.ratePerUsd(cur, datasource); }
      catch (e) { fxByCurrency[cur] = { rate: null, estimated: true, error: e.message }; }
    }

    const results = await pool(open, concurrency, async (rec) => {
      const fx = fxByCurrency[rec.currency || 'USD'];
      let chart;
      try {
        chart = await datasource.chart(rec.symbol, range, '1d');
      } catch (e) {
        rec.lastError = { at: new Date(nowFn()).toISOString(), message: e.message };
        return { id: rec.id, ok: false, error: e.message };
      }
      const candles = (chart && chart.candles) || [];
      if (!candles.length) {
        rec.lastError = { at: new Date(nowFn()).toISOString(), message: '上游回傳空 K 線' };
        return { id: rec.id, ok: false, error: '上游回傳空 K 線' };
      }
      const r = applyCandles(rec, candles, fx);
      if (rec.settled) delete rec.lastError;
      return { id: rec.id, ok: true, changed: r.changed, status: rec.status };
    });

    const changed = results.filter((r) => r && r.ok && r.changed).length;
    const failed = results.filter((r) => r && r.ok === false);
    const saved = save();

    return {
      ran: true,
      checked: open.length,
      changed,
      failed: failed.length,
      failures: failed,
      range,
      fx: Object.fromEntries(Object.entries(fxByCurrency).map(([k, v]) => [k, {
        rate: v.rate, estimated: !!v.estimated, source: v.source,
      }])),
      saved,
      records: results,
    };
  }

  /* ------------------------------------------------------------------
     查詢
     ------------------------------------------------------------------ */

  function list(o = {}) {
    let rows = state.records.slice();
    if (o.status) {
      const want = Array.isArray(o.status) ? o.status : [o.status];
      rows = rows.filter((r) => want.includes(r.status));
    }
    if (o.symbol) rows = rows.filter((r) => r.symbol === String(o.symbol).toUpperCase());
    if (o.from) rows = rows.filter((r) => r.pickDate >= o.from);
    if (o.to) rows = rows.filter((r) => r.pickDate <= o.to);
    // 新的在前；同一天用代碼排序，確保順序穩定
    rows.sort((a, b) => {
      if (a.pickDate !== b.pickDate) return a.pickDate < b.pickDate ? 1 : -1;
      return String(a.symbol).localeCompare(String(b.symbol));
    });
    return num(o.limit) > 0 ? rows.slice(0, num(o.limit)) : rows;
  }

  /**
   * 累計盈虧摘要。
   *
   * 關鍵：**累計報酬率的分母是「已投入總成本」，不是 10,000。**
   * 因為每筆交易各自使用 10,000 本金，十筆結案交易實際動用 100,000。
   * 若用 10,000 當分母，10 筆各賺 5% 會變成「+50%」，是錯的。
   */
  function summary() {
    const all = state.records;
    const byStatus = {};
    for (const s of STATUS_ORDER) byStatus[s] = 0;
    for (const r of all) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

    const closed = all.filter((r) => r.settled && r.pnl);
    const open = all.filter((r) => !r.settled && r.pnl);

    const realizedUsd = round2(closed.reduce((s, r) => s + (num(r.pnl.amountUsd) || 0), 0));
    const deployedUsd = round2(closed.reduce((s, r) => s + (num(r.entry && r.entry.costUsd) || 0), 0));
    const unrealizedUsd = round2(open.reduce((s, r) => s + (num(r.pnl.amountUsd) || 0), 0));
    const openCostUsd = round2(open.reduce((s, r) => s + (num(r.entry && r.entry.costUsd) || 0), 0));

    const wins = closed.filter((r) => num(r.pnl.amountUsd) > 0);
    const losses = closed.filter((r) => num(r.pnl.amountUsd) < 0);
    const holdDays = closed.map((r) => num(r.pnl.holdingDays)).filter((v) => v != null);

    const sum = (arr, k) => arr.reduce((s, r) => s + (num(r.pnl[k]) || 0), 0);

    return {
      // 使用者最在意的三件事
      realizedPnlUsd: realizedUsd,
      unrealizedPnlUsd: unrealizedUsd,
      totalPnlUsd: round2(realizedUsd + unrealizedUsd),
      // 分母說明見上
      realizedReturnPct: deployedUsd > 0 ? round2((realizedUsd / deployedUsd) * 100) : null,
      deployedUsd,
      openCostUsd,
      openReturnPct: openCostUsd > 0 ? round2((unrealizedUsd / openCostUsd) * 100) : null,

      counts: {
        total: all.length,
        ...byStatus,
        closed: closed.length,
        open: open.length,
        wins: wins.length,
        losses: losses.length,
      },
      winRate: closed.length ? round2((wins.length / closed.length) * 100) : null,
      avgWinUsd: wins.length ? round2(sum(wins, 'amountUsd') / wins.length) : null,
      avgLossUsd: losses.length ? round2(sum(losses, 'amountUsd') / losses.length) : null,
      avgHoldingDays: holdDays.length ? round2(holdDays.reduce((a, b) => a + b, 0) / holdDays.length) : null,
      // 平均單筆報酬（等權），與上面的資金加權報酬率互補
      avgReturnPct: closed.length ? round2(sum(closed, 'returnPct') / closed.length) : null,
      capitalUsd,
      note: '累計報酬率＝已實現損益總額 ÷ 已投入總成本（每筆各自 10,000 美元本金，故分母為筆數 × 10,000 的實際投入額）',
    };
  }

  function get(id) {
    return state.records.find((r) => r.id === id) || null;
  }

  return {
    // 生命週期
    load, save, update,
    // 寫入
    addPick, addPicks,
    // 查詢
    list, summary, get,
    // 內部（測試用）
    applyCandles, markToMarket, aside: { fillEntry, closeExit },
    // 狀態
    get state() { return state; },
    get records() { return state.records; },
    get recovered() { return recovered; },
    get saveCount() { return saveCount; },
    capitalUsd,
  };
}

module.exports = {
  create,
  SCHEMA_VERSION,
  DEFAULT_FILE,
  DEFAULT_CAPITAL_USD,
  STATUS_LABEL,
  STATUS_ORDER,
  FINAL_STATUS,
  dateKeyFromMs,
  daysBetween,
};
