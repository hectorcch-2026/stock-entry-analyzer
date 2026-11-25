'use strict';

/**
 * 通知訊息 HTML 轉義回歸測試（純函式，不需啟動服務或連網）
 *
 * 背景：Telegram 以 parse_mode='HTML' 發送。公司名若含 & 或 <
 * （AT&T、H&M、SK Hynix <holdings>），未轉義會被當成標籤，
 * 導致 400 can't parse entities —— 整則通知發不出去，且錯誤訊息
 * 完全看不出原因是公司名。
 *
 * 執行：node tests/notify-escape.cjs
 */

const { buildMessage } = require('../lib/telegram');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

// 用「去除合法標籤後不應殘留任何 < 或 >」來驗證轉義是否完整
function hasRawAngle(text) {
  const stripped = text.replace(/<\/?(b|i|a)(\s[^>]*)?>/g, '');
  return /[<>]/.test(stripped);
}
function hasRawAmp(text) {
  // 移除所有合法實體後，不應再有裸 &
  return /&(?!(amp|lt|gt|quot);)/.test(text);
}

console.log('\n通知訊息 HTML 轉義\n');

// 1. 公司名含 & 與角括號
{
  const m = buildMessage({ name: 'AT&T Inc.', symbol: 'T', price: 28.5, changePercent: -0.8, currency: 'USD' });
  ok('公司名 & 被轉義', m.includes('AT&amp;T'));
  ok('無裸 & 殘留', !hasRawAmp(m), m);
  ok('無裸角括號殘留', !hasRawAngle(m), m);
}

// 2. 名稱含看起來像標籤的片段（原始 bug 觸發點）
{
  const m = buildMessage({ name: 'A & B <Co>', symbol: 'AAPL', price: 100, changePercent: 1, currency: 'USD' });
  ok('尖括號被轉義為實體', m.includes('&lt;Co&gt;'));
  ok('無裸角括號殘留', !hasRawAngle(m), m);
}

// 3. 新聞連結含查詢參數（& 必須在 href 內轉義，否則網址被截斷）
{
  const m = buildMessage({
    name: 'Test', symbol: 'X', price: 1, changePercent: 0, currency: 'USD',
    news: [{ title: 'A & B', link: 'https://e.com/p?a=1&b=2' }],
  });
  ok('href 內 & 被轉義', m.includes('a=1&amp;b=2'));
  ok('新聞標題被轉義', m.includes('A &amp; B'));
}

// 4. href 含雙引號不得破壞屬性
{
  const m = buildMessage({
    name: 'Test', symbol: 'X', price: 1, changePercent: 0, currency: 'USD',
    news: [{ title: 't', link: 'https://e.com/?q="x"' }],
  });
  ok('href 雙引號被轉義', m.includes('&quot;'));
  ok('a 標籤結構完整', /<a href="[^"]*">[^<]*<\/a>/.test(m), m);
}

// 5. 不重複轉義：&amp; 不應變成 &amp;amp;
{
  const m = buildMessage({ name: 'A&B', symbol: 'X', price: 1, changePercent: 0, currency: 'USD' });
  ok('無重複轉義 &amp;amp;', !m.includes('&amp;amp;'));
}

// 6. 訊號文字含角括號
{
  const m = buildMessage({
    name: 'X', symbol: 'X', price: 1, changePercent: 0, currency: 'USD',
    signals: { verdictLabel: '偏空<觀望>', score: 40, probUp20: 0.4 },
  });
  ok('verdictLabel 被轉義', m.includes('偏空&lt;觀望&gt;'));
  ok('無裸角括號殘留', !hasRawAngle(m), m);
}

// 7. 缺 name 時以 symbol 代入，且不產生 undefined
{
  const m = buildMessage({ symbol: 'AAPL', price: 1, changePercent: 0 });
  ok('缺 name 不顯示 undefined', !/undefined/.test(m), m);
  ok('symbol 有被顯示', m.includes('AAPL'));
}

// 8. 缺價格顯示破折號而非 NaN
{
  const m = buildMessage({ symbol: 'X', name: 'X', changePercent: 0 });
  ok('缺價格顯示 — 而非 NaN', m.includes('—') && !/NaN/.test(m), m);
}

console.log('\n' + '─'.repeat(50));
console.log(`轉義驗證： ${pass} / ${pass + fail} 通過`);
if (fail) { console.log(`\n${fail} 項未通過\n`); process.exit(1); }
console.log('全部通過。\n');
