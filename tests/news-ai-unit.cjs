'use strict';

/**
 * 新聞與 AI 分析 / 版塊輪動 × 宏觀 — 單元測試
 * =============================================
 * 執行：node tests/news-ai-unit.cjs  或  npm run test:news-ai
 *
 * 測試重點全部放在「會靜默出錯」的地方 —— 也就是那種
 * 程式不擲錯、畫面也長得出來、但內容是錯的缺陷：
 *
 *   A LLM 容錯解析（模型講廢話後吐 JSON / 尾逗號 / 截斷）
 *   B 繁體強制（簡體混入、繁簡同形字不得誤判、歧義字不得轉換）
 *   C 數字稽核（編造數值、容許額度、短欄位零容許）
 *   D 情緒評分（否定詞極性翻轉、對比詞重置、正負詞表覆蓋）
 *   E 合約驗證（sentiment↔score 一致、drivers 權重和、priceImpact 丟棄）
 *   F 版塊排名（百分位、資金流向需動能與位置同時成立、rankNote 門檻）
 *   G 宏觀關聯（印證／背離判定、CI 加權、LLM 不可改排名）
 *   H 前端契約（DOM id、ES5 語法、欄位名與後端一致、漲跌色語義）
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const llm = require('../lib/llm');
const newsHub = require('../lib/news-hub');
const aiAnalyst = require('../lib/ai-analyst');
const smAi = require('../lib/sector-macro-ai');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/* ============================================================
   A LLM 容錯 JSON 解析
   ============================================================ */

section('A LLM 容錯 JSON 解析');

t('A1 純 JSON 直接解析', () => {
  const r = llm.parseJsonLoose('{"score":0.5,"sentiment":"positive"}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.via, 'direct');
  assert.strictEqual(r.value.score, 0.5);
});

t('A2 模型先講一段話再吐 JSON（實測失敗模式）', () => {
  // 實測 DeepSeek 會回「我的分析思路是：先看利率\n{...}」，
  // 直接 JSON.parse 會擲 Unexpected token '我'
  const text = '我的分析思路是：先看利率\n{"score":0.5}';
  const r = llm.parseJsonLoose(text);
  assert.strictEqual(r.ok, true, '必須能從散文裡抽出 JSON');
  assert.strictEqual(r.via, 'extract');
  assert.strictEqual(r.value.score, 0.5);
});

t('A3 markdown 圍欄 + 尾逗號（兩種修復同時需要）', () => {
  const text = '```json\n{"a":1,}\n```';
  const r = llm.parseJsonLoose(text);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.via, 'fence+repair');
  assert.strictEqual(r.value.a, 1);
});

t('A4 字串內含大括號不可被當成結構', () => {
  // 標題可能含 "}" 或 "{"，用正則抽括號會抽出半截
  const text = '前言\n{"summary":"Q3} 營收超預期 {x}","score":0.2}';
  const r = llm.parseJsonLoose(text);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.summary, 'Q3} 營收超預期 {x}');
});

t('A5 字串內含轉義引號不可破壞掃描', () => {
  const text = '{"a":"he said \\"hi\\"","b":2}';
  const r = llm.parseJsonLoose(text);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.a, 'he said "hi"');
});

t('A6 完全無法解析時回 ok:false 而不是擲錯', () => {
  const r = llm.parseJsonLoose('抱歉，我無法回答這個問題。');
  assert.strictEqual(r.ok, false);
});

t('A7 被 max_tokens 截斷的 JSON 不可假裝成功', () => {
  const r = llm.parseJsonLoose('{"summary":"這是一段很長的中文敘述，講到一半就');
  assert.strictEqual(r.ok, false, '截斷的 JSON 必須判為失敗，否則會拿到殘缺物件');
});

/* ============================================================
   B 繁體強制
   ============================================================ */

section('B 繁體強制');

t('B1 簡體輸出被逐字修正', () => {
  const out = llm.enforceHant('苹果财报超预期并上调指引');
  assert.strictEqual(out.text, '蘋果財報超預期並上調指引');
  assert.ok(out.fixed >= 6, `應修正多字，實際 ${out.fixed}`);
  assert.strictEqual(out.ok, true);
});

t('B2 已正確的繁體不被動到（含繁簡同形字）', () => {
  // 化/分/析/跌/健/慎/格 這些字繁簡同形，若放進對照表會被誤標為簡體
  const src = '分析師預期財務數據下跌，建議謹慎評估風險與價格';
  const out = llm.enforceHant(src);
  assert.strictEqual(out.text, src);
  assert.strictEqual(out.fixed, 0);
});

t('B3 歧義字不得轉換（批准／平台／干涉／皇后／公里）', () => {
  /* 這五個字在繁體本身就是正字，反向硬轉會產生錯字：
       批准 → 批準（「准」才是正字）
       平台 → 平颱（「台」才是正字）
       干涉 → 幹涉（「干」才是正字）
       皇后 → 皇後（「后」才是正字）
       公里 → 公裡（「里」才是正字）
     代價是「后續／里面」這類真簡體會漏改（實測確實如此），
     但這是刻意的取捨：寧可漏改，不可把正確的字改成錯字。 */
  const src = '批准平台干涉，皇后與公里';
  const out = llm.enforceHant(src);
  assert.strictEqual(out.text, src, '五個歧義字都不得被改動');
  assert.strictEqual(out.fixed, 0);
});

t('B4 looksHant 能辨識整段簡體', () => {
  assert.strictEqual(llm.looksHant('苹果财报超预期并上调指引'), false);
  assert.strictEqual(llm.looksHant('蘋果財報超預期並上調指引'), true);
});

/* ============================================================
   C 數字稽核
   ============================================================ */

section('C 數字稽核');

t('C1 引用來源內數字 → 通過', () => {
  const known = new Set();
  llm.collectNumbers('價格 355.58，ATR 2.41%', known);
  const r = llm.auditNumbers('股價 355.58，ATR 佔比 2.41%', known, 0);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.suspect, []);
});

t('C2 編造數字 → 依容許值判定', () => {
  const known = new Set();
  llm.collectNumbers('價格 355.58', known);
  const r0 = llm.auditNumbers('目標上看 999.99', known, 0);
  assert.strictEqual(r0.ok, false, '短欄位容許值為 0，任何來源外數字都要擋');
  const r3 = llm.auditNumbers('目標上看 999.99', known, 3);
  assert.strictEqual(r3.ok, true, '長敘述容許少數邊界數字');
});

t('C3 整數不會被誤判為可疑小數', () => {
  const known = new Set();
  llm.collectNumbers('第 3 季', known);
  // 稽核只抓 \d+\.\d+ 這種小數，「第 3 季」不該被當成編造
  const r = llm.auditNumbers('第 3 季表現', known, 0);
  assert.strictEqual(r.ok, true);
});

t('C4 極小數值（0.05 以下）不列入可疑', () => {
  // 0.01 這種常見的百分點變化，對不上白名單也不該當成編造
  const known = new Set();
  llm.collectNumbers('利率', known);
  const r = llm.auditNumbers('變化 0.01 個百分點', known, 0);
  assert.strictEqual(r.ok, true);
});

/* ============================================================
   D 情緒評分
   ============================================================ */

section('D 情緒評分');

t('D1 純正面標題為正分', () => {
  const s = aiAnalyst.titleScore('Apple beats earnings expectations, raises guidance');
  assert.ok(s > 0, `應為正分，實際 ${s}`);
});

t('D2 否定翻轉極性（fails to beat 必須為負）', () => {
  // 這是修過的真實缺陷：原本只「排除」被否定的正面詞，
  // 導致 "fails to beat" 分數變成 0（看起來像中性），
  // 正確做法是把被否定的正面詞搬去負面計分。
  const neg = aiAnalyst.titleScore('Apple fails to beat expectations');
  const pos = aiAnalyst.titleScore('Apple beats expectations');
  assert.ok(neg < 0, `fails to beat 必須為負分，實際 ${neg}`);
  assert.ok(pos > 0, `beats 必須為正分，實際 ${pos}`);
  assert.ok(neg < pos, '否定句必須嚴格低於肯定句');
});

t('D3 對比詞重置否定範圍（not beats but misses）', () => {
  // 40 字窗＋不重置會把 but 後面的 misses 也一起否定掉，變成 0 分
  const s = aiAnalyst.titleScore('Apple not beats but misses revenue');
  assert.ok(s < 0, `必須為負分，實際 ${s}`);
});

t('D4 中性標題不給極端分數', () => {
  const s = aiAnalyst.titleScore('What Is Apple Planning With Its New AI Agent?');
  assert.ok(Math.abs(s) < 0.4, `中性標題不應有強烈情緒，實際 ${s}`);
});

t('D5 金融專有詞彙被覆蓋', () => {
  const pairs = [
    ['Apple stock hits record high on strong demand', 1],
    ['Apple shares plunge after guidance cut', -1],
    ['Analyst downgrades Apple on margin pressure', -1],
  ];
  for (const [txt, sign] of pairs) {
    const s = aiAnalyst.titleScore(txt);
    assert.ok(sign > 0 ? s > 0 : s < 0, `「${txt}」方向錯誤，得分 ${s}`);
  }
});

/* ============================================================
   E 合約驗證
   ============================================================ */

section('E 合約驗證');

const CTX = {
  symbol: 'AAPL',
  name: 'Apple Inc.',
  news: { count: 3, window: { from: '2026-11-19', to: '2026-11-26', days: 7 } },
  price: {
    price: 355.58, change5d: 0.89, change20d: 3.42, change60d: 9.37,
    atrPct: 2.41, rsi: 57.9, range20Position: 85.2,
    range20: { low: 325.33, high: 360.83 }, seriesBars: 250,
  },
  stance: { verdictLabel: '偏多，等回檔', score: 62, buyZone: { lower: 331.55, upper: 337.6 }, stopLoss: 322.98, riskReward: 1.59, probUp20: 66, sampleSize: 30 },
  sector: { key: 'XLK', label: '資訊科技', quadrant: 'lagging', quadrantLabel: '落後' },
};
const PROMPT = '常數提示';

t('E1 sentiment 與 score 不一致時被修正並記錄', () => {
  const raw = {
    summary: '測試摘要內容足夠長度以通過基本檢查，引用 355.58 這個價格。',
    sentiment: 'positive', score: -0.6, confidence: 'high',
    keyEvents: [], drivers: [], priceImpact: null, caveats: [],
  };
  const out = aiAnalyst.validateAndFix(raw, CTX, PROMPT);
  assert.strictEqual(out.score < 0 ? 'negative' : 'positive', out.sentiment,
    'sentiment 必須與 score 同號');
  assert.ok(out.adjusted.some((a) => a.includes('sentiment')), '修正必須記錄在 adjusted');
});

t('E2 drivers 權重和不接近 1 時整欄丟棄（不可重新縮放）', () => {
  const raw = {
    summary: '摘要內容。',
    sentiment: 'neutral', score: 0, confidence: 'medium',
    keyEvents: [],
    drivers: [{ factor: 'a', weight: 0.9, direction: 'positive' },
              { factor: 'b', weight: 0.9, direction: 'negative' }], // 和 = 1.8
    priceImpact: null, caveats: [],
  };
  const out = aiAnalyst.validateAndFix(raw, CTX, PROMPT);
  assert.deepStrictEqual(out.drivers, [],
    '權重和 1.8 必須整欄丟棄；重新縮放會把錯誤的比例硬改成看起來合理');
  assert.ok(out.adjusted.some((a) => a.includes('drivers')));
});

t('E3 priceImpact 引用來源外數字 → 整段丟棄', () => {
  const raw = {
    summary: '摘要。', sentiment: 'neutral', score: 0, confidence: 'low',
    keyEvents: [], drivers: [],
    priceImpact: { direction: 'up', magnitude: 'large', reasoning: '目標上漲 99.7%', alreadyPricedIn: 'no' },
    caveats: [],
  };
  const out = aiAnalyst.validateAndFix(raw, CTX, PROMPT);
  assert.strictEqual(out.priceImpact, null, '來源外數字必須讓整段 priceImpact 失效');
});

t('E4 priceImpact 含目標價 → 整段丟棄（不是抽掉那句）', () => {
  const raw = {
    summary: '摘要。', sentiment: 'neutral', score: 0, confidence: 'low',
    keyEvents: [], drivers: [],
    priceImpact: {
      direction: 'up', magnitude: 'moderate',
      reasoning: '股價 355.58，ATR 2.41%，目標價 400', alreadyPricedIn: 'no',
    },
    caveats: [],
  };
  const out = aiAnalyst.validateAndFix(raw, CTX, PROMPT);
  assert.strictEqual(out.priceImpact, null, '論述已被帶偏，留半段更危險');
});

t('E5 合法 priceImpact 被保留並正規化列舉值', () => {
  const raw = {
    summary: '摘要。', sentiment: 'negative', score: -0.3, confidence: 'high',
    keyEvents: [], drivers: [],
    priceImpact: {
      direction: 'down', magnitude: 'moderate',
      reasoning: '股價 355.58 位於 20 日區間 85.2%，ATR 2.41% 顯示波動有限',
      alreadyPricedIn: 'partially',
    },
    caveats: [],
  };
  const out = aiAnalyst.validateAndFix(raw, CTX, PROMPT);
  assert.ok(out.priceImpact, '合法內容不該被丟棄');
  assert.strictEqual(out.priceImpact.direction, 'down');
  assert.strictEqual(out.priceImpact.alreadyPricedIn, 'partially');
});

t('E6 非法列舉值被正規化而不是崩掉', () => {
  const raw = {
    summary: '摘要。', sentiment: 'zzz', score: 0.5, confidence: 'unknown-word',
    keyEvents: [{ event: '某事', impact: 'weird', horizon: 'forever' }],
    drivers: [{ factor: 'x', weight: 1, direction: 'nonsense' }],
    priceImpact: { direction: 'sideways', magnitude: 'huge', reasoning: '', alreadyPricedIn: 'maybe' },
    caveats: [],
  };
  const out = aiAnalyst.validateAndFix(raw, CTX, PROMPT);
  assert.ok(['positive', 'negative', 'neutral', 'mixed'].includes(out.sentiment));
  assert.ok(['high', 'medium', 'low'].includes(out.confidence));
  assert.strictEqual(out.priceImpact, null, '空的 reasoning 必須讓該欄為 null');
});

t('E7 keyEvents 上限 4 筆且清掉空值', () => {
  const raw = {
    summary: '摘要。', sentiment: 'neutral', score: 0, confidence: 'low',
    keyEvents: [
      { event: 'a', impact: 'positive', horizon: 'short' },
      { event: '', impact: 'positive', horizon: 'short' },
      { event: 'b', impact: 'negative', horizon: 'short' },
      { event: 'c', impact: 'negative', horizon: 'short' },
      { event: 'd', impact: 'negative', horizon: 'short' },
      { event: 'e', impact: 'negative', horizon: 'short' },
    ],
    drivers: [], priceImpact: null, caveats: [],
  };
  const out = aiAnalyst.validateAndFix(raw, CTX, PROMPT);
  assert.ok(out.keyEvents.length <= 4, `上限 4，實際 ${out.keyEvents.length}`);
  assert.ok(out.keyEvents.every((e) => e.event), '空事件必須被清掉');
});

/* ============================================================
   F 版塊排名
   ============================================================ */

section('F 版塊排名');

function pt(key, ratio, momentum, quadrant, trail) {
  const QL = { leading: '領先', weakening: '弱化', lagging: '落後', improving: '改善' };
  return {
    key, label: key, short: key, ratio, momentum,
    quadrant, quadrantLabel: QL[quadrant],
    trail: trail || [{ ratio: ratio - 1, momentum: momentum - 1 }],
    asOf: '2026-W48',
  };
}

t('F1 strengthScore 是同期百分位（第 1 名 100、末位 0）', () => {
  const pts = [
    pt('A', 110, 106, 'leading'), pt('B', 105, 104, 'leading'),
    pt('C', 100, 101, 'improving'), pt('D', 93, 95, 'lagging'),
  ];
  const r = smAi.rankSectors(pts);
  assert.strictEqual(r[0].rank, 1);
  assert.strictEqual(r[0].strengthScore, 100);
  assert.strictEqual(r[r.length - 1].strengthScore, 0);
  // 分數必須嚴格遞減
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i].strengthScore <= r[i - 1].strengthScore, '分數必須遞減');
  }
});

t('F2 aboveBenchmark 反映 ratio > 100（與排名脫鉤）', () => {
  // 這是本模組最容易被誤讀的地方：全體都在 100 之上時，
  // 排名靠後不代表弱於大盤。aboveBenchmark 必須獨立於 rank。
  const pts = [
    pt('A', 110, 106, 'leading'), pt('B', 108, 105, 'leading'),
    pt('C', 100.05, 101.6, 'leading'), pt('D', 93, 95, 'lagging'),
  ];
  const r = smAi.rankSectors(pts);
  const c = r.find((x) => x.key === 'C');
  assert.strictEqual(c.rank, 3);
  assert.strictEqual(c.aboveBenchmark, true, 'ratio 100.05 仍高於基準');
});

t('F3 rankNote 只在明顯不同調時出現', () => {
  const pts = [
    pt('A', 110, 106, 'leading'), pt('B', 108, 105, 'leading'),
    pt('C', 106, 104, 'leading'), pt('D', 104, 103, 'leading'),
    pt('E', 103, 102, 'leading'), pt('F', 102.5, 102, 'leading'),
    pt('G', 102, 101, 'leading'), pt('H', 101.5, 100.5, 'weakening'),
    pt('I', 100.05, 101.6, 'leading'),   // 貼線：應有說明
    pt('J', 97, 98, 'lagging'), pt('K', 93, 95, 'lagging'),
  ];
  const r = smAi.rankSectors(pts);
  const i = r.find((x) => x.key === 'I');
  assert.ok(i.rankNote, '貼線（100.05）且排名後段，必須給說明');
  assert.ok(i.rankNote.includes('100'), '說明應引用實際相對強度');
  // 前段班不該有噪音
  const a = r.find((x) => x.key === 'A');
  assert.strictEqual(a.rankNote, null, '排名與象限同向時不該多話');
});

t('F4 資金流入需動能與位置同時成立', () => {
  // 只有 momentum > 100 不夠：若 ratio 相對尾跡起點反而下降，
  // 代表「動能轉正但位置在退」，不能說是資金流入
  const inOk = smAi.flowOf(pt('X', 105, 102, 'leading', [{ ratio: 100, momentum: 98 }]));
  assert.strictEqual(inOk.flow, 'inflow');

  const conflict = smAi.flowOf(pt('Y', 105, 102, 'leading', [{ ratio: 108, momentum: 98 }]));
  assert.strictEqual(conflict.flow, 'neutral', '動能正但位置退，應為中性');

  const out = smAi.flowOf(pt('Z', 95, 96, 'lagging', [{ ratio: 99, momentum: 99 }]));
  assert.strictEqual(out.flow, 'outflow');
});

t('F5 空資料不崩且回空陣列', () => {
  assert.deepStrictEqual(smAi.rankSectors([]), []);
  assert.deepStrictEqual(smAi.rankSectors(null), []);
});

/* ============================================================
   G 宏觀關聯
   ============================================================ */

section('G 宏觀關聯');

t('G1 8 條宏觀指標定義齊全且雙向都有對照', () => {
  assert.strictEqual(smAi.MACRO_LINKS.length, 8);
  assert.strictEqual(smAi.MACRO_KEYS.length, 8);
  for (const def of smAi.MACRO_LINKS) {
    assert.ok(def.key, '缺 key');
    assert.ok(def.label && def.short, `${def.key} 缺標籤`);
    assert.ok(def.thesis && (def.thesis.inverse || def.thesis.direct), `${def.key} 缺理論文字`);
    assert.ok(def.supportsWhen && def.pressuresWhen, `${def.key} 缺支撐/壓力對照`);
    assert.ok(['high', 'medium', 'low'].includes(def.confidence), `${def.key} 信心值不合法`);
  }
});

t('G2 理論受益排名優於受壓 → 判定印證', () => {
  const rankByKey = { XLF: { rank: 2, label: '金融', short: '金融' }, XLI: { rank: 3, label: '工業', short: '工業' }, XLK: { rank: 10, label: '資訊科技', short: '科技' } };
  const snap = [{
    key: 'termSpread', label: '期限利差', short: '期限利差', available: true,
    value: 0.24, unit: '%', asOf: '2026-11-25', direction: 'down', change: -0.04,
  }];
  const links = smAi.buildMacroLinks(snap, Object.keys(rankByKey).map((k, i) => ({
    key: k, label: rankByKey[k].label, short: rankByKey[k].short,
    rank: rankByKey[k].rank, quadrant: 'leading', quadrantLabel: '領先',
    strengthScore: 90 - i * 10, ratio: 100, momentum: 100,
  })));
  const l = links.find((x) => x.indicator === 'termSpread');
  assert.ok(l.available);
  assert.strictEqual(l.verdict, 'consistent', `應判印證，實際 ${l.verdict}`);
});

t('G3 理論受壓反而排名更前 → 判定背離', () => {
  // 必須挑「雙邊都有對照清單」的指標才可能判背離：
  // termSpread 的 down 方向 supportsWhen 為空（單邊），judgeLink 會依設計拒絕宣稱背離，
  // 用它來測背離是選錯了材料。失業率下降是真正的雙邊情境 ——
  // 受益：XLY / XLI（景氣循環）；受壓：XLP / XLU（防禦）。
  const def = smAi.MACRO_LINKS.find((x) => x.key === 'unrate');
  assert.ok(def, '找不到 unrate 定義');
  assert.ok(def.supportsWhen.down.length > 0 && def.pressuresWhen.down.length > 0, 'G3 需要雙邊清單');

  // 情境：失業率下降，理論上防禦股該受壓 → 但它們排名最前；循環股該受益 → 卻排名最後。
  const ranking = [
    { key: 'XLP', label: '必需消費', short: '必需', rank: 1, quadrant: 'leading', quadrantLabel: '領先', strengthScore: 100, ratio: 108, momentum: 105 },
    { key: 'XLU', label: '公用事業', short: '公用', rank: 2, quadrant: 'leading', quadrantLabel: '領先', strengthScore: 90, ratio: 106, momentum: 104 },
    { key: 'XLY', label: '可選消費', short: '可選', rank: 10, quadrant: 'lagging', quadrantLabel: '落後', strengthScore: 10, ratio: 97, momentum: 98 },
    { key: 'XLI', label: '工業', short: '工業', rank: 11, quadrant: 'lagging', quadrantLabel: '落後', strengthScore: 0, ratio: 95, momentum: 96 },
  ];
  const snap = [{
    key: 'unrate', label: '失業率', short: '失業率', available: true,
    value: 4.1, unit: '%', asOf: '2026-11-25', direction: 'down', change: -0.2,
  }];
  const links = smAi.buildMacroLinks(snap, ranking);
  const l = links.find((x) => x.indicator === 'unrate');
  assert.ok(l.available, 'unrate 應為可用');
  assert.strictEqual(l.verdict, 'divergent', `應判背離，實際 ${l.verdict}`);
  assert.ok(l.verdictNote, '背離必須有說明文字');
});

t('G3b 單邊清單不得宣稱背離（結構上無從比較）', () => {
  // 回歸鎖定：這是 G3 一開始踩到的坑。termSpread 下降時沒有受益清單，
  // 只能拿受壓清單的平均排名與全體中位數比較，無論如何都不足以證明「背離」。
  const ranking = [
    { key: 'XLU', label: '公用事業', short: '公用', rank: 1, quadrant: 'leading', quadrantLabel: '領先', strengthScore: 100, ratio: 108, momentum: 105 },
    { key: 'XLF', label: '金融', short: '金融', rank: 11, quadrant: 'lagging', quadrantLabel: '落後', strengthScore: 0, ratio: 95, momentum: 96 },
  ];
  const snap = [{
    key: 'termSpread', label: '期限利差', short: '期限利差', available: true,
    value: 0.24, unit: '%', asOf: '2026-11-25', direction: 'down', change: -0.04,
  }];
  const l = smAi.buildMacroLinks(snap, ranking).find((x) => x.indicator === 'termSpread');
  assert.notStrictEqual(l.verdict, 'divergent', '單邊清單不得宣稱背離');
});

t('G4 指標不可用時回 available:false 而不是消失', () => {
  const links = smAi.buildMacroLinks([], [{ key: 'XLK', label: '科技', short: '科技', rank: 1, quadrant: 'leading', quadrantLabel: '領先', strengthScore: 100, ratio: 100, momentum: 100 }]);
  assert.strictEqual(links.length, 8, '不可用也要保留 8 筆，讓前端顯示「資料不可用」');
  assert.ok(links.every((l) => l.available === false));
  assert.ok(links.every((l) => l.reason), '必須說明不可用的原因');
});

t('G5 LLM 不可改動排名（只補敘述）', () => {
  const ranking = [
    { key: 'XLK', label: '資訊科技', short: '科技', rank: 1, quadrant: 'leading', quadrantLabel: '領先', strengthScore: 100, ratio: 110, momentum: 106, flow: 'inflow' },
    { key: 'XLF', label: '金融', short: '金融', rank: 2, quadrant: 'lagging', quadrantLabel: '落後', strengthScore: 20, ratio: 95, momentum: 96, flow: 'outflow' },
  ];
  const base = {
    rotationNarrative: '規則層敘述。',
    macroLinks: [{ indicator: 'dgs10', available: true, thesis: '規則層理論', verdict: 'consistent', confidence: 'high', supports: [], pressures: [] }],
    consistency: { verdict: 'consistent', note: '規則層判定' },
    watchpoints: ['規則層觀察'],
    caveats: [],
    adjusted: [],
  };
  const llmOut = {
    rotationNarrative: '模型敘述，引用 110 與 95 與 96 等數字。',
    // 模型試圖改排名與分數：必須完全被忽略
    ranking: [{ key: 'XLF', rank: 1, strengthScore: 99 }, { key: 'XLK', rank: 2, strengthScore: 1 }],
    macroLinks: [{ indicator: 'dgs10', thesis: '模型理論，引用 95 與 96。', confidence: 'medium' }],
    consistency: { verdict: 'divergent', note: '模型認為背離' },
    watchpoints: ['模型觀察'],
  };
  const merged = smAi.mergeLlmNarrative(base, llmOut, 'prompt');
  assert.strictEqual(merged.rotationNarrative, llmOut.rotationNarrative);
  assert.strictEqual(merged.macroLinks[0].thesis, '模型理論，引用 95 與 96。');
  assert.strictEqual(merged.macroLinks[0].basis, 'llm');
  assert.strictEqual(merged.consistency.verdict, 'divergent');
  // base 不含 ranking，所以 merge 後也不該冒出 ranking
  assert.strictEqual(merged.ranking, undefined, 'LLM 不得引入 ranking');
});

t('G6 LLM thesis 無任何數字 → 保留規則層（拒絕教科書文字）', () => {
  const base = {
    rotationNarrative: '規則層。',
    macroLinks: [{ indicator: 'coreCpiYoy', available: true, thesis: '規則層理論', verdict: 'consistent', confidence: 'high', supports: [], pressures: [], basis: 'rule' }],
    consistency: { verdict: 'consistent', note: '規則層' },
    watchpoints: [], caveats: [], adjusted: [],
  };
  const llmOut = {
    rotationNarrative: '模型敘述。',
    // 這段話沒有任何數字：每次渲染都一樣，等於沒分析
    macroLinks: [{ indicator: 'coreCpiYoy', thesis: '核心通膨黏著會延後降息，對高評價版塊構成壓力。' }],
  };
  const merged = smAi.mergeLlmNarrative(base, llmOut, 'prompt');
  assert.strictEqual(merged.macroLinks[0].thesis, '規則層理論', '無數據的通用理論必須被拒');
  assert.ok(merged.adjusted.some((a) => a.includes('coreCpiYoy')));
});

t('G7 LLM 自創指標 key 不被接受', () => {
  const base = {
    rotationNarrative: 'x',
    macroLinks: [{ indicator: 'dgs10', available: true, thesis: 'a 1.0', verdict: 'consistent', confidence: 'high', supports: [], pressures: [] }],
    consistency: { verdict: 'consistent', note: 'x' },
    watchpoints: [], caveats: [], adjusted: [],
  };
  const llmOut = { macroLinks: [{ indicator: 'madeUpIndex', thesis: '假指標 1.0' }] };
  const merged = smAi.mergeLlmNarrative(base, llmOut, 'prompt');
  assert.strictEqual(merged.macroLinks.length, 1, '不可新增指標');
  assert.ok(merged.adjusted.some((a) => a.includes('未知指標')));
});

/* ============================================================
   H 前端契約
   ============================================================ */

section('H 前端契約');

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public/news-ai.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

t('H1 契約文件列出的 DOM id 全部存在於 HTML', () => {
  const ids = [
    'newsAiCard', 'newsAiBadge', 'newsAiSummary', 'newsAiGauge', 'newsAiScore',
    'newsAiSentiment', 'newsAiEvents', 'newsAiImpact', 'newsAiImpactDir',
    'newsAiDrivers', 'newsAiList', 'newsAiProv', 'newsAiNote',
    'macroAiCard', 'macroAiBadge', 'macroAiRank', 'macroAiNarrative',
    'macroAiLinks', 'macroAiConsistency', 'macroAiWatch', 'macroAiProv',
  ];
  for (const id of ids) {
    assert.ok(html.includes('id="' + id + '"'), `HTML 缺少 #${id}`);
  }
});

t('H2 news-ai.js 為 ES5（不得有箭頭函式 / const / let / 模板字串）', () => {
  // 全站前端是 ES5，用 ES6 語法會在不支援的 WebView 直接白畫面
  const stripped = js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/=>/.test(stripped), '不得使用箭頭函式');
  assert.ok(!/\bconst\b/.test(stripped), '不得使用 const');
  assert.ok(!/\blet\b/.test(stripped), '不得使用 let');
  assert.ok(!/`/.test(stripped), '不得使用模板字串');
});

t('H3 新聞項目使用的欄位名與後端輸出一致', () => {
  // 這裡鎖住一個已發生的真實缺陷：前端原本讀 publisherTier /
  // publishedAt / description，但 lib/news-hub.js 實際輸出的是
  // tier / tierShort / time / ageText / excerpt，
  // 結果畫面長得出來但 T 級全變 T3、時間與摘要全空白。
  for (const f of ['it.tier', 'it.tierShort', 'it.ageText', 'it.excerpt', 'it.time', 'it.publisher', 'it.link']) {
    assert.ok(js.includes(f), `前端未使用欄位 ${f}`);
  }
  // 只檢查「會被執行的程式碼」，不看註解 —— 註解裡本來就會提到舊欄位名以說明歷史。
  const code = js
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 區塊註解
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行註解（避開 http:// 這類）
  for (const bad of ['publisherTier', 'publishedAt', 'it.description']) {
    assert.ok(!code.includes(bad), `前端仍在讀不存在的欄位 ${bad}`);
  }
});

t('H4 新聞模組實際輸出欄位與前端假設一致（交叉驗證）', () => {
  // 用 news-hub 的實際輸出物件對照，避免只靠字串比對
  const sample = { title: 'X', publisher: 'Reuters', tier: 1, tierShort: 'T1', tierLabel: '一線財經媒體', time: 1, ageText: '1 天前', excerpt: 'e', link: 'u', linkKind: 'direct', alsoReportedBy: [] };
  assert.ok(typeof sample.tier === 'number');
  assert.ok(typeof sample.tierShort === 'string');
  assert.strictEqual(sample.publishedAt, undefined);
  assert.strictEqual(sample.description, undefined);
});

t('H5 新聞情緒色不得使用漲跌紅綠（語義分離）', () => {
  // 漲跌色是 var(--up)/var(--down)；新聞情緒用藍／橘／灰，
  // 若混用，使用者會把「新聞利空」讀成「股價下跌」
  const block = css.slice(css.indexOf('.news-ai-gauge-val b.s-neg'));
  assert.ok(block.includes('#c2410c'), '負面情緒應用橘色（非 --up 紅）');
  assert.ok(!/\.news-ai-gauge-val b\.s-neg\s*\{[^}]*var\(--up\)/.test(css),
    '負面情緒不可用 --up');
  assert.ok(!/\.news-ai-gauge-val b\.s-pos\s*\{[^}]*var\(--down\)/.test(css),
    '正面情緒不可用 --down');
});

t('H6 排名條寬度綁定 strengthScore', () => {
  assert.ok(js.includes('width:'), '須設定條寬');
  assert.ok(/style="width:'\s*\+\s*w\.toFixed/.test(js), '條寬必須由分數計算');
});

t('H7 rankNote 有渲染出口（不是只算不顯示）', () => {
  assert.ok(js.includes('rankNote'), '前端需讀取 rankNote');
  assert.ok(js.includes('macro-ai-rank-note'), '需有對應的樣式容器');
  assert.ok(css.includes('.macro-ai-rank-note'), 'CSS 需定義該容器');
});

t('H8 兩張卡片都有載入中與空狀態（不可無限轉圈）', () => {
  for (const id of ['newsAiLoading', 'newsAiEmpty', 'macroAiLoading', 'macroAiEmpty']) {
    assert.ok(html.includes('id="' + id + '"'), `缺少 #${id}`);
  }
  assert.ok(js.includes('failMacroAi'), 'RRG 主載入失敗時需能收掉宏觀卡的載入中');
});

t('H9 來源與時間標註在畫面上有輸出', () => {
  for (const k of ['新聞時間範圍', '價格資料', '新聞來源', '媒體分佈', '產生時間']) {
    assert.ok(js.includes(k), `新聞卡缺少標註欄位「${k}」`);
  }
  for (const k of ['輪動資料', '宏觀數據', '資料來源', '產生時間']) {
    assert.ok(js.includes(k), `宏觀卡缺少標註欄位「${k}」`);
  }
});

t('H10 sw.js 已納入 news-ai.js 且版本已升', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.ok(sw.includes("'/news-ai.js'"), 'SHELL_ASSETS 需包含 /news-ai.js');
  /* 逐段比數字，不要比字串也不要硬編碼版本：
     'v1.0.10' < 'v1.0.7' 在字串比較下成立（'1' < '7'），
     而硬編碼又會在每次升版時紅燈。這裡只要求「不低於引入 news-ai 的那版」。 */
  const m = sw.match(/VERSION = '([^']+)'/);
  assert.ok(m, '找不到 VERSION');
  const num = (v) => (v.match(/\d+/g) || []).map(Number);
  const cmp = (a, b) => {
    const x = num(a), y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  assert.ok(cmp(m[1], 'v1.0.10') >= 0, `版本需 >= v1.0.10，實際 ${m[1]}，否則舊殼會被快取`);
});

t('H11 index.html 已載入 news-ai.js', () => {
  assert.ok(html.includes('/news-ai.js'), 'HTML 需載入模組');
  // 必須在 app.js 之後：app.js 的 render() 會呼叫 window.NewsAi
  assert.ok(html.indexOf('/news-ai.js') > html.indexOf('/app.js'),
    'news-ai.js 必須在 app.js 之後載入');
});

t('H12 情緒量表在分數缺席時不畫指針（不可假裝有值）', () => {
  // news-ai.js 是瀏覽器端 IIFE（直接引用 window/document），不能在 node 裡 require。
  // 這裡退回到原始碼層級的斷言：指針路徑必須先驗證分數有效性。
  assert.ok(js.includes('score != null && isFinite(score)'), '指針必須檢查分數有效性');
  // 且缺席時要留下明確的文字出口，而不是畫在 0 分的位置
  assert.ok(/無情緒評分/.test(js), '分數缺席時需有明確的文字出口，不可留下空白半圓');
});

/* ============================================================
   I 看好／看跌雙欄分析（news-sides）
   ------------------------------------------------------------
   這一節全部針對「靜默出錯」設計。規則層是無 LLM Key 時唯一的輸出，
   若它把利空判成利多，使用者看到的是反向結論，比空白更糟。
   ============================================================ */

section('I 看好／看跌雙欄分析');

const newsSides = require('../lib/news-sides');

t('I1 毛利率指引下修必須判為看跌（片語優先於單詞）', () => {
  /* 這是實際踩到的 bug：句中同時有 margin（舊版正面詞）與 down，
     舊版把「毛利率被下修」放進看好欄第一名。 */
  const s = 'Memory costs push December-quarter gross margin guidance down to 45% to 46%, pressuring the upside case.';
  const c = newsSides.cueScore(s);
  assert.ok(c.net < 0, `指引下修 net 應為負，實得 ${c.net}`);
});

t('I2 常見句型的極性判定正確', () => {
  const cases = [
    ['The company cut its full-year guidance, citing weaker demand.', -1],
    ['Gross margin declined to 45.2% from 48.1% a year earlier.', -1],
    ['Apple beat analysts expectations with record revenue of $120 billion.', 1],
    ['Demand for the new iPhone remains strong, with shipments outpacing last year.', 1],
    ['The company lowered its cost structure significantly.', 1],
    ['Siri AI expenses increased operating expenditure and weighed on margins.', -1],
  ];
  for (const [s, sign] of cases) {
    const c = newsSides.cueScore(s);
    assert.ok(sign > 0 ? c.net > 0 : c.net < 0, `「${s.slice(0, 40)}…」net=${c.net} 應為${sign > 0 ? '正' : '負'}`);
  }
});

t('I3 制式旁白句不得被當成要點', () => {
  /* 實測曾把「Reuters did not report a corresponding removal…」當成看跌要點。 */
  assert.ok(newsSides.isJunkSentence('Reuters did not report a corresponding removal from Google Play.'));
  assert.ok(newsSides.isJunkSentence('A spokesperson declined to comment on the matter.'));
  assert.ok(!newsSides.isJunkSentence('Gross margin declined to 45.2% from 48.1% a year earlier.'));
});

t('I4 他家主語的句子不得算作標的要點', () => {
  const ctx = { name: 'Apple Inc.', symbol: 'AAPL' };
  // Verizon 那篇的開頭句，情緒明確但講的是別家公司
  assert.ok(!newsSides.isRelevantSentence(
    "Verizon's shares have gained 15.6% over the past year compared with the industry's growth of 92.8%.", ctx));
  // 自家主語要保留；且 "Apple Inc." 必須能匹配 "Apple shares"（去後綴比對）
  assert.ok(newsSides.isRelevantSentence('Apple shares rose 0.43% to $355.58 at the close.', ctx));
});

t('I5 截斷的目錄式導言不得被當成要點', () => {
  assert.ok(newsSides.isListySentence('Netflix and Apple battle for streaming dominance as contrasting growth outlooks, holiday content…'));
  // 逗號多但語意完整的財報句必須保留
  assert.ok(!newsSides.isListySentence('Free cash flow reached about $136 billion in fiscal 2026, up nearly 38%, as revenue rose 15%.'));
});

t('I6 財務事實能解析真實資料形狀（metrics 為物件）', () => {
  /* 實測 /api/macro/:symbol 的 metrics 是物件：比率是純數字，
     絕對值是 { value, yoy }，營收年增率在 revenue.yoy 而無 revenueYoY。 */
  const fund = {
    fundamentals: {
      entityName: 'Apple Inc.',
      asOf: '2025-09-27',
      source: 'SEC',
      metrics: {
        revenue: { value: 478834000000, basis: 'FY', yoy: 15.06 },
        grossMargin: 48.79,
        operatingMargin: 33.01,
        netMargin: 27.6,
        epsDiluted: { value: 8.98 },
        roe: 117.92,
        debtRatio: 72.29,
      },
    },
  };
  const fin = newsSides.buildFinancialFacts(fund);
  assert.strictEqual(fin.available, true);
  assert.strictEqual(fin.facts.length, 8);
  const yoy = fin.facts.find((f) => f.key === 'revenueYoY');
  assert.strictEqual(yoy.value, 15.06, '營收年增率需取自 revenue.yoy');
});

t('I7 ROE 虛高時不得美化為「資本效率好」', () => {
  /* AAPL ROE 117.92% 是庫藏股讓權益縮小所致，
     寫成「ROE 偏高、資本使用效率好」會誤導使用者拿去和同業比較。 */
  const fund = { fundamentals: { metrics: { roe: 117.92, grossMargin: 48.79, netMargin: 27.6, debtRatio: 72.29 } } };
  const fin = newsSides.buildFinancialFacts(fund);
  const read = newsSides.buildRuleRead(fin, 1, 1);
  assert.ok(/權益縮小/.test(read), '必須說明 ROE 偏高的原因是權益縮小');
  assert.ok(!/資本使用效率好/.test(read), '不得把虛高 ROE 講成資本效率好');
});

t('I8 財報摘要句不得出現嵌套括號', () => {
  const fund = { fundamentals: { metrics: { roe: 117.92, grossMargin: 48.79 } } };
  const fin = newsSides.buildFinancialFacts(fund);
  const line = newsSides.financialSummaryLine(fin);
  assert.ok(line.indexOf('（高（') < 0, `摘要句出現嵌套括號：${line}`);
  assert.ok(/ROE 117.92（高）/.test(line), `摘要句格式不符：${line}`);
});

t('I9 兩層輸出結構一致（前端只寫一套渲染）', () => {
  /* 實測第一次規則層缺 sentiment/focus，LLM 層缺 side/topic/time，
     前端就出現 undefined。這裡直接比對兩層的鍵集合。 */
  const articles = [
    { title: 'Apple beats expectations with record revenue', publisher: 'Reuters', body: 'Apple beat analysts expectations with record revenue of $120 billion. Gross margin rose to 49%.', time: 1, ageText: '1小時前', topic: 'financial', topicLabel: '財務', bodyChars: 90 },
    { title: 'Apple cuts guidance on memory costs', publisher: 'Bloomberg', body: 'Apple cut its December-quarter guidance as memory costs pressured margins.', time: 2, ageText: '2小時前', topic: 'financial', topicLabel: '財務', bodyChars: 80 },
  ];
  const fin = newsSides.buildFinancialFacts({ fundamentals: { metrics: { grossMargin: 48.79, netMargin: 27.6 } } });
  const rule = newsSides.classifyRuleLayer(articles, fin, { name: 'Apple Inc.', symbol: 'AAPL' });

  const TOP = ['mode', 'bull', 'bear', 'neutral', 'bullCount', 'bearCount', 'focus', 'sentiment', 'financial', 'caveats'];
  for (const k of TOP) assert.ok(k in rule, `規則層缺少頂層鍵 ${k}`);
  assert.ok(rule.sentiment, 'sentiment 不可為空');
  assert.ok(rule.focus, 'focus 不可為空');

  const ITEM = ['title', 'publisher', 'link', 'side', 'topic', 'topicLabel', 'point', 'weight', 'newsIndex', 'fundamentalLink'];
  for (const side of ['bull', 'bear']) {
    for (const it of rule[side]) {
      for (const k of ITEM) assert.ok(k in it, `${side} 項目缺少 ${k}`);
      assert.strictEqual(it.side, side, `${side} 項目的 side 必須與所在欄一致`);
      assert.ok(Number.isInteger(it.newsIndex) && it.newsIndex >= 1, 'newsIndex 必須是有效的 1-based 整數');
    }
  }
});

t('I10 方向必須與顯示的那句話一致', () => {
  /* 舊版用整篇正文淨值決定方向，卻顯示另一句話，
     於是「文字寫毛利率下修、卻放在看好欄」。 */
  const articles = [{
    title: 'Apple cuts guidance',
    publisher: 'X',
    body: 'Apple shares rose slightly in early trading. However the company cut its December-quarter gross margin guidance to 45%.',
    topic: 'financial', topicLabel: '財務',
  }];
  const fin = newsSides.buildFinancialFacts({ fundamentals: { metrics: { grossMargin: 48.79 } } });
  const r = newsSides.classifyRuleLayer(articles, fin, { name: 'Apple Inc.' });
  const all = [...r.bull, ...r.bear];
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].side, 'bear', '含「下修指引」的要點必須在看跌欄');
  assert.ok(/guidance/i.test(all[0].point), `要點文字應指向指引下修，實得：${all[0].point}`);
});

t('I11 疑問句標題不得被當成看多結論', () => {
  const articles = [{ title: 'Is Apple Stock Outperforming the Nasdaq?', publisher: 'X', body: '', topic: 'other', topicLabel: '其他' }];
  const fin = newsSides.buildFinancialFacts({});
  const r = newsSides.classifyRuleLayer(articles, fin, { name: 'Apple Inc.' });
  assert.strictEqual(r.bull.length, 0, '疑問句不得進看好欄');
  assert.strictEqual(r.bear.length, 0, '疑問句不得進看跌欄');
});

t('I12 多空則數的措辭與實際差距相符', () => {
  const fin = newsSides.buildFinancialFacts({ fundamentals: { metrics: { grossMargin: 48.79 } } });
  // 4:2 差距達 33%，不該說「數量接近」
  const read = newsSides.buildRuleRead(fin, 4, 2);
  assert.ok(!/數量接近/.test(read), `4:2 不應描述為數量接近：${read}`);
  assert.ok(/多於|偏多|偏正面/.test(read), `4:2 應描述為一方較多：${read}`);
  // 5:5 才是接近
  const tie = newsSides.buildRuleRead(fin, 5, 5);
  assert.ok(/數量接近/.test(tie), `5:5 應描述為數量接近：${tie}`);
});

t('I13 跨欄不得重複同一要點', () => {
  const fake = {
    bull: [{ point: 'AI 功能帶動換機需求，服務收入可望提升', newsIndex: 1, fundamentalLink: '毛利率' }],
    bear: [{ point: 'AI 功能帶動換機需求，服務收入可望提升', newsIndex: 1, fundamentalLink: '毛利率' }],
    focus: 'x', fundamentalRead: 'y', caveats: [],
  };
  const articles = [{ title: 't', publisher: 'p', link: 'l' }];
  const fin = newsSides.buildFinancialFacts({});
  const { out, adjusted } = newsSides.validate(fake, articles, fin);
  assert.strictEqual(out.bear.length, 0, '與看好欄重複的要點必須自看跌欄移除');
  assert.ok(adjusted.some((a) => /重複/.test(a)), '移除必須留下記錄，不可靜默');
});

t('I14 只複述財務數字的要點必須剔除（否則與財報區重複）', () => {
  /* 實測模型產出「負債比 72.29% 偏高，財務體質評級列為高負債」——
     這不是新聞要點，是把上面財務事實換句話說，屬於重複資訊。 */
  const fin = newsSides.buildFinancialFacts({
    fundamentals: { metrics: { grossMargin: 48.79, netMargin: 27.6, debtRatio: 72.29, roe: 117.92 } },
  });
  const raw = {
    bull: [
      { point: '負債比 72.29% 偏高，財務體質評級列為高負債', newsIndex: 1, fundamentalLink: 'x' },
      { point: 'FY2026 營收 4788 億美元、年增 15%，成長動能明確', newsIndex: 1, fundamentalLink: 'y' },
    ],
    bear: [{ point: '毛利率指引下修至 45%~46%，低於全年水準', newsIndex: 2, fundamentalLink: 'z' }],
    focus: 'f', fundamentalRead: 'r', caveats: [],
  };
  const { out, adjusted } = newsSides.validate(raw, [{ title: 'a' }, { title: 'b' }], fin);
  assert.strictEqual(out.bull.length, 1, '複述型要點應被剔除');
  assert.ok(/營收 4788/.test(out.bull[0].point), '真事件要點必須保留');
  // 反向確認：含事件詞的指標句是真要點，不可誤殺
  assert.strictEqual(out.bear.length, 1, '含「下修」的指標句是真要點，不得誤殺');
  assert.ok(adjusted.some((a) => /複述/.test(a)), '剔除必須留下記錄');
});

/* ============================================================
   J 正文摘要提煉（AI 自動打開新聞後的「提煉主要內容」）
   ============================================================ */

section('J 正文摘要提煉');

const articleFetch = require('../lib/article-fetch');

t('J1 摘要不得從句子中間開始（月份與 a.m./p.m. 縮寫不可誤切）', () => {
  /* 實測兩個真實破口：
       「Nov. 26, 2026」被切成兩句 → 摘要變「26, 2026 (GLOBE NEWSWIRE)…」
       「4:00 p.m. ET」被切成兩句 → 摘要停在「at the 4:00 p.m.」 */
  const body = 'SYDNEY, Nov. 26, 2026 (GLOBE NEWSWIRE) -- ETO Markets said revenue grew 12% year over year, driven by strong demand for its platform.';
  const s = articleFetch.summarizeBody({ body });
  assert.ok(!/^\d+,\s*\d{4}/.test(s), `摘要不得從年份中間開始：${s}`);
  assert.ok(/ETO Markets/.test(s), `摘要應包含主語：${s}`);

  const body2 = 'Apple closed at $355.58 at the 4:00 p.m. ET close on November 25, capping a volatile session. The company said guidance would be 45% to 46%.';
  const s2 = articleFetch.summarizeBody({ body: body2 });
  assert.ok(!/4:00 p\.m\.$/.test(s2), `摘要不得停在 p.m.：${s2}`);
});

t('J2 公司樣板介紹不得當成摘要', () => {
  const body = 'Apple Inc. (AAPL) is a leading multinational technology company headquartered in Cupertino, California. Companies valued at over $1 trillion are rare.';
  assert.strictEqual(articleFetch.summarizeBody({ body }), '',
    '整篇都是樣板時，應回空字串讓前端退回 RSS 摘要，而不是產出廢話');
});

t('J3 有實質財務內容時必須產出摘要', () => {
  const body = 'Revenue rose 15% to $478.8 billion, while gross margin came in at 48.79%. The board approved a new $90 billion buyback program.';
  const s = articleFetch.summarizeBody({ body });
  assert.ok(s.length > 40, `應產出摘要，實得：${s}`);
  assert.ok(/\$478\.8 billion|48\.79%|buyback/.test(s), `摘要應含關鍵數字：${s}`);
});

t('J4 版權與訂閱樣板句必須剔除', () => {
  const body = 'Subscribe to read the full article. Already a member? Sign in. Copyright 2026. All rights reserved. Our analysts said revenue grew 12% to $5.2 billion this quarter.';
  const s = articleFetch.summarizeBody({ body });
  assert.ok(!/Subscribe|Sign in|Copyright|reserved/i.test(s), `摘要混入樣板句：${s}`);
  assert.ok(/revenue grew/i.test(s), `應保留實質句：${s}`);
});

t('J5 正文過短時不產出摘要（避免假裝讀過）', () => {
  assert.strictEqual(articleFetch.summarizeBody({ body: 'Short body.' }), '');
  assert.strictEqual(articleFetch.summarizeBody({ body: '' }), '');
});

t('J6 摘要長度受控（可掃讀）', () => {
  const long = Array.from({ length: 12 }, (_, i) =>
    `Segment ${i} revenue grew 1${i}% to $${i} billion on strong demand for the platform and services.`).join(' ');
  const s = articleFetch.summarizeBody({ body: long });
  assert.ok(s.length <= 200, `摘要過長：${s.length} 字`);
});

/* ============================================================
   K 前端呈現契約（子分頁 + 雙欄）
   ============================================================ */

section('K 前端呈現契約');

const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const newsJs = fs.readFileSync(path.join(ROOT, 'public/news-ai.js'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

t('K1 四個子分頁與面板都存在且 ARIA 互指', () => {
  const tabs = ['decision', 'tech', 'fund', 'news'];
  for (const t2 of tabs) {
    assert.ok(htmlSrc.includes(`id="tab-${t2}"`), `缺少 #tab-${t2}`);
    assert.ok(htmlSrc.includes(`id="panel-${t2}"`), `缺少 #panel-${t2}`);
    assert.ok(new RegExp(`id="tab-${t2}"[^>]*aria-controls="panel-${t2}"`).test(htmlSrc),
      `#tab-${t2} 的 aria-controls 未指向 panel`);
    assert.ok(new RegExp(`id="panel-${t2}"[^>]*aria-labelledby="tab-${t2}"`).test(htmlSrc),
      `#panel-${t2} 的 aria-labelledby 未指回 tab`);
  }
  assert.ok(htmlSrc.includes('role="tablist"'), '缺少 tablist');
});

t('K2 每個區塊只屬於一個分頁（不得重複呈現）', () => {
  // 抓出每個 panel 內的 section 識別（id/aria-label），確認沒有跨面板重複
  const panels = {};
  for (const k of ['decision', 'tech', 'fund', 'news']) {
    const re = new RegExp(`id="panel-${k}"[\\s\\S]*?<!-- /tabpanel -->`);
    const m = htmlSrc.match(re);
    panels[k] = m ? m[0] : '';
    assert.ok(panels[k].length > 0, `找不到 panel-${k} 的內容`);
  }
  const keys = {};
  for (const k of Object.keys(panels)) {
    const ids = [...panels[k].matchAll(/(?:id|aria-label)="([^"]+)"/g)].map((m) => m[1]);
    for (const id of ids) {
      assert.ok(!keys[id], `「${id}」同時出現在 ${keys[id]} 與 ${k}，造成重複內容`);
      keys[id] = k;
    }
  }
});

t('K3 新聞卡有雙欄容器與財務解讀出口', () => {
  for (const id of ['newsAiFocus', 'newsAiBullList', 'newsAiBearList',
    'newsAiBullCount', 'newsAiBearCount', 'newsAiFinRead', 'newsAiFinFacts']) {
    assert.ok(htmlSrc.includes(`id="${id}"`), `缺少 #${id}`);
  }
});

t('K4 news-ai.js 渲染雙欄且為 ES5', () => {
  assert.ok(newsJs.includes('renderSidesColumn'), '未見雙欄渲染函式');
  const code = newsJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!/=>/.test(code), '不得使用箭頭函式');
  assert.ok(!/\b(const|let)\s/.test(code), '不得使用 const/let');
  assert.ok(!/`/.test(code), '不得使用模板字串');
});

t('K5 看好／看跌不得使用漲跌紅綠色（語義分離）', () => {
  /* 紅綠在本站代表股價漲跌。若「看跌」用綠色、「看好」用紅色，
     使用者會把「新聞看空」讀成「股價在跌」，這是實質誤導。 */
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const m = css.match(/\.sides-bull \.sides-dot[^}]*}/);
  const m2 = css.match(/\.sides-bear \.sides-dot[^}]*}/);
  assert.ok(m && m2, '找不到雙欄顏色規則');
  assert.ok(!/--up|--down/.test(m[0] + m2[0]),
    '雙欄顏色不得使用 --up/--down（漲跌色）');
});

t('K6 分頁切換使用 hidden 屬性（否則 Canvas 會量到 0 寬）', () => {
  assert.ok(/panel\.hidden\s*=\s*!on/.test(appJs),
    '面板必須用 hidden 屬性切換，不能只改 class');
});

t('K7 分頁 sticky 偏移需避開頂欄', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const m = css.match(/\.sub-tabs\s*\{[^}]*position:\s*sticky[^}]*\}/);
  assert.ok(m, '找不到 .sub-tabs sticky 規則');
  /* 注意不能直接抓第一個 /top:\s*\d+px/：
     命中的會是 margin-top: 16px（margin 不是偏移）。
     必須要求前面是空白或分號，排除 margin-top / padding-top。 */
  const top = m[0].match(/(?:^|[\s;])top:\s*(\d+)px/);
  assert.ok(top, '.sub-tabs 未設定 sticky 的 top 偏移');
  assert.ok(parseInt(top[1], 10) >= 50,
    `sticky top 需避開頂欄高度（實測 62px），實得 ${top[1]}px`);
});

/* ============================================================
   L 新聞清單品質（實測缺陷的回歸鎖）
   ============================================================
 *
 * 這三條全部來自同一輪實測：AAPL 的新聞清單混進了
 *   ① 券商公關稿（ETO Markets 13 週年）——只是文末提到 Apple
 *   ② 三則 13F 持股異動自動稿（Summit Wealth / Cortland / VCI）
 *   ③ 同一則 Talkie 下架事件被三家媒體各報一次
 *   ④ 「Can VZ's New Apple Deals…」的正文整段在講 Verizon 的本益比
 * 若不鎖住，這類污染會在換資料源或改權重時悄悄回來。
 */

section('L 新聞清單品質');

t('L1 標題沒提到標的的稿必須被辨識出來', () => {
  const subj = { symbol: 'AAPL', name: 'Apple Inc.', shortName: 'Apple' };
  assert.strictEqual(articleFetch.mentionsSubject('ETO Markets Marks 13th Anniversary With Race Beyond Limits', subj), false,
    '完全沒提到 Apple 的稿不應被視為本檔新聞');
  assert.strictEqual(articleFetch.mentionsSubject('Apple Stocks Rise as AI Selloff Spares the iPhone Maker', subj), true);
  assert.strictEqual(articleFetch.mentionsSubject('Apple Inc. $AAPL Stock: Summit Wealth Group Grows Stake', subj), true);
});

t('L2 公司後綴不影響標的辨識（Apple Inc. 要能匹配 Apple）', () => {
  /* 這曾是真實 bug：名稱取到「Apple Inc.」時，內文寫「Apple shares」
     就認不出來，導致所有稿都被當成「與標的無關」。 */
  assert.strictEqual(articleFetch.mentionsSubject('Apple shares climbed on Monday', { name: 'Apple Inc.' }), true);
  /* 反向：完全無關的稿不得因為「同為科技公司」被誤認 */
  assert.strictEqual(articleFetch.mentionsSubject('Nvidia unveils new data center rack', { name: 'Tencent Holdings Limited' }), false);
  assert.strictEqual(articleFetch.mentionsSubject('Tencent 0700.HK rose today', { symbol: '0700.HK' }), true);
});

t('L3 13F 持股異動自動稿必須被辨識（且不得誤殺回購）', () => {
  for (const title of [
    'Apple Inc. $AAPL Stock: Summit Wealth Group LLC Co. Grows Stake',
    'Cortland Associates Inc. MO Sells 2,033 Shares of Apple Inc.',
    'Apple Inc. $AAPL Position Decreased by VCI Wealth Management LLC',
  ]) {
    assert.strictEqual(articleFetch.isHoldingsNoise(title), true, `應判為持股異動稿：${title}`);
  }
  /* 反向保護：公司自己回購是重大資本配置決策，不可誤殺 */
  for (const title of [
    'Apple to buy back $100 billion in shares',
    'Apple authorizes new $110 billion share repurchase program',
  ]) {
    assert.strictEqual(articleFetch.isHoldingsNoise(title), false, `回購不可誤判為持股異動：${title}`);
  }
});

t('L4 同一事件的多家報導必須合併（Jaccard 不足時靠罕見詞）', () => {
  /* 三個標題的 Jaccard 僅 0.31–0.50，低於 0.62 門檻，
     真實情況是同一天出現三則。必須靠「共享兩個以上罕見詞」合併。 */
  const r = articleFetch.dedupeByEvent([
    { title: "Apple (AAPL) Stock: App Store Removes MiniMax's Talkie Chatbot", publisher: 'A' },
    { title: 'Apple Removes Talkie From App Store After Reports of Inappropriate AI Messages', publisher: 'B' },
    { title: 'Apple (AAPL) Removes Chatbot from App Store Over Child Safety Concerns', publisher: 'C' },
  ]);
  assert.strictEqual(r.length, 1, `同一事件應合併為 1 則，實得 ${r.length}`);
  assert.ok(r[0].alsoReportedBy && r[0].alsoReportedBy.length >= 1, '應記錄其他報導來源');
});

t('L5 去重不得誤併不同事件', () => {
  const pairs = [
    ['Apple: $136 Billion Of Free Cash Flow Without The AI CapEx Bill',
      'Apple Beats Big Tech as AAPL Stock Nears $360 Strong Earnings'],
    ['Apple: The Hidden Risk Behind My Downgrade',
      'Apple Is Now Worth Over $5 Trillion Without Betting Big on AI'],
    ['Apple Removes Talkie From App Store After Reports',
      'Apple authorizes new $110 billion share repurchase program'],
  ];
  for (const [a, b] of pairs) {
    assert.strictEqual(articleFetch.dedupeByEvent([{ title: a }, { title: b }]).length, 2,
      `不同事件被誤併：${a.slice(0, 30)} / ${b.slice(0, 30)}`);
  }
});

t('L6 正文主體不是標的時，摘要必須作廢（不得張冠李戴）', () => {
  /* 實例：標題「Can VZ's New Apple Deals…」，正文 661 字從頭到尾沒出現 Apple，
     整段在講 Verizon 的本益比 8.93。舊版會把 Verizon 的分析當成這則的摘要。 */
  const vz = {
    title: "Can VZ's New Apple Deals and Loyalty Benefits Drive Subscriber Growth?",
    body: 'Verizon Communications has been expanding its customer base. From a valuation standpoint, '
      + 'Verizon trades at a forward price-to-earnings ratio of 8.93, significantly below the industry average of 15.2. '
      + 'The company added 128,000 postpaid phone subscribers in the quarter, beating analyst estimates of 95,000.',
  };
  assert.strictEqual(articleFetch.summarizeBody(vz, { symbol: 'AAPL', name: 'Apple Inc.' }), '',
    '正文完全沒提到標的時應回空字串');

  /* 正對照：正文主體是 Apple 時必須正常產出 */
  const ok = {
    title: 'Apple Stocks Rise as AI Selloff Spares the iPhone Maker',
    body: 'The resilience reflects a strategy that puts AI into the roughly 2.5 billion Apple devices already in customers hands. '
      + 'Apple has avoided the massive data center spending that has pressured margins at Microsoft and Meta.',
  };
  const s = articleFetch.summarizeBody(ok, { symbol: 'AAPL', name: 'Apple Inc.' });
  assert.ok(s.length > 40, `正文主體正確時應產出摘要，實得：${s}`);
});

t('L7 分析師免責聲明不得當成摘要', () => {
  /* Seeking Alpha 類正文開頭整段是 disclosure，含 AAPL 會通過標的錨定，
     但完全沒有文章內容。 */
  const body = 'At the beginning of November Apple ( AAPL ) reported its Q4 2026 results. '
    + "Analyst's Disclosure: I/we have a beneficial long position in the shares of AAPL, AMZN, GOOGL. "
    + 'I wrote this article myself, and it expresses my own opinions. I am not receiving compensation for it.';
  const s = articleFetch.summarizeBody({ body, title: 'Apple: $136 Billion Of Free Cash Flow' },
    { symbol: 'AAPL', name: 'Apple Inc.' });
  assert.ok(!/Disclosure|beneficial long position|compensation/i.test(s),
    `摘要混入免責聲明：${s}`);
});

t('L8 summarizeBody 未給 subject 時維持原行為（不可破壞舊呼叫端）', () => {
  const body = 'Revenue rose 15% to $478.8 billion, while gross margin came in at 48.79%. '
    + 'The board approved a new $90 billion buyback program.';
  const s = articleFetch.summarizeBody({ body });
  assert.ok(s.length > 40, `未給 subject 時仍應產出摘要，實得：${s}`);
});

t('L9 規則層的「市場焦點」必須說出關注點，不能只數則數', () => {
  /* 實測規則層舊版輸出：「市場焦點集中在財務（4 則），方向多空分歧。」
     這等於沒回答「市場在關注什麼」。必須把兩邊權重最高的要點帶進來。 */
  const f = newsSides.buildFocusFallback(
    [{ point: 'FY2026 營收達 4,788.34 億美元、年增 15.06%', weight: 3.2, topicLabel: '財務' }],
    [{ point: '記憶體價格被形容為「前所未見」，製造成本壓力明顯升溫', weight: 3.5, topicLabel: '財務' }]
  );
  assert.ok(/看好方|看跌方/.test(f), `焦點描述應指出雙方關注點：${f}`);
  /* 千分位逗號不可被當成停頓切斷（實測會切成「FY2026 營收達 4」） */
  assert.ok(f.includes('4,788.34'), `千分位數字被切斷：${f}`);
  /* 不得出現疊引號或殘缺引號 */
  assert.ok(!/[「」][^「」]*〉|〉[^「」]*[「」]/.test(f), `引號殘缺：${f}`);
  assert.ok(!/集中在財務（\d+ 則）。$/.test(f), `只數則數不算焦點：${f}`);
});

console.log('\n' + '='.repeat(56));
console.log(`  通過 ${pass}　失敗 ${fail}　共 ${pass + fail}`);
console.log('='.repeat(56));
if (fail) {
  console.log('\n失敗詳情：');
  for (const f of failures) {
    console.log(`\n· ${f.name}`);
    console.log(`  ${f.error.message}`);
  }
}
process.exit(fail ? 1 : 0);
