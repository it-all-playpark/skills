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


if __name__ == "__main__":
    unittest.main()
