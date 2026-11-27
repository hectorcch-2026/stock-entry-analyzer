/* ===================================================
   新聞與 AI 分析（個股頁）+ 版塊輪動 × 宏觀經濟（RRG 頁）

   為什麼獨立成一支而不是併進 app.js：
     app.js 已 2900 行且被 19 個測試鎖住 DOM 契約，任何插入都可能
     破壞既有回歸。本檔只依賴 common.js 的 SA.*（格式化 / api / esc），
     不碰 app.js 內部函式，呈現失敗時也只影響自己的卡片。

   語言限制：全檔 ES5（var / function），與全站既有前端一致。
   =================================================== */
(function (global) {
  'use strict';

  var SA = global.SA || {};
  var doc = global.document;

  function $(id) { return doc.getElementById(id); }
  function esc(s) { return (SA.esc || function (x) { return String(x == null ? '' : x); })(s); }
  function fmt(v, d) { return (SA.fmt || function (x) { return x; })(v, d); }

  /* ---------------- 情緒 / 象限 / 流向 的呈現對照 ---------------- */

  /* 情緒顏色：刻意**不**用紅漲綠跌。
     紅綠在此代表「新聞正面／負面」，與股價漲跌是不同語義；
     若沿用漲跌色，使用者會把「新聞利空」誤讀成「股價下跌」。
     改用藍（正面）／橘（負面）／灰（中性），並一律附文字標籤。 */
  var SENTI = {
    positive: { cn: '偏多', cls: 's-pos' },
    negative: { cn: '偏空', cls: 's-neg' },
    neutral: { cn: '中性', cls: 's-neu' },
    mixed: { cn: '多空分歧', cls: 's-mix' },
  };

  var QUAD = {
    leading: { cn: '領先', cls: 'q-leading' },
    weakening: { cn: '弱化', cls: 'q-weakening' },
    lagging: { cn: '落後', cls: 'q-lagging' },
    improving: { cn: '改善', cls: 'q-improving' },
  };

  var FLOW = {
    inflow: { cn: '資金流入', arrow: '▲', cls: 'f-in' },
    outflow: { cn: '資金流出', arrow: '▼', cls: 'f-out' },
    neutral: { cn: '流向中性', arrow: '–', cls: 'f-neu' },
  };

  var IMPACT_DIR = { up: '偏向上行', down: '偏向下行', neutral: '中性' };
  var IMPACT_MAG = { large: '幅度較大', moderate: '幅度中等', small: '幅度有限' };
  var PRICED = {
    yes: '已反映於價格',
    partially: '部分已反映',
    no: '尚未反映',
    unknown: '是否已反映未知',
  };

  function qcn(q) { return (QUAD[q] || {}).cn || q || '—'; }
  function qcls(q) { return (QUAD[q] || {}).cls || ''; }
  function scn(s) { return (SENTI[s] || {}).cn || s || '—'; }
  function scls(s) { return (SENTI[s] || {}).cls || 's-neu'; }

  /** 相對時間：把 ISO 時間轉成「3 小時前」這種可讀字串 */
  function ago(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return '';
    var mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return '剛剛';
    if (mins < 60) return mins + ' 分鐘前';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' 小時前';
    var days = Math.round(hrs / 24);
    if (days < 30) return days + ' 天前';
    return Math.round(days / 30) + ' 個月前';
  }

  /** 把 ISO 時間轉成「11-26 08:00」這種短格式（含時區偏移，避免誤讀） */
  function shortTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '—';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function shortDate(s) {
    if (!s) return '—';
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return String(s);
  }

  /* ===================================================
     一、個股：新聞與 AI 分析
     =================================================== */

  var newsState = { symbol: null, mode: 'auto', loading: false, seq: 0 };

  /**
   * 載入並渲染新聞 AI 區塊。
   * @param {string} symbol
   * @param {object} [opts] { mode, refresh, name }
   */
  function loadNewsAi(symbol, opts) {
    var o = opts || {};
    var card = $('newsAiCard');
    if (!card || !symbol) return;

    newsState.symbol = symbol;
    if (o.mode) newsState.mode = o.mode;

    // 競態防護：切換股票時，舊請求可能比新請求晚回來而蓋掉新內容。
    // 用序號比對，只採用最後一次請求的結果。
    var seq = ++newsState.seq;
    newsState.loading = true;

    showLoading('newsAi', true);
    showEmpty('newsAi', null);

    var q = '/api/stock-news-ai?symbol=' + encodeURIComponent(symbol)
      + '&mode=' + encodeURIComponent(newsState.mode);
    if (o.name) q += '&name=' + encodeURIComponent(o.name);
    if (o.refresh) q += '&refresh=1';

    SA.api(q).then(function (d) {
      if (seq !== newsState.seq) return; // 已被更新的請求取代
      newsState.loading = false;
      showLoading('newsAi', false);
      renderNewsAi(d);
    }).catch(function (err) {
      if (seq !== newsState.seq) return;
      newsState.loading = false;
      showLoading('newsAi', false);
      var e = SA.describeError ? SA.describeError(err) : { title: '載入失敗', message: err.message };
      showEmpty('newsAi', {
        title: e.title,
        msg: e.message + (e.hint ? ' ' + e.hint : ''),
      });
    });
  }

  function renderNewsAi(d) {
    var body = $('newsAiBody');
    if (!body || !d) return;

    var ai = d.ai || {};
    var news = d.news || {};
    var prov = d.provenance || {};

    // 標題右側徽章：模式 + 則數
    var badge = $('newsAiBadge');
    if (badge) {
      var modeCn = ai.mode === 'llm' ? 'AI 模型分析' : '規則層分析';
      badge.textContent = modeCn + ' · ' + (news.count || 0) + ' 則';
      badge.className = 'news-ai-badge' + (ai.mode === 'llm' ? ' is-llm' : ' is-rule');
      badge.title = ai.mode === 'llm'
        ? '由 ' + (prov.aiModel || 'LLM') + ' 產出摘要與研判'
        : '未啟用模型或模型失敗，改以規則層（關鍵詞＋技術面）產生';
    }

    body.hidden = false;

    /* --- 情緒量表 --- */
    var score = typeof ai.score === 'number' ? ai.score : null;
    var gauge = $('newsAiGauge');
    if (gauge) gauge.innerHTML = gaugeSvg(score);

    var scoreEl = $('newsAiScore');
    if (scoreEl) {
      scoreEl.textContent = score == null ? '—' : (score > 0 ? '+' : '') + score.toFixed(2);
      scoreEl.className = scls(ai.sentiment);
    }
    var sentiEl = $('newsAiSentiment');
    if (sentiEl) {
      sentiEl.textContent = scn(ai.sentiment) + (ai.confidence ? '（信心 ' + confCn(ai.confidence) + '）' : '');
    }

    /* --- 摘要 --- */
    var sum = $('newsAiSummary');
    if (sum) sum.textContent = ai.summary || '—';

    /* --- ① 市場焦點 ---
       focus 來自後端 sides（LLM 或規則層），若缺席就退回 ai.summary，
       絕不留白：這一句是整張卡最上方的結論，空白等於沒有重點。 */
    var sides = d.sides || null;
    var focusEl = $('newsAiFocus');
    if (focusEl) {
      var focusText = (sides && sides.focus) || ai.summary || '—';
      focusEl.textContent = focusText;
    }

    /* --- ② 看好／看跌 雙欄 --- */
    if (sides) {
      renderSidesColumn($('newsAiBullList'), $('newsAiBullCount'), sides.bull, 'bull');
      renderSidesColumn($('newsAiBearList'), $('newsAiBearCount'), sides.bear, 'bear');

      var sidesHint = $('newsAiSidesHint');
      if (sidesHint) {
        var howCn = sides.mode === 'llm'
          ? '由 AI 逐則閱讀正文後分類'
          : '由片語方向詞典與正文關鍵句抽取';
        sidesHint.textContent = howCn
          + (sides.financialFacts && sides.financialFacts.available ? '，並對照最新財報' : '');
      }
    }

    /* --- ③ 結合財務狀況的解讀 --- */
    var finRead = $('newsAiFinRead');
    if (finRead) {
      var readText = (sides && sides.financial && sides.financial.read) || '';
      finRead.textContent = readText || '目前沒有可用的財報資料，僅就新聞內容判讀。';
    }

    // 財務事實小卡：只放後端給的數字，前端不自行換算（避免與財報卡不一致）
    var finFacts = $('newsAiFinFacts');
    if (finFacts) {
      var ff = sides && sides.financialFacts;
      if (ff && ff.available && ff.facts && ff.facts.length) {
        var heal = {};
        for (var hi = 0; hi < (ff.health || []).length; hi++) {
          heal[ff.health[hi].item] = ff.health[hi].level;
        }
        var chips = '';
        for (var fi = 0; fi < ff.facts.length; fi++) {
          var f = ff.facts[fi];
          var shown = formatFinValue(f);
          var lv = heal[f.label];
          var lvShort = lv ? String(lv).split('（')[0] : '';
          var cls = 'fin-chip'
            + (lvShort === '高' ? ' lv-high' : lvShort === '低' ? ' lv-low' : '');
          chips += '<span class="' + cls + '" title="'
            + esc((ff.period ? '期間 ' + ff.period + '　' : '')
              + (ff.asOf ? '截止 ' + ff.asOf : '')) + '">'
            + esc(f.label) + ' <b>' + esc(shown) + '</b>'
            + (lvShort ? '·' + esc(lvShort) : '')
            + '</span>';
        }
        finFacts.innerHTML = chips;
      } else {
        finFacts.innerHTML = '';
      }
    }

    var finHint = $('newsAiFinHint');
    if (finHint) {
      var ffh = sides && sides.financialFacts;
      finHint.textContent = ffh && ffh.available
        ? (ffh.period ? ffh.period + '　' : '') + (ffh.asOf || '')
        : '未取得財報資料';
    }

    /* --- 標籤：信心 / 模式 / 版塊 --- */
    var tags = $('newsAiTags');
    if (tags) {
      var tagHtml = '';
      if (d.sector) {
        tagHtml += '<span class="news-ai-tag ' + qcls(d.sector.quadrant) + '">'
          + esc(d.sector.label) + ' · ' + qcn(d.sector.quadrant) + '</span>';
      }
      if (ai.confidence) {
        tagHtml += '<span class="news-ai-tag">信心 ' + esc(confCn(ai.confidence)) + '</span>';
      }
      var t = news.tiers || {};
      if (t.tier1) {
        tagHtml += '<span class="news-ai-tag is-t1">一線媒體 ' + t.tier1 + ' 則</span>';
      }
      tagHtml += '<span class="news-ai-tag">時間窗 ' + (news.window && news.window.days ? news.window.days + ' 天' : '—') + '</span>';
      tags.innerHTML = tagHtml;
    }

    /* --- 關鍵事件 --- */
    var evBox = $('newsAiEvents');
    if (evBox) {
      var evs = ai.keyEvents || [];
      if (!evs.length) {
        evBox.innerHTML = '<li class="news-ai-ev-empty">本次新聞未萃取到明顯的關鍵事件。</li>';
      } else {
        var html = '';
        for (var i = 0; i < evs.length; i++) {
          var ev = evs[i] || {};
          var dir = ev.impact === 'positive' ? 'up' : (ev.impact === 'negative' ? 'down' : 'neutral');
          html += '<li class="news-ai-ev">'
            + '<span class="news-ai-ev-dir ' + dir + '" aria-label="' + esc(IMPACT_DIR[dir]) + '">'
            + (dir === 'up' ? '▲' : dir === 'down' ? '▼' : '–') + '</span>'
            + '<span class="news-ai-ev-text">' + esc(ev.event) + '</span>'
            + '<span class="news-ai-ev-hz">' + esc(hzCn(ev.horizon)) + '</span>'
            + '</li>';
        }
        evBox.innerHTML = html;
      }
    }

    /* --- 對股價的潛在影響 --- */
    var pi = ai.priceImpact;
    var dirEl = $('newsAiImpactDir');
    var magEl = $('newsAiImpactMag');
    var pricedEl = $('newsAiImpactPriced');
    var textEl = $('newsAiImpactText');
    if (pi) {
      if (dirEl) {
        dirEl.textContent = IMPACT_DIR[pi.direction] || pi.direction;
        dirEl.className = 'news-ai-impact-dir ' + (pi.direction === 'up' ? 'up' : pi.direction === 'down' ? 'down' : 'neutral');
      }
      if (magEl) magEl.textContent = IMPACT_MAG[pi.magnitude] || pi.magnitude || '—';
      if (pricedEl) pricedEl.textContent = PRICED[pi.alreadyPricedIn] || '';
      if (textEl) textEl.textContent = pi.reasoning || '—';
    } else {
      if (dirEl) { dirEl.textContent = '未提供'; dirEl.className = 'news-ai-impact-dir neutral'; }
      if (magEl) magEl.textContent = '—';
      if (pricedEl) pricedEl.textContent = '';
      if (textEl) {
        textEl.textContent = '本次未能產生可靠的股價影響研判'
          + (ai.adjusted && ai.adjusted.length ? '（' + ai.adjusted.join('；') + '）' : '') + '。';
      }
    }

    // 版塊脈絡一句
    var secLine = d.sector
      ? '<span class="news-ai-sec">版塊：' + esc(d.sector.label) + '（' + esc(d.sector.key) + '）'
        + '，目前「' + qcn(d.sector.quadrant) + '」象限，'
        + 'RS-Ratio ' + fmt(d.sector.ratio, 2) + '、動能 ' + fmt(d.sector.momentum, 2)
        + '，在版塊內為第 ' + d.sector.rankInSector + ' 大持股（權重 ' + fmt(d.sector.weight, 2) + '%）。</span>'
      : '<span class="news-ai-sec muted">未取得版塊歸屬，未納入版塊相對強弱。</span>';

    /* --- 驅動因子 --- */
    var drvBox = $('newsAiDrivers');
    if (drvBox) {
      var drvs = ai.drivers || [];
      var dh = '<div class="news-ai-drv-title">研判依據與權重</div>';
      if (!drvs.length) {
        dh += '<div class="news-ai-drv-empty">無可用因子。</div>';
      } else {
        for (var j = 0; j < drvs.length; j++) {
          var dv = drvs[j] || {};
          var w = Math.max(0, Math.min(1, Number(dv.weight) || 0));
          var ddir = dv.direction === 'positive' ? 'up' : dv.direction === 'negative' ? 'down' : 'neutral';
          dh += '<div class="news-ai-drv">'
            + '<span class="news-ai-drv-name">' + esc(dv.factor) + '</span>'
            + '<span class="news-ai-drv-bar"><i style="width:' + (w * 100).toFixed(0) + '%" class="' + ddir + '"></i></span>'
            + '<span class="news-ai-drv-w">' + (w * 100).toFixed(0) + '%</span>'
            + '</div>';
        }
      }
      dh += secLine;
      drvBox.innerHTML = dh;
    }

    /* --- 新聞清單 --- */
    var list = $('newsAiList');
    var listHint = $('newsAiListHint');
    if (list) {
      var items = news.items || [];
      if (!items.length) {
        list.innerHTML = '<li class="news-ai-list-empty">'
          + '查無相關新聞。這不代表公司沒有動態，可能是期間內無媒體報導，或報導未包含可辨識的公司名稱。'
          + '</li>';
      } else {
        var lh = '';
        for (var k = 0; k < items.length; k++) {
          lh += newsItemHtml(items[k]);
        }
        list.innerHTML = lh;
      }
    }
    if (listHint) {
      var tot = news.totalBeforeLimit || news.count || 0;
      listHint.textContent = '共 ' + (news.count || 0) + ' 則'
        + (tot > (news.count || 0) ? '（原始 ' + tot + ' 則，已按相關性與權威性篩選）' : '')
        + '，時間範圍 ' + shortTime(news.window && news.window.from) + ' ~ ' + shortTime(news.window && news.window.to);
    }

    /* --- 來源與時間標註（需求明確要求） --- */
    var pv = $('newsAiProv');
    if (pv) {
      var parts = [];
      parts.push('<span class="news-ai-prov-item"><b>新聞時間範圍</b>'
        + shortTime(news.window && news.window.from) + ' ~ ' + shortTime(news.window && news.window.to)
        + '（近 ' + ((news.window && news.window.days) || '—') + ' 天）</span>');

      if (d.price && d.price.asOf) {
        parts.push('<span class="news-ai-prov-item"><b>價格資料</b>至 ' + shortTime(d.price.asOf) + '</span>');
      }

      var srcs = prov.sources || [];
      if (srcs.length) {
        var sArr = [];
        for (var s = 0; s < srcs.length; s++) {
          var sc = srcs[s];
          sArr.push(esc(sc.name) + (sc.ok === false ? '（失敗）' : ' ' + sc.count + ' 則'));
        }
        parts.push('<span class="news-ai-prov-item"><b>新聞來源</b>' + sArr.join('、') + '</span>');
      }

      var pubs = (prov.publishers || []).slice(0, 6);
      if (pubs.length) {
        var pArr = [];
        for (var p = 0; p < pubs.length; p++) {
          var pb = pubs[p];
          pArr.push('<span class="tier-badge t' + pb.tier + '">T' + pb.tier + '</span>'
            + esc(pb.name) + '×' + pb.count);
        }
        parts.push('<span class="news-ai-prov-item"><b>媒體分佈</b>' + pArr.join('、') + '</span>');
      }

      parts.push('<span class="news-ai-prov-item"><b>分析方法</b>'
        + (ai.mode === 'llm'
          ? esc(prov.aiModel || 'LLM') + '（' + esc(prov.aiVia || '—') + '）'
          : '規則層（關鍵詞情緒＋技術面）') + '</span>');

      parts.push('<span class="news-ai-prov-item"><b>產生時間</b>' + shortTime(prov.generatedAt || d.generatedAt) + '</span>');

      pv.innerHTML = parts.join('');
    }

    /* --- 提示 --- */
    var note = $('newsAiNote');
    if (note) {
      var notes = [];
      if (ai.note) notes.push(esc(ai.note));
      var cav = ai.caveats || [];
      for (var c = 0; c < cav.length; c++) notes.push(esc(cav[c]));
      if (prov.hantOk === false) {
        notes.push('模型輸出含有非繁體字元，已盡量修正，仍可能有殘留。');
      }
      if (d.priceContextAvailable === false) {
        notes.push('未取得價格資料，本次研判僅基於新聞，未納入技術面。');
      }
      var dg = prov.degraded || [];
      for (var g = 0; g < dg.length; g++) {
        notes.push('來源「' + esc(dg[g].source) + '」異常：' + esc(dg[g].message));
      }
      note.innerHTML = notes.length
        ? '<b>限制與提示</b>' + notes.map(function (x) { return '· ' + x; }).join('<br>')
        : '';
      note.hidden = !notes.length;
    }
  }

  function newsItemHtml(it) {
    /* 欄位名必須與 lib/news-hub.js 的實際輸出對齊（實測 keys）：
         tier / tierShort / tierLabel、time（毫秒）、ageText、
         excerpt、linkKind、alsoReportedBy
       早期的寫法是按契約文件的想像欄位（publisherTier / publishedAt /
       description）取值，結果整份清單的 T 級徽章全部退化成 T3、
       時間與摘要也全部空白 —— 契約文件是設計意圖，程式碼才是事實。 */
    var t = typeof it.tier === 'number' ? it.tier : 3;
    var title = it.title || '(無標題)';
    var url = it.link || it.url || '';
    var meta = [];
    if (it.publisher) {
      meta.push('<span class="tier-badge t' + t + '" title="'
        + esc(it.tierLabel || ('來源分級 Tier ' + t)) + '">' + esc(it.tierShort || ('T' + t)) + '</span>'
        + '<span class="news-ai-item-pub">' + esc(it.publisher) + '</span>');
    }
    // 時間：優先用後端算好的 ageText，沒有才自己算
    var when = it.ageText || (it.time ? ago(new Date(it.time).toISOString()) : '');
    if (when) {
      var iso = it.time ? new Date(it.time).toISOString() : '';
      meta.push('<span class="news-ai-item-time"' + (iso ? ' title="' + esc(iso) + '"' : '') + '>'
        + esc(when) + '</span>');
    }
    // Google 轉址要標記，否則使用者以為連結壞了
    if (it.linkKind === 'google-redirect') {
      meta.push('<span class="news-ai-item-kind" title="此連結經 Google News 轉址，非原始媒體網址">轉址</span>');
    }
    var also = '';
    if (it.alsoReportedBy && it.alsoReportedBy.length) {
      also = '<span class="news-ai-item-also">另由 ' + esc(it.alsoReportedBy.join('、')) + ' 報導</span>';
    }
    var titleHtml = url
      ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>'
      : esc(title);

    /* 摘要來源優先序（這是「AI 自動打開各條新聞」的呈現端）：
         ① bodySummary —— 後端真的抓了正文後提煉的摘要
         ② excerpt     —— RSS 原始摘要（常常只是標題＋媒體名重複）
       若有正文但沒摘要，至少標出「已讀 N 字」讓使用者知道系統確實讀過，
       而不是把「沒抓到」和「沒內容」混為一談。 */
    var descText = it.bodySummary || it.excerpt || '';
    var descCls = 'news-ai-item-desc' + (it.bodySummary ? ' is-body' : '');
    var desc = descText
      ? '<p class="' + descCls + '">' + esc(descText) + '</p>'
      : '';

    // 閱讀狀態：明確區分「已讀正文」「付費牆」「抓不到」
    var bodyTag = '';
    if (it.paywalled) {
      bodyTag = '<span class="news-ai-item-bodytag is-paywall">付費牆，僅能以摘要呈現</span>';
    } else if (it.bodySummary) {
      bodyTag = '<span class="news-ai-item-bodytag is-ok">已讀正文 '
        + (it.bodyChars || 0) + ' 字</span>';
    } else if (it.bodyChars > 0) {
      bodyTag = '<span class="news-ai-item-bodytag">正文偏短，摘要有限</span>';
    }

    return '<li class="news-ai-item">'
      + '<div class="news-ai-item-meta">' + meta.join('') + '</div>'
      + '<div class="news-ai-item-title">' + titleHtml + '</div>'
      + desc + bodyTag + also
      + '</li>';
  }

  /* ---------------- 看好／看跌 雙欄 ---------------- */

  /**
   * 財務數字的中文顯示。
   *
   * 為什麼要自己格式化成「億」：後端營收是 478834000000（美元），
   * 直接印出來使用者讀不出量級。但**不可改變數值本身**，
   * 四捨五入的規則要固定，否則每個地方印出來的同一數字會不一樣。
   */
  function formatFinValue(f) {
    if (!f || f.value == null) return '—';
    var v = f.value;
    var unit = f.unit || '';
    if (unit === 'USD') {
      if (Math.abs(v) >= 1e9) return (v / 1e8).toFixed(2) + ' 億';
      if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + ' 百萬';
      return String(v);
    }
    if (unit === '%') return v + '%';
    return String(v) + unit;
  }

  /**
   * 單一要點的 HTML。
   *
   * 三層資訊的視覺層級必須分明，否則整欄會變成一團文字無法掃讀：
   *   要點本文（大字、深色）→ 財務連結（小字、左側細線）→ 來源（最小、灰）
   */
  function sideItemHtml(it, idx) {
    var point = it.point || it.title || '';
    var fin = it.fundamentalLink;
    var srcBits = [];
    if (it.publisher) srcBits.push(esc(it.publisher));
    if (it.ageText) srcBits.push(esc(it.ageText));
    var srcLink = '';
    if (it.title) {
      var label = it.title.length > 46 ? it.title.slice(0, 46) + '…' : it.title;
      srcLink = it.link
        ? '<a href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer" title="'
          + esc(it.title) + '">' + esc(label) + '</a>'
        : esc(label);
    }

    var srcHtml = (srcLink || srcBits.length)
      ? '<p class="sides-src">'
        + (srcBits.length ? '<span class="sides-src-meta">' + srcBits.join(' · ') + '</span>' : '')
        + (srcLink ? (srcBits.length ? ' · ' : '') + srcLink : '')
        + '</p>'
      : '';

    return '<li class="sides-item">'
      + '<span class="sides-idx" aria-hidden="true">' + (idx + 1) + '</span>'
      + '<div class="sides-body">'
      + '<p class="sides-point">' + esc(point) + '</p>'
      + (fin ? '<p class="sides-link">' + esc(fin) + '</p>' : '')
      + srcHtml
      + '</div></li>';
  }

  /**
   * 渲染一欄。
   *
   * 空狀態要說清楚「為什麼沒有」，不能只留一片空白：
   * 使用者分不清是「真的沒有看空消息」還是「功能壞了」。
   */
  function renderSidesColumn(listEl, countEl, items, side) {
    if (!listEl) return;
    var arr = items || [];
    if (countEl) countEl.textContent = String(arr.length);

    if (!arr.length) {
      listEl.innerHTML = '<li class="sides-empty">'
        + (side === 'bull'
          ? '本批新聞沒有明確的正面要點。'
          : '本批新聞沒有明確的負面要點。')
        + '<br>系統不強行二分，請對照下方關鍵事件與技術面。</li>';
      return;
    }

    var h = '';
    for (var i = 0; i < arr.length; i++) h += sideItemHtml(arr[i], i);
    listEl.innerHTML = h;
  }

  /** 情緒量表：半圓刻度盤 + 指針 */
  function gaugeSvg(score) {
    var W = 168, H = 96;
    var cx = W / 2, cy = 84, r = 62;

    function polar(v, rad) {
      // -1 → 180°, 0 → 90°, +1 → 0°
      var ang = Math.PI * (1 - (v + 1) / 2);
      return { x: cx + Math.cos(ang) * rad, y: cy - Math.sin(ang) * rad };
    }
    function arc(from, to, rad) {
      var a = polar(from, rad), b = polar(to, rad);
      var large = Math.abs(to - from) > 1 ? 1 : 0;
      // 由左往右掃：sweep-flag 1
      return 'M' + a.x.toFixed(2) + ' ' + a.y.toFixed(2)
        + ' A' + rad + ' ' + rad + ' 0 ' + large + ' 1 ' + b.x.toFixed(2) + ' ' + b.y.toFixed(2);
    }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="nag-svg" aria-hidden="true">';
    // 三段底色：負 / 中性 / 正
    svg += '<path d="' + arc(-1, -0.15, r) + '" stroke="#e8b4b4" stroke-width="11" fill="none" stroke-linecap="round"/>';
    svg += '<path d="' + arc(-0.15, 0.15, r) + '" stroke="#d8dee8" stroke-width="11" fill="none"/>';
    svg += '<path d="' + arc(0.15, 1, r) + '" stroke="#b4c6e8" stroke-width="11" fill="none" stroke-linecap="round"/>';

    if (score != null && isFinite(score)) {
      var v = Math.max(-1, Math.min(1, score));
      var tip = polar(v, r - 2);
      var base = polar(v, 26);
      svg += '<line x1="' + base.x.toFixed(2) + '" y1="' + base.y.toFixed(2) + '"'
        + ' x2="' + tip.x.toFixed(2) + '" y2="' + tip.y.toFixed(2) + '"'
        + ' stroke="' + (v > 0.15 ? '#1d4ed8' : v < -0.15 ? '#c2410c' : '#475467') + '"'
        + ' stroke-width="3" stroke-linecap="round"/>';
      svg += '<circle cx="' + cx + '" cy="' + cy + '" r="5" fill="#475467"/>';
    } else {
      // 沒有分數就不畫指針 —— 空白的半圓會被誤讀成「中性 0 分」，
      // 所以必須留下明確的文字出口，說明是「沒有」而不是「是零」。
      svg += '<text x="' + cx + '" y="' + (cy - 14) + '" text-anchor="middle"'
        + ' font-size="12" fill="#667085">無情緒評分</text>';
      svg += '<text x="' + cx + '" y="' + (cy + 2) + '" text-anchor="middle"'
        + ' font-size="10" fill="#98a2b3">新聞量不足</text>';
    }
    svg += '</svg>';
    return svg;
  }

  function confCn(c) {
    return ({ high: '高', medium: '中', low: '低' })[c] || c || '—';
  }
  function hzCn(h) {
    return ({ short: '短期', medium: '中期', long: '長期' })[h] || h || '';
  }

  /* ===================================================
     二、RRG：版塊輪動 × 宏觀經濟
     =================================================== */

  var macroState = { loading: false, seq: 0, params: null };

  function loadMacroAi(opts) {
    var o = opts || {};
    var card = $('macroAiCard');
    if (!card) return;

    var seq = ++macroState.seq;
    macroState.loading = true;
    showLoading('macroAi', true);
    showEmpty('macroAi', null);

    // 參數沿用 RRG 控制列，確保「圖上看到什麼，AI 就講什麼」
    var p = readRrgParams();
    macroState.params = p;

    var q = '/api/sector-macro-ai?timeframe=' + encodeURIComponent(p.timeframe)
      + '&window=' + encodeURIComponent(p.window)
      + '&benchmark=' + encodeURIComponent(p.benchmark)
      + '&trail=' + encodeURIComponent(p.trail)
      + '&period=' + encodeURIComponent(p.period)
      + '&mode=auto';
    if (o.refresh) q += '&refresh=1';

    SA.api(q).then(function (d) {
      if (seq !== macroState.seq) return;
      macroState.loading = false;
      showLoading('macroAi', false);
      renderMacroAi(d);
    }).catch(function (err) {
      if (seq !== macroState.seq) return;
      macroState.loading = false;
      showLoading('macroAi', false);
      var e = SA.describeError ? SA.describeError(err) : { title: '載入失敗', message: err.message };
      showEmpty('macroAi', { title: e.title, msg: e.message + (e.hint ? ' ' + e.hint : '') });
    });
  }

  /** 讀取 RRG 控制列的當前值（若不存在則用後端預設） */
  function readRrgParams() {
    function val(id, dflt) {
      var el = $(id);
      return el && el.value ? el.value : dflt;
    }
    return {
      timeframe: val('rrgTimeframe', 'weekly'),
      window: val('rrgWindow', '1y'),
      benchmark: val('rrgBenchmark', 'SPY'),
      trail: val('rrgTrail', '5'),
      period: val('rrgPeriod', '14'),
    };
  }

  function renderMacroAi(d) {
    var body = $('macroAiBody');
    if (!body || !d) return;
    var ai = d.ai || {};
    var prov = d.provenance || {};
    var ranking = d.ranking || [];

    var badge = $('macroAiBadge');
    if (badge) {
      var n = (d.macroLinks || []).filter(function (l) { return l.available; }).length;
      var tot = (d.macroLinks || []).length;
      badge.textContent = (ai.mode === 'llm' ? 'AI 關聯解讀' : '規則層解讀')
        + ' · 宏觀 ' + n + '/' + tot;
      badge.className = 'macro-ai-badge' + (ai.mode === 'llm' ? ' is-llm' : ' is-rule');
    }

    body.hidden = false;

    /* --- 敘述 --- */
    var nar = $('macroAiNarrative');
    if (nar) nar.textContent = ai.rotationNarrative || '—';

    /* --- 排名條 --- */
    var rankBox = $('macroAiRank');
    var legend = $('macroAiRankLegend');
    if (legend) {
      var qs = ['leading', 'weakening', 'lagging', 'improving'];
      var lh = '';
      for (var i = 0; i < qs.length; i++) {
        lh += '<span class="macro-ai-lg ' + qcls(qs[i]) + '"><i></i>' + qcn(qs[i]) + '</span>';
      }
      lh += '<span class="macro-ai-lg-sep">｜</span>'
        + '<span class="macro-ai-lg f-in">▲ 流入</span>'
        + '<span class="macro-ai-lg f-out">▼ 流出</span>'
        + '<span class="macro-ai-lg f-neu">– 中性</span>';
      legend.innerHTML = lh;
    }

    if (rankBox) {
      if (!ranking.length) {
        rankBox.innerHTML = '<div class="macro-ai-rank-empty">無版塊資料。</div>';
      } else {
        var above = 0;
        for (var a = 0; a < ranking.length; a++) if (ranking[a].aboveBenchmark) above++;

        var rh = '';
        for (var r = 0; r < ranking.length; r++) {
          var x = ranking[r] || {};
          var fl = FLOW[x.flow] || FLOW.neutral;
          var w = Math.max(0, Math.min(100, Number(x.strengthScore) || 0));
          rh += '<div class="macro-ai-rank-row' + (x.rankNote ? ' has-note' : '') + '">'
            + '<span class="macro-ai-rank-no">' + x.rank + '</span>'
            + '<span class="macro-ai-rank-name">' + esc(x.label) + '</span>'
            + '<span class="macro-ai-rank-bar">'
            + '<i class="' + qcls(x.quadrant) + '" style="width:' + w.toFixed(1) + '%"></i>'
            + '</span>'
            + '<span class="macro-ai-rank-score">' + fmt(x.strengthScore, 1) + '</span>'
            + '<span class="macro-ai-rank-quad ' + qcls(x.quadrant) + '">' + qcn(x.quadrant) + '</span>'
            + '<span class="macro-ai-rank-flow ' + fl.cls + '" title="' + esc(x.flowBasis || '') + '">'
            + fl.arrow + ' ' + fl.cn + '</span>'
            + '</div>';
          if (x.rankNote) {
            rh += '<p class="macro-ai-rank-note">' + esc(x.rankNote) + '</p>';
          }
        }
        // 一句話解釋同儕分布：這是「第 9 名卻是領先象限」之所以合理的原因
        rh += '<p class="macro-ai-rank-foot">11 個版塊中有 <b>' + above + '</b> 個相對強度高於基準線 100。'
          + '強弱分數是<b>同期版塊間的相對位置</b>（第 1 名 100 分、末位 0 分），'
          + '與象限的「勝過基準」是兩把不同的尺，兩者不同調時會在上方標註原因。</p>';
        rankBox.innerHTML = rh;
      }
    }

    /* --- 宏觀關聯卡 --- */
    var linkBox = $('macroAiLinks');
    if (linkBox) {
      var links = d.macroLinks || [];
      if (!links.length) {
        linkBox.innerHTML = '<div class="macro-ai-link-empty">無宏觀指標資料。</div>';
      } else {
        var lhtml = '';
        for (var m = 0; m < links.length; m++) {
          lhtml += macroLinkHtml(links[m]);
        }
        linkBox.innerHTML = lhtml;
      }
    }

    /* --- 一致性 --- */
    var consBox = $('macroAiConsistency');
    if (consBox) {
      var c = ai.consistency || {};
      var vd = c.verdict || 'unclear';
      var vcn = ({ consistent: '互相印證', divergent: '出現背離', unclear: '難以判定' })[vd] || vd;
      var vcls = ({ consistent: 'v-ok', divergent: 'v-div', unclear: 'v-un' })[vd] || 'v-un';
      consBox.className = 'macro-ai-consistency ' + vcls;
      consBox.innerHTML = '<div class="macro-ai-cons-head">'
        + '<span class="macro-ai-cons-verdict">' + vcn + '</span>'
        + '<span class="macro-ai-cons-basis">' + (c.basis === 'llm' ? 'AI 判定' : '規則層判定') + '</span>'
        + '</div>'
        + '<p class="macro-ai-cons-note">' + esc(c.note || '—') + '</p>'
        + '<p class="macro-ai-cons-hint">'
        + '背離通常比印證更有訊息量：代表市場正被其他因素主導，或該指標的傳導有時間差。'
        + '</p>';
    }

    /* --- 觀察重點 --- */
    var wpBox = $('macroAiWatch');
    var wpBlock = $('macroAiWatchBlock');
    if (wpBox && wpBlock) {
      var wps = ai.watchpoints || [];
      if (!wps.length) {
        wpBlock.hidden = true;
      } else {
        wpBlock.hidden = false;
        var wh = '';
        for (var w2 = 0; w2 < wps.length; w2++) wh += '<li>' + esc(wps[w2]) + '</li>';
        wpBox.innerHTML = wh;
      }
    }

    /* --- 來源與時間 --- */
    var pv = $('macroAiProv');
    if (pv) {
      var mw = prov.macroWindow || {};
      var bits = [];
      bits.push('<span class="macro-ai-prov-item"><b>輪動資料</b>'
        + esc(d.timeframeLabel || d.timeframe || '—') + '、'
        + esc(d.windowLabel || '—') + '、基準 ' + esc(d.benchmarkLabel || d.benchmark || '—')
        + '，截至 ' + esc(d.rotationAsOf || '—') + '</span>');
      bits.push('<span class="macro-ai-prov-item"><b>宏觀數據</b>'
        + (mw.from ? shortDate(mw.from) + ' ~ ' + shortDate(mw.to) : '—')
        + '（' + (mw.available || 0) + '/' + (mw.total || 0) + ' 項可用）</span>');
      var srcs = prov.sources || [];
      if (srcs.length) {
        var sa = [];
        for (var s2 = 0; s2 < srcs.length; s2++) sa.push(esc(srcs[s2].name));
        bits.push('<span class="macro-ai-prov-item"><b>資料來源</b>' + sa.join('、') + '</span>');
      }
      bits.push('<span class="macro-ai-prov-item"><b>分析方法</b>'
        + (ai.mode === 'llm' ? esc(prov.aiModel || 'LLM') : '規則層') + '</span>');
      bits.push('<span class="macro-ai-prov-item"><b>產生時間</b>' + shortTime(prov.generatedAt || d.generatedAt) + '</span>');
      pv.innerHTML = bits.join('');
    }

    /* --- 提示 --- */
    var note = $('macroAiNote');
    if (note) {
      var notes = [];
      if (ai.note) notes.push(esc(ai.note));
      var cav = ai.caveats || [];
      for (var c2 = 0; c2 < cav.length; c2++) notes.push(esc(cav[c2]));
      if (prov.hantOk === false) notes.push('模型輸出含有非繁體字元，已盡量修正，仍可能有殘留。');
      var dg = prov.degraded || [];
      for (var g2 = 0; g2 < dg.length; g2++) {
        notes.push('來源「' + esc(dg[g2].source) + '」異常：' + esc(dg[g2].message));
      }
      note.innerHTML = notes.length
        ? '<b>限制與提示</b>' + notes.map(function (x) { return '· ' + x; }).join('<br>')
        : '';
      note.hidden = !notes.length;
    }
  }

  function macroLinkHtml(l) {
    if (!l) return '';
    if (!l.available) {
      return '<div class="macro-ai-link is-na">'
        + '<div class="macro-ai-link-head"><span class="macro-ai-link-name">' + esc(l.label || l.short) + '</span>'
        + '<span class="macro-ai-link-na">資料不可用</span></div>'
        + '<p class="macro-ai-link-reason">' + esc(l.reason || '未取得此序列') + '</p>'
        + '</div>';
    }

    var vd = l.verdict === 'divergent' ? 'v-div' : 'v-ok';
    var dirArrow = l.direction === 'up' ? '▲' : l.direction === 'down' ? '▼' : '–';
    var dirCls = l.direction === 'up' ? 'up' : l.direction === 'down' ? 'down' : 'neutral';

    var chips = '';
    if ((l.supports || []).length) {
      chips += '<div class="macro-ai-chips"><span class="chip-label">理論受益</span>';
      for (var i = 0; i < l.supports.length; i++) {
        var sp = l.supports[i];
        chips += '<span class="macro-ai-chip is-sup">' + esc(sp.label) + ' #' + sp.rank + '</span>';
      }
      chips += '</div>';
    }
    if ((l.pressures || []).length) {
      chips += '<div class="macro-ai-chips"><span class="chip-label">理論受壓</span>';
      for (var j = 0; j < l.pressures.length; j++) {
        var pr = l.pressures[j];
        chips += '<span class="macro-ai-chip is-pre">' + esc(pr.label) + ' #' + pr.rank + '</span>';
      }
      chips += '</div>';
    }

    return '<div class="macro-ai-link ' + vd + '">'
      + '<div class="macro-ai-link-head">'
      + '<span class="macro-ai-link-name">' + esc(l.label) + '</span>'
      + '<span class="macro-ai-link-val">' + fmt(l.value, 2) + esc(l.unit || '') + '</span>'
      + '<span class="macro-ai-link-dir ' + dirCls + '">' + dirArrow + ' ' + esc(l.directionCn || '') + '</span>'
      + (l.percentile != null ? '<span class="macro-ai-link-pct">歷史百分位 ' + fmt(l.percentile, 1) + '</span>' : '')
      + '<span class="macro-ai-link-verdict ' + vd + '">'
      + (l.verdict === 'divergent' ? '背離' : '印證') + '</span>'
      + '</div>'
      + '<p class="macro-ai-link-thesis">' + esc(l.thesis || '—') + '</p>'
      + chips
      + (l.verdictNote ? '<p class="macro-ai-link-note">' + esc(l.verdictNote) + '</p>' : '')
      + '<div class="macro-ai-link-src">' + esc(l.source || 'FRED')
      + (l.asOf ? ' · 資料至 ' + esc(l.asOf) : '')
      + ' · ' + (l.basis === 'llm' ? 'AI 撰述' : '規則層')
      + (l.confidence ? ' · 信心 ' + esc(confCn(l.confidence)) : '')
      + '</div>'
      + '</div>';
  }

  /** 由 RRG 主載入失敗時呼叫，避免宏觀卡片停在「載入中」 */
  function failMacroAi(desc) {
    var d = desc || { title: '載入失敗', message: '版塊輪動資料取得失敗。' };
    showLoading('macroAi', false);
    showEmpty('macroAi', {
      title: d.title || '載入失敗',
      msg: (d.message || '') + (d.hint ? ' ' + d.hint : ''),
    });
  }

  /* ===================================================
     共用：載入中／空狀態
     =================================================== */

  function showLoading(prefix, on) {
    var el = $(prefix + 'Loading');
    var body = $(prefix + 'Body');
    if (el) el.hidden = !on;
    if (on && body) body.hidden = true;
  }

  function showEmpty(prefix, info) {
    var box = $(prefix + 'Empty');
    if (!box) return;
    if (!info) { box.hidden = true; return; }
    var t = $(prefix + 'EmptyTitle');
    var m = $(prefix + 'EmptyMsg');
    var body = $(prefix + 'Body');
    if (t) t.textContent = info.title || '尚無資料';
    if (m) m.textContent = info.msg || '—';
    box.hidden = false;
    if (body) body.hidden = true;
  }

  /* ===================================================
     事件接線
     =================================================== */

  function bind() {
    var retry = $('newsAiRetry');
    if (retry) {
      retry.addEventListener('click', function () {
        if (newsState.symbol) loadNewsAi(newsState.symbol, { refresh: true });
      });
    }

    var mRetry = $('macroAiRetry');
    if (mRetry) mRetry.addEventListener('click', function () { loadMacroAi({ refresh: true }); });

    var mRefresh = $('macroAiRefresh');
    if (mRefresh) mRefresh.addEventListener('click', function () { loadMacroAi({ refresh: true }); });
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  global.NewsAi = {
    loadNewsAi: loadNewsAi,
    loadMacroAi: loadMacroAi,
    failMacroAi: failMacroAi,
    renderNewsAi: renderNewsAi,
    renderMacroAi: renderMacroAi,
    gaugeSvg: gaugeSvg,
    state: function () { return { news: newsState, macro: macroState }; },
  };

})(window);
