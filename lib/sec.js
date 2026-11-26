'use strict';

/**
 * SEC EDGAR 存取層（企業財報）
 * ============================
 *
 * 三個端點：
 *   /files/company_tickers.json          代碼 → CIK 映射（約 796KB，1 萬餘筆）
 *   /api/xbrl/companyfacts/CIK##########.json  全部 XBRL 財務事實（AAPL 約 3.86MB）
 *   /submissions/CIK##########.json      申報清單（最近 1000 餘筆）
 *
 * ---------------------------------------------------------------------------
 * 三個必須寫進程式的坑（實測，勿移除）
 * ---------------------------------------------------------------------------
 * 1. **User-Agent 必須帶，且要含聯絡方式**。SEC 明文規定，不帶直接 403。
 *    實測 data.sec.gov 對空 UA 回 403；帶自訂 UA 才 200。
 *
 * 2. **`Revenues` 這個概念已廢棄**。實測 AAPL 的 `Revenues` 只有 11 筆、
 *    最新停在 **2018-09-29**；現行用的是
 *    `RevenueFromContractWithCustomerExcludingAssessedTax`（120 筆，最新 2026-09-26）。
 *    若照直覺寫 `facts['us-gaap'].Revenues`，會拿到 8 年前的營收，
 *    而且**完全不會報錯**——數字看起來很正常，只是全部過期。
 *    → 必須用「概念優先序」逐個嘗試，並檢查最新資料點是否夠新。
 *
 * 3. **同一概念混了兩種期間語義**。
 *    `Assets` 是**時點值**（frame 結尾 `I`，如 CY2026Q3I，沒有 start）；
 *    `Revenues` 是**區間值**（有 start/end，長度 90 天＝單季、365 天＝年度）。
 *    混用會把「單季」與「累計 9 個月」當成同一條序列，算出來的 YoY 全錯。
 *    → 用 (end - start) 天數分類，並在取用時明確指定要哪一類。
 *
 * 速率限制：SEC 官方規定 10 req/s。實測連發 12 次都 200、沒有 rate-limit 標頭，
 * 但**不能因為測不出來就放飛**——本模組自建節流器（120ms 間隔 ≈ 8.3 req/s）。
 */

const UA = 'stock-entry-analyzer/1.0 (fundamentals; contact@example.com)';

// 全域節流：所有 SEC 請求共用同一條時間軸，不隨呼叫端膨脹
const THROTTLE = { minIntervalMs: 120, lastAt: 0 };

let cikMapCache = null;      // { at:number, map:Map<string,{cik,title}> }
const CIK_MAP_TTL_MS = 7 * 24 * 3600 * 1000;

const factsCache = new Map(); // cik -> { at, data }
const FACTS_TTL_MS = 24 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取得節流許可（序列化所有 SEC 請求） */
async function throttle() {
  const now = Date.now();
  const wait = THROTTLE.lastAt + THROTTLE.minIntervalMs - now;
  if (wait > 0) await sleep(wait);
  THROTTLE.lastAt = Date.now();
}

/**
 * 帶節流與重試的 SEC GET。
 * 429/403 會退避重試一次；404 不重試（重試也不會變成有資料）。
 */
async function secGet(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 30000;
  let lastErr = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 404) {
        return { ok: false, status: 404, code: 'NOT_FOUND', retryable: false,
          message: 'SEC 查無此資源' };
      }
      if (res.status === 403) {
        return { ok: false, status: 403, code: 'BLOCKED', retryable: false,
          message: 'SEC 拒絕存取（User-Agent 可能不符規定）' };
      }
      if (res.status === 429) {
        lastErr = { status: 429, code: 'RATE_LIMITED', retryable: true,
          message: 'SEC 限流（超過 10 req/s）' };
        if (attempt === 0) { await sleep(1200); continue; }
        return { ok: false, ...lastErr };
      }
      if (!res.ok) {
        lastErr = { status: res.status, code: 'UPSTREAM', retryable: true,
          message: `SEC 回應 HTTP ${res.status}` };
        if (attempt === 0) { await sleep(800); continue; }
        return { ok: false, ...lastErr };
      }

      return { ok: true, data: await res.json() };
    } catch (e) {
      lastErr = { code: 'NETWORK', retryable: true, message: `無法連線至 SEC：${e.message}` };
      if (attempt === 0) await sleep(800);
    }
  }
  return { ok: false, ...(lastErr || { code: 'UNKNOWN', retryable: true, message: '未知錯誤' }) };
}

/* ============================================================
   代碼 → CIK
   ============================================================ */

/**
 * 代碼正規化。
 * 實測：SEC 表用 `BRK-B`，而市場慣用 `BRK.B`；港股完全不在表內。
 */
function normalizeTicker(sym) {
  return String(sym || '').trim().toUpperCase().replace(/\./g, '-');
}

/**
 * 取得 ticker → CIK 映射（7 天快取）。
 * @returns {Promise<{ok:boolean, map?:Map, code?:string, message?:string, count?:number}>}
 */
async function getCikMap() {
  const now = Date.now();
  if (cikMapCache && now - cikMapCache.at < CIK_MAP_TTL_MS) {
    return { ok: true, map: cikMapCache.map, count: cikMapCache.map.size, cached: true };
  }

  const r = await secGet('https://www.sec.gov/files/company_tickers.json');
  if (!r.ok) return { ok: false, code: r.code, message: r.message };

  // 原始格式：{ "0": {cik_str, ticker, title}, "1": {...}, ... }
  const map = new Map();
  const obj = r.data || {};
  for (const k of Object.keys(obj)) {
    const row = obj[k];
    if (!row || !row.ticker) continue;
    map.set(String(row.ticker).toUpperCase(), {
      cik: String(row.cik_str).padStart(10, '0'),
      title: row.title || '',
    });
  }

  cikMapCache = { at: now, map };
  return { ok: true, map, count: map.size };
}

/**
 * 解析單一代碼為 {cik, title}。
 * 港股／非 SEC 註冊公司會回 not_applicable，而不是「失敗」。
 */
async function resolveCik(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return { ok: false, code: 'EMPTY', message: '缺少股票代碼' };

  // 港股沒有 SEC 申報（實測 .HK 在 company_tickers.json 中 0 筆）
  if (/\.HK$/.test(raw) || /^\d{4,5}$/.test(raw)) {
    return {
      ok: false, code: 'NOT_APPLICABLE', market: 'HK',
      message: `${raw} 為港股，沒有 SEC 申報紀錄`,
      hint: '港股財報請參考公司年報或港交所披露易；本頁不提供港股基本面。',
    };
  }

  const mapRes = await getCikMap();
  if (!mapRes.ok) return { ok: false, code: mapRes.code, message: mapRes.message };

  const cand = normalizeTicker(raw);
  let hit = mapRes.map.get(cand);

  // 退回原始寫法（有些 ticker 本來就含點）
  if (!hit) hit = mapRes.map.get(raw);

  if (!hit) {
    return {
      ok: false, code: 'NOT_FOUND',
      message: `SEC 找不到代碼 ${raw} 的申報紀錄`,
      hint: '可能非美國註冊公司（如 ADR 底層為外國私人發行人時不報 10-K）。',
    };
  }

  return { ok: true, cik: hit.cik, title: hit.title, ticker: cand };
}

/* ============================================================
   companyfacts 解析
   ============================================================ */

/** 概念優先序：越前面越優先。註解說明為何是這個順序。 */
const CONCEPT_PRIORITY = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax', // 現行主流（ASC 606 後）
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'Revenues',                                            // 已廢棄但仍存在，常停在 2018
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
  ],
  netIncome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  epsDiluted: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  cash: ['CashAndCashEquivalentsAtCarryingValue'],
  sharesDiluted: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  inventory: ['InventoryNet'],
  receivables: ['AccountsReceivableNetCurrent'],
};

/**
 * 把某一概念的原始陣列整理成帶期間語義的觀測值。
 *
 * @param {object[]} arr SEC 原始 facts 陣列（含 start/end/val/form/filed/fy/fp/frame）
 * @returns {{instant:object[], duration:object[]}}
 */
function classifyPeriods(arr) {
  const instant = [];
  const duration = [];

  for (const row of arr || []) {
    if (row == null || row.val == null) continue;
    const val = Number(row.val);
    if (!isFinite(val)) continue;

    const form = String(row.form || '');
    // 只收正式財報；8-K / 424B 等附帶揭露的數字口徑不一
    if (!/^10-[KQ]/.test(form)) continue;

    const end = row.end;
    if (!end) continue;

    if (row.start) {
      const days = daysBetween(row.start, end);
      duration.push({
        start: row.start, end, days, val,
        form, filed: row.filed || '', fy: row.fy ?? null, fp: row.fp || '',
        frame: row.frame || '',
        period: classifyDuration(days),
      });
    } else {
      instant.push({
        end, val, form, filed: row.filed || '',
        fy: row.fy ?? null, fp: row.fp || '', frame: row.frame || '',
        period: 'instant',
      });
    }
  }

  // 同一 (start,end) 若多次申報（重述），取 filed 最新的一筆
  const dedupe = (list, keyFn) => {
    const best = new Map();
    for (const r of list) {
      const k = keyFn(r);
      const prev = best.get(k);
      if (!prev || String(r.filed) > String(prev.filed)) best.set(k, r);
    }
    return [...best.values()];
  };

  return {
    instant: dedupe(instant, (r) => r.end)
      .sort((a, b) => (a.end < b.end ? -1 : 1)),
    duration: dedupe(duration, (r) => `${r.start}|${r.end}`)
      .sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0)),
  };
}

function daysBetween(a, b) {
  const d1 = Date.parse(a + 'T00:00:00Z');
  const d2 = Date.parse(b + 'T00:00:00Z');
  if (!isFinite(d1) || !isFinite(d2)) return 0;
  return Math.round((d2 - d1) / 86400000);
}

/**
 * 把日期往前推 364 天（52 週）。
 * 刻意不用 365：多數美國公司的財年是 52/53 週制，
 * 用 364 天對齊「去年同一財季」比用 365 更準。
 */
function shiftYear(dateStr) {
  const t = Date.parse(dateStr + 'T00:00:00Z');
  if (!isFinite(t)) return dateStr;
  return new Date(t - 364 * 86400000).toISOString().slice(0, 10);
}

/**
 * 依天數分類期間語義。
 * 實測常見：單季 ≈ 91 天、年度 ≈ 364/365 天、累計 9 個月 ≈ 273 天。
 * 用寬鬆區間容納 52/53 週制（Apple 的財年常是 364 天）。
 */
function classifyDuration(days) {
  if (days >= 80 && days <= 100) return 'quarter';
  if (days >= 170 && days <= 190) return 'half';
  if (days >= 260 && days <= 285) return 'nineMonth';
  if (days >= 350 && days <= 380) return 'year';
  return 'other';
}

/**
 * 從 companyfacts 取出某個語意欄位（營收／淨利／…）的最佳序列。
 *
 * 回傳會標明用了哪個概念、為什麼用它，以及最新資料點日期。
 */
function pickConcept(facts, kind) {
  const gaap = (facts && facts.facts && facts.facts['us-gaap']) || {};
  const list = CONCEPT_PRIORITY[kind] || [];

  const tried = [];
  for (const concept of list) {
    const f = gaap[concept];
    if (!f || !f.units) { tried.push({ concept, result: 'missing' }); continue; }

    // 單位可能是 USD / USD-per-shares / shares
    const unitKeys = Object.keys(f.units);
    const wanted = kind === 'epsDiluted' ? 'USD/shares'
      : (kind === 'sharesDiluted' ? 'shares' : 'USD');
    const unitKey = unitKeys.includes(wanted) ? wanted : unitKeys[0];
    const arr = f.units[unitKey] || [];

    const cls = classifyPeriods(arr);
    const usable = kind === 'assets' || kind === 'liabilities' || kind === 'equity'
      ? cls.instant
      : cls.duration;

    if (!usable.length) { tried.push({ concept, result: 'no-usable-period' }); continue; }

    const latest = usable[usable.length - 1];
    // 核心防護：概念存在但資料太舊（Revenues 停在 2018 的經典情況）→ 往下試
    const ageDays = daysBetween(latest.end, new Date().toISOString().slice(0, 10));
    if (ageDays > 500 && list.indexOf(concept) < list.length - 1) {
      tried.push({ concept, result: `stale (last ${latest.end})` });
      continue;
    }

    tried.push({ concept, result: 'used' });
    return { ok: true, concept, unit: unitKey, latest, all: usable, tried };
  }

  return { ok: false, tried, message: `找不到可用的 ${kind} 概念` };
}

/**
 * 把「單季」序列組成 TTM（最近 4 季相加）。
 * 只有當最後 4 點彼此連續（季與季相接）才算，避免把不連續的季度硬加。
 */
function ttm(durationPoints) {
  const quarters = (durationPoints || []).filter((p) => p.period === 'quarter');
  if (quarters.length < 4) return null;

  const last4 = quarters.slice(-4);
  // 相鄰季度必須首尾相接（誤差 5 天內），否則不是連續四季
  for (let i = 1; i < last4.length; i++) {
    const gap = daysBetween(last4[i - 1].end, last4[i].start);
    if (Math.abs(gap) > 5) return null;
  }
  const sum = last4.reduce((s, p) => s + p.val, 0);
  return { value: sum, from: last4[0].start, to: last4[3].end, quarters: last4.length };
}

/**
 * 推導 TTM，處理「財報結構本身沒有單季 Q4」的必然情況。
 * ---------------------------------------------------------------
 * 這是實測 AAPL 才發現的：10-K 只揭露**年度**與**年初至今（YTD）**，
 * 不會單獨揭露第 4 季，所以「最近 4 個單季」這條路在財年結束時必然斷開。
 * 實測 AAPL 的單季序列在 2025-06-27 → 2025-09-28 之間缺一格，正是 Q4。
 *
 * 正確做法（三條路，依序嘗試）：
 *   1. 最近 4 個單季連續 → 直接相加
 *   2. 最新資料點就是年度值 → TTM 就等於該年度（財年結束當下 TTM == FY）
 *   3. 有當期 YTD → TTM = 上一個完整年度 + 當期 YTD − 去年同期 YTD
 *
 * 第 2 條常被誤判成「資料缺口」，其實是正確結果。
 *
 * @returns {{value:number, basis:string, from:string|null, to:string, quarters:number[]}|null}
 */
function deriveTtm(durationPoints) {
  const all = durationPoints || [];
  const quarters = all.filter((p) => p.period === 'quarter');
  const years = all.filter((p) => p.period === 'year');
  const ytds = all.filter((p) => p.period === 'half' || p.period === 'nineMonth');

  if (!all.length) return null;
  const latest = all[all.length - 1];

  // 路線 1：連續四季相加
  const direct = ttm(all);
  if (direct && Math.abs(daysBetween(direct.to, latest.end)) < 5) {
    return { value: direct.value, basis: 'TTM', from: direct.from, to: direct.to,
      quarters: direct.quarters, method: '4 個連續單季相加' };
  }

  // 路線 2：最新點是年度 → TTM == FY
  if (latest.period === 'year') {
    return { value: latest.val, basis: 'FY', from: latest.start || null, to: latest.end,
      quarters: 4, method: '最新財報為年度，財年結束時 TTM 等於年度值' };
  }

  // 路線 3：FY + 當期 YTD − 去年同期 YTD
  // 注意「當期 YTD」不限定是 half/nineMonth —— 財年第一季時，YTD 就是那一季。
  // 實測 MSFT（財年 6 月底結）最新點是 2026-09-30 的單季，
  // 若只從 half/nineMonth 裡挑「最後一個 YTD」，會誤抓到 2026-03-31 的 9 個月累計，
  // 算出一個結束日在 3 月、卻號稱是最新的 TTM。必須以 latest 為基準。
  const anchorYear = years
    .filter((y) => daysBetween(y.end, latest.end) > 0)
    .sort((a, b) => (a.end < b.end ? 1 : -1))[0];

  if (anchorYear) {
    // 去年同期、且長度相同的區間（排除年度本身）
    const priorYtd = all.find((p) =>
      p !== latest && p.period !== 'year' &&
      Math.abs(p.days - latest.days) <= 6 &&
      Math.abs(daysBetween(p.end, latest.end) - 364) <= 25);

    if (priorYtd) {
      const val = anchorYear.val + latest.val - priorYtd.val;
      return {
        value: val, basis: 'TTM', from: null, to: latest.end, quarters: 4,
        method: `上一年度（截至 ${anchorYear.end}）+ 當期 ${latest.days} 天 − 去年同期同長度`,
      };
    }
  }

  return null;
}

/**
 * 取最近的申報清單（10-K / 10-Q / 8-K）。
 */
async function getRecentFilings(cik, limit) {
  const n = limit || 10;
  const r = await secGet(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!r.ok) return { ok: false, code: r.code, message: r.message };

  const recent = (r.data && r.data.filings && r.data.filings.recent) || {};
  const forms = recent.form || [];
  const dates = recent.filingDate || [];
  const accn = recent.accessionNumber || [];
  const docs = recent.primaryDocument || [];
  const desc = recent.primaryDocDescription || [];

  const out = [];
  for (let i = 0; i < forms.length && out.length < n; i++) {
    if (!/^(10-K|10-Q|8-K)$/.test(forms[i])) continue;
    const accnPlain = String(accn[i] || '').replace(/-/g, '');
    out.push({
      form: forms[i],
      filedAt: dates[i] || '',
      description: desc[i] || '',
      url: accnPlain
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accnPlain}/${docs[i] || ''}`
        : null,
    });
  }
  return { ok: true, filings: out, entityName: (r.data && r.data.name) || '' };
}

/**
 * 取得單一公司的完整基本面。
 *
 * @param {string} symbol
 * @returns {Promise<object>} 一律回傳結構化物件，含 available / unavailable 標記
 */
async function getFundamentals(symbol) {
  const resolved = await resolveCik(symbol);
  if (!resolved.ok) {
    return {
      symbol: String(symbol || '').toUpperCase(),
      available: false,
      unavailable: resolved.code === 'NOT_APPLICABLE' ? 'not_applicable'
        : (resolved.code === 'NOT_FOUND' ? 'not_applicable' : 'transient'),
      code: resolved.code,
      reason: resolved.message,
      hint: resolved.hint || null,
    };
  }

  const { cik, title } = resolved;

  // 快取
  const cached = factsCache.get(cik);
  let facts;
  if (cached && Date.now() - cached.at < FACTS_TTL_MS) {
    facts = cached.data;
  } else {
    const r = await secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
      { timeoutMs: 40000 });
    if (!r.ok) {
      return {
        symbol: resolved.ticker, cik, entityName: title,
        available: false,
        unavailable: r.code === 'RATE_LIMITED' ? 'blocked' : 'transient',
        code: r.code, reason: r.message,
      };
    }
    facts = r.data;
    // 只留解析後需要的部分；不要長期駐留 3.86MB 原始物件
    factsCache.set(cik, { at: Date.now(), data: facts });
  }

  const picked = {
    revenue: pickConcept(facts, 'revenue'),
    netIncome: pickConcept(facts, 'netIncome'),
    grossProfit: pickConcept(facts, 'grossProfit'),
    operatingIncome: pickConcept(facts, 'operatingIncome'),
    eps: pickConcept(facts, 'epsDiluted'),
    assets: pickConcept(facts, 'assets'),
    liabilities: pickConcept(facts, 'liabilities'),
    equity: pickConcept(facts, 'equity'),
  };

  const rev = picked.revenue;
  const ni = picked.netIncome;

  // --- 期間一致性：優先用推導出的 TTM，否則退回最近年度 ---
  const revTtm = rev.ok ? deriveTtm(rev.all) : null;
  const niTtm = ni.ok ? deriveTtm(ni.all) : null;

  const revAnnual = rev.ok ? [...rev.all].reverse().find((p) => p.period === 'year') : null;
  const niAnnual = ni.ok ? [...ni.all].reverse().find((p) => p.period === 'year') : null;

  const revUse = revTtm || (revAnnual ? { value: revAnnual.val, basis: 'FY', from: revAnnual.start, to: revAnnual.end } : null);
  const niUse = niTtm || (niAnnual ? { value: niAnnual.val, basis: 'FY', from: niAnnual.start, to: niAnnual.end } : null);

  // --- YoY：同基期比較（TTM 對 TTM、FY 對 FY），不可混用 ---
  const revYoy = (() => {
    if (!rev.ok || !revUse) return null;
    const years = rev.all.filter((p) => p.period === 'year').sort((a, b) => (a.end < b.end ? -1 : 1));
    if (revUse.basis === 'FY') {
      // 年度對年度
      if (years.length < 2) return null;
      const cur = years[years.length - 1];
      const prev = years.find((p) => Math.abs(daysBetween(p.end, cur.end) - 364) < 20);
      if (!prev || !prev.val) return null;
      return +(((cur.val - prev.val) / Math.abs(prev.val)) * 100).toFixed(2);
    }
    // TTM 對「去年同期的 TTM」：用兩個相差約一年的 TTM 端點
    const targetEnd = shiftYear(revUse.to);
    const curQ = rev.all.filter((p) => p.period === 'quarter');
    const lastYearTo = curQ.find((p) => Math.abs(daysBetween(p.end, targetEnd)) < 25);
    if (!lastYearTo) return null;
    const idx = curQ.indexOf(lastYearTo);
    const fourQ = curQ.slice(Math.max(0, idx - 3), idx + 1);
    if (fourQ.length < 4) return null;
    const prevTtm = fourQ.reduce((s, p) => s + p.val, 0);
    if (!prevTtm) return null;
    return +(((revUse.value - prevTtm) / Math.abs(prevTtm)) * 100).toFixed(2);
  })();

  // --- 比率（同期配對，不跨期） ---
  const ratio = (numPick, denPick) => {
    if (!numPick.ok || !denPick.ok) return null;
    const n = deriveTtm(numPick.all);
    const d = deriveTtm(denPick.all);
    if (!n || !d) return null;
    if (!d.value) return null;
    return +((n.value / d.value) * 100).toFixed(2);
  };

  const grossMargin = ratio(picked.grossProfit, picked.revenue);
  const operatingMargin = ratio(picked.operatingIncome, picked.revenue);
  const netMargin = ratio(picked.netIncome, picked.revenue);

  let debtRatio = null;
  if (picked.liabilities.ok && picked.assets.ok) {
    const l = picked.liabilities.latest.val;
    const a = picked.assets.latest.val;
    if (a) debtRatio = +((l / a) * 100).toFixed(2);
  }

  let roe = null;
  let roeNote = null;
  if (niUse && picked.equity.ok) {
    const eq = picked.equity.latest.val;
    if (eq && eq !== 0) {
      roe = +((niUse.value / eq) * 100).toFixed(2);
      // 權益極小會讓 ROE 爆表。AAPL 實測 117.9% 並非算錯——
      // 大規模回購把權益從 2020 的 653 億壓到 1120 億區間，分母變小所致。
      if (Math.abs(roe) > 100) {
        roeNote = 'ROE 超過 100%：淨利大於股東權益，通常來自大規模庫藏股使權益縮小'
                + '（非計算錯誤）。此時 ROE 不宜與同業直接比較。';
      }
      if (eq < 0) {
        roeNote = '股東權益為負數（累積虧損或巨額回購），ROE 失去意義，不應採用。';
      }
    }
  }

  // --- 申報清單 ---
  const filings = await getRecentFilings(cik, 10).catch(() => ({ ok: false, filings: [] }));

  // --- 資料缺口宣告：讓前端能誠實顯示「這幾個數字算不出來」 ---
  const gaps = [];
  if (!rev.ok) gaps.push('營收');
  if (!ni.ok) gaps.push('淨利');
  if (grossMargin == null) gaps.push('毛利率');
  if (roe == null) gaps.push('ROE');
  if (revTtm && revTtm.basis !== 'TTM') gaps.push('TTM（改以年度值呈現）');

  return {
    symbol: resolved.ticker,
    cik,
    entityName: facts.entityName || title,
    available: true,
    source: 'SEC EDGAR XBRL',
    sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K`,
    asOf: rev.ok ? rev.latest.end : null,
    concepts: {
      revenue: rev.ok ? rev.concept : null,
      netIncome: ni.ok ? ni.concept : null,
      eps: picked.eps.ok ? picked.eps.concept : null,
    },
    metrics: {
      revenue: revUse ? { value: revUse.value, basis: revUse.basis,
        method: revUse.method || null,
        from: revUse.from || null, to: revUse.to || null, yoy: revYoy } : null,
      netIncome: niUse ? { value: niUse.value, basis: niUse.basis,
        method: niUse.method || null, to: niUse.to || null } : null,
      epsDiluted: picked.eps.ok ? {
        value: picked.eps.latest.val,
        period: picked.eps.latest.period,
        to: picked.eps.latest.end,
      } : null,
      grossMargin, operatingMargin, netMargin, debtRatio, roe, roeNote,
    },
    balance: {
      assets: picked.assets.ok ? { value: picked.assets.latest.val, asOf: picked.assets.latest.end } : null,
      liabilities: picked.liabilities.ok ? { value: picked.liabilities.latest.val, asOf: picked.liabilities.latest.end } : null,
      equity: picked.equity.ok ? { value: picked.equity.latest.val, asOf: picked.equity.latest.end } : null,
    },
    gaps,
    filings: filings.ok ? filings.filings : [],
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  UA, THROTTLE,
  normalizeTicker, getCikMap, resolveCik,
  classifyPeriods, classifyDuration, pickConcept, ttm, deriveTtm,
  daysBetween, shiftYear,
  getRecentFilings, getFundamentals,
  CONCEPT_PRIORITY,
};
