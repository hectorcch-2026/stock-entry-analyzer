/* ===================================================
   版塊熱力圖 Treemap（前端）
   ===================================================
   資料流：
     /api/rrg/treemap → { groups[], periods[], legend[], scale{} } → 這裡只負責畫。

   設計原則：
     1. 佈局演算法在後端（lib/treemap.js）已驗證過（面積比精確、無重疊），
        前端只重算「螢幕座標」——因為容器寬高只有瀏覽器知道。
        面積權值 areaValue 由後端給定，前端不得自行改動比例。
     2. 四個週期的數值都在同一份回應裡（leaf.returns / group.returns），
        切換週期是**純本地重繪**，不重新請求。
        這讓「快速連點日→週→月→年」零延遲，也不會有競態。
     3. 顏色語義：0 級 = 無資料（灰），1 級 = 平盤，2..5 = 由淺到深。
        平盤與無資料必須分開，否則使用者無法分辨「沒漲沒跌」與「抓不到資料」。
     4. 紅漲綠跌（華人市場慣例），與本專案其他檢視一致。
   =================================================== */
(function (global) {
  'use strict';

  var SA = global.SA;

  /* 顏色：漲紅跌綠。深淺由 level 決定（見 levelColor） */
  var UP_BASE = [217, 43, 43];     /* #d92b2b */
  var DOWN_BASE = [15, 157, 88];   /* #0f9d58 */
  var FLAT_BG = '#eef1f5';
  var NODATA_BG = '#d7dce4';
  var BORDER = '#ffffff';
  var TEXT_DARK = '#101828';
  var TEXT_LIGHT = '#ffffff';

  var state = {
    data: null,
    period: 'm1',
    loading: false,
    seq: 0,
    error: null,
    /* 佈局結果（每次重繪時算好，供懸停命中測試） */
    layout: null,
    hover: null,       /* 目前懸停的 leaf symbol */
    hoverGroup: null,
    /* 每個週期的分級門檻與級數，由 API 的 legend 提供 */
    scales: {},
    levels: 5,
  };

  function $(id) { return document.getElementById(id); }

  var el = {};

  function cacheEl() {
    el.wrap = $('rrgTmWrap');
    el.canvas = $('rrgTmCanvas');
    el.tip = $('rrgTmTip');
    el.empty = $('rrgTmEmpty');
    el.meta = $('rrgTmMeta');
    el.legend = $('rrgTmLegend');
    el.periods = $('rrgTmPeriods');
  }

  /* ---------------- 顏色 ---------------- */

  /**
   * 依級別取色。
   *
   * level 1..5 由淺到深；強度用 (level-1)/(LEVELS-1) 線性內插到基色。
   * 為什麼最低一級不是全白：純白會與卡片背景融為一體，
   * 使用者看不出那一格存在。用 18% 起跳，既有顏色又可辨識。
   */
  function levelColor(level, sign) {
    if (level <= 0) return NODATA_BG;          // 無資料
    if (sign === 0) return FLAT_BG;            // 平盤
    var maxLv = state.levels || 5;
    var t = maxLv > 1 ? (level - 1) / (maxLv - 1) : 1;
    var base = sign > 0 ? UP_BASE : DOWN_BASE;
    var minA = 0.18;                            // 最淺也帶 18% 基色
    var a = minA + (1 - minA) * t;
    /* 在白色與基色之間內插，得到「同色系、不同深淺」 */
    var r = Math.round(255 + (base[0] - 255) * a);
    var g = Math.round(255 + (base[1] - 255) * a);
    var b = Math.round(255 + (base[2] - 255) * a);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /** 深色底（深紅／深綠）要用白字，淺底用深字 */
  function textColorFor(level, sign) {
    if (level <= 0 || sign === 0) return TEXT_DARK;
    var maxLv = state.levels || 5;
    var t = maxLv > 1 ? (level - 1) / (maxLv - 1) : 1;
    var a = 0.18 + 0.82 * t;
    /* 內插後亮度低於 0.55 就用白字 */
    var lum = (1 - a) + a * ((0.299 * Math.abs(sign > 0 ? UP_BASE[0] : DOWN_BASE[0]) +
      0.587 * Math.abs(sign > 0 ? UP_BASE[1] : DOWN_BASE[1]) +
      0.114 * Math.abs(sign > 0 ? UP_BASE[2] : DOWN_BASE[2])) / 255);
    return lum < 0.62 ? TEXT_LIGHT : TEXT_DARK;
  }

  /** 取某節點在目前週期的漲跌幅 */
  function pctOf(node) {
    if (!node) return null;
    if (node.returns && typeof node.returns[state.period] === 'number') {
      return node.returns[state.period];
    }
    /* 回退：舊格式或只有單一週期時 */
    if (typeof node.returnPct === 'number') return node.returnPct;
    return null;
  }

  /** 依漲跌幅算級別（前端也要算，因為切換週期是本地重繪） */
  function levelOf(pct) {
    if (pct == null || !isFinite(pct)) return 0;
    var sc = state.scales[state.period];
    if (!sc || !(sc > 0)) return 1;
    var t = Math.min(1, Math.sqrt(Math.min(Math.abs(pct) / sc, 1)));
    return Math.max(1, Math.min(state.levels, Math.ceil(t * state.levels)));
  }

  /* ---------------- 佈局（前端重算螢幕座標） ---------------- */

  /**
   * squarified 佈局。與 lib/treemap.js 同一演算法，
   * 但這裡算的是「像素座標」，權值直接沿用後端給的 areaValue。
   *
   * 為什麼要重複實作：容器寬高只有瀏覽器知道（後端回 1140×560 之類的假設
   * 會在手機上爆掉）。面積**比例**由後端決定，座標由前端決定，職責分明。
   */
  function squarify(items, x, y, w, h) {
    var out = [];
    var list = [];
    for (var i = 0; i < items.length; i++) {
      if (isFinite(items[i].value) && items[i].value > 0) list.push(items[i]);
    }
    list.sort(function (a, b) { return b.value - a.value; });
    if (!list.length || !(w > 0) || !(h > 0)) return out;

    var total = 0;
    for (var t = 0; t < list.length; t++) total += list[t].value;
    if (!(total > 0)) return out;

    var scale = (w * h) / total;
    var rem = [];
    for (var r = 0; r < list.length; r++) {
      rem.push({ item: list[r], area: list[r].value * scale });
    }

    var rx = x, ry = y, rw = w, rh = h;
    var idx = 0;

    while (idx < rem.length) {
      if (!(rw > 0) || !(rh > 0)) {
        for (var z = idx; z < rem.length; z++) {
          out.push({ item: rem[z].item, x: rx, y: ry, w: 0, h: 0 });
        }
        break;
      }

      var horizontal = rw >= rh;
      var span = horizontal ? rw : rh;

      var rowArea = 0, end = idx, bestWorst = Infinity;
      while (end < rem.length) {
        var nextArea = rowArea + rem[end].area;
        var worst = worstRatio(rem, idx, end, nextArea, span);
        if (rowArea > 0 && worst > bestWorst) break;
        rowArea = nextArea;
        bestWorst = worst;
        end++;
      }
      if (end === idx) { rowArea = rem[idx].area; end = idx + 1; }

      var thick = rowArea / span;
      var offset = 0;
      for (var k = idx; k < end; k++) {
        var a = rem[k].area;
        var frac = rowArea > 0 ? a / rowArea : 1;
        if (horizontal) {
          var segW = span * frac;
          out.push({ item: rem[k].item, x: rx + offset, y: ry, w: segW, h: Math.min(thick, rh) });
          offset += segW;
        } else {
          var segH = span * frac;
          out.push({ item: rem[k].item, x: rx, y: ry + offset, w: Math.min(thick, rw), h: segH });
          offset += segH;
        }
      }

      if (horizontal) { ry += thick; rh -= thick; }
      else { rx += thick; rw -= thick; }
      idx = end;
    }
    return out;
  }

  function worstRatio(rem, from, to, sumArea, span) {
    if (!(sumArea > 0) || !(span > 0)) return Infinity;
    var maxA = 0, minA = Infinity;
    for (var k = from; k <= to && k < rem.length; k++) {
      var a = rem[k].area;
      if (a > maxA) maxA = a;
      if (a < minA) minA = a;
    }
    if (!(minA > 0) || !isFinite(minA)) minA = sumArea;
    var s2 = span * span;
    var a1 = (s2 * maxA) / (sumArea * sumArea);
    var a2 = (sumArea * sumArea) / (s2 * minA);
    return Math.max(a1, a2);
  }

  /* ---------------- 繪製 ---------------- */

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

  /** 量測文字寬度（用離屏 canvas 快取，避免每次 fillText 都量） */
  var measureCtx = null;
  function textWidth(txt, font) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(txt).width;
  }

  /** 依可用寬度截斷文字並加省略號 */
  function fitText(txt, maxW, font) {
    if (!txt) return '';
    if (textWidth(txt, font) <= maxW) return txt;
    var lo = 0, hi = txt.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (textWidth(txt.slice(0, mid) + '…', font) <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? txt.slice(0, lo) + '…' : '';
  }

  /**
   * 主繪製。
   *
   * 版面策略：
   *   - 外層：版塊群組（面積 = 版塊市值）
   *   - 內層：個股（面積 = 個股市值）
   *   - 群組右上角留 15px 給版塊名稱（不佔用個股面積，避免標籤被壓縮）
   *   - 只有在格子足夠大時才畫標籤，其餘靠 tooltip。
   *     硬塞文字會讓圖變成一片模糊，比沒有標籤更糟。
   */
  function draw() {
    if (!el.canvas || !el.wrap) return;
    var d = state.data;
    var rect = el.wrap.getBoundingClientRect();
    var cssW = Math.max(240, Math.floor(rect.width));
    /* 高度：桌面固定 520，窄螢幕依寬度縮放（正方形感）但至少 380 */
    var cssH = cssW < 560 ? Math.max(380, Math.round(cssW * 1.15)) : 520;

    var c = setupCanvas(el.canvas, cssW, cssH);
    var ctx = c.ctx, W = c.w, H = c.h;

    ctx.clearRect(0, 0, W, H);

    if (!d || !d.groups || !d.groups.length) {
      state.layout = null;
      return;
    }

    var PAD = 2;        // 版塊之間的白邊
    var HEAD = 15;      // 版塊標題列高

    /* 1) 排版塊 */
    var outerItems = [];
    for (var i = 0; i < d.groups.length; i++) {
      outerItems.push({ value: d.groups[i].areaValue, group: d.groups[i] });
    }
    var outer = squarify(outerItems, 0, 0, W, H);
    var layout = [];

    /* 2) 逐版塊畫 */
    for (var o = 0; o < outer.length; o++) {
      var rectO = outer[o];
      var g = rectO.item.group;

      /* 群組底色（深一點的灰，讓白邊更清楚） */
      ctx.fillStyle = '#f3f5f8';
      ctx.fillRect(rectO.x, rectO.y, rectO.w, rectO.h);

      /* 群組標題：半透明黑底 + 白字，在任何格子上都讀得清 */
      var gp = pctOf(g);
      var gLabel = g.short || g.key;
      var gPctTxt = gp == null ? '—' : SA.pct(gp, 1);
      var titleFont = 'bold 11px -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
      var titleTxt = gLabel + '  ' + gPctTxt;

      /* 標題只在寬度足夠時畫（太窄就只畫代碼） */
      if (rectO.w > 40 && rectO.h > HEAD) {
        ctx.fillStyle = 'rgba(16,24,40,0.72)';
        ctx.fillRect(rectO.x, rectO.y, rectO.w, HEAD);

        ctx.save();
        ctx.beginPath();
        ctx.rect(rectO.x, rectO.y, rectO.w, HEAD);
        ctx.clip();
        ctx.font = titleFont;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffffff';
        var tx = rectO.x + 4;
        ctx.fillText(fitText(titleTxt, rectO.w - 8, titleFont), tx, rectO.y + HEAD / 2 + 0.5);
        ctx.restore();
      }

      /* 內層：個股 */
      var ix = rectO.x + PAD;
      var iy = rectO.y + (rectO.h > HEAD ? HEAD : 0);
      var iw = Math.max(0, rectO.w - PAD * 2);
      var ih = Math.max(0, rectO.h - (rectO.h > HEAD ? HEAD : 0) - PAD);

      var leafItems = [];
      for (var j = 0; j < g.leaves.length; j++) {
        leafItems.push({ value: g.leaves[j].areaValue, leaf: g.leaves[j] });
      }
      var inner = squarify(leafItems, ix, iy, iw, ih);

      var leafRects = [];
      for (var k = 0; k < inner.length; k++) {
        var rO = inner[k];
        var leaf = rO.item.leaf;
        var pct = pctOf(leaf);
        var lv = levelOf(pct);
        var sign = pct == null ? 0 : (pct > 0 ? 1 : (pct < 0 ? -1 : 0));

        /* 格子本體。內縮 0.5px 留白邊，讓相鄰同色格子可分辨 */
        var x0 = rO.x + 0.5, y0 = rO.y + 0.5;
        var w0 = Math.max(0, rO.w - 1), h0 = Math.max(0, rO.h - 1);
        ctx.fillStyle = levelColor(lv, sign);
        ctx.fillRect(x0, y0, w0, h0);

        /* 懸停高亮：加白色內描邊 */
        if (state.hover && leaf.symbol === state.hover) {
          ctx.strokeStyle = 'rgba(255,255,255,0.95)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x0 + 1, y0 + 1, Math.max(0, w0 - 2), Math.max(0, h0 - 2));
          ctx.strokeStyle = 'rgba(16,24,40,0.35)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(0, w0 - 1), Math.max(0, h0 - 1));
        }

        /* 標籤：格子夠大才畫。門檻用「能不能放下一行代碼」判斷。 */
        if (w0 > 26 && h0 > 16) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, y0, w0, h0);
          ctx.clip();

          var tc = textColorFor(lv, sign);
          var tickFont = 'bold 11px -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
          var pctFont = '10px -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
          var cx = x0 + w0 / 2;
          var cy = y0 + h0 / 2;

          var showTicker = w0 >= textWidth(leaf.ticker, tickFont) + 8;
          var pctTxt = pct == null ? '—' : SA.pct(pct, 1);
          var showPct = h0 >= 30 && w0 >= textWidth(pctTxt, pctFont) + 6;

          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = tc;

          if (showTicker && showPct) {
            ctx.font = tickFont;
            ctx.fillText(leaf.ticker, cx, cy - 7);
            ctx.font = pctFont;
            ctx.fillText(pctTxt, cx, cy + 7);
          } else if (showTicker) {
            ctx.font = tickFont;
            ctx.fillText(leaf.ticker, cx, cy);
          } else if (w0 > 22 && h0 > 12) {
            /* 太窄：只畫漲跌幅，代碼靠 tooltip */
            ctx.font = pctFont;
            ctx.fillText(pctTxt, cx, cy);
          }
          ctx.restore();
        }

        leafRects.push({
          x: x0, y: y0, w: w0, h: h0,
          leaf: leaf, group: g, pct: pct, level: lv, sign: sign,
        });
      }

      layout.push({
        x: rectO.x, y: rectO.y, w: rectO.w, h: rectO.h,
        group: g, leaves: leafRects,
      });
    }

    state.layout = layout;

    /* 3) 邊框：整張圖外框，避免邊緣看起來像被裁掉 */
    ctx.strokeStyle = 'rgba(16,24,40,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  /* ---------------- 懸停 ---------------- */

  /** 命中測試：由內層往外找（葉節點優先） */
  function hitTest(px, py) {
    var L = state.layout;
    if (!L) return null;
    for (var i = 0; i < L.length; i++) {
      var grp = L[i];
      for (var j = 0; j < grp.leaves.length; j++) {
        var r = grp.leaves[j];
        if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
      }
    }
    return null;
  }

  function showTip(hit, clientX, clientY) {
    if (!el.tip) return;
    if (!hit) { el.tip.hidden = true; return; }

    var g = hit.group;
    var leaf = hit.leaf;
    var d = state.data;
    var periodFull = d && d.periodFull ? d.periodFull : state.period;
    /* 用目前選定週期的全名（如「1 個月」），語意比「m1」清楚 */
    var pLabel = periodFull;
    if (d && d.periods) {
      for (var i = 0; i < d.periods.length; i++) {
        if (d.periods[i].key === state.period) { pLabel = d.periods[i].full; break; }
      }
    }

    var pct = hit.pct;
    var pctCls = pct == null ? 'none' : (pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat'));
    var pctTxt = pct == null ? '無資料' : SA.pct(pct, 2);

    /* 市值格式化：兆用 T，十億用 B */
    function fmtCap(v) {
      if (v == null || !isFinite(v) || v <= 0) return '—';
      if (v >= 1e12) return (v / 1e12).toFixed(2) + ' T';
      if (v >= 1e9) return (v / 1e9).toFixed(1) + ' B';
      return (v / 1e6).toFixed(0) + ' M';
    }

    el.tip.innerHTML =
      '<div class="rrg-tm-tip-head">' +
        '<span class="rrg-tm-tip-tick">' + SA.esc(leaf.ticker) + '</span>' +
        '<span class="rrg-tm-tip-name">' + SA.esc(leaf.name || '') + '</span>' +
      '</div>' +
      '<div class="rrg-tm-tip-sec">' +
        '<i style="background:' + (g.color || '#64748b') + '"></i>' +
        SA.esc(g.label || g.key) +
      '</div>' +
      '<dl class="rrg-tm-tip-list">' +
        '<div><dt>' + SA.esc(pLabel) + ' 漲跌</dt>' +
          '<dd class="rrg-tm-tip-pct ' + pctCls + '">' + pctTxt + '</dd></div>' +
        '<div><dt>市值</dt><dd>' + fmtCap(leaf.marketCap) + '</dd></div>' +
        '<div><dt>佔全體</dt><dd>' + (leaf.sharePct != null ? leaf.sharePct.toFixed(2) + '%' : '—') + '</dd></div>' +
        '<div><dt>版塊內</dt><dd>' + (leaf.sectorSharePct != null ? leaf.sectorSharePct.toFixed(1) + '%' : '—') + '</dd></div>' +
        '<div><dt>基金權重</dt><dd>' + (leaf.weight != null ? leaf.weight.toFixed(2) + '%' : '—') + '</dd></div>' +
      '</dl>' +
      '<div class="rrg-tm-tip-foot">點擊前往 AI 分析</div>';

    el.tip.hidden = false;

    /* 定位：預設在游標右下，靠邊時翻到另一側。
       以視窗為硬約束（容器的 overflow 不該決定 tooltip 能否被看見）。 */
    var tw = el.tip.offsetWidth;
    var th = el.tip.offsetHeight;
    var gap = 14;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;

    var left = clientX + gap;
    if (left + tw > vw - 8) left = clientX - tw - gap;
    if (left < 8) left = 8;

    var top = clientY + gap;
    if (top + th > vh - 8) top = clientY - th - gap;
    if (top < 8) top = 8;

    el.tip.style.left = Math.round(left) + 'px';
    el.tip.style.top = Math.round(top) + 'px';
  }

  /* ---------------- 圖例 ---------------- */

  /**
   * 圖例：顏色 ↔ 漲跌幅。
   *
   * 需求要求「說明顏色所對應的升跌幅度」。
   * 兩側各五級（跌深→跌淺 | 平 | 漲淺→漲深），並標出門檻值。
   * 門檻來自 API 的 legend[period].steps，不寫死，
   * 確保圖例與實際著色永不一致的問題不會發生。
   */
  function renderLegend() {
    if (!el.legend) return;
    var d = state.data;
    if (!d || !d.legend) { el.legend.innerHTML = ''; return; }

    var found = null;
    for (var i = 0; i < d.legend.length; i++) {
      if (d.legend[i].key === state.period) { found = d.legend[i]; break; }
    }
    if (!found) { el.legend.innerHTML = ''; return; }

    var sc = found.thresholdPct;
    var lv = state.levels;
    var steps = found.steps || [];

    /* 由跌到漲排列：-5,-4,-3,-2,-1, 平, +1..+5 */
    var cells = [];

    // 跌（深→淺，即 level 5→1，負向）
    for (var m = lv; m >= 1; m--) {
      cells.push({ level: m, sign: -1 });
    }
    cells.push({ level: 1, sign: 0, flat: true });
    for (var p = 1; p <= lv; p++) {
      cells.push({ level: p, sign: 1 });
    }

    var html = '';
    html += '<div class="rrg-tm-leg-head">' +
      '<span class="rrg-tm-leg-title">' + SA.esc(found.full || found.label) + ' 漲跌幅</span>' +
      '<span class="rrg-tm-leg-range">滿色 ±' + sc + '%</span>' +
      '</div>';
    html += '<div class="rrg-tm-leg-bar">';
    for (var c = 0; c < cells.length; c++) {
      var cell = cells[c];
      var bg = cell.flat ? FLAT_BG : levelColor(cell.level, cell.sign);
      var title;
      if (cell.flat) {
        title = '0%';
      } else {
        /* 對應的區間：level n 涵蓋 (n-1)/lv 到 n/lv 的閾值比例（平方後才是百分比） */
        var lo = sc * Math.pow((cell.level - 1) / lv, 2);
        var hi = cell.level === lv ? sc : sc * Math.pow(cell.level / lv, 2);
        title = (cell.sign > 0 ? '+' : '−') + lo.toFixed(2) + '% ~ ' +
          (cell.sign > 0 ? '+' : '−') + hi.toFixed(2) + '%';
      }
      html += '<i style="background:' + bg + '" title="' + SA.esc(title) + '"></i>';
    }
    html += '</div>';
    html += '<div class="rrg-tm-leg-foot">' +
      '<span>−' + sc + '% 以下</span>' +
      '<span>0%</span>' +
      '<span>+' + sc + '% 以上</span>' +
      '</div>';

    /* 無資料色（只有真的存在無資料節點時才說明，避免圖例塞滿少見情況） */
    var hasNoData = false;
    if (d.groups) {
      for (var gi = 0; gi < d.groups.length && !hasNoData; gi++) {
        for (var li = 0; li < d.groups[gi].leaves.length; li++) {
          if (d.groups[gi].leaves[li].noData) { hasNoData = true; break; }
        }
      }
    }
    if (hasNoData) {
      html += '<div class="rrg-tm-leg-nodata">' +
        '<i style="background:' + NODATA_BG + '"></i>無資料（該週期缺價格）</div>';
    }

    el.legend.innerHTML = html;
  }

  /* ---------------- 週期按鈕 ---------------- */

  function renderPeriods() {
    if (!el.periods) return;
    var d = state.data;
    var list = (d && d.periods) || [
      { key: 'd1', label: '日', full: '1 日' },
      { key: 'w1', label: '週', full: '1 週' },
      { key: 'm1', label: '月', full: '1 個月' },
      { key: 'y1', label: '年', full: '1 年' },
    ];

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var on = p.key === state.period;
      html += '<button type="button" class="rrg-tm-pbtn' + (on ? ' on' : '') + '"' +
        ' data-period="' + SA.esc(p.key) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
        ' title="' + SA.esc(p.full) + '">' + SA.esc(p.label) + '</button>';
    }
    el.periods.innerHTML = html;
  }

  /** 切換週期：純本地重繪，不重新請求（資料已在同一份回應裡） */
  function setPeriod(key) {
    if (!key || key === state.period) return;
    if (!state.scales[key]) return;      // 未知週期直接忽略
    state.period = key;
    renderPeriods();
    renderLegend();
    renderMeta();
    draw();
    /* 若 tooltip 開著，關掉——它的內容是舊週期的數字 */
    if (el.tip) el.tip.hidden = true;
    state.hover = null;
  }

  function renderMeta() {
    if (!el.meta) return;
    var d = state.data;
    if (!d) return;
    var pLabel = state.period;
    if (d.periods) {
      for (var i = 0; i < d.periods.length; i++) {
        if (d.periods[i].key === state.period) { pLabel = d.periods[i].full; break; }
      }
    }
    var risen = 0, fell = 0, flat = 0, nodata = 0;
    if (d.groups) {
      for (var gi = 0; gi < d.groups.length; gi++) {
        var lv = d.groups[gi].leaves;
        for (var li = 0; li < lv.length; li++) {
          var v = pctOf(lv[li]);
          if (v == null) nodata++;
          else if (v > 0) risen++;
          else if (v < 0) fell++;
          else flat++;
        }
      }
    }
    var bits = [];
    bits.push('<b>' + SA.esc(pLabel) + '</b>');
    bits.push(d.totals.sectors + ' 個版塊 · ' + d.totals.leaves + ' 檔');
    bits.push('<span class="rrg-tm-up">漲 ' + risen + '</span>');
    bits.push('<span class="rrg-tm-down">跌 ' + fell + '</span>');
    if (flat) bits.push('平 ' + flat);
    if (nodata) bits.push('<span class="rrg-tm-nd">無資料 ' + nodata + '</span>');
    /* 面積若不是市值，必須說清楚——
       否則使用者會理所當然把面積讀成市值，而那是錯的。 */
    if (d.areaBasis === 'weight') {
      bits.push('<span class="rrg-tm-warn">市值暫不可用，面積暫以基金權重代替</span>');
    } else if (d.areaBasis === 'equal') {
      bits.push('<span class="rrg-tm-warn">市值與權重皆不可用，各格等大</span>');
    }
    el.meta.innerHTML = bits.join(' · ');
    el.meta.className = 'rrg-tm-meta' + (d.areaBasis && d.areaBasis !== 'marketCap' ? ' warn' : '');
  }

  /* ---------------- 載入 ---------------- */

  function load(opts) {
    opts = opts || {};
    if (!el.wrap) return;
    var mySeq = ++state.seq;
    state.loading = true;
    setStatus('載入中…', 'info');

    var url = '/api/rrg/treemap?period=' + encodeURIComponent(state.period) +
      (opts.perSector ? '&perSector=' + opts.perSector : '') +
      (opts.refresh ? '&refresh=1' : '');

    SA.api(url).then(function (d) {
      if (mySeq !== state.seq) return;   // 競態保護：只採用最後一次請求
      state.loading = false;
      state.error = null;
      state.data = d;

      /* 建立各週期的門檻表與級數 */
      state.scales = {};
      if (d.legend) {
        for (var i = 0; i < d.legend.length; i++) {
          state.scales[d.legend[i].key] = d.legend[i].thresholdPct;
          if (d.legend[i].levels) state.levels = d.legend[i].levels;
        }
      }
      /* 若後端回報的預設週期有效，沿用它；
         否則沿用前端目前的（使用者可能已經切過） */
      if (d.period && state.scales[d.period] && !state.period) state.period = d.period;
      if (!state.scales[state.period]) state.period = d.period || 'm1';

      if (el.empty) el.empty.hidden = true;

      renderPeriods();
      renderLegend();
      renderMeta();
      draw();
      showHealth();
    }).catch(function (err) {
      if (mySeq !== state.seq) return;
      state.loading = false;
      state.error = err;
      renderError(err);
    });
  }

  function setStatus(text, kind) {
    if (!el.meta) return;
    el.meta.textContent = text;
    el.meta.className = 'rrg-tm-meta' + (kind === 'err' ? ' err' : '');
  }

  /**
   * 錯誤呈現。區分「可重試」（上游失敗）與「參數錯誤」（使用者該修正），
   * 兩者用不同措辭與是否顯示重試按鈕。
   */
  function renderError(err) {
    var code = err && err.code;
    var retryable = code === 'NETWORK' || code === 'OFFLINE' ||
      (err && err.status >= 500) || code === 'TREEMAP_FAILED' || code === 'CAP_NO_SESSION';

    var msg = (err && err.message) || '載入失敗';
    var hint = (err && err.hint) || '';

    if (el.meta) {
      el.meta.innerHTML = '<span class="rrg-tm-err-msg">' + SA.esc(msg) + '</span>' +
        (hint ? ' <span class="rrg-tm-err-hint">' + SA.esc(hint) + '</span>' : '') +
        (retryable ? ' <button type="button" class="rrg-tm-retry" id="rrgTmRetry">重試</button>' : '');
      el.meta.className = 'rrg-tm-meta err';
    }

    /* 畫布清空並顯示空狀態，避免留著上一次的舊圖（那會被誤讀成新資料） */
    if (el.canvas) {
      var ctx = el.canvas.getContext('2d');
      ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    }
    state.layout = null;

    if (el.empty) {
      el.empty.hidden = false;
      var t = el.empty.querySelector('.rrg-tm-empty-title');
      var m = el.empty.querySelector('.rrg-tm-empty-msg');
      if (t) t.textContent = retryable ? '暫時無法載入' : '無法顯示';
      if (m) m.textContent = msg;
    }

    var btn = $('rrgTmRetry');
    if (btn) btn.addEventListener('click', function () { load({ refresh: true }); });

    /* 圖例與週期按鈕清空：沒有資料時留著圖例會誤導 */
    if (el.legend) el.legend.innerHTML = '';
  }

  /** 資料稀疏時給一行說明（不是錯誤，只是提醒） */
  function showHealth() {
    var d = state.data;
    if (!d || !d.health) return;
    var h = d.health;
    var bits = [];
    if (d.periods) {
      for (var i = 0; i < d.periods.length; i++) {
        if (d.periods[i].key === state.period) { bits.push('<b>' + SA.esc(d.periods[i].full) + '</b>'); break; }
      }
    }
    if (h.noCapCount) bits.push(h.noCapCount + ' 檔缺市值（以最小面積呈現）');
    if (h.returnFailures) bits.push(h.returnFailures + ' 檔行情取得失敗');
    if (h.holdingsFailures) bits.push(h.holdingsFailures + ' 個版塊持股失敗');
    if (bits.length > 1 && el.meta) {
      /* 保留原有統計，另加提醒 */
      var warn = document.createElement('span');
      warn.className = 'rrg-tm-warn';
      warn.textContent = ' · ' + bits.slice(1).join(' · ');
      el.meta.appendChild(warn);
    }
  }

  /* ---------------- 事件 ---------------- */

  function bindEvents() {
    if (el.periods) {
      el.periods.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-period]') : null;
        if (!btn) return;
        setPeriod(btn.getAttribute('data-period'));
      });
    }

    if (el.canvas) {
      el.canvas.addEventListener('mousemove', function (e) {
        var r = el.canvas.getBoundingClientRect();
        var px = e.clientX - r.left;
        var py = e.clientY - r.top;
        var hit = hitTest(px, py);
        var sym = hit ? hit.leaf.symbol : null;
        if (sym !== state.hover) {
          state.hover = sym;
          el.canvas.style.cursor = hit ? 'pointer' : 'default';
          draw();
        }
        showTip(hit, e.clientX, e.clientY);
      });

      el.canvas.addEventListener('mouseleave', function () {
        if (state.hover) { state.hover = null; draw(); }
        if (el.tip) el.tip.hidden = true;
      });

      el.canvas.addEventListener('click', function (e) {
        var r = el.canvas.getBoundingClientRect();
        var hit = hitTest(e.clientX - r.left, e.clientY - r.top);
        if (!hit) return;
        /* 跳到能查到資料的代碼（BRK-B 而非 BRK.B） */
        SA.navigate('#/detail/' + encodeURIComponent(hit.leaf.symbol));
      });
    }

    /* 尺寸變化時重繪（版面比例依容器寬高而定）。
       debounce 80ms：拖動視窗時不要每個 mousemove 都重排。 */
    var rt = null;
    global.addEventListener('resize', function () {
      if (rt) clearTimeout(rt);
      rt = setTimeout(function () { if (state.data) draw(); }, 80);
    });
  }

  /* ---------------- 生命週期 ---------------- */

  /** 進入檢視時呼叫（由 rrg-client.js 的 onEnter 觸發） */
  function enter() {
    cacheEl();
    if (!el.canvas) return;
    if (!state.bound) {
      bindEvents();
      state.bound = true;
    }
    /* 延遲到版面穩定後再載入並量測（display:none → block 的那一刻
       getBoundingClientRect 會是 0，直接畫會得到 0×0 畫布） */
    setTimeout(function () {
      if (!state.data) load({});
      else { draw(); }
    }, 0);
  }

  /** 重新載入（供外部「重新整理」按鈕呼叫） */
  function refresh() { load({ refresh: true }); }

  global.RrgTreemap = { enter: enter, refresh: refresh, draw: draw, state: state };
}(window));
