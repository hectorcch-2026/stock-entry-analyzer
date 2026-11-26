'use strict';

/**
 * 版塊輪動 × 宏觀經濟 關聯分析
 * ==============================
 *
 * 把 RRG 的輪動快照（誰強誰弱、在哪個象限、往哪走）與 FRED 的宏觀快照
 * （利率、通膨、就業、產出）組成一份可解釋的關聯分析。
 *
 * ── 為什麼排名一定要由後端算，不能交給模型 ────────────────
 * 模型每次輸出的敘述都會不同（temperature 即便 0.2 也有變異）。
 * 若「第一名是哪個版塊」也由模型決定，使用者重整兩次會看到不同答案，
 * 於是整份分析失去可信度。
 * 因此：**排名、強弱分數、資金流向 = 純函式計算，完全可重現**；
 * 模型只負責寫「為什麼」與「接下來看什麼」。
 *
 * ── 為什麼宏觀只取 8 條而不是全部 18 條 ──────────────────
 * 見 docs/新聞與AI分析_資料契約與來源策略.md §3.2 的完整論證。
 * 摘要：把 18 條全丟給模型，它只會挑最順口的講，而不是講最有解釋力的。
 * 篩選本身（以及篩掉誰、為什麼篩）就是方法論的一部分。
 *
 * ── 為什麼需要「一致性裁決」 ────────────────────────────
 * 輪動（價格行為）與宏觀（基本面條件）有時候會背離。
 * 背離通常才是真正的訊號：例如利率下行（利多成長股）但科技版塊
 * 卻在落後象限——代表市場已在定價別的東西。
 * 把「一致 / 背離」明確寫出來，比兩段各自正確卻互不相干的敘述有用得多。
 */

const llm = require('./llm');

/* ============================================================
   宏觀指標 ↔ 版塊 的理論關聯表
   ------------------------------------------------------------
   這張表是規則層的核心，也是 LLM 提示的依據。
   每一個 entry 都必須寫清楚「為什麼」，否則就變成沒有根據的配對。

   方向語義：
     inverse = 指標上升對該版塊不利、下降有利（多數利率型關係）
     direct  = 指標上升對該版塊有利
     mixed   = 視情況（例如利差對銀行為正、對成長股為負）
   ============================================================ */

const MACRO_LINKS = [
  {
    key: 'fedTargetUpper',
    label: '聯邦基金目標利率上限',
    short: '政策利率',
    thesis: {
      inverse: '政策利率是折現率的錨。利率處於高位時，未來現金流折現值下降，'
        + '長天期成長股（科技、非必需消費、房地產）的估值壓力最大；'
        + '利率回落時，這些版塊的評價修復彈性也最大。',
      direct: '利率上升通常伴隨景氣擴張，對銀行淨利差與循環性版塊偏有利。',
    },
    supportsWhen: { up: ['XLF'], down: ['XLK', 'XLY', 'XLRE', 'XLU'] },
    pressuresWhen: { up: ['XLK', 'XLY', 'XLRE', 'XLU'], down: ['XLF'] },
    confidence: 'high',
  },
  {
    key: 'dgs10',
    label: '10 年期公債殖利率',
    short: '10Y 殖利率',
    thesis: {
      inverse: '長端殖利率直接影響房貸、企業融資與股票風險溢價。'
        + '10Y 上行時，高本益比與高槓桿版塊（房地產、公用事業）承壓最明顯。',
      direct: '長端上行若來自景氣預期改善，對循環性與金融版塊可為正面。',
    },
    supportsWhen: { up: ['XLF'], down: ['XLRE', 'XLU', 'XLK'] },
    pressuresWhen: { up: ['XLRE', 'XLU', 'XLK'], down: ['XLF'] },
    confidence: 'high',
  },
  {
    key: 'termSpread',
    label: '10Y-2Y 期限利差',
    short: '期限利差',
    thesis: {
      inverse: '期限利差是銀行的核心獲利來源（借短貸長）。'
        + '利差擴大（陡峭化）通常改善銀行淨利差，並暗示景氣預期轉強；'
        + '利差收窄或倒掛則壓縮銀行獲利，且是衰退的前行指標。',
      direct: '',
    },
    supportsWhen: { up: ['XLF', 'XLI', 'XLB'], down: [] },
    pressuresWhen: { up: [], down: ['XLF', 'XLI', 'XLB'] },
    confidence: 'high',
  },
  {
    key: 'realYield10',
    label: '10 年期實質殖利率',
    short: '實質利率',
    thesis: {
      inverse: '實質利率是「不承擔風險也能拿到的報酬」，因此是黃金、'
        + '高股息資產與長期成長股的機會成本。實質利率走高時，'
        + '公用事業這類「債券替代品」的吸引力下降。',
      direct: '',
    },
    supportsWhen: { up: [], down: ['XLU', 'XLRE', 'XLB'] },
    pressuresWhen: { up: ['XLU', 'XLRE', 'XLB'], down: [] },
    confidence: 'medium',
  },
  {
    key: 'cpiYoy',
    label: 'CPI 年增率',
    short: 'CPI',
    thesis: {
      inverse: '通膨上行侵蝕實質購買力並壓縮評價；但對能源與原物料版塊，'
        + '通膨本身常對應商品價格上漲，反而是營收動能。',
      direct: '通膨溫和上行對具備定價權的必需消費與能源版塊有利。',
    },
    supportsWhen: { up: ['XLE', 'XLB', 'XLP'], down: ['XLK', 'XLY'] },
    pressuresWhen: { up: ['XLK', 'XLY', 'XLU'], down: ['XLE', 'XLB'] },
    confidence: 'medium',
  },
  {
    key: 'coreCpiYoy',
    label: '核心 CPI 年增率',
    short: '核心 CPI',
    thesis: {
      inverse: '核心通膨（剔除食品能源）是 Fed 政策路徑的主要依據。'
        + '核心通膨黏著會延後降息，對所有高評價版塊構成壓力；'
        + '核心通膨降溫則打開寬鬆空間，是成長股最主要的評價催化劑。',
      direct: '',
    },
    supportsWhen: { up: [], down: ['XLK', 'XLY', 'XLRE'] },
    pressuresWhen: { up: ['XLK', 'XLY', 'XLRE'], down: [] },
    confidence: 'high',
  },
  {
    key: 'unrate',
    label: '失業率',
    short: '失業率',
    thesis: {
      inverse: '失業率上升代表勞動市場轉弱、消費動能下滑，'
        + '對非必需消費與工業的營收展望不利；但同時提高降息機率，'
        + '對利率敏感的成長股反而是潛在利多（時間差需注意）。',
      direct: '失業率低檔代表消費韌性，對非必需消費與工業有利。',
    },
    supportsWhen: { up: ['XLP', 'XLU'], down: ['XLY', 'XLI'] },
    pressuresWhen: { up: ['XLY', 'XLI'], down: ['XLP', 'XLU'] },
    confidence: 'medium',
  },
  {
    key: 'indpro',
    label: '工業生產指數',
    short: '工業生產',
    thesis: {
      inverse: '',
      direct: '工業生產是實體經濟產出的最直接度量。指數上行代表製造業需求'
        + '轉強，對工業、原物料、能源這些上游版塊的營收有直接支撐。',
    },
    supportsWhen: { up: ['XLI', 'XLB', 'XLE'], down: [] },
    pressuresWhen: { up: [], down: ['XLI', 'XLB', 'XLE'] },
    confidence: 'high',
  },
];

/** 只取這 8 條（順序即畫面呈現順序） */
const MACRO_KEYS = MACRO_LINKS.map((m) => m.key);

/* ============================================================
   純函式：排名與強弱分數
   ============================================================ */

/**
 * 版塊強弱分數（0–100），可跨期比較。
 *
 * 公式設計說明：
 *   RRG 的 ratio / momentum 都以 100 為中性。理論上無上限
 *   （強勢版塊 ratio 可到 110+），因此不能直接用 0–100 當分數。
 *
 *   本函式把兩個維度各自轉為「相對百分位」，再依 6:4 加權：
 *     - ratio（相對強度水準）權重 0.6 —— 這是「現在有多強」
 *     - momentum（相對強度動能）權重 0.4 —— 這是「正在變強還是變弱」
 *   為什麼不是 5:5：輪動研判中「現在的位置」比「即將的變化」更可靠，
 *   因為動能可以很快反轉，而位置要扭轉需要更長時間。
 *
 *   百分位以**同一批版塊之間**的相對位置計算（不是歷史百分位），
 *   因此每次輸出必然有高有低，適合排名；跨期比較時請看絕對值，
 *   因為同期版塊集合相同，尺度一致。
 *
 * @param {Array} points RRG 的 points
 * @returns {Array} 已排序（強到弱）的排名
 */
function rankSectors(points) {
  const pts = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.ratio)) : [];
  if (!pts.length) return [];

  const ratios = pts.map((p) => p.ratio);
  const moms = pts.map((p) => (Number.isFinite(p.momentum) ? p.momentum : 100));

  const pctRank = (arr, v) => {
    if (arr.length < 2) return 50;
    const below = arr.filter((x) => x < v).length;
    return (below / (arr.length - 1)) * 100;
  };

  const scored = pts.map((p) => {
    const mom = Number.isFinite(p.momentum) ? p.momentum : 100;
    const rPct = pctRank(ratios, p.ratio);
    const mPct = pctRank(moms, mom);
    const strength = +(rPct * 0.6 + mPct * 0.4).toFixed(1);
    return {
      key: p.key,
      label: p.label,
      short: p.short,
      color: p.color,
      ratio: p.ratio,
      momentum: mom,
      quadrant: p.quadrant,
      quadrantLabel: p.quadrantLabel,
      strengthScore: strength,
      /* 是否「跑贏基準」——這是象限的判準（ratio > 100 ↔ 勝過 SPY）。
         與 strengthScore 刻意分開：兩者衡量的對象不同，
         混為一談會產生「第 9 名卻是領先象限」這種看似矛盾的呈現。 */
      aboveBenchmark: p.ratio > 100,
      _rPct: rPct,
      _mPct: mPct,
    };
  });

  scored.sort((a, b) => b.strengthScore - a.strengthScore
    || (b.ratio - a.ratio));

  const ranked = scored.map((s, i) => ({ ...s, rank: i + 1 }));

  /* 同儕分布：這一批版塊裡有幾個跑贏基準。
     為什麼要輸出它：象限的中性線固定在 100，但排名是相對同儕。
     當多數版塊都高於 100 時（實測 11 個裡有 8 個），
     「跑贏基準」與「排名靠前」就會分離，使用者看到
     「#9 通訊服務 / 24 分 / 領先象限」會以為程式算錯。
     把分布講出來，這個落差就變成可理解的資訊而非 bug。 */
  const aboveCount = ranked.filter((r) => r.aboveBenchmark).length;

  return ranked.map((r) => ({
    ...r,
    // 只在「象限語義與排名明顯相反」時給一句說明，其餘不多話
    rankNote: rankConflictNote(r, ranked.length, aboveCount),
  }));
}

/**
 * 產生「象限 vs 排名」落差的說明；沒有落差時回 null。
 *
 * 三種情況值得說明：
 *   A. 貼線：相對強度幾乎正好在 100（±0.5 內），象限只是勉強成立
 *   B. 贏過基準、輸給同儕：象限偏多但排名落在後 40%
 *   C. 輸給基準、贏過同儕：象限偏空但排名落在前段
 *
 * 為什麼門檻取後 40% 而不是後 50%：
 *   11 個版塊的第 6 名就是中位數，「領先象限但排第 6」不算矛盾，
 *   硬要說明反而變成噪音。只有明顯掉到後段（第 7 名之後）才需要解釋。
 */
function rankConflictNote(row, total, aboveCount) {
  if (!total) return null;
  const positiveQuad = row.quadrant === 'leading' || row.quadrant === 'improving';
  const negativeQuad = row.quadrant === 'lagging' || row.quadrant === 'weakening';
  const inBottom = row.rank > total * 0.6;
  const inTop = row.rank <= total * 0.4;

  const r2 = (v) => Number(v).toFixed(2);

  // A. 貼線：100.05 這種「技術上高於基準」講「仍高於基準」是自相矛盾的
  if (positiveQuad && row.aboveBenchmark && row.ratio - 100 <= 0.5) {
    return `相對強度 ${r2(row.ratio)} 幾乎正好貼在基準線 100 上，`
      + `動能 ${r2(row.momentum)} 勉強守住「${row.quadrantLabel}」象限，`
      + `但絕對水位毫無優勢，同儕中排第 ${row.rank}。`;
  }
  if (positiveQuad && inBottom && row.aboveBenchmark) {
    return `相對強度 ${r2(row.ratio)} 高於基準（100），但 ${total} 個版塊中有 ${aboveCount} 個同時高於基準，`
      + `同儕比較下僅排第 ${row.rank}——這是「贏過大盤、輸給其他版塊」。`;
  }
  if (negativeQuad && inTop && !row.aboveBenchmark) {
    return `相對強度 ${r2(row.ratio)} 低於基準（100），但同儕中僅 ${total - aboveCount} 個低於基準，`
      + `因此排名反而在第 ${row.rank} 名。`;
  }
  return null;
}

/**
 * 判定資金流向（inflow / outflow / neutral）。
 *
 * 為什麼不能只看 momentum > 100：
 *   RRG 的軸以 100 為中性，但剛從落後象限翻上來的版塊
 *   momentum 可能已 > 100（改善中），卻仍在落後象限（ratio < 100）。
 *   這種「動能轉正但位置還低」的狀態，解讀上是「資金開始流入」，
 *   而不是「已在流入」。因此流向必須結合**動能方向**與**位置變化**。
 *
 * 規則：
 *   inflow  = momentum > 100 且 ratio 較尾跡起點上升（位置也在改善）
 *   outflow = momentum < 100 且 ratio 較尾跡起點下降
 *   neutral = 其餘（動能與位置背離，或皆在中性附近）
 */
function flowOf(point) {
  if (!point) return { flow: 'neutral', flowBasis: '資料不足' };
  const mom = Number.isFinite(point.momentum) ? point.momentum : 100;
  const ratio = Number.isFinite(point.ratio) ? point.ratio : 100;

  const trail = point.trail || [];
  const first = trail.length ? trail[0] : null;
  const ratioDelta = first && Number.isFinite(first.ratio) ? +(ratio - first.ratio).toFixed(2) : null;

  if (mom > 100 && (ratioDelta == null || ratioDelta > 0)) {
    return {
      flow: 'inflow',
      flowBasis: ratioDelta != null
        ? `動能 ${mom.toFixed(1)} > 100，且強度較尾跡起點上升 ${ratioDelta.toFixed(2)}`
        : `動能 ${mom.toFixed(1)} > 100，資金持續流入`,
    };
  }
  if (mom < 100 && (ratioDelta == null || ratioDelta < 0)) {
    return {
      flow: 'outflow',
      flowBasis: ratioDelta != null
        ? `動能 ${mom.toFixed(1)} < 100，且強度較尾跡起點下降 ${Math.abs(ratioDelta).toFixed(2)}`
        : `動能 ${mom.toFixed(1)} < 100，資金持續流出`,
    };
  }
  return {
    flow: 'neutral',
    flowBasis: `動能 ${mom.toFixed(1)} 與位置變化 ${ratioDelta == null ? '未知' : ratioDelta.toFixed(2)} 方向不一致，暫無明確流向`,
  };
}

/* ============================================================
   宏觀快照整理
   ============================================================ */

/**
 * 把 FRED 的 series 陣列整理成本模組要的形狀。
 *
 * 只取 8 條，缺的標 `available:false` 而不是消失——
 * 「這裡本來該有資料但拿不到」與「這裡沒有這個指標」是兩件事。
 */
function buildMacroSnapshot(seriesList) {
  const byKey = {};
  for (const s of seriesList || []) if (s && s.key) byKey[s.key] = s;

  const out = [];
  for (const def of MACRO_LINKS) {
    const s = byKey[def.key];
    if (!s || !s.available) {
      out.push({
        key: def.key,
        label: def.label,
        short: def.short,
        available: false,
        reason: (s && (s.reason || s.unavailable)) || '未取得此序列',
        unit: null,
        value: null,
        asOf: null,
        percentile: null,
        change: null,
        direction: null,
        source: 'FRED',
      });
      continue;
    }

    /* direction 的判定必須用「變化量」，不能用「數值高低」。
       例如失業率 4.1% 是「低」，但若較上期上升 0.1，
       方向是「上行」。混淆這兩者會讓整段關聯說明講反。 */
    const chg = s.stats && Number.isFinite(s.stats.change) ? s.stats.change : null;
    // 死區：變化量太小時視為持平，避免把 0.001 的雜訊講成趨勢
    const deadband = macroDeadband(def.key);
    let direction = 'flat';
    if (chg != null) {
      if (chg > deadband) direction = 'up';
      else if (chg < -deadband) direction = 'down';
    }

    out.push({
      key: def.key,
      label: def.label,
      short: def.short,
      available: true,
      unit: s.unit || '',
      value: s.value,
      asOf: s.asOf,
      percentile: s.stats && Number.isFinite(s.stats.percentile) ? s.stats.percentile : null,
      prev: s.stats && Number.isFinite(s.stats.prev) ? s.stats.prev : null,
      change: chg,
      direction,
      changeWindow: s.freq === 'M' ? '較上期' : (s.freq === 'D' ? '較前一交易日' : '較上期'),
      source: s.source || 'FRED',
      sourceUrl: s.sourceUrl || null,
      freq: s.freq || null,
    });
  }
  return out;
}

/** 各指標的「變化量死區」門檻（低於此視為持平） */
function macroDeadband(key) {
  const map = {
    fedTargetUpper: 0.01, fedTargetLower: 0.01,
    dgs10: 0.02, dgs2: 0.02, dgs30: 0.02, realYield10: 0.02,
    termSpread: 0.02,
    cpiYoy: 0.05, coreCpiYoy: 0.05,
    unrate: 0.05, indpro: 0.05,
  };
  return map[key] == null ? 0.02 : map[key];
}

/* ============================================================
   規則層：宏觀 ↔ 版塊 關聯
   ============================================================ */

/**
 * 依宏觀方向與版塊實際表現，產生關聯說明。
 *
 * 關鍵設計：**每一條 thesis 都會標明它與市場實際表現是「印證」還是「背離」**。
 * 只寫理論（「利率下行利多科技股」）是沒有價值的通用廢話；
 * 寫「理論上利多，但科技版塊實際仍在落後象限，代表市場已定價其他因素」
 * 才是分析。
 */
function buildMacroLinks(macroSnap, ranking) {
  const rankByKey = {};
  for (const r of ranking) rankByKey[r.key] = r;

  const links = [];
  for (const def of MACRO_LINKS) {
    const m = macroSnap.find((x) => x.key === def.key);
    if (!m || !m.available) {
      links.push({
        indicator: def.key,
        label: def.label,
        short: def.short,
        available: false,
        reason: m ? m.reason : '未取得',
        thesis: null,
        supports: [],
        pressures: [],
        confidence: null,
        basis: 'none',
        verdict: 'unknown',
      });
      continue;
    }

    const up = m.direction === 'up';
    const down = m.direction === 'down';
    const dirKey = up ? 'up' : (down ? 'down' : null);

    // 方向為 flat 時，沒有「支撐/壓力」可言，但理論仍然可說明
    const supports = dirKey ? (def.supportsWhen[dirKey] || []) : [];
    const pressures = dirKey ? (def.pressuresWhen[dirKey] || []) : [];

    const thesisBase = (def.thesis.inverse && def.thesis.direct)
      ? (up ? (def.thesis.inverse || def.thesis.direct) : (def.thesis.direct || def.thesis.inverse))
      : (def.thesis.inverse || def.thesis.direct || '');

    /* 觀點檢核：把理論支撐/壓力清單與「實際排名」對照，得出印證／背離。
       這是本區塊最有價值的一步 —— 見檔案開頭關於「背離才是訊號」的說明。 */
    const verdict = judgeLink(supports, pressures, rankByKey, ranking.length);

    const dirCn = { up: '上行', down: '下行', flat: '持平' }[m.direction] || '未知';
    const changeCn = m.change == null ? '' : `（${m.change > 0 ? '+' : ''}${trimNum(m.change)}${m.unit && m.unit.includes('%') ? ' 個百分點' : ''}）`;

    links.push({
      indicator: def.key,
      label: def.label,
      short: def.short,
      available: true,
      value: m.value,
      unit: m.unit,
      asOf: m.asOf,
      percentile: m.percentile,
      change: m.change,
      direction: m.direction,
      directionCn: dirCn,
      changeCn,
      changeWindow: m.changeWindow,
      thesis: thesisBase,
      // 具體到「誰受益、誰受壓」，且附上實際排名，讓使用者能自行核對
      supports: supports.map((k) => rankBrief(rankByKey[k])).filter(Boolean),
      pressures: pressures.map((k) => rankBrief(rankByKey[k])).filter(Boolean),
      confidence: verdict.consistent ? def.confidence : lowerConfidence(def.confidence),
      basis: 'rule',
      verdict: verdict.consistent ? 'consistent' : 'divergent',
      verdictNote: verdict.note,
      source: 'FRED',
      sourceUrl: m.sourceUrl,
    });
  }
  return links;
}

/** 版塊的簡短摘要（排名 + 象限 + 流向），供 chips 顯示 */
function rankBrief(r) {
  if (!r) return null;
  return {
    key: r.key,
    label: r.label,
    short: r.short,
    rank: r.rank,
    quadrant: r.quadrant,
    quadrantLabel: r.quadrantLabel,
    strengthScore: r.strengthScore,
  };
}

/**
 * 檢核「理論上該受益的版塊」是否真的排名較前、該受壓的是否真的較後。
 *
 * 判定方式：取 supports 的平均排名與 pressures 的平均排名比較。
 * 若 supports 平均排名明顯優於 pressures（差距 ≥ 2 名），視為印證；
 * 若反過來（pressures 反而更前），視為背離。
 *
 * 為什麼用排名差而不是相關係數：這裡只有 2–4 個版塊、單一時間點，
 * 跑相關係數在統計上不成立（樣本太少會給出誤導性的高相關）。
 * 排名差是粗但有意义的判準，且完全可解釋。
 */
function judgeLink(supports, pressures, rankByKey, total) {
  if (!supports.length || !pressures.length) {
    return { consistent: true, note: null }; // 單邊清單無從比較，不宣稱背離
  }
  const avg = (arr) => {
    const rs = arr.map((k) => (rankByKey[k] ? rankByKey[k].rank : null)).filter((x) => x != null);
    if (!rs.length) return null;
    return rs.reduce((a, b) => a + b, 0) / rs.length;
  };
  const sAvg = avg(supports);
  const pAvg = avg(pressures);
  if (sAvg == null || pAvg == null) return { consistent: true, note: null };

  const diff = pAvg - sAvg; // 正值代表 supports 排名較前（數字小）
  if (diff >= 2) {
    return { consistent: true, note: `理論受益版塊平均排名 ${sAvg.toFixed(1)}，受壓版塊 ${pAvg.toFixed(1)}，與市場表現一致。` };
  }
  if (diff <= -2) {
    return {
      consistent: false,
      note: `理論受益版塊平均排名 ${sAvg.toFixed(1)}，反而落後於理論受壓版塊 ${pAvg.toFixed(1)}——市場尚未反映此指標，或已被其他因素主導。`,
    };
  }
  return { consistent: true, note: `理論受益與受壓版塊排名接近（${sAvg.toFixed(1)} vs ${pAvg.toFixed(1)}），此指標目前解釋力有限。` };
}

function lowerConfidence(c) {
  return c === 'high' ? 'medium' : 'low';
}

function trimNum(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/* ============================================================
   規則層：輪動敘述
   ============================================================ */

/**
 * 由排名產生輪動敘述（不經 LLM，確保每次相同）。
 *
 * 內容結構：目前相位 → 領先與落後的具體版塊 → 正在改善的接力者。
 */
function buildNarrative(ranking, rrgMeta) {
  if (!ranking.length) return '目前無版塊資料，無法判讀輪動。';

  const lead = ranking.filter((r) => r.quadrant === 'leading');
  const weak = ranking.filter((r) => r.quadrant === 'weakening');
  const lag = ranking.filter((r) => r.quadrant === 'lagging');
  const imp = ranking.filter((r) => r.quadrant === 'improving');
  const top = ranking[0];
  const bottom = ranking[ranking.length - 1];

  const parts = [];
  parts.push(`以${rrgMeta && rrgMeta.timeframeLabel ? rrgMeta.timeframeLabel : '週線'}觀察，`
    + `目前最強的是${top.label}（強弱分數 ${top.strengthScore}，第 ${top.rank} 名，`
    + `位於「${top.quadrantLabel}」象限）；最弱的是${bottom.label}`
    + `（${bottom.strengthScore}，第 ${bottom.rank} 名，「${bottom.quadrantLabel}」）。`);

  const qCount = `領先 ${lead.length} 個、弱化 ${weak.length} 個、落後 ${lag.length} 個、改善 ${imp.length} 個`;
  parts.push(`四象限分布為：${qCount}。`);

  if (imp.length) {
    parts.push(`值得注意的是${imp.map((r) => r.label).join('、')}位於「改善」象限，`
      + '代表相對強度雖仍低於基準，但動能已轉正，是下一輪輪動的潛在接力者。');
  }
  if (weak.length) {
    parts.push(`${weak.map((r) => r.label).join('、')}處於「弱化」象限，`
      + '相對強度仍在水準之上但動能轉負，需留意資金流出的延續性。');
  }
  if (!lead.length && !imp.length) {
    parts.push('目前沒有版塊處於領先或改善象限，整體呈防禦格局。');
  }

  return parts.join('');
}

/* ============================================================
   LLM 敘述強化
   ============================================================ */

const OUTPUT_SCHEMA_HINT = `{
  "rotationNarrative": "繁體中文 150–250 字，說明目前輪動相位與誰在接力",
  "macroLinks": [{"indicator":"<必須是我提供的 key>","thesis":"繁體中文，說明這個指標如何傳導到版塊","confidence":"high|medium|low"}],
  "consistency": {"verdict":"consistent|divergent|unclear","note":"繁體中文，指出印證或背離在哪"},
  "watchpoints": ["繁體中文 1–3 條，接下來該看什麼才會證實或推翻上述判讀"],
  "caveats": ["資料不足之處"]
}`;

function buildPrompt(p) {
  const input = {
    輪動參數: p.rrgMeta,
    版塊排名: p.ranking.map((r) => ({
      rank: r.rank,
      label: r.label,
      strengthScore: r.strengthScore,
      ratio: r.ratio,
      momentum: r.momentum,
      quadrant: r.quadrantLabel,
      flow: r.flow,
      flowBasis: r.flowBasis,
      高於基準: r.aboveBenchmark,
      // 系統已判定的落差說明：餵給模型是為了避免它自己編一套解釋，
      // 也是為了讓它在敘述裡正確處理「排名與象限不同調」的情況
      排名象限落差: r.rankNote || null,
    })),
    宏觀指標: p.macroLinks.filter((l) => l.available).map((l) => ({
      key: l.indicator,
      label: l.label,
      value: l.value,
      unit: l.unit,
      asOf: l.asOf,
      變化: l.change,
      方向: l.directionCn,
      歷史百分位: l.percentile,
      理論上支撐: l.supports.map((s) => s.label),
      理論上受壓: l.pressures.map((s) => s.label),
      目前判定: l.verdict,
    })),
    規則層敘述: p.ruleNarrative,
  };

  return [
    '你是一位宏觀策略分析師。以下是我**已經算好**的版塊輪動排名與宏觀指標快照。',
    '請據此說明「宏觀條件如何傳導到版塊輪動」，並判斷兩者是否互相印證。',
    '',
    '嚴格規則（違反會導致輸出被丟棄）：',
    '1. 只能使用我提供的數字，**絕對不可新增、推算或估計任何數值**。',
    '2. 版塊排名與強弱分數**已由系統計算完成，不可重新排序或質疑數字本身**。',
    '3. 不可預測版塊未來報酬、不可建議配置比例、不可給出進出場時機。',
    '4. `macroLinks[].indicator` 必須是我提供清單中的 key，不可自創。',
    '5. 若市場表現與宏觀理論背離，**必須明確指出背離**，不可粉飾成「大致符合」。',
    '6. 宏觀指標的「歷史百分位」代表目前水位在歷史上的相對位置，'
      + '高百分位不等於「會下跌」，只能說「處於歷史高位」。切勿把水位當成方向預測。',
    '7. 「強弱分數」是同期版塊間的相對排名，「象限」是相對基準（SPY）的絕對位置，'
      + '兩者可能不同調。若某版塊的 `排名象限落差` 有值，**必須照它說明**，'
      + '不要自行另編一套理由，也不要把「排名靠後」誤說成「弱於大盤」。',
    '7. 「強弱分數」是同期版塊間的相對排名，「象限」是相對基準（SPY）的絕對位置，'
      + '兩者可能不同調。若某版塊的 `排名象限落差` 有值，**必須照它說明**，'
      + '不要自行另編一套理由，也不要把「排名靠後」誤說成「弱於大盤」。',
    '8. 一律使用繁體中文（台灣用語），不可使用簡體字。',
    '9. 每一條 `macroLinks[].thesis` **必須引用該指標的實際數值、方向或百分位**'
      + '（例如「實質殖利率 2.79%、百分位 99.1」）。'
      + '只寫通用理論、不含任何數字的句子會被丟棄。',
    '10. 只輸出 JSON 物件，不要任何說明文字、不要 markdown 圍欄。',
    '',
    '輸出格式：',
    OUTPUT_SCHEMA_HINT,
    '',
    '輸入資料：',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

/**
 * 驗證並整合 LLM 輸出。
 *
 * 與個股分析相同的立場：**排名永遠用後端算好的**，
 * LLM 只能補充 thesis 文字與 overall 判讀，不能改動數字。
 */
function mergeLlmNarrative(base, raw, prompt) {
  const adjusted = [];
  const out = { ...base };

  // 白名單：所有餵入的數字 + prompt 全文
  const known = new Set();
  llm.collectNumbers(JSON.stringify(base), known);
  llm.collectNumbers(prompt, known);

  /* --- rotationNarrative --- */
  const nar = String(raw.rotationNarrative == null ? '' : raw.rotationNarrative).trim();
  if (nar) {
    const audit = llm.auditNumbers(nar, known, 3);
    const banned = /建議(買|賣|配置|加碼|減碼)|目標價|會漲|會跌|預測.*(漲|跌)/.test(nar);
    if (banned) {
      adjusted.push('rotationNarrative（含買賣建議或價格預測，已保留規則層版本）');
    } else if (!audit.ok) {
      adjusted.push(`rotationNarrative（引用 ${audit.suspect.length} 個來源外的數字，已保留規則層版本）`);
    } else {
      out.rotationNarrative = nar;
    }
  } else {
    adjusted.push('rotationNarrative（為空）');
  }

  /* --- macroLinks：只允許覆寫既有 indicator 的 thesis，不可新增指標 --- */
  const byKey = {};
  for (const l of out.macroLinks) byKey[l.indicator] = l;

  const llmLinks = Array.isArray(raw.macroLinks) ? raw.macroLinks : [];
  let overridden = 0;
  const unknownKeys = [];
  for (const cl of llmLinks) {
    const key = String((cl && cl.indicator) || '').trim();
    if (!byKey[key]) { if (key) unknownKeys.push(key); continue; }
    const target = byKey[key];
    const thesis = String((cl && cl.thesis) || '').trim();
    if (!thesis) continue;
    // 理論文字同樣要做數字稽核：模型很愛在理論段落偷塞統計數字
    const audit = llm.auditNumbers(thesis, known, 2);
    if (!audit.ok) { adjusted.push(`macroLinks.${key}.thesis（引用來源外數字）`); continue; }
    /* 必須引用至少一個具體數字，否則就是通用教科書文字。
       實測：模型對「核心 CPI」「政策利率」會吐「通膨黏著會延後降息，
       對高評價版塊構成壓力」這類沒有數字的句子 —— 這段話每次渲染都一樣，
       既不反映當期水位也不反映實際排名，等於沒有分析。
       規則層的 thesis 雖然也是預寫的，但它有明確的方向語義（inverse/direct）
       且搭配 verdictNote 一起呈現，資訊量大於模型的空泛版本。 */
    if (!/\d/.test(thesis)) {
      adjusted.push(`macroLinks.${key}.thesis（未引用任何數據，保留規則層文字）`);
      continue;
    }
    target.thesis = thesis;
    target.basis = 'llm';
    const c = String((cl && cl.confidence) || '').toLowerCase();
    if (['high', 'medium', 'low'].includes(c)) target.confidence = c;
    overridden++;
  }
  if (unknownKeys.length) {
    adjusted.push(`macroLinks（含 ${unknownKeys.length} 個未知指標 key：${unknownKeys.slice(0, 3).join('、')}）`);
  }
  out.macroLinks = out.macroLinks.map((l) => byKey[l.indicator] || l);

  /* --- consistency --- */
  const cons = raw.consistency || {};
  const cv = String(cons.verdict || '').toLowerCase();
  const note = String(cons.note || '').trim();
  if (['consistent', 'divergent', 'unclear'].includes(cv)) {
    out.consistency = {
      verdict: cv,
      note: note || out.consistency.note,
      basis: 'llm',
    };
    if (note && !llm.auditNumbers(note, known, 2).ok) {
      out.consistency.note = out.consistency.note; // 保留規則層 note
      out.consistency.basis = 'rule';
      adjusted.push('consistency.note（引用來源外數字）');
    }
  } else if (note) {
    adjusted.push('consistency.verdict（值不合法，已保留規則層結論）');
  }

  /* --- watchpoints --- */
  const wp = Array.isArray(raw.watchpoints) ? raw.watchpoints : [];
  const cleanWp = wp.map((w) => String(w || '').trim())
    .filter((w) => w && llm.auditNumbers(w, known, 1).ok)
    .slice(0, 3);
  if (cleanWp.length) out.watchpoints = cleanWp;

  /* --- caveats --- */
  const cv2 = Array.isArray(raw.caveats) ? raw.caveats : [];
  const cleanCv = cv2.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 5);
  if (cleanCv.length) out.caveats = [...new Set([...out.caveats, ...cleanCv])].slice(0, 6);

  out.adjusted = adjusted;
  out.llmOverriddenLinks = overridden;
  return out;
}

/* ============================================================
   一致性裁決（規則層）
   ============================================================ */

/**
 * 綜合判定「輪動」與「宏觀」是否互相印證。
 *
 * 做法：統計所有 macroLinks 的 verdict（consistent / divergent），
 * 加權後給出整體結論。權重用 confidence：高信心指標的背離比
 * 低信心指標的背離更值得注意。
 */
function judgeConsistency(macroLinks) {
  const live = macroLinks.filter((l) => l.available && l.verdict && l.verdict !== 'unknown');
  if (!live.length) {
    return { verdict: 'unclear', note: '宏觀指標不足，無法判斷與輪動是否一致。', basis: 'rule' };
  }
  const w = { high: 1, medium: 0.6, low: 0.3 };
  let consW = 0;
  let divW = 0;
  const divNames = [];
  for (const l of live) {
    const ww = w[l.confidence] || 0.3;
    if (l.verdict === 'divergent') { divW += ww; divNames.push(l.short); }
    else consW += ww;
  }
  const total = consW + divW;
  if (!total) return { verdict: 'unclear', note: '宏觀指標信心不足，無法判斷。', basis: 'rule' };

  if (divW / total >= 0.4) {
    return {
      verdict: 'divergent',
      note: `有 ${divNames.length} 項指標（${divNames.join('、')}）的理論方向與版塊實際表現背離。`
        + '這種背離通常意味市場正在定價其他因素，或指標的傳導存在時間差；'
        + '不宜單純依宏觀方向推斷版塊強弱。',
      basis: 'rule',
    };
  }
  return {
    verdict: 'consistent',
    note: '多數宏觀指標的理論方向與版塊實際排名一致，輪動可由基本面條件解釋。',
    basis: 'rule',
  };
}

/* ============================================================
   觀察重點（規則層）
   ============================================================ */

function buildWatchpoints(ranking, macroLinks, consistency) {
  const out = [];

  const imp = ranking.filter((r) => r.quadrant === 'improving');
  if (imp.length) {
    out.push(`${imp.map((r) => r.label).join('、')}能否從「改善」進入「領先」象限`
      + '（需 RS-Ratio 站上 100），是下一階段輪動的確認訊號。');
  }

  const weak = ranking.filter((r) => r.quadrant === 'weakening');
  if (weak.length) {
    out.push(`${weak.map((r) => r.label).join('、')}若跌破 100 軸將轉入「落後」，`
      + '可作為資金撤出的觀察點。');
  }

  const div = macroLinks.filter((l) => l.available && l.verdict === 'divergent');
  if (div.length) {
    out.push(`${div.map((l) => l.short).join('、')}與版塊表現背離，`
      + '後續若開始收斂，代表宏觀傳導正在生效。');
  }

  if (consistency.verdict === 'divergent') {
    out.push('在背離收斂之前，不宜以單一宏觀指標推斷版塊方向。');
  }

  return out.slice(0, 3);
}

/* ============================================================
   主流程
   ============================================================ */

/**
 * 產生版塊輪動 × 宏觀關聯分析。
 *
 * @param {object} opts
 * @param {object} opts.rrg     lib/rrg 的 buildRRG 輸出（或 /api/rrg 回應）
 * @param {Array}  [opts.macroSeries] FRED series 陣列（不給則自行取）
 * @param {string} [opts.mode]  'auto' | 'rule'
 * @param {object} [opts.llmCfg]
 * @param {boolean} [opts.refresh]
 */
async function analyzeSectorMacro(opts) {
  const o = opts || {};
  const mode = String(o.mode || 'auto').toLowerCase();
  const wantLlm = mode !== 'rule';

  const rrgData = o.rrg;
  if (!rrgData || !Array.isArray(rrgData.points)) {
    const e = new Error('缺少輪動資料（rrg.points）');
    e.code = 'NO_RRG';
    throw e;
  }

  const key = `sec-macro:${rrgData.timeframe || 'weekly'}|${rrgData.benchmark || 'SPY'}|${mode}`;
  if (!o.refresh) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, cached: true };
  }

  /* --- 1. 排名（純函式，完全可重現） --- */
  const ranked = rankSectors(rrgData.points);
  const ranking = ranked.map((r) => ({ ...r, ...flowOf(rrgData.points.find((p) => p.key === r.key)) }));
  for (const r of ranking) { delete r._rPct; delete r._mPct; }

  /* --- 2. 宏觀快照 --- */
  let seriesList = o.macroSeries;
  let macroError = null;
  if (!seriesList) {
    try {
      const fred = require('./fred');
      seriesList = await fred.getMany(MACRO_KEYS);
    } catch (e) {
      macroError = e.message;
      seriesList = [];
    }
  }
  const macroSnap = buildMacroSnapshot(seriesList);
  const macroAvailable = macroSnap.filter((m) => m.available).length;

  /* --- 3. 宏觀關聯（規則層） --- */
  const macroLinks = buildMacroLinks(macroSnap, ranking);

  /* --- 4. 規則層敘述與裁決 --- */
  const rrgMeta = {
    timeframe: rrgData.timeframe,
    timeframeLabel: rrgData.timeframeLabel,
    window: rrgData.window,
    windowLabel: rrgData.windowLabel,
    benchmark: rrgData.benchmark,
    benchmarkLabel: rrgData.benchmarkLabel,
    asOf: rrgData.asOf,
  };
  const ruleNarrative = buildNarrative(ranking, rrgMeta);
  const consistency = judgeConsistency(macroLinks);

  let base = {
    rotationNarrative: ruleNarrative,
    macroLinks,
    consistency,
    watchpoints: buildWatchpoints(ranking, macroLinks, consistency),
    caveats: buildCaveats(macroSnap, macroAvailable, ranking, rrgData),
    adjusted: [],
  };

  /* --- 5. LLM 強化 --- */
  let aiMode = 'rule';
  let llmMeta = null;
  let llmNote = null;

  if (wantLlm && macroAvailable > 0 && ranking.length > 0) {
    const prompt = buildPrompt({ rrgMeta, ranking, macroLinks, ruleNarrative });
    const res = await llm.callLlm({ prompt, cfg: o.llmCfg, json: true, temperature: 0.2 });
    if (res.ok && res.json && typeof res.json === 'object') {
      base = mergeLlmNarrative(base, res.json, prompt);
      aiMode = 'llm';
      llmMeta = {
        model: (o.llmCfg && o.llmCfg.model) || llm.loadLlmConfig().model || null,
        via: res.via,
      };
    } else {
      llmNote = res.note || 'LLM 未成功，改用規則層敘述';
    }
  } else if (wantLlm) {
    llmNote = macroAvailable === 0
      ? '宏觀指標全部不可用，僅提供輪動排名（規則層）'
      : '無輪動資料，無法產生關聯分析';
  }

  const hantOk = aiMode === 'llm'
    ? llm.looksHant(JSON.stringify({ n: base.rotationNarrative, l: base.macroLinks.map((x) => x.thesis) }))
    : true;

  /* --- 6. 組裝 --- */
  const out = {
    ok: true,
    timeframe: rrgData.timeframe,
    timeframeLabel: rrgData.timeframeLabel,
    window: rrgData.window,
    benchmark: rrgData.benchmark,
    rotationAsOf: rrgData.asOf,
    ai: {
      mode: aiMode,
      note: llmNote,
      rotationNarrative: base.rotationNarrative,
      consistency: base.consistency,
      watchpoints: base.watchpoints,
      caveats: base.caveats,
      adjusted: base.adjusted || [],
      llmOverriddenLinks: base.llmOverriddenLinks || 0,
    },
    ranking,
    macroLinks: base.macroLinks,
    macroSnapshot: macroSnap,
    provenance: {
      rotationAsOf: rrgData.asOf,
      rotationParams: {
        timeframe: rrgData.timeframe,
        timeframeLabel: rrgData.timeframeLabel,
        window: rrgData.window,
        benchmark: rrgData.benchmark,
        period: rrgData.period,
        trail: rrgData.trail,
      },
      macroWindow: {
        from: minAsOf(macroSnap),
        to: maxAsOf(macroSnap),
        available: macroAvailable,
        total: macroSnap.length,
      },
      sources: [
        { id: 'yahoo-chart', name: 'Yahoo Finance（版塊 ETF 復權日線）', role: '輪動計算基礎' },
        { id: 'fred', name: 'FRED（聖路易斯聯準銀行）', role: '宏觀指標' },
      ].concat(aiMode === 'llm' ? [{
        id: 'llm', name: llmMeta ? llmMeta.model : 'LLM', role: '關聯敘述',
      }] : []),
      aiMode,
      aiModel: aiMode === 'llm' && llmMeta ? llmMeta.model : null,
      generatedAt: new Date().toISOString(),
      degraded: macroError ? [{ source: 'fred', message: macroError }] : [],
      hantOk,
    },
    generatedAt: new Date().toISOString(),
  };

  if (aiMode === 'llm') cacheSet(key, out);
  return { ...out, cached: false };
}

function buildCaveats(macroSnap, available, ranking, rrgData) {
  const out = [];
  if (available === 0) out.push('宏觀指標全部不可用，本區塊僅呈現輪動排名。');
  else if (available < macroSnap.length) {
    out.push(`宏觀指標僅 ${available}/${macroSnap.length} 項可用，關聯說明可能不完整。`);
  }
  if (ranking.length < 11) {
    out.push(`本次僅取得 ${ranking.length} 個版塊（應為 11），排名比較的完整性受限。`);
  }
  if (rrgData.adjFallback && rrgData.adjFallback.length) {
    out.push(`${rrgData.adjFallback.join('、')} 缺少復權價，相對強度可能失真。`);
  }
  out.push('強弱分數為同期版塊間的相對位置（0–100），非絕對報酬，不可跨不同基準指數比較。');
  out.push('宏觀指標與版塊的關聯為理論傳導關係，非因果證明；實際傳導可能受時間差與其他因素干擾。');
  return out;
}

function minAsOf(list) {
  const ds = list.filter((m) => m.available && m.asOf).map((m) => m.asOf);
  return ds.length ? ds.sort()[0] : null;
}

function maxAsOf(list) {
  const ds = list.filter((m) => m.available && m.asOf).map((m) => m.asOf);
  return ds.length ? ds.sort()[ds.length - 1] : null;
}

/* ============================================================
   快取
   ============================================================ */

const AI_TTL_MS = 30 * 60 * 1000;
const store = new Map();

function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > AI_TTL_MS) { store.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  store.set(key, { at: Date.now(), value });
  if (store.size > 40) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20);
    for (const [k] of oldest) store.delete(k);
  }
}

function resetCache() { store.clear(); }

module.exports = {
  analyzeSectorMacro,
  rankSectors,
  flowOf,
  buildMacroSnapshot,
  buildMacroLinks,
  buildNarrative,
  judgeConsistency,
  buildWatchpoints,
  buildPrompt,
  mergeLlmNarrative,
  MACRO_LINKS,
  MACRO_KEYS,
  resetCache,
  AI_TTL_MS,
};
