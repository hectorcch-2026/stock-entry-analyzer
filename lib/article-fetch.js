/* ============================================================
 * 文章正文抓取與去重
 * ============================================================
 *
 * ── 為什麼需要這一層 ──────────────────────────────────────
 * news-hub 給的 excerpt 有一半是**假的摘要**。實測 12 則新聞中：
 *   - linkKind='google-redirect' 的 6 則，excerpt 就是「標題 + 出版者」
 *     例如 excerpt = "Apple pulls MiniMax AI chatbot ... Reuters"
 *     這不是摘要，是把標題再貼一次。
 *   - linkKind='direct' 的 Yahoo 新聞有真摘要，但其中 1 則長度為 0。
 *
 * 直接拿這種 excerpt 餵給 AI，等於讓模型對著標題重述一次標題，
 * 產出的「要點」必然是空話。要真的提煉內容，就必須打開原文。
 *
 * ── 兩個技術障礙與解法 ────────────────────────────────────
 * ① Google News 轉址無法用 redirect:'follow' 還原
 *    實測：抓 news.google.com/rss/articles/… 只會拿到 Google 的
 *    中介頁（61 萬字元，但沒有原文內容），因為真實網址是靠 JS 解出的。
 *    解法：仿 Google News 自己前端的 batchexecute 呼叫，用頁面上的
 *    data-n-a-sg / data-n-a-ts 換回原始網址。實測成功率 3/3，每則約 400ms。
 *    注意：舊教學常見的「base64 解 id」對 2024 年後的新格式
 *    （AU_yqL…）已失效，必須保留 batchexecute 這條路。
 *
 * ② Yahoo Finance 會回傳超大的 response header
 *    實測：帶自訂 User-Agent 時 fetch 直接失敗，cause 是
 *    UND_ERR_HEADERS_OVERFLOW；**不帶 UA 反而 200**。
 *    這是 undici 的預設 header 上限（16KB）被 Yahoo 的 set-cookie 撐爆。
 *    解法：抓 Yahoo 時不要覆寫 User-Agent。這違反直覺，但實測如此。
 *
 * ── 抓多少 ────────────────────────────────────────────────
 * 使用者的要求是「按重點新聞 10 篇（以財務狀況和政策變化為主）排序，
 * 不要取重複的內容」。因此：
 *   1. 先依「財務／政策」相關性評分排序，不只看 tier 與情緒。
 *   2. 去重（同一事件多家報導只留一家），避免 10 篇裡有 4 篇同一個消息。
 *   3. 只抓前 N 篇（預設 10），其餘不抓，避免拖慢頁面。
 *
 * 這一層**永不擲出**：任何一則抓失敗就跳過，讓上層用標題繼續運作。
 * 抓到一半總比整頁壞掉好。
 */

'use strict';

/* ============================================================
   設定
   ============================================================ */

/** 單篇抓取逾時。實測正常文章 200–500ms，8 秒已足夠寬鬆。 */
const FETCH_TIMEOUT_MS = 8000;

/** 解 Google 轉址的逾時。實測約 400ms。 */
const DECODE_TIMEOUT_MS = 6000;

/** 正文最多保留字元數。餵 AI 用不到更多，也避免 prompt 過長。 */
const BODY_MAX_CHARS = 1400;

/** 併發上限。同時打太多家媒體會被擋，10 篇分兩批剛好。 */
const CONCURRENCY = 5;

/**
 * 「財務狀況」相關詞。命中者排序優先。
 *
 * 為什麼權重要高於「政策」：使用者要的是「對個股基本面與投資判斷的影響」，
 * 財報數字直接改變估值；政策是間接影響。但政策（關稅、反壟斷、補貼）
 * 對某些股票（如 AAPL 的 App Store 抽成）影響極大，所以仍給高分。
 */
const FINANCIAL_TERMS = [
  { re: /\b(earnings|revenue|profit|margin|guidance|forecast|outlook)\b/i, w: 10 },
  { re: /\b(eps|p\/e|valuation|market cap|free cash flow|cash flow)\b/i, w: 9 },
  { re: /\b(quarter|q[1-4]|fiscal|annual|results|beat|miss)\b/i, w: 8 },
  { re: /\b(dividend|buyback|repurchase|shareholder return)\b/i, w: 7 },
  { re: /\b(upgrade|downgrade|price target|analyst|rating)\b/i, w: 7 },
  { re: /\b(sales|shipment|units sold|demand|inventory|order)\b/i, w: 6 },
  { re: /\b(debt|leverage|balance sheet|credit|cash position)\b/i, w: 6 },
  { re: /\b(cost|pricing|price cut|price hike|inflation|tariff)\b/i, w: 5 },
  /* 以下為實測補充：真實財經標題常用這些說法，但第一版漏掉了，
     導致「投資 1000 美元能變成多少」這種明確的估值稿被歸為「其他」。 */
  { re: /\b(invest|investor|investing|worth|value|valuation)\b/i, w: 6 },
  { re: /\b(stock|share|shares|equity|rally|selloff|surge|plunge|slump|rebound)\b/i, w: 4 },
  { re: /\b(growth|expand|slowdown|recession|momentum)\b/i, w: 5 },
  { re: /\b(subscri|subscriber|revenue growth|margin pressure)\b/i, w: 6 },
  { re: /\b(competit|rival|market share|outperform|underperform)\b/i, w: 5 },
];

/** 「政策／監管」相關詞。 */
const POLICY_TERMS = [
  { re: /\b(regulat|antitrust|monopol|investigation|lawsuit|court|ruling|verdict)\b/i, w: 10 },
  { re: /\b(doj|sec|ftc|eu commission|european commission|competition authority)\b/i, w: 10 },
  { re: /\b(ban|restrict|fine|penalty|sanction|compliance|probe)\b/i, w: 8 },
  { re: /\b(policy|rule|bill|act|law|legislation|executive order)\b/i, w: 7 },
  { re: /\b(tariff|trade war|export control|import duty)\b/i, w: 8 },
  { re: /\b(approval|clearance|license|permit)\b/i, w: 5 },
  /* 實測補充：內容審查、兒少安全、App Store 下架等屬於「平台監管」，
     是本檔股票（AAPL）真實的高頻事件類型，不能歸為「其他」。 */
  { re: /\b(child safety|content moderation|safety concern|age verification)\b/i, w: 9 },
  { re: /\b(app store|platform|gatekeeper|dma|digital markets act)\b/i, w: 7 },
  { re: /\b(remove|pull|takedown|suspend|block)\b/i, w: 5 },
  { re: /\b(supreme court|congress|senate|parliament|lawmakers|authorit)\b/i, w: 8 },
];

/** 明顯沒有分析價值的內容特徵（廣告、行情播報、純技術分析稿）。 */
const LOW_VALUE = [
  /\b(stock price|share price) (today|now|on)\b/i,
  /\b(how to buy|should you buy|is it time to buy)\b/i,
  /\b(better buy than|which is the better)\b/i,
  /\b(stocks to watch|top picks?|hot stocks?)\b/i,
  /\bmorning briefing\b/i,
  /\bmarket (wrap|recap|close)\b/i,
];

/* ============================================================
   標的歸屬判定
   ============================================================ */

/**
 * 標題是否真的在講這家公司？
 *
 * 為什麼需要：新聞聚合器（尤其 Google News）會把「文末順帶提到」的稿
 * 也歸到這檔股票，例如 AAPL 清單出現券商公關稿。這種稿一旦進了清單，
 * ① 佔掉一則真正有價值新聞的名額
 * ② AI 會把它當成這家公司的消息去解讀，產生事實錯誤
 *
 * 用字串比對而非語意，因為這裡要的是「寧可漏、不可錯」：
 * 漏掉一則 -3 分的新聞只是少一則；放進一則別家公司的稿會污染整段分析。
 *
 * @param {string} text    標題（或任意文字）
 * @param {object} subject { symbol, name, shortName }
 */
function mentionsSubject(text, subject) {
  const s = String(text || '').toLowerCase();
  if (!s || !subject) return false;

  // 代號（AAPL / 0700.HK）。港股須容忍「0700」不帶 .HK 的寫法。
  const sym = String(subject.symbol || '').toLowerCase();
  if (sym) {
    if (s.includes(sym)) return true;
    const bare = sym.split('.')[0];
    if (bare && bare.length >= 3 && s.includes(bare)) return true;
  }

  // 公司名：去掉 Inc/Corp 等後綴，並容忍「Apple Inc.」寫成「Apple」
  const names = [subject.name, subject.shortName].filter(Boolean);
  for (const raw of names) {
    const n = String(raw).toLowerCase().trim();
    if (!n) continue;
    if (s.includes(n)) return true;
    const stem = n.replace(/\b(inc|corp|corporation|ltd|limited|co|company|plc|sa|ag|nv|holdings?|group|technologies|technology)\b\.?/g, '').replace(/\s+/g, ' ').trim();
    if (stem && stem.length >= 3 && s.includes(stem)) return true;
  }
  return false;
}

/**
 * 這則新聞是不是「機構持股異動」類的自動生成稿？
 *
 * 為什麼要濾：AAPL 實測 10 則裡有 3 則是
 * 「Summit Wealth Group LLC Co. Grows Stake」這類 13F 申報自動稿。
 * 它們標題含公司名與 $AAPL，主題詞（shares）也命中，分數不低，
 * 但對「市場最關注什麼」是純噪音——真正的機構持股變化要看 13F 匯總，
 * 不是看單一小型投顧的季報。
 */
const HOLDINGS_NOISE = [
  /* 「動詞 + 部位名詞」。刻意不要求結尾接 of/in——
     實測「Summit Wealth Group LLC Co. Grows Stake」這種標題就沒有 of/in，
     卻是典型的 13F 自動稿。 */
  /\b(grows?|boosts?|raises?|increases?|decreases?|cuts?|trims?|lowers?|sells?|buys?|acquires?|reduces?)\b[^.]{0,40}\b(stake|position|holdings?|shares)\b/i,
  /\b(position|stake|holdings?)\b[^.]{0,30}\b(increased|decreased|raised|lowered|cut|trimmed)\b/i,
  /\b(wealth|asset|capital|investment)\s+(management|advisors?|group|partners?|counsel)\b/i,
  /\b(has|have)\s+\$?[\d.]+(?:\s?(?:million|billion|m|b))?\s+(?:shares?|stake|position)\b/i,
  /\b13f\b/i,
];

/* 反向保護：這些是「公司自己買回股份」，屬重大資本配置決策，
   與「某投顧調整持股」完全不是同一回事。誤殺它們會漏掉真正重要的消息。 */
const HOLDINGS_SAFE = [
  /\bbuy\s*-?\s*back\b/i,
  /\bbuyback\b/i,
  /\brepurchas\w*\b/i,
  /\btender offer\b/i,
  /\bincreas\w*\b[^.]{0,20}\bdividend\b/i,
];

function isHoldingsNoise(title) {
  const t = String(title || '');
  if (!t) return false;
  if (HOLDINGS_SAFE.some((re) => re.test(t))) return false;
  return HOLDINGS_NOISE.some((re) => re.test(t));
}

/** 看起來像「付費牆／錯誤頁」的正文特徵，命中就不採用。 */
const JUNK_BODY = [
  /^(please )?(enable|turn on) (javascript|cookies)/i,
  /^(access denied|403 forbidden|404 not found)/i,
  /^(subscribe|sign in) to (continue|read)/i,
  /page (not found|does not exist)/i,
  /* Google News 的包裝頁：og:description 固定是
     「Comprehensive up-to-date news coverage, aggregated from sources all
     over the world by Google News.」—— 這不是任何一篇文章的內容。
     線上實測 10 則裡有 7 則抓到這句，於是每個「要點」都變成同一句話。 */
  /comprehensive up-to-date news coverage/i,
  /aggregated from sources all over the world/i,
  /* Yahoo Finance 文章頁開頭的免責區塊：
     「Trading disclosure The above button links to Coinbase. Yahoo Finance
     is not a broker-dealer or investment advisor…」
     它是頁面框架，不是文章，但長度足以通過 60 字門檻。 */
  /trading disclosure/i,
  /is not a broker-dealer or investment advis/i,
  /the above button links to/i,
];

/* ============================================================
   文字工具
   ============================================================ */

/** 解 HTML 實體。只要處理最常見的幾個，其餘留給前端顯示。 */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => {
      const code = Number(d);
      // 只解可列印的 ASCII 與常用拉丁字元，避免產生控制字元
      return code >= 32 && code < 127 ? String.fromCharCode(code) : ' ';
    });
}

/** 去標籤、壓空白、截長。 */
function toPlain(html, max) {
  const t = decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return max ? t.slice(0, max) : t;
}

/**
 * 摘要是否「只是把標題再貼一次」。
 * 這是本模組存在的理由：這種 excerpt 不能當摘要用。
 */
function isRedundant(excerpt, title) {
  const ex = String(excerpt || '').trim();
  const ti = String(title || '').trim();
  if (!ex) return true;              // 空的一律視為不可用
  if (!ti) return false;
  // 取標題前 40 字比對（標題常被後方出版者名截斷）
  const head = ti.slice(0, Math.min(40, ti.length)).toLowerCase();
  const e = ex.toLowerCase();
  if (e.startsWith(head)) return true;
  // 也可能是「摘要開頭 40 字與標題相同」
  if (head.startsWith(e.slice(0, Math.min(40, e.length))) && e.length < head.length + 30) return true;
  return false;
}

/* ============================================================
   Google News 轉址還原
   ============================================================ */

/**
 * 從 news.google.com/rss/articles/… 解出原始網址。
 *
 * 流程（仿 Google News 自家前端）：
 *   1. 抓中介頁，取出 data-n-a-sg（簽章）與 data-n-a-ts（時間戳）
 *   2. POST /_/DotsSplashUi/data/batchexecute，rpcid=Fbv4je
 *   3. 回應中 garturlres 的第二個元素就是原始網址
 *
 * 失敗時回 null，讓上層跳過這則（不影響其他新聞）。
 */
async function decodeGoogleNewsUrl(url) {
  const id = (String(url).match(/articles\/([^?/]+)/) || [])[1];
  if (!id) return null;

  /* 舊格式（CBMi 開頭）可直接 base64 解出網址。
     仍保留這條路：成本幾乎為零，且能覆蓋舊連結。 */
  try {
    const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
    const txt = Buffer.from(b64, 'base64').toString('utf8');
    const m = txt.match(/https?:\/\/[^\s"'\\]+/);
    if (m && !/google\./i.test(m[0]) && /^https?:\/\//.test(m[0])) return m[0];
  } catch { /* 格式不符就走下面的正規流程 */ }

  try {
    const pageRes = await fetch(`https://news.google.com/rss/articles/${id}`, {
      signal: AbortSignal.timeout(DECODE_TIMEOUT_MS),
    });
    const html = await pageRes.text();
    const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
    const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
    if (!sg || !ts) return null;

    // 這個陣列結構由 Google 前端定義，順序不能改。
    const ctx = [[
      'X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null,
      1, null, null, null, null, null, 0, 1,
    ], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0];
    const req = ['garturlreq', ctx, id, Number(ts), sg];
    const payload = [[['Fbv4je', JSON.stringify(req)]]];

    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'f.req=' + encodeURIComponent(JSON.stringify(payload)),
      signal: AbortSignal.timeout(DECODE_TIMEOUT_MS),
    });
    const txt = await res.text();
    // 回應是巢狀 JSON 字串，用寬鬆 regex 取 garturlres 後的網址
    const m = txt.match(/garturlres[^\[]*\[?\\?"?(https?:[^\\"]+)/);
    return m ? m[1].replace(/\\\//g, '/') : null;
  } catch {
    return null;
  }
}

/* ============================================================
   正文抽取
   ============================================================ */

/**
 * 從 HTML 抽正文。
 *
 * 策略：先看 og:description（多數媒體都有，且是編輯寫的摘要），
 * 再看 name=description，最後用段落文字拼。
 * 不用 readability 之類的庫——本專案零執行期依賴是硬約束。
 */
function extractBody(html) {
  const src = String(html || '');
  const og = (src.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{60,})/i) || [])[1] || '';
  const desc = (src.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{60,})/i) || [])[1] || '';

  // 段落：抓 <p> 內 80–1200 字者，過濾導覽與版權聲明
  const paras = [];
  const re = /<p[^>]*>([\s\S]{60,1600}?)<\/p>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const t = toPlain(m[1]);
    if (t.length < 80) continue;
    if (/(cookie|subscribe|sign in|log in|advertisement|all rights reserved|terms of (use|service)|privacy policy|share this article|follow us on)/i.test(t)) continue;
    /* 頁面框架段落。這些話出現在「正文」位置卻是全站共用的樣板，
       若留著會變成摘要與要點（線上實測 Yahoo 的 Trading disclosure
       與 Google News 的 coverage 說明都被當成文章內容）。 */
    if (/(trading disclosure|broker-dealer or investment advis|above button links to|comprehensive up-to-date news coverage|aggregated from sources all over the world)/i.test(t)) continue;
    // 純圖片說明或作者簡介
    if (/^(photo|image|credit|by |published|updated)\b/i.test(t) && t.length < 160) continue;
    paras.push(t);
    if (paras.join(' ').length > BODY_MAX_CHARS * 2) break;
  }

  const joined = paras.join(' ').slice(0, BODY_MAX_CHARS);
  let body = toPlain(og) || toPlain(desc) || joined;
  // og/desc 太短時，段落內容更有資訊量
  if (body.length < 140 && joined.length > body.length) body = joined;

  return { body, og: toPlain(og), desc: toPlain(desc), paraCount: paras.length };
}

/** 抓單篇文章正文。永不擲出。 */
async function fetchOneBody(item) {
  const url = item.resolvedUrl || item.link;
  if (!url || !/^https?:\/\//.test(url)) {
    return { ...item, body: '', bodySource: 'none', bodyOk: false, bodyNote: '無有效連結' };
  }

  /* Yahoo Finance 不帶自訂 UA：帶了會因 response header 過大而
     UND_ERR_HEADERS_OVERFLOW（實測）。其他站帶 UA 較不易被擋。 */
  const isYahoo = /(^|\.)yahoo\.com/i.test(new URL(url).hostname);
  const opts = { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  if (!isYahoo) {
    opts.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      /* 401/403/402 通常是付費牆（Reuters、WSJ、FT 都是）。
         這不是程式錯誤，而是那些媒體的策略，繞不過去也不該繞。
         標記出來，讓上層改用 RSS 摘要並在畫面上誠實說明。 */
      const gated = res.status === 401 || res.status === 402 || res.status === 403;
      return {
        ...item,
        body: '', bodySource: 'none', bodyOk: false,
        bodyNote: gated ? '付費牆' : `HTTP ${res.status}`,
        paywalled: gated,
      };
    }
    const html = await res.text();
    const { body, og, paraCount } = extractBody(html);

    /* 門檻 60 字元：實測部分媒體（Barchart）的正文是動態載入，
       靜態 HTML 只有一小段開場。這種內容仍比純標題有資訊量，
       不該整個丟掉，但要在 bodyOk 上標記為 false，讓排序知道它較弱。 */
    if (!body || body.length < 60) {
      return { ...item, body: '', bodySource: 'none', bodyOk: false, bodyNote: '正文過短', paraCount };
    }
    if (JUNK_BODY.some((re) => re.test(body.slice(0, 120)))) {
      return { ...item, body: '', bodySource: 'none', bodyOk: false, bodyNote: '付費牆或錯誤頁' };
    }

    return {
      ...item,
      body,
      bodySource: og && body === toPlain(og) ? 'og:description' : 'paragraph',
      bodyOk: true,
      bodyNote: null,
      paraCount,
    };
  } catch (e) {
    const note = e.name === 'TimeoutError' ? '逾時'
      : /HEADERS_OVERFLOW/i.test(String(e.cause || '')) ? 'header 過大'
        : '連線失敗';
    return { ...item, body: '', bodySource: 'none', bodyOk: false, bodyNote: note };
  }
}

/* ============================================================
   排序：財務與政策優先
   ============================================================ */

/**
 * 為一則新聞打「分析價值」分數。
 *
 * 為什麼不直接用情緒強度排序：
 * 情緒強度高只代表用詞強烈，不代表內容對基本面重要。
 * 使用者要的是「市場最關注的項目」，那應該由主題決定，不是形容詞。
 */
function scoreNewsworthiness(item, subject) {
  const text = `${item.title || ''} ${item.body || ''}`;
  let s = 0;

  for (const t of FINANCIAL_TERMS) if (t.re.test(text)) s += t.w;
  for (const t of POLICY_TERMS) if (t.re.test(text)) s += t.w;

  // 標題命中的權重加倍：標題是編輯判斷的重點
  let titleS = 0;
  for (const t of FINANCIAL_TERMS) if (t.re.test(item.title || '')) titleS += t.w;
  for (const t of POLICY_TERMS) if (t.re.test(item.title || '')) titleS += t.w;
  s += titleS;

  // 明顯的低價值稿扣分
  if (LOW_VALUE.some((re) => re.test(item.title || ''))) s -= 12;

  /* 機構持股異動自動稿重扣（見 HOLDINGS_NOISE 說明） */
  if (isHoldingsNoise(item.title || '')) s -= 15;

  /* 明顯不談這家公司的稿要重扣。
     實測 AAPL 清單混進「ETO Markets Marks 13th Anniversary…」——
     那是券商公關稿，只是文末順帶提到 Apple，卻因有正文而加分擠進前 10，
     佔掉一則真正有價值的名額。標題完全沒提到標的＝不是這檔的新聞。 */
  if (subject && !mentionsSubject(item.title || '', subject)) s -= 20;

  // 有正文者加分：資訊量確實更大
  if (item.bodyOk && item.body.length > 200) s += 5;

  // 一線媒體加分（但幅度小於主題）
  if (item.tier === 1) s += 4;
  else if (item.tier === 2) s += 2;

  // 太舊的新聞扣分：7 天內，每過一天扣 0.5
  if (item.time) {
    const daysOld = (Date.now() - item.time) / 86400000;
    s -= Math.min(daysOld * 0.5, 3.5);
  }

  return Math.round(s * 10) / 10;
}

/** 主題標籤，讓前端能顯示「財報」「監管」等分類。 */
function topicOf(item) {
  const text = `${item.title || ''} ${item.body || ''}`;
  const fin = FINANCIAL_TERMS.reduce((a, t) => a + (t.re.test(text) ? t.w : 0), 0);
  const pol = POLICY_TERMS.reduce((a, t) => a + (t.re.test(text) ? t.w : 0), 0);
  if (fin === 0 && pol === 0) return 'other';
  if (fin > pol * 1.3) return 'financial';
  if (pol > fin * 1.3) return 'policy';
  return 'both';
}

const TOPIC_LABEL = {
  financial: '財務',
  policy: '政策／監管',
  both: '財務＋政策',
  other: '其他',
};

/* ============================================================
   簡單去重（跨來源同一事件）
   ============================================================ */

/**
 * 產生「事件指紋」用於去重。
 *
 * news-hub 已用 dedupeKey 去過一次，但那是以**完全相同標題**為基礎。
 * 不同媒體報導同一事件時標題用字不同，仍會重複。
 * 這裡用「顯著詞集合的 Jaccard 相似度」補一層。
 */
function significantWords(title) {
  const STOP = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at',
    'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
    'its', 'it', 'this', 'that', 'these', 'those', 'has', 'have', 'had',
    'will', 'would', 'could', 'should', 'may', 'might', 'can', 'says', 'said',
    'after', 'before', 'over', 'into', 'than', 'then', 'up', 'down', 'out',
    'new', 'more', 'most', 'about', 'what', 'how', 'why', 'who', 'when',
  ]);
  return new Set(
    String(title || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

function similarity(a, b) {
  const A = significantWords(a);
  const B = significantWords(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 兩個標題是否為同一事件。
 *
 * 為什麼 Jaccard 不夠：中文/英文標題越長，重疊比例越被稀釋。
 * 實測同一則 Talkie 下架事件的三個標題：
 *   「Apple (AAPL) Stock: App Store Removes MiniMax's Talkie Chatbot」
 *   「Apple Removes Talkie From App Store After Reports of …」
 *   「Apple (AAPL) Removes Chatbot from App Store Over Child Safety …」
 * Jaccard 只有 0.31–0.50，全部低於 0.62 門檻，於是同一天出現三則。
 *
 * 補一個更貼近語意的訊號：**兩者是否共享「罕見詞」**。
 * 所謂罕見詞＝不是每則新聞都會出現的詞。「talkie」「appstore」
 * 這類專有名詞同時出現在兩個標題裡，幾乎可以確定是同一件事；
 * 而「apple」「stock」這種每則都有的詞不該拿來判斷。
 */
const COMMON_TITLE_WORDS = new Set([
  'apple', 'aapl', 'stock', 'stocks', 'shares', 'share', 'price', 'company',
  'inc', 'corp', 'nasdaq', 'nyse', 'today', 'week', 'year', 'report',
  'reports', 'reported', 'news', 'analyst', 'analysts', 'market', 'markets',
]);

function rareShared(A, B) {
  const out = [];
  for (const w of A) {
    if (!B.has(w)) continue;
    if (COMMON_TITLE_WORDS.has(w)) continue;
    if (w.length < 4) continue;
    out.push(w);
  }
  return out;
}

/**
 * 去重：相似度超過門檻、或共享「兩個以上罕見詞」視為同一事件，
 * 保留分數較高者（呼叫端已先排序）。
 */
function dedupeByEvent(items, threshold = 0.62) {
  const kept = [];
  for (const it of items) {
    const A = significantWords(it.title);
    const dup = kept.find((k) => {
      if (similarity(k.title, it.title) >= threshold) return true;
      const shared = rareShared(A, significantWords(k.title));
      /* 兩個以上罕見詞重疊即視為同一事件。
         實測 Talkie 三則共享 {appstore, talkie}、{appstore, removes} 等組合，
         而「Apple 財報」「Apple AI 策略」不會共享這類專有名詞。 */
      return shared.length >= 2;
    });
    if (dup) {
      dup.alsoReportedBy = [...new Set([...(dup.alsoReportedBy || []), it.publisher].filter(Boolean))];
      continue;
    }
    kept.push(it);
  }
  return kept;
}

/* ============================================================
   併發控制
   ============================================================ */

/** 固定併發跑 async 任務，保持輸出順序。 */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
    for (;;) {
      const i = idx++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ============================================================
   主流程
   ============================================================ */

/**
 * 為新聞清單補上正文，並依「財務／政策」重要性排序，取前 N 篇。
 *
 * @param {object[]} items      news-hub 的 news 陣列
 * @param {object}   [opts]
 * @param {number}   [opts.limit=10]       最多抓幾篇正文
 * @param {boolean}  [opts.resolveGoogle=true] 是否解 Google 轉址
 * @returns {Promise<{items:object[], stats:object}>}
 */
async function enrichNews(items, opts) {
  const o = opts || {};
  const limit = Number.isFinite(o.limit) ? o.limit : 10;
  /* 標的歸屬：用來剔除「不是這家公司」的稿。
     呼叫端沒給時退回 null，此時不做剔除（寧可保守，不要誤殺）。 */
  const subject = o.subject
    ? { symbol: o.subject.symbol || null, name: o.subject.name || null, shortName: o.subject.shortName || null }
    : (o.symbol || o.name ? { symbol: o.symbol || null, name: o.name || null, shortName: null } : null);
  const list = Array.isArray(items) ? items.slice() : [];
  if (!list.length) {
    return { items: [], stats: { total: 0, fetched: 0, bodyOk: 0, decoded: 0, deduped: 0 } };
  }

  /* 步驟 1：先依標題粗排，確保只對「最可能重要」的前 limit*2 篇花成本，
     再從中精選。若不先粗排，可能把抓取預算花在行情播報稿上。 */
  const preRanked = list
    .map((it) => ({
      ...it,
      preScore: scoreNewsworthiness(it, subject),
      topic: topicOf(it),
      excerptUsable: !isRedundant(it.excerpt, it.title),
    }))
    .sort((a, b) => b.preScore - a.preScore);

  // 去重先做，避免把抓取預算浪費在重複事件上
  const dedupedPre = dedupeByEvent(preRanked);
  const dedupedCount = preRanked.length - dedupedPre.length;

  const candidates = dedupedPre.slice(0, Math.max(limit, 1));

  /* 步驟 2：解析 Google 轉址（只對候選者做，省時間） */
  let decoded = 0;
  if (o.resolveGoogle !== false) {
    const need = candidates.filter((it) => it.linkKind === 'google-redirect' || /news\.google\.com/i.test(it.link || ''));
    const resolved = await mapLimit(need, CONCURRENCY, async (it) => {
      const real = await decodeGoogleNewsUrl(it.link);
      return { link: it.link, real };
    });
    const map = new Map(resolved.map((r) => [r.link, r.real]));
    for (const it of candidates) {
      const real = map.get(it.link);
      if (real) { it.resolvedUrl = real; decoded++; }
    }
  }

  /* 步驟 3：抓正文。只抓「摘要不可用」或「主題重要」的；
     excerpt 本身已經有實質內容的就不重抓，省時間。 */
  const enriched = await mapLimit(candidates, CONCURRENCY, async (it) => {
    const needsBody = !it.excerptUsable || it.topic === 'financial' || it.topic === 'policy' || it.topic === 'both';
    if (!needsBody) {
      return { ...it, body: it.excerpt || '', bodySource: 'excerpt', bodyOk: false, bodyNote: '沿用 RSS 摘要' };
    }
    const r = await fetchOneBody(it);

    /* 抓失敗時的退路，順序很重要：
       ① 若 RSS 摘要本身有內容（非標題重複）→ 用摘要
       ② 若抓到「過短但非空」的正文 → 用它（動態載入的站仍有一小段開場）
       ③ 都沒有 → 留空，前端只顯示標題
       這確保「盡力而為，但不假裝有內容」。 */
    if (!r.bodyOk) {
      if (it.excerptUsable && it.excerpt) {
        return { ...r, body: it.excerpt, bodySource: 'excerpt', bodyOk: false, bodyNote: r.bodyNote || '退回摘要' };
      }
      if (r.body && r.body.length >= 40) {
        return { ...r, bodySource: 'partial', bodyOk: false };
      }
      return { ...r, body: '', bodySource: 'none' };
    }
    return r;
  });

  /* 步驟 4：以「有正文」重新計分並最終排序 */
  const scored = enriched.map((it) => ({
    ...it,
    score: scoreNewsworthiness(it, subject),
    topicLabel: TOPIC_LABEL[it.topic] || TOPIC_LABEL.other,
    bodyChars: (it.body || '').length,
    /* 提煉摘要。放在評分之後，因為摘要要用到 topic；
       但用 body 本身而非 score，兩者互不影響。 */
    bodySummary: summarizeBody(it, subject),
  })).sort((a, b) => b.score - a.score);

  const bodyOk = scored.filter((it) => it.bodyOk).length;

  return {
    items: scored,
    stats: {
      total: list.length,
      considered: candidates.length,
      fetched: enriched.filter((it) => it.bodySource !== 'excerpt').length,
      bodyOk,
      decoded,
      deduped: dedupedCount,
      summarized: scored.filter((it) => it.bodySummary).length,
    },
  };
}

/* ============================================================
   正文摘要提煉
   ============================================================
 *
 * 為什麼不能直接截前 N 字：
 *   實測抓到的正文開頭常是「Apple ( NASDAQ:AAPL ) shares rose 0.43% to
 *   $355.58 at the 4:00 p.m. ET close on November 25, gaining on a day
 *   when...」—— 這是行情播報，不是文章重點。
 *   使用者要的是「這篇在講什麼」，所以必須挑句，不是切字。
 *
 * 做法（依序）：
 *   ① 切句
 *   ② 剔除垃圾句（版權、訂閱、記者署名、股價播報）
 *   ③ 打分：有實質財務/政策詞 + 有數字 + 位置靠前
 *   ④ 取前 2 句，按原文順序重排（保留因果順序，不要跳來跳去）
 *   ⑤ 截到 180 字內
 */

const SUMMARY_JUNK = [
  /\b(all rights reserved|copyright|©|terms of (?:use|service)|privacy policy)\b/i,
  /\b(subscribe|sign up|newsletter|download the app|follow us|click here|read more)\b/i,
  /\b(image|photo|credit|getty|reuters\/file|source:)\s*[:：]/i,
  /^\s*(by|written by|reported by)\s+[A-Z]/i,
  /\b(shares?|stock)\s+(rose|fell|gained|dropped|closed|traded)\b[^.]{0,60}\b(at the|on)\b/i,
  /\b(disclaimer|forward-looking statements|no obligation to update)\b/i,
  /* 公司樣板介紹。實測「Is Apple Stock Outperforming the Nasdaq?」的正文
     開頭是「Apple Inc. (AAPL) is a leading multinational technology
     company headquartered in Cupertino, California.」—— 這句話對讀者
     零資訊量（誰不知道 Apple 做什麼），卻是分數最高的句子。
     這類「公司履歷」必須剔除，否則摘要等於沒寫。 */
  /\b(is|are)\s+(a|an|the)\s+(leading|major|global|well-known|prominent|diversified)\b[^.]{0,80}\b(company|corporation|firm|provider|manufacturer|technology)\b/i,
  /\bheadquartered in\b/i,
  /\b(you get free stock quotes|up-to-date news|financial data|research tools)\b/i,
  /* 分析師免責聲明。Seeking Alpha 等站的正文開頭常整段是
     「Analyst's Disclosure: I/we have a beneficial long position in the
     shares of AAPL, AMZN…」「I am not receiving compensation for it」。
     這種句子含有 AAPL 會通過標的錨定，卻完全沒有文章內容，
     一旦當成摘要就是純垃圾。 */
  /\b(analyst'?s?\s+disclosure|beneficial long position|i\/we have|i wrote this article|express(es)? my own opinions?)\b/i,
  /\b(not receiving compensation|no business relationship with any company|not an investment advisor|personal opinion and is not meant to be)\b/i,
  /\b(this article (was|is) (produced|written) by|seeking alpha|investment research platform)\b/i,
  /* 頁面框架（第三道防線：即使 body 過濾漏掉，也不讓它變成摘要） */
  /comprehensive up-to-date news coverage/i,
  /aggregated from sources all over the world/i,
  /trading disclosure|broker-dealer or investment advis/i,
  /the above button links to/i,
];

/* 摘要時值得保留的「有資訊量」句子特徵 */
const SUMMARY_VALUE = /\b(revenue|sales|earnings|profit|margin|guidance|outlook|forecast|eps|dividend|buyback|cash flow|capex|subscri\w+|shipment\w+|market share|tariff\w*|regulat\w+|antitrust|lawsuit|probe|approval|launch\w*|partner\w*|acqui\w+|expand\w*|cost|price|billion|million|percent)\b/i;

/** 切句（中英通用；處理常見縮寫避免誤切） */
function splitSentences(text) {
  return String(text || '')
    /* 縮寫保護。實測漏掉的兩個：
         「Nov. 26, 2026」被切成兩句 → 摘要變成「26, 2026 (GLOBE NEWSWIRE)…」
         「4:00 p.m. ET」被切成兩句 → 摘要停在「at the 4:00 p.m.」
       月份縮寫與 a.m./p.m. 必須一起保護，否則摘要會從句子中間開始。 */
    .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\./g, '$1<DOT>')
    .replace(/\b(a\.m|p\.m|U\.S|U\.K|Inc|Ltd|Co|Corp|Mr|Ms|Mrs|Dr|No|vs|e\.g|i\.e|Jr|Sr|St)\./gi, '$1<DOT>')
    .split(/(?<=[。！？])|(?<=[.!?])\s+/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter((s) => s.length >= 35);
}

/**
 * 從正文提煉 2 句話的摘要。
 * @returns {string} 空字串代表「沒有可用正文」，讓前端知道要退回 excerpt
 */
function summarizeBody(item, subject) {
  const body = String((item && item.body) || '');
  if (!body || body.length < 80) return '';

  const title = String((item && item.title) || '');
  const titleWords = significantWords(title);

  const sents = splitSentences(body)
    .filter((s) => !SUMMARY_JUNK.some((re) => re.test(s)))
    /* 資料源把段落接成一長串，切句後可能從半句話開始
       （實測：摘要以「ver than 60% of MiniMax's revenue in…」開頭，
       原句是「…generated more than 60%…」被截斷）。
       判斷法：開頭是小寫字母，或開頭是常見的句中連接詞。
       這種句子寧可丟掉——看起來像壞掉的摘要比沒有摘要更糟。 */
    .filter((s) => /^[A-Z0-9"'(「『]/.test(s.trim()))
    .filter((s) => !/^(and|but|or|which|that|while|although|however|moreover|meanwhile|as a result|in addition|ver|ther|ing|ed)\b/i.test(s.trim()));
  if (!sents.length) return '';

  /* 標的錨定（三步，順序不可調換）
     ------------------------------------------------
     實測「Can VZ's New Apple Deals …」這則：標題提到 Apple，
     但正文 661 字從頭到尾沒出現過 Apple，整段在講 Verizon 的本益比 8.93。
     摘要因此變成 Verizon 的分析，與標題完全脫節——前端看起來就是張冠李戴。

     ① 正文完全沒提到標的 → 這篇的正文主體不是這家公司，整篇作廢。
        （實測 AAPL 七篇有正文的稿子裡只有一篇如此，代價可接受；
        退回 RSS 摘要至少與標題一致，且 UI 會標示「未讀到正文」。）
     ② 正文有提到標的 → 只從「確實提到標的」的句子裡挑。
        這樣就算文章前半段先鋪陳別家公司，摘要也不會跑題。 */
  if (subject) {
    if (!mentionsSubject(body, subject)) return '';
    const anchored = sents.filter((s) => mentionsSubject(s, subject));
    if (!anchored.length) return '';
    sents.length = 0;
    Array.prototype.push.apply(sents, anchored);
  }

  const scored = sents.map((s, i) => {
    let v = 0;
    if (SUMMARY_VALUE.test(s)) v += 3;       // 有實質商業內容
    if (/\d/.test(s)) v += 1.5;              // 有數字更具體
    if (i <= 1) v += 1.5;                    // 開頭句多半是主題句
    if (s.length > 260) v -= 1.5;            // 過長不好掃讀
    if (s.length < 55) v -= 0.8;             // 過短資訊不足
    /* 與標題共詞＝這句確實在講標題那件事，而不是文章旁的補充背景 */
    if (titleWords.size) {
      const sw = significantWords(s);
      let shared = 0;
      for (const w of sw) if (titleWords.has(w)) shared++;
      if (shared >= 2) v += 1.5;
      else if (shared === 1) v += 0.5;
    }
    return { s, i, v };
  }).sort((a, b) => b.v - a.v);

  /* 門檻：至少要有一句真的帶商業內容（SUMMARY_VALUE +3）。
     為什麼需要這個門檻：實測「公司履歷」類文章的正文被清掉樣板句後，
     只剩「Companies valued at over $1 trillion are rare.」這種空話，
     分數 1.5+1.5=3 也會被選中，結果摘要看起來像廢話。
     寧可回空字串（前端會退回 RSS 摘要並標示「未讀到正文」），
     也不要產出一句沒有資訊量的摘要。 */
  if (!scored.length || scored[0].v < 4.5) return '';

  /* 取分數最高的 2 句，但按原文順序輸出（保留因果關係） */
  const picked = scored.slice(0, 2).sort((a, b) => a.i - b.i);

  let out = picked.map((x) => x.s).join(' ');
  out = out.replace(/\s+/g, ' ').trim();

  // 截斷：優先在句號處收尾，避免句子講一半
  if (out.length > 190) {
    const cut = out.slice(0, 190);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'));
    out = lastStop > 110 ? cut.slice(0, lastStop + 1) : cut.replace(/[,;，；]\s*$/, '') + '…';
  }
  return out;
}

module.exports = {
  enrichNews,
  decodeGoogleNewsUrl,
  extractBody,
  summarizeBody,
  splitSentences,
  fetchOneBody,
  scoreNewsworthiness,
  topicOf,
  TOPIC_LABEL,
  isRedundant,
  dedupeByEvent,
  similarity,
  significantWords,
  mentionsSubject,
  isHoldingsNoise,
  // 供測試檢查
  FINANCIAL_TERMS,
  POLICY_TERMS,
  LOW_VALUE,
  HOLDINGS_NOISE,
};
