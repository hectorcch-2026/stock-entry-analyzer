/* ============================================================
 * 市場關注點：看好／看跌雙欄分析
 * ============================================================
 *
 * ── 這個模組解決什麼問題 ──────────────────────────────────
 * 原本的新聞卡只給「整體情緒 −0.08，中性」。使用者看完仍然不知道
 * 市場到底在爭論什麼。真正有用的是：
 *   「看多的人在意哪幾點、看空的人在意哪幾點、各自的依據是什麼」
 * 因此這裡把新聞要點拆成正反兩欄，並對每一點標註它來自哪則新聞。
 *
 * ── 兩層設計：規則層必可用，LLM 可選增強 ─────────────────
 * 線上環境曾出現「未設定 API Key」的狀況（實測 ai.mode='rule'）。
 * 若整個區塊只依賴 LLM，沒 Key 時使用者會看到一片空白，等同功能壞掉。
 * 因此：
 *   - 規則層：用情緒詞典＋新聞正文的關鍵句抽取，永遠有輸出
 *   - LLM 層：把 10 篇正文一起餵給模型，要求分類並結合財報解讀
 * LLM 失敗時**明確標示**退回規則層，不含糊。
 *
 * ── 反幻覺 ────────────────────────────────────────────────
 * 沿用 ai-analyst 的數字白名單機制：所有財務數字都由程式給定，
 * 模型的任務只有「分類」與「解讀」，不得新增任何數值。
 * 這是本專案一貫原則——編造一個毛利率比沒有毛利率更糟。
 */

'use strict';

const llm = require('./llm');

/* ============================================================
   財務數據 → 可引用的判讀素材
   ============================================================ */

/**
 * 把財報 metrics 整理成「模型可引用的事實清單」。
 *
 * 為什麼要先整理：直接把原始 metrics 丟給模型，模型容易挑錯單位或誤讀。
 * 這裡先算好中文標籤與體質評級，模型只需引用。
 *
 * 注意實際資料形狀（實測 /api/macro/:symbol 的 fundamentals.metrics）：
 *   - 是**物件**而非陣列
 *   - 絕對值欄位（revenue/netIncome/epsDiluted）是 { value, basis, yoy, to, … }
 *   - 比率欄位（grossMargin/netMargin/debtRatio/roe）是**純數字**
 *   - 營收年增率不在獨立欄位，而是 revenue.yoy
 *   - 沒有 revenueYoY 這個 key
 * 第一版誤以為是陣列，導致 available 永遠 false、財務事實全空。
 */
function buildFinancialFacts(fund) {
  const src = fund || {};
  // 呼叫端可能傳整個 /api/macro/:symbol 回應，也可能只傳 fundamentals
  const f = src.fundamentals && typeof src.fundamentals === 'object' ? src.fundamentals : src;
  const m = f && typeof f.metrics === 'object' && f.metrics ? f.metrics : {};

  /** 取純數值：同時支援「純數字」與「{value}」兩種形狀 */
  const num = (node) => {
    if (node == null) return null;
    if (typeof node === 'number') return Number.isFinite(node) ? node : null;
    if (typeof node === 'object' && Number.isFinite(node.value)) return node.value;
    return null;
  };

  const facts = [];
  const push = (key, label, value, unit, extra) => {
    if (value == null) return;
    const e = extra || {};
    facts.push({
      key, label, value,
      unit: unit || '',
      basis: e.basis || null,
      note: e.note || null,
    });
  };

  push('revenue', '營收', num(m.revenue), 'USD', { basis: m.revenue && m.revenue.basis });
  push('revenueYoY', '營收年增率', m.revenue && Number.isFinite(m.revenue.yoy) ? m.revenue.yoy : null, '%');
  push('grossMargin', '毛利率', num(m.grossMargin), '%');
  push('operatingMargin', '營業利益率', num(m.operatingMargin), '%');
  push('netMargin', '淨利率', num(m.netMargin), '%');
  push('epsDiluted', '稀釋 EPS', num(m.epsDiluted), 'USD');
  push('roe', 'ROE', num(m.roe), '%', { note: m.roeNote || null });
  push('debtRatio', '負債比', num(m.debtRatio), '%');

  /* 體質評語：讓模型有現成的方向可引用，不必自己推論。
     門檻取一般公認水準，並在 basis 寫明依據，避免變成主觀評分。 */
  const gm = num(m.grossMargin);
  const nm = num(m.netMargin);
  const roe = num(m.roe);
  const dr = num(m.debtRatio);

  const health = [];
  if (gm != null) health.push({ item: '毛利率', level: gm >= 40 ? '高' : gm >= 20 ? '中' : '低', value: gm, basis: '≥40% 高、20–40% 中、<20% 低' });
  if (nm != null) health.push({ item: '淨利率', level: nm >= 15 ? '高' : nm >= 5 ? '中' : '低', value: nm, basis: '≥15% 高、5–15% 中、<5% 低' });
  /* ROE > 100% 時不能標「高」就了事：那通常是庫藏股讓權益縮小造成的，
     直接和同業比會誤導。仍在 health 裡，但 level 標「高（權益縮小）」，
     並保留原始 note 讓模型與使用者看得到原因。 */
  if (roe != null) {
    let lvl = roe >= 15 ? '高' : roe >= 8 ? '中' : '低';
    if (roe > 100) lvl = '高（權益縮小所致）';
    health.push({ item: 'ROE', level: lvl, value: roe, basis: '≥15% 高、8–15% 中、<8% 低；>100% 需注意權益基數' });
  }
  if (dr != null) health.push({ item: '負債比', level: dr <= 40 ? '低' : dr <= 65 ? '中' : '高', value: dr, basis: '≤40% 低、40–65% 中、>65% 高' });

  return {
    available: facts.length > 0,
    facts,
    health,
    asOf: (f && f.asOf) || null,
    period: (m.revenue && m.revenue.basis) || null,
    entity: (f && (f.entityName || f.entity)) || null,
    source: (f && f.source) || null,
  };
}

/** 財報摘要句，供規則層直接使用（也讓 LLM 有共同的事實基礎）。 */
function financialSummaryLine(fin) {
  if (!fin || !fin.available) return '未取得財報資料，以下僅就新聞內容判讀。';
  const pick = (k) => {
    const h = fin.health.find((x) => x.item === k);
    if (!h) return null;
    // level 可能是「高（權益縮小所致）」，摘要句用短標籤即可
    const short = String(h.level).split('（')[0];
    return `${k} ${h.value}（${short}）`;
  };
  const parts = ['毛利率', '淨利率', 'ROE', '負債比'].map(pick).filter(Boolean);
  if (!parts.length) return '財報資料有限，僅就可得項目判讀。';
  return `最新財報：${parts.join('、')}。`;
}

/* ============================================================
   關鍵句抽取（規則層用）
   ============================================================ */

/**
 * 句子切分。處理常見縮寫，避免在 "U.S." 之後被切斷。
 * 中英文都要能切：中文正文常常沒有空白分隔，只靠標點。
 */
function splitSentences(text) {
  return String(text || '')
    .replace(/\b(U\.S|U\.K|Inc|Ltd|Co|Corp|Mr|Ms|Dr|No|vs|e\.g|i\.e)\./g, '$1<DOT>')
    .split(/(?<=[。！？])|(?<=[.!?])\s+/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter((s) => s.length > 25);
}

/* ---- 方向判斷：片語優先，單詞為輔 -------------------------------
 *
 * 為什麼不能只數單詞（這是實測踩到的坑）：
 *   句子「12 月季度毛利率指引降至 45% 至 46%」裡同時有 margin 與 down。
 *   舊版把 'margin' 放進正面詞表，於是「毛利率被下修」被判成**利多**，
 *   最後出現在「看好」欄第 2 點。方向完全相反，比沒有功能更危險。
 *
 * 解法：先比對「有意義的片語」，每個片語自帶方向與權重；
 * 片語未命中的部分才退回單詞計數。片語權重（2–3.5）遠高於單詞（1），
 * 因此「毛利率指引下修」整體必為負，不會被 margin 這個單詞翻正。
 */

const BULL_PHRASES = [
  { w: 3.5, re: /\b(beat|beats|beating|exceed(?:ed|s|ing)?|above (?:expectations|estimates|consensus)|better than expected|ahead of (?:expectations|estimates))\b/i },
  { w: 3.0, re: /\brecord (?:revenue|profit|quarter|high|sales|earnings|results|demand)\b/i },
  { w: 3.0, re: /\b(rais(?:e|es|ed|ing)|lift(?:s|ed|ing)?|hik(?:e|es|ed|ing)|boost(?:s|ed|ing)?|increas(?:e|es|ed|ing))\b[^.]{0,40}\b(guidance|outlook|forecast|dividend|buyback|target|estimate)\b/i },
  // 「壓低成本」是正面，必須在單詞層的 lower/cut 之前先被片語吃掉
  { w: 2.5, re: /\b(lower(?:ed|s|ing)?|cut(?:s|ting)?|reduc(?:e|es|ed|ing))\b[^.]{0,25}\b(cost|costs|expense|expenses|spending)\b/i },
  { w: 3.0, re: /\b(upgrade[sd]?|outperform\w*|buy rating|bullish|top pick|overweight|price target raised)\b/i },
  { w: 2.5, re: /\b(surge[sd]?|soar\w*|jump\w*|rall(?:y|ied|ies)|climb\w*|gain(?:ed|s|ing)?|rebound\w*|recover\w*)\b/i },
  { w: 2.0, re: /\b(growth|grew|grow(?:s|ing)?|expans\w+|expand(?:ed|s|ing)?)\b/i },
  { w: 2.0, re: /\b(free cash flow|market share gain|margin expansion|profitab\w+|cash flow)\b/i },
  { w: 2.0, re: /\b(strong|solid|robust|healthy|resilient)\b[^.]{0,40}\b(demand|growth|results|sales|revenue|margin|balance|earnings|quarter)\b/i },
  { w: 2.0, re: /\b(demand)\b[^.]{0,30}\b(strong|solid|robust|healthy|rising|growth|outpac\w*)\b/i },
  { w: 2.0, re: /\b(new (?:deal|order|contract|partnership|launch)|partnership|win(?:s|ning)?|won|approv(?:al|ed))\b/i },
  { w: 2.0, re: /\b(buyback|repurchase|dividend)\b/i },
  { w: 1.5, re: /\b(ris(?:e|es|en|ing)|rose)\b/i },
];

const BEAR_PHRASES = [
  // 「下修指引」——舊版最致命的誤判來源，權重給到最高
  { w: 3.5, re: /\b(cut|cuts|cutting|lower(?:ed|s)?|reduce[sd]?|slash(?:ed|es)?|trim(?:med|s)?)\b[^.]{0,40}\b(guidance|outlook|forecast|estimate|target)\b/i },
  { w: 3.5, re: /\b(guidance|outlook|forecast)\b[^.]{0,40}\b(below|down|lower|cut|weak|soft)\b/i },
  { w: 3.0, re: /\b(pressur\w*|squeez\w*|erod\w*|erosion|drag(?:ged|s)?|weigh(?:ed|s|ing)?|hurt(?:s|ing)?)\b[^.]{0,50}\b(margin|profit|earnings|revenue|growth|sales)\b/i },
  { w: 3.0, re: /\b(margin|profit|earnings|revenue|sales)\b[^.]{0,50}\b(pressur\w*|squeez\w*|erod\w*|declin\w*|fall\w*|dr(opped|op)|shrink\w*|contract\w*)\b/i },
  { w: 3.0, re: /\b(cost|costs|prices?|expenses?)\b[^.]{0,40}\b(surg\w*|soar\w*|jump\w*|ris(?:e|es|ing)|climb\w*|spik\w*|higher|increas\w*)\b/i },
  { w: 2.5, re: /\b(growth|revenue|sales|demand)\b[^.]{0,25}\b(slow\w*|stall\w*|weaken\w*|soften\w*)\b/i },
  { w: 3.0, re: /\b(lawsuit|sues?|sued|antitrust|class action|probe|investigation|inquiry|penalt\w+|fine[sd]?|ruling against|injunction)\b/i },
  { w: 2.5, re: /\b(bann?ed|bans|remov\w+ from|pull(?:s|ed)? from|blocked|restrict\w*|curb\w*|barred)\b/i },
  { w: 2.5, re: /\b(child safety|content moderation|age verification|regulatory (?:scrutiny|pressure|risk|probe)|compliance (?:risk|cost|burden))\b/i },
  { w: 3.0, re: /\b(downgrade[sd]?|underperform\w*|sell rating|below (?:expectations|estimates|consensus)|miss(?:es|ed)? (?:expectations|estimates|revenue|earnings))\b/i },
  { w: 2.0, re: /\b(selloff|sell-off|rout|slump\w*|plunge[sd]?|tumble[sd]?|sank|crash\w*|sink\w*)\b/i },
  { w: 2.0, re: /\b(loss(?:es)?|weaker|weakness|slowdown|headwind\w*|tariff\w*|layoff\w*|recall\w*|defect\w*|halt\w*|shortage\w*|unprecedented)\b/i },
  { w: 1.5, re: /\b(delay\w*|risk\w*|concern\w*|worry|worries|uncertain\w*|doubt\w*)\b/i },
  { w: 1.5, re: /\b(declin\w*|fell|fall(?:s|ing)?|dr(opped|op|ops)|dropping|slid\w*)\b/i },
];

/* 單詞層只作補充訊號（權重 1）。刻意拿掉舊版的 'margin'：
   它是最容易被上下文反轉的詞，必須交給片語判斷。 */
const POS_WORDS = [
  'beat', 'beats', 'record', 'strong', 'stronger', 'growth', 'grow', 'grew', 'rise', 'rose',
  'gain', 'gains', 'surge', 'jump', 'rally', 'upgrade', 'raised', 'outperform', 'optimistic',
  'bullish', 'upside', 'recovery', 'rebound', 'momentum', 'outpace', 'win', 'wins', 'won',
  'approval', 'partnership', 'profit', 'profitable', 'efficient',
];

const NEG_WORDS = [
  'miss', 'misses', 'fell', 'fall', 'drop', 'dropped', 'decline', 'declined', 'slump',
  'plunge', 'plunged', 'tumble', 'sink', 'sank', 'weak', 'weaker', 'weakness', 'loss',
  'losses', 'downgrade', 'cut', 'cuts', 'lower', 'lowered', 'underperform', 'risk',
  'concern', 'concerns', 'worry', 'worries', 'pressure', 'pressured', 'bearish',
  'downside', 'lawsuit', 'probe', 'investigation', 'fine', 'penalty', 'ban', 'restrict',
  'delay', 'delayed', 'shortage', 'slowdown', 'headwind', 'tariff', 'recall', 'defect',
  'layoff', 'layoffs', 'warning', 'warns', 'warned', 'halt',
];

/**
 * 單句方向分數。
 * @returns {{pos:number, neg:number, net:number, total:number}}
 *   net > 0 偏多、net < 0 偏空。pos/neg 皆為正數（強度），net 才是方向。
 */
function cueScore(sentence) {
  const s = String(sentence || '');
  if (!s) return { pos: 0, neg: 0, net: 0, total: 0 };

  let pos = 0;
  let neg = 0;

  for (const p of BULL_PHRASES) if (p.re.test(s)) pos += p.w;
  for (const p of BEAR_PHRASES) if (p.re.test(s)) neg += p.w;

  // 單詞補充訊號：先正規化成單詞集合，避免用幾十個 RegExp 反覆掃描
  const words = new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
  for (const w of POS_WORDS) if (words.has(w)) pos += 1;
  for (const w of NEG_WORDS) if (words.has(w)) neg += 1;

  return {
    pos: +pos.toFixed(2),
    neg: +neg.toFixed(2),
    net: +(pos - neg).toFixed(2),
    total: +(pos + neg).toFixed(2),
  };
}

/* 實質內容詞：句中有這些詞，通常就是真正的「要點」而非背景描述。 */
const SUBSTANCE_RE = /\b(revenue|sales|earnings|profit|margin|guidance|outlook|forecast|eps|dividend|buyback|cash flow|capex|capital expenditure|subscri\w+|shipment\w+|market share|tariff\w*|regulat\w+|antitrust|lawsuit|probe|approval|quarter|fiscal|year-over-year|billion|million|percent|costs?|pricing)\b/i;

/* 垃圾句：不是「要點」，而是新聞業的制式旁白、導覽句或無主體描述。
   實測抓到「Reuters did not report a corresponding removal from Google Play.」
   被當成看跌要點——它既不構成利空，也不是任何分析。這類句子必須先剔除。 */
const JUNK_RES = [
  /\b(did not|does not|do not|could not|was not|is not) (immediately )?(report|respond|comment|confirm|reach)\b/i,
  /\b(click|tap|scroll|subscribe|sign up|read more|continue reading|newsletter|download the app)\b/i,
  /\b(drawing on|in a statement|said in a|spokesperson|declined to comment|couldn't be reached)\b/i,
  /\b(all rights reserved|copyright|©|terms of (?:use|service)|privacy policy)\b/i,
  /\b(is|are) (?:apple|the company|the stock|its shares?)\b[^.]{0,20}\b(outperforming|underperforming)\b/i,
];

/** 這句是不是制式旁白／導覽／無資訊量的句子。 */
function isJunkSentence(s) {
  const t = String(s || '');
  if (!t) return true;
  return JUNK_RES.some((re) => re.test(t));
}

/**
 * 句子是否「與標的相關」。
 *
 * 實測問題：抓 Verizon 那篇時，正文第一句是
 * 「Verizon's shares have gained 15.6% over the past year…」，
 * 它情緒明確、也有數字，於是穩坐看好欄第一名——但它講的是 Verizon，
 * 對 AAPL 沒有意義。
 * 做法：句中有競品/其他公司主語、卻完全沒提到標的（公司名或代號）→ 不相關。
 * 只在「有提供標的名稱」時啟用，避免無法判斷時誤殺。
 */
function isRelevantSentence(s, ctx) {
  const t = String(s || '');
  const c = ctx || {};
  if (!t) return true;

  /* 名稱要做「變體」比對。實測踩到的坑：
     name 是 "Apple Inc."，句子寫的是 "Apple shares rose…"，
     直接比對 "apple inc." 找不到，於是自家新聞被誤判成他家公司。
     所以除了全名，還要放進去掉 Inc./Corp./Ltd. 後的主名，
     以及代號。 */
  const base = [c.name, c.shortName]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase())
    .reduce((acc, n) => {
      acc.push(n);
      const trimmed = n.replace(/\b(inc|corp|corporation|ltd|limited|co|company|plc|sa|ag|nv|holdings?)\b\.?/g, '').trim();
      if (trimmed && trimmed !== n) acc.push(trimmed);
      return acc;
    }, []);
  if (c.symbol) base.push(String(c.symbol).toLowerCase());

  if (!base.length) return true;              // 無標的資訊 → 不判斷

  const low = t.toLowerCase();
  if (base.some((n) => low.indexOf(n) >= 0)) return true;   // 提到標的 → 一定相關

  /* 沒提到標的時，若句首主語是別家公司，就是不相關。
     用「句子開頭 60 字內出現 X's shares / X shares / X stock」判斷。 */
  const OTHER_SUBJECT = /^[^.]{0,60}?\b([A-Z][A-Za-z&.\-]{1,20})(?:'s)?\s+(?:shares|stock|results|revenue|earnings)\b/;
  if (OTHER_SUBJECT.test(t)) return false;

  return true;
}

/**
 * 句子是否為「目錄式標題」而非正文內容。
 *
 * 實測：Yahoo 的 og:description 常是「A, B and C battle for dominance as…」
 * 這種把多篇標題串起來的導言，被當成要點會讓使用者一頭霧水。
 * 特徵：逗號很多、沒有動詞時態、以省略號結尾。
 */
function isListySentence(s) {
  const t = String(s || '');
  if (!t) return false;
  /* 省略號結尾是「被截斷的導言」，幾乎都是目錄式標題串接，
     不論逗號幾個都不可當要點：句子本身不完整，讀者無法理解語意。 */
  if (/[…]$|\.\.\.$/.test(t.trim())) return true;

  /* 多逗號且短 → 標題串接。
     注意別把逗號多但語意完整的財報句誤殺：
     「Free cash flow reached about $136 billion in fiscal 2026,
       up nearly 38%, as revenue rose 15%.」只有 2 個逗號，
     所以門檻設在 3 個以上，且要求句中沒有主要動詞。 */
  const commas = (t.match(/,/g) || []).length;
  if (commas >= 3 && t.length < 200) return true;
  return false;
}

/**
 * 從一則新聞抽出「方向明確」的要點句。
 *
 * 兩個條件的交集才取：
 *   ① 有方向（|net| ≥ MIN_NET）→ 否則這句放進任何一欄都是誤導
 *   ② 有實質內容（含財務/政策詞或數字）→ 否則只是一句背景描述
 *
 * 舊版只按「情緒詞總量」排序，結果挑出
 * 「Verizon shares have gained 15.6%」這種與標的無關、且純屬描述市場表現的句子。
 * 加入 SUBSTANCE_RE 與方向門檻後，會優先落到「毛利率指引下修」這類真要點。
 */
const MIN_NET = 1.5;

function extractPoints(item, maxPerItem, ctx) {
  const max = maxPerItem || 1;
  const body = String(item.body || '');
  if (!body) return [];

  /* 先剔除垃圾句與不相關句，再評分。
     順序很重要：若先評分再過濾，「Verizon shares gained 15.6%」這種
     情緒強、又含數字的句子會先被選中，之後才被丟掉，結果整則沒有要點。 */
  const sents = splitSentences(body).filter((s) => !isJunkSentence(s)
    && !isListySentence(s)
    && isRelevantSentence(s, ctx));
  if (!sents.length) return [];

  const scored = sents.map((s, i) => {
    const c = cueScore(s);
    let s2 = Math.abs(c.net) * 2;                // 先看方向強度
    if (SUBSTANCE_RE.test(s)) s2 += 2.0;         // 有財務/政策實質內容
    if (/\d/.test(s)) s2 += 1.0;                 // 有數字較具體
    if (i === 0) s2 += 0.5;                      // 首句常為主題句
    if (s.length > 240) s2 -= 1.5;               // 過長難掃讀
    if (s.length < 45) s2 -= 0.5;                // 過短資訊量不足
    return { s, i, score: s2, cue: c };
  });

  // 先取有方向的句；若整篇都沒有，才退回純內容分數（但仍標 net=0）
  const directional = scored.filter((x) => Math.abs(x.cue.net) >= MIN_NET);
  const pool = directional.length ? directional : scored;
  pool.sort((a, b) => b.score - a.score);

  return pool.slice(0, max).map((x) => ({
    text: trimSentence(x.s, 150),
    pos: x.cue.pos,
    neg: x.cue.neg,
    net: x.cue.net,
    directional: Math.abs(x.cue.net) >= MIN_NET,
  }));
}

/** 截斷句子但保留完整語意（優先在逗號處斷）。 */
function trimSentence(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastComma = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('，'), cut.lastIndexOf('; '));
  if (lastComma > max * 0.55) return cut.slice(0, lastComma) + '…';
  return cut.slice(0, max - 1) + '…';
}

/* ============================================================
   規則層：正反分類
   ============================================================ */

/**
 * 把每則新聞歸到「看好」或「看跌」，並產出與 LLM 層**相同結構**的結果。
 *
 * 為什麼一定要同結構：前端只寫一套渲染邏輯。若規則層少欄位，
 * 畫面就會出現 undefined 或空白區塊——實測第一次就是這樣。
 *
 * 判定原則：
 *   方向必須與「被顯示的那句話」一致。舊版用整篇正文的淨值決定方向，
 *   卻顯示另一句話，於是出現「文字寫毛利率下修、卻放在看好欄」的矛盾。
 *   現在方向直接取自 extractPoints 挑中的那一句。
 */
function classifyRuleLayer(items, fin, ctx) {
  const bull = [];
  const bear = [];
  const neutral = [];
  const c = ctx || {};

  /* newsIndex 必須與 LLM 層的編號一致（1-based，對應顯示順序）。
     舊版讀 it.index，但 enrichNews 的回傳沒有這個欄位，於是永遠 null，
     前端就無法把要點連回原文。這裡直接用陣列位置補上。 */
  items.forEach((it, pos) => {
    const index = pos + 1;
    const pts = extractPoints(it, 1, c);
    const chosen = pts[0] || null;

    // 方向：優先採用被選中那句自己的 net；沒有正文時退回標題
    let net;
    if (chosen && chosen.directional) net = chosen.net;
    else {
      const tc = cueScore(it.title || '');
      net = tc.net;
    }

    /* 疑問句標題不帶方向。「Is Apple Stock Outperforming the Nasdaq?」
       含有 outperform，會被判成利多——但那只是個問句，不是結論。
       問句一律降為中性，讓它落在 neutral 而不是污染看好欄。 */
    const isQuestion = /\?\s*$|^(is|are|can|could|will|would|should|does|do|did|has|have|why|what|how|when)\b/i.test(String(it.title || '').trim());
    if (isQuestion) net = 0;

    /* 要點文字：優先用正文句；若只有標題，且標題本身被截斷（以 … 結尾）
       或只是疑問句，就不適合當「要點」，改由呼叫端視為無要點。 */
    let pointText = chosen ? chosen.text : String(it.title || '').trim();
    if (!chosen) {
      const t = String(it.title || '').trim();
      if (/[…]$|\.\.\.$/.test(t) || isQuestion) pointText = '';
    }

    const entry = {
      title: it.title || '',
      publisher: it.publisher || null,
      link: it.resolvedUrl || it.link || null,
      time: it.time || null,
      ageText: it.ageText || '',
      topic: it.topic || 'other',
      topicLabel: it.topicLabel || '其他',
      point: pointText,
      side: net > 0 ? 'bull' : net < 0 ? 'bear' : 'neutral',
      weight: Math.abs(net),
      newsIndex: index,
      /* 規則層的 fundamentalLink 由財務事實反推，不是空著。
         前端兩欄的版面一致，少了這欄會出現高度不齊的卡片。 */
      fundamentalLink: linkToFinancial(net, it, fin),
      bodyChars: it.bodyChars || 0,
    };

    if (net > 0 && pointText) bull.push(entry);
    else if (net < 0 && pointText) bear.push(entry);
    else neutral.push(entry);
  });

  const byWeight = (a, b) => b.weight - a.weight || (b.time || 0) - (a.time || 0);
  bull.sort(byWeight);
  bear.sort(byWeight);

  const bullTop = bull.slice(0, 6);
  const bearTop = bear.slice(0, 6);

  return {
    mode: 'rule',
    bull: bullTop,
    bear: bearTop,
    neutral,
    bullCount: bullTop.length,
    bearCount: bearTop.length,
    focus: buildFocusFallback(bullTop, bearTop),
    sentiment: toSentiment(bull.length, bear.length),
    financial: {
      line: financialSummaryLine(fin),
      read: buildRuleRead(fin, bull.length, bear.length),
    },
    caveats: buildRuleCaveats(fin, bull.length, bear.length),
    adjusted: [],
    note: '以片語方向詞典與正文關鍵句分類；未設定 LLM 時使用此模式。',
  };
}

/** 多空則數 → sentiment（與 ai-analyst 的命名一致，前端可共用顏色）。 */
function toSentiment(bullN, bearN) {
  const t = bullN + bearN;
  if (!t) return 'neutral';
  if (bullN >= 2 && bearN >= 2 && Math.abs(bullN - bearN) <= Math.max(1, t * 0.25)) return 'mixed';
  const r = bullN / t;
  if (r >= 0.65) return 'positive';
  if (r <= 0.35) return 'negative';
  return 'neutral';
}

/**
 * 規則層的「這點與哪個財務指標有關」。
 *
 * 只用已經存在的財務事實組句，不新增數字。
 * 依要點方向挑最相關的指標：看空優先談毛利率/負債比，看多優先談淨利率/營收成長。
 */
function linkToFinancial(net, item, fin) {
  if (!fin || !fin.available) return '未取得財報資料，無法對應財務指標。';

  const val = (k) => {
    const h = fin.health.find((x) => x.item === k);
    return h ? h.value : null;
  };
  const lvl = (k) => {
    const h = fin.health.find((x) => x.item === k);
    return h ? String(h.level).split('（')[0] : null;
  };

  const text = `${item.title || ''} ${(item.body || '').slice(0, 900)}`;
  const gm = val('毛利率');
  const nm = val('淨利率');
  const yoy = (fin.facts.find((f) => f.key === 'revenueYoY') || {}).value;
  const dr = val('負債比');

  // 成本/毛利/指引類 → 毛利率
  if (/\b(margin|cost|costs|pricing|guidance|outlook)\b/i.test(text) && gm != null) {
    return net < 0
      ? `成本端壓力直接影響毛利率 ${gm}%（現屬${lvl('毛利率')}檔），是指引下修時最先被檢視的指標。`
      : `對毛利率 ${gm}%（${lvl('毛利率')}檔）屬正向支撐，但仍需觀察能否在後續季度延續。`;
  }
  // 營收/需求/成長類 → 營收年增率
  if (/\b(revenue|sales|demand|growth|subscri\w+|shipment\w+)\b/i.test(text) && yoy != null) {
    return net < 0
      ? `需求走弱會壓抑營收年增率（現為 ${yoy}%），成長動能面臨減速風險。`
      : `需求回溫有助維持營收年增率 ${yoy}%，支撐獲利基數。`;
  }
  // 監管/訴訟類 → 服務收入與毛利率結構
  if (/\b(regulat\w*|antitrust|lawsuit|probe|ban\w*|app store|penalt\w*)\b/i.test(text)) {
    return gm != null
      ? `監管風險主要落在高毛利業務上，若規則改變會影響毛利率 ${gm}% 的結構。`
      : '監管風險影響高毛利業務，惟目前無可對應的財務數字。';
  }
  // 獲利品質類
  if (net > 0 && nm != null) {
    return `淨利率 ${nm}%（${lvl('淨利率')}檔）是本業獲利效率的觀察點。`;
  }
  if (net < 0 && dr != null) {
    return `負債比 ${dr}%（${lvl('負債比')}檔）偏高時，外部衝擊的緩衝空間較小。`;
  }
  return fin.facts.length
    ? `對照現有財報指標判讀，未見直接對應項目。`
    : '未取得財報資料，無法對應財務指標。';
}

/** 規則層也要講清楚資料限制，不能讓使用者誤以為是 LLM 深度分析。 */
function buildRuleCaveats(fin, bullN, bearN) {
  const out = [];
  if (!fin || !fin.available) out.push('未取得財報資料，基本面解讀僅為一般性說明。');
  if (bullN + bearN === 0) out.push('本批新聞缺乏明確方向詞，未強行二分。');
  out.push('要點由正文關鍵句抽取，未經語意改寫，建議點回原文確認上下文。');
  return out;
}

/**
 * 規則層的「結合財報」解讀。
 *
 * 只做能從數字直接推得的陳述，不猜因果。
 * 例如「毛利率高 → 抗成本上升能力較強」是合理推論；
 * 「毛利率高 → 股價會漲」就不是。
 */
function buildRuleRead(fin, bullN, bearN) {
  if (!fin || !fin.available) {
    return '未取得財報資料，無法對照基本面。以下僅反映新聞本身的傾向。';
  }

  const out = [];
  /* level 可能是「高（權益縮小所致）」，直接與 '高' 比會漏掉。
     必須先取短標籤，否則 AAPL 的 ROE 那句永遠不會出現。 */
  const shortLvl = (k) => {
    const h = fin.health.find((x) => x.item === k);
    return h ? String(h.level).split('（')[0] : null;
  };
  const lvl = shortLvl;
  const val = (k) => (fin.health.find((x) => x.item === k) || {}).value;

  const gm = lvl('毛利率');
  const nm = lvl('淨利率');
  const roe = lvl('ROE');
  const dr = lvl('負債比');

  if (gm === '高') out.push(`毛利率 ${val('毛利率')}% 屬高檔，對成本上升（如零組件漲價、關稅）的緩衝較厚。`);
  else if (gm === '低') out.push(`毛利率 ${val('毛利率')}% 偏低，成本端稍有波動就容易壓縮獲利。`);

  if (nm === '高') out.push(`淨利率 ${val('淨利率')}% 顯示本業獲利效率佳，題材發酵時較容易反映在 EPS。`);
  else if (nm === '低') out.push(`淨利率 ${val('淨利率')}% 偏薄，營收成長未必能同步轉為獲利。`);

  if (roe === '高') {
    // ROE 因權益縮小而虛高時，講「資本效率好」會誤導，要直說原因
    const raw = fin.health.find((x) => x.item === 'ROE') || {};
    if (String(raw.level).indexOf('權益縮小') >= 0) {
      out.push(`ROE ${val('ROE')}% 偏高主要來自庫藏股使權益縮小，不宜視為純粹的獲利效率提升，也不宜與同業直接比較。`);
    } else {
      out.push(`ROE ${val('ROE')}% 偏高，資本使用效率好，是長線資金的加分項。`);
    }
  }

  if (dr === '高') out.push(`負債比 ${val('負債比')}% 偏高，利率或信用環境轉緊時壓力較大。`);
  else if (dr === '低') out.push(`負債比 ${val('負債比')}% 偏低，財務結構穩健。`);

  if (bullN === 0 && bearN === 0) {
    out.push('本批新聞沒有明顯方向性，對基本面的邊際影響有限。');
  } else if (bullN === 0) {
    out.push(`本批新聞無明確看多要點，看空 ${bearN} 則，短期雜音偏多。`);
  } else if (bearN === 0) {
    out.push(`本批新聞無明確看空要點，看多 ${bullN} 則，市場氛圍偏正面，但仍需確認體質是否支撐。`);
  } else {
    /* 舊版用 bullN > bearN*2，導致 4:2 被說成「數量接近」。
       改成看比例，並把「勢均力敵」限定在差距確實小時。 */
    const total = bullN + bearN;
    const gap = Math.abs(bullN - bearN) / total;
    if (gap <= 0.2) {
      out.push(`看多（${bullN}）與看空（${bearN}）數量接近，屬於多空分歧，方向未明。`);
    } else if (bullN > bearN) {
      out.push(`看多要點（${bullN} 則）多於看空（${bearN} 則），市場關注偏向正面，但仍需對照上述體質是否支撐。`);
    } else {
      out.push(`看空要點（${bearN} 則）多於看多（${bullN} 則），短期雜音偏多，宜對照體質判斷是情緒還是基本面轉弱。`);
    }
  }

  return out.join(' ');
}

/* ============================================================
   LLM 層
   ============================================================ */

const SCHEMA_HINT = `{
  "bull": [{"point":"繁體中文 20–40 字要點","newsIndex":1,"fundamentalLink":"繁體中文，說明這點與哪個財務指標有關"}],
  "bear": [{"point":"繁體中文 20–40 字要點","newsIndex":2,"fundamentalLink":"繁體中文，說明這點與哪個財務指標有關"}],
  "focus": "繁體中文 40–80 字，說明市場目前最在意什麼",
  "fundamentalRead": "繁體中文 80–150 字，結合財務數字解讀上述要點對基本面的影響",
  "caveats": ["資料不足之處"]
}`;

/**
 * 組 LLM prompt。
 *
 * 關鍵設計：把「新聞編號 → 正文」與「財務事實」分開給，
 * 並要求模型用 newsIndex 回指，這樣前端才能把要點連回原文。
 * 若不給編號，模型產出的要點無法溯源，等於不可查證的斷言。
 */
function buildPrompt(articles, fin, ctx) {
  const list = articles.map((a, i) => ({
    index: i + 1,
    title: a.title,
    publisher: a.publisher,
    topic: a.topicLabel || null,
    body: String(a.body || a.excerpt || '').slice(0, 700),
  }));

  const input = {
    標的: { symbol: ctx.symbol, name: ctx.name || null },
    財務事實: fin.available
      ? { facts: fin.facts, 體質評級: fin.health, 期間: fin.period, 截止: fin.asOf }
      : null,
    價格脈絡: ctx.price || null,
    新聞: list,
  };

  return [
    '你是一位嚴謹的財經分析師。任務：把以下新聞整理成「市場對這檔股票最關注的項目」，',
    '分成「看好」與「看跌」兩欄，並結合財務數字說明對基本面的影響。',
    '',
    '嚴格規則（違反會導致輸出被丟棄）：',
    '1. 只能引用我提供的財務數字，**絕對不可新增、推算或估計任何數值**。',
    '2. 不可給目標價、不可預測股價、不可建議買賣。',
    '3. 每個要點都必須標 `newsIndex`，指向上面新聞清單的 index；不得捏造不存在的編號。',
    '4. 同一件事只寫一次。兩欄之間**不可重複**同一個要點。',
    '5. 若某則新聞其實是中性的，就不要硬塞進任何一欄。**寧可少列，不可濫列**。',
    '6. 每欄最多 6 點。要點必須具體（講「AI 功能帶動換機需求」而非「消息面利多」）。',
    '7. `fundamentalLink` 必須對應到提供的財務指標（如毛利率、淨利率、ROE、負債比、營收年增率）。',
    '8. 資料不足時在 `caveats` 明說，不可編造。',
    '9. **一律使用繁體中文**（台灣用語），不可使用簡體字。',
    '10. 只輸出 JSON 物件，不要 markdown 圍欄、不要說明文字。',
    '',
    '輸出格式：',
    SCHEMA_HINT,
    '',
    '輸入資料：',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

/** 校正 LLM 輸出。任何改動都記錄，不靜默採用。 */
function validate(raw, articles, fin) {
  const adjusted = [];
  const out = { bull: [], bear: [], focus: '', fundamentalRead: '', caveats: [] };

  const normSide = (arr, side) => {
    const list = Array.isArray(arr) ? arr : [];
    const seen = new Set();
    const res = [];
    for (const x of list) {
      if (!x || typeof x !== 'object') continue;
      const point = String(x.point || '').trim();
      if (!point) { adjusted.push(`${side}：空要點已丟棄`); continue; }
      // 去重（同欄內）
      const key = point.replace(/\s/g, '').slice(0, 24);
      if (seen.has(key)) { adjusted.push(`${side}：重複要點已丟棄`); continue; }
      seen.add(key);

      const idx = Number(x.newsIndex);
      const validIdx = Number.isInteger(idx) && idx >= 1 && idx <= articles.length ? idx : null;
      if (validIdx == null) adjusted.push(`${side}：「${point.slice(0, 12)}…」的 newsIndex 無效`);

      const src = validIdx ? articles[validIdx - 1] : null;

      res.push({
        point,
        newsIndex: validIdx,
        fundamentalLink: String(x.fundamentalLink || '').trim() || null,
        title: src ? src.title : null,
        publisher: src ? src.publisher : null,
        link: src ? (src.resolvedUrl || src.link) : null,
        /* 以下欄位 LLM 不會給，必須由來源新聞補齊。
           前端兩欄共用同一套渲染，若 side/topic/time 缺漏，
           排名徽章、分類標籤與時間都會變成空白——實測稽核出 12 個缺欄。 */
        side,
        time: src ? (src.time || null) : null,
        ageText: src ? (src.ageText || '') : '',
        topic: src ? (src.topic || 'other') : 'other',
        topicLabel: src ? (src.topicLabel || '其他') : '其他',
        weight: 0,
        bodyChars: src ? (src.bodyChars || 0) : 0,
      });
      if (res.length >= 6) break;
    }
    return res;
  };

  out.bull = normSide(raw.bull, '看好');
  out.bear = normSide(raw.bear, '看跌');

  /* ---- 剔除「只是在複述財務數字」的假要點 ----
     實測模型會產出「負債比 72.29% 偏高，財務體質評級列為高負債」這種條目。
     它不是新聞要點，而是把上面已經列出的財務事實換句話說一次，
     對使用者是重複資訊，且會讓兩欄看起來像在湊數。
     判準：要點裡沒有「事件性詞彙」卻出現財務指標名 → 視為複述。
     注意只砍「幾乎只講數字」的，不要誤殺「毛利率指引下修」這種真事件。 */
  const METRIC_RE = /(毛利率|淨利率|營業利益率|負債比|ROE|營收年增率|稀釋\s*EPS)/;
  const EVENT_RE = /\b(guidance|outlook|forecast|下修|上調|下調|宣布|推出|發布|起訴|訴訟|裁決|下架|召回|裁員|收購|合併|達成|簽署|漲價|降價|削減|增加|成長|衰退|超越|不如預期|優於預期)\b|(指引|展望|預測|新產品|新功能|合作|協議|判決|調查|罰款|禁令|關稅|漲價|降價)/i;
  const isMetricRestate = (x) => {
    const p = String(x.point || '');
    if (!METRIC_RE.test(p)) return false;          // 沒提指標 → 不是複述
    if (EVENT_RE.test(p)) return false;            // 有事件詞 → 是真要點
    return p.length <= 42;                         // 短且只有指標 → 複述
  };
  const beforeBull = out.bull.length;
  const beforeBear = out.bear.length;
  out.bull = out.bull.filter((x) => !isMetricRestate(x));
  out.bear = out.bear.filter((x) => !isMetricRestate(x));
  if (out.bull.length < beforeBull || out.bear.length < beforeBear) {
    adjusted.push('已移除只複述財務數字的要點（避免與財報區重複）');
  }

  /* 跨欄去重：同一要點不可同時出現在兩欄。
     實測模型偶爾會把「監管風險」同時寫成「看空依據」與「看多機會（利空出盡）」，
     這對使用者是混淆而非資訊。保留先出現的一欄。 */
  const bullKeys = new Set(out.bull.map((b) => b.point.replace(/\s/g, '').slice(0, 16)));
  const before = out.bear.length;
  out.bear = out.bear.filter((b) => !bullKeys.has(b.point.replace(/\s/g, '').slice(0, 16)));
  if (out.bear.length < before) adjusted.push('看跌欄中有要點與看好欄重複，已移除');

  out.focus = String(raw.focus || '').trim();
  out.fundamentalRead = String(raw.fundamentalRead || '').trim();
  out.caveats = (Array.isArray(raw.caveats) ? raw.caveats : [])
    .map((c) => String(c || '').trim()).filter(Boolean).slice(0, 4);

  /* caveats 去重：模型有時已在 caveats 裡寫「未提供財報數字」，
     我們再加一句就會重複，使用者會以為系統在鬼打牆。 */
  const NO_FIN = '未取得財報資料，基本面解讀僅為一般性說明。';
  if (!fin.available) {
    const already = out.caveats.some((c) => /未取得財報|財務數字未提供|未提供財報/.test(c));
    if (!already) out.caveats.push(NO_FIN);
  }

  return { out, adjusted };
}

/**
 * 主入口：產生看好／看跌分析。
 *
 * @param {object[]} articles  已補正文的新聞（article-fetch.enrichNews 的輸出）
 * @param {object}   fin       buildFinancialFacts 的結果
 * @param {object}   ctx       { symbol, name, price, llmCfg, wantLlm, refresh }
 */
async function analyzeSides(articles, fin, ctx) {
  const c = ctx || {};
  const list = Array.isArray(articles) ? articles : [];
  const financial = fin || { available: false, facts: [], health: [] };

  if (!list.length) {
    return {
      mode: 'none',
      bull: [], bear: [], neutral: [],
      bullCount: 0, bearCount: 0,
      focus: '目前沒有可取用的新聞。',
      sentiment: 'neutral',
      financial: { line: financialSummaryLine(financial), read: '' },
      caveats: ['無新聞可分析。'],
      note: '無新聞資料',
    };
  }

  const wantLlm = c.wantLlm !== false && llm.isConfigured() && list.length > 0;

  /* ------------------------------------------------------------
     LLM 結果快取
     ------------------------------------------------------------
     單次 LLM 呼叫實測 6–8 秒。若不快取，使用者每次進個股頁、
     每次切分頁、每次重新整理都會重跑一次，體感等同功能壞掉。
     快取鍵包含：標的、新聞標題集合、財務數字快照 —— 任一改變就重算，
     因此不會出現「新聞更新了但分析還是舊的」這種更糟的情況。
     ------------------------------------------------------------ */
  const cacheKey = wantLlm ? buildSidesCacheKey(c.symbol, list, financial) : null;
  if (cacheKey && !c.refresh) {
    const hit = sidesCacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  if (wantLlm) {
    const prompt = buildPrompt(list, financial, c);
    const res = await llm.callLlm({
      prompt, cfg: c.llmCfg, json: true, temperature: 0.2,
    });

    if (res.ok && res.json && typeof res.json === 'object') {
      const { out, adjusted } = validate(res.json, list, financial);
      // 至少要有一欄有內容，否則視為失敗（避免回一個空殼給使用者）
      if (out.bull.length || out.bear.length) {
        const result = {
          mode: 'llm',
          bull: out.bull,
          bear: out.bear,
          neutral: [],
          bullCount: out.bull.length,
          bearCount: out.bear.length,
          focus: out.focus || buildFocusFallback(out.bull, out.bear),
          sentiment: toSentiment(out.bull.length, out.bear.length),
          financial: {
            line: financialSummaryLine(financial),
            read: out.fundamentalRead || buildRuleRead(financial, out.bull.length, out.bear.length),
          },
          caveats: out.caveats,
          adjusted,
          note: null,
          model: (c.llmCfg && c.llmCfg.model) || llm.loadLlmConfig().model || null,
        };
        if (cacheKey) sidesCacheSet(cacheKey, result);
        return { ...result, cached: false };
      }
      const rule = classifyRuleLayer(list, financial, c);
      rule.note = 'LLM 未產出有效要點，已改用規則層分類。';
      return rule;
    }

    const rule = classifyRuleLayer(list, financial, c);
    rule.note = res.note || 'LLM 分析未成功，已改用規則層分類。';
    return rule;
  }

  const rule = classifyRuleLayer(list, financial, c);
  if (!llm.isConfigured()) rule.note = '未設定 LLM API Key，使用規則層分類。';
  else if (c.wantLlm === false) rule.note = '已指定使用規則層分類。';
  return rule;
}

/* ============================================================
   快取
   ============================================================ */

const SIDES_TTL_MS = 30 * 60 * 1000;
const sidesStore = new Map();

/**
 * 快取鍵：標的 + 新聞標題 + 財務數字。
 *
 * 為什麼不只用 symbol：新聞每小时都在變，若只按 symbol 快取，
 * 使用者會看到「昨天的新聞配前天的分析」。把標題與財務值納入鍵，
 * 內容一變就自然失效，比單純 TTL 更可靠。
 */
function buildSidesCacheKey(symbol, list, fin) {
  const titles = list.map((x) => String(x.title || '').slice(0, 60)).join('|');
  const facts = (fin && fin.facts ? fin.facts : [])
    .map((f) => `${f.key}=${f.value}`).join(',');
  return `${symbol || '?'}::${hash32(titles)}::${hash32(facts)}`;
}

/** 輕量字串雜湊（FNV-1a 變體）。只用於快取鍵，不需密碼學強度。 */
function hash32(s) {
  let h = 2166136261;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(36);
}

function sidesCacheGet(key) {
  const hit = sidesStore.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SIDES_TTL_MS) { sidesStore.delete(key); return null; }
  return hit.value;
}

function sidesCacheSet(key, value) {
  sidesStore.set(key, { at: Date.now(), value });
  if (sidesStore.size > 80) {
    const oldest = [...sidesStore.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, 40);
    for (const [k] of oldest) sidesStore.delete(k);
  }
}

function resetSidesCache() { sidesStore.clear(); }

/** 沒有 LLM 的 focus 句時的替代。 */
function buildFocusFallback(bull, bear) {
  const all = (bull || []).concat(bear || []);
  if (!all.length) return '本批新聞沒有明確的多空焦點。';

  /* 舊版把 bull/bear 重新包成 {topicLabel} 後再數，但 bull 的項目本來就有
     topicLabel，包一層反而讓 undefined 的項目全被歸成「其他」，永遠印「其他」。
     直接數原物件的 topicLabel。 */
  const c = {};
  for (const x of all) {
    const k = x.topicLabel || '其他';
    c[k] = (c[k] || 0) + 1;
  }
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];

  const bn = (bull || []).length;
  const ben = (bear || []).length;
  const dir = bn > ben ? '偏多看' : ben > bn ? '偏看空' : '多空分歧';

  /* 只印「財務（4 則），方向多空分歧」等於沒說市場在關注什麼。
     規則層沒有摘要能力，但可以指出**具體的關注點**：
     取各邊權重最高的要點，把它們的名字併進來。
     這樣使用者一眼就知道「市場在爭的是哪兩件事」。 */
  const topOf = (arr) => {
    const s = (arr || []).slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
    return s.length ? String(s[0].point || '').trim() : '';
  };
  /* 要點可能很長，只取第一個停頓前的核心詞組。
     注意：不能直接用 /[，,。；]/ 切——「4,788.34」的千分位逗號會被切斷，
     實測會變成「FY2026 營收達 4」。所以 ASCII 逗號另外處理：
     只有「逗號後不是數字」才算停頓。 */
  const clip = (s) => {
    if (!s) return '';
    let cut = String(s).trim();
    const zh = cut.search(/[，。；、]/);
    if (zh > 0) cut = cut.slice(0, zh);
    /* 英文逗號：用 callback 檢查前後字元，前後都是數字就不算停頓 */
    cut = cut.replace(/,(?!\d)/, '\u0000').split('\u0000')[0];
    cut = cut.replace(/[（(][^）)]*[）)]/g, '').trim();
    return cut.length > 26 ? cut.slice(0, 26) + '…' : cut;
  };

  /* 要點本身常含「」，外層再包一層「」會出現「…「…」」的疊引號，
     改用書名號〈〉做外層。另外中文引號是成對的，截斷時可能只切到開頭那個，
     所以先移除所有引號字元再包外層，避免出現「「前所未見〉」這種殘缺。 */
  const wrap = (s) => `〈${String(s).replace(/[「」『』"]/g, '').trim()}〉`;

  const bTop = clip(topOf(bull));
  const rTop = clip(topOf(bear));

  let head = `市場焦點集中在${top ? top[0] : '公司消息'}（${top ? top[1] : 0} 則）`;
  if (bTop || rTop) {
    const parts = [];
    if (bTop) parts.push(`看好方主要圍繞${wrap(bTop)}`);
    if (rTop) parts.push(`看跌方集中在${wrap(rTop)}`);
    return `${head}。${parts.join('；')}，整體${dir}。`;
  }
  return `${head}，方向${dir}。`;
}

module.exports = {
  analyzeSides,
  buildFinancialFacts,
  financialSummaryLine,
  classifyRuleLayer,
  buildRuleRead,
  extractPoints,
  cueScore,
  splitSentences,
  buildPrompt,
  validate,
  linkToFinancial,
  buildFocusFallback,
  toSentiment,
  isJunkSentence,
  isRelevantSentence,
  isListySentence,
  resetSidesCache,
  SCHEMA_HINT,
};
