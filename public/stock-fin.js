/* ===================================================
   個股財報（個股模塊）

   為什麼從「宏觀」搬到「個股」：
     財報的資料粒度是「一家公司」，會隨股票代碼變動；宏觀頁的
     粒度是「全市場」（利率、通膨、FOMC），不隨個股變動。
     把個股財報放在宏觀頁會造成兩個問題：
       1. 使用者在宏觀頁輸入代碼後，整頁（含 FOMC、資料限制、
          AI 解讀）都被換成單一公司的內容，宏觀資料形同被覆蓋掉。
       2. 換一檔股票就要重打一次完整路由，而個股詳情頁本來就
          已經有代碼在手，沒有任何理由再輸入一次。
     因此改為：財報跟著個股走，在 #/detail/:symbol 的結果區塊內
     以一張獨立卡片呈現；宏觀頁回歸純全市場儀表板。

   語言限制：全檔 ES5（var / function），與全站既有前端一致。
   =================================================== */
(function (global) {
  'use strict';

  var SA = global.SA || {};
  var doc = global.document;

  function $(id) { return doc.getElementById(id); }
  function esc(s) { return (SA.esc || function (x) { return String(x == null ? '' : x); })(s); }
  function fmt(v, d) { return (SA.fmt || function (x) { return x; })(v, d); }

  /** 大額美元轉 B/M 顯示（與財報數字量級相符） */
  function fmtUsd(v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    return fmt(v, 0);
  }

  function fmtPct(v, d) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(d == null ? 2 : d) + '%';
  }

  var state = { symbol: null, loading: false, seq: 0 };

  /**
   * 載入並渲染某檔股票的財報。
   * @param {string} symbol
   * @param {object} [opts] { refresh }
   */
  function load(symbol, opts) {
    var o = opts || {};
    var card = $('stockFinCard');
    if (!card || !symbol) return;

    // 競態防護：快速切換股票時，舊請求可能晚回來蓋掉新內容
    var seq = ++state.seq;
    state.symbol = symbol;
    state.loading = true;

    showLoading(true);
    showEmpty(null);
    var body = $('stockFinBody');
    if (body) body.hidden = true;

    var q = '/api/macro/' + encodeURIComponent(symbol);
    if (o.refresh) q += '?refresh=1';

    SA.api(q).then(function (d) {
      if (seq !== state.seq) return;
      state.loading = false;
      showLoading(false);
      render(d);
    }).catch(function (err) {
      if (seq !== state.seq) return;
      state.loading = false;
      showLoading(false);
      var info = SA.describeError ? SA.describeError(err)
        : { title: '載入失敗', message: err.message };
      showEmpty({
        title: '財報載入失敗',
        msg: info.message + (info.hint ? ' ' + info.hint : ''),
      });
    });
  }

  function showLoading(on) {
    var el = $('stockFinLoading');
    if (el) el.hidden = !on;
  }

  function showEmpty(info) {
    var box = $('stockFinEmpty');
    if (!box) return;
    if (!info) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'stock-fin-empty';
    var t = $('stockFinEmptyTitle');
    var m = $('stockFinEmptyMsg');
    if (t) t.textContent = info.title || '無財報資料';
    if (m) m.textContent = info.msg || '';
  }

  function badge(text, cls) {
    var b = $('stockFinBadge');
    if (!b) return;
    b.textContent = text || '—';
    b.className = 'badge ' + (cls || 'badge-neutral');
  }

  function render(d) {
    var body = $('stockFinBody');
    if (!body || !d) return;

    var fund = d.fundamentals || {};
    var ok = !!fund.available;

    body.hidden = false;
    badge(ok ? (fund.entityName ? 'SEC EDGAR' : '已取得') : '無資料',
      ok ? 'badge-neutral' : 'badge-warn');

    // 標題：有公司名就用公司名，否則用代碼
    var title = $('stockFinTitle');
    if (title) {
      title.textContent = '個股財報'
        + (fund.entityName ? '　' + fund.entityName : '')
        + (d.symbol ? '（' + d.symbol + '）' : '');
    }

    var sub = $('stockFinSub');
    if (sub) {
      sub.textContent = ok
        ? '來源：SEC EDGAR XBRL（美股）　·　宏觀背景：FRED'
        : '此標的可能無 SEC 財報（例如港股），或該公司未申報 XBRL。';
    }

    renderTable(fund, d.macroBackdrop);
    renderMeta(fund, d);

    // 不可用時給明確原因，不要留一張空表
    if (!ok) {
      showEmpty({
        title: '無財報資料',
        msg: (fund.reason || '此標的無 SEC 財報')
          + (fund.hint ? '　' + fund.hint : ''),
      });
    } else {
      showEmpty(null);
    }
  }

  function renderTable(fund, backdrop) {
    var tbody = $('stockFinTableBody');
    if (!tbody) return;

    if (!fund || !fund.available) {
      tbody.innerHTML = '<tr><td colspan="5" class="mt-empty">'
        + esc((fund && fund.reason) || '無財報資料') + '</td></tr>';
      return;
    }

    var m = fund.metrics || {};
    var rows = [];

    function row(label, def, value, unit, asOf, source) {
      rows.push({ label: label, def: def, value: value, unit: unit, asOf: asOf, source: source });
    }

    if (m.revenue) {
      row('營收（' + m.revenue.basis + '）',
        m.revenue.method || '來自 SEC XBRL 損益表',
        fmtUsd(m.revenue.value), 'USD', m.revenue.to, 'SEC EDGAR');
    }
    if (m.revenue && m.revenue.yoy != null) {
      row('營收年增率', '與去年同期比較（同基期口徑）',
        fmtPct(m.revenue.yoy), '%', m.revenue.to, 'SEC EDGAR');
    }
    if (m.netIncome) {
      row('淨利（' + m.netIncome.basis + '）', '扣除所有費用與稅後',
        fmtUsd(m.netIncome.value), 'USD', m.netIncome.to, 'SEC EDGAR');
    }
    if (m.grossMargin != null) {
      row('毛利率', '（營收 − 營業成本）/ 營收', fmt(m.grossMargin), '%', fund.asOf, 'SEC EDGAR');
    }
    if (m.operatingMargin != null) {
      row('營業利益率', '營業利益 / 營收', fmt(m.operatingMargin), '%', fund.asOf, 'SEC EDGAR');
    }
    if (m.netMargin != null) {
      row('淨利率', '淨利 / 營收', fmt(m.netMargin), '%', fund.asOf, 'SEC EDGAR');
    }
    if (m.epsDiluted) {
      row('稀釋 EPS', '計入潛在稀釋效果', fmt(m.epsDiluted.value), 'USD/share',
        m.epsDiluted.to, 'SEC EDGAR');
    }
    if (m.roe != null) {
      row('ROE', m.roeNote ? '淨利 / 股東權益（注意：權益偏小會使比率偏高）' : '淨利 / 股東權益',
        fmt(m.roe), '%', fund.balance && fund.balance.equity ? fund.balance.equity.asOf : fund.asOf,
        'SEC EDGAR');
    }
    if (m.debtRatio != null) {
      row('負債比', '總負債 / 總資產', fmt(m.debtRatio), '%', fund.asOf, 'SEC EDGAR');
    }
    if (m.peRatio != null) {
      row('本益比', m.peNote || '股價 / 近四季 EPS',
        fmt(m.peRatio), 'x', fund.asOf, 'SEC EDGAR + 即時報價');
    }

    // 宏觀背景：只放與個股評價直接相關的三項，不做成第二份宏觀儀表板
    if (backdrop) {
      if (backdrop.fedTargetUpper) {
        row('政策利率上限（背景）', 'FOMC 目標區間上緣',
          fmt(backdrop.fedTargetUpper.value), '%', backdrop.fedTargetUpper.asOf, 'FRED');
      }
      if (backdrop.dgs10) {
        row('10 年期殖利率（背景）', '市場交易結果，非政策利率',
          fmt(backdrop.dgs10.value), '%', backdrop.dgs10.asOf, 'FRED');
      }
      if (backdrop.termSpread) {
        row('10Y-2Y 利差（背景）', '負值代表殖利率倒掛',
          fmt(backdrop.termSpread.value), '%', backdrop.termSpread.asOf, 'FRED');
      }
    }

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="mt-empty">此標的無可顯示的財務欄位</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (r) {
      return '<tr>'
        + '<td><div class="mt-name">' + esc(r.label) + '</div>'
        + '<div class="mt-def">' + esc(r.def) + '</div></td>'
        + '<td class="ta-r mt-val">' + esc(r.value) + '</td>'
        + '<td class="mt-unit">' + esc(r.unit) + '</td>'
        + '<td class="mt-date">' + esc(r.asOf || '—') + '</td>'
        + '<td class="mt-src">' + esc(r.source || '—') + '</td>'
        + '</tr>';
    }).join('');
  }

  /** 頁腳：來源、時間、缺口 */
  function renderMeta(fund, d) {
    var box = $('stockFinMeta');
    if (!box) return;
    var bits = [];

    var asOf = fund && fund.asOf;
    if (asOf) bits.push('<span class="stock-fin-meta-item"><b>財報期間</b>' + esc(asOf) + '</span>');
    if (d && d.symbol) bits.push('<span class="stock-fin-meta-item"><b>代碼</b>' + esc(d.symbol) + '</span>');
    if (d && d.generatedAt) {
      bits.push('<span class="stock-fin-meta-item"><b>產生時間</b>' + esc(shortTime(d.generatedAt)) + '</span>');
    }
    if (fund && fund.gaps && fund.gaps.length) {
      bits.push('<span class="stock-fin-meta-item"><b>資料缺口</b>' + esc(fund.gaps.join('、')) + '</span>');
    }

    box.innerHTML = bits.join('');
    box.hidden = !bits.length;
  }

  function shortTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '—';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 進場：由 app.js 在個股分析成功後呼叫 */
  function onStock(symbol) {
    if (!symbol) {
      clear();
      return;
    }
    // 同一檔不重抓
    if (state.symbol && state.symbol.toUpperCase() === String(symbol).toUpperCase()
      && !state.loading && $('stockFinBody') && !$('stockFinBody').hidden) {
      return;
    }
    load(symbol);
  }

  function clear() {
    var card = $('stockFinCard');
    if (card) card.hidden = true;
    state.symbol = null;
    state.seq++;
  }

  function bind() {
    var card = $('stockFinCard');
    if (card) card.hidden = false;

    var btn = $('stockFinRefresh');
    if (btn && !btn.__bound) {
      btn.__bound = true;
      btn.addEventListener('click', function () {
        if (state.symbol) load(state.symbol, { refresh: true });
      });
    }
  }

  global.StockFin = {
    load: load,
    onStock: onStock,
    clear: clear,
    bind: bind,
    state: state,
    fmtUsd: fmtUsd,
  };
})(window);
