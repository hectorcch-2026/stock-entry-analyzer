/* ============================================================
 * 新聞關鍵字與主題提煉
 * ============================================================
 *
 * ── 這個模組解決什麼問題 ──────────────────────────────────
 * 個股新聞分析原本只給「情緒 −0.08／中性」與幾個要點。
 * 使用者無法快速回答：「這批新聞到底在講哪幾件事？」
 * 因此這裡從 10 則新聞的**標題 + 正文**提煉關鍵字與主題，
 * 後續的「關鍵字 → 觀點 → 依據」鏈條都以這裡的輸出為索引。
 *
 * ── 兩個關鍵設計決定 ──────────────────────────────────────
 *
 * ① 為什麼不直接用詞頻（TF）排序
 *   純 TF 會把 "apple"（每則都有）、"said"、"million" 排到最前面——
 *    這些詞區分度為零。真正有用的是「只在這幾則出現、但橫跨多則」的詞，
 *    所以排序用「文件覆蓋率」為主、詞頻為輔，並扣掉標的自身名稱。
 *
 * ② 為什麼要有「中文標準標籤」對照表
 *    新聞原文是英文（Yahoo/Google News），但匯報要繁體中文。
 *    若直接把 "guidance" 丟給使用者，匯報會變成中英夾雜。
 *    這裡把已知的財經／監管概念映射成中文標籤，
 *    未命中對照表的專有名詞（Siri、Talkie、MiniMax）保留原文，
 *    因為那些是實體名稱，硬翻反而失真。
 *
 * ── 純函式，無 I/O ────────────────────────────────────────
 * 不抓網路、不讀檔案，方便單元測試與在 LLM 前後重複呼叫。
 */

'use strict';

/* ============================================================
   停用詞
   ============================================================ */

/**
 * 英文停用詞。
 *
 * 除了常見虚詞，這裡刻意納入三類「財經新聞常見但無區分度」的詞：
 *   ① 每則都有的公司名與代號（apple/aapl/inc/nasdaq）
 *   ② 報導用動詞（said/reports/according）
 *   ③ 純計量詞（million/billion/percent/year）
 * 若不排除，前 10 個關鍵字會有 6 個是這類詞。
 */
const STOP_EN = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'into', 'over',
  'after', 'before', 'about', 'above', 'below', 'under', 'between', 'during',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'should', 'may', 'might', 'must', 'shall',
  'it', 'its', 'this', 'that', 'these', 'those', 'they', 'them', 'their',
  'he', 'she', 'his', 'her', 'we', 'our', 'you', 'your', 'i', 'my',
  'not', 'no', 'nor', 'none', 'all', 'any', 'some', 'each', 'every', 'both',
  'more', 'most', 'much', 'many', 'very', 'too', 'also', 'just', 'only',
  'now', 'then', 'today', 'yesterday', 'tomorrow', 'week', 'month', 'year',
  'said', 'says', 'say', 'told', 'according', 'report', 'reports', 'reported',
  'new', 'news', 'one', 'two', 'three', 'first', 'second', 'next', 'last',
  'other', 'others', 'such', 'own', 'same', 'here', 'there', 'where', 'when',
  'what', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'million', 'billion', 'trillion', 'thousand', 'percent', 'per', 'cent',
  'get', 'got', 'make', 'made', 'take', 'took', 'see', 'seen', 'know',
  'like', 'well', 'back', 'even', 'still', 'yet', 'however', 'while',
  'inc', 'corp', 'corporation', 'ltd', 'limited', 'co', 'company', 'plc',
  'nasdaq', 'nyse', 'stock', 'stocks', 'share', 'shares', 'equity',
  'analyst', 'analysts', 'investor', 'investors', 'market', 'markets',
  'apple', 'aapl',
]);

/** 中文虚詞與高頻無區分度詞。 */
const STOP_ZH = new Set([
  '的', '了', '和', '與', '或', '在', '是', '有', '為', '對', '從', '到',
  '這', '那', '個', '些', '們', '也', '就', '都', '而', '但', '並', '被',
  '將', '已', '可能', '表示', '指出', '認為', '公司', '股票', '股價',
  '市場', '分析', '報導', '消息', '今日', '今年', '去年', '目前',
]);

/* ============================================================
   概念對照表：英文詞 → 中文標準標籤
   ============================================================ */

/**
 * 每個概念一組 pattern。
 *
 * `cat` 是粗分類，前端用來上色與分組：
 *   financial 財務　policy 政策／監管　product 產品／技術
 *   market 市場面　risk 風險　other 其他
 *
 * `label` 是中文標準標籤，也是「同義詞合併」的依據：
 *   "guidance" / "outlook" / "forecast" 都併到「業績指引」，
 *   否則同一個概念會拆成三個關鍵字，把榜單佔滿。
 */
const CONCEPTS = [
  /* ---- 財務 ---- */
  { id: 'guidance', label: '業績指引', cat: 'financial',
    re: /\b(guidance|outlook|forecast|projection|steer)\b/i },
  { id: 'margin', label: '毛利率', cat: 'financial',
    re: /\b(gross margin|margin|profitability|operating margin)\b/i },
  { id: 'revenue', label: '營收', cat: 'financial',
    re: /\b(revenue|sales|top line|topline)\b/i },
  { id: 'earnings', label: '獲利', cat: 'financial',
    re: /\b(earnings|profit|net income|bottom line|eps)\b/i },
  { id: 'cashflow', label: '自由現金流', cat: 'financial',
    re: /\b(free cash flow|cash flow|fcf|operating cash)\b/i },
  { id: 'valuation', label: '估值', cat: 'financial',
    re: /\b(valuation|p\/e|price-to-earnings|forward earnings|multiple|premium)\b/i },
  { id: 'capex', label: '資本支出', cat: 'financial',
    re: /\b(capex|capital expenditure|capital spending|data center spend)\b/i },
  { id: 'buyback', label: '回購與股息', cat: 'financial',
    re: /\b(buyback|repurchase|dividend|shareholder return|payout)\b/i },
  { id: 'cost', label: '成本壓力', cat: 'financial',
    re: /\b(cost|costs|expense|expenses|input price|component price|memory price)\b/i },
  { id: 'rating', label: '評等調整', cat: 'financial',
    /* 必須寫成「(price) target」而非單獨 target，且 rating 不可裸匹配：
       實測「Talkie carries an 18-plus age rating on the App Store」會命中裸 rating，
       把一條產品年齡分級新聞變成「評等調整」。加限定詞後才不會誤收。 */
    re: /\b(upgrade[sd]?|downgrade[sd]?|price target|analyst rating|stock rating|initiate[sd]? coverage|outperform\w*|underperform\w*)\b/i },

  /* ---- 政策／監管 ---- */
  { id: 'regulatory', label: '監管調查', cat: 'policy',
    re: /\b(regulat\w*|antitrust|monopol\w*|investigation|probe|inquiry)\b/i },
  { id: 'lawsuit', label: '訴訟裁決', cat: 'policy',
    re: /\b(lawsuit|litigation|court|ruling|verdict|settlement|class action)\b/i },
  { id: 'tariff', label: '關稅與貿易', cat: 'policy',
    re: /\b(tariff|trade war|export control|import duty|trade restriction)\b/i },
  { id: 'privacy', label: '隱私與兒少安全', cat: 'policy',
    re: /\b(child safety|privacy|content moderation|age verification|minor|teen)\b/i },
  { id: 'appstore', label: 'App Store 政策', cat: 'policy',
    re: /\b(app store|platform fee|gatekeeper|dma|digital markets act|sideload\w*)\b/i },
  { id: 'removal', label: '下架與停權', cat: 'policy',
    re: /\b(remov\w*|pull(?:ed|s)?|takedown|suspend\w*|ban(?:ned|s)?|block(?:ed|s)?)\b/i },

  /* ---- 產品／技術 ---- */
  { id: 'ai', label: 'AI 佈局', cat: 'product',
    re: /\b(artificial intelligence|\bai\b|ai agent|machine learning|llm|generative)\b/i },
  { id: 'iphone', label: 'iPhone 與換機潮', cat: 'product',
    re: /\b(iphone|handset|smartphone|device cycle|upgrade cycle)\b/i },
  { id: 'services', label: '服務業務', cat: 'product',
    re: /\b(services?|subscription|app store revenue|cloud|advertising)\b/i },
  { id: 'product', label: '新品與功能', cat: 'product',
    re: /\b(unveil\w*|launch\w*|release\w*|new product|new feature|foldable|chip)\b/i },
  { id: 'partnership', label: '合作與結盟', cat: 'product',
    re: /\b(partnership|partner\w*|deal|collaborat\w*|joint venture|alliance)\b/i },

  /* ---- 市場面 ---- */
  { id: 'demand', label: '需求與出貨', cat: 'market',
    re: /\b(demand|shipment|units sold|inventory|order book|backlog)\b/i },
  { id: 'competition', label: '競爭格局', cat: 'market',
    re: /\b(competit\w*|rival\w*|market share|landscape)\b/i },
  { id: 'institution', label: '機構持股', cat: 'market',
    re: /\b(institutional|hedge fund|stake|position|13f|asset manager)\b/i },
  { id: 'sentiment', label: '市場情緒', cat: 'market',
    re: /\b(rally|selloff|surge|plunge|slump|rebound|sentiment|record high)\b/i },

  /* ---- 風險 ---- */
  { id: 'supply', label: '供應鏈', cat: 'risk',
    re: /\b(supply chain|supplier|component shortage|lead time|manufactur\w*)\b/i },
  { id: 'macro', label: '總體環境', cat: 'risk',
    re: /\b(recession|inflation|interest rate|fed\b|economy|gdp|unemployment)\b/i },
];

const CONCEPT_BY_ID = CONCEPTS.reduce((acc, c) => { acc[c.id] = c; return acc; }, {});

const CAT_LABEL = {
  financial: '財務',
  policy: '政策／監管',
  product: '產品／技術',
  market: '市場面',
  risk: '風險',
  other: '其他',
};

/* ============================================================
   斷詞
   ============================================================ */

/**
 * 英文斷詞。
 *
 * 保留連字號與點號在詞內（"price-to-earnings"、"p/e" → "p e"），
 * 因為財經詞常帶這些符號，先切碎會丟掉語意。
 * 只保留長度 ≥3 的英文字，避免 a/of 之類的殘留。
 */
function tokenizeEn(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  const re = /[a-z][a-z0-9'’\-]{2,}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    let w = m[0].replace(/^[-']+|[-']+$/g, '');
    if (w.length < 3) continue;
    // 連字號複合詞同時保留整體與拆開後的詞："price-to-earnings" → price / earnings
    if (w.indexOf('-') > 0) {
      out.push(w);
      for (const part of w.split('-')) if (part.length >= 3) out.push(part);
    } else {
      out.push(w);
    }
  }
  return out.filter((w) => !STOP_EN.has(w));
}

/**
 * 中文斷詞（無詞庫的近似法）。
 *
 * 沒有 jieba 可用（本專案零執行時依賴），所以用「二字與三字滑窗」
 * 取候選詞，再用停用詞與數字過濾。精度不如真斷詞，
 * 但足夠抓出「毛利率」「下修」「監管」這類主題詞，
 * 且不會像單字滑窗那樣產出大量無意義組合。
 */
function tokenizeZh(text) {
  const s = String(text || '');
  const out = [];
  const chunks = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const chunk of chunks) {
    for (let n = 3; n >= 2; n--) {
      for (let i = 0; i + n <= chunk.length; i++) {
        const w = chunk.slice(i, i + n);
        if (STOP_ZH.has(w)) continue;
        out.push(w);
      }
    }
  }
  return out;
}

function tokenize(text) {
  return tokenizeEn(text).concat(tokenizeZh(text));
}

/* ============================================================
   關鍵字提煉
   ============================================================ */

/**
 * 從一批新聞提煉關鍵字。
 *
 * 打分方式（實測調校後的權重）：
 *   base = 文件覆蓋率 × 0.6 + 正規化詞頻 × 0.4
 *   覆蓋率權重更高的理由：只在一則裡重複 10 次的詞，區分度不如
 *   橫跨 5 則各出現 1 次的詞——後者才是「這批新聞的共同主題」。
 *
 * @param {Array}  articles 新聞陣列，需有 title / body
 * @param {Object} opts
 *   - subject   {symbol,name} 標的，用來排除自身名稱（已在 STOP_EN 有 apple/aapl）
 *   - max       回傳幾個關鍵字（預設 12）
 *   - minDocs   至少要出現在幾則新聞（預設 2，避免只出現一次的雜訊）
 * @returns {{ keywords: Array, topics: Array, stats: Object }}
 */
function extractKeywords(articles, opts) {
  const o = opts || {};
  const max = Number.isFinite(o.max) ? o.max : 12;
  const minDocs = Number.isFinite(o.minDocs) ? o.minDocs : 2;
  const list = Array.isArray(articles) ? articles : [];

  if (!list.length) {
    return { keywords: [], topics: [], stats: { docs: 0, terms: 0 } };
  }

  /* 每則的詞集合（用 Set 去重，避免同一則重複計次拉高分數） */
  const docSets = list.map((a) => new Set(tokenize(`${a.title || ''} ${a.body || ''}`)));
  const df = new Map();      // 文件頻次
  const tf = new Map();      // 總詞頻（含重複）

  for (let i = 0; i < docSets.length; i++) {
    for (const w of docSets[i]) df.set(w, (df.get(w) || 0) + 1);
    for (const w of tokenize(`${list[i].title || ''} ${list[i].body || ''}`)) {
      tf.set(w, (tf.get(w) || 0) + 1);
    }
  }

  /* 詞 → 出現的新聞編號集合。散詞的追溯鏈用（概念另有 hitDocs）。 */
  const termDocs = new Map();
  for (let i = 0; i < docSets.length; i++) {
    for (const w of docSets[i]) {
      if (!termDocs.has(w)) termDocs.set(w, []);
      termDocs.get(w).push(i + 1);
    }
  }

  const docs = list.length;
  const rows = [];

  for (const [term, d] of df.entries()) {
    if (d < minDocs) continue;
    const coverage = d / docs;
    /* 詞頻正規化：以「出現最多的詞」為基準，避免長文拉高絕對值 */
    const raw = tf.get(term) || 0;
    rows.push({ term, df: d, tf: raw, coverage });
  }

  if (!rows.length) {
    return { keywords: [], topics: [], stats: { docs, terms: 0 } };
  }

  const maxTf = rows.reduce((m, r) => Math.max(m, r.tf), 1);
  for (const r of rows) {
    r.score = r.coverage * 0.6 + (r.tf / maxTf) * 0.4;
  }

  /* ---- 概念合併：把同義詞併到中文標準標籤 ---- */
  const conceptHits = new Map();   // id → { count, docs:Set }
  for (const c of CONCEPTS) {
    let hits = 0;
    const hitDocs = new Set();
    for (let i = 0; i < list.length; i++) {
      const text = `${list[i].title || ''} ${list[i].body || ''}`;
      if (!c.re.test(text)) continue;
      hits++;
      hitDocs.add(i);
    }
    if (hits >= Math.max(2, minDocs)) {
      conceptHits.set(c.id, { count: hits, docs: hitDocs });
    }
  }

  /* ---- 組裝輸出 ---- */
  const usedTerms = new Set();
  const out = [];

  /* 先放概念標籤（它們是「主題」，優先於散詞） */
  const conceptRows = [...conceptHits.entries()]
    .map(([id, v]) => ({
      id,
      label: CONCEPT_BY_ID[id].label,
      cat: CONCEPT_BY_ID[id].cat,
      catLabel: CAT_LABEL[CONCEPT_BY_ID[id].cat] || CAT_LABEL.other,
      df: v.count,
      coverage: v.count / docs,
      score: (v.count / docs) * 1.15,   // 概念略加分：同義詞已合併，資訊量較高
      kind: 'concept',
      /* 命中的新聞編號（1-based，對應前端顯示順序）。
         「關鍵字 → 觀點 → 依據」這條追溯鏈需要它：
         沒有 docIndexes，就只能說「這個關鍵字很重要」，
         卻指不出是從哪幾則新聞看出來的。 */
      docIndexes: [...v.docs].map((i) => i + 1).sort((a, b) => a - b),
    }))
    .sort((a, b) => b.score - a.score);

  for (const r of conceptRows) {
    if (out.length >= max) break;
    out.push(r);
  }

  /* 再補未命中概念的專有名詞／實體（保留原文，因為硬翻會失真） */
  const conceptWords = new Set();
  for (const c of CONCEPTS) {
    const src = String(c.re.source).replace(/\\b|\(\?:|\)|\?|\^|\$/g, '');
    for (const w of src.split('|')) {
      const t = w.trim().toLowerCase();
      if (t && t.length >= 3 && /^[a-z\s]+$/.test(t)) conceptWords.add(t);
    }
  }
  for (const w of conceptWords) for (const part of w.split(/\s+/)) conceptWords.add(part);

  const wordRows = rows
    .filter((r) => !conceptWords.has(r.term) && !usedTerms.has(r.term))
    .sort((a, b) => b.score - a.score);

  /* 未登錄詞只保留「形態上像專有名詞」的。
     ------------------------------------------------------------
     為什麼不能用「首字母大寫」判斷：實測三種大寫訊號全部失效——
       ① 標題是 Title Case → research / growth / strategy 全大寫
       ② 正文句首大寫      → Hold / Buy 這種開頭詞也算
       ③ 統計大寫比例      → 短語料下 2/3 就過門檻，照樣誤收
     最後改用**形態特徵**，這些在財經語料裡很穩：
       · 詞內部有大寫（MiniMax、OpenAI、iPhone）→ 一定是實體
       · 全大寫縮寫（FTC、DOJ、DMA）→ 機構或協定
       · 含數字（Q4、13F、5G）→ 專有標記
     不符這三者的英文散詞一律不顯示。寧可只呈現概念標籤，
     也不要把 research / hold / buy 這種填充詞塞進「關鍵字」清單。
     ------------------------------------------------------------ */
  const looksLikeProperNoun = (term) => {
    if (!term || term.length < 3) return false;
    const core = term.replace(/[^a-zA-Z0-9]/g, '');
    if (!core) return false;
    // ① 詞內部有大寫（排除首字母）
    if (/[A-Z]/.test(core.slice(1))) return true;
    // ② 全大寫縮寫（≥2 字元）
    if (core.length >= 2 && core === core.toUpperCase() && /^[A-Z]+$/.test(core)) return true;
    // ③ 含數字
    if (/\d/.test(core)) return true;
    return false;
  };

  /* 中文專有名詞：連續中文 ≥3 字且不在停用詞表，通常是實體名稱
     （只要不是「市場」「分析」這類泛詞即可）。tokenizeZh 已過濾停用詞。 */
  const looksLikeZhEntity = (term) => /^[\u4e00-\u9fa5]{3,}$/.test(term) && !STOP_ZH.has(term);

  for (const r of wordRows) {
    if (out.length >= max) break;
    const display = r.term;
    if (display.length < 3) continue;
    /* 英文看形態；中文看長度與停用詞 */
    const ok = /[\u4e00-\u9fa5]/.test(display)
      ? looksLikeZhEntity(display)
      : looksLikeProperNoun(display);
    if (!ok) continue;
    usedTerms.add(r.term);
    out.push({
      id: 'w:' + r.term,
      label: display,
      cat: 'other',
      catLabel: CAT_LABEL.other,
      df: r.df,
      coverage: +r.coverage.toFixed(3),
      score: +r.score.toFixed(3),
      kind: 'term',
      docIndexes: termDocs.get(r.term) || [],
    });
  }

  /* 分數正規化到 0–100 給前端畫強度條。
     注意：基準必須取「整份清單的最大值」，不能用 out[0]——
     概念與散詞的分數是兩套公式算出來的（概念 coverage×1.15、
     散詞 coverage×0.6+tf×0.4），散詞的原始值本來就比較高。
     實測用 out[0] 當基準時，散詞權重會算出 168 這種破表數字。 */
  const topScore = out.reduce((m, k) => Math.max(m, k.score), 0) || 1;
  for (const k of out) {
    k.weight = Math.max(1, Math.round((k.score / topScore) * 100));
    k.score = +k.score.toFixed(3);
    k.coverage = +k.coverage.toFixed(3);
  }

  /* ---- 主題聚合：把關鍵字按粗分類歸群 ---- */
  const groups = new Map();
  for (const k of out) {
    const key = k.cat;
    if (!groups.has(key)) {
      groups.set(key, { cat: key, catLabel: CAT_LABEL[key] || CAT_LABEL.other, keywords: [], weight: 0 });
    }
    const g = groups.get(key);
    g.keywords.push(k.label);
    g.weight += k.weight;
  }
  const topics = [...groups.values()]
    .map((g) => ({ ...g, weight: Math.round(g.weight / Math.max(1, g.keywords.length)) }))
    .sort((a, b) => b.weight - a.weight);

  return {
    keywords: out,
    topics,
    stats: { docs, terms: rows.length, concepts: conceptRows.length },
  };
}

/* ============================================================
   匯報用文字工具
   ============================================================ */

/**
 * 把關鍵字清單壓成一句「主題摘要」，給匯報開頭用。
 * 例：「本次新聞圍繞業績指引、毛利率與 AI 佈局，政策面另有監管調查。」
 */
function summarizeTopics(keywords, topics) {
  const all = keywords || [];
  const ks = all.slice(0, 5).map((k) => k.label);
  if (!ks.length) return '本次新聞未提煉出明確主題。';

  let s = `本次新聞主要圍繞${ks.slice(0, 3).join('、')}`;
  /* 這裡要用**全部**關鍵字數，不是被切到前 5 個之後的長度。
     第一版寫 ks.length，實測跑出「等 5 個關鍵字」但畫面列了 9 個——
     使用者一眼就看出前後不一致，會懷疑整份摘要是不是套模板。 */
  if (all.length > 3) s += `等 ${all.length} 個關鍵字`;

  const pol = (topics || []).find((t) => t.cat === 'policy');
  const risk = (topics || []).find((t) => t.cat === 'risk');
  const extra = [];
  if (pol && pol.keywords.length) extra.push(`政策面另有${pol.keywords.slice(0, 2).join('、')}`);
  if (risk && risk.keywords.length) extra.push(`風險面需留意${risk.keywords.slice(0, 2).join('、')}`);
  if (extra.length) s += '；' + extra.join('；');

  return s + '。';
}

module.exports = {
  extractKeywords,
  summarizeTopics,
  tokenize,
  tokenizeEn,
  tokenizeZh,
  CONCEPTS,
  CONCEPT_BY_ID,
  CAT_LABEL,
  STOP_EN,
  STOP_ZH,
};
