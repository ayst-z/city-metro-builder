import importlib.util
from pathlib import Path
import unittest

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location("plan_map", Path(__file__).parents[1] / "scripts/plan-map.py")
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


def anchor(name, x, y):
    return {"name": name, "pixel": [x, y], "coord": [118 + x * 0.0001 + y * 0.00002, 32 - y * 0.0001]}


class PlanMapTest(unittest.TestCase):
    def setUp(self):
        self.anchors = [anchor("A", 0, 0), anchor("B", 100, 0), anchor("C", 0, 100), anchor("D", 100, 100)]
        self.checks = [anchor("E", 25, 30), anchor("F", 75, 60)]

    def test_affine_reflected_pixel_y_and_holdout(self):
        fit = plan.fit_transform(self.anchors, self.checks, "gcj02", 1)
        self.assertTrue(fit["ok"])
        np.testing.assert_allclose(plan.project(fit, [[20, 30]])[0], anchor("X", 20, 30)["coord"], atol=1e-10)

    def test_bad_holdout_blocks_despite_perfect_training(self):
        self.checks[0]["coord"][0] += 0.02
        fit = plan.fit_transform(self.anchors, self.checks, "wgs84", 100)
        self.assertFalse(fit["ok"])
        self.assertEqual(max(x["errorM"] for x in fit["fit"]), 0)

    def test_collinear_rejected(self):
        with self.assertRaisesRegex(ValueError, "collinear|degenerate"):
            plan.fit_transform([anchor(str(i), i, i) for i in range(4)], self.checks, "gcj02")

    def test_reused_checks_rejected(self):
        with self.assertRaisesRegex(ValueError, "distinct"):
            plan.fit_transform(self.anchors, self.anchors[:2], "gcj02")

    def test_nan_and_crs_rejected(self):
        with self.assertRaises(ValueError):
            plan.fit_transform(self.anchors, self.checks, "auto")
        self.anchors[0]["pixel"][0] = float("nan")
        with self.assertRaises(ValueError):
            plan.fit_transform(self.anchors, self.checks, "gcj02")

    def test_follow_curve_not_straight_chord(self):
        image = np.full((100, 100, 3), 255, np.uint8)
        cv2.polylines(image, [np.array([[10, 80], [10, 20], [80, 20]])], False, (220, 30, 30), 5)
        path, quality = plan.trace_segment(image, [10, 80], [80, 20], "#dc1e1e", bridge_px=3)
        self.assertGreater(quality["colorCoverage"], 0.95)
        self.assertLess(min(np.linalg.norm(np.asarray(path) - [10, 20], axis=1)), 5)

    def test_long_gap_blocks(self):
        image = np.full((100, 120, 3), 255, np.uint8)
        cv2.line(image, (10, 50), (35, 50), (220, 30, 30), 5)
        cv2.line(image, (80, 50), (110, 50), (220, 30, 30), 5)
        with self.assertRaisesRegex(ValueError, "disconnected"):
            plan.trace_segment(image, [10, 50], [110, 50], "#dc1e1e", bridge_px=3)

    def test_station_symbol_bridge(self):
        image = np.full((80, 120, 3), 255, np.uint8)
        cv2.line(image, (10, 40), (110, 40), (220, 30, 30), 5)
        cv2.circle(image, (60, 40), 4, (255, 255, 255), -1)
        _, quality = plan.trace_segment(image, [10, 40], [110, 40], "#dc1e1e", bridge_px=5)
        self.assertLessEqual(quality["maxGapPx"], 11)

    def test_trace_budget_and_bounds(self):
        image = np.full((80, 120, 3), [220, 30, 30], np.uint8)
        with self.assertRaisesRegex(ValueError, "budget"):
            plan.trace_segment(image, [10, 40], [110, 40], "#dc1e1e", max_states=1)
        with self.assertRaisesRegex(ValueError, "outside"):
            plan.trace_segment(image, [-1, 40], [110, 40], "#dc1e1e")

    def test_compile_rejects_extrapolation_and_missing_segments(self):
        image = np.full((150, 150, 3), [220, 30, 30], np.uint8)
        manifest = {"crs": "gcj02", "anchors": self.anchors, "checks": self.checks, "source": {"workSize": [150, 150]},
                    "lines": [{"name": "P", "color": "#dc1e1e", "stations": [
                        {"name": "one", "pixel": [20, 20]}, {"name": "two", "pixel": [120, 20]}], "segments": [{}]}]}
        result = plan.compile_plan(image, manifest)
        self.assertFalse(result["ok"])
        self.assertIn("coverage", result["blocked"][0]["reason"])
        manifest["lines"][0]["segments"] = []
        result = plan.compile_plan(image, manifest)
        self.assertIn("segment count", result["blocked"][0]["reason"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
