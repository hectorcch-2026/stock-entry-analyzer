'use strict';

/**
 * Telegram 通知模組
 *
 * 設定方式（環境變數 / config.json）：
 *   TELEGRAM_BOT_TOKEN   - BotFather 取得的 token
 *   TELEGRAM_CHAT_ID     - 接收訊息的 chat id
 *
 * 未設定時，模組進入「模擬模式」：不實際發送，僅回傳將發送的內容，
 * 讓前端仍可完整驗證通知流程。
 */

const fs = require('fs');
const path = require('path');

function loadConfig() {
  const cfg = {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  };
  try {
    const p = path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const t = j.telegram || {};
      cfg.token = cfg.token || t.botToken || '';
      cfg.chatId = cfg.chatId || t.chatId || '';
    }
  } catch { /* 忽略設定檔錯誤 */ }
  return cfg;
}

function isConfigured() {
  const c = loadConfig();
  return Boolean(c.token && c.chatId);
}

/** 產生價格異動 + 新聞的通知文本 */
function buildMessage({ symbol, name, price, changePercent, currency, signals, news }) {
  const arrow = changePercent >= 0 ? '🔴' : '🟢'; // 紅漲綠跌（華人習慣）
  const f = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
  const lines = [];

  // 注意：parse_mode 為 HTML，所有動態文字都必須轉義。
  // 公司名常含 & 或 <（AT&T、H&M、SK Hynix <holdings>…），
  // 未轉義會被 Telegram 當成標籤而整則訊息發送失敗（400 can't parse entities）。
  const safeName = escapeHtml(name || symbol || '');
  const safeSymbol = escapeHtml(symbol || '');
  const safeCur = escapeHtml(currency || '');

  lines.push(`${arrow} <b>${safeName}</b>（${safeSymbol}）`);
  lines.push(`現價：<b>${f(price)} ${safeCur}</b>　${changePercent >= 0 ? '+' : ''}${f(changePercent)}%`);

  if (signals) {
    if (signals.buyZone) lines.push(`建議買入區間：${f(signals.buyZone.lower)} ~ ${f(signals.buyZone.upper)}`);
    if (signals.verdictLabel) lines.push(`技術面評分：${f(signals.score, 1)}/100（${escapeHtml(signals.verdictLabel)}）`);
    if (signals.probUp20 != null) lines.push(`20 日上漲機率：${(signals.probUp20 * 100).toFixed(1)}%`);
  }

  if (Array.isArray(news) && news.length) {
    lines.push('');
    lines.push('📰 相關新聞：');
    for (const n of news.slice(0, 3)) {
      // href 內的 & 也需轉義，否則部分網址會被截斷
      const href = escapeHtml(n.link || '');
      const title = escapeHtml(n.title || '');
      lines.push(href ? `• <a href="${href}">${title}</a>` : `• ${title}`);
    }
  }

  lines.push('');
  lines.push(`<i>更新時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Hong_Kong' })}</i>`);
  return lines.join('\n');
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')   // 必須最先，否則後面產生的 & 會被重複轉義
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 發送通知
 * @returns {Promise<{ok:boolean, mode:string, message:string, error?:string}>}
 */
async function send(payload) {
  return sendText(buildMessage(payload));
}

/**
 * 直接發送一段已組好的 HTML 文本。
 *
 * 為什麼要把「組訊息」與「送出」拆開：
 *   `send()` 只能發「單一個股」那種固定版型。每日推介摘要需要
 *   自己排版（多檔股票、區間、累計損益），硬塞進 buildMessage
 *   會讓那邊長出一堆 if，而單股通知也會跟著變複雜。
 *
 *   拆開之後，逾時、錯誤分類、模擬模式這些**容易寫錯一次**的部分
 *   仍然只有一份，新功能不必重寫一遍網路邏輯。
 *
 * @param {string} text 已轉義的 Telegram HTML
 */
async function sendText(text) {
  const cfg = loadConfig();

  if (!cfg.token || !cfg.chatId) {
    return {
      ok: true,
      mode: 'simulated',
      message: text,
      hint: '尚未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，訊息僅在本地模擬產生，未實際發送。',
    };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      // 沒有逾時的話，在封鎖 Telegram 的網路環境會一直掛著直到連線層放棄
      signal: AbortSignal.timeout(12000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      return {
        ok: false, mode: 'telegram', message: text,
        error: j.description || `HTTP ${res.status}`,
        // parse 失敗時，把原文一併回傳，前端可改以純文字重送或複製
        hint: /parse entities/i.test(j.description || '')
          ? '訊息含 Telegram HTML 無法解析的字元；已對文字做轉義，若仍失敗請回報。'
          : undefined,
      };
    }
    return { ok: true, mode: 'telegram', message: text };
  } catch (e) {
    // 常見於雲端沙箱／公司內網封鎖 api.telegram.org —— 這不是憑證問題，
    // 而是出站連線被擋。明確說出來，否則使用者只看到「fetch failed」。
    const blocked = /fetch failed|timeout|aborted|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|UND_ERR/i.test(
      `${e.message} ${e.cause?.code || ''} ${e.name || ''}`
    );
    return {
      ok: false,
      mode: 'telegram',
      message: text,
      error: e.message,
      hint: blocked
        ? '此執行環境無法連線到 api.telegram.org（出站網路被限制）。通知功能需在可直連 Telegram 的主機上執行；重點訊息已顯示在上方，可直接複製。'
        : undefined,
    };
  }
}

/**
 * 發送一張圖片（配合說明文字）。
 *
 * 用 multipart/form-data 直接上傳 PNG，而不是先上傳取得 file_id：
 *   · 我們每天只發少量圖，重複利用率低，換取「不必管理 file_id 快取」的簡單；
 *   · 圖片只有幾 KB，上傳成本可忽略。
 *
 * caption 同樣走 HTML，所以**必須**與文字訊息用同一套轉義。
 * 這裡不自己轉義，而是要求呼叫端傳已轉義的字串——
 * 理由與 sendText 相同：轉義只該有一份實作。
 *
 * @param {Buffer} pngBuffer PNG 內容
 * @param {string} [caption] 已轉義的圖說（上限 1024 字元，Telegram 限制）
 * @returns {Promise<{ok:boolean, mode:string, error?:string, skipped?:boolean}>}
 */
async function sendPhoto(pngBuffer, caption) {
  const cfg = loadConfig();

  if (!cfg.token || !cfg.chatId) {
    return {
      ok: true,
      mode: 'simulated',
      skipped: true,
      hint: '尚未設定 Telegram，圖片僅在本地產生，未實際發送。',
    };
  }

  if (!Buffer.isBuffer(pngBuffer) || !pngBuffer.length) {
    return { ok: false, mode: 'telegram', error: '圖片內容為空' };
  }

  // Telegram 的 caption 上限是 1024（不是 4096）。
  // 超過會整則失敗，所以這裡先截斷——圖說不像損益數字那麼關鍵，
  // 截斷比整張圖送不出去好。
  let cap = String(caption || '');
  if (cap.length > 1024) cap = `${cap.slice(0, 1010)}…（略）`;

  try {
    const form = new FormData();
    form.append('chat_id', cfg.chatId);
    if (cap) {
      form.append('caption', cap);
      form.append('parse_mode', 'HTML');
    }
    // 檔名固定：Telegram 會用它判斷是圖片
    form.append('photo', new Blob([pngBuffer], { type: 'image/png' }), 'chart.png');

    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      return {
        ok: false,
        mode: 'telegram',
        error: j.description || `HTTP ${res.status}`,
      };
    }
    return { ok: true, mode: 'telegram' };
  } catch (e) {
    const blocked = /fetch failed|timeout|aborted|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|UND_ERR/i.test(
      `${e.message} ${e.cause?.code || ''} ${e.name || ''}`
    );
    return {
      ok: false,
      mode: 'telegram',
      error: e.message,
      hint: blocked ? '此執行環境無法連線到 api.telegram.org（出站網路被限制）。' : undefined,
    };
  }
}

module.exports = { send, sendText, sendPhoto, isConfigured, buildMessage, loadConfig, escapeHtml };
