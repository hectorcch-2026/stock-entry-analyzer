'use strict';

/**
 * 每日推介 → Telegram 推送
 * ==========================
 *
 * 把「今天推薦了哪幾檔、手上還握著什麼、現在怎麼樣」整理成訊息推出去。
 *
 * ── 四個必須想清楚的點 ────────────────────────────────────
 *
 * ① 一天只能推一次（否則會變成騷擾）
 *   `dailyRun()` 是「訪問觸發」的：每 30 分鐘、任何一個人開頁都可能跑一次。
 *   若推送綁在「任務跑完就推」，一天會推幾十次，使用者第一件事就是封鎖 bot。
 *   因此以**當天日期**（香港時區）為發送鎖：
 *     同一天只推一次，跨日自然會再推。
 *
 *   ⚠️ 這裡刻意**不用推介日期（pickDate）當鎖**。
 *      用 pickDate 當鎖的版本有個致命缺口：週末、假期、或當天篩不出標的時，
 *      dailyRun 不會產生新 pickDate，於是那一天完全靜默——
 *      而持倉中的股票當天漲跌也就永遠看不到。
 *      使用者要的是「每日推送」，不是「有推介才推送」。
 *      鎖與內容因此解耦：鎖看「今天推過了嗎」，內容看「今天有什麼可講」。
 *
 *   鎖要落地保存，否則重新部署後會把當天的又推一遍。
 *
 * ② 訊息長度上限 4096 字元
 *   Telegram 超過就整則失敗（400 MESSAGE_TOO_LONG），不是截斷。
 *   一天若有多檔，加上持倉段落很容易逼近上限，所以先量長度、超過就分批，
 *   而不是等它失敗。分批時**絕不把某一檔股票切成兩半**——
 *   看到半個止蝕價比看不到更危險。
 *
 * ③ 公司名一定要轉義
 *   AT&T、H&M、SK Hynix <holdings> 這類名字含 & 或 <，
 *   在 parse_mode=HTML 下會讓整則訊息發不出去（400 can't parse entities）。
 *   這是本專案已經踩過的坑（見 lib/telegram.js 的註解），這裡沿用同一套轉義。
 *
 * ④ 沒有新推介的日子也要推
 *   使用者選的是「每天推：新推介＋持倉表現」。
 *   因此訊息分成兩個段落：今日新推介、持倉表現。
 *   若當天沒有新推介，仍會推持倉段落——這才是「每日」的意義。
 *   較早推介、至今仍在等買區的記錄不會逐檔列出（會讓訊息爆長），
 *   但會在結尾用一行帶出筆數，避免它們安靜地消失、讓人以為資料掉了。
 *
 * ── 為什麼推送失敗不該讓任務失敗 ──────────────────────────
 *   帳本更新（抓價格、推進狀態）才是核心；通知只是「順便告訴你」。
 *   若 Telegram 掛了就把整個 dailyRun 標成失敗，會讓人以為帳本沒更新，
 *   反而去重跑、造成真正的重複計算。因此推送結果獨立回報，不拋錯。
 */

const fs = require('fs');
const path = require('path');
const { renderCandleChart } = require('./candle-chart');

const STATE_FILE = path.join(__dirname, '..', 'data', 'tracker', 'notify-state.json');

/** Telegram 單則訊息上限（官方 4096）。留一點餘裕，避免算術邊界剛好超標。 */
const MAX_LEN = 4000;

const STATUS_EMOJI = {
  pending: '⏳',
  holding: '📌',
  target_hit: '🎯',
  stop_hit: '🛑',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 香港時區的 YYYY-MM-DD。
 *
 * 為什麼不直接 new Date().toISOString().slice(0,10)：
 *   那是 UTC 日期。香港是 UTC+8，凌晨 0:00–8:00 之間 UTC 還停在前一天，
 *   於是「今天」會算成昨天——發送鎖就會在每天早上的那幾個小時失效，
 *   同一份內容推兩次。使用者是港股/美股投資者，作息就在這個危險區間內。
 */
function hkDateKey(now) {
  const d = now ? new Date(now) : new Date();
  if (!isFinite(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    const y = get('year');
    const m = get('month');
    const day = get('day');
    if (!y || !m || !day) return null;
    return `${y}-${m}-${day}`;
  } catch (_) {
    // Intl 異常時的退路：手動 +8 小時。比整則推送掛掉好。
    const t = new Date(d.getTime() + 8 * 3600 * 1000);
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }
}

/** 星期（中文單字），讓訊息一眼看出是週幾，週末沒有新推介時不會誤以為壞了 */
function weekdayZh(now) {
  const d = now ? new Date(now) : new Date();
  try {
    const w = new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Hong_Kong',
      weekday: 'short',
    }).format(d);
    return w.replace(/^週/, '');
  } catch (_) {
    return '';
  }
}

/** 港幣與美元都要顯示符號，否則「45.64」看不出是哪個幣別 */
function curSign(currency) {
  if (currency === 'HKD') return 'HK$';
  if (currency === 'USD') return 'US$';
  return `${currency || ''} `;
}

/** 價格：低價股用 3 位小數，其餘 2 位（0.85 與 0.9 要分得出來） */
function fmtPrice(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '—';
  return Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2);
}

/**
 * 千分位。金額到四位數以上時，`1145.71` 與 `1,145.71` 的辨識速度差很多，
 * 而這則訊息是「掃一眼」的，不是逐字讀的。
 */
function group(n) {
  const s = Math.abs(n).toFixed(2);
  const [int, dec] = s.split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

function fmtUsd(v, sign) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  const s = n < 0 ? '-' : (sign && n > 0 ? '+' : '');
  return `${s}US$${group(n)}`;
}

function fmtPct(v, sign) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  const s = n < 0 ? '' : (sign ? '+' : '');
  return `${s}${n.toFixed(2)}%`;
}

function loadState(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    // 狀態檔壞掉時視為「沒推過」比「推過了」安全嗎？
    // 這裡選「沒推過」：寧可多推一次，也不要整天靜默無聲。
    return {};
  }
}

function saveState(file, state) {
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

/**
 * 持有天數的白話描述。
 *
 * 為什麼不直接印「持有 0 天」：
 *   0 天讀起來像「欄位沒抓到」，尤其當其他檔都寫 3 天、5 天時。
 *   「今日買入」是同一件事的肯定說法，不會被誤讀成資料缺漏。
 */
function fmtHolding(days) {
  const n = Number(days);
  if (!isFinite(n) || n < 0) return null;
  if (n === 0) return '今日買入';
  return `持有 ${n} 天`;
}

/**
 * 組出單一檔股票的段落（HTML）。
 *
 * @param {object} r   帳本記錄
 * @param {function} esc HTML 轉義
 * @param {object} [opts] { showEntry: 是否顯示實際買入價 }
 */
function buildStockBlock(r, esc, opts) {
  const o = opts || {};
  const lines = [];
  const emoji = STATUS_EMOJI[r.status] || '•';
  const cur = curSign(r.currency);

  lines.push(`${emoji} <b>${esc(r.name || r.symbol)}</b>（${esc(r.symbol)}）`);

  // 建議買入是區間：這是使用者最需要的「掛單價」
  const zone = r.buyLow === r.buyHigh
    ? `${cur}${fmtPrice(r.buyLow)}`
    : `${cur}${fmtPrice(r.buyLow)} ~ ${fmtPrice(r.buyHigh)}`;
  lines.push(`　建議買入：${zone}`);
  lines.push(`　止賺 <b>${cur}${fmtPrice(r.targetPrice)}</b>　止蝕 <b>${cur}${fmtPrice(r.stopPrice)}</b>`);

  if (r.pnl) {
    const parts = [];
    // 已在場上的，先講「你當初買多少」，否則只看到現價無法判斷賺賠怎麼來的
    if (o.showEntry && r.entry && r.entry.price > 0) {
      parts.push(`買入 ${cur}${fmtPrice(r.entry.price)}`);
    }
    parts.push(`現價 ${cur}${fmtPrice(r.pnl.markPrice)}`);
    parts.push(`損益 <b>${fmtUsd(r.pnl.amountUsd, true)}</b>（${fmtPct(r.pnl.returnPct, true)}）`);
    const held = fmtHolding(r.pnl.holdingDays);
    if (held) parts.push(held);
    lines.push(`　${parts.join('　')}`);
  } else if (r.status === 'pending') {
    lines.push('　尚未觸及買區，等待中');
  }

  return lines.join('\n');
}

/**
 * 把 units 切成不超過 MAX_LEN 的訊息。
 *
 * units: [{ text, header }]
 *   以「單一股票」為最小單位，header 視為與其後第一檔綁在一起，
 *   避免出現「【持倉表現】」孤零零留在上一則結尾、下一則從股票開始。
 *
 * @returns {Array<string>} 一則或多則
 */
function chunk(headLines, footLines, units) {
  const head = headLines.join('\n');
  const foot = footLines.join('\n');

  const msgs = [];
  let body = [];
  let len = head.length + foot.length + 2;

  const flush = () => {
    msgs.push([head, ...body].join('\n'));
    body = ['（續）'];
    // 「（續）」3 字 + 換行；foot 只在最後一則出現，但這裡保守計入
    len = 4 + foot.length;
  };

  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    let need = u.text.length + 1;

    // header 要連同下一檔一起判斷，否則會斷在 header 之後
    if (u.header && i + 1 < units.length) {
      need += units[i + 1].text.length + 1;
    }

    if (len + need > MAX_LEN && body.length > 0) flush();

    body.push(u.text);
    // header 已把下一檔算進 need，這裡只加自己的長度，避免重複計
    len += u.text.length + 1;
  }

  msgs.push([head, ...body, foot].join('\n'));
  return msgs;
}

/**
 * 等待買入的股票：一行一檔，重點是「我的掛單價」。
 *
 * 為什麼用精簡格式而不是 buildStockBlock：
 *   等待買入的股票可能很多（現在就有 9 檔）。若每檔都用完整區塊
 *   （三行 + 空白），訊息會膨脹到需要分成三四則，
 *   而「還沒進場」的股票其實只需要兩個資訊：代碼、買區。
 *   止賺止蝕等真的成交後再詳細講就好。
 *
 * 為什麼不顯示「距買區還差幾 %」：
 *   帳本裡的 refPrice 是**推介當時**的價格，不是現價。
 *   拿它算距離會給出一個看起來精確、實際上過時的數字——
 *   比不顯示更糟。要顯示距離就得即時抓價，那會讓推送變慢且容易失敗。
 */
function buildPendingLine(r, esc) {
  const cur = curSign(r.currency);
  const zone = r.buyLow === r.buyHigh
    ? `${cur}${fmtPrice(r.buyLow)}`
    : `${cur}${fmtPrice(r.buyLow)} ~ ${fmtPrice(r.buyHigh)}`;
  const name = r.name ? ` ${esc(r.name)}` : '';
  return `⏳ <b>${esc(r.symbol)}</b>${name}\n　買入 ${zone}`;
}

/**
 * 組出完整訊息。
 *
 * @param {object} o
 *   todayRows        當日新推介（pickDate === todayKey）
 *   positionRows     持倉中且非今日新推介的記錄
 *   pendingRows      等待買入的記錄（含今日與較早的）
 *   maxPending       等待買入最多列幾檔（其餘只給筆數）
 *   summary          lib/picks-tracker 的 summary()
 *   todayKey         YYYY-MM-DD（香港）
 *   now              時間（測試用）
 * @returns {Array<string>} 一則或多則
 */
function buildDigest(o, esc) {
  const todayRows = Array.isArray(o.todayRows) ? o.todayRows : [];
  const positionRows = Array.isArray(o.positionRows) ? o.positionRows : [];
  const summary = o.summary || {};
  const dateKey = o.todayKey || '';
  const maxPending = Number.isFinite(o.maxPending) ? o.maxPending : 12;

  // 等待買入：排除已經在「今日新推介」裡重複列出的
  const todaySyms = new Set(todayRows.map((r) => r.symbol));
  const pendingAll = (Array.isArray(o.pendingRows) ? o.pendingRows : [])
    .filter((r) => !todaySyms.has(r.symbol));
  // 分數高的排前面：那些是最接近值得掛單的
  const pendingRows = pendingAll
    .slice()
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const pendingShown = pendingRows.slice(0, maxPending);
  const pendingHidden = pendingRows.length - pendingShown.length;

  const headLines = [];
  headLines.push('📈 <b>每日推介追蹤</b>');
  const wd = weekdayZh(o.now);
  headLines.push(`${esc(dateKey)}${wd ? `（${wd}）` : ''}`);
  headLines.push('');

  const units = [];

  // ── 段落一：今日新推介 ──
  if (todayRows.length) {
    units.push({
      text: `🆕 <b>今日新推介</b>（${todayRows.length} 檔）`,
      header: true,
    });
    for (const r of todayRows) {
      units.push({ text: buildStockBlock(r, esc, { showEntry: true }), header: false });
    }
  } else {
    // 措辭要依「有沒有持倉」而變：
    // 若照樣寫「以下為持倉狀況」卻沒有任何持倉，訊息就自相矛盾
    // （說有東西在下面，下面卻空的），比不寫更糟。
    const hasBelow = positionRows.length || pendingShown.length;
    const tail = hasBelow
      ? '　今日暫無新推介（未產生新名單，以下為目前狀況）'
      : '　今日暫無新推介';
    units.push({
      text: `🆕 <b>今日新推介</b>\n${tail}`,
      header: false,
    });
  }

  // ── 段落二：持倉表現 ──
  // 前面補一個空行：兩個段落若緊貼，會讀成「今日暫無新推介」下面直接接
  // 一個沒有標題的區塊，看不出換段了。
  if (positionRows.length) {
    const openPnl = positionRows
      .map((r) => (r.pnl ? Number(r.pnl.amountUsd) : 0))
      .filter((v) => isFinite(v))
      .reduce((a, b) => a + b, 0);
    units.push({
      text: `\n📊 <b>持倉表現</b>（${positionRows.length} 檔・合計 <b>${fmtUsd(openPnl, true)}</b>）`,
      header: true,
    });
    for (const r of positionRows) {
      units.push({ text: buildStockBlock(r, esc, { showEntry: true }), header: false });
    }
  }

  // ── 段落三：等待買入 ──
  if (pendingShown.length) {
    const more = pendingHidden > 0 ? `，另有 ${pendingHidden} 檔未列出` : '';
    units.push({
      text: `\n⏳ <b>等待買入</b>（${pendingRows.length} 檔${more}）`,
      header: true,
    });
    for (const r of pendingShown) {
      units.push({ text: buildPendingLine(r, esc), header: false });
    }
  }

  const footLines = [];
  const total = Number(summary.totalPnlUsd);
  const counts = summary.counts || {};
  if (isFinite(total)) {
    footLines.push('');
    footLines.push('━━━━━━━━━━━━');
    footLines.push('<b>累計表現</b>（每筆本金 US$10,000）');
    const bits = [`總損益 <b>${fmtUsd(total, true)}</b>`];
    if (counts.holding) bits.push(`持倉 ${counts.holding}`);
    if (counts.pending) bits.push(`待買入 ${counts.pending}`);
    if (counts.closed) bits.push(`已結案 ${counts.closed}`);
    footLines.push(bits.join('　'));

    const winRate = summary.winRate != null
      ? `${Number(summary.winRate).toFixed(1)}%`
      : '—（尚無結案）';
    const avgHold = summary.avgHoldingDays != null
      ? `${Number(summary.avgHoldingDays).toFixed(1)} 天`
      : '—';
    footLines.push(`勝率 ${winRate}　平均持有 ${avgHold}`);
  }

  // 今天既沒有新推介、也沒有任何持倉、也沒有等待買入（例如全部已止賺/止蝕）：
  // 訊息只剩頁尾的統計數字，讀起來像「壞掉了」。
  // 明講「手上沒有未結案的部位」才是完整的句子。
  if (!todayRows.length && !positionRows.length && !pendingShown.length) {
    footLines.push('');
    footLines.push('目前沒有未結案的推介，空手等待下一次機會。');
  }

  footLines.push('');
  footLines.push(
    `<i>${esc(new Date(o.now || Date.now()).toLocaleString('zh-TW', { timeZone: 'Asia/Hong_Kong' }))}</i>`,
  );

  return chunk(headLines, footLines, units);
}

/**
 * @param {object} deps
 *   tracker    lib/picks-tracker 實例
 *   telegram   lib/telegram（有 sendText / escapeHtml）
 * @param {object} [opts]
 *   stateFile  發送鎖的落地位置
 *   nowFn      時間來源（測試注入）
 */
function createNotifier(deps, opts = {}) {
  const tracker = deps.tracker;
  const telegram = deps.telegram;
  if (!tracker) throw new Error('createNotifier 需要 tracker');
  if (!telegram) throw new Error('createNotifier 需要 telegram');

  const stateFile = opts.stateFile === undefined ? STATE_FILE : opts.stateFile;
  const nowFn = opts.nowFn || (() => Date.now());
  const esc = telegram.escapeHtml || ((s) => String(s == null ? '' : s));

  /* ---- K 線圖設定 ----
     maxCharts 預設 5：持倉 + 今日新推介的數量上限。
       為什麼要上限：圖是一張一則訊息，十張圖就是十則通知。
       在 Telegram 上一次跳十則，使用者只會覺得被騷擾，
       反而不會去看最重要的那兩檔。
     chartBars 60：約三個月的交易日。
       太短看不出趨勢，太長則單根 K 線只剩 1px 失去意義。
     chartRange 6mo：抓 6 個月再取最近 60 根，
       留緩衝是為了避開假日與停牌造成的根數不足。 */
  const maxCharts = opts.maxCharts === undefined ? 5 : Number(opts.maxCharts);
  const chartBars = opts.chartBars || 60;
  const chartRange = opts.chartRange || '6mo';

  // 等待買入最多逐檔列幾檔（其餘只給筆數）
  const maxPending = opts.maxPending === undefined ? 12 : Number(opts.maxPending);

  function isEnabled() {
    const v = String(process.env.TRACKER_TELEGRAM || '1').toLowerCase();
    if (v === '0' || v === 'false' || v === 'off') return false;
    return true;
  }

  function state() {
    return loadState(stateFile);
  }

  /** 該「發送日」是否已推過（key 是發送日，不是推介日） */
  function alreadySent(dateKey) {
    if (!dateKey) return false;
    return Boolean(state().sent && state().sent[dateKey]);
  }

  /**
   * 把帳本拆成「今日新推介 / 持倉 / 等待買入」三組，並組出訊息。
   * 純函式（不送、不寫檔），供 push 與 preview 共用。
   */
  function assemble(dateKeyArg) {
    const all = tracker.records || [];
    const dateKey = dateKeyArg || hkDateKey(nowFn());

    const todayRows = all
      .filter((r) => r.pickDate === dateKey)
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

    // 持倉：未結案、狀態為 holding、且不是今日才建立的名單。
    // 排除今日是為了避免與「今日新推介」重複列同一檔。
    const positionRows = all
      .filter((r) => !r.settled && r.status === 'holding' && r.pickDate !== dateKey)
      .sort((a, b) => {
        const pa = a.pnl ? Number(a.pnl.amountUsd) : 0;
        const pb = b.pnl ? Number(b.pnl.amountUsd) : 0;
        return pb - pa;   // 賺最多的排前面
      });

    // 等待買入：所有還沒成交的（含今日新推介裡仍是 pending 的）。
    // buildDigest 內部會排除已經在「今日新推介」段落出現過的，避免重複。
    const pendingRows = all.filter((r) => !r.settled && r.status === 'pending');

    const msgs = buildDigest({
      todayRows,
      positionRows,
      pendingRows,
      maxPending,
      summary: typeof tracker.summary === 'function' ? tracker.summary() : {},
      todayKey: dateKey,
      now: nowFn(),
    }, esc);

    return { dateKey, msgs, todayRows, positionRows, pendingRows };
  }

  /**
   * 決定要為哪些股票畫 K 線圖。
   *
   * 只畫「持倉」與「今日新推介」（使用者選定的範圍）：
   *   · 等待買入的可能十幾檔，全畫會變成連續十幾張圖，變成騷擾；
   *   · 持倉與新推介才是真的需要「看技術面決定要不要動作」的對象。
   *
   * 去重：同一檔可能既是今日新推介又是持倉（今天剛成交），
   * 只畫一次，否則會連發兩張一樣的圖。
   */
  function chartTargets(built) {
    const seen = new Set();
    const out = [];
    const add = (r, tag) => {
      if (!r || !r.symbol || seen.has(r.symbol)) return;
      seen.add(r.symbol);
      out.push({ record: r, tag });
    };
    // 持倉優先（真的要盯的）
    for (const r of built.positionRows) add(r, '持倉');
    for (const r of built.todayRows) {
      // 持倉的股票已經畫過，這裡標籤用「新推介」
      add(r, r.status === 'holding' ? '持倉' : '新推介');
    }
    return out.slice(0, Math.max(0, maxCharts));
  }

  /**
   * 為單一股票產生 K 線 PNG。
   *
   * 失敗一律回 null 並記錄原因——畫圖失敗不該讓整則推送失敗，
   * 文字訊息本身仍然有價值。
   */
  async function chartFor(record) {
    if (!deps.datasource || typeof deps.datasource.chart !== 'function') {
      return { ok: false, error: '未注入 datasource' };
    }
    try {
      const r = await deps.datasource.chart(record.symbol, chartRange, '1d');
      const candles = (r && r.candles) || [];
      if (!candles.length) return { ok: false, error: '查無行情資料' };

      const png = renderCandleChart({
        symbol: record.symbol,
        candles,
        bars: chartBars,
        pick: {
          buyLow: record.buyLow,
          buyHigh: record.buyHigh,
          targetPrice: record.targetPrice,
          stopPrice: record.stopPrice,
          costPrice: record.entry ? record.entry.price : null,
        },
        /* 事件標記：把「什麼時候推介、什麼時候進場、什麼時候出場」
           畫在時間軸上。使用者要能一眼看出「推薦之後實際走了多久、
           在哪一天觸發」，光有水平價位線看不出時間。
           日期為空的事件會被 normalizeEvents 自動略過。 */
        events: [
          { type: 'pick', date: record.pickDate },
          record.entry && record.entry.date
            ? { type: 'entry', date: record.entry.date, price: record.entry.price }
            : null,
          record.exit && record.exit.date
            ? { type: 'exit', date: record.exit.date, price: record.exit.price }
            : null,
        ].filter(Boolean),
      });

      // 圖說只放關鍵價位，避免與文字訊息重複太多
      const cur = curSign(record.currency);
      const zone = record.buyLow === record.buyHigh
        ? `${cur}${fmtPrice(record.buyLow)}`
        : `${cur}${fmtPrice(record.buyLow)} ~ ${fmtPrice(record.buyHigh)}`;
      const capLines = [
        `<b>${esc(record.name || record.symbol)}</b>（${esc(record.symbol)}）`,
        `買區 ${zone}　止賺 ${cur}${fmtPrice(record.targetPrice)}　止蝕 ${cur}${fmtPrice(record.stopPrice)}`,
      ];
      /* 圖例：圖上只有 P／B／X 三個字母，不解釋沒人看得懂。
         只在真的有該事件時才列，避免出現「X（出場）」卻其實還沒出場。
         caption 上限 1024 字，這一行約 30 字，遠低於上限。 */
      const legend = [];
      legend.push(`P 推介 ${record.pickDate || '—'}`);
      if (record.entry && record.entry.date) legend.push(`B 進場 ${record.entry.date}`);
      if (record.exit && record.exit.date) {
        legend.push(`X ${record.status === 'target_hit' ? '止賺' : '止蝕'} ${record.exit.date}`);
      }
      if (legend.length > 1) capLines.push(`<i>${esc(legend.join('　'))}</i>`);
      return { ok: true, png, caption: capLines.join('\n'), bars: candles.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 推送今日摘要（文字 + 選配 K 線圖）。
   *
   * @param {object} o { force?, charts? }
   *   charts  是否附 K 線圖；預設「有注入 datasource 就發」
   * @returns {Promise<object>} 結果，永不拋錯
   */
  async function push({ force = false, charts } = {}) {
    if (!isEnabled()) {
      return { ok: false, skipped: true, reason: 'TRACKER_TELEGRAM 已關閉' };
    }

    const all = tracker.records || [];
    if (!all.length) {
      return { ok: false, skipped: true, reason: '帳本尚無任何推介記錄' };
    }

    // 需要 summary 才能組訊息；若 tracker 沒這個方法就當作壞掉，明確回報
    if (typeof tracker.summary !== 'function') {
      return { ok: false, skipped: true, reason: 'tracker 缺少 summary()，無法組訊息' };
    }

    const built = assemble();
    const { dateKey, msgs, todayRows, positionRows } = built;

    // ① 今天推過了嗎
    if (!force && alreadySent(dateKey)) {
      return { ok: true, skipped: true, reason: `${dateKey} 已推送過`, dateKey };
    }

    const results = [];
    for (const text of msgs) {
      // 逐則送；任何一則失敗都記錄下來，但不讓整個流程爆掉
      // eslint-disable-next-line no-await-in-loop
      const r = await telegram.sendText(text);
      results.push({ ok: r.ok, mode: r.mode, error: r.error || null, chars: text.length });
      if (!r.ok) break;   // 第一則就失敗就沒必要繼續發續則
    }

    const textOk = results.length > 0 && results.every((r) => r.ok);

    /* ---- ② K 線圖 ----
       順序刻意放在文字之後：
         · 文字是主體（價位、損益），圖是輔助；
         · 若文字就失敗（例如憑證錯），再發圖只是多十次失敗請求。
       圖失敗**不影響**整體 ok——文字已經送達，資訊價值仍在。
       但會在結果裡明確列出哪些股票畫圖失敗，不靜默吞掉。 */
    const sendCharts = charts === undefined
      ? Boolean(deps.datasource && typeof telegram.sendPhoto === 'function')
      : Boolean(charts);

    const chartResults = [];
    if (textOk && sendCharts) {
      const targets = chartTargets(built);
      for (const t of targets) {
        // eslint-disable-next-line no-await-in-loop
        const c = await chartFor(t.record);
        if (!c.ok) {
          chartResults.push({ symbol: t.record.symbol, ok: false, error: c.error });
          continue;   // 單檔失敗就跳過，不中斷其他檔
        }
        // eslint-disable-next-line no-await-in-loop
        const sent = await telegram.sendPhoto(c.png, c.caption);
        chartResults.push({
          symbol: t.record.symbol,
          ok: sent.ok,
          bytes: c.png.length,
          bars: c.bars,
          error: sent.ok ? null : (sent.error || null),
        });
      }
    }

    // 文字全成功就算成功；圖的失敗另外回報，不讓它把整天標成失敗，
    // 否則隔天會因為「昨天沒推成功」而重推文字，使用者會收到重複訊息。
    const allOk = textOk;

    // 只有成功才標記已推，否則下次還會重試（避免「以為推了其實沒推」）
    if (allOk) {
      const st = state();
      st.sent = st.sent || {};
      st.sent[dateKey] = {
        at: new Date(nowFn()).toISOString(),
        messages: results.length,
        charts: chartResults.filter((c) => c.ok).length,
      };
      // 只保留最近 60 天，避免狀態檔無限長大
      const keys = Object.keys(st.sent).sort();
      if (keys.length > 60) {
        const drop = keys.slice(0, keys.length - 60);
        for (const k of drop) delete st.sent[k];
      }
      saveState(stateFile, st);
    }

    return {
      ok: allOk,
      skipped: false,
      dateKey,
      newPicks: todayRows.map((r) => r.symbol),
      positions: positionRows.map((r) => r.symbol),
      messages: results,
      charts: chartResults,
      chartsOk: chartResults.filter((c) => c.ok).length,
      mode: results[0] ? results[0].mode : null,
      error: allOk ? null : (results.find((r) => !r.ok) || {}).error || null,
    };
  }

  /** 只組訊息、不送出。供 /api/tracker/status?notifyPreview=1 人工檢查用。 */
  function preview(dateKeyArg) {
    const built = assemble(dateKeyArg);
    const targets = chartTargets(built);
    return {
      dateKey: built.dateKey,
      chars: built.msgs.map((m) => m.length),
      newPicks: built.todayRows.map((r) => r.symbol),
      positions: built.positionRows.map((r) => r.symbol),
      pending: built.pendingRows.map((r) => r.symbol),
      // 哪些股票會畫 K 線圖（讓使用者事先知道會收到幾張圖）
      chartTargets: targets.map((t) => ({ symbol: t.record.symbol, tag: t.tag })),
      messages: built.msgs,
    };
  }

  function status() {
    const st = state();
    const dates = Object.keys(st.sent || {}).sort().reverse();
    const today = hkDateKey(nowFn());
    return {
      enabled: isEnabled(),
      configured: telegram.isConfigured ? telegram.isConfigured() : false,
      stateFile,
      today,
      sentToday: Boolean(st.sent && st.sent[today]),
      sentDates: dates.slice(0, 10),
      lastSent: dates[0] ? { date: dates[0], ...(st.sent[dates[0]] || {}) } : null,
      charts: {
        enabled: Boolean(deps.datasource && typeof telegram.sendPhoto === 'function'),
        maxCharts,
        bars: chartBars,
      },
    };
  }

  return { push, status, preview, alreadySent, assemble, chartFor, chartTargets };
}

module.exports = {
  createNotifier,
  buildDigest,
  buildStockBlock,
  buildPendingLine,
  hkDateKey,
  fmtHolding,
  STATUS_EMOJI,
  MAX_LEN,
  STATE_FILE,
};
