/* ===================================================
   買入位與技術位分析系統 — 前端應用
   零外部依賴：搜尋自動完成、Canvas K 線圖、響應式渲染
   =================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    data: null,
    overlays: { ma: true, levels: true, boll: false, vol: false },
    hoverIndex: null,
    chartGeom: null,
    suggestTimer: null,
    suggestIndex: -1,
    suggestItems: [],
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
        if (data.assumedMarket === 'HK') {
          $('symbolInput').value = data.meta.symbol;
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
    var series = d.series.daily;
    if (!series || series.length < 2) return;

    var c = setupCanvas();
    var ctx = c.ctx, W = c.w, H = c.h;
    ctx.clearRect(0, 0, W, H);

    var showVol = state.overlays.vol;
    var padL = 8, padR = 62, padT = 14, padB = 26;
    var volH = showVol ? Math.max(44, H * 0.16) : 0;
    var plotH = H - padT - padB - volH - (showVol ? 8 : 0);
    var plotW = W - padL - padR;

    // --- 計算數列 ---
    var closes = series.map(function (x) { return x.c; });
    var maDefs = [{ p: 5, color: COLORS.ma5 }, { p: 10, color: COLORS.ma10 }, { p: 20, color: COLORS.ma20 }, { p: 60, color: COLORS.ma60 }];
    var maSeries = maDefs.map(function (m) { return { p: m.p, color: m.color, data: sma(closes, m.p) }; });
    var bollData = state.overlays.boll ? bollinger(closes, 20, 2) : null;

    // --- Y 軸範圍 ---
    var vis = series.map(function (x) { return { h: x.h, l: x.l }; });
    var lo = Math.min.apply(null, vis.map(function (x) { return x.l; }));
    var hi = Math.max.apply(null, vis.map(function (x) { return x.h; }));
    var pool = [];
    if (state.overlays.ma) maSeries.forEach(function (m) { m.data.forEach(function (v) { if (v != null) pool.push(v); }); });
    if (bollData) { bollData.upper.concat(bollData.lower).forEach(function (v) { if (v != null) pool.push(v); }); }
    d.levels.supports.forEach(function (s) { pool.push(s.price); });
    d.levels.resistances.forEach(function (s) { pool.push(s.price); });
    pool.push(d.buyZone.lower, d.buyZone.upper);

    var poolMin = pool.length ? Math.min.apply(null, pool) : lo;
    var poolMax = pool.length ? Math.max.apply(null, pool) : hi;
    var padY = (hi - lo) * 0.08;
    lo = Math.min(lo, poolMin) - padY;
    hi = Math.max(hi, poolMax) + padY;
    if (hi <= lo) { hi = lo + 1; }

    var n = series.length;
    var slot = plotW / n;
    var bw = Math.max(1.2, Math.min(11, slot * 0.62));

    var xOf = function (i) { return padL + slot * i + slot / 2; };
    var yOf = function (v) { return padT + plotH * (1 - (v - lo) / (hi - lo)); };

    state.chartGeom = { xOf: xOf, yOf: yOf, slot: slot, padL: padL, padT: padT, plotW: plotW, plotH: plotH, series: series, lo: lo, hi: hi, n: n };

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

    // --- 買入區間帶 ---
    if (state.overlays.levels) {
      var yUpper = yOf(d.buyZone.upper), yLower = yOf(d.buyZone.lower);
      ctx.fillStyle = COLORS.zone;
      ctx.fillRect(padL, yUpper, plotW, Math.max(2, yLower - yUpper));
      ctx.strokeStyle = COLORS.zoneEdge;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      [yUpper, yLower].forEach(function (y) {
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      });
      // 停損 / 目標
      ctx.strokeStyle = COLORS.down;
      ctx.beginPath(); ctx.moveTo(padL, yOf(d.buyZone.stopLoss)); ctx.lineTo(padL + plotW, yOf(d.buyZone.stopLoss)); ctx.stroke();
      ctx.strokeStyle = COLORS.up;
      ctx.beginPath(); ctx.moveTo(padL, yOf(d.buyZone.target)); ctx.lineTo(padL + plotW, yOf(d.buyZone.target)); ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- 支撐壓力線 ---
    if (state.overlays.levels) {
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1.2;
      d.levels.supports.forEach(function (s) { hline(ctx, yOf(s.price), padL, padL + plotW, COLORS.support); });
      d.levels.resistances.forEach(function (s) { hline(ctx, yOf(s.price), padL, padL + plotW, COLORS.resistance); });
      ctx.setLineDash([]);
    }

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

    // --- 均線 ---
    if (state.overlays.ma) {
      maSeries.forEach(function (m) { linePlot(ctx, m.data, xOf, yOf, m.color, 1.5, []); });
    }

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

  function renderLegend(d, maSeries) {
    var items = [];
    if (state.overlays.ma) maSeries.forEach(function (m) {
      items.push('<span><i class="lg-line" style="background:' + m.color + '"></i>MA' + m.p + '</span>');
    });
    if (state.overlays.boll) items.push('<span style="color:' + COLORS.boll + '"><i class="lg-dash"></i>布林通道 20,2</span>');
    if (state.overlays.levels) {
      items.push('<span><i class="lg-line" style="background:' + COLORS.support + '"></i>支撐</span>');
      items.push('<span><i class="lg-line" style="background:' + COLORS.resistance + '"></i>壓力</span>');
      items.push('<span><i class="lg-line" style="background:' + COLORS.zoneEdge + '"></i>建議買入區間</span>');
      items.push('<span><i class="lg-line" style="background:' + COLORS.down + '"></i>停損</span>');
      items.push('<span><i class="lg-line" style="background:' + COLORS.up + '"></i>目標</span>');
    }
    if (state.overlays.vol) items.push('<span>下方柱狀為成交量</span>');
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
  function bindChartInteraction() {
    var cv = $('priceChart');
    var tip = $('chartTooltip');

    function onMove(clientX, clientY) {
      var g = state.chartGeom;
      if (!g) return;
      var rect = cv.getBoundingClientRect();
      var x = clientX - rect.left;
      var idx = Math.floor((x - g.padL) / g.slot);
      idx = Math.max(0, Math.min(g.n - 1, idx));
      state.hoverIndex = idx;
      drawChart();

      var b = g.series[idx];
      var dt = new Date(b.t);
      var chg = b.o ? ((b.c - b.o) / b.o) * 100 : 0;
      tip.innerHTML = '<strong>' + dt.toLocaleDateString('zh-TW') + '</strong><br>'
        + '開 ' + fmt(b.o) + '　高 ' + fmt(b.h) + '<br>'
        + '低 ' + fmt(b.l) + '　收 ' + fmt(b.c) + '<br>'
        + '漲跌 ' + pct(chg, 2) + '　量 ' + fmtInt(b.v);
      tip.hidden = false;
      tip.style.left = Math.min(rect.width - 70, Math.max(70, g.xOf(idx))) + 'px';
      tip.style.top = Math.max(80, g.yOf(b.c) - 8) + 'px';
    }

    cv.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); });
    cv.addEventListener('mouseleave', function () {
      state.hoverIndex = null;
      tip.hidden = true;
      drawChart();
    });
    cv.addEventListener('touchstart', function (e) {
      if (e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    cv.addEventListener('touchmove', function (e) {
      if (e.touches[0]) { onMove(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }
    }, { passive: false });
    cv.addEventListener('touchend', function () {
      setTimeout(function () { state.hoverIndex = null; tip.hidden = true; drawChart(); }, 1200);
    });
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
        drawChart();
      });
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

    // 支援 ?symbol= 直接查詢（方便分享與 Power BI 連結）
    var params = new URLSearchParams(location.search);
    var sym = params.get('symbol');
    if (sym) {
      $('symbolInput').value = sym;
      $('clearBtn').hidden = false;
      analyze(sym);
    }

    api('/api/health').then(function () { setStatus('就緒', 'ok'); })
      .catch(function () { setStatus('服務未連線', 'err'); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
