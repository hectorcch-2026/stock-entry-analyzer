'use strict';

/**
 * 版塊輪動選股流程（三階段漏斗）
 * ================================
 *
 * 目的：把「RRG 版塊輪動」與「個股篩選」接成一條有因果關係的流程，
 * 讓每一檔選出來的股票都能回答「為什麼是這個版塊、為什麼是這檔」。
 *
 *   階段一  11 個版塊 ETF → 優勢版塊（預設前 2）
 *   階段二  500 檔母體 → 依版塊歸屬收斂成動態標的池
 *   階段三  動態池 → 套用既定篩選條件 → 排序輸出
 *
 * ── 為什麼版塊是「閘門」而不是「加分項」──────────────────
 * 版塊的 strengthScore 是**同儕百分位**（11 個版塊之間比），
 * 個股的 score 是**技術面絕對分**（七個維度加權）。兩套尺度混在一起
 * 加權後，得到的數字既無法解釋也無法回測：使用者看到 81 分，
 * 追問「這 81 分多少來自版塊、多少來自個股」時答不出來。
 *
 * 當閘門則理由單純：「逆風版塊裡的強勢股，勝率結構性較差」。
 * 可稽核、可回測，而且每一階段的貢獻都能單獨驗證。
 *
 * ── 為什麼預設只取前 2 個版塊 ─────────────────────────
 * 成本隨版塊數線性成長。實測母體 500 檔的版塊分佈：
 *   XLI 83 / XLK 76 / XLF 76 / XLV 60 / XLY 47 / XLP 33 /
 *   XLU 31 / XLRE 30 / XLB 24 / XLE 21 / XLC 19
 *
 *   前 2 → 約 159 檔 → 477 個上游請求 → 90 秒預算內可跑完
 *   前 3 → 約 235 檔 → 705 個請求 → 逼近甚至超出預算
 *
 * analyzer.analyze() 每檔打 3 個請求，這是無法迴避的固定成本，
 * 所以「能不能跑完」直接由版塊數決定。前 2 是讓每日運行成本可控的
 * 實務選擇，需要更廣覆蓋時可用 sectorTopN 調高（上限 6）。
 */

const rrg = require('./rrg');
const rrgService = require('./rrg-service');
const sectorHoldings = require('./sector-holdings');
const sectorMacroAi = require('./sector-macro-ai');
const pool = require('./pool');

/** 預設取前幾個優勢版塊。2 = 約 159 檔，可在 90 秒預算內跑完。 */
const DEFAULT_TOP_N = 2;

/** 上限。再多就會超出單輪時間預算，且版塊優勢會稀釋到沒有意義。 */
const MAX_TOP_N = 6;

/**
 * 優勢版塊的象限門檻。
 *
 * 為什麼要「先篩象限、再按分數排序」，而不是直接取前 N 名：
 *   ratio 的 100 是**固定線**（勝過基準），但 strengthScore 是**相對排名**。
 *   實測會出現 11 個版塊中有 8 個 ratio > 100 的情況——那時純按名次
 *   取前 2，可能剛好選到正在轉弱的版塊（leading 但 cross 指向 weakening）。
 *   先要求「位於領先或改善象限」，才不會選到逆風中的版塊。
 */
const FAVORED_QUADRANTS = ['leading', 'improving'];

/** 判定結果的三種分類。觀察類不是「次等」，而是「下一輪的名單」。 */
const VERDICT = {
  FAVORED: 'favored',   // 進池
  WATCH: 'watch',       // 不進池，但值得盯著
  AVOID: 'avoid',       // 迴避
};

function normTopN(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return DEFAULT_TOP_N;
  return Math.max(1, Math.min(MAX_TOP_N, Math.floor(n)));
}

/**
 * 階段一：判定每個版塊的角色（優勢／觀察／迴避）。
 *
 * @param {Array} ranked  sectorMacroAi.rankSectors() 的輸出（已按分數排序）
 * @returns {Array} 補上 verdict / verdictReason 的陣列
 */
function classifySectors(ranked) {
  const list = Array.isArray(ranked) ? ranked : [];
  return list.map((s) => {
    const quad = String(s.quadrant || '');
    const next = s.cross && s.cross.next ? String(s.cross.next) : null;
    const conf = s.cross && s.cross.confidence ? String(s.cross.confidence) : 'none';
    const inFavoredQuad = FAVORED_QUADRANTS.includes(quad);

    let verdict = VERDICT.AVOID;
    let reason = '';

    if (inFavoredQuad) {
      /*
       * 降級條件：位於優勢象限，但即將轉弱且信心高。
       *
       * 為什麼要降級：leading 的定義是「ratio≥100 且 momentum≥100」，
       * 但 momentum 只要還在 100 以上就算 leading——即使它正在快速下滑。
       * 這種「山頂上的領先」是最容易套牢的位置，因此降為觀察。
       */
      if (next === 'weakening' && conf === 'high') {
        verdict = VERDICT.WATCH;
        reason = `位於「${s.quadrantLabel}」但接近轉入「弱化」（信心高），暫不優先加碼`;
      } else {
        verdict = VERDICT.FAVORED;
        reason = quad === 'leading'
          ? '領先象限：相對強度與動能同時高於基準'
          : '改善象限：相對強度仍低於基準，但動能已轉強（佈局期）';
      }
    } else if (quad === 'weakening') {
      // 已轉弱但還沒跌向落後 → 觀察；若下一步就是落後 → 迴避
      if (next === 'lagging') {
        verdict = VERDICT.AVOID;
        reason = '弱化且下一步指向落後，趨勢明確轉差';
      } else {
        verdict = VERDICT.WATCH;
        reason = '位於弱化象限但尚未跌向落後，觀察是否止穩';
      }
    } else if (quad === 'lagging') {
      // 落後版塊唯一值得看的情況：正在強力轉向改善
      if (next === 'improving' && conf === 'high') {
        verdict = VERDICT.WATCH;
        reason = '落後象限但正接近轉入「改善」（信心高），可提前留意';
      } else {
        verdict = VERDICT.AVOID;
        reason = '落後象限：相對強度與動能同時低於基準';
      }
    } else {
      verdict = VERDICT.AVOID;
      reason = '資料不足，無法判定象限';
    }

    return { ...s, verdict, verdictReason: reason };
  });
}

/**
 * 從已分類的版塊中挑出優勢版塊（依 strengthScore 排序後取前 N）。
 *
 * 注意：這裡**不再重排**——rankSectors 已排好。取前 N 是為了控制成本，
 * 不是因為第 3 名以後沒有優勢。
 */
function pickFavored(classified, topN) {
  const n = normTopN(topN);
  const favored = (classified || []).filter((s) => s.verdict === VERDICT.FAVORED);
  return { favored: favored.slice(0, n), eligibleCount: favored.length, topN: n };
}

/**
 * 階段二：依優勢版塊建立動態標的池。
 *
 * 剔除原因必須分三類，不可合併——因為三者的除錯方向完全相反：
 *   OUT_OF_UNIVERSE     非美股／中概股   → 規則性排除（母體已純化，通常 0）
 *   SECTOR_UNKNOWN      查不到版塊歸屬   → **資料管線異常**（修正 50 上限後應為 0）
 *   SECTOR_NOT_FAVORED  版塊未入選       → 策略性排除（正常結果）
 *
 * 若把 SECTOR_UNKNOWN 併進 SECTOR_NOT_FAVORED，資料管線壞掉時
 * 使用者只會看到一個大數字，完全無從發現異常。
 *
 * @param {object} opts { universe, sectorIndex, favoredSectors }
 */
function buildDynamicPool(opts) {
  const universe = Array.isArray(opts.universe) ? opts.universe : [];
  const index = opts.sectorIndex;       // Map<symbol, [{sector, weight, rank}]>
  const favored = Array.isArray(opts.favoredSectors) ? opts.favoredSectors : [];
  const favoredKeys = new Set(favored.map((s) => String(s.key).toUpperCase()));

  const members = [];
  const excludedUnknown = [];
  const excludedNotFavored = [];
  const bySector = new Map();
  /*
   * 去重必須在正規化之後做，因為 `BRK.B` 與 `BRK-B` 是同一檔，
   * 但字串不同。若只看原始字串，同一檔會進池兩次，
   * 階段三就會對它打兩倍的 upstream 請求、並在結果裡出現兩列。
   */
  const seen = new Set();

  for (const raw of universe) {
    const sym = pool.normalizeTicker(raw);
    if (!sym) continue;
    if (seen.has(sym)) continue;
    seen.add(sym);

    const list = index && index.get ? index.get(sym) : null;
    if (!list || !list.length) {
      excludedUnknown.push(sym);
      continue;
    }

    // 主場版塊：權重最高者（index 已依權重排序）
    const home = list[0];
    const sectorKey = String(home.sector || '').toUpperCase();

    if (!favoredKeys.has(sectorKey)) {
      excludedNotFavored.push({ symbol: sym, sector: sectorKey });
      continue;
    }

    if (!bySector.has(sectorKey)) bySector.set(sectorKey, []);
    bySector.get(sectorKey).push(sym);
    members.push({
      symbol: sym,
      sector: sectorKey,
      weight: home.weight,
      rankInSector: home.rank,
      // 次要歸屬：一檔可能同時在兩個 ETF（實測目前 0 筆，屬防禦性保留）
      otherSectors: list.slice(1).map((x) => x.sector),
    });
  }

  // 版塊內的權重排序（權重大的通常市值大、流動性好）
  members.sort((a, b) => (b.weight || 0) - (a.weight || 0));

  return {
    members,
    symbols: members.map((m) => m.symbol),
    bySector: Object.fromEntries([...bySector.entries()].map(([k, v]) => [k, v.length])),
    excluded: {
      sectorUnknown: {
        count: excludedUnknown.length,
        symbols: excludedUnknown,
        note: excludedUnknown.length
          ? '查不到版塊歸屬——這代表持股檔異常或上限截斷，不是「這些股票不合格」'
          : '全部母體成員皆已成功歸屬版塊',
      },
      sectorNotFavored: {
        count: excludedNotFavored.length,
        sample: excludedNotFavored.slice(0, 30),
      },
    },
    funnel: {
      universe: universe.length,
      withSector: universe.length - excludedUnknown.length,
      unknownSector: excludedUnknown.length,
      notFavored: excludedNotFavored.length,
      dynamicPool: members.length,
    },
  };
}

/**
 * 完整三階段流程（階段三由呼叫端接 screener，避免循環依賴）。
 *
 * @param {object} deps { datasource }
 * @param {object} opts { topN, timeframe, benchmarkKey, period }
 * @returns {Promise<object>}
 */
async function buildSectorFlow(deps, opts = {}) {
  const topN = normTopN(opts.topN);
  const timeframe = opts.timeframe || rrg.DEFAULT_TIMEFRAME;
  const benchmarkKey = opts.benchmarkKey || 'SPY';
  /*
   * 平滑週期必須走 rrg.normPeriod()，不能讀 rrg.DEFAULT_PERIOD。
   *
   * 為什麼：rrg.js **沒有匯出** DEFAULT_PERIOD，所以 rrg.DEFAULT_PERIOD
   * 是 undefined。undefined 傳進 computeTrack() 後，內部的 DEMA 迴圈
   * 一次都不執行，ratio/momentum 全部是 null —— 於是每個版塊都被判成
   * 「資料不足」（INSUFFICIENT_DATA），整條流程在階段一就失敗。
   *
   * 這個 bug 的症狀極具誤導性：錯誤訊息說「所有版塊的資料都不足以計算 RRG」，
   * 看起來像上游行情抓不到，實際上資料完好、是參數是 undefined。
   * 而且 normPeriod 還會依時間週期給不同預設（月線是 8，日/週線是 14），
   * 這也是直接寫死 14 會錯的地方。
   */
  const period = rrg.normPeriod(opts.period, timeframe).value;

  /* ---- 階段一 ---- */
  const matrix = await rrgService.getMatrix(deps.datasource, { timeframe, benchmarkKey });
  if (!matrix.ok) {
    return {
      ok: false,
      stage: 'sectors',
      code: matrix.code || 'RRG_FAILED',
      message: matrix.message || '無法計算版塊輪動',
      hint: matrix.hint || null,
    };
  }

  const built = rrg.buildRRG({
    dates: matrix.dates,
    t: matrix.t,
    rows: matrix.rows,
    benchmarkKey,
    sectorKeys: rrg.SECTORS.map((s) => s.key),
    period,
    windowBars: rrg.WINDOWS[rrg.DEFAULT_WINDOW].bars[timeframe] || 52,
    trail: rrg.DEFAULT_TRAIL,
    meta: { sectors: rrg.SECTORS },
  });
  if (!built.ok) {
    return {
      ok: false,
      stage: 'sectors',
      code: built.code || 'RRG_BUILD_FAILED',
      message: built.message || '無法建立 RRG',
      hint: built.hint || null,
    };
  }

  const ranked = sectorMacroAi.rankSectors(built.points);
  const classified = classifySectors(ranked);
  const { favored, eligibleCount } = pickFavored(classified, topN);

  if (!favored.length) {
    return {
      ok: false,
      stage: 'sectors',
      code: 'NO_FAVORED_SECTOR',
      message: '目前沒有版塊位於領先或改善象限',
      hint: '市場全面轉弱時這是正常結果；可改用不含版塊前置的一般篩選',
      sectors: classified,
    };
  }

  /* ---- 階段二 ---- */
  let index;
  try {
    index = await sectorHoldings.getSectorIndex();
  } catch (e) {
    return {
      ok: false,
      stage: 'pool',
      code: 'SECTOR_INDEX_FAILED',
      message: `無法取得版塊持股對照：${e.message}`,
      hint: '持股檔由發行商提供，稍後重試即可',
      sectors: classified,
    };
  }
  if (!index.ok || !index.size) {
    return {
      ok: false,
      stage: 'pool',
      code: 'SECTOR_INDEX_EMPTY',
      message: '版塊持股對照表為空',
      hint: '持股檔可能全部抓取失敗，請稍後重試',
      sectors: classified,
      failedSectors: index.failed || [],
    };
  }

  const universe = pool.all();
  const dyn = buildDynamicPool({ universe, sectorIndex: index.map, favoredSectors: favored });

  /* 版塊成員數要跟「這個版塊在母體裡有多少檔」對齊，
     不能只回「有幾檔入池」——否則使用者無從判斷是版塊小還是被剔除了。 */
  const favoredWithMembers = favored.map((s) => ({
    key: s.key,
    label: s.label,
    short: s.short,
    color: s.color,
    rank: s.rank,
    strengthScore: s.strengthScore,
    ratio: s.ratio,
    momentum: s.momentum,
    quadrant: s.quadrant,
    quadrantLabel: s.quadrantLabel,
    crossNext: s.cross ? s.cross.nextCn : null,
    crossConfidence: s.cross ? s.cross.confidence : 'none',
    verdictReason: s.verdictReason,
    /*
     * 入選版塊一律回數字（含 0），不回 null。
     * 0 與「不知道」在語意上完全不同：0 是「這個版塊在母體裡沒有成員」
     * （罕見但可能），null 是「沒算」。前端把 null 畫成破折號，
     * 若這裡回 null，使用者就分不出「版塊很小」與「程式沒算」。
     */
    members: dyn.bySector[String(s.key).toUpperCase()] || 0,
  }));

  /*
   * 未入選版塊的成員數也要算出來。
   *
   * 需求表 A 有「池內檔數」這一欄。若只給入選版塊填數字、其餘留白，
   * 使用者會以為「那幾欄是壞的」，實際上它們是「本輪沒取用，所以是 0」。
   * 這裡一併算出「該版塊在母體裡有幾檔」，讓表 A 每一列都有意義：
   * 未入選版塊標 0，並可對照它的實際母體成員數。
   */
  const favoredKeySet = new Set(favored.map((s) => String(s.key).toUpperCase()));
  const universeBySector = {};
  for (const sym of universe) {
    const s = pool.normalizeTicker(sym);
    if (!s) continue;
    const list = index.map && index.map.get ? index.map.get(s) : null;
    if (!list || !list.length) continue;
    const key = String(list[0].sector || '').toUpperCase();
    universeBySector[key] = (universeBySector[key] || 0) + 1;
  }

  const sectorsWithMembers = classified.map((s) => {
    const key = String(s.key).toUpperCase();
    const inPool = favoredKeySet.has(key);
    return {
      ...s,
      memberCountInPool: inPool ? (dyn.bySector[key] || 0) : 0,
      memberCountInUniverse: universeBySector[key] || 0,
    };
  });

  return {
    ok: true,
    topN,
    timeframe,
    benchmarkKey,
    period,
    asOf: matrix.dates && matrix.dates.length ? matrix.dates[matrix.dates.length - 1] : null,
    sectors: sectorsWithMembers,
    favoredSummary: {
      topN,
      eligibleCount,
      picked: favoredWithMembers,
      note: eligibleCount > topN
        ? `另有 ${eligibleCount - topN} 個版塊同樣位於優勢象限，但本次僅取前 ${topN} 個以控制成本。`
        : null,
    },
    pool: dyn,
    coverage: {
      indexSize: index.size,
      universe: universe.length,
      unknownSector: dyn.excluded.sectorUnknown.count,
      healthy: dyn.excluded.sectorUnknown.count === 0,
    },
  };
}

module.exports = {
  VERDICT,
  DEFAULT_TOP_N,
  MAX_TOP_N,
  FAVORED_QUADRANTS,
  normTopN,
  classifySectors,
  pickFavored,
  buildDynamicPool,
  buildSectorFlow,
};
