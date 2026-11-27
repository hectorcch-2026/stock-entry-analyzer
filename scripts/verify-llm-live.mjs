'use strict';

/**
 * 線上 LLM 設定驗證
 * ================
 *
 * 用途：在 Render（或其他部署環境）設定完 LLM_* 環境變數後，
 * 確認「金鑰真的生效且真的能呼叫」，而不是只看有沒有值。
 *
 * 為什麼不能只看 /api/health 的 configured: true：
 *   configured 只代表「讀到字串」。金鑰打錯、baseUrl 少了 /v1、
 *   模型名不存在、供應商擋了雲端 IP —— 這四種情況 configured 都是 true，
 *   但實際呼叫會失敗。因此本腳本會真的呼叫並要求回傳 mode === 'llm'。
 *
 * 為什麼要驗三個端點、而不是只驗 /api/interpret：
 *   站上有三個地方各自獨立呼叫模型，各自有自己的降級路徑。
 *   只驗一個的話，另外兩個壞掉時本腳本仍會全綠 —— 那比沒有腳本更危險。
 *
 * ⚠️ 三個端點判斷「模型是否生效」的欄位位置**各不相同**，
 *    這是最容易讀錯而誤報失敗的地方（我在此處連續誤判過兩次）：
 *
 *    端點                          模式欄位            模型名欄位
 *    /api/interpret               `llm.mode`          `llm.model`
 *    /api/stock-news-ai           `ai.mode`           `provenance.aiModel`
 *    /api/sector-macro-ai         `ai.mode`           `provenance.aiModel`
 *
 *    且 `/api/interpret` 的 `interpretation.mode` **恆為 'rule'**（規則層永遠存在），
 *    讀它必定看到 rule。另外 `ai.model` 不存在，模型名只在 `provenance.aiModel`。
 *
 * 用法：
 *   node scripts/verify-llm-live.mjs                        # 預設打 Render，驗 3 個端點
 *   node scripts/verify-llm-live.mjs http://127.0.0.1:5177  # 打本機
 *   node scripts/verify-llm-live.mjs --quick                # 只驗健康檢查＋/api/interpret
 */

const ARGS = process.argv.slice(2);
/** 快速模式：略過兩個較慢的端點（各約 10–20 秒，且會消耗 token） */
const QUICK = ARGS.includes('--quick');
const BASE = (ARGS.find((a) => !a.startsWith('--'))
  || 'https://stock-entry-analyzer.onrender.com').replace(/\/+$/, '');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function getJson(path, timeoutMs) {
  const res = await fetch(BASE + path, {
    signal: AbortSignal.timeout(timeoutMs || 60000),
    headers: { Accept: 'application/json' },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 時保留 text */ }
  return { status: res.status, json, text };
}

(async () => {
  console.log(`\n驗證目標：${BASE}\n`);

  console.log('[1] 健康檢查：LLM 設定是否被讀到');
  let h;
  try {
    h = await getJson('/api/health', 30000);
  } catch (e) {
    console.log(`  ✗ 無法連線：${e.message}`);
    process.exit(1);
  }
  ok('服務回應 200', h.status === 200, `HTTP ${h.status}`);

  const info = (h.json && h.json.llm) || null;
  if (!info) {
    ok('/api/health 有 llm 欄位', false, '舊版服務可能還沒部署新程式');
    console.log('\n（若服務是舊版，請先確認最新 commit 已部署）');
    process.exit(1);
  }

  console.log(`      configured = ${info.configured}`);
  console.log(`      source     = ${info.source}`);
  console.log(`      baseUrl    = ${info.baseUrl}`);
  console.log(`      model      = ${info.model}`);
  console.log(`      key hint   = ${info.apiKeyHint}`);
  console.log(`      maxTokens  = ${info.maxTokens}`);
  console.log(`      noThink    = ${info.disableThinking}`);

  ok('已讀到 LLM 金鑰', info.configured === true,
    '未設定 LLM_API_KEY（或 OPENAI_API_KEY）');
  ok('金鑰來源是環境變數', info.source === 'env',
    `來源為 ${info.source}；Render 上應為 env（config.json 不會被部署）`);
  ok('baseUrl 有值且指向 /v1', Boolean(info.baseUrl) && /\/v1\/?$/.test(info.baseUrl),
    `baseUrl=${info.baseUrl}（DeepSeek 相容端點通常需以 /v1 結尾）`);
  ok('model 有值', Boolean(info.model), `model=${info.model}`);
  ok('已關閉推理（避免正文被 reasoning 吃掉）', info.disableThinking === true,
    '建議設 LLM_DISABLE_THINKING=1');
  ok('金鑰未外洩（只回傳指紋）', Boolean(info.apiKeyHint) && info.apiKeyHint.includes('…'),
    `hint=${info.apiKeyHint}`);

  if (!info.configured) {
    console.log('\n設定步驟見 DEPLOY.md「啟用 LLM 解讀」一節。');
    console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
    process.exit(1);
  }

  console.log('\n[2] 實際呼叫：確認金鑰能真的產生 LLM 輸出');
  // 用 macro 解讀（不依賴任何股票代碼，最穩定）。
  //
  // ⚠️ 必須帶 mode=llm：/api/interpret 預設是 mode=rule，只在明確要求時
  //    才呼叫模型（避免使用者只是開頁面就燒 API 額度）。少了這個參數
  //    會永遠看到 mode=rule，而那不是「金鑰失效」——是最常見的誤判來源。
  let r;
  try {
    r = await getJson('/api/interpret?scope=macro&mode=llm', 150000);
  } catch (e) {
    ok('解讀端點可呼叫', false, e.message);
    console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
    process.exit(1);
  }

  ok('解讀端點回應 200', r.status === 200, `HTTP ${r.status}`);

  const interp = r.json && r.json.interpretation;
  const llmBlock = r.json && r.json.llm;

  // mode 在 llm 區塊上，不在 interpretation 上。
  //   interpretation   = 規則層結果（永遠都有，mode 固定 'rule'）
  //   llm              = 模型潤飾結果（有呼叫才有；mode 可能是 'llm' 或退回 'rule'）
  // 一開始我誤讀 interpretation.mode，於是「模型明明成功了」也判成失敗。
  const mode = llmBlock && llmBlock.mode;

  ok('回傳結構完整', Boolean(interp), Object.keys(r.json || {}).join(','));
  ok('有嘗試呼叫模型（llm 區塊存在）', Boolean(llmBlock),
    'llm 為 null 代表根本沒進入 LLM 分支（檢查 mode=llm 參數）');

  if (mode === 'llm') {
    ok('模型實際產生輸出（mode=llm）', true);
    console.log(`      llm.model = ${llmBlock.model || '(未回報)'}`);
    console.log(`      llm.via   = ${llmBlock.via || '(未回報)'}`);
    const snippet = String(llmBlock.text || '').replace(/\s+/g, ' ').trim();
    if (snippet) console.log(`      輸出前 120 字：${snippet.slice(0, 120)}`);
    ok('輸出非空', snippet.length > 0, '有 mode=llm 但沒有內文，通常是 max_tokens 被 reasoning 吃光');
    ok('輸出為繁體中文', /[\u4e00-\u9fa5]/.test(snippet),
      '沒有中文字，可能模型回英文或回空字串');
  } else {
    ok('模型實際產生輸出（mode=llm）', false,
      `目前 mode=${mode}，仍是規則層。可能原因：金鑰無效、baseUrl 錯誤、模型名不存在、或供應商擋雲端 IP`);
    if (llmBlock && llmBlock.note) console.log(`      伺服器註記：${llmBlock.note}`);
  }

  /* ============================================================
     [3][4] 另外兩個吃 LLM 的端點
     ============================================================
     這兩支各自有獨立的降級路徑：任何失敗都回 200 + 規則層結果，
     所以「HTTP 200 且內容看起來像樣」完全不代表模型跑過。
     唯一可靠的判準是它們回報的 mode 欄位。

     這兩支比 /api/interpret 慢（新聞要先抓正文、兩個 LLM 呼叫並行，
     實測約 12 秒；版塊輪動需先算 RRG 矩陣，約 10 秒），
     且都會消耗 token，因此 --quick 可略過。
     刻意**不**用 refresh=1：走伺服器既有快取，避免重複燒額度。
     ============================================================ */
  if (QUICK) {
    console.log('\n[3][4] 已略過（--quick）：未驗 /api/stock-news-ai 與 /api/sector-macro-ai');
    console.log('      正式上線前請至少完整跑一次，這兩支的模型路徑與 /api/interpret 互相獨立。');
  } else {
    /**
     * 共通檢查。三個端點的欄位路徑不同，由呼叫端指定，避免再讀錯。
     * @param {string} label   顯示用名稱
     * @param {string} path    請求路徑
     * @param {string} modeKey 模式欄位（如 'ai.mode'）
     * @param {string} modelKey 模型名欄位（如 'provenance.aiModel'）
     * @returns {Promise<object|null>} 回應 JSON（連線失敗時為 null），
     *   供呼叫端做端點專屬的額外檢查，避免為了多驗一項而重打一次。
     */
    async function checkAiEndpoint(label, path, modeKey, modelKey) {
      console.log(`\n${label}`);
      let res;
      try {
        res = await getJson(path, 180000);
      } catch (e) {
        ok('端點可呼叫', false, e.message);
        return null;
      }
      ok('回應 200', res.status === 200, `HTTP ${res.status}`);

      const j = res.json || {};
      const dig = (p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), j);
      const aiMode = dig(modeKey);
      const aiModel = dig(modelKey);
      const degraded = dig('provenance.degraded');
      const hantOk = dig('provenance.hantOk');

      console.log(`      ${modeKey}  = ${aiMode}`);
      console.log(`      ${modelKey} = ${aiModel}`);

      ok('模型實際產生輸出（mode=llm）', aiMode === 'llm',
        `目前 ${modeKey}=${aiMode}；此端點失敗時會靜默退回規則層並回 200，`
        + `因此不能只看 HTTP 狀態`);
      ok('有回報模型名', Boolean(aiModel),
        `${modelKey}=${aiModel}；為 null 代表走的是規則層或舊版服務`);
      /* 繁中檢查只在模型路徑下有意義：
         伺服器計算是 hantOk = (ai.mode === 'llm') ? looksHant(...) : true，
         規則層恆為 true。若無條件斷言，降級時這一項會「假通過」，
         反而讓人以為內容沒問題。因此 mode 不對就標成略過、不計分。 */
      if (aiMode === 'llm') {
        ok('輸出為繁體中文', hantOk !== false,
          `hantOk=${hantOk}；模型可能回了簡中／英文，前端會顯示簡體字`);
      } else {
        console.log('      - 繁中檢查略過（未走模型，規則層恆為 true，斷言無意義）');
      }
      ok('無降級警告', !Array.isArray(degraded) || degraded.length === 0,
        `degraded=${JSON.stringify(degraded)}`);
      return j;
    }

    const newsJson = await checkAiEndpoint(
      '[3] 個股新聞 AI 分析（AAPL）—— 驗 ai.mode 與 provenance.aiModel',
      '/api/stock-news-ai?symbol=AAPL&mode=llm',
      'ai.mode', 'provenance.aiModel',
    );

    /* 新聞端點除了摘要，還有兩個獨立的 LLM 消費者（看好／看跌分類、
       關鍵字→觀點→匯報）。三者的 mode 欄位各自獨立，必須分別看：
       ai.mode 成功不代表 sides.mode 成功 —— 兩者是並行的兩次呼叫。 */
    if (newsJson) {
      const ai = newsJson.ai || {};
      ok('新聞摘要非空', Boolean(ai.summary && String(ai.summary).trim()),
        `summary 長度 ${String(ai.summary || '').length}`);
      ok('看好／看跌也走了模型（sides.mode）', (newsJson.sides || {}).mode === 'llm',
        `sides.mode=${(newsJson.sides || {}).mode}；ai.mode 成功不代表這一支成功，兩次呼叫彼此獨立`);
      ok('看好／看跌皆有內容',
        Number((newsJson.sides || {}).bullCount) > 0 && Number((newsJson.sides || {}).bearCount) > 0,
        `bull=${(newsJson.sides || {}).bullCount} bear=${(newsJson.sides || {}).bearCount}`);
      ok('結構化匯報已產出', Boolean((newsJson.report || {}).text),
        'report.text 為空 → 前端「匯報」分頁會是空白');
    }

    const sectorJson = await checkAiEndpoint(
      '[4] 版塊輪動 × 宏觀關聯（週線）—— 驗 ai.mode 與 provenance.aiModel',
      '/api/sector-macro-ai?mode=llm',
      'ai.mode', 'provenance.aiModel',
    );

    /* 這支的模型輸出是「改寫宏觀關聯」。
       曾出現 mode=llm 但 rotationNarrative 為空 → 前端顯示空白區塊，
       因此除了 mode 還要驗實際內文。 */
    if (sectorJson) {
      const nar = (sectorJson.ai || {}).rotationNarrative;
      ok('版塊輪動敘述非空', Boolean(nar && String(nar).trim()),
        'mode=llm 但 rotationNarrative 為空，前端會顯示空白區塊');
    }
  }

  console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
  process.exit(fail === 0 ? 0 : 1);
})();
