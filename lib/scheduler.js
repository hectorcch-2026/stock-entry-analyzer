'use strict';

/**
 * 排程器 — 惰性補跑（lazy catch-up）
 *
 * 為什麼不用單純的 setInterval：
 * Render 免費方案閒置 15 分鐘後會休眠（DEPLOY.md:53），進程被凍結，
 * 所有 setTimeout／setInterval 都停止計時。醒來後時間已經跳過，
 * 單靠 interval 會出現「今天該跑的批次沒跑，且永遠不會補」。
 *
 * 因此本模組採三層設計：
 *
 *   L1 訪問觸發（主要）：每次有人開啟選股頁 → maybeRun() 檢查
 *                        「今日是否已過收盤」且「今日資料不存在」
 *                        → 是則當場產生。休眠再久，第一個訪問者也會補上。
 *
 *   L2 進程內定時（輔助）：可選啟動，只在長駐環境（Railway／付費方案）
 *                        真正有效。作為「有人在用但沒點選股頁」時的預熱。
 *
 *   L3 外部 cron（輔助）：暴露 runDaily()，由 Render Cron／GitHub Actions
 *                        呼叫 /api/picks?force=1&token=… 觸發。
 *
 * 三層互不衝突，靠「當日鎖」保證同一天只產生一次。
 */

const path = require('path');
const fs = require('fs');

/** 收盤後多久算「今日已收盤」。留 30 分鐘緩衝給上游更新日線。 */
const SETTLE_MINUTES = 30;

/** 排程資料落地目錄 */
const DAILY_DIR = path.join(__dirname, '..', 'data', 'picks');

/** 進程內狀態：避免同一進程重複觸發 */
const inflight = new Map();

/** 交易日判斷（排除週末）。不含各市場假日——假日會產生一份「資料未更新」的結果，屬可接受。 */
function isTradingDay(d) {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

/**
 * 計算「最近的已收盤時刻」。
 * 美股與港股都在當地 16:00 收盤，但兩地時區不同，這裡取「任一市場已收盤」即算，
 * 因為清單會涵蓋兩個市場。
 *
 * 以 UTC 為計算基準，輸出一個可比較的毫秒數，避免伺服器時區差異。
 */
function lastSettledCutoff(now = new Date()) {
  // 港股收盤 16:00 HKT = 08:00 UTC
  // 美股收盤 16:00 ET  = 20:00 UTC（夏令時）／21:00 UTC（冬令時）
  // 這裡取較晚者（20:00 UTC）作為統一收盤點，寧可晚跑也不要跑到盤中資料
  const utcCloseHour = 20;
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    utcCloseHour, SETTLE_MINUTES, 0, 0
  ));
  if (now < cutoff) {
    // 今天還沒收盤（或剛收盤未滿緩衝）→ 基準回到昨天
    cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  }
  // 回退到最近的交易日
  while (!isTradingDay(cutoff)) {
    cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  }
  return cutoff;
}

/** 把 Date 轉成 YYYY-MM-DD（UTC） */
function dateKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dailyFile(key) {
  return path.join(DAILY_DIR, `${key}.json`);
}

/** 讀取某日的排程結果。不存在回 null。 */
function readDaily(key) {
  try {
    const f = dailyFile(key);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeDaily(key, payload) {
  try {
    if (!fs.existsSync(DAILY_DIR)) fs.mkdirSync(DAILY_DIR, { recursive: true });
    fs.writeFileSync(dailyFile(key), JSON.stringify(payload), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 惰性補跑核心。
 *
 * @param {object} deps        { analyzer, symbols }
 * @param {object} opts        { force:boolean }  force=true 時不論是否已存在都重跑
 * @param {object} runner      { screen }  注入 screener.screen，避免循環依賴
 * @returns {{ran:boolean, key:string, reason:string, payload?:object}}
 */
async function maybeRun(deps, runner, opts = {}) {
  const cutoff = lastSettledCutoff();
  const key = dateKey(cutoff);

  if (!opts.force) {
    const existing = readDaily(key);
    if (existing) {
      return { ran: false, key, reason: '今日已有資料', payload: existing };
    }
  }

  // 同一進程內避免併發重複跑（兩個使用者同時開啟選股頁）
  if (inflight.has(key)) {
    const payload = await inflight.get(key);
    return { ran: false, key, reason: '已有執行中的批次，等待其結果', payload };
  }

  const task = (async () => {
    const startedAt = Date.now();
    // 排程用寬鬆條件（不跟隨使用者查詢）：目的是產出一份「今日候選池」，
    // 使用者進到選股頁時再依自己的條件即時篩選。若這裡就套用嚴格條件，
    // 使用者一放寬條件就沒有現成資料可用，等於每天都要重跑一次全集。
    const res = await runner.screen(deps, { limit: 60, maxDistAtr: 3.0, minScore: 50 });
    const payload = {
      ok: res.ok,
      key,
      cutoffUtc: cutoff.toISOString(),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      // 排程用固定條件（不跟隨使用者查詢），使用者查詢時另有即時篩選
      opts: res.opts,
      rows: res.rows || [],
      stats: res.stats || null,
      error: res.error || null,
      source: 'lazy-catchup',
    };
    // 只有成功才寫檔；失敗留給下次訪問重試，不寫壞檔
    if (res.ok && res.rows && res.rows.length > 0) {
      writeDaily(key, payload);
    }
    return payload;
  })();

  inflight.set(key, task);
  try {
    const payload = await task;
    return { ran: true, key, reason: opts.force ? '強制重跑' : '今日尚未產生，已補跑', payload };
  } finally {
    inflight.delete(key);
  }
}

/** 列出最近 N 天有資料的日期（新的在前）。用於前端「歷史」下拉。 */
function listRecent(limit = 10) {
  try {
    if (!fs.existsSync(DAILY_DIR)) return [];
    return fs.readdirSync(DAILY_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace('.json', ''))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch (_) {
    return [];
  }
}

/**
 * L2：啟動進程內定時器。
 * 僅在明確設定 ENABLE_INPROCESS_CRON=1 時啟用——因為在多數免費方案上它無效，
 * 開了反而製造「以為有排程」的假象。
 */
function startInterval(deps, runner, intervalMs = 30 * 60 * 1000, log = console.log) {
  if (String(process.env.ENABLE_INPROCESS_CRON || '') !== '1') {
    log('[scheduler] 進程內定時未啟用（ENABLE_INPROCESS_CRON≠1）。改由訪問觸發與外部 cron 補跑。');
    return null;
  }
  log(`[scheduler] 進程內定時已啟用，每 ${Math.round(intervalMs / 60000)} 分鐘檢查一次`);
  const timer = setInterval(async () => {
    try {
      const r = await maybeRun(deps, runner, {});
      if (r.ran) log(`[scheduler] ${r.key} 已產生（${r.payload?.rows?.length ?? 0} 檔）`);
    } catch (e) {
      log(`[scheduler] 執行失敗：${e.message}`);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  SETTLE_MINUTES,
  DAILY_DIR,
  isTradingDay,
  lastSettledCutoff,
  dateKey,
  dailyFile,
  readDaily,
  writeDaily,
  maybeRun,
  listRecent,
  startInterval,
};
