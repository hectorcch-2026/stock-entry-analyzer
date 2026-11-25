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
  const cfg = loadConfig();
  const text = buildMessage(payload);

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

module.exports = { send, isConfigured, buildMessage, loadConfig };
