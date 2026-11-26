/* ===================================================
   共用工具與路由（載入順序：common.js → app.js → screen.js）

   為什麼要拆出這一支：
     app.js 是既有主檔（2200+ 行、19 個測試鎖定的 DOM 契約），
     直接往裡面加選股頁邏輯會讓回歸風險失控。
     這裡提供三頁共用的最小集合（格式化、API、路由、橫幅），
     新頁面（screen.js）只依賴這裡，不碰 app.js 的內部函式。
   =================================================== */
(function (global) {
  'use strict';

  var SA = {};

  /* ---------------- 格式化 ---------------- */
  SA.fmt = function (v, d) {
    if (v == null || !isFinite(v)) return '—';
    d = d == null ? 2 : d;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  SA.fmtInt = function (v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  };
  SA.pct = function (v, d) {
    if (v == null || !isFinite(v)) return '—';
    d = d == null ? 1 : d;
    return (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  };
  SA.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  SA.clsOf = function (v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat'; };

  /* ---------------- API ---------------- */
  /**
   * 與 app.js 的 api() 語意一致：HTTP 失敗或 {ok:false} 都轉成帶 code 的 Error，
   * 讓呼叫端能用同一套判斷處理「參數錯誤 / 限流 / 離線 / 上游失敗」。
   */
  SA.api = function (path, opts) {
    var startedOnline = navigator.onLine;
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok || (body && body.ok === false)) {
          var err = new Error(
            (body && body.error && body.error.message) || ('請求失敗（HTTP ' + res.status + '）')
          );
          err.code = body && body.error && body.error.code;
          err.hint = body && body.error && body.error.hint;
          err.status = res.status;
          throw err;
        }
        return body;
      });
    }).catch(function (err) {
      if (err && typeof err.status === 'undefined' && !err.code) {
        err.code = startedOnline ? 'NETWORK' : 'OFFLINE';
        err.network = true;
      }
      throw err;
    });
  };

  /** 把 Error 轉成給使用者看的 {title, message, hint, retryable} */
  SA.describeError = function (err) {
    var code = (err && err.code) || '';
    if (code === 'BAD_PARAMS' || code === 'BAD_RANGE') {
      return {
        title: '篩選條件有誤',
        message: err.message,
        hint: err.hint || '請依提示調整參數後重試。',
        kind: 'param',
      };
    }
    if (code === 'NOT_FOUND' || code === 'NO_DATA' || err.status === 404) {
      return { title: '查無資料', message: err.message, hint: err.hint || '請確認代碼或時間區間。', kind: 'empty' };
    }
    if (code === 'INSUFFICIENT_DATA' || err.status === 422) {
      return { title: '資料不足', message: err.message, hint: err.hint || '此標的歷史資料不足，無法可靠分析。', kind: 'empty' };
    }
    if (code === 'RATE_LIMITED' || err.status === 429) {
      return { title: '請求過於頻繁', message: '資料來源暫時限制存取頻率。', hint: '請稍候 10–30 秒後再試。', kind: 'retry' };
    }
    if (code === 'OFFLINE' || code === 'NETWORK' || err.network || !navigator.onLine) {
      return { title: '無法連線', message: '請求未能送達伺服器。', hint: '請確認網路狀態後重試。', kind: 'offline' };
    }
    return { title: '取得資料失敗', message: err.message || '伺服器暫時無法回應。', hint: err.hint || '請稍後再試一次。', kind: 'retry' };
  };

  /* ---------------- 橫幅 / 狀態 ---------------- */
  SA.setStatus = function (text, kind) {
    var t = document.getElementById('statusText');
    var d = document.getElementById('statusDot');
    if (t) t.textContent = text;
    if (d) d.className = 'dot' + (kind ? ' ' + kind : '');
  };

  SA.showBar = function (text, variant) {
    var bar = document.getElementById('offlineBar');
    if (!bar) return;
    var txt = document.getElementById('offlineText');
    if (txt) txt.textContent = text;
    bar.className = 'offline-bar' + (variant ? ' ' + variant : '');
    bar.hidden = false;
    var btn = document.getElementById('offlineRetry');
    if (btn) btn.hidden = true;
  };

  SA.hideBar = function () {
    var bar = document.getElementById('offlineBar');
    if (bar) bar.hidden = true;
  };

  /* ---------------- 路由 ---------------- */
  /**
   * 四頁路由，以 hash 表示，不打擾伺服器（靜態服務不需要 SPA fallback 規則）：
   *   #/predict         K 線預測（預設）
   *   #/screen          AI 選股
   *   #/macro           宏觀經濟儀表板（全市場，不帶代碼）
   *   #/macro/AAPL      個股財報與 AI 解讀
   *   #/detail/AAPL     個股詳情（沿用 K 線預測頁的完整分析區塊）
   *
   * 為什麼詳情頁不是獨立一份 DOM：
   *   完整分析（報價／買區／機率／K 線圖／技術位／回測／四模組）是一整套
   *   互相依賴的渲染邏輯。複製一份等於把 19 個測試鎖定的欄位也複製一份，
   *   兩邊遲早不同步。改為「同一份結果區塊、兩種進場模式」：
   *   詳情模式只是額外顯示返回列，內容完全相同。
   *
   * 為什麼宏觀頁要獨立一份 DOM：
   *   它的資料粒度是「全市場」（利率、FOMC、通膨），不隨個股變動。
   *   併進詳情頁會導致換一檔股票就重抓一次 FRED，且兩者的失敗模式
   *   完全不同（K 線逾時 vs SEC 逾時），混在一起會互相牽連。
   */
  var ROUTES = { predict: 'predict', screen: 'screen', macro: 'macro', detail: 'detail' };

  function parseHash() {
    var h = String(location.hash || '').replace(/^#\/?/, '');
    if (!h) return { name: 'predict', symbol: null };
    var parts = h.split('/').filter(Boolean);
    var head = parts[0];
    if (head === 'screen') return { name: 'screen', symbol: null };
    if (head === 'macro') {
      return { name: 'macro', symbol: parts[1] ? decodeURIComponent(parts[1]) : null };
    }
    if (head === 'detail') return { name: 'detail', symbol: parts[1] ? decodeURIComponent(parts[1]) : null };
    return { name: 'predict', symbol: null };
  }

  SA.currentRoute = parseHash;

  function setActiveNav(name) {
    var items = document.querySelectorAll('#mainNav [data-route]');
    Array.prototype.forEach.call(items, function (a) {
      var r = a.getAttribute('data-route');
      var on = (name === 'detail' ? 'detail' : name) === r;
      a.classList.toggle('active', on);
      if (r === 'detail') a.hidden = name !== 'detail';
    });
  }

  var handlers = { onPredict: null, onScreen: null, onMacro: null, onDetail: null };

  /** 由 app.js / screen.js / macro.js 註冊各自的進場處理 */
  SA.onRoute = function (map) {
    Object.keys(map || {}).forEach(function (k) {
      if (k in handlers) handlers[k] = map[k];
    });
  };

  SA.navigate = function (hash) {
    if (location.hash === hash) { dispatch(); return; }
    location.hash = hash;
  };

  function showView(name) {
    var chart = document.getElementById('viewChart');
    var screen = document.getElementById('viewScreen');
    var macro = document.getElementById('viewMacro');
    if (chart) chart.hidden = name !== 'chart';
    if (screen) screen.hidden = name !== 'screen';
    if (macro) macro.hidden = name !== 'macro';
  }

  var lastDispatched = '';

  function dispatch() {
    var r = parseHash();
    var view = r.name === 'screen' ? 'screen' : (r.name === 'macro' ? 'macro' : 'chart');
    showView(view);
    setActiveNav(r.name);
    var sig = r.name + '|' + (r.symbol || '');
    // 同一個 hash 重複觸發時不重跑（避免 hashchange 與手動呼叫互相重複請求）
    if (sig === lastDispatched) return;
    lastDispatched = sig;

    if (r.name === 'screen' && handlers.onScreen) handlers.onScreen();
    else if (r.name === 'macro' && handlers.onMacro) handlers.onMacro(r.symbol);
    else if (r.name === 'detail' && handlers.onDetail) handlers.onDetail(r.symbol);
    else if (r.name === 'predict' && handlers.onPredict) handlers.onPredict();
  }

  SA.dispatchRoute = dispatch;

  SA.startRouter = function () {
    window.addEventListener('hashchange', dispatch);
    dispatch();
  };

  /** 提供給「載入中」狀態的按鈕轉圈 */
  SA.setBusy = function (btn, busy, labelBusy, labelIdle) {
    if (!btn) return;
    btn.disabled = !!busy;
    var sp = btn.querySelector('.spinner');
    var lb = btn.querySelector('.btn-label');
    if (sp) sp.hidden = !busy;
    if (lb) lb.textContent = busy ? (labelBusy || '處理中…') : (labelIdle || '開始篩選');
  };

  global.SA = SA;
})(window);
