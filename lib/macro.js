'use strict';

/**
 * 宏觀與基本面 — 整合層
 * ======================
 *
 * 把 fred / sec / fomc / interpret 四個模組組裝成前端要的單一結構。
 *
 * 快取策略（沿用本專案「記憶體 → 落地檔」的既有模式）：
 *   各資料的天然更新頻率不同，TTL 不應短於更新頻率。
 *   日頻利率在收盤前根本不會變，設 5 分鐘 TTL 只是浪費上游請求。
 *
 *   FOMC 日程        7 天   （年度表，幾乎不變）
 *   SEC ticker→CIK   7 天   （在 lib/sec.js 內）
 *   SEC companyfacts 24 小時（財報季才變，3.86MB 不宜頻繁抓）
 *   日頻 FRED 序列    6 小時
 *   月頻 FRED 序列    24 小時
 *
 * 原則：**只快取成功的結果**。抓取失敗不覆寫既有快取，
 * 避免一次上游故障就把好資料洗掉。
 */

const fred = require('./fred');
const sec = require('./sec');
const fomc = require('./fomc');
const interpret = require('./interpret');

const TTL = {
  fomc: 7 * 24 * 3600 * 1000,
  daily: 6 * 3600 * 1000,
  monthly: 24 * 3600 * 1000,
  fundamentals: 24 * 3600 * 1000,
};

/** 極簡 TTL 快取 */
function makeCache() {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (Date.now() > hit.expires) { store.delete(key); return null; }
      return hit.value;
    },
    set(key, value, ttlMs) {
      store.set(key, { value, expires: Date.now() + ttlMs });
    },
    /** 只快取成功結果 */
    setIfOk(key, value, ttlMs) {
      if (value && value.available === true) this.set(key, value, ttlMs);
    },
    clear() { store.clear(); },
    stats() { return { entries: store.size }; },
  };
}

const cache = makeCache();

/** 宏觀頁要顯示的序列（順序即前端呈現順序） */
const MACRO_KEYS = [
  'fedTargetUpper', 'fedTargetLower', 'dgs10', 'dgs2', 'dgs30', 'termSpread', 'realYield10',
  'cpiYoy', 'coreCpiYoy', 'unrate', 'indpro', 'payems', 'umcsent',
  'dollarBroad', 'eurusd', 'deficit12m', 'gdpReal', 'manemp',
];

/**
 * 取得宏觀儀表板資料。
 *
 * 各序列獨立抓取，單一失敗不影響其他；失敗的序列仍會出現在清單中
 * （帶 available:false 與原因），而不是從畫面消失——
 * 「這裡本來應該有資料但拿不到」與「這裡沒有這個欄位」是兩件事。
 */
async function getMacroOverview(opts) {
  const force = opts && opts.force;
  const cachedMacro = force ? null : cache.get('macro:series');
  const cachedFomc = force ? null : cache.get('macro:fomc');

  const [seriesList, schedule] = await Promise.all([
    cachedMacro || fred.getMany(MACRO_KEYS),
    cachedFomc || fomc.getSchedule().catch((e) => ({
      available: false, unavailable: 'transient',
      reason: `無法取得 FOMC 日程：${e.message}`,
    })),
  ]);

  if (!cachedMacro) {
    // 只有「至少一半序列成功」才寫快取，避免上游全掛時把空結果存起來
    const okCount = seriesList.filter((s) => s && s.available).length;
    if (okCount >= Math.ceil(MACRO_KEYS.length / 2)) {
      cache.set('macro:series', seriesList, TTL.monthly);
    }
  }
  if (!cachedFomc && schedule && schedule.available) {
    cache.set('macro:fomc', schedule, TTL.fomc);
  }

  // 以 key 建索引供解讀層使用
  const byKey = {};
  for (const s of seriesList) if (s && s.key) byKey[s.key] = s;

  const interpretation = interpret.interpretMacro({ series: byKey, schedule });

  const okCount = seriesList.filter((s) => s && s.available).length;
  const unavailable = seriesList.filter((s) => s && !s.available);

  return {
    ok: true,
    scope: 'macro',
    generatedAt: new Date().toISOString(),
    series: seriesList,
    fomc: schedule,
    interpretation,
    status: {
      total: seriesList.length,
      available: okCount,
      unavailable: unavailable.length,
      // 部分失敗時明確標記 degraded，讓前端能顯示提示
      degraded: unavailable.length > 0,
      unavailableKeys: unavailable.map((s) => ({ key: s.key, label: s.label, reason: s.reason, code: s.unavailable })),
    },
    sources: [
      { name: 'FRED（聖路易斯聯準銀行）', url: 'https://fred.stlouisfed.org', usage: '利率／通膨／就業／生產序列', auth: '免 Key（fredgraph CSV）' },
      { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', usage: 'FOMC 會議日程', auth: '公開頁面' },
    ],
    limitations: [
      '本頁的「利率走勢模組」為**期貨市場隱含利率**，不是 Fed 的預測，也不是本網站的預測模型。'
        + 'Fed 官方不公布未來利率路徑（點陣圖為與會者匿名預測，非委員會決議），'
        + '因此該模組只把市場上實際成交的期貨價格換算成隱含利率，逐點附上合約代碼與價格供回查。',
      'ISM 製造業 PMI 因授權變更已從 FRED 下線，本頁以工業生產（INDPRO）呈現實體產出，兩者概念不同。',
      '日頻序列在週末與假日無新值，不同序列的最新日期可能不一致（已在各列標明 asOf）。',
      '部分月份資料可能因政府停擺等原因缺漏，年增率計算會因此缺少基期（已於畫面標示）。',
      '走勢圖的折線只連接實際觀測值，缺值處直接斷線；長跨度序列經 LTTB 降採樣，可能省略部分中間點，但不會移動任何觀測值。',
    ],
  };
}

/**
 * 取得個股整合資料（財報 + 宏觀背景）。
 */
async function getSymbolOverview(symbol, opts) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) {
    return { ok: false, code: 'EMPTY', message: '請提供股票代碼' };
  }

  const force = opts && opts.force;
  const cacheKey = `fund:${sym}`;
  let fund = force ? null : cache.get(cacheKey);

  if (!fund) {
    fund = await sec.getFundamentals(sym);
    if (fund && fund.available) cache.set(cacheKey, fund, TTL.fundamentals);
  }

  // 宏觀背景精簡：只取 3 項最相關，避免個股頁變成宏觀頁
  const [upper, dgs10, spread] = await Promise.all([
    cache.get('macro:mini') || fred.getSeries('fedTargetUpper').catch(() => null),
    fred.getSeries('dgs10').catch(() => null),
    fred.getSeries('termSpread').catch(() => null),
  ]);

  const interpretation = interpret.interpretFundamentals(fund, opts && opts.ctx);

  return {
    ok: true,
    scope: 'fundamentals',
    generatedAt: new Date().toISOString(),
    symbol: sym,
    fundamentals: fund,
    interpretation,
    macroBackdrop: {
      fedTargetUpper: upper && upper.available ? { value: upper.value, asOf: upper.asOf } : null,
      dgs10: dgs10 && dgs10.available ? { value: dgs10.value, asOf: dgs10.asOf } : null,
      termSpread: spread && spread.available ? { value: spread.value, asOf: spread.asOf } : null,
    },
    sources: [
      { name: 'SEC EDGAR（XBRL companyfacts）', url: 'https://www.sec.gov/edgar', usage: '營收／淨利／資產負債／EPS', auth: '公開，需自訂 User-Agent' },
      { name: 'FRED', url: 'https://fred.stlouisfed.org', usage: '宏觀背景（政策利率、10Y）', auth: '免 Key' },
    ],
  };
}

/**
 * 資料字典：把 fred 的序列註冊表 + SEC 的欄位定義組成一份可渲染的清單。
 *
 * 這是「明確每個資料項的欄位定義、資料來源、數值範圍與範例值」的實作。
 * 範例值取自**實際抓到的資料**（不是編的），抓不到就標明。
 */
async function getDataDictionary() {
  const cached = cache.get('dict');
  if (cached) return cached;

  /* 範例值來源策略（依序）：
       1. 宏觀總覽已在快取裡 → 直接沿用，零額外請求
       2. 否則對全部 18 個序列現抓（與 /api/macro 共用同一份 TTL 快取，
          所以使用者若先開過儀表板，這裡幾乎不會產生新請求）
     早期版本只抽樣 7 個代表序列，導致 11 個欄位的範例值是 null ——
     而「範例值」正是這份字典存在的理由，留空等於沒交付。 */
  const samples = {};
  const cachedMacro = cache.get('macro:series');
  if (Array.isArray(cachedMacro) && cachedMacro.length) {
    for (const s of cachedMacro) {
      if (s && s.key && s.available) samples[s.key] = { value: s.value, asOf: s.asOf };
    }
  }

  const missingKeys = fred.SERIES
    .map((d) => d.key)
    .filter((k) => !samples[k]);

  if (missingKeys.length) {
    await Promise.all(missingKeys.map(async (k) => {
      const s = await fred.getSeries(k).catch(() => null);
      if (s && s.available) samples[k] = { value: s.value, asOf: s.asOf };
    }));
  }

  const macroFields = fred.SERIES.map((def) => {
    const s = samples[def.key];
    return {
      group: '宏觀經濟',
      key: def.key,
      seriesId: def.id,
      label: def.label,
      unit: def.unit,
      freq: def.freq === 'D' ? '日頻' : def.freq === 'M' ? '月頻' : '季頻',
      transform: def.transform === 'yoy' ? '年增率（自行計算）' : '原始值',
      definition: def.definition,
      source: 'FRED',
      sourceUrl: `https://fred.stlouisfed.org/series/${def.id}`,
      range: def.plausible,
      rangeNote: '合理值域，超出即視為資料異常',
      example: s ? s.value : null,
      exampleAsOf: s ? s.asOf : null,
      note: def.note,
    };
  });

  // SEC 財報欄位（定義寫死在此，因為它們是本模組的計算口徑，不是外部 API 欄位）
  const secFields = [
    {
      group: '企業財報', key: 'revenue', label: '營收', unit: 'USD',
      freq: '季頻／年頻', transform: 'TTM 或年度值', source: 'SEC XBRL',
      definition: '公司主要營業活動的收入總額。以 XBRL 概念 RevenueFromContractWithCustomerExcludingAssessedTax 優先，'
        + '依序退回 IncludingAssessedTax / Revenues / SalesRevenueNet。',
      range: [0, 1e13], rangeNote: '非負；上限僅為防呆',
      example: 478834000000, exampleAsOf: '2026-09-26（AAPL FY2026）',
      note: '已廢棄的 Revenues 概念在 AAPL 只到 2018-09-29，必須用概念優先序並檢查資料新舊。',
    },
    {
      group: '企業財報', key: 'netIncome', label: '淨利', unit: 'USD',
      freq: '季頻／年頻', transform: 'TTM 或年度值', source: 'SEC XBRL',
      definition: '扣除所有費用與稅後的淨利潤。概念優先序 NetIncomeLoss → ProfitLoss。',
      range: [-1e12, 1e12], rangeNote: '可為負（虧損）',
      example: 132175000000, exampleAsOf: '2026-09-26（AAPL）',
      note: '淨利含一次性項目（資產減損、訴訟和解），與營業利益不同。',
    },
    {
      group: '企業財報', key: 'epsDiluted', label: '稀釋每股盈餘', unit: 'USD/share',
      freq: '季頻／年頻', transform: '原始值', source: 'SEC XBRL',
      definition: '計入選擇權、可轉債等潛在稀釋效果後的每股盈餘。',
      range: [-100, 1000], rangeNote: '可為負',
      example: 8.98, exampleAsOf: '2026-09-26（AAPL）',
      note: '與基本 EPS 的差異來自稀釋效果；計算本益比時應使用稀釋 EPS。',
    },
    {
      group: '企業財報', key: 'grossMargin', label: '毛利率', unit: '%',
      freq: '依財報', transform: '毛利 / 營收', source: 'SEC XBRL（計算）',
      definition: '（營收 − 營業成本）/ 營收。反映產品定價能力與生產效率。',
      range: [-100, 100], rangeNote: '理論上 0–100，負值代表成本高於售價',
      example: 48.79, exampleAsOf: '2026-09-26（AAPL）',
      note: '分子分母必須同期配對；跨期相除會得到無意義的數字。',
    },
    {
      group: '企業財報', key: 'netMargin', label: '淨利率', unit: '%',
      freq: '依財報', transform: '淨利 / 營收', source: 'SEC XBRL（計算）',
      definition: '淨利 / 營收。與毛利率的落差反映營業費用與稅負。',
      range: [-100, 100], rangeNote: '可為負',
      example: 27.6, exampleAsOf: '2026-09-26（AAPL）',
      note: '與毛利率差距過大代表費用結構沈重。',
    },
    {
      group: '企業財報', key: 'roe', label: '股東權益報酬率（ROE）', unit: '%',
      freq: '依財報', transform: '淨利(TTM) / 股東權益', source: 'SEC XBRL（計算）',
      definition: '淨利除以股東權益。分子是期間值、分母是時點值，口徑已在此標明。',
      range: [-500, 500], rangeNote: '權益接近 0 時會爆表',
      example: 117.92, exampleAsOf: '2026-09-26（AAPL）',
      note: 'AAPL 的 117.9% 不是算錯——大規模庫藏股使權益縮小。權益為負時 ROE 無意義。',
    },
    {
      group: '企業財報', key: 'debtRatio', label: '負債比', unit: '%',
      freq: '依財報', transform: '總負債 / 總資產', source: 'SEC XBRL（計算）',
      definition: '總負債佔總資產的比例。兩者皆為時點值。',
      range: [0, 200], rangeNote: '>100% 代表資不抵債',
      example: 72.29, exampleAsOf: '2026-09-26（AAPL）',
      note: '高負債比不一定不好，需看負債性質（有息負債 vs 營運週轉）與產業慣例。',
    },
    {
      group: '企業財報', key: 'revenueYoy', label: '營收年增率', unit: '%',
      freq: '依財報', transform: '（本期 − 去年同期）/ 去年同期', source: 'SEC XBRL（計算）',
      definition: '與去年同期比較的成長率。TTM 必須對 TTM、年度必須對年度，不可混用。',
      range: [-100, 500], rangeNote: '基期為負或接近 0 時比率會失真',
      example: 15.06, exampleAsOf: '2026-09-26（AAPL）',
      note: '財年 52/53 週制公司需用 364 天對齊，不能用 365 天。',
    },
  ];

  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    fields: [...macroFields, ...secFields],
    groups: ['宏觀經濟', '企業財報'],
    conventions: [
      '所有數值皆附 asOf（資料所屬日期），不同欄位的 asOf 可能不同，這是正常的。',
      '空值一律視為「無觀測值」，不以 0 代替。',
      '合理值域用於自動偵測資料異常，超出時仍顯示數值但會標記。',
      '範例值取自實際抓取的資料，可能隨時間變動；非固定常數。',
    ],
  };

  cache.set('dict', result, 12 * 3600 * 1000);
  return result;
}

module.exports = {
  getMacroOverview,
  getSymbolOverview,
  getDataDictionary,
  MACRO_KEYS,
  TTL,
  cache,
};
