/* ===================================================
   宏觀與基本面頁（#/macro、#/macro/:symbol）

   依賴 window.SA（common.js 提供），不碰 app.js 內部函式。
   設計約束：
     1. 任一模組失敗不可整頁白屏 —— 每個區塊獨立顯示自己的錯誤。
     2. 「載入中 / 無資料 / 資料故障 / 本來就沒有」四種狀態必須分開，
        混在一起會讓使用者反覆重試一個註定失敗的模組（本專案已踩過）。
     3. 所有插入的動態字串一律走 SA.esc()，避免新聞/公司名帶 HTML。
   =================================================== */
(function (global) {
  'use strict';

  var SA = global.SA;
  if (!SA) return;

  var state = {
    scope: null,          // 'macro' | 'symbol'
    symbol: null,
    macro: null,
    dict: null,
    dictGroup: 'all',
    loading: false,
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 格式化 ---------------- */

  /**
   * 依單位決定顯示方式。
   *
   * 關鍵陷阱（實測踩到）：「單位」欄本身可能已經帶量級，
   * 例如「千人」「百萬美元」「十億美元（2017 年連鎖）」。
   * 若數值再套一層 K/M/B 縮寫，就會變成
   *   `24.7K 十億美元`（其實是 24.7 兆）
   *   `-404.1K 百萬美元`（其實是 -4041 億）
   *   `159.3K 千人`（其實是 1.59 億人）
   * 數學上等於同一個值，但讀起來是雙重換算，幾乎一定被誤讀。
   *
   * 因此規則改為：**單位已含量級時，數字照原樣加千分位，不再縮寫**。
   * 只有單位純粹是「%」「指數」「美元/歐元」這種不帶量級的，才允許縮寫。
   */
  function fmtValue(v, unit) {
    if (v == null || !isFinite(v)) return '—';
    var u = String(unit || '');

    // 單位本身帶量級詞 → 不可再縮寫
    var unitHasScale = /千人|百萬|十億|兆|萬|千美元|thousand|million|billion/i.test(u);
    if (unitHasScale) {
      var digits1 = /千人|百萬美元|十億美元/.test(u) ? 0 : 2;
      return SA.fmt(v, digits1);
    }

    if (/千人/.test(u)) return SA.fmt(v, 0);
    // 匯率需要 4 位小數：1.10 看不出 EUR/USD 當天的變動（實際 1.0981）
    if (/美元\/歐元|USD\/EUR/.test(u)) return SA.fmt(v, 4);
    if (Math.abs(v) >= 10000) return SA.fmtInt(v);
    return SA.fmt(v, 2);
  }

  /** 大額美元轉 B/M 顯示 */
  function fmtUsd(v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    return SA.fmt(v, 0);
  }

  function fmtPct(v, d) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + Number(v).toFixed(d == null ? 2 : d) + '%';
  }

  /** 來源標籤 */
  function sourceBadge(source) {
    var map = {
      FRED: { cls: 'src-fred', text: 'FRED' },
      'SEC EDGAR XBRL': { cls: 'src-sec', text: 'SEC' },
    };
    var m = map[source] || { cls: 'src-other', text: source || '—' };
    return '<span class="src-badge ' + m.cls + '">' + SA.esc(m.text) + '</span>';
  }

  /* ---------------- 四種狀態分開呈現 ---------------- */

  /**
   * 顯示提示條。
   * kind: loading | error | warn | info | degraded
   */
  function showNotice(html, kind) {
    var el = $('macroNotice');
    if (!el) return;
    if (!html) { el.hidden = true; el.innerHTML = ''; return; }
    el.className = 'macro-notice mn-' + (kind || 'info');
    el.innerHTML = html;
    el.hidden = false;
  }

  function hideNotice() {
    var el = $('macroNotice');
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  /* ---------------- 宏觀表格 ---------------- */

  function renderMacroTable(series) {
    var body = $('macroTableBody');
    if (!body) return;

    if (!Array.isArray(series) || !series.length) {
      body.innerHTML = '<tr><td colspan="6" class="mt-empty">沒有可顯示的宏觀指標</td></tr>';
      return;
    }

    var rows = series.map(function (s) {
      var nameCell = '<div class="mt-name">' + SA.esc(s.label || s.key) + '</div>'
        + (s.definition
          ? '<div class="mt-def">' + SA.esc(s.definition) + '</div>'
          : '');

      if (!s.available) {
        // 不可用：明確區分「已下線」與「暫時失敗」，不要都寫「載入失敗」
        var why = s.unavailable === 'retired' ? '此指標已停止公開提供'
          : s.unavailable === 'blocked' ? '來源限制存取'
            : '暫時無法取得';
        return '<tr class="row-unavail">'
          + '<td>' + nameCell + '</td>'
          + '<td class="ta-r mt-dim">—</td>'
          + '<td class="mt-dim">' + SA.esc(s.unit || '—') + '</td>'
          + '<td colspan="2" class="mt-dim">'
          + '<span class="unavail-tag">' + SA.esc(why) + '</span>'
          + (s.reason ? '<div class="mt-why">' + SA.esc(s.reason) + '</div>' : '')
          + '</td>'
          + '<td>' + (s.source ? sourceBadge(s.source) : '—') + '</td>'
          + '</tr>';
      }

      // 歷史百分位：視覺化成長條，讓「高／低」一眼可讀
      var pct = s.stats && s.stats.percentile != null ? s.stats.percentile : null;
      var pctCell = '—';
      if (pct != null) {
        var tone = pct >= 80 ? 'hi' : pct <= 20 ? 'lo' : 'mid';
        pctCell = '<div class="pct-wrap" title="歷史百分位 ' + pct + '（0=最低，100=最高）">'
          + '<div class="pct-bar"><i class="pct-fill ' + tone + '" style="width:' + Math.max(2, pct) + '%"></i></div>'
          + '<span class="pct-num">' + pct.toFixed(0) + '</span>'
          + '</div>';
      }

      // 值域異常標記
      var rangeFlag = s.plausible === 'out-of-range'
        ? '<span class="range-flag" title="數值超出登記合理值域，可能為資料異常">⚠️</span>' : '';

      return '<tr>'
        + '<td>' + nameCell + '</td>'
        + '<td class="ta-r mt-val">' + SA.esc(fmtValue(s.value, s.unit)) + rangeFlag + '</td>'
        + '<td class="mt-unit">' + SA.esc(s.unit || '—') + '</td>'
        + '<td class="mt-date">' + SA.esc(s.asOf || '—') + '</td>'
        + '<td class="ta-r">' + pctCell + '</td>'
        + '<td>' + sourceBadge(s.source) + '</td>'
        + '</tr>';
    }).join('');

    body.innerHTML = rows;

    var count = $('macroCount');
    if (count) {
      var ok = series.filter(function (s) { return s.available; }).length;
      count.textContent = ok + ' / ' + series.length + ' 可用';
    }
  }

  /* ---------------- FOMC ---------------- */

  function renderFomc(f) {
    var list = $('fomcList');
    var badge = $('fomcBadge');
    var nextEl = $('fomcNext');
    var noteEl = $('fomcNote');
    if (!list) return;

    if (!f || !f.available) {
      list.innerHTML = '<li class="mt-empty">'
        + SA.esc((f && f.reason) || '暫時無法取得 FOMC 日程') + '</li>';
      if (badge) badge.textContent = '不可用';
      if (nextEl) nextEl.hidden = true;
      if (noteEl) noteEl.textContent = '';
      return;
    }

    if (badge) badge.textContent = '下次 ' + (f.next ? f.next.date : '—');

    // 下次會議醒目卡
    if (nextEl && f.next) {
      nextEl.hidden = false;
      nextEl.innerHTML = '<div class="fn-label">下次會議</div>'
        + '<div class="fn-date">' + SA.esc(f.next.date) + '</div>'
        + '<div class="fn-sub">' + SA.esc(f.next.label) + '　·　距今 '
        + SA.esc(String(f.next.daysUntil)) + ' 天</div>';
    } else if (nextEl) {
      nextEl.hidden = true;
    }

    // 會議清單（已召開 + 即將召開合併，標記狀態）
    var items = []
      .concat((f.recent || []).slice().reverse().map(function (m) {
        return { m: m, status: 'past' };
      }))
      .concat((f.upcoming || []).map(function (m) {
        return { m: m, status: m.date === (f.next && f.next.date) ? 'next' : 'future' };
      }));

    list.innerHTML = items.map(function (it) {
      var st = it.status;
      var label = st === 'past' ? '已召開' : st === 'next' ? '即將召開' : '預定';
      return '<li class="fomc-item fomc-' + st + '">'
        + '<span class="fi-date">' + SA.esc(it.m.date) + '</span>'
        + '<span class="fi-label">' + SA.esc(it.m.label) + '</span>'
        + '<span class="fi-status">' + SA.esc(label) + '</span>'
        + '</li>';
    }).join('') || '<li class="mt-empty">沒有會議資料</li>';

    // 場次合理性警告
    var warns = (f.validations || []).filter(function (v) { return !v.ok; });
    if (noteEl) {
      noteEl.innerHTML = SA.esc(f.forecastNote || '')
        + (warns.length
          ? '<br><span class="text-warn">⚠️ ' + SA.esc(warns.map(function (w) {
            return w.issues.join('；');
          }).join('；')) + '</span>'
          : '');
    }
  }

  /* ---------------- 限制說明 ---------------- */

  function renderLimits(limitations) {
    var el = $('macroLimits');
    if (!el) return;
    if (!Array.isArray(limitations) || !limitations.length) {
      el.innerHTML = '<li class="mt-empty">—</li>';
      return;
    }
    el.innerHTML = limitations.map(function (t) {
      return '<li>' + SA.esc(t) + '</li>';
    }).join('');
  }

  /* ---------------- 資料字典 ---------------- */

  function renderDict(dict) {
    var body = $('dictBody');
    if (!body) return;

    if (!dict || !Array.isArray(dict.fields)) {
      body.innerHTML = '<tr><td colspan="6" class="mt-empty">資料字典無法取得</td></tr>';
      return;
    }

    state.dict = dict;

    var countEl = $('dictCount');
    if (countEl) countEl.textContent = dict.fields.length + ' 個欄位';

    var conv = $('dictConv');
    if (conv && Array.isArray(dict.conventions)) {
      conv.innerHTML = '<h3>口徑說明</h3><ul>'
        + dict.conventions.map(function (c) { return '<li>' + SA.esc(c) + '</li>'; }).join('')
        + '</ul>';
    }

    applyDictFilter();
  }

  function applyDictFilter() {
    var body = $('dictBody');
    if (!body || !state.dict) return;

    var fields = state.dict.fields.filter(function (f) {
      return state.dictGroup === 'all' || f.group === state.dictGroup;
    });

    if (!fields.length) {
      body.innerHTML = '<tr><td colspan="6" class="mt-empty">此分類沒有欄位</td></tr>';
      return;
    }

    body.innerHTML = fields.map(function (f) {
      var range = Array.isArray(f.range)
        ? '[' + SA.fmtInt(f.range[0]) + ', ' + SA.fmtInt(f.range[1]) + ']'
        : '—';

      var example = f.example != null
        ? '<span class="dict-ex">' + SA.esc(fmtValue(f.example, f.unit)) + '</span>'
          + (f.exampleAsOf ? '<div class="mt-why">' + SA.esc(f.exampleAsOf) + '</div>' : '')
        : '<span class="mt-dim">—</span>';

      return '<tr>'
        + '<td><div class="mt-name">' + SA.esc(f.label) + '</div>'
        + '<code class="dict-key">' + SA.esc(f.seriesId || f.key) + '</code></td>'
        + '<td class="dict-def">' + SA.esc(f.definition || '—')
        + (f.note ? '<div class="mt-why">' + SA.esc(f.note) + '</div>' : '')
        + '</td>'
        + '<td>' + (f.sourceUrl
          ? '<a class="dict-link" href="' + SA.esc(f.sourceUrl) + '" target="_blank" rel="noopener">'
            + SA.esc(f.source) + ' ↗</a>'
          : SA.esc(f.source || '—')) + '</td>'
        + '<td class="mt-unit">' + SA.esc(f.unit || '—')
        + '<div class="mt-why">' + SA.esc(f.freq || '') + (f.transform ? '　' + SA.esc(f.transform) : '') + '</div></td>'
        + '<td class="dict-range">' + SA.esc(range)
        + '<div class="mt-why">' + SA.esc(f.rangeNote || '') + '</div></td>'
        + '<td class="ta-r">' + example + '</td>'
        + '</tr>';
    }).join('');
  }

  /* ---------------- AI 解讀 ---------------- */

  function stanceMeta(stance) {
    var map = {
      hawkish: { cls: 'st-hawk', label: '偏緊' },
      dovish: { cls: 'st-dove', label: '偏鬆' },
      neutral: { cls: 'st-neutral', label: '中性' },
      mixed: { cls: 'st-mixed', label: '矛盾' },
      positive: { cls: 'st-pos', label: '正向' },
      negative: { cls: 'st-neg', label: '負向' },
      unknown: { cls: 'st-unknown', label: '資料不足' },
    };
    return map[stance] || map.unknown;
  }

  function renderInterp(interp, llm) {
    var list = $('interpList');
    var overallEl = $('interpOverall');
    var modeEl = $('interpMode');
    var gapsEl = $('interpGaps');
    var discEl = $('interpDisc');
    if (!list) return;

    list.innerHTML = '';
    if (overallEl) overallEl.hidden = true;
    if (gapsEl) gapsEl.hidden = true;

    if (!interp || interp.available === false) {
      // 「本來就沒有」與「失敗」要分開講
      var title = interp && interp.unavailable === 'not_applicable'
        ? '此標的不適用' : 'AI 解讀暫時無法產生';
      list.innerHTML = '<div class="interp-empty">'
        + '<strong>' + SA.esc(title) + '</strong>'
        + '<p>' + SA.esc((interp && interp.reason) || '沒有可解讀的資料') + '</p>'
        + (interp && interp.hint ? '<p class="mt-why">' + SA.esc(interp.hint) + '</p>' : '')
        + '</div>';
      if (modeEl) { modeEl.textContent = '—'; modeEl.className = 'badge'; }
      if (discEl) discEl.textContent = '';
      return;
    }

    if (modeEl) {
      var isLlm = llm && llm.mode === 'llm';
      modeEl.textContent = isLlm ? 'LLM 潤飾' : '規則型推理';
      modeEl.className = 'badge ' + (isLlm ? 'badge-ok' : 'badge-neutral');
      modeEl.title = isLlm
        ? '數字由規則層計算，LLM 僅改寫語氣'
        : '全部由確定性規則產生，零依賴、可重現';
    }

    // 綜合傾向
    if (overallEl && interp.overall) {
      var ov = interp.overall;
      var om = stanceMeta(ov.stance);
      overallEl.hidden = false;
      overallEl.className = 'interp-overall ' + om.cls;
      var c = ov.counts || {};
      overallEl.innerHTML = '<span class="io-tag">' + SA.esc(om.label) + '</span>'
        + '<div class="io-body"><strong>' + SA.esc(ov.text || '') + '</strong>'
        + '<div class="io-counts">偏緊 ' + (c.hawkish || 0)
        + '　偏鬆 ' + (c.dovish || 0)
        + '　矛盾 ' + (c.mixed || 0)
        + '　資料不足 ' + (c.unknown || 0) + '</div></div>';
    }

    // LLM 摘要
    if (llm && llm.text) {
      var sum = document.createElement('div');
      sum.className = 'interp-llm';
      sum.innerHTML = '<div class="illm-head">AI 摘要</div><p>' + SA.esc(llm.text) + '</p>';
      list.appendChild(sum);
    } else {
      // 即使沒有呼叫 LLM，也要說明「為什麼是規則型」——
      // 只掛一個「規則型推理」徽章而不解釋，使用者會以為是 AI 壞了。
      //
      // 措辭注意：/api/macro 這條路徑**根本沒有嘗試呼叫 LLM**，
      // 所以不能寫「未設定 API Key」（那是在斷言一件我們沒查證的事，
      // 使用者若確實設了 Key 會以為設定沒生效）。只描述確定的事實。
      var note = document.createElement('div');
      note.className = 'interp-llm-note';
      note.textContent = (llm && llm.note)
        || '本區解讀由確定性規則產生：每個數字都由程式自來源計算，'
          + '每條結論都列出依據，同一份資料每次得到相同結果。'
          + '（如需模型潤飾語氣，可用 mode=llm 另行呼叫，數字仍不經模型。）';
      list.appendChild(note);
    }

    // 逐條結論
    (interp.findings || []).forEach(function (f) {
      var m = stanceMeta(f.stance);
      var card = document.createElement('article');
      card.className = 'interp-card ' + m.cls;

      var evHtml = '';
      if (Array.isArray(f.evidence) && f.evidence.length) {
        evHtml = '<div class="ic-evidence"><div class="ice-head">依據</div><ul>'
          + f.evidence.map(function (e) {
            var val = e.unit === 'USD' ? fmtUsd(e.value) : fmtValue(e.value, e.unit);
            return '<li><span class="ice-k">' + SA.esc(e.label) + '</span>'
              + '<span class="ice-v">' + SA.esc(val)
              + (e.unit && e.unit !== 'USD' ? ' ' + SA.esc(e.unit) : '')
              + '</span>'
              + '<span class="ice-d">' + SA.esc(e.asOf || '') + '</span></li>';
          }).join('')
          + '</ul></div>';
      }

      card.innerHTML = '<div class="ic-head">'
        + '<span class="ic-tag ' + m.cls + '">' + SA.esc(m.label) + '</span>'
        + '<h3>' + SA.esc(f.headline) + '</h3>'
        + '</div>'
        + '<p class="ic-detail">' + SA.esc(f.detail) + '</p>'
        + evHtml
        // caveat 有的是後端加上的說明、有的本身就以 ⚠️ 開頭（如軟硬背離），
        // 這裡先去掉開頭的警告符號再統一補一個，避免出現「⚠️ ⚠️」。
        + (f.caveat
          ? '<p class="ic-caveat">⚠️ ' + SA.esc(String(f.caveat).replace(/^[⚠️\s]+/, '')) + '</p>'
          : '');

      list.appendChild(card);
    });

    // 資料缺口
    if (gapsEl && Array.isArray(interp.gaps) && interp.gaps.length) {
      gapsEl.hidden = false;
      gapsEl.innerHTML = '<strong>資料缺口</strong>：以下項目無法計算，未以推測值替代 —— '
        + interp.gaps.map(function (g) { return SA.esc(g); }).join('、');
    }

    if (discEl) discEl.textContent = interp.disclaimer || '';
  }

  /* ---------------- 資料載入 ---------------- */

  function setBusy(busy) {
    state.loading = busy;
    var btn = $('macroRefresh');
    if (btn) {
      btn.disabled = busy;
      var sp = btn.querySelector('.spinner');
      var lb = btn.querySelector('.btn-label');
      if (sp) sp.hidden = !busy;
      if (lb) lb.textContent = busy ? '載入中…' : '重新整理';
    }
  }

  function setStamp(text) {
    var el = $('macroStamp');
    if (el) el.textContent = text || '—';
  }

  /** 載入宏觀資料（含解讀） */
  function loadMacro(force) {
    setBusy(true);
    showNotice('<span class="mn-spin" aria-hidden="true"></span>'
      + '正在取得宏觀數據（18 個序列，首次約需 5–15 秒）…', 'loading');
    setStamp('載入中…');

    var title = $('macroTitle');
    var sub = $('macroSub');
    if (title) title.textContent = '宏觀經濟儀表板';
    if (sub) sub.textContent = '資料來源：FRED（聖路易斯聯準銀行）＋ Federal Reserve';

    return SA.api('/api/macro' + (force ? '?refresh=1' : ''))
      .then(function (d) {
        state.macro = d;
        state.scope = 'macro';
        state.symbol = null;

        renderMacroTable(d.series);
        renderFomc(d.fomc);
        renderLimits(d.limitations);
        renderInterp(d.interpretation, null);

        var st = d.status || {};
        setStamp('資料時間 ' + new Date(d.generatedAt).toLocaleString('zh-TW', { hour12: false }));

        if (st.degraded) {
          var names = (st.unavailableKeys || []).map(function (x) { return x.label; });
          showNotice('⚠️ 部分指標無法取得：' + SA.esc(names.join('、'))
            + '。其餘指標正常顯示。', 'degraded');
        } else {
          hideNotice();
        }

        // 若網址帶了 symbol，順便載入該股
        if (state.pendingSymbol) {
          var s = state.pendingSymbol;
          state.pendingSymbol = null;
          loadSymbol(s);
        }
      })
      .catch(function (err) {
        var info = SA.describeError(err);
        showNotice('<strong>' + SA.esc(info.title) + '</strong> '
          + SA.esc(info.message) + '　<span class="mn-hint">' + SA.esc(info.hint) + '</span>', 'error');
        setStamp('載入失敗');
        var body = $('macroTableBody');
        if (body) {
          body.innerHTML = '<tr><td colspan="6" class="mt-empty">' + SA.esc(info.message) + '</td></tr>';
        }
      })
      .then(function () {
        setBusy(false);
        state.pendingSymbol = null;
      });
  }

  /** 載入個股財報 */
  function loadSymbol(symbol) {
    if (!symbol) return Promise.resolve();
    setBusy(true);
    showNotice('<span class="mn-spin" aria-hidden="true"></span>'
      + '正在取得 ' + SA.esc(symbol) + ' 的財報與解讀…', 'loading');

    return SA.api('/api/macro/' + encodeURIComponent(symbol))
      .then(function (d) {
        state.scope = 'symbol';
        state.symbol = d.symbol;

        var title = $('macroTitle');
        var sub = $('macroSub');
        if (title) title.textContent = (d.fundamentals && d.fundamentals.entityName)
          ? d.fundamentals.entityName + '（' + d.symbol + '）' : d.symbol;
        if (sub) sub.textContent = '企業財報：SEC EDGAR XBRL　·　宏觀背景：FRED';

        // 財報表格：用 metrics 組出來
        renderFundamentalsTable(d.fundamentals, d.macroBackdrop);
        renderFomc(state.macro ? state.macro.fomc : null);
        renderLimits(d.fundamentals && d.fundamentals.gaps
          ? ['資料缺口：' + d.fundamentals.gaps.join('、')]
          : []);
        renderInterp(d.interpretation, null);

        setStamp('資料時間 ' + new Date(d.generatedAt).toLocaleString('zh-TW', { hour12: false }));

        if (!d.fundamentals || !d.fundamentals.available) {
          // 不是錯誤，是「本來就沒有」——用 warn 而非 error
          showNotice('ℹ️ ' + SA.esc((d.fundamentals && d.fundamentals.reason) || '此標的無財報資料')
            + (d.fundamentals && d.fundamentals.hint
              ? '<div class="mn-hint">' + SA.esc(d.fundamentals.hint) + '</div>' : ''), 'warn');
        } else {
          hideNotice();
        }
      })
      .catch(function (err) {
        var info = SA.describeError(err);
        showNotice('<strong>' + SA.esc(info.title) + '</strong> '
          + SA.esc(info.message) + '　<span class="mn-hint">' + SA.esc(info.hint) + '</span>', 'error');
      })
      .then(function () { setBusy(false); });
  }

  /** 把財報 metrics 渲染成表格（沿用 macro-table 樣式） */
  function renderFundamentalsTable(fund, backdrop) {
    var body = $('macroTableBody');
    if (!body) return;

    if (!fund || !fund.available) {
      body.innerHTML = '<tr><td colspan="6" class="mt-empty">'
        + SA.esc((fund && fund.reason) || '無財報資料') + '</td></tr>';
      var countEl = $('macroCount');
      if (countEl) countEl.textContent = '0 項';
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
        fmtUsd(m.revenue.value), 'USD', m.revenue.to, 'SEC EDGAR XBRL');
    }
    if (m.revenue && m.revenue.yoy != null) {
      row('營收年增率', '與去年同期比較（同基期口徑）',
        fmtPct(m.revenue.yoy), '%', m.revenue.to, 'SEC EDGAR XBRL');
    }
    if (m.netIncome) {
      row('淨利（' + m.netIncome.basis + '）', '扣除所有費用與稅後',
        fmtUsd(m.netIncome.value), 'USD', m.netIncome.to, 'SEC EDGAR XBRL');
    }
    if (m.grossMargin != null) {
      row('毛利率', '（營收 − 營業成本）/ 營收', SA.fmt(m.grossMargin), '%', fund.asOf, 'SEC EDGAR XBRL');
    }
    if (m.operatingMargin != null) {
      row('營業利益率', '營業利益 / 營收', SA.fmt(m.operatingMargin), '%', fund.asOf, 'SEC EDGAR XBRL');
    }
    if (m.netMargin != null) {
      row('淨利率', '淨利 / 營收', SA.fmt(m.netMargin), '%', fund.asOf, 'SEC EDGAR XBRL');
    }
    if (m.epsDiluted) {
      row('稀釋 EPS', '計入潛在稀釋效果', SA.fmt(m.epsDiluted.value), 'USD/share',
        m.epsDiluted.to, 'SEC EDGAR XBRL');
    }
    if (m.roe != null) {
      row('ROE', m.roeNote ? '淨利 / 股東權益（注意：權益偏小會使比率偏高）' : '淨利 / 股東權益',
        SA.fmt(m.roe), '%', fund.balance && fund.balance.equity ? fund.balance.equity.asOf : fund.asOf,
        'SEC EDGAR XBRL');
    }
    if (m.debtRatio != null) {
      row('負債比', '總負債 / 總資產', SA.fmt(m.debtRatio), '%', fund.asOf, 'SEC EDGAR XBRL');
    }

    // 宏觀背景
    if (backdrop) {
      if (backdrop.fedTargetUpper) {
        row('政策利率上限（背景）', 'FOMC 目標區間上緣',
          SA.fmt(backdrop.fedTargetUpper.value), '%', backdrop.fedTargetUpper.asOf, 'FRED');
      }
      if (backdrop.dgs10) {
        row('10 年期殖利率（背景）', '市場交易結果，非政策利率',
          SA.fmt(backdrop.dgs10.value), '%', backdrop.dgs10.asOf, 'FRED');
      }
      if (backdrop.termSpread) {
        row('10Y-2Y 利差（背景）', '負值代表殖利率倒掛',
          SA.fmt(backdrop.termSpread.value), '%', backdrop.termSpread.asOf, 'FRED');
      }
    }

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="mt-empty">此標的無可顯示的財務欄位</td></tr>';
      return;
    }

    body.innerHTML = rows.map(function (r) {
      return '<tr>'
        + '<td><div class="mt-name">' + SA.esc(r.label) + '</div>'
        + '<div class="mt-def">' + SA.esc(r.def) + '</div></td>'
        + '<td class="ta-r mt-val">' + SA.esc(r.value) + '</td>'
        + '<td class="mt-unit">' + SA.esc(r.unit) + '</td>'
        + '<td class="mt-date">' + SA.esc(r.asOf || '—') + '</td>'
        + '<td class="ta-r mt-dim">—</td>'
        + '<td>' + sourceBadge(r.source) + '</td>'
        + '</tr>';
    }).join('');

    var count = $('macroCount');
    if (count) count.textContent = rows.length + ' 項';
  }

  /* ---------------- 分頁 ---------------- */

  function switchTab(name) {
    var tabs = document.querySelectorAll('.mh-tab');
    Array.prototype.forEach.call(tabs, function (b) {
      var on = b.getAttribute('data-mtab') === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    var panels = { overview: $('tabOverview'), dict: $('tabDict'), interpret: $('tabInterpret') };
    Object.keys(panels).forEach(function (k) {
      if (panels[k]) panels[k].hidden = k !== name;
    });

    // 切到資料字典時才載入（避免多打一次 API）
    if (name === 'dict' && !state.dict) {
      var body = $('dictBody');
      if (body) body.innerHTML = '<tr><td colspan="6" class="mt-empty">載入中…</td></tr>';
      SA.api('/api/data-dict')
        .then(renderDict)
        .catch(function (err) {
          var info = SA.describeError(err);
          if (body) body.innerHTML = '<tr><td colspan="6" class="mt-empty">'
            + SA.esc(info.message) + '</td></tr>';
        });
    }
  }

  /* ---------------- 事件綁定 ---------------- */

  function bindEvents() {
    var refresh = $('macroRefresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        if (state.scope === 'symbol' && state.symbol) {
          loadSymbol(state.symbol);
        } else {
          loadMacro(true);
        }
      });
    }

    var form = $('macroSymbolForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = $('macroSymbol');
        var v = input ? String(input.value || '').trim() : '';
        if (!v) { if (input) input.focus(); return; }
        SA.navigate('#/macro/' + encodeURIComponent(v.toUpperCase()));
      });
    }

    var tabs = document.querySelectorAll('.mh-tab');
    Array.prototype.forEach.call(tabs, function (b) {
      b.addEventListener('click', function () {
        switchTab(b.getAttribute('data-mtab'));
      });
    });

    var filter = $('dictFilter');
    if (filter) {
      filter.addEventListener('click', function (e) {
        var btn = e.target.closest('.dict-chip');
        if (!btn) return;
        Array.prototype.forEach.call(filter.querySelectorAll('.dict-chip'), function (c) {
          c.classList.toggle('active', c === btn);
        });
        state.dictGroup = btn.getAttribute('data-dgroup');
        applyDictFilter();
      });
    }
  }

  /* ---------------- 路由進場 ---------------- */

  SA.onRoute({
    onMacro: function (symbol) {
      bindEvents();

      // 已經有宏觀資料就不重抓（換個網址參數不該重打 18 個序列）
      if (state.macro && !symbol) {
        state.scope = 'macro';
        state.symbol = null;
        renderMacroTable(state.macro.series);
        renderFomc(state.macro.fomc);
        renderLimits(state.macro.limitations);
        renderInterp(state.macro.interpretation, null);
        var t = $('macroTitle');
        var s = $('macroSub');
        if (t) t.textContent = '宏觀經濟儀表板';
        if (s) s.textContent = '資料來源：FRED（聖路易斯聯準銀行）＋ Federal Reserve';
        setStamp('資料時間 ' + new Date(state.macro.generatedAt).toLocaleString('zh-TW', { hour12: false }));
        switchTab('overview');
        return;
      }

      if (symbol) {
        // 有 symbol：先確保宏觀資料在手（作為背景），再載入個股
        if (state.macro) {
          renderFomc(state.macro.fomc);
          loadSymbol(symbol);
        } else {
          state.pendingSymbol = symbol;
          loadMacro(false);
        }
        switchTab('overview');
        return;
      }

      switchTab('overview');
      loadMacro(false);
    },
  });

  /* ---------------- 供測試使用 ---------------- */
  global.MacroPage = {
    state: state,
    fmtValue: fmtValue,
    fmtUsd: fmtUsd,
    stanceMeta: stanceMeta,
    loadMacro: loadMacro,
    loadSymbol: loadSymbol,
    switchTab: switchTab,
  };
})(window);
