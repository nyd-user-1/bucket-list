"""Offline checks: aggregation and rendering, no AWS calls."""
import re
import unittest

from bucket_list.render import fmt_b, render
from bucket_list.sweep import Aggregate, serialize


def sample():
    agg = Aggregate()
    agg.add("logs/2024/01/app-000123.log", 2048, "2024-01-05")
    agg.add("logs/2024/02/app-000124.log", 4096, "2024-02-05")
    agg.add("logs/2025/01/app-000125.log", 1024, "2025-01-05")
    agg.add("data/big.parquet", 5 * 1024 ** 3, "2025-06-01")
    agg.add("readme.txt", 10, "2023-03-03")
    for i in range(40):
        agg.add("many/f%02d/x.bin" % i, 100 + i, "2025-02-02")
    return serialize(agg, "demo-bucket")


class OfflineTests(unittest.TestCase):
    def test_aggregate(self):
        r = sample()
        self.assertEqual(r["n"], 45)
        self.assertEqual(r["largest"][0][0], "data/big.parquet")
        logs = next(p for p in r["prefixes"] if p["p"] == "logs/")
        self.assertEqual(logs["o"], "2024-01-05")
        self.assertEqual(logs["w"], "2025-01-05")
        self.assertEqual(logs["f"][0][0], "app-#.log")
        many = next(p for p in r["prefixes"] if p["p"] == "many/")
        self.assertEqual(len(many["c"]), 31)
        self.assertEqual(many["c"][-1]["p"], "(10 more)")
        self.assertTrue(any(p["p"] == "(root)" for p in r["prefixes"]))

    def test_render(self):
        r = sample()
        r["region"] = "us-east-1"
        stats = {"demo-bucket": {"cwObjects": 9000, "classes": {"StandardStorage": 5.0}, "estMonthly": 0.115}}
        html = render([r], stats, {"demo-bucket": {"verdict": "keep", "note": "<b>x</b>"}}, "123")
        self.assertIn("<title>Bucket List</title>", html)
        self.assertIn("Lightweight search for S3", html)
        self.assertGreaterEqual(len(re.findall(r'class="page"', html)), 2)
        self.assertIn('id="q"', html)
        self.assertIn("&lt;b&gt;x&lt;/b&gt;", html)
        self.assertIn("old versions", html)
        self.assertIn("chip keep", html)

    def test_fmt(self):
        self.assertEqual(fmt_b(0), "0")
        self.assertEqual(fmt_b(512), "512 B")
        self.assertEqual(fmt_b(1536), "2 KB")
        self.assertEqual(fmt_b(150 * 1024 ** 3), "150 GB")


if __name__ == "__main__":
    unittest.main()
