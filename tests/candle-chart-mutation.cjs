'use strict';

/**
 * 變異測試 — 證明 lib/png.js 與 lib/candle-chart.js 的測試「真的會失敗」
 * ======================================================================
 *
 * 這兩個模組的錯誤幾乎都不會拋錯：
 *   · PNG 少了 filter byte → 圖**仍然合法**，只是整張斜掉
 *   · 漲跌顏色寫反 → 圖看起來正常，但紅綠互換，判斷完全反向
 *   · 參考線沒畫 → 圖變成普通走勢圖，看起來依然漂亮
 *   · 價格軸算錯 → K 線位置偏離參考線，數字對但圖是錯的
 *   · y 軸上下顛倒 → 漲的股票看起來在跌
 * 這些全都「跑得完、能開圖」，只有斷言能釘住。
 *
 * 做法同 tracker-notify-mutation：把原始碼逐一植入典型錯誤，
 * 重跑單元測試，**必須失敗**。沒被測出就代表那段斷言是空的。
 *
 * 執行：node tests/candle-chart-mutation.cjs
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PNG_SRC = path.join(ROOT, 'lib', 'png.js');
const CHART_SRC = path.join(ROOT, 'lib', 'candle-chart.js');
const TEST = path.join(ROOT, 'tests', 'candle-chart-unit.cjs');
const BACKUP_DIR = path.join(ROOT, '.tmpv');

/**
 * 每個變異：{ file, name, find, replace, why }
 * 前提：find 在該檔案中必須恰好出現一次。
 */
const MUTATIONS = [
  /* ── PNG 編碼 ───────────────────────────────────────── */
  {
    file: PNG_SRC,
    name: '整條掃描線都寫 0（整張圖變黑，filter byte 對但資料沒複製）',
    find: '    rgb.copy(raw, dst + 1, src, src + stride);',
    replace: '    raw.fill(0, dst + 1, dst + 1 + stride);',
    why: 'filter byte 對了、圖也合法，但整張圖是黑的——最容易誤判成「渲染失敗」',
  },
  {
    file: PNG_SRC,
    name: '掃描線緩衝少算 filter byte（每列差 1 byte）',
    find: '  const raw = Buffer.alloc(height * (stride + 1));',
    replace: '  const raw = Buffer.alloc(height * stride + 1);',
    why: '緩衝大小與 stride 不一致，寫到後半段就越界，圖會整片錯位',
  },
  {
    file: PNG_SRC,
    name: '色彩類型寫成 0（灰階）而不是 2（RGB）',
    find: '  ihdr[9] = 2;   // color type 2 = truecolor RGB',
    replace: '  ihdr[9] = 0;   // color type 2 = truecolor RGB',
    why: '解碼器會把 RGB 三通道當成灰階讀，整張圖變黑白雜訊',
  },
  {
    file: PNG_SRC,
    name: '像素緩衝長度不符時不拋錯（默默畫錯）',
    find: '    throw new Error(`像素緩衝長度不符：預期 ${expected}，實際 ${rgb.length}`);',
    replace: '    return Buffer.alloc(0);',
    why: '長度算錯時會整張圖錯位，卻沒有任何訊息告訴你出事了',
  },
  {
    file: PNG_SRC,
    name: 'IHDR 寬高寫反',
    find: '  ihdr.writeUInt32BE(width, 0);\n  ihdr.writeUInt32BE(height, 4);',
    replace: '  ihdr.writeUInt32BE(height, 0);\n  ihdr.writeUInt32BE(width, 4);',
    why: '非正方形圖會直接變形，或整個檔案壞掉',
  },
  {
    file: PNG_SRC,
    name: 'CRC 不計算（填 0）',
    find: '  crc.writeUInt32BE(crc32(body), 0);',
    replace: '  crc.writeUInt32BE(0, 0);',
    why: '多數解碼器會直接拒收，症狀是「圖打不開」但程式毫無錯誤',
  },

  /* ── 顏色：紅漲綠跌 ─────────────────────────────────── */
  {
    file: CHART_SRC,
    name: '紅漲綠跌寫反（漲畫成綠、跌畫成紅）',
    find: '    const c = up ? COLOR.up : COLOR.down;',
    replace: '    const c = up ? COLOR.down : COLOR.up;',
    why: '華人習慣是紅漲綠跌。寫反會讓使用者把漲看成跌，是最嚴重的一種錯',
  },
  {
    file: CHART_SRC,
    name: '漲跌判斷用嚴格大於（平盤被當成跌）',
    find: '    const up = Number(b.c) >= Number(b.o);',
    replace: '    const up = Number(b.c) > Number(b.o);',
    why: '平盤（收=開）顏色會翻轉，本來該是紅的變綠',
  },
  {
    file: CHART_SRC,
    name: '漲色改成綠色系的深綠',
    find: "  up: { r: 217, g: 43, b: 43 },      // 漲：紅",
    replace: "  up: { r: 11, g: 122, b: 68 },    // 漲：紅",
    why: '常數被改掉時，所有 K 線顏色都錯，但程式完全正常',
  },

  /* ── y 軸與價格對應 ─────────────────────────────────── */
  {
    file: CHART_SRC,
    name: 'y 軸上下顛倒（高價畫在下面）',
    find: '  const yOf = (price) => plotY + ((hi - price) / (hi - lo)) * plotH;',
    replace: '  const yOf = (price) => plotY + ((price - lo) / (hi - lo)) * plotH;',
    why: '整張圖上下鏡像：漲的股票看起來在跌，而且圖本身毫無異狀',
  },
  {
    file: CHART_SRC,
    name: '價格範圍不扣除呼吸空間（K 線貼邊被切掉）',
    find: '  hi += span * 0.06;\n  lo = Math.max(0, lo - span * 0.06);',
    replace: '  hi += 0;\n  lo = lo - 0;',
    why: '最高最低價剛好壓在邊界上，影線會被裁掉，看起來像沒畫',
  },
  {
    file: CHART_SRC,
    name: '高低價抓錯（用開盤收盤當範圍）',
    find: '    if (isFinite(b.h)) hi = Math.max(hi, b.h);\n    if (isFinite(b.l)) lo = Math.min(lo, b.l);',
    replace: '    if (isFinite(b.o)) hi = Math.max(hi, b.o);\n    if (isFinite(b.c)) lo = Math.min(lo, b.c);',
    why: '影線會超出畫面被裁掉，K 線的「最高最低」資訊整個消失',
  },
  {
    file: CHART_SRC,
    name: 'K 線實體不以 slot 中心對齊（整排 K 線偏左/偏右）',
    find: '    const xBody = Math.round(cx - bodyW / 2);',
    replace: '    const xBody = Math.round(cx);',
    why: '實體往右偏半個身位，影線與實體不再對齊，K 線看起來像被切一半',
  },

  /* ── 參考線 ─────────────────────────────────────────── */
  {
    file: CHART_SRC,
    name: '完全不畫參考線（圖變成普通走勢圖）',
    find: '    canvas.dashedH(plotX, plotX + plotW - 1, y, color, 5, 3, 1);',
    replace: '    if (false) canvas.dashedH(plotX, plotX + plotW - 1, y, color, 5, 3, 1);',
    why: '這張圖存在的理由就是畫出「離我的掛單還多遠」，沒了就毫無價值',
  },
  {
    file: CHART_SRC,
    name: '買區只畫一條線（區間變成單一價位）',
    find: "  pushRef(pick.buyHigh, COLOR.buy, '');",
    replace: '  // pushRef(pick.buyHigh, COLOR.buy, \'\');',
    why: '「78.98 ~ 80.37」這種區間是掛單的關鍵，少一條線就看不出區間寬度',
  },
  {
    file: CHART_SRC,
    name: '不畫現價線',
    find: '    canvas.dashedH(plotX, plotX + plotW - 1, y, COLOR.last, 2, 4, 1);',
    replace: '    if (false) canvas.dashedH(plotX, plotX + plotW - 1, y, COLOR.last, 2, 4, 1);',
    why: '現價線是最後一根收盤的位置，沒有它很難一眼對照現價與買區的距離',
  },

  /* ── K 線本體 ───────────────────────────────────────── */
  {
    file: CHART_SRC,
    name: 'K 線實體寬度不依根數調整（永遠 1px 寬）',
    find: '  const bodyW = Math.max(1, Math.floor(slot * 0.62));',
    replace: '  const bodyW = 1;',
    why: '60 根時每根只剩影線，看不出開收盤的關係，紅綠也幾乎看不到',
  },
  {
    file: CHART_SRC,
    name: '不取最近 N 根，改取最前 N 根（畫到過期行情）',
    find: '  const bars = candles.slice(-wantBars);',
    replace: '  const bars = candles.slice(0, wantBars);',
    why: '圖上會是最舊的那段行情，看起來完全正常但講的是幾年前的事',
  },
  {
    file: CHART_SRC,
    name: 'bars 的下限 10 被移除（1 根時 slot 過寬）',
    find: '  const wantBars = Math.max(10, Math.min(opts.bars || 60, candles.length));',
    replace: '  const wantBars = Math.min(opts.bars || 60, candles.length);',
    why: '只給 1~2 根時會畫成一根超粗的柱子，看起來像資料壞了',
  },
  {
    file: CHART_SRC,
    name: '沒有 K 線資料時不畫 NO DATA（留下一片空白）',
    find: "    drawText(canvas, 'NO DATA', plotX + 20, plotY + plotH / 2, 3, COLOR.axis);",
    replace: "    // drawText(canvas, 'NO DATA', plotX + 20, plotY + plotH / 2, 3, COLOR.axis);",
    why: '空圖與「畫壞了」無法分辨，使用者會以為程式故障',
  },
  {
    file: CHART_SRC,
    name: '影線不畫（只剩實體）',
    find: '    canvas.vline(Math.round(cx), yHigh, yLow, c, 1);',
    replace: '    if (false) canvas.vline(Math.round(cx), yHigh, yLow, c, 1);',
    why: '最高最低是停損停利的重要參考，少了影線等於丟掉一半資訊',
  },
  {
    file: CHART_SRC,
    name: '不畫參考線標籤數字（線還在但不知是哪個價位）',
    find: '    drawText(canvas, lb.text, PAD_L + 2, y, 1, lb.color);',
    replace: '    if (false) drawText(canvas, lb.text, PAD_L + 2, y, 1, lb.color);',
    why: '三條虛線沒有數字，就分不出哪條是買區、哪條是止蝕',
  },
  {
    file: CHART_SRC,
    name: '實體高度為 0 時不補 1px（平盤 K 線消失）',
    find: '    const bh = Math.max(1, Math.abs(yClose - yOpen));',
    replace: '    const bh = Math.abs(yClose - yOpen);',
    why: '開收同價時高度 0，那一根完全看不到，像是缺資料',
  },
  {
    file: CHART_SRC,
    name: '標籤重疊保護失效（價格接近時文字疊成一團）',
    find: '    if (y - lastY < 7) y = lastY + 7;',
    replace: '    if (false) y = lastY + 7;',
    why: '止賺與止蝕只差 0.3 時，兩組數字會疊在同一列，完全讀不出來',
  },
];

/**
 * 已確認的「等價變異」（改了行為不變，因此測不出來是正確的）
 * ============================================================
 * 這些不是漏接，記錄下來免得日後有人以為是測試太弱：
 *
 * 1. `raw[dst] = 0;` 註解掉 → Buffer.alloc 本來就填 0，filter byte 仍是 0。
 *    想驗證「少了 filter byte 會斜掉」，必須改成讓它變成非 0
 *    或改成不配置那一個 byte（見下面「掃描線緩衝少算」那條）。
 *
 * 2. `hi = lo + 1`（橫盤退路）拿掉 → 後面的 `const span = hi - lo || 1`
 *    已經處理了 0 的情況，yOf 用的是 `hi - lo`（仍是 0）→ 會產生 NaN。
 *    但實際上 hi/lo 在計算時已被加減了 6% 的呼吸空間，
 *    橫盤時 hi !== lo，所以那句退路本來就是防禦性的死碼。
 *
 * 3. `pushRef` 的「超出畫面就不畫」拿掉 → canvas 的所有繪圖都自帶邊界裁剪，
 *    畫到圖外的線不會留下任何像素；而標籤的 y 若超出還會有
 *    `if (y > H - PAD_B) continue` 攔住。所以這條守衛的效果被
 *    其他機制吸收了，行為等價。
 *
 * 4. `canvas.rect(PAD_L + 1, y - 1, w + 2, 7, COLOR.bg)`（標籤白底）拿掉 →
 *    實測掃過多組價位，標籤永遠被推離自己的虛線至少 7px
 *    （因為上一行才剛把 y 拉開），所以白底根本不與任何線重疊，
 *    拿掉它畫面上完全沒有差別。白底是為了「同列有別的線」這種情況
 *    預留的，目前的繪圖順序讓它成為等價變異——不是測試太弱。
 */

function runTest() {
  try {
    execFileSync(process.execPath, [TEST], { stdio: 'pipe', cwd: ROOT });
    return { pass: true, out: '' };
  } catch (e) {
    return { pass: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

console.log('\n變異測試：png / candle-chart\n');

const baseline = runTest();
if (!baseline.pass) {
  console.log('  ✗ 基準測試本身沒通過，變異測試無意義。先修好測試。');
  console.log(baseline.out.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
console.log('  ✓ 基準：原始碼測試全數通過\n');

// 備份兩個檔案
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const backups = new Map();
for (const f of [PNG_SRC, CHART_SRC]) {
  const b = path.join(BACKUP_DIR, `${path.basename(f)}.orig`);
  fs.copyFileSync(f, b);
  backups.set(f, b);
}
const originals = new Map();
for (const f of [PNG_SRC, CHART_SRC]) {
  originals.set(f, fs.readFileSync(f, 'utf8'));
}

function restoreAll() {
  for (const [f, b] of backups) fs.copyFileSync(b, f);
}

let caught = 0;
let missed = 0;

for (const m of MUTATIONS) {
  const src = originals.get(m.file);
  const occurrences = src.split(m.find).length - 1;
  if (occurrences !== 1) {
    console.log(`  ! 跳過「${m.name}」— find 出現 ${occurrences} 次（需恰好 1 次）`);
    missed += 1;
    continue;
  }

  fs.writeFileSync(m.file, src.replace(m.find, m.replace), 'utf8');

  let res;
  try {
    res = runTest();
  } finally {
    restoreAll();
  }

  if (res.pass) {
    missed += 1;
    console.log(`  ✗ 未被測出：${m.name}`);
    console.log(`      ${m.why}`);
  } else {
    caught += 1;
    console.log(`  ✓ 已測出：${m.name}`);
  }
}

restoreAll();

console.log(`\n捕捉 ${caught} / ${MUTATIONS.length} 個變異，漏接 ${missed} 個\n`);

if (missed > 0) {
  console.log('漏接的變異代表對應斷言是空的 —— 那段測試沒有價值，必須補強。\n');
  process.exit(1);
}
