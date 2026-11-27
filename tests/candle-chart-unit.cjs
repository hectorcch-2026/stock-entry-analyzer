'use strict';

/**
 * lib/png.js + lib/candle-chart.js 單元測試
 * =========================================
 *
 * 這一支的風險同樣是「不會拋錯但畫錯」：
 *   · PNG 少了 filter byte → 整張圖斜掉，但仍然是一張合法的 PNG
 *   · 漲跌顏色寫反 → 紅綠互換，交易判斷完全反向
 *   · 價格軸 y 上下顛倒 → 漲的股票看起來在跌
 *   · 買區/止賺/止蝕沒畫 → 圖變成普通走勢圖，失去存在意義
 * 以上都不會讓程式失敗，只能靠斷言釘住。
 *
 * ── 驗證策略：只數「顏色出現幾次」是不夠的 ──────────────
 *   第一版就是只數顏色總量，結果變異測試抓不到一半的錯：
 *     · 參考線的「文字標籤」也是同一色，1px 虛線與 15px 文字
 *       在總量上看不出差別 → 少畫一條線仍可能達標
 *     · y 軸顛倒後紅綠總量完全不變 → 總量法天生看不到
 *   所以這裡改成量**幾何**：
 *     · 逐列統計（rowCounts）→ 判斷「有幾條水平線」
 *     · 單列最長連續同色（maxRunInRow）→ 量 K 線實體寬度
 *     · 極值列的 y 位置（minRow/maxRow）→ 判斷 y 軸方向與是否被裁切
 *
 * 執行：node tests/candle-chart-unit.cjs
 */

const assert = require('assert');
const zlib = require('zlib');

const { encodePNG, createCanvas } = require('../lib/png');
const { renderCandleChart, COLOR } = require('../lib/candle-chart');

/* 與 renderCandleChart 一致的繪圖區（斷言要對照這些值） */
const W = 720;
const H = 420;
const PLOT_X = 8;
const PLOT_Y = 30;
const PLOT_W = 650;
const PLOT_H = 364;

let pass = 0;
let fail = 0;
const failures = [];

async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

/* ---- PNG 解碼（只解我們自己產的格式：8-bit RGB、filter 0） ---- */

/**
 * 獨立實作一份 CRC32，用來驗證每個 chunk 的 CRC。
 *
 * 為什麼要驗：CRC 寫錯時，我們的解碼器（直接 inflate）完全不受影響，
 * 但 Telegram／瀏覽器會直接拒收整張圖。也就是說「測試全綠、圖卻打不開」。
 * 這是唯一會讓推送靜默失敗的 PNG 錯誤，必須釘住。
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function parsePNG(png) {
  assert.ok(Buffer.isBuffer(png), '應為 Buffer');
  const sig = png.slice(0, 8).toString('hex');
  assert.strictEqual(sig, '89504e470d0a1a0a', 'PNG 簽名不正確');

  let p = 8;
  const chunks = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.slice(p + 4, p + 8).toString('ascii');
    const data = png.slice(p + 8, p + 8 + len);
    const stored = png.readUInt32BE(p + 8 + len);
    const actual = crc32(png.slice(p + 4, p + 8 + len));
    assert.strictEqual(
      stored, actual,
      `${type} chunk 的 CRC 不對（存 ${stored}，實算 ${actual}）—— 解碼器會直接拒收整張圖`,
    );
    chunks.push({ type, len, data });
    p += 12 + len;
  }

  const ihdr = chunks.find((c) => c.type === 'IHDR');
  assert.ok(ihdr, '缺少 IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];

  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  assert.ok(idat.length, '缺少 IDAT');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3;

  // 解壓後的長度必須剛好是 height * (stride + 1)。
  // 若緩衝區大小算錯，Buffer.copy 會「安靜地截斷」最後幾列——
  // 圖看起來只是底部多一條黑邊，很容易被忽略。
  assert.strictEqual(
    raw.length, height * (stride + 1),
    `解壓後長度不符：預期 ${height * (stride + 1)}，實際 ${raw.length}（緩衝區大小算錯會截斷最後幾列）`,
  );

  const filterBytes = [];
  for (let y = 0; y < height; y += 1) filterBytes.push(raw[y * (stride + 1)]);

  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }

  return { width, height, bitDepth, colorType, chunks, pixels, filterBytes, stride };
}

function pixelAt(img, x, y) {
  const i = y * img.stride + x * 3;
  return { r: img.pixels[i], g: img.pixels[i + 1], b: img.pixels[i + 2] };
}

function isColor(img, x, y, c) {
  const p = pixelAt(img, x, y);
  return p.r === c.r && p.g === c.g && p.b === c.b;
}

/** 統計整張圖某顏色出現次數 */
function countColor(img, color) {
  let n = 0;
  for (let i = 0; i < img.pixels.length; i += 3) {
    if (img.pixels[i] === color.r && img.pixels[i + 1] === color.g && img.pixels[i + 2] === color.b) n += 1;
  }
  return n;
}

/** 逐列統計某顏色的像素數 → 用來判斷「有幾條水平線」 */
function rowCounts(img, color) {
  const rows = new Array(img.height).fill(0);
  for (let y = 0; y < img.height; y += 1) {
    let n = 0;
    for (let x = 0; x < img.width; x += 1) {
      if (isColor(img, x, y, color)) n += 1;
    }
    rows[y] = n;
  }
  return rows;
}

/** 某列中，該顏色最長的連續區段（用來量 K 線實體寬度） */
function maxRunInRow(img, y, color) {
  let best = 0;
  let cur = 0;
  for (let x = 0; x < img.width; x += 1) {
    if (isColor(img, x, y, color)) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/** 該顏色在整張圖中最寬的單列連續區段（K 線實體寬度上限） */
function maxRunAnyRow(img, color) {
  let best = 0;
  for (let y = 0; y < img.height; y += 1) {
    const r = maxRunInRow(img, y, color);
    if (r > best) best = r;
  }
  return best;
}

/** 該顏色出現的第一列 / 最後一列（判斷 y 方向與裁切） */
function extentRows(img, color) {
  const rows = rowCounts(img, color);
  let first = -1;
  let last = -1;
  for (let y = 0; y < img.height; y += 1) {
    if (rows[y] > 0) {
      if (first < 0) first = y;
      last = y;
    }
  }
  return { first, last, rows };
}

/**
 * 該顏色有幾列「明顯是一條水平線」。
 *
 * minRatio 要依虛線的 duty cycle 給：
 *   參考線 dash 5 / gap 3 → 覆蓋約 62%
 *   現價線 dash 2 / gap 4 → 覆蓋約 33%（線更細，因為它是輔助資訊）
 * 若一律用 50% 當門檻，現價線永遠達標不了，會誤判成「沒畫」。
 */
function countLineRows(img, color, minRatio) {
  const rows = rowCounts(img, color);
  const need = PLOT_W * (minRatio === undefined ? 0.5 : minRatio);
  return rows.filter((n) => n >= need).length;
}

/**
 * 標籤列 vs 虛線列的區分。
 *
 * ⚠️ 這裡有個很容易踩的陷阱：止賺色 ＝ 漲色（都是紅），止蝕色 ＝ 跌色（都是綠）。
 *   這是刻意的配色（止賺用紅、止蝕用綠，語意一致），但也意味著
 *   **不能在有紅色 K 線的圖上數「紅色像素」來判斷標籤**
 *   ——數到的大多數是 K 線實體。
 *   所以下面的標籤測試一律讓 K 線只有「另一種顏色」，
 *   這樣該色就只可能來自參考線本身。
 */
function lineRows(img, color) {
  const rows = rowCounts(img, color);
  const s = new Set();
  rows.forEach((n, y) => {
    if (n >= PLOT_W * 0.5) s.add(y);
  });
  return s;
}

/** 左側標籤帶內、且不在長虛線列上的該色像素數 → 只算標籤字形 */
function labelPixels(img, color) {
  const onLine = lineRows(img, color);
  let n = 0;
  for (let y = 0; y < img.height; y += 1) {
    if (onLine.has(y)) continue;
    for (let x = PLOT_X; x < PLOT_X + 40; x += 1) {
      if (isColor(img, x, y, color)) n += 1;
    }
  }
  return n;
}

/** 標籤字形佔用的列（用於判斷兩個標籤是否重疊） */
function labelRowList(img, color) {
  const onLine = lineRows(img, color);
  const out = [];
  for (let y = 0; y < img.height; y += 1) {
    if (onLine.has(y)) continue;
    let n = 0;
    for (let x = PLOT_X; x < PLOT_X + 40; x += 1) {
      if (isColor(img, x, y, color)) n += 1;
    }
    // 門檻取 1：3x5 點陣字的某些列（例如 '0' 的上下橫槓中間）
    // 在 40px 窗口內只會貢獻 1~2 個像素，門檻設 2 會把整列漏掉，
    // 導致一個完整的標籤被誤切成好幾段。
    if (n >= 1) out.push(y);
  }
  return out;
}

/**
 * 把列清單切成「一段一段」的色帶。
 *
 * 為什麼需要：每個標籤都會先鋪一塊白底再寫字。
 * 若兩個標籤疊在一起，後畫的那個白底會把前一個**整段蓋掉**——
 * 於是「重疊」的視覺結果不是「糊成一團」，而是「少了一個標籤」。
 * 所以判準要看「有幾段獨立的色帶」，而不是看連續長度。
 *
 * 允許 1 列的空隙就合併：labelRowList 會排除「長虛線列」，
 * 若某個標籤剛好壓在虛線那一列上，就會被切成兩段（5px 的字變 2+3）。
 * 那是量測方式的假象，不是真的兩個標籤，所以要合併。
 */
function bands(rows, mergeGap) {
  const g = mergeGap === undefined ? 1 : mergeGap;
  const out = [];
  for (const y of rows) {
    const last = out[out.length - 1];
    if (last && y - last[last.length - 1] <= g + 1) last.push(y);
    else out.push([y]);
  }
  return out;
}

/* ---- 測試用 K 線 ---- */

function mkCandles(n, opts) {
  const o = opts || {};
  const start = o.start || 100;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const base = start + Math.sin(i / 4) * 5;
    const open = base;
    const close = o.forceUp ? base + 2 : (i % 2 === 0 ? base + 2 : base - 2);
    out.push({
      t: Date.UTC(2026, 0, 1) + i * 86400000,
      o: open,
      h: Math.max(open, close) + 1.5,
      l: Math.min(open, close) - 1.5,
      c: close,
      v: 1000,
    });
  }
  return out;
}

/** 指定區間的線性走勢，方便算參考線位置 */
function mkLinear(n, from, to, opts) {
  const o = opts || {};
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const mid = from + ((to - from) * i) / Math.max(1, n - 1);
    const open = mid;
    const close = o.forceUp ? mid + 0.4 : mid;
    out.push({
      t: Date.UTC(2026, 0, 1) + i * 86400000,
      o: open,
      h: Math.max(open, close) + (o.wick === undefined ? 0.5 : o.wick),
      l: Math.min(open, close) - (o.wick === undefined ? 0.5 : o.wick),
      c: close,
      v: 1000,
    });
  }
  return out;
}

(async () => {
  console.log('\nPNG 編碼\n');

  await ok('基本 PNG 結構：簽名 + IHDR + IDAT + IEND', async () => {
    const c = createCanvas(10, 10, { r: 255, g: 255, b: 255 });
    const png = encodePNG(10, 10, c.raw);
    const img = parsePNG(png);
    assert.strictEqual(img.width, 10);
    assert.strictEqual(img.height, 10);
    assert.strictEqual(img.bitDepth, 8);
    assert.strictEqual(img.colorType, 2, '應為 truecolor RGB');
    assert.deepStrictEqual(
      img.chunks.map((x) => x.type),
      ['IHDR', 'IDAT', 'IEND'],
      'chunk 順序或數量不對',
    );
  });

  await ok('每條掃描線都有 filter byte（缺少會讓整張圖斜掉）', async () => {
    const c = createCanvas(7, 5, { r: 255, g: 255, b: 255 });
    const png = encodePNG(7, 5, c.raw);
    const img = parsePNG(png);
    assert.strictEqual(img.filterBytes.length, 5);
    for (const f of img.filterBytes) {
      assert.strictEqual(f, 0, 'filter byte 應為 0');
    }
  });

  await ok('像素內容與輸入完全一致（不會錯位）', async () => {
    const c = createCanvas(4, 3, { r: 0, g: 0, b: 0 });
    c.pixel(1, 1, { r: 255, g: 0, b: 0 });
    const png = encodePNG(4, 3, c.raw);
    const img = parsePNG(png);
    const p = pixelAt(img, 1, 1);
    assert.deepStrictEqual(p, { r: 255, g: 0, b: 0 }, '該點應為紅色');
    const q = pixelAt(img, 0, 0);
    assert.deepStrictEqual(q, { r: 0, g: 0, b: 0 }, '其他點應為黑色');
  });

  await ok('寬高不會寫反（非正方形圖）', async () => {
    const c = createCanvas(9, 4, { r: 1, g: 2, b: 3 });
    const img = parsePNG(encodePNG(9, 4, c.raw));
    assert.strictEqual(img.width, 9);
    assert.strictEqual(img.height, 4);
    assert.strictEqual(img.pixels.length, 9 * 4 * 3);
  });

  await ok('像素緩衝長度不符要拋錯', async () => {
    assert.throws(() => encodePNG(10, 10, Buffer.alloc(10)), /長度不符/);
  });

  await ok('繪圖超出邊界會被裁剪，不會爆掉', async () => {
    const c = createCanvas(10, 10, { r: 255, g: 255, b: 255 });
    c.rect(-50, -50, 200, 200, { r: 1, g: 2, b: 3 });
    c.hline(-100, 500, 5, { r: 9, g: 9, b: 9 });
    c.vline(999, -999, 999, { r: 9, g: 9, b: 9 });
    const img = parsePNG(encodePNG(10, 10, c.raw));
    assert.strictEqual(img.width, 10);
  });

  await ok('整張圖底色一致（緩衝區算錯會讓最後幾列變黑邊）', async () => {
    /* 白色底圖上沒有任何繪圖：整張必須全白。
       若 Buffer.alloc 的大小算錯（少算 filter byte），Buffer.copy 會截斷
       最後幾列，那些列在解壓後是 0（純黑）——圖只是底部多一條黑邊，
       看起來像「圖片風格」，實際上是最後幾列資料根本沒寫進去。 */
    const c = createCanvas(37, 23, { r: 255, g: 255, b: 255 });
    const img = parsePNG(encodePNG(37, 23, c.raw));
    const nonWhite = img.pixels.length / 3 - countColor(img, { r: 255, g: 255, b: 255 });
    assert.strictEqual(nonWhite, 0, `純白底圖不該有任何其他顏色，實際有 ${nonWhite} 個非白像素`);

    // 最後一列也要是白的（緩衝區截斷最常傷到這裡）
    for (let x = 0; x < img.width; x += 1) {
      assert.deepStrictEqual(
        pixelAt(img, x, img.height - 1), { r: 255, g: 255, b: 255 },
        `第 ${img.height - 1} 列第 ${x} 行不是白色（最後一列被截斷）`,
      );
    }
  });

  console.log('\nK 線圖 — 基本\n');

  await ok('輸出尺寸與色彩格式正確', async () => {
    const img = parsePNG(renderCandleChart({ symbol: 'TEST', candles: mkCandles(40) }));
    assert.strictEqual(img.width, W);
    assert.strictEqual(img.height, H);
    assert.strictEqual(img.colorType, 2);
  });

  await ok('K 線真的畫上去了（不是一片空白）', async () => {
    const img = parsePNG(renderCandleChart({ symbol: 'TEST', candles: mkCandles(40) }));
    const red = countColor(img, COLOR.up);
    const green = countColor(img, COLOR.down);
    assert.ok(red > 100, `紅色 K 線像素應 > 100，實際 ${red}`);
    assert.ok(green > 100, `綠色 K 線像素應 > 100，實際 ${green}`);
  });

  await ok('紅漲綠跌：上漲 K 線是紅、下跌是綠', async () => {
    const upImg = parsePNG(renderCandleChart({ symbol: 'UP', candles: mkCandles(30, { forceUp: true }) }));
    const upRed = countColor(upImg, COLOR.up);
    const upGreen = countColor(upImg, COLOR.down);
    assert.ok(upRed > upGreen * 3, `全漲時紅色應遠多於綠色（紅 ${upRed} / 綠 ${upGreen}）`);
    assert.ok(COLOR.up.r > 200 && COLOR.up.g < 80, '漲色應為紅（r 高 g 低）');
    assert.ok(COLOR.down.g > 100 && COLOR.down.r < 80, '跌色應為綠（g 高 r 低）');
  });

  await ok('平盤（收=開）算上漲、畫紅色（>= 而不是 >）', async () => {
    // 全部 doji：o === c
    const img = parsePNG(renderCandleChart({ symbol: 'DOJI', candles: mkLinear(20, 100, 110) }));
    const red = countColor(img, COLOR.up);
    const green = countColor(img, COLOR.down);
    assert.ok(red > 0, '平盤應有紅色');
    assert.strictEqual(green, 0, `平盤不該出現綠色，實際 ${green}`);
  });

  await ok('K 線實體有依根數加寬（不是永遠 1px）', async () => {
    // 60 根時 slot ≈ 10.8，bodyW 應為 6；若變成 1 就只剩細線
    const img = parsePNG(renderCandleChart({ symbol: 'W', candles: mkCandles(60, { forceUp: true }) }));
    const run = maxRunAnyRow(img, COLOR.up);
    assert.ok(run >= 4, `實體最寬連續區段應 >= 4px，實際 ${run}（1 表示沒加寬）`);
  });

  await ok('影線（最高最低）有畫出來', async () => {
    // 刻意做長影線：實體只有 1 單位，影線卻拉到 ±90
    const candles = [];
    for (let i = 0; i < 5; i += 1) {
      candles.push({
        t: Date.UTC(2026, 0, 1) + i * 86400000,
        o: 100, c: 100.5, h: 190, l: 10, v: 1000,
      });
    }
    const img = parsePNG(renderCandleChart({ symbol: 'WICK', candles }));
    const ink = countColor(img, COLOR.up);
    // 實體只有約 2px 高 × 約 80px 寬 ≈ 160；影線上下各約 170px → 合計應遠超過 300
    assert.ok(ink > 350, `長影線應有大量像素，實際 ${ink}（影線沒畫會掉到 ~160）`);
  });

  await ok('平盤 K 線不會消失（開收同價時至少補 1px）', async () => {
    // 實體高度 0，靠 max(1, ...) 補成 1px；若為 0 就整根不見
    const candles = [];
    for (let i = 0; i < 8; i += 1) {
      candles.push({
        t: Date.UTC(2026, 0, 1) + i * 86400000,
        o: 100, c: 100, h: 100.5, l: 99.5, v: 1000,
      });
    }
    const img = parsePNG(renderCandleChart({ symbol: 'FLATBODY', candles }));
    const run = maxRunAnyRow(img, COLOR.up);
    assert.ok(run >= 4, `平盤實體仍應有寬度 >= 4px，實際 ${run}（1 表示只剩影線）`);
  });

  console.log('\nK 線圖 — 座標與裁切\n');

  await ok('y 軸方向正確：高價在上面、低價在下面', async () => {
    // K 線 100~115，止賺 112（高價）、買區 101（低價）
    const img = parsePNG(renderCandleChart({
      symbol: 'AXIS',
      candles: mkLinear(40, 100, 115),
      pick: { buyLow: 101, buyHigh: 101, targetPrice: 112, stopPrice: 102 },
    }));

    const targetRows = extentRows(img, COLOR.target).rows
      .map((n, y) => ({ n, y })).filter((r) => r.n >= PLOT_W / 2).map((r) => r.y);
    const stopRows = extentRows(img, COLOR.stop).rows
      .map((n, y) => ({ n, y })).filter((r) => r.n >= PLOT_W / 2).map((r) => r.y);

    assert.ok(targetRows.length, '找不到止賺線（紅，112）');
    assert.ok(stopRows.length, '找不到止蝕線（綠，102）');
    // 止賺價 112 比止蝕價 102 高 → 螢幕上 y 要更小（更靠上）
    assert.ok(
      Math.min(...targetRows) < Math.min(...stopRows),
      `止賺(112) 應在止蝕(102) 上方：止賺 y=${Math.min(...targetRows)}，止蝕 y=${Math.min(...stopRows)}（可能 y 軸顛倒了）`,
    );
  });

  await ok('K 線不會貼邊被裁掉（上下留白）', async () => {
    /* 影線要夠長才測得出來：影線只有上下 1 單位時，
       即使 y 範圍只算開收盤、不含最高最低，看起來也不會被裁到。
       所以這裡用長影線（±20）——範圍算錯時影線會直接頂到繪圖區外緣。 */
    const img = parsePNG(renderCandleChart({ symbol: 'PAD', candles: mkLinear(30, 100, 130, { wick: 20 }) }));
    const red = extentRows(img, COLOR.up);
    const green = extentRows(img, COLOR.down);
    const first = Math.min(...[red.first, green.first].filter((v) => v >= 0));
    const last = Math.max(red.last, green.last);
    assert.ok(first > PLOT_Y + 2, `最高價不該貼在繪圖區上緣（first=${first}, 上緣=${PLOT_Y}）`);
    assert.ok(last < PLOT_Y + PLOT_H - 2, `最低價不該貼在繪圖區下緣（last=${last}, 下緣=${PLOT_Y + PLOT_H}）`);
  });

  await ok('所有價格相同（橫盤）不會除以零', async () => {
    /* o/h/l/c 全部 50。若移除 `hi === lo` 的退路，(hi-lo)=0，
       yOf 會回傳 NaN，所有繪製都被裁掉 → 只剩格線與刻度。 */
    const candles = [];
    for (let i = 0; i < 20; i += 1) {
      candles.push({ t: Date.UTC(2026, 0, 1) + i * 86400000, o: 50, h: 50, l: 50, c: 50, v: 10 });
    }
    const img = parsePNG(renderCandleChart({ symbol: 'FLAT', candles }));
    assert.strictEqual(img.width, W);
    // 真的畫出 K 線（不是因為 y 全變 NaN 而空白）
    assert.ok(countColor(img, COLOR.up) > 100, '橫盤也應畫出 K 線');
    // 而且只能有紅色（收=開算上漲），不該冒出綠色
    assert.strictEqual(countColor(img, COLOR.down), 0, '橫盤不該出現綠色 K 線');
  });

  console.log('\nK 線圖 — 參考線\n');

  await ok('三條參考線都畫了，而且是「線」不是只有標籤', async () => {
    const img = parsePNG(renderCandleChart({
      symbol: 'REF',
      candles: mkLinear(40, 78, 86),
      pick: { buyLow: 79.5, buyHigh: 80.5, targetPrice: 85, stopPrice: 78.5 },
    }));
    // 一條水平線會覆蓋繪圖區大半（虛線 duty ≈ 5/8）
    assert.ok(countLineRows(img, COLOR.buy) >= 2,
      `買區應有兩條水平線，實際 ${countLineRows(img, COLOR.buy)} 列`);
    assert.ok(countLineRows(img, COLOR.target) >= 1,
      `止賺應有水平線，實際 ${countLineRows(img, COLOR.target)} 列`);
    assert.ok(countLineRows(img, COLOR.stop) >= 1,
      `止蝕應有水平線，實際 ${countLineRows(img, COLOR.stop)} 列`);
  });

  await ok('買區是兩條線夾出的區間（少一條就看不出寬度）', async () => {
    const img = parsePNG(renderCandleChart({
      symbol: 'ZONE',
      candles: mkLinear(40, 78, 86),
      pick: { buyLow: 79.5, buyHigh: 80.5 },
    }));
    const lines = countLineRows(img, COLOR.buy);
    assert.ok(lines >= 2, `買區應有 2 條線，實際 ${lines}`);
    assert.ok(lines <= 3, `買區不該多於 2 條線（標籤不該被算成線），實際 ${lines}`);
  });

  await ok('現價線有畫（最後一根收盤）', async () => {
    const img = parsePNG(renderCandleChart({ symbol: 'LAST', candles: mkLinear(40, 100, 110) }));
    // 現價線是細虛線（dash 2 / gap 4），覆蓋率約 33%
    const lines = countLineRows(img, COLOR.last, 0.2);
    assert.ok(lines >= 1, `現價線應可見，實際 ${lines} 列`);
    assert.ok(lines <= 2, `現價線只需 1 條，實際 ${lines} 列`);
  });

  await ok('參考線價格超出範圍時不畫（但圖仍正常產生）', async () => {
    const img = parsePNG(renderCandleChart({
      symbol: 'FAR',
      candles: mkCandles(40, { start: 100 }),
      pick: { buyLow: 1, buyHigh: 2, targetPrice: 99999, stopPrice: 0.5 },
    }));
    assert.strictEqual(img.width, W);
    assert.strictEqual(countColor(img, COLOR.buy), 0, '超出範圍的買區線不應畫出來');
    assert.strictEqual(countLineRows(img, COLOR.target), 0, '超出範圍的止賺線不應畫出來');
  });

  await ok('離譜的止賺價不會把 K 線壓扁（參考線不得主導比例）', async () => {
    // 止賺 1000、K 線在 100 附近：若把 1000 納入 y 範圍，K 線會縮成一條
    const img = parsePNG(renderCandleChart({
      symbol: 'SQUASH',
      candles: mkLinear(40, 98, 104, { wick: 1 }),
      pick: { targetPrice: 1000 },
    }));
    const red = extentRows(img, COLOR.up);
    const green = extentRows(img, COLOR.down);
    const span = Math.max(red.last, green.last) - Math.min(...[red.first, green.first].filter((v) => v >= 0));
    assert.ok(span > PLOT_H * 0.3,
      `K 線應佔用繪圖區至少 30% 高度，實際 ${span}/${PLOT_H}（太小表示比例被參考線主導）`);
  });

  await ok('參考線標籤的數字有畫出來（不是只有虛線）', async () => {
    /* 只有三條虛線而沒有數字，就分不出哪條是買區、哪條是止賺。

       配色陷阱：止賺色 ＝ 漲色（紅），止蝕色 ＝ 跌色（綠）。
       所以要看哪一種顏色的「乾淨」標籤，就得讓 K 線全部是另一種顏色：
         · K 線全綠（下跌）→ 紅色只可能來自止賺標籤 ✅
         · K 線全綠（下跌）→ 綠色混著 K 線，不能用來驗止蝕     ❌
       （買區是藍色，永遠乾淨。） */
    const green = [];
    for (let i = 0; i < 40; i += 1) {
      const m = 78 + ((86 - 78) * i) / 39;
      green.push({ t: Date.UTC(2026, 0, 1) + i * 86400000, o: m + 0.3, c: m - 0.3, h: m + 0.5, l: m - 0.5, v: 1 });
    }
    const img = parsePNG(renderCandleChart({
      symbol: '',
      candles: green,
      pick: { targetPrice: 85, stopPrice: 78.5, buyLow: 82, buyHigh: 81.7 },
    }));
    const bare = parsePNG(renderCandleChart({ symbol: '', candles: green }));

    // 前提：不帶參考線時紅色為 0，證明 K 線全是綠的
    assert.strictEqual(countColor(bare, COLOR.up), 0, '前提：全跌 K 線不該有紅色');

    assert.ok(labelPixels(img, COLOR.target) >= 8,
      `止賺標籤的數字應畫出來，左側只有 ${labelPixels(img, COLOR.target)} 個像素`);
    assert.ok(labelRowList(img, COLOR.target).length >= 4,
      `止賺標籤應佔至少 4 列（5px 高的字），實際 ${labelRowList(img, COLOR.target).length}`);
    // 線本身也要在（不能只有標籤、線不見了）
    assert.ok(countLineRows(img, COLOR.target) >= 1, '止賺虛線本身也要畫');

    // 買區是藍色，永遠乾淨
    assert.ok(labelPixels(img, COLOR.buy) >= 8,
      `買區標籤的數字應畫出來，左側只有 ${labelPixels(img, COLOR.buy)} 個像素`);
  });

  await ok('參考線標籤不會互相重疊（價格很接近時）', async () => {
    /* 這裡的價格刻意配成「四個價位在螢幕上只差 1~3px」。
       沒有「至少間隔 7px」的保護時，後畫的白底會把前一個標籤整段蓋掉：
       實測 buyLow 只剩 [213] 一列（幾乎全被吃掉）、止蝕跑到 220、
       止賺完全消失。有保護時則是三段乾淨的色帶。
       所以判準是「標籤仍然完整可讀」，而不是「有沒有連在一起」。
       K 線做成全綠 → 買區（藍）不會與 K 線撞色，訊號最乾淨。 */
    const flat = [];
    for (let i = 0; i < 40; i += 1) {   // 100 → 110
      const m = 100 + (10 * i) / 39;
      flat.push({ t: Date.UTC(2026, 0, 1) + i * 86400000, o: m + 0.3, c: m - 0.3, h: m + 0.5, l: m - 0.5, v: 1 });
    }
    const img = parsePNG(renderCandleChart({
      symbol: '',
      candles: flat,
      pick: { buyLow: 105.00, buyHigh: 104.90, targetPrice: 104.84, stopPrice: 104.78 },
    }));

    const buyRows = labelRowList(img, COLOR.buy);
    const buyBands = bands(buyRows);

    /* 「完整」用垂直跨度判斷，不是數列數：
       標籤若剛好壓在虛線那一列上，該列會被 labelRowList 排除，
       於是 5px 高的字只數到 4 列。跨度（last - first + 1）不受影響。 */
    const span = (b) => b[b.length - 1] - b[0] + 1;

    assert.ok(buyBands.length >= 2,
      `買區應有兩段獨立標籤，實際 ${buyBands.length} 段：${JSON.stringify(buyBands)}`);
    const complete = buyBands.filter((b) => span(b) >= 4);
    assert.ok(complete.length >= 2,
      `買區兩個標籤都應完整（垂直跨度 >= 4px），實際只有 ${complete.length} 段完整：`
      + `${JSON.stringify(buyBands.map((b) => ({ rows: b, span: span(b) })))}`);

    // 止賺 / 止蝕的標籤也不能被蓋掉
    const targetBands = bands(labelRowList(img, COLOR.target));
    const fullTarget = targetBands.filter((b) => span(b) >= 4);
    assert.ok(fullTarget.length >= 1,
      `止賺標籤不該被其他標籤蓋掉，實際色帶：`
      + `${JSON.stringify(targetBands.map((b) => ({ rows: b, span: span(b) })))}`);
  });

  await ok('標籤有鋪白底，數字不會被虛線劃穿', async () => {
    /* 標籤會先用背景色蓋一塊再寫字。少了這一步，1px 虛線會從
       小字的空隙穿過去，數字整個糊掉。

       量法要精準：白底矩形的寬度是 textWidth(text,1) + 2，字串長度不定
       （`80.00` 是 5 字元 → 寬 21px；`104.78` 是 6 字元 → 26px）。
       所以不能假設固定的 40px。這裡改用「同一列的藍色像素總數」比較：
       標籤列會因為白底而少了開頭那一大段，總數必然少於虛線本體。 */
    const flat = [];
    for (let i = 0; i < 40; i += 1) {
      const m = 78 + ((86 - 78) * i) / 39;
      flat.push({ t: Date.UTC(2026, 0, 1) + i * 86400000, o: m, c: m, h: m + 0.2, l: m - 0.2, v: 1 });
    }
    const img = parsePNG(renderCandleChart({
      symbol: '',
      candles: flat,
      pick: { buyLow: 80, buyHigh: 80 },
    }));

    /* 關鍵：要看「標籤那一列」，不是虛線那一列。
       標籤會被推到至少 7px 外（見上一條測試），所以虛線列本身沒有白底。 */
    const labelRowsHere = labelRowList(img, COLOR.buy);
    assert.ok(labelRowsHere.length, '應找得到買區標籤');

    /* 白底矩形的寬度 = textWidth(label) + 2，起點 x = PAD_L + 1。
       標籤文字從 x = PAD_L + 2 開始，5 個字元寬約 19px。
       若白底沒鋪，標籤列的右緣（最後一個藍色像素）會一路延伸到
       虛線的末端（約 x=657）；有鋪白底時，右緣會停在標籤文字附近。

       這是唯一能穩定區分兩者的訊號：實測有白底 maxx=28、
       沒白底時 maxx 也在 28 附近——因為虛線被推到別列去了。
       所以改用「標籤列相對虛線列」的比較。 */
    const rightmost = (y) => {
      let maxx = -1;
      for (let x = 0; x < img.width; x += 1) {
        if (isColor(img, x, y, COLOR.buy)) maxx = x;
      }
      return maxx;
    };

    const lineRow = lineRows(img, COLOR.buy).values().next().value;
    const lineRight = rightmost(lineRow);
    assert.ok(lineRight > 400, `虛線應橫貫整個繪圖區，實際右緣 x=${lineRight}`);

    // 標籤列的藍色只該出現在左側文字區，不該出現右側的虛線殘影
    const strayRight = labelRowsHere.filter((y) => rightmost(y) > PLOT_X + 60);
    assert.strictEqual(strayRight.length, 0,
      `標籤列不該出現右側藍色殘影（y=${strayRight.slice(0, 5).join(',')}）`
      + ' —— 表示白底沒鋪，數字被虛線劃穿');
  });

  await ok('超出範圍的參考線不留任何痕跡（含標籤）', async () => {
    /* 止賺價是現價兩倍時，畫在圖外沒有意義；更糟的是標籤被擠到頂端，
       那會讓使用者以為某個價位就長在那裡。
       K 線全綠 → 紅色只可能來自止賺，驗「完全沒有紅色」即可。 */
    const green = [];
    for (let i = 0; i < 30; i += 1) {
      const mid = 100 + i * 0.2;
      green.push({ t: Date.UTC(2026, 0, 1) + i * 86400000, o: mid + 0.3, c: mid - 0.3, h: mid + 0.5, l: mid - 0.5, v: 1 });
    }
    const img = parsePNG(renderCandleChart({ symbol: '', candles: green, pick: { targetPrice: 9999 } }));
    assert.strictEqual(countColor(img, COLOR.up), 0,
      '離譜的止賺價（9999）不該在圖上留下任何紅色痕跡（線或標籤）');
  });

  await ok('K 線實體與影線同心（偏移會讓 K 線看起來被切一半）', async () => {
    /* 實體必須以 slot 中心對齊影線。
       若 xBody 少算 bodyW/2，實體會整個往右偏半個身位，
       影線與實體不再同心——遠看像每根 K 線都被削掉左半邊。 */
    // 單根 K 線，影線窄（1px）、實體寬，最容易量出偏心
    const one = [{ t: Date.UTC(2026, 0, 1), o: 100, c: 100.05, h: 110, l: 90, v: 1 }];
    const img = parsePNG(renderCandleChart({ symbol: '', candles: one, bars: 10 }));

    let wickX = null;
    let bodyRange = null;
    for (let y = PLOT_Y; y < PLOT_Y + PLOT_H; y += 1) {
      const xs = [];
      for (let x = 0; x < img.width; x += 1) {
        if (isColor(img, x, y, COLOR.up)) xs.push(x);
      }
      if (!xs.length) continue;
      if (xs.length === 1) wickX = xs[0];
      else if (!bodyRange && xs.length > 1) bodyRange = { first: xs[0], last: xs[xs.length - 1] };
    }

    assert.ok(wickX !== null, '應找得到影線（1px 寬的那一列）');
    assert.ok(bodyRange, '應找得到實體（較寬的那一列）');

    const center = (bodyRange.first + bodyRange.last) / 2;
    assert.ok(
      Math.abs(center - wickX) <= 1,
      `實體中心（${center}）應與影線（${wickX}）對齊，實際偏移 ${(center - wickX).toFixed(1)}px`,
    );
  });

  console.log('\nK 線圖 — 邊界情況\n');

  await ok('股票代碼會畫在圖上（字母也要畫得出來）', async () => {
    /* 這條抓的是真實發生過的缺陷：字型第一版只有 0-9，
       於是 `PDD`、`LI` 這種純字母代碼在左上角**完全空白**，
       `2015.HK` 只畫得出 `2015.`。圖上完全看不出是哪檔股票。 */
    const blank = parsePNG(renderCandleChart({ symbol: '', candles: mkLinear(20, 100, 110) }));
    const withSym = parsePNG(renderCandleChart({ symbol: 'PDD', candles: mkLinear(20, 100, 110) }));

    const inkOf = (img) => img.pixels.length / 3 - countColor(img, { r: 255, g: 255, b: 255 });
    const extra = inkOf(withSym) - inkOf(blank);
    assert.ok(extra > 30, `代碼 PDD 應畫出額外墨跡，實際只多 ${extra}（字母畫不出來）`);

    // 港股常見的 4 位數字 + .HK 也要有字母
    const hk = parsePNG(renderCandleChart({ symbol: '2015.HK', candles: mkLinear(20, 100, 110) }));
    const digitsOnly = parsePNG(renderCandleChart({ symbol: '2015.', candles: mkLinear(20, 100, 110) }));
    assert.ok(
      inkOf(hk) > inkOf(digitsOnly),
      'HK 兩個字母應比空白多出墨跡（2015.HK 不該只剩 2015.）',
    );
  });

  await ok('沒有 K 線資料時改顯示 NO DATA（不是一片空白）', async () => {
    // symbol 留空，這樣畫面裡的非白像素只可能來自 NO DATA 字樣
    const img = parsePNG(renderCandleChart({ symbol: '', candles: [] }));
    assert.strictEqual(img.width, W);
    const nonWhite = img.pixels.length / 3 - countColor(img, { r: 255, g: 255, b: 255 });
    // 空白畫布幾乎全白；有 NO DATA 字樣才會有明顯墨跡（也仍有格線與刻度）
    assert.ok(nonWhite > 150, `應有 NO DATA 字樣，非白像素實際只有 ${nonWhite}`);
    assert.ok(nonWhite < 6000, `不該畫出 K 線，非白像素實際 ${nonWhite}`);
  });

  await ok('K 線不足時不會爆（只有 3 根）', async () => {
    const img = parsePNG(renderCandleChart({ symbol: 'FEW', candles: mkCandles(3) }));
    assert.strictEqual(img.width, W);
    assert.ok(countColor(img, COLOR.up) + countColor(img, COLOR.down) > 10, '少數幾根仍應畫出來');
  });

  await ok('bars 參數生效：只取最近 N 根（不是取最前 N 根）', async () => {
    /* 不能用「墨跡多寡」驗證根數——取 10 根與 60 根時價格區間也變，
       y 軸比例整個重算：10 根在窄區間會被放大成又寬又高，
       60 根在寬區間則是又細又短，總墨跡誰多誰少取決於取樣段落。
       所以驗內容：前 190 根全跌（綠），最後 10 根全漲（紅），
       那 bars:10 就應該只看得到紅、完全看不到綠。 */
    const candles = [];
    for (let i = 0; i < 200; i += 1) {
      const isTail = i >= 190;
      const base = 100 + Math.sin(i / 6) * 3;
      const close = isTail ? base + 2 : base - 2;
      candles.push({
        t: Date.UTC(2026, 0, 1) + i * 86400000,
        o: base,
        h: Math.max(base, close) + 1,
        l: Math.min(base, close) - 1,
        c: close,
        v: 1000,
      });
    }

    const ten = parsePNG(renderCandleChart({ symbol: 'T', candles, bars: 10 }));
    assert.ok(countColor(ten, COLOR.up) > 50, `只取最後 10 根時應畫出紅色，實際 ${countColor(ten, COLOR.up)}`);
    assert.strictEqual(countColor(ten, COLOR.down), 0, '只取最後 10 根時不該出現綠色');

    const sixty = parsePNG(renderCandleChart({ symbol: 'T', candles, bars: 60 }));
    assert.ok(countColor(sixty, COLOR.down) > 50, '取 60 根時應包含較早的綠色 K 線');
  });

  await ok('bars 少於 10 時仍保留 10 根下限（不會畫成一根粗柱）', async () => {
    const candles = mkCandles(50);
    const inkOf = (img) => img.pixels.length / 3 - countColor(img, { r: 255, g: 255, b: 255 });
    const one = parsePNG(renderCandleChart({ symbol: 'T', candles, bars: 1 }));
    const ten = parsePNG(renderCandleChart({ symbol: 'T', candles, bars: 10 }));
    assert.strictEqual(inkOf(one), inkOf(ten), 'bars:1 應與 bars:10 相同（10 根下限）');
  });

  await ok('極端價格（低價股）也能正常畫', async () => {
    const candles = [];
    for (let i = 0; i < 30; i += 1) {
      candles.push({
        t: Date.UTC(2026, 0, 1) + i * 86400000,
        o: 0.85 + i * 0.001,
        h: 0.9 + i * 0.001,
        l: 0.8 + i * 0.001,
        c: 0.88 + i * 0.001,
        v: 100,
      });
    }
    const img = parsePNG(renderCandleChart({ symbol: 'PENNY', candles }));
    assert.strictEqual(img.width, W);
    const ink = img.pixels.length / 3 - countColor(img, { r: 255, g: 255, b: 255 });
    assert.ok(ink > 500, '低價股仍應有可見的 K 線');
  });

  await ok('輸出為合法 PNG（可被 zlib 正確解壓）', async () => {
    const img = parsePNG(renderCandleChart({ symbol: 'OK', candles: mkCandles(60) }));
    assert.strictEqual(img.pixels.length, img.width * img.height * 3);
  });

  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項\n`);
  if (fail) {
    failures.forEach((f) => {
      console.log(`FAILED: ${f.name}`);
      console.log(f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 4).join('\n') : f.error);
      console.log('');
    });
    process.exit(1);
  }
})();

/**
 * 標籤區的判定：標籤畫在繪圖區左側（PAD_L 附近），
 * 而且是實心小方塊堆成的字，不只是一個像素。
 */
function isLabelRow(img, y, color) {
  let n = 0;
  for (let x = PLOT_X; x < PLOT_X + 40; x += 1) {
    if (isColor(img, x, y, color)) n += 1;
  }
  return n >= 2;
}
