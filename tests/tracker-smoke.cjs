'use strict';

/**
 * 真實資料煙霧測試 — 用真的上游跑一次完整流程
 * ============================================
 *
 * 單元測試用的是假 K 線，能證明「邏輯對」，但不能證明
 * 「接上真實資料也能跑」。兩者失敗的方式完全不同：
 *   · 邏輯錯 → 數字算錯，但程式不會報錯
 *   · 接線錯 → 欄位抓不到、型別不符，往往直接拋錯或算出 NaN
 *
 * 這支測試用 data/picks 裡的真實清單 + Yahoo 真實日線跑一次，
 * 檢查的是「有沒有合理的數字」，不是「數字等於多少」——
 * 後者每天都會變，寫死就變成天天要改的測試。
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const T = require('../lib/picks-tracker');
const job = require('../lib/tracker-job');
const datasource = require('../lib/datasource');
const scheduler = require('../lib/scheduler');

let pass = 0;
let fail = 0;

async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

console.log('\n=== 真實資料煙霧測試 ===\n');

const TMP = path.join(__dirname, '..', '.tmpv', 'smoke');
const LEDGER = path.join(TMP, 'ledger.json');
const JOB_STATE = path.join(TMP, 'job-state.json');

/**
 * 清掉上一輪的產出。
 *
 * 這裡刻意「整目錄砍掉重建」，而不是逐一刪除已知檔名。
 * 原本只刪 LEDGER / JOB_STATE 兩個檔，但後面的測試另外用了
 * `ledger-job.json`、`ledger-thr.json`、`ledger-gap.json`——
 * 那些檔沒被清到，於是 `processedPickDates` 帶著上一輪的日期進來，
 * `dailyRun` 第一次執行就認為「今天已經處理過」，收錄 0 筆。
 *
 * 症狀是「第一次跑很順、第二次跑就掛」，而且只有在同一台機器
 * 連跑兩次才會出現——最容易被誤判成程式不穩、或直接說「重跑就好」。
 * 逐一列舉檔名的清法天生會隨測試增加而漏，因此改成整目錄重來。
 */
function fresh() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(TMP, { recursive: true });
}

(async () => {
  fresh();

  /* --- 用真實的 data/picks 清單建立記錄 --- */
  const picksDir = path.join(__dirname, '..', 'data', 'picks');
  const dates = job.listPickDates(picksDir);
  console.log(`  可用清單日期：${dates.join('、') || '（無）'}\n`);

  const tracker = T.create({ filePath: LEDGER, datasource, capitalUsd: 10000 });
  tracker.load();

  await ok('能從真實清單建立推介記錄', () => {
    assert.ok(dates.length > 0, 'data/picks 至少要有 1 份清單');
    const payload = JSON.parse(fs.readFileSync(path.join(picksDir, `${dates[0]}.json`), 'utf8'));
    const out = tracker.addPicks(payload.rows, { pickDate: dates[0], limit: 5, minScore: 0 });
    assert.ok(out.inserted.length > 0, `應建立至少 1 筆，實際 ${out.inserted.length}`);
    console.log(`      建立 ${out.inserted.length} 筆：${out.inserted.map((r) => r.symbol).join('、')}`);
    // 每一筆的價格欄位都必須是正數
    for (const r of out.inserted) {
      assert.ok(r.buyLow > 0 && r.buyHigh > 0 && r.stopPrice > 0 && r.targetPrice > 0,
        `${r.symbol} 價格欄位不完整`);
      assert.ok(r.stopPrice < r.buyLow && r.buyHigh < r.targetPrice,
        `${r.symbol} 價格順序不對`);
    }
  });

  await ok('真實清單的幣別分佈正確（美股 USD、港股 HKD）', () => {
    for (const r of tracker.records) {
      if (r.market === 'HK') assert.strictEqual(r.currency, 'HKD', `${r.symbol} 應為 HKD`);
      else assert.strictEqual(r.currency, 'USD', `${r.symbol} 應為 USD`);
    }
  });

  /* --- 用真實日線更新 --- */
  let updateResult = null;
  await ok('用真實 Yahoo 日線跑 update() 不拋錯', async () => {
    updateResult = await tracker.update({ concurrency: 3 });
    assert.ok(updateResult.checked > 0, '應有記錄被檢查');
    console.log(`      檢查 ${updateResult.checked} 筆，狀態變更 ${updateResult.changed} 筆，失敗 ${updateResult.failed} 筆`);
    if (updateResult.fx) {
      console.log(`      匯率：${JSON.stringify(updateResult.fx)}`);
    }
  });

  await ok('每筆記錄的狀態都是合法的四種之一', () => {
    for (const r of tracker.records) {
      assert.ok(T.STATUS_ORDER.includes(r.status),
        `${r.symbol} 狀態「${r.status}」不合法`);
    }
    const dist = {};
    for (const r of tracker.records) dist[r.status] = (dist[r.status] || 0) + 1;
    console.log(`      狀態分佈：${JSON.stringify(dist)}`);
  });

  await ok('已建倉的記錄，股數與損益都是合理數字（非 NaN / 非 null）', () => {
    const held = tracker.records.filter((r) => r.entry);
    if (!held.length) {
      // 清單日期很新（例如今天是清單隔天）時，價格可能還沒回到買區，
      // 全部維持待買入是**正確**結果，不是失敗。
      // 真正該釘住的是「待買入的記錄不得有 entry / pnl」——那才是邏輯錯誤。
      for (const r of tracker.records) {
        assert.strictEqual(r.status, 'pending', `${r.symbol} 未建倉卻不是 pending`);
        assert.strictEqual(r.entry, null, `${r.symbol} 待買入卻已有 entry`);
        assert.strictEqual(r.pnl, null, `${r.symbol} 待買入卻已有損益`);
      }
      console.log(`      （全部 ${tracker.records.length} 筆仍在待買入，價格尚未回到買區——屬正常）`);
      return;
    }
    for (const r of held) {
      assert.ok(isFinite(r.entry.shares) && r.entry.shares > 0, `${r.symbol} 股數無效`);
      assert.ok(isFinite(r.entry.price) && r.entry.price > 0, `${r.symbol} 成交價無效`);
      assert.ok(isFinite(r.entry.fxRate) && r.entry.fxRate > 0, `${r.symbol} 匯率無效`);
      // 港股匯率應接近 7.8，美股應為 1
      if (r.currency === 'HKD') {
        assert.ok(r.entry.fxRate > 7 && r.entry.fxRate < 9,
          `${r.symbol} 港元匯率 ${r.entry.fxRate} 不合理`);
      } else {
        assert.strictEqual(r.entry.fxRate, 1, `${r.symbol} 美元匯率應為 1`);
      }
      // 成本必須接近 10,000 美元（碎股取整會有極小誤差）
      assert.ok(Math.abs(r.entry.costUsd - 10000) < 1,
        `${r.symbol} 成本 ${r.entry.costUsd} 應約為 10000`);
      if (r.pnl) {
        assert.ok(isFinite(r.pnl.amountUsd), `${r.symbol} 損益為 NaN`);
        assert.ok(isFinite(r.pnl.returnPct), `${r.symbol} 報酬率為 NaN`);
      }
    }
    console.log(`      已建倉 ${held.length} 筆，`
      + `股數範圍 ${Math.min(...held.map((r) => r.entry.shares)).toFixed(2)}–${Math.max(...held.map((r) => r.entry.shares)).toFixed(2)}`);
  });

  await ok('港股損益有折算，沒有被匯率放大', () => {
    const hk = tracker.records.filter((r) => r.currency === 'HKD' && r.pnl);
    if (!hk.length) { console.log('      （本次無港股記錄，略過）'); return; }
    for (const r of hk) {
      // 回報率不該因為匯率而偏離價格報酬太多（正常在 ±15% 以內）
      const diff = Math.abs(r.pnl.returnPct - r.pnl.priceReturnPct);
      assert.ok(diff < 15,
        `${r.symbol} 美元報酬 ${r.pnl.returnPct}% 與價格報酬 ${r.pnl.priceReturnPct}% 差距過大（${diff.toFixed(2)}%），匯率可能沒折算`);
    }
    console.log(`      港股 ${hk.length} 筆，美元與價格報酬差距均在合理範圍`);
  });

  await ok('摘要數字自洽：已實現 + 未實現 = 總計', () => {
    const s = tracker.summary();
    const sum = Math.round((s.realizedPnlUsd + s.unrealizedPnlUsd) * 100) / 100;
    assert.strictEqual(sum, s.totalPnlUsd,
      `已實現 ${s.realizedPnlUsd} + 未實現 ${s.unrealizedPnlUsd} 應等於 ${s.totalPnlUsd}`);
    assert.strictEqual(s.counts.total, tracker.records.length);
    assert.strictEqual(s.counts.closed + s.counts.open, s.counts.total);
    console.log(`      總計 ${s.totalPnlUsd} USD（已實現 ${s.realizedPnlUsd} / 未實現 ${s.unrealizedPnlUsd}）`);
    if (s.realizedReturnPct != null) {
      console.log(`      累計報酬率 ${s.realizedReturnPct}%（分母＝已投入 ${s.deployedUsd} USD）`);
    }
  });

  /* --- 持久化往返 --- */
  await ok('存檔後重新載入，所有數字完全一致', () => {
    tracker.save();
    const before = tracker.summary();
    const t2 = T.create({ filePath: LEDGER, datasource });
    const l = t2.load();
    assert.strictEqual(l.loaded, true);
    assert.strictEqual(t2.records.length, tracker.records.length);
    assert.deepStrictEqual(t2.summary(), before, '重新載入後摘要不一致');
  });

  await ok('重跑 update 不會改變已結案記錄的損益', async () => {
    const closedBefore = tracker.records
      .filter((r) => r.settled)
      .map((r) => ({ id: r.id, pnl: r.pnl.amountUsd, status: r.status }));
    if (!closedBefore.length) { console.log('      （本次無結案記錄，略過）'); return; }
    await tracker.update({ concurrency: 3 });
    const closedAfter = tracker.records
      .filter((r) => r.settled)
      .map((r) => ({ id: r.id, pnl: r.pnl.amountUsd, status: r.status }));
    assert.deepStrictEqual(closedAfter, closedBefore, '已結案記錄的損益被重算改動了');
    console.log(`      ${closedBefore.length} 筆結案記錄損益未變`);
  });

  /* --- 任務層冪等性（用假的 scheduler，不打真實上游） --- */
  await ok('dailyRun 重複執行不會重複收錄', async () => {
    fresh();
    const t = T.create({ filePath: path.join(TMP, 'ledger-job.json'), datasource, capitalUsd: 10000 });
    t.load();
    const j = job.createJob(
      { tracker: t, scheduler: null, screenDeps: null, runner: null },
      { picksDir, stateFile: JOB_STATE, throttleMs: 0, backfillDays: 3 }
    );
    const r1 = await j.dailyRun({ force: true });
    const r2 = await j.dailyRun({ force: true });
    assert.ok(r1.added > 0, `第一次應收錄記錄，實際 ${r1.added}`);
    assert.strictEqual(r2.added, 0, `第二次不得再新增，實際 ${r2.added}`);
    assert.strictEqual(t.records.length, r1.added, '記錄總數應等於第一次收錄數');
    console.log(`      第一次收錄 ${r1.added} 筆，第二次 ${r2.added} 筆（正確）`);
  });

  await ok('dailyRun 會標記已處理日期，避免每天重試', () => {
    const t = T.create({ filePath: path.join(TMP, 'ledger-job.json'), datasource });
    t.load();
    assert.ok(t.state.processedPickDates.length > 0, '應有已處理日期');
    console.log(`      已處理日期：${t.state.processedPickDates.join('、')}`);
  });

  await ok('節流機制會擋下短時間內的重複執行', async () => {
    const t2 = T.create({ filePath: path.join(TMP, 'ledger-thr.json'), datasource, capitalUsd: 10000 });
    t2.load();
    const j2 = job.createJob(
      { tracker: t2, scheduler: null, screenDeps: null, runner: null },
      { picksDir, stateFile: path.join(TMP, 'job-thr.json'), throttleMs: 30 * 60 * 1000, backfillDays: 1 }
    );
    const a = await j2.dailyRun({ force: true });
    const b = await j2.dailyRun({});          // 非強制
    assert.strictEqual(a.ran, true);
    assert.strictEqual(b.ran, false, `應被節流擋下，實際 ran=${b.ran}`);
    assert.ok(/節流/.test(b.reason), `原因應說明節流，實際「${b.reason}」`);
    console.log(`      第二次被擋：${b.reason}`);
  });

  /* --- 真實的 scheduler 整合（只讀，不觸發篩選） --- */
  await ok('scheduler 的最近結算日可作為推介日', () => {
    const cutoff = scheduler.lastSettledCutoff();
    const key = scheduler.dateKey(cutoff);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(key), `日期格式不對：${key}`);
    assert.ok(scheduler.isTradingDay(cutoff), `${key} 應為交易日`);
    console.log(`      最近結算日：${key}（${cutoff.toISOString()}）`);
  });

  /* --- 用真實 K 線強制走一次「觸價建倉 → 出場」的完整路徑 ---
   *
   * 為什麼要這樣做：
   *   上面幾項若全部停在「待買入」，代表最關鍵的兩段程式（建倉、出場）
   *   在真實資料上一次都沒被執行過。假 K 線能驗證邏輯，但驗不了
   *   「真實 K 線的欄位與型別接不接受」——那是完全不同的失敗模式。
   *   因此這裡刻意把買區放寬到必然觸價、止賺收窄到必然到達，
   *   用**真實的**開高低收去跑，驗算出來的股數與損益是否合理。
   */
  await ok('真實資料下價格順序不合理仍會被擋下', async () => {
    const t = T.create({ filePath: null, datasource, capitalUsd: 10000 });
    // 止蝕設得比買區還高 —— 這是不可能成立的組合（先停損才買進？）
    const r = t.addPick({
      symbol: 'ZS', name: 'Zscaler', market: 'US', currency: 'USD',
      price: 231.62, score: 87, verdict: { level: 'buy' },
      zoneLower: 206.06, zoneUpper: 214.39, zoneStop: 220, zoneTarget: 260,
    }, { pickDate: '2026-11-24' });
    assert.strictEqual(r.action, 'invalid', `應被擋下，實際 ${r.action}`);
    assert.strictEqual(t.records.length, 0);
  });

  await ok('真實 K 線：正常區間觸價建倉並算出合理股數', async () => {
    const t = T.create({ filePath: null, datasource, capitalUsd: 10000 });
    // 取 ZS 真實買區（206.06–214.39），把上沿放寬到 216 讓 11-25 的低點 214.54 觸價
    const rec = t.addPick({
      symbol: 'ZS', name: 'Zscaler, Inc.', market: 'US', currency: 'USD',
      price: 231.62, score: 87, verdict: { level: 'buy' },
      zoneLower: 206.06, zoneUpper: 216, zoneStop: 190, zoneTarget: 260,
    }, { pickDate: '2026-11-24' });
    assert.strictEqual(rec.action, 'inserted');

    const out = await t.update({ concurrency: 1 });
    const r = rec.record;

    if (r.status === 'pending') {
      // 若上游此刻的 K 線已不含 2026-11-25（資料回滾），不能算失敗
      console.log('      （上游無 11-25 之後的日線，本次未觸價——略過）');
      return;
    }

    assert.strictEqual(r.status, 'holding', `應已建倉，實際 ${r.status}`);
    assert.ok(r.entry.price > 200 && r.entry.price <= 216,
      `成交價 ${r.entry.price} 應落在買區上沿 216 以內`);
    assert.ok(isFinite(r.entry.shares) && r.entry.shares > 0);
    // 股數 × 成交價 必須約等於本金
    const notional = r.entry.shares * r.entry.price;
    assert.ok(Math.abs(notional - 10000) < 1,
      `股數 × 價格 = ${notional.toFixed(2)}，應約為 10000`);
    assert.ok(Math.abs(r.entry.costUsd - 10000) < 1);
    console.log(`      以 ${r.entry.price} 成交 ${r.entry.shares} 股，`
      + `名目 ${notional.toFixed(2)} USD（${r.entry.date}）`);
  });

  await ok('真實 K 線：建倉當天不判出場（資料只到建倉日時停在持倉中）', async () => {
    const t = T.create({ filePath: null, datasource, capitalUsd: 10000 });
    // 止賺設在 217，遠低於 11-25 的高點 232.12。若允許建倉當天判出場，
    // 這筆會立刻變成「已止賺」——但那是不對的：日線分不清
    // 「先漲到 232 再跌回買區」還是「先跌進買區再漲到 232」。
    const rec = t.addPick({
      symbol: 'ZS', name: 'Zscaler, Inc.', market: 'US', currency: 'USD',
      price: 231.62, score: 87, verdict: { level: 'buy' },
      zoneLower: 206.06, zoneUpper: 216, zoneStop: 190, zoneTarget: 217,
    }, { pickDate: '2026-11-24' });

    await t.update({ concurrency: 1 });
    const r = rec.record;

    if (r.status === 'pending') {
      console.log('      （上游無 11-25 之後的日線，未觸價——略過）');
      return;
    }
    assert.strictEqual(r.status, 'holding',
      `建倉當天不應結案，實際 ${r.status}（若為 target_hit 表示建倉當天就判了出場）`);
    assert.strictEqual(r.settled, false, '尚未結案');
    // 即使當天 high 已遠超止賺價，也不得出場
    assert.strictEqual(r.exit, null, '建倉當天不得有出場記錄');
    console.log(`      建倉於 ${r.entry.date}（${r.entry.price}），`
      + `當天高點已超止賺 217 但仍停在持倉中——正確`);
  });

  await ok('真實 K 線：建倉後有次一交易日時，止賺能正確結案', async () => {
    const t = T.create({ filePath: null, datasource, capitalUsd: 10000 });
    // 把推介日往前推一週，讓 11-25 之後還有交易日可判定
    const rec = t.addPick({
      symbol: 'ZS', name: 'Zscaler, Inc.', market: 'US', currency: 'USD',
      price: 231.62, score: 87, verdict: { level: 'buy' },
      zoneLower: 206.06, zoneUpper: 216, zoneStop: 190, zoneTarget: 217,
    }, { pickDate: '2026-11-19' });

    await t.update({ concurrency: 1 });
    const r = rec.record;

    if (r.status === 'pending') {
      console.log('      （未觸價——略過）');
      return;
    }
    // 11-20 那根：o=202.73 h=206.20 l=193.13 → 開盤即低於買區上沿 216，
    // 應以 202.73 成交；同日 high 206.20 < 217 不觸止賺
    // 11-23 那根：o=238.01 h=247.90 → 跳空高開，應以 238.01 成交止賺
    assert.strictEqual(r.status, 'target_hit', `應已止賺，實際 ${r.status}`);
    assert.strictEqual(r.settled, true);
    assert.ok(r.exit.price >= 217, `出場價 ${r.exit.price} 應不低於止賺價 217`);
    assert.ok(isFinite(r.pnl.amountUsd), '美元損益必須是數字');
    assert.strictEqual(r.pnl.realized, true);
    assert.strictEqual(r.pnl.amountUsd, r.pnl.amountLocal, '美股原幣與美元損益應相同');
    assert.ok(r.pnl.holdingDays >= 1, `持倉天數應 ≥1，實際 ${r.pnl.holdingDays}`);
    // 跳空高開 → 以開盤價成交，報酬應優於「剛好到止賺價」
    const naiveReturn = ((217 - r.entry.price) / r.entry.price) * 100;
    assert.ok(r.pnl.priceReturnPct >= naiveReturn - 0.01,
      `跳空高開的報酬 ${r.pnl.priceReturnPct}% 不應低於止賺價報酬 ${naiveReturn.toFixed(2)}%`);
    console.log(`      ${r.entry.date} 以 ${r.entry.price} 建倉，`
      + `${r.exit.date} 以 ${r.exit.price} 止賺，`
      + `損益 ${r.pnl.amountUsd} USD / ${r.pnl.returnPct}%，持有 ${r.pnl.holdingDays} 天`);
  });

  await ok('真實 K 線：港股走完整流程，美元損益已折算', async () => {
    const t = T.create({ filePath: null, datasource, capitalUsd: 10000 });
    // 0700 不存在於清單，改用清單內真實港股 0291.HK（買區 19.18–19.59）
    const rec = t.addPick({
      symbol: '0291.HK', name: 'China Resources Beer', market: 'HK', currency: 'HKD',
      price: 21, score: 85, verdict: { level: 'buy' },
      zoneLower: 19.18, zoneUpper: 21.5, zoneStop: 18, zoneTarget: 22,
    }, { pickDate: '2026-11-24' });

    await t.update({ concurrency: 1 });
    const r = rec.record;

    if (r.status === 'pending') {
      console.log('      （上游無 11-25 之後的日線，略過）');
      return;
    }
    assert.ok(r.entry.fxRate > 7 && r.entry.fxRate < 9,
      `港元匯率 ${r.entry.fxRate} 不合理`);
    // 港股：原幣損益 ≠ 美元損益，且美元約為原幣 / 7.8
    if (r.pnl) {
      const ratio = r.pnl.amountLocal === 0 ? null : r.pnl.amountUsd / r.pnl.amountLocal;
      if (ratio != null) {
        assert.ok(Math.abs(ratio - 1 / r.entry.fxRate) < 0.01,
          `美元/原幣比 ${ratio.toFixed(4)} 應約為 1/${r.entry.fxRate}`);
      }
      console.log(`      0291.HK 狀態 ${r.status}，原幣損益 ${r.pnl.amountLocal} HKD`
        + ` → 美元 ${r.pnl.amountUsd}（匯率 ${r.entry.fxRate}）`);
    }
  });

  console.log(`\n=== 結果：${pass} passed / ${fail} failed ===\n`);
  if (fail) process.exit(1);
})();
