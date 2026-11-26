"""
ISM 製造業 PMI 雙源接入與交叉驗證
=================================

主源：DBnomics Python 庫（序列 ISM/pmi/pm）
備援：AKShare ``ak.macro_usa_pmi()``

⚠️ 重要現況（2026-11-26 實測，見 docs/ISM_PMI_接入方案.md）
--------------------------------------------------------------------------
兩個來源目前都取不到可用的美國 ISM 製造業 PMI：

1. **DBnomics 可拉取，但主序列自 2025-09 起數值損壞**
   `pmi` 在 2025-09 之後為 11.1 / 10.0 / 10.0 / 10.3。
   PMI 是擴散指數、榮枯線固定 50，實務不可能低於 30；
   同時 12 個分項（neword/production/...）全部平滑連續，僅主序列斷裂，
   指向單一欄位抓取錯誤。本模組**不會**把這些值當成有效資料。

2. **AKShare 的 ``macro_usa_pmi`` 已在 1.20.42 移除**
   原因：金十數據於 2025-09 停止更新經濟指標頁面並遷移到微信小程序，
   官方明示「美国、欧元区的其余指标暂无替代接口」。
   AKShare 內已無任何美國 ISM/PMI 函式（僅剩中國 PMI）。

因此本模組的預設行為是：
  * 兩源都嘗試拉取（保留完整能力，未來修復即可自動恢復）；
  * 以「合理性檢查」擋掉損壞值，不讓它流入下游；
  * 每輪輸出明確警示，指出哪一源失效、原因為何、可改用什麼；
  * 仍完整執行雙源比對邏輯，一旦任一源恢復即自動開始真正比對。

設計原則
--------
* 所有網路呼叫都有重試 + 指數退避，失敗不靜默。
* 欄位一律正規化為 (period, value, source, fetched_at) 的 tidy 結構。
* 時間對齊以「月」為單位（period = YYYY-MM），避免時區與日粒度誤差。
* 比對結果為結構化資料（StatusReport），可直接寫 JSON / 印出 / 發告警。

執行
----
    python -m ism_pmi_pipeline --once          # 跑一次
    python -m ism_pmi_pipeline --check-env     # 只檢查環境與兩源可用性
    python -m ism_pmi_pipeline --install-cron  # 印出每月排程安裝方式
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------

#: DBnomics 序列識別碼（provider/dataset/series）
DBNOMICS_SERIES = "ISM/pmi/pm"

#: PMI 擴散指數的合理值域。低於 30 在實務上從未出現，視為資料錯誤。
PMI_MIN_PLAUSIBLE = 30.0
PMI_MAX_PLAUSIBLE = 80.0

#: 單月變動超過此值視為可疑（歷史上最大單月波動約 15 點）
PMI_MAX_MONTHLY_JUMP = 20.0

#: 資料新鮮度上限（天）。超過即判定為過期。
STALE_AFTER_DAYS = 90

#: 兩源數值比對容差（PMI 通常公布到小數一位）
VALUE_TOLERANCE = 0.05

#: 重試設定
RETRY_ATTEMPTS = 4
RETRY_BASE_DELAY = 1.5  # 秒，指數退避
REQUEST_TIMEOUT = 30

#: 產出位置
DEFAULT_STATE_DIR = Path(__file__).resolve().parent.parent / "data" / "ism_pmi"

log = logging.getLogger("ism_pmi")


# ---------------------------------------------------------------------------
# 資料模型
# ---------------------------------------------------------------------------


@dataclass
class SeriesPoint:
    """單一觀測值（正規化後）。"""

    period: str          # YYYY-MM
    value: float
    source: str          # "dbnomics" | "akshare"
    fetched_at: str      # ISO 8601 UTC

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class FetchResult:
    """單一來源的拉取結果。"""

    source: str
    ok: bool = False
    points: List[SeriesPoint] = field(default_factory=list)
    error: Optional[str] = None
    attempts: int = 0
    elapsed_ms: int = 0
    notes: List[str] = field(default_factory=list)

    @property
    def latest(self) -> Optional[SeriesPoint]:
        """最新月份的觀測值（依 period 排序後取最後一筆）。"""
        if not self.points:
            return None
        return max(self.points, key=lambda p: p.period)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "ok": self.ok,
            "n_points": len(self.points),
            "latest": self.latest.as_dict() if self.latest else None,
            "error": self.error,
            "attempts": self.attempts,
            "elapsed_ms": self.elapsed_ms,
            "notes": self.notes,
        }


@dataclass
class StatusReport:
    """雙源比對的完整結果。"""

    run_at: str
    status: str                       # "ok" | "warn" | "critical"
    primary: FetchResult
    backup: FetchResult
    comparisons: List[Dict[str, Any]] = field(default_factory=list)
    alerts: List[Dict[str, str]] = field(default_factory=list)
    recommended_value: Optional[float] = None
    recommended_period: Optional[str] = None
    recommended_source: Optional[str] = None
    #: 建議值是否已過期。True 代表這是「最後一個可信的歷史值」，
    #: 而非當月最新值——下游不可當成 current reading 使用。
    recommended_is_stale: bool = False

    def as_dict(self) -> Dict[str, Any]:
        return {
            "run_at": self.run_at,
            "status": self.status,
            "primary": self.primary.as_dict(),
            "backup": self.backup.as_dict(),
            "comparisons": self.comparisons,
            "alerts": self.alerts,
            "recommended": {
                "value": self.recommended_value,
                "period": self.recommended_period,
                "source": self.recommended_source,
                "is_stale": self.recommended_is_stale,
                "note": ("已過期，僅為最後一個可信的歷史值，不可視為當月最新值"
                         if self.recommended_is_stale else "當期有效值"),
            },
        }


# ---------------------------------------------------------------------------
# 工具：重試、正規化、合理性檢查
# ---------------------------------------------------------------------------


def retry_call(fn, *, what: str, attempts: int = RETRY_ATTEMPTS,
               base_delay: float = RETRY_BASE_DELAY):
    """帶指數退避的重試包裝。

    只重試「可能為暫時性」的錯誤；程式設計錯誤（TypeError/AttributeError）
    直接拋出，避免無意義重試掩蓋真正的 bug。
    """
    non_retryable = (TypeError, AttributeError, KeyError, ImportError, NameError)
    last_exc: Optional[BaseException] = None

    for i in range(1, attempts + 1):
        try:
            return True, fn(), i, None
        except non_retryable as exc:
            log.error("%s 發生不可重試的錯誤：%s", what, exc)
            return False, None, i, f"{type(exc).__name__}: {exc}"
        except Exception as exc:  # noqa: BLE001 — 網路/解析錯誤都要能退避重試
            last_exc = exc
            if i == attempts:
                break
            delay = base_delay ** i
            log.warning("%s 第 %d/%d 次失敗（%s），%.1fs 後重試",
                        what, i, attempts, exc, delay)
            time.sleep(delay)

    return False, None, attempts, f"{type(last_exc).__name__}: {last_exc}"


def to_month(value: Any) -> Optional[str]:
    """把各種日期表示正規化成 YYYY-MM。

    DBnomics 給的是 `2025-08-01`（period 欄），AKShare 給的是 `2025年08月份`
    或 `2025-08`，都要能吃下。
    """
    if value is None:
        return None

    # datetime / date
    if hasattr(value, "strftime"):
        return value.strftime("%Y-%m")

    s = str(value).strip()
    if not s:
        return None

    # 2025年08月份 / 2025年8月
    if "年" in s:
        try:
            year, rest = s.split("年", 1)
            month = rest.replace("月份", "").replace("月", "").strip()
            return f"{int(year):04d}-{int(month):02d}"
        except (ValueError, TypeError):
            return None

    # 2025-08 / 2025-08-01 / 2025/08/01
    s2 = s.replace("/", "-")
    parts = s2.split("-")
    if len(parts) >= 2:
        try:
            return f"{int(parts[0]):04d}-{int(parts[1]):02d}"
        except (ValueError, TypeError):
            return None

    return None


def month_to_date(period: str) -> datetime:
    """YYYY-MM → 該月 1 日（UTC），用於新鮮度計算。"""
    year, month = period.split("-")
    return datetime(int(year), int(month), 1, tzinfo=timezone.utc)


def months_between(period_a: str, period_b: str) -> int:
    """兩個 YYYY-MM 相差幾個月（a - b）。"""
    ay, am = (int(x) for x in period_a.split("-"))
    by, bm = (int(x) for x in period_b.split("-"))
    return (ay - by) * 12 + (am - bm)


def plausibility_issues(points: List[SeriesPoint]) -> List[str]:
    """檢查數列是否有不可能的數值。

    這是本模組的核心防線：DBnomics 的 ISM 主序列目前是壞的，
    沒有這層檢查就會把「PMI=10」當成「製造業崩壞」的訊號送給下游。
    """
    issues: List[str] = []
    if not points:
        return ["序列為空"]

    ordered = sorted(points, key=lambda p: p.period)

    out_of_range = [p for p in ordered
                    if not (PMI_MIN_PLAUSIBLE <= p.value <= PMI_MAX_PLAUSIBLE)]
    if out_of_range:
        sample = ", ".join(f"{p.period}={p.value}" for p in out_of_range[:5])
        issues.append(
            f"{len(out_of_range)} 筆超出合理值域 "
            f"[{PMI_MIN_PLAUSIBLE}, {PMI_MAX_PLAUSIBLE}]：{sample}"
            + (" …" if len(out_of_range) > 5 else "")
        )

    jumps = []
    for prev, cur in zip(ordered, ordered[1:]):
        delta = abs(cur.value - prev.value)
        if delta > PMI_MAX_MONTHLY_JUMP:
            jumps.append(f"{prev.period}→{cur.period} 跳動 {delta:.1f}")
    if jumps:
        issues.append(f"{len(jumps)} 處單月異常跳動（>{PMI_MAX_MONTHLY_JUMP}）："
                      + "；".join(jumps[:3]))

    return issues


def drop_implausible(points: List[SeriesPoint]) -> Tuple[List[SeriesPoint], List[str]]:
    """剔除不合理的觀測值，回傳（乾淨資料, 被剔除的說明）。

    做法：從最新月份往前掃，遇到第一個不合理值就把它與其後所有值丟棄，
    因為資料損壞通常是「從某月開始一路錯下去」，而非單點跳動。
    """
    ordered = sorted(points, key=lambda p: p.period)
    cut_at: Optional[int] = None

    for idx in range(len(ordered) - 1, -1, -1):
        v = ordered[idx].value
        if not (PMI_MIN_PLAUSIBLE <= v <= PMI_MAX_PLAUSIBLE):
            cut_at = idx
        else:
            # 一旦遇到合理值就停：更早的值維持不動
            break

    if cut_at is None:
        return ordered, []

    dropped = ordered[cut_at:]
    kept = ordered[:cut_at]
    detail = (f"丟棄 {len(dropped)} 筆不合理值 "
              f"（{dropped[0].period} 起的 {', '.join(f'{p.value}' for p in dropped[:4])}）")
    return kept, [detail]


def stale_check(period: str, run_at: datetime) -> Optional[str]:
    """檢查資料月份是否過期。"""
    if not period:
        return "無資料月份"
    age_days = (run_at - month_to_date(period)).days
    if age_days > STALE_AFTER_DAYS:
        return f"最新月份 {period} 距今 {age_days} 天（>{STALE_AFTER_DAYS} 天）"
    return None


# ---------------------------------------------------------------------------
# 來源一：DBnomics
# ---------------------------------------------------------------------------


def fetch_dbnomics(series_id: str = DBNOMICS_SERIES) -> FetchResult:
    """以序列代碼從 DBnomics 拉取完整歷史。

    使用官方 Python 庫 `dbnomics.fetch_series`，走的是 DBnomics 的 JSON API，
    不涉及任何網頁反爬處理。
    """
    started = time.time()
    result = FetchResult(source="dbnomics")
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def _do():
        from dbnomics import fetch_series  # 延遲匯入：沒裝也能跑備援
        df = fetch_series(series_id, timeout=REQUEST_TIMEOUT)
        if df is None or len(df) == 0:
            raise RuntimeError(f"DBnomics 回傳空資料集：{series_id}")
        return df

    ok, df, attempts, err = retry_call(_do, what=f"DBnomics 拉取 {series_id}")
    result.attempts = attempts
    result.elapsed_ms = int((time.time() - started) * 1000)

    if not ok:
        result.error = err
        return result

    try:
        points: List[SeriesPoint] = []
        # 優先使用 period 欄（DBnomics 已正規化為日期），退回 original_period
        period_col = "period" if "period" in df.columns else "original_period"
        for _, row in df.iterrows():
            period = to_month(row.get(period_col))
            raw = row.get("value")
            if period is None or raw is None:
                continue
            try:
                val = float(raw)
            except (TypeError, ValueError):
                continue
            points.append(SeriesPoint(period=period, value=val,
                                      source="dbnomics", fetched_at=fetched_at))

        if not points:
            result.error = "解析後無有效觀測值"
            return result

        result.ok = True
        result.points = points
        result.notes.append(f"序列 {series_id}，共 {len(points)} 筆，"
                            f"{points[0].period} ~ {points[-1].period}")
        return result

    except Exception as exc:  # noqa: BLE001
        result.error = f"解析失敗：{type(exc).__name__}: {exc}"
        return result


# ---------------------------------------------------------------------------
# 來源二：AKShare
# ---------------------------------------------------------------------------


def fetch_akshare() -> FetchResult:
    """以 AKShare 拉取美國 ISM 製造業 PMI（備援源）。

    AKShare 在 1.20.42 移除了 ``macro_usa_pmi``。本函式會：
      * 若函式存在 → 正常拉取；
      * 若不存在 → 回傳明確的「接口已移除」錯誤，而不是丟出例外中斷流程。
    """
    started = time.time()
    result = FetchResult(source="akshare")
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def _do():
        import akshare as ak

        if not hasattr(ak, "macro_usa_pmi"):
            raise LookupError(
                "ak.macro_usa_pmi 不存在（AKShare 1.20.42 起已移除；"
                "因金十數據 2025-09 停止更新經濟指標頁面）。"
                "AKShare 目前無美國 PMI 替代接口。"
            )
        df = ak.macro_usa_pmi()
        if df is None or len(df) == 0:
            raise RuntimeError("AKShare 回傳空資料集")
        return df

    ok, df, attempts, err = retry_call(_do, what="AKShare 拉取 macro_usa_pmi",
                                       attempts=2)  # 接口不存在時重試無意義，只試 2 次
    result.attempts = attempts
    result.elapsed_ms = int((time.time() - started) * 1000)

    if not ok:
        result.error = err
        return result

    try:
        # AKShare 的欄位名在不同版本間變動過，逐一嘗試
        period_candidates = ["日期", "月份", "date", "Date", "period"]
        value_candidates = ["今值", "现值", "值", "value", "Value", "PMI"]

        period_col = next((c for c in period_candidates if c in df.columns), None)
        value_col = next((c for c in value_candidates if c in df.columns), None)

        if period_col is None or value_col is None:
            result.error = (f"無法識別欄位，實際欄位為 {list(df.columns)}；"
                            f"預期含期間欄 {period_candidates} 與數值欄 {value_candidates}")
            return result

        points: List[SeriesPoint] = []
        for _, row in df.iterrows():
            period = to_month(row.get(period_col))
            raw = row.get(value_col)
            if period is None or raw is None:
                continue
            try:
                val = float(raw)
            except (TypeError, ValueError):
                continue
            points.append(SeriesPoint(period=period, value=val,
                                      source="akshare", fetched_at=fetched_at))

        if not points:
            result.error = "解析後無有效觀測值"
            return result

        result.ok = True
        result.points = points
        result.notes.append(f"共 {len(points)} 筆，"
                            f"{points[0].period} ~ {points[-1].period}")
        return result

    except Exception as exc:  # noqa: BLE001
        result.error = f"解析失敗：{type(exc).__name__}: {exc}"
        return result


# ---------------------------------------------------------------------------
# 交叉驗證
# ---------------------------------------------------------------------------


def compare_sources(primary: FetchResult, backup: FetchResult,
                    run_at: datetime) -> Tuple[List[Dict[str, Any]],
                                               List[Dict[str, str]],
                                               Optional[SeriesPoint]]:
    """比對兩源，回傳（逐項比對結果, 警示清單, 建議採用的觀測值）。"""
    comparisons: List[Dict[str, Any]] = []
    alerts: List[Dict[str, str]] = []
    chosen: Optional[SeriesPoint] = None

    p_latest = primary.latest
    b_latest = backup.latest

    # --- 1. 拉取成敗 ---------------------------------------------------
    if not primary.ok:
        alerts.append({
            "level": "critical",
            "code": "PRIMARY_FETCH_FAILED",
            "message": f"主源 DBnomics 拉取失敗：{primary.error}",
        })
    if not backup.ok:
        alerts.append({
            "level": "warning",
            "code": "BACKUP_UNAVAILABLE",
            "message": f"備援源 AKShare 不可用：{backup.error}",
        })

    # --- 2. 期間比對 ---------------------------------------------------
    if p_latest and b_latest:
        diff_months = months_between(p_latest.period, b_latest.period)
        comparisons.append({
            "item": "期間",
            "primary": p_latest.period,
            "backup": b_latest.period,
            "match": diff_months == 0,
            "detail": "一致" if diff_months == 0
                      else f"相差 {abs(diff_months)} 個月"
                           f"（{'主源較新' if diff_months > 0 else '備援較新'}）",
        })
        if diff_months != 0:
            alerts.append({
                "level": "warning",
                "code": "PERIOD_MISMATCH",
                "message": (f"最新月份不一致：主源 {p_latest.period}、"
                            f"備援 {b_latest.period}（差 {abs(diff_months)} 個月）。"
                            "可能是其中一源尚未更新。"),
            })

    # --- 3. 數值比對（僅在同月份可比時） --------------------------------
    if p_latest and b_latest:
        if p_latest.period == b_latest.period:
            delta = abs(p_latest.value - b_latest.value)
            same = delta <= VALUE_TOLERANCE
            comparisons.append({
                "item": "數值",
                "primary": p_latest.value,
                "backup": b_latest.value,
                "match": same,
                "detail": f"差 {delta:.2f}（容差 {VALUE_TOLERANCE}）",
            })
            if not same:
                alerts.append({
                    "level": "critical",
                    "code": "VALUE_MISMATCH",
                    "message": (f"同一月份 {p_latest.period} 數值不一致："
                                f"主源 {p_latest.value} vs 備援 {b_latest.value}"
                                f"（差 {delta:.2f}）。需人工確認哪一源正確。"),
                })
        else:
            comparisons.append({
                "item": "數值",
                "primary": p_latest.value,
                "backup": b_latest.value,
                "match": None,
                "detail": "月份不同，無法直接比對",
            })

    # --- 4. 更新時間比對 -----------------------------------------------
    if primary.ok and backup.ok and p_latest and b_latest:
        p_age = (run_at - datetime.fromisoformat(p_latest.fetched_at)).total_seconds()
        b_age = (run_at - datetime.fromisoformat(b_latest.fetched_at)).total_seconds()
        comparisons.append({
            "item": "拉取時間",
            "primary": p_latest.fetched_at,
            "backup": b_latest.fetched_at,
            "match": True,
            "detail": f"兩源同一輪抓取，相差 {abs(p_age - b_age):.0f} 秒",
        })

    # --- 5. 合理性與新鮮度 ---------------------------------------------
    for res, label in ((primary, "主源 DBnomics"), (backup, "備援源 AKShare")):
        if not res.ok or not res.points:
            continue
        issues = plausibility_issues(res.points)
        if issues:
            alerts.append({
                "level": "critical",
                "code": f"{res.source.upper()}_IMPLAUSIBLE",
                "message": f"{label} 數值不合理：" + "；".join(issues),
            })
        if res.latest:
            stale = stale_check(res.latest.period, run_at)
            if stale:
                alerts.append({
                    "level": "warning",
                    "code": f"{res.source.upper()}_STALE",
                    "message": f"{label} 資料過期：{stale}",
                })

    # --- 6. 決定建議值 -------------------------------------------------
    # 分兩輪，避免「尾段損壞的主源」打敗「完整健康的備援」：
    #   第一輪：整條序列都合理的來源（最新月即有效讀數）。
    #   第二輪：尾段損壞但可修剪出合理前段的來源（歷史值，需標記過期）。
    # 每一輪都主源優先、備援次之。
    fully_clean: List[Tuple[FetchResult, SeriesPoint]] = []
    trimmed: List[Tuple[FetchResult, SeriesPoint]] = []

    for res in (primary, backup):
        if not res.ok or not res.points:
            continue
        if not plausibility_issues(res.points):
            latest = max(res.points, key=lambda p: p.period)
            fully_clean.append((res, latest))
            continue
        clean, _ = drop_implausible(res.points)
        if clean and not plausibility_issues(clean):
            trimmed.append((res, max(clean, key=lambda p: p.period)))

    if fully_clean:
        chosen = fully_clean[0][1]
    elif trimmed:
        chosen = trimmed[0][1]

    if chosen is None:
        alerts.append({
            "level": "critical",
            "code": "NO_USABLE_VALUE",
            "message": "兩源皆無可用的合理數值，無法產出 PMI 指標。",
        })
    elif trimmed and not fully_clean:
        alerts.append({
            "level": "warning",
            "code": "ONLY_TRIMMED_HISTORY",
            "message": (f"兩源尾段皆損壞，僅能提供 {chosen.period}={chosen.value} "
                        f"（來自 {chosen.source}）作為最後可信的歷史值；"
                        "這是歷史值，不可當成當月最新讀數。"),
        })

    return comparisons, alerts, chosen


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def run_once(state_dir: Path = DEFAULT_STATE_DIR,
             write_files: bool = True) -> StatusReport:
    """執行一次完整的雙源拉取 + 比對，並輸出結果。"""
    run_at = datetime.now(timezone.utc)
    log.info("開始執行，時間 %s", run_at.isoformat(timespec="seconds"))

    log.info("拉取主源 DBnomics（%s）…", DBNOMICS_SERIES)
    primary = fetch_dbnomics()
    log.info("  主源：ok=%s 筆數=%d 耗時=%dms%s",
             primary.ok, len(primary.points), primary.elapsed_ms,
             f" 錯誤={primary.error}" if primary.error else "")

    log.info("拉取備援源 AKShare（macro_usa_pmi）…")
    backup = fetch_akshare()
    log.info("  備援：ok=%s 筆數=%d 耗時=%dms%s",
             backup.ok, len(backup.points), backup.elapsed_ms,
             f" 錯誤={backup.error}" if backup.error else "")

    comparisons, alerts, chosen = compare_sources(primary, backup, run_at)

    # 「過期」有兩種成因：月份太舊，或只修剪出歷史值（尾段損壞）。
    trimmed_only = any(a["code"] == "ONLY_TRIMMED_HISTORY" for a in alerts)
    is_stale = bool(chosen) and (trimmed_only or
                                 stale_check(chosen.period, run_at) is not None)

    has_critical = any(a["level"] == "critical" for a in alerts)
    has_warning = any(a["level"] == "warning" for a in alerts)
    status = "critical" if has_critical else ("warn" if has_warning else "ok")

    report = StatusReport(
        run_at=run_at.isoformat(timespec="seconds"),
        status=status,
        primary=primary,
        backup=backup,
        comparisons=comparisons,
        alerts=alerts,
        recommended_value=chosen.value if chosen else None,
        recommended_period=chosen.period if chosen else None,
        recommended_source=chosen.source if chosen else None,
        recommended_is_stale=is_stale,
    )

    if write_files:
        write_outputs(report, state_dir)

    return report


def write_outputs(report: StatusReport, state_dir: Path) -> None:
    """把結果寫成 JSON，並維護一份「最新狀態」與歷史紀錄。"""
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        payload = report.as_dict()

        latest = state_dir / "latest.json"
        latest.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                          encoding="utf-8")

        stamp = report.run_at.replace(":", "").replace("-", "")
        hist = state_dir / f"run_{stamp}.json"
        hist.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                        encoding="utf-8")

        log.info("結果已寫入 %s", latest)
    except OSError as exc:
        log.error("寫入結果檔失敗（不影響本次判斷）：%s", exc)


def print_report(report: StatusReport) -> None:
    """以人類可讀格式印出報告。"""
    icon = {"ok": "✅", "warn": "⚠️", "critical": "🚨"}[report.status]

    print()
    print("=" * 74)
    print(f" ISM 製造業 PMI 雙源比對 — {report.run_at}")
    print(f" 狀態：{icon} {report.status.upper()}")
    print("=" * 74)

    print("\n【來源狀態】")
    for res in (report.primary, report.backup):
        flag = "OK " if res.ok else "FAIL"
        latest = res.latest
        detail = (f"{latest.period} = {latest.value}" if latest else "—")
        print(f"  [{flag}] {res.source:<9} 筆數={len(res.points):<4} "
              f"最新={detail:<18} 耗時={res.elapsed_ms}ms")
        if res.error:
            print(f"         錯誤：{res.error}")
        for note in res.notes:
            print(f"         註記：{note}")

    if report.comparisons:
        print("\n【交叉驗證】")
        for c in report.comparisons:
            mark = {True: "✓", False: "✗", None: "–"}[c["match"]]
            print(f"  {mark} {c['item']}：主源={c['primary']}  "
                  f"備援={c['backup']}  ({c['detail']})")

    print("\n【建議採用值】")
    if report.recommended_value is not None:
        flag = "  ⚠️ 已過期（非當期值）" if report.recommended_is_stale else ""
        print(f"  {report.recommended_period} = {report.recommended_value} "
              f"（來自 {report.recommended_source}）{flag}")
        if report.recommended_is_stale:
            print("     注意：這是「最後一個可信的歷史值」，不可當成當月最新讀數。")
    else:
        print("  無 —— 兩源皆無可用數值")

    if report.alerts:
        print("\n【警示】")
        for a in report.alerts:
            lv = {"critical": "🚨", "warning": "⚠️", "info": "ℹ️"}.get(a["level"], "•")
            print(f"  {lv} [{a['code']}] {a['message']}")
    print()


# ---------------------------------------------------------------------------
# 排程：每月第一個工作日 10:00 美東
# ---------------------------------------------------------------------------


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> datetime:
    """該月第 n 個指定星期幾（weekday: 0=週一）。"""
    d = datetime(year, month, 1)
    offset = (weekday - d.weekday()) % 7
    return d + timedelta(days=offset + (n - 1) * 7)


def _last_weekday(year: int, month: int, weekday: int) -> datetime:
    """該月最後一個指定星期幾。"""
    nxt = datetime(year + (month == 12), month % 12 + 1, 1)
    d = nxt - timedelta(days=1)
    while d.weekday() != weekday:
        d -= timedelta(days=1)
    return d


def _observed(d: datetime) -> datetime:
    """美國聯邦假日的 observed 規則：週六→前一個週五，週日→後一個週一。"""
    if d.weekday() == 5:      # 週六
        return d - timedelta(days=1)
    if d.weekday() == 6:      # 週日
        return d + timedelta(days=1)
    return d


def us_federal_holidays(year: int) -> set:
    """美國聯邦假日（足以正確判斷「月初是否為工作日」）。

    只涵蓋會落在月初、可能影響「第一個工作日」判定的假日；
    ISM 製造業 PMI 於工作日 10:00 ET 發布，遇聯邦假日順延，
    因此排程必須避開。
    """
    days = {
        _observed(datetime(year, 1, 1)),                    # New Year's Day
        _nth_weekday(year, 1, 0, 3),                        # MLK Day（1 月第 3 個週一）
        _nth_weekday(year, 2, 0, 3),                        # Washington's Birthday
        _last_weekday(year, 5, 0),                          # Memorial Day
        _observed(datetime(year, 6, 19)),                   # Juneteenth
        _observed(datetime(year, 7, 4)),                    # Independence Day
        _nth_weekday(year, 9, 0, 1),                        # Labor Day
        _nth_weekday(year, 10, 0, 2),                       # Columbus Day
        _observed(datetime(year, 11, 11)),                  # Veterans Day
        _nth_weekday(year, 11, 3, 4),                       # Thanksgiving
        _observed(datetime(year, 12, 25)),                  # Christmas
    }
    return {d.date() for d in days}


def now_eastern() -> datetime:
    """現在的紐約時間（正確處理 EST/EDT 夏令時）。

    不能用固定 UTC-5 偏移：美東每年 3 月第二個週日到 11 月第一個週日為 EDT
    (UTC-4)，其餘為 EST (UTC-5)。用錯會讓排程提早或延後一小時，
    可能落在 ISM 10:00 發布之前。
    """
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York"))
    except Exception:  # noqa: BLE001 — 缺 tzdata 時退回 UTC-5 並警告
        log.warning("無法載入 America/New_York 時區，改用固定 UTC-5（夏令時會偏 1 小時）")
        return (datetime.now(timezone.utc) - timedelta(hours=5)).replace(
            tzinfo=None)


def first_business_day(year: int, month: int) -> datetime:
    """回傳該月第一個「工作日」（排除週末與美國聯邦假日）。

    這是排程正確性的關鍵：2026-01-01 是元旦、2026-07-04 前後也可能落在月初，
    若只排除週末會把排程訂在休市日，導致 ISM 發布前就執行、比對必然失敗。
    """
    holidays = us_federal_holidays(year)
    d = datetime(year, month, 1)
    # 最多往後找 10 天，足以跳過連續假日
    for _ in range(10):
        if d.weekday() < 5 and d.date() not in holidays:
            return d
        d += timedelta(days=1)
    raise RuntimeError(f"找不到 {year}-{month:02d} 的工作日")


def cron_expression() -> str:
    """每月第一個工作日 10:00 美東的 cron 表達式。

    注意：標準 cron 無法表達「第一個工作日」，因此用 `1-3` 加上
    `nthWeekday` 判斷，或直接用本模組的 `--watch` 迴圈。
    這裡給出的是「每月 1~3 日的 10:00 都觸發，由程式內部再判斷是否為
    第一個工作日」的寫法 —— 最穩健且可移植。
    """
    return "0 10 1-3 * *"


def install_cron_hint(tz_name: str = "America/New_York") -> str:
    """產出安裝排程的說明（不直接改系統 crontab）。"""
    py = sys.executable
    here = Path(__file__).resolve().parent
    return f"""\
# --- 每月第一個工作日 10:00 美東，執行 ISM PMI 雙源比對 ---
# 1) 先確認系統時區或改用 CRON_TZ（Linux cronie / macOS 支援 CRON_TZ）
CRON_TZ={tz_name}
# 2) 1~3 日都觸發，由程式判斷是否為當月第一個工作日，非當日則直接跳過
0 10 1-3 * * cd {here.parent} && {py} -m ism_pmi_pipeline --once --business-day-guard >> {here.parent}/data/ism_pmi/cron.log 2>&1

# --- 若使用 Windows，改用工作排程器（PowerShell，系統管理員權限）---
# $act = New-ScheduledTaskAction -Execute "{py}" `
#          -Argument "-m ism_pmi_pipeline --once --business-day-guard" `
#          -WorkingDirectory "{here.parent}"
# $trg = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday -At 10:00
# Register-ScheduledTask -TaskName "ISM-PMI-Check" -Action $act -Trigger $trg
# （Windows 端同樣靠 --business-day-guard 過濾非第一個工作日）

# --- 若不想用系統排程，可直接長駐 ---
# {py} -m ism_pmi_pipeline --watch
"""


def is_first_business_day(now_et: datetime) -> bool:
    """判斷 now_et 當天是否為該月第一個工作日。"""
    expected = first_business_day(now_et.year, now_et.month)
    return now_et.date() == expected.date()


def check_env() -> int:
    """檢查環境：兩源是否可用、資料是否合理。回傳退出碼。"""
    print("=" * 74)
    print(" 環境檢查")
    print("=" * 74)

    problems = 0

    # 依賴
    for mod in ("dbnomics", "akshare", "pandas"):
        try:
            __import__(mod)
            print(f"  ✅ {mod} 已安裝")
        except ImportError:
            print(f"  ❌ {mod} 未安裝")
            if mod != "akshare":
                problems += 1

    # AKShare 接口存在性
    try:
        import akshare as ak
        has = hasattr(ak, "macro_usa_pmi")
        print(f"  {'✅' if has else '⚠️ '} ak.macro_usa_pmi "
              f"{'存在' if has else '不存在（1.20.42 起已移除）'}")
        if not has:
            print(f"     AKShare 版本：{getattr(ak, '__version__', '?')}")
    except ImportError:
        print("  ⚠️  akshare 未安裝，備援源不可用")

    # 兩源實測
    print()
    p = fetch_dbnomics()
    print(f"  主源 DBnomics：ok={p.ok} 筆數={len(p.points)}"
          + (f" 錯誤={p.error}" if p.error else ""))
    if p.ok and p.points:
        issues = plausibility_issues(p.points)
        if issues:
            print(f"     🚨 數值不合理：{'；'.join(issues)}")
            problems += 1
        else:
            print(f"     ✅ 數值合理，最新 {p.latest.period} = {p.latest.value}")

    b = fetch_akshare()
    print(f"  備援 AKShare：ok={b.ok} 筆數={len(b.points)}"
          + (f" 錯誤={b.error}" if b.error else ""))
    if not b.ok:
        problems += 1

    print()
    if problems:
        print(f"  結論：有 {problems} 個問題，PMI 指標目前無法可靠取得。")
        print("  建議：參考 docs/ISM_PMI_接入方案.md 的「可行替代」章節。")
    else:
        print("  結論：兩源皆正常。")
    print()
    return 0 if problems == 0 else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="ISM 製造業 PMI 雙源接入與交叉驗證",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--once", action="store_true",
                        help="執行一次並輸出結果（預設行為）")
    parser.add_argument("--check-env", action="store_true",
                        help="只檢查環境與兩源可用性")
    parser.add_argument("--health", action="store_true",
                        help="快速健康檢查，有問題時退出碼非 0（適合監控）")
    parser.add_argument("--install-cron", action="store_true",
                        help="印出每月排程的安裝方式")
    parser.add_argument("--watch", action="store_true",
                        help="長駐，每月第一個工作日 10:00 美東自動執行")
    parser.add_argument("--business-day-guard", action="store_true",
                        help="若今天不是當月第一個工作日則直接跳過（配合 cron 1-3 日觸發）")
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR,
                        help=f"結果輸出目錄（預設 {DEFAULT_STATE_DIR}）")
    parser.add_argument("--no-write", action="store_true",
                        help="不寫入檔案，只印出")
    parser.add_argument("-v", "--verbose", action="store_true", help="顯示除錯訊息")

    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.install_cron:
        print(install_cron_hint())
        return 0

    if args.check_env:
        return check_env()

    if args.watch:
        return run_watch(args)

    if args.business_day_guard:
        now_et = now_eastern()
        if not is_first_business_day(now_et):
            log.info("今天（美東 %s）不是當月第一個工作日，跳過。",
                     now_et.date().isoformat())
            return 0

    report = run_once(state_dir=args.state_dir, write_files=not args.no_write)
    print_report(report)

    if args.health:
        return 0 if report.status == "ok" else 1

    # 有 critical 時給非 0 退出碼，讓排程系統能偵測
    return 0 if report.status == "ok" else 2


def run_watch(args) -> int:
    """長駐：每月第一個工作日 10:00 美東執行一次。"""
    log.info("進入長駐模式（每月第一個工作日 10:00 美東）。Ctrl+C 結束。")
    last_run_month: Optional[str] = None

    while True:
        now_et = now_eastern()
        stamp = now_et.strftime("%Y-%m")

        # ISM 製造業 PMI 於美東 10:00 發布；排程 10:05 執行，
        # 留 5 分鐘緩衝讓資料源完成更新。
        if (now_et.hour == 10 and now_et.minute >= 5
                and is_first_business_day(now_et)
                and last_run_month != stamp):
            log.info("觸發：%s 為本月第一個工作日（美東 10:%02d）",
                     now_et.date(), now_et.minute)
            report = run_once(state_dir=args.state_dir, write_files=not args.no_write)
            print_report(report)
            last_run_month = stamp

        time.sleep(60)


if __name__ == "__main__":
    sys.exit(main())
