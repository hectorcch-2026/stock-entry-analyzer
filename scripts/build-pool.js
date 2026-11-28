#!/usr/bin/env node
'use strict';

/**
 * 產生標的池快照（lib/pool-us-500.json）
 *
 * 為什麼要有這支腳本、而不是在執行期抓 Wikipedia：
 *   1. 服務啟動時不能依賴外網。Render 冷啟動若還要等 Wikipedia，第一個
 *      使用者會看到 30 秒白畫面，而且 Wikipedia 一掛，整個服務就起不來。
 *   2. 標的池必須是「可稽核的常數」。使用者要能問「這 500 檔是哪來的」，
 *      答案必須固定；每次啟動重抓，答案會隨 Wikipedia 編輯而漂移。
 *   3. 產出物進版控，改動就是一次 diff，review 時看得見。
 *
 * 來源為什麼選 S&P 500：
 *   需求是「只納入在美國交易所上市的個股」＋「500 檔」＋「排除中概股」。
 *   S&P 500 的三個性質剛好同時滿足：
 *     · 成分股必須是美國註冊（US-domiciled），中概股（開曼註冊的 ADR）
 *       結構上就進不來 —— 這是「排除」最可靠的實現方式：不是靠黑名單，
 *       而是靠母體本身的定義。
 *     · 全部在 NYSE / NASDAQ 掛牌（美國交易所）。
 *     · 規模恰好 500 家。
 *
 * 503 → 500 是怎麼來的（這是本腳本最重要的一件事）：
 *   Wikipedia 的成分股表有 503 個**代碼**，但其中 3 組是同一家公司的
 *   第二類股（dual-class），不是 3 家獨立公司：
 *       GOOGL / GOOG   Alphabet A 股 / C 股
 *       FOXA  / FOX    Fox A 股 / B 股
 *       NWSA  / NWS    News Corp A 股 / B 股
 *   去重後剛好 500 家。留哪一個？留**成交量大的那一類**（A 股），
 *   因為技術分析要的是流動性，B/C 股常常只有稀薄成交，算出來的
 *   ATR、均量、支撐壓力都不具代表性。
 *
 * 用法：
 *   node scripts/build-pool.js            # 抓 Wikipedia 並覆寫快照
 *   node scripts/build-pool.js --check    # 只驗證現有快照，不連網（CI 用）
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'lib', 'pool-us-500.json');
const SRC_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';

/** 目標檔數。需求寫死 500，這裡也寫死，兩邊一旦不一致就讓腳本失敗。 */
const TARGET = 500;

/**
 * 同一家公司的第二類股 → 保留代碼。
 *
 * 為什麼明寫成表、而不是用「名稱去掉 (Class X) 後相同就合併」的自動規則：
 *   自動規則會在名稱不完全一致時漏判（例如 "Alphabet Inc. (Class A)" 與
 *   "Alphabet Inc. (Class C)" 去掉括號後確實相同，但 Berkshire 的
 *   BRK.B 名稱根本沒寫 Class）。漏判的後果是池子多一檔重複公司，
 *   而「不得重複」是這次需求的硬條件。明寫一張表，漏了就看得見。
 */
const DUAL_CLASS_DROP = {
  GOOG: 'GOOGL',  // Alphabet C 股 → 留 A 股（成交量較大）
  FOX: 'FOXA',    // Fox B 股 → 留 A 股
  NWS: 'NWSA',    // News Corp B 股 → 留 A 股
};

/**
 * 中概股黑名單（在美上市中國概念股）。
 *
 * 這裡必須說清楚一件事，否則會誤導維護者：
 *   **S&P 500 母體裡目前一檔中概股都沒有**，因為指數要求美國註冊，
 *   而中概股幾乎都是開曼群島註冊的 ADR。所以對「現在的池子」而言，
 *   這份名單命中的數量是 0。
 *
 * 那為什麼還要留著：
 *   1. 母體若哪天換掉（例如改成「美股全體」），這道閘門必須已經在，
 *      不能等換了才補 —— 那時就來不及了。
 *   2. 篩選器可以被呼叫方直接餵 symbols（測試、外部 cron、未來的 API），
 *      繞過母體建立。閘門放在篩選器裡才是「固定規則」，放在母體只是
 *      「預設值」。
 *   3. 需求明確要求「標註已排除中概股與因而調整的數量」。數量是 0
 *      也必須講出來，這樣使用者才知道規則真的跑了，而不是被忽略了。
 */
const CHINA_ADR = [
  'BABA', 'BIDU', 'BILI', 'BEKE', 'EDU', 'IQ', 'JD', 'LI', 'NIO', 'NTES',
  'PDD', 'TAL', 'TME', 'XPEV', 'WB', 'YY', 'MOMO', 'ZH', 'HUYA', 'DOYU',
  'TIGR', 'FUTU', 'KC', 'GOTU', 'RERE', 'YQ', 'BEST', 'CAN', 'CANG', 'DAO',
  'EH', 'FANH', 'GDS', 'HTHT', 'JFIN', 'JKS', 'LU', 'LX', 'MNSO', 'NOAH',
  'QFIN', 'RLX', 'SINA', 'SOHU', 'STG', 'TCOM', 'TUYA', 'VIPS', 'VNET',
  'WIMI', 'XNET', 'YJ', 'ZLAB', 'ZTO', 'ATAT', 'ATHM', 'BZ', 'DQ', 'FINV',
  'HCM', 'HSAI', 'LEGN', 'NIU', 'PPC', 'QD', 'RENN', 'SECO', 'UXIN',
];

/**
 * 名稱中帶有這些字樣者一律視為中概股。
 *
 * 為什麼用 \b 邊界而不是裸 substring：
 *   裸的 /CN/ 會命中 "Dominion Energy"（Dom-i-**ni**-on 不含 CN，但
 *   /CN/i 對 "Dominion" 是 false，真正踩雷的是 /china/ 對
 *   "China" 的寬鬆寫法；實測用 /china/i 會誤傷 "Old Dominion" 之類
 *   只要含 "china" 片段的字）。用詞邊界能明確表達「這是一個詞」。
 */
const CHINA_NAME_RE = /\b(china|chinese|prc|beijing|shanghai|shenzhen|hong\s*kong)\b/i;

function normalizeTicker(t) {
  return String(t || '').trim().toUpperCase().replace(/\./g, '-');
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** 把一格 HTML（含屬性）清成純文字：先切掉標籤外殼，再剝殘留標籤。 */
function cellText(cell) {
  // 呼叫端是用 `<td` 切開的，所以每格開頭還留著 ` id="mwXX">` 這種殘骸。
  // 先丟掉第一個 `>` 之前的所有內容，才是真正的內容起點。
  const afterAttr = String(cell || '').replace(/^[^>]*>/, '');
  return stripTags(afterAttr);
}

function parseConstituents(html) {
  const m = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/);
  if (!m) throw new Error('找不到 id="constituents" 的成分股表（Wikipedia 版型可能已改）');

  const rows = m[0].split(/<tr[ >]/).slice(1);
  const out = [];
  for (const r of rows) {
    const cells = r.split(/<td[ >]/).slice(1);
    if (!cells.length) continue; // 表頭列沒有 <td>
    const link = cells[0].match(/>([A-Z][A-Z.\-]{0,7})<\//);
    if (!link) continue;
    const sym = normalizeTicker(link[1]);
    const name = cellText(cells[1]);
    const sector = cellText(cells[2]);
    if (!sym || !name) continue;
    out.push({ symbol: sym, name, sector });
  }
  return out;
}

/** 套用排除規則，並回報每一條規則各排掉幾檔。 */
function applyExclusions(rows) {
  const dropped = { dualClass: [], chinaAdr: [], chinaName: [], duplicate: [] };
  const seen = new Set();
  const kept = [];
  const chinaSet = new Set(CHINA_ADR.map(normalizeTicker));

  for (const r of rows) {
    if (Object.prototype.hasOwnProperty.call(DUAL_CLASS_DROP, r.symbol)) {
      dropped.dualClass.push({ symbol: r.symbol, kept: DUAL_CLASS_DROP[r.symbol] });
      continue;
    }
    if (chinaSet.has(r.symbol)) {
      dropped.chinaAdr.push(r.symbol);
      continue;
    }
    if (CHINA_NAME_RE.test(r.name)) {
      dropped.chinaName.push({ symbol: r.symbol, name: r.name });
      continue;
    }
    if (seen.has(r.symbol)) {
      dropped.duplicate.push(r.symbol);
      continue;
    }
    seen.add(r.symbol);
    kept.push(r);
  }
  return { kept, dropped };
}

function build() {
  const nodeHttps = require('https');
  return new Promise((resolve, reject) => {
    nodeHttps.get(SRC_URL, { headers: { 'User-Agent': 'stock-entry-analyzer/pool-builder' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Wikipedia 回應 ${res.statusCode}`));
        res.resume();
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf));
    }).on('error', reject);
  });
}

function verify(snapshot) {
  const problems = [];
  const syms = snapshot.symbols.map((s) => s.symbol);

  if (syms.length !== TARGET) {
    problems.push(`檔數應為 ${TARGET}，實際 ${syms.length}`);
  }
  if (new Set(syms).size !== syms.length) {
    problems.push('存在重複代碼');
  }
  const bad = syms.filter((s) => !/^[A-Z]{1,5}(-[A-Z])?$/.test(s));
  if (bad.length) problems.push(`代碼格式異常：${bad.join(',')}`);

  const hk = syms.filter((s) => /\.HK$/i.test(s));
  if (hk.length) problems.push(`池中含有港股：${hk.join(',')}`);

  const chinaSet = new Set(CHINA_ADR.map(normalizeTicker));
  const cn = syms.filter((s) => chinaSet.has(s));
  if (cn.length) problems.push(`池中仍有中概股：${cn.join(',')}`);

  const cnName = snapshot.symbols.filter((s) => CHINA_NAME_RE.test(s.name || ''));
  if (cnName.length) problems.push(`名稱含中國字樣：${cnName.map((x) => x.symbol).join(',')}`);

  return problems;
}

async function main() {
  const checkOnly = process.argv.includes('--check');

  if (checkOnly) {
    const snapshot = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const problems = verify(snapshot);
    if (problems.length) {
      console.error('✗ 快照驗證失敗：');
      problems.forEach((p) => console.error('  - ' + p));
      process.exit(1);
    }
    console.log(`✓ 快照驗證通過：${snapshot.symbols.length} 檔，無重複、無港股、無中概股`);
    return;
  }

  console.log('抓取 S&P 500 成分股…');
  const html = await build();
  const raw = parseConstituents(html);
  console.log(`  解析到 ${raw.length} 個代碼`);

  const { kept, dropped } = applyExclusions(raw);
  console.log(`  排除同一公司第二類股 ${dropped.dualClass.length} 檔：`
    + dropped.dualClass.map((d) => `${d.symbol}（留 ${d.kept}）`).join('、'));
  console.log(`  排除中概股（代碼比對） ${dropped.chinaAdr.length} 檔`
    + (dropped.chinaAdr.length ? '：' + dropped.chinaAdr.join('、') : ''));
  console.log(`  排除中概股（名稱比對） ${dropped.chinaName.length} 檔`
    + (dropped.chinaName.length ? '：' + dropped.chinaName.map((d) => d.symbol).join('、') : ''));
  console.log(`  排除重複代碼 ${dropped.duplicate.length} 檔`);
  console.log(`  保留 ${kept.length} 檔`);

  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'S&P 500 constituents (en.wikipedia.org)',
    market: 'us',
    targetSize: TARGET,
    symbols: kept.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    exclusions: {
      dualClass: dropped.dualClass,
      chinaAdr: dropped.chinaAdr,
      chinaName: dropped.chinaName,
      duplicate: dropped.duplicate,
    },
  };

  const problems = verify(snapshot);
  if (problems.length) {
    console.error('✗ 產出驗證失敗，未寫檔：');
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }

  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log(`✓ 已寫入 ${path.relative(process.cwd(), OUT)}（${kept.length} 檔）`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('✗ 失敗：' + e.message);
    process.exit(1);
  });
}

module.exports = { parseConstituents, applyExclusions, verify, normalizeTicker, CHINA_ADR, CHINA_NAME_RE, DUAL_CLASS_DROP, TARGET };
