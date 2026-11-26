/**
 * 專案更名與「個股財報」模塊搬移 — 驗收測試
 * ===========================================
 * 執行：node tests/rename-and-move.cjs
 *
 * 這支測試存在的理由：
 *   改名與搬功能的缺陷都是「靜默」的 —— 頁面照樣跑得動，
 *   只是某處還寫著舊名字，或某個入口已經失效。這種問題不會拋錯，
 *   只能靠逐項比對。因此這裡把每一項需求都變成一條斷言。
 *
 * 涵蓋：
 *   A. 舊名零殘留（全庫掃描，含文件與設定檔）
 *   B. 新名出現在所有「使用者看得到 / 系統會讀到」的位置
 *   C. 個股財報確實已從宏觀模塊移除
 *   D. 個股財報確實已在個股模塊呈現
 *   E. 路由與選單歸屬正確（含舊網址轉址）
 *   F. 快取與資源清單同步
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; failures.push({ name, error: e }); console.log(`  FAIL  ${name}`); console.log(`        ${e.message}`); }
}
function section(s) { console.log(`\n=== ${s} ===`); }
function ok(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (a !== b) throw new Error(m || `期望 ${b}，實際 ${a}`); }

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

/** 遞迴列出專案內所有文字檔（排除依賴、版控、暫存） */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.verify' || name === '.probe') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) { walk(full, out); continue; }
    if (!/\.(js|mjs|cjs|html|css|json|md|webmanifest|yml|yaml|txt)$/.test(name)) continue;
    if (/\.log$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

const NEW = '股票量化分析專業介面';
/* 舊產品名。注意：「買入位判斷依據」是這套分析的真實技術概念
   （一張卡片的標題、README 的一節），不是產品名稱，必須保留。
   同理 lib/analyzer.js 的「買入位分析引擎」描述的是引擎算什麼，
   而不是產品叫什麼。這兩者已在 A1 的白名單與 A2 的反向斷言中分別處理。 */
const OLD_NAMES = ['買入位與技術位分析系統', '買入位與技術位分析', '買入位分析'];

const files = walk(ROOT);

const html = read('public/index.html');
const css = read('public/styles.css');
const appJs = read('public/app.js');
const commonJs = read('public/common.js');
const macroJs = read('public/macro.js');
const finJs = read('public/stock-fin.js');
const swJs = read('public/sw.js');
const manifest = JSON.parse(read('public/manifest.webmanifest'));
const pkg = JSON.parse(read('package.json'));
const serverJs = read('server.js');

/* ============================================================
   A. 舊名零殘留
   ============================================================ */
section('A 舊名零殘留');

t('A1 全庫不含任何舊產品名', () => {
  /* 掃描範圍排除本檔案自己：它必須把舊名當成「待偵測的字串」寫在程式裡，
     而且註解裡也舉了技術概念的例子，這些都不是產品名殘留。
     檢查工具不該把自己算成違規。 */
  const SELF = path.join(__dirname, 'rename-and-move.cjs');
  /* lib/analyzer.js 的「買入位分析引擎」是引擎職責描述，不是產品名，白名單排除。
     注意 path.relative 在 Windows 回傳反斜線，必須先正規化再比對，
     否則白名單永遠匹配不到，會變成形同虛設。 */
  const WHITELIST = ['lib/analyzer.js'];

  const hits = [];
  for (const f of files) {
    if (f === SELF) continue;
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (WHITELIST.includes(rel)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    for (const old of OLD_NAMES) {
      if (txt.includes(old)) {
        const line = txt.split('\n').findIndex((l) => l.includes(old));
        hits.push(`${rel}:${line + 1} -> ${old}`);
      }
    }
  }
  ok(hits.length === 0, `仍有 ${hits.length} 處舊名：\n${hits.join('\n')}`);
});

t('A2 技術概念「買入位」必須保留（不可過度替換）', () => {
  // 這是防反向錯誤：把產品名換掉時，連技術概念一起換會讓文案失去意義
  ok(html.includes('買入位判斷依據'), 'index.html 的「買入位判斷依據」被誤刪');
  ok(read('README.md').includes('買入位判斷依據'), 'README 的技術章節被誤刪');
  ok(appJs.includes('彙整買入位建議'), '載入提示的「彙整買入位建議」被誤刪');
});

/* ============================================================
   B. 新名出現在該出現的地方
   ============================================================ */
section('B 新名覆蓋所有可見與可讀位置');

t('B1 瀏覽器分頁 title', () => {
  ok(html.includes(`<title>${NEW}`), `title 未更新：${(html.match(/<title>([^<]*)<\/title>/) || [])[1]}`);
});

t('B2 meta description 與 iOS 主畫面名稱', () => {
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
  ok(desc.includes('股票量化分析'), `meta description 未更新：${desc}`);
  const apple = (html.match(/<meta name="apple-mobile-web-app-title" content="([^"]*)"/) || [])[1] || '';
  ok(apple.length > 0 && !OLD_NAMES.some((o) => apple.includes(o)), `iOS 名稱仍為舊名：${apple}`);
});

t('B3 頁首品牌文字', () => {
  const brand = (html.match(/<div class="brand-text">\s*<strong>([^<]*)<\/strong>/) || [])[1] || '';
  eq(brand, NEW, `頁首品牌為「${brand}」`);
});

t('B4 PWA manifest（name / short_name / description）', () => {
  eq(manifest.name, NEW, `manifest.name 為 ${manifest.name}`);
  ok(manifest.short_name && manifest.short_name.length <= 12,
    `short_name 過長（會被系統截斷）：${manifest.short_name}`);
  ok(!OLD_NAMES.some((o) => (manifest.description || '').includes(o)),
    'manifest.description 含舊名');
});

t('B5 package.json description', () => {
  ok(pkg.description.includes('股票量化分析'), `package.json description 為「${pkg.description}」`);
});

t('B6 伺服器啟動橫幅', () => {
  ok(serverJs.includes(NEW), 'server.js 啟動訊息未更新（使用者開機就看得到）');
});

t('B7 各檔頭部註解（品牌標示）', () => {
  ok(appJs.includes(NEW), 'app.js 檔頭未更新');
  ok(css.includes(NEW), 'styles.css 檔頭未更新');
  ok(swJs.includes(NEW), 'sw.js 檔頭未更新');
  ok(serverJs.includes(NEW), 'server.js 檔頭未更新');
});

t('B8 推播通知預設標題', () => {
  ok(swJs.includes('股票量化分析'), 'sw.js 推播標題未更新');
  ok(!swJs.includes('買入位'), 'sw.js 仍有舊名殘留');
});

t('B9 文件與部署說明', () => {
  ok(read('README.md').split('\n')[0].includes('股票量化分析'), 'README 標題未更新');
  ok(read('DEPLOY.md').includes('股票量化分析'), 'DEPLOY.md 未更新');
  ok(read('GITHUB-UPLOAD.md').includes('股票量化分析'), 'GITHUB-UPLOAD.md 未更新');
  ok(read('docs/NAS部署評估.md').includes('股票量化分析'), 'NAS 部署評估未更新');
});

/* ============================================================
   C. 個股財報已離開宏觀模塊
   ============================================================ */
section('C 個股財報已從宏觀模塊移除');

t('C1 宏觀頁不再有股票代碼輸入表單', () => {
  ok(!html.includes('macroSymbolForm'), 'index.html 仍有 #macroSymbolForm');
  ok(!html.includes('id="macroSymbol"'), 'index.html 仍有 #macroSymbol');
  ok(!macroJs.includes('macroSymbolForm'), 'macro.js 仍綁定該表單');
});

t('C2 macro.js 不再有財報渲染邏輯', () => {
  ok(!/function\s+loadSymbol/.test(macroJs), 'macro.js 仍有 loadSymbol');
  ok(!/function\s+renderFundamentalsTable/.test(macroJs), 'macro.js 仍有 renderFundamentalsTable');
  ok(!macroJs.includes("'/api/macro/'"), 'macro.js 仍直接呼叫個股財報端點');
});

t('C3 macro.js 不再保留 scope / symbol 狀態（避免誤導）', () => {
  ok(!/scope:\s*'macro'\s*\|\s*'symbol'/.test(macroJs), 'state 仍宣告 scope');
  ok(!macroJs.includes('state.scope'), 'macro.js 仍讀寫 state.scope');
  ok(!macroJs.includes('state.pendingSymbol'), 'macro.js 仍保留 pendingSymbol');
});

t('C4 宏觀頁保留全市場功能（不可誤刪）', () => {
  ok(html.includes('id="macroTableBody"'), '宏觀指標表被刪了');
  ok(html.includes('id="fomcList"'), 'FOMC 清單被刪了');
  ok(html.includes('id="dictBody"'), '資料字典被刪了');
  ok(html.includes('id="interpList"'), 'AI 解讀被刪了');
  ok(html.includes('id="macroRefresh"'), '重新整理被刪了');
});

t('C5 宏觀頁有說明為何沒有個股財報', () => {
  ok(/mh-scope-note/.test(html), '缺少範圍說明（使用者會以為功能消失了）');
  ok(/全市場/.test(html), '說明未講清楚本頁是全市場粒度');
  ok(/個股詳情頁/.test(html), '說明未指引到新位置');
});

/* ============================================================
   D. 個股財報已在個股模塊
   ============================================================ */
section('D 個股財報已在個股模塊');

t('D1 財報卡位於 #result 之內（個股模塊）', () => {
  const resultStart = html.indexOf('<div id="result"');
  ok(resultStart > -1, '找不到 #result');
  const resultEnd = html.indexOf('</div><!-- /#result -->');
  ok(resultEnd > resultStart, '找不到 #result 結束標記');
  const cardPos = html.indexOf('id="stockFinCard"');
  ok(cardPos > resultStart && cardPos < resultEnd,
    '財報卡不在 #result 內（仍留在模塊外）');
});

t('D2 財報卡在 #viewMacro 之外', () => {
  const macroStart = html.indexOf('<div id="viewMacro"');
  const macroEnd = html.indexOf('</div><!-- /#viewMacro -->');
  const cardPos = html.indexOf('id="stockFinCard"');
  ok(cardPos < macroStart || cardPos > macroEnd,
    '財報卡仍在宏觀 view 內（等於沒搬）');
});

t('D3 財報卡必要元素齊全', () => {
  for (const id of ['stockFinCard', 'stockFinTitle', 'stockFinBadge', 'stockFinRefresh',
    'stockFinSub', 'stockFinLoading', 'stockFinEmpty', 'stockFinEmptyTitle',
    'stockFinEmptyMsg', 'stockFinBody', 'stockFinTableBody', 'stockFinMeta']) {
    ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
});

t('D4 前端模組實作載入、渲染、空狀態與錯誤', () => {
  ok(finJs.includes("'/api/macro/'"), '未呼叫個股財報端點');
  ok(finJs.includes('StockFin'), '未匯出全域介面');
  ok(/seq !== state\.seq/.test(finJs), '缺少競態防護（快速切換股票會顯示錯的財報）');
  ok(finJs.includes('describeError'), '缺少錯誤描述');
  ok(/stockFinEmpty/.test(finJs), '缺少空狀態處理');
});

t('D5 前端為 ES5（與全站一致）', () => {
  ok(!/=>/.test(finJs), '出現箭頭函式');
  ok(!/\bconst\s/.test(finJs), '出現 const');
  ok(!/\blet\s/.test(finJs), '出現 let');
  ok(!/`/.test(finJs), '出現模板字串');
});

t('D6 動態字串一律轉義', () => {
  // innerHTML 拼接處的動態值必須包在 esc() 內
  ok(finJs.includes('function esc('), '缺少 esc 包裝');
  const innerHtmlLines = finJs.split('\n').filter((l) => l.includes('innerHTML'));
  ok(innerHtmlLines.length > 0, '找不到 innerHTML 賦值');
  ok(!/innerHTML\s*=\s*[^;']*\+\s*(?:m|r|fund|d)\./.test(finJs),
    '有 innerHTML 直接拼接未轉義的物件屬性');
});

t('D7 index.html 已載入 stock-fin.js，且在 app.js 之後', () => {
  ok(html.includes('/stock-fin.js'), 'HTML 未載入模組');
  ok(html.indexOf('/stock-fin.js') > html.indexOf('/app.js'),
    '必須在 app.js 之後載入（app.js 的 render 會呼叫 window.StockFin）');
});

t('D8 app.js 在分析成功後觸發財報載入', () => {
  ok(appJs.includes('window.StockFin'), 'app.js 未呼叫 StockFin');
  ok(appJs.includes('StockFin.onStock'), '未以當前代碼載入財報');
});

t('D9 財報卡有樣式，且只用真實存在的 CSS 變數', () => {
  ok(css.includes('.stock-fin-card'), '缺少 .stock-fin-card 樣式');
  ok(css.includes('.stock-fin-empty'), '缺少空狀態樣式');
  const block = css.slice(css.indexOf('.stock-fin-card'));
  const used = [...block.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
  const declared = new Set([...css.matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((m) => m[1]));
  const missing = [...new Set(used)].filter((v) => !declared.has(v));
  ok(missing.length === 0, `用了不存在的 CSS 變數：${missing.join(', ')}`);
});

/* ============================================================
   E. 路由與選單歸屬
   ============================================================ */
section('E 路由與選單歸屬');

t('E1 路由仍能解析 #/macro（不帶代碼）', () => {
  ok(/head === 'macro'/.test(commonJs), 'common.js 不再解析 macro');
  ok(/name:\s*'macro',\s*symbol:\s*parts\[1\]/.test(commonJs),
    'macro 路由的 symbol 解析被破壞');
});

t('E2 舊網址 #/macro/:symbol 會轉到個股詳情', () => {
  ok(/if\s*\(symbol\)\s*\{\s*SA\.navigate\('#\/detail\//.test(macroJs.replace(/\n\s*/g, '')),
    'macro.js 未把帶代碼的舊網址轉到 #/detail');
  // 轉址不能只是註解，必須是實際執行的程式碼
  const idx = macroJs.indexOf("SA.navigate('#/detail/'");
  ok(idx > -1, '找不到轉址呼叫');
  const before = macroJs.slice(Math.max(0, idx - 200), idx);
  ok(/if\s*\(symbol\)/.test(before), '轉址未包在 if (symbol) 內（會把宏觀頁也轉走）');
});

t('E3 導航為四項，且不含已搬移的財報入口', () => {
  const nav = [...html.matchAll(/<a href="#\/(\w+)" data-route="(\w+)" class="nav-item[^"]*">([^<]+)<\/a>/g)]
    .map((m) => ({ route: m[2], text: m[3].trim() }));
  const visible = nav.filter((n) => n.route !== 'detail');
  eq(visible.length, 4, `可見導航應為 4 項，實際 ${visible.length}`);
  ok(visible.some((n) => /宏觀/.test(n.text)), '缺少宏觀導航');
  ok(!visible.some((n) => /財報/.test(n.text)),
    '導航仍把財報當獨立入口（財報屬於個股模塊，不該另立選單）');
});

t('E4 宏觀導航指向 #/macro（不帶代碼）', () => {
  const m = html.match(/<a href="#\/([^"]*)" data-route="macro"/);
  ok(m, '找不到宏觀導航');
  eq(m[1], 'macro', `宏觀導航指向 #/${m[1]}，應為 #/macro`);
});

t('E5 個股詳情選單仍在（detail 路由的入口）', () => {
  ok(/data-route="detail"/.test(html), '缺少 detail 導航項');
  ok(/nav-detail/.test(html), '缺少 nav-detail 樣式掛鉤');
});

/* ============================================================
   F. 快取與資源清單
   ============================================================ */
section('F 快取同步');

t('F1 Service Worker 已收錄 stock-fin.js', () => {
  ok(swJs.includes("'/stock-fin.js'"), 'SHELL_ASSETS 未含 /stock-fin.js（離線時財報會抓不到）');
});

t('F2 Service Worker 版本已升（避免舊殼蓋新頁）', () => {
  const m = swJs.match(/VERSION = '([^']+)'/);
  ok(m, '找不到 VERSION');
  const num = (v) => (v.match(/\d+/g) || []).map(Number);
  const cmp = (a, b) => {
    const x = num(a), y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  ok(cmp(m[1], 'v1.0.11') >= 0, `版本應 >= v1.0.11，實際 ${m[1]}`);
});

t('F3 後端端點未被破壞（財報資料仍可取）', () => {
  ok(serverJs.includes("'/api/macro/'"), '後端 /api/macro/:symbol 端點不見了');
  ok(/getSymbolOverview/.test(serverJs), '後端不再呼叫 getSymbolOverview');
});

/* ============================================================ */

console.log('\n' + '='.repeat(56));
console.log(`  通過 ${pass}　失敗 ${fail}　共 ${pass + fail}`);
console.log('='.repeat(56));
if (fail) {
  console.log('\n失敗詳情：');
  for (const f of failures) console.log(`\n· ${f.name}\n  ${f.error.message}`);
}
process.exit(fail ? 1 : 0);
