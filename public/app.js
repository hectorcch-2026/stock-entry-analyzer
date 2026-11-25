/* ===================================================
   買入位與技術位分析系統 — 前端應用
   零外部依賴：搜尋自動完成、Canvas K 線圖、響應式渲染
   =================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    data: null,
    overlays: { ma: true, levels: true, vp: true, fvg: true, boll: false, vol: false },
    hoverIndex: null,
    chartGeom: null,
    suggestTimer: null,
    suggestIndex: -1,
    suggestItems: [],
    /**
     * 時間區間切換的額外序列。
     *
     * null 表示「用 /api/analyze 附帶的 250 根」（預設，與既有行為完全一致）。
     * 只有使用者主動切到 2y/5y 時才會去 /api/kline 取更長的歷史，
     * 因此預設路徑不會多一次請求，也不會動到 AC-01 鎖定的 250 根契約。
     */
    kline: null,
    klineRange: null,
    klineLoading: false,
    /**
     * 視窗（縮放 / 平移）。
     *
     * start 是「可見區間在完整序列中的起始索引」，count 是可見根數。
     * count 為 null 表示顯示全部。預設全部 → 與舊行為逐位元相同。
     */
    view: { start: 0, count: null },
  };

  /* ==================== 工具 ==================== */
  function fmt(v, d) {
    if (v == null || !isFinite(v)) return '—';
    d = d == null ? 2 : d;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtInt(v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }
  function pct(v, d) {
    if (v == null || !isFinite(v)) return '—';
    d = d == null ? 1 : d;
    return (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clsOf(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat'; }

  function setStatus(text, kind) {
    $('statusText').textContent = text;
    var d = $('statusDot');
    d.className = 'dot' + (kind ? ' ' + kind : '');
  }

  /* ==================== PWA：Service Worker 註冊 ==================== */
  var swReg = null;

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Service Worker 僅在安全來源可用（HTTPS 或 localhost）；
    // 以私有 IP（192.168.x.x）透過 http 存取時會被瀏覽器拒絕，屬正常現象。
    if (!window.isSecureContext) {
      console.info('[PWA] 非安全來源（需 HTTPS 或 localhost），Service Worker 未註冊。離線與加入主畫面功能不可用。');
      return;
    }

    navigator.serviceWorker.register('/sw.js').then(function (reg) {
      swReg = reg;
      // 偵測到新版 Service Worker 時提示使用者
      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showOfflineBar('有新版本可用，重新載入以更新。', 'cached', '重新載入', function () {
              sw.postMessage({ type: 'SKIP_WAITING' });
              location.reload();
            });
          }
        });
      });
    }).catch(function (e) {
      console.warn('[PWA] Service Worker 註冊失敗：', e.message);
    });
  }

  /* ==================== 離線 / 快取狀態橫幅 ==================== */
  function showOfflineBar(text, variant, actionLabel, onAction) {
    var bar = $('offlineBar');
    if (!bar) return;
    bar.hidden = false;
    bar.className = 'offline-bar' + (variant ? ' ' + variant : '');
    $('offlineText').textContent = text;
    var btn = $('offlineRetry');
    if (actionLabel) {
      btn.hidden = false;
      btn.textContent = actionLabel;
      btn.onclick = onAction;
    } else {
      btn.hidden = true;
      btn.onclick = null;
    }
  }

  function hideOfflineBar() {
    var bar = $('offlineBar');
    if (bar) bar.hidden = true;
  }

  function bindConnectionState() {
    window.addEventListener('online', function () {
      hideOfflineBar();
      setStatus('就緒', 'ok');
    });
    window.addEventListener('offline', function () {
      showOfflineBar('目前離線，介面可瀏覽但無法取得即時行情。恢復連線後將自動更新。', '', null, null);
      setStatus('離線', 'err');
    });
    if (!navigator.onLine) {
      showOfflineBar('目前離線，介面可瀏覽但無法取得即時行情。恢復連線後將自動更新。', '', null, null);
      setStatus('離線', 'err');
    }
  }

  /* ==================== iOS 加入主畫面引導 ==================== */
  var IOS_TIP_KEY = 'entry-analyzer-ios-tip-dismissed';

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS 13+
  }

  function isStandalone() {
    return window.navigator.standalone === true
      || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function maybeShowIOSTip() {
    if (!isIOS() || isStandalone()) return;
    var ua = navigator.userAgent;
    // 只有 Safari 才有「加入主畫面」；Chrome / Firefox on iOS 沒有此選項
    var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    if (!isSafari) return;
    try { if (localStorage.getItem(IOS_TIP_KEY)) return; } catch (e) { /* 無痕模式 */ }

    var tip = $('iosInstallTip');
    if (!tip) return;
    // 延遲顯示，避免一進站就干擾
    setTimeout(function () { tip.hidden = false; }, 2500);

    var close = $('iosTipClose');
    if (close) {
      close.addEventListener('click', function () {
        tip.hidden = true;
        try { localStorage.setItem(IOS_TIP_KEY, '1'); } catch (e) {}
      });
    }
  }

  /* ==================== 資料新鮮度 ==================== */
  /**
   * 檢查回應標頭中的快取標記。
   * Service Worker 在「網路失敗、改用快取」時會加上 X-From-Cache 與 X-Cache-Age；
   * 在離線回退 shell 時會加上 X-Offline。據此明確告知使用者資料可能過時。
   *
   * 注意：只有在「回應成功且非離線來源」時才收起提示。
   * 若回應本身是離線錯誤（如 503 OFFLINE），必須保留提示，
   * 否則會在顯示後立刻被這裡蓋掉。
   */
  function noteCacheHeaders(res) {
    if (!res || !res.headers) return null;
    var fromCache = res.headers.get('X-From-Cache');
    var ageSec = Number(res.headers.get('X-Cache-Age') || 0);
    var offline = res.headers.get('X-Offline');
    if (offline) {
      showOfflineBar('目前離線，顯示的是裝置上的介面快取。恢復連線後可取得即時行情。', 'cached', '重新載入', function () { location.reload(); });
      return { offline: true };
    }
    if (fromCache) {
      var mins = Math.max(1, Math.round(ageSec / 60));
      showOfflineBar('無法連線，以下為約 ' + mins + ' 分鐘前的快取資料，可能已偏離現價，請謹慎判讀。', 'stale', '重試', function () { analyze(); });
      return { fromCache: true, ageSec: ageSec };
    }
    // 僅在成功回應時收起提示，避免蓋掉離線狀態
    if (res.ok) hideOfflineBar();
    return null;
  }

  /* ==================== API ==================== */
  function api(path, opts) {
    var startedOnline = navigator.onLine;
    return fetch(path, opts).then(function (res) {
      // 先讀取快取相關標頭，決定是否要提示資料新鮮度
      noteCacheHeaders(res);
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
      // 網路層失敗（fetch 直接被拒）不會帶 status，統一標記為 NETWORK，
      // 讓上層能據此顯示離線橫幅，而不是只丟一句含糊的錯誤。
      if (err && typeof err.status === 'undefined' && !err.code) {
        err.code = startedOnline ? 'NETWORK' : 'OFFLINE';
        err.network = true;
      }
      throw err;
    });
  }

  /* ==================== 輸入驗證 ==================== */
  var HK_RE = /^\d{1,5}$/;
  var US_RE = /^[A-Za-z][A-Za-z.\-]{0,9}$/;
  var HKFULL_RE = /^\d{3,5}\.HK$/i;
  var CN_RE = /[\u4e00-\u9fff]/;

  /** 即時驗證：回傳 {valid, level, message} */
  function validateInput(raw) {
    var v = (raw || '').trim();
    if (!v) return { valid: false, level: 'empty', message: '' };
    if (v.length > 24) return { valid: false, level: 'error', message: '輸入過長，請輸入 24 個字元以內' };
    if (CN_RE.test(v)) {
      return v.length >= 2
        ? { valid: true, level: 'ok', message: '將以名稱搜尋' }
        : { valid: false, level: 'warn', message: '名稱至少需要 2 個字' };
    }
    if (HK_RE.test(v)) {
      if (v.length > 5) return { valid: false, level: 'error', message: '港股代碼為 1-5 位數字' };
      var pad = v.length <= 4 ? v.padStart(4, '0') : v;
      return { valid: true, level: 'ok', message: '識別為港股，將查詢 ' + pad + '.HK' };
    }
    if (HKFULL_RE.test(v)) return { valid: true, level: 'ok', message: '識別為港股代碼' };
    if (US_RE.test(v)) return { valid: true, level: 'ok', message: '識別為美股代碼' };
    return { valid: false, level: 'error', message: '格式無法辨識，請輸入代碼（AAPL / 0700）或名稱' };
  }

  /* ==================== 自動完成 ==================== */
  function hideSuggestions() {
    var ul = $('suggestions');
    ul.hidden = true;
    ul.innerHTML = '';
    state.suggestIndex = -1;
    state.suggestItems = [];
  }

  function renderSuggestions(items, q) {
    var ul = $('suggestions');
    state.suggestItems = items;
    state.suggestIndex = -1;
    if (!items.length) { hideSuggestions(); return; }

    ul.innerHTML = items.map(function (it, i) {
      return '<li role="option" data-idx="' + i + '" aria-selected="false">'
        + '<span class="sug-sym">' + esc(it.symbol) + '</span>'
        + '<span class="sug-name">' + esc(it.name) + '</span>'
        + '<span class="sug-mkt">' + esc(it.market === 'HK' ? '港股 ' + it.exchange : it.exchange || '美股') + '</span>'
        + '</li>';
    }).join('');
    ul.hidden = false;

    Array.prototype.forEach.call(ul.children, function (li) {
      li.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var it = state.suggestItems[Number(li.dataset.idx)];
        if (it) { $('symbolInput').value = it.symbol; hideSuggestions(); analyze(it.symbol); }
      });
    });
  }

  function fetchSuggestions(q) {
    if (!q || q.trim().length < 1) { hideSuggestions(); return; }
    api('/api/search?q=' + encodeURIComponent(q.trim()))
      .then(function (res) {
        if ($('symbolInput').value.trim() !== q.trim()) return; // 輸入已變更
        renderSuggestions(res.results || [], q);
      })
      .catch(function () { hideSuggestions(); });
  }

  function moveSuggest(delta) {
    var items = state.suggestItems;
    if (!items.length) return;
    var ul = $('suggestions');
    state.suggestIndex += delta;
    if (state.suggestIndex < 0) state.suggestIndex = items.length - 1;
    if (state.suggestIndex >= items.length) state.suggestIndex = 0;
    Array.prototype.forEach.call(ul.children, function (li, i) {
      var sel = i === state.suggestIndex;
      li.setAttribute('aria-selected', sel ? 'true' : 'false');
      if (sel) li.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ==================== 錯誤顯示 ==================== */
  function showError(title, message, hint, actions) {
    $('welcome').hidden = true;
    $('result').hidden = true;
    $('loading').hidden = true;
    var box = $('errorBox');
    box.hidden = false;
    $('errorTitle').textContent = title;
    $('errorMessage').textContent = message || '';
    $('errorHint').textContent = hint || '';
    var wrap = $('errorActions');
    wrap.innerHTML = '';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'err-btn';
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      wrap.appendChild(b);
    });
  }

  function clearError() {
    $('errorBox').hidden = true;
    $('errorActions').innerHTML = '';
  }

  /* ==================== 主流程 ==================== */
  function setLoading(on, text) {
    $('loading').hidden = !on;
    $('searchBtn').disabled = on;
    $('searchBtn').querySelector('.spinner').hidden = !on;
    $('searchBtn').querySelector('.btn-label').textContent = on ? '分析中' : '查詢分析';
    if (text) $('loadingText').textContent = text;
    if (on) {
      $('welcome').hidden = true;
      $('result').hidden = true;
      clearError();
      setStatus('分析中…', 'busy');
    }
  }

  /**
   * 結束載入狀態但不觸碰結果 / 錯誤區塊，
   * 讓後續的 render 或 showError 決定最終畫面，避免兩者互相覆蓋。
   */
  function endLoading() {
    $('loading').hidden = true;
    $('searchBtn').disabled = false;
    $('searchBtn').querySelector('.spinner').hidden = true;
    $('searchBtn').querySelector('.btn-label').textContent = '查詢分析';
  }

  function analyze(rawSymbol) {
    var raw = (rawSymbol || $('symbolInput').value || '').trim();
    var v = validateInput(raw);

    if (!raw) {
      $('symbolInput').classList.add('invalid');
      $('symbolInput').focus();
      showError('請輸入查詢內容', '尚未輸入股票代碼或名稱。', '例如：美股 AAPL、港股 0700 或 0700.HK、名稱「騰訊」或「Apple」。');
      setStatus('等待輸入', 'err');
      return;
    }
    if (!v.valid) {
      $('symbolInput').classList.add('invalid');
      $('symbolInput').focus();
      showError('輸入格式有誤', v.message, '支援格式：美股代碼（AAPL、BRK.B）、港股代碼（0700 / 0700.HK）、中英文名稱（騰訊 / Tencent）。',
        [{ label: '使用範例：0700.HK', onClick: function () { $('symbolInput').value = '0700.HK'; analyze(); } }]);
      setStatus('格式錯誤', 'err');
      return;
    }

    $('symbolInput').classList.remove('invalid');
    hideSuggestions();
    setLoading(true, '正在取得 ' + raw + ' 的行情並計算技術位…');

    // 載入文案輪播，避免使用者誤以為卡住
    var ticks = 0;
    var timer = setInterval(function () {
      ticks++;
      var msgs = ['正在取得行情資料…', '計算均線與動能指標…', '偵測支撐壓力位…', '執行歷史回測模型…', '彙整買入位建議…'];
      $('loadingText').textContent = msgs[Math.min(ticks, msgs.length - 1)];
    }, 1100);

    api('/api/analyze?symbol=' + encodeURIComponent(raw))
      .then(function (data) {
        clearInterval(timer);
        endLoading();
        state.data = data;
        // 換標的必須重置區間與視窗：5y 序列是上一檔的，留著會畫錯股價
        state.kline = null;
        state.klineRange = null;
        state.klineLoading = false;
        state.view = { start: 0, count: null };
        setRangeActive('1y');
        setRangeStatus('');
        if (data.assumedMarket === 'HK') {
          $('symbolInput').value = data.meta.symbol;
        }
        // 詳情頁的網址要跟著更新，否則重新整理會回到上一檔
        if (document.body.classList.contains('detail-mode') && data.meta.symbol) {
          var want = '#/detail/' + encodeURIComponent(data.meta.symbol);
          if (location.hash !== want) history.replaceState(null, '', '#' + want.slice(1));
        }
        render(data);
        setStatus('已更新', 'ok');
      })
      .catch(function (err) {
        clearInterval(timer);
        endLoading();
        state.data = null;
        handleAnalyzeError(err, raw);
      });
  }

  function handleAnalyzeError(err, raw) {
    var code = err.code || '';
    var actions = [];

    if (code === 'NOT_FOUND') {
      showError('查無此標的',
        err.message || ('找不到「' + raw + '」對應的股票。'),
        err.hint || '請確認代碼是否正確。美股代碼為英文字母（如 AAPL），港股為數字（如 0700.HK）。',
        [{ label: '改用名稱搜尋', onClick: function () { $('symbolInput').value = ''; $('symbolInput').focus(); setStatus('等待輸入'); } }]);
      setStatus('查無資料', 'err');
    } else if (code === 'INSUFFICIENT_DATA' || err.status === 422) {
      showError('資料不足，無法分析',
        err.message || '此標的的歷史資料不足，無法進行可靠的技術分析。',
        err.hint || '可能原因：新股上市未滿 40 個交易日、長期停牌或成交量過低。建議改用其他標的。',
        [{ label: '改查 0700.HK', onClick: function () { $('symbolInput').value = '0700.HK'; analyze(); } },
         { label: '改查 AAPL', onClick: function () { $('symbolInput').value = 'AAPL'; analyze(); } }]);
      setStatus('資料不足', 'err');
    } else if (code === 'EMPTY' || code === 'INVALID_FORMAT' || code === 'INVALID' || code === 'TOO_LONG') {
      showError('輸入有誤', err.message || '請檢查輸入內容。', err.hint || '美股如 AAPL，港股如 0700 或 0700.HK。');
      setStatus('輸入錯誤', 'err');
    } else if (code === 'RATE_LIMITED' || err.status === 429) {
      showError('請求過於頻繁', '資料來源暫時限制存取頻率。', '請稍候 10-30 秒後再試。',
        [{ label: '重試', onClick: function () { analyze(raw); } }]);
      setStatus('請稍後重試', 'err');
    } else if (code === 'OFFLINE' || err.status === 503) {
      showOfflineBar('目前離線，介面可瀏覽但無法取得即時行情。恢復連線後將自動更新。', 'cached', '重試', function () { analyze(raw); });
      showError('目前離線', err.message || '無法連線取得即時行情。',
        err.hint || '介面仍可瀏覽。請恢復網路連線後重試；若已加入主畫面，離線時仍能開啟介面。',
        [{ label: '重試連線', onClick: function () { analyze(raw); } }]);
      setStatus('離線', 'err');
    } else if (!navigator.onLine) {
      showOfflineBar('目前離線，介面可瀏覽但無法取得即時行情。恢復連線後將自動更新。', 'cached', '重試', function () { analyze(raw); });
      showError('網路連線中斷', '目前無法連線到網路。', '請檢查網路連線後重試。',
        [{ label: '重試', onClick: function () { analyze(raw); } }]);
      setStatus('離線', 'err');
    } else if (code === 'NETWORK' || err.network) {
      // 瀏覽器仍認為在線，但請求在網路層就被拒絕（DNS / 連線中斷 / 被阻擋）。
      // 這種情況同樣需要明確的離線提示，否則使用者只看到一句無法理解的錯誤。
      showOfflineBar('無法連線到伺服器或資料來源，以下為錯誤狀態。恢復連線後將自動更新。', 'stale', '重試', function () { analyze(raw); });
      showError('無法連線', err.message || '請求未能送達伺服器，可能是網路中斷或連線被阻擋。',
        err.hint || '請確認網路狀態後重試；若持續失敗，可能是資料來源暫時無法存取。',
        [{ label: '重試', onClick: function () { analyze(raw); } }]);
      setStatus('連線失敗', 'err');
    } else {
      showError('取得資料失敗', err.message || '伺服器或資料來源暫時無法回應。',
        err.hint || '請稍後再試一次；若持續失敗，請確認服務是否仍在執行。',
        [{ label: '重試', onClick: function () { analyze(raw); } }]);
      setStatus('載入失敗', 'err');
    }
  }

  /* ==================== 渲染 ==================== */
  function render(d) {
    $('welcome').hidden = true;
    clearError();
    $('result').hidden = false;
    var m = d.meta;
    var cur = m.currency || '';

    // --- 報價 ---
    $('qName').textContent = m.name || m.shortName || m.symbol;
    $('qSymbol').textContent = m.symbol;
    $('qMarket').textContent = m.market === 'HK' ? '港股' : '美股';
    $('qExchange').textContent = m.exchange || '';
    $('qPrice').textContent = fmt(m.price);
    $('qCurrency').textContent = cur;

    var chg = m.changePercent;
    var chgEl = $('qChange');
    chgEl.textContent = pct(chg) + (chg != null ? '  ' + (chg >= 0 ? '+' : '') + fmt(m.price - (m.previousClose || m.price)) : '');
    chgEl.className = 'price-change ' + clsOf(chg);

    $('qDayRange').textContent = fmt(m.dayLow) + ' – ' + fmt(m.dayHigh);
    $('qPrevClose').textContent = fmt(m.previousClose);
    $('qVolume').textContent = fmtInt(m.volume);
    $('qAtr').textContent = fmt(d.snapshot.atr) + (d.snapshot.atrPct != null ? ' (' + d.snapshot.atrPct.toFixed(2) + '%)' : '');
    var r252 = d.levels.range252;
    $('qRange252').textContent = fmt(r252.low) + ' – ' + fmt(r252.high);
    var rsi = d.snapshot.rsi;
    $('qRsi').textContent = rsi == null ? '—' : rsi.toFixed(1) + ' (' + (rsi > 70 ? '超買' : rsi < 30 ? '超賣' : '中性') + ')';

    // --- 綜合評分 ---
    $('verdictLabel').textContent = d.verdict.label;
    $('verdictScore').textContent = d.score.toFixed(1) + ' / 100';
    $('verdictBadge').className = 'verdict ' + d.verdict.tone;
    setTimeout(function () { $('verdictFill').style.width = d.score + '%'; }, 60);

    if (d.fuzzyMatchNote) {
      var fn = $('fuzzyNote');
      fn.hidden = false;
      fn.textContent = '⚠️ ' + d.fuzzyMatchNote;
    } else {
      $('fuzzyNote').hidden = true;
    }

    // --- 買入區間 ---
    var z = d.buyZone;
    $('zoneLower').textContent = fmt(z.lower);
    $('zoneUpper').textContent = fmt(z.upper);
    $('zoneCurrency').textContent = cur;
    $('zoneBasisBadge').textContent = z.overlapCount > 1 ? z.overlapCount + ' 個技術位重合' : '單一技術位';
    $('zoneBasis').textContent = z.anchorWhy + '（' + fmt(z.anchorPrice) + '）';
    $('zoneSupporting').textContent = (z.supporting || []).join('、') || '—';
    $('zoneStop').textContent = fmt(z.stopLoss) + '（' + pct(((z.stopLoss - m.price) / m.price) * 100) + '）';
    $('zoneTarget').textContent = fmt(z.target) + '（' + pct(((z.target - m.price) / m.price) * 100) + '）';
    $('zoneRR').textContent = z.riskReward + ' : 1';
    $('zoneHint').textContent = '策略提示：' + z.positionHint + '。以 ATR(' + fmt(z.atr) + ') 衡量波動，'
      + '若股價在區間內出現放量止跌訊號可分批進場；跌破停損 ' + fmt(z.stopLoss) + ' 應果斷減碼。';

    renderZoneVisual(d);

    // --- 機率 ---
    var p = d.probabilities;
    $('probHint').textContent = confHint(p);
    var badge = $('confidenceBadge');
    badge.textContent = confLabel(p.confidence);
    badge.className = 'badge ' + (p.confidence === 'high' ? 'high' : p.confidence === 'insufficient' || p.confidence === 'low' ? 'low' : '');

    setGauge('arcUp20', $('valUp20'), p.probUp20, 'probUp20');
    setGauge('arcProfit', $('valProfit'), p.probProfit, 'probProfit');
    $('valUp10').textContent = (p.probUp10 * 100).toFixed(1) + '%';
    $('valSamples').textContent = p.sampleSize + ' 次';
    $('valBase').textContent = p.baseRate20 != null ? (p.baseRate20 * 100).toFixed(1) + '%' : '—';
    $('valEdge').textContent = p.edge20 != null
      ? (p.edge20 >= 0 ? '+' : '') + (p.edge20 * 100).toFixed(1) + ' 個百分點'
      : '—';
    $('valEdge').className = 'zl-v ' + (p.edge20 > 0 ? 'pos' : p.edge20 < 0 ? 'neg' : '');

    // --- K 線區間預測（FP）---
    // 獨立卡片、獨立母體，與上方機率區塊無換算關係（規格 §2.4 FP-0）
    renderPred(d);

    // --- 統計可信度 + 區間位置（取代方向機率，A-31）---
    renderCredibility(d);

    // --- 技術位表 ---
    var rows = [];
    d.levels.supports.forEach(function (s, i) {
      rows.push(row('支撐 ' + (i + 1), 'role-supp', s.price, s.distancePct, s.touches));
    });
    d.levels.resistances.forEach(function (s, i) {
      rows.push(row('壓力 ' + (i + 1), 'role-res', s.price, s.distancePct, s.touches));
    });
    $('levelsBody').innerHTML = rows.join('') || '<tr><td colspan="4" style="color:var(--text-3)">未偵測到明確的支撐壓力位</td></tr>';

    // --- 均線表 ---
    $('maBody').innerHTML = d.snapshot.mas.map(function (ma) {
      var dist = ((ma.value - m.price) / m.price) * 100;
      var above = m.price >= ma.value;
      return '<tr>'
        + '<td><span class="role-pill role-ma">' + ma.label + '</span></td>'
        + '<td class="num">' + fmt(ma.value) + '</td>'
        + '<td class="num ' + (dist > 0 ? 'v-neg' : 'v-pos') + '">' + pct(dist) + '</td>'
        + '<td class="num">' + (ma.slopePct >= 0 ? '▲' : '▼') + ' ' + ma.slopePct.toFixed(2) + '%</td>'
        + '<td>' + (above ? '<span class="v-pos">現價在上</span>' : '<span class="v-neg">現價在下</span>') + '</td>'
        + '</tr>';
    }).join('') || '<tr><td colspan="5" style="color:var(--text-3)">均線資料不足</td></tr>';

    // --- 高低點 / 斐波 ---
    renderRanges(d);
    renderFib(d);

    // --- 評分細項 ---
    $('scoreBreakdown').innerHTML = d.scoreBreakdown.map(function (b) {
      var r = (b.score / b.max) * 100;
      return '<div class="bd-row">'
        + '<span class="bd-label">' + esc(b.label) + '</span>'
        + '<span class="bd-track"><span class="bd-fill" style="width:' + r.toFixed(1) + '%"></span></span>'
        + '<span class="bd-val">' + b.score.toFixed(1) + '</span>'
        + '</div>'
        + '<div class="bd-note">' + esc(b.note) + '</div>';
    }).join('');

    // --- 判斷依據 ---
    $('rationale').innerHTML = d.rationale.map(function (r) {
      return '<div class="rat-item"><h3>' + esc(r.title) + '</h3><p>' + esc(r.body) + '</p></div>';
    }).join('');

    // --- 回測 ---
    renderBacktest(d);

    // --- 進階技術分析四模組 ---
    renderAdvanced(d);

    // --- 頁腳 ---
    var upDate = new Date(d.dataUpdatedAt);
    $('fUpdated').textContent = upDate.toLocaleString('zh-TW', { hour12: false })
      + '（' + timeAgo(d.dataUpdatedAt) + '）';
    $('fSource').textContent = d.dataSource;
    $('fDelay').textContent = delayHint(m);
    $('notifyStatus').textContent = '通知將包含：' + (m.shortName || m.symbol) + ' 現價、漲跌幅、建議買入區間與 20 日上漲機率，以及最新相關新聞連結。';

    // --- 圖表 ---
    state.hoverIndex = null;
    drawChart();
  }

  function row(label, cls, price, distPct, touches) {
    return '<tr>'
      + '<td><span class="role-pill ' + cls + '">' + label + '</span></td>'
      + '<td class="num">' + fmt(price) + '</td>'
      + '<td class="num ' + (distPct >= 0 ? 'v-pos' : 'v-neg') + '">' + pct(distPct) + '</td>'
      + '<td class="num">' + touches + '</td>'
      + '</tr>';
  }

  function confLabel(c) {
    return { high: '高信心（樣本充足）', medium: '中信心', low: '低信心（樣本偏少）', insufficient: '樣本不足（僅技術推估）' }[c] || '—';
  }

  function confHint(p) {
    if (p.confidence === 'insufficient') {
      return '⚠️ 歷史樣本僅 ' + p.sampleSize + ' 次，機率主要由技術面推估，參考價值有限，請搭配其他資訊判斷。';
    }
    var s = '以近兩年日線回溯，股價進入建議區間共 ' + p.sampleSize + ' 次樣本';
    if (p.baseRate20 != null) {
      s += '；同期「任意時點進場」的 20 日上漲基準機率為 ' + (p.baseRate20 * 100).toFixed(1) + '%，本區間相對優勢 '
        + (p.edge20 >= 0 ? '＋' : '－') + Math.abs(p.edge20 * 100).toFixed(1) + ' 個百分點。';
    } else { s += '。'; }
    if (p.edge20 != null && p.edge20 < 0) s += ' 相對優勢為負，代表此區間的歷史表現未優於隨機進場，建議縮小部位或等待更佳價位。';
    else if (p.edge20 != null && p.edge20 > 0.03) s += ' 相對優勢明顯，屬統計上較有利的進場區。';
    return s;
  }

  function setGauge(arcId, valEl, value, key) {
    var arc = $(arcId);
    var c = 2 * Math.PI * 50;
    arc.style.strokeDasharray = c;
    var off = c * (1 - Math.max(0, Math.min(1, value)));
    setTimeout(function () {
      arc.style.strokeDashoffset = off;
      arc.setAttribute('class', 'gauge-arc ' + (value >= 0.6 ? 'good' : value >= 0.45 ? 'mid' : 'poor'));
    }, 60);
    animateNumber(valEl, value * 100, '%');
  }

  function animateNumber(el, target, suffix) {
    var start = 0, dur = 800, t0 = performance.now();
    function step(t) {
      var k = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      el.textContent = (start + (target - start) * e).toFixed(1) + suffix;
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /** 買入區間視覺化：以 52 週高低為座標軸 */
  function renderZoneVisual(d) {
    var m = d.meta, z = d.buyZone;
    var lo = d.levels.range252.low, hi = d.levels.range252.high;
    if (lo == null || hi == null || hi <= lo) { $('zoneVisual').innerHTML = ''; return; }
    var pad = (hi - lo) * 0.06;
    var min = lo - pad, max = hi + pad;
    var pos = function (v) { return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)); };
    var l = pos(z.lower), u = pos(z.upper), now = pos(m.price), st = pos(z.stopLoss), tg = pos(z.target);
    var html = '<div class="track"></div>'
      + '<div class="band" style="left:' + l + '%;width:' + Math.max(2, u - l) + '%"></div>'
      + '<div class="marker m-now" style="left:' + now + '%"></div>'
      + '<div class="marker-label" style="left:' + now + '%">現價 ' + fmt(m.price) + '</div>'
      + '<div class="marker m-stop" style="left:' + st + '%"></div>'
      + '<div class="marker m-target" style="left:' + tg + '%"></div>';
    $('zoneVisual').innerHTML = html;
  }

  /**
   * 渲染 K 線區間預測卡片（FP，路徑 A）
   *
   * 三個狀態必須明確區分，不可混為一談（否則使用者會把
   * 「今天沒有預測」誤讀成「預測結果是 0」）：
   *   ok / partial  → 顯示區間
   *   adj_unavailable / insufficient / unavailable → 顯示原因，不給任何數值
   *
   * 設計約束（規格 §2.3 / §8.4）：
   *   - 絕不使用 COLORS.zone 藍，避免與「建議買入區間」混淆
   *   - 絕不用紅綠承載方向或機率（本卡片不輸出方向）
   *   - 不確定性說明為必要元素，不可隱藏
   */
  function renderPred(d) {
    var p = d.pred;
    var card = $('predCard');
    if (!p) { card.hidden = true; return; }
    card.hidden = false;

    var badge = $('predBadge');
    var noBody = $('predBody');
    var noBox = $('predUnavailable');
    var cur = d.meta.currency || '';

    var OK = p.status === 'ok' || p.status === 'partial';

    if (!OK) {
      noBody.hidden = true;
      noBox.hidden = false;
      var titles = {
        adj_unavailable: '此標的無法提供可靠預測',
        insufficient: '資料不足，無法產生預測',
        unavailable: '暫時無法取得預測資料',
        error: '預測模組發生異常',
      };
      $('predUnavailableTitle').textContent = titles[p.status] || '無法產生預測';
      $('predUnavailableReason').textContent = p.reason || '';
      badge.textContent = '未提供';
      badge.className = 'badge badge-neutral';
      return;
    }

    noBox.hidden = true;
    noBody.hidden = false;

    var base = p.price != null ? p.price : d.meta.price;
    $('predBase').textContent = fmt(base) + ' ' + cur;

    // --- 各週期區間 ---
    // 長條的比例尺：取所有週期的最寬區間，讓三個週期可互相比較寬窄。
    // 這比「每個週期各自滿版」更能傳達「越遠越不確定」的直覺。
    var hs = [5, 10, 20].filter(function (h) { return p.horizons[h] && p.horizons[h].status === 'ok'; });
    var maxSpread = 0;
    hs.forEach(function (h) {
      var o = p.horizons[h];
      if (o.q10 != null && o.q90 != null) maxSpread = Math.max(maxSpread, (o.q90 - o.q10) / base);
    });

    var labels = { 5: '5 日', 10: '10 日', 20: '20 日' };
    var html = '';

    hs.forEach(function (h) {
      var o = p.horizons[h];
      var lo = o.q10, hi = o.q90, mid = o.q50;

      // 位置：以 [最寬區間] 為畫布，今日收盤置中對齊，
      // 這樣「上偏」與「下偏」可直接由視覺判斷，無須讀數字
      var spread = maxSpread > 0 ? maxSpread : 0.01;
      var half = spread / 2;
      // 相對現價的偏移比例（-1..1），再映射到 0..100%
      var toPct = function (v) {
        var rel = (v - base) / base;
        return Math.max(0, Math.min(100, 50 + (rel / half) * 50));
      };
      var l = toPct(lo), u = toPct(hi), md = toPct(mid);

      var dLo = ((lo - base) / base) * 100;
      var dHi = ((hi - base) / base) * 100;

      html += '<div class="pred-row">'
        + '<span class="pred-h">' + labels[h] + '</span>'
        + '<div class="pred-bar">'
        + '<div class="pred-span" style="left:' + l + '%;width:' + Math.max(1.5, u - l) + '%"></div>'
        + '<div class="pred-median" style="left:' + md + '%"></div>'
        + '<div class="pred-base-tick" style="left:50%"></div>'
        + '</div>'
        + '<span class="pred-vals">' + fmt(lo) + '<span class="pred-sep">–</span>' + fmt(hi)
        + '<span class="pred-delta">' + (dLo >= 0 ? '+' : '') + dLo.toFixed(1) + '% / '
        + (dHi >= 0 ? '+' : '') + dHi.toFixed(1) + '%</span></span>'
        + '</div>';
    });

    $('predRows').innerHTML = html || '<p class="pred-unavailable-reason">無可用的週期資料</p>';

    // --- 中繼資訊 ---
    $('predAsOf').textContent = p.asOf || '—';
    var adjText = { 'yahoo-adjclose': '已復權（Yahoo adjclose）', 'qfq-native': '已復權（前復權原始資料）' };
    $('predAdj').textContent = adjText[p.adj] || '未復權';
    $('predQuality').textContent = ({ high: '良好', medium: '普通', low: '偏低' })[p.quality] || '—';

    // PICP：只在回測確實執行過時顯示，避免暗示未驗證的模型也「有校準」
    var picpEl = $('predPicp');
    if (p.backtest && p.backtest.status === 'ok' && p.backtest.horizons) {
      var parts = [];
      [5, 10, 20].forEach(function (h) {
        var b = p.backtest.horizons[h];
        if (b && b.status === 'ok' && b.picp != null) parts.push('h' + h + ' ' + (b.picp * 100).toFixed(1) + '%');
      });
      picpEl.textContent = parts.length ? parts.join('、') : '—';
      // 未通過門檻時必須在徽章上明示，不能只顯示好看的數字
      if (p.backtest.pass === false) {
        badge.textContent = '區間偏窄或偏寬';
        badge.className = 'badge low';
      } else {
        badge.textContent = '80% 區間';
        badge.className = 'badge badge-neutral';
      }
    } else {
      picpEl.textContent = '未執行';
      badge.textContent = '80% 區間';
      badge.className = 'badge badge-neutral';
    }

    $('predNote').textContent = '⚠️ ' + (p.note || '此為歷史分位數推估的價格區間，非價格預測，不構成投資建議')
      + '。區間寬度隨個股波動率不同，「較寬」代表波動較大，不代表較不準確。'
      + '本卡片與上方「建議買入區間」採用不同資料母體，數值不可互相換算。';
  }

  /**
   * 統計可信度 + 區間位置（取代「方向機率」，對應 A-31 裁決）
   *
   * 三個必須說清楚的地方，少一個就會被誤讀成投資建議：
   *   1. 可信度衡量的是「區間估計品質」，不是「會不會漲」
   *   2. 位置描述（重心偏上／對稱／偏下）是幾何量，不是機率
   *   3. 未通過驗收門檻時必須明說，不能只挑好看的數字顯示
   */
  function renderCredibility(d) {
    var card = $('credCard');
    if (!card) return;
    var c = d.predCredibility;
    if (!c) { card.hidden = true; return; }
    card.hidden = false;

    var badge = $('credBadge');
    var body = $('credBody');
    var empty = $('credUnavailable');

    if (!c.available) {
      body.hidden = true;
      empty.hidden = false;
      $('credUnavailableReason').textContent = c.reason || '此標的的區間預測不可用，因此無法評估可信度。';
      badge.textContent = '未提供';
      badge.className = 'badge badge-neutral';
      return;
    }

    empty.hidden = true;
    body.hidden = false;

    // --- 分數環 ---
    var score = c.score == null ? 0 : c.score;
    var ring = $('credRing');
    var C = 2 * Math.PI * 42;
    if (ring) {
      ring.style.strokeDasharray = C;
      ring.setAttribute('class', 'cred-ring grade-' + (c.grade || 'unknown'));
      // 先設滿再延遲歸位，讓填色有動畫（避免一進場就是終值）
      ring.style.strokeDashoffset = C;
      setTimeout(function () { ring.style.strokeDashoffset = C * (1 - score / 100); }, 60);
    }
    var scoreEl = $('credScore');
    if (scoreEl) scoreEl.textContent = score == null ? '—' : String(score);
    var labelEl = $('credLabel');
    if (labelEl) {
      labelEl.textContent = c.label || '—';
      labelEl.className = 'cred-label grade-' + (c.grade || 'unknown');
    }
    badge.textContent = c.backtestPass === false ? '區間未達驗收門檻' : (c.grade === 'high' ? '可信度高' : c.grade === 'medium' ? '可信度中等' : '可信度偏低');
    badge.className = 'badge ' + (c.backtestPass === false ? 'low' : c.grade === 'high' ? 'high' : c.grade === 'medium' ? 'badge-neutral' : 'low');

    // --- 三個組成 ---
    var comps = c.components || [];
    $('credComponents').innerHTML = comps.map(function (p) {
      var v = p.score == null ? null : p.score;
      var w = Math.round((p.weight || 0) * 100);
      var cls = v == null ? 'na' : v >= 75 ? 'good' : v >= 55 ? 'mid' : 'poor';
      return '<div class="cred-comp">'
        + '<div class="cc-head">'
        + '<span class="cc-name">' + esc(p.label) + '</span>'
        + '<span class="cc-w">權重 ' + w + '%</span>'
        + '<span class="cc-val ' + cls + '">' + (v == null ? '不適用' : v) + '</span>'
        + '</div>'
        + '<div class="cc-track"><span class="cc-fill ' + cls + '" style="width:' + (v == null ? 0 : v) + '%"></span></div>'
        + '<div class="cc-note">' + esc(p.note || '') + '</div>'
        + '</div>';
    }).join('');

    // --- 位置描述（不是方向預測）---
    var pos = c.position || {};
    var posBox = $('credPosition');
    if (pos.available) {
      var keyCls = pos.key === 'upper' ? 'pos-up' : pos.key === 'lower' ? 'pos-down' : 'pos-flat';
      var rowsHtml = '';
      [5, 10, 20].forEach(function (h) {
        var o = pos.detail && pos.detail[h];
        if (!o) return;
        rowsHtml += '<div class="cp-row">'
          + '<span class="cp-h">' + h + ' 日</span>'
          + '<span class="cp-bar">'
          + '<span class="cp-zone" style="left:' + (50 - o.shareAbove * 50) + '%;width:' + (o.shareAbove * 100) + '%"></span>'
          + '<span class="cp-tick" style="left:50%"></span>'
          + '</span>'
          + '<span class="cp-txt">' + esc(o.label) + '</span>'
          + '</div>';
      });
      posBox.innerHTML = '<div class="cp-head ' + keyCls + '">'
        + '<span class="cp-title">' + esc(pos.label || '—') + '</span>'
        + '<span class="cp-sub">' + (pos.shareAbove != null ? '區間內 ' + (pos.shareAbove * 100).toFixed(0) + '% 的價位高於現價' : '') + '</span>'
        + '</div>'
        + rowsHtml
        + '<p class="cp-warn">⚠️ ' + esc(String(pos.explain || '').replace(/\*\*/g, '')) + '</p>';
    } else {
      posBox.innerHTML = '<p class="cp-warn">區間資料不足，無法描述位置。</p>';
    }

    // --- 說明 ---
    var notes = (c.notes || []).slice();
    $('credNotes').innerHTML = notes.length
      ? notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('')
      : '';
    $('credNotes').hidden = notes.length === 0;
    $('credDisclaimer').textContent = '⚠️ ' + (c.disclaimer || '');
  }

  function renderRanges(d) {
    var m = d.meta;
    var defs = [
      { t: '近 20 日', r: d.levels.range20 },
      { t: '近 60 日（季度）', r: d.levels.range60 },
      { t: '近 252 日（一年）', r: d.levels.range252 },
    ];
    $('rangeGrid').innerHTML = defs.map(function (x) {
      var pos = x.r.high && x.r.low ? ((m.price - x.r.low) / (x.r.high - x.r.low)) * 100 : null;
      return '<div class="range-cell">'
        + '<h3>' + x.t + '</h3>'
        + '<div class="rr"><span>高點</span><span>' + fmt(x.r.high) + '</span></div>'
        + '<div class="rr"><span>低點</span><span>' + fmt(x.r.low) + '</span></div>'
        + '<div class="rr"><span>現價位置</span><span>' + (pos == null ? '—' : pos.toFixed(0) + '%') + '</span></div>'
        + '</div>';
    }).join('');
  }

  function renderFib(d) {
    var fib = d.levels.fib;
    var bar = $('fibBar'), list = $('fibList');
    if (!fib) { bar.innerHTML = ''; list.innerHTML = '<p style="color:var(--text-3);font-size:13px">無足夠區間計算回撤位</p>'; return; }
    var m = d.meta, z = d.buyZone;
    var hi = fib.high, lo = fib.low;
    var posPct = function (p) { return ((hi - p) / (hi - lo)) * 100; };

    // 加上現價與買入區間標記
    var marks = fib.levels.map(function (l) {
      var inZone = l.price >= z.lower * 0.995 && l.price <= z.upper * 1.005;
      return '<div class="fib-mark' + (inZone ? ' strong' : '') + '" style="left:' + posPct(l.price).toFixed(2) + '%">'
        + '<span class="fib-mark-label">' + l.label.split(' ')[0] + '</span></div>';
    }).join('');

    bar.innerHTML = marks
      + '<div class="fib-mark strong" style="left:' + posPct(m.price).toFixed(2) + '%;background:#101828;width:2px"><span class="fib-mark-label" style="color:#101828;font-weight:700">現價</span></div>';

    list.innerHTML = fib.levels.map(function (l) {
      var dist = ((l.price - m.price) / m.price) * 100;
      var inZone = l.price >= z.lower * 0.995 && l.price <= z.upper * 1.005;
      return '<div class="fib-item' + (inZone ? ' zone-hit' : '') + '">'
        + '<span class="fl">' + esc(l.label) + (inZone ? ' ★買區' : '') + '</span>'
        + '<span class="fp">' + fmt(l.price) + '</span>'
        + '<span class="fl">' + pct(dist) + '</span>'
        + '</div>';
    }).join('');
  }

  function renderBacktest(d) {
    var h10 = d.backtest.horizons[10] || {}, h20 = d.backtest.horizons[20] || {};
    var bt = d.backtest;
    $('btBadge').textContent = bt.samples + ' 次進場樣本';

    if (!bt.samples) {
      $('btGrid').innerHTML = '<p style="color:var(--text-3);font-size:13px">過去兩年內股價未曾進入此區間，無法回測；建議將此區間視為前瞻性參考，並搭配即時訊號確認。</p>';
      $('btBody').innerHTML = '';
      return;
    }

    var cells = [
      { k: '20 日勝率', v: h20.winRate != null ? (h20.winRate * 100).toFixed(1) + '%' : '—', sub: '樣本 ' + (h20.n || 0) + ' 次' },
      { k: '20 日平均報酬', v: h20.avgReturn != null ? pct(h20.avgReturn, 2) : '—', sub: '中位數 ' + (h20.medianReturn != null ? pct(h20.medianReturn, 2) : '—') },
      { k: '平均獲利 / 虧損', v: (h20.avgWin != null ? '+' + h20.avgWin.toFixed(2) : '—') + ' / ' + (h20.avgLoss != null ? h20.avgLoss.toFixed(2) : '—'), sub: '賠率 ' + (h20.payoffRatio != null ? h20.payoffRatio.toFixed(2) : '—') },
      { k: '獲利因子', v: h20.profitFactor != null ? h20.profitFactor.toFixed(2) : '—', sub: '>1 代表期望為正' },
      { k: '平均最大浮盈', v: h20.avgMFE != null ? pct(h20.avgMFE, 2) : '—', sub: '20 日內最佳時機' },
      { k: '平均最大浮虧', v: h20.avgMAE != null ? h20.avgMAE.toFixed(2) + '%' : '—', sub: '承受的最大回撤' },
      { k: '10 日勝率', v: h10.winRate != null ? (h10.winRate * 100).toFixed(1) + '%' : '—', sub: '樣本 ' + (h10.n || 0) + ' 次' },
      { k: '相對基準優勢', v: h20.edge != null ? (h20.edge >= 0 ? '+' : '') + (h20.edge * 100).toFixed(1) + 'pt' : '—', sub: '優於隨機進場幅度' },
    ];
    $('btGrid').innerHTML = cells.map(function (c) {
      return '<div class="bt-cell"><span class="bk">' + c.k + '</span>'
        + '<span class="bv">' + c.v + '</span><span class="bsub">' + c.sub + '</span></div>';
    }).join('');

    var t = d.series.daily;
    $('btBody').innerHTML = bt.recentTriggers.slice().reverse().map(function (x) {
      var dt = new Date(x.time);
      return '<tr>'
        + '<td>' + dt.toLocaleDateString('zh-TW') + '</td>'
        + '<td class="num">' + fmt(x.entry) + '</td>'
        + '<td class="num ' + (x.r10 > 0 ? 'v-pos' : x.r10 < 0 ? 'v-neg' : '') + '">' + (x.r10 != null ? pct(x.r10, 2) : '—') + '</td>'
        + '<td class="num ' + (x.r20 > 0 ? 'v-pos' : x.r20 < 0 ? 'v-neg' : '') + '">' + (x.r20 != null ? pct(x.r20, 2) : '—') + '</td>'
        + '</tr>';
    }).join('');
  }

  /* ============================================================
     進階技術分析四模組
     ------------------------------------------------------------
     後端已把每個模組整理成固定結構，前端只負責呈現：
       { key, title, subtitle, available, dimension{title,points[]},
         entry[], stop[], platforms[{name,note}], data }
     每個 entry / stop 都帶 status 與 statusText，用顏色與排序
     讓使用者一眼看出哪個信號已觸發。
     ============================================================ */

  var ADV_STATUS = {
    triggered: { text: '已觸發', cls: 'adv-on' },
    near: { text: '接近', cls: 'adv-near' },
    'not-met': { text: '未達', cls: 'adv-off' },
    invalid: { text: '已失效', cls: 'adv-bad' },
    unknown: { text: '無法判定', cls: 'adv-na' },
  };

  function renderAdvanced(d) {
    var box = $('advModules');
    var at = d.advancedTools;
    if (!at || !at.modules || !at.modules.length) {
      box.innerHTML = '<p class="adv-empty">此標的暫無進階分析資料。</p>';
      $('advBadge').textContent = '—';
      return;
    }

    $('advBadge').textContent = at.availableCount + ' / ' + at.totalCount + ' 模組可用';

    box.innerHTML = at.modules.map(function (mod) {
      return renderAdvModule(mod);
    }).join('');
  }

  function renderAdvModule(mod) {
    var head = '<header class="adv-mhead">'
      + '<div class="adv-mtitle">'
      + '<h3>' + esc(mod.title) + '</h3>'
      + '<span class="adv-msub">' + esc(mod.subtitle) + '</span>'
      + '</div>'
      + (mod.available
        ? ''
        : '<span class="adv-flag adv-flag-na">資料不可用</span>')
      + '</header>';

    // 資料缺失：明確提示原因與替代方案，不顯示空殼
    if (!mod.available) {
      // 三種不可用要講清楚差別，否則使用者會一直重整一個永遠不會好的模組：
      //   blocked   → 上游拒絕（環境限制），重試無用，直接導向替代平台
      //   transient → 限流／連線，稍後重整即可
      //   其餘       → 此標的本来就没有（如港股無期權市場）
      var flag = mod.blocked
        ? '<span class="adv-flag adv-flag-na">環境無法取得</span>'
        : mod.transient
          ? '<span class="adv-flag adv-flag-warn">暫時無法取得</span>'
          : '<span class="adv-flag adv-flag-na">資料不可用</span>';
      var reasonCls = mod.blocked ? '' : mod.transient ? ' adv-na-transient' : '';
      return '<article class="adv-mod adv-mod-na" data-key="' + esc(mod.key) + '">'
        + '<header class="adv-mhead">'
        + '<div class="adv-mtitle">'
        + '<h3>' + esc(mod.title) + '</h3>'
        + '<span class="adv-msub">' + esc(mod.subtitle) + '</span>'
        + '</div>' + flag
        + '</header>'
        + '<div class="adv-na-box">'
        + '<p class="adv-na-reason' + reasonCls + '">'
        + esc(mod.reason || '此模組目前無法計算。') + '</p>'
        + (mod.hint ? '<p class="adv-na-hint">' + esc(mod.hint) + '</p>' : '')
        + renderAdvDimension(mod.dimension)
        + renderAdvPlatforms(mod.platforms)
        + '</div>'
        + '</article>';
    }

    var proxyWarn = mod.proxy
      ? '<div class="adv-proxy">⚠️ 代理指標：' + esc(mod.proxyReason || '此數值非真實 GEX。') + '</div>'
      : '';

    return '<article class="adv-mod" data-key="' + esc(mod.key) + '">'
      + head
      + proxyWarn
      + renderAdvDataStrip(mod)
      + renderAdvDimension(mod.dimension)
      + renderAdvSignals('最佳進場（下注）信號', 'entry', mod.entry)
      + renderAdvSignals('止損 / 失效信號', 'stop', mod.stop)
      + renderAdvPlatforms(mod.platforms)
      + '</article>';
  }

  /** 各模組的關鍵數字摘要（有 data 才顯示） */
  function renderAdvDataStrip(mod) {
    var dt = mod.data || {};
    var items = [];

    if (mod.key === 'vrvp') {
      items.push(['POC', fmt(dt.poc)]);
      items.push(['VAH', fmt(dt.vah)]);
      items.push(['VAL', fmt(dt.val)]);
      items.push(['重貨區', (dt.heavyZones || []).length + ' 個']);
    } else if (mod.key === 'avwap') {
      var prim = null;
      (dt.series || []).forEach(function (s) { if (s.isPrimary) prim = s; });
      if (!prim && (dt.series || []).length) prim = dt.series[0];
      if (prim) {
        items.push(['主錨點', (prim.anchor && prim.anchor.label) || '—']);
        items.push(['AVWAP', fmt(prim.vwap)]);
        items.push(['距離', pct(prim.distPct)]);
        items.push(['事件後', pct(prim.gainSince)]);
      }
    } else if (mod.key === 'fvg') {
      items.push(['未回補', dt.activeCount == null ? '—' : dt.activeCount + ' 個']);
      items.push(['已回補', dt.filledCount == null ? '—' : dt.filledCount + ' 個']);
      if (dt.nearest) {
        items.push(['最近缺口', fmt(dt.nearest.lower) + ' – ' + fmt(dt.nearest.upper)]);
        items.push(['回補率', Math.round((dt.nearest.fillRatio || 0) * 100) + '%']);
      } else {
        items.push(['最近缺口', '無']);
        items.push(['回補率', '—']);
      }
    } else if (mod.key === 'gex') {
      items.push(['Put Wall', fmt(dt.putWall)]);
      items.push(['Call Wall', fmt(dt.callWall)]);
      items.push(['Zero Gamma', dt.zeroGamma == null ? '—' : fmt(dt.zeroGamma)]);
      items.push(['P/C 比', dt.pcr == null ? '—' : dt.pcr.toFixed(2)]);
    }

    if (!items.length) return '';

    return '<div class="adv-strip">' + items.map(function (it) {
      return '<div class="adv-strip-item"><span class="adv-sk">' + esc(it[0]) + '</span>'
        + '<span class="adv-sv">' + esc(it[1]) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderAdvDimension(dim) {
    if (!dim || !dim.points || !dim.points.length) return '';
    return '<div class="adv-block">'
      + '<h4 class="adv-bh">觀察維度</h4>'
      + '<p class="adv-bsub">' + esc(dim.title || '') + '</p>'
      + '<ul class="adv-points">' + dim.points.map(function (p) {
        return '<li>' + esc(p) + '</li>';
      }).join('') + '</ul>'
      + '</div>';
  }

  function renderAdvSignals(title, kind, list) {
    if (!list || !list.length) {
      return '<div class="adv-block">'
        + '<h4 class="adv-bh ' + (kind === 'entry' ? 'bh-entry' : 'bh-stop') + '">' + esc(title) + '</h4>'
        + '<p class="adv-none">此模組目前無可用信號。</p>'
        + '</div>';
    }

    // 已觸發 / 接近 的排前面，方便快速掃讀
    var order = { triggered: 0, near: 1, unknown: 2, 'not-met': 3, invalid: 4 };
    var sorted = list.slice().sort(function (a, b) {
      return (order[a.status] == null ? 9 : order[a.status]) - (order[b.status] == null ? 9 : order[b.status]);
    });

    return '<div class="adv-block">'
      + '<h4 class="adv-bh ' + (kind === 'entry' ? 'bh-entry' : 'bh-stop') + '">' + esc(title) + '</h4>'
      + '<div class="adv-sigs">' + sorted.map(function (s) {
        var st = ADV_STATUS[s.status] || ADV_STATUS.unknown;
        return '<div class="adv-sig ' + st.cls + '">'
          + '<div class="adv-sig-top">'
          + '<span class="adv-sig-label">' + esc(s.label) + '</span>'
          + '<span class="adv-pill ' + st.cls + '">' + st.text + '</span>'
          + '</div>'
          + (s.statusText ? '<p class="adv-sig-state">' + esc(s.statusText) + '</p>' : '')
          + (s.detail ? '<p class="adv-sig-detail">' + esc(s.detail) + '</p>' : '')
          + '</div>';
      }).join('') + '</div>'
      + '</div>';
  }

  function renderAdvPlatforms(plats) {
    if (!plats || !plats.length) return '';
    return '<div class="adv-block adv-block-plat">'
      + '<h4 class="adv-bh">常見支援平台</h4>'
      + '<div class="adv-plats">' + plats.map(function (p) {
        return '<span class="adv-plat" title="' + esc(p.note || '') + '">'
          + esc(p.name) + '</span>';
      }).join('') + '</div>'
      + '</div>';
  }

  function timeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分鐘前';
    return Math.floor(s / 3600) + ' 小時前';
  }

  function delayHint(m) {
    var tz = m.timezone || '';
    if (m.market === 'HK') return '香港交易所延遲報價（約 15 分鐘），時區 ' + (tz || 'Asia/Hong_Kong');
    return '美股延遲報價，時區 ' + (tz || 'America/New_York');
  }

  /* ==================== Canvas K 線圖 ==================== */
  var COLORS = {
    up: '#d92b2b', down: '#0f9d58',
    ma5: '#e8a33d', ma10: '#7c5cff', ma20: '#1d4ed8', ma60: '#0f9d58', ma120: '#94a3b8',
    boll: '#a855f7', grid: '#eef1f5', axis: '#98a2b3', text: '#475467',
    zone: 'rgba(29,78,216,.14)', zoneEdge: '#1d4ed8',
    support: '#0f9d58', resistance: '#d92b2b', vol: 'rgba(29,78,216,.35)',
    // 籌碼分佈（成交量分佈）：用藍色系，與支撐壓力的紅綠語義區隔，避免誤讀
    vpBar: 'rgba(29,78,216,.16)',
    vpBarVA: 'rgba(29,78,216,.30)',
    vpBarPOC: 'rgba(217,43,43,.55)',
    poc: '#d92b2b', vah: '#1d4ed8', val: '#64748b',
    /**
     * 五級視覺層級（規格書 B1）。
     * 刻意不再用顏色承載「這是什麼線」——顏色已語義飽和（up/resistance
     * 同為 #d92b2b，down/support 同為 #0f9d58）。層級改由線寬與線型區分，
     * 顏色只保留少量輔助辨識。
     */
    l0: '#101828',   // 現價：中性近黑，不與漲跌紅綠衝突
    l1: '#1d4ed8',   // 決策線：藍（進場上下緣、止損）
    l1t: '#7c3aed',  // 目標線：紫，與決策線區隔
    l2: '#64748b',   // 結構線：石板灰
    l3: '#94a3b8',   // 參考線：淡灰
    // FVG：看漲用紅（偏多）、看跌用綠（偏空），符合紅漲綠跌慣例
    // 透明度調高到 .18：.13 在白底上幾乎看不出來（實測取樣 alpha 只有 10 幾），
    // 但又不至於濃到蓋住 K 線實體。
    fvgBull: 'rgba(217,43,43,.18)', fvgBullEdge: 'rgba(217,43,43,.65)',
    fvgBear: 'rgba(15,157,88,.18)', fvgBearEdge: 'rgba(15,157,88,.65)',
  };

  function setupCanvas() {
    var cv = $('priceChart');
    var dpr = window.devicePixelRatio || 1;
    var rect = cv.getBoundingClientRect();
    var w = Math.max(320, rect.width);
    var h = rect.height || 420;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function drawChart() {
    var d = state.data;
    if (!d) return;

    /**
     * 序列來源：預設 `d.series.daily`（250 根，既有行為）；
     * 使用者切換時間區間後改用 `state.kline.candles`（更長）。
     * 兩者欄位結構相同（t/o/h/l/c/v），因此下游完全不必分支。
     */
    var full = (state.kline && state.kline.candles && state.kline.candles.length)
      ? state.kline.candles
      : d.series.daily;
    if (!full || full.length < 2) return;

    /**
     * 視窗切片（縮放 / 平移）。
     *
     * 原本這裡直接畫全部 250 根。加上縮放後必須只畫「可見區間」，
     * 否則放大時每根寬度不變，只是把後面的 K 線擠出畫布外。
     *
     * 關鍵：count 為 null 時 start=0、count=full.length，切片就是整個陣列
     * （slice 會回傳新陣列但內容與順序完全相同），所以預設路徑的
     * 座標計算與舊版逐位元一致 —— AC-06 與圖表疊加測試不受影響。
     */
    var total = full.length;
    var viewCount = state.view.count == null ? total : Math.max(10, Math.min(total, state.view.count));
    var viewStart = Math.max(0, Math.min(total - viewCount, state.view.start || 0));
    state.view.start = viewStart;
    state.view.count = viewCount === total ? null : viewCount;
    var series = viewStart === 0 && viewCount === total ? full : full.slice(viewStart, viewStart + viewCount);
    // 供 FVG 等「以絕對索引定位」的圖層換算位置
    var absOffset = viewStart;

    var c = setupCanvas();
    var ctx = c.ctx, W = c.w, H = c.h;
    ctx.clearRect(0, 0, W, H);

    var showVol = state.overlays.vol;
    /**
     * A4：padR 依實際價格字元數動態計算。
     * 固定 62px 對「1234.56」這種較長格式偏窄，右緣刻度會被截掉。
     * 這裡以最大可能刻度值估字元數，下限仍為 62 以免版面跳動。
     */
    var sampleTxt = fmtPrice(hiEstimate(series));
    var padR = Math.max(62, Math.round(sampleTxt.length * 6.6) + 22);
    var padL = 8, padT = 14, padB = 26;
    var volH = showVol ? Math.max(44, H * 0.16) : 0;
    var plotH = H - padT - padB - volH - (showVol ? 8 : 0);
    var plotW = W - padL - padR;

    // --- 計算數列 ---
    /**
     * 均線與布林必須在**完整序列**上計算，再切出可見區間。
     *
     * 若只在可見區間上算，放大到最後 60 根時 MA60 的起點會落在陣列開頭，
     * 前 59 根沒有值（圖上左半段突然沒有均線），而且數值與未縮放時不同
     * ——同一根 K 線的 MA20 不該因為縮放而改變。
     */
    var closes = full.map(function (x) { return x.c; });
    var maDefs = [{ p: 5, color: COLORS.ma5 }, { p: 10, color: COLORS.ma10 }, { p: 20, color: COLORS.ma20 }, { p: 60, color: COLORS.ma60 }];
    var maFull = maDefs.map(function (m) { return { p: m.p, color: m.color, data: sma(closes, m.p) }; });
    var bollFull = state.overlays.boll ? bollinger(closes, 20, 2) : null;

    var win = function (arr) {
      if (!arr) return arr;
      return (viewStart === 0 && viewCount === total) ? arr : arr.slice(viewStart, viewStart + viewCount);
    };
    var maSeries = maFull.map(function (m) { return { p: m.p, color: m.color, data: win(m.data) }; });
    var bollData = bollFull
      ? { mid: win(bollFull.mid), upper: win(bollFull.upper), lower: win(bollFull.lower) }
      : null;

    // --- Y 軸範圍（A6：視口裁切） ---
    /**
     * 規格書 A6 的核心目的：不讓遠端技術位把 K 線壓成扁平帶。
     *
     * 舊做法把所有技術位（支撐、壓力、POC/VAH/VAL、買區、FVG）併入
     * lo/hi 計算。只要有一條半年前的支撐位，K 線實體就會被壓到只剩
     * 幾個像素──這是「圖表看不懂」的頭號成因，比配色問題嚴重得多。
     *
     * 新做法：lo/hi 只由「實際繪製的 K 線」高低點決定，再向外留 5%。
     * 超出視口的決策線不壓縮座標，改用邊緣箭頭提示（見 drawEdgeMarkers）。
     *
     * 註：規格書寫「近 N 根，N = min(可見根數, 120)」。但本圖實際繪製
     * 全部 250 根（測試亦以此為基準），若只取 120 根算範圍，前 130 根
     * 會被裁到畫布外。故這裡取「實際繪製的根數」為 N，同樣達成
     * 「技術位不得影響 lo/hi」這個可驗收目標（AC-06）。
     */
    var visHigh = -Infinity, visLow = Infinity;
    for (var vi0 = 0; vi0 < series.length; vi0++) {
      if (series[vi0].h > visHigh) visHigh = series[vi0].h;
      if (series[vi0].l < visLow) visLow = series[vi0].l;
    }
    var lo = visLow;
    var hi = visHigh;
    var spanY = hi - lo;
    if (!isFinite(spanY) || spanY <= 0) spanY = Math.abs(hi) * 0.02 || 1;
    lo = lo - spanY * 0.05;
    hi = hi + spanY * 0.05;
    // 現價若因資料異常落在範圍外（極少數），強制納入，否則 L0 會消失
    if (isFinite(d.meta.price)) {
      if (d.meta.price > hi) hi = d.meta.price + spanY * 0.02;
      if (d.meta.price < lo) lo = d.meta.price - spanY * 0.02;
    }
    if (hi <= lo) { hi = lo + 1; }

    /**
     * 進階圖層資料。
     *
     * FVG 的 `barsAgo` 是「距最後一根多少根」，與序列總長度無關，
     * 因此切換到更長的區間（5y）時仍能正確定位——只要把 n 換成
     * 實際繪製序列的總長度即可。
     */
    var advData = advChartData(d, total);

    var n = series.length;
    var slot = plotW / n;
    var bw = Math.max(1.2, Math.min(11, slot * 0.62));

    var xOf = function (i) { return padL + slot * i + slot / 2; };
    var yOf = function (v) { return padT + plotH * (1 - (v - lo) / (hi - lo)); };

    /**
     * 幾何契約（測試鎖定）。
     *
     * `series` 仍是「本幀繪製的序列」，所以 hover 與測試讀到的都是看得見的
     * 那一段；新增的 `full` / `viewStart` 只是讓時間軸標籤與縮放控制
     * 知道自己在完整序列的哪個位置，不改變任何既有欄位的語意。
     */
    state.chartGeom = {
      xOf: xOf, yOf: yOf, slot: slot, padL: padL, padT: padT,
      plotW: plotW, plotH: plotH, series: series, lo: lo, hi: hi, n: n,
      full: full, fullLen: total, viewStart: viewStart, viewCount: viewCount,
      padR: padR,
    };
    // 供回歸測試斷言「技術位是否畫在正確的價格座標」。
    // 掛在元素上而非 window，避免汙染全域；不影響任何渲染行為。
    $('priceChart').__geom = state.chartGeom;

    // --- 網格與 Y 軸標籤 ---
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    var ticks = 5;
    for (var t = 0; t <= ticks; t++) {
      var v = lo + ((hi - lo) * t) / ticks;
      var y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.axis;
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(v), padL + plotW + 6, y);
    }

    // --- X 軸日期 ---
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.axis;
    var stepX = Math.max(1, Math.round(n / 5));
    for (var i = 0; i < n; i += stepX) {
      var dt = new Date(series[i].t);
      ctx.fillText((dt.getMonth() + 1) + '/' + dt.getDate(), xOf(i), H - padB / 2);
    }

    // --- 買入區間帶（L4 背景，最底層） ---
    if (state.overlays.levels) {
      var yUpper = yOf(d.buyZone.upper), yLower = yOf(d.buyZone.lower);
      var bandTop = Math.max(padT, Math.min(yUpper, yLower));
      var bandBot = Math.min(padT + plotH, Math.max(yUpper, yLower));
      if (bandBot > bandTop) {
        ctx.fillStyle = COLORS.zone;
        ctx.fillRect(padL, bandTop, plotW, bandBot - bandTop);
      }
    }

    // --- 進階圖層（L4 背景）：FVG 填色與 VP 柱，畫在 K 線之前 ---
    /**
     * FVG 以「絕對索引」定位（fromIdx 是從序列尾端回推），
     * 縮放後必須減去視窗起點才對得上畫布座標。
     * 完全落在視窗外就跳過，避免畫到畫布外被裁掉卻仍計算。
     */
    var advDataView = {
      vp: advData.vp,
      fvg: advData.fvg
        ? advData.fvg
          .map(function (g) { return Object.assign({}, g, { fromIdx: g.fromIdx - absOffset }); })
          // 減去視窗起點後可能變成負數（缺口整段落在視窗左側之外）。
          // 這種要一併濾掉：drawFVG 會把負索引夾成 padL，畫出一條從左邊界
          // 延伸到右邊界的假區間帶，看起來像「這裡有缺口」，實際上是錯的。
          .filter(function (g) { return g.fromIdx >= 0 && g.fromIdx < n; })
        : null,
    };
    if (state.overlays.fvg) drawFVG(ctx, advDataView.fvg, xOf, yOf, padL, plotW, padT, plotH);
    if (state.overlays.vp) drawVolumeProfile(ctx, advData.vp, yOf, padL, plotW, padT, plotH);

    // --- K 線 ---
    for (var k = 0; k < n; k++) {
      var bar = series[k];
      var x = xOf(k);
      var up = bar.c >= bar.o;
      var col = up ? COLORS.up : COLORS.down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1;
      // 影線
      ctx.beginPath();
      ctx.moveTo(x, yOf(bar.h));
      ctx.lineTo(x, yOf(bar.l));
      ctx.stroke();
      // 實體
      var yo = yOf(bar.o), yc = yOf(bar.c);
      var top = Math.min(yo, yc);
      var hgt = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(x - bw / 2, top, bw, hgt);
    }

    // --- 布林通道 ---
    if (bollData) {
      bandArea(ctx, bollData.upper, bollData.lower, xOf, yOf, n, 'rgba(168,85,247,.08)');
      linePlot(ctx, bollData.upper, xOf, yOf, COLORS.boll, 1.2, [4, 3]);
      linePlot(ctx, bollData.lower, xOf, yOf, COLORS.boll, 1.2, [4, 3]);
      linePlot(ctx, bollData.mid, xOf, yOf, COLORS.boll, 1.4, []);
    }

    // --- 均線（L4 背景） ---
    if (state.overlays.ma) {
      maSeries.forEach(function (m) { linePlot(ctx, m.data, xOf, yOf, m.color, 1.5, []); });
    }

    /**
     * ==================== 技術位水平線（L1–L3） ====================
     *
     * 依規格書 B1／B2 實作：
     *   L1  決策線：進場上緣、下緣、止損        → 配額 3，永不降級
     *   L1-T 目標線：目標①、目標②              → 配額 2，②可降級
     *   L2  結構線：POC/VAH/VAL                 → 未滿 5 才遞補
     *   L3  參考線：支撐、壓力                  → 僅 hover，或未滿 5 才畫
     *   L0  基準線：現價（最後畫，不佔配額）
     *
     * 超額時的降級鏈：L3 → L2 → L1-T②。L1 三條與 L0 永不降級。
     */
    var drawnLines = [];        // 實際畫出的水平線（供標籤與測試）
    var edgeMarks = [];         // 超出視口、改以邊緣箭頭呈現的線

    // L1 三條核心決策線（依 B2 優先序 1–3）
    var z = d.buyZone;
    var l1 = [
      { v: z.upper, key: 'zone-upper', label: '進場上緣' },
      { v: z.stopLoss, key: 'stoploss', label: '止損', action: '跌破即失效' },
      { v: z.lower, key: 'zone-lower', label: '進場下緣' },
    ];
    // L1-T 目標①＝POC（若可得），目標②＝target
    // tp1IsPoc 必須獨立記錄：不能靠「drawnLines 裡有沒有 key==='tp1'」反推，
    // 因為 POC 低於現價時 tp1 取的是 z.target，那時 POC 仍應以 L2 另行繪出，
    // 否則 POC 會被靜默跳過而完全消失（實測會從圖上消失）。
    var pocVal = (state.overlays.vp && advData.vp && isFinite(advData.vp.poc)) ? advData.vp.poc : null;
    var tp1IsPoc = pocVal != null && pocVal > d.meta.price;
    var tp1 = tp1IsPoc ? pocVal : (isFinite(z.target) ? z.target : null);
    var tp2 = (tp1IsPoc && isFinite(z.target) && z.target !== pocVal) ? z.target : null;

    if (state.overlays.levels) {
      l1.forEach(function (item) {
        if (!isFinite(item.v)) return;
        pushLine(item.v, 'L1', item.label, item.action, item.key);
      });
      if (tp1 != null) pushLine(tp1, 'L1T', '目標①', '減半倉', 'tp1');
      if (tp2 != null) pushLine(tp2, 'L1T', '目標②', '移止損至保本', 'tp2');
    }

    // L2 結構線：POC / VAH / VAL（僅在尚有配額時遞補）
    if (state.overlays.vp && advData.vp) {
      if (pocVal != null && !tp1IsPoc) {
        pushLine(advData.vp.poc, 'L2', 'POC', null, 'poc');
      }
      pushLine(advData.vp.vah, 'L2', 'VAH', null, 'vah');
      pushLine(advData.vp.val, 'L2', 'VAL', null, 'val');
    }

    // L3 參考線：支撐壓力（最後遞補，超出就只留 hover）
    if (state.overlays.levels) {
      d.levels.supports.forEach(function (s, i) {
        pushLine(s.price, 'L3', '支撐' + (i + 1), null, 'sup' + i);
      });
      d.levels.resistances.forEach(function (s, i) {
        pushLine(s.price, 'L3', '壓力' + (i + 1), null, 'res' + i);
      });
    }

    /**
     * 加入一條候選線：依配額決定「畫線 / 降級」。
     * 配額規則（B2）：L1 三條保留；其餘共用剩下名額，總數上限 5。
     */
    function pushLine(v, tier, label, action, key) {
      if (!isFinite(v)) return;
      // 超出視口 → 交給邊緣箭頭，不畫線、不佔配額
      if (v > hi || v < lo) {
        if (tier === 'L1' || tier === 'L1T') {
          edgeMarks.push({ v: v, tier: tier, label: label, action: action });
        }
        return;
      }
      var quota = (tier === 'L1') ? 3 : 5;
      if (drawnLines.length >= quota) return;   // 降級：不畫線
      drawnLines.push({ v: v, tier: tier, label: label, action: action, key: key });
    }

    // 依層級由低到高繪製（L3 → L2 → L1T → L1），確保決策線壓在最上層
    drawnLines.sort(function (a, b) { return TIER_ORDER[a.tier] - TIER_ORDER[b.tier]; });
    drawnLines.forEach(function (ln) {
      var st = TIER_STYLE[ln.tier];
      var y = Math.round(yOf(ln.v)) + 0.5;
      ctx.save();
      ctx.globalAlpha = st.alpha || 1;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.lw;
      ctx.setLineDash(st.dash);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.restore();
    });

    // --- L3 支撐壓力在 L1/其它線之上仍要能 hover，故不另畫 ---

    // --- 標籤（B3：垂直錯位階梯，避免疊字） ---
    drawLineLabels(ctx, drawnLines, yOf, padL, plotW, padT, plotH);

    // --- B7：超出視口的決策線，以邊緣箭頭呈現 ---
    drawEdgeMarkers(ctx, edgeMarks, yOf, padL, plotW, padT, plotH, hi, lo);

    // --- L0 現價線（最高優先級，最後繪製；不佔配額） ---
    if (isFinite(d.meta.price) && d.meta.price >= lo && d.meta.price <= hi) {
      var yP = Math.round(yOf(d.meta.price)) + 0.5;
      ctx.save();
      ctx.strokeStyle = COLORS.l0;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(padL, yP);
      ctx.lineTo(padL + plotW, yP);
      ctx.stroke();
      // 右側價格 pill
      var pillTxt = '現價 ' + fmtPrice(d.meta.price);
      ctx.font = '600 10px ui-monospace, monospace';
      var tw = ctx.measureText(pillTxt).width;
      var pillW = tw + 12;
      var pillX = padL + plotW + 3;
      ctx.fillStyle = COLORS.l0;
      roundRect(ctx, pillX, yP - 8, Math.min(pillW, padR - 6), 16, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(pillTxt, pillX + 6, yP + 0.5);
      ctx.restore();
    }

    // 供驗證用的本幀摘要（B2 配額 / B7 邊緣箭頭）。
    // 與 __geom 同樣只做「讀」，不改任何渲染行為。
    state.chartGeom.tiers = drawnLines.map(function (l) {
      return { tier: l.tier, label: l.label, v: l.v };
    });
    state.chartGeom.edge = edgeMarks.map(function (m) {
      return { tier: m.tier, label: m.label, v: m.v };
    });
    $('priceChart').__geom = state.chartGeom;

    // --- 成交量 ---
    if (showVol) {
      var volTop = padT + plotH + 8;
      var maxV = Math.max.apply(null, series.map(function (x) { return x.v || 0; })) || 1;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = COLORS.axis;
      ctx.textAlign = 'left';
      ctx.fillText(fmtInt(maxV), padL + plotW + 6, volTop + 6);
      for (var vi = 0; vi < n; vi++) {
        var vv = series[vi].v || 0;
        var vh = (vv / maxV) * volH;
        ctx.fillStyle = series[vi].c >= series[vi].o ? 'rgba(217,43,43,.42)' : 'rgba(15,157,88,.42)';
        ctx.fillRect(xOf(vi) - bw / 2, volTop + volH - vh, bw, vh);
      }
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(padL, volTop + volH);
      ctx.lineTo(padL + plotW, volTop + volH);
      ctx.stroke();
    }

    // --- 十字線 / hover ---
    if (state.hoverIndex != null && state.hoverIndex >= 0 && state.hoverIndex < n) {
      var hx = xOf(state.hoverIndex);
      ctx.strokeStyle = 'rgba(16,24,40,.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + plotH); ctx.stroke();
      var hb = series[state.hoverIndex];
      var hy = yOf(hb.c);
      ctx.beginPath(); ctx.moveTo(padL, hy); ctx.lineTo(padL + plotW, hy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(hb.c), padL + plotW + 6, hy);
    }

    renderLegend(d, maSeries);
  }

  /**
   * 估算 Y 軸刻度的最大字元長度，供 A4 動態計算 padR。
   * 取近期高點與現價的較大者——刻度上限就是這個量級。
   *
   * 注意這裡必須用**完整序列**的尾段，而非縮放後的可見區間：
   * padR 若隨縮放跳動，右側價格刻度會忽寬忽窄，整個繪圖區跟著位移。
   */
  function hiEstimate(series) {
    var m = -Infinity;
    for (var i = Math.max(0, series.length - 250); i < series.length; i++) {
      if (series[i].h > m) m = series[i].h;
    }
    var p = state.data && state.data.meta ? state.data.meta.price : null;
    if (isFinite(p) && p > m) m = p;
    return isFinite(m) ? m : 1;
  }

  /** 圓角矩形（不依賴 ctx.roundRect，舊版 Safari 沒有） */
  function roundRect(ctx, x, y, w, h, r) {    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /**
   * B1：四層視覺樣式。層級靠「線寬 + 虛線節奏 + 透明度」區分，
   * 刻意不靠顏色——因為紅(#d92b2b)同時是「上漲」與「壓力」，
   * 綠(#0f9d58)同時是「下跌」與「支撐」，語義已飽和。
   * 必須定義在模組作用域：drawChart 與 drawLineLabels 兩邊都要用。
   */
  var TIER_STYLE = {
    L1:  { color: COLORS.l1,  lw: 2.0, dash: [] },            // 決策線：實線最粗
    L1T: { color: COLORS.l1t, lw: 1.6, dash: [6, 3] },        // 目標：長虛線
    L2:  { color: COLORS.l2,  lw: 1.2, dash: [5, 3] },        // 結構：中虛線
    L3:  { color: COLORS.l3,  lw: 1.0, dash: [2, 4], alpha: 0.45 }, // 參考：點線且淡
  };
  /** 繪製順序：數字越小越先畫（越靠底層） */
  var TIER_ORDER = { L3: 0, L2: 1, L1T: 2, L1: 3 };

  /**
   * B4：依容器寬度決定標籤詳略。
   *   ≥1024px：完整語義 + 價格，例「止損 331.80（跌破即失效）」
   *   640–1023px：語義 + 價格
   *   <640px：代號 + 價格，例「SL 331.80」
   */
  var TIER_CODE = {
    '進場上緣': 'EN↑', '進場下緣': 'EN↓', '止損': 'SL',
    '目標①': 'TP1', '目標②': 'TP2', 'POC': 'POC', 'VAH': 'VAH', 'VAL': 'VAL',
  };
  function labelMode() {
    var w = window.innerWidth;
    if (w >= 1024) return 'full';
    if (w >= 640) return 'mid';
    return 'short';
  }
  function buildLabel(ln) {
    var mode = labelMode();
    var code = TIER_CODE[ln.label] || (ln.label.length > 4 ? ln.label.slice(0, 4) : ln.label);
    var price = fmtPrice(ln.v);
    if (mode === 'full') {
      return ln.action ? (ln.label + ' ' + price + '（' + ln.action + '）')
        : (ln.label + ' ' + price);
    }
    if (mode === 'mid') {
      return ln.label + ' ' + price;
    }
    return code + ' ' + price;
  }

  /**
   * B3：標籤垂直錯位。
   * 同側任兩標籤 y 距離 < 12px 即視為碰撞，後者下移；超過 4 層併入。
   */
  function drawLineLabels(ctx, lines, yOf, padL, plotW, padT, plotH) {
    if (!lines.length) return;
    var MIN_GAP = 12;
    var items = lines.map(function (ln) {
      return { ln: ln, y: yOf(ln.v), ty: yOf(ln.v) };
    }).sort(function (a, b) { return a.y - b.y; });

    // 由下往上錯位（避免壓到下方標籤）
    var lastY = -Infinity;
    items.forEach(function (it) {
      if (it.ty < lastY + MIN_GAP) it.ty = lastY + MIN_GAP;
      lastY = it.ty;
    });
    // 若整體超出繪圖區底部，整體上移
    var overflow = lastY - (padT + plotH - 4);
    if (overflow > 0) {
      items.forEach(function (it) { it.ty -= overflow; });
    }

    ctx.save();
    ctx.font = '600 9.5px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    items.forEach(function (it) {
      var st = TIER_STYLE[it.ln.tier];
      var txt = buildLabel(it.ln);
      var labelX = padL + 6;
      var tw = ctx.measureText(txt).width;
      // 引線：標籤被移開時，用細線連回真實價位
      if (Math.abs(it.ty - it.y) > 0.6) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = st.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(labelX + tw + 2, it.ty);
        ctx.lineTo(labelX + tw + 2, it.y);
        ctx.stroke();
        ctx.restore();
      }
      // 標籤底（淡底提升可讀性，尤其壓在 K 線上時）
      ctx.save();
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = '#fff';
      roundRect(ctx, labelX - 3, it.ty - 6.5, tw + 6, 13, 3);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = st.alpha || 1;
      ctx.fillStyle = st.color;
      ctx.fillText(txt, labelX, it.ty);
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  }

  /**
   * B7：超出視口的決策線以邊緣箭頭呈現。
   * L1／L1-T 實心、L2 空心、L3 不顯示（避免邊緣變成另一種雜訊）。
   * 同向最多 3 個，超出顯示 +N。
   */
  function drawEdgeMarkers(ctx, marks, yOf, padL, plotW, padT, plotH, hi, lo) {
    if (!marks.length) return;
    var up = marks.filter(function (m) { return m.v > hi; })
      .sort(function (a, b) { return b.v - a.v; });
    var dn = marks.filter(function (m) { return m.v < lo; })
      .sort(function (a, b) { return a.v - b.v; });

    var draw = function (list, isTop) {
      var cap = 3;
      list.slice(0, cap).forEach(function (m, i) {
        var y = isTop ? padT + 8 + i * 15 : padT + plotH - 8 - i * 15;
        var x = padL + plotW - 14;
        var solid = (m.tier === 'L1' || m.tier === 'L1T');
        ctx.save();
        ctx.font = '600 9px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        var txt = (isTop ? '▲ ' : '▼ ') + (m.action === '跌破即失效' ? 'SL' : (TIER_CODE[m.label] || m.label)) + ' ' + fmtPrice(m.v);
        var tw = ctx.measureText(txt).width;
        // 底
        ctx.fillStyle = solid ? 'rgba(29,78,216,.92)' : 'rgba(100,116,139,.92)';
        roundRect(ctx, x - tw - 8, y - 7, tw + 10, 14, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, x, y + 0.5);
        ctx.restore();
      });
      if (list.length > cap) {
        var y2 = isTop ? padT + 8 + cap * 15 : padT + plotH - 8 - cap * 15;
        ctx.save();
        ctx.font = '600 9px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(100,116,139,.75)';
        ctx.fillText('+' + (list.length - cap), padL + plotW - 14, y2);
        ctx.restore();
      }
    };
    draw(up, true);
    draw(dn, false);
  }


  /**
   * 從 advancedTools 取出圖表需要的資料
   *
   * 這裡有一個容易錯的對應關係：後端算 FVG 用「全部 K 線」（lookback 120），
   * 而圖表只畫最近 250 根。FVG 的 barsAgo 是「距最後一根幾根」，
   * 所以換算成圖表索引就是 n - 1 - barsAgo。用這個方式對齊，
   * 不管後端 lookback 幾根都正確，不需要兩邊共用常數。
   */
  function advChartData(d, seriesLen) {
    var out = { vp: null, fvg: null };
    var at = d && d.advancedTools;
    if (!at || !at.modules) return out;

    at.modules.forEach(function (m) {
      if (!m.available || !m.data) return;

      if (m.key === 'vrvp') {
        var prof = m.data.profile || [];
        var val = prof.filter(function (b) { return b.volume > 0; });
        if (!val.length) return;
        var maxV = 0;
        val.forEach(function (b) { if (b.volume > maxV) maxV = b.volume; });
        out.vp = {
          poc: m.data.poc, vah: m.data.vah, val: m.data.val,
          profile: prof, maxV: maxV,
        };
      }

      if (m.key === 'fvg') {
        // 只畫未回補的缺口（已回補的畫上去只會變成雜訊），
        // 且只保留落在圖表可見範圍內的，避免右側延伸帶互相重疊。
        //
        // seriesLen 由呼叫方傳入「本幀實際繪製的序列長度」：
        // 預設是 250，切換到 5y 時會是 1200+。barsAgo 是相對最後一根的
        // 距離，所以 n 必須是「完整序列」的長度，不能是縮放後的可見根數。
        var n = seriesLen != null ? seriesLen
          : (d.series && d.series.daily ? d.series.daily.length : 0);
        out.fvg = (m.data.active || [])
          .map(function (g) {
            var idx = n - 1 - (g.barsAgo || 0);
            return { lower: g.lower, upper: g.upper, direction: g.direction, fromIdx: idx, fillRatio: g.fillRatio, label: g.label };
          })
          .filter(function (g) { return g.fromIdx >= 0 && g.fromIdx < n; });
      }
    });

    return out;
  }

  /** 成交量分佈：從左側（或右側）往內長的橫向柱狀，附 POC / VAH / VAL */
  function drawVolumeProfile(ctx, vp, yOf, padL, plotW, padT, plotH) {
    if (!vp || !vp.profile || !vp.profile.length || !vp.maxV) return;

    // 柱狀最寬佔繪圖區 18%，太寬會遮住 K 線，太窄看不出形狀
    var maxBarW = Math.min(plotW * 0.18, 96);
    /**
     * 靠「左側」往右長，而不是右側。
     *
     * 原因：FVG 區間帶是從缺口形成處「向右延伸到最新一根」，
     * 佔用的是畫面右半部。若成交量分佈也貼右側，兩者會疊在同一塊
     * 區域互相蓋掉（實測 FVG 的紅色填充被柱狀圖蓋成紫色）。
     * 慣例上 TradingView 的 Volume Profile 也預設畫在左側，
     * 左 VP + 右 FVG 正好分工，視覺上互不干擾。
     */
    var left = padL;

    ctx.save();
    vp.profile.forEach(function (bin) {
      if (!(bin.volume > 0)) return;
      var w = (bin.volume / vp.maxV) * maxBarW;
      if (w < 0.6) return;      // 極細的格省略，避免糊成一團

      var yTop = yOf(bin.to);
      var yBot = yOf(bin.from);
      var h = Math.max(1, Math.abs(yBot - yTop));

      var fill = bin.isPOC ? COLORS.vpBarPOC
        : bin.inVA ? COLORS.vpBarVA
          : COLORS.vpBar;
      ctx.fillStyle = fill;
      ctx.fillRect(left, Math.min(yTop, yBot), w, h);
    });

    // POC / VAH / VAL 的「線」不在這裡畫。
    // 舊版在此自行繪製三條線＋左側標籤，但同一價位又會被 pushLine() 以 L2
    // 再壓一次，結果是：同價位兩條線、兩處標籤，且這裡的版本繞過 B2 配額，
    // 讓「最多 5 條水平線」的約束形同失效（實測畫出 6 條以上）。
    // 現在只保留籌碼柱（L4 背景），線與標籤統一由 L1/L2 層級系統輸出，
    // 才能同時受 A6 視口裁切與 B2 配額管轄。
    ctx.restore();
  }

  /** FVG：從缺口形成的那根 K 線起，向右延伸成區間帶 */
  function drawFVG(ctx, gaps, xOf, yOf, padL, plotW, padT, plotH) {
    if (!gaps || !gaps.length) return;

    var right = padL + plotW;
    ctx.save();
    gaps.forEach(function (g) {
      if (!isFinite(g.lower) || !isFinite(g.upper)) return;

      var yTop = yOf(g.upper);
      var yBot = yOf(g.lower);
      if (yTop > padT + plotH || yBot < padT) return;   // 完全在畫面外

      var x = Math.max(padL, xOf(g.fromIdx));
      var w = right - x;
      if (w <= 1) return;

      var bull = g.direction === 'bullish';
      ctx.fillStyle = bull ? COLORS.fvgBull : COLORS.fvgBear;
      ctx.fillRect(x, Math.min(yTop, yBot), w, Math.max(1, Math.abs(yBot - yTop)));

      // 上下邊界線（虛線），讓區間的上下沿看得出來
      ctx.strokeStyle = bull ? COLORS.fvgBullEdge : COLORS.fvgBearEdge;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      [yTop, yBot].forEach(function (y) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // 已回補比例：用一小段實線標在起點，一眼看出這個缺口被吃掉多少
      if (g.fillRatio > 0) {
        var full = Math.abs(yBot - yTop);
        var fh = full * Math.min(1, g.fillRatio);
        var fromBottom = bull;   // 看漲缺口由上方回補，看跌由下方回補
        var fy = fromBottom ? Math.min(yTop, yBot) : Math.min(yTop, yBot) + full - fh;
        ctx.fillStyle = bull ? 'rgba(217,43,43,.30)' : 'rgba(15,157,88,.30)';
        ctx.fillRect(x, fy, Math.min(14, w), Math.max(1, fh));
      }
    });
    ctx.restore();
  }

  function hline(ctx, y, x1, x2, color) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
  }

  function linePlot(ctx, data, xOf, yOf, color, lw, dash) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    if (dash && dash.length) ctx.setLineDash(dash);
    ctx.beginPath();
    var started = false;
    for (var i = 0; i < data.length; i++) {
      if (data[i] == null) { started = false; continue; }
      var x = xOf(i), y = yOf(data[i]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (dash && dash.length) ctx.setLineDash([]);
  }

  function bandArea(ctx, upper, lower, xOf, yOf, n, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    var started = false;
    for (var i = 0; i < n; i++) {
      if (upper[i] == null) continue;
      var x = xOf(i), y = yOf(upper[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    for (var j = n - 1; j >= 0; j--) {
      if (lower[j] == null) continue;
      ctx.lineTo(xOf(j), yOf(lower[j]));
    }
    ctx.closePath();
    ctx.fill();
  }

  function fmtPrice(v) {
    if (v >= 1000) return v.toFixed(0);
    if (v >= 100) return v.toFixed(1);
    if (v >= 10) return v.toFixed(2);
    return v.toFixed(3);
  }

  /**
   * hover 時補上「這根 K 線」與進階技術位的關係
   *
   * 純線圖看得到位置，但看不出「相對關係」。這裡直接算給你看：
   * 收盤價在不在價值區內、有沒有落在某個未回補缺口裡。
   * 這些判斷只用來輔助閱讀，不改變任何分析結論。
   */
  function hoverAdvLines(d, bar) {
    var at = d && d.advancedTools;
    if (!at || !at.modules) return '';
    var out = '';

    at.modules.forEach(function (m) {
      if (!m.available || !m.data) return;

      if (m.key === 'vrvp' && state.overlays.vp) {
        var vp = m.data;
        if (vp.vah == null || vp.val == null) return;
        var inside = bar.c >= vp.val && bar.c <= vp.vah;
        out += '<br><span style="opacity:.75">價值區 </span>'
          + (inside ? '區內' : bar.c > vp.vah ? '在上方' : '在下方')
          + '<span style="opacity:.5"> / POC ' + fmtPrice(vp.poc) + '</span>';
      }

      if (m.key === 'fvg' && state.overlays.fvg) {
        var hit = null;
        (m.data.active || []).forEach(function (g) {
          if (bar.c >= g.lower && bar.c <= g.upper) hit = g;
        });
        if (hit) {
          out += '<br><span style="opacity:.75">位於</span> '
            + (hit.direction === 'bullish' ? '看漲' : '看跌') + ' FVG '
            + fmtPrice(hit.lower) + '~' + fmtPrice(hit.upper);
        }
      }
    });

    return out;
  }

  function renderLegend(d, maSeries) {
    var items = [];
    if (state.overlays.ma) maSeries.forEach(function (m) {
      items.push('<span><i class="lg-line" style="background:' + m.color + '"></i>MA' + m.p + '</span>');
    });
    if (state.overlays.boll) items.push('<span style="color:' + COLORS.boll + '"><i class="lg-dash"></i>布林通道 20,2</span>');
    // 五級層級說明（規格書 B1）：以線寬／線型區分，不再用顏色承載語義
    items.push('<span class="lg-tier"><i class="lg-line" style="background:' + COLORS.l0 + ';height:2px"></i>現價（L0）</span>');
    if (state.overlays.levels) {
      items.push('<span class="lg-tier"><i class="lg-line" style="background:' + COLORS.l1 + ';height:2.5px"></i>決策線（L1）</span>');
      items.push('<span class="lg-tier"><i class="lg-line" style="background:' + COLORS.l1t + ';height:2px"></i>目標（L1-T）</span>');
    }
    if (state.overlays.vol) items.push('<span>下方柱狀為成交量</span>');
    if (state.overlays.vp) {
      items.push('<span><i class="lg-line" style="background:' + COLORS.l2 + '"></i>POC 控制點</span>');
      items.push('<span><i class="lg-dash" style="color:' + COLORS.l2 + '"></i>VAH 價值區上界</span>');
      items.push('<span><i class="lg-dash" style="color:' + COLORS.l2 + '"></i>VAL 價值區下界</span>');
      items.push('<span><i class="lg-box" style="background:' + COLORS.vpBarVA + '"></i>成交量分佈</span>');
    }
    if (state.overlays.levels) {
      items.push('<span><i class="lg-line" style="background:' + COLORS.l3 + ';opacity:.6"></i>支撐／壓力（L3）</span>');
    }
    if (state.overlays.fvg) {
      items.push('<span><i class="lg-box" style="background:' + COLORS.fvgBull + ';border-color:' + COLORS.fvgBullEdge + '"></i>看漲 FVG</span>');
      items.push('<span><i class="lg-box" style="background:' + COLORS.fvgBear + ';border-color:' + COLORS.fvgBearEdge + '"></i>看跌 FVG</span>');
    }
    $('chartLegend').innerHTML = items.join('');
  }

  /* ---- 指標（前端副本，供圖表用） ---- */
  function sma(vals, p) {
    var out = new Array(vals.length).fill(null), sum = 0;
    for (var i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= p) sum -= vals[i - p];
      if (i >= p - 1) out[i] = sum / p;
    }
    return out;
  }
  function bollinger(vals, p, mult) {
    var mid = sma(vals, p), up = [], low = [];
    for (var i = 0; i < vals.length; i++) {
      if (mid[i] == null) { up.push(null); low.push(null); continue; }
      var acc = 0;
      for (var j = i - p + 1; j <= i; j++) acc += Math.pow(vals[j] - mid[i], 2);
      var sd = Math.sqrt(acc / p);
      up.push(mid[i] + mult * sd);
      low.push(mid[i] - mult * sd);
    }
    return { mid: mid, upper: up, lower: low };
  }

  /* ---- 滑鼠互動 ---- */
  /**
   * A1：三種模式對應框架的三層濾網。
   * 模式只決定「哪些圖層該開」，不改變任何計算。
   */
  var MODES = {
    // 第一層（日線）：看防守區在哪。留下結構與成本分佈，關掉短均線與布林。
    structure: { ma: false, levels: true, vp: true, fvg: true, boll: false, vol: false },
    // 第二層（1H／15M）：看是真跌破還是掃損。留下支撐壓力與缺口。
    confirm: { ma: false, levels: true, vp: false, fvg: true, boll: false, vol: true },
    // 第三層（5M）：看現在該不該扣扳機。幾乎全部關掉，只留決策線與缺口。
    execute: { ma: false, levels: true, vp: false, fvg: true, boll: false, vol: false },
  };

  function applyMode(name) {
    var preset = MODES[name];
    if (!preset) return;
    Object.keys(preset).forEach(function (k) { state.overlays[k] = preset[k]; });
    // 同步 tab 按鈕的高亮狀態
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', !!state.overlays[b.dataset.overlay]);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
      b.classList.toggle('active', b.dataset.mode === name);
    });
    drawChart();
  }

  function clearModeActive() {
    Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
      b.classList.remove('active');
    });
  }

  /* ==================== 時間區間切換 ==================== */
  /**
   * 為什麼需要打 API 而不是只切前端：
   *   /api/analyze 只附 250 根日線（控制回應大小）。切到 2y 要 501 根、
   *   5y 要 1250 根，前端沒有更多資料可切。所以 1y 以內純前端切；
   *   2y / 5y 才去 /api/kline 取。
   */
  var RANGE_LABEL = { '3m': '3 個月', '6m': '6 個月', '1y': '1 年', '2y': '2 年', '5y': '5 年' };

  function setRangeActive(key) {
    Array.prototype.forEach.call(document.querySelectorAll('.range-btn'), function (b) {
      b.classList.toggle('active', b.dataset.range === (key || '1y'));
    });
  }

  function setRangeStatus(text, kind) {
    var el = $('rangeStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'range-status' + (kind ? ' ' + kind : '');
    el.hidden = !text;
  }

  function applyRange(rangeKey) {
    var key = rangeKey || '1y';
    // 重置視窗：切換區間後「顯示全部」，否則使用者在 5y 放大到最後 60 根，
    // 再切回 3m 時會落在一个不存在的索引上，畫面變成空白。
    state.view = { start: 0, count: null };
    state.hoverIndex = null;

    if (key === '1y') {
      // 1y 與 analyze 附帶的 250 根等價，直接用現有資料，不必多一次請求
      state.kline = null;
      state.klineRange = '1y';
      setRangeActive('1y');
      setRangeStatus('');
      drawChart();
      updateZoomUi();
      return;
    }

    var sym = state.data && state.data.meta ? state.data.meta.symbol : null;
    if (!sym) return;

    // 已有同區間資料就直接重繪（來回切換不重複打上游）
    if (state.kline && state.klineRange === key) {
      setRangeActive(key);
      setRangeStatus('');
      drawChart();
      updateZoomUi();
      return;
    }

    state.klineLoading = true;
    setRangeActive(key);
    setRangeStatus('正在載入 ' + (RANGE_LABEL[key] || key) + ' 資料…');

    SA.api('/api/kline?symbol=' + encodeURIComponent(sym) + '&range=' + encodeURIComponent(key))
      .then(function (res) {
        state.klineLoading = false;
        if (!res.candles || res.candles.length < 2) {
          // 資料不足時退回 1y，不要留下空白圖表
          setRangeStatus((RANGE_LABEL[key] || key) + ' 資料不足（僅 ' + (res.candles ? res.candles.length : 0) + ' 根），已顯示 1 年', 'warn');
          state.kline = null;
          state.klineRange = '1y';
          setRangeActive('1y');
          drawChart();
          updateZoomUi();
          return;
        }
        state.kline = res;
        state.klineRange = key;
        state.view = { start: 0, count: null };
        setRangeStatus(res.bars + ' 根日線 · ' + (res.source === 'yahoo' ? 'Yahoo' : res.source), 'ok');
        drawChart();
        updateZoomUi();
      })
      .catch(function (err) {
        state.klineLoading = false;
        var desc = SA.describeError(err);
        setRangeStatus('載入失敗：' + desc.message + '（仍顯示 1 年）', 'err');
        state.kline = null;
        state.klineRange = '1y';
        setRangeActive('1y');
        drawChart();
        updateZoomUi();
      });
  }

  /* ==================== 縮放與平移 ==================== */
  var MIN_BARS = 30;    // 最少顯示 30 根，再少就看不出型態

  function seriesTotal() {
    return state.chartGeom ? state.chartGeom.fullLen : 0;
  }

  /** 限制視窗在合法範圍內，回傳是否有變動 */
  function clampView() {
    var total = seriesTotal();
    if (!total) return false;
    var count = state.view.count == null ? total : Math.max(MIN_BARS, Math.min(total, Math.round(state.view.count)));
    var start = Math.max(0, Math.min(total - count, Math.round(state.view.start || 0)));
    var changed = count !== state.view.count || start !== state.view.start;
    state.view.count = count >= total ? null : count;
    state.view.start = start;
    return changed;
  }

  /**
   * 以某個「可見區間內的相對比例」為中心縮放。
   *
   * 為什麼要錨定而不是單純改 count：滑鼠滾輪縮放時，使用者預期
   * 「指標指到的那根 K 線不動」。若只改 count，畫面會從最右邊開始
   * 一路往右縮，指標下的內容會漂走。
   */
  function zoomAt(ratio, factor) {
    var total = seriesTotal();
    if (!total) return;
    var curCount = state.view.count == null ? total : state.view.count;
    var curStart = state.view.start || 0;

    var nextCount = Math.round(curCount * factor);
    nextCount = Math.max(MIN_BARS, Math.min(total, nextCount));
    if (nextCount === curCount) return;

    var anchorAbs = curStart + curCount * ratio;
    var nextStart = Math.round(anchorAbs - nextCount * ratio);
    state.view.count = nextCount >= total ? null : nextCount;
    state.view.start = nextStart;
    clampView();
    drawChart();
    updateZoomUi();
  }

  function panBy(bars) {
    var total = seriesTotal();
    if (!total) return;
    var curCount = state.view.count == null ? total : state.view.count;
    if (curCount >= total) return;   // 全顯示時沒有可平移的內容
    state.view.start = (state.view.start || 0) + bars;
    clampView();
    drawChart();
    updateZoomUi();
  }

  function resetZoom() {
    state.view = { start: 0, count: null };
    drawChart();
    updateZoomUi();
  }

  /** 更新縮放控制列的文字與可用狀態 */
  function updateZoomUi() {
    var total = seriesTotal();
    var g = state.chartGeom;
    var bar = $('zoomBar');
    if (!bar || !g) return;
    bar.hidden = false;

    var count = state.view.count == null ? total : state.view.count;
    var start = state.view.start || 0;

    // 顯示「第 a–b 根，共 N 根」
    var label = total
      ? ('第 ' + (start + 1) + '–' + (start + count) + ' 根 · 共 ' + total + ' 根')
      : '—';
    var el = $('zoomLabel');
    if (el) el.textContent = label;

    var isFull = count >= total;
    ['zoomIn', 'zoomOut'].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      b.disabled = id === 'zoomIn' ? count <= MIN_BARS : isFull && count >= total ? false : false;
    });
    var zi = $('zoomIn'), zo = $('zoomOut');
    if (zi) zi.disabled = count <= MIN_BARS;
    if (zo) zo.disabled = count >= total;
    var pl = $('panLeft'), pr = $('panRight');
    if (pl) pl.disabled = isFull || start <= 0;
    if (pr) pr.disabled = isFull || start + count >= total;
    var rs = $('zoomReset');
    if (rs) rs.disabled = isFull && start === 0;

    // 可見區間的時間範圍（讓人知道現在看的是哪一段）
    var rangeEl = $('zoomRange');
    if (rangeEl) {
      if (g.full.length) {
        var a = g.full[Math.min(start, g.full.length - 1)];
        var b = g.full[Math.min(start + count - 1, g.full.length - 1)];
        rangeEl.textContent = fmtDate(a.t) + ' → ' + fmtDate(b.t);
      } else {
        rangeEl.textContent = '';
      }
    }
  }

  function fmtDate(t) {
    var dt = new Date(t);
    return (dt.getFullYear() % 100) + '/' + (dt.getMonth() + 1) + '/' + dt.getDate();
  }

  function bindChartInteraction() {
    var cv = $('priceChart');
    var tip = $('chartTooltip');
    var infoBar = $('chartInfoBar');
    var infoBody = $('chartInfoBody');

    /** 是否為窄螢幕（資訊改用下方固定列，避免手指遮擋） */
    function isNarrow() { return window.innerWidth <= 900; }

    function onMove(clientX, clientY) {
      var g = state.chartGeom;
      if (!g) return;
      var rect = cv.getBoundingClientRect();
      var x = clientX - rect.left;
      // 吸附到最近 K 線中心，而非自由座標（A7）
      var idx = Math.round((x - g.padL - g.slot / 2) / g.slot);
      idx = Math.max(0, Math.min(g.n - 1, idx));
      state.hoverIndex = idx;
      drawChart();
      showInfo(idx, rect, g);
    }

    function showInfo(idx, rect, g) {
      var b = g.series[idx];
      var dt = new Date(b.t);
      var chg = b.o ? ((b.c - b.o) / b.o) * 100 : 0;
      var head = '<strong>' + dt.toLocaleDateString('zh-TW') + '</strong>　'
        + '開 ' + fmt(b.o) + '　高 ' + fmt(b.h) + '　'
        + '低 ' + fmt(b.l) + '　收 ' + fmt(b.c) + '　'
        + '漲跌 ' + pct(chg, 2) + '　量 ' + fmtInt(b.v);
      var extra = hoverAdvLines(state.data, b);

      if (isNarrow() && infoBar && infoBody) {
        // A7：行動端資訊置於圖表下方固定列，不遮擋手指
        infoBody.innerHTML = head + extra;
        infoBar.hidden = false;
        tip.hidden = true;
        return;
      }
      tip.innerHTML = head + extra;
      tip.hidden = false;
      tip.style.left = Math.min(rect.width - 70, Math.max(70, g.xOf(idx))) + 'px';
      tip.style.top = Math.max(80, g.yOf(b.c) - 8) + 'px';
    }

    /**
     * 視口切換同步（A7 的邊界條件）。
     * 桌面 hover 時浮動 tooltip 會定位在圖表座標的右半側（例如 left≈700px）；
     * 若使用者把視窗縮到手機寬度，那個絕對定位的浮層仍停在舊座標，
     * 直接把 scrollWidth 撐到 1000px 以上，產生水平滾動。
     * 因此尺寸變化時：窄螢幕一律收起浮層，改由下方固定列承載資訊。
     */
    function syncViewport() {
      if (!isNarrow()) return;
      tip.hidden = true;
      tip.style.left = '';
      tip.style.top = '';
    }
    window.addEventListener('resize', syncViewport);
    syncViewport();

    cv.addEventListener('mousemove', function (e) {
      // 拖拽平移中：不觸發 hover（否則十字線會跟著甩）
      if (dragState.active) { onDrag(e.clientX, e.clientY); return; }
      onMove(e.clientX, e.clientY);
    });
    // 桌面：mouseleave 立即清除（A7 規範 ≤50ms）
    cv.addEventListener('mouseleave', function () {
      if (isNarrow()) return;   // 觸控裝置不因 mouseleave 清除
      if (dragState.active) return;
      state.hoverIndex = null;
      tip.hidden = true;
      drawChart();
    });

    /* ---------------- 滾輪縮放 ---------------- */
    /**
     * 為什麼要 preventDefault：
     *   圖表佔滿一屏高度時，滾輪在圖上滾動會連帶捲動整個頁面，
     *   使用者永遠縮放不到，只會覺得「這張圖滑不動」。
     *   因此僅在指標位於繪圖區內時攔截，其餘區域（含右側價格軸留白）
     *   仍讓頁面正常捲動，避免使用者被鎖在圖表上。
     *   必須 passive:false 才能 preventDefault。
     */
    cv.addEventListener('wheel', function (e) {
      var g = state.chartGeom;
      if (!g) return;
      var rect = cv.getBoundingClientRect();
      var x = e.clientX - rect.left;
      if (x < g.padL || x > g.padL + g.plotW) return;   // 在繪圖區外：讓頁面捲動
      e.preventDefault();
      var ratio = Math.max(0, Math.min(1, (x - g.padL) / g.plotW));
      // deltaY > 0 = 往下滾 = 縮小（顯示更多根）；< 0 = 放大
      var factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      zoomAt(ratio, factor);
    }, { passive: false });

    /* ---------------- 拖拽平移 ---------------- */
    var dragState = { active: false, x0: 0, startBars: 0 };

    function onDragStart(clientX) {
      var g = state.chartGeom;
      if (!g) return false;
      var total = g.fullLen;
      var count = state.view.count == null ? total : state.view.count;
      if (count >= total) return false;   // 全顯示時無可平移
      dragState.active = true;
      dragState.x0 = clientX;
      dragState.startBars = state.view.start || 0;
      cv.classList.add('dragging');
      tip.hidden = true;
      return true;
    }

    function onDrag(clientX) {
      var g = state.chartGeom;
      if (!g || !dragState.active) return;
      var dx = clientX - dragState.x0;
      // 換算成根數：往右拖 = 看更早的資料（start 減少）
      var bars = Math.round(dx / g.slot);
      state.view.start = dragState.startBars - bars;
      clampView();
      drawChart();
      updateZoomUi();
    }

    function onDragEnd() {
      if (!dragState.active) return;
      dragState.active = false;
      cv.classList.remove('dragging');
    }

    cv.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (onDragStart(e.clientX)) e.preventDefault();
    });
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('mousemove', function (e) {
      if (dragState.active) onDrag(e.clientX);
    });

    /* ---------------- 觸控雙指縮放 / 單指平移 ---------------- */
    var touchState = { pinching: false, dist0: 0, count0: 0, ratio: 0.5, x0: 0, startBars: 0 };

    function touchDist(t) {
      var dx = t[0].clientX - t[1].clientX;
      var dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    cv.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        // 進入雙指模式：取消 hover，記下起始距離與當前根數
        var g = state.chartGeom;
        if (!g) return;
        var total = g.fullLen;
        touchState.pinching = true;
        touchState.dist0 = touchDist(e.touches);
        touchState.count0 = state.view.count == null ? total : state.view.count;
        var rect = cv.getBoundingClientRect();
        var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        touchState.ratio = Math.max(0, Math.min(1, (midX - g.padL) / g.plotW));
        state.hoverIndex = null;
        tip.hidden = true;
        e.preventDefault();
      }
    }, { passive: false });

    cv.addEventListener('touchmove', function (e) {
      if (touchState.pinching && e.touches.length === 2) {
        var d = touchDist(e.touches);
        if (touchState.dist0 > 0) {
          // 手指張開 = 放大 = 根數變少
          var factor = touchState.dist0 / d;
          var total = seriesTotal();
          var next = Math.round(touchState.count0 * factor);
          next = Math.max(MIN_BARS, Math.min(total, next));
          if (next !== (state.view.count == null ? total : state.view.count)) {
            state.view.count = next >= total ? null : next;
            clampView();
            drawChart();
            updateZoomUi();
          }
        }
        e.preventDefault();
        return;
      }
      if (e.touches.length === 1 && state.view.count != null) {
        // 已放大時，單指左右滑動 = 平移（未放大時保留原本的 hover 行為）
        if (!touchState.panning) {
          touchState.panning = true;
          touchState.x0 = e.touches[0].clientX;
          touchState.startBars = state.view.start || 0;
        }
        var dx = e.touches[0].clientX - touchState.x0;
        if (Math.abs(dx) > 6) {
          var g = state.chartGeom;
          if (g) {
            state.view.start = touchState.startBars - Math.round(dx / g.slot);
            clampView();
            drawChart();
            updateZoomUi();
          }
          e.preventDefault();
          return;
        }
      }
      if (e.touches[0]) { onMove(e.touches[0].clientX, e.touches[0].clientY); }
    }, { passive: false });

    cv.addEventListener('touchend', function () {
      touchState.pinching = false;
      touchState.panning = false;
      // 保留十字線與資訊（不設 timeout）
    });

    /**
     * 行動端：點按後「釘住」，不自動消失。
     * 舊版 touchend 於 1200ms 後自動隱藏，與「釘住」語義衝突，已移除。
     * 解除方式：點圖表外（document 層監聽）或再次點同一根。
     */
    var touchPinned = false;
    cv.addEventListener('touchstart', function (e) {
      if (e.touches[0] && e.touches.length === 1) {
        touchPinned = true;
        // 單指點按也要立刻顯示該根資訊（不能只依賴 touchmove，
        // 否則「點一下」這種最常見的操作反而不出資訊）
        if (state.view.count == null) onMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });
    document.addEventListener('touchstart', function (e) {
      if (touchPinned && !cv.contains(e.target)) {
        touchPinned = false;
        state.hoverIndex = null;
        if (infoBar) infoBar.hidden = true;
        drawChart();
      }
    }, { passive: true });
  }

  /* ==================== 通知 ==================== */
  function bindNotify() {
    var toggle = $('notifyToggle'), btn = $('notifyBtn');

    api('/api/config').then(function (c) {
      if (!c.telegramConfigured) {
        $('notifyStatus').innerHTML = 'Telegram 尚未設定，目前為<strong>模擬模式</strong>：可預覽通知內容，但不會實際發送。'
          + '設定方式：於專案根目錄建立 <code>config.json</code>（{"telegram":{"botToken":"...","chatId":"..."}}）或設定環境變數 <code>TELEGRAM_BOT_TOKEN</code> / <code>TELEGRAM_CHAT_ID</code>。';
      }
    }).catch(function () {});

    toggle.addEventListener('change', function () {
      btn.disabled = !toggle.checked || !state.data;
    });

    btn.addEventListener('click', function () {
      if (!state.data) return;
      var d = state.data;
      btn.disabled = true;
      btn.textContent = '發送中…';
      api('/api/news?symbol=' + encodeURIComponent(d.meta.symbol)
        + '&name=' + encodeURIComponent(d.meta.name || ''))
        .then(function (n) { return n.news || []; })
        .catch(function () { return []; })
        .then(function (news) {
          return api('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: d.meta.symbol, name: d.meta.name, price: d.meta.price,
              changePercent: d.meta.changePercent, currency: d.meta.currency,
              signals: {
                buyZone: d.buyZone, score: d.score,
                verdictLabel: d.verdict.label, probUp20: d.probabilities.probUp20,
              },
              news: news,
            }),
          });
        })
        .then(function (r) {
          var box = $('notifyPreview');
          box.hidden = false;
          // 依實際結果決定標題：舊版不論成敗都顯示「已發送」，會誤導使用者
          // 以為通知真的送到了（尤其出站網路被封鎖時）。
          var head = r.mode === 'simulated'
            ? '【模擬模式 · 未實際發送】'
            : (r.ok ? '【已發送至 Telegram】' : '【發送失敗 · 下列內容未送出】');
          box.textContent = head + '\n\n'
            + (r.message || '')
            + (r.error ? '\n\n錯誤：' + r.error : '')
            + (r.hint ? '\n\n' + r.hint : '')
            + (r.warning ? '\n\n' + r.warning : '');
        })
        .catch(function (e) {
          var box = $('notifyPreview');
          box.hidden = false;
          box.textContent = '發送失敗：' + e.message;
        })
        .then(function () {
          btn.textContent = '發送測試通知';
          btn.disabled = !toggle.checked;
        });
    });
  }

  /* ==================== 事件綁定 ==================== */
  function bindEvents() {
    var input = $('symbolInput');

    $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); analyze(); });

    input.addEventListener('input', function () {
      var raw = input.value;
      input.classList.remove('invalid');
      $('clearBtn').hidden = !raw;

      var v = validateInput(raw);
      if (v.message) {
        $('searchHint').textContent = v.message;
        $('searchHint').className = 'hint-line'
          + (v.level === 'error' ? ' hint-error' : v.level === 'warn' ? ' hint-warn' : ' hint-ok');
      } else {
        $('searchHint').textContent = '支援美股代碼（AAPL）、港股代碼（0700 或 0700.HK）與中英文名稱搜尋。';
        $('searchHint').className = 'hint-line';
      }

      clearTimeout(state.suggestTimer);
      state.suggestTimer = setTimeout(function () { fetchSuggestions(raw); }, 260);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); }
      else if (e.key === 'Escape') { hideSuggestions(); }
      else if (e.key === 'Enter' && state.suggestIndex >= 0 && state.suggestItems[state.suggestIndex]) {
        e.preventDefault();
        var it = state.suggestItems[state.suggestIndex];
        input.value = it.symbol;
        hideSuggestions();
        analyze(it.symbol);
      }
    });

    input.addEventListener('blur', function () { setTimeout(hideSuggestions, 160); });
    input.addEventListener('focus', function () {
      if (input.value.trim()) fetchSuggestions(input.value);
    });

    $('clearBtn').addEventListener('click', function () {
      input.value = '';
      input.focus();
      $('clearBtn').hidden = true;
      hideSuggestions();
      $('result').hidden = true;
      $('welcome').hidden = false;
      clearError();
      setStatus('就緒');
    });

    // 詳情頁返回：回到選股結果（若先前是從選股頁點進來）
    var back = $('detailBack');
    if (back) {
      back.addEventListener('click', function () {
        // 有歷史紀錄就回上一頁（保留篩選結果與捲動位置），否則退回選股頁
        if (history.length > 1 && /^#\/detail\//.test(location.hash)) history.back();
        else SA.navigate('#/screen');
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (b) {
      b.addEventListener('click', function () {
        input.value = b.dataset.symbol;
        $('clearBtn').hidden = false;
        analyze(b.dataset.symbol);
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () {
        var key = b.dataset.overlay;
        state.overlays[key] = !state.overlays[key];
        b.classList.toggle('active', state.overlays[key]);
        // 手動調整圖層後即離開模式預設（模式按鈕不再高亮）
        clearModeActive();
        drawChart();
      });
    });

    /**
     * A1：模式切換。
     * 模式是「圖層組合的預設」，使用者手動改圖層後即視為自訂，
     * 模式按鈕取消高亮——避免介面顯示「結構模式」但實際已不符。
     */
    Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
      b.addEventListener('click', function () {
        applyMode(b.dataset.mode);
      });
    });

    /* ---------------- 時間區間切換 ---------------- */
    Array.prototype.forEach.call(document.querySelectorAll('.range-btn'), function (b) {
      b.addEventListener('click', function () {
        if (state.klineLoading) return;
        applyRange(b.dataset.range);
      });
    });

    /* ---------------- 縮放 / 平移控制 ---------------- */
    var zoomIn = $('zoomIn'), zoomOut = $('zoomOut');
    var panLeft = $('panLeft'), panRight = $('panRight'), zoomReset = $('zoomReset');

    if (zoomIn) zoomIn.addEventListener('click', function () { zoomAt(0.5, 1 / 1.35); });
    if (zoomOut) zoomOut.addEventListener('click', function () { zoomAt(0.5, 1.35); });
    if (zoomReset) zoomReset.addEventListener('click', resetZoom);
    if (panLeft) panLeft.addEventListener('click', function () { panBy(-Math.round((state.view.count || 0) * 0.5)); });
    if (panRight) panRight.addEventListener('click', function () { panBy(Math.round((state.view.count || 0) * 0.5)); });

    // 鍵盤：+/- 縮放、方向鍵平移、0 重置。僅在圖表聚焦時生效，
    // 避免搶走輸入框的方向鍵行為。
    document.addEventListener('keydown', function (e) {
      if (!state.data) return;
      var cv = $('priceChart');
      if (!cv || document.activeElement !== cv) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(0.5, 1 / 1.35); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(0.5, 1.35); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); panBy(-Math.max(1, Math.round((state.view.count || 0) * 0.2))); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); panBy(Math.max(1, Math.round((state.view.count || 0) * 0.2))); }
      else if (e.key === '0') { e.preventDefault(); resetZoom(); }
    });

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { if (state.data) drawChart(); }, 160);
    });

    // 快捷鍵：/ 聚焦搜尋
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
      }
    });

    // 資料更新時間即時刷新
    setInterval(function () {
      if (state.data) {
        $('fUpdated').textContent = new Date(state.data.dataUpdatedAt)
          .toLocaleString('zh-TW', { hour12: false }) + '（' + timeAgo(state.data.dataUpdatedAt) + '）';
      }
    }, 30000);
  }

  /* ==================== 初始化 ==================== */
  function init() {
    bindEvents();
    bindChartInteraction();
    bindNotify();
    bindConnectionState();
    setStatus('就緒');

    registerServiceWorker();
    maybeShowIOSTip();

    /**
     * 路由註冊（common.js 提供）。
     *
     * predict：K 線預測頁，不自動查詢（顯示歡迎區）
     * detail ：詳情頁，依 hash 帶入的代碼自動查詢並顯示返回列
     *
     * 兩者共用同一份結果區塊，差別只在「有沒有返回列」與是否自動查詢。
     */
    SA.onRoute({
      onPredict: function () {
        $('detailBar').hidden = true;
        document.body.classList.remove('detail-mode');
        // 從詳情頁返回時保留已載入的結果，不清空（使用者會期待畫面還在）
        setStatus(state.data ? '已更新' : '就緒', state.data ? 'ok' : null);
      },
      onDetail: function (symbol) {
        $('detailBar').hidden = false;
        document.body.classList.add('detail-mode');
        if (!symbol) {
          SA.navigate('#/predict');
          return;
        }
        // 麵包屑要說清楚「現在在看哪一檔」，否則從選股結果點進來後
        // 使用者無從確認自己點的是不是那一列。
        var crumb = $('detailCrumb');
        if (crumb) crumb.textContent = symbol + '　個股詳情';
        // 已經在看同一檔就不重複查詢（例如從選股頁點進來後再按上一頁）
        if (state.data && state.data.meta && state.data.meta.symbol.toUpperCase() === symbol.toUpperCase()) {
          return;
        }
        $('symbolInput').value = symbol;
        $('clearBtn').hidden = false;
        analyze(symbol);
      },
    });

    // 支援 ?symbol= 直接查詢（分享連結 / Power BI 連結）。
    // 這是既有契約：帶 symbol 進來就自動查，且視為詳情模式。
    var params = new URLSearchParams(location.search);
    var sym = params.get('symbol');
    if (sym) {
      $('symbolInput').value = sym;
      $('clearBtn').hidden = false;
      // 這條路徑不經過 router，所以要自己把詳情模式的 UI 狀態補上
      $('detailBar').hidden = false;
      document.body.classList.add('detail-mode');
      var crumb0 = $('detailCrumb');
      if (crumb0) crumb0.textContent = sym + '　個股詳情';
      // 先手動切到 detail 路由，再由 router 觸發查詢（避免重複請求）
      if (!/^#\/detail\//.test(location.hash)) {
        location.replace('#/detail/' + encodeURIComponent(sym));
      }
      analyze(sym);
    } else {
      SA.startRouter();
    }

    if (sym) SA.startRouter();

    api('/api/health').then(function () { setStatus('就緒', 'ok'); })
      .catch(function () { setStatus('服務未連線', 'err'); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
