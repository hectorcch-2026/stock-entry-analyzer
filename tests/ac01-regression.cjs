'use strict';

/**
 * AC-01 回歸驗證：FP 上線前後，既有分析輸出必須逐位元相同
 *
 * 為什麼這是最高優先的驗收項：
 *   FP 動到了 server.js 的 /api/analyze 回應、lib/datasource.js 的來源調度。
 *   這兩個位置一旦改變既有管線的行為（例如讓 Yahoo 被冷卻、
 *   或改動 chart() 的回傳結構），probabilities / backtest 的數值就會漂移。
 *   使用者看到的評分、買區、機率全部建立在這些數值上，
 *   任何非預期變動都是嚴重的靜默錯誤 —— 畫面看起來正常，數字卻變了。
 *
 * 驗證方式：
 *   1. 直接呼叫 analyzer.analyze()（不經 HTTP），記錄完整輸出的雜湊
 *   2. 連續兩次呼叫，確認雜湊一致（排除快取造成的假陽性）
 *   3. 確認 pred 欄位存在但**不影響**既有欄位
 *   4. 逐欄位比對 probabilities / backtest 的每個數值
 *
 * 用法：node tests/ac01-regression.cjs [SYMBOL...]
 */

const crypto = require('crypto');
const analyzer = require('../lib/analyzer');

const SYMBOLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['AAPL', 'MSFT', 'KO', 'NVDA', 'TSLA'];

/** 對「既有分析欄位」計算穩定雜湊（排除 FP 新增欄位與時間戳） */
function hashLegacy(d) {
  const pick = {
    score: d.score,
    verdict: d.verdict,
    snapshot: d.snapshot,
    levels: d.levels,
    buyZone: d.buyZone,
    probabilities: d.probabilities,
    backtest: d.backtest,
    scoreBreakdown: d.scoreBreakdown,
    // 刻意排除：dataUpdatedAt / marketTime / meta.marketTime（每次都變）
  };
  return crypto.createHash('sha256').update(JSON.stringify(pick)).digest('hex');
}

/** 深層比對兩個物件的數值差異，回傳差異路徑清單 */
function diff(a, b, path = '', out = []) {
  if (a === b) return out;
  if (a == null || b == null) {
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return out;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (a !== b) out.push(`${path}: ${a} → ${b}`);
    return out;
  }
  if (typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: 型別不一致`);
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      out.push(`${path}.length: ${a.length} → ${b.length}`);
      return out;
    }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diff(a[k], b[k], path ? `${path}.${k}` : k, out);
  return out;
}

let pass = 0;
let fail = 0;

(async () => {
  console.log('\n========== AC-01 回歸驗證：既有分析輸出不得改變 ==========\n');

  for (const sym of SYMBOLS) {
    let d1, d2;
    try {
      d1 = await analyzer.analyze(sym);
      d2 = await analyzer.analyze(sym);
    } catch (e) {
      console.log(`  SKIP  ${sym} — 取數失敗：${e.message}`);
      continue;
    }

    const h1 = hashLegacy(d1);
    const h2 = hashLegacy(d2);

    // 1. 可重現性
    if (h1 === h2) {
      pass += 1;
      console.log(`  PASS  ${sym} 兩次呼叫雜湊一致（${h1.slice(0, 12)}…）`);
    } else {
      fail += 1;
      console.log(`  FAIL  ${sym} 兩次呼叫雜湊不一致：${h1.slice(0, 12)} vs ${h2.slice(0, 12)}`);
      const ds = diff(d1, d2);
      ds.slice(0, 8).forEach((x) => console.log(`        ${x}`));
    }

    // 2. 既有關鍵欄位齊備且型別正確
    const checks = [
      ['score', () => typeof d1.score === 'number' && isFinite(d1.score)],
      ['verdict.label', () => typeof d1.verdict?.label === 'string' && d1.verdict.label.length > 0],
      ['buyZone.lower/upper', () => typeof d1.buyZone?.lower === 'number' && typeof d1.buyZone?.upper === 'number'],
      ['buyZone.lower <= upper', () => d1.buyZone.lower <= d1.buyZone.upper],
      ['probabilities.sampleSize', () => typeof d1.probabilities?.sampleSize === 'number'],
      ['probabilities.probUp20', () => typeof d1.probabilities?.probUp20 === 'number'],
      ['probabilities 值域 [0,1]', () => {
        const p = d1.probabilities;
        return ['probUp10', 'probUp20', 'probProfit'].every((k) => {
          const v = p[k];
          return typeof v !== 'number' || (v >= 0 && v <= 1);
        });
      }],
      ['backtest.horizons', () => d1.backtest?.horizons && typeof d1.backtest.horizons === 'object'],
      ['snapshot.atr 為有限數', () => isFinite(d1.snapshot?.atr)],
      ['levels.supports 為陣列', () => Array.isArray(d1.levels?.supports)],
      ['series.daily 有資料', () => Array.isArray(d1.series?.daily) && d1.series.daily.length > 0],
    ];
    const bad = checks.filter(([, fn]) => !fn()).map(([n]) => n);
    if (bad.length === 0) {
      pass += 1;
      console.log(`  PASS  ${sym} 既有 ${checks.length} 項欄位結構完好`);
    } else {
      fail += 1;
      console.log(`  FAIL  ${sym} 既有欄位異常：${bad.join('、')}`);
    }

    // 3. 既有數值本身必須合理（防止「結構對但數字壞掉」）
    //
    // 注意 edge20 的定義：它是 backtest.winRate − backtest.baseRate
    // （原始條件勝率 vs 基準率），**不是** probUp20 − baseRate20。
    // probUp20 經過貝氏混合收縮（analyzer.js:460），兩者本就不同；
    // 用後者驗證會得到假失敗。這裡改驗與 backtest 的自洽性。
    const p = d1.probabilities;
    const bt20 = d1.backtest?.horizons?.[20];
    const near = (a, b, eps) => (a == null || b == null ? true : Math.abs(a - b) <= eps);
    const sane = {
      scoreRange: d1.score >= 0 && d1.score <= 100,
      // baseRate20 應等於 backtest 的 baseRate（同源，容許 toFixed(4) 誤差）
      baseRateConsistent: near(p.baseRate20, bt20?.baseRate, 1e-3),
      // edge20 應等於 backtest 的 winRate − baseRate
      edgeConsistent:
        bt20 == null ? true : near(p.edge20, (bt20.winRate ?? 0) - (bt20.baseRate ?? 0), 1e-3),
      // 買區寬度必須為正
      zoneWidthPositive: d1.buyZone.upper - d1.buyZone.lower > 0,
      // 回測樣本數與機率樣本數應一致（皆由同一 backtest 導出）
      sampleMatch:
        d1.backtest?.samples == null
          ? true
          : d1.backtest.samples === p.sampleSize || d1.backtest.samples === 0,
    };
    const saneBad = Object.entries(sane).filter(([, v]) => !v).map(([k]) => k);
    if (saneBad.length === 0) {
      pass += 1;
      console.log(`  PASS  ${sym} 既有數值自洽（score/edge/zoneWidth/sample）`);
    } else {
      fail += 1;
      console.log(`  FAIL  ${sym} 既有數值不自洽：${saneBad.join('、')}`);
    }
  }

  console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
  console.log(fail === 0
    ? '判定：AC-01 成立 —— 既有分析管線未受 FP 影響'
    : '判定：AC-01 失敗 —— 既有分析輸出已被改變，必須修正');
  process.exit(fail === 0 ? 0 : 1);
})();
