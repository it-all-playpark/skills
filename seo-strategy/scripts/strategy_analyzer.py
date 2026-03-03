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

# --- Issue auto-detection thresholds ---
THRESHOLDS = {
    "low_ctr_high_imp": {"min_impressions": 100, "max_ctr": 3.0},
    "high_bounce": {"min_bounce_rate": 65.0},
    "low_engagement": {"max_engagement_rate": 35.0},
    "position_opportunity": {"min_position": 8, "max_position": 20},
    "zero_click": {"min_impressions": 50, "max_clicks": 0},
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


def load_config(path: str | None) -> dict:
    """Load config JSON and merge with defaults."""
    config = dict(DEFAULT_CONFIG)
    if path:
        user_config = load_json(path)
        if user_config:
            config.update(user_config)
    return config


def parse_frontmatter(mdx_path: str) -> dict | None:
    """Extract frontmatter from MDX file."""
    try:
        with open(mdx_path) as f:
            content = f.read()
    except (OSError, UnicodeDecodeError):
        return None

    match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return None

    fm = {}
    for line in match.group(1).split("\n"):
        if ":" in line:
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if value:
                fm[key] = value
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
            "tags": [t.strip() for t in fm.get("tags", "").split(",") if t.strip()],
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

    # GSC reports may vary in structure; handle common formats
    rows = []
    if isinstance(gsc_data, list):
        rows = gsc_data
    elif isinstance(gsc_data, dict):
        rows = gsc_data.get("rows", gsc_data.get("search_analytics", {}).get("rows", []))

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
    """Extract site-wide GSC KPIs."""
    rows = []
    if isinstance(gsc_data, list):
        rows = gsc_data
    elif isinstance(gsc_data, dict):
        rows = gsc_data.get("rows", gsc_data.get("search_analytics", {}).get("rows", []))

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
    rows = []
    if isinstance(gsc_data, list):
        rows = gsc_data
    elif isinstance(gsc_data, dict):
        rows = gsc_data.get("rows", gsc_data.get("search_analytics", {}).get("rows", []))

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


def detect_issues(ga_metrics: dict, gsc_metrics: dict) -> list[str]:
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
            "issues": detect_issues(ga, gsc),
        }
        results.append(entry)

    # Sort by total impressions + pageviews (combined visibility)
    results.sort(key=lambda x: x["gsc"]["impressions"] + x["ga4"]["pageviews"], reverse=True)
    return results


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

    return output


def main():
    parser = argparse.ArgumentParser(description="SEO Strategy Analyzer")
    parser.add_argument("--ga-report", help="Path to GA4 report JSON")
    parser.add_argument("--gsc-report", help="Path to GSC report JSON")
    parser.add_argument("--trends-report", help="Path to Trends report JSON")
    parser.add_argument("--config", help="Path to seo-config.json")
    parser.add_argument("--blog-dir", help="Blog directory path (overrides config)")
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
    print(f"Analysis complete: {n_articles} articles, {n_issues} issues detected, {n_clusters} query clusters, {n_suggestions} cluster suggestions")
    print(f"Output: {args.output}")


if __name__ == "__main__":
    main()
