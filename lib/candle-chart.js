'use strict';

/**
 * K 線圖產生器（零依賴，輸出 PNG）
 * ==================================
 *
 * 為什麼要在伺服器端畫圖：
 *   Telegram 只能「收一張圖片」或「收一段文字」。把 K 線畫成文字
 *   （方塊字元拼圖）雖然輕，但看不到開高低收，對「該不該進場」的判斷
 *   幫助有限。使用者要的是真的 K 線圖。
 *
 * ── 圖上必須有的東西（依重要性排序） ──────────────────────
 *
 * ① 真實 K 線（開高低收），紅漲綠跌
 *    採華人習慣：紅漲、綠跌。這與歐美相反，寫錯會讓使用者完全誤判方向。
 *
 * ② 三條參考線：建議買入區、止賺、止蝕
 *    這才是這張圖存在的理由——把「現在價格離我的掛單還多遠」畫出來。
 *    只有 K 線沒有參考線，就只是張股票走勢圖，跟推送的推介內容無關。
 *
 * ③ 價格刻度與日期
 *    沒有刻度無法判斷幅度；沒有日期無法判斷是哪一段行情。
 *
 * ── 為什麼沒有用文字繪製字型 ─────────────────────────────
 *   點陣字型要自己做（每個字元 5x7 點陣），程式碼會膨脹好幾百行。
 *   折衷做法：數字用極簡的 3x5 點陣（只畫我們需要的 0-9 與幾個符號），
 *   中文標題則不放進圖裡——中文標題交給 Telegram 訊息的文字說明，
 *   圖上只留數字與價格。這樣既看得懂，又不必自己造中文字型。
 */

const { encodePNG, createCanvas } = require('./png');

/* ---- 配色（與前端一致） ---- */
const COLOR = {
  bg: { r: 255, g: 255, b: 255 },
  grid: { r: 235, g: 236, b: 238 },
  axis: { r: 150, g: 150, b: 152 },
  text: { r: 70, g: 72, b: 76 },
  up: { r: 217, g: 43, b: 43 },      // 漲：紅
  down: { r: 11, g: 122, b: 68 },    // 跌：綠（合規深綠，非 #0f9d58）
  buy: { r: 24, g: 102, b: 204 },    // 買區：藍
  target: { r: 217, g: 43, b: 43 },  // 止賺：紅
  stop: { r: 11, g: 122, b: 68 },    // 止蝕：綠
  last: { r: 120, g: 120, b: 125 },  // 現價水平線
};

/**
 * 極簡 3x5 點陣字型。
 *
 * 只實作數字、英文大寫與少量符號 —— 圖上要顯示的是價格、日期與股票代碼。
 * 中文不放進圖裡（見檔頭說明）。
 * 每列 3 bit，用字串表示比較好讀也比較好改。
 *
 * ⚠️ 英文大寫是必要的，不是裝飾：
 *   第一版只做了 0-9，結果 `NO DATA` 與 `2015.HK` 的字母全部落回空白，
 *   於是「查無行情」變成一張全白圖片（使用者以為程式壞了），
 *   而美股代碼 `PDD`、`LI` 在左上角**完全不會出現**——畫了一張
 *   不知道是哪檔股票的圖。3px 寬畫不出漂亮的 N，但足以辨識。
 */
const GLYPHS = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  A: ['111', '101', '111', '101', '101'],
  B: ['110', '101', '110', '101', '110'],
  C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '111', '100', '111'],
  F: ['111', '100', '111', '100', '100'],
  G: ['011', '100', '101', '101', '011'],
  H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
  J: ['001', '001', '001', '101', '011'],
  K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['110', '101', '101', '101', '101'],
  O: ['111', '101', '101', '101', '111'],
  P: ['111', '101', '111', '100', '100'],
  Q: ['111', '101', '101', '111', '001'],
  R: ['111', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'],
  V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'],
  X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  Z: ['111', '001', '010', '100', '111'],
  '.': ['000', '000', '000', '000', '010'],
  '-': ['000', '000', '111', '000', '000'],
  '/': ['001', '001', '010', '100', '100'],
  ':': ['000', '010', '000', '010', '000'],
  '+': ['000', '010', '111', '010', '000'],
  '%': ['101', '001', '010', '100', '101'],
  ' ': ['000', '000', '000', '000', '000'],
};

/**
 * 以 scale 倍放大畫一段文字（僅限 GLYPHS 支援的字元）。
 * 回傳實際寬度，方便置中或右對齊。
 */
function drawText(canvas, text, x, y, scale, color) {
  const s = Math.max(1, Math.round(scale));
  let cx = Math.round(x);
  const str = String(text);
  for (const ch of str) {
    const glyph = GLYPHS[ch] || GLYPHS[' '];
    for (let row = 0; row < 5; row += 1) {
      const bits = glyph[row];
      for (let col = 0; col < 3; col += 1) {
        if (bits[col] === '1') {
          canvas.rect(cx + col * s, Math.round(y) + row * s, s, s, color);
        }
      }
    }
    cx += 4 * s;   // 3 寬 + 1 間距
  }
  return cx - Math.round(x);
}

function textWidth(text, scale) {
  const s = Math.max(1, Math.round(scale));
  return String(text).length * 4 * s - s;
}

function fmtPrice(v) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2);
}

function fmtDate(key) {
  // 只需要 MM/DD
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? `${m[2]}/${m[3]}` : String(key || '');
}

/**
 * 畫一張 K 線圖。
 *
 * @param {object} o
 *   symbol     股票代碼（畫在左上）
 *   candles     [{t,o,h,l,c}] 由舊到新
 *   pick        { buyLow, buyHigh, targetPrice, stopPrice, costPrice? } 參考線
 *   bars       要顯示的根數（預設 60）
 *   width/height
 * @returns {Buffer} PNG
 */
function renderCandleChart(o) {
  const opts = o || {};
  const symbol = String(opts.symbol || '');
  const candles = Array.isArray(opts.candles) ? opts.candles : [];
  const pick = opts.pick || {};

  const W = opts.width || 720;
  const H = opts.height || 420;

  // 邊界：左右留給價格刻度與日期，上方留給代碼
  const PAD_L = 8;
  const PAD_R = 62;    // 右側價格刻度
  const PAD_T = 30;
  const PAD_B = 26;    // 底部日期

  const canvas = createCanvas(W, H, COLOR.bg);

  const plotX = PAD_L;
  const plotY = PAD_T;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  // 只取最近 N 根
  const wantBars = Math.max(10, Math.min(opts.bars || 60, candles.length));
  const bars = candles.slice(-wantBars);

  if (!bars.length) {
    drawText(canvas, symbol, PAD_L, 8, 3, COLOR.text);
    drawText(canvas, 'NO DATA', plotX + 20, plotY + plotH / 2, 3, COLOR.axis);
    return encodePNG(W, H, canvas.raw);
  }

  /* ---- ① 計算價格範圍 ----
     把三條參考線也納入範圍：否則止賺價若在畫面外，
     使用者就看不到「離目標還多遠」，圖就失去意義。
     但也不能讓參考線主導整個比例（例如止賺價是現價兩倍時，
     K 線會被壓成底部一條線），所以用「K 線範圍」為主，
     參考線只擴張到合理倍數內。 */
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    if (isFinite(b.h)) hi = Math.max(hi, b.h);
    if (isFinite(b.l)) lo = Math.min(lo, b.l);
  }
  if (!isFinite(hi) || !isFinite(lo) || hi <= lo) {
    hi = lo + 1;
  }

  const priceRefs = [pick.buyLow, pick.buyHigh, pick.targetPrice, pick.stopPrice, pick.costPrice]
    .map(Number)
    .filter((v) => isFinite(v) && v > 0);

  const baseSpan = hi - lo;
  const limitHi = hi + baseSpan * 0.35;   // 最多再往上擴 35%
  const limitLo = Math.max(0, lo - baseSpan * 0.35);

  for (const v of priceRefs) {
    if (v <= limitHi && v >= limitLo) {
      hi = Math.max(hi, v);
      lo = Math.min(lo, v);
    }
  }
  // 上下各留 6% 呼吸空間，避免 K 線貼邊
  const span = hi - lo || 1;
  hi += span * 0.06;
  lo = Math.max(0, lo - span * 0.06);

  const yOf = (price) => plotY + ((hi - price) / (hi - lo)) * plotH;

  /* ---- ② 網格與價格刻度 ---- */
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i += 1) {
    const price = lo + ((hi - lo) * i) / gridLines;
    const y = yOf(price);
    canvas.hline(plotX, plotX + plotW - 1, y, COLOR.grid, 1);
    const label = fmtPrice(price);
    drawText(canvas, label, plotX + plotW + 4, y - 2, 1, COLOR.axis);
  }

  /* ---- ③ K 線 ----
     寬度依根數自動算，最少 1px 影線 + 1px 實體。 */
  const slot = plotW / bars.length;
  const bodyW = Math.max(1, Math.floor(slot * 0.62));

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    const cx = plotX + slot * (i + 0.5);
    const up = Number(b.c) >= Number(b.o);
    const c = up ? COLOR.up : COLOR.down;

    const xBody = Math.round(cx - bodyW / 2);

    // 影線（最高到最低）
    const yHigh = yOf(Number(b.h));
    const yLow = yOf(Number(b.l));
    canvas.vline(Math.round(cx), yHigh, yLow, c, 1);

    // 實體（開盤到收盤）；若開收相同，至少畫 1px 才看得到
    const yOpen = yOf(Number(b.o));
    const yClose = yOf(Number(b.c));
    const top = Math.min(yOpen, yClose);
    const bh = Math.max(1, Math.abs(yClose - yOpen));
    canvas.rect(xBody, top, bodyW, bh, c);
  }

  /* ---- ④ 三條參考線 ----
     用虛線是刻意的：實線會和 K 線實體混淆，
     而且虛線在視覺上就是「這是一個價位，不是走勢」。

     標籤放在右側刻度區內，並避免互相重疊（價格接近時會疊在一起，
     疊起來就完全讀不出數字）。 */
  const labels = [];
  const pushRef = (value, color, tag) => {
    const v = Number(value);
    if (!isFinite(v) || v <= 0) return;
    const y = yOf(v);
    if (y < plotY - 2 || y > plotY + plotH + 2) return;   // 超出畫面就不畫
    canvas.dashedH(plotX, plotX + plotW - 1, y, color, 5, 3, 1);
    labels.push({ y, text: `${tag}${fmtPrice(v)}`, color });
  };

  // 買區用兩條線夾出區間
  pushRef(pick.buyLow, COLOR.buy, '');
  pushRef(pick.buyHigh, COLOR.buy, '');
  pushRef(pick.targetPrice, COLOR.target, '');
  pushRef(pick.stopPrice, COLOR.stop, '');

  // 現價：最後一根收盤
  const lastClose = Number(bars[bars.length - 1].c);
  if (isFinite(lastClose) && lastClose > 0) {
    const y = yOf(lastClose);
    canvas.dashedH(plotX, plotX + plotW - 1, y, COLOR.last, 2, 4, 1);
  }

  // 標籤排版：依 y 排序後，彼此至少間隔 7px，避免文字疊在一起
  labels.sort((a, b) => a.y - b.y);
  let lastY = -999;
  for (const lb of labels) {
    let y = lb.y;
    if (y - lastY < 7) y = lastY + 7;
    if (y > H - PAD_B) continue;
    // 標籤放左側（右側已被價格刻度佔用）
    const w = textWidth(lb.text, 1);
    canvas.rect(PAD_L + 1, y - 1, w + 2, 7, COLOR.bg);
    drawText(canvas, lb.text, PAD_L + 2, y, 1, lb.color);
    lastY = y;
  }

  /* ---- ⑤ 底部日期 ---- */
  const firstKey = bars[0] && bars[0].t ? fmtDateMs(bars[0].t) : '';
  const lastKey = bars[bars.length - 1] && bars[bars.length - 1].t
    ? fmtDateMs(bars[bars.length - 1].t) : '';
  if (firstKey) drawText(canvas, firstKey, plotX, H - PAD_B + 8, 1, COLOR.axis);
  if (lastKey) {
    const w = textWidth(lastKey, 1);
    drawText(canvas, lastKey, plotX + plotW - w, H - PAD_B + 8, 1, COLOR.axis);
  }

  /* ---- ⑥ 左上角代碼 ---- */
  drawText(canvas, symbol, PAD_L, 6, 2, COLOR.text);

  return encodePNG(W, H, canvas.raw);
}

function fmtDateMs(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (!isFinite(d.getTime())) return '';
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}`;
}

module.exports = {
  renderCandleChart,
  COLOR,
  fmtPrice,
  textWidth,
};
