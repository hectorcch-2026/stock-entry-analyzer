'use strict';

/**
 * 關鍵字 → 觀點 → 新聞依據（需求 2 的實作）
 * 需求原文：「根據關鍵字生成相關觀點，並保留支撐該觀點的新聞依據」。
 *
 * ── 為什麼要獨立成一支模組 ────────────────────────────────
 * news-sides.js 已經在做「看好／看跌」，那是以**情緒方向**為軸的切法。
 * 需求 2 要的是另一條軸：**以關鍵字為軸**。兩者不能合併，因為：
 *   · 同一關鍵字可以同時產生看好與看跌兩種觀點（監管調查對龍頭是風險，
 *     對合規廠商是機會）；
 *   · 使用者追問的是「你為什麼這樣說」，答案必須指回具體新聞，
 *     而不是只給一個情緒標籤。
 * 所以這裡輸出的是「觀點物件」，每個觀點自帶：
 *   keyword（來自哪個關鍵字）→ claim（觀點）→ evidence[]（支撐它的新聞）
 *   → counter（反向證據，若有）。少了 counter，觀點就會像單方面背書。
 *
 * ── 分層原則（與全專案一致）─────────────────────────────
 * 規則層先產出完整可用的觀點；LLM 只負責把 claim 講得更像人話，
 * 且**不得改變 evidence 與方向**——那些是程式算出來的、可稽核的事實。
 * 這樣即使沒有 LLM（Render 目前就是這種狀態），功能依然成立。
 */

const { CONCEPT_BY_ID } = require('./news-keywords');

/* ============================================================
   句型庫
   ============================================================
   規則層沒有生成能力，只能用「模板 + 該關鍵字的實際證據」組句。
   模板必須帶入真實數字或真實標題片段，否則會變成空話。

   每類概念給三種句型的寫法差異：
     · dir='risk'   → 講代價與不確定性
     · dir='upside' → 講受益路徑
     · dir='watch'  → 講「需要觀察什麼」（中性）
   ============================================================ */

/**
 * 每個概念類別的觀點骨架。
 *
 * mech  = 機制說明（為什麼這個關鍵字會影響股價），這是觀點的「因為」。
 * hedge = 該類別最常被忽略的反面，當作 caveat 用，避免觀點變成單邊結論。
 */
const CONCEPT_VIEWS = {
  /* ---- 財務 ---- */
  revenue: {
    upside: '營收是這批新聞最常被提到的數字，市場正在用它驗證成長是否還在軌道上',
    risk: '營收相關消息偏多，但若成長主要由價格或一次性因素帶動，品質就要打折',
    mech: '營收決定規模，也是毛利率與營業槓桿的分母；成長放緩時，費用剛性會直接壓縮獲利',
    hedge: '單季營收受產品週期與匯率影響大，一季的優劣不足以定調趨勢',
  },
  earnings: {
    upside: '獲利能力被反覆討論，且討論集中在「賺得比預期多」這一側',
    risk: '獲利相關消息出現雜音，需要確認是一次性項目還是本業轉弱',
    mech: '獲利是估值的最終錨點；EPS 與市場預期的差距，通常比絕對值更影響短期股價',
    hedge: '若獲利改善來自費用遞延或稅率，隔年就可能回吐',
  },
  margin: {
    upside: '毛利率是這批新聞的隱含焦點，反映定價權仍在自己手上',
    risk: '毛利率被拿出來討論，通常意味著成本或價格壓力已經進入市場視野',
    mech: '毛利率同時反映定價權與成本結構，是判斷「成長有沒有含金量」最直接的一條線',
    hedge: '毛利率的短期波動常來自產品組合，未必代表長期競爭力改變',
  },
  guidance: {
    upside: '業績指引是市場定調未來兩季的依據，目前的解讀偏正向',
    risk: '業績指引出現調整訊號，這是比已公布的財報更有殺傷力的資訊',
    mech: '指引代表管理層對未來的看法，市場通常會先交易指引、再回頭修財報模型',
    hedge: '管理層指引本身有保守傾向，過度解讀單次調整容易誤判',
  },
  valuation: {
    upside: '估值被重新拿出來計算，意味著有人認為目前的價格還沒有反映全部價值',
    risk: '估值成為討論主題，通常出現在股價已經跑了一大段之後',
    mech: '估值是價格與獲利之間的橋樑；同一則獲利消息，在不同估值位階下的股價反應會相反',
    hedge: '估值討論很容易變成事後合理化，重點仍是獲利能不能兌現',
  },
  rating: {
    upside: '評等或目標價被調整，代表賣方正在重寫對這檔的假設',
    risk: '評等相關消息偏空，這類調整往往帶動被動資金同步移動',
    mech: '評等調整本身不改變基本面，但會改變資金流向與短期籌碼結構',
    hedge: '賣方評等有落後性，經常是在股價反應之後才調整',
  },
  cashflow: {
    upside: '現金流被點名為優勢，這在利率偏高的環境是實質的防禦力',
    risk: '現金流的討論帶有疑慮，需要確認是營運流出還是資本支出造成',
    mech: '自由現金流決定回購、股利與償債的空間，是估值下限的支撐',
    hedge: '現金流也會受應收帳款與存貨變動影響，單季數字波動大',
  },

  /* ---- 政策／監管 ---- */
  regulatory: {
    upside: '監管動作被視為利空出盡或產業秩序改善，對合規領先者有結構性好处',
    risk: '監管與調查是這批新聞最明確的風險項，這類事件的時間與罰則都不可預測',
    mech: '監管會改變可服務市場與合規成本，影響的是未來數年的成長率，而非單季數字',
    hedge: '監管消息常先以「調查」形式出現，最終罰則或和解條件可能遠低於市場最初的反應',
  },
  antitrust: {
    upside: '反壟斷議題升溫，但若最終只帶來行為補救而非結構拆分，對本業影響有限',
    risk: '反壟斷是這批新聞裡殺傷力最持久的風險，因為它可能直接限制商業模式',
    mech: '反壟斷的終局可能是罰款、行為限制或業務拆分，三者對估值的影響差一個量級',
    hedge: '這類案件動輒數年，期間股價對進展的反應往往大於最終結果',
  },
  tariff: {
    upside: '關稅或貿易議題發酵，若公司有產能轉移能力，反而可能取得相對優勢',
    risk: '關稅直接壓縮毛利，且成本轉嫁需要時間，通常先進成本、後反映在售價',
    mech: '關稅是外生的成本衝擊，會同時影響毛利與終端需求，雙邊擠壓',
    hedge: '關稅細則與豁免名單經常變動，初期反應常被過度放大',
  },

  /* ---- 產品／技術 ---- */
  ai: {
    upside: 'AI 佈局是這批新聞最集中的題材，市場正在為「AI 能不能變現」定價',
    risk: 'AI 相關消息偏多，但要留意資本支出已經先行、營收還沒跟上',
    mech: 'AI 影響兩件事：新的營收曲線，以及資料中心資本支出對自由現金流的侵蝕',
    hedge: 'AI 題材容易把估值推到需要多年兌現的位置，中途的失望期會很長',
  },
  capex: {
    upside: '資本支出方向明確，代表公司願意為下一輪成長先付錢，且有具體落地項目',
    risk: '資本支出是這批新聞的壓力點：錢先花、折舊後到，短期自由現金流會先受傷',
    mech: '資本支出是「今天的現金流出、明天的產能」，市場對它的評價取決於回報能否在合理期間兌現',
    hedge: '資本支出可以遞延，若需求轉弱，管理層通常會先砍這塊，屆時營收預期也會同步下修',
  },
  buyback: {
    upside: '回購與股息是這批新聞的支撐項，等於管理層用真金白銀為股價背書',
    risk: '回購與股息的可持續性被質疑，這通常連帶暗示現金流或獲利展望有變',
    mech: '回購減少流通股數、直接墊高 EPS，是估值下限的重要支撐；但它需要自由現金流餵養',
    hedge: '在高估值時回購，等同用貴的價格買自家股票，長期回報未必優於投入本業',
  },
  cost: {
    upside: '成本結構有改善空間，任何效率提升都會直接放大到獲利',
    risk: '成本壓力是這批新聞中較明確的負面因子，會先侵蝕毛利、再影響終端定價',
    mech: '成本是毛利率的直接對手；在營收成長放緩時，成本控管幾乎是唯一還能動的槓桿',
    hedge: '一次性成本（重組、減損）常被誤讀為結構性惡化，需看後續季度是否回落',
  },
  product: {
    upside: '新產品與功能是這批新聞的正面主軸，屬於可驗證的具體進展',
    risk: '產品相關消息的評價分歧，需要看實際出貨或採用率才能確認',
    mech: '新產品決定下一輪成長曲線，市場會先交易期待、再用銷售數據修正',
    hedge: '發表與上市之間有時間差，初期熱度不等於營收貢獻',
  },
  iphone: {
    upside: 'iPhone 與換機潮是這批新聞的討論核心，銷售動能被視為成長的即時指標',
    risk: '換機週期相關消息偏弱，這條線直接牽動公司最大的營收來源',
    mech: 'iPhone 是營收與安裝基數的雙重來源：它賣得好，硬體營收與後續服務收入會一起受益',
    hedge: '單一機型的銷售受電信商補貼與匯率影響大，需要對照整體出貨而非單季熱度',
  },
  services: {
    upside: '服務業務被視為高毛利、可重複的收入來源，有助於估值品質',
    risk: '服務業務的成長若放緩，會直接影響市場給這檔的本益比',
    mech: '服務收入毛利率遠高於硬體，占比上升會結構性改善整體獲利與評價',
    hedge: '服務成長常與裝置安裝基數綁定，硬體銷售轉弱會在數季後反映',
  },
  partnership: {
    upside: '合作與結盟消息是這批新聞的正面因子，代表外部資源正在被導入',
    risk: '合作相關消息的實際貢獻仍待驗證，宣布與落地之間常有落差',
    mech: '結盟能繞過自建能力的時間成本，但也意味著價值需要與夥伴分潤',
    hedge: '合作協議多半不揭露財務條件，很難據此推算對營收的實際貢獻',
  },

  /* ---- 政策／監管 ---- */
  regulatory: {
    upside: '監管動作被視為利空出盡或產業秩序改善，對合規領先者有結構性好處',
    risk: '監管與調查是這批新聞最明確的風險項，這類事件的時間與罰則都不可預測',
    mech: '監管會改變可服務市場與合規成本，影響的是未來數年的成長率，而非單季數字',
    hedge: '監管消息常先以「調查」形式出現，最終罰則或和解條件可能遠低於市場最初的反應',
  },
  antitrust: {
    upside: '反壟斷議題升溫，但若最終只帶來行為補救而非結構拆分，對本業影響有限',
    risk: '反壟斷是這批新聞裡殺傷力最持久的風險，因為它可能直接限制商業模式',
    mech: '反壟斷的終局可能是罰款、行為限制或業務拆分，三者對估值的影響差一個量級',
    hedge: '這類案件動輒數年，期間股價對進展的反應往往大於最終結果',
  },
  lawsuit: {
    upside: '法律爭議若朝和解方向發展，不確定性移除本身就是利多',
    risk: '訴訟與法律風險是這批新聞中較難量化的一項，潛在賠償可能超出預期',
    mech: '法律風險影響的是尾部情境，市場通常以折價而非直接扣減的方式反應',
    hedge: '多數訴訟最終以低於起訴金額和解，過度反應的情況很常見',
  },
  tariff: {
    upside: '關稅或貿易議題發酵，若公司有產能轉移能力，反而可能取得相對優勢',
    risk: '關稅直接壓縮毛利，且成本轉嫁需要時間，通常先進成本、後反映在售價',
    mech: '關稅是外生的成本衝擊，會同時影響毛利與終端需求，雙邊擠壓',
    hedge: '關稅細則與豁免名單經常變動，初期反應常被過度放大',
  },
  privacy: {
    upside: '隱私與兒少安全規範趨嚴，對已建立合規流程的平台反而是競爭門檻',
    risk: '隱私與兒少安全是這批新聞裡的合規風險，可能導致產品受限或面臨罰款',
    mech: '隱私規範影響的是資料使用能力，進而影響廣告與個人化服務的變現效率',
    hedge: '法規落地時間長，且各國標準不一，初期多為局部市場的調整',
  },
  appstore: {
    upside: 'App Store 政策變化若朝向開放，對平台抽成模式的長期爭議可望緩解',
    risk: 'App Store 政策是被監管緊盯的環節，任何強制開放都會動搖高毛利的抽成收入',
    mech: 'App Store 抽成是服務業務毛利最高的部分，政策一變就直接影響服務營收結構',
    hedge: '政策調整通常有過渡期與豁免條款，實際財務影響往往小於表面標題',
  },
  removal: {
    upside: '應用下架爭議若迅速解決，對營運的實質影響有限',
    risk: '應用下架與停權是這批新聞的即時風險，會直接切斷該市場的服務收入',
    mech: '下架影響的是通路可及性；在單一市場下架，短期營收與用戶成長都會受損',
    hedge: '下架常是合規程序問題，若在數週內恢復，實際財務影響通常很小',
  },

  /* ---- 市場面 ---- */
  demand: {
    upside: '需求與出貨是這批新聞的正面主軸，代表訂單端仍在擴張',
    risk: '需求相關消息轉弱，這是最貼近營收的領先指標',
    mech: '需求決定出貨，出貨決定營收；它是財報公布前唯一能觀察到的即時線索',
    hedge: '需求訊號常來自通路或供應鏈訪談，雜訊多，需與官方財測交叉驗證',
  },
  institution: {
    upside: '機構持股變動顯示長線資金仍在場內，籌碼結構相對穩定',
    risk: '機構持股或內部人交易出現變化，這類訊息常領先於公開基本面',
    mech: '籌碼結構影響的是股價的支撐與壓力，而不是公司本身的獲利能力',
    hedge: '13F 持股有 45 天遞延，看到時往往已經不是最新部位',
  },
  sentiment: {
    upside: '市場情緒偏樂觀，這在短期內會自我強化，但也意味著容錯空間變小',
    risk: '市場情緒轉弱，短期資金面比基本面更早反映在股價上',
    mech: '情緒決定短期的評價乘數；同一組獲利數字，在樂觀與悲觀環境下的本益比可以差一倍',
    hedge: '情緒是最容易反轉的變數，不適合作為中長期判斷的主要依據',
  },
  macro: {
    upside: '宏觀環境被納入討論，若利率路徑轉鴿，對高評價股是直接利多',
    risk: '宏觀因素是外生變數，公司無法控制，卻會主導評價的折現率',
    mech: '利率與景氣決定折現率與終端需求，是評價乘數的最大變數',
    hedge: '宏觀預測的準確度本身很低，不宜當作單一決策依據',
  },

  /* ---- 風險 ---- */
  competition: {
    upside: '競爭議題被討論，但龍頭的規模優勢在價格戰中通常是受益方',
    risk: '競爭壓力是這批新聞中的結構性風險，因為它壓縮的是長期毛利率',
    mech: '競爭會壓縮定價權，最終反映在毛利率與市占率的同步下滑',
    hedge: '競爭對手的動作常有宣傳成分，實際市占變化要看季度數據',
  },
  supply: {
    upside: '供應鏈狀況改善，通常先反映在交期縮短與成本下降',
    risk: '供應鏈是這批新聞的風險項，缺料或斷鏈會直接打斷出貨節奏',
    mech: '供應鏈決定能不能把需求變成營收，是訂單與出貨之間的閘門',
    hedge: '供應鏈問題常是短期擾動，除非牽涉到單一來源的關鍵零件',
  },
};

/**
 * 舊 id → 現行 id 的對照。
 *
 * 為什麼需要：CONCEPT_VIEWS 最早是照「概念語意」命名（antitrust、legal、service），
 * 後來 news-keywords 的 CONCEPTS 改用了更貼近語料的 id（tariff、lawsuit、services）。
 * 兩邊不一致時不會報錯，只會讓該關鍵字默默掉回通用模板函式——
 * 實測「服務業務」就是這樣變成一句空話。保留對照表讓舊寫法仍能命中。
 */
const CONCEPT_ALIAS = {
  antitrust: 'tariff',
  legal: 'lawsuit',
  service: 'services',
};

/** 概念的預設骨架（未在 CONCEPT_VIEWS 登錄時使用）。 */
const DEFAULT_VIEW = {
  upside: '這項主題在這批新聞中被反覆提及，且論述方向偏正面',
  risk: '這項主題在這批新聞中被反覆提及，但論述方向偏負面',
  mech: '被多則新聞共同提及的主題，通常是市場當前定價的主要依據',
  hedge: '主題熱度不等於結論正確，仍需對照實際財務數字',
};

/* ============================================================
   證據挑選
   ============================================================ */

/**
 * 從一則新聞中挑出「支撐某個關鍵字」的那一句。
 *
 * 為什麼不能直接拿標題：標題是編輯下的，常是問句或釣魚式寫法
 * （「Is Apple Stock Outperforming?」），不構成依據。
 * 也不能拿整段正文：前端要塞進卡片，而且使用者要的是「哪一句話」。
 *
 * 策略：在正文中找含關鍵字線索的句子；找不到就退回 title。
 * 句子要能自我說明（含數字或事件詞優先），並截到可掃讀的長度。
 *
 * ── 主體過濾（實測踩到的坑，必須保留）────────────────────
 * 第一版只比對關鍵字，結果出現大量張冠李戴的引文：
 *   · 關鍵字「獲利」→ 引用「Verizon trades at 8.93x forward earnings」
 *     （同一則新聞裡在比較 Verizon，不是在講 Apple）
 *   · 關鍵字「營收」→ 引用「Talkie … generated 60% of MiniMax's revenue」
 *     （那是在講 MiniMax 的營收）
 *   · 關鍵字「評等調整」→ 引用「18-plus age rating on the App Store」
 * 這三種都是「句子命中關鍵字，但主體不是這檔股票」。
 * 使用者一旦發現引文講的是別家公司，整份報告的可信度就沒了。
 * 因此：句子若提到別家公司且沒提到本標的，直接排除。
 */
function pickEvidenceSentence(item, keyword, subject) {
  const body = String((item && item.body) || '');
  const title = String((item && item.title) || '');
  if (!body) return { text: title, fromTitle: true };

  const sents = splitSentences(body);
  if (!sents.length) return { text: title, fromTitle: true };

  /* 關鍵字的線索：概念關鍵字用中文標籤對不上英文正文，
     所以改用「該概念的正則」來找句；散詞則直接比對字串。 */
  const matcher = buildKeywordMatcher(keyword);

  /* 本標的的名稱與代號，用來判斷句子在講誰 */
  const self = buildSubjectMatcher(subject, item);

  const scored = sents.map((s, i) => {
    let sc = 0;
    if (matcher && matcher(s)) sc += 4;          // 命中關鍵字本身
    if (/\d/.test(s)) sc += 1.5;                 // 有數字更具體
    if (EVENT_RE.test(s)) sc += 1.5;             // 有事件性動詞
    if (i === 0) sc += 0.5;                      // 首句常為主題句
    if (s.length < 40) sc -= 1;                  // 過短資訊量不足
    if (s.length > 260) sc -= 1;                 // 過長難塞進卡片
    /* 主體是別家公司 → 直接淘汰（給 -99 讓它不可能被選中） */
    if (self && !self.mine(s) && self.other(s)) return { s, i, sc: -99 };
    if (self && self.mine(s)) sc += 1;           // 明確講到本標的 → 加分
    return { s, i, sc };
  });

  scored.sort((a, b) => b.sc - a.sc);
  const best = scored[0];
  if (!best || best.sc <= 0) return { text: trimSentence(title || sents[0], 130), fromTitle: true };
  return { text: trimSentence(best.s, 130), fromTitle: false };
}

/**
 * 建立「這句在講本標的嗎」的判斷器。
 *
 * @param {object} subject  {symbol,name,shortName}
 * @param {object} item     當前新聞（用它的 relatedTickers 補強）
 */
function buildSubjectMatcher(subject, item) {
  const s = subject || {};
  const symbol = String(s.symbol || '').toLowerCase();
  const names = [s.name, s.shortName].filter(Boolean)
    .map((n) => String(n).toLowerCase().trim())
    .filter(Boolean);
  if (!symbol && !names.length) return null;

  const deskNames = names.map(stripCorpSuffix).filter((n) => n && n.length >= 3);

  const mine = (text) => {
    const t = String(text || '').toLowerCase();
    if (!t) return false;
    if (symbol) {
      if (t.includes(symbol)) return true;
      const bare = symbol.split('.')[0];
      if (bare && bare.length >= 3 && t.includes(bare)) return true;
    }
    for (const n of names) if (t.includes(n)) return true;
    for (const n of deskNames) if (t.includes(n)) return true;
    return false;
  };

  /* 「別家公司」的辨識：句首主語或「X's / X (TICKER)」這種所有格與代號寫法。
     不把整份公司名詞典搬進來，只用一個可控的常見大型股清單——
     目的是擋掉「同一則新聞裡拿別家做比較」的情況，不是做實體辨識。 */
  const other = (text) => {
    const raw = String(text || '');
    if (!raw) return false;
    /* 明確的其他代號寫法：Apple ( NASDAQ:AAPL ) 這種是本標的，
       但 ( MNMXF )、( VZ ) 這種就是別家。 */
    const tickers = raw.match(/\([^)]{0,24}\)/g) || [];
    for (const g of tickers) {
      const tk = (g.match(/\b[A-Z]{1,5}\b/g) || []).join('');
      if (tk && symbol && tk.toLowerCase() !== symbol.split('.')[0]) {
        // 交易所前綴（NASDAQ/NYSE）不算代號差異
        const cleaned = tk.replace(/NASDAQ|NYSE|AMEX|HKEX/gi, '');
        if (cleaned.length >= 2 && cleaned.toLowerCase() !== symbol.split('.')[0]) return true;
      }
    }
    /* 其他大型股名：只在本句「沒提到本標的」時才算數（由呼叫端保證） */
    const low = raw.toLowerCase();
    for (const co of OTHER_COMPANIES) {
      if (co === symbol.split('.')[0]) continue;
      if (new RegExp(`\\b${co}\\b`, 'i').test(low)) return true;
    }
    return false;
  };

  return { mine, other };
}

/** 去掉 Inc./Corp./Ltd. 等後綴，讓「Apple Inc.」也能用「apple」比對。 */
function stripCorpSuffix(n) {
  return String(n || '')
    .replace(/\b(inc|corp|corporation|ltd|limited|co|company|plc|sa|ag|nv|holdings?|group|technologies|technology)\b\.?/g, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * 常見大型股與指數名。
 *
 * 為什麼需要這份清單：財經新聞很常在講 A 公司時拿 B 公司做比較
 * （「Apple 的本益比高於 Microsoft」「Verizon 的 forward P/E 是 8.93」）。
 * 這些句子會命中關鍵字，但引用的主體不是本標的。
 * 不做完整的實體辨識，只用這份可控清單擋掉最常見的張冠李戴。
 */
const OTHER_COMPANIES = [
  'microsoft', 'alphabet', 'google', 'amazon', 'meta', 'nvidia', 'tesla', 'netflix',
  'verizon', 'at&t', 't-mobile', 'intel', 'amd', 'qualcomm', 'broadcom', 'tsmc',
  'samsung', 'sony', 'ibm', 'oracle', 'salesforce', 'adobe', 'cisco', 'dell', 'hp',
  'walmart', 'target', 'costco', 'disney', 'boeing', 'ford', 'gm', 'general motors',
  'jpmorgan', 'goldman', 'morgan stanley', 'bank of america', 'wells fargo',
  'minimax', 'openai', 'anthropic', 'talkie', 'tencent', 'alibaba', 'baidu', 'jd',
  'palantir', 'snowflake', 'shopify', 'spotify', 'uber', 'airbnb', 'paypal',
];

/** 依關鍵字種類產生「這句是不是在講它」的判斷函式。 */
function buildKeywordMatcher(keyword) {
  if (!keyword) return null;
  if (keyword.kind === 'concept') {
    // 由 CONCEPTS 取回正則（news-keywords 已匯出 CONCEPT_BY_ID）
    const def = CONCEPT_BY_ID[keyword.id];
    if (def && def.re) return (s) => def.re.test(s);
    return null;
  }
  const term = String(keyword.label || '').toLowerCase();
  if (!term) return null;
  if (/[\u4e00-\u9fa5]/.test(term)) {
    /* 中文散詞：只比對 2 字以上片段，避免「市場」這種泛詞亂命中。
       中文沒有詞邊界，用 includes 是可行且必要的。 */
    return (s) => s.includes(term);
  }
  /* 英文散詞：用詞邊界，避免 ai 命中 said（經典誤判） */
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${esc}\\b`, 'i');
  return (s) => re.test(s);
}

const EVENT_RE = /\b(announc\w*|launch\w*|report\w*|said|expect\w*|forecast\w*|guidance|cut|raise\w*|beat|miss\w*|warn\w*|approv\w*|sue[sd]?|probe|investigat\w*|tariff\w*|recall\w*)\b|(宣布|推出|公布|表示|預期|下修|上調|下調|超越|不如|警告|批准|起訴|調查|關稅|召回)/i;

/** 中英混合斷句。不能只用 '.'，因為「U.S.」「4,788.34」會被切碎。 */
function splitSentences(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  /* ① 先在中文句末標點斷；② 英文用「. 後接大寫或結尾」斷；
     ③ 保護小數點與縮寫（U.S.、Inc.、No.） */
  const guarded = s
    .replace(/\b(U\.S|U\.K|Inc|Corp|Ltd|Co|Mr|Ms|Dr|No|vs|etc)\./gi, '$1\u0001');
  const parts = guarded
    .split(/(?<=[。！？；])|(?<=[.!?])\s+(?=[A-Z0-9"'（(])|(?<=[.!?])$/)
    .map((x) => x.replace(/\u0001/g, '.').trim())
    .filter((x) => x.length >= 12);
  return parts.length ? parts : [s];
}

/** 截斷但保留語意（優先在停頓處斷）。 */
function trimSentence(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastPause = Math.max(
    cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf(', '), cut.lastIndexOf('; '),
  );
  if (lastPause > max * 0.5) return cut.slice(0, lastPause) + '…';
  return cut.slice(0, max - 1) + '…';
}

/* ============================================================
   主入口
   ============================================================ */

/** 方向詞典：判斷某個關鍵字的證據整體偏正還是偏負。 */
const POS_RE = /\b(beat|beats|surge[sd]?|jump\w*|record|growth|grew|raise[sd]?|upgrade[sd]?|outperform\w*|strong|profit\w*|expand\w*|approv\w*|win[s]?\b|gain\w*|rally|optimis\w*|undervalued|buy)\b|(超越|成長|創高|上調|調升|優於|強勁|獲利|擴張|批准|取得|上漲|看好|低估)/i;
const NEG_RE = /\b(miss\w*|fall\w*|drop\w*|declin\w*|cut[s]?\b|slump\w*|warn\w*|downgrade[sd]?|underperform\w*|weak\w*|loss\w*|lawsuit|probe|investigat\w*|recall\w*|tariff\w*|fine[sd]?|risk\w*|concern\w*|sell)\b|(不如|衰退|下滑|下修|調降|弱於|虧損|訴訟|調查|召回|關稅|罰款|風險|疑慮|賣出)/i;

/** 對一段文字給出正負淨值。用詞數而非分值，避免長句被單詞主導。 */
function polarity(text) {
  const t = String(text || '');
  const pos = (t.match(new RegExp(POS_RE.source, 'gi')) || []).length;
  const neg = (t.match(new RegExp(NEG_RE.source, 'gi')) || []).length;
  return pos - neg;
}

/**
 * 產生「關鍵字 → 觀點 → 依據」。
 *
 * @param {object[]} articles  已補正文的新聞（news.items）
 * @param {object}   kw        news-keywords.extractKeywords 的輸出
 * @param {object}   opts      { symbol, name, maxViews }
 * @returns {{ views: Array, stats: object }}
 */
function buildViewpoints(articles, kw, opts) {
  const o = opts || {};
  const list = Array.isArray(articles) ? articles : [];
  const keywords = (kw && Array.isArray(kw.keywords)) ? kw.keywords : [];
  const maxViews = Number.isFinite(o.maxViews) ? o.maxViews : 6;
  const subject = { symbol: o.symbol, name: o.name, shortName: o.shortName };

  if (!list.length || !keywords.length) {
    return { views: [], stats: { keywords: keywords.length, views: 0 } };
  }

  const views = [];

  for (const k of keywords) {
    if (views.length >= maxViews) break;

    /* 只處理「有多則新聞支撐」的關鍵字。
       minDocs 已在 extractKeywords 把過關，但概念與散詞門檻不同，
       這裡再擋一次：只有一則新聞的關鍵字無法形成觀點。 */
    const idxs = (k.docIndexes || []).filter((i) => i >= 1 && i <= list.length);
    if (idxs.length < 2) continue;

    const items = idxs.map((i) => list[i - 1]).filter(Boolean);
    if (!items.length) continue;

    /* ---- 證據：每則新聞挑一句，最多 3 條 ----
       ── 為什麼弱的引文直接丟掉，而不是標記後保留 ──────────────
       第一版把 weak 引文留在陣列裡只加旗標，結果前端照樣把它當依據列出，
       實測出現「依據 #6：The strategy delivered a 2.3% gross return」——
       這句跟「評等調整」毫無關係，只是文章背景鋪陳。
       使用者看到這種引文，會直接懷疑整份報告是不是亂湊的。
       所以規則改成：**沒有真正命中主題的引文不進 evidence**。
       代價是某些觀點的證據條數會變少（甚至因此整條觀點消失），
       但這是對的取捨——寧可只有兩條紮實的依據。 */
    const evidence = [];
    let net = 0;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const picked = pickEvidenceSentence(it, k, subject);
      if (!picked.text) continue;

      /* 標題式引文不算依據：標題常是問句（「Should You Buy AAPL?」），
         或只是下標的誘導句，拿它當證據是虛應故事。
         整句既沒關鍵字、又沒事件詞，也只算背景鋪陳。 */
      if (picked.fromTitle) continue;
      if (!sentenceActuallyMatches(picked.text, k)) continue;

      const pol = polarity(`${it.title || ''} ${picked.text}`);
      if (evidence.length < 3) {
        evidence.push({
          newsIndex: idxs[n] || null,
          title: String(it.title || ''),
          publisher: it.publisher || null,
          link: it.resolvedUrl || it.link || null,
          time: it.time || null,
          ageText: it.ageText || '',
          quote: picked.text,
          quoteFromTitle: false,
          weak: false,
          polarity: pol > 0 ? 'pos' : pol < 0 ? 'neg' : 'flat',
        });
      }
      net += pol;
    }

    /* 沒有紮實引文 → 這條關鍵字形成不了觀點。
       保留它只會在報告裡製造一條「有標題、沒內容」的空殼。 */
    if (!evidence.length) continue;

    /* ---- 方向：由證據的整體極性決定 ---- */
    const dir = net > 0 ? 'upside' : net < 0 ? 'risk' : 'watch';
    const skel = findSkeleton(k);

    /* 沒有專屬骨架 → 不產出觀點。
       通用模板只會講「這項主題被反覆提及」這種廢話，
       不如讓前端少顯示一條，把版面留給真的有內容的觀點。 */
    if (!skel) continue;

    const claim = dir === 'watch' ? skel.mech : (skel[dir] || skel.mech);

    views.push({
      keywordId: k.id,
      keyword: k.label,
      cat: k.cat,
      catLabel: k.catLabel,
      weight: k.weight,
      dir,
      dirLabel: dir === 'upside' ? '偏正向' : dir === 'risk' ? '偏風險' : '待觀察',
      claim,
      mechanism: skel.mech,
      caveat: skel.hedge,
      evidence,
      evidenceCount: evidence.length,
      /* 反向證據數：證據裡極性與整體方向相反的條數。
         這個數字讓使用者知道「共識有多一致」，而不是只看到單邊說法。 */
      dissentCount: evidence.filter((e) => (dir === 'upside' && e.polarity === 'neg')
        || (dir === 'risk' && e.polarity === 'pos')).length,
      netPolarity: net,
    });
  }

  return {
    views,
    stats: {
      keywords: keywords.length,
      views: views.length,
      withEvidence: views.filter((v) => v.evidence.length).length,
    },
  };
}

/**
 * 取該關鍵字的觀點骨架。
 *
 * 找不到就回 null，由呼叫端決定怎麼處理——**不要**默默退回 DEFAULT_VIEW：
 * 通用模板會產出「這項主題在這批新聞中被反覆提及」這種空話，
 * 使用者一眼就看得出系統沒東西講。寧可少一條觀點。
 */
function findSkeleton(k) {
  if (!k) return null;
  const direct = CONCEPT_VIEWS[k.id];
  if (direct) return direct;
  const alias = CONCEPT_ALIAS[k.id];
  if (alias && CONCEPT_VIEWS[alias]) return CONCEPT_VIEWS[alias];
  /* 散詞：用標籤反查概念（少數語料會以英文原文命中） */
  for (const id of Object.keys(CONCEPT_VIEWS)) {
    const def = CONCEPT_BY_ID[id];
    if (def && def.label === k.label) return CONCEPT_VIEWS[id];
  }
  return null;
}

/**
 * 這句話真的在講這個關鍵字嗎？
 *
 * pickEvidenceSentence 已用 matcher 加了 4 分，但當該則新聞整篇都沒有
 * 真正命中關鍵字的句子時，最高分的仍可能是一句「有數字有事件詞」
 * 的無關句子。這裡做最後一道閘：要求引文至少符合下列之一，
 * 否則標為 weak，不列入正式依據。
 */
function sentenceActuallyMatches(text, keyword) {
  const m = buildKeywordMatcher(keyword);
  if (m && m(text)) return true;
  if (EVENT_RE.test(text)) return true;
  return false;
}

/** 散詞的 id 是 'w:xxx'，取不到骨架時回 null。 */
function conceptIdFromLabel() {
  return null;
}

/* ============================================================
   結構化匯報（需求 3）
   ============================================================ */

/**
 * 產出繁體中文結構化匯報。
 *
 * 需求原文：「以繁體中文產出結構化匯報，內容包含新聞摘要、關鍵字、
 * 相關觀點與資料來源」。
 *
 * 關鍵設計：這份匯報是**資料結構**，不是一坨文字。
 * 前端可以照自己的版面渲染，但每個區塊都已經有可以直接顯示的
 * 繁中句子；同時保留 report.blocks 的順序，讓「先摘要、再關鍵字、
 * 再觀點、最後來源」的敘事層級不會被版面改動打亂。
 */
function buildReport(articles, kw, vp, opts) {
  const o = opts || {};
  const list = Array.isArray(articles) ? articles : [];
  const keywords = (kw && kw.keywords) || [];
  const allKeywords = keywords;
  const topics = (kw && kw.topics) || [];
  const views = (vp && vp.views) || [];

  const symbol = o.name ? `${o.name}（${o.symbol || ''}）` : (o.symbol || '本標的');
  const now = new Date(o.now || Date.now());

  /* ---- 1. 新聞摘要 ---- */
  /* 不用 LLM 也要有摘要：用「最高權重關鍵字 + 則數 + 時間窗」組合。
     這不是文章摘要，而是「這批新聞在講什麼」的摘要——正是需求要的。

     直接呼叫 summarizeTopics，不在此處另寫一份：
     這句同時出現在「關鍵字區塊」與「匯報第一段」，
     兩邊各寫一次遲早會不一致（實測就出現過一邊講 5 個、一邊列 9 個）。 */
  const topicLine = allKeywords.length
    ? `本次共取用 ${list.length} 則新聞，主要圍繞${allKeywords.slice(0, 3).map((k) => k.label).join('、')}${allKeywords.length > 3 ? `等 ${allKeywords.length} 個關鍵字` : ''}。`
    : `本次共取用 ${list.length} 則新聞，未提煉出明顯的共同主題。`;

  const summary = {
    line: `${symbol}：${topicLine}`,
    articleCount: list.length,
    window: o.window || null,
    generatedAt: now.toISOString(),
    topicLine,
  };

  /* ---- 2. 關鍵字 ---- */
  const keywordBlock = {
    count: keywords.length,
    items: keywords.map((k) => ({
      label: k.label,
      cat: k.cat,
      catLabel: k.catLabel,
      weight: k.weight,
      df: k.df,
      /* 「出現在哪幾則」是這份匯報可追溯的關鍵，
         使用者可以據此回查原文，而不是只能相信系統的結論。 */
      newsIndexes: k.docIndexes || [],
    })),
    topics: topics.map((t) => ({
      cat: t.cat, catLabel: t.catLabel, keywords: t.keywords, weight: t.weight,
    })),
  };

  /* ---- 3. 相關觀點 ---- */
  const viewBlock = {
    count: views.length,
    items: views.map((v) => ({
      keyword: v.keyword,
      dir: v.dir,
      dirLabel: v.dirLabel,
      claim: v.claim,
      mechanism: v.mechanism,
      caveat: v.caveat,
      dissentCount: v.dissentCount,
      evidence: v.evidence.map((e) => ({
        newsIndex: e.newsIndex,
        title: e.title,
        publisher: e.publisher,
        link: e.link,
        ageText: e.ageText,
        quote: e.quote,
      })),
    })),
  };

  /* ---- 4. 資料來源 ---- */
  /* 只列真的有被引用的來源，並標明被引用幾次。
     全部新聞都列上去會讓「來源」變成免責聲明，而不是可查證的清單。 */
  const cited = new Map();
  for (const v of views) {
    for (const e of v.evidence) {
      const key = e.newsIndex || e.title;
      if (!cited.has(key)) {
        cited.set(key, {
          newsIndex: e.newsIndex,
          title: e.title,
          publisher: e.publisher,
          link: e.link,
          ageText: e.ageText,
          citedBy: [],
        });
      }
      const row = cited.get(key);
      if (!row.citedBy.includes(v.keyword)) row.citedBy.push(v.keyword);
    }
  }
  const sources = [...cited.values()].sort((a, b) => (a.newsIndex || 99) - (b.newsIndex || 99));

  const caveats = [];
  if (!list.length) caveats.push('本次沒有取得新聞，報告僅為空殼。');
  if (keywords.length < 2) caveats.push('關鍵字數量偏少，代表這批新聞主題分散，觀點的參考價值有限。');
  if (views.length && views.every((v) => v.dissentCount === 0)) {
    caveats.push('所有觀點的證據方向一致，未出現反向訊號——這可能代表共識，也可能是因為樣本太少。');
  }
  if (views.some((v) => v.dissentCount > 0)) {
    caveats.push('部分觀點含有方向相反的證據，代表市場對該主題仍有分歧，不宜視為單邊結論。');
  }

  return {
    title: `${symbol} 新聞分析匯報`,
    summary,
    keywords: keywordBlock,
    viewpoints: viewBlock,
    sources,
    caveats,
    /* 敘事順序顯式化：前端若要做「匯出／複製全文」，
       照這個順序串就會是一份可直接閱讀的報告。 */
    blocks: ['summary', 'keywords', 'viewpoints', 'sources'],
  };
}

/** 把結構化匯報壓成純文字（給「複製」按鈕與無腳本情境用）。 */
function reportToText(report) {
  const r = report || {};
  const L = [];
  if (r.title) { L.push(r.title); L.push(''); }

  if (r.summary && r.summary.line) {
    L.push('一、新聞摘要');
    L.push(r.summary.line);
    L.push('');
  }

  if (r.keywords && r.keywords.items.length) {
    L.push('二、關鍵字');
    for (const k of r.keywords.items) {
      const idx = (k.newsIndexes || []).join('、');
      L.push(`  · ${k.label}（${k.catLabel}，強度 ${k.weight}${idx ? `，來源 #${idx}` : ''}）`);
    }
    L.push('');
  }

  if (r.viewpoints && r.viewpoints.items.length) {
    L.push('三、相關觀點');
    for (const v of r.viewpoints.items) {
      L.push(`  【${v.keyword}｜${v.dirLabel}】${v.claim}`);
      if (v.mechanism) L.push(`    為什麼重要：${v.mechanism}`);
      for (const e of v.evidence) {
        L.push(`    依據 #${e.newsIndex}（${e.publisher || '來源'}）：${e.quote}`);
      }
      if (v.caveat) L.push(`    須留意：${v.caveat}`);
    }
    L.push('');
  }

  if (r.sources && r.sources.length) {
    L.push('四、資料來源');
    for (const s of r.sources) {
      L.push(`  #${s.newsIndex} ${s.title}`);
      L.push(`      ${s.publisher || ''}${s.ageText ? ` · ${s.ageText}` : ''}${s.link ? ` · ${s.link}` : ''}`);
    }
    L.push('');
  }

  if (r.caveats && r.caveats.length) {
    L.push('五、限制說明');
    for (const c of r.caveats) L.push(`  · ${c}`);
  }

  return L.join('\n');
}

module.exports = {
  buildViewpoints,
  buildReport,
  reportToText,
  pickEvidenceSentence,
  splitSentences,
  polarity,
  CONCEPT_VIEWS,
  DEFAULT_VIEW,
};
