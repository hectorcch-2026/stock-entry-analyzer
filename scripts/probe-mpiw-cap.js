'use strict';

/**
 * 診斷：MPIW 上限（規格 §5.5.1 表定 8%/12%/18%）是否可與 PICP 同時達成？
 *
 * 核心問題：
 *   PICP 已被約束在 [75%, 85%]，區間「寬度」就不再是自由參數。
 *   對一組給定的報酬樣本，要覆蓋 80% 的觀測值，寬度有一個下限；
 *   想變窄必然掉覆蓋率。因此若表定上限低於「80% 覆蓋所需的寬度」，
 *   這個門檻在數學上不可滿足 —— 與 A-09 的 Brier 門檻是同一種缺陷。
 *
 * 本腳本量測三個寬度，逐一比較：
 *   1. 實測 MPIW（波動率歸一化分位數，PICP 已達標）
 *   2. 常態理論寬度 2 × 1.2816 × σ_d × √h
 *   3. ATR 換算寬度 1.606 × ATR% × √h（E[單日高低幅] = 1.596σ）
 *
 * 若「實測 / 理論」比值穩定在 1.0–1.5，代表模型沒有浪費寬度，
 * 表定上限才是錯的那一方。
 *
 * 用法：node scripts/probe-mpiw-cap.js
 */

const yahoo = require('../lib/yahoo');
const adjust = require('../lib/adjust');
const forecast = require('../lib/forecast');

const SYMBOLS = [
  'AAPL', 'NVDA', 'MSFT', 'KO', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM',
  'AMD', 'INTC', 'PFE', 'DIS', 'BA', 'WMT', 'CVX', 'NKE', 'ORCL', 'CSCO',
];

const HORIZONS = [5, 10, 20];
const TABLE_CAP = { 5: 0.08, 10: 0.12, 20: 0.18 };

function std(arr) {
  if (arr.length < 2) return null;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

(async () => {
  const rows = [];

  for (const sym of SYMBOLS) {
    let raw;
    try {
      raw = await yahoo.chartWithAdj(sym, '10y', '1d');
    } catch (e) {
      console.log(`${sym} 取數失敗：${e.message}`);
      continue;
    }
    const series = adjust.buildAdjustedSeries('yahoo', raw.candles, raw.adjClose);
    const candles = series.candles;

    // 全期日對數報酬標準差（理論寬度的基準）
    const dr = [];
    for (let i = 1; i < candles.length; i++) {
      const a = candles[i - 1].c;
      const b = candles[i].c;
      if (a > 0 && b > 0) dr.push(Math.log(b / a));
    }
    const sigmaD = std(dr);

    // ATR%（14 日）
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const p = candles[i - 1];
      trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    }
    const atr = trs.slice(-14).reduce((s, x) => s + x, 0) / 14;
    const atrPct = atr / candles[candles.length - 1].c;

    const bt = forecast.backtestIntervals(candles, { lookback: 500, minTraining: 250, minOrigins: 60 });

    const row = { sym, sigmaD, atrPct, h: {} };
    for (const h of HORIZONS) {
      const r = bt.horizons[h];
      if (!r || r.status !== 'ok') { row.h[h] = null; continue; }
      const theory = 2 * 1.2816 * sigmaD * Math.sqrt(h);   // 常態 80% 區間
      const atrBased = 1.606 * atrPct * Math.sqrt(h);        // E[range]=1.596σ
      row.h[h] = {
        mpiw: r.mpiw,
        picp: r.picp,
        theory,
        atrBased,
        ratioTheory: r.mpiw / theory,
        ratioAtr: r.mpiw / atrBased,
        tableCap: TABLE_CAP[h],
        tableFeasible: r.mpiw <= TABLE_CAP[h],
      };
    }
    rows.push(row);
  }

  const pc = (x) => (x * 100).toFixed(2) + '%';

  console.log('\n===== 診斷 1：實測 MPIW vs 常態理論寬度（2×1.2816×σd×√h）=====');
  console.log('若比值 ≈ 1.0–1.5，代表區間沒有浪費寬度，是表定上限設定有問題\n');
  console.log('標的    h   實測MPIW  理論寬度  比值    PICP');
  for (const r of rows) {
    for (const h of HORIZONS) {
      const o = r.h[h];
      if (!o) continue;
      console.log(
        r.sym.padEnd(7) + String(h).padEnd(4) +
        pc(o.mpiw).padEnd(10) + pc(o.theory).padEnd(10) +
        o.ratioTheory.toFixed(2).padEnd(7) + pc(o.picp)
      );
    }
  }

  console.log('\n===== 診斷 2：表定上限的可達性 =====');
  console.log('標的    h   實測MPIW  表定上限   ATR換算寬度  差額(實測-表定)');
  for (const r of rows) {
    for (const h of HORIZONS) {
      const o = r.h[h];
      if (!o) continue;
      console.log(
        r.sym.padEnd(7) + String(h).padEnd(4) +
        pc(o.mpiw).padEnd(10) + pc(o.tableCap).padEnd(10) +
        pc(o.atrBased).padEnd(13) +
        ((o.mpiw - o.tableCap) * 100).toFixed(2).padStart(6) + 'pp  ' +
        (o.tableFeasible ? 'OK' : '✗')
      );
    }
  }

  console.log('\n===== 彙總 =====');
  for (const h of HORIZONS) {
    const vals = rows.map((r) => r.h[h]).filter(Boolean);
    if (!vals.length) continue;
    const rt = vals.map((o) => o.ratioTheory).sort((a, b) => a - b);
    const ra = vals.map((o) => o.ratioAtr).sort((a, b) => a - b);
    const mw = vals.map((o) => o.mpiw).sort((a, b) => a - b);
    const feas = vals.filter((o) => o.tableFeasible).length;
    const med = (a) => a[Math.floor(a.length / 2)];
    console.log(
      `h${String(h).padEnd(3)} 實測MPIW 中位 ${pc(med(mw))}  範圍 ${pc(mw[0])}–${pc(mw[mw.length - 1])}  |  ` +
      `÷理論 中位 ${med(rt).toFixed(2)} (${rt[0].toFixed(2)}–${rt[rt.length - 1].toFixed(2)})  |  ` +
      `÷ATR 中位 ${med(ra).toFixed(2)} (${ra[0].toFixed(2)}–${ra[ra.length - 1].toFixed(2)})  |  ` +
      `表定上限可達 ${feas}/${vals.length}`
    );
  }

  // 若以 ATR 相對倍數定義上限，需要多大的倍數才能容納實測？
  console.log('\n----- 若改用 ATR 相對上限：需要幾倍？(取最大值，即最寬鬆的必要倍數) -----');
  for (const h of HORIZONS) {
    const vals = rows.map((r) => r.h[h]).filter(Boolean);
    if (!vals.length) continue;
    const ra = vals.map((o) => o.ratioAtr).sort((a, b) => a - b);
    console.log(
      `h${String(h).padEnd(3)} ÷ATR 中位 ${ra[Math.floor(ra.length / 2)].toFixed(2)}  ` +
      `P90 ${ra[Math.floor(ra.length * 0.9)].toFixed(2)}  最大 ${ra[ra.length - 1].toFixed(2)}`
    );
  }

  process.exit(0);
})();
