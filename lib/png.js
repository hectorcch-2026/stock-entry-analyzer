'use strict';

/**
 * 零依賴 PNG 編碼器
 * ==================
 *
 * 為什麼要自己寫，而不是裝 sharp / canvas：
 *   本專案維持「執行時零依賴」（package.json 的 dependencies 是空的）。
 *   這不是潔癖，是維運現實：Render 每次部署都要 npm install，
 *   依賴越多建置越慢；而 sharp 帶原生二進位檔，在不同平台／Node 版本
 *   上裝不起來的機率明顯高於純 JS。為了「每天一張圖」而引入這種風險
 *   並不划算。
 *
 *   需要的東西其實很少：PNG 就是「簽名 + 幾個 chunk + zlib 壓縮的像素」，
 *   而 zlib 是 Node 內建的。整個編碼器不到 100 行。
 *
 * PNG 的最小結構（我們只用到必要的三個 chunk）：
 *   IHDR  尺寸與色彩格式（8-bit RGB，無透明）
 *   IDAT  zlib 壓縮後的掃描線資料（每行前面要一個 filter byte）
 *   IEND  結束標記
 *
 * 為什麼色彩格式用 RGB 而不是調色盤／RGBA：
 *   我們只需要「畫實心矩形」，不需要透明，也不在乎體積多幾 KB。
 *   格式越簡單，寫錯的機會越少。
 */

const zlib = require('zlib');

/** CRC32 查表（PNG 每個 chunk 都要帶） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 把 RGB 像素緩衝編成 PNG。
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgb 長度必須是 width * height * 3，順序為 R,G,B 逐像素
 * @returns {Buffer} PNG 檔內容
 */
function encodePNG(width, height, rgb) {
  const expected = width * height * 3;
  if (rgb.length !== expected) {
    throw new Error(`像素緩衝長度不符：預期 ${expected}，實際 ${rgb.length}`);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type 2 = truecolor RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // 每一條掃描線前面要有一個 filter byte（0 = none）。
  // 少了這個 byte，解碼器會把整張圖的像素往後推一格，畫面會斜掉——
  // 這種錯不會拋例外，只會讓圖看起來「有點怪」，很難除錯。
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0;
    rgb.copy(raw, dst + 1, src, src + stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ==========================================================
   極簡點陣繪圖（只做我們需要的：矩形、線、像素）
   ========================================================== */

/**
 * 建立一張 RGB 畫布。
 *
 * 座標系：左上角為 (0,0)，x 向右、y 向下（與 PNG 一致）。
 * 所有繪圖都做邊界裁剪——畫超出範圍的線不該讓程式爆掉，
 * 因為 K 線的價格軸偶爾會因為極端值算到框外。
 */
function createCanvas(width, height, bg) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const buf = Buffer.alloc(w * h * 3);
  const base = bg || { r: 255, g: 255, b: 255 };

  for (let i = 0; i < w * h; i += 1) {
    buf[i * 3] = base.r;
    buf[i * 3 + 1] = base.g;
    buf[i * 3 + 2] = base.b;
  }

  function pixel(x, y, c) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    const i = (yi * w + xi) * 3;
    buf[i] = c.r;
    buf[i + 1] = c.g;
    buf[i + 2] = c.b;
  }

  function rect(x, y, rw, rh, c) {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = x0 + Math.round(rw);
    const y1 = y0 + Math.round(rh);
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) pixel(xx, yy, c);
    }
  }

  /** 水平線／垂直線（列印用的細虛線也靠這個組出來） */
  function hline(x0, x1, y, c, thickness) {
    const t = Math.max(1, thickness || 1);
    rect(Math.min(x0, x1), y, Math.abs(x1 - x0) + 1, t, c);
  }
  function vline(x, y0, y1, c, thickness) {
    const t = Math.max(1, thickness || 1);
    rect(x, Math.min(y0, y1), t, Math.abs(y1 - y0) + 1, c);
  }

  /** 虛線：drawing dashed reference lines (buy zone / stop / target) */
  function dashedH(x0, x1, y, c, dash, gap, thickness) {
    const d = dash || 6;
    const gp = gap || 4;
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += d + gp) {
      const end = Math.min(x + d - 1, Math.max(x0, x1));
      hline(x, end, y, c, thickness);
    }
  }

  /**
   * 垂直虛線（標示事件發生的時間點）。
   * 與 dashedH 對稱：同樣的 dash/gap 語意，只是方向不同。
   * 事件標記必須用虛線——實線會被誤讀成「這裡是一條價位」，
   * 而它其實是「這裡是一個時間點」。
   */
  function dashedV(x, y0, y1, c, dash, gap, thickness) {
    const d = dash || 6;
    const gp = gap || 4;
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += d + gp) {
      const end = Math.min(y + d - 1, Math.max(y0, y1));
      vline(x, y, end, c, thickness);
    }
  }

  return {
    width: w,
    height: h,
    raw: buf,
    pixel,
    rect,
    hline,
    vline,
    dashedH,
    dashedV,
  };
}

module.exports = {
  encodePNG,
  createCanvas,
  crc32,
};
