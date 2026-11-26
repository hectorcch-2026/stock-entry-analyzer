'use strict';

/**
 * 經濟資料庫 — 持久化儲存層
 * ==========================
 *
 * 目的：把抓回來的宏觀／財報數據「落地」，讓同一筆資料不需要每次重抓。
 * 需要的是三件事：**寫入、查詢、更新**，外加兩個必須想清楚的難題——
 * 「重複資料怎麼辦」與「資料已存在時該怎麼更新」。
 *
 * ── 為什麼不用 SQLite ────────────────────────────────────────
 * Node 22.5+ 內建 `node:sqlite`，看起來是零依賴的最佳解。但本專案的
 * **部署環境是 Node 20**（Dockerfile `FROM node:20-alpine`、
 * render.yaml `NODE_VERSION=20`），而 `node:sqlite` 在 Node 20 並不存在。
 * 用它在本機（v22）開發會全部通過，一上線就 `MODULE_NOT_FOUND`。
 * 專案又規定 `dependencies: {}`，不能用 better-sqlite3。
 *
 * 因此沿用本專案既有的落地模式（`lib/screener.js`、`lib/scheduler.js`
 * 都是 JSON 檔），但補上它原本缺少的兩件事：**原子寫入** 與 **唯一鍵去重**。
 * 資料量級（18 條序列 × 約 1000 期 ≈ 2 萬列）用 JSON 完全夠，且可直接
 * 用肉眼檢查、用 git 比對、用任何工具讀。
 *
 * ── 三張表（邏輯上）────────────────────────────────────────
 *
 *   ① series        指標主檔：指標名稱、單位、統計週期、資料來源…
 *                   唯一鍵 seriesKey
 *   ② observations  觀測值：某指標在某期間的值
 *                   唯一鍵 (seriesKey, period) ← 這就是「唯一標識」
 *   ③ revisions     修訂軌跡：值被改過幾次、從什麼改成什麼、何時改的
 *                   這是「更新」與「覆寫」的差別所在
 *
 * ── 物理上是一個檔 ─────────────────────────────────────────
 * 三個表存在同一個 `state.json` 裡。理由是**原子性**：
 * 檔案替換（write tmp → rename）是作業系統層級的原子操作，
 * 一次 rename 就能讓三張表同時生效；若拆成三個檔，
 * 中途崩潰會留下「值已更新但修訂紀錄沒寫」的不一致狀態。
 *
 * ── 更新邏輯（本模組的核心）────────────────────────────────
 * 見 `decide()` 的註解。一句話：**不是「有就覆寫」，而是逐項判斷**。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const DEFAULT_META_FILE = 'state.json';

/** 統計週期 → 正規化後的期間格式 */
const PERIOD_FORMAT = {
  D: 'YYYY-MM-DD', // 日
  W: 'YYYY-MM-DD', // 週（以該週代表日表示）
  M: 'YYYY-MM',    // 月
  Q: 'YYYY-Qn',    // 季
  Y: 'YYYY',       // 年
};

const DAY_FREQS = new Set(['D', 'W']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 解析日期字串的前三段。
 * 刻意不用 `new Date()`：`new Date('2026-10-01')` 在部分環境被當成 UTC、
 * 部分被當成本地時間，跨時區會位移一天。手動解析才是可預測的。
 */
function parseDateParts(input) {
  const s = String(input == null ? '' : input).trim();
  const m = /^(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] == null ? null : Number(m[2]);
  const d = m[3] == null ? null : Number(m[3]);
  if (mo != null && (mo < 1 || mo > 12)) return null;
  if (d != null && (d < 1 || d > 31)) return null;
  return { y, m: mo, d };
}

/**
 * 把任意日期字串正規化成該頻率的標準期間鍵。
 *
 * 這是去重的關鍵。同一個月，FRED 給 `2026-10-01`、TE 可能給 `2026-09-30`
 * （月末），若直接拿字串當鍵，同一個月會被存成兩筆，圖表就出現
 * 「同月兩個點」。正規化成 `YYYY-MM` 之後才會收斂成一筆。
 *
 * 這也對應文件裡記過的陷阱：月頻資料的「日」不可靠，只取年月。
 *
 * @returns {string|null} 正規化期間；無法解析時為 null（呼叫端應跳過該列）
 */
function normalizePeriod(input, freq) {
  const f = String(freq || 'M').toUpperCase();
  const p = parseDateParts(input);
  if (!p) return null;

  if (f === 'Y') return String(p.y);
  if (f === 'Q') {
    const mo = p.m || 1; // 只有年份時視為 Q1，但這種輸入本身可疑，交呼叫端判斷
    return `${p.y}-Q${Math.ceil(mo / 3)}`;
  }
  if (DAY_FREQS.has(f)) {
    // 日／週頻必須有完整年月日；缺日代表上游格式不對，不可以猜
    if (!p.m || !p.d) return null;
    return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  }
  // 預設月頻
  if (!p.m) return null;
  return `${p.y}-${pad2(p.m)}`;
}

/** 唯一標識：seriesKey|period。用管線符號是因為兩者都不可能含有它。 */
function observationId(seriesKey, period) {
  return `${seriesKey}|${period}`;
}

function splitObservationId(id) {
  const s = String(id == null ? '' : id);
  const i = s.indexOf('|');
  if (i <= 0) return null;
  return { seriesKey: s.slice(0, i), period: s.slice(i + 1) };
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    tables: { series: [], observations: [], revisions: [] },
  };
}

/**
 * 建立／載入一個 store。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.dir]  資料目錄；傳 null 表示純記憶體（測試用，不落地）
 * @param {string} [opts.file]      檔名，預設 state.json
 * @param {boolean} [opts.autoSave] 每次異動後自動落地，預設 true
 * @param {number} [opts.maxRevisions] 修訂紀錄上限，預設 5000
 */
function openStore(opts) {
  const o = opts || {};
  const dir = o.dir === null ? null : (o.dir || path.join(__dirname, '..', 'data', 'econ-store'));
  const file = o.file || DEFAULT_META_FILE;
  const autoSave = o.autoSave !== false;
  const maxRevisions = Number.isFinite(o.maxRevisions) ? o.maxRevisions : 5000;

  const filePath = dir ? path.join(dir, file) : null;

  let state = emptyState();
  /** seriesKey → series 物件 */
  const seriesByKey = new Map();
  /** `seriesKey|period` → observation 物件 */
  const obsById = new Map();
  /** 資料檔損壞時，備份到哪裡（不刪除，只改名） */
  let recovered = null;

  // ── 載入 ────────────────────────────────────────────────
  function rebuildIndexes() {
    seriesByKey.clear();
    obsById.clear();
    for (const s of state.tables.series) seriesByKey.set(s.seriesKey, s);
    for (const ob of state.tables.observations) obsById.set(ob.id, ob);
  }

  function load() {
    if (!filePath || !fs.existsSync(filePath)) return { loaded: false };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      // 損壞的檔案不可以直接蓋掉——那是使用者的資料。
      // 改名備份後以空庫啟動，並透過 recovered 對外說明發生了什麼。
      const bak = `${filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(filePath, bak); } catch { /* 備份失敗也不阻擋啟動 */ }
      recovered = { reason: e.message, backup: bak };
      return { loaded: false, corrupt: true };
    }

    if (!raw || typeof raw !== 'object' || !raw.tables) {
      recovered = { reason: '檔案結構不是預期的 { tables: {...} }', backup: null };
      return { loaded: false, corrupt: true };
    }

    // 版本不同時不強行解讀，寧可明確報錯也不要默默誤讀
    if (raw.schemaVersion != null && raw.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `econ-store 檔案版本 ${raw.schemaVersion} 與程式預期的 ${SCHEMA_VERSION} 不符，`
        + `請先遷移資料（${filePath}）`
      );
    }

    state = {
      schemaVersion: SCHEMA_VERSION,
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || null,
      tables: {
        series: Array.isArray(raw.tables.series) ? raw.tables.series : [],
        observations: Array.isArray(raw.tables.observations) ? raw.tables.observations : [],
        revisions: Array.isArray(raw.tables.revisions) ? raw.tables.revisions : [],
      },
    };
    rebuildIndexes();
    return { loaded: true, counts: stats().counts };
  }

  // ── 落地 ────────────────────────────────────────────────
  let saveCount = 0;

  /**
   * 原子寫入：先寫 .tmp，再 rename 覆蓋。
   * 直接 writeFile 到目標檔的話，寫到一半斷電會留下半個 JSON，
   * 下次啟動就整庫解析失敗。rename 在同一檔案系統上是原子的。
   */
  function save() {
    if (!filePath) return { ok: true, memoryOnly: true };
    fs.mkdirSync(dir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, filePath);
    saveCount += 1;
    return { ok: true, file: filePath, bytes: fs.statSync(filePath).size };
  }

  function maybeSave() {
    if (autoSave) return save();
    return { ok: true, deferred: true };
  }

  // ── 表① series：指標主檔 ─────────────────────────────────
  /**
   * 寫入／更新指標主檔。以 seriesKey 為唯一鍵，已存在則合併可更新欄位。
   * 回傳 { action: 'inserted'|'updated'|'unchanged' }
   */
  function writeSeries(meta) {
    if (!meta || !meta.seriesKey) {
      throw new Error('writeSeries 需要 seriesKey');
    }
    const now = new Date().toISOString();
    const freq = String(meta.frequency || meta.freq || 'M').toUpperCase();
    const existing = seriesByKey.get(meta.seriesKey);

    const fields = {
      seriesKey: meta.seriesKey,
      label: meta.label || meta.seriesKey,
      unit: meta.unit != null ? meta.unit : '',
      frequency: freq,
      periodFormat: PERIOD_FORMAT[freq] || 'YYYY-MM',
      source: meta.source || null,
      sourceId: meta.sourceId || meta.id || null,
      sourceUrl: meta.sourceUrl || null,
      definition: meta.definition || null,
      note: meta.note || null,
    };

    if (!existing) {
      const row = { ...fields, createdAt: now, updatedAt: now };
      state.tables.series.push(row);
      seriesByKey.set(row.seriesKey, row);
      maybeSave();
      return { action: 'inserted', seriesKey: row.seriesKey };
    }

    // 只覆寫「有給值」的欄位，避免一次不完整的呼叫把既有說明白白清空
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      if (v == null || v === '') continue;
      if (existing[k] !== v) { existing[k] = v; changed = true; }
    }
    // 這筆原本是寫入時自動補的最小主檔，現在拿到真定義了——把標記拿掉
    if (existing.autoCreated) {
      delete existing.autoCreated;
      changed = true;
    }
    if (!changed) return { action: 'unchanged', seriesKey: existing.seriesKey };
    existing.updatedAt = now;
    maybeSave();
    return { action: 'updated', seriesKey: existing.seriesKey };
  }

  function getSeries(seriesKey) {
    return seriesByKey.get(seriesKey) || null;
  }

  function listSeries() {
    return state.tables.series.map((s) => ({ ...s }));
  }

  // ── 更新決策（核心）──────────────────────────────────────
  /**
   * 決定「已存在的資料遇到新資料時該怎麼辦」。
   *
   * 這不是「有就覆寫」。六種情況要分開處理：
   *
   *   1. 沒有既有紀錄                    → insert
   *   2. 新值為 null                     → skip（null 是「沒資料」，不是「值為 0」；
   *                                        絕不可用它蓋掉已抓到的真值）
   *   3. 值完全相同                      → unchanged（不寫檔、不記修訂，
   *                                        這就是「避免每次重新抓取」的效果）
   *   4. 來源更新時間比既有的更舊        → skip stale（遲到的舊回應不可覆蓋新資料）
   *   5. 值不同                          → update + 記一筆 revision
   *   6. 值不同但來源更新時間未提供      → update + 記 revision（保守：以值為準）
   *
   * @returns {{action:string, reason?:string}}
   */
  function decide(existing, incoming) {
    const hasValue = incoming.value != null && Number.isFinite(Number(incoming.value));

    if (!hasValue) {
      return existing
        ? { action: 'skip', reason: 'null-does-not-overwrite' }
        : { action: 'skip', reason: 'null-value' };
    }

    const value = Number(incoming.value);

    if (!existing) return { action: 'insert', value };

    // 值相同：連 updatedAt 都不動，保持「這筆沒變」的語義
    if (existing.value === value) return { action: 'unchanged', value };

    // 來源時間倒退 → 遲到的舊資料。用日期字串比大小在 ISO 格式下是正確的
    const incAt = incoming.sourceUpdatedAt || null;
    const curAt = existing.sourceUpdatedAt || null;
    if (incAt && curAt && String(incAt) < String(curAt)) {
      return { action: 'skip', reason: 'stale-source' };
    }

    return { action: 'update', value, prevValue: existing.value };
  }

  /**
   * 寫入單筆觀測值（upsert）。這是「寫入」與「更新」共用的入口。
   */
  function write(row) {
    const report = writeMany([row]);
    if (report.errors.length) {
      const e = new Error(report.errors[0].reason);
      e.code = 'WRITE_REJECTED';
      throw e;
    }
    return {
      action: report.inserted ? 'inserted'
        : report.updated ? 'updated'
          : report.unchanged ? 'unchanged' : 'skipped',
      reason: report.skipped[0] ? report.skipped[0].reason : null,
      id: report.ids[0] || null,
    };
  }

  /**
   * 批次寫入。回傳統計報表——這份報表就是「有沒有重複寫入」的證據。
   *
   * @param {Array<object>} rows 每列需有 seriesKey、period（或 date）、value
   */
  function writeMany(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const now = new Date().toISOString();
    const report = {
      received: list.length,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: [],
      errors: [],
      revisions: 0,
      duplicatesInBatch: 0,
      ids: [],
    };
    const seenInBatch = new Set();
    let dirty = false;

    for (let i = 0; i < list.length; i += 1) {
      const raw = list[i];
      if (!raw || typeof raw !== 'object') {
        report.errors.push({ index: i, reason: 'not-an-object' });
        continue;
      }

      const seriesKey = raw.seriesKey;
      if (!seriesKey) {
        report.errors.push({ index: i, reason: 'missing-seriesKey' });
        continue;
      }

      // 頻率：優先看該列，其次回查主檔，最後預設月頻
      let series = seriesByKey.get(seriesKey);
      const freq = String(raw.frequency || raw.freq || (series && series.frequency) || 'M').toUpperCase();

      // 主檔不存在時自動補一筆「最小主檔」。
      //
      // 為什麼不直接拒絕：實測發現「寫得進去、卻查不出來」——查詢端點會因為
      // 主檔不存在而回 404，使用者明明寫成功了卻什麼都讀不到，這比允許寫入更糟。
      // 標記 autoCreated，讓日後 sync 能用真正的 label／單位／定義把它補完整
      // （writeSeries 對已存在的 key 是合併更新，不會產生第二筆）。
      if (!series) {
        const row0 = {
          seriesKey,
          label: raw.label || seriesKey,
          unit: raw.unit != null ? raw.unit : '',
          frequency: freq,
          periodFormat: PERIOD_FORMAT[freq] || 'YYYY-MM',
          source: raw.source || null,
          sourceId: raw.sourceId || null,
          sourceUrl: null,
          definition: null,
          note: null,
          autoCreated: true,
          createdAt: now,
          updatedAt: now,
        };
        state.tables.series.push(row0);
        seriesByKey.set(seriesKey, row0);
        series = row0;
        dirty = true;
      }

      const period = normalizePeriod(raw.period != null ? raw.period : raw.date, freq);
      if (!period) {
        report.errors.push({
          index: i,
          reason: `unparseable-period:${raw.period != null ? raw.period : raw.date}`,
        });
        continue;
      }

      const id = observationId(seriesKey, period);
      if (seenInBatch.has(id)) report.duplicatesInBatch += 1;
      seenInBatch.add(id);
      report.ids.push(id);

      const existing = obsById.get(id) || null;
      const verdict = decide(existing, raw);

      if (verdict.action === 'skip') {
        report.skipped.push({ id, seriesKey, period, reason: verdict.reason });
        continue;
      }

      if (verdict.action === 'unchanged') {
        report.unchanged += 1;
        continue;
      }

      if (verdict.action === 'insert') {
        const row2 = {
          id,
          seriesKey,
          period,
          value: verdict.value,
          unit: raw.unit != null ? raw.unit : (series ? series.unit : ''),
          frequency: freq,
          source: raw.source || (series ? series.source : null),
          sourceUpdatedAt: raw.sourceUpdatedAt || null,
          firstSeenAt: now,
          updatedAt: now,
          revisionCount: 0,
        };
        state.tables.observations.push(row2);
        obsById.set(id, row2);
        report.inserted += 1;
        dirty = true;
        continue;
      }

      // update：先留修訂紀錄，再改值。順序固定，crash 時寧可多一筆修訂也不要漏記
      const rev = {
        seriesKey,
        period,
        prevValue: verdict.prevValue,
        newValue: verdict.value,
        changedAt: now,
        source: raw.source || existing.source || null,
        reason: raw.reason || 'value-changed',
      };
      state.tables.revisions.push(rev);
      report.revisions += 1;

      existing.value = verdict.value;
      existing.updatedAt = now;
      existing.revisionCount = (existing.revisionCount || 0) + 1;
      if (raw.source) existing.source = raw.source;
      if (raw.sourceUpdatedAt) existing.sourceUpdatedAt = raw.sourceUpdatedAt;
      report.updated += 1;
      dirty = true;
    }

    // 修訂紀錄上限：只丟最舊的，並用 droppedRevisions 記帳，不讓它無聲消失
    if (state.tables.revisions.length > maxRevisions) {
      const drop = state.tables.revisions.length - maxRevisions;
      state.tables.revisions.splice(0, drop);
      state.droppedRevisions = (state.droppedRevisions || 0) + drop;
      dirty = true;
    }

    if (dirty) maybeSave();
    return report;
  }

  /**
   * 依唯一標識更新既有紀錄。找不到就回 NOT_FOUND，不會偷偷插入
   * （更新與寫入的語義要分開，否則打錯 key 會憑空長出一筆資料）。
   */
  function update(seriesKey, period, patch) {
    const p = patch || {};
    const series = seriesByKey.get(seriesKey);
    const freq = String(p.frequency || (series && series.frequency) || 'M').toUpperCase();
    const norm = normalizePeriod(period, freq);
    if (!norm) return { ok: false, code: 'BAD_PERIOD', message: `無法解析期間：${period}` };

    const id = observationId(seriesKey, norm);
    const existing = obsById.get(id);
    if (!existing) return { ok: false, code: 'NOT_FOUND', message: `找不到 ${id}` };

    if (p.value == null) {
      // 只更新來源時間等中介資料，不動值
      if (p.sourceUpdatedAt) { existing.sourceUpdatedAt = p.sourceUpdatedAt; maybeSave(); }
      return { ok: true, action: 'touched', id };
    }

    const r = write({
      seriesKey,
      period: norm,
      value: p.value,
      source: p.source,
      sourceUpdatedAt: p.sourceUpdatedAt,
      frequency: freq,
    });
    return { ok: true, ...r, id };
  }

  // ── 查詢 ────────────────────────────────────────────────
  function get(seriesKey, period) {
    const series = seriesByKey.get(seriesKey);
    const freq = String((series && series.frequency) || 'M').toUpperCase();
    const norm = normalizePeriod(period, freq);
    if (!norm) return null;
    return obsById.get(observationId(seriesKey, norm)) || null;
  }

  /**
   * 查詢觀測值。
   * @param {object} q
   * @param {string} [q.seriesKey] 不給則查全部
   * @param {string} [q.from] 期間下界（含）
   * @param {string} [q.to]   期間上界（含）
   * @param {string} [q.order] 'asc'（預設）| 'desc'
   * @param {number} [q.limit] 取幾筆（搭配 desc 可拿最新 N 筆）
   */
  function query(q) {
    const o = q || {};
    const order = o.order === 'desc' ? 'desc' : 'asc';
    let rows = state.tables.observations;

    if (o.seriesKey) rows = rows.filter((r) => r.seriesKey === o.seriesKey);
    // 期間鍵是字典序可比的（YYYY-MM / YYYY-MM-DD / YYYY / YYYY-Qn 各自內部一致），
    // 所以字串比較就是時間比較——前提是同一序列不混用格式，這由 series.frequency 保證
    if (o.from != null) rows = rows.filter((r) => r.period >= String(o.from));
    if (o.to != null) rows = rows.filter((r) => r.period <= String(o.to));

    const sorted = rows.slice().sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
    const out = order === 'desc' ? sorted.reverse() : sorted;
    const limited = Number.isFinite(o.limit) && o.limit > 0 ? out.slice(0, o.limit) : out;
    return limited.map((r) => ({ ...r }));
  }

  /** 取某序列最新一筆（依期間，不是依寫入時間） */
  function latest(seriesKey) {
    const desc = query({ seriesKey, order: 'desc', limit: 1 });
    return desc[0] || null;
  }

  /** 取某序列「已存的最後 N 期」的期間鍵，可用來判斷是否需要再去抓 */
  function periods(seriesKey) {
    return query({ seriesKey }).map((r) => r.period);
  }

  function revisionsOf(seriesKey, period) {
    return state.tables.revisions
      .filter((r) => r.seriesKey === seriesKey && (period == null || r.period === period))
      .map((r) => ({ ...r }));
  }

  function stats() {
    const bySeries = {};
    for (const ob of state.tables.observations) {
      bySeries[ob.seriesKey] = (bySeries[ob.seriesKey] || 0) + 1;
    }
    return {
      counts: {
        series: state.tables.series.length,
        observations: state.tables.observations.length,
        revisions: state.tables.revisions.length,
      },
      bySeries,
      droppedRevisions: state.droppedRevisions || 0,
      file: filePath,
      bytes: filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
      saves: saveCount,
      recovered,
    };
  }

  /** 匯出完整狀態（備份／除錯用） */
  function exportState() {
    return JSON.parse(JSON.stringify(state));
  }

  const loadResult = load();

  return {
    // 表①
    writeSeries,
    getSeries,
    listSeries,
    // 寫入／更新
    write,
    writeMany,
    update,
    // 查詢
    get,
    query,
    latest,
    periods,
    revisionsOf,
    // 維運
    stats,
    save,
    exportState,
    get filePath() { return filePath; },
    get memoryOnly() { return filePath === null; },
    loadResult,
  };
}

module.exports = {
  openStore,
  normalizePeriod,
  observationId,
  splitObservationId,
  PERIOD_FORMAT,
  SCHEMA_VERSION,
};
