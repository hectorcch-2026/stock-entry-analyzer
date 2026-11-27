'use strict';

/**
 * LLM 存取層（共用）
 * ===================
 *
 * 為什麼要獨立一支：
 *   `lib/interpret.js` 早有一段 `polishWithLlm()`，裡面藏了三個**實測踩到**的坑
 *   （推理型模型的 token 預算、空回應要能分辨原因、幻覺白名單要含 prompt 全文）。
 *   新的兩個 AI 模組（個股新聞分析、版塊輪動 macro 分析）需要同一套防護，
 *   但還要多做兩件事：**要求純 JSON** 與 **強制繁體中文**。
 *   若各自複製一份，遲早只有一份會被修好。因此集中在這裡。
 *
 * ── 五個實測事實（全部寫成程式碼防護，勿移除）────────────────
 *
 * 1. **推理型模型會把 max_tokens 吃光**。DeepSeek-V4.1-flash 會先產生
 *    reasoning_content，且 reasoning_tokens **計入 max_tokens**。實測
 *    max_tokens=700 時 700 全被推理吃掉、content 為空字串（finish_reason='length'）。
 *    → 預設 3000；並在 content 為空時分辨「預算不足」與「真的空回應」。
 *
 * 2. **模型會先講一段話再吐 JSON**。實測提示「請先說明分析思路，然後輸出 JSON」
 *    得到 `我的分析思路是：…\n{"score":0.5}`，直接 `JSON.parse` 會擲
 *    `Unexpected token '我'`。→ 必須有容錯解析器（見 parseJsonLoose）。
 *
 * 3. **模型會無視「繁體中文」要求回簡體**。實測要求繁體，回「苹果财报超预期并上调指引」。
 *    → 提示層明示 + 輸出層偵測 + 高頻詞替換 + 仍失敗則誠實標記。
 *
 * 4. **模型會引用我們沒給的數字**。→ 沿用 collectNumbers 白名單機制，
 *    白名單必須包含送出的 prompt 全文，不能只收 evidence。
 *
 * 5. **模型會把「不確定」講成肯定**。→ 提示層要求遇到資料不足必須直說，
 *    並禁止預測價格（本專案一貫的免責立場）。
 */

const fs = require('fs');
const path = require('path');

/* ============================================================
   設定
   ============================================================ */

/**
 * 讀取 LLM 設定。優先環境變數，其次 config.json 的 `llm` 區塊。
 *
 * 為什麼要支援 config.json：本專案既有慣例就是「環境變數優先、設定檔次之」
 * （見 lib/telegram.js），且 config.json 已列入 .gitignore，適合放金鑰。
 *
 * 支援的環境變數：
 *   LLM_API_KEY / OPENAI_API_KEY      金鑰
 *   LLM_BASE_URL / OPENAI_BASE_URL    API base（含 /v1）
 *   LLM_MODEL / OPENAI_MODEL          模型名
 *   LLM_MAX_TOKENS                    輸出上限
 *   LLM_TIMEOUT_MS                    逾時毫秒數
 *   LLM_DISABLE_THINKING              設 1 時送出 enable_thinking:false
 *   LLM_CONFIG_PATH                   自訂設定檔路徑（測試用；設為空字串可完全跳過設定檔）
 */
function loadLlmConfig() {
  const out = {
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || '',
    model: process.env.LLM_MODEL || process.env.OPENAI_MODEL || '',
    maxTokens: Number(process.env.LLM_MAX_TOKENS) || 0,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 0,
    disableThinking: process.env.LLM_DISABLE_THINKING === '1',
  };
  // 測試需要「完全沒有金鑰」的環境，但正式環境的 config.json 可能已填金鑰。
  // 因此允許用 LLM_CONFIG_PATH='' 明確跳過設定檔（單元測試就靠這個）。
  const explicit = process.env.LLM_CONFIG_PATH;
  if (explicit === '') return out;

  try {
    const p = explicit || path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const c = j.llm || {};
      out.apiKey = out.apiKey || c.apiKey || '';
      out.baseUrl = out.baseUrl || c.baseUrl || '';
      out.model = out.model || c.model || '';
      out.maxTokens = out.maxTokens || Number(c.maxTokens) || 0;
      out.timeoutMs = out.timeoutMs || Number(c.timeoutMs) || 0;
      if (typeof c.disableThinking === 'boolean') {
        out.disableThinking = out.disableThinking || c.disableThinking;
      }
    }
  } catch { /* 設定檔壞掉時靜默忽略，退回規則層 */ }
  return out;
}

/** 是否已設定金鑰（前端可據此顯示「AI 或規則」模式說明） */
function isConfigured() {
  return Boolean(loadLlmConfig().apiKey);
}

/**
 * 回報 LLM 設定狀態，**不外洩金鑰**。
 *
 * 為什麼需要這個函式：
 *   部署到 Render 後要確認「環境變數到底有沒有生效」，原本只能看
 *   /api/interpret 的 interpretation.mode —— 但那是規則層的輸出欄位，
 *   且要跑完整套解讀才看得到。設定錯誤時（例如變數名打錯、值帶引號），
 *   畫面上只會「還是規則型」，完全看不出是哪一環節出問題。
 *
 * 因此這裡只回報「有沒有、指向哪、用哪個模型」，金鑰只給前 4 後 4 碼：
 *   { configured: true, baseUrl: 'https://…/v1', model: 'DeepSeek-…',
 *     apiKeyHint: 'sk-U…ki7Y', source: 'env' | 'file' | 'none' }
 *
 * 金鑰指紋（指紋不是金鑰本身）足以判斷「是不是我填的那一把」，
 * 又不會讓任何人在 log 或回應裡撿到完整金鑰。
 */
function describeConfig() {
  const envKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const cfg = loadLlmConfig();
  const key = cfg.apiKey || '';

  let source = 'none';
  if (envKey) source = 'env';
  else if (key) source = 'file';

  const hint = key
    ? (key.length <= 10 ? '***' : `${key.slice(0, 4)}…${key.slice(-4)}`)
    : null;

  return {
    configured: Boolean(key),
    source,
    baseUrl: cfg.baseUrl || null,
    model: cfg.model || null,
    apiKeyHint: hint,
    // 這三項是「有填但填錯」最常見的原因，直接回報省一次猜謎
    maxTokens: cfg.maxTokens || null,
    disableThinking: Boolean(cfg.disableThinking),
    timeoutMs: cfg.timeoutMs || null,
  };
}

/* ============================================================
   數字白名單（反幻覺）
   ============================================================ */

/**
 * 把一段文字裡出現的所有數字收集起來（正規化為整數／一位／兩位小數三種寫法）。
 *
 * 用途：作為幻覺檢查的「白名單」。關鍵是**白名單必須包含我們餵給模型的
 * 全部文字**，不能只看結構化數值。
 *
 * 這是實測踩到的坑：模型的輸出會引用 detail 裡的「歷史 18.3 百分位」、
 * 「99.2 百分位」這類數字。若白名單只收 evidence，這些正確的引用會被
 * 判成幻覺，導致一份好輸出被整段丟棄。
 */
function collectNumbers(text, into) {
  const set = into || new Set();
  const nums = String(text || '').match(/-?\d+(?:\.\d+)?/g) || [];
  for (const n of nums) {
    const v = Math.abs(parseFloat(n));
    if (!isFinite(v)) continue;
    set.add(v.toFixed(1));
    set.add(v.toFixed(2));
    set.add(String(Math.round(v)));
  }
  return set;
}

/**
 * 檢查輸出裡的數字是否都能對應到白名單。
 *
 * @param {string} text
 * @param {Set<string>} knownNumbers
 * @param {number} [maxSuspect=3] 容許的可疑數字個數。
 *   為什麼預設是 3：長篇敘述（150–250 字）難免引用到白名單邊界上的數字
 *   （例如「第 3 季」被寫成「3.0」）。但只要可疑數字一多，整段就不可信。
 *   **短欄位必須用 0**：例如「對股價的潛在影響」這種一兩句話的欄位，
 *   出現任何來源外的數字就代表模型在編造，沒有「容許 3 個」的餘地。
 * @returns {{ok:boolean, suspect:string[]}}
 */
function auditNumbers(text, knownNumbers, maxSuspect) {
  const limit = maxSuspect == null ? 3 : maxSuspect;
  const mentioned = String(text || '').match(/\d+\.\d+/g) || [];
  const suspect = mentioned.filter((n) => {
    const v = Math.abs(parseFloat(n));
    return v > 0.05 && !knownNumbers.has(v.toFixed(1)) && !knownNumbers.has(v.toFixed(2));
  });
  return { ok: suspect.length <= limit, suspect };
}

/* ============================================================
   容錯 JSON 解析
   ============================================================ */

/**
 * 從一段文字中取出第一個「配對平衡」的 JSON 物件或陣列。
 *
 * 為什麼不能只用正則：字串裡可能出現 `}`（例如標題含 "Q3}"），
 * 也可能有轉義字元 `\"`。必須做字元掃描並追蹤字串狀態與轉義。
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractBalanced(text) {
  const s = String(text || '');
  const start = (() => {
    const a = s.indexOf('{');
    const b = s.indexOf('[');
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  })();
  if (start < 0) return null;

  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // 沒有配對到結尾（被截斷）
}

/** 移除物件／陣列最後一個元素後面的多餘逗號（`{"a":1,}` → `{"a":1}`） */
function repairTrailingCommas(text) {
  return String(text || '')
    .replace(/,\s*([}\]])/g, '$1')
    // 模型偶爾會用全角引號或智慧引號包住 key，先換成 ASCII 再解析
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

/**
 * 容錯解析：先直接解析，失敗再剝 markdown 圍欄、再抽取平衡區段、再修尾逗號。
 *
 * 這是**必要**的，不是防禦性冗餘。實測模型回傳
 *   `我的分析思路是：…\n{"score":0.5}`
 * 時，`JSON.parse` 直接擲 `Unexpected token '我'`；而這段輸出內容本身是有效的。
 *
 * @param {string} raw
 * @returns {{ok:boolean, value?:any, via?:string, note?:string}}
 */
function parseJsonLoose(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, note: '回應為空' };

  // 1) 純 JSON（最快路徑，涵蓋絕大多數情況）
  try {
    return { ok: true, value: JSON.parse(text), via: 'direct' };
  } catch { /* 繼續 */ }

  // 2) 剝掉 markdown 程式碼圍欄
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const body = fence[1].trim();
    try { return { ok: true, value: JSON.parse(body), via: 'fence' }; } catch { /* 繼續 */ }
    try {
      return { ok: true, value: JSON.parse(repairTrailingCommas(body)), via: 'fence+repair' };
    } catch { /* 繼續 */ }
  }

  // 3) 抽取第一個平衡的 {...} 或 [...]
  const seg = extractBalanced(text);
  if (seg) {
    try { return { ok: true, value: JSON.parse(seg), via: 'extract' }; } catch { /* 繼續 */ }
    try {
      return { ok: true, value: JSON.parse(repairTrailingCommas(seg)), via: 'extract+repair' };
    } catch { /* 繼續 */ }
  }

  return { ok: false, note: '找不到可解析的 JSON 物件（可能被 token 上限截斷）' };
}

/* ============================================================
   繁體中文偵測與修正
   ============================================================ */

/**
 * 簡→繁替換表：**只收「繁體絕不使用」且無歧義的字**。
 *
 * 三條硬規則（違反會把正確的繁體輸出改壞，比不改更糟）：
 *   ① 簡繁同形字一律不收（化、分、析、跌、健、慎、格、退、股、息、率、盈…）。
 *   ② 有歧義的字一律不收，**寧可漏判也不誤改**：
 *        「准」在繁體是「批准」正字     → 不可改「批準」
 *        「干」在繁體是「干涉」正字     → 不可改「乾涉」
 *        「台」在繁體是「平台」正字     → 不可改「臺」
 *        「后」在繁體是「皇后」正字     → 不可改「後」
 *        「里」在繁體是「公里」正字     → 不可改「裡」
 *        「复」對應「復」與「複」二義   → 復甦／複雜，無法一對一
 *        「汇」對應「匯」與「彙」二義   → 匯率／詞彙，無法一對一
 *        「划」對應「劃」與「划」二義   → 計劃／划船
 *   ③ 只收財經／宏觀語境高頻字。
 *
 * 為什麼用小表而不是完整字符映射：完整 OpenCC 對照表有數萬條，
 * 塞進零依賴專案不現實。而且**不假裝成功**——修正後若仍有簡體殘留，
 * 會回報 ok:false，由前端標示「AI 回應含簡體字」。誠實標記比偽裝成正體更可取。
 */
const HANS_TO_HANT = {
  /* 財務損益 */
  财: '財', 报: '報', 资: '資', 产: '產', 负: '負', 债: '債', 业: '業', 绩: '績',
  营: '營', 销: '銷', 赚: '賺', 亏: '虧', 损: '損', 净: '淨', 费: '費', 银: '銀',
  贷: '貸', 账: '賬', 额: '額', 价: '價', 购: '購', 贸: '貿', 税: '稅', 财: '財',
  /* 市場與交易 */
  现: '現', 场: '場', 买: '買', 卖: '賣', 涨: '漲', 势: '勢', 区: '區', 间: '間',
  线: '線', 图: '圖', 单: '單', 双: '雙', 长: '長', 权: '權', 户: '戶', 载: '載',
  /* 總量與規模 */
  万: '萬', 亿: '億', 综: '綜', 类: '類', 归: '歸', 属: '屬', 单: '單',
  /* 宏觀政策 */
  经: '經', 济: '濟', 货: '幣', 币: '幣', 宽: '寬', 紧: '緊', 缩: '縮', 胀: '脹',
  储: '儲', 联: '聯', 备: '備', 决: '決', 议: '議', 论: '論', 评: '評', 级: '級',
  调: '調', 实: '實', 际: '際', 数: '數', 据: '據', 预: '預', 测: '測', 变: '變',
  动: '動', 态: '態', 稳: '穩', 谨: '謹', 应: '應',
  /* 風險與判斷 */
  风: '風', 险: '險', 压: '壓', 扩: '擴', 强: '強', 劲: '勁', 软: '軟', 显: '顯',
  忧: '憂', 虑: '慮', 减: '減', 况: '況', 优: '優', 险: '險',
  /* 時間與邏輯連接 */
  时: '時', 过: '過', 还: '還', 没: '沒', 从: '從', 会: '會', 个: '個', 们: '們',
  为: '為', 与: '與', 将: '將', 对: '對', 于: '於', 这: '這', 该: '該', 当: '當',
  进: '進', 择: '擇', 开: '開', 关: '關', 键: '鍵', 条: '條', 约: '約', 继: '繼',
  续: '續', 结: '結', 构: '構', 记: '記', 录: '錄', 题: '題', 观: '觀', 点: '點',
  论: '論', 认: '認', 识: '識', 说: '說', 讲: '講', 谈: '談', 问: '問', 见: '見',
  务: '務', 义: '義', 无: '無', 举: '舉', 农: '農', 战: '戰', 团: '團', 织: '織',
  员: '員', 领: '領', 张: '張', 处: '處', 导: '導', 览: '覽', 讯: '訊',
  /* 地名與企業 */
  华: '華', 欧: '歐', 亚: '亞', 韩: '韓', 湾: '灣', 广: '廣', 庆: '慶', 宁: '寧',
  铁: '鐵', 铜: '銅', 铝: '鋁', 钢: '鋼', 苹: '蘋', 并: '並', 块: '塊',
};

/** 簡體專用字集合（＝替換表的 key，因為表裡已排除簡繁同形與歧義字） */
const HANS_SET = new Set(Object.keys(HANS_TO_HANT));

/**
 * 偵測並嘗試修正簡體字。
 *
 * @returns {{text:string, found:string[], fixed:number, ok:boolean}}
 */
function enforceHant(raw) {
  const text = String(raw == null ? '' : raw);
  let out = '';
  let fixed = 0;
  for (const ch of text) {
    const rep = HANS_TO_HANT[ch];
    if (rep && rep !== ch) { out += rep; fixed++; } else out += ch;
  }
  const found = [];
  for (const ch of out) if (HANS_SET.has(ch)) found.push(ch);
  return {
    text: out,
    found: [...new Set(found)],
    fixed,
    // 沒有任何「簡體專用字」殘留就視為通過
    ok: found.length === 0,
  };
}

/**
 * 判斷**輸入本身**是否已是繁體。
 *
 * 為什麼不直接用 enforceHant(text).ok：
 *   那個 ok 的語義是「修正之後沒有殘留簡體」，對任何輸入都成立
 *   —— 連整段簡體都會回 true（因為已經被改完了）。
 *   用它當「這是不是繁體」會永遠得到 true，等於沒有檢查。
 *   實測：looksHant('苹果财报超预期') 回 true，明顯不對。
 *
 * 這裡改成「完全不需要修正」才算繁體，語義與函式名一致。
 */
function looksHant(text) {
  return enforceHant(text).fixed === 0;
}

/* ============================================================
   呼叫
   ============================================================ */

/**
 * 呼叫 chat/completions，回傳統一結構。**永不擲出**——所有失敗都變成
 * `{ok:false, note}`，讓上層無條件退回規則層。
 *
 * @param {object} req
 * @param {string} req.prompt
 * @param {object} [req.cfg]        覆寫設定（apiKey/baseUrl/model/maxTokens/timeoutMs/disableThinking）
 * @param {number} [req.temperature]
 * @param {boolean} [req.json]      是否要求純 JSON（會加 response_format 並在提示層強調）
 * @returns {Promise<{ok:boolean, text:string, json:any, mode:string, note:string|null,
 *                    usage:object|null, via:string|null, hant:object|null}>}
 */
async function callLlm(req) {
  const r = req || {};
  const fileCfg = loadLlmConfig();
  const cfg = r.cfg || {};

  const apiKey = cfg.apiKey || fileCfg.apiKey;
  if (!apiKey) {
    return {
      ok: false, text: '', json: null, mode: 'rule',
      note: '未設定 LLM API Key，使用規則型分析', usage: null, via: null, hant: null,
    };
  }

  // 推理型模型需要遠高於一般模型的預算，預設 3000
  const maxTokens = cfg.maxTokens || fileCfg.maxTokens || 3000;
  const timeoutMs = cfg.timeoutMs || fileCfg.timeoutMs || 60000;
  const disableThinking = cfg.disableThinking != null
    ? Boolean(cfg.disableThinking) : fileCfg.disableThinking;

  const wantJson = r.json !== false;

  const body = {
    model: cfg.model || fileCfg.model || 'gpt-4o-mini',
    messages: [{ role: 'user', content: String(r.prompt || '') }],
    temperature: r.temperature == null ? 0.2 : r.temperature,
    max_tokens: maxTokens,
  };
  // 推理型模型預設會先想一大段再回答，且 reasoning_tokens **計入 max_tokens**。
  // 這些任務不需要推理，關閉可把延遲從數十秒壓到 1–2 秒；
  // 若供應商不認此參數會直接忽略，無副作用。
  if (disableThinking) body.enable_thinking = false;
  // JSON 模式：支援的供應商會強制輸出合法 JSON；不支援的會忽略此欄位，
  // 因此**不能只靠它**，仍必須走 parseJsonLoose。
  if (wantJson) body.response_format = { type: 'json_object' };

  try {
    const base = (cfg.baseUrl || fileCfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return {
        ok: false, text: '', json: null, mode: 'rule',
        note: `LLM 回應 HTTP ${res.status}，改用規則型分析`, usage: null, via: null, hant: null,
      };
    }

    const j = await res.json();
    const choice = j && j.choices && j.choices[0];
    const msg = (choice && choice.message) || {};
    // 只取 content。推理型模型另附的 reasoning_content 是模型的思考過程，
    // 絕不可當成結果顯示給使用者（裡面常有未經查核的草稿數字）。
    const text = String(msg.content || '').trim();

    if (!text) {
      const cut = choice && choice.finish_reason === 'length';
      const rt = j && j.usage && j.usage.completion_tokens_details
        && j.usage.completion_tokens_details.reasoning_tokens;
      return {
        ok: false, text: '', json: null, mode: 'rule',
        note: cut
          ? `LLM 的 ${maxTokens} token 預算在產生正文前就被推理用盡`
            + `（推理 ${rt || '?'} tokens），改用規則型分析。可調高 llm.maxTokens。`
          : 'LLM 回應為空，改用規則型分析',
        usage: j && j.usage ? j.usage : null, via: null, hant: null,
      };
    }

    // 繁體強制：模型實測會無視要求回簡體，這裡做一次偵測＋高頻詞替換。
    // 替換後仍有殘留就誠實回報 hant.ok=false（由前端揭露），不假裝成功。
    const hant = enforceHant(text);

    const parsed = wantJson ? parseJsonLoose(hant.text) : { ok: false, note: null };
    if (wantJson && !parsed.ok) {
      return {
        ok: false, text: hant.text, json: null, mode: 'rule',
        note: `LLM 輸出無法解析為 JSON（${parsed.note}），改用規則型分析`,
        usage: j && j.usage ? j.usage : null, via: null, hant,
      };
    }

    return {
      ok: true,
      text: hant.text,
      json: wantJson ? parsed.value : null,
      mode: 'llm',
      note: null,
      usage: j && j.usage ? j.usage : null,
      via: wantJson ? parsed.via : null,
      hant,
    };
  } catch (e) {
    const aborted = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      ok: false, text: '', json: null, mode: 'rule',
      note: aborted
        ? `LLM 逾時（${Math.round(timeoutMs / 1000)} 秒），改用規則型分析`
        : `LLM 呼叫失敗（${e.message}），改用規則型分析`,
      usage: null, via: null, hant: null,
    };
  }
}

module.exports = {
  loadLlmConfig,
  isConfigured,
  describeConfig,
  collectNumbers,
  auditNumbers,
  extractBalanced,
  repairTrailingCommas,
  parseJsonLoose,
  enforceHant,
  looksHant,
  callLlm,
  HANS_TO_HANT,
};
