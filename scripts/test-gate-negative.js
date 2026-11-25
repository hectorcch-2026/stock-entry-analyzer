'use strict';

/**
 * 反向測試：judge() 的防退化護欄是否真的能攔下退化模型？
 *
 * 一個只會說「過」的門檻等於沒有門檻。本腳本偽造三種退化輸出，
 * 確認每一種都會被 judge() 判為不通過：
 *   1. 灌寬區間（±50%）：PICP 衝高但寬度爆表
 *   2. 縮窄區間（±2%）：寬度漂亮但 PICP 崩到 50% 以下
 *   3. 對所有標的吐同一個絕對寬度（與波動率脫鉤）
 *
 * 用法：node scripts/test-gate-negative.js
 */

const forecast = require('../lib/forecast');

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`);
  }
}

// 一份「正常」的回測結果：σ̄ = 2%，PICP 79%，寬度符合
function normalBT(over) {
  const o = over || {};
  return {
    status: 'ok',
    horizons: {
      5: { status: 'ok', origins: 2000, picp: 0.79, mpiw: 0.115, meanSigma: 0.02, pinball: 0.01, ...(o[5] || {}) },
      10: { status: 'ok', origins: 2000, picp: 0.785, mpiw: 0.162, meanSigma: 0.02, pinball: 0.01, ...(o[10] || {}) },
      20: { status: 'ok', origins: 2000, picp: 0.77, mpiw: 0.229, meanSigma: 0.02, pinball: 0.01, ...(o[20] || {}) },
    },
  };
}

console.log('\n===== judge() 反向測試 =====');

// 0. 正常模型必須通過（否則後面的測試沒有意義）
const base = forecast.judge(normalBT(), 3.2);
check('正常模型（PICP 79%，寬度 1.0–1.3 倍理論）判定 PASS', base.pass === true);

// 1. 灌寬區間：PICP 99%，寬度 ±50%
const wide = forecast.judge(normalBT({
  5: { picp: 0.99, mpiw: 1.00 },
  10: { picp: 0.99, mpiw: 1.00 },
  20: { picp: 0.99, mpiw: 1.00 },
}), 3.2);
check('灌寬模型（PICP 99%，±50%）被拒', wide.pass === false);
check('  → 由 PICP 上界攔下（99% > 85%）', wide.detail[5].picpOk === false);
check('  → 且寬度護欄同時觸發', wide.detail[5].mpiwOk === false);

// 2. 縮窄區間：PICP 45%，寬度很窄
const narrow = forecast.judge(normalBT({
  5: { picp: 0.45, mpiw: 0.03 },
  10: { picp: 0.44, mpiw: 0.04 },
  20: { picp: 0.46, mpiw: 0.06 },
}), 3.2);
check('縮窄模型（PICP 45%）被拒', narrow.pass === false);
check('  → 由 PICP 下界攔下（45% < 75%）', narrow.detail[5].picpOk === false);
check('  → 寬度雖然合格，仍不足以放行', narrow.detail[5].mpiwOk === true);

// 3. 寬度與波動率脫鉤：對低波動股吐固定 ±40%
//    σ̄=0.5%（低波動），寬度 40% → 理論寬度 h5 = 2×1.2816×0.005×2.236 = 2.87%，比值 13.9 倍
const decoupled = {
  status: 'ok',
  horizons: {
    5: { status: 'ok', origins: 2000, picp: 0.80, mpiw: 0.40, meanSigma: 0.005, pinball: 0.01 },
    10: { status: 'ok', origins: 2000, picp: 0.80, mpiw: 0.40, meanSigma: 0.005, pinball: 0.01 },
    20: { status: 'ok', origins: 2000, picp: 0.80, mpiw: 0.40, meanSigma: 0.005, pinball: 0.01 },
  },
};
const dc = forecast.judge(decoupled, 0.8);
check('寬度脫鉤模型（低波動股吐 ±40%，PICP 80%）被拒', dc.pass === false);
check('  → PICP 合格但寬度護欄攔下', dc.detail[5].picpOk === true && dc.detail[5].mpiwOk === false);
check(`  → 寬度為理論的 ${dc.detail[5].widthRatio} 倍（>1.56 上限）`, dc.detail[5].widthRatio > 1.56);

// 4. 缺週期 → 不通過
const missing = normalBT();
delete missing.horizons[20];
check('缺少 h20 的結果被拒', forecast.judge(missing, 3.2).pass === false);

// 5. status 非 ok → 不通過
const badStatus = normalBT({ 10: { status: 'insufficient' } });
check('h10 status=insufficient 被拒', forecast.judge(badStatus, 3.2).pass === false);

// 6. 無波動率資訊 → 不得因「無法判斷」而放行
const noSigma = normalBT({ 5: { meanSigma: null }, 10: { meanSigma: null }, 20: { meanSigma: null } });
check('波動率全缺且無 ATR 備援時被拒（不得靜默放行）', forecast.judge(noSigma, null).pass === false);

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
console.log(fail === 0 ? '判定：PASS —— 門檻具備鑑別力，非空殼' : '判定：FAIL —— 門檻無法攔下退化模型');
process.exit(fail === 0 ? 0 : 1);
