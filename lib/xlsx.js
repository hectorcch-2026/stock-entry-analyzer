'use strict';

/**
 * 極簡 XLSX 讀取器（零依賴）
 * =========================
 *
 * 為什麼要自己寫：
 *   本專案刻意維持 dependencies: {}（見 package.json 與 README 的零依賴約定），
 *   而 SheetJS 之類的套件會帶進數十 MB 與多個間接依賴。
 *   我們只需要「讀一張工作表的前幾十列」，不需要公式、樣式、合併儲存格。
 *
 * 只支援 subset（但涵蓋官方持股檔的全部實際用法）：
 *   - .xlsx（OOXML zip）：zlib.inflateRawSync 解壓，無需外部 zip 函式庫
 *   - 儲存格型別：shared string（t="s"）、inline string（t="inlineStr"）、數值
 *   - 只讀 xl/worksheets/sheet1.xml
 *
 * 不支援（明確不做，避免誤用）：
 *   - .xls（BIFF 舊格式，完全不同結構）
 *   - 公式（<f>）：我們只要快取值 <v>，不重算
 *   - 日期序號轉換：呼叫端自己判斷欄位語意
 */

const zlib = require('zlib');

/* ---------------- ZIP ---------------- */

/**
 * 讀取 zip 中央目錄，回傳 { 檔名: Buffer }。
 *
 * 從 EOCD（End Of Central Directory）往回找，而不是從檔頭往前掃：
 * xlsx 是「先放檔案資料、最後放中央目錄」，且可能夾帶不支援的壓縮法，
 * 只有中央目錄能可靠列出所有項目。
 */
function readZip(buf) {
  // EOCD 簽章 0x06054b50，最小 22 bytes，註解最多 65535 bytes
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) {
    const e = new Error('不是有效的 xlsx（找不到 ZIP 結尾標記）');
    e.code = 'BAD_XLSX';
    throw e;
  }

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = {};

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // 中央目錄項目簽章
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');

    // 實際資料位置要看「local header」自己的檔名/額外欄長度，不能沿用中央目錄的
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + csize);
      try {
        // method 0 = stored（未壓縮）、8 = deflate
        out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
      } catch {
        /* 單一項目解壓失敗不應中斷整份檔案 */
      }
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/* ---------------- XML ---------------- */

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&'); // 必須最後做，否則 &amp;lt; 會被二次解碼
}

/** 取出 <si> 內所有 <t> 的文字（處理 rich text 被拆成多段 <r><t> 的情況） */
function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''))
  );
}

/** 欄名 A→1、B→2、AA→27 */
function colToIndex(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}

/**
 * 解析工作表為「列的陣列」，每列是 { 欄名: 值 } 的物件。
 *
 * 回傳原始物件而不是二維陣列，因為持股檔的欄位順序並不固定
 * （SSGA 曾在不同版本間調換 Weight 與 Sector 的位置），
 * 用欄名取值比用索引穩健。
 */
function parseSheet(xml, sharedStrings) {
  if (!xml) return [];
  const rows = [];

  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = {};
    for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const inner = cm[2];
      const refM = attrs.match(/r="([A-Z]+)\d+"/);
      if (!refM) continue;
      const col = refM[1];
      const type = (attrs.match(/t="(\w+)"/) || [])[1];
      const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
      let val = vM ? vM[1] : null;

      if (type === 's') {
        const idx = Number(val);
        val = Number.isInteger(idx) && sharedStrings[idx] != null ? sharedStrings[idx] : null;
      } else if (type === 'inlineStr') {
        const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        val = t ? unescapeXml(t[1]) : null;
      } else if (type === 'str') {
        val = val == null ? null : unescapeXml(val);
      } else if (type === 'e') {
        val = null; // 錯誤值（#N/A 等）視為缺值
      } else if (val != null) {
        const n = Number(val);
        // 布林（t="b"）在此不特別處理：持股檔不會用到
        if (type !== 'b' && isFinite(n)) val = n;
      }

      if (val !== null && val !== '') row[col] = val;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

/* ---------------- 對外 ---------------- */

/**
 * 讀取 xlsx 的第一張工作表。
 *
 * @param {Buffer} buf 檔案內容
 * @returns {Array<Object>} 每列為 { A: 值, B: 值, ... }
 */
function readFirstSheet(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) {
    const e = new Error('xlsx 內容為空');
    e.code = 'BAD_XLSX';
    throw e;
  }
  const zip = readZip(buf);
  const sheetName = Object.keys(zip)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) {
    const e = new Error('xlsx 內找不到工作表');
    e.code = 'BAD_XLSX';
    throw e;
  }
  const shared = parseSharedStrings(zip['xl/sharedStrings.xml']?.toString('utf8'));
  return parseSheet(zip[sheetName].toString('utf8'), shared);
}

module.exports = { readFirstSheet, readZip, parseSheet, colToIndex, unescapeXml };
