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
    /*
     * 版塊輪動前置開啟時，排序交給伺服器的四鍵排序（版塊優先），
     * 所以 sortBy 傳 'sector'。關閉時沿用使用者在表頭點的欄位。
     *
     * 為什麼不讓使用者自己選「版塊優先」這個排序：
     * 版塊優先只有在有版塊歸屬時才有意義。若讓它獨立成一個排序選項，
     * 使用者可以在沒開版塊流程時選它 —— 那時它會靜默退回評分排序，
     * 變成一個「選了但沒作用」的選項。綁在開關上就不可能誤用。
     */
    var sectorFlow = $('fSectorFlow') ? $('fSectorFlow').checked : false;
    return {
      market: $('fMarket') ? $('fMarket').value : 'all',
      minScore: num('fMinScore', 55),
      maxDistAtr: num('fMaxDistAtr', 3),
      minPrice: num('fMinPrice', 1),
      maxAtrPct: num('fMaxAtrPct', 12),
      limit: num('fLimit', 30),
      requirePred: $('fRequirePred') ? $('fRequirePred').checked : false,
      sortBy: sectorFlow ? 'sector' : state.sortBy,
      sortDir: state.sortDir,
      sectorFlow: sectorFlow,
      sectorTopN: $('fSectorTopN') ? Number($('fSectorTopN').value) || 2 : 2,
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
    if ($('fSectorFlow')) $('fSectorFlow').checked = o.sectorFlow !== false;
    if ($('fSectorTopN') && o.sectorTopN) $('fSectorTopN').value = String(o.sectorTopN);
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
      /*
       * sectorFlow / sectorTopN 只在開啟時送出。
       * 送 sectorFlow=0 也可以（伺服器會走一般篩選），但少一個參數
       * 能讓快取 key 更短、也讓「沒帶參數 = 一般篩選」這條向後相容
       * 規則永遠成立。
       */
      if (k === 'sectorFlow') {
        if (v) q.push('sectorFlow=1');
        return;
      }
      if (k === 'sectorTopN') {
        if (o.sectorFlow) q.push('sectorTopN=' + encodeURIComponent(v));
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

        /*
         * 版塊流程的失敗是「200 但 ok:false」——不是 HTTP 錯誤。
         *
         * 為什麼伺服器要用 200：階段一／階段二算不出來不是「請求錯誤」，
         * 而是「這一輪市場或資料源不允許」，重試可能就好了。用 4xx/5xx
         * 會讓快取、CDN、前端錯誤處理全部誤判成程式壞掉。
         *
         * 但前端絕不能因為 200 就當成成功 —— 那會顯示一份空表格，
         * 使用者會以為「今天沒有符合條件的股票」。必須走錯誤卡，
         * 並明確說出是哪一階段失敗、可以改用什麼。
         */
        if (res.ok === false && res.sectorFlow) {
          var sf = res.sectorFlow;
          state.rows = [];
          state.lastStats = {};
          $('screenResult').hidden = true;
          // 版塊表仍可顯示（失敗時可能已有部分版塊資料），讓使用者看得到依據
          if (res.sectors && res.sectors.length) {
            $('screenResult').hidden = false;
            renderSectorFlow({
              sectorFlow: {
                enabled: true, topN: sf.topN, sectors: res.sectors,
                funnel: res.funnel || {}, bySector: {},
                favoredSummary: res.favoredSummary || { picked: [] },
              },
              sectors: res.sectors,
              rows: [],
            });
          }
          showScreenError(
            '版塊輪動流程無法完成',
            sf.message || '版塊或標的池的計算失敗。',
            sf.hint || '可改用不含版塊前置的一般篩選（取消勾選「版塊輪動前置」）。',
            [
              { label: '改用一般篩選', onClick: function () {
                if ($('fSectorFlow')) $('fSectorFlow').checked = false;
                runScreen();
              } },
              { label: '重試', onClick: function () { runScreen(o); } },
            ]
          );
          SA.setStatus('版塊流程失敗', 'err');
          return;
        }

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

  /* ===================================================
     版塊輪動流程 — 表 A（版塊總覽）與表 B（漏斗）
     =================================================== */

  var VERDICT_CN = { favored: '優勢', watch: '觀察', avoid: '迴避' };

  function renderSectorFlow(res) {
    var wrap = $('sectorFlowWrap');
    if (!wrap) return;

    var flow = res.sectorFlow;
    var sectors = res.sectors || [];

    // 沒有版塊流程資料 → 整塊隱藏（一般篩選不該出現空白表格）
    if (!flow || !flow.enabled || !sectors.length) {
      wrap.hidden = true;
      setSectorColumns(false);
      return;
    }

    wrap.hidden = false;
    setSectorColumns(!!(res.rows && res.rows.length && res.rows[0].sector));

    /* ---- 表 A：版塊總覽 ---- */

    // 中繼資訊：時間週期、基準、資料截止日
    var metaBits = [];
    if (flow.timeframe) metaBits.push(flow.timeframe === 'weekly' ? '週線' : flow.timeframe === 'daily' ? '日線' : '月線');
    if (flow.benchmarkKey) metaBits.push('基準 ' + flow.benchmarkKey);
    if (flow.asOf) metaBits.push('資料至 ' + flow.asOf);
    if (flow.topN) metaBits.push('取前 ' + flow.topN + ' 名');
    $('sectorFlowMeta').textContent = metaBits.join('｜');

    /*
     * 需求要求明示「本次依哪些版塊」。這句話必須由資料組出來，
     * 不能寫死 —— 否則版塊一換（例如改取前 3）文字就開始騙人。
     */
    var picked = (flow.favoredSummary && flow.favoredSummary.picked) || [];
    /*
     * 「實際取用」的名單必須用物件查表，不能靠 verdict 判斷。
     * verdict 是「這個版塊的象限是否合格」，可能同時有 6 個合格；
     * picked 才是「本次真的取用了哪 N 個」。兩者混用會讓畫面上的
     * 綠色版塊數與漏斗的池內檔數互相矛盾。
     */
    var pickedKeys = {};
    picked.forEach(function (s) { pickedKeys[String(s.key).toUpperCase()] = true; });

    var basis = $('sectorFlowBasis');
    if (picked.length) {
      var names = picked.map(function (s) {
        return '<strong>' + esc(s.key) + '</strong>（' + esc(s.label) + '，'
          + (s.strengthScore == null ? '—' : s.strengthScore) + ' 分，'
          + esc(s.quadrantLabel || '') + '）';
      }).join('、');
      var txt = '本次依 RRG ' + esc(flow.timeframe === 'weekly' ? '週線' : '輪動')
        + '，取強弱分數前 ' + flow.topN + ' 名且位於領先／改善象限的版塊：' + names + '。';
      if (flow.favoredSummary.note) txt += ' ' + esc(flow.favoredSummary.note);
      basis.innerHTML = txt;
      basis.hidden = false;
    } else {
      basis.hidden = true;
    }

    $('sectorFlowBody').innerHTML = sectors.map(function (s) {
      /*
       * 三種狀態要分清楚，不能只靠 verdict：
       *
       *   verdict = 'favored' ─ 象限合格（可能是 6 個版塊）
       *   picked  = 真的被取用 ─ 只有前 N 名（可能是 2 個）
       *
       * 若把「象限合格」全部標成優勢綠底，畫面會顯示 6 個綠色版塊，
       * 但下面的漏斗說只有 2 個版塊的股票進了池 —— 兩個數字互相矛盾，
       * 使用者會懷疑其中一個算錯了。實際上兩者都對，差別在「合格」
       * 與「取用」，必須在標籤上就分開。
       */
      var isPicked = pickedKeys[String(s.key).toUpperCase()] === true;
      var isFav = s.verdict === 'favored';
      var rowCls = isPicked ? 'is-favored' : s.verdict === 'avoid' ? 'is-avoid' : '';

      var verdictLabel;
      var verdictCls;
      if (isPicked) {
        verdictLabel = '優勢・已取';
        verdictCls = 'favored';
      } else if (isFav) {
        verdictLabel = '優勢・未取';
        verdictCls = 'watch';
      } else {
        verdictLabel = VERDICT_CN[s.verdict] || s.verdict;
        verdictCls = s.verdict;
      }

      // cross 的「下一步」：只在有信心時才顯示，否則留白避免誤導
      var next = s.cross && s.cross.nextCn
        ? esc(s.cross.nextCn) + (s.cross.confidence === 'high' ? ' <span class="fc-note">(高)</span>' : '')
        : '—';
      var members = flow.bySector && flow.bySector[String(s.key).toUpperCase()] != null
        ? flow.bySector[String(s.key).toUpperCase()]
        : null;
      /*
       * 「池內檔數」：入選版塊顯示實際入池數；未入選顯示 0。
       * 不顯示破折號 —— 破折號代表「沒算」，而 0 是明確的答案。
       * 母體成員數放在 title 裡，讓使用者能分辨「版塊本來就小」與
       * 「版塊很大但這輪沒取用」。
       */
      var memberText = isPicked && members != null ? members : '0';
      var memberTitle = s.memberCountInUniverse != null
        ? ' title="該版塊在母體中共 ' + s.memberCountInUniverse + ' 檔"'
        : '';
      var rowTitle = isFav && !isPicked
        ? ' title="象限合格，但名次在 topN 之外，為控制成本本次未取用"'
        : '';
      return '<tr class="' + rowCls + '"' + rowTitle + '>'
        + '<td class="num">' + (s.rank == null ? '—' : s.rank) + '</td>'
        + '<td><span class="sf-sector-cell">'
        + '<span class="sf-sector-dot" style="background:' + esc(s.color || '#94a3b8') + '"></span>'
        + '<span class="sf-sector-key">' + esc(s.key) + '</span>'
        + '<span class="sf-sector-name">' + esc(s.short || s.label || '') + '</span>'
        + '</span></td>'
        + '<td class="num">' + (s.strengthScore == null ? '—' : s.strengthScore.toFixed(1)) + '</td>'
        + '<td class="num">' + (s.ratio == null ? '—' : s.ratio.toFixed(1)) + '</td>'
        + '<td class="num">' + (s.momentum == null ? '—' : s.momentum.toFixed(1)) + '</td>'
        + '<td>' + esc(s.quadrantLabel || '—') + '</td>'
        + '<td>' + next + '</td>'
        + '<td class="num"' + memberTitle + '>' + memberText + '</td>'
        + '<td><span class="sf-verdict sfv-' + esc(verdictCls) + '">'
        + esc(verdictLabel) + '</span></td>'
        + '</tr>';
    }).join('');

    /* ---- 表 B：漏斗 ---- */

    var f = flow.funnel || {};
    var rows = [];

    rows.push({ cls: 'is-total', marker: '', label: '母體（在美上市個股，已排除中概股）', count: f.universe });

    /*
     * 「無版塊歸屬」必須獨立一列，且非 0 要標紅。
     * 它代表資料管線異常（持股檔截斷／抓取失敗），不是「這些股票不合格」。
     * 併進「版塊未入選」會讓異常看起來像正常的策略結果。
     */
    rows.push({
      cls: f.unknownSector > 0 ? 'is-warn' : '',
      marker: '├─',
      label: '無版塊歸屬'
        + (f.unknownSector > 0 ? '（資料異常，請檢查持股檔）' : '（正常）'),
      count: f.unknownSector,
    });

    rows.push({
      cls: '',
      marker: '├─',
      label: '版塊未入選（不在前 ' + (flow.topN || 2) + ' 名優勢版塊）',
      count: f.notFavored,
    });

    rows.push({ cls: 'is-result', marker: '└─', label: '進入本次標的池', count: f.dynamicPool });

    $('sectorFunnel').innerHTML = rows.map(function (r) {
      return '<div class="funnel-row ' + r.cls + '">'
        + '<span class="funnel-label"><span class="funnel-marker">' + r.marker + '</span>'
        + esc(r.label) + '</span>'
        + '<span class="funnel-count">' + (r.count == null ? '—' : fmtInt(r.count)) + ' 檔</span>'
        + '</div>';
    }).join('');

    // 覆蓋率說明：正常時一句話，異常時明確要求檢查
    var cov = $('sectorCoverage');
    var c = flow.coverage || {};
    if (c.healthy) {
      cov.className = 'sf-coverage';
      cov.textContent = '母體 ' + (c.universe || 0) + ' 檔全部完成版塊歸屬（0 檔未歸屬）。';
    } else {
      cov.className = 'sf-coverage is-warn';
      cov.innerHTML = '⚠️ 母體 ' + (c.universe || 0) + ' 檔中有 <strong>'
        + (c.unknownSector || 0) + '</strong> 檔查不到版塊歸屬 —— 這代表持股檔異常或上限截斷，'
        + '請檢查 SECTOR_UNKNOWN 清單，而不是放寬篩選條件。';
    }
  }

  /**
   * 控制「所屬版塊 / 版塊名次」兩欄的顯示。
   *
   * 為什麼要動態開關而不是一直顯示：
   * 一般篩選（沒開版塊流程）時這兩欄必然是空的。留著兩欄空白會讓表格
   * 多出 180px 寬度且看起來像壞掉。用 JS 依資料有無切換，
   * 讓同一張表在兩種模式下都乾淨。
   */
  function setSectorColumns(on) {
    var ths = document.querySelectorAll('#screenTableWrap thead .st-sector, #screenTableWrap thead .st-sector-rank');
    Array.prototype.forEach.call(ths, function (th) { th.hidden = !on; });
  }

  /* ==================== 渲染結果 ==================== */
  function renderResult(res) {
    var st = res.stats || {};
    $('screenResult').hidden = false;
    $('screenTableWrap').hidden = true;
    $('screenEmpty').hidden = true;
    $('screenReasons').hidden = true;
    $('screenNote').hidden = true;

    // 版塊流程的兩張表：有資料才顯示，一般篩選時整塊隱藏
    renderSectorFlow(res);

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
    /*
     * 中概股排除數一定要出現在統計列，即使它是 0。
     *
     * 為什麼 0 也要顯示：使用者要能分辨「規則跑了但沒命中」與「規則根本
     * 沒生效」。只顯示大於 0 的數字，會讓 0 的情況看起來像沒這條規則，
     * 於是下一次真的命中時，使用者會以為是新加的 bug。
     */
    if (st.chinaExcluded) {
      stats.push(['已排除中概股', st.chinaExcluded.count + ' 檔']);
    }
    if (st.nonUsExcluded) {
      stats.push(['已排除非美股', st.nonUsExcluded.count + ' 檔']);
    }
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
    var showSector = res.rows.some(function (r) { return !!r.sector; });
    setSectorColumns(showSector);

    $('screenBody').innerHTML = res.rows.map(function (r) {
      var dirCls = r.distAtr == null ? '' : r.distAtr <= 0 ? 'in-zone' : r.distAtr <= 1 ? 'near' : '';
      /*
       * 版塊兩欄：只有版塊流程才有值。沒值時輸出空儲存格
       * （而不是「—」），因為整欄會被 setSectorColumns 隱藏，
       * 顯示破折號只是多餘的視覺噪音。
       */
      var sectorCells = '<td class="st-sector">'
        + (r.sector
          ? '<span class="st-sector-chip"><span class="sf-sector-key">' + esc(r.sector) + '</span>'
            + (r.sectorLabel ? esc(r.sectorLabel) : '') + '</span>'
          : '')
        + '</td>'
        + '<td class="num st-sector-rank">' + (r.sectorRank == null ? '' : '#' + r.sectorRank) + '</td>';
      return '<tr class="sc-row" data-symbol="' + esc(r.symbol) + '" tabindex="0">'
        + '<td class="st-sym">'
        + '<span class="st-code">' + esc(r.symbol) + '</span>'
        + '<span class="st-name">' + esc(r.name || '') + '</span>'
        + '</td>'
        + sectorCells
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

    /*
     * 集中度提示 —— 需求要求明示「前 10 名有 N 檔來自某版塊；
     * 若改按個股評分排序，前 10 名會變動 M 檔」。
     *
     * 這是版塊優先排序的已知代價，必須主動說出來。使用者要靠這兩個數字
     * 決定要「順風集中」還是「分散」，藏起來等於替他做了決定。
     */
    var noteLines = [];
    if (st.concentration && st.concentration.note) {
      noteLines.push('📊 ' + st.concentration.note);
    }
    if (st.timedOut) {
      noteLines.push('⚠️ ' + (st.notes && st.notes.length ? st.notes[st.notes.length - 1] : '已達單輪時間上限，結果可能不完整。'));
    } else if (st.notes && st.notes.length) {
      noteLines.push('ℹ️ ' + st.notes.join('；'));
    }
    if (noteLines.length) {
      var note = $('screenNote');
      note.hidden = false;
      note.innerHTML = noteLines.map(esc).join('<br>');
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

  /**
   * 依「最主要被排除的原因」給對應的放寬按鈕。
   *
   * 原本不論原因一律給同樣三個選項，等於沒回答「該放寬哪一條」。
   * 現在以 reasons[0].code（後端已按次數排序）決定第一顆按鈕，
   * 其餘仍保留通用選項，讓使用者還是能自行調整。
   */
  function addRelaxActions(container, reasons) {
    var top = (reasons && reasons[0] && reasons[0].code) || null;
    var byCode = {
      score: { label: '評分放寬到 40', apply: { minScore: 40 } },
      distAtr: { label: '距買區放寬到 6 ATR', apply: { maxDistAtr: 6 } },
      price: { label: '股價下限降到 0', apply: { minPrice: 0 } },
      atrPct: { label: '波動上限放寬到 20%', apply: { maxAtrPct: 20 } },
      avgVol: { label: '移除均量下限', apply: { minAvgVol: 0 } },
      pred: { label: '不要求區間預測', apply: { requirePred: false } },
    };
    var acts = [];
    if (top && byCode[top]) acts.push(byCode[top]);
    acts.push({ label: '評分放寬到 40', apply: { minScore: 40 } });
    acts.push({ label: '距買區放寬到 6 ATR', apply: { maxDistAtr: 6 } });
    acts.push({ label: '恢復預設條件', apply: null });

    // 去重：主因對應的按鈕可能與通用選項重複
    var seen = {};
    acts = acts.filter(function (a) {
      if (seen[a.label]) return false;
      seen[a.label] = true;
      return true;
    });

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

    /*
     * 版塊開關：關閉時把「優勢版塊數」一起禁用。
     *
     * 為什麼要禁用而不是留著：一個可選但沒有作用的控制項，會讓使用者
     * 以為它已經生效。禁用後游標一移上去就知道「這要開啟版塊前置才有用」。
     */
    var flowToggle = $('fSectorFlow');
    if (flowToggle) {
      var syncFlow = function () {
        var on = flowToggle.checked;
        if ($('fSectorTopN')) $('fSectorTopN').disabled = !on;
        if ($('fMarket')) $('fMarket').disabled = on;
        /*
         * market 在版塊模式下由伺服器強制為 all（池內全是美股，
         * 兩者等價，但顯式設定避免歧義）。因此把下拉禁用，
         * 免得使用者切到 hk 卻發現沒反應。
         */
      };
      flowToggle.addEventListener('change', syncFlow);
      syncFlow();
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
          /*
           * 這裡的字要跟著母體規則走。舊版寫「美股 N 檔 + 港股 M 檔」，
           * 母體改成純美股後若不改，就會出現「港股 0 檔」這種
           * 看起來像壞掉的文案 —— 事實上是規則改了，不是資料掉了。
           */
          var excl = m.pool.excluded && m.pool.excluded.chinaAdr
            ? m.pool.excluded.chinaAdr.count : 0;
          hint.innerHTML = '篩選是在本機伺服器即時計算：標的池為在美國交易所上市的 '
            + '<span id="poolCountHint">' + total + '</span>'
            + ' 檔個股（已排除中概股 ' + excl + ' 檔）'
            + '。母體較大，單輪有時間上限，'
            + '未跑完時會標示「僅檢查 N 檔」。條件放寬可得到更多結果。';
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
