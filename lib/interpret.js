'use strict';

/**
 * 解讀引擎（Interpretation Engine）
 * ==================================
 *
 * 目標：把「宏觀數據」與「企業財報」翻譯成可判斷的結論，
 * 而且**每一個結論都必須能追溯回具體數字**。
 *
 * ---------------------------------------------------------------------------
 * 為什麼預設不是「呼叫某個 LLM」
 * ---------------------------------------------------------------------------
 * 本專案 `dependencies: {}`，沒有任何 LLM API Key。若硬要接一個需要付費 Key 的
 * 服務，這個功能在預設環境下就是死的。因此本引擎採「確定性規則 + 可選 LLM 增強」：
 *
 *   mode = 'rule'   規則推理（預設，零依賴、可重現、可審核）
 *   mode = 'llm'    規則為骨架，LLM 只負責改寫語氣（需設 openaiApiKey）
 *
 * 關鍵限制：**LLM 絕不負責產生數字**。數字一律由規則層算好後傳進去，
 * LLM 只能改寫文字。這樣即使模型胡說，也不會污染數值。
 * 若 LLM 失敗，靜默退回規則層輸出——功能不會因此不可用。
 *
 * ---------------------------------------------------------------------------
 * 三個設計原則（與本專案既有「寧可沒有預測，也不要錯的預測」一致）
 * ---------------------------------------------------------------------------
 * 1. **不預測**。只描述「已發生的事實」與「目前的相對位置」，
 *    不寫「未來會漲/會跌」。使用者要的是解讀，不是算命。
 * 2. **每條結論都有 evidence**。列出支撐該結論的指標與數值，
 *    讓使用者可以自己覆核，而不是只能相信。
 * 3. **資料缺口必須明說**。算不出來的指標要列在 `gaps`，
 *    不可用「整體而言」之類的話帶過。
 */

const fs = require('fs');
const path = require('path');
const fred = require('./fred');
const sec = require('./sec');
const fomc = require('./fomc');

/* ============================================================
   共用小工具
   ============================================================ */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 把數值轉成「高／中／低」三級，並回傳門檻說明 */
function band(value, cuts, labels) {
  if (value == null || !isFinite(value)) return { level: 'unknown', label: '資料不足' };
  if (value < cuts[0]) return { level: 'low', label: labels[0] };
  if (value < cuts[1]) return { level: 'mid', label: labels[1] };
  return { level: 'high', label: labels[2] };
}

/** 建立一條結論 */
function finding(opts) {
  return {
    id: opts.id,
    topic: opts.topic,               // 'inflation' | 'rates' | 'labor' | ...
    stance: opts.stance,             // 'hawkish' | 'dovish' | 'neutral' | 'mixed' | 'unknown'
    headline: opts.headline,         // 一句話結論
    detail: opts.detail,             // 展開說明
    evidence: opts.evidence || [],   // [{label, value, unit, asOf}]
    confidence: opts.confidence || 'medium', // high | medium | low
    caveat: opts.caveat || null,
  };
}

/** 從 fred 序列取證據 */
function ev(series, opts) {
  if (!series || !series.available) return null;
  const o = opts || {};
  return {
    label: o.label || series.label,
    value: series.value,
    unit: o.unit || series.unit,
    asOf: series.asOf,
    seriesId: series.id,
    percentile: series.stats ? series.stats.percentile : null,
  };
}

/* ============================================================
   宏觀解讀
   ============================================================ */

/**
 * 通膨解讀。
 *
 * 判斷邏輯（刻意寫得可審核，不用黑箱）：
 *   - 核心 CPI YoY > 3%      → 通膨仍高於目標，偏鷹
 *   - 2% ~ 3%               → 接近目標，中性
 *   - < 2%                  → 低於目標，偏鴿
 *   - 整體與核心背離 > 1pp   → 標記「有雜訊」，避免單看一個數字
 */
function interpretInflation(series) {
  const cpi = series.cpiYoy;
  const core = series.coreCpiYoy;

  if (!cpi || !cpi.available) {
    return finding({
      id: 'inflation', topic: 'inflation', stance: 'unknown',
      headline: '通膨資料無法取得',
      detail: 'CPI 年增率序列不可用，無法判斷通膨狀態。',
      confidence: 'low',
    });
  }

  const coreVal = core && core.available ? core.value : null;
  const mainVal = cpi.value;

  // 以核心 CPI 為主判準（Fed 更關注核心），沒有核心才用整體
  const ref = coreVal != null ? coreVal : mainVal;
  const refLabel = coreVal != null ? '核心 CPI 年增率' : 'CPI 年增率';

  const b = band(ref, [2, 3], ['低於目標', '接近目標', '高於目標']);
  const stance = b.level === 'high' ? 'hawkish' : b.level === 'low' ? 'dovish' : 'neutral';

  // 整體 vs 核心背離
  let divergence = null;
  if (coreVal != null) {
    const diff = +(mainVal - coreVal).toFixed(2);
    if (Math.abs(diff) > 1) {
      divergence = `整體 CPI（${mainVal.toFixed(2)}%）與核心 CPI（${coreVal.toFixed(2)}%）相差 ${diff > 0 ? '+' : ''}${diff} 個百分點，`
        + (diff > 0 ? '代表能源或食品價格正在推高通膨，這部分波動大、可逆。'
                    : '代表能源或食品價格壓低通膨，潛在壓力其實比表面更高。');
    }
  }

  const evidence = [ev(cpi)].filter(Boolean);
  if (core) evidence.push(ev(core));

  return finding({
    id: 'inflation',
    topic: 'inflation',
    stance,
    headline: `${refLabel} ${ref.toFixed(2)}%，${b.label}（2% 目標）`,
    detail: `${refLabel}目前為 ${ref.toFixed(2)}%，${b.label}。`
      + (ref >= 3 ? '這意味著通膨仍明顯高於 Fed 的 2% 目標，短期內降息的空間受限。'
        : ref >= 2 ? '通膨已接近目標區間，但尚未完全回到 2%，政策仍有觀望空間。'
          : '通膨低於 2% 目標，理論上支持較寬鬆的政策立場。')
      + (divergence ? ' ' + divergence : ''),
    evidence,
    confidence: cpi.stats && cpi.stats.percentile != null ? 'high' : 'medium',
    caveat: cpi.asOf && cpi.asOf < new Date(Date.now() - 75 * 86400000).toISOString().slice(0, 10)
      ? `最新 CPI 資料為 ${cpi.asOf}，距今超過兩個月，可能已有更新一期。`
      : null,
  });
}

/**
 * 利率與殖利率曲線解讀。
 *
 * 重點：**區分「政策利率」與「市場利率」**。
 * 目標區間是 FOMC 決定的；10Y/2Y 是市場交易出來的。混為一談是最常見的誤讀。
 */
function interpretRates(series, schedule) {
  const upper = series.fedTargetUpper;
  const lower = series.fedTargetLower;
  const dgs10 = series.dgs10;
  const dgs2 = series.dgs2;
  const spread = series.termSpread;
  const real = series.realYield10;

  const hasTarget = upper && upper.available && lower && lower.available;
  const evidence = [];
  let parts = [];

  if (hasTarget) {
    evidence.push(ev(upper, { label: '目標區間上限' }));
    evidence.push(ev(lower, { label: '目標區間下限' }));
    const width = +(upper.value - lower.value).toFixed(2);
    parts.push(`政策利率目標區間為 ${lower.value.toFixed(2)}%–${upper.value.toFixed(2)}%。`);
    // 區間寬度異常 → 資料可能錯
    if (Math.abs(width - 0.25) > 0.01) {
      parts.push(`⚠️ 區間寬度為 ${width} 個百分點，非慣例的 0.25，請確認資料正確性。`);
    }
  }

  if (dgs10 && dgs10.available) {
    evidence.push(ev(dgs10));
    parts.push(`10 年期公債殖利率 ${dgs10.value.toFixed(2)}%（市場交易結果，非政策利率）。`);
  }

  // 殖利率曲線
  let curveStance = 'neutral';
  let curveText = '';
  if (spread && spread.available) {
    evidence.push(ev(spread));
    const v = spread.value;
    if (v < 0) {
      curveStance = 'dovish';
      curveText = `10Y-2Y 期限利差為 ${v.toFixed(2)} 個百分點，處於「倒掛」狀態`
        + `（短天期殖利率高於長天期）。歷史上倒掛是經濟放緩的領先訊號，`
        + `但從倒掛到實際衰退的時滯可能長達 6–24 個月，不能直接推論「馬上衰退」。`;
    } else if (v < 0.5) {
      curveStance = 'neutral';
      curveText = `10Y-2Y 期限利差為 +${v.toFixed(2)} 個百分點，曲線為正向但偏平坦。`;
    } else {
      curveStance = 'neutral';
      curveText = `10Y-2Y 期限利差為 +${v.toFixed(2)} 個百分點，曲線明顯正向，`
        + `代表市場對長期的成長與通膨預期高於短期。`;
    }
    parts.push(curveText);
  } else if (dgs10 && dgs10.available && dgs2 && dgs2.available) {
    // FRED 序列不可用時自行相減，並標明口徑
    const v = +(dgs10.value - dgs2.value).toFixed(2);
    parts.push(`10Y-2Y 利差由本模組自行相減得 ${v > 0 ? '+' : ''}${v} 個百分點`
      + `（FRED 的 T10Y2Y 序列不可用，此值可能因採樣日不同而與官方序列有些微差異）。`);
  }

  if (real && real.available) {
    evidence.push(ev(real));
    parts.push(`10 年期實質殖利率（TIPS）為 ${real.value.toFixed(2)}%，`
      + `可視為市場對實質資金成本的定價。`);
  }

  if (schedule && schedule.available && schedule.next) {
    parts.push(`下次 FOMC 會議為 ${schedule.next.date}（${schedule.next.label}），`
      + `距今 ${schedule.next.daysUntil} 天。`);
  }

  if (!hasTarget && !(dgs10 && dgs10.available)) {
    return finding({
      id: 'rates', topic: 'rates', stance: 'unknown',
      headline: '利率資料無法取得',
      detail: '政策利率與公債殖利率皆不可用。',
      confidence: 'low',
    });
  }

  return finding({
    id: 'rates',
    topic: 'rates',
    stance: curveStance,
    headline: hasTarget
      ? `政策利率 ${lower.value.toFixed(2)}%–${upper.value.toFixed(2)}%`
        + (spread && spread.available ? `；10Y-2Y 利差 ${spread.value > 0 ? '+' : ''}${spread.value.toFixed(2)}pp` : '')
      : `10 年期殖利率 ${dgs10.value.toFixed(2)}%`,
    detail: parts.join(' '),
    evidence,
    confidence: 'high',
    caveat: schedule && schedule.available ? schedule.forecastNote : null,
  });
}

/**
 * 勞動市場解讀。
 */
function interpretLabor(series) {
  const unrate = series.unrate;
  if (!unrate || !unrate.available) {
    return finding({
      id: 'labor', topic: 'labor', stance: 'unknown',
      headline: '就業資料無法取得', detail: '失業率序列不可用。', confidence: 'low',
    });
  }

  const v = unrate.value;
  const pct = unrate.stats ? unrate.stats.percentile : null;

  // 以歷史百分位判斷「以歷史標準算高或低」，比固定門檻更有意義
  let stance = 'neutral';
  let tone = '';
  if (pct != null) {
    if (pct < 20) { stance = 'hawkish'; tone = '處於歷史相對低檔，勞動市場偏緊'; }
    else if (pct > 80) { stance = 'dovish'; tone = '處於歷史相對高檔，勞動市場明顯轉弱'; }
    else tone = '處於歷史中間區間';
  }

  const chg = unrate.stats ? unrate.stats.change : null;

  return finding({
    id: 'labor',
    topic: 'labor',
    stance,
    headline: `失業率 ${v.toFixed(1)}%${pct != null ? `（歷史 ${pct} 百分位）` : ''}`,
    detail: `失業率為 ${v.toFixed(1)}%，${tone}。`
      + (chg != null && chg !== 0 ? `與上月相比${chg > 0 ? '上升' : '下降'} ${Math.abs(chg).toFixed(1)} 個百分點。` : '')
      + ' 注意失業率是落後指標：企業先減少招聘、之後才裁員，因此它轉弱時通常景氣已下滑一段時間。',
    evidence: [ev(unrate)].filter(Boolean),
    confidence: pct != null ? 'high' : 'medium',
  });
}

/**
 * 實體經濟（生產與消費信心）解讀。
 * 特別處理「軟指標 vs 硬指標背離」——這是本報告已驗證過的現象。
 */
function interpretActivity(series) {
  const indpro = series.indpro;
  const umcsent = series.umcsent;
  const evidence = [];
  const parts = [];
  let stance = 'neutral';

  if (indpro && indpro.available) {
    evidence.push(ev(indpro));
    const p = indpro.stats ? indpro.stats.percentile : null;
    parts.push(`工業生產指數 ${indpro.value.toFixed(2)}`
      + (p != null ? `，位於歷史 ${p} 百分位` : '') + '。');
    if (p != null && p > 85) parts.push('實體產出處於歷史高位。');
    else if (p != null && p < 15) parts.push('實體產出處於歷史低位。');
  }

  if (umcsent && umcsent.available) {
    evidence.push(ev(umcsent));
    const p = umcsent.stats ? umcsent.stats.percentile : null;
    parts.push(`消費者信心 ${umcsent.value.toFixed(1)}`
      + (p != null ? `（歷史 ${p} 百分位）` : '') + '。');

    // 背離偵測：硬指標高、軟指標低
    const ipPct = indpro && indpro.available && indpro.stats ? indpro.stats.percentile : null;
    if (ipPct != null && p != null && ipPct > 80 && p < 25) {
      stance = 'mixed';
      parts.push(`⚠️ 軟硬指標嚴重背離：實體產出在歷史 ${ipPct} 百分位（強），`
        + `但消費者信心僅在 ${p} 百分位（弱）。`
        + `這種組合通常代表「產出尚未反映需求端的悲觀」，`
        + `也可能是信心調查受政治或一次性事件干擾。不宜只用其中一項下結論。`);
    }
  }

  if (!evidence.length) {
    return finding({
      id: 'activity', topic: 'activity', stance: 'unknown',
      headline: '實體經濟資料無法取得', detail: '工業生產與消費者信心皆不可用。', confidence: 'low',
    });
  }

  return finding({
    id: 'activity',
    topic: 'activity',
    stance,
    headline: indpro && indpro.available
      ? `工業生產 ${indpro.value.toFixed(1)}${indpro.stats && indpro.stats.percentile != null ? `（${indpro.stats.percentile} 百分位）` : ''}`
      : `消費者信心 ${umcsent.value.toFixed(1)}`,
    detail: parts.join(' '),
    evidence,
    confidence: 'medium',
    caveat: '工業生產是「量」的指標，與 ISM PMI 的擴散指數概念不同，不可互稱或互相替代推論。',
  });
}

/**
 * 外部部門（美元與匯率）解讀。
 * 方向很容易搞反，這裡特別寫清楚。
 */
function interpretExternal(series) {
  const dollar = series.dollarBroad;
  const eurusd = series.eurusd;
  const evidence = [];
  const parts = [];

  if (dollar && dollar.available) {
    evidence.push(ev(dollar));
    const p = dollar.stats ? dollar.stats.percentile : null;
    parts.push(`美元廣義指數 ${dollar.value.toFixed(2)}` + (p != null ? `（歷史 ${p} 百分位）` : '') + '。');
  }
  if (eurusd && eurusd.available) {
    evidence.push(ev(eurusd));
    parts.push(`EUR/USD ${eurusd.value.toFixed(4)}——數值上升代表美元走弱（同樣 1 歐元可換到更多美元）。`);
  }

  if (!evidence.length) {
    return finding({
      id: 'external', topic: 'external', stance: 'unknown',
      headline: '匯率資料無法取得', detail: '美元指數與 EUR/USD 皆不可用。', confidence: 'low',
    });
  }

  return finding({
    id: 'external',
    topic: 'external',
    stance: 'neutral',
    headline: `美元指數 ${dollar && dollar.available ? dollar.value.toFixed(1) : '—'}`,
    detail: parts.join(' '),
    evidence,
    confidence: 'medium',
    caveat: '此處的「美元指數」為 Fed 的廣義貿易加權指數，與新聞常引用的 ICE DXY 成分與基期不同，數值不可互相比較。',
  });
}

/**
 * 完整宏觀解讀。
 *
 * @param {{series:Object, schedule:Object}} input
 */
function interpretMacro(input) {
  const series = input.series || {};
  const schedule = input.schedule || null;

  const findings = [
    interpretInflation(series),
    interpretRates(series, schedule),
    interpretLabor(series),
    interpretActivity(series),
    interpretExternal(series),
  ];

  // 資料缺口
  const gaps = [];
  for (const f of findings) {
    if (f.stance === 'unknown') gaps.push(f.topic);
  }

  // 綜合傾向：數鷹派與鴿派票數
  const hawk = findings.filter((f) => f.stance === 'hawkish').length;
  const dove = findings.filter((f) => f.stance === 'dovish').length;
  const mixed = findings.filter((f) => f.stance === 'mixed').length;

  // 全部主題都取不到資料時，不可說「大致中性」。
  // 「中性」是一個**判斷結果**，代表「看過了、兩邊力量相當」；
  // 而「全部資料不足」代表「根本沒看到」—— 兩者混為一談會讓使用者
  // 誤以為系統已經評估過並得出中性結論。這與本專案
  // 「寧可沒有預測，也不要錯的預測」是同一條原則。
  const allUnknown = findings.every((f) => f.stance === 'unknown');

  let overall;
  if (allUnknown) overall = { stance: 'unknown', text: '所有指標皆無法取得，無法判讀目前環境' };
  else if (hawk > dove + 1) overall = { stance: 'hawkish', text: '多數指標指向偏緊（hawkish）的環境' };
  else if (dove > hawk + 1) overall = { stance: 'dovish', text: '多數指標指向偏鬆（dovish）的環境' };
  else if (mixed > 0) overall = { stance: 'mixed', text: '指標彼此矛盾，沒有單一方向' };
  else overall = { stance: 'neutral', text: '指標大致中性，沒有明顯方向' };

  return {
    scope: 'macro',
    generatedAt: new Date().toISOString(),
    mode: 'rule',
    overall: {
      ...overall,
      counts: { hawkish: hawk, dovish: dove, mixed, unknown: gaps.length },
    },
    findings,
    gaps,
    disclaimer: '本解讀為規則型推理，描述「已公布的數據」與「相對歷史位置」，'
      + '不構成任何投資建議，也不預測未來走勢。所有數值皆可回溯至來源，請自行覆核。',
  };
}

/* ============================================================
   財報解讀
   ============================================================ */

/**
 * 企業財報解讀。
 *
 * 每個結論都掛在實際數字上；算不出來的欄位列入 gaps，不用形容詞帶過。
 */
function interpretFundamentals(fund, ctx) {
  if (!fund || !fund.available) {
    return {
      scope: 'fundamentals',
      generatedAt: new Date().toISOString(),
      mode: 'rule',
      available: false,
      unavailable: fund ? fund.unavailable : 'transient',
      reason: fund ? fund.reason : '無法取得財報資料',
      hint: fund ? fund.hint : null,
      findings: [],
      gaps: [],
      disclaimer: null,
    };
  }

  const m = fund.metrics || {};
  const findings = [];
  const gaps = [...(fund.gaps || [])];

  // --- 1. 成長性 ---
  if (m.revenue && m.revenue.yoy != null) {
    const yoy = m.revenue.yoy;
    const base = m.revenue.basis === 'FY' ? '年度' : 'TTM';
    findings.push(finding({
      id: 'growth',
      topic: 'growth',
      stance: yoy > 10 ? 'positive' : yoy > 0 ? 'neutral' : 'negative',
      headline: `營收${base}同比 ${yoy > 0 ? '+' : ''}${yoy.toFixed(1)}%`,
      detail: `以 ${base} 口徑計算，營收較去年同期${yoy > 0 ? '成長' : '衰退'} ${Math.abs(yoy).toFixed(1)}%。`
        + (m.revenue.method ? `（計算方式：${m.revenue.method}）` : '')
        + (yoy > 15 ? ' 增速處於高速區間。'
          : yoy > 5 ? ' 增速穩健。'
            : yoy > 0 ? ' 增速偏緩。'
              : ' 營收正在萎縮，需留意是否為結構性問題。'),
      evidence: [{
        label: '營收', value: m.revenue.value, unit: 'USD',
        asOf: m.revenue.to, basis: base, yoy,
      }],
      confidence: 'high',
    }));
  } else if (!m.revenue) {
    gaps.push('營收同比（缺少可比較的基期）');
  }

  // --- 2. 獲利能力 ---
  const margins = [
    ['毛利率', m.grossMargin],
    ['營業利益率', m.operatingMargin],
    ['淨利率', m.netMargin],
  ].filter(([, v]) => v != null);

  if (margins.length) {
    const detail = margins.map(([k, v]) => `${k} ${v.toFixed(2)}%`).join('、');
    let comment = '';
    // 用毛利率與淨利率的落差判斷費用結構
    if (m.grossMargin != null && m.netMargin != null) {
      const opexGap = +(m.grossMargin - m.netMargin).toFixed(2);
      comment = ` 毛利與淨利之間相差 ${opexGap} 個百分點，`
        + (opexGap > 40 ? '代表營業費用（研發、行銷、管理）佔比很高。'
          : opexGap > 20 ? '費用結構屬於中等水準。'
            : '費用控制相對精簡，大部分毛利能轉為淨利。');
    }
    findings.push(finding({
      id: 'margins', topic: 'profitability', stance: 'neutral',
      headline: detail,
      detail: detail + '。' + comment,
      evidence: margins.map(([k, v]) => ({ label: k, value: v, unit: '%', asOf: m.revenue ? m.revenue.to : null })),
      confidence: 'high',
    }));
  }

  // --- 3. 資本效率（ROE 需特別小心） ---
  if (m.roe != null) {
    findings.push(finding({
      id: 'roe', topic: 'efficiency', stance: m.roe > 15 ? 'positive' : m.roe > 0 ? 'neutral' : 'negative',
      headline: `ROE ${m.roe.toFixed(1)}%`,
      detail: `股東權益報酬率 ${m.roe.toFixed(1)}%。`
        + (m.roeNote ? ' ' + m.roeNote
          : m.roe > 15 ? ' 高於多數企業的資金成本，資本運用效率良好。'
            : m.roe > 0 ? ' 為正值但不算突出。'
              : ' 為負值，代表本期虧損。'),
      evidence: [{
        label: 'ROE', value: m.roe, unit: '%',
        asOf: fund.balance && fund.balance.equity ? fund.balance.equity.asOf : null,
      }],
      confidence: m.roeNote ? 'medium' : 'high',
      caveat: m.roeNote,
    }));
  }

  // --- 4. 財務結構 ---
  if (m.debtRatio != null && fund.balance) {
    const dr = m.debtRatio;
    findings.push(finding({
      id: 'leverage', topic: 'leverage',
      stance: dr > 70 ? 'negative' : dr > 40 ? 'neutral' : 'positive',
      headline: `負債比 ${dr.toFixed(1)}%`,
      detail: `總負債 ${(fund.balance.liabilities.value / 1e9).toFixed(1)}B `
        + `／ 總資產 ${(fund.balance.assets.value / 1e9).toFixed(1)}B = ${dr.toFixed(1)}%。`
        + (dr > 70 ? ' 負債佔比偏高，需注意償債能力與利率風險。'
          : dr > 40 ? ' 負債水準中等。'
            : ' 負債佔比低，財務結構穩健。')
        + ' 注意：負債比高不必然是壞事——需要看負債的性質（有息 vs 營運週轉）與產業慣例。',
      evidence: [{
        label: '總負債', value: fund.balance.liabilities.value, unit: 'USD',
        asOf: fund.balance.liabilities.asOf,
      }, {
        label: '總資產', value: fund.balance.assets.value, unit: 'USD',
        asOf: fund.balance.assets.asOf,
      }],
      confidence: 'high',
    }));
  }

  // --- 5. 每股盈餘 ---
  if (m.epsDiluted) {
    const e = m.epsDiluted;
    findings.push(finding({
      id: 'eps', topic: 'earnings', stance: e.value > 0 ? 'positive' : 'negative',
      headline: `稀釋 EPS ${e.value.toFixed(2)}`,
      detail: `稀釋後每股盈餘 ${e.value.toFixed(2)}（${e.period === 'year' ? '年度' : e.period === 'quarter' ? '單季' : '期間'}值，`
        + `截至 ${e.to}）。` + (e.value <= 0 ? ' EPS 為負，本期處於虧損狀態。' : ''),
      evidence: [{ label: '稀釋 EPS', value: e.value, unit: 'USD/share', asOf: e.to }],
      confidence: 'high',
    }));
  }

  // --- 6. 市場定價（僅在提供市值時） ---
  if (ctx && ctx.price != null && m.epsDiluted && m.epsDiluted.value > 0) {
    const pe = +(ctx.price / m.epsDiluted.value).toFixed(2);
    findings.push(finding({
      id: 'valuation', topic: 'valuation', stance: 'neutral',
      headline: `本益比約 ${pe.toFixed(1)} 倍`,
      detail: `以股價 ${ctx.price} 與稀釋 EPS ${m.epsDiluted.value.toFixed(2)} 計算，`
        + `本益比約 ${pe.toFixed(1)} 倍。`
        + `此處的 EPS 為${m.epsDiluted.period === 'year' ? '年度' : '期間'}值，`
        + `若與 TTM EPS 不同，本益比會偏離市場慣用的算法。`,
      evidence: [
        { label: '股價', value: ctx.price, unit: ctx.currency || 'USD', asOf: ctx.priceAsOf || null },
        { label: '稀釋 EPS', value: m.epsDiluted.value, unit: 'USD/share', asOf: m.epsDiluted.to },
      ],
      confidence: 'medium',
      caveat: '本益比未考慮一次性項目與非經常性損益，不同資料源的 EPS 口徑可能不同。',
    }));
  } else if (!ctx || ctx.price == null) {
    gaps.push('本益比（未提供股價）');
  }

  return {
    scope: 'fundamentals',
    generatedAt: new Date().toISOString(),
    mode: 'rule',
    available: true,
    symbol: fund.symbol,
    entityName: fund.entityName,
    asOf: fund.asOf,
    findings,
    gaps: [...new Set(gaps)],
    disclaimer: '本解讀基於 SEC XBRL 申報數字，僅描述已公布的財務狀況，'
      + '不構成投資建議。比率計算方式已在各條說明中標明，請注意口徑差異。',
  };
}

/* ============================================================
   可選：LLM 文字潤飾
   ============================================================ */

/**
 * 讀取 LLM 設定。優先環境變數，其次 config.json 的 `llm` 區塊。
 *
 * 為什麼要支援 config.json：本專案既有慣例就是「環境變數優先、設定檔次之」
 * （見 lib/telegram.js），且 config.json 已列入 .gitignore，適合放金鑰。
 *
 * 支援的環境變數：
 *   LLM_API_KEY / OPENAI_API_KEY      金鑰
 *   LLM_BASE_URL / OPENAI_BASE_URL    API base（含 /v1）
 *   LLM_MODEL / OPENAI_MODEL          模型名
 *   LLM_MAX_TOKENS                    輸出上限
 *   LLM_TIMEOUT_MS                    逾時毫秒數
 *   LLM_DISABLE_THINKING              設 1 時送出 enable_thinking:false（見下）
 *   LLM_CONFIG_PATH                   自訂設定檔路徑（測試用；設為空字串可完全跳過設定檔）
 */
function loadLlmConfig() {
  const out = {
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || '',
    model: process.env.LLM_MODEL || process.env.OPENAI_MODEL || '',
    maxTokens: Number(process.env.LLM_MAX_TOKENS) || 0,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 0,
    disableThinking: process.env.LLM_DISABLE_THINKING === '1',
  };
  // 測試需要「完全沒有金鑰」的環境，但正式環境的 config.json 可能已填金鑰。
  // 因此允許用 LLM_CONFIG_PATH='' 明確跳過設定檔（單元測試 J1 就靠這個）。
  const explicit = process.env.LLM_CONFIG_PATH;
  if (explicit === '') return out;

  try {
    const p = explicit || path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const c = j.llm || {};
      out.apiKey = out.apiKey || c.apiKey || '';
      out.baseUrl = out.baseUrl || c.baseUrl || '';
      out.model = out.model || c.model || '';
      out.maxTokens = out.maxTokens || Number(c.maxTokens) || 0;
      out.timeoutMs = out.timeoutMs || Number(c.timeoutMs) || 0;
      if (typeof c.disableThinking === 'boolean') {
        out.disableThinking = out.disableThinking || c.disableThinking;
      }
    }
  } catch { /* 設定檔壞掉時靜默忽略，退回規則層 */ }
  return out;
}

/**
 * 把一段文字裡出現的所有數字收集起來（正規化為一位／兩位小數兩種寫法）。
 *
 * 用途：作為幻覺檢查的「白名單」。關鍵是**白名單必須包含我們餵給模型的
 * 全部文字**，不能只看 evidence[].value。
 *
 * 這是實測踩到的坑：模型的輸出會引用 detail 裡的「歷史 18.3 百分位」、
 * 「99.2 百分位」這類數字。若白名單只收 evidence，這些正確的引用會被
 * 判成幻覺，導致一份好輸出被整段丟棄。
 */
function collectNumbers(text, into) {
  const set = into || new Set();
  const nums = String(text || '').match(/-?\d+(?:\.\d+)?/g) || [];
  for (const n of nums) {
    const v = Math.abs(parseFloat(n));
    if (!isFinite(v)) continue;
    set.add(v.toFixed(1));
    set.add(v.toFixed(2));
    set.add(String(Math.round(v)));
  }
  return set;
}

/**
 * 若設定了 LLM 金鑰，把規則層結論改寫成更自然的敘述。
 *
 * 嚴格限制：
 *   - 只送出規則層已算好的結論與數值，**不讓模型自行取數**
 *   - 要求模型只能改寫、不得新增數字
 *   - 任何失敗（無 Key、逾時、回應格式錯）都靜默退回規則層輸出
 *
 * 三個實測修正（見 tests/macro-unit.cjs J 系列）：
 *   1. **推理型模型的 token 預算**：DeepSeek-V4.1-flash 等模型會先產生
 *      reasoning_content，且 reasoning_tokens **計入 max_tokens**。
 *      實測 max_tokens=700 時 700 全被推理吃掉、content 為空字串
 *      （finish_reason='length'）。因此預設值必須拉高到 3000。
 *   2. **content 為空要能分辨原因**：若 finish_reason='length'，要明確回報
 *      「token 預算不足」而不是含糊的「回應為空」，否則使用者無法調參。
 *   3. **幻覺白名單要含 prompt 全文**：模型引用 detail 裡的百分位數是合法的。
 *
 * @returns {Promise<{text:string|null, mode:string, note:string|null}>}
 */
async function polishWithLlm(interpretation, opts) {
  const cfg = opts || {};
  const fileCfg = loadLlmConfig();

  const apiKey = cfg.apiKey || fileCfg.apiKey;
  if (!apiKey) {
    return { text: null, mode: 'rule', note: '未設定 LLM API Key，使用規則型解讀' };
  }

  // 推理型模型需要遠高於一般模型的預算，預設 3000
  const maxTokens = cfg.maxTokens || fileCfg.maxTokens || 3000;
  // 實測一次完整潤飾約 11–15 秒（含 1900–2300 推理 token），20 秒太緊
  const timeoutMs = cfg.timeoutMs || fileCfg.timeoutMs || 60000;
  const disableThinking = cfg.disableThinking != null
    ? Boolean(cfg.disableThinking) : fileCfg.disableThinking;

  const payload = interpretation.findings.map((f) => ({
    headline: f.headline, detail: f.detail, stance: f.stance,
  }));

  const prompt = [
    '以下是一組已計算完成的經濟／財務解讀結論。請改寫成一段通順的繁體中文摘要。',
    '嚴格規則：',
    '1. 只能使用我提供的數字，**絕對不可新增或推測任何數值**。',
    '2. 不可給出投資建議，不可預測價格或未來走勢。',
    '3. 若結論彼此矛盾，必須明確說出矛盾，不可粉飾。',
    '4. 長度 150–250 字。',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');

  try {
    const base = (cfg.baseUrl || fileCfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const body = {
      model: cfg.model || fileCfg.model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: maxTokens,
    };
    // 推理型模型（如 DeepSeek-V4.1-flash）預設會先想一大段再回答，
    // 而且 reasoning_tokens **計入 max_tokens**。實測同一份輸入的推理量
    // 在 1340–6167 tokens 之間劇烈波動，導致有時正文被擠成空字串，
    // 延遲也從 2 秒膨脹到 29 秒。這個任務只是「換句話說」，
    // 不需要推理，因此預設關閉；若供應商不認此參數會直接忽略，無副作用。
    if (disableThinking) body.enable_thinking = false;

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return { text: null, mode: 'rule', note: `LLM 回應 HTTP ${res.status}，改用規則型解讀` };
    }
    const j = await res.json();
    const choice = j && j.choices && j.choices[0];
    const msg = (choice && choice.message) || {};
    // 只取 content。推理型模型另附的 reasoning_content 是模型的思考過程，
    // 絕不可當成結果顯示給使用者（裡面常有未經查核的草稿數字）。
    const text = String(msg.content || '').trim();

    if (!text) {
      // 分辨「預算不足」與「真的空回應」，否則使用者無從調參
      const cut = choice && choice.finish_reason === 'length';
      const rt = j && j.usage && j.usage.completion_tokens_details
        && j.usage.completion_tokens_details.reasoning_tokens;
      return {
        text: null, mode: 'rule',
        note: cut
          ? `LLM 的 ${maxTokens} token 預算在產生正文前就被推理用盡`
            + `（推理 ${rt || '?'} tokens），改用規則型解讀。`
            + '可調高 llm.maxTokens 或改用非推理模型。'
          : 'LLM 回應為空，改用規則型解讀',
      };
    }

    // 後置檢查：模型若生出「來源完全沒出現過」的數字，直接棄用（防幻覺污染）。
    //
    // 白名單 = evidence 的數值 ∪ 我們送出的 prompt 全文裡出現的所有數字。
    // 後者不可省略：模型會合法地引用 detail 中的百分位數等數字，
    // 若只認 evidence，正確輸出會被誤判成幻覺而整段丟棄。
    const knownNumbers = new Set();
    for (const f of interpretation.findings) {
      for (const e of f.evidence || []) {
        if (typeof e.value === 'number') {
          knownNumbers.add(Math.abs(e.value).toFixed(1));
          knownNumbers.add(Math.abs(e.value).toFixed(2));
          knownNumbers.add(String(Math.round(Math.abs(e.value))));
        }
        // 證據本身就帶的百分位也要算合法
        if (typeof e.percentile === 'number') {
          collectNumbers(String(e.percentile), knownNumbers);
        }
      }
      collectNumbers(f.headline, knownNumbers);
      collectNumbers(f.detail, knownNumbers);
      collectNumbers(f.caveat, knownNumbers);
    }
    collectNumbers(prompt, knownNumbers);

    const mentioned = text.match(/\d+\.\d+/g) || [];
    const suspect = mentioned.filter((n) => {
      const v = Math.abs(parseFloat(n));
      return v > 0.05 && !knownNumbers.has(v.toFixed(1)) && !knownNumbers.has(v.toFixed(2));
    });
    if (suspect.length > 3) {
      return {
        text: null, mode: 'rule',
        note: `LLM 輸出含 ${suspect.length} 個無法對應到來源的數字（${suspect.slice(0, 3).join(', ')}），已棄用以避免幻覺`,
      };
    }

    return { text, mode: 'llm', note: null };
  } catch (e) {
    const aborted = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      text: null, mode: 'rule',
      note: aborted
        ? `LLM 逾時（${Math.round(timeoutMs / 1000)} 秒），改用規則型解讀`
        : `LLM 呼叫失敗（${e.message}），改用規則型解讀`,
    };
  }
}

module.exports = {
  interpretMacro,
  interpretFundamentals,
  interpretInflation,
  interpretRates,
  interpretLabor,
  interpretActivity,
  interpretExternal,
  polishWithLlm,
  band,
};
