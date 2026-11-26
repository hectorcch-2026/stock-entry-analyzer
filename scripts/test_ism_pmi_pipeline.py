"""
ISM PMI 雙源管線的單元測試
==========================

重點驗證：
  1. 欄位正規化（各種期間格式都能收斂到 YYYY-MM）
  2. 合理性檢查能擋掉 DBnomics 目前的損壞值
  3. 交叉驗證在「數值一致 / 不一致 / 期間不同 / 一源失敗」下的判定
  4. 第一個工作日計算正確排除週末與聯邦假日
  5. 夏令時正確切換

執行：
    python -m pytest scripts/test_ism_pmi_pipeline.py -v
或：
    python scripts/test_ism_pmi_pipeline.py
"""

from __future__ import annotations

import dataclasses
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ism_pmi_pipeline as m  # noqa: E402


def mk_points(values, source="test", start_year=2025, start_month=1):
    """從數值清單造出連續月份的 SeriesPoint 清單。"""
    pts = []
    y, mo = start_year, start_month
    for v in values:
        pts.append(m.SeriesPoint(
            period=f"{y:04d}-{mo:02d}",
            value=float(v),
            source=source,
            fetched_at="2026-11-26T00:00:00+00:00",
        ))
        mo += 1
        if mo > 12:
            y, mo = y + 1, 1
    return pts


def mk_result(points, source="test", ok=True, error=None):
    """包成 FetchResult，並把每個觀測值的 source 改寫成與結果一致。

    比對邏輯是從 ``res.points`` 取觀測值來當建議值，若點上的 source
    與外層 FetchResult 不一致，斷言 chosen.source 就會看到錯的值。
    """
    stamped = [dataclasses.replace(p, source=source) for p in points]
    return m.FetchResult(source=source, ok=ok, points=stamped, error=error)


class TestMonthNormalization(unittest.TestCase):
    """欄位正規化：所有來源的期間格式都要能收斂。"""

    def test_common_formats(self):
        cases = {
            "2025-08-01": "2025-08",
            "2025-08": "2025-08",
            "2025/08/01": "2025-08",
            "2025年08月份": "2025-08",
            "2025年8月": "2025-08",
            "2025-08-01 00:00:00": "2025-08",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(m.to_month(raw), expected)

    def test_datetime_object(self):
        self.assertEqual(m.to_month(datetime(2025, 8, 1)), "2025-08")

    def test_invalid_inputs(self):
        for bad in ("", None, "garbage", "abc-def"):
            with self.subTest(bad=bad):
                self.assertIsNone(m.to_month(bad))

    def test_months_between(self):
        self.assertEqual(m.months_between("2025-12", "2025-08"), 4)
        self.assertEqual(m.months_between("2026-01", "2025-12"), 1)
        self.assertEqual(m.months_between("2026-11", "2025-08"), 15)
        self.assertEqual(m.months_between("2025-08", "2025-08"), 0)


class TestPlausibility(unittest.TestCase):
    """合理性檢查：這是擋下 DBnomics 損壞值的核心防線。"""

    def test_normal_series_passes(self):
        pts = mk_points([48.0, 49.0, 50.2, 47.5, 52.1])
        self.assertEqual(m.plausibility_issues(pts), [])

    def test_detects_out_of_range(self):
        # 重現 DBnomics 目前的實際損壞：2025-09 起為 11.1/10/10/10.3
        pts = mk_points([48.7, 11.1, 10.0, 10.0, 10.3])
        issues = m.plausibility_issues(pts)
        self.assertTrue(any("超出合理值域" in i for i in issues))

    def test_detects_large_jump(self):
        pts = mk_points([48.0, 49.0, 74.0])  # 跳 25 點
        issues = m.plausibility_issues(pts)
        self.assertTrue(any("異常跳動" in i for i in issues))

    def test_empty_series(self):
        self.assertEqual(m.plausibility_issues([]), ["序列為空"])

    def test_drop_implausible_trims_tail(self):
        pts = mk_points([48.0, 49.0, 50.0, 10.0, 10.0, 10.5])
        kept, notes = m.drop_implausible(pts)
        self.assertEqual([p.value for p in kept], [48.0, 49.0, 50.0])
        self.assertTrue(notes)

    def test_drop_implausible_no_change_when_clean(self):
        pts = mk_points([48.0, 49.0, 50.0])
        kept, notes = m.drop_implausible(pts)
        self.assertEqual(len(kept), 3)
        self.assertEqual(notes, [])

    def test_stale_check(self):
        now = datetime(2026, 11, 26, tzinfo=timezone.utc)
        self.assertIsNotNone(m.stale_check("2025-08", now))   # 明顯過期
        self.assertIsNone(m.stale_check("2026-10", now))      # 1 個月內，算新鮮


class TestCrossValidation(unittest.TestCase):
    """交叉驗證邏輯。"""

    def setUp(self):
        self.now = datetime(2026, 11, 26, tzinfo=timezone.utc)

    def test_matching_values_no_value_alert(self):
        a = mk_result(mk_points([49.8, 50.1]), source="dbnomics")
        b = mk_result(mk_points([49.8, 50.1]), source="akshare")
        comps, alerts, chosen = m.compare_sources(a, b, self.now)
        value_alerts = [x for x in alerts if x["code"] == "VALUE_MISMATCH"]
        self.assertEqual(value_alerts, [])
        self.assertIsNotNone(chosen)
        self.assertAlmostEqual(chosen.value, 50.1)

    def test_value_mismatch_raises_critical(self):
        a = mk_result(mk_points([49.8, 50.1]), source="dbnomics")
        b = mk_result(mk_points([49.8, 52.3]), source="akshare")  # 差 2.2
        comps, alerts, _ = m.compare_sources(a, b, self.now)
        codes = [x["code"] for x in alerts]
        self.assertIn("VALUE_MISMATCH", codes)
        detail = next(x for x in alerts if x["code"] == "VALUE_MISMATCH")
        self.assertEqual(detail["level"], "critical")
        self.assertIn("50.1", detail["message"])
        self.assertIn("52.3", detail["message"])

    def test_period_mismatch_warns(self):
        a = mk_result(mk_points([49.8, 50.1, 51.0]), source="dbnomics")
        b = mk_result(mk_points([49.8, 50.1]), source="akshare")  # 少一個月
        comps, alerts, _ = m.compare_sources(a, b, self.now)
        self.assertIn("PERIOD_MISMATCH", [x["code"] for x in alerts])

    def test_backup_failure_warns_but_still_chooses_primary(self):
        a = mk_result(mk_points([49.8, 50.1]), source="dbnomics")
        b = mk_result([], source="akshare", ok=False, error="接口已移除")
        comps, alerts, chosen = m.compare_sources(a, b, self.now)
        self.assertIn("BACKUP_UNAVAILABLE", [x["code"] for x in alerts])
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen.source, "dbnomics")

    def test_both_fail_yields_no_usable_value(self):
        a = mk_result([], source="dbnomics", ok=False, error="網路錯誤")
        b = mk_result([], source="akshare", ok=False, error="接口已移除")
        comps, alerts, chosen = m.compare_sources(a, b, self.now)
        self.assertIsNone(chosen)
        self.assertIn("NO_USABLE_VALUE", [x["code"] for x in alerts])

    def test_implausible_primary_falls_back_to_clean_backup(self):
        """主源損壞、備援正常時，應採用備援的合理值。"""
        a = mk_result(mk_points([48.7, 11.1, 10.0]), source="dbnomics")
        b = mk_result(mk_points([48.7, 49.2, 50.0]), source="akshare")
        comps, alerts, chosen = m.compare_sources(a, b, self.now)
        self.assertIn("DBNOMICS_IMPLAUSIBLE", [x["code"] for x in alerts])
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen.source, "akshare")
        self.assertAlmostEqual(chosen.value, 50.0)

    def test_both_implausible_tails_trim_back_to_last_good_value(self):
        """兩源尾段都損壞時，會退回「最後一個合理值」，並標記為過期。

        這是刻意設計：與其輸出 None（下游無法區分「沒資料」與「資料壞了」），
        不如給出最後一個可信的歷史值，同時用 recommended_is_stale 明確標註
        它不是當月讀數。run_once() 會把該旗標一起寫進輸出。
        """
        a = mk_result(mk_points([48.7, 11.1]), source="dbnomics")
        b = mk_result(mk_points([48.7, 12.0]), source="akshare")
        comps, alerts, chosen = m.compare_sources(a, b, self.now)
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen.source, "dbnomics")   # 主源優先
        self.assertAlmostEqual(chosen.value, 48.7)    # 尾段損壞值已被剔除
        self.assertEqual(chosen.period, "2025-01")
        # 兩源都應被判為不合理
        codes = [x["code"] for x in alerts]
        self.assertIn("DBNOMICS_IMPLAUSIBLE", codes)
        self.assertIn("AKSHARE_IMPLAUSIBLE", codes)
        # 且不得同時報 NO_USABLE_VALUE —— 因為確實還有可用值
        self.assertNotIn("NO_USABLE_VALUE", codes)

    def test_all_values_implausible_yields_no_usable_value(self):
        """整條序列都不合理時，才是真的沒有可用值。"""
        a = mk_result(mk_points([11.1, 10.0, 10.3]), source="dbnomics")
        b = mk_result(mk_points([12.0, 11.5]), source="akshare")
        comps, alerts, chosen = m.compare_sources(a, b, self.now)
        self.assertIsNone(chosen)
        self.assertIn("NO_USABLE_VALUE", [x["code"] for x in alerts])


class TestStatusReport(unittest.TestCase):
    """輸出結構：過期旗標必須一路傳到 JSON，不能被下游誤讀。"""

    def test_stale_flag_serialized(self):
        rep = m.StatusReport(
            run_at="2026-11-26T15:00:00+00:00", status="warn",
            primary=m.FetchResult(source="dbnomics"),
            backup=m.FetchResult(source="akshare"),
            recommended_value=48.7, recommended_period="2025-08",
            recommended_source="dbnomics", recommended_is_stale=True,
        )
        d = rep.as_dict()
        self.assertTrue(d["recommended"]["is_stale"])
        self.assertIn("不可視為當月最新值", d["recommended"]["note"])

    def test_fresh_flag_serialized(self):
        rep = m.StatusReport(
            run_at="2026-11-26T15:00:00+00:00", status="ok",
            primary=m.FetchResult(source="dbnomics"),
            backup=m.FetchResult(source="akshare"),
            recommended_value=50.1, recommended_period="2026-10",
            recommended_source="dbnomics", recommended_is_stale=False,
        )
        d = rep.as_dict()
        self.assertFalse(d["recommended"]["is_stale"])
        self.assertEqual(d["recommended"]["note"], "當期有效值")


class TestDocsConsistency(unittest.TestCase):
    """文件與程式不得各自漂移：文件裡承諾的數字要與常數一致。"""

    def setUp(self):
        self.doc = (Path(__file__).resolve().parent.parent
                    / "docs" / "ISM_PMI_接入方案.md")

    def test_doc_exists(self):
        self.assertTrue(self.doc.exists(), f"缺少設計文件：{self.doc}")

    def test_thresholds_match_constants(self):
        """文件引用的門檻值必須與程式常數相同，避免各說各話。"""
        text = self.doc.read_text(encoding="utf-8")
        # 值域：文件寫 [30, 80]，程式是 30.0 / 80.0
        self.assertIn(f"[{m.PMI_MIN_PLAUSIBLE:g}, {m.PMI_MAX_PLAUSIBLE:g}]", text)
        # 跳動與新鮮度：文件寫「> 20 點」「> 90 天」，用 :g 讓 20.0 → 20
        self.assertIn(f"> {m.PMI_MAX_MONTHLY_JUMP:g}", text)
        self.assertIn(f"> {m.STALE_AFTER_DAYS:g}", text)
        self.assertIn(f"{m.VALUE_TOLERANCE:g}", text)   # 容差 0.05
        self.assertIn(m.DBNOMICS_SERIES, text)

    def test_doc_records_both_source_failures(self):
        text = self.doc.read_text(encoding="utf-8")
        for token in ("11.1", "10.3", "1.20.42", "48.7", "ONLY_TRIMMED_HISTORY"):
            with self.subTest(token=token):
                self.assertIn(token, text)


class TestBusinessDay(unittest.TestCase):
    """第一個工作日：必須排除週末與美國聯邦假日。"""

    def test_january_skips_new_year(self):
        # 2026-01-01 是元旦（週四），第一個工作日應為 01-02
        self.assertEqual(m.first_business_day(2026, 1).date().isoformat(),
                         "2026-01-02")

    def test_july_skips_observed_holiday(self):
        # 2026-07-04 為週六，observed 為 07-03（週五），故 07-01 應為第一個工作日
        self.assertEqual(m.first_business_day(2026, 7).date().isoformat(),
                         "2026-07-01")

    def test_august_skips_weekend(self):
        # 2026-08-01 為週六 → 順延到 08-03（週一）
        self.assertEqual(m.first_business_day(2026, 8).date().isoformat(),
                         "2026-08-03")

    def test_result_is_always_weekday_and_not_holiday(self):
        for year in (2025, 2026, 2027):
            holidays = m.us_federal_holidays(year)
            for month in range(1, 13):
                with self.subTest(year=year, month=month):
                    d = m.first_business_day(year, month)
                    self.assertLess(d.weekday(), 5, f"{d} 是週末")
                    self.assertNotIn(d.date(), holidays, f"{d} 是聯邦假日")

    def test_is_first_business_day(self):
        self.assertTrue(m.is_first_business_day(datetime(2026, 1, 2)))
        self.assertFalse(m.is_first_business_day(datetime(2026, 1, 1)))
        self.assertFalse(m.is_first_business_day(datetime(2026, 1, 5)))


class TestTimezone(unittest.TestCase):
    """時區：必須正確處理 EST/EDT。"""

    def test_uses_named_timezone(self):
        et = m.now_eastern()
        self.assertIsNotNone(et.tzinfo)
        self.assertIn(et.utcoffset().total_seconds(), (-5 * 3600, -4 * 3600))

    def test_winter_is_est(self):
        from zoneinfo import ZoneInfo
        winter = datetime(2026, 1, 15, 10, 0, tzinfo=ZoneInfo("America/New_York"))
        self.assertEqual(winter.utcoffset().total_seconds(), -5 * 3600)

    def test_summer_is_edt(self):
        from zoneinfo import ZoneInfo
        summer = datetime(2026, 7, 15, 10, 0, tzinfo=ZoneInfo("America/New_York"))
        self.assertEqual(summer.utcoffset().total_seconds(), -4 * 3600)


class TestRetry(unittest.TestCase):
    """重試：可重試錯誤要退避重試，程式錯誤不重試。"""

    def test_retries_then_succeeds(self):
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] < 3:
                raise ConnectionError("暫時失敗")
            return "ok"

        ok, val, attempts, err = m.retry_call(
            flaky, what="test", attempts=4, base_delay=0.01)
        self.assertTrue(ok)
        self.assertEqual(val, "ok")
        self.assertEqual(attempts, 3)

    def test_non_retryable_fails_fast(self):
        calls = {"n": 0}

        def broken():
            calls["n"] += 1
            raise TypeError("程式錯誤")

        ok, val, attempts, err = m.retry_call(
            broken, what="test", attempts=4, base_delay=0.01)
        self.assertFalse(ok)
        self.assertEqual(calls["n"], 1, "TypeError 不應重試")
        self.assertIn("TypeError", err)

    def test_exhausts_attempts(self):
        def always_fail():
            raise ConnectionError("永遠失敗")

        ok, val, attempts, err = m.retry_call(
            always_fail, what="test", attempts=2, base_delay=0.01)
        self.assertFalse(ok)
        self.assertEqual(attempts, 2)
        self.assertIn("ConnectionError", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
