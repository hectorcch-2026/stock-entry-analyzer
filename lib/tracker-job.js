'use strict';

/**
 * 推介追蹤的每日任務 — 把「篩選」與「更新」串成一個可重複執行的動作
 * ==================================================================
 *
 * 為什麼需要這一層，而不是在路由裡直接呼叫：
 *   每日任務其實包含三個彼此依賴的步驟，而**任何一步都可能因為休眠、
 *   上游失敗、使用者中途關頁而只完成一部分**。若把這三段寫在路由裡，
 *   重試時就得從頭再想一遍「哪些做過了」，很容易變成重複推薦或漏推。
 *   集中成一個 `dailyRun()`，讓它自己保證冪等，路由只要呼叫就好。
 *
 * ── 三個步驟 ────────────────────────────────────────────────
 *   ① 補齊歷史清單：掃 `data/picks/*.json`，把「尚未納入帳本」的日期補進來。
 *      這解決「服務休眠三天，醒來後那三天的推介全都不見了」。
 *      只補最近 N 天，避免第一次上線就把幾十天的舊清單全部塞進帳本。
 *   ② 建立當日推介：取最近一個已收盤交易日的清單，挑評分最高的前幾名。
 *   ③ 更新所有未結案記錄：抓日線推進狀態、算損益。
 *
 * ── 冪等性怎麼保證 ──────────────────────────────────────────
 *   ② 靠 `(推介日, 代碼)` 主鍵去重，重跑幾次結果都一樣。
 *   ③ 靠記錄的 `settled` 終態，已結案的不再重算。
 *   ① 靠帳本裡的 `processedPickDates` 清單，標記「這個日期已納入」。
 *      注意這裡刻意**不**用「該日期是否已有記錄」來判斷——
 *      因為某天可能全部被去重擋掉（0 筆新增），但那也是「處理過了」，
 *      若用記錄數判斷就會每天重試同一份清單。
 *
 * ── 為什麼要有節流 ──────────────────────────────────────────
 *   本服務的排程是「訪問觸發」的（見 lib/scheduler.js）。若每次開頁都
 *   完整跑一次，等於把上游當成免費無限資源打。因此非強制執行時，
 *   同一時段內最多跑一次；強制執行（外部 cron 帶 token）則不受限。
 */

const fs = require('fs');
const path = require('path');

const PICKS_DIR = path.join(__dirname, '..', 'data', 'picks');
const STATE_FILE = path.join(__dirname, '..', 'data', 'tracker', 'job-state.json');

/** 非強制執行時的節流間隔（毫秒）。30 分鐘——與 scheduler 的檢查頻率一致。 */
const THROTTLE_MS = 30 * 60 * 1000;

/** 首次啟用時最多回溯幾天的舊清單 */
const DEFAULT_BACKFILL_DAYS = 10;

function readState(file) {
  try {
    if (!fs.existsSync(file)) return { lastRunAt: null, lastRunKey: null };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return { lastRunAt: null, lastRunKey: null };
    return raw;
  } catch (_) {
    return { lastRunAt: null, lastRunKey: null };
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

/** 列出 data/picks 下所有日期檔（新到舊） */
function listPickDates(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace('.json', ''))
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
}

function readPickFile(dir, key) {
  try {
    const f = path.join(dir, `${key}.json`);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} deps
 *   tracker     lib/picks-tracker 的實例
 *   scheduler   lib/scheduler（用於惰性補跑當日清單）
 *   screenDeps  傳給 scheduler.maybeRun 的 { analyzer, forecast, datasource, symbols }
 *   runner      screener（有 screen 方法）
 * @param {object} [opts] { picksDir, stateFile, throttleMs, backfillDays }
 */
function createJob(deps, opts = {}) {
  const tracker = deps.tracker;
  if (!tracker) throw new Error('createJob 需要 tracker');

  const picksDir = opts.picksDir || PICKS_DIR;
  const stateFile = opts.stateFile === undefined ? STATE_FILE : opts.stateFile;
  const throttleMs = opts.throttleMs == null ? THROTTLE_MS : opts.throttleMs;
  const backfillDays = opts.backfillDays == null ? DEFAULT_BACKFILL_DAYS : opts.backfillDays;

  /** 每日收錄幾檔。使用者要的是「當日條件最佳的股票」，取前 5 檔。 */
  const dailyLimit = Number(process.env.TRACKER_DAILY_LIMIT) > 0
    ? Number(process.env.TRACKER_DAILY_LIMIT) : 5;

  /** 收錄門檻：低於此評分的不值得追蹤，只會稀釋統計 */
  const minScore = Number(process.env.TRACKER_MIN_SCORE) >= 0
    ? Number(process.env.TRACKER_MIN_SCORE) : 55;

  let inflight = null;

  /**
   * 是否有任何一天的清單尚未納入帳本。
   *
   * 回傳**舊到新**——這一點很重要，不是風格問題：
   *   帳本用「同股是否有未結案記錄」來擋重複開倉。若按新到舊補錄，
   *   較新的日期會先建立記錄，於是較舊的日期反而被判定為「重複開倉」而丟棄，
   *   歷史就被記成了相反的因果。
   *   真實運行時日期是逐日累積的，天生就是舊到新；補錄必須一致。
   */
  function pendingDates() {
    // listPickDates 是新到舊，取最近 N 天後再反轉成舊到新
    const dates = listPickDates(picksDir).slice(0, backfillDays).reverse();
    const processed = new Set(tracker.state.processedPickDates || []);
    return dates.filter((d) => !processed.has(d));
  }

  /**
   * 執行每日任務。
   * @param {object} o { force }
   */
  async function dailyRun(o = {}) {
    // 同一進程內避免併發重複跑（兩個分頁同時打開）
    if (inflight) return inflight;

    inflight = (async () => {
      const startedAt = Date.now();
      const state = readState(stateFile);
      const nowMs = Date.now();

      // 節流：非強制時，距上次執行不足間隔就直接跳過
      if (!o.force && state.lastRunAt && nowMs - state.lastRunAt < throttleMs) {
        return {
          ran: false,
          reason: `距上次更新僅 ${Math.round((nowMs - state.lastRunAt) / 60000)} 分鐘（節流 ${Math.round(throttleMs / 60000)} 分鐘），略過`,
          added: 0, updated: 0, checked: 0,
          lastRunAt: state.lastRunAt,
        };
      }

      /* ---- ① 若今日清單尚未產生，先讓 scheduler 補跑 ---- */
      let todayKey = null;
      let screenNote = null;
      if (deps.scheduler && deps.screenDeps && deps.runner) {
        try {
          const r = await deps.scheduler.maybeRun(deps.screenDeps, deps.runner, {});
          todayKey = r.key;
          screenNote = r.reason;
        } catch (e) {
          // 篩選失敗不該讓整個任務掛掉：已有的歷史記錄仍然可以更新
          screenNote = `當日清單產生失敗：${e.message}`;
        }
      }

      /* ---- ② 把尚未納入的歷史清單補進來 ---- */
      const todo = pendingDates();
      const added = [];
      const perDate = [];

      for (const key of todo) {
        const payload = readPickFile(picksDir, key);
        const rows = payload && Array.isArray(payload.rows) ? payload.rows : null;
        if (!rows || !rows.length) {
          // 檔案存在但沒有資料（例如當天全市場抓取失敗）→ 標記已處理，
          // 否則每次都會重試同一份空清單。
          tracker.markProcessed(key);
          perDate.push({ date: key, inserted: 0, skipped: '清單為空' });
          continue;
        }

        const out = tracker.addPicks(rows, {
          pickDate: key,
          limit: dailyLimit,
          minScore,
          source: 'daily-job',
        });
        tracker.markProcessed(key);
        added.push(...out.inserted);
        perDate.push({
          date: key,
          inserted: out.inserted.length,
          considered: out.considered,
          duplicatesDay: out.duplicatesDay.length,
          duplicatesOpen: out.duplicatesOpen.length,
          invalid: out.invalid.length,
        });
      }

      /* ---- ③ 更新所有未結案記錄 ---- */
      let upd = null;
      // 先存一次：③ 若因為「沒有未結案記錄」而提早返回，它不會存檔，
      // 那麼 ② 新增的記錄與 processedPickDates 就會丟失，下次重跑又重來一遍。
      if (added.length || todo.length) {
        try { tracker.save(); } catch (e) { /* 存檔失敗由後續 update 再試 */ }
      }
      try {
        upd = await tracker.update();
      } catch (e) {
        upd = { ran: false, reason: `更新失敗：${e.message}`, checked: 0, changed: 0 };
      }

      const nextState = {
        lastRunAt: Date.now(),
        lastRunKey: todayKey,
        lastDurationMs: Date.now() - startedAt,
      };
      writeState(stateFile, nextState);

      /* ---- ④ 推送到 Telegram ----
        必須放在 ③ 之後：③ 才是抓最新價格、推進狀態的地方。
        若在 ③ 之前推，訊息裡的現價與損益會是上一輪的舊值。

        失敗**不影響**任務結果：帳本已更新完成，通知只是附加。
        若把推送失敗當成任務失敗，使用者會以為帳本沒更新而去重跑，
        反而可能造成重複計算——那才是真正的問題。 */
      let notify = null;
      if (deps.notifier) {
        try {
          notify = await deps.notifier.push({});
        } catch (e) {
          notify = { ok: false, error: e.message };
        }
      }

      return {
        ran: true,
        durationMs: Date.now() - startedAt,
        screen: { key: todayKey, note: screenNote },
        backfilled: perDate,
        added: added.length,
        addedRecords: added.map((r) => ({ id: r.id, symbol: r.symbol, pickDate: r.pickDate })),
        checked: upd ? upd.checked : 0,
        updated: upd ? upd.changed : 0,
        failed: upd ? upd.failed || 0 : 0,
        failures: upd ? upd.failures || [] : [],
        fx: upd ? upd.fx : null,
        range: upd ? upd.range : null,
        notify,
        lastRunAt: nextState.lastRunAt,
      };
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  function status() {
    const state = readState(stateFile);
    return {
      lastRunAt: state.lastRunAt || null,
      lastRunKey: state.lastRunKey || null,
      lastDurationMs: state.lastDurationMs || null,
      throttleMinutes: Math.round(throttleMs / 60000),
      dailyLimit,
      minScore,
      backfillDays,
      pendingPickDates: pendingDates(),
      availablePickDates: listPickDates(picksDir).slice(0, backfillDays),
    };
  }

  return { dailyRun, status, pendingDates };
}

module.exports = { createJob, THROTTLE_MS, DEFAULT_BACKFILL_DAYS, PICKS_DIR, listPickDates };
