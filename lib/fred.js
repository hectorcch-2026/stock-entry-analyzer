'use strict';

/**
 * FRED 序列存取層
 * ================
 *
 * 資料來源：Federal Reserve Bank of St. Louis（FRED）公開圖表 CSV 入口
 *   https://fred.stlouisfed.org/graph/fredgraph.csv?id=<SERIES_ID>
 *
 * 走的是官方圖表下載端點，**不需要 API Key**，也不涉及網頁反爬。
 * 若日後要取 series metadata / 更嚴謹的錯誤碼，可在 config 設定 fredApiKey
 * 改用 api.stlouisfed.org；本模組不強制。
 *
 * ---------------------------------------------------------------------------
 * 三個實測踩到的坑（全部已寫成防護，勿移除）
 * ---------------------------------------------------------------------------
 * 1. **User-Agent 必須帶**。實測不帶 UA 時 fredgraph 會回連線失敗（curl 回 000），
 *    帶一般 UA 才穩定回 200。這與 SEC 的規定不同（SEC 是明文要求），
 *    但結果一樣：沒帶就可能整批失敗。
 *
 * 2. **≥3 個序列會改回 ZIP**。實測：
 *      id=A,B        → application/csv
 *      id=A,B,C      → application/zip（內含 daily.csv / monthly.csv / README.txt）
 *    若直接把 ZIP 位元組當 CSV 解析，會得到一堆亂碼列而「看起來有資料」。
 *    因此本模組**一律單序列抓取**，並在偵測到 ZIP magic bytes（PK\x03\x04）時明確報錯。
 *
 * 3. **最後一列不一定是各序列的最新值**。實測 DGS10,DGS2,T10Y2Y 合併 CSV 的
 *    最後一列是 `2026-11-25,,,0.24`——DGS10/DGS2 當天無值（空字串），
 *    只有 T10Y2Y 有值。若取「最後一列」當最新值，會拿到 null。
 *    因此每個序列各自往回溯找**最後一個非空值**。
 *
 * 另一個原則：空字串一律視為 null，**絕不當成 0**。
 * 實測合併 CSV 有 4,315 / 16,932 列含空值（各序列歷史起點不同）；
 * 當成 0 會讓圖表出現「跌到零」的假線段。
 */

const UA = 'stock-entry-analyzer/1.0 (macro page; contact@example.com)';
const BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const CACHE_DIR = require('path').join(__dirname, '..', 'data', 'macro');

/* ============================================================
   序列註冊表
   ------------------------------------------------------------
   每個欄位都必須寫清楚：這是什麼、單位、原始頻率、合理值域。
   前端「資料字典」頁直接吃這份定義，不在前端另外硬編碼一份，
   避免兩邊各說各話。
   ============================================================ */

/**
 * @typedef {Object} SeriesDef
 * @property {string} key      前端欄位名（唯一）
 * @property {string} id       FRED series id
 * @property {string} label    中文名稱
 * @property {string} unit     單位
 * @property {string} freq     'D' 日頻 | 'M' 月頻 | 'Q' 季頻
 * @property {string} transform 'level' 原值 | 'yoy' 年增率 | 'spread' 利差
 * @property {[number,number]} plausible 合理值域（超出即視為資料異常）
 * @property {string} definition 欄位定義：這個數字在衡量什麼
 * @property {string} note     使用時必須知道的限制
 */

/** @type {SeriesDef[]} */
const SERIES = [
  {
    key: 'fedTargetUpper', id: 'DFEDTARU', label: '聯邦基金目標利率上限',
    unit: '%', freq: 'D', transform: 'level', plausible: [0, 20],
    definition: 'FOMC 設定的聯邦基金目標區間上緣。這是政策利率，不是市場成交利率。',
    note: '日頻但只在 FOMC 決議後變動，兩個月之間通常完全不變。',
  },
  {
    key: 'fedTargetLower', id: 'DFEDTARL', label: '聯邦基金目標利率下限',
    unit: '%', freq: 'D', transform: 'level', plausible: [0, 20],
    definition: 'FOMC 設定的目標區間下緣。與上限共同構成 25 個基點的區間。',
    note: '與上限同時變動；若兩者區間寬度異常（非 25bp），代表資料有問題。',
  },
  {
    key: 'dgs10', id: 'DGS10', label: '10 年期公債殖利率',
    unit: '%', freq: 'D', transform: 'level', plausible: [0, 25],
    definition: '10 年期美國公債的市場殖利率（constant maturity），由財政部每日公布。',
    note: '這是市場價格衍生的利率，不是 Fed 決定的政策利率。假日與週末不更新。',
  },
  {
    key: 'dgs2', id: 'DGS2', label: '2 年期公債殖利率',
    unit: '%', freq: 'D', transform: 'level', plausible: [0, 25],
    definition: '2 年期美國公債的市場殖利率，對政策利率預期最敏感。',
    note: '歷史起點比 10 年期晚（1976 起），做長跨度比較時要注意起點不同。',
  },
  {
    key: 'dgs30', id: 'DGS30', label: '30 年期公債殖利率',
    unit: '%', freq: 'D', transform: 'level', plausible: [0, 25],
    definition: '30 年期美國公債的市場殖利率，反映長期通膨與財政預期。',
    note: '交易活躍度低於 10 年期，單日波動可能較大。',
  },
  {
    key: 'termSpread', id: 'T10Y2Y', label: '10Y-2Y 期限利差',
    unit: '%（百分點）', freq: 'D', transform: 'level', plausible: [-5, 5],
    definition: '10 年期殖利率減 2 年期殖利率。負值稱為「殖利率倒掛」。',
    note: 'FRED 直接提供此序列，與自行相減可能因採樣日不同而有微幅差異。',
  },
  {
    key: 'realYield10', id: 'DFII10', label: '10 年期實質殖利率',
    unit: '%', freq: 'D', transform: 'level', plausible: [-3, 8],
    definition: '10 年期 TIPS（抗通膨公債）殖利率，可視為市場的實質利率預期。',
    note: '2003 年才開始有資料。金融海嘯期間曾為負值。',
  },
  {
    key: 'cpiYoy', id: 'CPIAUCSL', label: 'CPI 年增率',
    unit: '%', freq: 'M', transform: 'yoy', plausible: [-5, 25],
    definition: '消費者物價指數（都市消費者，未季調）的同比變化。本模組自行計算 YoY。',
    note: 'YoY 由原始指數計算，非 FRED 現成序列；需至少 13 個月的歷史點。',
  },
  {
    key: 'coreCpiYoy', id: 'CPILFESL', label: '核心 CPI 年增率',
    unit: '%', freq: 'M', transform: 'yoy', plausible: [-5, 25],
    definition: '剔除食品與能源後的 CPI 同比變化，Fed 更關注的潛在通膨指標。',
    note: '核心 CPI 通常比整體 CPI 平穩，兩者背離時代表能源/食品價格在擾動。',
  },
  {
    key: 'unrate', id: 'UNRATE', label: '失業率',
    unit: '%', freq: 'M', transform: 'level', plausible: [0, 30],
    definition: '失業人口佔勞動力的比例，由美國勞工統計局（BLS）調查得出。',
    note: '落後指標——企業先減少招聘才裁員，失業率往往在衰退中期才明顯上升。',
  },
  {
    key: 'indpro', id: 'INDPRO', label: '工業生產指數',
    unit: '指數（2017=100）', freq: 'M', transform: 'level', plausible: [0, 200],
    definition: '製造業、礦業與公用事業的實體產出水準。',
    note: '這是產出「量」的指標，與 ISM PMI 的擴散指數概念不同，不可互稱。',
  },
  {
    key: 'payems', id: 'PAYEMS', label: '非農就業人數',
    unit: '千人', freq: 'M', transform: 'level', plausible: [10000, 300000],
    definition: '企業調查（establishment survey）的就業人數，不含農業。',
    note: '絕對水準值意義有限，實務看月增減；本模組另提供 momChange。',
  },
  {
    key: 'umcsent', id: 'UMCSENT', label: '密西根大學消費者信心',
    unit: '指數', freq: 'M', transform: 'level', plausible: [0, 150],
    definition: '密西根大學月度調查的消費者信心指數，長期均值約 85。',
    note: '這是調查型軟指標，與實體消費數據可能背離，不宜單獨作為景氣結論。',
  },
  {
    key: 'dollarBroad', id: 'DTWEXBGS', label: '美元廣義指數',
    unit: '指數（2006-01=100）', freq: 'D', transform: 'level', plausible: [50, 200],
    definition: '美元對一籃子主要貿易夥伴貨幣的加權匯率。',
    note: '與 DXY（ICE 美元指數）成分不同、基期不同，數值不可互相比較或替換。',
  },
  {
    key: 'eurusd', id: 'DEXUSEU', label: 'EUR/USD 匯率',
    unit: '美元/歐元', freq: 'D', transform: 'level', plausible: [0.3, 2.5],
    definition: '1 歐元可兌換的美元數。由 Fed H.10 統計發布。',
    note: '數值越大代表美元越弱（同樣 1 歐元換到更多美元）。方向勿搞反。',
  },
  {
    key: 'deficit12m', id: 'MTSDS133FMS', label: '聯邦財政赤字（月度）',
    unit: '百萬美元', freq: 'M', transform: 'level', plausible: [-1500000, 500000],
    definition: '當月聯邦政府收支差額，負值代表赤字（支出大於收入）。',
    note: '單月數字受一次性收支影響極大，本模組另提供 12 個月滾動合計。',
  },
  {
    key: 'gdpReal', id: 'GDPC1', label: '實質 GDP',
    unit: '十億美元（2017 年連鎖）', freq: 'Q', transform: 'level', plausible: [1000, 40000],
    definition: '經通膨調整後的國內生產總值，季頻、年化水準。',
    note: '季頻且會多次修正（初值/修正/最終），最新一季數字通常還會變。',
  },
  {
    key: 'manemp', id: 'MANEMP', label: '製造業就業人數',
    unit: '千人', freq: 'M', transform: 'level', plausible: [5000, 25000],
    definition: '製造業部門的就業人數。常與工業生產一起看製造業景氣。',
    note: '製造業就業長期趨勢向下（自動化），絕對值下滑不必然代表景氣衰退。',
  },
];

const BY_KEY = new Map(SERIES.map((s) => [s.key, s]));
const BY_ID = new Map(SERIES.map((s) => [s.id, s]));

/* ============================================================
   抓取與解析
   ============================================================ */

/**
 * 解析 fredgraph CSV 為點陣列。
 *
 * 關鍵行為：
 *   - 空字串 / 非數值 → 跳過（視為 null，不是 0）
 *   - 回傳依日期升冪排序
 *
 * @param {string} text 原始 CSV
 * @returns {{date:string, value:number}[]}
 */
function parseCsv(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;

  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return out;

  // 第一行必須是表頭，且首欄為 observation_date
  const header = lines[0].split(',');
  if (!/observation_date/i.test(header[0] || '')) return out;

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length < 2) continue;
    const date = (cells[0] || '').trim();
    const raw = (cells[1] || '').trim();
    // 空字串是「當日無觀測值」，不是 0
    if (!date || raw === '') continue;
    const value = Number(raw);
    if (!isFinite(value)) continue;
    out.push({ date, value });
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * 是否為 ZIP（FRED 在 ≥3 序列時會回壓縮檔）。魔術位元組 PK\x03\x04。
 *
 * 回傳嚴格布林：`buf && ...` 在 buf 為 null 時會回傳 null 而不是 false。
 * 雖然放在 if 裡結果一樣，但對外契約是「回答 yes/no」，
 * 讓它可能回傳 null 會在 `=== false` 這類判斷裡埋地雷。
 */
function looksLikeZip(buf) {
  return Boolean(buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05));
}

/**
 * 取單一 FRED 序列。
 *
 * @param {string} seriesId
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:true, id:string, points:{date:string,value:number}[], fetchedAt:string}
 *                 | {ok:false, id:string, code:string, message:string, retryable:boolean}>}
 */
async function fetchSeries(seriesId, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 25000;
  const started = Date.now();
  let lastErr = null;

  // 兩次嘗試：FRED 偶發性 5xx，重試一次即可
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE}?id=${encodeURIComponent(seriesId)}`, {
        headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 404) {
        return {
          ok: false, id: seriesId, code: 'RETIRED', retryable: false,
          message: `FRED 查無序列 ${seriesId}（可能已下線或從未存在）`,
        };
      }
      if (res.status === 429) {
        return {
          ok: false, id: seriesId, code: 'RATE_LIMITED', retryable: true,
          message: 'FRED 請求過於頻繁，請稍候再試',
        };
      }
      if (!res.ok) {
        lastErr = { code: 'UPSTREAM', retryable: true, message: `FRED 回應 HTTP ${res.status}` };
        if (attempt === 0) { await sleep(600); continue; }
        return { ok: false, id: seriesId, ...lastErr };
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (looksLikeZip(buf)) {
        // 明確擋下，不要讓 ZIP 位元組被當成 CSV 解析
        return {
          ok: false, id: seriesId, code: 'ZIP_RESPONSE', retryable: false,
          message: 'FRED 回傳 ZIP 而非 CSV（多序列合併時的行為）；本模組僅支援單序列抓取',
        };
      }

      const points = parseCsv(buf.toString('utf8'));
      if (!points.length) {
        return {
          ok: false, id: seriesId, code: 'EMPTY', retryable: false,
          message: `序列 ${seriesId} 解析後沒有任何有效觀測值`,
        };
      }

      return {
        ok: true, id: seriesId, points,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
      };
    } catch (e) {
      lastErr = { code: 'NETWORK', retryable: true, message: `無法連線至 FRED：${e.message}` };
      if (attempt === 0) await sleep(600);
    }
  }

  return { ok: false, id: seriesId, ...(lastErr || { code: 'UNKNOWN', retryable: true, message: '未知錯誤' }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   衍生計算
   ============================================================ */

/**
 * 計算年增率（YoY）。以「同月份去年」為基期，不是「前 12 筆」。
 *
 * 為什麼要用月份對齊而不是索引位移：月頻序列偶有缺月，
 * 用索引位移會把「去年 11 月」誤當成「去年 10 月」，算出來的 YoY 差一個月。
 *
 * @param {{date:string, value:number}[]} points
 * @returns {{date:string, value:number}[]}
 */
function yoy(points) {
  const out = [];
  if (!Array.isArray(points) || points.length < 13) return out;

  // 以 YYYY-MM 建索引，確保月份對齊
  const byMonth = new Map();
  for (const p of points) byMonth.set(p.date.slice(0, 7), p.value);

  for (const p of points) {
    const ym = p.date.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const prevYm = `${y - 1}-${String(m).padStart(2, '0')}`;
    if (!byMonth.has(prevYm)) continue;
    const prev = byMonth.get(prevYm);
    if (!prev) continue; // 基期為 0 無法算百分比
    out.push({ date: p.date, value: +(((p.value - prev) / prev) * 100).toFixed(4) });
  }
  return out;
}

/** 取最後一個觀測值 */
function lastOf(points) {
  return Array.isArray(points) && points.length ? points[points.length - 1] : null;
}

/**
 * 從歷史點計算相對位置（0–100 百分位），用於「目前處於歷史何處」。
 * 樣本不足 12 點回傳 null，不要用少數點編故事。
 *
 * 注意 `typeof value !== 'number'` 這道檢查不可省：
 * `isFinite(null)` 為 true（null 會被隱式轉成 0），
 * 若不擋，缺值會被算成「歷史第 0 百分位」——畫面上看起來像
 * 「這個指標處於歷史最低」，但其實只是沒資料。
 */
function percentileRank(points, value) {
  if (!Array.isArray(points) || points.length < 12) return null;
  if (typeof value !== 'number' || !isFinite(value)) return null;
  let below = 0;
  for (const p of points) if (p.value < value) below++;
  return +((below / points.length) * 100).toFixed(1);
}

/** N 期前的變化量（月頻＝月增，日頻＝N 交易日前） */
function changeOver(points, n) {
  if (!Array.isArray(points) || points.length <= n) return null;
  const cur = points[points.length - 1].value;
  const prev = points[points.length - 1 - n].value;
  if (!isFinite(cur) || !isFinite(prev)) return null;
  return +(cur - prev).toFixed(4);
}

/* ============================================================
   對外：取得一組序列
   ============================================================ */

/**
 * 抓取單一 key 對應的序列，套用 transform，附上定義與統計。
 *
 * 回傳結構刻意做成「自描述」：前端拿到就知道這是什麼、單位、來源、值域，
 * 不需要另外對照文件。
 */
async function getSeries(key, opts) {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`未註冊的序列 key：${key}`);

  const raw = await fetchSeries(def.id, opts);
  if (!raw.ok) {
    return {
      key: def.key, id: def.id, label: def.label, unit: def.unit, freq: def.freq,
      definition: def.definition, note: def.note,
      source: 'FRED', sourceUrl: `https://fred.stlouisfed.org/series/${def.id}`,
      available: false,
      unavailable: raw.code === 'RETIRED' ? 'retired' : (raw.retryable ? 'transient' : 'blocked'),
      reason: raw.message,
    };
  }

  let points = raw.points;
  if (def.transform === 'yoy') {
    points = yoy(raw.points);
    if (!points.length) {
      return {
        key: def.key, id: def.id, label: def.label, unit: def.unit, freq: def.freq,
        definition: def.definition, note: def.note,
        source: 'FRED', sourceUrl: `https://fred.stlouisfed.org/series/${def.id}`,
        available: false, unavailable: 'transient',
        reason: '歷史點不足 13 個月，無法計算年增率',
      };
    }
  }

  const last = lastOf(points);
  const [lo, hi] = def.plausible;
  const inRange = last.value >= lo && last.value <= hi;

  return {
    key: def.key,
    id: def.id,
    label: def.label,
    unit: def.unit,
    freq: def.freq,
    transform: def.transform,
    definition: def.definition,
    note: def.note,
    source: 'FRED',
    sourceUrl: `https://fred.stlouisfed.org/series/${def.id}`,
    available: true,
    // 合理性檢查：超出登記值域時仍回傳數值，但明確標記，讓上層決定是否採用
    plausible: inRange ? 'ok' : 'out-of-range',
    value: last.value,
    asOf: last.date,
    points: points.length,
    span: { from: points[0].date, to: last.date },
    stats: {
      min: Math.min(...points.map((p) => p.value)),
      max: Math.max(...points.map((p) => p.value)),
      percentile: percentileRank(points, last.value),
      prev: points.length > 1 ? points[points.length - 2].value : null,
      change: changeOver(points, def.freq === 'M' ? 1 : 1),
    },
    fetchedAt: raw.fetchedAt,
  };
}

/** 並行抓取多個序列（各自獨立，單一失敗不影響其他） */
async function getMany(keys, opts) {
  const results = await Promise.all(keys.map((k) => getSeries(k, opts).catch((e) => ({
    key: k, available: false, unavailable: 'transient', reason: e.message,
  }))));
  return results;
}

module.exports = {
  SERIES, BY_KEY, BY_ID,
  parseCsv, looksLikeZip, fetchSeries, getSeries, getMany,
  yoy, lastOf, percentileRank, changeOver,
  CACHE_DIR,
};
