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
      body.innerHTML = '<tr><td colspan="12" class="tr-none">此狀態目前沒有記錄</td></tr>';
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
        + '</tr>'
      );
    });
    body.innerHTML = html.join('');
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
