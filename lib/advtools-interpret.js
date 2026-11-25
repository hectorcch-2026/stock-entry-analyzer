'use strict';

/**
 * 四大工具 —— 解讀層（Interpretation）
 *
 * 計算層（advtools.js）只負責算出「客觀事實」；
 * 本層負責把事實翻譯成使用者要的四個欄位：
 *
 *   dimension  觀察維度   —— 這個工具在看什麼、怎麼看
 *   entry      最佳進場   —— 什麼條件成立時是好的下注點（含目前的符合程度）
 *   stop       止損／失效 —— 什麼情況代表原本的判斷錯了
 *   platforms  支援平台   —— 哪裡可以自己看到這個指標
 *
 * 關鍵設計：每條訊號都帶 status，不是單純的文字描述。
 *   'triggered'  條件已成立 —— 現在就符合
 *   'near'       接近成立   —— 差一點，值得盯著
 *   'not-met'    未成立
 *   'invalid'    已失效
 *   'unknown'    資料不足無法判定
 *
 * 這樣前端可以上色、可以排序，使用者一眼知道「現在該做什麼」，
 * 而不是讀完四段文字還要自己判斷。
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(d) : null);

/* ============================================================
   模組 1：VRVP / FRVP
   ============================================================ */

function interpretVolumeProfile(vp, ctx) {
  const platforms = [
    { name: 'TradingView', note: '內建「Volume Profile Fixed Range / Visible Range」指標，可直接畫 VAH/VAL/POC' },
    { name: '富途牛牛', note: 'K 線圖 → 指標 → 籌碼分佈（Volume Profile），支援港美股' },
  ];

  const dimension = {
    title: '籌碼堆積與重貨區',
    points: [
      '把區間內每一根 K 線的成交量，依其高低價範圍攤分到各價位格，形成橫向的量能分佈。',
      'POC（Point of Control）= 成交量最大的價位，代表市場共识成本最集中的地方。',
      'Value Area = 涵蓋 70% 成交量的價格帶，上界 VAH、下界 VAL，是籌碼的主要戰場。',
      '價格在 VAH 之上代表籌碼向上換手成功；跌破 VAL 代表套牢盤全面失守。',
    ],
  };

  if (!vp.available) {
    return {
      key: 'vrvp',
      title: 'VRVP / FRVP 成交量分佈',
      subtitle: 'Volume Profile · 籌碼堆積與重貨區',
      available: false,
      reason: vp.reason,
      hint: '需要至少 20 個交易日的完整量價資料。若為新上市股票，可改用 TradingView 的分時成交量分佈觀察。',
      dimension,
      entry: [],
      stop: [],
      platforms,
      data: null,
    };
  }

  const { price, poc, vah, val, posInVA, hist, facts } = {
    price: vp.price, poc: vp.poc, vah: vp.vah, val: vp.val,
    posInVA: vp.posInVA, facts: vp.facts,
  };

  /* ---------- 進場信號 ---------- */
  const entry = [];

  // 信號 A：突破 VAH 後回踩確認
  const nearVAH = Math.abs(vp.distToVAHPct ?? 999) <= 1.5;
  const aboveVAH = vp.facts.aboveVAH;
  entry.push({
    id: 'vah-retest',
    label: '突破 VAH 後回踩確認',
    detail: `價格站上 ${vah}（VAH）後，回踩不破並以量縮止跌，代表上方籌碼已換手成功，是順勢進場點。`,
    status: aboveVAH && nearVAH ? 'triggered' : aboveVAH ? 'near' : 'not-met',
    statusText: aboveVAH && nearVAH
      ? `現價 ${price} 正貼近 VAH ${vah}，若出現量縮止跌即為確認`
      : aboveVAH
        ? `已在 VAH 之上（距 ${vp.distToVAHPct}%），等回踩 ${vah} 再確認`
        : `現價尚未站上 VAH ${vah}（差 ${vp.distToVAHPct}%）`,
    levels: { trigger: vah },
  });

  // 信號 B：回調至 POC 止跌
  const nearPOC = Math.abs(vp.distToPOCPct ?? 999) <= 1.5;
  entry.push({
    id: 'poc-bounce',
    label: '回調至 POC 止跌',
    detail: `POC ${poc} 是全市場最集中的成本區，價格回到這裡常有承接買盤，是低風險的埋伏點。`,
    status: nearPOC ? 'triggered' : 'not-met',
    statusText: nearPOC
      ? `現價 ${price} 距 POC ${poc} 僅 ${vp.distToPOCPct}%，且該區近 20 日已被觸及 ${vp.pocTouches} 次`
      : `現價距 POC ${poc} 尚有 ${vp.distToPOCPct}%`,
    levels: { trigger: poc },
  });

  /* ---------- 止損 / 失效信號 ---------- */
  const stop = [];

  stop.push({
    id: 'poc-break',
    label: '放量跌破 POC 且無法快速收回',
    detail: `POC 是多空成本中樞。若以放量（≥ 1.3 倍均量）跌破 ${poc}，且 1~2 根 K 線內收不回，代表籌碼結構轉空，原本的多方假設失效。`,
    status: vp.facts.belowVAL ? 'invalid' : nearPOC && (vp.volRatio ?? 0) >= 1.3 ? 'near' : 'not-met',
    statusText: vp.facts.belowVAL
      ? `現價已跌破 VAL ${val}，POC 防線早已失守`
      : nearPOC
        ? `現價貼近 POC，近 3 日均量為區間均量的 ${vp.volRatio} 倍${(vp.volRatio ?? 0) >= 1.3 ? '（放量，警戒）' : '（未見放量）'}`
        : `現價距 POC 仍有 ${vp.distToPOCPct}%，尚未構成威脅`,
    levels: { trigger: poc },
  });

  stop.push({
    id: 'val-break',
    label: '跌破 VAL',
    detail: `VAL ${val} 是價值區下界，跌破代表 70% 的籌碼都處於虧損，容易引發止損連鎖賣壓，應無條件退出。`,
    status: vp.facts.belowVAL ? 'invalid' : Math.abs(vp.distToVALPct ?? 999) <= 1.5 ? 'near' : 'not-met',
    statusText: vp.facts.belowVAL
      ? `⚠️ 現價 ${price} 已跌破 VAL ${val}（${vp.distToVALPct}%），結構轉空`
      : `現價距 VAL ${val} 尚有 ${vp.distToVALPct}% 的緩衝`,
    levels: { trigger: val },
  });

  return {
    key: 'vrvp',
    title: 'VRVP / FRVP 成交量分佈',
    subtitle: 'Volume Profile · 籌碼堆積與重貨區',
    available: true,
    dimension,
    entry,
    stop,
    platforms,
    data: {
      price,
      poc: vp.poc,
      vah: vp.vah,
      val: vp.val,
      posInVA,
      posText: posInVA === 'above-vah' ? '在價值區之上（強勢）'
        : posInVA === 'below-val' ? '在價值區之下（弱勢）' : '在價值區之內（整理）',
      distToPOCPct: vp.distToPOCPct,
      distToVAHPct: vp.distToVAHPct,
      distToVALPct: vp.distToVALPct,
      valueAreaPct: vp.valueAreaPct,
      lookback: vp.lookback,
      pocTouches: vp.pocTouches,
      volRatio: vp.volRatio,
      heavyZones: vp.heavyZones,
      profile: vp.profile,
      priceRange: vp.priceRange,
    },
  };
}

/* ============================================================
   模組 2：Anchored VWAP
   ============================================================ */

function interpretAnchoredVWAP(av, ctx) {
  const platforms = [
    { name: 'TradingView', note: '「Anchored VWAP」工具，可在任一 K 線右键設定錨點' },
    { name: 'Thinkorswim', note: 'Studies → VWAP，支援 Anchored 模式與多錨點疊加' },
  ];

  const dimension = {
    title: '特定事件後的資金平均成本',
    points: [
      'VWAP 是以成交量加權的平均成交價，代表「這段期間進場者的平均成本」。',
      '錨定（Anchored）指從某個關鍵事件日起算，例如財報日、重大利好消息、底部起漲日。',
      '價格在 AVWAP 之上 → 該事件後進場的資金整體獲利，籌碼安定，易形成支撐。',
      '價格在 AVWAP 之下 → 該批資金虧損，反彈時容易遇到解套賣壓。',
    ],
  };

  if (!av.available) {
    return {
      key: 'avwap',
      title: 'Anchored VWAP 錨定均價',
      subtitle: '事件後的資金平均成本',
      available: false,
      reason: av.reason,
      hint: '需要至少 30 個交易日，且區間內要有明顯的事件型態（放量突破、最大量日、階段低點）。',
      dimension,
      entry: [],
      stop: [],
      platforms,
      data: null,
    };
  }

  const p = av.primary;
  const entry = [];
  const stop = [];

  // 主要進場：回踩 AVWAP 且出現看漲 K 線
  entry.push({
    id: 'avwap-retest',
    label: `回踩${p.anchor.label}的 AVWAP 且出現看漲 K 線`,
    detail: `以 ${p.anchor.label}（${p.anchor.price}，${p.anchor.barsAgo} 根 K 線前）為錨點，AVWAP 現為 ${p.vwap}。`
      + ' 價格回踩此線不破，且當根收盤高於開盤、下影線收復過半，代表該批資金願意守成本，是勝率較高的進場點。',
    status: p.nearVWAP && p.bullishBar ? 'triggered' : p.nearVWAP ? 'near' : 'not-met',
    statusText: p.nearVWAP
      ? `現價 ${av.price} 貼近 AVWAP ${p.vwap}（${p.distPct}%），${p.bullishBar ? '且近 3 根已出現看漲 K 線 ✓' : '但尚未出現明確看漲 K 線'}`
      : `現價距 AVWAP ${p.vwap} 尚有 ${p.distPct}%`,
    levels: { trigger: p.vwap, anchor: p.anchor.price },
  });

  // 輔助進場：多錨點共振
  if (av.count > 1) {
    const held = av.series.filter((s) => s.aboveVWAP);
    entry.push({
      id: 'multi-anchor',
      label: '多錨點 AVWAP 共振支撐',
      detail: '不同事件錨點的 AVWAP 若集中在相近價位，代表多批資金成本重疊，支撐力度更強。',
      status: held.length === av.count ? 'triggered' : held.length > 0 ? 'near' : 'not-met',
      statusText: `${av.count} 條 AVWAP 中有 ${held.length} 條位於現價之下`
        + (held.length ? `（下方最近為 ${held.reduce((b, s) => (s.distPct < b.distPct ? s : b)).vwap}）` : ''),
      levels: {},
    });
  }

  // 止損：收盤明確跌破關鍵 AVWAP
  stop.push({
    id: 'avwap-break',
    label: '收盤價明確跌破關鍵 AVWAP',
    detail: `若收盤跌破 ${p.vwap} 且幅度超過 1%（而非盤中假跌破），代表 ${p.anchor.label} 後進場的資金已全面虧損，`
      + '原本的支撐假設失效。',
    status: !p.aboveVWAP
      ? (Math.abs(p.distPct ?? 0) > 1 ? 'invalid' : 'near')
      : 'not-met',
    statusText: p.aboveVWAP
      ? `現價仍在 AVWAP ${p.vwap} 之上（+${p.distPct}%），防線未破`
      : `⚠️ 現價已跌破 AVWAP ${p.vwap}（${p.distPct}%）${Math.abs(p.distPct ?? 0) > 1 ? '，且幅度超過 1%，視為有效跌破' : '，但幅度未達 1%，可能是假跌破'}`,
    levels: { trigger: p.vwap },
  });

  // 補充止損：錨點本身的價位
  stop.push({
    id: 'anchor-break',
    label: '跌破錨定事件當日的價位',
    detail: `錨點 ${p.anchor.price} 是該事件的有效性底線。跌破它代表事件帶來的漲幅完全回吐，該錨點已失去意義，需重新尋找錨點。`,
    status: av.price < p.anchor.price ? 'invalid' : 'not-met',
    statusText: av.price >= p.anchor.price
      ? `現價 ${av.price} 仍在錨點價 ${p.anchor.price} 之上（自錨點以來 ${p.gainSince}%）`
      : `⚠️ 現價已跌破錨點價 ${p.anchor.price}，該事件漲幅全數回吐`,
    levels: { trigger: p.anchor.price },
  });

  return {
    key: 'avwap',
    title: 'Anchored VWAP 錨定均價',
    subtitle: '事件後的資金平均成本',
    available: true,
    dimension,
    entry,
    stop,
    platforms,
    data: {
      price: av.price,
      aboveCount: av.aboveCount,
      totalCount: av.count,
      series: av.series.map((s) => ({
        anchor: s.anchor,
        vwap: s.vwap,
        slope: s.slope,
        distPct: s.distPct,
        gainSince: s.gainSince,
        aboveVWAP: s.aboveVWAP,
        holding: s.holding,
        touches: s.touches,
        breaches: s.breaches,
        isPrimary: s === av.primary,
      })),
    },
  };
}

/* ============================================================
   模組 3：FVG / 價格裂口
   ============================================================ */

function interpretFVG(fv, ctx) {
  const platforms = [
    { name: '所有主流看盤軟件', note: '多數平台無內建 FVG，但可用「矩形」手動標記；TradingView 有社群指標（Fair Value Gap / ICT Concepts）' },
    { name: 'TradingView', note: '搜尋 "Fair Value Gap" 或 "ICT" 可找到自動標記指標' },
  ];

  const dimension = {
    title: '短期買賣動能失衡區',
    points: [
      'FVG（Fair Value Gap）由三根 K 線構成：中間留下未被成交的價格真空帶，代表當時買賣力量嚴重失衡。',
      '看漲 FVG：第 1 根的高點低於第 3 根的低點，價格快速上衝留下缺口。',
      '看跌 FVG：第 1 根的低點高於第 3 根的高點，價格急跌留下缺口。',
      '市場傾向「回補效率缺口」——價格常會回頭測試這些區間，因此它們既是進場區，也是判斷動能是否持續的依據。',
      '傳統裂口（Gap）只看今開 vs 昨收的跳空，FVG 看的是結構性失衡，更適合日內與短波段。',
    ],
  };

  if (!fv.available) {
    return {
      key: 'fvg',
      title: '價格裂口 / FVG',
      subtitle: 'Fair Value Gap · 動能失衡區',
      available: false,
      reason: fv.reason,
      hint: '需要至少 10 根 K 線。',
      dimension,
      entry: [],
      stop: [],
      platforms,
      data: null,
    };
  }

  const entry = [];
  const stop = [];

  if (!fv.totalFound) {
    // 沒有缺口也是有意義的資訊：代表走勢連續、無失衡
    return {
      key: 'fvg',
      title: '價格裂口 / FVG',
      subtitle: 'Fair Value Gap · 動能失衡區',
      available: true,
      dimension,
      entry: [{
        id: 'no-gap',
        label: '目前無有效缺口',
        detail: fv.message,
        status: 'not-met',
        statusText: '走勢連續、無明顯動能失衡，等出現新的 FVG 再考慮以此為依據',
        levels: {},
      }],
      stop: [],
      platforms,
      data: {
        totalFound: 0, activeCount: 0, filledCount: 0,
        active: [], filledRecently: [], nearest: null, price: fv.price,
      },
    };
  }

  // 進場 A：回調進入未回補的看漲 FVG
  const bullActive = fv.active.filter((g) => g.direction === 'bullish');
  const inBull = fv.inside && fv.inside.direction === 'bullish';
  const nearestBull = bullActive.length
    ? bullActive.reduce((b, g) => (Math.abs(g.distPct) < Math.abs(b.distPct) ? g : b))
    : null;

  if (bullActive.length) {
    entry.push({
      id: 'fvg-retest',
      label: '價格回調進入看漲 FVG 區間',
      detail: `未回補的看漲 FVG 是潛在的支撐真空帶。價格回落進入 ${nearestBull.lower} ~ ${nearestBull.upper} 時，`
        + '若出現止跌（下影線、量縮、收盤拉回），是低風險的進場區。',
      status: inBull ? 'triggered' : (Math.abs(nearestBull.distPct) <= 1.5 ? 'near' : 'not-met'),
      statusText: inBull
        ? `✓ 現價 ${fv.price} 正位於看漲 FVG ${nearestBull.lower} ~ ${nearestBull.upper} 之內`
        : `最近的看漲 FVG 在 ${nearestBull.lower} ~ ${nearestBull.upper}，距現價 ${nearestBull.distPct}%`,
      levels: { lower: nearestBull.lower, upper: nearestBull.upper },
    });
  }

  // 進場 B：突破裂口上沿且縮量止跌
  const aboveBull = bullActive.filter((g) => fv.price > g.upper);
  const nearestAbove = aboveBull.length
    ? aboveBull.reduce((b, g) => (Math.abs(g.distPct) < Math.abs(b.distPct) ? g : b))
    : null;

  entry.push({
    id: 'fvg-breakout',
    label: '突破裂口上沿時縮量止跌',
    detail: '價格站上缺口上沿後若量能收縮、且不再回落，代表缺口已由壓力轉為支撐，是續漲訊號。',
    status: nearestAbove && Math.abs(nearestAbove.distPct) <= 2 ? 'near' : nearestAbove ? 'not-met' : 'not-met',
    statusText: nearestAbove
      ? `現價已在看漲 FVG ${nearestAbove.upper} 之上 ${nearestAbove.distPct}%`
      : '現價尚未突破任何未回補的看漲 FVG 上沿',
    levels: nearestAbove ? { trigger: nearestAbove.upper } : {},
  });

  // 止損：裂口被完全回補
  const filledBull = fv.filledRecently.filter((g) => g.lower != null);
  stop.push({
    id: 'fvg-filled',
    label: '裂口被完全回補（封閉）',
    detail: '缺口完全封閉代表原本推動價格的動能已經消散，突破失敗。'
      + '看漲 FVG 被完全回補後，該區間不再是支撐，反而成為壓力。',
    status: filledBull.length ? 'invalid' : 'not-met',
    statusText: filledBull.length
      ? `近 ${fv.lookback} 根內已有 ${fv.filledCount} 個缺口被完全回補${filledBull[0] ? `（最近一個：${filledBull[0].lower} ~ ${filledBull[0].upper}）` : ''}`
      : `目前 ${fv.activeCount} 個未回補缺口均未被封閉`,
    levels: {},
  });

  // 止損：跌回看跌 FVG 之中
  const bearActive = fv.active.filter((g) => g.direction === 'bearish');
  const inBear = fv.inside && fv.inside.direction === 'bearish';
  if (bearActive.length) {
    stop.push({
      id: 'fvg-bear-enter',
      label: '跌入看跌 FVG 區間',
      detail: '看跌 FVG 代表上方套牢的賣壓區。價格若無力突破反而跌回其中，代表反彈結束。',
      status: inBear ? 'invalid' : 'not-met',
      statusText: inBear
        ? `⚠️ 現價已跌入看跌 FVG ${fv.inside.lower} ~ ${fv.inside.upper}`
        : `上方有 ${bearActive.length} 個看跌 FVG，最近的在 ${bearActive[0].lower} ~ ${bearActive[0].upper}`,
      levels: bearActive[0] ? { lower: bearActive[0].lower, upper: bearActive[0].upper } : {},
    });
  }

  return {
    key: 'fvg',
    title: '價格裂口 / FVG',
    subtitle: 'Fair Value Gap · 動能失衡區',
    available: true,
    dimension,
    entry,
    stop,
    platforms,
    data: {
      price: fv.price,
      totalFound: fv.totalFound,
      activeCount: fv.activeCount,
      filledCount: fv.filledCount,
      lookback: fv.lookback,
      minGapPct: fv.minGapPct,
      active: fv.active,
      filledRecently: fv.filledRecently,
      nearest: fv.nearest,
      inside: fv.inside,
    },
  };
}

/* ============================================================
   模組 4：期權 OI / GEX
   ============================================================ */

function interpretGEX(gx, ctx) {
  const platforms = [
    { name: 'Unusual Whales', note: '專業 GEX / OI 視覺化，含 Put Wall、Call Wall、Zero Gamma，美股為主' },
    { name: 'SpotGamma', note: 'GEX 分析先驅，提供 Zero Gamma 與對沖壓力指標（付費）' },
    { name: '富途牛牛', note: '期權 → 期權異動 / 未平倉合約分佈，支援港美股期權' },
  ];

  const dimension = {
    title: '機構與做市商對沖博弈',
    points: [
      '做市商（dealer）賣出期權後必須用標的股票對沖 delta，這個對沖行為會反向影響股價。',
      'Positive Gamma 環境：做市商「買跌賣漲」對沖，抑制波動，股價傾向在區間內震盪。',
      'Negative Gamma 環境：做市商「追漲殺跌」對沖，放大波動，行情容易單邊加速。',
      'Put Wall = 看跌期權未平倉量最大的履約價，通常構成強力支撐（做市商在此有大量對沖需求）。',
      'Call Wall = 看漲期權未平倉量最大的履約價，通常構成壓力。',
      'Zero Gamma = 累積 GEX 由負轉正的價位。跌破此位代表環境由「壓波動」轉為「放大波動」，風險驟升。',
    ],
  };

  if (!gx.available) {
    return {
      key: 'gex',
      title: '期權 OI / GEX',
      subtitle: '機構與做市商對沖博弈',
      available: false,
      // transient = 暫時性取用失敗（限流 / 連線），非「此標的無期權」
      transient: !!gx.transient,
      reason: gx.reason,
      hint: gx.hint,
      dimension,
      entry: [],
      stop: [],
      platforms,
      data: null,
    };
  }

  const entry = [];
  const stop = [];

  // 進場：跌至 Put Wall 附近且處於正 Gamma
  entry.push({
    id: 'putwall-bounce',
    label: '股價跌至 Put Wall 附近，且處於正 Gamma 環境',
    detail: `Put Wall ${gx.putWall} 是做市商對沖需求最集中的價位，通常形成強力支撐。`
      + '若同時處於正 Gamma 環境（做市商壓抑波動），在此處止跌反彈的機率較高。',
    status: gx.facts.nearPutWall && gx.positiveGamma
      ? 'triggered'
      : gx.facts.nearPutWall
        ? 'near'
        : 'not-met',
    statusText: gx.facts.nearPutWall
      ? `現價 ${gx.spot} 距 Put Wall ${gx.putWall} 僅 ${gx.putWallDistPct}%，${gx.positiveGamma ? '且為正 Gamma 環境 ✓' : '但目前為負 Gamma 環境，支撐力道打折'}`
      : `現價距 Put Wall ${gx.putWall} 尚有 ${gx.putWallDistPct}%`,
    levels: { putWall: gx.putWall },
  });

  // 進場：Positive Gamma 區間內回檔
  entry.push({
    id: 'positive-gamma',
    label: '正 Gamma 環境下的區間低吸',
    detail: '正 Gamma 時做市商會壓抑波動，股價傾向在 Put Wall 與 Call Wall 之間震盪。'
      + '在區間下緣（接近 Put Wall）買、上緣（接近 Call Wall）賣，是此環境的順勢做法。',
    status: gx.positiveGamma && gx.facts.nearPutWall ? 'triggered'
      : gx.positiveGamma ? 'near' : 'not-met',
    statusText: gx.positiveGamma
      ? `目前為正 Gamma（淨曝險 ${gx.totalNetExposure >= 0 ? '+' : ''}${gx.totalNetExposure}），預期震盪於 ${gx.putWall} ~ ${gx.callWall}`
      : `目前為負 Gamma（淨曝險 ${gx.totalNetExposure}），波動會被放大，區間策略不適用`,
    levels: { lower: gx.putWall, upper: gx.callWall },
  });

  // 止損：跌破 Zero Gamma
  stop.push({
    id: 'zero-gamma-break',
    label: '跌破 Zero Gamma 轉折位',
    detail: 'Zero Gamma 是 gamma 環境的分水嶺。跌破它代表市場從「做市商壓波動」轉為「做市商放大波動」，'
      + '下跌會自我強化，是最明確的風險升級訊號。',
    status: gx.facts.belowZeroGamma ? 'invalid'
      : gx.zeroGamma != null && Math.abs(gx.zeroGammaDistPct ?? 999) <= 2 ? 'near' : 'not-met',
    statusText: gx.zeroGamma == null
      ? '本期權鏈未出現明顯的 Zero Gamma 轉折（累積曝險未由負轉正）'
      : gx.facts.belowZeroGamma
        ? `⚠️ 現價 ${gx.spot} 已跌破 Zero Gamma ${gx.zeroGamma}（${gx.zeroGammaDistPct}%），波動環境已轉為放大`
        : `現價在 Zero Gamma ${gx.zeroGamma} 之上（+${gx.zeroGammaDistPct}%），緩衝尚存`,
    levels: { zeroGamma: gx.zeroGamma },
  });

  // 止損：Put Wall 大量平倉
  if (gx.proxy) {
    stop.push({
      id: 'putwall-unwind',
      label: 'Put Wall 出現大量平倉',
      detail: 'Put Wall 的支撐來自做市商的對沖買盤。若該履約價的未平倉量快速減少（平倉），'
        + '對沖買盤隨之消失，支撐會瞬間瓦解。',
      status: 'unknown',
      statusText: '⚠️ 需 OI 變化率才能判定平倉，目前資料源不提供 OI（詳見下方資料說明）',
      levels: { putWall: gx.putWall },
    });
  } else {
    stop.push({
      id: 'putwall-unwind',
      label: 'Put Wall 出現大量平倉',
      detail: 'Put Wall 的支撐來自做市商的對沖買盤。若該履約價的未平倉量快速減少（平倉），對沖買盤隨之消失，支撐會瞬間瓦解。',
      status: 'not-met',
      statusText: `Put Wall ${gx.putWall} 目前權重仍為最高（需搭配前一日 OI 對比確認是否正在平倉）`,
      levels: { putWall: gx.putWall },
    });
  }

  return {
    key: 'gex',
    title: '期權 OI / GEX',
    subtitle: '機構與做市商對沖博弈',
    available: true,
    proxy: gx.proxy,
    proxyReason: gx.proxyReason,
    dimension,
    entry,
    stop,
    platforms,
    data: {
      spot: gx.spot,
      expiration: gx.expiration,
      dte: gx.dte,
      contracts: gx.contracts,
      strikes: gx.strikes,
      ivValidPct: gx.ivValidPct,
      putWall: gx.putWall,
      callWall: gx.callWall,
      zeroGamma: gx.zeroGamma,
      totalNetExposure: gx.totalNetExposure,
      positiveGamma: gx.positiveGamma,
      nearNetExposure: gx.nearNetExposure,
      pcr: gx.pcr,
      putWallDistPct: gx.putWallDistPct,
      callWallDistPct: gx.callWallDistPct,
      zeroGammaDistPct: gx.zeroGammaDistPct,
      chartRows: gx.chartRows,
      topStrikes: gx.topStrikes,
    },
  };
}

/* ============================================================
   對外入口
   ============================================================ */

/**
 * 把四個模組的計算結果組成完整回應
 * @param {{vp:object, avwap:object, fvg:object, gex:object}} raw 計算層輸出
 * @param {object} ctx 上下文（meta 等）
 */
function interpretAll(raw, ctx = {}) {
  return [
    interpretVolumeProfile(raw.vp, ctx),
    interpretAnchoredVWAP(raw.avwap, ctx),
    interpretFVG(raw.fvg, ctx),
    interpretGEX(raw.gex, ctx),
  ];
}

module.exports = { interpretAll, interpretVolumeProfile, interpretAnchoredVWAP, interpretFVG, interpretGEX };
