'use strict';

/**
 * P2 Go/No-Go 驗證（規格 §5.5.1 路徑 A）
 *
 * 對多檔標的跑 walk-forward 區間回測，輸出 PICP / MPIW，
 * 判定「80% 區間的實際覆蓋率是否落在 75%–85%」。
 *
 * 這是路徑 A 的核心可達性證明：
 *   若 PICP 落在此區間，代表「價格區間」這個宣稱是可信的，
 *   FP 可以上線；若不在，代表連區間估計都不可靠，不應上線。
 *
 * 用法：node scripts/verify-intervals.js [--verbose]
 */

const yahoo = require('../lib/yahoo');
const adjust = require('../lib/adjust');
const anomaly = require('../lib/anomaly');
const forecast = require('../lib/forecast');

const SYMBOLS = [
  'AAPL', 'NVDA', 'MSFT', 'KO', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM',
  'AMD', 'INTC', 'PFE', 'DIS', 'BA', 'WMT', 'CVX', 'NKE', 'ORCL', 'CSCO',
];

const VERBOSE = process.argv.includes('--verbose');

function pct(x) {
  return (x * 100).toFixed(2) + '%';
}

(async () => {
  const rows = [];
  let okCount = 0;

  for (const sym of SYMBOLS) {
    let raw;
    try {
      raw = await yahoo.chartWithAdj(sym, '10y', '1d');
    } catch (e) {
      console.log(`${sym}  取數失敗：${e.message}`);
      continue;
    }

    const series = adjust.buildAdjustedSeries('yahoo', raw.candles, raw.adjClose);
    const quality = anomaly.inspect(series.candles);
    const bt = forecast.backtestIntervals(series.candles, { lookback: 500, minTraining: 250, minOrigins: 60 });

    // ATR% 用於 MPIW 上限縮放
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
    const h = bt.horizons;
    const row = {
      sym,
      bars: series.candles.length,
      adj: series.adj,
      quality: quality.quality,
      outliers: quality.outliers.length,
      gaps: quality.gaps.length,
      atrPct: +atrPct.toFixed(2),
      pass: verdict.pass,
      h5: h[5], h10: h[10], h20: h[20],
    };
    rows.push(row);
    if (verdict.pass) okCount += 1;
  }

  console.log('\n================ P2 Go/No-Go：區間可校準性驗證 ================');
  console.log('路徑 A 雙條件（A-32 / A-33 修訂）：');
  console.log('  (1) PICP ∈ [75%, 85%]        —— 校準性（真門檻）');
  console.log('  (2) MPIW ≤ 4.0 × σ̄ × √h      —— 防退化護欄（不得超過常態理論寬度 1.56 倍）');
  console.log('      σ̄ = 回測期內平均日波動率（與 MPIW 同期，非最後 14 根 ATR）\n');

  console.log('標的    根數  ATR%   q10-q90 覆蓋率(PICP)      MPIW              判定');
  console.log('                   h5     h10    h20      h5      h10     h20');

  for (const r of rows) {
    const f = (o, k) => (o && o.status === 'ok' ? pct(o[k]) : '  —  ');
    console.log(
      r.sym.padEnd(7) +
      String(r.bars).padEnd(6) +
      String(r.atrPct).padEnd(6) +
      String(f(r.h5, 'picp')).padEnd(7) +
      String(f(r.h10, 'picp')).padEnd(7) +
      String(f(r.h20, 'picp')).padEnd(7) +
      String(f(r.h5, 'mpiw')).padEnd(8) +
      String(f(r.h10, 'mpiw')).padEnd(8) +
      String(f(r.h20, 'mpiw')).padEnd(8) +
      (r.pass ? 'PASS' : 'FAIL')
    );
  }

  // 彙總
  const collect = (k, field) => rows.map((r) => r[k]).filter((o) => o && o.status === 'ok').map((o) => o[field]);
  console.log('\n--- 彙總（所有標的的每個週期視為獨立觀測）---');
  for (const hh of ['h5', 'h10', 'h20']) {
    const p = collect(hh, 'picp');
    const w = collect(hh, 'mpiw');
    if (!p.length) { console.log(`${hh}: 無資料`); continue; }
    const mean = p.reduce((s, x) => s + x, 0) / p.length;
    const inRange = p.filter((x) => x >= 0.75 && x <= 0.85).length;
    const meanW = w.reduce((s, x) => s + x, 0) / w.length;
    console.log(
      `${hh.padEnd(4)} PICP 平均 ${pct(mean)}  落在[75,85]% 的標的 ${inRange}/${p.length}` +
      `   MPIW 平均 ${pct(meanW)}   範圍 ${pct(Math.min(...p))}–${pct(Math.max(...p))}`
    );
  }

  // 寬度健全性：MPIW ÷ 常態理論寬度
  console.log('\n--- 寬度健全性（MPIW ÷ 常態理論寬度 2σ̄√h×1.2816；上限對應 1.56）---');
  for (const hh of ['h5', 'h10', 'h20']) {
    const ratios = [];
    for (const r of rows) {
      const o = r[hh];
      if (!o || o.status !== 'ok') continue;
      if (o.meanSigma) ratios.push(o.mpiw / (2 * 1.2816 * o.meanSigma * Math.sqrt(Number(hh.slice(1)))));
    }
    if (!ratios.length) continue;
    ratios.sort((a, b) => a - b);
    const over = ratios.filter((x) => x > 4.0 / (2 * 1.2816)).length;
    console.log(
      `${hh.padEnd(4)} 比值 中位 ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}` +
      `  範圍 ${ratios[0].toFixed(2)}–${ratios[ratios.length - 1].toFixed(2)}` +
      `  超限 ${over}/${ratios.length}`
    );
  }

  console.log(`\n通過全部三週期門檻的標的：${okCount}/${rows.length}`);
  console.log(
    okCount >= Math.ceil(rows.length * 0.8)
      ? '判定：PASS —— 區間宣稱可校準，路徑 A 之 P2 關卡通過'
      : '判定：REVIEW —— 部分標的區間偏寬或偏窄，需檢視分位數設定'
  );

  if (VERBOSE) {
    console.log('\n--- 明細 ---');
    for (const r of rows) {
      console.log(`${r.sym}: adj=${r.adj} quality=${r.quality} outliers=${r.outliers} gaps=${r.gaps}`);
      for (const hh of ['h5', 'h10', 'h20']) {
        const o = r[hh];
        if (o && o.status === 'ok') {
          console.log(`   ${hh}: origins=${o.origins} picp=${pct(o.picp)} mpiw=${pct(o.mpiw)} pinball=${o.pinball}`);
        } else {
          console.log(`   ${hh}: ${o ? o.status : 'n/a'}`);
        }
      }
    }
  }

  process.exit(0);
})();
