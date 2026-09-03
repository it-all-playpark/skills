#!/usr/bin/env python3
"""SEO Strategy Analyzer - GA4 + GSC + Trends クロス分析エンジン

GA4/GSC/Trends レポートとブログ frontmatter を入力として、
記事メトリクス・クエリクラスタ・デバイスギャップ・チャネル分析を出力する。
戦略的判断は LLM に委ね、データ分析とメトリクス算出のみを担当。
"""

import argparse
import glob
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# Add _lib to path for config loader
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_lib"))
from config import load_skill_config

# --- Issue auto-detection thresholds ---
THRESHOLDS = {
    "low_ctr_high_imp": {"min_impressions": 100, "max_ctr": 3.0},
    "high_bounce": {"min_bounce_rate": 65.0},
    "low_engagement": {"max_engagement_rate": 35.0},
    "position_opportunity": {"min_position": 8, "max_position": 20},
    "zero_click": {"min_impressions": 50, "max_clicks": 0},
    "zero_impressions": {"min_days_since_publish": 30},
}

# --- Default config ---
DEFAULT_CONFIG = {
    "site": "",
    "content_path_prefix": "/blog/",
    "content_dir": "content/blog",
    "cluster_keywords": {},
    "unclustered_min_impressions": 20,
    "cluster_suggestion_min_impressions": 50,
    "cluster_suggestion_top_n": 5,
    # content_overlap_analysis: KW × 既存記事の重複検出 (Issue #69)
    "saturation_thresholds": {
        # coverage_count <= "none" → "none" (新規提案OK)
        # coverage_count <= "low"  → "low"
        # coverage_count <= "medium" → "medium"
        # それ以上 → "high" (新規提案禁止)
        "none": 0,
        "low": 1,
        "medium": 3,
    },
    "overlap_match_threshold": 0.4,
}

# --- Stop words for cluster suggestions ---
STOP_WORDS = frozenset({
    # English
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could", "to", "of", "in",
    "for", "on", "with", "at", "by", "from", "as", "into", "about",
    "between", "through", "after", "before", "above", "below", "and",
    "but", "or", "not", "no", "if", "then", "than", "so", "it", "its",
    "this", "that", "these", "those", "what", "which", "who", "whom",
    "how", "when", "where", "why", "all", "each", "every", "both",
    "few", "more", "most", "other", "some", "such", "only", "own",
    "same", "very", "just", "also", "still",
    # Japanese particles / auxiliaries
    "の", "に", "は", "を", "た", "が", "で", "て", "と", "し", "れ",
    "さ", "ある", "いる", "も", "する", "から", "な", "こと", "として",
    "い", "や", "れる", "など", "なっ", "ない", "この", "ため", "その",
    "あと", "よう", "また", "もの", "という", "あり", "まで", "られ",
    "なる", "へ", "か", "だ", "これ", "によって", "により", "ここ",
    "お", "ほど", "どう", "よ", "ね", "です", "ます",
})


def load_json(path: str | None) -> dict | None:
    if not path or not Path(path).exists():
        return None
    with open(path) as f:
        return json.load(f)


def _extract_gsc_rows(gsc_data: dict | list, *, kind: str = "all") -> list[dict]:
    """Normalize GSC report data into a flat list of row dicts.

    Handles three formats:
      1. Combined: top-level ``rows`` with ``page``/``query`` fields or ``keys``
      2. Separated: ``queries`` list + ``pages`` list (each with ``keys[0]``)
      3. Query+URL pairs: ``rows`` with ``keys: [query, url]`` (2-element keys)

    *kind* controls which rows to return:
      - ``"all"``: queries + pages (default)
      - ``"queries"``: query rows only
      - ``"pages"``: page rows only
    """
    from urllib.parse import urlparse

    if isinstance(gsc_data, list):
        return gsc_data

    # Format 1/3: combined rows (may have 1-key or 2-key format)
    rows = gsc_data.get("rows", gsc_data.get("search_analytics", {}).get("rows", []))
    if rows:
        # Detect keys format by inspecting first row
        first = rows[0] if rows else {}
        first_keys = first.get("keys", [])

        # Format 3: keys: [query, url] — normalize into page/query fields
        if len(first_keys) == 2 and (first_keys[1].startswith("http") or first_keys[1].startswith("/")):
            normalized: list[dict] = []
            for row in rows:
                entry = dict(row)
                keys = entry.pop("keys", [])
                if len(keys) >= 2:
                    entry["query"] = keys[0]
                    parsed = urlparse(keys[1])
                    entry["page"] = parsed.path
                elif len(keys) == 1:
                    val = keys[0]
                    if val.startswith("http") or val.startswith("/"):
                        parsed = urlparse(val)
                        entry["page"] = parsed.path
                    else:
                        entry["query"] = val
                normalized.append(entry)
            return normalized

        # Format 1: single-key rows (page-only or query-only)
        if first_keys:
            normalized = []
            for row in rows:
                entry = dict(row)
                keys = entry.pop("keys", [])
                if keys:
                    val = keys[0]
                    if val.startswith("http") or val.startswith("/"):
                        parsed = urlparse(val)
                        entry.setdefault("page", parsed.path)
                    else:
                        entry.setdefault("query", val)
                normalized.append(entry)
            return normalized

        # Already has page/query fields
        return rows

    # Format 2: separated queries / pages (from /gsc skill)
    result: list[dict] = []
    if kind in ("all", "queries"):
        for q in gsc_data.get("queries", []):
            entry = dict(q)
            keys = entry.pop("keys", [])
            if keys:
                entry.setdefault("query", keys[0])
            result.append(entry)
    if kind in ("all", "pages"):
        for p in gsc_data.get("pages", []):
            entry = dict(p)
            keys = entry.pop("keys", [])
            if keys:
                parsed = urlparse(keys[0])
                entry.setdefault("page", parsed.path)
            result.append(entry)
    return result


def load_config(path: str | None) -> dict:
    """Load config JSON and merge with defaults.

    Priority: --config path > skill-config.json["seo-strategy"] > defaults
    """
    config = dict(DEFAULT_CONFIG)
    if path:
        user_config = load_json(path)
        if user_config:
            config.update(user_config)
    else:
        # Fallback: load from skill-config.json (with legacy support)
        skill_cfg = load_skill_config("seo-strategy")
        if skill_cfg:
            config.update(skill_cfg)
    return config


def _split_csv_or_array(value) -> list[str]:
    """Normalize CSV / array literal / list / single string into a list[str].

    Accepts:
      - list (returned as-is, items stripped)
      - "[a, b, c]" → ["a", "b", "c"]
      - "a, b, c" → ["a", "b", "c"]
      - "single" → ["single"]
      - "" / None → []
    """
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return [str(v).strip().strip('"').strip("'") for v in value if str(v).strip()]
    s = str(value).strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    return [t.strip().strip('"').strip("'") for t in s.split(",") if t.strip()]


def parse_frontmatter(mdx_path: str) -> dict | None:
    """Extract frontmatter from MDX file.

    Supports:
      - inline `key: value`
      - YAML block list (continuation lines starting with `- `)
    """
    try:
        with open(mdx_path) as f:
            content = f.read()
    except (OSError, UnicodeDecodeError):
        return None

    match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return None

    fm: dict = {}
    lines = match.group(1).split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if ":" in line and not line.lstrip().startswith("-"):
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if value:
                fm[key] = value
            else:
                # Empty value — check for following YAML block list (- item).
                items: list[str] = []
                j = i + 1
                while j < len(lines):
                    nxt = lines[j]
                    stripped = nxt.lstrip()
                    if stripped.startswith("- "):
                        items.append(stripped[2:].strip().strip('"').strip("'"))
                        j += 1
                        continue
                    if stripped == "" and not items:
                        # blank line before any item — end of block
                        break
                    break
                if items:
                    fm[key] = items
                    i = j
                    continue
        i += 1
    return fm


def scan_blog_articles(blog_dir: str) -> list[dict]:
    """Scan blog directory for MDX articles and extract frontmatter."""
    articles = []
    for mdx_path in sorted(glob.glob(f"{blog_dir}/*.mdx")):
        fm = parse_frontmatter(mdx_path)
        if not fm:
            continue
        slug = Path(mdx_path).stem
        # Remove date prefix (YYYY-MM-DD-)
        if re.match(r"\d{4}-\d{2}-\d{2}-", slug):
            slug = slug[11:]
        articles.append({
            "slug": slug,
            "file": Path(mdx_path).name,
            "title": fm.get("title", ""),
            "description": fm.get("description", ""),
            "date": fm.get("date", ""),
            "category": fm.get("category", ""),
            "tags": _split_csv_or_array(fm.get("tags", "")),
            "keywords": _split_csv_or_array(fm.get("keywords", "")),
        })
    return articles


def extract_ga4_page_metrics(ga_data: dict, content_path_prefix: str = "/blog/") -> dict[str, dict]:
    """Extract per-page metrics from GA4 report."""
    metrics = {}
    content = ga_data.get("content", {})
    page_perf = content.get("page_performance", {})

    for row in page_perf.get("rows", []):
        path = row.get("pagePath", "")
        if not path.startswith(content_path_prefix):
            continue
        slug = path[len(content_path_prefix):].rstrip("/")
        if not slug:
            continue
        metrics[slug] = {
            "pageviews": int(row.get("screenPageViews", 0)),
            "active_users": int(row.get("activeUsers", 0)),
            "bounce_rate": round(float(row.get("bounceRate", 0)) * 100, 1),
            "engagement_rate": round(float(row.get("engagementRate", 0)) * 100, 1),
            "avg_duration": round(float(row.get("averageSessionDuration", 0)), 1),
        }
    return metrics


def extract_ga4_kpi(ga_data: dict) -> dict:
    """Extract site-wide KPIs from GA4 report."""
    traffic = ga_data.get("traffic", {})
    overview = traffic.get("overview", {})
    rows = overview.get("rows", [])

    if not rows:
        return {}

    total_users = sum(int(r.get("activeUsers", 0)) for r in rows)
    total_sessions = sum(int(r.get("sessions", 0)) for r in rows)
    total_pvs = sum(int(r.get("screenPageViews", 0)) for r in rows)
    bounce_rates = [float(r.get("bounceRate", 0)) for r in rows]
    engagement_rates = [float(r.get("engagementRate", 0)) for r in rows]

    avg_bounce = round(sum(bounce_rates) / len(bounce_rates) * 100, 1) if bounce_rates else 0
    avg_engagement = round(sum(engagement_rates) / len(engagement_rates) * 100, 1) if engagement_rates else 0
    pages_per_session = round(total_pvs / total_sessions, 2) if total_sessions else 0

    return {
        "active_users": total_users,
        "sessions": total_sessions,
        "pageviews": total_pvs,
        "bounce_rate": avg_bounce,
        "engagement_rate": avg_engagement,
        "pages_per_session": pages_per_session,
    }


def extract_ga4_device_metrics(ga_data: dict) -> dict:
    """Extract device-level metrics for gap analysis."""
    devices = ga_data.get("traffic", {}).get("devices", {})
    result = {}
    for row in devices.get("rows", []):
        cat = row.get("deviceCategory", "").lower()
        if cat in ("desktop", "mobile", "tablet"):
            result[cat] = {
                "sessions": int(row.get("sessions", 0)),
                "bounce_rate": round(float(row.get("bounceRate", 0)) * 100, 1),
                "engagement_rate": round(float(row.get("engagementRate", 0)) * 100, 1),
                "active_users": int(row.get("activeUsers", 0)),
            }
    return result


def extract_ga4_channel_metrics(ga_data: dict) -> list[dict]:
    """Extract channel/source metrics."""
    sources = ga_data.get("traffic", {}).get("source_medium", {})
    channels = []
    for row in sources.get("rows", []):
        source = row.get("sessionSourceMedium", row.get("source", ""))
        channels.append({
            "source_medium": source,
            "sessions": int(row.get("sessions", 0)),
            "active_users": int(row.get("activeUsers", 0)),
            "bounce_rate": round(float(row.get("bounceRate", 0)) * 100, 1),
            "engagement_rate": round(float(row.get("engagementRate", 0)) * 100, 1),
        })
    return sorted(channels, key=lambda x: x["sessions"], reverse=True)


def extract_gsc_page_metrics(gsc_data: dict, content_path_prefix: str = "/blog/") -> dict[str, dict]:
    """Extract per-page GSC metrics (queries, impressions, clicks, CTR, position)."""
    metrics: dict[str, dict] = {}

    rows = _extract_gsc_rows(gsc_data, kind="pages")

    for row in rows:
        page = row.get("page", row.get("keys", [""])[0] if "keys" in row else "")
        query = row.get("query", row.get("keys", ["", ""])[1] if "keys" in row and len(row.get("keys", [])) > 1 else "")

        # Normalize page to slug using content_path_prefix
        slug = ""
        if content_path_prefix in page:
            slug = page.split(content_path_prefix)[-1].rstrip("/")
        elif page.startswith(content_path_prefix):
            slug = page[len(content_path_prefix):].rstrip("/")

        if not slug:
            continue

        if slug not in metrics:
            metrics[slug] = {
                "impressions": 0,
                "clicks": 0,
                "ctr": 0,
                "avg_position": 0,
                "top_queries": [],
                "_positions": [],
            }

        impressions = int(row.get("impressions", 0))
        clicks = int(row.get("clicks", 0))
        position = float(row.get("position", 0))

        metrics[slug]["impressions"] += impressions
        metrics[slug]["clicks"] += clicks
        if query:
            metrics[slug]["top_queries"].append({
                "query": query,
                "impressions": impressions,
                "clicks": clicks,
                "position": round(position, 1),
            })
        if position > 0:
            metrics[slug]["_positions"].append((position, impressions))

    # Calculate weighted avg position and CTR
    for slug, m in metrics.items():
        if m["impressions"] > 0:
            m["ctr"] = round(m["clicks"] / m["impressions"] * 100, 1)
        positions = m.pop("_positions")
        if positions:
            total_imp = sum(imp for _, imp in positions)
            if total_imp > 0:
                m["avg_position"] = round(sum(p * imp for p, imp in positions) / total_imp, 1)
        # Sort top queries by impressions
        m["top_queries"] = sorted(m["top_queries"], key=lambda x: x["impressions"], reverse=True)[:10]

    return metrics


def extract_gsc_kpi(gsc_data: dict) -> dict:
    """Extract site-wide GSC KPIs.

    For combined (Format 2: {pages, queries}) data, uses pages-only to avoid
    double-counting.  For other formats, uses all rows.
    """
    # Prefer pages-only for KPI to avoid double-counting
    if isinstance(gsc_data, dict) and "pages" in gsc_data:
        rows = _extract_gsc_rows(gsc_data, kind="pages")
    else:
        rows = _extract_gsc_rows(gsc_data)

    total_clicks = sum(int(r.get("clicks", 0)) for r in rows)
    total_impressions = sum(int(r.get("impressions", 0)) for r in rows)
    avg_ctr = round(total_clicks / total_impressions * 100, 1) if total_impressions else 0

    positions = [(float(r.get("position", 0)), int(r.get("impressions", 1))) for r in rows if float(r.get("position", 0)) > 0]
    total_imp = sum(imp for _, imp in positions)
    avg_position = round(sum(p * imp for p, imp in positions) / total_imp, 1) if total_imp else 0

    return {
        "clicks": total_clicks,
        "impressions": total_impressions,
        "avg_ctr": avg_ctr,
        "avg_position": avg_position,
    }


def build_query_clusters(
    gsc_data: dict, blog_articles: list[dict], config: dict,
) -> tuple[list[dict], list[dict]]:
    """Cluster GSC queries by topic and map to articles.

    Returns (clusters, unclustered) tuple.
    """
    rows = _extract_gsc_rows(gsc_data, kind="queries")

    content_path_prefix = config.get("content_path_prefix", "/blog/")

    # Collect all queries with metrics
    query_data: dict[str, dict] = {}
    for row in rows:
        query = row.get("query", "")
        if not query:
            if "keys" in row and row["keys"]:
                query = row["keys"][0]
        if not query:
            continue

        if query not in query_data:
            query_data[query] = {"impressions": 0, "clicks": 0, "pages": set()}
        query_data[query]["impressions"] += int(row.get("impressions", 0))
        query_data[query]["clicks"] += int(row.get("clicks", 0))
        page = row.get("page", "")
        if page:
            query_data[query]["pages"].add(page)

    # Keyword-based clustering from config
    cluster_keywords = config.get("cluster_keywords", {})

    clusters: dict[str, dict] = {}
    unclustered = []

    for query, data in query_data.items():
        q_lower = query.lower()
        matched = False
        for cluster_name, keywords in cluster_keywords.items():
            if any(kw in q_lower for kw in keywords):
                if cluster_name not in clusters:
                    clusters[cluster_name] = {
                        "cluster": cluster_name,
                        "queries": [],
                        "total_impressions": 0,
                        "total_clicks": 0,
                        "mapped_articles": set(),
                    }
                clusters[cluster_name]["queries"].append(query)
                clusters[cluster_name]["total_impressions"] += data["impressions"]
                clusters[cluster_name]["total_clicks"] += data["clicks"]
                for page in data["pages"]:
                    if content_path_prefix in page:
                        slug = page.split(content_path_prefix)[-1].rstrip("/")
                        clusters[cluster_name]["mapped_articles"].add(slug)
                matched = True
                break
        if not matched:
            unclustered.append({"query": query, **data})

    # Add "その他" cluster for high-impression unclustered queries
    unclustered_min = config.get("unclustered_min_impressions", 20)
    high_imp_unclustered = [q for q in unclustered if q["impressions"] >= unclustered_min]
    if high_imp_unclustered:
        clusters["その他"] = {
            "cluster": "その他",
            "queries": [q["query"] for q in high_imp_unclustered[:20]],
            "total_impressions": sum(q["impressions"] for q in high_imp_unclustered),
            "total_clicks": sum(q["clicks"] for q in high_imp_unclustered),
            "mapped_articles": set(),
        }

    # Convert sets to lists and sort by impressions
    result = []
    for c in clusters.values():
        c["mapped_articles"] = sorted(c["mapped_articles"])
        c["queries"] = sorted(c["queries"], key=lambda q: query_data.get(q, {}).get("impressions", 0), reverse=True)[:15]
        result.append(c)

    return (
        sorted(result, key=lambda x: x["total_impressions"], reverse=True),
        unclustered,
    )


def _tokenize(text: str) -> list[str]:
    """Split text into tokens by whitespace, hyphens, underscores."""
    return [t for t in re.split(r"[\s\-_]+", text.lower()) if t and t not in STOP_WORDS and len(t) > 1]


# CJK 連続部分を検出する正規表現 (Hiragana / Katakana / CJK Unified Ideographs)
_CJK_RUN_RE = re.compile(r"[぀-ゟ゠-ヿ㐀-鿿]+")


def _tokenize_for_overlap(text: str) -> set[str]:
    """Tokenize text for overlap matching (CJK-aware, no MeCab dependency).

    Returns a lowercase token set built from:
    - whitespace/hyphen/underscore split tokens (length >= 2, stop-words removed)
    - 2-gram of every contiguous CJK character run (covers Japanese/Chinese)

    The bigram fallback lets us match terms like "シフト管理" against article
    titles like "シフト管理アプリの選び方" without a morphological analyzer.
    """
    if not text:
        return set()
    tokens: set[str] = set()
    # ASCII / latin tokens via the existing tokenizer.
    tokens.update(_tokenize(text))
    # CJK bigrams.
    for run in _CJK_RUN_RE.findall(text):
        if len(run) < 2:
            continue
        for i in range(len(run) - 1):
            tokens.add(run[i:i + 2])
    return tokens


def _saturation_label(count: int, thresholds: dict) -> str:
    """Map coverage_count to saturation label using config thresholds."""
    none_max = int(thresholds.get("none", 0))
    low_max = int(thresholds.get("low", 1))
    medium_max = int(thresholds.get("medium", 3))
    if count <= none_max:
        return "none"
    if count <= low_max:
        return "low"
    if count <= medium_max:
        return "medium"
    return "high"


def build_content_overlap_analysis(
    blog_articles: list[dict],
    config: dict,
) -> dict:
    """Build content overlap analysis: cluster KW × existing articles coverage.

    Mechanically detects which existing published articles already cover each
    cluster keyword so that LLM-driven `new_article_directions` proposals can
    avoid cannibalizing newly-published (GSC-not-yet-indexed) articles.

    Output structure (see seo-strategy/references/schema.md):

        {
          "match_threshold": 0.4,
          "thresholds": {"none": 0, "low": 1, "medium": 3},
          "clusters": [
            {
              "name": "Claude Code",
              "keywords": ["claude code", ...],
              "coverage_articles": [
                {"slug": "...", "title": "...", "match_score": 0.92,
                 "matched_on": ["title", "tags"]}
              ],
              "coverage_count": 3,
              "saturation": "high"
            }
          ]
        }
    """
    cluster_keywords = config.get("cluster_keywords", {}) or {}
    match_threshold = float(config.get("overlap_match_threshold", 0.4))
    thresholds = dict(
        config.get("saturation_thresholds")
        or DEFAULT_CONFIG["saturation_thresholds"]
    )

    if not cluster_keywords:
        return {
            "match_threshold": match_threshold,
            "thresholds": thresholds,
            "clusters": [],
        }

    # Pre-tokenize each article: per-field token set + combined token set.
    article_index = []
    for article in blog_articles:
        field_tokens = {
            "title": _tokenize_for_overlap(article.get("title", "")),
            "tags": _tokenize_for_overlap(" ".join(article.get("tags", []) or [])),
            "description": _tokenize_for_overlap(article.get("description", "")),
            "keywords": _tokenize_for_overlap(" ".join(article.get("keywords", []) or [])),
        }
        combined: set[str] = set()
        for s in field_tokens.values():
            combined |= s
        if not combined:
            continue
        article_index.append({
            "slug": article.get("slug", ""),
            "title": article.get("title", ""),
            "field_tokens": field_tokens,
            "combined": combined,
        })

    clusters_out: list[dict] = []
    # Iterate over cluster_keywords in declaration order.
    for cluster_name, raw_keywords in cluster_keywords.items():
        if isinstance(raw_keywords, str):
            keywords = [raw_keywords]
        else:
            keywords = [str(k) for k in (raw_keywords or [])]

        # Pre-tokenize each KW.
        kw_token_sets = [(kw, _tokenize_for_overlap(kw)) for kw in keywords]
        kw_token_sets = [(kw, ts) for kw, ts in kw_token_sets if ts]

        coverage: list[dict] = []
        for art in article_index:
            best_score = 0.0
            matched_fields: set[str] = set()
            for _kw, kw_tokens in kw_token_sets:
                inter_combined = kw_tokens & art["combined"]
                if not inter_combined:
                    continue
                denom = min(len(kw_tokens), len(art["combined"]))
                score = len(inter_combined) / denom if denom else 0.0
                if score > best_score:
                    best_score = score
                # matched_on は KW トークンが intersect する field 名のみ採用
                for field, ftokens in art["field_tokens"].items():
                    if kw_tokens & ftokens:
                        matched_fields.add(field)
            if best_score >= match_threshold:
                coverage.append({
                    "slug": art["slug"],
                    "title": art["title"],
                    "match_score": round(best_score, 3),
                    "matched_on": sorted(matched_fields),
                })

        coverage.sort(key=lambda c: c["slug"])
        clusters_out.append({
            "name": cluster_name,
            "keywords": keywords,
            "coverage_articles": coverage,
            "coverage_count": len(coverage),
            "saturation": _saturation_label(len(coverage), thresholds),
        })

    return {
        "match_threshold": match_threshold,
        "thresholds": thresholds,
        "clusters": clusters_out,
    }


def build_cluster_suggestions(
    unclustered: list[dict], config: dict,
) -> list[dict]:
    """Suggest new clusters from unclustered queries.

    Algorithm:
    1. Filter queries with impressions >= cluster_suggestion_min_impressions
    2. Tokenize each query
    3. Group queries by common token
    4. Require 2+ queries per group
    5. Sort by total_impressions descending, take top N
    6. Deduplicate: queries in higher-ranked groups are excluded from lower ones
    """
    min_imp = config.get("cluster_suggestion_min_impressions", 50)
    top_n = config.get("cluster_suggestion_top_n", 5)

    # Filter by min impressions
    candidates = [q for q in unclustered if q.get("impressions", 0) >= min_imp]
    if not candidates:
        return []

    # Build token → queries mapping
    token_groups: dict[str, list[dict]] = defaultdict(list)
    for q in candidates:
        tokens = _tokenize(q["query"])
        for token in tokens:
            token_groups[token].append(q)

    # Build suggestions: require 2+ queries per token group
    raw_suggestions = []
    for token, queries in token_groups.items():
        if len(queries) < 2:
            continue
        total_imp = sum(q["impressions"] for q in queries)
        total_clicks = sum(q["clicks"] for q in queries)
        raw_suggestions.append({
            "suggested_keyword": token,
            "queries": [q["query"] for q in queries],
            "query_count": len(queries),
            "total_impressions": total_imp,
            "total_clicks": total_clicks,
        })

    # Sort by total_impressions descending
    raw_suggestions.sort(key=lambda x: x["total_impressions"], reverse=True)

    # Deduplicate: queries in higher-ranked groups excluded from lower
    used_queries: set[str] = set()
    final = []
    for suggestion in raw_suggestions:
        remaining = [q for q in suggestion["queries"] if q not in used_queries]
        if len(remaining) < 2:
            continue
        used_queries.update(remaining)
        # Recalculate metrics with remaining queries only
        remaining_data = [q for q in candidates if q["query"] in set(remaining)]
        total_imp = sum(q["impressions"] for q in remaining_data)
        total_clicks = sum(q["clicks"] for q in remaining_data)
        final.append({
            "suggested_keyword": suggestion["suggested_keyword"],
            "queries": remaining,
            "query_count": len(remaining),
            "total_impressions": total_imp,
            "total_clicks": total_clicks,
        })
        if len(final) >= top_n:
            break

    return final


def detect_issues(ga_metrics: dict, gsc_metrics: dict, article_date: str = "") -> list[str]:
    """Auto-detect issues for an article based on thresholds."""
    issues = []
    imp = gsc_metrics.get("impressions", 0)
    ctr = gsc_metrics.get("ctr", 0)
    clicks = gsc_metrics.get("clicks", 0)
    pos = gsc_metrics.get("avg_position", 0)
    bounce = ga_metrics.get("bounce_rate", 0)
    engagement = ga_metrics.get("engagement_rate", 100)

    t = THRESHOLDS
    if imp >= t["low_ctr_high_imp"]["min_impressions"] and ctr <= t["low_ctr_high_imp"]["max_ctr"]:
        issues.append("low_ctr_high_imp")
    if bounce >= t["high_bounce"]["min_bounce_rate"]:
        issues.append("high_bounce")
    if engagement <= t["low_engagement"]["max_engagement_rate"]:
        issues.append("low_engagement")
    if t["position_opportunity"]["min_position"] <= pos <= t["position_opportunity"]["max_position"]:
        issues.append("position_opportunity")
    if imp >= t["zero_click"]["min_impressions"] and clicks <= t["zero_click"]["max_clicks"]:
        issues.append("zero_click")

    # 公開30日以上経過 & imp 0 → KW不適合の可能性
    if article_date and imp == 0:
        from datetime import date
        try:
            pub = date.fromisoformat(article_date)
            days = (date.today() - pub).days
            if days >= t["zero_impressions"]["min_days_since_publish"]:
                issues.append("zero_impressions")
        except ValueError:
            pass

    return issues


def build_article_metrics(
    blog_articles: list[dict],
    ga_page_metrics: dict[str, dict],
    gsc_page_metrics: dict[str, dict],
) -> list[dict]:
    """Cross-reference GA4 + GSC + blog frontmatter into unified article metrics."""
    all_slugs = set()
    for a in blog_articles:
        all_slugs.add(a["slug"])
    all_slugs.update(ga_page_metrics.keys())
    all_slugs.update(gsc_page_metrics.keys())

    # Build article lookup
    article_lookup = {a["slug"]: a for a in blog_articles}

    results = []
    for slug in sorted(all_slugs):
        article = article_lookup.get(slug, {})
        ga = ga_page_metrics.get(slug, {})
        gsc = gsc_page_metrics.get(slug, {})

        if not ga and not gsc:
            continue

        entry = {
            "slug": slug,
            "title": article.get("title", ""),
            "date": article.get("date", ""),
            "category": article.get("category", ""),
            "gsc": {
                "impressions": gsc.get("impressions", 0),
                "clicks": gsc.get("clicks", 0),
                "ctr": gsc.get("ctr", 0),
                "avg_position": gsc.get("avg_position", 0),
                "top_queries": gsc.get("top_queries", []),
            },
            "ga4": {
                "pageviews": ga.get("pageviews", 0),
                "active_users": ga.get("active_users", 0),
                "bounce_rate": ga.get("bounce_rate", 0),
                "engagement_rate": ga.get("engagement_rate", 0),
                "avg_duration": ga.get("avg_duration", 0),
            },
            "issues": detect_issues(ga, gsc, article.get("date", "")),
        }
        results.append(entry)

    # Sort by total impressions + pageviews (combined visibility)
    results.sort(key=lambda x: x["gsc"]["impressions"] + x["ga4"]["pageviews"], reverse=True)
    return results


def build_category_performance(article_metrics: list[dict]) -> dict:
    """Aggregate performance by blog category to detect domain authority gaps."""
    by_cat: dict[str, dict] = defaultdict(lambda: {
        "count": 0, "total_imp": 0, "total_clicks": 0,
        "total_pv": 0, "zero_imp_count": 0, "slugs": []
    })
    for a in article_metrics:
        cat = a.get("category", "") or "unknown"
        by_cat[cat]["count"] += 1
        by_cat[cat]["total_imp"] += a["gsc"]["impressions"]
        by_cat[cat]["total_clicks"] += a["gsc"]["clicks"]
        by_cat[cat]["total_pv"] += a["ga4"]["pageviews"]
        if a["gsc"]["impressions"] == 0:
            by_cat[cat]["zero_imp_count"] += 1
        by_cat[cat]["slugs"].append(a["slug"])

    result = {}
    for cat, data in by_cat.items():
        n = data["count"]
        result[cat] = {
            "article_count": n,
            "total_impressions": data["total_imp"],
            "total_clicks": data["total_clicks"],
            "avg_impressions": round(data["total_imp"] / n) if n else 0,
            "total_pageviews": data["total_pv"],
            "zero_impression_count": data["zero_imp_count"],
            "zero_impression_rate": round(data["zero_imp_count"] / n * 100, 1) if n else 0,
        }
    return result


def build_domain_authority_map(query_clusters: list[dict]) -> list[dict]:
    """Identify which keyword areas the domain has authority in."""
    authority = []
    for cluster in query_clusters:
        if cluster["cluster"] == "その他":
            continue
        imp = cluster["total_impressions"]
        clicks = cluster["total_clicks"]
        ctr = round(clicks / imp * 100, 1) if imp > 0 else 0
        authority.append({
            "area": cluster["cluster"],
            "impressions": imp,
            "clicks": clicks,
            "ctr": ctr,
            "strength": "strong" if ctr >= 5 and clicks >= 20 else
                        "moderate" if imp >= 100 else "weak",
        })
    authority.sort(key=lambda x: x["impressions"], reverse=True)
    return authority


def build_device_gap(ga_data: dict) -> dict:
    """Calculate mobile vs desktop gap metrics."""
    devices = extract_ga4_device_metrics(ga_data)
    desktop = devices.get("desktop", {})
    mobile = devices.get("mobile", {})

    if not desktop or not mobile:
        return {"available": False}

    return {
        "available": True,
        "desktop": desktop,
        "mobile": mobile,
        "mobile_bounce_gap": round(mobile.get("bounce_rate", 0) - desktop.get("bounce_rate", 0), 1),
        "mobile_engagement_gap": round(mobile.get("engagement_rate", 0) - desktop.get("engagement_rate", 0), 1),
    }



# =============================================================================
# Codebase Audit — static analysis of Next.js project for technical SEO issues
# =============================================================================


def _glob_tsx(base: str, pattern: str = "**/*.tsx") -> list[str]:
    """Recursively find .tsx files under *base*."""
    return sorted(glob.glob(f"{base}/{pattern}", recursive=True))


def _read_text(path: str) -> str:
    """Read file as text, return empty string on failure."""
    try:
        return Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def scan_jsonld_usage(project_dir: str) -> dict:
    """Detect JSON-LD schema types and which pages use them."""
    structured_data_file = f"{project_dir}/lib/structured-data.tsx"
    content = _read_text(structured_data_file)

    # Extract exported component names (e.g. OrganizationJsonLd)
    available = re.findall(r"export\s+function\s+(\w+JsonLd)", content)

    # Scan app/ pages for JSON-LD usage
    global_schemas: list[str] = []
    page_usage: dict[str, list[str]] = {}
    pages_without: list[str] = []

    layout_file = f"{project_dir}/app/layout.tsx"
    layout_content = _read_text(layout_file)
    for comp in available:
        if f"<{comp}" in layout_content or f"{comp}(" in layout_content:
            global_schemas.append(comp)

    for page_path in _glob_tsx(f"{project_dir}/app", "**/page.tsx"):
        rel = str(Path(page_path).relative_to(project_dir))
        page_content = _read_text(page_path)
        used = [c for c in available if f"<{c}" in page_content or f"{c}(" in page_content]
        if used:
            page_usage[rel] = used
        else:
            pages_without.append(rel)

    # Issue detection
    issues: list[dict] = []
    for page in pages_without:
        # Skip special pages
        if any(skip in page for skip in ["not-found", "error", "loading", "opengraph", "twitter"]):
            continue
        issues.append({
            "type": "no_jsonld",
            "page": page,
            "severity": "low",
            "description": f"{page} に JSON-LD 構造化データがない",
        })

    return {
        "available_types": available,
        "global_schemas": global_schemas,
        "page_usage": page_usage,
        "pages_without_jsonld": pages_without,
        "issues": issues,
    }


def scan_metadata_completeness(project_dir: str) -> dict:
    """Check metadata/OGP coverage across page templates."""
    pages: list[dict] = []
    fields_to_check = {
        "title": [r"\btitle\s*:", r"\btitle\s*="],
        "description": [r"\bdescription\s*:"],
        "openGraph": [r"\bopenGraph\s*:", r"\bOpenGraph"],
        "twitter": [r"\btwitter\s*:"],
        "canonical": [r"\bcanonical\s*:", r"\balternates\s*:"],
    }

    for page_path in _glob_tsx(f"{project_dir}/app", "**/page.tsx"):
        rel = str(Path(page_path).relative_to(project_dir))
        content = _read_text(page_path)

        has_metadata = bool(
            re.search(r"export\s+(async\s+)?function\s+generateMetadata", content)
            or re.search(r"export\s+const\s+metadata", content)
        )
        if not has_metadata:
            pages.append({"path": rel, "metadata_type": "none", "issues": ["no_metadata"]})
            continue

        metadata_type = "generateMetadata" if "generateMetadata" in content else "static"
        entry: dict = {"path": rel, "metadata_type": metadata_type, "issues": []}

        for field, patterns in fields_to_check.items():
            found = any(re.search(p, content) for p in patterns)
            entry[f"has_{field}"] = found
            if not found and field in ("title", "description"):
                entry["issues"].append(f"missing_{field}")

        pages.append(entry)

    # Summary
    total = len(pages)
    with_meta = sum(1 for p in pages if p["metadata_type"] != "none")
    with_og = sum(1 for p in pages if p.get("has_openGraph"))
    with_canonical = sum(1 for p in pages if p.get("has_canonical"))

    return {
        "pages": pages,
        "summary": {
            "total_pages": total,
            "with_metadata": with_meta,
            "with_openGraph": with_og,
            "with_canonical": with_canonical,
        },
    }


def scan_sitemap_config(project_dir: str) -> dict:
    """Analyse sitemap.ts for coverage and configuration."""
    sitemap_path = f"{project_dir}/app/sitemap.ts"
    content = _read_text(sitemap_path)

    if not content:
        return {"file": None, "issues": [{"type": "no_sitemap", "severity": "critical"}]}

    # Detect revalidation
    revalidate_match = re.search(r"revalidate\s*=\s*(\d+)", content)
    revalidate = int(revalidate_match.group(1)) if revalidate_match else None

    # Detect content types by scanning function calls and URL patterns
    content_types: list[str] = []
    type_patterns = {
        "static": r"url:\s*['\"`]https?://[^'\"]+/(about|contact|service|solutions)",
        "blog": r"getAllBlogPosts|/blog/\$",
        "blog_category": r"/blog/category/",
        "blog_hub": r"/blog/hub/",
        "news": r"getAllNewsPosts|/news/",
    }
    for ctype, pattern in type_patterns.items():
        if re.search(pattern, content):
            content_types.append(ctype)

    # Extract priority values
    priorities: dict[str, float] = {}
    for m in re.finditer(r"priority:\s*([\d.]+)", content):
        priorities[f"priority_{len(priorities)}"] = float(m.group(1))

    issues: list[dict] = []
    if "blog_hub" not in content_types:
        issues.append({"type": "missing_hub_pages", "severity": "medium",
                        "description": "ハブページが sitemap に含まれていない"})

    return {
        "file": "app/sitemap.ts",
        "revalidate": revalidate,
        "content_types": content_types,
        "priority_values": sorted(set(priorities.values()), reverse=True),
        "issues": issues,
    }


def scan_robots_config(project_dir: str) -> dict:
    """Parse robots.ts for allow/disallow rules."""
    robots_path = f"{project_dir}/app/robots.ts"
    content = _read_text(robots_path)

    if not content:
        return {"file": None, "issues": [{"type": "no_robots", "severity": "high"}]}

    # Extract disallow paths
    disallow = re.findall(r"disallow:\s*\[([^\]]*)\]", content, re.DOTALL)
    disallow_paths: list[str] = []
    if disallow:
        disallow_paths = re.findall(r"['\"]([^'\"]+)['\"]", disallow[0])

    # Extract sitemap URL
    sitemap_match = re.search(r"sitemap:\s*['\"]([^'\"]+)['\"]", content)
    sitemap_url = sitemap_match.group(1) if sitemap_match else None

    return {
        "file": "app/robots.ts",
        "disallow_paths": disallow_paths,
        "sitemap_url": sitemap_url,
        "issues": [],
    }


_IMAGE_EXT_PATTERN = re.compile(r"\.(webp|png|jpe?g|svg|gif|avif)$", re.IGNORECASE)


def _load_hub_slugs(blog_dir: str) -> set[str]:
    """Read hub slugs from lib/blog-hubs.ts so /blog/hub/* links are valid.

    blog_dir は通常 'content/blog'。Next.js プロジェクト構成では
    `<repo>/content/blog/` と `<repo>/lib/blog-hubs.ts` が同じリポジトリルートを
    親に持つため、blog_dir から 2 階層上に登ってから lib/ を参照する。
    """
    blog_path = Path(blog_dir).resolve()
    # blog_path: <repo>/content/blog → parent.parent: <repo>
    hub_file = blog_path.parent.parent / "lib" / "blog-hubs.ts"
    if not hub_file.exists():
        return set()
    content = _read_text(str(hub_file))
    # Match keys like  'salon-dx-shift-management': {
    return set(re.findall(r"'([a-z0-9-]+)':\s*\{", content))


def scan_internal_links(blog_dir: str) -> dict:
    """Build internal link graph from MDX content."""
    # 画像は markdown image syntax `![alt](/blog/...)` を含むが、
    # `\[...\]\(...\)` は `![alt](url)` の `[alt](url)` 部分にも一致してしまう。
    # 画像存在確認は image scanner の責務なので、内部リンクの broken 判定からは画像を除外する。
    link_pattern = re.compile(r"\[([^\]]*)\]\((/blog/[^)#\s]+)")
    articles = scan_blog_articles(blog_dir)
    known_slugs = {a["slug"] for a in articles}
    hub_slugs = _load_hub_slugs(blog_dir)

    outgoing: dict[str, list[str]] = defaultdict(list)
    incoming: dict[str, list[str]] = defaultdict(list)
    broken: list[dict] = []

    for mdx_path in sorted(glob.glob(f"{blog_dir}/*.mdx")):
        src_slug = Path(mdx_path).stem
        if re.match(r"\d{4}-\d{2}-\d{2}-", src_slug):
            src_slug = src_slug[11:]

        content = _read_text(mdx_path)
        for _text, href in link_pattern.findall(content):
            # Skip image references (handled by image scanner, not internal links)
            if _IMAGE_EXT_PATTERN.search(href):
                continue
            # Recognize /blog/hub/* as valid link targets
            if href.startswith("/blog/hub/"):
                hub_slug = href.strip("/").split("/")[-1]
                if hub_slug in hub_slugs:
                    continue  # valid hub page link, skip
            target_slug = href.strip("/").split("/")[-1]
            if target_slug in known_slugs:
                if target_slug not in outgoing[src_slug]:
                    outgoing[src_slug].append(target_slug)
                if src_slug not in incoming[target_slug]:
                    incoming[target_slug].append(src_slug)
            else:
                broken.append({"source": src_slug, "target": href})

    # Orphan detection: articles with no incoming AND no outgoing links
    orphans = [s for s in known_slugs if s not in outgoing and s not in incoming]
    orphan_rate = round(len(orphans) / len(known_slugs) * 100, 1) if known_slugs else 0

    issues: list[dict] = []
    if orphan_rate > 50:
        issues.append({
            "type": "high_orphan_rate",
            "severity": "high",
            "rate": orphan_rate,
            "description": f"記事の {orphan_rate}% に内部リンクがない（孤立記事）",
        })
    for bl in broken:
        issues.append({
            "type": "broken_internal_link",
            "severity": "medium",
            "source": bl["source"],
            "target": bl["target"],
            "description": f"{bl['source']} → {bl['target']} はリンク切れ",
        })

    return {
        "total_articles": len(known_slugs),
        "articles_with_outgoing": len(outgoing),
        "articles_with_incoming": len(incoming),
        "orphan_articles": sorted(orphans),
        "orphan_rate": orphan_rate,
        "broken_links": broken,
        "link_graph_sample": {
            slug: {"outgoing": out, "incoming": list(incoming.get(slug, []))}
            for slug, out in sorted(outgoing.items())[:20]
        },
        "issues": issues,
    }


def scan_image_optimization(project_dir: str, blog_dir: str) -> dict:
    """Check image optimization config and usage patterns."""
    # next.config.ts
    config_content = _read_text(f"{project_dir}/next.config.ts")
    if not config_content:
        config_content = _read_text(f"{project_dir}/next.config.mjs")
    if not config_content:
        config_content = _read_text(f"{project_dir}/next.config.js")

    formats: list[str] = re.findall(r"image/(avif|webp)", config_content)

    # Count next/image vs raw <img> in components
    next_image_count = 0
    raw_img_count = 0
    for tsx_path in _glob_tsx(f"{project_dir}/app") + _glob_tsx(f"{project_dir}/components"):
        content = _read_text(tsx_path)
        if "next/image" in content or "from 'next/image'" in content or 'from "next/image"' in content:
            next_image_count += 1
        if re.search(r"<img\s", content):
            raw_img_count += 1

    # Blog frontmatter images
    articles = scan_blog_articles(blog_dir)
    webp_count = 0
    non_webp: list[str] = []
    no_image: list[str] = []
    for mdx_path in sorted(glob.glob(f"{blog_dir}/*.mdx")):
        fm = parse_frontmatter(mdx_path)
        if not fm:
            continue
        img = fm.get("image", "")
        slug = Path(mdx_path).stem
        if re.match(r"\d{4}-\d{2}-\d{2}-", slug):
            slug = slug[11:]
        if not img:
            no_image.append(slug)
        elif img.endswith(".webp"):
            webp_count += 1
        else:
            non_webp.append(slug)

    issues: list[dict] = []
    if raw_img_count > 0:
        issues.append({
            "type": "raw_img_tag",
            "severity": "medium",
            "count": raw_img_count,
            "description": f"{raw_img_count} ファイルで next/image ではなく <img> を使用",
        })
    if non_webp:
        issues.append({
            "type": "non_webp_blog_images",
            "severity": "low",
            "slugs": non_webp,
            "description": f"{len(non_webp)} 記事で WebP 以外の画像を使用",
        })

    return {
        "next_config_formats": sorted(set(formats)),
        "files_using_next_image": next_image_count,
        "files_using_raw_img": raw_img_count,
        "blog_images": {
            "total": len(articles),
            "webp": webp_count,
            "non_webp": len(non_webp),
            "no_image": len(no_image),
        },
        "issues": issues,
    }


def scan_noindex_canonical(project_dir: str) -> dict:
    """Detect noindex directives and canonical URL coverage."""
    noindex_pages: list[str] = []
    pages_with_canonical: list[str] = []
    pages_without_canonical: list[str] = []

    for page_path in _glob_tsx(f"{project_dir}/app", "**/page.tsx"):
        rel = str(Path(page_path).relative_to(project_dir))
        content = _read_text(page_path)

        # Skip non-content pages
        if any(skip in rel for skip in ["not-found", "error", "loading"]):
            continue

        if re.search(r"noindex\s*:\s*true", content):
            noindex_pages.append(rel)

        if re.search(r"canonical\s*:|alternates\s*:", content):
            pages_with_canonical.append(rel)
        else:
            pages_without_canonical.append(rel)

    issues: list[dict] = []
    # Blog article pages without canonical is a notable gap
    for page in pages_without_canonical:
        if "[slug]" in page and "blog" in page:
            issues.append({
                "type": "missing_canonical",
                "page": page,
                "severity": "medium",
                "description": "ブログ記事ページに canonical URL が未設定",
            })

    return {
        "noindex_pages": noindex_pages,
        "pages_with_canonical": pages_with_canonical,
        "pages_without_canonical": pages_without_canonical,
        "issues": issues,
    }


def build_codebase_audit(project_dir: str, blog_dir: str) -> dict:
    """Run all codebase audit scans and return consolidated results."""
    jsonld = scan_jsonld_usage(project_dir)
    metadata = scan_metadata_completeness(project_dir)
    sitemap = scan_sitemap_config(project_dir)
    robots = scan_robots_config(project_dir)
    internal_links = scan_internal_links(blog_dir)
    images = scan_image_optimization(project_dir, blog_dir)
    noindex_canonical = scan_noindex_canonical(project_dir)

    # Aggregate issues
    all_issues: list[dict] = []
    for section in [jsonld, metadata, sitemap, robots, internal_links, images, noindex_canonical]:
        all_issues.extend(section.get("issues", []))

    severity_counts = defaultdict(int)
    for issue in all_issues:
        severity_counts[issue.get("severity", "low")] += 1

    return {
        "jsonld": jsonld,
        "metadata": metadata,
        "sitemap": sitemap,
        "robots": robots,
        "internal_links": internal_links,
        "image_optimization": images,
        "noindex_canonical": noindex_canonical,
        "summary": {
            "total_issues": len(all_issues),
            "critical": severity_counts.get("critical", 0),
            "high": severity_counts.get("high", 0),
            "medium": severity_counts.get("medium", 0),
            "low": severity_counts.get("low", 0),
        },
    }


def build_output(
    ga_data: dict | None,
    gsc_data: dict | None,
    trends_data: dict | None,
    blog_dir: str,
    args: argparse.Namespace,
    config: dict,
) -> dict:
    """Build the complete strategy analyzer output."""
    blog_articles = scan_blog_articles(blog_dir)
    content_path_prefix = config.get("content_path_prefix", "/blog/")

    # Extract metrics
    ga_page_metrics = extract_ga4_page_metrics(ga_data, content_path_prefix) if ga_data else {}
    gsc_page_metrics = extract_gsc_page_metrics(gsc_data, content_path_prefix) if gsc_data else {}

    # Build cross-referenced article metrics
    article_metrics = build_article_metrics(blog_articles, ga_page_metrics, gsc_page_metrics)

    # Build output
    output: dict = {
        "metadata": {
            "generated_at": datetime.now().astimezone().isoformat(),
            "site": config.get("site", ""),
            "config": args.config or None,
            "data_sources": {
                "ga_report": args.ga_report or None,
                "gsc_report": args.gsc_report or None,
                "trends_report": args.trends_report or None,
            },
            "blog_articles_scanned": len(blog_articles),
            "articles_with_metrics": len(article_metrics),
        },
    }

    # KPI Snapshot
    kpi: dict = {}
    if ga_data:
        kpi["ga4"] = extract_ga4_kpi(ga_data)
    if gsc_data:
        kpi["gsc"] = extract_gsc_kpi(gsc_data)
    output["kpi_snapshot"] = kpi

    # Article metrics
    output["article_metrics"] = article_metrics

    # Query clusters + cluster suggestions (GSC)
    if gsc_data:
        clusters, unclustered = build_query_clusters(gsc_data, blog_articles, config)
        output["query_clusters"] = clusters
        output["cluster_suggestions"] = build_cluster_suggestions(unclustered, config)

    # Category performance
    output["category_performance"] = build_category_performance(article_metrics)

    # Domain authority map (requires query_clusters)
    if "query_clusters" in output:
        output["domain_authority_map"] = build_domain_authority_map(output["query_clusters"])

    # Device gap (GA4)
    if ga_data:
        output["device_gap"] = build_device_gap(ga_data)

    # Channel metrics (GA4)
    if ga_data:
        output["channel_metrics"] = extract_ga4_channel_metrics(ga_data)

    # Trends data summary (pass through key sections for LLM)
    if trends_data:
        output["trends_summary"] = {
            "market_context": trends_data.get("market_context", {}),
            "keyword_clusters": [
                {
                    "cluster_name": c.get("cluster_name", ""),
                    "trend_score": c.get("trends_validation", {}).get("trend_score", 0),
                    "trend_direction": c.get("trends_validation", {}).get("trend_direction", ""),
                }
                for c in trends_data.get("keyword_clusters", [])
            ],
            "emerging_opportunities": trends_data.get("emerging_opportunities", []),
        }

    # Blog article list (for LLM to understand existing coverage)
    output["existing_articles"] = [
        {"slug": a["slug"], "title": a["title"], "date": a["date"], "category": a["category"]}
        for a in blog_articles
    ]

    # Content overlap analysis (Issue #69): mechanical KW × article coverage
    # Prevents new_article_directions from cannibalizing GSC-not-yet-indexed
    # newly-published articles. Always emitted (clusters: [] when no KW config).
    output["content_overlap_analysis"] = build_content_overlap_analysis(
        blog_articles, config,
    )

    # Codebase audit (technical SEO from source code)
    project_dir = getattr(args, "project_dir", None) or "."
    output["codebase_audit"] = build_codebase_audit(project_dir, blog_dir)

    return output


def main():
    parser = argparse.ArgumentParser(description="SEO Strategy Analyzer")
    parser.add_argument("--ga-report", help="Path to GA4 report JSON")
    parser.add_argument("--gsc-report", help="Path to GSC report JSON")
    parser.add_argument("--trends-report", help="Path to Trends report JSON")
    parser.add_argument("--config", help="Path to seo-config.json")
    parser.add_argument("--blog-dir", help="Blog directory path (overrides config)")
    parser.add_argument("--project-dir", default=".", help="Project root directory for codebase audit")
    parser.add_argument("--output", default="claudedocs/seo-strategy-analysis.json", help="Output path")
    args = parser.parse_args()

    # Load config
    config = load_config(args.config)

    # blog-dir: CLI arg > config > default
    blog_dir = args.blog_dir or config.get("content_dir", "content/blog")

    # Load data
    ga_data = load_json(args.ga_report)
    gsc_data = load_json(args.gsc_report)
    trends_data = load_json(args.trends_report)

    if not ga_data and not gsc_data:
        print("Error: At least one of --ga-report or --gsc-report is required.", file=sys.stderr)
        sys.exit(1)

    # Build analysis
    output = build_output(ga_data, gsc_data, trends_data, blog_dir, args, config)

    # Write output
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    # Summary to stdout
    n_articles = len(output.get("article_metrics", []))
    n_issues = sum(len(a["issues"]) for a in output.get("article_metrics", []))
    n_clusters = len(output.get("query_clusters", []))
    n_suggestions = len(output.get("cluster_suggestions", []))
    audit_summary = output.get("codebase_audit", {}).get("summary", {})
    n_audit_issues = audit_summary.get("total_issues", 0)
    overlap = output.get("content_overlap_analysis", {}) or {}
    overlap_clusters = overlap.get("clusters", []) or []
    n_overlap = len(overlap_clusters)
    n_high_sat = sum(1 for c in overlap_clusters if c.get("saturation") == "high")
    print(
        f"Analysis complete: {n_articles} articles, {n_issues} issues detected, "
        f"{n_clusters} query clusters, {n_suggestions} cluster suggestions, "
        f"{n_audit_issues} codebase audit issues, "
        f"{n_overlap} overlap clusters analyzed ({n_high_sat} high saturation)"
    )
    print(f"Output: {args.output}")


if __name__ == "__main__":
    main()
