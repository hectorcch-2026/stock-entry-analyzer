/* ===================================================
   AI 選股 — 前端邏輯
   依賴：common.js（window.SA）。不依賴 app.js 的內部函式。
   =================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var fmt = SA.fmt, pct = SA.pct, esc = SA.esc, clsOf = SA.clsOf, fmtInt = SA.fmtInt;

  var state = {
    loading: false,
    lastQuery: null,      // 上次查詢參數（供「重試」與「放寬條件」使用）
    rows: [],
    sortBy: 'score',
    sortDir: 'desc',
    meta: null,           // /api/screen/meta 的結果
    picksLoadedAt: null,
    loaded: false,        // 是否已載入過（避免每次切頁都重跑）
  };

  /* ==================== 篩選條件 ==================== */
  function readForm() {
    function num(id, dflt) {
      var el = $(id);
      if (!el) return dflt;
      var v = el.value.trim();
      if (!v) return dflt;
      var n = Number(v);
      return isFinite(n) ? n : dflt;
    }
    return {
      market: $('fMarket') ? $('fMarket').value : 'all',
      minScore: num('fMinScore', 55),
      maxDistAtr: num('fMaxDistAtr', 3),
      minPrice: num('fMinPrice', 1),
      maxAtrPct: num('fMaxAtrPct', 12),
      limit: num('fLimit', 30),
      requirePred: $('fRequirePred') ? $('fRequirePred').checked : false,
      sortBy: state.sortBy,
      sortDir: state.sortDir,
    };
  }

  function writeForm(o) {
    if (!o) return;
    if ($('fMarket')) $('fMarket').value = o.market || 'all';
    if ($('fMinScore')) $('fMinScore').value = o.minScore;
    if ($('fMaxDistAtr')) $('fMaxDistAtr').value = o.maxDistAtr;
    if ($('fMinPrice')) $('fMinPrice').value = o.minPrice;
    if ($('fMaxAtrPct')) $('fMaxAtrPct').value = o.maxAtrPct;
    if ($('fLimit')) $('fLimit').value = o.limit;
    if ($('fRequirePred')) $('fRequirePred').checked = !!o.requirePred;
  }

  function toQuery(o) {
    var q = [];
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (v === undefined || v === null || v === '') return;
      if (k === 'requirePred') {
        if (v) q.push('requirePred=1');
        return;
      }
      q.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return q.join('&');
  }

  /* ==================== 錯誤與狀態 ==================== */
  function clearScreenError() {
    var box = $('screenError');
    if (box) box.hidden = true;
  }

  function showScreenError(title, message, hint, actions) {
    var box = $('screenError');
    if (!box) return;
    box.hidden = false;
    $('screenErrorTitle').textContent = title;
    $('screenErrorMessage').textContent = message || '';
    $('screenErrorHint').textContent = hint || '';
    var wrap = $('screenErrorActions');
    wrap.innerHTML = '';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'err-btn';
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      wrap.appendChild(b);
    });
  }

  function setLoading(on, text) {
    state.loading = on;
    SA.setBusy($('screenBtn'), on, '篩選中…', '開始篩選');
    var ld = $('screenLoading');
    if (ld) ld.hidden = !on;
    var lt = $('screenLoadingText');
    if (lt && text) lt.textContent = text;
    if (on) {
      SA.setStatus('篩選中', 'busy');
      $('screenResult').hidden = false;
      $('screenEmpty').hidden = true;
      $('screenTableWrap').hidden = true;
      clearScreenError();
    }
  }

  /* ==================== 執行篩選 ==================== */
  /**
   * 送出前先自己驗一遍數字欄位。
   *
   * 為什麼要自己驗：這些欄位是 type=number，若值不符合 min/max/step，
   * 瀏覽器會在「提交」這一步直接攔掉——submit 事件根本不會觸發，
   * 使用者按下按鈕後畫面毫無反應，看起來就像壞掉了。
   * 這裡把攔截點拉到自己的程式碼裡，才能給出「哪一欄不對」的說明。
   */
  var NUM_FIELDS = [
    { id: 'fMinScore', label: '技術評分', min: 0, max: 100 },
    { id: 'fMaxDistAtr', label: '距買區', min: 0, max: 50 },
    { id: 'fMinPrice', label: '股價', min: 0, max: 1e9 },
    { id: 'fMaxAtrPct', label: '波動上限', min: 0.1, max: 100 },
    { id: 'fLimit', label: '結果筆數上限', min: 1, max: 200, integer: true },
  ];

  function validateForm() {
    for (var i = 0; i < NUM_FIELDS.length; i++) {
      var f = NUM_FIELDS[i];
      var el = $(f.id);
      if (!el) continue;
      var raw = String(el.value == null ? '' : el.value).trim();
      if (raw === '') return f.label + '不可留空。';
      var n = Number(raw);
      if (!isFinite(n)) return f.label + '必須是數字（目前是「' + raw + '」）。';
      if (f.integer && Math.round(n) !== n) return f.label + '必須是整數（目前是「' + raw + '」）。';
      if (n < f.min || n > f.max) {
        return f.label + '必須介於 ' + f.min + ' 與 ' + f.max + ' 之間（目前是「' + raw + '」）。';
      }
    }
    return null;
  }

  function runScreen(opts) {
    if (state.loading) return;

    // 無論從按鈕或程式呼叫，都先驗一次
    if (!opts) {
      var bad = validateForm();
      if (bad) {
        setLoading(false);
        $('screenResult').hidden = true;
        showScreenError('篩選條件有誤', bad, '請修正後再試一次，或按「恢復預設」帶回建議值。', [
          { label: '恢復預設條件', onClick: function () { resetForm(); } },
        ]);
        SA.setStatus('條件有誤', 'err');
        return;
      }
    }

    var o = opts || readForm();
    state.lastQuery = o;
    state.sortBy = o.sortBy || state.sortBy;
    state.sortDir = o.sortDir || state.sortDir;

    setLoading(true, '正在逐檔分析（' + (o.market === 'all' ? '全部市場' : o.market === 'hk' ? '港股' : '美股') + '）…');

    // 進度文案輪播：篩選要 8–15 秒，沒有變化的話使用者會以為卡住
    var ticks = 0;
    var msgs = [
      '正在逐檔分析…',
      '計算均線與波動指標…',
      '偵測支撐壓力與買入區間…',
      '套用篩選條件…',
      '排序並彙整結果…',
    ];
    var timer = setInterval(function () {
      ticks++;
      var lt = $('screenLoadingText');
      if (lt) lt.textContent = msgs[Math.min(ticks, msgs.length - 1)];
    }, 1800);

    SA.api('/api/screen?' + toQuery(o))
      .then(function (res) {
        clearInterval(timer);
        setLoading(false);
        state.rows = res.rows || [];
        // 保留完整統計，供本地重新排序時重用（重排不該讓統計列消失）
        state.lastStats = res.stats || {};
        renderResult(res);
        SA.setStatus('已更新', 'ok');
      })
      .catch(function (err) {
        clearInterval(timer);
        setLoading(false);
        state.rows = [];
        var desc = SA.describeError(err);

        // 參數錯誤屬於「使用者輸入問題」，顯示在錯誤卡並提供「恢復預設」，
        // 而不是丟一個空結果讓使用者一頭霧水。
        if (desc.kind === 'param') {
          showScreenError(desc.title, desc.message, desc.hint, [
            { label: '恢復預設條件', onClick: function () { resetForm(); } },
          ]);
          $('screenResult').hidden = true;
          SA.setStatus('條件有誤', 'err');
          return;
        }

        var retry = function () { runScreen(o); };
        showScreenError(desc.title, desc.message, desc.hint, [{ label: '重試', onClick: retry }]);
        if (desc.kind === 'offline') SA.showBar('目前離線，無法執行篩選。恢復連線後可重試。', 'stale');
        SA.setStatus('篩選失敗', 'err');
      });
  }

  /* ==================== 渲染結果 ==================== */
  function renderResult(res) {
    var st = res.stats || {};
    $('screenResult').hidden = false;
    $('screenTableWrap').hidden = true;
    $('screenEmpty').hidden = true;
    $('screenReasons').hidden = true;
    $('screenNote').hidden = true;

    var badge = $('screenStatsBadge');
    badge.textContent = st.returned != null
      ? (st.returned + ' / ' + st.passed + ' 檔')
      : '—';
    badge.className = 'badge badge-neutral';

    // --- 統計列 ---
    var stats = [];
    stats.push(['標的池', (st.pool || 0) + ' 檔']);
    stats.push(['已檢查', (st.checked || 0) + ' 檔']);
    stats.push(['符合條件', (st.passed || 0) + ' 檔']);
    if (st.excluded) stats.push(['條件不符', st.excluded + ' 檔']);
    if (st.failed) stats.push(['取數失敗', st.failed + ' 檔']);
    if (st.elapsedMs != null) stats.push(['耗時', (st.elapsedMs / 1000).toFixed(1) + ' 秒']);
    if (st.truncated) stats.push(['已截斷', '僅顯示前 ' + st.returned + ' 檔']);

    $('screenStats').innerHTML = stats.map(function (s) {
      return '<span class="ss-item"><span class="ss-k">' + esc(s[0]) + '</span>'
        + '<span class="ss-v">' + esc(s[1]) + '</span></span>';
    }).join('');

    // --- 無結果 ---
    if (!res.rows || !res.rows.length) {
      $('screenEmpty').hidden = false;
      var body = '已檢查 ' + (st.checked || 0) + ' 檔，沒有標的同時符合目前所有條件。';
      if (st.failed) body += '（其中 ' + st.failed + ' 檔取數失敗）';
      $('screenEmptyBody').textContent = body;

      var acts = $('screenEmptyActions');
      acts.innerHTML = '';

      // 依排除原因給「放寬哪一條最有效」的建議，而不是只叫使用者「再試試」
      var reasons = st.excludeReasons || [];
      if (reasons.length) {
        var box = $('screenReasons');
        box.hidden = false;
        box.innerHTML = '<p class="sr-title">主要被排除的原因（依出現次數）</p>'
          + '<div class="sr-list">'
          + reasons.map(function (r) {
            return '<span class="sr-item"><span class="sr-c">' + r.count + '</span>'
              + esc(r.reason) + '</span>';
          }).join('')
          + '</div>';
      }

      addRelaxActions(acts, reasons);
      return;
    }

    // --- 表格 ---
    $('screenTableWrap').hidden = false;
    $('screenBody').innerHTML = res.rows.map(function (r) {
      var dirCls = r.distAtr == null ? '' : r.distAtr <= 0 ? 'in-zone' : r.distAtr <= 1 ? 'near' : '';
      return '<tr class="sc-row" data-symbol="' + esc(r.symbol) + '" tabindex="0">'
        + '<td class="st-sym">'
        + '<span class="st-code">' + esc(r.symbol) + '</span>'
        + '<span class="st-name">' + esc(r.name || '') + '</span>'
        + '</td>'
        + '<td class="num">' + fmt(r.price) + (r.currency ? ' <span class="st-cur">' + esc(r.currency) + '</span>' : '') + '</td>'
        + '<td class="num ' + clsOf(r.changePct) + '">' + pct(r.changePct) + '</td>'
        + '<td class="num"><span class="st-score ' + scoreCls(r.score) + '">' + (r.score == null ? '—' : r.score) + '</span></td>'
        + '<td class="num ' + dirCls + '">' + (r.distAtr == null ? '—' : r.distAtr + ' ATR') + '</td>'
        + '<td class="num">' + (r.atrPct == null ? '—' : r.atrPct.toFixed(1) + '%') + '</td>'
        + '<td class="num">' + (r.rrRatio == null ? '—' : r.rrRatio + ' : 1') + '</td>'
        + '<td class="st-verdict">' + verdictPill(r.verdict) + '</td>'
        + '<td class="st-act"><button type="button" class="row-btn" data-symbol="' + esc(r.symbol) + '">詳情 →</button></td>'
        + '</tr>';
    }).join('');

    bindRowClicks();

    if (st.timedOut) {
      var note = $('screenNote');
      note.hidden = false;
      note.textContent = '⚠️ ' + (st.notes && st.notes.length ? st.notes[st.notes.length - 1] : '已達單輪時間上限，結果可能不完整。');
    } else if (st.notes && st.notes.length) {
      var note2 = $('screenNote');
      note2.hidden = false;
      note2.textContent = 'ℹ️ ' + st.notes.join('；');
    }

    updateSortIndicators();
  }

  function scoreCls(s) {
    if (s == null) return '';
    if (s >= 75) return 'sc-high';
    if (s >= 60) return 'sc-mid';
    return 'sc-low';
  }

  function verdictPill(v) {
    if (!v) return '—';
    var tone = v.tone === 'positive' ? 'vp-pos' : v.tone === 'negative' ? 'vp-neg' : 'vp-neu';
    return '<span class="verdict-pill ' + tone + '">' + esc(v.label || '—') + '</span>';
  }

  function addRelaxActions(container, reasons) {
    var acts = [
      { label: '評分放寬到 40', apply: { minScore: 40 } },
      { label: '距買區放寬到 6 ATR', apply: { maxDistAtr: 6 } },
      { label: '恢復預設條件', apply: null },
    ];
    acts.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'err-btn';
      b.textContent = a.label;
      b.addEventListener('click', function () {
        if (!a.apply) { resetForm(); return; }
        var cur = readForm();
        Object.keys(a.apply).forEach(function (k) { cur[k] = a.apply[k]; });
        writeForm(cur);
        runScreen(cur);
      });
      container.appendChild(b);
    });
  }

  function bindRowClicks() {
    Array.prototype.forEach.call(document.querySelectorAll('#screenBody .row-btn'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        goDetail(b.dataset.symbol);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#screenBody .sc-row'), function (tr) {
      tr.addEventListener('click', function () { goDetail(tr.dataset.symbol); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goDetail(tr.dataset.symbol); }
      });
    });
  }

  function goDetail(symbol) {
    if (!symbol) return;
    // 以 hash 導航，讓瀏覽器上一頁可以直接回到選股結果
    SA.navigate('#/detail/' + encodeURIComponent(symbol));
  }

  /* ==================== 排序 ==================== */
  function bindSort() {
    Array.prototype.forEach.call(document.querySelectorAll('.st-sort'), function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sort;
        if (state.sortBy === key) {
          state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          state.sortBy = key;
          state.sortDir = 'desc';
        }
        // 已有結果時在本地重排（不必重跑整個篩選，那是 8–15 秒的事）
        if (state.rows.length) {
          state.rows = sortRows(state.rows, state.sortBy, state.sortDir);
          renderResult({ rows: state.rows, stats: state.lastStats || {} });
        } else {
          updateSortIndicators();
        }
      });
    });
  }

  function sortRows(rows, key, dir) {
    var d = dir === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      var an = av == null || !isFinite(av);
      var bn = bv == null || !isFinite(bv);
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      if (av === bv) return 0;
      return (av - bv) * d;
    });
  }

  function updateSortIndicators() {
    Array.prototype.forEach.call(document.querySelectorAll('.st-sort'), function (th) {
      var on = th.dataset.sort === state.sortBy;
      th.classList.toggle('sorted', on);
      // aria-sort 讓螢幕閱讀器也能讀出目前排序方向，不只靠視覺箭頭
      if (on) th.setAttribute('aria-sort', state.sortDir === 'desc' ? 'descending' : 'ascending');
      else th.removeAttribute('aria-sort');
      var ind = th.querySelector('.sort-ind');
      if (ind) ind.textContent = on ? (state.sortDir === 'desc' ? '▼' : '▲') : '';
    });
  }

  /* ==================== 每日清單 ==================== */
  function loadPicks(opts) {
    var force = opts && opts.force;
    if (state.loading) return;
    setLoading(true, force ? '正在重跑今日清單（約 8–30 秒）…' : '正在檢查今日清單…');

    var qs = force ? '?run=1' : '?preview=1';

    SA.api('/api/picks' + qs)
      .then(function (res) {
        // 更新排程資訊（無論有無資料都要顯示「今日有沒有」）
        renderSchedule(res);

        if (res.rows && res.rows.length) {
          setLoading(false);
          state.rows = res.rows;
          state.lastStats = res.stats || {};
          renderResult({ rows: res.rows, stats: res.stats || {} });
          var badge = $('screenStatsBadge');
          badge.textContent = res.ran ? '今日清單（剛產生）' : '今日清單';
          badge.className = 'badge high';
          var note = $('screenNote');
          note.hidden = false;
          note.textContent = 'ℹ️ 清單基準日 ' + res.key + '，產生於 '
            + new Date(res.generatedAt).toLocaleString('zh-TW', { hour12: false })
            + '（耗時 ' + ((res.durationMs || 0) / 1000).toFixed(1) + ' 秒）。排序與篩選可在此結果上直接操作。';
          SA.setStatus('已載入清單', 'ok');
          return;
        }

        // 尚未產生：以一般訪問模式觸發惰性補跑
        setLoading(true, '今日清單尚未產生，正在補跑（約 8–30 秒）…');
        return SA.api('/api/picks')
          .then(function (res2) {
            setLoading(false);
            renderSchedule(res2);
            if (res2.rows && res2.rows.length) {
              state.rows = res2.rows;
              state.lastStats = res2.stats || {};
              renderResult({ rows: res2.rows, stats: res2.stats || {} });
              var b2 = $('screenStatsBadge');
              b2.textContent = '今日清單（已補跑）';
              b2.className = 'badge high';
              SA.setStatus('已補跑今日清單', 'ok');
            } else {
              $('screenResult').hidden = false;
              $('screenEmpty').hidden = false;
              $('screenEmptyBody').textContent = '今日清單沒有符合條件的標的（' + (res2.reason || '') + '）。';
              SA.setStatus('今日無資料', 'err');
            }
          });
      })
      .catch(function (err) {
        setLoading(false);
        var desc = SA.describeError(err);
        showScreenError(desc.title, desc.message, desc.hint, [
          { label: '改用即時篩選', onClick: function () { runScreen(); } },
        ]);
        SA.setStatus('清單載入失敗', 'err');
      });
  }

  function renderSchedule(res) {
    var sc = res.schedule || {};
    if ($('scSettle')) $('scSettle').textContent = (sc.settleMinutes || 30) + ' 分鐘';
    if ($('scToday')) {
      $('scToday').textContent = res.generatedAt
        ? new Date(res.generatedAt).toLocaleString('zh-TW', { hour12: false })
        : (res.reason || '尚未產生');
    }
    if ($('scHistory')) {
      var h = res.history || [];
      $('scHistory').textContent = h.length ? h.join('、') : '（尚無）';
    }
    if ($('scCron')) {
      $('scCron').textContent = sc.inProcessCron
        ? '已啟用（每 30 分鐘檢查）'
        : '未啟用（免費方案休眠後無效，改由訪問觸發）';
    }
  }

  /* ==================== 表單事件 ==================== */
  function resetForm() {
    var d = (state.meta && state.meta.defaults) || {};
    writeForm({
      market: d.market || 'all',
      minScore: d.minScore != null ? d.minScore : 55,
      maxDistAtr: d.maxDistAtr != null ? d.maxDistAtr : 3,
      minPrice: d.minPrice != null ? d.minPrice : 1,
      maxAtrPct: d.maxAtrPct != null ? d.maxAtrPct : 12,
      limit: d.limit != null ? d.limit : 30,
      requirePred: false,
    });
    state.sortBy = 'score';
    state.sortDir = 'desc';
    updateSortIndicators();
    clearScreenError();
    $('screenResult').hidden = true;
    $('screenEmpty').hidden = true;
    SA.setStatus('就緒');
  }

  function bindEvents() {
    var form = $('screenForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        runScreen();
      });
    }
    if ($('screenReset')) $('screenReset').addEventListener('click', resetForm);
    if ($('screenPicks')) {
      $('screenPicks').addEventListener('click', function () { loadPicks(); });
    }
    bindSort();
  }

  /* ==================== 初始化（切到選股頁時） ==================== */
  function init() {
    if (state.loaded) return;
    state.loaded = true;

    bindEvents();

    // 取回預設值與母體大小（不在前端硬編碼，避免兩邊漂移）
    SA.api('/api/screen/meta')
      .then(function (m) {
        state.meta = m;
        if (m.defaults) writeForm(m.defaults);
        var total = m.pool ? m.pool.total : 0;
        if ($('poolBadge')) $('poolBadge').textContent = '標的池 ' + total + ' 檔';
        // 注意：不能用 textContent 覆寫 #screenHint —— 它內部有 #poolCountHint
        // 這個 span，覆寫會把 span 整個銷毀。改用 innerHTML 重建同一段結構。
        var hint = $('screenHint');
        if (hint && m.pool) {
          hint.innerHTML = '篩選是在本機伺服器即時計算：美股 ' + m.pool.us + ' 檔 + 港股 '
            + m.pool.hk + ' 檔，共 <span id="poolCountHint">' + m.pool.total
            + '</span> 檔，約需 8–15 秒。條件放寬可得到更多結果。';
        }
      })
      .catch(function () {
        // 取不到中繼資料不影響篩選（表單已有合理的預設值）
      });

    // 先問「今日清單有沒有」，有就直接顯示（毫秒級），沒有則提示可補跑。
    // 這樣切到選股頁時不會一進去就卡 15 秒。
    SA.api('/api/picks?preview=1')
      .then(function (res) {
        renderSchedule(res);
        if (res.rows && res.rows.length) {
          state.rows = res.rows;
          state.lastStats = res.stats || {};
          renderResult({ rows: res.rows, stats: res.stats || {} });
          var badge = $('screenStatsBadge');
          badge.textContent = '今日清單';
          badge.className = 'badge high';
        }
      })
      .catch(function () { /* 沒有清單不是錯誤 */ });
  }

  /* ==================== 註冊路由 ==================== */
  SA.onRoute({
    onScreen: function () {
      init();
      SA.setStatus('選股', 'ok');
    },
  });

  // 進入選股頁的初始化一律由 router 的 onScreen 觸發（含直接以 #/screen 開啟），
  // 這裡不需要額外的 DOMContentLoaded 掛鉤。
})();
