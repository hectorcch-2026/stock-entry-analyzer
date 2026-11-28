#!/usr/bin/env node
'use strict';

/**
 * 版塊輪動選股流程 — 端到端整合測試（全離線）
 *
 * 目的：證明階段一（版塊）→ 階段二（動態池）→ 階段三（個股）真的接得起來。
 *
 * 為什麼要這一支，單元測試不夠嗎：
 *   單元測試把 sector-flow 的每個函式單獨餵假資料，證明「判定邏輯對」。
 *   但它證明不了「buildSectorFlow 真的會把 RRG 的輸出餵給 rankSectors、
 *   把 rankSectors 的輸出餵給 classifySectors、再把結果變成 screener 吃的
 *   sectorMeta」。接線錯了，每個零件都對，整條線仍然不動。
 *
 * 全離線的做法：
 *   1. datasource 用合成 K 線（可控制的斜率），不碰網路
 *   2. sector-holdings 的索引用注入的假 Map，不抓發行商持股檔
 *   3. rrg-service 的快取先清空，避免吃到真實快取
 *
 * 這樣「版塊強弱」就是可預測的：我讓某個版塊的斜率遠高於基準，
 * 它就應該出現在優勢版塊裡。若沒有，是接線壞了，不是市場變了。
 */

const assert = require('assert');

const rrg = require('../lib/rrg');
const rrgService = require('../lib/rrg-service');
const pool = require('../lib/pool');
const screener = require('../lib/screener');
const sectorFlow = require('../lib/sector-flow');
const sectorHoldings = require('../lib/sector-holdings');
const sectorMacroAi = require('../lib/sector-macro-ai');

let pass = 0;
let fail = 0;
const failures = [];

async function ta(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, msg: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

/**
 * 合成 K 線：以 CAGR 斜率產生確定性序列。
 *
 * 為什麼用「確定性斜率」而不是隨機漫步：
 *   隨機漫步的 RRG 結果不可預測，測試會變成「跑得過就好」，
 *   而「跑得過」不代表「算對了」。用固定斜率，我可以斷言
 *   「斜率最高的版塊必須是 leading」，這才是真正的驗證。
 */
/**
 * 合成 K 線：成長率從 startCagr **線性過渡**到 endCagr。
 *
 * 為什麼一定要用「加速度」而不是固定斜率：
 *   固定斜率（固定 CAGR）的相對強度會**收斂**——比值上升一段後趨平，
 *   於是 momentum 貼在 100 附近，RRG 會把它判成 weakening（ratio>100
 *   但動能不再上升）。這在數學上是正確的：等速跑贏不等於正在轉強。
 *
 *   我一開始就是這樣寫的，結果 XLK（最強）被判成 weakening，
 *   而 XLE（最弱）因為 ratio<100 且動能微升被判成 improving 而入選。
 *   那不是程式錯，是**假資料沒有領先的形狀**。
 *
 *   真實市場的領先版塊是「近期跑贏幅度擴大」——所以合成資料必須加速。
 *   endCagr > startCagr → 資金持續流入 → ratio 上升且 momentum > 100 → leading。
 *
 * @param {number} days     交易日數
 * @param {number} startCagr 期初年化成長率
 * @param {number} endCagr   期末年化成長率
 */
function synthCandles(days, startCagr, endCagr) {
  const candles = [];
  const adjClose = [];
  /*
   * t 必須是**毫秒**（resample 用 new Date(t) 做週/月分桶）。
   * 若誤用秒，400 根「日線」會全部落進同一週，重取樣後只剩 1 期，
   * RRG 因為暖機期不足而整批失敗——症狀是「所有版塊資料不足」，
   * 很容易被誤判成資料源問題。
   */
  const start = Date.UTC(2020, 0, 6);   // 週一
  let px = 100;
  const endCagrV = endCagr != null ? endCagr : startCagr;
  for (let i = 0; i < days; i++) {
    const frac = days > 1 ? i / (days - 1) : 0;
    const cagr = startCagr + (endCagrV - startCagr) * frac;   // 線性加速
    const daily = Math.pow(1 + cagr, 1 / 252) - 1;
    // 加上一個固定的小幅波動，讓 ratio/momentum 不會是完美直線
    const wobble = Math.sin(i / 9) * 0.004;
    px = px * (1 + daily + wobble);
    candles.push({ t: start + i * 86400000, o: px, h: px * 1.005, l: px * 0.995, c: px, v: 1e6 });
    adjClose.push(px);
  }
  return { candles, adjClose, source: 'synthetic' };
}

/** 造一個假 datasource：每個代碼給不同的「期初 → 期末」成長率。 */
function synthDatasource(rates) {
  return {
    calls: [],
    async chartWithAdj(symbol) {
      this.calls.push(symbol);
      const r = rates[symbol] || { start: 0.05, end: 0.05 };
      // 900 根日線 ≈ 43 個月。月線的暖機期是 8×2.5=20 期，
      // 若只有 400 根（約 13 個月）月線一定失敗，週線卻完全正常。
      return synthCandles(900, r.start, r.end);
    },
  };
}

/** 造一個假的持股索引，讓指定的版塊含指定的股票。 */
function fakeIndex(map) {
  const m = new Map();
  for (const [sector, symbols] of Object.entries(map)) {
    symbols.forEach((s, i) => {
      if (!m.has(s)) m.set(s, []);
      m.get(s).push({ sector, weight: 30 - i, rank: i + 1 });
    });
  }
  return { ok: true, size: m.size, map: m, failed: [] };
}

/** 假的 analyzer：給定分數表。 */
function fakeAnalyzer(scoreMap) {
  return {
    async analyze(sym) {
      const score = scoreMap[sym] != null ? scoreMap[sym] : 62;
      return {
        meta: { symbol: sym, name: sym, market: 'us', price: 100 },
        score,
        verdict: 'watch-buy',
        snapshot: { price: 100, atr: 2, atrPct: 2, changePct: 0.5, volume: { vol20: 2e6 } },
        buyZone: { lower: 96, upper: 98, stopLoss: 92, target: 112 },
        backtest: { samples: 120, horizons: { 20: { winRate: 0.62 } } },
        rationale: [],
      };
    },
  };
}

(async () => {
  console.log('\n=== 版塊輪動選股流程 端到端整合測試 ===\n');

  /* 每次都要清 RRG 快取，否則第二次執行會拿到上一輪的矩陣 */
  rrgService.resetCache();

  /* ------------------------------------------------------------
     測試資料：讓 XLK 加速領先、XLE 加速落後，其餘持平

     為什麼要「加速」而不是「高斜率」：
     固定高斜率的相對強度會收斂（ratio 上升後趨平），momentum 貼近 100，
     RRG 正確地判成 weakening —— 等速跑贏不等於正在轉強。
     領先的形狀是「跑贏幅度持續擴大」，所以 end > start。
     ------------------------------------------------------------ */
  const rates = {};
  const flat = { start: 0.06, end: 0.06 };
  for (const s of rrg.SECTORS) rates[s.key] = flat;
  rates.SPY = { start: 0.06, end: 0.06 };          // 基準持平
  rates.XLK = { start: 0.05, end: 0.42 };          // 加速領先 → leading
  rates.XLI = { start: 0.05, end: 0.30 };          // 次強 → leading
  rates.XLF = { start: 0.06, end: 0.14 };          // 略轉強 → leading/improving
  rates.XLE = { start: 0.07, end: -0.30 };         // 加速落後 → lagging
  rates.XLU = { start: 0.06, end: -0.12 };         // 轉弱 → lagging/weakening

  const ds = synthDatasource(rates);

  await ta('I1 階段一：優勢版塊只可能來自 leading／improving，且排名反映建構順序', async () => {
    const flow = await sectorFlow.buildSectorFlow({ datasource: ds }, { topN: 2 });
    assert.strictEqual(flow.ok, true, `流程失敗：${flow.message || flow.code}`);

    const picked = flow.favoredSummary.picked;

    /*
     * 斷言的是**不變式**，不是特定代碼。
     *
     * 我原本寫「XLK 必須入選」，結果紅了——但程式是對的：合成資料裡
     * XLK 的動能由 100.57 微降到 100.52（在山頂滾落），cross 因此正確地
     * 判成「接近弱化、信心高」而把它降級為觀察。那是規則在正常運作。
     *
     * 若為了讓測試變綠去改資料，等於在替規則化妝。改為驗證「無論資料形狀
     * 如何都必須成立」的三件事：入選者必在優勢象限、必為 FAVORED 判定、
     * 弱勢象限絕不入選。
     */
    assert.ok(picked.length > 0, '至少應選出一個版塊');
    assert.ok(picked.length <= 2, `topN=2 不可超過，實際 ${picked.length}`);

    for (const s of picked) {
      assert.ok(
        ['leading', 'improving'].includes(s.quadrant),
        `${s.key} 位於 ${s.quadrant}，不該入選`
      );
      const full = flow.sectors.find((x) => x.key === s.key);
      assert.strictEqual(full.verdict, sectorFlow.VERDICT.FAVORED,
        `${s.key} 被選入池，但判定不是 FAVORED`);
    }

    // 排名確實反映建構順序：給最強斜率的 XLK 必須是 strengthScore 第 1
    const ranked = flow.sectors.slice().sort((a, b) => a.rank - b.rank);
    assert.strictEqual(ranked[0].key, 'XLK',
      `建構時 XLK 斜率最高，應排名第 1，實際第 1 是 ${ranked[0].key}`);
    assert.strictEqual(ranked[0].strengthScore, 100, '第 1 名的同儕百分位必須是 100');
  });

  await ta('I2 階段一：落後象限的版塊絕不進池（WATCH 或 AVOID 皆可，但不可 FAVORED）', async () => {
    const flow = await sectorFlow.buildSectorFlow({ datasource: ds }, { topN: 2 });

    /*
     * 落後象限有兩個合法的下場：
     *   AVOID —— 純粹落後
     *   WATCH —— 落後但正強力轉向改善（規格 §1.3 的提前留意）
     *
     * 我最初斷言「落後必為 AVOID」，在資料加長後紅了：XLE 的尾段動能
     * 確實開始回升，cross 判為「接近改善、信心高」，於是正確地變成 WATCH。
     * 那不是 bug，是規格裡明寫的第三類。
     *
     * 真正的不變式是「落後象限永遠不會被當成優勢版塊」——
     * 這也是唯一會造成實際損失的行為（把錢放進逆風版塊）。
     */
    const lagging = flow.sectors.filter((s) => s.quadrant === 'lagging');
    assert.ok(lagging.length > 0, '這組資料應至少有一個落後版塊');

    for (const s of lagging) {
      assert.notStrictEqual(s.verdict, sectorFlow.VERDICT.FAVORED,
        `${s.key} 位於落後象限卻是 FAVORED —— 版塊閘門失效`);
      assert.ok([sectorFlow.VERDICT.WATCH, sectorFlow.VERDICT.AVOID].includes(s.verdict),
        `${s.key} 的判定 ${s.verdict} 不合理`);
    }

    // XLE 的建構是「成長率一路崩到 -30%」，必為落後
    const xle = flow.sectors.find((s) => s.key === 'XLE');
    assert.strictEqual(xle.quadrant, 'lagging', `XLE 應為 lagging，實際 ${xle.quadrant}`);

    const pickedKeys = flow.favoredSummary.picked.map((s) => s.key);
    for (const s of lagging) {
      assert.ok(!pickedKeys.includes(s.key), `${s.key} 是落後版塊，不該進池`);
    }
  });

  await ta('I2b 階段一：山頂領先者會被降級 —— 這條規則真的會觸發', async () => {
    /*
     * 這組資料裡 XLK/XLI 的動能都在山頂微降，因此 cross 判為
     * 「接近弱化、信心高」，規則應把它們降為觀察。
     * 若這條紅了，代表降級規則失效（cross 傳遞斷掉或條件寫錯）——
     * 這正是我在本次實作中修掉的 bug，必須有測試釘住。
     */
    const flow = await sectorFlow.buildSectorFlow({ datasource: ds }, { topN: 2 });
    const demoted = flow.sectors.filter(
      (s) => ['leading', 'improving'].includes(s.quadrant) && s.verdict === sectorFlow.VERDICT.WATCH
    );
    assert.ok(demoted.length > 0,
      '所有優勢象限版塊都是 FAVORED —— 降級規則可能沒生效（檢查 cross 是否傳到這裡）');
    for (const s of demoted) {
      assert.ok(/弱化/.test(s.verdictReason), `降級原因應提到弱化，實際：${s.verdictReason}`);
    }
  });

  await ta('I3 階段一：cross 有實際傳到最終輸出', async () => {
    const flow = await sectorFlow.buildSectorFlow({ datasource: ds }, { topN: 2 });
    // 至少要有版塊帶 cross 資訊，否則「下一步」欄位永遠空白
    const withCross = flow.sectors.filter((s) => s.cross && s.cross.next);
    assert.ok(withCross.length > 0, '所有版塊的 cross 都消失了 —— 傳遞鏈斷了');
    assert.ok(withCross.every((s) => s.cross.confidence), 'cross 必須帶信心程度');
  });

  await ta('I4 階段二：動態池只含優勢版塊成員，且漏斗自洽', async () => {
    /*
     * 這裡必須攔截 getSectorIndex，否則會真的去抓發行商持股檔（需要網路）。
     * 用真實母體（500 檔）搭配假索引，才能驗證「母體 → 池」的收斂。
     */
    const orig = sectorHoldings.getSectorIndex;
    const real = pool.all();
    // 把母體成員平均分配進幾個版塊，模擬真實分佈
    const buckets = {};
    real.forEach((sym, i) => {
      const key = rrg.SECTORS[i % rrg.SECTORS.length].key;
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(sym);
    });
    sectorHoldings.getSectorIndex = async () => fakeIndex(buckets);

    try {
      rrgService.resetCache();
      const flow = await sectorFlow.buildSectorFlow({ datasource: synthDatasource(rates) }, { topN: 2 });
      assert.strictEqual(flow.ok, true, `流程失敗：${flow.message || flow.code}`);

      const f = flow.pool.funnel;
      assert.strictEqual(f.universe, 500, `母體應為 500，實際 ${f.universe}`);
      assert.strictEqual(f.unknownSector, 0, `不該有無歸屬（假索引覆蓋全部母體），實際 ${f.unknownSector}`);
      assert.strictEqual(
        f.dynamicPool + f.unknownSector + f.notFavored, f.universe,
        '漏斗三類相加必須等於母體'
      );
      assert.ok(f.dynamicPool > 0, '動態池不可為空');
      assert.ok(f.dynamicPool < 500, `動態池應小於母體（前 2 版塊），實際 ${f.dynamicPool}`);

      // 池內每一檔都必須屬於入選版塊
      const favoredKeys = new Set(flow.favoredSummary.picked.map((s) => s.key));
      for (const m of flow.pool.members) {
        assert.ok(favoredKeys.has(m.sector), `${m.symbol} 屬於 ${m.sector}，不在優勢版塊內`);
      }
    } finally {
      sectorHoldings.getSectorIndex = orig;
    }
  });

  await ta('I5 階段三：完整串接 — 動態池餵進 screener 並按版塊排序', async () => {
    const orig = sectorHoldings.getSectorIndex;
    const real = pool.all();
    const buckets = {};
    real.forEach((sym, i) => {
      const key = rrg.SECTORS[i % rrg.SECTORS.length].key;
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(sym);
    });
    sectorHoldings.getSectorIndex = async () => fakeIndex(buckets);

    try {
      rrgService.resetCache();
      const flow = await sectorFlow.buildSectorFlow({ datasource: synthDatasource(rates) }, { topN: 2 });
      assert.strictEqual(flow.ok, true, `流程失敗：${flow.message || flow.code}`);

      // 組 sectorMeta（與 server.js 端點的做法一致）
      const sectorMeta = new Map();
      for (const s of flow.favoredSummary.picked) {
        const key = String(s.key).toUpperCase();
        for (const m of flow.pool.members) {
          if (String(m.sector).toUpperCase() !== key) continue;
          sectorMeta.set(m.symbol, {
            key, label: s.label, rank: s.rank,
            strengthScore: s.strengthScore, quadrant: s.quadrant,
          });
        }
      }
      assert.strictEqual(sectorMeta.size, flow.pool.symbols.length,
        'sectorMeta 必須覆蓋池內每一檔，否則部分列會缺版塊欄位');

      // 給池內成員固定分數，讓排序只受版塊名次影響
      const scoreMap = {};
      flow.pool.symbols.forEach((s) => { scoreMap[s] = 65; });

      const out = await screener.screen(
        { analyzer: fakeAnalyzer(scoreMap), symbols: flow.pool.symbols, sectorMeta },
        { sortBy: 'sector', market: 'all', limit: 20 },
        { concurrency: 6, budgetMs: 30000 }
      );

      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.opts.sortBy, 'sector', 'sortBy 不該被退回 —— 有 sectorMeta 就該生效');
      assert.strictEqual(out.stats.sortLabel, '版塊優先');
      assert.ok(out.rows.length > 0, '應該有通過篩選的標的');

      // 第 1 鍵生效：第一列的版塊名次必須是全場最小
      const minRank = Math.min(...out.rows.map((r) => r.sectorRank));
      assert.strictEqual(out.rows[0].sectorRank, minRank,
        `第一列的版塊名次應為 ${minRank}，實際 ${out.rows[0].sectorRank}`);

      // 版塊名次必須單調不減（第 1 鍵是 ASC）
      for (let i = 1; i < out.rows.length; i++) {
        assert.ok(out.rows[i].sectorRank >= out.rows[i - 1].sectorRank,
          `版塊名次在第 ${i} 列發生倒退（${out.rows[i - 1].sectorRank} → ${out.rows[i].sectorRank}）`);
      }

      // 每一列都要有版塊欄位
      for (const r of out.rows) {
        assert.ok(r.sector, `${r.symbol} 缺少 sector 欄位`);
        assert.ok(r.sectorRank != null, `${r.symbol} 缺少 sectorRank 欄位`);
      }

      assert.ok(out.stats.concentration, '版塊模式必須附集中度');
    } finally {
      sectorHoldings.getSectorIndex = orig;
    }
  });

  await ta('I6 端點契約：失敗時不降級成一般篩選（不會假成功）', async () => {
    // datasource 完全失敗 → 階段一失敗 → 必須明確回報，不能回一份普通篩選清單
    const broken = { async chartWithAdj() { throw new Error('network down'); } };
    rrgService.resetCache();
    const flow = await sectorFlow.buildSectorFlow({ datasource: broken }, { topN: 2 });
    assert.strictEqual(flow.ok, false, '上游全掛時不該回 ok:true');
    assert.ok(flow.code, '必須帶錯誤代碼');
    assert.ok(flow.message, '必須帶可讀訊息');
    assert.ok(!('rows' in flow), '失敗結果不該帶 rows（避免被誤用成篩選結果）');
  });

  await ta('I7 端點契約：topN 越大，動態池越大（版塊數與成本成正比）', async () => {
    const orig = sectorHoldings.getSectorIndex;
    const real = pool.all();
    const buckets = {};
    real.forEach((sym, i) => {
      const key = rrg.SECTORS[i % rrg.SECTORS.length].key;
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(sym);
    });
    sectorHoldings.getSectorIndex = async () => fakeIndex(buckets);

    try {
      rrgService.resetCache();
      const f2 = await sectorFlow.buildSectorFlow({ datasource: synthDatasource(rates) }, { topN: 2 });
      rrgService.resetCache();
      const f4 = await sectorFlow.buildSectorFlow({ datasource: synthDatasource(rates) }, { topN: 4 });

      assert.ok(f2.ok && f4.ok, '兩次都應成功');
      assert.ok(f4.pool.symbols.length > f2.pool.symbols.length,
        `topN=4 的池（${f4.pool.symbols.length}）應大於 topN=2（${f2.pool.symbols.length}）`);
      // 成本檢核：每檔 3 個請求
      assert.ok(f2.pool.symbols.length * 3 < 600,
        `topN=2 的請求數（${f2.pool.symbols.length * 3}）應在 90 秒預算內`);
    } finally {
      sectorHoldings.getSectorIndex = orig;
    }
  });

  await ta('I8 平滑週期依時間週期取預設（月線 8、週線 14，不可寫死）', async () => {
    /*
     * rrg.TIMEFRAMES 對每個週期給不同的預設平滑期數（月線 8、日/週線 14）。
     * 若 buildSectorFlow 不呼叫 normPeriod 而是寫死 14，週線看起來完全正常，
     * 只有月線會錯——而且是「數字算得出、但不是我宣告的參數」這種靜默錯誤。
     *
     * 這條斷言專門釘住那個寫死值：讀 flow.period 必須等於該週期的預設。
     */
    const monthly = await sectorFlow.buildSectorFlow(
      { datasource: synthDatasource(rates) }, { topN: 2, timeframe: 'monthly' }
    );
    assert.strictEqual(monthly.ok, true, `月線流程失敗：${monthly.message || monthly.code}`);
    assert.strictEqual(monthly.period, 8, `月線的預設平滑週期應為 8，實際 ${monthly.period}`);
    assert.strictEqual(monthly.timeframe, 'monthly');

    // 明確傳入 period 時必須被尊重
    rrgService.resetCache();
    const custom = await sectorFlow.buildSectorFlow(
      { datasource: synthDatasource(rates) }, { topN: 2, timeframe: 'weekly', period: 20 }
    );
    assert.strictEqual(custom.ok, true);
    assert.strictEqual(custom.period, 20, `明確指定的週期應為 20，實際 ${custom.period}`);
  });

  console.log(`\n=== 結果：${pass} 通過 / ${fail} 失敗 ===\n`);
  if (fail) {
    failures.forEach((f) => console.log(`  ✗ ${f.name}\n      ${f.msg}`));
    process.exit(1);
  }
})();
