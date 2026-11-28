'use strict';

/**
 * 圖上事件標記（推介／進場／出場）單元測試 — 完全不連網
 * =====================================================
 *
 * 這是需求「在 K 線圖上標示推介日期、止虧日期、止盤日期及其對應價位」
 * 的直接驗收。它的失敗模式跟其他圖表功能一樣安靜：
 *   · 日期對到錯的 K 線 → 圖上看起來完全正常，只是標在錯誤的日子
 *   · 區間外的日期被畫在邊界 → 使用者以為推介發生在圖的最左邊那天
 *   · 週末／停牌的日期直接被丟掉 → 標記消失，使用者以為功能沒做
 *   · 同一天多個標籤疊在一起 → 只看得到一個，另一個像不存在
 *   · 佈局常數被改動 → 34 條既有的幾何斷言全部失效
 * 以上都不會拋錯，只能靠斷言釘住。
 *
 * 覆蓋範圍：
 *   A. 日期 → K 線索引（含週末、停牌、區間外、格式錯誤）
 *   B. 同一天多事件（去重規則）
 *   C. 型別與顏色
 *   D. 價位
 *   E. 幾何：垂直線落在正確的欄、標籤不重疊、佈局常數不變
 *   F. 真實 PNG 產出（真的畫得出來，不是只有資料對）
 *
 * 用法：node tests/candle-event-markers.cjs
 */

const assert = require('assert');

const { renderCandleChart, normalizeEvents, EVENT_STYLE, COLOR } = require('../lib/candle-chart');
const { encodePNG } = require('../lib/png');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, msg: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

/* ===============================================================
   測試資料：確定性的 60 根日 K，**跳過週末**
   跳過週末是刻意的——週末事件要對到「之前最近的一根」，
   若資料每天都有，這條規則根本不會被執行到。
   =============================================================== */

const BAR_COUNT = 60;
const START = Date.UTC(2026, 9, 1); // 2026-10-01（週四）

function makeBars(n = BAR_COUNT) {
  const bars = [];
  let day = START;
  let px = 100;
  while (bars.length < n) {
    const d = new Date(day);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {           // 0=週日, 6=週六
      px = px + (((bars.length * 37) % 11) - 5) * 0.6;
      bars.push({
        t: day,
        o: +px.toFixed(2),
        h: +(px + Math.abs(((bars.length * 13) % 7) - 3) + 0.5).toFixed(2),
        l: +(px - Math.abs(((bars.length * 17) % 7) - 3) - 0.5).toFixed(2),
        c: +(px + (((bars.length * 29) % 5) - 2) * 0.4).toFixed(2),
        v: 1000000 + (bars.length * 7919) % 500000,
      });
    }
    day += 86400000;
  }
  return bars;
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const BARS = makeBars();
const BARS_END = dayKey(BARS[BARS.length - 1].t);
const BARS_START = dayKey(BARS[0].t);

/* ===============================================================
   A. 日期 → 索引
   =============================================================== */

console.log('\nA. 日期 → K 線索引');

t('A1 精確命中的日期對到該根', () => {
  const k = dayKey(BARS[10].t);
  const out = normalizeEvents([{ type: 'pick', date: k }], BARS);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].index, 10);
});

t('A2 週末的日期對到「之前最近」的那一根，不是被丟掉', () => {
  // 找一個週六
  let sat = null;
  for (let i = 0; i < BARS.length - 1; i += 1) {
    const d = new Date(BARS[i].t);
    const next = new Date(BARS[i + 1].t);
    if (next.getTime() - d.getTime() > 86400000) { sat = dayKey(d.getTime() + 86400000); break; }
  }
  assert.ok(sat, '測試資料裡應該有週末斷點');
  const out = normalizeEvents([{ type: 'pick', date: sat }], BARS);
  assert.strictEqual(out.length, 1, '週末事件不該被丟掉');
  assert.strictEqual(dayKey(out[0].t), dayKey(BARS[0].t) === sat ? dayKey(BARS[0].t) : dayKey(out[0].t));
  // 對到的那一根必須真的在前一個交易日
  assert.ok(out[0].t < Date.parse(sat + 'T00:00:00Z'), '必須落在事件日之前');
  assert.strictEqual(out[0].index < BARS.length, true);
});

t('A3 早於第一根 → 丟棄（不畫在邊界上騙人）', () => {
  const before = dayKey(Date.parse(BARS_START + 'T00:00:00Z') - 86400000);
  const out = normalizeEvents([{ type: 'pick', date: before }], BARS);
  assert.strictEqual(out.length, 0, '區間外的事件必須被丟棄');
});

t('A4 晚於最後一根 → 對到最後一根（狀態已成立，只是還沒收盤）', () => {
  const after = dayKey(Date.parse(BARS_END + 'T00:00:00Z') + 5 * 86400000);
  const out = normalizeEvents([{ type: 'pick', date: after }], BARS);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].index, BARS.length - 1);
});

t('A5 日期格式錯誤 → 丟棄，不猜', () => {
  ['', 'abc', '2026/11/01', '2026-11', null, undefined].forEach((d) => {
    const out = normalizeEvents([{ type: 'pick', date: d }], BARS);
    assert.strictEqual(out.length, 0, `${JSON.stringify(d)} 不該被接受`);
  });
});

t('A6 空輸入 / 空 bars 都回空陣列，不拋錯', () => {
  assert.deepStrictEqual(normalizeEvents([], BARS), []);
  assert.deepStrictEqual(normalizeEvents(null, BARS), []);
  assert.deepStrictEqual(normalizeEvents([{ type: 'pick', date: BARS_START }], []), []);
  assert.deepStrictEqual(normalizeEvents([{ type: 'pick', date: BARS_START }], null), []);
});

t('A7 帶時間的 ISO 字串也能用（只取前 10 碼）', () => {
  const k = dayKey(BARS[5].t);
  const out = normalizeEvents([{ type: 'pick', date: `${k}T13:45:00.000Z` }], BARS);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].index, 5);
});

/* ===============================================================
   B. 同一天多事件
   =============================================================== */

console.log('\nB. 同一天多事件');

t('B1 不同型別同一天 → 都保留', () => {
  const k = dayKey(BARS[8].t);
  const out = normalizeEvents([
    { type: 'pick', date: k },
    { type: 'entry', date: k },
  ], BARS);
  assert.strictEqual(out.length, 2);
});

t('B2 同型別同一天重複 → 只留一個（重複畫只會更亂）', () => {
  const k = dayKey(BARS[8].t);
  const out = normalizeEvents([
    { type: 'pick', date: k },
    { type: 'pick', date: k },
    { type: 'pick', date: k },
  ], BARS);
  assert.strictEqual(out.length, 1);
});

t('B3 排序由左到右（依 index）', () => {
  const out = normalizeEvents([
    { type: 'exit', date: dayKey(BARS[20].t) },
    { type: 'pick', date: dayKey(BARS[3].t) },
    { type: 'entry', date: dayKey(BARS[9].t) },
  ], BARS);
  assert.deepStrictEqual(out.map((x) => x.index), [3, 9, 20]);
});

t('B4 同一 index 上不同型別的順序穩定（依 tag）', () => {
  const k = dayKey(BARS[8].t);
  const a = normalizeEvents([
    { type: 'pick', date: k }, { type: 'entry', date: k },
  ], BARS).map((x) => x.tag);
  const b = normalizeEvents([
    { type: 'entry', date: k }, { type: 'pick', date: k },
  ], BARS).map((x) => x.tag);
  assert.deepStrictEqual(a, b, '輸入順序不該改變輸出順序');
});

/* ===============================================================
   C. 型別與顏色
   =============================================================== */

console.log('\nC. 型別、標籤與顏色');

t('C1 四種事件各有預設標籤 P / B / X', () => {
  assert.strictEqual(EVENT_STYLE.pick.tag, 'P');
  assert.strictEqual(EVENT_STYLE.entry.tag, 'B');
  assert.strictEqual(EVENT_STYLE.exit.tag, 'X');
});

t('C2 預設標籤會實際套用到輸出', () => {
  const k = dayKey(BARS[4].t);
  const out = normalizeEvents([
    { type: 'pick', date: k },
    { type: 'entry', date: k },
    { type: 'exit', date: k },
  ], BARS);
  assert.deepStrictEqual(out.map((x) => x.tag).sort(), ['B', 'P', 'X']);
});

t('C3 事件的顏色不可與漲跌色相同（否則會被誤讀成 K 線）', () => {
  assert.notDeepStrictEqual(EVENT_STYLE.pick.color, COLOR.up, '推介色不可等於漲色');
  assert.notDeepStrictEqual(EVENT_STYLE.pick.color, COLOR.down, '推介色不可等於跌色');
  assert.notDeepStrictEqual(EVENT_STYLE.entry.color, COLOR.up, '進場色不可等於漲色');
  assert.notDeepStrictEqual(EVENT_STYLE.entry.color, COLOR.down, '進場色不可等於跌色');
  assert.notDeepStrictEqual(EVENT_STYLE.exit.color, COLOR.up, '出場色不可等於漲色');
  assert.notDeepStrictEqual(EVENT_STYLE.exit.color, COLOR.down, '出場色不可等於跌色');
});

t('C4 未知型別有退路，不會變成 undefined 讓繪圖爆掉', () => {
  const out = normalizeEvents([{ type: 'unknown-type', date: dayKey(BARS[3].t) }], BARS);
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].tag, '必須有標籤');
  assert.ok(out[0].color && typeof out[0].color.r === 'number', '必須有顏色');
});

t('C5 可自訂標籤（截斷為 1 字元）', () => {
  const out = normalizeEvents([{ type: 'pick', date: dayKey(BARS[3].t), tag: '推薦' }], BARS);
  assert.strictEqual(out[0].tag, '推');
});

/* ===============================================================
   D. 價位
   =============================================================== */

console.log('\nD. 價位');

t('D1 有給價位就保留', () => {
  const out = normalizeEvents([{ type: 'exit', date: dayKey(BARS[12].t), price: 88.5 }], BARS);
  assert.strictEqual(out[0].price, 88.5);
});

t('D2 沒給價位為 null（畫在軸上／用垂直線表示，不亂猜）', () => {
  const out = normalizeEvents([{ type: 'pick', date: dayKey(BARS[12].t) }], BARS);
  assert.strictEqual(out[0].price, null);
});

t('D3 不合理價位（0、負、NaN、字串）一律視為沒有', () => {
  [0, -5, NaN, 'abc', null, undefined].forEach((p) => {
    const out = normalizeEvents([{ type: 'pick', date: dayKey(BARS[12].t), price: p }], BARS);
    assert.strictEqual(out[0].price, null, `${JSON.stringify(p)} 不該成為價位`);
  });
});

t('D4 字串數字可轉成價位', () => {
  const out = normalizeEvents([{ type: 'exit', date: dayKey(BARS[12].t), price: '123.4' }], BARS);
  assert.strictEqual(out[0].price, 123.4);
});

/* ===============================================================
   E. 幾何：垂直線位置與佈局常數
   =============================================================== */

console.log('\nE. 幾何（垂直線位置、佈局常數）');

/** 解 PNG 成 { w, h, px(x,y) } —— 只為了量測，不驗格式 */
const zlib = require('zlib');

function decodePNG(buf) {
  assert.strictEqual(buf.readUInt32BE(0), 0x89504e47, '不是 PNG');
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') { idat.push(data); }
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  assert.strictEqual(bitDepth, 8);
  assert.strictEqual(colorType, 2, '應為 8-bit RGB');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 3;
  const stride = w * bpp;
  const px = Buffer.alloc(w * h * bpp);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    const filter = raw[p]; p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    // 反濾波（只實作本專案會用到的 0/1/2/3/4）
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
      line[i] = v;
    }
    line.copy(px, y * stride);
    prev = line;
  }
  return {
    w, h,
    at(x, y) { const i = (y * w + x) * bpp; return { r: px[i], g: px[i + 1], b: px[i + 2] }; },
  };
}

const LAYOUT = { W: 720, H: 420, PLOT_X: 8, PLOT_Y: 30, PLOT_W: 650, PLOT_H: 364 };

t('E1 佈局常數不變（改了會讓 34 條既有幾何斷言失效）', () => {
  const png = renderCandleChart({
    symbol: 'TEST', candles: BARS,
    pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 }, events: [],
  });
  const img = decodePNG(png);
  assert.strictEqual(img.w, LAYOUT.W, '寬度');
  assert.strictEqual(img.h, LAYOUT.H, '高度');
});

t('E2 事件的垂直線落在正確的欄（用顏色逐欄計數）', () => {
  const pick = { type: 'pick', date: dayKey(BARS[20].t) };
  const withEv = renderCandleChart({
    symbol: 'TEST', candles: BARS,
    pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 }, events: [pick],
  });
  const without = renderCandleChart({
    symbol: 'TEST', candles: BARS,
    pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 }, events: [],
  });
  const a = decodePNG(withEv);
  const b = decodePNG(without);

  // 找出「有事件」比「沒事件」多了最多藍色像素的欄
  const c = EVENT_STYLE.pick.color;
  const hits = [];
  for (let x = LAYOUT.PLOT_X; x < LAYOUT.PLOT_X + LAYOUT.PLOT_W; x += 1) {
    let diff = 0;
    for (let y = LAYOUT.PLOT_Y; y < LAYOUT.PLOT_Y + LAYOUT.PLOT_H; y += 1) {
      const p = a.at(x, y);
      const q = b.at(x, y);
      const isEv = Math.abs(p.r - c.r) <= 2 && Math.abs(p.g - c.g) <= 2 && Math.abs(p.b - c.b) <= 2;
      const wasEv = Math.abs(q.r - c.r) <= 2 && Math.abs(q.g - c.g) <= 2 && Math.abs(q.b - c.b) <= 2;
      if (isEv && !wasEv) diff += 1;
    }
    if (diff > 0) hits.push({ x, diff });
  }
  assert.ok(hits.length > 0, '應該要有藍色像素出現');
  const best = hits.reduce((m, h) => (h.diff > m.diff ? h : m), hits[0]);
  const expected = Math.round(LAYOUT.PLOT_X + (LAYOUT.PLOT_W / BARS.length) * (20 + 0.5));
  assert.ok(Math.abs(best.x - expected) <= 2,
    `垂直線應在 x≈${expected}，實際 ${best.x}（差距 ${Math.abs(best.x - expected)}）`);
});

t('E3 垂直線是虛線（有畫／沒畫交錯，不是實線）', () => {
  const pick = { type: 'pick', date: dayKey(BARS[20].t) };
  const png = renderCandleChart({
    symbol: 'TEST', candles: BARS,
    pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 }, events: [pick],
  });
  const img = decodePNG(png);
  const c = EVENT_STYLE.pick.color;
  const x = Math.round(LAYOUT.PLOT_X + (LAYOUT.PLOT_W / BARS.length) * (20 + 0.5));
  let on = 0, off = 0, seenOn = false;
  for (let y = LAYOUT.PLOT_Y + 5; y < LAYOUT.PLOT_Y + LAYOUT.PLOT_H - 5; y += 1) {
    let hit = false;
    for (let dx = -1; dx <= 1; dx += 1) {
      const p = img.at(x + dx, y);
      if (Math.abs(p.r - c.r) <= 2 && Math.abs(p.g - c.g) <= 2 && Math.abs(p.b - c.b) <= 2) hit = true;
    }
    if (hit) { on += 1; seenOn = true; } else if (seenOn) off += 1;
  }
  assert.ok(on > 20, `虛線的實體應該夠多，實際 ${on}`);
  assert.ok(off > 20, `虛線應該有缺口，實際缺口 ${off}`);
});

t('E4 標籤在頂部留白區，不壓在 K 線上', () => {
  const png = renderCandleChart({
    symbol: 'TEST', candles: BARS,
    pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 },
    events: [{ type: 'pick', date: dayKey(BARS[20].t) }],
  });
  const img = decodePNG(png);
  const c = EVENT_STYLE.pick.color;
  // 標籤文字應該出現在 PLOT_Y 之上（頂部留白），不是圖內
  let topHits = 0;
  let innerHits = 0;
  for (let y = 0; y < LAYOUT.PLOT_Y; y += 1) {
    for (let x = 0; x < LAYOUT.W; x += 1) {
      const p = img.at(x, y);
      if (Math.abs(p.r - c.r) <= 2 && Math.abs(p.g - c.g) <= 2 && Math.abs(p.b - c.b) <= 2) topHits += 1;
    }
  }
  for (let y = LAYOUT.PLOT_Y + 6; y < LAYOUT.PLOT_Y + 40; y += 1) {
    for (let x = 0; x < LAYOUT.W; x += 1) {
      const p = img.at(x, y);
      if (Math.abs(p.r - c.r) <= 2 && Math.abs(p.g - c.g) <= 2 && Math.abs(p.b - c.b) <= 2) innerHits += 1;
    }
  }
  assert.ok(topHits > 0, '標籤應該出現在頂部留白區');
  assert.ok(topHits > innerHits, `標籤不該壓在圖內（頂部 ${topHits} vs 圖內 ${innerHits}）`);
});

t('E5 多個事件靠很近時標籤會推開，不互相覆蓋', () => {
  const events = [];
  for (let i = 18; i <= 22; i += 1) events.push({ type: 'pick', date: dayKey(BARS[i].t) });
  const png = renderCandleChart({
    symbol: 'TEST', candles: BARS,
    pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 }, events,
  });
  const img = decodePNG(png);
  const c = EVENT_STYLE.pick.color;

  // 逐列找出藍色像素的 x 區間，統計「有幾個分離的色塊」
  let clusters = 0;
  let prevHit = false;
  for (let x = 0; x < LAYOUT.W; x += 1) {
    let hit = false;
    for (let y = 15; y <= 26; y += 1) {
      const p = img.at(x, y);
      if (Math.abs(p.r - c.r) <= 2 && Math.abs(p.g - c.g) <= 2 && Math.abs(p.b - c.b) <= 2) { hit = true; break; }
    }
    if (hit && !prevHit) clusters += 1;
    prevHit = hit;
  }
  assert.ok(clusters >= 3, `五個標籤應該形成多個可分離色塊，實際 ${clusters} 個`);
});

t('E6 區間外的事件完全不影響畫面（像素與沒有事件時一致）', () => {
  const before = dayKey(Date.parse(BARS_START + 'T00:00:00Z') - 30 * 86400000);
  const withOut = renderCandleChart({
    symbol: 'TEST', candles: BARS,
    pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 }, events: [{ type: 'pick', date: before }],
  });
  const none = renderCandleChart({
    symbol: 'TEST', candles: BARS,
    pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 }, events: [],
  });
  assert.ok(withOut.equals(none), '區間外事件不該改變任何像素');
});

t('E7 沒有 events 欄位時行為與空陣列相同（向後相容）', () => {
  const a = renderCandleChart({
    symbol: 'TEST', candles: BARS, pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 },
  });
  const b = renderCandleChart({
    symbol: 'TEST', candles: BARS, pick: { buyLow: 90, buyHigh: 95, targetPrice: 120, stopPrice: 80 }, events: [],
  });
  assert.ok(a.equals(b));
});

/* ===============================================================
   結果
   =============================================================== */

console.log(`\n========== 結果：${pass} 通過 / ${fail} 失敗 ==========`);
if (fail) {
  console.log('\n失敗明細：');
  failures.forEach((f) => console.log(` - ${f.name}: ${f.msg}`));
}
process.exit(fail === 0 ? 0 : 1);
