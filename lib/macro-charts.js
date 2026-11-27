'use strict';

/**
 * 宏觀走勢圖：把 fred 的歷史點組成可直接繪圖的圖表定義
 * ======================================================
 *
 * 為什麼「圖表的挑選」要寫在後端而不是前端：
 *   同一張圖上疊多條線的前提是**單位相同且量級相近**。
 *   把「失業率（%）」和「工業生產指數（102.5）」疊在一起，
 *   失業率那條會貼在底線變成一條直線——畫面看起來像「失業率沒變」，
 *   但其實只是被壓扁了。這種錯誤在後端定義一次就不會發生，
 *   若交給前端自由組合，遲早會有人疊錯。
 *
 * 因此本模組明確列出「哪幾條可以疊、用哪個範圍」，並在每次輸出時
 * 附上 unit 與 sharedScale 旗標，讓前端知道這張圖的 y 軸能不能共用。
 */

const fred = require('./fred');

/**
 * 圖表定義。
 *
 * keys 內的多條序列必須共用同一單位（unit），且量級相近，
 * 否則 y 軸共用會讓某條線被壓成直線。
 */
const CHARTS = [
  {
    id: 'rates',
    title: '政策利率與公債殖利率',
    subtitle: '政策利率為階梯狀（只在 FOMC 決議後變動）；公債殖利率為每日市場價格。',
    unit: '%',
    range: '5y',
    sharedScale: true,
    keys: ['fedTargetUpper', 'dgs10', 'dgs2'],
  },
  {
    id: 'spread',
    title: '10Y-2Y 期限利差',
    subtitle: '負值代表殖利率倒掛。歷史上倒掛後 6–24 個月出現衰退，但時滯不固定。',
    unit: '%（百分點）',
    range: '10y',
    sharedScale: true,
    keys: ['termSpread'],
    zeroLine: true,
  },
  {
    id: 'inflation',
    title: '通膨年增率',
    subtitle: '核心 CPI 剔除食品與能源，是 Fed 更關注的潛在通膨指標。',
    unit: '%',
    range: '10y',
    sharedScale: true,
    keys: ['cpiYoy', 'coreCpiYoy'],
  },
  {
    id: 'labor',
    title: '失業率',
    subtitle: '落後指標：景氣轉折後才明顯變化，不宜用來搶先判斷。',
    unit: '%',
    range: '10y',
    sharedScale: true,
    keys: ['unrate'],
  },
  {
    id: 'activity',
    title: '工業生產指數',
    subtitle: '實體產出。與 ISM 製造業 PMI 概念不同（後者為問卷調查擴散指數）。',
    unit: '指數（2017=100）',
    range: '10y',
    sharedScale: true,
    keys: ['indpro'],
  },
  {
    id: 'sentiment',
    title: '消費者信心',
    subtitle: '密西根大學調查。屬軟指標，與硬指標背離時代表預期與實體產出不同步。',
    unit: '指數',
    range: '10y',
    sharedScale: true,
    keys: ['umcsent'],
  },
];

/** 圖表 id 白名單（避免前端傳任意 id 造成無謂的上游請求） */
const CHART_IDS = CHARTS.map((c) => c.id);

const cache = new Map();
const TTL = 6 * 3600 * 1000;

function cacheGet(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(k); return null; }
  return hit.value;
}

/**
 * 取得圖表資料。
 *
 * @param {{ids?:string[], range?:string, maxPoints?:number, force?:boolean}} [opts]
 * @returns {Promise<object>}
 */
async function getCharts(opts) {
  const o = opts || {};
  const force = !!o.force;
  const wantIds = Array.isArray(o.ids) && o.ids.length
    ? o.ids.filter((id) => CHART_IDS.indexOf(id) >= 0)
    : CHART_IDS;

  if (!wantIds.length) {
    return {
      ok: false,
      code: 'BAD_CHART_ID',
      message: `不支援的圖表 id，可用：${CHART_IDS.join('、')}`,
    };
  }

  // 覆寫 range 時，只允許在已定義的清單內（避免任意值造成無謂請求）
  const rangeOverride = o.range && fred.RANGES[o.range] !== undefined ? o.range : null;
  const cacheKey = `charts:${wantIds.join(',')}:${rangeOverride || 'd'}:${o.maxPoints || 0}`;
  if (!force) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }

  const defs = CHARTS.filter((c) => wantIds.indexOf(c.id) >= 0);

  /* 逐圖取各自的 range。
     同一序列在不同圖用不同 range 時（例如 dgs10 在“利率”圖是 5y、
     在別張圖是 10y）會各取一次——但 fred 層有上游備忘，
     不會真的重複下載同一個 CSV，只是重算一次裁切與降採樣。 */
  const charts = await Promise.all(defs.map(async (d) => {
    const useRange = rangeOverride || d.range;
    const series = await fred.getManyWindows(d.keys, {
      range: useRange,
      maxPoints: o.maxPoints || 260,
      force,
    });

    const okSeries = series.filter((s) => s && s.ok);
    const badSeries = series.filter((s) => !s || !s.ok);

    return {
      id: d.id,
      title: d.title,
      subtitle: d.subtitle,
      unit: d.unit,
      range: useRange,
      sharedScale: d.sharedScale !== false,
      zeroLine: !!d.zeroLine,
      series: series.map((s) => (s && s.ok ? {
        key: s.key,
        label: s.label,
        unit: s.unit,
        points: s.points,
        count: s.count,
        total: s.total,
        sampled: s.sampled,
        step: s.step,
        asOf: s.asOf,
        value: s.value,
        from: s.from,
        to: s.to,
        stats: s.stats,
        source: s.source,
        sourceUrl: s.sourceUrl,
        note: s.note,
      } : {
        key: (s && s.key) || 'unknown',
        label: (s && s.label) || '未取得',
        available: false,
        reason: (s && s.reason) || '無法取得序列',
      })),
      available: okSeries.length > 0,
      missing: badSeries.length,
      status: badSeries.length === 0 ? 'ok' : (okSeries.length ? 'degraded' : 'unavailable'),
    };
  }));

  const out = {
    ok: true,
    scope: 'macro-charts',
    generatedAt: new Date().toISOString(),
    charts,
    status: {
      total: charts.length,
      available: charts.filter((c) => c.available).length,
      unavailable: charts.filter((c) => !c.available).length,
      degraded: charts.some((c) => c.status !== 'ok'),
    },
    conventions: [
      '所有折線僅連接實際觀測值，缺值處直接斷線（不以 0 補點，避免畫出假跌破）。',
      '長跨度序列以 LTTB 降採樣，保留轉折處極值；min／max 仍以完整視窗計算。',
      '同圖多線共用 y 軸前，後端已確認單位相同；不同單位的指標不會放在同一張圖。',
      '每張圖的 to 為該序列最後一個有值的日期，不同序列可能不同（週末與假日不更新）。',
    ],
    sources: [
      { name: 'FRED（聖路易斯聯準銀行）', url: 'https://fred.stlouisfed.org', usage: '全部走勢序列', auth: '免 Key（fredgraph CSV）' },
    ],
  };

  cache.set(cacheKey, { value: out, expires: Date.now() + TTL });
  return out;
}

/** 清空（測試用） */
function clearChartCache() { cache.clear(); }

module.exports = {
  getCharts,
  clearChartCache,
  CHARTS,
  CHART_IDS,
};
