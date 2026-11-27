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
 *   但實際呼叫會失敗。因此本腳本會真的打一次 /api/interpret 並要求
 *   回傳 mode === 'llm'。
 *
 * 用法：
 *   node scripts/verify-llm-live.mjs                        # 預設打 Render
 *   node scripts/verify-llm-live.mjs http://127.0.0.1:5177  # 打本機
 */

const BASE = (process.argv[2] || 'https://stock-entry-analyzer.onrender.com').replace(/\/+$/, '');

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

  console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
  process.exit(fail === 0 ? 0 : 1);
})();
