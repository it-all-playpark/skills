"""Unit tests for strategy_analyzer broken_links false-positive fixes.

Covers two regressions found while running v1.2 Phase 1.5 (Issue #414):

1. `_load_hub_slugs` resolved the wrong directory (`<repo>/content/lib/...`
   instead of `<repo>/lib/...`), making every `/blog/hub/*` link look broken.
2. `scan_internal_links` flagged image references (`![alt](/blog/...webp)`)
   as broken internal links because the regex matches both link and image
   markdown syntax.

Run:

    python3 -m unittest seo-strategy/scripts/test_strategy_analyzer.py

The tests are self-contained: they synthesize a tiny corpus on tmpfs that
mirrors the real corporate-site layout (`<root>/content/blog/*.mdx` and
`<root>/lib/blog-hubs.ts`).
"""

from __future__ import annotations

import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

# Make `strategy_analyzer` importable without packaging.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import strategy_analyzer  # noqa: E402


class HubSlugLoadTest(unittest.TestCase):
    """`_load_hub_slugs` should walk up two levels (blog → content → repo)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "content" / "blog").mkdir(parents=True)
        (self.root / "lib").mkdir(parents=True)
        (self.root / "lib" / "blog-hubs.ts").write_text(
            textwrap.dedent(
                """
                export const blogHubs = {
                  'business-automation': { slug: 'business-automation' },
                  'ai-coding-tools': { slug: 'ai-coding-tools' },
                  'salon-dx-shift-management': { slug: 'salon-dx-shift-management' },
                };
                """
            ).strip(),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_loads_hub_slugs_from_repo_root(self) -> None:
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            slugs = strategy_analyzer._load_hub_slugs("content/blog")
        finally:
            os.chdir(cwd)
        self.assertEqual(
            slugs,
            {"business-automation", "ai-coding-tools", "salon-dx-shift-management"},
        )

    def test_returns_empty_when_hubs_file_missing(self) -> None:
        (self.root / "lib" / "blog-hubs.ts").unlink()
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            slugs = strategy_analyzer._load_hub_slugs("content/blog")
        finally:
            os.chdir(cwd)
        self.assertEqual(slugs, set())


class BrokenLinksTest(unittest.TestCase):
    """`scan_internal_links` should ignore hub pages and image references."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.blog_dir = self.root / "content" / "blog"
        self.blog_dir.mkdir(parents=True)
        (self.root / "lib").mkdir(parents=True)
        (self.root / "lib" / "blog-hubs.ts").write_text(
            "export const blogHubs = {\n"
            "  'business-automation': {},\n"
            "};\n",
            encoding="utf-8",
        )

        # MDX with: hub link (valid), inline image (valid), real broken link
        article = textwrap.dedent(
            """\
            ---
            title: 'Sample article'
            date: 2026-01-01
            ---

            See the [hub overview](/blog/hub/business-automation).

            ![alt text](/blog/foo/pipeline.webp)

            Related: [unknown](/blog/this-does-not-exist).
            """
        )
        (self.blog_dir / "2026-01-01-sample.mdx").write_text(article, encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_hub_links_are_not_broken(self) -> None:
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            result = strategy_analyzer.scan_internal_links("content/blog")
        finally:
            os.chdir(cwd)

        broken_targets = [b["target"] for b in result["broken_links"]]
        self.assertNotIn("/blog/hub/business-automation", broken_targets)

    def test_image_references_are_not_broken(self) -> None:
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            result = strategy_analyzer.scan_internal_links("content/blog")
        finally:
            os.chdir(cwd)

        broken_targets = [b["target"] for b in result["broken_links"]]
        self.assertFalse(
            any(t.endswith(".webp") for t in broken_targets),
            f"image references should not be flagged broken: {broken_targets}",
        )

    def test_real_broken_link_is_still_detected(self) -> None:
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            result = strategy_analyzer.scan_internal_links("content/blog")
        finally:
            os.chdir(cwd)

        broken_targets = [b["target"] for b in result["broken_links"]]
        self.assertIn("/blog/this-does-not-exist", broken_targets)


class ContentOverlapAnalysisTest(unittest.TestCase):
    """`build_content_overlap_analysis` should map cluster KWs to existing articles
    so that new_article_directions can avoid cannibalizing recently-published
    (GSC-not-yet-indexed) articles. Issue #69."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.blog_dir = self.root / "content" / "blog"
        self.blog_dir.mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write(self, name: str, frontmatter: str, body: str = "body\n") -> None:
        (self.blog_dir / name).write_text(
            "---\n" + frontmatter.strip() + "\n---\n\n" + body,
            encoding="utf-8",
        )

    def _scan(self) -> list[dict]:
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            return strategy_analyzer.scan_blog_articles("content/blog")
        finally:
            os.chdir(cwd)

    def test_returns_clusters_with_zero_coverage_when_no_articles_match(self) -> None:
        self._write(
            "2026-01-01-something-else.mdx",
            "title: 'Unrelated topic'\ndate: 2026-01-01\ntags: cooking, recipes",
        )
        articles = self._scan()
        config = {
            "cluster_keywords": {"Claude Code": ["claude code", "claude-code"]},
            "saturation_thresholds": {"none": 0, "low": 1, "medium": 3},
            "overlap_match_threshold": 0.4,
        }
        out = strategy_analyzer.build_content_overlap_analysis(articles, config)
        self.assertEqual(len(out["clusters"]), 1)
        self.assertEqual(out["clusters"][0]["coverage_count"], 0)
        self.assertEqual(out["clusters"][0]["saturation"], "none")
        self.assertEqual(out["clusters"][0]["coverage_articles"], [])

    def test_marks_high_saturation_when_four_or_more_articles_cover_keyword(self) -> None:
        for i in range(4):
            self._write(
                f"2026-01-0{i+1}-claude-code-{i}.mdx",
                f"title: 'Claude Code 入門 {i}'\ndate: 2026-01-0{i+1}",
            )
        articles = self._scan()
        config = {
            "cluster_keywords": {"Claude Code": ["claude code"]},
            "saturation_thresholds": {"none": 0, "low": 1, "medium": 3},
            "overlap_match_threshold": 0.4,
        }
        out = strategy_analyzer.build_content_overlap_analysis(articles, config)
        cluster = out["clusters"][0]
        self.assertGreaterEqual(cluster["coverage_count"], 4)
        self.assertEqual(cluster["saturation"], "high")

    def test_match_score_is_in_zero_to_one_range_and_perfect_match_is_one(self) -> None:
        self._write(
            "2026-01-01-exact.mdx",
            "title: 'claude code'\ndate: 2026-01-01",
        )
        articles = self._scan()
        config = {
            "cluster_keywords": {"Claude Code": ["claude code"]},
            "overlap_match_threshold": 0.4,
        }
        out = strategy_analyzer.build_content_overlap_analysis(articles, config)
        scores = [a["match_score"] for a in out["clusters"][0]["coverage_articles"]]
        self.assertTrue(scores, "expected at least one matched article")
        for s in scores:
            self.assertGreaterEqual(s, 0.0)
            self.assertLessEqual(s, 1.0)
        self.assertAlmostEqual(max(scores), 1.0, places=2)

    def test_matched_on_lists_only_fields_with_token_intersection(self) -> None:
        self._write(
            "2026-01-01-title-only.mdx",
            "title: 'claude code 速習'\ndate: 2026-01-01\ntags: foo, bar",
        )
        self._write(
            "2026-01-02-tags-only.mdx",
            "title: 'AI ツール比較'\ndate: 2026-01-02\ntags: claude code, comparison",
        )
        articles = self._scan()
        config = {
            "cluster_keywords": {"Claude Code": ["claude code"]},
            "overlap_match_threshold": 0.4,
        }
        out = strategy_analyzer.build_content_overlap_analysis(articles, config)
        cov = {a["slug"]: a["matched_on"] for a in out["clusters"][0]["coverage_articles"]}
        self.assertIn("title-only", cov)
        self.assertIn("title", cov["title-only"])
        self.assertNotIn("tags", cov["title-only"])
        self.assertIn("tags-only", cov)
        self.assertIn("tags", cov["tags-only"])

    def test_threshold_overrides_from_config_change_saturation(self) -> None:
        for i in range(2):
            self._write(
                f"2026-01-0{i+1}-claude-code-{i}.mdx",
                f"title: 'Claude Code 入門 {i}'\ndate: 2026-01-0{i+1}",
            )
        articles = self._scan()
        # default thresholds {none:0, low:1, medium:3} → 2 articles → "medium"
        out_default = strategy_analyzer.build_content_overlap_analysis(
            articles,
            {
                "cluster_keywords": {"Claude Code": ["claude code"]},
                "saturation_thresholds": {"none": 0, "low": 1, "medium": 3},
                "overlap_match_threshold": 0.4,
            },
        )
        self.assertEqual(out_default["clusters"][0]["saturation"], "medium")
        # tighter thresholds {none:0, low:0, medium:1} → 2 articles → "high"
        out_strict = strategy_analyzer.build_content_overlap_analysis(
            articles,
            {
                "cluster_keywords": {"Claude Code": ["claude code"]},
                "saturation_thresholds": {"none": 0, "low": 0, "medium": 1},
                "overlap_match_threshold": 0.4,
            },
        )
        self.assertEqual(out_strict["clusters"][0]["saturation"], "high")

    def test_match_threshold_filters_low_score_articles(self) -> None:
        # KW = 3 tokens、article は KW のうち 1 トークンのみ含む → score = 1/3 ≈ 0.33
        self._write(
            "2026-01-01-partial.mdx",
            "title: 'cli ツール紹介'\ndate: 2026-01-01",
        )
        articles = self._scan()
        config_low = {
            "cluster_keywords": {"Claude Code CLI": ["claude code cli"]},
            "overlap_match_threshold": 0.3,
        }
        config_high = {
            "cluster_keywords": {"Claude Code CLI": ["claude code cli"]},
            "overlap_match_threshold": 0.5,
        }
        out_low = strategy_analyzer.build_content_overlap_analysis(articles, config_low)
        out_high = strategy_analyzer.build_content_overlap_analysis(articles, config_high)
        self.assertEqual(out_low["clusters"][0]["coverage_count"], 1)
        self.assertEqual(out_high["clusters"][0]["coverage_count"], 0)

    def test_japanese_keywords_match_via_bigram(self) -> None:
        self._write(
            "2026-01-01-shift.mdx",
            "title: 'シフト管理アプリの選び方'\ndate: 2026-01-01",
        )
        articles = self._scan()
        config = {
            "cluster_keywords": {"シフト管理": ["シフト管理"]},
            "overlap_match_threshold": 0.4,
        }
        out = strategy_analyzer.build_content_overlap_analysis(articles, config)
        self.assertEqual(out["clusters"][0]["coverage_count"], 1)
        self.assertEqual(
            out["clusters"][0]["coverage_articles"][0]["slug"], "shift",
        )

    def test_keywords_field_in_frontmatter_is_used(self) -> None:
        self._write(
            "2026-01-01-via-keywords.mdx",
            textwrap.dedent(
                """\
                title: 'Unrelated headline'
                date: 2026-01-01
                keywords:
                  - claude code
                  - cli
                """
            ).strip(),
        )
        articles = self._scan()
        config = {
            "cluster_keywords": {"Claude Code": ["claude code"]},
            "overlap_match_threshold": 0.4,
        }
        out = strategy_analyzer.build_content_overlap_analysis(articles, config)
        self.assertEqual(out["clusters"][0]["coverage_count"], 1)
        matched_on = out["clusters"][0]["coverage_articles"][0]["matched_on"]
        self.assertIn("keywords", matched_on)


if __name__ == "__main__":
    unittest.main()
