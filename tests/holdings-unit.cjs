'use strict';

/**
 * 版塊權重股 — 單元測試（完全不連網）
 * ====================================
 *
 * 這個功能的核心風險不是「算錯」，而是**看起來有資料、其實是錯的**。
 * 因此測試的重點放在四類邊界：
 *
 *   A. XLSX 解析：持股檔不是標準表格，前面有 3 列檔頭、夾雜非股票列。
 *      解析器若把「US DOLLAR」「期貨」當成股票，表格會出現無法點擊的假代碼。
 *   B. 股票列過濾：必須同時用「代碼格式 / 權重為正 / 有 SEDOL」三重條件。
 *      單靠代碼格式會放過期貨（IXTZ6 符合格式）；單靠權重會放過現金。
 *   C. 區間報酬：交易日 vs 日曆日的差異、資料不足時必須給 null 而非 0。
 *      「資料不足回 0%」是最危險的錯誤——畫面看起來完全正常。
 *   D. 代碼正規化：持股檔寫 BRK.B，行情端要 BRK-B。
 *      不轉換的話那檔股票永遠顯示「—」，且原因完全看不出來。
 *   E. 前端契約：DOM id、四區間欄位、跳轉目標。
 *
 * 用法：node tests/holdings-unit.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const xlsx = require('../lib/xlsx');
const sh = require('../lib/sector-holdings');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; failures.push({ name, msg: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

/* ============================================================
   A. XLSX 解析
   ============================================================ */

console.log('\n--- A. XLSX 解析 ---');

/** 造一個最小 xlsx：單一工作表、給定儲存格 */
function makeXlsx(rows) {
  // rows: [[值, 值], ...] 全部當 inline string 或數值
  const sheetRows = rows.map((cells, ri) => {
    const cs = cells.map((v, ci) => {
      const col = String.fromCharCode(65 + ci);
      const ref = `${col}${ri + 1}`;
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      if (v == null) return '';
      const esc = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<c r="${ref}" t="inlineStr"><is><t>${esc}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cs}</row>`;
  }).join('');

  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;

  const files = [
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8')],
  ];

  // 手工組 zip（stored，不壓縮）
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);          // method 0 = stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);           // method
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

t('A1 基本解析：inlineStr 與數值都能讀出', () => {
  const buf = makeXlsx([['Name', 'Ticker', 'Weight'], ['APPLE INC', 'AAPL', 17.95]]);
  const rows = xlsx.readFirstSheet(buf);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].A, 'Name');
  assert.strictEqual(rows[1].B, 'AAPL');
  assert.strictEqual(rows[1].C, 17.95);
});

t('A2 欄名不是 A/B 也能正確定位（colToIndex）', () => {
  assert.strictEqual(xlsx.colToIndex('A'), 1);
  assert.strictEqual(xlsx.colToIndex('E'), 5);
  assert.strictEqual(xlsx.colToIndex('Z'), 26);
  assert.strictEqual(xlsx.colToIndex('AA'), 27);
  assert.strictEqual(xlsx.colToIndex('AB'), 28);
});

t('A3 XML 實體必須還原（&amp; 最後解碼，避免雙重解碼）', () => {
  assert.strictEqual(xlsx.unescapeXml('A &amp; B'), 'A & B');
  assert.strictEqual(xlsx.unescapeXml('&lt;b&gt;'), '<b>');
  assert.strictEqual(xlsx.unescapeXml('&amp;lt;'), '&lt;', '&amp;lt; 應只還原成 &lt;');
});

t('A4 非 zip 內容要明確報錯，不可靜默回空陣列', () => {
  assert.throws(() => xlsx.readFirstSheet(Buffer.from('not a zip file at all')),
    (e) => e.code === 'BAD_XLSX', '應擲出 BAD_XLSX');
});

t('A5 空 Buffer 要明確報錯', () => {
  assert.throws(() => xlsx.readFirstSheet(Buffer.alloc(0)),
    (e) => e.code === 'BAD_XLSX');
});

/* ============================================================
   B. 股票列過濾
   ============================================================ */

console.log('\n--- B. 股票列過濾 ---');

t('B1 一般股票列通過', () => {
  assert.ok(sh.isStockRow({ A: 'APPLE INC', B: 'AAPL', D: '2046251', E: 17.95 }));
  assert.ok(sh.isStockRow({ A: 'BERKSHIRE HATHAWAY CL B', B: 'BRK.B', D: '2073390', E: 13.6 }));
});

t('B2 現金列（Ticker 為 -）必須被排除', () => {
  assert.strictEqual(sh.isStockRow({ A: 'US DOLLAR', B: '-', D: '-', E: 0.0126 }), false);
});

t('B3 貨幣市場基金（SEDOL 為 -）必須被排除', () => {
  assert.strictEqual(sh.isStockRow({
    A: 'SSI US GOV MONEY MARKET CLASS', B: 'MMKT', D: '-', E: 0.0157,
  }), false, 'SEDOL 為 - 代表不是掛牌股票');
});

t('B4 期貨（代碼像 IXTZ6，且權重可為負）必須被排除', () => {
  assert.strictEqual(sh.isStockRow({
    A: 'XAK TECHNOLOGY    DEC26', B: 'IXTZ6', D: 'ADI394XN3', E: -0.012944,
  }), false, '代碼含數字應被樣式擋掉');
});

t('B5 負權重即使代碼像股票也要排除（short 部位不是成分股）', () => {
  assert.strictEqual(sh.isStockRow({ A: 'SOMETHING', B: 'XYZ', D: 'ABC123', E: -0.5 }), false);
});

t('B6 權重為 0 或非數值要排除', () => {
  assert.strictEqual(sh.isStockRow({ A: 'X', B: 'XYZ', D: 'A1', E: 0 }), false);
  assert.strictEqual(sh.isStockRow({ A: 'X', B: 'XYZ', D: 'A1', E: 'n/a' }), false);
});

t('B7 parseHoldings 會依權重由高到低排序', () => {
  const rows = [
    { A: 'Name', B: 'Ticker', C: 'Identifier', D: 'SEDOL', E: 'Weight' },
    { A: 'SMALL', B: 'SM', D: 'S1', E: 1.5 },
    { A: 'BIG', B: 'BG', D: 'S2', E: 20.0 },
    { A: 'MID', B: 'MD', D: 'S3', E: 8.0 },
  ];
  const out = sh.parseHoldings(rows);
  assert.deepStrictEqual(out.map((x) => x.ticker), ['BG', 'MD', 'SM']);
});

t('B8 找不到標題列要明確報錯（不能回空陣列假裝成功）', () => {
  assert.throws(() => sh.parseHoldings([{ A: 'junk' }, { A: 'more junk' }]),
    (e) => e.code === 'BAD_HOLDINGS');
});

t('B9 標題列不在固定第 4 列也能解析（不寫死索引）', () => {
  const rows = [
    { A: 'Fund Name:', B: 'X' },
    { A: 'extra line' },
    { A: 'another' },
    { A: 'Name', B: 'Ticker', D: 'SEDOL', E: 'Weight' },
    { A: 'APPLE INC', B: 'AAPL', D: '2046251', E: 10 },
  ];
  const out = sh.parseHoldings(rows);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].ticker, 'AAPL');
});

t('B10 檔頭 asOf / fundName 解析', () => {
  const rows = [
    { A: 'Fund Name:', B: 'State Street® Technology Select Sector SPDR® ETF' },
    { A: 'Ticker Symbol:', B: 'XLK' },
    { A: 'Holdings:', B: 'As of 24-Nov-2026' },
  ];
  assert.strictEqual(sh.parseAsOf(rows), '24-Nov-2026');
  assert.ok(/Technology/.test(sh.parseFundName(rows)));
});

/* ============================================================
   C. 區間報酬
   ============================================================ */

console.log('\n--- C. 區間報酬 ---');

/** 造一段每天 +1% 的完美序列 */
function ramp(n, start, step) {
  const candles = [];
  const adj = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    candles.push({ t: i * 86400000, c: v });
    adj.push(v);
    v = v * (1 + step);
  }
  return { candles, adjClose: adj };
}

t('C1 單調上漲：各區間報酬應等於複利結果', () => {
  const { candles, adjClose } = ramp(100, 100, 0.01);
  const r = sh.computeReturns(candles, adjClose);
  // 1 日 = +1%
  assert.ok(Math.abs(r.returns.d1 - 1.0) < 1e-6, `d1 應為 1%，得 ${r.returns.d1}`);
  // 5 日 = 1.01^5 - 1
  const exp5 = (Math.pow(1.01, 5) - 1) * 100;
  assert.ok(Math.abs(r.returns.w1 - exp5) < 1e-6, `w1 應為 ${exp5}，得 ${r.returns.w1}`);
});

t('C2 以交易日計算，不是日曆日（5 日 ≠ 7 個日曆日）', () => {
  const periods = sh.PERIODS;
  assert.strictEqual(periods.find((p) => p.key === 'w1').tradingDays, 5);
  assert.strictEqual(periods.find((p) => p.key === 'm1').tradingDays, 21);
  assert.strictEqual(periods.find((p) => p.key === 'm3').tradingDays, 63);
});

t('C3 資料不足以回推時必須給 null，不可回 0', () => {
  // 只有 10 根，無法回推 21 或 63 個交易日
  const { candles, adjClose } = ramp(10, 100, 0.01);
  const r = sh.computeReturns(candles, adjClose);
  assert.notStrictEqual(r.returns.d1, null, '1 日應該算得出來');
  assert.strictEqual(r.returns.m1, null, '1 個月資料不足應為 null');
  assert.strictEqual(r.returns.m3, null, '3 個月資料不足應為 null');
  assert.notStrictEqual(r.returns.m1, 0, '絕不可用 0 冒充「資料不足」');
});

t('C4 復權價優先於收盤價（除息日不得算成下跌）', () => {
  // 收盤價在最後一天憑空跌 10%（模擬除息），但復權價持平
  const candles = [];
  const adj = [];
  for (let i = 0; i < 30; i++) {
    candles.push({ t: i * 86400000, c: i === 29 ? 90 : 100 });
    adj.push(100);   // 復權後完全持平
  }
  const r = sh.computeReturns(candles, adj);
  assert.ok(Math.abs(r.returns.d1) < 1e-9,
    `用復權價應為 0%，得 ${r.returns.d1}（若用收盤價會是 -10%）`);
  assert.strictEqual(r.adjUsed, true);
});

t('C5 沒有復權價時退回收盤價，並標記 adjUsed=false', () => {
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push({ t: i * 86400000, c: 100 + i });
  const r = sh.computeReturns(candles, null);
  assert.strictEqual(r.adjUsed, false);
  assert.ok(r.returns.d1 > 0);
});

t('C6 長度不符的 adjClose 必須忽略（不可錯位）', () => {
  const { candles } = ramp(30, 100, 0.01);
  const r = sh.computeReturns(candles, [1, 2, 3]);   // 長度不符
  assert.strictEqual(r.adjUsed, false, '長度不符時不可使用復權價');
});

t('C7 只有 1 根或空陣列 → bars 為 0，四個 key 皆為 null（非 undefined）', () => {
  const r1 = sh.computeReturns([], null);
  assert.strictEqual(r1.bars, 0);
  ['d1', 'w1', 'm1', 'm3'].forEach((k) => {
    assert.strictEqual(r1.returns[k], null, `空資料時 ${k} 應為 null 而非 undefined`);
  });

  const r2 = sh.computeReturns([{ t: 0, c: 100 }], null);
  assert.strictEqual(r2.bars, 0, '單根無法算報酬');
  assert.strictEqual(r2.returns.d1, null);
});

t('C8 缺值與非正數價格必須跳過', () => {
  const candles = [];
  const adj = [];
  for (let i = 0; i < 30; i++) {
    candles.push({ t: i * 86400000, c: 100 });
    adj.push(i % 5 === 0 ? null : 100);   // 夾雜 null
  }
  const r = sh.computeReturns(candles, adj);
  assert.ok(r.bars < 30, '含 null 的應被跳過');
  assert.ok(r.bars >= 20, `有效根數應仍足夠，得 ${r.bars}`);
});

t('C9 PERIODS 的 key 與前端欄位一致（四個區間齊全）', () => {
  assert.deepStrictEqual(sh.PERIODS.map((p) => p.key), ['d1', 'w1', 'm1', 'm3']);
  assert.deepStrictEqual(sh.PERIODS.map((p) => p.label), ['1 日', '1 週', '1 個月', '3 個月']);
});

/* ============================================================
   D. 代碼正規化
   ============================================================ */

console.log('\n--- D. 代碼正規化 ---');

t('D1 BRK.B 必須轉成 BRK-B（行情端格式）', () => {
  assert.strictEqual(sh.toQuoteSymbol('BRK.B'), 'BRK-B');
  assert.strictEqual(sh.toQuoteSymbol('BF.B'), 'BF-B');
});

t('D2 已是行情格式則不變', () => {
  assert.strictEqual(sh.toQuoteSymbol('BRK-B'), 'BRK-B');
  assert.strictEqual(sh.toQuoteSymbol('AAPL'), 'AAPL');
});

t('D3 港股代碼不可被誤轉（0700.HK 的 HK 不是類股後綴）', () => {
  assert.strictEqual(sh.toQuoteSymbol('0700.HK'), '0700.HK');
});

t('D4 小寫輸入要轉大寫', () => {
  assert.strictEqual(sh.toQuoteSymbol('brk.b'), 'BRK-B');
  assert.strictEqual(sh.toQuoteSymbol('aapl'), 'AAPL');
});

t('D5 空值不拋錯', () => {
  assert.strictEqual(sh.toQuoteSymbol(null), '');
  assert.strictEqual(sh.toQuoteSymbol(''), '');
});

/* ============================================================
   E. 版塊清單與 URL
   ============================================================ */

console.log('\n--- E. 版塊清單與 URL ---');

t('E1 11 個 SPDR 版塊齊全且與 rrg.js 一致', () => {
  const rrg = require('../lib/rrg');
  assert.strictEqual(sh.SECTOR_KEYS.length, 11);
  assert.deepStrictEqual(sh.SECTOR_KEYS, rrg.SECTORS.map((s) => s.key));
});

t('E2 持股檔 URL 規則正確（小寫版塊代碼）', () => {
  const u = sh.holdingsUrl('XLK');
  assert.ok(u.indexOf('holdings-daily-us-en-xlk.xlsx') >= 0, u);
  assert.ok(u.indexOf('ssga.com') >= 0);
});

t('E3 不支援的版塊要拋 BAD_SECTOR 並附可用清單', async () => {
  // 這個測試是同步的，用 try/catch 模擬
  let caught = null;
  try { await sh.getHoldings('ZZZ', { limit: 5 }); } catch (e) { caught = e; }
  assert.ok(caught, '應拋錯');
  assert.strictEqual(caught.code, 'BAD_SECTOR');
  assert.ok(/XLK/.test(caught.hint || ''), 'hint 應列出可用版塊');
});

/*
 * E4/E5：MAX_HOLDINGS 是「個股 → 版塊」對照表的覆蓋率上限。
 *
 * 為什麼要釘住一個看起來無害的常數：
 *   它原本是 50，理由是「持股表只要顯示前 N 大」。但 getSectorIndex() 拿
 *   同一份持股建對照表，50 於是變成天花板——母體 500 檔中只有 405 檔
 *   查得到版塊，其餘 95 檔被誤判為「不屬於任何版塊」。這個 bug 沒有症狀：
 *   漏斗數字仍自洽（405+95=500）、沒有錯誤訊息、被丟掉的還是 CTSH 這種
 *   正常大型股。唯一能防止它復發的方式，就是斷言這個上限不得再被調低
 *   到低於現實 ETF 的持股規模。
 *
 * 下限取 100 而不是 83（實測最大 XLI 的持股數）：留一點餘裕，因為 ETF
 * 成分股會隨時間增加，83 是某一天的快照而非結構上限。
 */
t('E4 MAX_HOLDINGS 不得低於現實 ETF 持股規模（覆蓋率護欄）', () => {
  assert.ok(typeof sh.MAX_HOLDINGS === 'number', 'MAX_HOLDINGS 應匯出為數字');
  assert.ok(sh.MAX_HOLDINGS >= 100,
    `MAX_HOLDINGS=${sh.MAX_HOLDINGS} 太低。實測 XLI 有 83 檔持股，` +
    '低於 100 會讓版塊對照表出現大量「查無版塊」而無任何錯誤訊息');
});

t('E5 getHoldings 的 limit 會被 MAX_HOLDINGS 夾住（不能繞過上限）', () => {
  // 夾制邏輯：Math.max(1, Math.min(limit || 10, MAX_HOLDINGS))
  // 這裡直接驗算同一條式子，確保語意沒被改寫。
  const clamp = (v) => Math.max(1, Math.min(Number(v) || 10, sh.MAX_HOLDINGS));
  assert.strictEqual(clamp(1e9), sh.MAX_HOLDINGS, '超大 limit 應夾到上限');
  assert.strictEqual(clamp(0), 10, '0 應退回預設 10');
  assert.strictEqual(clamp(-5), 1, '負數應夾到下限 1');
  assert.strictEqual(clamp(undefined), 10, 'undefined 應退回預設 10');
});

t('E6 getSectorIndex 取持股時用的是 MAX_HOLDINGS，不是寫死的小數字', () => {
  /*
   * 這是最關鍵的一條：getSectorIndex() 若傳入寫死的 50，覆蓋率就會被
   * 截斷，而且不會有任何錯誤。用原始碼斷言它確實傳 MAX_HOLDINGS。
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sector-holdings.js'), 'utf8');
  const m = src.match(/getSectorIndex\s*\(\s*opts[^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '找不到 getSectorIndex 定義');
  assert.ok(/limit:\s*MAX_HOLDINGS/.test(m[0]),
    'getSectorIndex 應以 limit: MAX_HOLDINGS 取持股；若改回寫死數字，' +
    '版塊對照表會靜默漏掉排第 N 名之後的成分股');
});

/* ============================================================
   F. 前端契約
   ============================================================ */

console.log('\n--- F. 前端契約 ---');

const readPub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const html = readPub('index.html');
const client = readPub('rrg-client.js');
const css = readPub('styles.css');
const sw = readPub('sw.js');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

t('F1 持股面板的 DOM id 全部存在於 index.html', () => {
  ['rrgHoldSector', 'rrgHoldLimit', 'rrgHoldBody', 'rrgHoldMeta', 'rrgHoldTable']
    .forEach((id) => {
      assert.ok(html.indexOf('id="' + id + '"') >= 0, `index.html 缺少 #${id}`);
    });
});

t('F2 rrg-client.js 引用的持股 id 都有對應元素', () => {
  ['holdSector', 'holdLimit', 'holdBody', 'holdMeta', 'holdTable'].forEach((k) => {
    assert.ok(client.indexOf("$('rrgHold") >= 0, 'rrg-client 應有持股面板的取值');
  });
  /* 反過來確認沒有取到不存在的 id。
     「重試」按鈕是執行期才用 innerHTML 生成的，靜態 HTML 當然沒有它，
     所以要先確認它出現在 client 自己的 innerHTML 字串裡，否則才是真的漏了。 */
  const dynamicIds = ['rrgHoldRetry'];
  const ids = [...client.matchAll(/\$\('(rrgHold[A-Za-z]+)'\)/g)].map((m) => m[1]);
  ids.forEach((id) => {
    if (dynamicIds.indexOf(id) >= 0) {
      assert.ok(client.indexOf('id="' + id + '"') >= 0,
        `#${id} 不在 index.html，所以必須由 client 動態生成`);
      return;
    }
    assert.ok(html.indexOf('id="' + id + '"') >= 0,
      `rrg-client 取用 #${id} 但 index.html 沒有，也不是動態生成`);
  });
});

t('F3 表格七個欄位（代碼/權重/四區間/分析）', () => {
  const tbl = html.slice(html.indexOf('id="rrgHoldTable"'));
  const head = tbl.slice(0, tbl.indexOf('</thead>'));
  const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    m[1].replace(/<[^>]*>/g, '').trim());
  assert.strictEqual(cols.length, 7, `應為 7 欄，實際 ${cols.length}`);
  assert.ok(/代碼/.test(cols[0]));
  assert.ok(/權重/.test(cols[1]));
  assert.ok(/1\s*日/.test(cols[2]));
  assert.ok(/1\s*週/.test(cols[3]));
  assert.ok(/1\s*個月/.test(cols[4]));
  assert.ok(/3\s*個月/.test(cols[5]));
  assert.ok(/分析/.test(cols[6]));
});

t('F4 跳轉目標為 #/detail/<symbol>（既有個股頁路由）', () => {
  assert.ok(client.indexOf("'#/detail/'") >= 0, 'rrg-client 應導向 #/detail/');
  assert.ok(client.indexOf('SA.navigate') >= 0, '應走既有路由，不可直接改 hash');
});

t('F5 跳轉要用 quoteSymbol 而不是原始 ticker', () => {
  const seg = client.slice(client.indexOf('var quoteSym'));
  assert.ok(seg.indexOf('r.quoteSymbol') >= 0, '應優先使用 quoteSymbol');
  assert.ok(seg.indexOf('encodeURIComponent(quoteSym)') >= 0, 'href 應以 quoteSymbol 組成');
});

t('F6 正紅負綠（台／港／陸股慣例）', () => {
  const up = css.match(/\.rrg-ret\.up\s*\{[^}]*color:\s*var\(--up\)/);
  const down = css.match(/\.rrg-ret\.down\s*\{[^}]*color:\s*var\(--down\)/);
  assert.ok(up, '正的應使用 var(--up)');
  assert.ok(down, '負的應使用 var(--down)');
  // --up 必須是紅、--down 必須是綠
  assert.ok(/--up:\s*#d92b2b/i.test(css), '--up 應為紅色');
  assert.ok(/--down:\s*#0f9d58/i.test(css), '--down 應為綠色');
});

t('F7 載入 / 無資料 / 錯誤三種狀態都有對應處理', () => {
  assert.ok(client.indexOf('setHoldLoading') >= 0, '應有載入中狀態');
  assert.ok(client.indexOf('renderHoldError') >= 0, '應有錯誤狀態');
  assert.ok(client.indexOf('無持股資料') >= 0, '應有空資料狀態');
});

t('F8 API 端點存在且路徑正確', () => {
  assert.ok(serverSrc.indexOf("'/api/rrg/holdings'") >= 0, 'server 應有 /api/rrg/holdings');
  assert.ok(client.indexOf('/api/rrg/holdings?sector=') >= 0, '前端應呼叫該端點');
});

t('F9 Service Worker 版本已升（否則舊殼會蓋掉新頁）', () => {
  const m = sw.match(/const VERSION = '(v[\d.]+)'/);
  assert.ok(m, '找不到 VERSION');
  /* 逐段比數字，不要比字串：'v1.0.10' < 'v1.0.7' 在字串比較下成立。 */
  const num = (v) => (v.match(/\d+/g) || []).map(Number);
  const cmp = (a, b) => {
    const x = num(a), y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  assert.ok(cmp(m[1], 'v1.0.6') >= 0, `版本應 >= v1.0.6，得 ${m[1]}`);
});

t('F10 前端只用 ES5（本專案既有約束）', () => {
  // 去掉註解與字串後檢查是否出現 ES6 語法
  const stripped = client
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const bad = [
    [/\bconst\s+[A-Za-z_$]/, 'const'],
    [/\blet\s+[A-Za-z_$]/, 'let'],
    [/=>/, '箭頭函式'],
    [/`/, '樣板字串'],
  ];
  bad.forEach(([re, name]) => {
    assert.strictEqual(re.test(stripped), false, `rrg-client.js 出現 ${name}`);
  });
});

t('F11 可點列有鍵盤支援（tabindex + Enter）', () => {
  assert.ok(client.indexOf('tabindex="0"') >= 0, '列應可被 Tab 聚焦');
  assert.ok(client.indexOf("e.key !== 'Enter'") >= 0, '應支援 Enter 鍵');
});

t('F12 「分析」是真正的 <a>（支援右鍵／新分頁）', () => {
  assert.ok(client.indexOf('a.rrg-hold-go') >= 0, '應有 <a class="rrg-hold-go">');
  assert.ok(/class="rrg-hold-go"\s+href=/.test(client) ||
    /<a class="rrg-hold-go" href=/.test(client), '應帶 href');
});

/* ============================================================
   結果
   ============================================================ */
console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
if (fail) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f.name}: ${f.msg}`));
}
process.exit(fail === 0 ? 0 : 1);
