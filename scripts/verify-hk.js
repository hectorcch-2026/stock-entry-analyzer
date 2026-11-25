'use strict';

/**
 * 跨市場驗證：P2 門檻在港股是否同樣成立？
 *
 * 為什麼要單獨一支腳本：
 *   原 P2 驗證（scripts/verify-intervals.js）只跑 20 檔美股。
 *   但實測發現 0700.HK 的 h20 PICP = 74.04%，略低於 75% 門檻。
 *   若不查清楚，會誤把「市場特性」當成「模型適用於全市場」。
 *
 * 港股與美股的關鍵差異：
 *   - 交易時段含午休，日線邊界不同
 *   - 無漲跌停（美股個股有 LULD），極端單日波動較多
 *   - 部分標的流动性低，收盤價跳動大
 *   這些都會讓分位數估計偏窄 → 覆蓋率不足。
 *
 * 用法：node scripts/verify-hk.js
 */

const yahoo = require('../lib/yahoo');
const adjust = require('../lib/adjust');
const anomaly = require('../lib/anomaly');
const forecast = require('../lib/forecast');

const HK = [
  '0700.HK', '0005.HK', '0939.HK', '1299.HK', '0388.HK',
  '2318.HK', '0941.HK', '0001.HK', '0016.HK', '0027.HK',
  '0175.HK', '2020.HK', '1810.HK', '9988.HK', '3690.HK',
];

// 美股對照組（同腳本、同參數，排除方法差異）
const US = ['AAPL', 'KO', 'MSFT', 'JPM', 'WMT'];

const pc = (x) => (x * 100).toFixed(2) + '%';

async function measure(sym) {
  let raw;
  try {
    raw = await yahoo.chartWithAdj(sym, '10y', '1d');
  } catch (e) {
    return { sym, error: e.message };
  }
  const series = adjust.buildAdjustedSeries('yahoo', raw.candles, raw.adjClose);
  if (!adjust.isUsable(series.adj)) return { sym, error: `adj=${series.adj}` };

  const quality = anomaly.inspect(series.candles);
  if (!quality.ok) return { sym, error: quality.reason };

  const bt = forecast.backtestIntervals(series.candles, { lookback: 500, minTraining: 250, minOrigins: 60 });
  const closes = series.candles.map((c) => c.c);
  const trs = [];
  for (let i = 1; i < series.candles.length; i++) {
    const c = series.candles[i];
    const p = series.candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const atr = trs.slice(-14).reduce((s, x) => s + x, 0) / 14;
  const atrPct = (atr / closes[closes.length - 1]) * 100;
  const verdict = forecast.judge(bt, atrPct);

  return {
    sym,
    bars: series.candles.length,
    atrPct: +atrPct.toFixed(2),
    quality: quality.quality,
    pass: verdict.pass,
    h5: bt.horizons[5],
    h10: bt.horizons[10],
    h20: bt.horizons[20],
  };
}

function table(title, rows) {
  console.log(`\n----- ${title} -----`);
  console.log('標的        根數  ATR%   PICP h5   h10    h20    判定');
  for (const r of rows) {
    if (r.error) { console.log(`${r.sym.padEnd(11)} ${r.error}`); continue; }
    const f = (o) => (o && o.status === 'ok' ? pc(o.picp) : '  —  ');
    console.log(
      r.sym.padEnd(11) + String(r.bars).padEnd(6) + String(r.atrPct).padEnd(6) +
      String(f(r.h5)).padEnd(9) + String(f(r.h10)).padEnd(7) + String(f(r.h20)).padEnd(7) +
      (r.pass ? 'PASS' : 'FAIL')
    );
  }
}

(async () => {
  console.log('\n========== 跨市場驗證（港股 vs 美股）==========');
  console.log('門檻同 P2：PICP ∈ [75%,85%] 且 MPIW ≤ 4.0×σ̄×√h\n');

  const hkRows = [];
  for (const s of HK) hkRows.push(await measure(s));
  const usRows = [];
  for (const s of US) usRows.push(await measure(s));

  table('港股', hkRows);
  table('美股（對照組，同方法）', usRows);

  const summarize = (label, rows) => {
    const ok = rows.filter((r) => !r.error);
    if (!ok.length) { console.log(`\n${label}: 無有效資料`); return; }
    const passN = ok.filter((r) => r.pass).length;
    const lines = [];
    for (const h of ['h5', 'h10', 'h20']) {
      const vals = ok.map((r) => r[h]).filter((o) => o && o.status === 'ok').map((o) => o.picp);
      if (!vals.length) continue;
      vals.sort((a, b) => a - b);
      const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
      const below = vals.filter((v) => v < 0.75).length;
      lines.push(`  ${h.padEnd(3)} 平均 ${pc(mean)}  最低 ${pc(vals[0])}  低於75%的標的 ${below}/${vals.length}`);
    }
    console.log(`\n${label}：通過 ${passN}/${ok.length}`);
    lines.forEach((l) => console.log(l));
  };

  console.log('\n========== 彙總 ==========');
  summarize('港股', hkRows);
  summarize('美股', usRows);

  // 診斷：h20 覆蓋不足是否集中在低流動/高波動標的
  const bad = hkRows.filter((r) => !r.error && r.h20 && r.h20.status === 'ok' && r.h20.picp < 0.75);
  if (bad.length) {
    console.log('\n----- h20 PICP < 75% 的港股明細 -----');
    for (const r of bad) {
      console.log(
        `${r.sym.padEnd(11)} PICP ${pc(r.h20.picp)}  MPIW ${pc(r.h20.mpiw)}  ` +
        `σ̄ ${(r.h20.meanSigma * 100).toFixed(2)}%  ATR% ${r.atrPct}  quality ${r.quality}`
      );
    }
    console.log('（MPIW 明顯偏窄 → 分位數未涵蓋厚尾；與 ATR 高波動標的一致）');
  }

  process.exit(0);
})();
