'use strict';

/**
 * 新聞聚合與來源權威性分級
 * ==========================
 *
 * ── 為什麼要三路並行而不是只用一條 ────────────────────────
 * 動工前先量了真實資料（2026-11-26）：
 *
 *   來源                     | 可取回量              | 特性
 *   -------------------------|----------------------|--------------------------
 *   Yahoo /v1/finance/search | 6–8 則／標的          | 有縮圖、有 relatedTickers
 *   Yahoo Finance RSS        | 16–17 則／標的        | **有 description 摘要**
 *   Google News RSS          | 69–100 則／標的       | 支援 site: 與 when:
 *
 * 關鍵發現：**在 Yahoo 的一般新聞聚合裡，Bloomberg 只佔約 1/100 標題**
 * （實測 5 檔標的 × 各 20 則，Bloomberg 只出現 1 次；最高的是 Stocktwits 12 次）。
 * 若只被動聚合，就無法兌現「整合權威財經媒體」這個需求，只能假裝所有來源都權威。
 *
 * 但改用 Google News RSS 的定向查詢後：
 *   `AAPL site:bloomberg.com when:30d`                → 100 則，82 則 Bloomberg.com
 *   `(site:bloomberg.com OR site:reuters.com OR site:wsj.com) AAPL when:30d`
 *                                                     → 79 則（Reuters 31 / Bloomberg 27+9 / WSJ 12），耗時 398ms
 *
 * 所以正確做法是：**定向查詢取權威深度 + 一般聚合取廣度與摘要**，兩者互補。
 *
 * ── 為什麼一定要分級，以及分級為什麼不改變事實 ────────────
 * 把 tier 3 的內容當 tier 1 呈現是說謊；把 tier 3 藏起來假裝沒有也是說謊。
 * 因此照實收錄、照實標級，由前端顯示級別，讓使用者自己判斷。
 * 分級只影響「排序」與「AI 餵入的權重」，不影響「是否出現」。
 *
 * ── 為什麼連結是 Google 轉址而非原始網址 ──────────────────
 * Google News RSS 的 <link> 是 news.google.com/rss/articles/… 轉址，
 * 無法在不發請求的前提下還原成原始網址（需要解 base64 內的簽章）。
 * 本模組**不解碼偽造原始網址**，而是在輸出標明 `linkKind: 'google-redirect'`，
 * 讓前端與使用者知道點下去會先經過 Google。這比給一個猜出來的網址誠實。
 */

const llm = require('./llm');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ============================================================
   來源權威性分級
   ------------------------------------------------------------
   規則必須可解釋，不可憑感覺。任何未列於 tier1/tier2 的出版者
   一律歸 tier 3（寧可低估，不可高估）。
   ============================================================ */

/** Tier 1：通訊社與一線財經媒體（原始採訪、有編輯台） */
const TIER1 = [
  'bloomberg', 'breakingviews', 'reuters', 'wall street journal', 'wsj',
  'financial times', 'barron', 'associated press', 'ap news', 'afp',
  'agence france-presse', 'cnbc', 'nikkei', 'dow jones',
];

/** Tier 2：專業財經媒體與研究機構（有方法論揭露，非原始採訪） */
const TIER2 = [
  'yahoo finance', 'marketwatch', 'investing.com', 'mt newswires',
  'zacks', 'motley fool', 'seeking alpha', "investor's business daily", 'ibd',
  'trefis', 'simply wall st', 'benzinga', 'tipranks', 'gurufocus', 'morningstar',
  's&p global', 'marketbeat', 'barchart', 'business wire', 'globenewswire',
  'pr newswire', 'thestreet', 'kiplinger', 'fool.com', 'schaeffer',
];

/** 把出版社名稱正規化後比對分級 */
function tierOf(publisher) {
  const p = String(publisher || '').toLowerCase().trim();
  if (!p) return 3;
  for (const k of TIER1) if (p.includes(k)) return 1;
  for (const k of TIER2) if (p.includes(k)) return 2;
  return 3;
}

/** tier 的顯示標籤（前端直接用，不在前端另寫一份對照） */
const TIER_LABEL = {
  1: { key: 'tier1', label: '一線財經媒體', short: 'T1', note: '通訊社／原始採訪，有編輯台查核' },
  2: { key: 'tier2', label: '專業財經媒體', short: 'T2', note: '有方法論揭露，多為分析與轉述' },
  3: { key: 'tier3', label: '社群與聚合', short: 'T3', note: '部落格、論壇、非財經媒體轉載' },
};

/* ============================================================
   RSS 解析（零依賴）
   ============================================================ */

/** 解 XML 實體（只處理 RSS 實際會用的那幾個） */
function unescapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');   // 必須最後做，否則 &amp;lt; 會被解成 <
}

/** 去掉 CDATA 包裝 */
function stripCdata(s) {
  const t = String(s == null ? '' : s).trim();
  const m = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1].trim() : t;
}

/** 取單一標籤內容（RSS 的 item 內不會有同名嵌套，用非貪婪即可） */
function tag(body, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = String(body || '').match(re);
  return m ? unescapeXml(stripCdata(m[1])) : '';
}

/** 取標籤的屬性（例如 <source url="…">） */
function tagAttr(body, name, attr) {
  const re = new RegExp(`<${name}[^>]*\\s${attr}=["']([^"']*)["'][^>]*>`, 'i');
  const m = String(body || '').match(re);
  return m ? unescapeXml(m[1]) : '';
}

/**
 * 解析 RSS 2.0。
 *
 * 不支援 Atom：這三個來源實測都回 RSS 2.0。若日後換來源回 Atom，
 * 會得到 0 筆而不是錯誤資料——這是刻意的，寧可空手也不亂猜欄位。
 */
function parseRss(xml) {
  const out = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    const body = m[1];
    const title = tag(body, 'title').trim();
    if (!title) continue;
    const link = tag(body, 'link').trim();
    const pub = tag(body, 'pubDate').trim();
    const src = tag(body, 'source').trim();
    const srcUrl = tagAttr(body, 'source', 'url');
    const desc = tag(body, 'description').trim();
    out.push({ title, link, pubDate: pub, source: src, sourceUrl: srcUrl, description: desc });
  }
  return out;
}

/**
 * Google News 的標題會附加「 - 出版者」後綴。
 * 不去掉的話：①畫面重複 ②去重時同一事件因後綴不同而判為不同。
 *
 * 只在後綴**確實等於已知出版者**時才移除，避免誤砍正常標題
 * （例如 "Apple - Q3 preview" 這種真的用破折號的標題）。
 */
function stripPublisherSuffix(title, publisher) {
  const t = String(title || '');
  const p = String(publisher || '').trim();
  if (!p) return t;
  const suffix = ' - ' + p;
  if (t.length > suffix.length && t.slice(-suffix.length) === suffix) {
    return t.slice(0, -suffix.length).trim();
  }
  return t;
}

/* ============================================================
   去重
   ============================================================ */

/**
 * 正規化標題用於去重鍵。
 *
 * 只用「前 8 個詞」而不是整串：同一事件被轉載時，各媒體的標題
 * 前半段幾乎相同、後半段常各自加油添醋。用整串比對會漏掉大量重複。
 *
 * 實測效果：`(site:bloomberg.com OR site:reuters.com) AAPL` 的 79 則
 * 中有多組「Apple + 同一事件」的不同標題，前 8 詞可正確合併。
 */
function dedupeKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ');
}

/* ============================================================
   相關性過濾
   ------------------------------------------------------------
   Google News 的 `site:` 查詢**不是精確比對**。實測
   `(site:bloomberg.com OR …) AAPL when:30d` 會帶回：
     "Cdp Infrastructures Group Inc"、"North Oil Co / Qatar"、
     "Speedmatrix Sdn Bhd"、"Craft Brew Alliance Inc"、"Astra Cia Argentina de Petroleo SA"
     "Leverage Shares 2X Long AAPL Daily ETF (AAPE.N) | Stock Price & Latest News"
     "- WSJ"（空的標題後綴）
   這些標題既沒有 AAPL 也沒有 Apple，純粹是 Google 索引比對到內文的雜訊。

   若不過濾，AI 收到的一半內容與標的無關，摘要必然是垃圾。
   這也解釋了為何規則層 12 則裡有 11 則情緒為 0——它們根本不是同一件事。

   策略：**保守的包含式比對**（有足夠證據才保留），並區分兩種等級：
     strong — 標題直接出現代碼或公司名，或 relatedTickers 明確標記
     weak   — 標題未直接出現，但摘要／內文有（保留但排序在後）
   ============================================================ */

/** 公司名轉為可用於比對的關鍵詞（去掉 Inc./Corp. 等後綴與標點） */
function nameTokens(name) {
  return String(name || '')
    .replace(/\b(inc|corp|corporation|co|company|ltd|limited|plc|group|holdings?|sa|ag|nv|se)\b\.?/gi, ' ')
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter((t) => t.length >= 3);
}

/**
 * 判斷一則新聞與標的的相關性。
 *
 * @returns {{relevant:boolean, strength:'strong'|'weak'|'none', why:string}}
 */
function relevanceOf(item, ctx) {
  const c = ctx || {};
  const title = String(item.title || '').toLowerCase();
  const bodyText = `${title} ${String(item.excerpt || '').toLowerCase()}`;
  const symbol = String(c.symbol || '').toLowerCase();
  const base = symbol.replace(/\.hk$/, '');
  const tokens = c.nameTokens || [];

  /* 1) 代碼直接出現（含 AAPL / (AAPL) / $AAPL 等寫法） */
  if (base && base.length >= 2) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(base)}([^a-z0-9]|$)`, 'i');
    if (re.test(title)) return { relevant: true, strength: 'strong', why: 'symbol-in-title' };
  }

  /* 2) 公司名 token 直接出現（主要 token 至少一個，且長度 ≥3） */
  for (const t of tokens) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`, 'i');
    if (re.test(title)) return { relevant: true, strength: 'strong', why: `name-in-title:${t}` };
  }

  /* 3) Yahoo 回傳的 relatedTickers 明確標記（最可靠，優先於文字比對） */
  if (Array.isArray(item.relatedTickers) && item.relatedTickers.length) {
    const hit = item.relatedTickers.some((t) => String(t).toUpperCase() === c.symbol.toUpperCase());
    if (hit) return { relevant: true, strength: 'strong', why: 'relatedTickers' };
  }

  /* 4) 標題沒有，但摘要／內文有 → 弱相關（保留，但排序在後） */
  for (const t of tokens) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`, 'i');
    if (re.test(bodyText)) return { relevant: true, strength: 'weak', why: `name-in-body:${t}` };
  }
  if (base && base.length >= 2) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(base)}([^a-z0-9]|$)`, 'i');
    if (re.test(bodyText)) return { relevant: true, strength: 'weak', why: 'symbol-in-body' };
  }

  return { relevant: false, strength: 'none', why: 'no-match' };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 標題健全性檢查：擋掉明顯不是新聞的條目，以及對「研判」無價值的自動生成稿。
 *
 * 實測命中兩大類雜訊：
 *
 * ① 不是新聞
 *     "- WSJ"                                  → 只有出版者後綴，標題被截斷
 *     "Cdp Infrastructures Group Inc"           → 只有一個公司名，不是句子
 *     "Leverage Shares 2X Long AAPL Daily ETF (AAPE.N) | Stock Price & Latest News"
 *                                              → ETF 報價頁
 *
 * ② 自動生成的 13F／持股異動稿（數量最多，殺傷力最大）
 *     "Apple Inc. $AAPL Stock: Welch Group LLC Reduces Stake"
 *     "Apple Inc. $AAPL Stock Position Raised by Bank Julius Baer & Co. Ltd Zurich"
 *     "Apple Inc. $AAPL Stock Holdings Boosted by Hoey Investments Inc."
 *   實測 40 則相關新聞中有 **18 則**屬此類。它們語句幾乎相同、
 *   只換了機構名，情緒詞全是「Raised / Cut / Boosted」——
 *   餵進情緒模型會讓加權分數被機構調倉方向綁架，
 *   而那與公司基本面毫無關係。這不是「新聞」，是申報表格的模板化轉述。
 *
 * ③ 國會議員交易揭露稿（同樣是模板）
 *     "Apple (NASDAQ:AAPL) Stock Sale Disclosed by Rep. Harriet M. Hageman"
 */
function looksLikeHeadline(title) {
  const t = String(title || '').trim();
  if (t.length < 12) return false;
  if (/^[-–—|·\s]+/.test(t)) return false;
  if (!/\s/.test(t)) return false;
  if (/stock price & latest news/i.test(t)) return false;
  if (/\([A-Z]{1,5}\.[A-Z]\)/.test(t) && /etf/i.test(t)) return false;
  if (isBoilerplate(title)) return false;
  if (isMarketWide(title)) return false;
  return true;
}

/**
 * 是否為模板化的自動生成稿（無研判價值）。
 *
 * 命名為 boilerplate 而不是「垃圾」，因為它們**是真實資訊**，
 * 只是屬於「持股異動申報」而非「事件新聞」。本模組的用途是
 * 新聞情緒研判，因此排除它們；若要另做「機構持倉變化」功能，
 * 應該走獨立的資料源與呈現方式，不該混在新聞流裡。
 */
const BOILERPLATE_PATTERNS = [
  // 13F／機構持股異動（主動與被動語態都要擋）
  /\bstock\s*:\s*.{0,40}(reduces?|cuts?|lowers?|trims?|decreases?)\s+(stake|position|holdings?)/i,
  /\bstock\s+(position|holdings?)\s+(raised|boosted|increased|cut|lowered|reduced|trimmed)\b/i,
  /\bstock\s+(bought|acquired|purchased|sold)\s+(by|at)\b/i,
  /\b(reduces?|cuts?|lowers?|trims?)\s+(stake|position)\b/i,
  /\b(raises?|boosts?|increases?)\s+(stake|position)\b/i,
  /\bholds?\s+[\d,.]+\s*(shares|%)\b/i,
  /\bnew\s+position\s+in\b/i,
  // 分析師預測／目標價彙總頁（內容是表格，不是事件）
  /\bstock\s+forecast\s*&\s*analyst\s+predictions\b/i,
  /\bprice\s+target\s+(and|&)\s+analyst\b/i,
  // 國會議員／內部人交易揭露
  /\bstock\s+(sale|purchase)\s+(disclosed|revealed)\s+by\s+(rep\.|sen\.|congress)/i,
  /\b(congressman|congresswoman|senator)\s+(buys?|sells?|bought|sold)\b/i,
  /\binsider\s+(buying|selling|trading)\b/i,
  // 股息／拆股的自動再宣導稿
  /\bhow\s+dividend\s+reinvestments?\s+add\s+up\b/i,
  // 純大盤播報（與個股無關，只因內文提到代碼而被索引）
  /^stock\s+movers?\b/i,
];

/**
 * 大盤／指數類標題：即使內文提到本公司，對「個股研判」也沒有直接價值。
 *
 * 實測「Dow Jones Futures Rise After Nasdaq Slashes Losses In Wild Market Ride」
 * 只因內文列出 AAPL 而被 Google 索引進來，且被情緒模型讀成 -0.5
 * （因為 slashes losses 命中 neg 詞），對個股情緒是純粹的污染。
 */
const MARKET_WIDE_PATTERNS = [
  /\bdow\s+(jones\s+)?futures\b/i,
  /\b(s&p\s*500|nasdaq|russell)\s+(futures|composite|index)\b/i,
  /\bmarket\s+(wrap|recap|close|open|outlook|update)\b/i,
  /\bstocks?\s+(to\s+(watch|buy|sell)|moving|making\s+moves)\b/i,
  /\bwhat\s+to\s+watch\s+in\s+(the\s+)?(stock\s+)?market\b/i,
];

function isMarketWide(title) {
  const t = String(title || '');
  return MARKET_WIDE_PATTERNS.some((re) => re.test(t));
}

function isBoilerplate(title) {
  const t = String(title || '');
  return BOILERPLATE_PATTERNS.some((re) => re.test(t));
}

/** 帶 UA 抓文字，逾時保護 */
async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs || 12000),
  });
  if (!res.ok) {
    const e = new Error(`上游回應 HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.text();
}

/**
 * Google News RSS 定向查詢。
 *
 * 為什麼要用 site: 定向而不是只搜關鍵字：
 * 見檔案開頭的量測。一般聚合的 Bloomberg 命中率約 1%，
 * 定向查詢可拉到數十則。這是「整合權威媒體」唯一可兌現的做法。
 */
async function fetchGoogleNews(opts) {
  const o = opts || {};
  const hl = o.hl || 'en-US';
  const hlParts = hl.split('-');
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(o.query)
    + `&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(hlParts[1] || 'US')}`
    + `&ceid=${encodeURIComponent((hlParts[1] || 'US') + ':' + (hlParts[0] || 'en'))}`;
  const xml = await fetchText(url, o.timeoutMs);
  // origin 必須由呼叫端指定（gnews-tier1 / gnews-general），否則來源統計會全部歸到同一格
  return parseRss(xml).map((r) => ({ ...r, origin: o.origin || 'gnews' }));
}

/** Yahoo Finance RSS（有 description，適合餵 AI） */
async function fetchYahooRss(opts) {
  const o = opts || {};
  const url = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s='
    + encodeURIComponent(o.symbol) + '&region=US&lang=en-US';
  const xml = await fetchText(url, o.timeoutMs);
  return parseRss(xml).map((r) => ({
    ...r,
    origin: 'yahoo-rss',
    // Yahoo RSS 沒有 <source>，出版者要從 description 或 URL 推
    source: r.source || publisherFromUrl(r.link) || 'Yahoo Finance',
  }));
}

/** Yahoo 搜尋 API（有 relatedTickers，可做相關性過濾） */
async function fetchYahooApi(opts) {
  const o = opts || {};
  const url = 'https://query1.finance.yahoo.com/v1/finance/search?q='
    + encodeURIComponent(o.query) + `&quotesCount=0&newsCount=${o.count || 10}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(o.timeoutMs || 12000),
  });
  if (!res.ok) {
    const e = new Error(`上游回應 HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  return (j.news || []).map((n) => ({
    title: n.title || '',
    link: n.link || '',
    pubDate: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toUTCString() : '',
    source: n.publisher || '',
    sourceUrl: '',
    description: '',
    relatedTickers: n.relatedTickers || [],
    thumbnail: pickThumb(n.thumbnail),
    origin: 'yahoo-api',
  }));
}

/** 從縮圖清單挑一個適合清單顯示的尺寸（140x140 最省頻寬） */
function pickThumb(t) {
  const rs = (t && t.resolutions) || [];
  if (!rs.length) return null;
  const small = rs.find((r) => r.tag === '140x140');
  return (small || rs[rs.length - 1] || {}).url || null;
}

/** 從連結網域推測出版者（Yahoo RSS 缺 <source> 時的退路） */
function publisherFromUrl(link) {
  const m = String(link || '').match(/^https?:\/\/(?:www\.)?([^/]+)/i);
  if (!m) return '';
  const host = m[1].toLowerCase();
  const map = {
    'finance.yahoo.com': 'Yahoo Finance',
    'stocktwits.com': 'Stocktwits',
    'reuters.com': 'Reuters',
    'bloomberg.com': 'Bloomberg',
    'wsj.com': 'The Wall Street Journal',
    'cnbc.com': 'CNBC',
    'marketwatch.com': 'MarketWatch',
    'investing.com': 'Investing.com',
    'fool.com': 'The Motley Fool',
    'seekingalpha.com': 'Seeking Alpha',
    'barrons.com': 'Barron\'s',
    'barchart.com': 'Barchart.com',
    'benzinga.com': 'Benzinga',
    'zacks.com': 'Zacks Investment Research',
    'simplywall.st': 'Simply Wall St',
    'gurufocus.com': 'GuruFocus',
    'tipranks.com': 'TipRanks',
  };
  for (const k of Object.keys(map)) if (host === k || host.endsWith('.' + k)) return map[k];
  return host;
}

/* ============================================================
   時間
   ============================================================ */

/** 解析 RSS 的 pubDate（RFC 822）為毫秒；壞值回 null，不可回 0 */
function parsePubDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : null;
}

/**
 * 相對時間文字（中文）。
 *
 * 為什麼不直接顯示原始 pubDate：畫面上一排 GMT 字串對使用者沒有意義，
 * 但精確時間又不能省（可查核性）。因此「幾小時前」為主，title 屬性放原始時間。
 */
function ageText(ms, nowMs) {
  if (!ms || !Number.isFinite(ms)) return '時間不明';
  const diff = Math.max(0, (nowMs || Date.now()) - ms);
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.round(h / 24);
  return `${d} 天前`;
}

/* ============================================================
   聚合主流程
   ============================================================ */

/**
 * 取得某標的的新聞，含來源分級、去重、排序。
 *
 * @param {object} opts
 * @param {string} opts.symbol       代碼（如 AAPL / 0700.HK）
 * @param {string} [opts.name]       公司名稱（港股以代碼查通常 0 筆，需用名稱）
 * @param {number} [opts.days]       時間窗（1–30，預設 7）
 * @param {number} [opts.limit]      回傳上限（預設 12）
 * @param {boolean} [opts.refresh]   略過快取
 * @param {object} [opts.datasource] 可注入（測試用）
 * @returns {Promise<object>}
 */
async function getNews(opts) {
  const o = opts || {};
  const symbol = String(o.symbol || '').trim();
  if (!symbol) {
    const e = new Error('缺少 symbol');
    e.code = 'EMPTY';
    throw e;
  }

  const days = clampInt(o.days, 7, 1, 30);
  const limit = clampInt(o.limit, 12, 1, 50);
  const now = Date.now();

  const key = `news:${symbol}|${days}|${limit}`;
  if (!o.refresh) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, cached: true };
  }

  const isHK = /\.HK$/i.test(symbol) || /^\d{1,5}$/.test(symbol);
  const baseSymbol = symbol.replace(/\.HK$/i, '');
  const name = String(o.name || '').trim();

  /* 查詢設計：
     A. 權威定向（tier1 站台）— 這是「整合權威財經媒體」的兌現方式
     B. 一般廣度查詢 — 補足中小型股（權威媒體未必報導）
     兩者用不同 when: 視窗：權威報導較稀疏，給 30 天；
     一般新聞給使用者選定的 days，避免畫面被舊聞佔滿。 */
  const tier1Sites = '(site:bloomberg.com OR site:reuters.com OR site:wsj.com '
    + 'OR site:barrons.com OR site:ft.com)';
  const subject = name && isHK ? `${name} ${baseSymbol}` : (isHK ? baseSymbol : symbol);

  const tasks = [
    {
      id: 'gnews-tier1',
      run: () => fetchGoogleNews({
        query: `${tier1Sites} ${subject} when:30d`,
        hl: 'en-US',
        origin: 'gnews-tier1',
      }),
    },
    {
      id: 'gnews-general',
      run: () => fetchGoogleNews({
        query: `${subject} ${isHK ? '' : 'stock'} when:${days}d`,
        hl: isHK ? 'zh-TW' : 'en-US',
        origin: 'gnews-general',
      }),
    },
    {
      id: 'yahoo-rss',
      run: () => fetchYahooRss({ symbol }),
    },
    {
      id: 'yahoo-api',
      run: () => fetchYahooApi({ query: isHK ? (name || baseSymbol) : symbol, count: 10 }),
    },
  ];

  const settled = await Promise.all(tasks.map(async (t) => {
    try {
      const items = await t.run();
      return { id: t.id, ok: true, items };
    } catch (e) {
      return {
        id: t.id, ok: false, items: [],
        code: e.status === 429 ? 'RATE_LIMITED' : (e.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED'),
        message: e.message,
      };
    }
  }));

  const degraded = settled.filter((s) => !s.ok).map((s) => {
    const label = {
      'gnews-tier1': '權威媒體查詢', 'gnews-general': '綜合新聞查詢',
      'yahoo-rss': 'Yahoo RSS', 'yahoo-api': 'Yahoo 搜尋',
    }[s.id] || s.id;
    return {
      source: s.id, label, code: s.code,
      message: `${label} 暫時不可用（${s.code === 'RATE_LIMITED' ? '要求過於頻繁' : s.code === 'TIMEOUT' ? '逾時' : s.message}）`,
    };
  });

  /* 合併與正規化 */
  const raw = [];
  for (const s of settled) {
    for (const it of s.items) {
      const title = stripPublisherSuffix(it.title, it.source).trim();
      if (!title) continue;
      // 標題健全性：先擋掉「不是新聞」的條目（空後綴、報價頁、單一公司名）
      if (!looksLikeHeadline(title)) continue;
      const ts = parsePubDate(it.pubDate);
      // 時間窗過濾：只留 days 內。時間不明的保留（不可因缺時間而丟棄內容）
      if (ts && now - ts > days * 86400000) continue;
      raw.push({
        title,
        publisher: cleanPublisher(it.source),
        publisherUrl: it.sourceUrl || '',
        link: it.link || '',
        linkKind: /news\.google\.com/i.test(it.link || '') ? 'google-redirect' : 'direct',
        time: ts,
        ageText: ageText(ts, now),
        // 摘要只留前 300 字：餵 AI 夠用，畫面也放得下
        excerpt: trimText(it.description, 300),
        thumbnail: it.thumbnail || null,
        origin: it.origin,
        relatedTickers: it.relatedTickers || [],
      });
    }
  }

  /* 相關性過濾：`site:` 查詢會帶回大量與標的無關的條目（實測見上方長註解）。
     若不過濾，AI 收到的一半內容與標的無關，摘要必然是垃圾。
     weak 相關（只有摘要／內文命中）保留，但排序時排在 strong 之後。 */
  const relCtx = { symbol, nameTokens: nameTokens(name || (o.analysis && o.analysis.meta && o.analysis.meta.name)) };
  const dropped = { irrelevant: 0, unheadline: 0 };
  const relevant = [];
  for (const it of raw) {
    const rel = relevanceOf(it, relCtx);
    if (!rel.relevant) { dropped.irrelevant++; continue; }
    it.relevance = rel.strength;
    relevant.push(it);
  }

  /* 去重：同事件多來源時保留 tier 最高、時間最新者，並記錄 alsoReportedBy */
  for (const it of raw) {
    it.tier = tierOf(it.publisher);
    it.tierLabel = TIER_LABEL[it.tier].label;
    it.tierShort = TIER_LABEL[it.tier].short;
  }

  const byKey = new Map();
  for (const it of relevant) {
    const k = dedupeKey(it.title);
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, it); continue; }
    const better = (it.tier < prev.tier)
      || (it.tier === prev.tier && (it.time || 0) > (prev.time || 0));
    const winner = better ? it : prev;
    const loser = better ? prev : it;
    if (loser.publisher && loser.publisher !== winner.publisher) {
      winner.alsoReportedBy = [...new Set([...(winner.alsoReportedBy || []), loser.publisher])];
    }
    byKey.set(k, winner);
  }
  const deduped = [...byKey.values()];

  /* 排序：相關性強度 → tier → 時間近者。
     為什麼相關性排在 tier 前面：
     一則 tier1 但只是「內文提到本公司」的報導，其分析價值低於
     一則 tier2 但標題直接講本公司的報導。相關性是內容是否可用的前提，
     權威性是內容可不可信的評價——前提必須先滿足。 */
  const relRank = { strong: 0, weak: 1 };
  deduped.sort((a, b) => {
    const ra = relRank[a.relevance] == null ? 1 : relRank[a.relevance];
    const rb = relRank[b.relevance] == null ? 1 : relRank[b.relevance];
    if (ra !== rb) return ra - rb;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return (b.time || 0) - (a.time || 0);
  });

  const items = deduped.slice(0, limit);

  /* 統計：讓前端與 provenance 都能顯示「哪個來源貢獻了幾則、其中幾則是 tier1」 */
  const bySource = settled.map((s) => {
    const mine = deduped.filter((it) => it.origin === s.id);
    return {
      id: s.id,
      name: SOURCE_NAME[s.id] || s.id,
      ok: s.ok,
      count: mine.length,
      tier1: mine.filter((it) => it.tier === 1).length,
      code: s.ok ? null : s.code,
      message: s.ok ? null : s.message,
    };
  });

  const publishers = {};
  for (const it of deduped) {
    if (!it.publisher) continue;
    const p = publishers[it.publisher] || { name: it.publisher, tier: it.tier, count: 0 };
    p.count++;
    publishers[it.publisher] = p;
  }
  const publisherList = Object.values(publishers).sort((a, b) => a.tier - b.tier || b.count - a.count);

  const withTime = deduped.filter((it) => it.time);
  const window = {
    from: withTime.length ? new Date(Math.min(...withTime.map((i) => i.time))).toISOString() : null,
    to: withTime.length ? new Date(Math.max(...withTime.map((i) => i.time))).toISOString() : null,
    days,
  };

  const value = {
    ok: true,
    symbol,
    name: name || null,
    market: isHK ? 'HK' : 'US',
    count: items.length,
    totalBeforeLimit: deduped.length,
    rawCount: raw.length,
    news: items,
    window,
    sources: bySource,
    publishers: publisherList,
    tiers: {
      tier1: deduped.filter((i) => i.tier === 1).length,
      tier2: deduped.filter((i) => i.tier === 2).length,
      tier3: deduped.filter((i) => i.tier === 3).length,
    },
    relevance: {
      strong: deduped.filter((i) => i.relevance === 'strong').length,
      weak: deduped.filter((i) => i.relevance === 'weak').length,
      // 被過濾掉的雜訊條目數：讓使用者知道「不是沒有新聞，是已濾掉無關的」
      filteredOut: dropped.irrelevant,
    },
    tierLabels: TIER_LABEL,
    degraded,
    generatedAt: new Date().toISOString(),
  };

  // 只有「確實拿到東西」才快取。全空快取會讓一次上游故障卡住使用者 10 分鐘。
  if (items.length) cacheSet(key, value);
  return { ...value, cached: false };
}

const SOURCE_NAME = {
  'gnews-tier1': 'Google News（權威媒體定向）',
  'gnews-general': 'Google News（綜合）',
  'yahoo-rss': 'Yahoo Finance RSS',
  'yahoo-api': 'Yahoo Finance 搜尋',
};

/** 出版者名稱清理：去頭尾空白、去掉 Google 附加的網域後綴 */
function cleanPublisher(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** 截斷文字（去除 HTML 標籤與多餘空白） */
function trimText(s, n) {
  const t = String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function clampInt(v, dflt, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/* ============================================================
   快取
   ============================================================ */

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 120;
const store = new Map();

function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { store.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  store.set(key, { at: Date.now(), value });
  if (store.size > CACHE_MAX) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)
      .slice(0, Math.ceil(CACHE_MAX / 2));
    for (const [k] of oldest) store.delete(k);
  }
}

function resetCache() { store.clear(); }

module.exports = {
  getNews,
  tierOf,
  TIER_LABEL,
  TIER1,
  TIER2,
  parseRss,
  stripPublisherSuffix,
  dedupeKey,
  parsePubDate,
  ageText,
  publisherFromUrl,
  trimText,
  relevanceOf,
  looksLikeHeadline,
  nameTokens,
  fetchGoogleNews,
  fetchYahooRss,
  fetchYahooApi,
  unescapeXml,
  resetCache,
  CACHE_TTL_MS,
};
