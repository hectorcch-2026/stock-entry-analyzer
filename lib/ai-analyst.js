'use strict';

/**
 * 個股「新聞 + AI」綜合研判
 * ==========================
 *
 * 輸入：新聞（已分級去重）＋ 個股價格脈絡 ＋ 技術立場 ＋ 版塊歸屬
 * 輸出：固定 schema（見 docs/新聞與AI分析_資料契約與來源策略.md §2.2）
 *
 * ── 三個設計決定，以及為什麼 ─────────────────────────────
 *
 * ① **規則層是完整的，不是殘缺的替代品**
 *    本專案的立場是「無金鑰也要能用」。若規則層只回一句「請設定 API Key」，
 *    整塊就變空殼。因此規則層輸出與 LLM 版**完全相同 schema**，
 *    前端只有一條渲染路徑。詞表計分雖不如 LLM 細膩，但它是可重現、可稽核的。
 *
 * ② **模型不得自行取數，且輸出必須通過三重後置檢查**
 *    - 數字白名單：輸出引用的小數必須來自我們餵入的內容
 *    - sentiment/score 一致性：`positive` 必須 score > 0.15，否則後端校正並記錄
 *    - weight 總和：drivers 權重和須在 1±0.02，否則整欄丟棄（不縮放偽裝）
 *    這三項都是實測踩過的坑，見 lib/llm.js 檔案開頭。
 *
 * ③ **禁止目標價與擇時**
 *    本專案全站立場是「不構成投資建議」。模型若吐出目標價或「明天該買」，
 *    整段 priceImpact 丟棄並記錄，而不是過濾掉那一句就放行
 *    （因為一句被抽掉的論述，其餘部分通常也已被帶偏）。
 */

const llm = require('./llm');
const newsHub = require('./news-hub');

/* ============================================================
   情緒詞表（規則層用）
   ------------------------------------------------------------
   刻意做成「小而精」而不是大詞典：
     - 只收對股價方向有明確含義的詞
     - 避免中性財經常用詞（如 "report"、"quarter"、"shares"）
     - 否定詞另處理，不靠詞表本身
   ============================================================ */

const POS_WORDS = [
  'beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps',
  'record high', 'all-time high', 'upgrade', 'upgrades', 'raised', 'raises guidance',
  'outperform', 'strong', 'robust', 'growth', 'expands', 'expansion', 'profit rises',
  'better than expected', 'tops estimates', 'buyback', 'dividend increase', 'wins',
  'approval', 'approved', 'breakthrough', 'partnership', 'deal', 'contract win',
  'optimistic', 'bullish', 'upside', 'gains', 'climbs', 'rebounds', 'recovery',
  'accelerat', 'momentum', 'record revenue', 'demand surge', 'price target raised',
  /* 以下為實測補齊：真實財經標題常用但原表未收的表達 */
  'wins approval', 'secures', 'expands into', 'ramps up', 'outpaces', 'top estimates',
  'profit jumps', 'revenue beats', 'margin expansion', 'raises outlook', 'raises forecast',
  'positive', 'favorable', 'tailwind', 'well-positioned', 'dominant', 'leader',
  'safe haven', 'defies', 'resilient', 'upside potential', 'attractive', 'undervalued',
  'free cash flow', 'cash-rich', 'buyback program', 'special dividend', 'record',
  'milestone', 'landmark', 'wins back', 'turnaround', 'reaccelerat', 'blowout',
];

const NEG_WORDS = [
  'miss', 'misses', 'plunge', 'plunges', 'slump', 'slumps', 'tumble', 'tumbles',
  'sink', 'sinks', 'fall', 'falls', 'drop', 'drops', 'decline', 'declines',
  'downgrade', 'downgrades', 'cut', 'cuts guidance', 'warns', 'warning', 'weak',
  'weakness', 'layoff', 'layoffs', 'lawsuit', 'probe', 'investigation', 'fine',
  'penalty', 'recall', 'shortfall', 'below expectations', 'worse than expected',
  'bearish', 'downside', 'loss', 'losses', 'loss widens', 'delay', 'delays',
  'halt', 'halts', 'suspend', 'suspended', 'resign', 'resigns', 'ousted',
  'antitrust', 'sanction', 'sanctions', 'tariff', 'tariffs', 'ban', 'banned',
  'sell-off', 'selloff', 'slashes', 'slashed', 'impairment', 'write-down',
  /* 以下為實測補齊 */
  'risk', 'risky', 'concern', 'concerns', 'overhang', 'overhangs', 'headwind',
  'headwinds', 'overvalued', 'expensive valuation', 'pressure', 'pressures',
  'strain', 'strains', 'outage', 'outages', 'glitch', 'failure', 'fails',
  'slowdown', 'slowing', 'stagnant', 'underperform', 'underweight', 'sell rating',
  'downturn', 'deteriorat', 'drops below', 'falls below', 'cuts jobs', 'shutdown',
  'short seller', 'shorting', 'bubble', 'correction', 'warning sign', 'flags',
  'sold by', 'reduces', 'trimmed', 'cuts stake', 'exodus', 'loss of', 'scrutiny',
];

/** 否定詞：出現在情緒詞前 3 個詞內則翻轉極性 */
const NEGATORS = ['not', 'no', 'never', 'without', 'unlikely', 'denies',
  'fails to', 'fail to', 'failed to', 'no longer'];

/**
 * 找出情緒詞在文字中的位置（詞界比對），回傳所有命中索引。
 *
 * 為什麼不用 indexOf：'beat' 會命中 'beatles'；'cut' 會命中 'executive'。
 * 單詞必須用詞界，片語才可以直接 includes。
 */
function findWord(text, word) {
  const t = String(text || '').toLowerCase();
  if (word.includes(' ')) {
    const out = [];
    let i = t.indexOf(word);
    while (i >= 0) { out.push(i); i = t.indexOf(word, i + 1); }
    return out;
  }
  const re = new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    // 命中的起點要加上前綴詞長度，才是詞本身的位置
    out.push(m.index + m[1].length);
    // 避免零寬匹配造成無限迴圈
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

/**
 * 判斷某個詞在該位置是否被否定。
 *
 * 兩個條件同時成立才算被否定：
 *   ① 否定詞出現在**前 3 個詞內**
 *   ② 否定詞與該詞之間**沒有轉折連詞**（but / however / yet / though / while）
 *
 * 第 ② 條是實測必需的。考慮 "Apple not beats but misses revenue"：
 *   - 用 40 字元窗口：`not` 同時否定 beats 與 misses → 正負抵銷成 0（錯）
 *   - 只看前 3 詞：misses 的前 3 詞 = [not, beats, but] 仍含 not → 誤否定（錯）
 *   - 加上轉折詞切斷：`but` 之後極性重置，misses 不再被 not 否定（正確）
 * 語意上這是對的：「不是 A 而是 B」的 B 不受前面的否定詞影響。
 *
 * 為什麼是 3 個詞：多詞否定片語（"no longer a strong buy"、"fails to beat"）
 * 需要跨 2–3 個詞才抓得到。2 個詞會漏掉 "no longer a"。
 */
const CONTRAST_WORDS = ['but', 'however', 'yet', 'though', 'although', 'while', 'whereas'];

function isNegatedAt(text, index) {
  const t = String(text || '').toLowerCase();
  const before = t.slice(0, index).trim();
  if (!before) return false;
  const words = before.split(/[^a-z']+/).filter(Boolean).slice(-3);
  if (!words.length) return false;

  // 轉折詞之後的否定詞不算數（極性已重置）
  const lastContrast = words.reduce((acc, w, i) => (CONTRAST_WORDS.includes(w) ? i : acc), -1);
  const scope = words.slice(lastContrast + 1);
  if (!scope.length) return false;

  const joined = scope.join(' ');
  if (NEGATORS.some((n) => n.includes(' ') && joined.includes(n))) return true;
  return scope.some((w) => NEGATORS.includes(w));
}

/**
 * 計算正面與負面命中數，並處理否定翻轉。
 *
 * 否定不是「扣掉不算」，而是**翻轉極性**：
 *   "fails to beat expectations" 語意是負面，若只把 beat 排除，
 *   會得到 0 分（實測如此），等於把明確的負面標題讀成中性。
 * 因此被否定的正面詞計入負向，被否定的負面詞計入正向。
 */
function countEffective(text, words) {
  let pos = 0;
  let neg = 0;
  for (const w of words) {
    for (const idx of findWord(text, w)) {
      if (isNegatedAt(text, idx)) {
        // 翻轉
        if (words === POS_WORDS) neg++;
        else pos++;
      } else if (words === POS_WORDS) pos++;
      else neg++;
    }
  }
  return { pos, neg };
}

/**
 * 標題情緒分數（-1..1）。
 *
 * 權重設計：一則標題通常只帶 1–3 個情緒詞，若用「命中數 ÷ 詞總數」
 * 會讓所有分數都趨近 0。因此用命中差 ÷ (命中和 + 2)：
 *   +1/-0  → +0.33        （單一正面詞）
 *   +2/-0  → +0.50
 *   +2/-1  → +0.20
 *   +1/-1  → 0
 * 分母的 +2 是「平滑項」，讓單詞標題不會直接飽和到 ±1。
 */
function titleScore(title) {
  const a = countEffective(title, POS_WORDS);
  const b = countEffective(title, NEG_WORDS);
  const pos = a.pos + b.pos;
  const neg = a.neg + b.neg;
  if (pos === 0 && neg === 0) return 0;
  const raw = (pos - neg) / (pos + neg + 2);
  return Math.max(-1, Math.min(1, raw));
}

/* ============================================================
   價格脈絡
   ============================================================ */

/**
 * 從 /api/analyze 的回應抽出餵給 AI 的價格脈絡。
 *
 * 為什麼不重算指標：analyze 已經算好 RSI / ATR / 區間位置，
 * 重算一份等於製造第二個真相來源（而且公式難免有微小差異，
 * 導致「AI 說 RSI 58，畫面上寫 57.9」這種看起來像 bug 的不一致）。
 *
 * 注意 `series` 的形状是 `{ daily: [...], weekly: [...] }` 而不是陣列。
 * 一開始把它當陣列取用，導致 change5d/change20d 全部是 null
 * （實測 seriesBars:0），於是「近 20 日漲跌 —」出現在摘要裡。
 * 必須取 `.daily`。
 */
function buildPriceContext(analysis) {
  const a = analysis || {};
  const m = a.meta || {};
  const s = a.snapshot || {};
  const lv = a.levels || {};
  const raw = a.series;
  const daily = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.daily) ? raw.daily : []);

  const closes = daily.map((x) => x && x.c).filter((v) => Number.isFinite(v));
  const last = closes.length ? closes[closes.length - 1] : m.price;

  function chg(n) {
    if (closes.length <= n) return null;
    const prev = closes[closes.length - 1 - n];
    if (!Number.isFinite(prev) || !prev) return null;
    return +(((last - prev) / prev) * 100).toFixed(2);
  }

  // 20 日區間位置：0 = 貼著低點，100 = 貼著高點
  let range20Pos = null;
  const r20 = lv.range20;
  if (r20 && Number.isFinite(r20.low) && Number.isFinite(r20.high) && r20.high > r20.low) {
    range20Pos = +(((last - r20.low) / (r20.high - r20.low)) * 100).toFixed(1);
  }

  return {
    price: m.price != null ? m.price : null,
    currency: m.currency || '',
    changePercent: m.changePercent != null ? m.changePercent : null,
    change5d: chg(5),
    change20d: chg(20),
    change60d: chg(60),
    atrPct: s.atrPct != null ? +Number(s.atrPct).toFixed(2) : null,
    rsi: s.rsi != null ? +Number(s.rsi).toFixed(1) : null,
    range20Position: range20Pos,
    range20: r20 && Number.isFinite(r20.low) ? { low: r20.low, high: r20.high } : null,
    asOf: a.dataUpdatedAt ? new Date(a.dataUpdatedAt).toISOString() : null,
    seriesBars: closes.length,
  };
}

/** 從 analyze 的技術立場抽摘要（不含完整 breakdown，避免餵太多） */
function buildStance(analysis) {
  const a = analysis || {};
  const z = a.buyZone || {};
  const p = a.probabilities || {};
  return {
    verdictLabel: (a.verdict && a.verdict.label) || null,
    score: Number.isFinite(a.score) ? +a.score.toFixed(1) : null,
    buyZone: Number.isFinite(z.lower) ? { lower: z.lower, upper: z.upper } : null,
    stopLoss: Number.isFinite(z.stopLoss) ? z.stopLoss : null,
    riskReward: Number.isFinite(z.riskReward) ? z.riskReward : null,
    probUp20: Number.isFinite(p.probUp20) ? +(p.probUp20 * 100).toFixed(1) : null,
    sampleSize: Number.isFinite(p.sampleSize) ? p.sampleSize : null,
  };
}

/* ============================================================
   規則層分析
   ============================================================ */

/**
 * 無 LLM 時的分析。**必須產出與 LLM 版相同的 schema。**
 *
 * @param {object} p
 * @param {object} p.news      newsHub.getNews 的回傳
 * @param {object} p.price     buildPriceContext 的回傳
 * @param {object} p.stance    buildStance 的回傳
 * @param {object} [p.sector]  { key, label, quadrant, quadrantLabel }
 */
function ruleAnalyze(p) {
  const news = (p.news && p.news.news) || [];
  const price = p.price || {};
  const stance = p.stance || {};
  const sector = p.sector || null;

  /* 加權情緒：tier1 權重 1.0、tier2 0.7、tier3 0.4。
     為什麼要按 tier 加權：一則路透社的「財報超預期」與一則論壇的
     「感覺會漲」在統計上不該等權重。這也讓 tier 分級的意義落到實處。 */
  const W = { 1: 1.0, 2: 0.7, 3: 0.4 };
  let num = 0;
  let den = 0;
  const scored = news.map((n) => {
    const s = titleScore(n.title);
    const w = W[n.tier] || 0.4;
    num += s * w;
    den += w;
    return { title: n.title, tier: n.tier, publisher: n.publisher, score: s };
  });
  const score = den > 0 ? Math.max(-1, Math.min(1, num / den)) : 0;

  let sentiment = 'neutral';
  if (score > 0.15) sentiment = 'positive';
  else if (score < -0.15) sentiment = 'negative';
  // mixed：有明確正負兩極的頭條同時存在（即使加權後接近 0）
  const posN = scored.filter((s) => s.score > 0.15).length;
  const negN = scored.filter((s) => s.score < -0.15).length;
  if (posN >= 2 && negN >= 2 && Math.abs(score) <= 0.3) sentiment = 'mixed';

  /* keyEvents：優先 tier1，再按情緒強度。
     為什麼門檻用 0.03 而不是 0.05：
     實測 12 則 tier1 新聞裡只有 1 則通過 0.05 門檻（財經標題多為陳述句，
     真正帶強烈情緒詞的很少），導致「關鍵事件」只剩 1 條，區塊看起來像壞掉。
     降到 0.03 後可穩定取到 3–4 條，且仍排除完全中性（0 分）的標題。 */
  const EVENT_MIN = 0.03;
  const keyEvents = scored
    .filter((s) => Math.abs(s.score) > EVENT_MIN)
    .sort((a, b) => (b.tier === 1 ? 1 : 0) - (a.tier === 1 ? 1 : 0)
      || Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 4)
    .map((s) => ({
      event: s.title,
      impact: s.score > EVENT_MIN ? 'positive' : (s.score < -EVENT_MIN ? 'negative' : 'neutral'),
      horizon: 'short',
      source: s.publisher,
      tier: s.tier,
    }));

  /* summary：模板句，但必須有資訊量 */
  const t1 = news.filter((n) => n.tier === 1).length;
  const dirCn = { positive: '偏正面', negative: '偏負面', neutral: '中性', mixed: '多空分歧' }[sentiment];
  let summary = news.length
    ? `近 ${p.news.window && p.news.window.days ? p.news.window.days : '?'} 天共 ${news.length} 則相關新聞，`
      + `其中 ${t1} 則來自一線財經媒體。加權情緒為${dirCn}`
      + `（分數 ${score.toFixed(2)}）。`
    : '目前取不到相關新聞，以下僅為技術面判讀。';

  if (price.rsi != null) {
    summary += `技術面上 RSI 為 ${price.rsi}`
      + `（${price.rsi > 70 ? '超買區' : price.rsi < 30 ? '超賣區' : '中性區間'}），`
      + `近 20 日漲跌 ${fmtPct(price.change20d)}。`;
  }

  /* drivers：固定三因子，權重依資料可得性分配（和恆為 1）。
     direction 必須反映**該因子自己的方向**，不可一律跟隨總情緒：
     實測曾出現「總情緒 neutral（-0.03）但新聞驅動因子標 negative」的矛盾，
     因為 -0.03 落在 neutral 區間卻被當成負值。個別因子用嚴格符號判斷。 */
  const drivers = [];
  const hasNews = news.length > 0;
  const hasTech = price.rsi != null || price.change20d != null;
  const hasSector = Boolean(sector && sector.quadrant);
  let wNews = hasNews ? 0.5 : 0;
  let wTech = hasTech ? 0.3 : 0;
  let wSec = hasSector ? 0.2 : 0;
  const sum = wNews + wTech + wSec;
  if (sum > 0) {
    wNews = +(wNews / sum).toFixed(2);
    wTech = +(wTech / sum).toFixed(2);
    wSec = +(1 - wNews - wTech).toFixed(2);
    if (hasNews) {
      drivers.push({ factor: '新聞情緒', weight: wNews, direction: score > 0 ? 'positive' : (score < 0 ? 'negative' : 'neutral') });
    }
    if (hasTech) {
      // 技術面方向：超賣區（RSI<35）視為偏多機會，超買（RSI>70）視為偏空風險，
      // 中間地帶則看 20 日趨勢。
      let tdir = 'neutral';
      if (price.rsi != null && price.rsi < 35) tdir = 'positive';
      else if (price.rsi != null && price.rsi > 70) tdir = 'negative';
      else if (price.change20d != null) tdir = price.change20d > 0 ? 'positive' : (price.change20d < 0 ? 'negative' : 'neutral');
      drivers.push({ factor: '技術面位置', weight: wTech, direction: tdir });
    }
    if (hasSector) {
      drivers.push({
        factor: '版塊相對強弱',
        weight: wSec,
        direction: (sector.quadrant === 'leading' || sector.quadrant === 'improving') ? 'positive' : 'negative',
      });
    }
  }

  /* priceImpact：方向取情緒，幅度取 ATR 分級。
     為什麼用 ATR 而不是固定百分比：ATR 就是這檔股票自己的日常波動，
     對低波動股用 3% 當「大」的門檻，等於每次都說「大」。 */
  const atr = price.atrPct;
  let magnitude = 'small';
  if (atr != null) magnitude = atr >= 3 ? 'large' : atr >= 1.5 ? 'moderate' : 'small';
  const dirMap = { positive: 'up', negative: 'down', neutral: 'neutral', mixed: 'neutral' };

  /* alreadyPricedIn 的規則判斷：若新聞方向的漲跌已在前 5 日走完，
     大致上可說「已反映」。這是粗略啟發，因此標 unknown 而非斷言。 */
  let alreadyPricedIn = 'unknown';
  const c5 = price.change5d;
  if (c5 != null && sentiment !== 'neutral' && sentiment !== 'mixed') {
    const sameDir = (sentiment === 'positive' && c5 > 1.5) || (sentiment === 'negative' && c5 < -1.5);
    const oppDir = (sentiment === 'positive' && c5 < -1.5) || (sentiment === 'negative' && c5 > 1.5);
    if (sameDir) alreadyPricedIn = 'partially';
    else if (oppDir) alreadyPricedIn = 'no';
  }

  const impactReason = buildImpactReason(price, magnitude, sentiment);

  return {
    mode: 'rule',
    summary,
    sentiment,
    score: +score.toFixed(2),
    confidence: t1 >= 6 ? 'high' : t1 >= 2 ? 'medium' : 'low',
    keyEvents,
    drivers,
    priceImpact: {
      direction: dirMap[sentiment] || 'neutral',
      magnitude,
      reasoning: impactReason,
      alreadyPricedIn,
    },
    sectorContext: sector
      ? `${sector.label}目前處於「${sector.quadrantLabel}」象限，` +
        ((sector.quadrant === 'leading' || sector.quadrant === 'improving')
          ? '版塊相對強度有支撐。' : '版塊相對強度偏弱，是本標的的外部壓力。')
      : null,
    caveats: buildCaveats(p, t1),
    adjusted: [],
    scored: scored.slice(0, 8),
  };
}

/** 用實際數字組出「影響幅度」的說明，避免空話 */
function buildImpactReason(price, magnitude, sentiment) {
  const parts = [];
  if (price.atrPct != null) {
    parts.push(`本標的 14 日 ATR 為 ${price.atrPct}%`);
  }
  if (price.change5d != null) {
    parts.push(`近 5 日已${price.change5d >= 0 ? '上漲' : '下跌'} ${Math.abs(price.change5d)}%`);
  }
  const magCn = { large: '大', moderate: '中等', small: '小' }[magnitude] || '中等';
  const sentCn = { positive: '正面', negative: '負面', neutral: '中性', mixed: '分歧' }[sentiment] || '中性';
  if (!parts.length) {
    return `新聞情緒${sentCn}，但因缺少波動度數據，影響幅度僅能以「${magCn}」概括，無法量化。`;
  }
  return `新聞情緒${sentCn}；${parts.join('，')}，判斷對股價的潛在影響幅度為「${magCn}」。`
    + '此為統計性描述，非價格預測。';
}

/** 資料不足必須明說，不可粉飾 */
function buildCaveats(p, tier1Count) {
  const out = [];
  const news = (p.news && p.news.news) || [];
  if (!news.length) out.push('無相關新聞，情緒分析不成立。');
  if (tier1Count === 0) out.push('本次無一線財經媒體報導，情緒判讀的可靠度較低。');
  if ((p.price && p.price.atrPct) == null) out.push('缺少波動度數據，影響幅度無法量化。');
  if (!p.sector) out.push('未取得版塊歸屬，無法納入版塊相對強弱。');
  if (news.some((n) => n.linkKind === 'google-redirect')) {
    out.push('部分新聞連結為 Google News 轉址，並非原始媒體網址。');
  }
  return out;
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
}

/* ============================================================
   LLM 分析
   ============================================================ */

/** 給模型的輸出格式說明（與 docs 契約逐字對齊） */
const OUTPUT_SCHEMA_HINT = `{
  "summary": "繁體中文 120–200 字，說明這批新聞共同指向什麼，必須引用我提供的數字",
  "sentiment": "positive | negative | neutral | mixed",
  "score": 0.0,
  "confidence": "high | medium | low",
  "keyEvents": [{"event":"…","impact":"positive|negative|neutral","horizon":"short|medium|long"}],
  "drivers": [{"factor":"…","weight":0.45,"direction":"positive|negative"}],
  "priceImpact": {"direction":"up|down|neutral","magnitude":"large|moderate|small","reasoning":"繁體中文，必須引用價格脈絡的數字","alreadyPricedIn":"yes|partially|no|unknown"},
  "sectorContext": "繁體中文一句話，或 null",
  "caveats": ["資料不足之處"]
}`;

/**
 * 組 prompt。**所有數字都在這裡給定**，模型只能引用不能發明。
 */
function buildPrompt(p) {
  const news = ((p.news && p.news.news) || []).slice(0, 8).map((n, i) => ({
    i: i + 1,
    title: n.title,
    publisher: n.publisher,
    tier: n.tier,          // 1=一線財經媒體 2=專業媒體 3=社群
    age: n.ageText,
    excerpt: n.excerpt || null,
  }));

  const input = {
    標的: {
      symbol: p.symbol,
      name: p.name || null,
      市場: p.news ? p.news.market : null,
    },
    價格脈絡: p.price,
    技術立場: p.stance,
    版塊: p.sector || null,
    新聞: news,
    新聞時間範圍: p.news ? p.news.window : null,
  };

  return [
    '你是一位嚴謹的財經分析師。請根據以下**已由系統算好**的資料，',
    '針對這檔股票做「新聞情緒 + 價格脈絡」的綜合研判。',
    '',
    '嚴格規則（違反會導致輸出被丟棄）：',
    '1. 只能使用我提供的數字，**絕對不可新增、推算或估計任何數值**。',
    '2. 不可給出目標價、不可預測未來價格、不可建議買賣或擇時。',
    '3. `tier` 代表來源權威性（1 最高、3 最低）。tier 1 的新聞權重應明顯高於 tier 3。',
    '4. `score` 必須落在 -1 到 1，且必須與 `sentiment` 一致：',
    '   positive 對應 score > 0.15；negative 對應 score < -0.15；neutral 對應 |score| ≤ 0.15。',
    '5. `drivers` 的 weight 總和必須等於 1.0；若無法給出合理權重，就給空陣列。',
    '6. `priceImpact.reasoning` **必須引用** 價格脈絡裡的實際數字（如 ATR、近 5 日漲跌）。',
    '7. 資料不足時必須在 `caveats` 明說，不可編造理由填充。',
    '8. **一律使用繁體中文**（台灣用語），不可使用簡體字。',
    '9. 只輸出 JSON 物件，不要任何說明文字、不要 markdown 圍欄。',
    '',
    '輸出格式：',
    OUTPUT_SCHEMA_HINT,
    '',
    '輸入資料：',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

/**
 * 後置檢查與校正。任何一項不通過都記錄在 `adjusted`，**不靜默採用**。
 *
 * @param {object} raw  模型回傳的物件
 * @param {object} p    原始輸入（供白名單比對）
 * @param {string} prompt 送出的完整 prompt（白名單必須含它）
 */
function validateAndFix(raw, p, prompt) {
  const adjusted = [];
  const out = {};

  /* --- summary --- */
  out.summary = String(raw.summary == null ? '' : raw.summary).trim();
  if (!out.summary) {
    adjusted.push('summary');
    out.summary = '';
  }

  /* --- sentiment / score 一致性 --- */
  let s = String(raw.sentiment || '').toLowerCase().trim();
  if (!['positive', 'negative', 'neutral', 'mixed'].includes(s)) {
    adjusted.push('sentiment');
    s = 'neutral';
  }
  let score = Number(raw.score);
  if (!Number.isFinite(score)) { adjusted.push('score'); score = 0; }
  score = Math.max(-1, Math.min(1, score));

  const expected = score > 0.15 ? 'positive' : (score < -0.15 ? 'negative' : 'neutral');
  // mixed 允許 |score| ≤ 0.3（多空抵銷後接近 0 是正常的）
  const consistent = (s === expected) || (s === 'mixed' && Math.abs(score) <= 0.3);
  if (!consistent) {
    adjusted.push('sentiment（與 score 不一致，已依 score 校正）');
    s = expected;
  }
  out.sentiment = s;
  out.score = +score.toFixed(2);

  /* --- confidence --- */
  const conf = String(raw.confidence || '').toLowerCase();
  out.confidence = ['high', 'medium', 'low'].includes(conf) ? conf : 'low';
  if (!['high', 'medium', 'low'].includes(conf)) adjusted.push('confidence');

  /* --- keyEvents：最多 4 條，空的丟棄 --- */
  const ev = Array.isArray(raw.keyEvents) ? raw.keyEvents : [];
  out.keyEvents = ev.slice(0, 4).map((e) => ({
    event: String((e && e.event) || '').trim(),
    impact: ['positive', 'negative', 'neutral'].includes(e && e.impact) ? e.impact : 'neutral',
    horizon: ['short', 'medium', 'long'].includes(e && e.horizon) ? e.horizon : 'short',
  })).filter((e) => e.event);
  if (!out.keyEvents.length && ev.length) adjusted.push('keyEvents（全部為空，已丟棄）');

  /* --- drivers：權重和必須在 1±0.02，否則整欄丟棄（不縮放偽裝） --- */
  const dv = Array.isArray(raw.drivers) ? raw.drivers : [];
  const cleaned = dv.map((d) => ({
    factor: String((d && d.factor) || '').trim(),
    weight: Number(d && d.weight),
    // direction 允許 neutral：某些因子（如已反映的消息）本身無方向
    direction: ['positive', 'negative', 'neutral'].includes(d && d.direction)
      ? d.direction : 'neutral',
  })).filter((d) => d.factor && Number.isFinite(d.weight) && d.weight > 0);

  if (cleaned.length) {
    const sum = cleaned.reduce((a, b) => a + b.weight, 0);
    if (Math.abs(sum - 1) <= 0.02) {
      out.drivers = cleaned.map((d) => ({ ...d, weight: +d.weight.toFixed(3) }));
    } else {
      // 刻意不縮放：縮放後看起來合法，但已不是模型的原意，等於偽造
      adjusted.push(`drivers（權重和 ${sum.toFixed(2)} ≠ 1，整欄丟棄）`);
      out.drivers = [];
    }
  } else {
    out.drivers = [];
  }

  /* --- priceImpact：必須含白名單數字，否則降級 --- */
  const pi = raw.priceImpact || {};
  const reasoning = String(pi.reasoning || '').trim();
  const knownNumbers = new Set();
  for (const src of [p.price, p.stance, p.sector, p.news && p.news.window]) {
    llm.collectNumbers(JSON.stringify(src), knownNumbers);
  }
  llm.collectNumbers(prompt, knownNumbers);

  // priceImpact 只有一兩句話，任何來源外的數字都代表模型在編造 → 容許值為 0
  const audit = llm.auditNumbers(reasoning, knownNumbers, 0);
  const banned = /目標價|target price|建議買|建議賣|buy rating|sell rating|會漲到|會跌到/i.test(reasoning);

  if (!reasoning) {
    out.priceImpact = null;
    adjusted.push('priceImpact（為空）');
  } else if (banned) {
    // 整段丟棄而不是抽掉那一句：論述已被帶偏，留半段更危險
    out.priceImpact = null;
    adjusted.push('priceImpact（含目標價或買賣建議，整段丟棄）');
  } else if (!audit.ok) {
    out.priceImpact = null;
    adjusted.push(`priceImpact（引用 ${audit.suspect.length} 個來源外的數字：${audit.suspect.slice(0, 3).join('、')}）`);
  } else {
    out.priceImpact = {
      direction: ['up', 'down', 'neutral'].includes(pi.direction) ? pi.direction : 'neutral',
      magnitude: ['large', 'moderate', 'small'].includes(pi.magnitude) ? pi.magnitude : 'moderate',
      reasoning,
      alreadyPricedIn: ['yes', 'partially', 'no', 'unknown'].includes(pi.alreadyPricedIn)
        ? pi.alreadyPricedIn : 'unknown',
    };
  }

  /* --- sectorContext --- */
  const sc = raw.sectorContext;
  out.sectorContext = (sc == null || sc === '' || String(sc).toLowerCase() === 'null')
    ? null : String(sc).trim();

  /* --- caveats --- */
  const cv = Array.isArray(raw.caveats) ? raw.caveats : [];
  out.caveats = cv.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 5);

  out.adjusted = adjusted;
  return out;
}

/**
 * 主入口：產生個股新聞 AI 分析。
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {string} [opts.name]
 * @param {object} [opts.analysis]  /api/analyze 的回應（用於價格脈絡）
 * @param {object} [opts.news]      已取得的 newsHub 結果（不給則自行抓）
 * @param {object} [opts.sector]    { key,label,quadrant,quadrantLabel }
 * @param {string} [opts.mode]      'auto' | 'rule'
 * @param {object} [opts.llmCfg]    測試用覆寫
 */
async function analyzeStock(opts) {
  const o = opts || {};
  const symbol = String(o.symbol || '').trim();
  if (!symbol) {
    const e = new Error('缺少 symbol');
    e.code = 'EMPTY';
    throw e;
  }

  const mode = String(o.mode || 'auto').toLowerCase();
  const wantLlm = mode !== 'rule';

  const key = `stock-ai:${symbol}|${mode}|${o.analysis ? 'an' : 'no'}`;
  if (!o.refresh) {
    const hit = aiCacheGet(key);
    if (hit) return { ...hit, cached: true };
  }

  // 新聞：允許注入以免重複抓取
  let news = o.news;
  if (!news) {
    try {
      news = await newsHub.getNews({ symbol, name: o.name, days: o.days || 7, limit: 12 });
    } catch (e) {
      news = {
        ok: false, symbol, market: /\.HK$/i.test(symbol) ? 'HK' : 'US',
        count: 0, news: [], window: { from: null, to: null, days: o.days || 7 },
        sources: [], publishers: [], tiers: { tier1: 0, tier2: 0, tier3: 0 },
        degraded: [{ source: 'all', code: 'FETCH_FAILED', message: `新聞取得失敗：${e.message}` }],
        generatedAt: new Date().toISOString(),
      };
    }
  }

  const price = buildPriceContext(o.analysis);
  const stance = buildStance(o.analysis);
  const sector = o.sector || null;

  const ctx = { symbol, name: o.name || null, news, price, stance, sector };

  let ai = null;
  let llmNote = null;
  let llmMeta = null;

  if (wantLlm && news.count > 0) {
    const prompt = buildPrompt(ctx);
    const res = await llm.callLlm({ prompt, cfg: o.llmCfg, json: true, temperature: 0.2 });
    if (res.ok && res.json && typeof res.json === 'object') {
      const fixed = validateAndFix(res.json, ctx, prompt);
      // 只有 summary 或 keyEvents 有內容才採用 LLM 版；否則退回規則層（避免半空殼）
      if (fixed.summary || fixed.keyEvents.length) {
        ai = { mode: 'llm', ...fixed };
        llmMeta = {
          model: (o.llmCfg && o.llmCfg.model) || llm.loadLlmConfig().model || null,
          via: res.via,
          tokens: res.usage || null,
        };
      } else {
        llmNote = 'LLM 輸出缺少摘要與關鍵事件，改用規則層分析';
      }
    } else {
      llmNote = res.note || 'LLM 分析未成功，改用規則層分析';
    }
  } else if (wantLlm && news.count === 0) {
    llmNote = '無相關新聞可分析，改用規則層（僅技術面）';
  }

  if (!ai) {
    ai = ruleAnalyze({ news, price, stance, sector });
    if (llmNote) ai.note = llmNote;
  }

  /* 繁體檢查：LLM 路徑已在 llm.callLlm 內處理，這裡彙總給前端 */
  const hantOk = ai.mode === 'llm' ? llm.looksHant(JSON.stringify(ai)) : true;

  const out = {
    ok: true,
    symbol,
    name: o.name || null,
    market: news.market || (/\.HK$/i.test(symbol) ? 'HK' : 'US'),
    ai,
    news: {
      count: news.count,
      totalBeforeLimit: news.totalBeforeLimit || news.count,
      items: news.news || [],
      window: news.window || { from: null, to: null, days: o.days || 7 },
      tiers: news.tiers || { tier1: 0, tier2: 0, tier3: 0 },
      tierLabels: newsHub.TIER_LABEL,
      publishers: (news.publishers || []).slice(0, 12),
    },
    price,
    stance,
    sector,
    provenance: {
      newsWindow: news.window || { from: null, to: null, days: o.days || 7 },
      priceAsOf: price.asOf,
      sources: (news.sources || []).map((s) => ({
        id: s.id, name: s.name, count: s.count, tier1: s.tier1, ok: s.ok,
      })),
      publishers: (news.publishers || []).slice(0, 12),
      aiMode: ai.mode,
      aiModel: ai.mode === 'llm' && llmMeta ? llmMeta.model : null,
      aiVia: llmMeta ? llmMeta.via : null,
      generatedAt: new Date().toISOString(),
      degraded: news.degraded || [],
      hantOk,
    },
    generatedAt: new Date().toISOString(),
  };

  // LLM 模式才快取（規則層是純函式，重算成本近乎零，快取反而會蓋掉新聞更新）
  if (ai.mode === 'llm') aiCacheSet(key, out);
  return { ...out, cached: false };
}

/* ============================================================
   快取
   ============================================================ */

const AI_TTL_MS = 30 * 60 * 1000;
const aiStore = new Map();

function aiCacheGet(key) {
  const hit = aiStore.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > AI_TTL_MS) { aiStore.delete(key); return null; }
  return hit.value;
}

function aiCacheSet(key, value) {
  aiStore.set(key, { at: Date.now(), value });
  if (aiStore.size > 100) {
    const oldest = [...aiStore.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
    for (const [k] of oldest) aiStore.delete(k);
  }
}

function resetAiCache() { aiStore.clear(); }

module.exports = {
  analyzeStock,
  ruleAnalyze,
  buildPriceContext,
  buildStance,
  buildPrompt,
  validateAndFix,
  titleScore,
  countEffective,
  findWord,
  isNegatedAt,
  buildImpactReason,
  resetAiCache,
  AI_TTL_MS,
  POS_WORDS,
  NEG_WORDS,
};
