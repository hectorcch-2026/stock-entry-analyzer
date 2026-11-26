/* ===================================================
   RRG 版塊輪動地圖（前端）

   資料流：
     /api/rrg → { points[], meta{} } → 這裡只負責畫。

   設計原則：
     1. 計算全部在後端（lib/rrg.js），前端不做任何指標運算。
        否則同一張圖在兩個地方算出不同答案，永遠對不起来。
     2. 座標軸一律以 (100,100) 為中心、等比例（等比）縮放。
        RRG 的「象限」是幾何概念，若 x/y 比例不同，45 度線就不再是
        真正的分界，視覺上的「轉向」也會被拉伸成假象。
     3. 尾跡由舊（淡）到新（濃），末端加圓點標示最新一期。
        使用者回報「看不出哪端是新的」是這類圖最常見的抱怨。
   =================================================== */
(function (global) {
  'use strict';

  var SA = global.SA;
  var COLORS = {
    leading: '#0f9d58',    /* 領先 */
    weakening: '#b45309',  /* 弱化 */
    lagging: '#d92b2b',    /* 落後 */
    improving: '#1d4ed8',  /* 改善 */
  };
  var QUAD_META = {
    leading: { label: '領先', en: 'Leading', tip: '強度高、動能仍向上' },
    weakening: { label: '弱化', en: 'Weakening', tip: '強度仍高、動能轉弱' },
    lagging: { label: '落後', en: 'Lagging', tip: '強度低、動能向下' },
    improving: { label: '改善', en: 'Improving', tip: '強度低、動能轉強' },
  };

  var state = {
    data: null,
    trail: 5,
    period: 14,
    timeframe: 'weekly',
    window: '1y',
    benchmark: 'SPY',
    sectors: null,      /* null = 全選 */
    hover: null,        /* 目前懸停的 point key */
    pinned: null,       /* 點擊鎖定的 point key */
    loading: false,
    seq: 0,
  };

  /* ---------------- DOM ---------------- */
  function $(id) { return document.getElementById(id); }

  var el = {};

  function cacheEl() {
    el.wrap = $('rrgChartWrap');
    el.canvas = $('rrgCanvas');
    el.tip = $('rrgTip');
    el.empty = $('rrgEmpty');
    el.notice = $('rrgNotice');
    el.legend = $('rrgLegend');
    el.stamp = $('rrgStamp');
    el.tableBody = $('rrgTableBody');
    el.table = $('rrgTable');
    el.diag = $('rrgDiag');
    el.selTf = $('rrgTimeframe');
    el.selWin = $('rrgWindow');
    el.selBench = $('rrgBenchmark');
    el.rangeTrail = $('rrgTrail');
    el.rangePeriod = $('rrgPeriod');
    el.trailVal = $('rrgTrailVal');
    el.periodVal = $('rrgPeriodVal');
    el.chips = $('rrgSectorChips');
    el.sectorSummary = $('rrgSectorSummary');
    el.refresh = $('rrgRefresh');
  }

  /* ---------------- 載入 ---------------- */
  function buildUrl() {
    var p = ['timeframe=' + encodeURIComponent(state.timeframe),
             'window=' + encodeURIComponent(state.window),
             'benchmark=' + encodeURIComponent(state.benchmark),
             'trail=' + state.trail];
    /* period 為 0 代表「用該週期的預設值」，此時不要送參數，
       讓後端自己決定（週線 14、月線 8），避免把 0 傳過去還得靠後端擋。 */
    if (state.period > 0) p.push('period=' + state.period);
    if (state.sectors && state.sectors.length) {
      p.push('sectors=' + encodeURIComponent(state.sectors.join(',')));
    }
    return '/api/rrg?' + p.join('&');
  }

  function load(opts) {
    opts = opts || {};
    var mySeq = ++state.seq;
    state.loading = true;
    if (el.refresh) SA.setBusy(el.refresh, true, '載入中…', '重新整理');
    showNotice('載入中…', 'info');

    var url = buildUrl() + (opts.refresh ? '&refresh=1' : '');

    SA.api(url).then(function (d) {
      /* 競態保護：連續切換控制項時，只採用最後一次請求的結果 */
      if (mySeq !== state.seq) return;
      state.data = d;
      state.loading = false;
      if (el.refresh) SA.setBusy(el.refresh, false, '載入中…', '重新整理');
      syncMeta(d.meta);
      syncControlsFromResponse(d);
      renderAll();
      SA.setStatus('已更新 ' + (d.asOf || ''), 'ok');
    }).catch(function (err) {
      if (mySeq !== state.seq) return;
      state.loading = false;
      if (el.refresh) SA.setBusy(el.refresh, false, '載入中…', '重新整理');
      state.data = null;
      renderAll();
      var desc = SA.describeError(err);
      showNotice(desc.title + '：' + desc.message + (desc.hint ? '　' + desc.hint : ''), 'error',
                 desc.kind === 'retry' || desc.kind === 'offline');
      SA.setStatus('載入失敗', 'err');
    });
  }

  function showNotice(text, kind, retryable) {
    if (!el.notice) return;
    if (!text) { el.notice.hidden = true; el.notice.innerHTML = ''; return; }
    el.notice.hidden = false;
    el.notice.className = 'rrg-notice ' + (kind || 'info');
    el.notice.innerHTML = '<span class="rrg-notice-text">' + SA.esc(text) + '</span>' +
      (retryable ? '<button type="button" class="rrg-notice-retry" id="rrgNoticeRetry">重試</button>' : '');
    var btn = $('rrgNoticeRetry');
    if (btn) btn.addEventListener('click', function () { load({ refresh: true }); });
  }

  /* ---------------- 控制項 ---------------- */
  function syncMeta(meta) {
    if (!meta) return;
    fillSelect(el.selTf, meta.timeframes, state.timeframe);
    fillSelect(el.selWin, meta.windows, state.window);
    fillSelect(el.selBench, meta.benchmarks.map(function (b) {
      return { key: b.key, label: b.label + '（' + b.key + '）' };
    }), state.benchmark);

    if (el.rangeTrail) {
      el.rangeTrail.min = meta.trailMin;
      el.rangeTrail.max = meta.trailMax;
    }
    renderChips(meta.sectors);
  }

  function fillSelect(sel, items, current) {
    if (!sel || !items) return;
    sel.innerHTML = items.map(function (it) {
      return '<option value="' + SA.esc(it.key) + '"' +
        (it.key === current ? ' selected' : '') + '>' + SA.esc(it.label) + '</option>';
    }).join('');
  }

  /** 後端對非法值會回套預設值，這裡把「實際生效值」同步回 UI，避免畫面與資料不一致 */
  function syncControlsFromResponse(d) {
    state.trail = d.trail;
    state.period = d.period;
    if (el.trailVal) el.trailVal.textContent = d.trail;
    if (el.rangeTrail) el.rangeTrail.value = d.trail;
    if (el.periodVal) el.periodVal.textContent = d.period;
    if (el.rangePeriod) el.rangePeriod.value = d.period;
    if (el.selTf && el.selTf.value !== d.timeframe) el.selTf.value = d.timeframe;
    if (el.selWin && el.selWin.value !== d.window) el.selWin.value = d.window;
    if (el.selBench && el.selBench.value !== d.benchmark) el.selBench.value = d.benchmark;
    state.timeframe = d.timeframe;
    state.window = d.window;
    state.benchmark = d.benchmark;

    if (d.windowNote) {
      showNotice(d.windowNote, 'warn');
    } else if (d.failures && d.failures.length) {
      showNotice('部分版塊取不到資料：' + d.failures.map(function (f) {
        return f.symbol + '（' + f.code + '）';
      }).join('、'), 'warn');
    } else if (d.adjFallback && d.adjFallback.length) {
      showNotice('以下標的取不到復權價，已改用未復權價，相對強度可能偏低：' +
        d.adjFallback.join('、'), 'warn');
    } else {
      showNotice('');
    }
  }

  function renderChips(sectors) {
    if (!el.chips || !sectors) return;
    var chosen = state.sectors;
    el.chips.innerHTML = sectors.map(function (s) {
      var on = !chosen || chosen.indexOf(s.key) >= 0;
      return '<label class="rrg-chip' + (on ? ' on' : '') + '" data-key="' + SA.esc(s.key) + '">' +
        '<input type="checkbox"' + (on ? ' checked' : '') + ' value="' + SA.esc(s.key) + '">' +
        '<span class="rrg-chip-dot" style="background:' + SA.esc(s.color) + '"></span>' +
        '<span class="rrg-chip-k">' + SA.esc(s.key) + '</span>' +
        '<span class="rrg-chip-l">' + SA.esc(s.short || s.label) + '</span>' +
        '</label>';
    }).join('');
    updateSectorSummary();
  }

  function updateSectorSummary() {
    if (!el.sectorSummary) return;
    var total = state.data && state.data.meta ? state.data.meta.sectors.length : 11;
    var n = state.sectors ? state.sectors.length : total;
    el.sectorSummary.textContent = (state.sectors ? '已選 ' + n + ' / ' + total : '已選全部 ' + total) + ' 個版塊';
  }

  function readChips() {
    if (!el.chips) return null;
    var boxes = el.chips.querySelectorAll('input[type="checkbox"]');
    var picked = [];
    Array.prototype.forEach.call(boxes, function (b) { if (b.checked) picked.push(b.value); });
    return picked.length === boxes.length ? null : picked;
  }

  /* ---------------- 主繪製 ---------------- */
  function renderAll() {
    var d = state.data;
    if (!d || !d.ok) {
      if (el.empty) el.empty.hidden = false;
      if (el.stamp) el.stamp.textContent = '—';
      if (el.tableBody) el.tableBody.innerHTML = '<tr><td colspan="9" class="rrg-table-empty">尚無資料</td></tr>';
      if (el.legend) el.legend.innerHTML = '';
      drawChart();  /* 仍畫出空白座標，讓畫面不至於全白 */
      renderDiag(null);
      return;
    }
    if (el.empty) el.empty.hidden = true;
    if (el.stamp) el.stamp.textContent = d.asOf ? ('資料至 ' + d.asOf) : '—';
    renderLegend(d);
    drawChart();
    renderTable(d);
    renderDiag(d);
  }

  function renderLegend(d) {
    if (!el.legend) return;
    var counts = { leading: 0, weakening: 0, lagging: 0, improving: 0 };
    d.points.forEach(function (p) { if (counts[p.quadrant] != null) counts[p.quadrant] += 1; });
    el.legend.innerHTML = ['leading', 'weakening', 'lagging', 'improving'].map(function (k) {
      return '<span class="rrg-leg"><i style="background:' + COLORS[k] + '"></i>' +
        QUAD_META[k].label + ' <b>' + counts[k] + '</b></span>';
    }).join('');
  }

  /* ---------------- 畫布 ---------------- */
  /** DPR 縮放，沿用 app.js 的既有做法（public/app.js 的 setupCanvas） */
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

  /**
   * 依資料自動決定座標範圍。
   * 以 (100,100) 為中心、**兩軸同一半徑**（等比），並留出尾跡空間。
   * 這是 RRG 的硬性要求：x/y 若不同比例，45 度分界線會失真。
   */
  function computeDomain(d) {
    var maxDev = 6;   /* 最小視野：±6，避免只有一個點時畫面被放大到失真 */
    if (d && d.points) {
      d.points.forEach(function (p) {
        (p.trail || []).forEach(function (tp) {
          maxDev = Math.max(maxDev, Math.abs(tp.ratio - 100), Math.abs(tp.momentum - 100));
        });
        if (p.ratio != null) maxDev = Math.max(maxDev, Math.abs(p.ratio - 100));
        if (p.momentum != null) maxDev = Math.max(maxDev, Math.abs(p.momentum - 100));
      });
    }
    /* 取整到好看的刻度，並多留 12% 邊界讓標籤不貼邊 */
    var pad = maxDev * 1.12;
    var step = pad <= 3 ? 1 : pad <= 8 ? 2 : pad <= 20 ? 5 : pad <= 50 ? 10 : 25;
    var lim = Math.ceil(pad / step) * step;
    return { min: 100 - lim, max: 100 + lim, step: step };
  }

  function drawChart() {
    if (!el.canvas || !el.wrap) return;
    var cssW = el.wrap.clientWidth || 640;
    /* 繪圖區是正方形，而邊距固定（左 46 右 18 上 18 下 34）。
       要讓正方形儘量填滿外框，高度≈寬度-12（水平邊距 64 vs 垂直 52 的差）。
       上限 640 避免在超寬螢幕上變成一個巨大方塊。 */
    var cssH = Math.max(320, Math.min(Math.round(cssW - 12), 640));
    var sc = setupCanvas(el.canvas, cssW, cssH);
    var ctx = sc.ctx, W = sc.w, H = sc.h;

    ctx.clearRect(0, 0, W, H);

    var d = state.data && state.data.ok ? state.data : null;
    var dom = computeDomain(d);

    /* 邊距：左邊要放 y 軸標籤，下方要放 x 軸標籤 */
    var padL = 46, padR = 18, padT = 18, padB = 34;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    /* 等比：取較小邊作為實際繪圖區邊長，置中 */
    var side = Math.min(plotW, plotH);
    var ox = padL + (plotW - side) / 2;
    var oy = padT + (plotH - side) / 2;

    function X(v) { return ox + ((v - dom.min) / (dom.max - dom.min)) * side; }
    function Y(v) { return oy + side - ((v - dom.min) / (dom.max - dom.min)) * side; }

    /* --- 背景與四象限底色 --- */
    ctx.save();
    var cX = X(100), cY = Y(100);

    var quadFill = [
      { x0: cX, y0: oy,  x1: ox + side, y1: cY, color: 'rgba(15,157,88,0.055)' },   /* 右上 領先 */
      { x0: cX, y0: cY,  x1: ox + side, y1: oy + side, color: 'rgba(180,83,9,0.055)' }, /* 右下 弱化 */
      { x0: ox, y0: cY,  x1: cX, y1: oy + side, color: 'rgba(217,43,43,0.055)' },   /* 左下 落後 */
      { x0: ox, y0: oy,  x1: cX, y1: cY, color: 'rgba(29,78,216,0.055)' },          /* 左上 改善 */
    ];
    quadFill.forEach(function (q) {
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0);
    });

    /* --- 格線 --- */
    ctx.strokeStyle = '#eef1f6';
    ctx.lineWidth = 1;
    for (var g = dom.min; g <= dom.max; g += dom.step) {
      var gx = Math.round(X(g)) + 0.5;
      var gy = Math.round(Y(g)) + 0.5;
      ctx.beginPath(); ctx.moveTo(gx, oy); ctx.lineTo(gx, oy + side); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ox, gy); ctx.lineTo(ox + side, gy); ctx.stroke();
    }

    /* --- 中心十字線（100） --- */
    ctx.strokeStyle = '#c9d2e0';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(Math.round(cX) + 0.5, oy); ctx.lineTo(Math.round(cX) + 0.5, oy + side); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox, Math.round(cY) + 0.5); ctx.lineTo(ox + side, Math.round(cY) + 0.5); ctx.stroke();

    /* --- 象限標題 --- */
    ctx.font = '600 12px -apple-system, "Segoe UI", "PingFang TC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var qPad = 26;
    var labels = [
      { t: '領先', sub: 'Leading', x: cX + (ox + side - cX) / 2, y: oy + qPad },
      { t: '弱化', sub: 'Weakening', x: cX + (ox + side - cX) / 2, y: oy + side - qPad },
      { t: '落後', sub: 'Lagging', x: ox + (cX - ox) / 2, y: oy + side - qPad },
      { t: '改善', sub: 'Improving', x: ox + (cX - ox) / 2, y: oy + qPad },
    ];
    labels.forEach(function (L) {
      ctx.fillStyle = 'rgba(16,24,40,0.30)';
      ctx.font = '600 13px -apple-system, "Segoe UI", "PingFang TC", sans-serif';
      ctx.fillText(L.t, L.x, L.y);
      ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(L.sub, L.x, L.y + 15);
    });

    /* --- 軸刻度標籤 --- */
    ctx.fillStyle = '#8a94a6';
    ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (var t = dom.min; t <= dom.max; t += dom.step) {
      var tx = X(t);
      if (tx > ox - 1 && tx < ox + side + 1) {
        ctx.fillText(String(t), tx, oy + side + 8);
      }
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var t2 = dom.min; t2 <= dom.max; t2 += dom.step) {
      var ty = Y(t2);
      if (ty > oy - 1 && ty < oy + side + 1) {
        ctx.fillText(String(t2), ox - 8, ty);
      }
    }

    /* --- 軸標題 --- */
    ctx.fillStyle = '#475467';
    ctx.font = '600 11px -apple-system, "Segoe UI", "PingFang TC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('JdK RS-Ratio（相對強度）', ox + side / 2, H - 2);
    ctx.save();
    ctx.translate(11, oy + side / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'top';
    ctx.fillText('JdK RS-Momentum（動能）', 0, 0);
    ctx.restore();

    /* --- 版塊尾跡與端點 --- */
    if (!d) { ctx.restore(); return; }

    var activeKey = state.hover || state.pinned;

    /* 先畫非高亮的，再畫高亮的，確保高亮永遠在最上層 */
    var ordered = d.points.slice().sort(function (a, b) {
      var ah = a.key === activeKey ? 1 : 0;
      var bh = b.key === activeKey ? 1 : 0;
      return ah - bh;
    });

    ordered.forEach(function (p) {
      var isActive = p.key === activeKey;
      var dim = activeKey && !isActive;
      var trail = p.trail || [];
      if (!trail.length) return;

      ctx.globalAlpha = dim ? 0.22 : 1;

      /* 尾跡：由舊到新，透明度遞增 */
      for (var i = 1; i < trail.length; i++) {
        var a = trail[i - 1], b = trail[i];
        var frac = i / (trail.length - 1);
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = (dim ? 0.22 : 1) * (0.20 + 0.62 * frac);
        ctx.lineWidth = 1 + 1.9 * frac;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(X(a.ratio), Y(a.momentum));
        ctx.lineTo(X(b.ratio), Y(b.momentum));
        ctx.stroke();
      }

      ctx.globalAlpha = dim ? 0.22 : 1;

      /* 末端圓點（最新一期） */
      var hx = X(p.ratio), hy = Y(p.momentum);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(hx, hy, isActive ? 6.2 : 4.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(hx, hy, isActive ? 4.6 : 3.3, 0, Math.PI * 2);
      ctx.fill();

      if (isActive) {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.arc(hx, hy, 10.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      /* 標籤：高亮時一定顯示；否則只在空間允許時顯示，避免擠成一團 */
      var showLabel = isActive || trail.length > 0;
      if (showLabel) {
        ctx.globalAlpha = dim ? 0.3 : 1;
        var lx = hx + (hx > cX ? 9 : -9);
        ctx.textAlign = hx > cX ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.font = (isActive ? '700 ' : '600 ') + '11px -apple-system, "Segoe UI", "PingFang TC", sans-serif';
        ctx.fillStyle = '#101828';
        ctx.fillText(p.short || p.key, lx, hy);
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = '#667085';
        ctx.fillText(p.key, lx, hy + 12);
      }
    });

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ---------------- 懸停 ---------------- */
  /**
   * 命中測試：以「最新端點」為圓心，半徑內視為命中。
   * 不用尾跡線段做命中判定——線很細，使用者幾乎點不到。
   */
  function hitTest(cssX, cssY) {
    if (!state.data || !state.data.ok) return null;
    var cv = el.canvas;
    if (!cv) return null;
    var W = parseFloat(cv.style.width) || cv.clientWidth;
    var H = parseFloat(cv.style.height) || cv.clientHeight;

    var d = state.data;
    var dom = computeDomain(d);
    var padL = 46, padR = 18, padT = 18, padB = 34;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var side = Math.min(plotW, plotH);
    var ox = padL + (plotW - side) / 2;
    var oy = padT + (plotH - side) / 2;

    function X(v) { return ox + ((v - dom.min) / (dom.max - dom.min)) * side; }
    function Y(v) { return oy + side - ((v - dom.min) / (dom.max - dom.min)) * side; }

    var best = null, bestDist = 18;  /* 18px 命中半徑 */
    d.points.forEach(function (p) {
      var dist = Math.hypot(X(p.ratio) - cssX, Y(p.momentum) - cssY);
      if (dist < bestDist) { bestDist = dist; best = p; }
    });
    return best;
  }

  function showTip(p, cssX, cssY) {
    if (!el.tip || !p) return;
    var q = QUAD_META[p.quadrant] || { label: p.quadrantLabel || '—', tip: '' };
    var a = p.analysis || {};
    var rows = [
      ['RS-Ratio', SA.fmt(p.ratio, 2)],
      ['RS-Momentum', SA.fmt(p.momentum, 2)],
      ['所在象限', q.label + (q.tip ? '（' + q.tip + '）' : '')],
      ['尾跡位移', a.length == null ? '—' : SA.fmt(a.length, 2)],
      ['每期移動', a.speedPerBar == null ? '—' : SA.fmt(a.speedPerBar, 2)],
      ['直線度', a.efficiency == null ? '—' : (a.efficiency * 100).toFixed(0) + '%'],
      ['彎曲程度', a.curvatureTierCn || '—'],
      ['動能判讀', a.signalCn || '—'],
      ['下一步', p.cross && p.cross.nextCn ? p.cross.nextCn : '—'],
      ['資料至', p.asOf || '—'],
    ];
    el.tip.innerHTML =
      '<div class="rrg-tip-head"><span class="rrg-tip-dot" style="background:' + SA.esc(p.color) + '"></span>' +
      SA.esc(p.label) + ' <span class="rrg-tip-k">' + SA.esc(p.key) + '</span></div>' +
      '<table class="rrg-tip-rows">' +
      rows.map(function (r) {
        return '<tr><th>' + SA.esc(r[0]) + '</th><td>' + SA.esc(String(r[1])) + '</td></tr>';
      }).join('') +
      '</table>';
    el.tip.hidden = false;

    /* 邊界防護：**視口是硬約束**，容器只是偏好。
       手機上圖表容器本身就落在頁面偏下方（實測頂端 y≈626、高 324），
       若堅持把 tooltip 夾在容器內，310px 的內容只能塞進 218px 的空間，
       底部一定會被切掉。
       而 .rrg-chart-wrap 沒有 overflow:hidden，所以允許 tooltip 向上
       溢出到容器外（覆蓋上方區塊）是安全且正確的做法——
       tooltip 本來就是浮層，被裁切才是不可接受的。
       因此：上下界只取視口；容器高度僅在「容器比視口更有空間」時才採用。 */
    var wrapRect = el.wrap.getBoundingClientRect();
    var tipW = el.tip.offsetWidth || 220;
    var tipH = el.tip.offsetHeight || 180;

    /* 視口可用範圍（換算成相對容器的座標；容器本身有頁面偏移，必須扣掉） */
    var vMinX = -wrapRect.left + 4;
    var vMaxX = global.innerWidth - wrapRect.left - tipW - 4;
    var vMinY = -wrapRect.top + 4;
    var vMaxY = global.innerHeight - wrapRect.top - tipH - 4;

    /* 水平：容器與視口取交集（左右不出界較自然） */
    var minX = Math.max(4, vMinX);
    var maxX = Math.min(wrapRect.width - tipW - 4, vMaxX);

    /* 垂直：以視口為準，可為負值（即允許溢出容器上緣） */
    var minY = vMinY;
    var maxY = vMaxY;

    /* 偏好位置：滑鼠右下方；空間不足時翻到左/上 */
    var left = cssX + 16;
    var top = cssY + 12;
    if (left + tipW > wrapRect.width - 4) left = cssX - tipW - 16;
    if (top + tipH > wrapRect.height - 4) top = cssY - tipH - 12;

    /* 夾制。若區間反轉（空間真的不夠），靠上緣顯示，至少看得到標題與前幾列。 */
    left = maxX >= minX ? Math.max(minX, Math.min(left, maxX)) : minX;
    top = maxY >= minY ? Math.max(minY, Math.min(top, maxY)) : minY;

    el.tip.style.left = Math.round(left) + 'px';
    el.tip.style.top = Math.round(top) + 'px';
  }

  function hideTip() {
    if (el.tip) {
      el.tip.hidden = true;
      el.tip.classList.remove('locked');
    }
    state.hover = null;
    drawChart();
  }

  function bindHover() {
    if (!el.canvas) return;

    function toLocal(evt) {
      var r = el.canvas.getBoundingClientRect();
      return { x: evt.clientX - r.left, y: evt.clientY - r.top };
    }

    el.canvas.addEventListener('mousemove', function (e) {
      var pt = toLocal(e);
      var hit = hitTest(pt.x, pt.y);
      var key = hit ? hit.key : null;
      if (key !== state.hover) {
        state.hover = key;
        drawChart();
      }
      if (hit) showTip(hit, pt.x, pt.y);
      else if (el.tip) el.tip.hidden = true;
    });

    el.canvas.addEventListener('mouseleave', function () {
      if (state.pinned) {
        state.hover = null;
        drawChart();
        if (el.tip) el.tip.hidden = true;
      } else {
        hideTip();
      }
    });

    /* 點擊鎖定／解除（觸控裝置沒有 hover，需要這個） */
    el.canvas.addEventListener('click', function (e) {
      var pt = toLocal(e);
      var hit = hitTest(pt.x, pt.y);
      if (hit && state.pinned === hit.key) {
        state.pinned = null;
        hideTip();
      } else if (hit) {
        state.pinned = hit.key;
        state.hover = hit.key;
        drawChart();
        showTip(hit, pt.x, pt.y);
        /* 鎖定後才允許在 tooltip 內捲動（未鎖定時它必須繼續穿透滑鼠） */
        if (el.tip) el.tip.classList.add('locked');
      } else {
        state.pinned = null;
        hideTip();
      }
    });
  }

  /* ---------------- 表格 ---------------- */
  function renderTable(d) {
    if (!el.tableBody) return;
    if (!d.points.length) {
      el.tableBody.innerHTML = '<tr><td colspan="9" class="rrg-table-empty">沒有可顯示的版塊</td></tr>';
      return;
    }

    /* 依 RS-Ratio 由高到低排，讓「誰強誰弱」一眼看出來 */
    var rows = d.points.slice().sort(function (a, b) { return b.ratio - a.ratio; });

    el.tableBody.innerHTML = rows.map(function (p) {
      var a = p.analysis || {};
      var q = QUAD_META[p.quadrant] || { label: p.quadrantLabel || '—' };
      var next = p.cross && p.cross.nextCn ? p.cross.nextCn : '—';
      var conf = p.cross && p.cross.confidence;
      var confMark = conf === 'high' ? ' <span class="rrg-conf high">高</span>'
        : conf === 'medium' ? ' <span class="rrg-conf med">中</span>' : '';
      var sigCls = a.signal === 'turning-cw' ? 'cw'
        : a.signal === 'turning-ccw' ? 'ccw'
        : a.signal === 'flat' ? 'flat' : 'moving';
      return '<tr data-key="' + SA.esc(p.key) + '">' +
        '<td><span class="rrg-dot" style="background:' + SA.esc(p.color) + '"></span>' +
        '<b>' + SA.esc(p.key) + '</b> <span class="rrg-td-label">' + SA.esc(p.short || p.label) + '</span></td>' +
        '<td class="num">' + SA.fmt(p.ratio, 2) + '</td>' +
        '<td class="num">' + SA.fmt(p.momentum, 2) + '</td>' +
        '<td><span class="rrg-quad q-' + SA.esc(p.quadrant) + '">' + SA.esc(q.label) + '</span></td>' +
        '<td class="num">' + (a.length == null ? '—' : SA.fmt(a.length, 2)) + '</td>' +
        '<td class="num">' + (a.speedPerBar == null ? '—' : SA.fmt(a.speedPerBar, 2)) + '</td>' +
        '<td class="num">' + (a.efficiency == null ? '—' : (a.efficiency * 100).toFixed(0) + '%') + '</td>' +
        '<td><span class="rrg-sig ' + sigCls + '">' + SA.esc(a.signalCn || '—') + '</span></td>' +
        '<td>' + SA.esc(next) + confMark + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderDiag(d) {
    if (!el.diag) return;
    if (!d) { el.diag.hidden = true; return; }
    var bits = [];
    if (d.diagnostics) {
      bits.push('對齊期數 ' + d.diagnostics.totalPeriods +
        '（暖機 ' + d.diagnostics.warmup + ' 期後開始計算）');
    }
    if (d.coverage) {
      var bad = d.coverage.filter(function (c) { return !c.ok; });
      if (bad.length) {
        bits.push('無法計算：' + bad.map(function (c) {
          return c.label + '（' + c.reason + '）';
        }).join('、'));
      }
    }
    if (d.unknownSectors && d.unknownSectors.length) {
      bits.push('忽略未知版塊代碼：' + d.unknownSectors.join('、'));
    }
    if (d.source) bits.push('資料來源 ' + d.source);
    if (d.cached) bits.push('（快取）');

    if (!bits.length) { el.diag.hidden = true; return; }
    el.diag.hidden = false;
    el.diag.innerHTML = '<span class="rrg-diag-title">資料說明</span>' +
      bits.map(function (b) { return '<span class="rrg-diag-item">' + SA.esc(b) + '</span>'; }).join('');
  }

  /* ---------------- 事件綁定 ---------------- */
  var trailTimer = null, periodTimer = null;

  function bindControls() {
    if (el.selTf) {
      el.selTf.addEventListener('change', function () {
        state.timeframe = el.selTf.value;
        state.window = '1y';   /* 換週期時重設區間，避免沿用上一個週期的期數語意 */
        /* 平滑週期也要重設：週線預設 14、月線預設 8。
           若沿用上一個週期的值，切到月線仍帶著 14，
           月線一年只有 12 根，14 期平滑會嚴重過度平滑、圖形幾乎不動，
           但畫面完全看不出原因（滑桿停在 14 看起來很正常）。 */
        state.period = 0;      /* 0/省略 → 後端套用該週期的預設值 */
        load();
      });
    }
    if (el.selWin) {
      el.selWin.addEventListener('change', function () {
        state.window = el.selWin.value;
        load();
      });
    }
    if (el.selBench) {
      el.selBench.addEventListener('change', function () {
        state.benchmark = el.selBench.value;
        load();
      });
    }
    if (el.rangeTrail) {
      el.rangeTrail.addEventListener('input', function () {
        state.trail = Number(el.rangeTrail.value) || 5;
        if (el.trailVal) el.trailVal.textContent = state.trail;
        /* 拖動時高頻觸發，但只影響切片、不重抓上游，仍做去抖避免重繪風暴 */
        clearTimeout(trailTimer);
        trailTimer = setTimeout(function () { load(); }, 140);
      });
    }
    if (el.rangePeriod) {
      el.rangePeriod.addEventListener('input', function () {
        state.period = Number(el.rangePeriod.value) || 14;
        if (el.periodVal) el.periodVal.textContent = state.period;
        clearTimeout(periodTimer);
        periodTimer = setTimeout(function () { load(); }, 320);
      });
    }
    if (el.chips) {
      el.chips.addEventListener('change', function () {
        Array.prototype.forEach.call(el.chips.querySelectorAll('.rrg-chip'), function (c) {
          var box = c.querySelector('input');
          c.classList.toggle('on', !!(box && box.checked));
        });
        var picked = readChips();
        if (picked && picked.length === 0) {
          showNotice('至少要選一個版塊', 'warn');
          renderChips(state.data && state.data.meta ? state.data.meta.sectors : null);
          return;
        }
        state.sectors = picked;
        updateSectorSummary();
        load();
      });
    }
    if (el.tableBody) {
      el.tableBody.addEventListener('click', function (e) {
        var tr = e.target.closest ? e.target.closest('tr[data-key]') : null;
        if (!tr) return;
        var key = tr.getAttribute('data-key');
        state.pinned = (state.pinned === key) ? null : key;
        state.hover = state.pinned;
        drawChart();
        if (!state.pinned && el.tip) el.tip.hidden = true;
      });
    }
    if (el.refresh) {
      el.refresh.addEventListener('click', function () { load({ refresh: true }); });
    }

    /* 視窗尺寸變化時重繪（畫布是像素尺寸，不重繪會模糊或錯位） */
    var rzTimer = null;
    global.addEventListener('resize', function () {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(function () { drawChart(); }, 120);
    });
  }

  /* ---------------- 進場 ---------------- */
  var started = false;

  function onEnter() {
    if (started) return;   /* 回到本頁不重抓；有快取也幾乎是瞬間 */
    started = true;
    if (!el.canvas) cacheEl();
    bindControls();
    bindHover();
    /* 先畫空白座標，載入時畫面不會是一片白 */
    drawChart();
    load();
  }

  if (SA && SA.onRoute) SA.onRoute({ onRrg: onEnter });

  global.RRG = { state: state, load: load, draw: drawChart };
})(window);
