/* ===================================================
   每日精選推介追蹤 — 前端邏輯
   依賴：common.js（window.SA）。獨立一支，不依賴 app.js / screen.js 的內部函式。

   為什麼要獨立一支而不是塞進 screen.js：
     選股頁回答「今天有哪些候選」，追蹤頁回答「過去推薦了什麼、現在怎麼樣」。
     兩者的資料來源、更新頻率、失敗處理都不同：選股失敗只要重試即可，
     追蹤頁失敗時若把已有帳本一起蓋掉，使用者會誤以為歷史記錄消失了。
     分開才不會為了共用一個錯誤處理而讓其中一邊變差。
   =================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var fmt = SA.fmt, esc = SA.esc;

  /** 觀察清單變動的監聽只綁一次（bindEvents 會在每次進頁面時被呼叫） */
  var watchSyncBound = false;

  var state = {
    loaded: false,
    loading: false,
    records: [],
    summary: null,
    labels: { pending: '待買入', holding: '持倉中', target_hit: '已止賺', stop_hit: '已止蝕' },
    order: ['pending', 'holding', 'target_hit', 'stop_hit'],
    filter: '',
    capitalUsd: 10000,
  };

  /* ==================== 金額與樣式 ==================== */
  /** 漲紅跌綠（本專案慣例，與美股相反） */
  function clsOfNum(v) {
    if (v == null || !isFinite(v) || v === 0) return '';
    return v > 0 ? 'v-pos' : 'v-neg';
  }

  /** 帶正負號的美元金額 */
  function fmtUsd(v) {
    if (v == null || !isFinite(v)) return '—';
    var sign = v > 0 ? '+' : (v < 0 ? '−' : '');
    return sign + 'US$' + fmt(Math.abs(v), 2);
  }

  function fmtPct(v) {
    if (v == null || !isFinite(v)) return '—';
    var sign = v > 0 ? '+' : (v < 0 ? '−' : '');
    return sign + fmt(Math.abs(v), 2) + '%';
  }

  /** 價格：港股與美股都用 2 位，低價股（<1）用 4 位以免看起來像整數 */
  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return '—';
    return Math.abs(v) < 1 ? fmt(v, 4) : fmt(v, 2);
  }

  function statusCls(s) {
    if (s === 'pending') return 'tr-badge tr-b-pending';
    if (s === 'holding') return 'tr-badge tr-b-holding';
    if (s === 'target_hit') return 'tr-badge tr-b-target';
    if (s === 'stop_hit') return 'tr-badge tr-b-stop';
    return 'tr-badge';
  }

  /* ==================== 渲染 ==================== */
  function renderSummary(sum) {
    if (!sum) return;
    var total = $('trTotalPnl');
    total.textContent = fmtUsd(sum.totalPnlUsd);
    total.className = 'tr-sum-v ' + clsOfNum(sum.totalPnlUsd);

    // 報酬率：沒有已結案交易時顯示「—」，不要顯示 0% 假裝打和
    var rp = $('trReturnPct');
    if (sum.realizedReturnPct == null) {
      rp.textContent = '尚無已結案交易';
      rp.className = 'tr-sum-sub';
    } else {
      rp.textContent = '已實現報酬 ' + fmtPct(sum.realizedReturnPct);
      rp.className = 'tr-sum-sub ' + clsOfNum(sum.realizedReturnPct);
    }

    var re = $('trRealized');
    re.textContent = fmtUsd(sum.realizedPnlUsd);
    re.className = 'tr-g-v ' + clsOfNum(sum.realizedPnlUsd);

    var un = $('trUnrealized');
    un.textContent = fmtUsd(sum.unrealizedPnlUsd);
    un.className = 'tr-g-v ' + clsOfNum(sum.unrealizedPnlUsd);

    var wr = $('trWinRate');
    wr.textContent = sum.winRate == null ? '—' : fmt(sum.winRate, 1) + '%';
    wr.className = 'tr-g-v';

    var ah = $('trAvgHold');
    ah.textContent = sum.avgHoldingDays == null ? '—' : fmt(sum.avgHoldingDays, 1) + ' 天';
    ah.className = 'tr-g-v';

    /**
     * 顯示「目前還壓在場上的本金」＝ openCostUsd，不是 deployedUsd。
     *
     * deployedUsd 是**已結案**交易的成本，它只是已實現報酬率的分母。
     * 這個格子原本寫 deployedUsd、標籤卻是「已投入成本」，於是
     * 在「有一筆 10,000 美元持倉、但還沒有任何交易結案」的情況下，
     * 摘要會出現「未實現 +556.53」卻同時顯示「已投入成本 US$0」——
     * 同一張卡片裡自相矛盾，而且是最容易被追問的那一格。
     *
     * 沒有持倉時退回 deployedUsd，讓「已全部結案」時仍看得到投入規模。
     */
    var costShown = (sum.openCostUsd || 0) > 0 ? sum.openCostUsd : (sum.deployedUsd || 0);
    $('trDeployed').textContent = 'US$' + fmt(costShown, 0);
    $('trCounts').textContent = (sum.counts.total || 0) + ' 筆'
      + (sum.counts.closed ? '（已結案 ' + sum.counts.closed + '）' : '');

    // 計數標籤
    var c = sum.counts || {};
    $('trN-all').textContent = c.total || 0;
    $('trN-pending').textContent = c.pending || 0;
    $('trN-holding').textContent = c.holding || 0;
    $('trN-target_hit').textContent = c.target_hit || 0;
    $('trN-stop_hit').textContent = c.stop_hit || 0;

    $('trSumNote').textContent = sum.note || '';
    state.capitalUsd = sum.capitalUsd || 10000;
    $('trCapitalHint').textContent = fmt(state.capitalUsd, 0);
  }

  function renderRows() {
    var body = $('trBody');
    var wrap = $('trTableWrap');
    var empty = $('trEmpty');
    if (!body) return;

    var rows = state.records;
    if (state.filter) {
      rows = rows.filter(function (r) { return r.status === state.filter; });
    }

    if (!state.records.length) {
      wrap.hidden = true;
      empty.hidden = false;
      $('trListBadge').textContent = '—';
      return;
    }
    empty.hidden = true;
    wrap.hidden = false;
    $('trListBadge').textContent = rows.length + ' 筆';

    if (!rows.length) {
      // colspan 必須等於實際欄數（含新增的「操作」欄共 13 欄）。
      // 少算會讓「此狀態沒有記錄」擠在第一欄，整列看起來歪掉。
      body.innerHTML = '<tr><td colspan="13" class="tr-none">此狀態目前沒有記錄</td></tr>';
      return;
    }

    var html = [];
    rows.forEach(function (r) {
      var label = state.labels[r.status] || r.status;
      // 現價／出場：已結案顯示出場價，持倉中顯示最後收盤（浮動）
      var pxCol = '—';
      var pxCls = '';
      if (r.exit && r.exit.price != null) {
        pxCol = fmtPrice(r.exit.price);
      } else if (r.pnl && r.pnl.markPrice != null) {
        pxCol = fmtPrice(r.pnl.markPrice);
      }

      var pnl = r.pnl ? r.pnl.amountUsd : null;
      var pnlTxt = pnl == null ? '—' : fmtUsd(pnl);
      // 未實現的損益加註「浮動」，避免與已實現混淆
      var pnlSub = '';
      if (pnl != null && r.settled === false) pnlSub = '<span class="tr-float">浮動</span>';

      var rp = r.pnl ? r.pnl.returnPct : null;
      var hold = '—';
      if (r.pnl && r.pnl.holdingDays != null) {
        // 「0 天」讀起來像算錯，但其實是「今天才建倉」。
        // 用文字表達比讓使用者自己推測好。
        hold = r.pnl.holdingDays === 0 ? '今日建倉' : r.pnl.holdingDays + ' 天';
      }

      // 建議買入：顯示區間，若成交了就以成交價為主
      var buyTxt = fmtPrice(r.buyLow) + '–' + fmtPrice(r.buyHigh);
      var buySub = r.entry && r.entry.price != null
        ? '<span class="tr-entry">成交 ' + fmtPrice(r.entry.price) + '</span>'
        : '';

      // 幣別提示：港股以港元計價，使用者必須知道損益已折算
      var curTag = r.currency && r.currency !== 'USD'
        ? '<span class="tr-cur">' + esc(r.currency) + '</span>' : '';

      /* 操作欄：加入觀察 + 個股分析。
         「個股分析」用 <a href="#/detail/…"> 而不是 onclick 導頁，
         這樣使用者可以右鍵「在新分頁開啟」、也可以複製連結分享——
         用 JS 導頁會把這兩件事一起弄丟。
         「加入觀察」依 r.watched（後端算好的）決定初始狀態，
         不靠前端猜，否則重新整理後按鈕會顯示錯的狀態。 */
      var watched = !!r.watched;
      /* 「推薦依據」按鈕：只有在真的有存到依據時才出現。
         舊記錄（這個功能上線前建立的）沒有 reasons/params，
         對它們顯示一顆按了只會看到「無資料」的按鈕是誤導。 */
      var hasBasis = (Array.isArray(r.reasons) && r.reasons.length)
        || (r.params && (r.params.rrRatio != null || (r.params.breakdown || []).length))
        || (r.newsAi && r.newsAi.summary);
      var ops = '<td class="tr-ops">'
        + '<a class="tr-op tr-op-detail" href="#/detail/' + encodeURIComponent(r.symbol) + '">個股分析</a>'
        + (hasBasis
          ? '<button type="button" class="tr-op tr-op-basis" data-act="basis" data-symbol="'
            + esc(r.symbol) + '" data-id="' + esc(r.id) + '" aria-expanded="false">推薦依據</button>'
          : '')
        + '<button type="button" class="tr-op tr-op-watch' + (watched ? ' is-on' : '') + '"'
        + ' data-act="watch" data-symbol="' + esc(r.symbol) + '"'
        + ' aria-pressed="' + (watched ? 'true' : 'false') + '">'
        + (watched ? '已加入觀察' : '加入觀察')
        + '</button>'
        + '</td>';

      html.push(
        '<tr class="tr-row" data-id="' + esc(r.id) + '">'
        + '<td class="tr-sym">'
        + '<span class="tr-sym-code">' + esc(r.symbol) + '</span>' + curTag
        + '<span class="tr-sym-name">' + esc(r.name || '') + '</span>'
        + '</td>'
        + '<td class="tr-date">' + esc(r.pickDate) + '</td>'
        + '<td class="num">' + buyTxt + buySub + '</td>'
        + '<td class="num tr-tp">' + fmtPrice(r.targetPrice) + '</td>'
        + '<td class="num tr-sl">' + fmtPrice(r.stopPrice) + '</td>'
        + '<td class="num">' + (r.entry && r.entry.price != null ? fmtPrice(r.entry.price) : '—') + '</td>'
        + '<td class="num">' + (r.entry && r.entry.shares != null ? fmt(r.entry.shares, 2) : '—') + '</td>'
        + '<td class="num">' + pxCol + '</td>'
        + '<td class="num ' + clsOfNum(pnl) + '">' + pnlTxt + pnlSub + '</td>'
        + '<td class="num ' + clsOfNum(rp) + '">' + (rp == null ? '—' : fmtPct(rp)) + '</td>'
        + '<td class="num">' + hold + '</td>'
        + '<td class="tr-state"><span class="' + statusCls(r.status) + '">' + esc(label) + '</span></td>'
        + ops
        + '</tr>'
        + '<tr class="tr-basis-row" data-basis-for="' + esc(r.id) + '" hidden>'
        + '<td colspan="13" class="tr-basis-cell"></td>'
        + '</tr>'
      );
    });
    body.innerHTML = html.join('');
    // 重繪後如果有展開過的列，把它的內容補回來（否則一按「更新現價」就收起來）
    if (expandedId) fillBasisRow(expandedId);
  }

  /* ==================== 推薦依據 ==================== */

  /** 目前展開的是哪一筆（重繪後要能還原） */
  var expandedId = null;

  function paramsTable(p) {
    if (!p) return '';
    var rows = [];
    function add(k, v, hint) {
      if (v == null || v === '') return;
      rows.push('<tr><th>' + esc(k) + '</th><td>' + esc(String(v))
        + (hint ? '<span class="tr-basis-hint">' + esc(hint) + '</span>' : '') + '</td></tr>');
    }
    add('盈虧比', p.rrRatio != null ? fmt(p.rrRatio, 2) : null, '潛在報酬 ÷ 風險，越高越值得做');
    add('距買區（ATR）', p.distAtr != null ? fmt(p.distAtr, 2) : null, '現價距買區上緣的波動倍數');
    add('波動（ATR%）', p.atrPct != null ? fmt(p.atrPct, 2) + '%' : null);
    add('平均成交量', p.avgVol != null ? fmt(p.avgVol, 0) : null);
    add('20 日勝率', p.winRate20 != null ? fmt(p.winRate20, 1) + '%' : null,
      p.samples ? '樣本 ' + p.samples + ' 次' : null);
    add('20 日上漲機率', p.probUp20 != null ? fmt(p.probUp20, 1) + '%' : null);
    add('獲利機率', p.probProfit != null ? fmt(p.probProfit, 1) + '%' : null);
    add('基準機率', p.baseRate20 != null ? fmt(p.baseRate20, 1) + '%' : null, '同期大盤的上漲機率');
    if (!rows.length) return '';
    return '<table class="tr-basis-params"><tbody>' + rows.join('') + '</tbody></table>';
  }

  function breakdownTable(list) {
    if (!Array.isArray(list) || !list.length) return '';
    var rows = list.map(function (d) {
      var s = d.s == null ? '—' : fmt(d.s, 1);
      var m = d.m == null ? '' : ' / ' + fmt(d.m, 1);
      var pct = (d.s != null && d.m) ? Math.max(0, Math.min(100, (d.s / d.m) * 100)) : 0;
      return '<tr><th>' + esc(d.l || d.k || '') + '</th>'
        + '<td class="num">' + esc(s + m) + '</td>'
        + '<td class="tr-basis-bar"><span style="width:' + pct.toFixed(0) + '%"></span></td></tr>';
    });
    return '<table class="tr-basis-breakdown"><tbody>' + rows.join('') + '</tbody></table>';
  }

  function newsBlock(n) {
    if (!n || !n.summary) return '';
    var senti = n.sentiment ? String(n.sentiment) : '';
    var sentiCls = /負|bear|neg/i.test(senti) ? 'is-bear' : (/正|bull|pos/i.test(senti) ? 'is-bull' : '');
    var head = (n.headlines || []).slice(0, 5).map(function (h) {
      return '<li>' + esc(h) + '</li>';
    }).join('');
    return '<div class="tr-basis-news">'
      + '<div class="tr-basis-news-head">推薦當時新聞 AI 摘要'
      + (senti ? '<span class="tr-basis-senti ' + sentiCls + '">' + esc(senti) + '</span>' : '')
      + (n.newsCount ? '<span class="tr-basis-hint">共 ' + n.newsCount + ' 則</span>' : '')
      + '</div>'
      + '<p class="tr-basis-news-sum">' + esc(n.summary) + '</p>'
      + (head ? '<ul class="tr-basis-news-list">' + head + '</ul>' : '')
      + '</div>';
  }

  function reasonsBlock(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return '<div class="tr-basis-reasons">' + list.map(function (p) {
      return '<div class="tr-basis-reason">'
        + (p.title ? '<h4>' + esc(p.title) + '</h4>' : '')
        + (p.body ? '<p>' + esc(p.body) + '</p>' : '')
        + '</div>';
    }).join('') + '</div>';
  }

  /** 把某一筆的依據內容填進它那一列（含 K 線圖） */
  function fillBasisRow(id) {
    var row = $('trBody').querySelector('[data-basis-for="' + String(id).replace(/"/g, '\\"') + '"]');
    if (!row) return;
    var cell = row.querySelector('.tr-basis-cell');
    if (!cell) return;
    var rec = null;
    for (var i = 0; i < state.records.length; i += 1) {
      if (state.records[i].id === id) { rec = state.records[i]; break; }
    }
    if (!rec) return;

    var sym = rec.symbol;
    var legend = ['P 推介 ' + (rec.pickDate || '—')];
    if (rec.entry && rec.entry.date) legend.push('B 進場 ' + rec.entry.date);
    if (rec.exit && rec.exit.date) {
      legend.push('X ' + (rec.status === 'target_hit' ? '止賺' : '止蝕') + ' ' + rec.exit.date);
    }

    /* 注意：這裡的條件必須用括號包起來。
       `'x' + cond ? a : b` 會被解析成 `('x' + cond) ? a : b`——
       字串永遠為真，於是永遠走 a，而且最後的 </div> 會被吞掉。 */
    var emptyNote = (!rec.reasons || !rec.reasons.length) && !rec.newsAi
      ? '<p class="tr-basis-hint">這一筆沒有存到推薦依據（可能是功能上線前的舊記錄）。</p>'
      : '';

    cell.innerHTML = '<div class="tr-basis">'
      + '<div class="tr-basis-chart">'
      + '<img class="tr-basis-img" alt="' + esc(sym) + ' K 線圖（含推介與出場標記）"'
      + ' src="/api/tracker/chart.png?symbol=' + encodeURIComponent(sym) + '&t=' + Date.now() + '">'
      + '<div class="tr-basis-legend">' + esc(legend.join('　')) + '</div>'
      + '</div>'
      + '<div class="tr-basis-info">'
      + reasonsBlock(rec.reasons)
      + paramsTable(rec.params)
      + breakdownTable(rec.params && rec.params.breakdown)
      + newsBlock(rec.newsAi)
      + emptyNote
      + '</div>'
      + '</div>';
  }

  function toggleBasis(btn) {
    var id = btn.getAttribute('data-id');
    var row = $('trBody').querySelector('[data-basis-for="' + String(id).replace(/"/g, '\\"') + '"]');
    if (!row) return;
    var open = row.hidden;
    // 一次只開一筆：同時展開多筆會讓表格長到看不出自己在看哪一行
    var all = $('trBody').querySelectorAll('.tr-basis-row');
    for (var i = 0; i < all.length; i += 1) all[i].hidden = true;
    var allBtns = $('trBody').querySelectorAll('[data-act="basis"]');
    for (var j = 0; j < allBtns.length; j += 1) allBtns[j].setAttribute('aria-expanded', 'false');

    if (open) {
      fillBasisRow(id);
      row.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      expandedId = id;
    } else {
      expandedId = null;
    }
  }

  function renderFilterNote(res) {
    var note = $('trFilterNote');
    if (!note) return;
    var u = res.updated || {};
    var parts = [];
    if (u.ran) {
      parts.push('剛剛已更新：檢查 ' + (u.checked || 0) + ' 筆，狀態變更 ' + (u.updated || 0) + ' 筆');
      if (u.added) parts.push('新增 ' + u.added + ' 筆推介');
      if (u.failed) parts.push(u.failed + ' 筆取價失敗');
    } else if (u.reason) {
      // 節流是正常行為，用中性語氣說明，不要讓使用者以為出錯
      parts.push(u.reason);
    }
    var sch = res.schedule || {};
    if (sch.throttleMinutes) {
      parts.push('每日收錄 ' + (sch.dailyLimit || 5) + ' 檔，' + sch.throttleMinutes + ' 分鐘內重複開啟直接讀取既有資料');
    }
    note.textContent = parts.join('；');
  }

  function renderUpdatedAt(res) {
    var el = $('trUpdatedAt');
    if (!el) return;
    var u = res.updated || {};
    if (u.ran && u.lastRunAt) {
      el.textContent = '剛剛更新';
      el.className = 'badge high';
    } else if (state.records.length) {
      el.textContent = '資料已載入';
      el.className = 'badge badge-neutral';
    } else {
      el.textContent = '—';
      el.className = 'badge badge-neutral';
    }
  }

  function showError(err) {
    var box = $('trError');
    box.hidden = false;
    $('trErrorMessage').textContent = (err && err.message) || '無法取得推介記錄';
    $('trErrorHint').textContent = (err && err.hint) || '請稍後重試，或按下方按鈕重新載入。';
    var acts = $('trErrorActions');
    acts.innerHTML = '';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-btn';
    btn.textContent = '重新載入';
    btn.onclick = function () { box.hidden = true; load({ force: false }); };
    acts.appendChild(btn);
  }

  function hideError() {
    var box = $('trError');
    if (box) box.hidden = true;
  }

  /* ==================== 載入 ==================== */
  /**
   * @param {object} o { force: 是否要求伺服器立即更新（會打上游取價） }
   */
  function load(o) {
    if (state.loading) return;
    state.loading = true;
    hideError();

    var loading = $('trLoading');
    var tableWrap = $('trTableWrap');
    // 已有資料時不顯示骨架，避免畫面閃動
    var showSkeleton = !state.records.length;
    if (showSkeleton && loading) {
      loading.hidden = false;
      if (tableWrap) tableWrap.hidden = true;
    }
    $('trLoadingText').textContent = o && o.force
      ? '正在取得最新價格並更新狀態…' : '正在載入推介記錄…';

    var btn = $('trRefresh');
    if (btn) SA.setBusy(btn, true, '更新中…', '更新現價');
    var boot = $('trBootBtn');
    if (boot) SA.setBusy(boot, true, '建立中…', '立即建立今日推介');

    var url = '/api/tracker';
    if (o && o.force) url += '?run=1';

    SA.api(url)
      .then(function (res) {
        state.records = res.records || [];
        state.summary = res.summary || null;
        if (res.statusLabel) state.labels = res.statusLabel;
        if (res.statusOrder) state.order = res.statusOrder;
        state.loaded = true;

        if (loading) loading.hidden = true;
        renderSummary(state.summary);
        renderRows();
        renderFilterNote(res);
        renderUpdatedAt(res);

        if (res.recovered) {
          // 帳本損壞是重大事件，必須讓使用者知道歷史記錄可能不完整
          showError({
            message: '帳本檔案曾損壞，已備份並重建',
            hint: '原因：' + (res.recovered.reason || '未知')
              + (res.recovered.backup ? '；備份位於 ' + res.recovered.backup : ''),
          });
        }
      })
      .catch(function (err) {
        if (loading) loading.hidden = true;
        // 保留既有資料：錯誤不該讓已經看到的記錄消失
        if (state.records.length) {
          renderRows();
        }
        showError(err);
      })
      .then(function () {
        state.loading = false;
        if (btn) SA.setBusy(btn, false, '更新中…', '更新現價');
        if (boot) SA.setBusy(boot, false, '建立中…', '立即建立今日推介');
      });
  }

  /* ==================== 事件 ==================== */
  function bindEvents() {
    var tabs = document.querySelectorAll('.tr-st-tab');
    Array.prototype.forEach.call(tabs, function (t) {
      t.onclick = function () {
        Array.prototype.forEach.call(tabs, function (x) {
          x.classList.remove('is-active');
          x.setAttribute('aria-selected', 'false');
        });
        t.classList.add('is-active');
        t.setAttribute('aria-selected', 'true');
        state.filter = t.getAttribute('data-status') || '';
        renderRows();
      };
    });

    var refresh = $('trRefresh');
    if (refresh) {
      refresh.onclick = function () { load({ force: true }); };
    }

    var boot = $('trBootBtn');
    if (boot) {
      boot.onclick = function () { load({ force: true }); };
    }

    /* 表格內的「加入觀察」用事件委派，不要逐列綁 onclick：
       表格每次重繪都換掉整批 DOM，逐列綁會綁到已經被丟棄的節點上
       （症狀：按了沒反應，而且沒有任何錯誤）。 */
    var body = $('trBody');
    if (body && !body.dataset.watchBound) {
      body.dataset.watchBound = '1';
      body.addEventListener('click', function (e) {
        var basis = e.target.closest ? e.target.closest('[data-act="basis"]') : null;
        if (basis) {
          e.preventDefault();
          toggleBasis(basis);
          return;
        }
        var btn = e.target.closest ? e.target.closest('[data-act="watch"]') : null;
        if (!btn) return;
        e.preventDefault();
        addToWatch(btn.getAttribute('data-symbol'), btn);
      });
    }

    /* 清單在別的視圖（觀察清單頁）被改動後，這裡的按鈕要跟著改。
       少了這段，使用者在觀察清單按「移出觀察」再回到推介頁，
       按鈕還是寫著「已加入觀察」——按下去只會被導去觀察清單，
       而他以為那檔還在清單裡。
       只更新相關那一列，不整表重繪：整表重繪會讓捲動位置跳掉。 */
    if (!watchSyncBound) {
      watchSyncBound = true;
      document.addEventListener('watchlist:changed', function (ev) {
        var d = (ev && ev.detail) || {};
        var box = $('trBody');
        if (!box) return;
        var items = d.items || null;
        // 整份清單有變動（例如剛載入完）：對所有按鈕重新對帳
        var targets;
        if (!d.symbol) {
          targets = [].slice.call(box.querySelectorAll('[data-act="watch"]'));
          if (!targets.length) return;
        } else {
          var one = box.querySelector('[data-act="watch"][data-symbol="' + String(d.symbol).replace(/"/g, '\\"') + '"]');
          targets = one ? [one] : [];
        }
        targets.forEach(function (btn) {
          var sym = String(btn.getAttribute('data-symbol') || '').toUpperCase();
          // 有帶清單就以清單為準；沒帶才退回模組內已知的狀態
          var inList = items
            ? items.some(function (x) { return String(x.symbol || '').toUpperCase() === sym; })
            : (SA.watchlist && SA.watchlist.has(sym));
          btn.classList.toggle('is-on', !!inList);
          btn.setAttribute('aria-pressed', inList ? 'true' : 'false');
          btn.textContent = inList ? '已加入觀察' : '加入觀察';
          btn.disabled = false;
          for (var i = 0; i < state.records.length; i += 1) {
            if (String(state.records[i].symbol || '').toUpperCase() === sym) {
              state.records[i].watched = !!inList;
              break;
            }
          }
        });
      });
    }
  }

  /** 把某一筆推介加入觀察清單（樂觀更新：先改按鈕，失敗再回滾） */
  function addToWatch(symbol, btn) {
    if (!symbol) return;
    if (btn.classList.contains('is-on')) {
      // 已加入：導到觀察清單頁，讓使用者能在那裡管理（含移出）。
      // 不在這裡做「再按一次就移除」——誤觸的代價不對稱：
      // 誤加只是多一筆，誤刪可能讓他以為股票不見了。
      SA.navigate('#/watch');
      return;
    }
    if (!SA.watchlist) return;

    var rec = null;
    for (var i = 0; i < state.records.length; i += 1) {
      if (state.records[i].symbol === symbol) { rec = state.records[i]; break; }
    }
    if (!rec) return;

    btn.disabled = true;
    btn.textContent = '加入中…';

    SA.watchlist.add(rec).then(function () {
      btn.classList.add('is-on');
      btn.setAttribute('aria-pressed', 'true');
      btn.textContent = '已加入觀察';
      btn.disabled = false;
      rec.watched = true;
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = '加入觀察';
      showError({
        message: (err && err.message) || '加入觀察失敗',
        hint: (err && err.hint) || '請稍後重試。',
      });
    });
  }

  function init() {
    bindEvents();
    if (!state.loaded) {
      load({ force: false });
    } else {
      // 再次進入頁面時只重繪，不重打一次上游；使用者要最新資料可按「更新現價」
      renderSummary(state.summary);
      renderRows();
    }
  }

  SA.onRoute({
    onTracker: function () {
      init();
      SA.setStatus('推介追蹤', 'ok');
    },
  });
})();
