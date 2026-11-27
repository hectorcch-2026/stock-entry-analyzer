/* ===================================================
   宏觀走勢圖與利率期貨隱含路徑（需求 4、5）

   為什麼自己畫 Canvas 而不引入圖表庫：
     本專案零執行期依賴（package.json 無 dependencies）。
     引入 Chart.js 會讓「零依賴」這個已寫進交付文件的約束失效。
     app.js / rrg-client.js / rrg-treemap.js 都是手繪 Canvas 2D，
     這裡沿用同一套做法（含 DPR 縮放），維持一致性。

   三個必須自己處理、圖表庫會順手做掉的事：
     1. 缺值要斷線，不能連過去 —— 連過去會畫出一條根本不存在的走勢。
     2. y 軸範圍要含 0 的圖（利差圖）必須畫出零線，否則看不出正負。
     3. 降採樣後的點數與「完整視窗」的 min/max 不同 ——
        軸標與統計一律用後端回傳的完整統計，不用畫面上的點重算。

   顏色約定（全站一致，不得挪用）：
     漲紅跌綠只用於價格漲跌語義。走勢圖是多序列比較，
     用 --brand 系列的辨識色，不用 --up / --down。
   =================================================== */
(function (global) {
  'use strict';

  var SA = global.SA;
  if (!SA) return;

  var $ = function (id) { return document.getElementById(id); };

  /* 序列辨識色：刻意避開 --up / --down（那兩個是漲跌語義） */
  var LINE_COLORS = ['#1d4ed8', '#0e7490', '#7c3aed', '#b45309', '#0f766e', '#be123c'];

  var state = {
    charts: null,
    chartsLoading: false,
    rates: null,
    ratesLoading: false,
    lastFocus: null,
  };

  /* ---------------- 共用：讀 CSS 變數 ---------------- */

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  /** DPR 縮放，與 rrg-client.js / app.js 一致 */
  function setupCanvas(cv, cssW, cssH) {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  /* ---------------- 共用：數值格式 ---------------- */

  function fmtAxis(v, unit) {
    if (v == null || !isFinite(v)) return '';
    var a = Math.abs(v);
    var d = a >= 100 ? 0 : (a >= 10 ? 1 : 2);
    return v.toFixed(d);
  }

  function fmtDateShort(iso) {
    // 2026-11-24 → 26/11（依畫面寬度可縮短）
    if (!iso || iso.length < 10) return '';
    return iso.slice(2, 4) + '/' + iso.slice(5, 7);
  }

  function fmtDateFull(iso) {
    if (!iso || iso.length < 10) return '—';
    return iso.slice(0, 4) + '-' + iso.slice(5, 7) + '-' + iso.slice(8, 10);
  }

  /* ============================================================
     走勢圖
     ============================================================ */

  /**
   * 依所有序列的完整統計決定 y 軸範圍。
   *
   * 為什麼用後端的 stats.min/max 而不是掃 points：
   *   points 是降採樣後的點。掃它算出來的範圍可能比真實極值窄，
   *   於是曲線會凸出畫布外——而且同一天重整兩次（取樣點不同）
   *   會得到不同的軸，看起來像資料變了。
   */
  function computeYDomain(chart) {
    var min = Infinity;
    var max = -Infinity;
    for (var i = 0; i < chart.series.length; i++) {
      var s = chart.series[i];
      if (s.available === false || !s.stats) continue;
      if (s.stats.min != null) min = Math.min(min, s.stats.min);
      if (s.stats.max != null) max = Math.max(max, s.stats.max);
    }
    if (min === Infinity || max === -Infinity) return null;

    if (min === max) { min -= 1; max += 1; }

    var span = max - min;
    min -= span * 0.08;
    max += span * 0.08;

    // 含 0 的意義：利差圖必須看得到零線；其他圖含 0 與否影響不大，
    // 但若資料本來就跨 0（例如實質利率），不含 0 會讓人誤判正負。
    if (min > 0 && min < span * 0.5) min = 0;
    if (max < 0 && -max < span * 0.5) max = 0;

    return { min: min, max: max };
  }

  function drawChart(cv, chart) {
    var wrap = cv.parentNode;
    var cssW = (wrap && wrap.clientWidth) || 640;
    cssW = Math.max(280, cssW);
    var cssH = Math.max(180, Math.min(Math.round(cssW * 0.42), 300));
    var sc = setupCanvas(cv, cssW, cssH);
    var ctx = sc.ctx;
    var W = sc.w;
    var H = sc.h;

    var cText3 = cssVar('--text-3', '#8a94a6');
    var cBorder = cssVar('--border', '#e3e8ef');
    var cText2 = cssVar('--text-2', '#5b6474');

    ctx.clearRect(0, 0, W, H);

    var okSeries = [];
    for (var i = 0; i < chart.series.length; i++) {
      if (chart.series[i].available !== false && chart.series[i].points) okSeries.push(chart.series[i]);
    }

    if (!okSeries.length) {
      ctx.fillStyle = cText3;
      ctx.font = '13px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('此圖目前無可用資料', W / 2, H / 2);
      return;
    }

    var dom = computeYDomain(chart);
    if (!dom) return;

    var padL = 44;
    var padR = 12;
    var padT = 10;
    var padB = 24;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    // x 軸：以所有序列的日期範圍為準（各序列 to 可能不同）
    var tMin = null;
    var tMax = null;
    for (var j = 0; j < okSeries.length; j++) {
      var p0 = okSeries[j].points;
      if (!p0.length) continue;
      var d0 = Date.parse(p0[0].date);
      var d1 = Date.parse(p0[p0.length - 1].date);
      if (tMin === null || d0 < tMin) tMin = d0;
      if (tMax === null || d1 > tMax) tMax = d1;
    }
    if (tMin === null || tMax === null || tMin === tMax) return;

    function X(ts) { return padL + ((ts - tMin) / (tMax - tMin)) * plotW; }
    function Y(v) { return padT + plotH - ((v - dom.min) / (dom.max - dom.min)) * plotH; }

    /* --- 水平格線 + y 軸標籤 --- */
    var ticks = 4;
    ctx.strokeStyle = cBorder;
    ctx.fillStyle = cText3;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    for (var t = 0; t <= ticks; t++) {
      var val = dom.min + ((dom.max - dom.min) * t) / ticks;
      var yy = Y(val);
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(yy) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(yy) + 0.5);
      ctx.stroke();
      ctx.fillText(fmtAxis(val), padL - 6, yy);
    }

    /* --- 零線（利差圖必需）--- */
    if (chart.zeroLine && dom.min < 0 && dom.max > 0) {
      ctx.save();
      ctx.strokeStyle = cText2;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(Y(0)) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(Y(0)) + 0.5);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = cText2;
      ctx.font = '10px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('0', padL + 3, Y(0) - 2);
    }

    /* --- x 軸標籤（起、中、迄）--- */
    ctx.fillStyle = cText3;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(fmtDateFull(new Date(tMin).toISOString().slice(0, 10)), padL, padT + plotH + 6);
    ctx.textAlign = 'center';
    ctx.fillText(fmtDateShort(new Date((tMin + tMax) / 2).toISOString().slice(0, 10)), padL + plotW / 2, padT + plotH + 6);
    ctx.textAlign = 'right';
    ctx.fillText(fmtDateFull(new Date(tMax).toISOString().slice(0, 10)), padL + plotW, padT + plotH + 6);

    /* --- 折線 --- */
    for (var k = 0; k < okSeries.length; k++) {
      var s = okSeries[k];
      var pts = s.points;
      if (!pts.length) continue;

      ctx.strokeStyle = LINE_COLORS[k % LINE_COLORS.length];
      ctx.lineWidth = (k === 0 ? 2 : 1.6);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();

      for (var m = 0; m < pts.length; m++) {
        var xx = X(Date.parse(pts[m].date));
        var vy = Y(pts[m].value);
        if (m === 0) ctx.moveTo(xx, vy); else ctx.lineTo(xx, vy);
      }
      ctx.stroke();

      /* 末端點標記，方便看出「最新值在哪」 */
      var lastP = pts[pts.length - 1];
      ctx.beginPath();
      ctx.arc(X(Date.parse(lastP.date)), Y(lastP.value), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = LINE_COLORS[k % LINE_COLORS.length];
      ctx.fill();
    }
  }

  /* ============================================================
     走勢圖：DOM 組裝
     ============================================================ */

  function chartCardHtml(c) {
    var legend = c.series.map(function (s, i) {
      if (s.available === false) {
        return '<span class="mc-legend-item mc-legend-miss" title="' + SA.esc(s.reason || '') + '">'
          + '<i class="mc-dot" style="background:' + cText3Fallback() + '"></i>'
          + SA.esc(s.label) + '（無資料）</span>';
      }
      return '<span class="mc-legend-item">'
        + '<i class="mc-dot" style="background:' + LINE_COLORS[i % LINE_COLORS.length] + '"></i>'
        + SA.esc(s.label)
        + ' <b>' + SA.fmt(s.value) + '</b>'
        + '<span class="mc-legend-unit">' + SA.esc(s.unit || '') + '</span>'
        + '</span>';
    }).join('');

    var foot = c.series.filter(function (s) { return s.available !== false; }).map(function (s) {
      return SA.esc(s.label) + '：' + SA.esc(fmtDateFull(s.to))
        + '（共 ' + s.total + ' 筆' + (s.sampled ? '，圖上顯示 ' + s.count + ' 點' : '') + '，' + SA.esc(s.step) + '）';
    }).join('　·　');

    return '<section class="card mc-card" data-chart="' + SA.esc(c.id) + '">'
      + '<header class="card-head mc-head">'
      + '<div class="mc-head-text">'
      + '<h3 class="mc-title">' + SA.esc(c.title) + '</h3>'
      + '<p class="mc-sub">' + SA.esc(c.subtitle) + '</p>'
      + '</div>'
      + '<span class="badge badge-neutral mc-range">' + SA.esc(c.range) + '</span>'
      + '</header>'
      + '<div class="mc-legend">' + legend + '</div>'
      + '<div class="mc-canvas-wrap"><canvas role="img" aria-label="'
      + SA.esc(c.title + ' 走勢圖，單位 ' + c.unit) + '"></canvas></div>'
      + '<p class="mc-foot">' + foot + '</p>'
      + '</section>';
  }

  function cText3Fallback() { return cssVar('--text-3', '#8a94a6'); }

  function renderCharts(result) {
    var host = $('macroCharts');
    if (!host) return;

    if (!result || !result.ok || !result.charts || !result.charts.length) {
      host.innerHTML = '<p class="mc-empty">目前無法取得走勢圖資料。</p>';
      return;
    }

    host.innerHTML = result.charts.map(chartCardHtml).join('');

    // 逐張繪製。延到下一格事件迴圈，確保 layout 已完成，
    // 否則 clientWidth 會是 0，畫布寬度會退回 640 而與容器不符。
    var cards = host.querySelectorAll('.mc-card');
    Array.prototype.forEach.call(cards, function (card, idx) {
      var chart = result.charts[idx];
      var cv = card.querySelector('canvas');
      if (cv && chart) drawChart(cv, chart);
    });
  }

  /* ============================================================
     利率期貨隱含路徑
     ============================================================ */

  function dirMeta(direction) {
    if (direction === 'up') return { cls: 'rf-up', text: '市場定價為上升' };
    if (direction === 'down') return { cls: 'rf-down', text: '市場定價為下降' };
    if (direction === 'flat') return { cls: 'rf-flat', text: '市場定價大致持平' };
    return { cls: 'rf-flat', text: '無法判定' };
  }

  function anchorText(a) {
    if (!a || a.value == null) return '基準利率無法取得';
    return a.label + ' ' + a.value.toFixed(2) + '%'
      + (a.asOf ? '（' + fmtDateFull(a.asOf) + '）' : '');
  }

  function drawRateChart(cv, res) {
    var wrap = cv.parentNode;
    var cssW = Math.max(300, (wrap && wrap.clientWidth) || 640);
    var cssH = Math.max(200, Math.min(Math.round(cssW * 0.40), 300));
    var sc = setupCanvas(cv, cssW, cssH);
    var ctx = sc.ctx;
    var W = sc.w;
    var H = sc.h;

    var cText3 = cssVar('--text-3', '#8a94a6');
    var cBorder = cssVar('--border', '#e3e8ef');
    var cBrand = cssVar('--brand', '#1d4ed8');
    var cText2 = cssVar('--text-2', '#5b6474');

    ctx.clearRect(0, 0, W, H);

    var pts = (res.points || []).filter(function (p) { return p.available && p.impliedRate != null; });
    if (!pts.length) {
      ctx.fillStyle = cText3;
      ctx.font = '13px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('目前無可用的期貨報價', W / 2, H / 2);
      return;
    }

    // 曲線範圍 + 基準線都要進 y 軸，否則基準線會落在畫布外
    var rates = pts.map(function (p) { return p.impliedRate; });
    var anchorVal = res.anchor && res.anchor.value != null ? res.anchor.value : null;
    if (anchorVal != null) rates.push(anchorVal);
    var lo = Math.min.apply(null, rates);
    var hi = Math.max.apply(null, rates);
    if (lo === hi) { lo -= 0.25; hi += 0.25; }
    var span = hi - lo;
    lo -= span * 0.22;
    hi += span * 0.22;

    var padL = 46;
    var padR = 14;
    var padT = 14;
    var padB = 30;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    function X(i) {
      // 左邊留一格給「現在」，讓基準線有位置
      return padL + (plotW * (i + 1)) / (pts.length + 1);
    }
    function Y(v) { return padT + plotH - ((v - lo) / (hi - lo)) * plotH; }

    /* 格線 */
    ctx.strokeStyle = cBorder;
    ctx.fillStyle = cText3;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    var ticks = 4;
    for (var t = 0; t <= ticks; t++) {
      var val = lo + ((hi - lo) * t) / ticks;
      var yy = Y(val);
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(yy) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(yy) + 0.5);
      ctx.stroke();
      ctx.fillText(val.toFixed(2) + '%', padL - 6, yy);
    }

    /* 基準線（當前 SOFR） */
    if (anchorVal != null) {
      var ay = Y(anchorVal);
      ctx.save();
      ctx.strokeStyle = cText2;
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(ay) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(ay) + 0.5);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = cText2;
      ctx.font = '10px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('現在 ' + anchorVal.toFixed(2) + '%', padL + 4, ay - 3);
    }

    /* 折線 + 點 */
    ctx.strokeStyle = cBrand;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    var coords = [];
    for (var i = 0; i < pts.length; i++) {
      var xx = X(i);
      var vy = Y(pts[i].impliedRate);
      coords.push({ x: xx, y: vy, p: pts[i] });
      if (i === 0) ctx.moveTo(xx, vy); else ctx.lineTo(xx, vy);
    }
    ctx.stroke();

    for (var m = 0; m < coords.length; m++) {
      ctx.beginPath();
      ctx.arc(coords[m].x, coords[m].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = cBrand;
      ctx.fill();
      ctx.strokeStyle = cssVar('--surface', '#fff');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    /* x 軸標籤：季別（點多時只標奇數索引，避免重疊） */
    ctx.fillStyle = cText3;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var every = pts.length > 8 ? 2 : 1;
    for (var n = 0; n < coords.length; n++) {
      if (n % every !== 0 && n !== coords.length - 1) continue;
      ctx.fillText(coords[n].p.quarter, coords[n].x, padT + plotH + 8);
    }
  }

  function rateRowHtml(p) {
    if (!p.available) {
      return '<tr class="rf-miss">'
        + '<td class="rf-q">' + SA.esc(p.quarter) + '</td>'
        + '<td class="rf-c">' + SA.esc(p.contract || '—') + '</td>'
        + '<td class="ta-r">—</td>'
        + '<td class="ta-r">—</td>'
        + '<td class="ta-r">—</td>'
        + '<td class="rf-note">' + SA.esc(p.reason || '無報價') + '</td>'
        + '</tr>';
    }

    var vs = p.vsAnchorBp == null ? '—' : (p.vsAnchorBp > 0 ? '+' : '') + p.vsAnchorBp + ' bp';
    var vsCls = p.vsAnchorBp == null ? '' : (p.vsAnchorBp > 0 ? 'v-up' : (p.vsAnchorBp < 0 ? 'v-down' : ''));

    return '<tr>'
      + '<td class="rf-q"><b>' + SA.esc(p.quarter) + '</b></td>'
      + '<td class="rf-c"><a href="' + SA.esc(p.sourceUrl || '#') + '" target="_blank" rel="noopener">'
      + SA.esc(p.contract) + '</a></td>'
      + '<td class="ta-r rf-px">' + p.price.toFixed(3) + '</td>'
      + '<td class="ta-r"><b>' + p.impliedRate.toFixed(3) + '%</b></td>'
      + '<td class="ta-r ' + vsCls + '">' + SA.esc(vs) + '</td>'
      + '<td class="rf-note">' + SA.esc(fmtDateFull(p.asOf))
      + (p.volume != null ? '　量 ' + SA.fmtInt(p.volume) : '') + '</td>'
      + '</tr>';
  }

  function renderRates(res) {
    var host = $('ratesForecast');
    if (!host) return;

    if (!res || !res.ok) {
      host.innerHTML = '<p class="mc-empty">目前無法取得利率期貨資料。</p>';
      return;
    }

    var path = res.path || {};
    var dm = dirMeta(path.direction);

    var headline = (function () {
      if (!path.available) {
        return '<p class="rf-headline rf-flat">本次未取得有效期貨報價，無法建立隱含路徑。</p>';
      }
      var total = path.totalBp == null ? '—'
        : (path.totalBp > 0 ? '+' : '') + path.totalBp + ' bp';
      return '<p class="rf-headline ' + dm.cls + '">'
        + '<span class="rf-dir">' + SA.esc(dm.text) + '</span>　'
        + '由 <b>' + SA.esc(path.firstQuarter) + '</b> 的 <b>' + path.firstRate.toFixed(2) + '%</b>'
        + ' 到 <b>' + SA.esc(path.lastQuarter) + '</b> 的 <b>' + path.lastRate.toFixed(2) + '%</b>'
        + '（合計 <b>' + SA.esc(total) + '</b>）'
        + '</p>';
    })();

    var rows = (res.points || []).map(rateRowHtml).join('');

    var meta = ''
      + '<dl class="rf-meta">'
      + '<div><dt>時間範圍</dt><dd>' + SA.esc(res.timeRange.from) + ' – ' + SA.esc(res.timeRange.to)
      + '　<span class="rf-dim">（' + SA.esc(res.timeRange.fromPeriod) + ' 起至 '
      + SA.esc(res.timeRange.toPeriod) + '，共 ' + res.timeRange.quarters + ' 季）</span></dd></div>'
      + '<div><dt>基準利率</dt><dd>' + SA.esc(anchorText(res.anchor)) + '</dd></div>'
      + '<div><dt>更新頻率</dt><dd>' + SA.esc(res.updateFrequency.quote)
      + '　<span class="rf-dim">快取 ' + res.updateFrequency.quoteTtlMinutes + ' 分鐘</span></dd></div>'
      + '<div><dt>政策利率現值</dt><dd>'
      + (res.spot.policyUpper != null
        ? res.spot.policyUpper.toFixed(2) + '% – ' + res.spot.policyLower.toFixed(2) + '%'
        + '　<span class="rf-dim">（' + SA.esc(fmtDateFull(res.spot.policyAsOf)) + '）</span>'
        : '—')
      + '</dd></div>'
      + '</dl>';

    var srcList = (res.sources || []).map(function (s) {
      return '<li><a href="' + SA.esc(s.url) + '" target="_blank" rel="noopener">' + SA.esc(s.name) + '</a>'
        + '　<span class="rf-dim">' + SA.esc(s.usage) + '</span></li>';
    }).join('');

    var limits = (res.limitations || []).map(function (t) {
      return '<li>' + SA.esc(t) + '</li>';
    }).join('');

    host.innerHTML = ''
      + '<section class="card rf-card">'
      + '<header class="card-head mc-head">'
      + '<div class="mc-head-text">'
      + '<h3 class="mc-title">利率走勢：期貨市場隱含路徑（未來 ' + res.timeRange.quarters + ' 季）</h3>'
      + '<p class="mc-sub">由 CME 3 個月 SOFR 期貨（SR3）價格換算。'
      + '隱含利率 = 100 − 期貨價格。</p>'
      + '</div>'
      + '<span class="badge badge-neutral mc-range">' + SA.esc(res.anchor.kind || '—') + '</span>'
      + '</header>'

      + headline

      + '<div class="mc-canvas-wrap"><canvas role="img" aria-label="未來 '
      + res.timeRange.quarters + ' 季期貨隱含利率走勢圖"></canvas></div>'

      + meta

      + '<div class="rf-table-wrap">'
      + '<table class="rf-table">'
      + '<caption class="sr-only">各季度期貨合約價格與隱含利率，含相對基準的變化</caption>'
      + '<thead><tr>'
      + '<th scope="col">季度</th>'
      + '<th scope="col">合約</th>'
      + '<th scope="col" class="ta-r">價格</th>'
      + '<th scope="col" class="ta-r">隱含利率</th>'
      + '<th scope="col" class="ta-r">vs 基準</th>'
      + '<th scope="col">報價日</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>'
      + '</div>'

      + '<details class="rf-more">'
      + '<summary>可追溯性與資料來源</summary>'
      + '<p class="rf-formula"><b>換算式：</b>' + SA.esc(res.traceability.formula)
      + '　<span class="rf-dim">' + SA.esc(res.traceability.formulaNote) + '</span></p>'
      + '<ul class="rf-src">' + srcList + '</ul>'
      + '<p class="rf-dim">' + SA.esc(res.traceability.anchorRule) + '</p>'
      + '</details>'

      + '<details class="rf-more">'
      + '<summary>使用限制</summary>'
      + '<ul class="limit-list">' + limits + '</ul>'
      + '</details>'

      + '</section>';

    var cv = host.querySelector('canvas');
    if (cv) drawRateChart(cv, res);
  }

  /* ============================================================
     載入
     ============================================================ */

  function loadCharts(force) {
    if (state.chartsLoading) return Promise.resolve();
    state.chartsLoading = true;

    var host = $('macroCharts');
    if (host) host.innerHTML = '<p class="mc-empty">正在計算走勢圖…</p>';

    return SA.api('/api/macro/charts' + (force ? '?refresh=1' : ''))
      .then(function (d) {
        state.charts = d;
        renderCharts(d);
      })
      .catch(function (err) {
        var info = SA.describeError(err);
        if (host) {
          host.innerHTML = '<p class="mc-empty">' + SA.esc(info.message) + '</p>';
        }
      })
      .then(function () {
        state.chartsLoading = false;
      });
  }

  function loadRates(force) {
    if (state.ratesLoading) return Promise.resolve();
    state.ratesLoading = true;

    var host = $('ratesForecast');
    if (host) host.innerHTML = '<p class="mc-empty">正在取得期貨報價…</p>';

    return SA.api('/api/rates/forecast' + (force ? '?refresh=1' : ''))
      .then(function (d) {
        state.rates = d;
        renderRates(d);
      })
      .catch(function (err) {
        var info = SA.describeError(err);
        if (host) {
          host.innerHTML = '<p class="mc-empty">' + SA.esc(info.message) + '</p>';
        }
      })
      .then(function () {
        state.ratesLoading = false;
      });
  }

  /** 重新繪製（視窗尺寸改變時） */
  function redrawAll() {
    if (state.charts && state.charts.charts) {
      var host = $('macroCharts');
      if (!host) return;
      var cards = host.querySelectorAll('.mc-card');
      Array.prototype.forEach.call(cards, function (card, idx) {
        var chart = state.charts.charts[idx];
        var cv = card.querySelector('canvas');
        if (cv && chart) drawChart(cv, chart);
      });
    }
    if (state.rates && state.rates.ok) {
      var host2 = $('ratesForecast');
      var cv2 = host2 && host2.querySelector('canvas');
      if (cv2) drawRateChart(cv2, state.rates);
    }
  }

  var resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawAll, 180);
  }

  if (global.addEventListener) global.addEventListener('resize', onResize);

  /* ============================================================
     鉤子
     ============================================================ */

  global.MacroCharts = {
    loadCharts: loadCharts,
    loadRates: loadRates,
    renderCharts: renderCharts,
    renderRates: renderRates,
    redrawAll: redrawAll,
    // 供測試使用
    _computeYDomain: computeYDomain,
    _state: state,
  };
})(typeof window !== 'undefined' ? window : this);
