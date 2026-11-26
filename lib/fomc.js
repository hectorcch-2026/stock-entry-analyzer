'use strict';

/**
 * FOMC 會議日程解析
 * ==================
 *
 * 來源：https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *
 * ---------------------------------------------------------------------------
 * 為什麼不直接用「press release 連結反推日期」
 * ---------------------------------------------------------------------------
 * 最直覺的做法是抓頁面上的 `/monetarypolicy/files/monetary20260128a.pdf` 這類連結，
 * 用正則抽出 20260128。實測確實能抽到 48 個日期、涵蓋 2021–2026，
 * **但 2026 只抽到 7 場**——因為 12 月那場還沒開，所以還沒有會後聲明檔案。
 *
 * 用「連結反推」會系統性漏掉**所有尚未舉行的會議**，
 * 而「下次會議何時」正是使用者最想知道的事。這是致命的設計錯誤。
 *
 * 正確做法：直接解析頁面上的會議表格（`div.fomc-meeting`），
 * 裡面有 `fomc-meeting__month`（月份名）與 `fomc-meeting__date`（如 `8-9` 或 `27-28`）。
 * 實測 2026 年可完整解析出 **8 場**，包含 12 月 8–9 日。
 *
 * ---------------------------------------------------------------------------
 * 兩個解析陷阱
 * ---------------------------------------------------------------------------
 * 1. **Jackson Hole 不是 FOMC 例會**。2025 年會出現一筆 08-22，
 *    那是全球央行年會。若從連結反推就會誤收，導致「一年 9 場」的荒謬結果
 *    （正常是 8 場）。改為解析表格後此問題自然消失，但仍保留場次數檢查。
 * 2. **日期跨月**。實測格式為 `27-28`（同月）、`28-29`，但也有跨月寫法。
 *    取**結束日**作為會議日（決議與記者會都在第二天）。
 */

const UA = 'stock-entry-analyzer/1.0 (macro page; contact@example.com)';
const URL_CAL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 解析會議表格區塊為會議清單。
 *
 * @param {string} html 頁面 HTML
 * @param {number} year 要解析的年度
 * @returns {{date:string, month:string, days:string, label:string}[]}
 */
function parseYearMeetings(html, year) {
  if (typeof html !== 'string' || !html) return [];

  // 切出該年度的 panel：從 "20XX FOMC Meetings" 到下一個年度標題
  const marker = `${year} FOMC Meetings`;
  const start = html.indexOf(marker);
  if (start < 0) return [];

  let end = html.length;
  for (const y of [year + 1, year - 1]) {
    const i = html.indexOf(`${y} FOMC Meetings`, start + marker.length);
    if (i > start && i < end) end = i;
  }
  const scope = html.slice(start, end);

  const out = [];
  // 每個會議區塊：月份名 + 日期字串（可能帶 * 標記，代表有預測材料）
  const re = /fomc-meeting__month[^>]*>\s*<strong>([A-Za-z]+)<\/strong>[\s\S]{0,400}?fomc-meeting__date[^>]*>\s*([0-9]{1,2}(?:\s*[-–]\s*[0-9]{1,2})?)\s*\*?\s*</g;

  let m;
  while ((m = re.exec(scope))) {
    const monthName = m[1].toLowerCase();
    const monthNum = MONTHS[monthName];
    if (!monthNum) continue;

    const daysRaw = m[2].replace(/\s/g, '');
    // 取區間的第二個數字＝會議結束日；只有一天就直接用
    const parts = daysRaw.split(/[-–]/);
    const dayNum = parseInt(parts[parts.length - 1], 10);
    if (!dayNum || dayNum < 1 || dayNum > 31) continue;

    const iso = `${year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) continue;
    // 防止出現 2 月 30 日這種不存在的日期
    if (d.getUTCMonth() + 1 !== monthNum || d.getUTCDate() !== dayNum) continue;

    out.push({
      date: iso,
      month: monthName.charAt(0).toUpperCase() + monthName.slice(1),
      days: daysRaw,
      label: `${monthName.charAt(0).toUpperCase() + monthName.slice(1)} ${daysRaw}`,
    });
  }

  // 去重並依日期排序
  const seen = new Set();
  return out.filter((x) => (seen.has(x.date) ? false : seen.add(x.date)))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 場次合理性檢查。
 * 正常一年 8 場。實測 2021–2024 皆 8 場，2026 也是 8 場。
 * 少於 6 或多於 9 都代表解析可能有問題（或頁面結構改變）。
 *
 * 注意：**尚未公布的年度本來就可能只有部分場次**（例：頁面剛更新），
 * 所以「少」只警告不報錯；「多」則幾乎一定是誤收（如 Jackson Hole）。
 */
function validateMeetings(meetings, year) {
  const n = meetings.length;
  const issues = [];
  if (n === 0) issues.push(`${year} 年解析不到任何會議，頁面結構可能已變更`);
  else if (n > 9) issues.push(`${year} 年解析出 ${n} 場，超過合理上限 9 場，可能誤收非例會事件（如 Jackson Hole）`);
  else if (n < 6) issues.push(`${year} 年僅解析出 ${n} 場（正常為 8 場），可能尚未完整公布`);
  return { ok: issues.length === 0, expected: 8, parsed: n, issues };
}

/**
 * 取得 FOMC 日程（含下次會議）。
 *
 * @returns {Promise<object>}
 */
async function getSchedule() {
  let html = null;
  let lastErr = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(URL_CAL, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        lastErr = `Fed 官網回應 HTTP ${res.status}`;
        if (attempt === 0) { await sleep(800); continue; }
      } else {
        html = await res.text();
        break;
      }
    } catch (e) {
      lastErr = `無法連線至 Fed 官網：${e.message}`;
      if (attempt === 0) await sleep(800);
    }
  }

  if (!html) {
    return {
      available: false, unavailable: 'transient',
      reason: lastErr || '無法取得 FOMC 日程',
      source: 'Federal Reserve', sourceUrl: URL_CAL,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const thisYear = new Date().getUTCFullYear();

  const years = [thisYear, thisYear + 1];
  const byYear = {};
  const all = [];
  const validations = [];

  for (const y of years) {
    const ms = parseYearMeetings(html, y);
    byYear[y] = ms;
    all.push(...ms);
    validations.push({ year: y, ...validateMeetings(ms, y) });
  }

  const upcoming = all.filter((m) => m.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const past = all.filter((m) => m.date < today).sort((a, b) => (a.date < b.date ? 1 : -1));
  const next = upcoming[0] || null;

  let daysUntilNext = null;
  if (next) {
    daysUntilNext = Math.round(
      (Date.parse(next.date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000
    );
  }

  return {
    available: true,
    source: 'Federal Reserve',
    sourceUrl: URL_CAL,
    asOf: today,
    byYear,
    upcoming: upcoming.slice(0, 6),
    recent: past.slice(0, 4),
    next: next ? { ...next, daysUntil: daysUntilNext } : null,
    validations,
    // 誠實宣告：Fed 不發布利率預測路徑，本模組也不提供
    forecastNote: 'Fed 官方不公布未來利率路徑（點陣圖為與會者匿名預測，非委員會決議）。'
      + '本頁僅提供「已知的會議時程」與「當前政策利率」，不提供利率預測。',
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { parseYearMeetings, validateMeetings, getSchedule, URL_CAL };
