/* ===================================================
   觀察清單 — 前端邏輯
   依賴：common.js（window.SA）。獨立一支，理由與 tracker.js 相同：
   它有自己的資料來源（/api/watchlist）與自己的失敗模式，
   不該為了共用錯誤處理而讓任一邊變差。

   為什麼「加入／移出」都在前端做樂觀更新：
     使用者在推介頁按「加入觀察」時，等一次往返才變色會讓人以為沒按到。
     因此先改畫面、再送請求；請求失敗才回滾並提示。
     但**不做**瀏覽器端快取：清單的真相在伺服器，重新載入一定重讀。
   =================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = SA.esc;

  var state = {
    loaded: false,
    loading: false,
    items: [],
    // 目前畫面上「哪些代碼已在觀察清單」——推介頁的按鈕狀態靠它
    set: {},
    busy: {},
  };

  function rebuildSet() {
    state.set = {};
    state.items.forEach(function (it) { state.set[it.symbol] = true; });
  }

  /* 通知其他視圖（目前是推介頁的按鈕）清單變了。
     一定要帶 detail：監聽方若只知道「有東西變了」，就得整份重抓或
     重新掃一遍 set，反而更容易不同步。帶上代碼與動作，
     監聽方可以只改那一顆按鈕，畫面不會整表閃一下。 */
  function announce(action, symbol) {
    document.dispatchEvent(new CustomEvent('watchlist:changed', {
      detail: { action: action, symbol: symbol || null, items: state.items.slice() },
    }));
  }

  function showError(msg, hint) {
    var box = $('wtError');
    if (!box) return;
    box.hidden = false;
    $('wtErrorMessage').textContent = msg || '無法取得觀察清單';
    $('wtErrorHint').textContent = hint || '請稍後重試。';
  }

  function hideError() {
    var box = $('wtError');
    if (box) box.hidden = true;
  }

  /* ==================== 載入 ==================== */
  function load(silent) {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    hideError();

    var loading = $('wtLoading');
    if (!silent && !state.items.length && loading) loading.hidden = false;

    return SA.api('/api/watchlist')
      .then(function (res) {
        state.items = res.items || [];
        state.loaded = true;
        rebuildSet();
        render();
        if (loading) loading.hidden = true;
        // 清單更新後，推介頁上「已加入」的按鈕狀態也要跟著對
        announce('reload', null);
      })
      .catch(function (err) {
        if (loading) loading.hidden = true;
        showError((err && err.message) || null, (err && err.hint) || null);
      })
      .then(function () { state.loading = false; });
  }

  /* ==================== 渲染 ==================== */
  function render() {
    var wrap = $('wtTableWrap');
    var empty = $('wtEmpty');
    var body = $('wtBody');
    if (!body) return;

    $('wtCount').textContent = state.items.length ? state.items.length + ' 檔' : '—';

    if (!state.items.length) {
      if (wrap) wrap.hidden = true;
      if (empty) empty.hidden = false;
      body.innerHTML = '';
      return;
    }
    if (empty) empty.hidden = true;
    if (wrap) wrap.hidden = false;

    var html = [];
    state.items.forEach(function (it) {
      var added = it.addedAt ? String(it.addedAt).slice(0, 10) : '—';
      // 來源：從哪一筆推介加進來的。沒有就顯示「手動加入」，不要留空白
      var src = it.fromPick
        ? '<span class="wt-src-pick">' + esc(it.fromPick) + '</span>'
        : '<span class="wt-src-manual">手動加入</span>';

      html.push(
        '<tr class="tr-row" data-symbol="' + esc(it.symbol) + '">'
        + '<td class="tr-sym">'
        + '<a class="tr-sym-code wt-link" href="#/detail/' + encodeURIComponent(it.symbol) + '">'
        + esc(it.symbol) + '</a>'
        + '<span class="tr-sym-name">' + esc(it.name || '') + '</span>'
        + '</td>'
        + '<td class="tr-date">' + esc(added) + '</td>'
        + '<td class="tr-src">' + src + '</td>'
        + '<td class="tr-ops">'
        + '<a class="tr-op tr-op-detail" href="#/detail/' + encodeURIComponent(it.symbol) + '">個股分析</a>'
        + '<button type="button" class="tr-op tr-op-remove" data-act="remove" data-symbol="'
        + esc(it.symbol) + '">移出觀察</button>'
        + '</td>'
        + '</tr>'
      );
    });
    body.innerHTML = html.join('');
  }

  /* ==================== 移出 ==================== */
  function remove(symbol, btn) {
    if (!symbol || state.busy[symbol]) return;
    state.busy[symbol] = true;
    if (btn) { btn.disabled = true; btn.textContent = '移除中…'; }

    SA.api('/api/watchlist?symbol=' + encodeURIComponent(symbol), { method: 'DELETE' })
      .then(function () {
        var idx = -1;
        for (var i = 0; i < state.items.length; i += 1) {
          if (state.items[i].symbol === symbol) { idx = i; break; }
        }
        if (idx >= 0) state.items.splice(idx, 1);
        rebuildSet();
        render();
        announce('remove', symbol);
      })
      .catch(function (err) {
        showError((err && err.message) || '移出失敗', (err && err.hint) || null);
        if (btn) { btn.disabled = false; btn.textContent = '移出觀察'; }
      })
      .then(function () { state.busy[symbol] = false; });
  }

  /* ==================== 加入（供推介頁呼叫） ==================== */
  /**
   * @param {object} rec 推介記錄（需 symbol；會一併帶 name/market/currency）
   * @returns {Promise<{ok:boolean, added:boolean}>}
   */
  function add(rec) {
    if (!rec || !rec.symbol) return Promise.resolve({ ok: false, added: false });
    var sym = String(rec.symbol).toUpperCase();
    // 與送出的內容用同一個推導：否則本地先補的那筆會顯示「手動加入」，
    // 重新載入後才變成推介 id——使用者會以為紀錄被改過。
    var fromPick = rec.id || (sym + '@' + (rec.pickDate || ''));

    return SA.api('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: sym,
        name: rec.name || null,
        market: rec.market || null,
        currency: rec.currency || null,
        fromPick: fromPick,
      }),
    }).then(function (res) {
      // 伺服器回什麼就以什麼為準：重複加入會回 added:false，
      // 那也是成功（清單裡已經有它了），按鈕應該顯示「已加入」。
      if (!state.set[sym]) {
        state.set[sym] = true;
        state.items.push({
          symbol: sym,
          name: rec.name || null,
          fromPick: (res && res.item && res.item.fromPick) || fromPick,
          addedAt: new Date().toISOString(),
        });
        if (state.loaded) render();
      }
      announce('add', sym);
      return { ok: true, added: !!(res && res.added) };
    });
  }

  function has(symbol) {
    return !!state.set[String(symbol || '').toUpperCase()];
  }

  /* ==================== 事件 ==================== */
  function bindEvents() {
    var body = $('wtBody');
    if (body && !body.dataset.bound) {
      body.dataset.bound = '1';
      body.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-act="remove"]') : null;
        if (!btn) return;
        e.preventDefault();
        remove(btn.getAttribute('data-symbol'), btn);
      });
    }
  }

  function init() {
    bindEvents();
    // 每次都重讀：清單可能在別的裝置／分頁被改過，
    // 用本地鏡像會讓使用者看到已經刪掉的股票。
    load(state.loaded);
  }

  SA.onRoute({
    onWatch: function () {
      init();
      SA.setStatus('觀察清單', 'ok');
    },
  });

  /* 對外：讓 tracker.js 能加入觀察，並查詢某檔是否已在清單 */
  SA.watchlist = {
    add: add,
    has: has,
    reload: function () { return load(true); },
    items: function () { return state.items.slice(); },
  };
})();
