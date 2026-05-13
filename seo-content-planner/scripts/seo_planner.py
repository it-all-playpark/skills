#!/usr/bin/env python3
"""
SEO Content Planner - GA4実績 × Trendsデータ × GSCデータから記事ネタを提案

Usage:
    python seo_planner.py --ga-report ga_report.json --trends-report trends_report.json [options]
    python seo_planner.py --trends-report trends_report.json [options]
    python seo_planner.py --trends-report trends.json --gsc-report gsc.json --output-format content_strategy
    python seo_planner.py --trends-report trends.json --strategy seo-strategy.json --output-format content_strategy

Required:
    --trends-report     trends-analyzer の出力JSONパス

Optional:
    --ga-report         ga-analyzer の出力JSONパス（より精度の高いスコアリングに使用）
    --gsc-report        GSC export JSON（CTR/掲載順位データによるスコアリング強化）
    --strategy          seo-strategy.json パス（戦略に基づくスコアリング強化）
    --output            出力ファイルパス (default: content_plan.json)
    --top-n             出力する記事ネタ候補数 (default: 15)
    --output-format     content_plan | content_strategy (default: content_plan)
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path


def load_json(path: str) -> dict:
    """JSONファイルを読み込む。"""
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"Error loading {path}: {e}")
        sys.exit(1)


def load_published_articles(blog_dir: str) -> set[str]:
    """content/blog/*.mdx の frontmatter から既存記事のテーマを抽出し、除外用キーワード set を返す。

    抽出対象:
    - tags (YAML list): 記事の主題タグ
    - title 内の `【〜】` フレーズ: 記事の主題ピック

    Returns:
        set of lowercase normalized strings (length >= 2)
    """
    published: set[str] = set()
    p = Path(blog_dir)
    if not p.is_dir():
        return published

    bracket_pattern = re.compile(r"【([^】]+)】")

    for mdx in sorted(p.glob("*.mdx")):
        try:
            text = mdx.read_text(encoding="utf-8")
        except OSError:
            continue
        # frontmatter (between first two `---`)
        m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
        if not m:
            continue
        fm = m.group(1)

        # title: '【foo bar】baz' or "title: foo"
        title_match = re.search(r"^title:\s*[\"']?(.+?)[\"']?\s*$", fm, re.MULTILINE)
        if title_match:
            title_raw = title_match.group(1).strip()
            for b in bracket_pattern.findall(title_raw):
                phrase = b.strip().lower()
                if 2 <= len(phrase) <= 40:
                    published.add(phrase)

        # tags: YAML list (- item) 形式
        tags_section_match = re.search(
            r"^tags:\s*\n((?:[ \t]+-[ \t].+\n?)+)", fm, re.MULTILINE
        )
        if tags_section_match:
            for tm in re.finditer(
                r"^[ \t]+-[ \t]*[\"']?([^\"'\n]+?)[\"']?\s*$",
                tags_section_match.group(1),
                re.MULTILINE,
            ):
                tag = tm.group(1).strip().lower()
                if 2 <= len(tag) <= 40:
                    published.add(tag)

        # tags: [a, b, c] インライン形式（後方互換）
        inline_match = re.search(r"^tags:\s*\[([^\]]+)\]", fm, re.MULTILINE)
        if inline_match:
            for raw in inline_match.group(1).split(","):
                tag = raw.strip().strip("\"'").lower()
                if 2 <= len(tag) <= 40:
                    published.add(tag)

    return published


def load_strategy(path: str) -> dict | None:
    """seo-strategy.json を読み込み、プランニングに必要な情報を抽出する。

    Returns:
        {
            "keyword_areas": {area_lower: {priority, funnel, suggested_angles}},
            "rewrite_slugs": set of slugs to exclude,
            "rewrite_keywords": set of lowercase query strings for exclusion matching,
            "raw": original JSON data,
        }
    """
    try:
        with open(path) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"Warning: Could not load strategy file {path}: {e}")
        return None

    # new_article_directions からキーワード領域を抽出
    directions = data.get("new_article_directions", [])
    keyword_areas = {}
    for d in directions:
        area = d.get("keyword_area", "")
        if area:
            keyword_areas[area.lower()] = {
                "priority": d.get("priority", "medium"),
                "funnel": d.get("funnel", "認知"),
                "suggested_angles": d.get("suggested_angles", []),
            }

    # existing_article_optimizations のリライト対象 slug + target_queries を収集
    optimizations = data.get("existing_article_optimizations", [])
    rewrite_slugs = set()
    rewrite_keywords = set()
    for opt in optimizations:
        slug = opt.get("slug", "")
        if slug:
            rewrite_slugs.add(slug)
            for q in opt.get("target_queries", []):
                rewrite_keywords.add(q.lower())

    print(
        f"  Strategy loaded: {len(keyword_areas)} keyword areas, "
        f"{len(rewrite_slugs)} rewrite targets, "
        f"{len(rewrite_keywords)} rewrite keywords"
    )
    return {
        "keyword_areas": keyword_areas,
        "rewrite_slugs": rewrite_slugs,
        "rewrite_keywords": rewrite_keywords,
        "raw": data,
    }


def match_strategy_keyword_area(keyword: str, keyword_areas: dict) -> tuple[str, dict] | None:
    """キーワードと戦略のキーワード領域をマッチングする。

    部分一致: keyword_area の単語がキーワードに含まれる、またはその逆。

    Returns:
        マッチ時: (area_name, area_data)
        マッチなし: None
    """
    keyword_lower = keyword.lower()
    for area_name, area_data in keyword_areas.items():
        # area の単語を分割して部分マッチ
        area_words = area_name.split()
        if any(word in keyword_lower for word in area_words):
            return (area_name, area_data)
        # 逆方向: keyword の単語が area に含まれる
        kw_words = keyword_lower.split()
        if any(word in area_name for word in kw_words if len(word) >= 2):
            return (area_name, area_data)
    return None


def extract_ga_metrics(ga_data: dict) -> dict:
    """GA4データからページごとのパフォーマンス指標を抽出する。"""
    metrics = {}

    # ページタイトルごとのメトリクス
    page_titles = ga_data.get("content", {}).get("page_titles", {}).get("rows", [])
    for row in page_titles:
        title = row.get("pageTitle", "")
        metrics[title] = {
            "views": int(row.get("screenPageViews", 0)),
            "avg_duration": float(row.get("averageSessionDuration", 0)),
            "bounce_rate": float(row.get("bounceRate", 0)),
            "engagement_rate": float(row.get("engagementRate", 0)),
        }

    # トラフィックソース情報
    source_data = ga_data.get("traffic", {}).get("traffic_sources", {}).get("rows", [])
    organic_ratio = 0
    total_sessions = sum(int(r.get("sessions", 0)) for r in source_data)
    for row in source_data:
        if row.get("sessionDefaultChannelGroup") == "Organic Search":
            organic_sessions = int(row.get("sessions", 0))
            organic_ratio = organic_sessions / total_sessions if total_sessions else 0

    return {"pages": metrics, "organic_ratio": organic_ratio, "total_sessions": total_sessions}


def extract_gsc_metrics(gsc_data: dict) -> dict:
    """GSC JSONデータからクエリ別メトリクスを抽出・集約する。

    Auto-threshold: total_impressions < 100 の場合はGSCスコアリングを無効化（ログのみ）。

    Returns:
        {
            "enabled": bool,
            "total_impressions": int,
            "queries": {
                query: {"clicks": N, "impressions": N, "ctr": F, "position": F}
            }
        }
    """
    rows = gsc_data.get("rows", [])

    queries: dict[str, dict] = {}
    total_impressions = 0

    for row in rows:
        # GSC export format: keys[] contains query string, or direct "query" field
        keys = row.get("keys", [])
        query = keys[0] if keys else row.get("query", "")
        if not query:
            continue

        clicks = int(row.get("clicks", 0))
        impressions = int(row.get("impressions", 0))
        ctr = float(row.get("ctr", 0))
        position = float(row.get("position", 0))

        total_impressions += impressions

        if query in queries:
            existing = queries[query]
            total_imp = existing["impressions"] + impressions
            existing["clicks"] += clicks
            existing["impressions"] = total_imp
            # Weighted average for CTR and position
            if total_imp > 0:
                existing["ctr"] = (existing["clicks"] / total_imp) * 100
                existing["position"] = (
                    (existing["position"] * (total_imp - impressions))
                    + (position * impressions)
                ) / total_imp
        else:
            queries[query] = {
                "clicks": clicks,
                "impressions": impressions,
                "ctr": ctr * 100 if ctr < 1 else ctr,  # Normalize to percentage
                "position": position,
            }

    enabled = total_impressions >= 100
    if not enabled:
        print(
            f"  GSC threshold not met: {total_impressions} impressions < 100. "
            f"GSC scoring disabled (data retained for reference)."
        )

    print(
        f"  GSC data: {len(queries)} queries, {total_impressions} total impressions, "
        f"scoring {'enabled' if enabled else 'disabled'}"
    )

    return {
        "enabled": enabled,
        "total_impressions": total_impressions,
        "queries": queries,
    }


def match_gsc_to_keyword(keyword: str, gsc_metrics: dict) -> dict | None:
    """トレンドキーワードとGSCクエリの部分一致マッチングを行う。

    Returns:
        マッチした場合: {
            total_clicks, total_impressions, avg_ctr, avg_position,
            top_queries (top 5), action_type, ctr_gap_signal
        }
        マッチなしの場合: None
    """
    queries = gsc_metrics.get("queries", {})
    if not queries:
        return None

    keyword_lower = keyword.lower()
    matched: list[tuple[str, dict]] = []

    for query, data in queries.items():
        query_lower = query.lower()
        # Partial match: keyword appears in query or query appears in keyword
        if keyword_lower in query_lower or query_lower in keyword_lower:
            matched.append((query, data))

    if not matched:
        return None

    # Aggregate matched queries
    total_clicks = sum(d["clicks"] for _, d in matched)
    total_impressions = sum(d["impressions"] for _, d in matched)
    avg_ctr = (total_clicks / total_impressions * 100) if total_impressions > 0 else 0.0
    avg_position = (
        sum(d["position"] * d["impressions"] for _, d in matched) / total_impressions
        if total_impressions > 0
        else 0.0
    )

    # Top 5 queries by impressions
    matched.sort(key=lambda x: x[1]["impressions"], reverse=True)
    top_queries = [
        {"query": q, "clicks": d["clicks"], "impressions": d["impressions"]}
        for q, d in matched[:5]
    ]

    # CTR gap classification
    if total_impressions >= 100 and avg_ctr < 3.0:
        action_type = "optimize_existing"
        ctr_gap_signal = "low_ctr_high_impressions"
    elif total_clicks > 0:
        action_type = "write_new"
        ctr_gap_signal = "has_traffic"
    else:
        action_type = "write_new"
        ctr_gap_signal = "no_traffic"

    return {
        "total_clicks": total_clicks,
        "total_impressions": total_impressions,
        "avg_ctr": round(avg_ctr, 2),
        "avg_position": round(avg_position, 1),
        "top_queries": top_queries,
        "action_type": action_type,
        "ctr_gap_signal": ctr_gap_signal,
    }


def compute_gsc_position_bonus(gsc_match: dict) -> float:
    """GSC掲載順位に基づくボーナススコアを算出する (0-15 points)。

    Position scoring:
    - Position 1-3: 15 points (top positions, high CTR improvement potential)
    - Position 4-10: linear decay 15 -> 0 (first page)
    - Position 11-20: linear decay 5 -> 0 (second page, close to top)
    - Position 21+: 0 points

    Impression weight: min(1.0, impressions / 500) to scale by actual volume.
    """
    position = gsc_match.get("avg_position", 0)
    impressions = gsc_match.get("total_impressions", 0)

    # Position score
    if position <= 0:
        position_score = 0.0
    elif position <= 3:
        position_score = 15.0
    elif position <= 10:
        # Linear decay from 15 to 0 over positions 4-10
        position_score = 15.0 * (10 - position) / (10 - 3)
    elif position <= 20:
        # Linear decay from 5 to 0 over positions 11-20
        position_score = 5.0 * (20 - position) / (20 - 10)
    else:
        position_score = 0.0

    # Impression weight
    impression_weight = min(1.0, impressions / 500)

    return round(position_score * impression_weight, 1)


def compute_seo_scores(
    trends_data: dict,
    ga_metrics: dict | None = None,
    top_n: int = 15,
    gsc_metrics: dict | None = None,
    strategy_data: dict | None = None,
    published_keywords: set[str] | None = None,
) -> list[dict]:
    """GA4実績 × トレンドスコア × GSCデータ × 戦略データからSEOスコアを算出する。

    スコアリング基準:
    - trend_score (0-40): トレンド方向 × 関心度
    - content_gap_score (0-30): 関連上昇クエリの多さ（未カバー領域の発見）
    - ga_performance_score (0-30): GA実績（ある場合）
    - gsc_position_bonus (0-15): GSC掲載順位ボーナス（ある場合）
    - funnel_bonus (0-15): ファネルボーナス（content_strategy出力時に計算）
    - strategy_bonus (0-15): 戦略キーワード領域マッチボーナス（ある場合）
    """
    trend_scores = trends_data.get("trend_scores", [])
    keywords_meta = {
        kw["keyword"]: kw for kw in trends_data.get("keywords", [])
    }

    gsc_enabled = gsc_metrics and gsc_metrics.get("enabled", False)
    strategy_keyword_areas = strategy_data.get("keyword_areas", {}) if strategy_data else {}
    strategy_rewrite_keywords = strategy_data.get("rewrite_keywords", set()) if strategy_data else set()
    published_keywords = published_keywords or set()

    excluded_by_published = 0
    results = []
    for ts in trend_scores:
        kw = ts["keyword"]
        meta = keywords_meta.get(kw, {})
        kw_lower = kw.lower()

        # リライト対象キーワードを新規提案から除外
        if strategy_rewrite_keywords:
            if any(rk in kw_lower or kw_lower in rk for rk in strategy_rewrite_keywords):
                continue

        # 既存公開記事のテーマと被るキーワードを除外
        # - 完全一致: 常に除外
        # - 部分一致: pk/kw 両方が長さ4以上のときのみ（短語の過剰除外を避ける）
        if published_keywords:
            if any(
                pk == kw_lower
                or (len(pk) >= 4 and len(kw_lower) >= 4 and (pk in kw_lower or kw_lower in pk))
                for pk in published_keywords
            ):
                excluded_by_published += 1
                continue

        # 1. Trend Score (0-40)
        direction_multiplier = {
            "rising": 1.5,
            "stable": 1.0,
            "declining": 0.5,
            "unknown": 0.7,
        }.get(ts.get("trend_direction", "unknown"), 0.7)

        avg_interest = ts.get("avg_interest", 0)
        trend_score = min(40, (avg_interest / 100) * 40 * direction_multiplier)

        # 2. Content Gap Score (0-30)
        rising_count = len(ts.get("rising_queries", []))
        top_count = len(ts.get("top_queries", []))
        content_gap_score = min(30, (rising_count * 4 + top_count * 2))

        # 3. GA Performance Score (0-30)
        ga_score = 0
        if ga_metrics:
            # ページタイトルマッチング
            original_title = meta.get("original_title", "")
            page_data = ga_metrics.get("pages", {}).get(original_title, {})
            if page_data:
                views = page_data.get("views", 0)
                engagement = page_data.get("engagement_rate", 0)
                # 既にPVがある = 実績あり → 関連記事を書く価値が高い
                ga_score = min(30, (views / 10) + (engagement * 20))

        # 4. GSC Position Bonus (0-15)
        gsc_position_bonus = 0.0
        gsc_match = None
        if gsc_enabled:
            gsc_match = match_gsc_to_keyword(kw, gsc_metrics)
            if gsc_match:
                gsc_position_bonus = compute_gsc_position_bonus(gsc_match)
                # Confidence boost: GSC click data validates trend relevance
                if gsc_match.get("total_clicks", 0) > 0:
                    trend_score = min(40, trend_score * 1.1)

        # 5. Funnel Bonus placeholder (0.0 - actual calculation in generate_strategy_output)
        funnel_bonus = 0.0

        # 6. Strategy Bonus (0-15): 戦略のキーワード領域にマッチする場合
        strategy_bonus = 0.0
        strategy_match = None
        if strategy_keyword_areas:
            strategy_match = match_strategy_keyword_area(kw, strategy_keyword_areas)
            if strategy_match:
                _area_name, area_data = strategy_match
                priority_bonus = {"high": 15.0, "medium": 10.0, "low": 5.0}
                strategy_bonus = priority_bonus.get(area_data.get("priority", "medium"), 10.0)

        total_score = round(
            trend_score + content_gap_score + ga_score + gsc_position_bonus + funnel_bonus + strategy_bonus,
            1,
        )

        # 記事ネタの方向性を推定
        strategy_angles = strategy_match[1].get("suggested_angles", []) if strategy_match else []
        suggestions = generate_article_suggestions(kw, ts, meta, strategy_angles=strategy_angles)

        # 推奨公開時期
        recommended_timing = estimate_timing(ts)

        # 難易度推定
        difficulty = estimate_difficulty(avg_interest, rising_count)

        result = {
            "keyword": kw,
            "seo_score": total_score,
            "score_breakdown": {
                "trend": round(trend_score, 1),
                "content_gap": round(content_gap_score, 1),
                "ga_performance": round(ga_score, 1),
                "gsc_position_bonus": round(gsc_position_bonus, 1),
                "funnel_bonus": round(funnel_bonus, 1),
                "strategy_bonus": round(strategy_bonus, 1),
            },
            "trend_direction": ts.get("trend_direction", "unknown"),
            "avg_interest": avg_interest,
            "trend_change_pct": ts.get("trend_change_pct", 0),
            "difficulty": difficulty,
            "recommended_timing": recommended_timing,
            "article_suggestions": suggestions,
            "rising_queries": ts.get("rising_queries", []),
            "source": meta.get("source", "unknown"),
        }

        # GSC data: only include if matched
        if gsc_match:
            result["gsc"] = gsc_match

        results.append(result)

    if published_keywords and excluded_by_published:
        print(
            f"  Excluded {excluded_by_published} keywords overlapping with published articles"
        )

    # スコア順でソート
    results.sort(key=lambda x: x["seo_score"], reverse=True)
    return results[:top_n]


def generate_article_suggestions(
    keyword: str, trend_score: dict, meta: dict, strategy_angles: list[str] | None = None
) -> list[str]:
    """キーワードとトレンドデータから記事ネタの切り口を提案する。"""
    suggestions = []

    # 戦略の suggested_angles を優先反映
    if strategy_angles:
        suggestions.extend(strategy_angles)

    # 上昇クエリから切り口を発見
    rising = trend_score.get("rising_queries", [])
    if rising:
        for rq in rising[:3]:
            suggestions.append(f"「{rq}」の切り口で解説記事")

    # トレンド方向に応じた提案
    direction = trend_score.get("trend_direction", "unknown")
    if direction == "rising":
        suggestions.append(f"「{keyword}」の最新動向まとめ")
        suggestions.append(f"「{keyword}」入門ガイド（初心者向け）")
    elif direction == "stable":
        suggestions.append(f"「{keyword}」のベストプラクティス")
        suggestions.append(f"「{keyword}」の実践事例")
    elif direction == "declining":
        suggestions.append(f"「{keyword}」の現状と代替手段")

    # GAソースに基づく提案
    source = meta.get("source", "")
    if source == "page_title":
        suggestions.append(f"既存記事の深掘り・続編")

    return suggestions[:5]


def estimate_timing(trend_score: dict) -> str:
    """トレンド方向から推奨公開時期を推定する。"""
    direction = trend_score.get("trend_direction", "unknown")
    change = trend_score.get("trend_change_pct", 0)
    if direction == "rising" and change > 30:
        return "immediate"  # 今すぐ
    elif direction == "rising":
        return "within_2_weeks"  # 2週間以内
    elif direction == "stable":
        return "within_1_month"  # 1ヶ月以内
    else:
        return "low_priority"  # 優先度低


def estimate_difficulty(avg_interest: float, rising_count: int) -> str:
    """競合の多さと需要から難易度を推定する。"""
    if avg_interest > 70:
        return "hard"  # 競合多い
    elif avg_interest > 30:
        return "medium" if rising_count < 3 else "medium_high"
    else:
        return "easy"  # ニッチで狙い目


def classify_funnel(keyword: str, strategy_funnel: str | None = None) -> str:
    """キーワードのパターンからファネルステージを分類する。

    Args:
        keyword: 分類対象のキーワード
        strategy_funnel: 戦略から継承するファネル分類（優先）

    Returns:
        "認知" | "興味" | "検討" | "行動"
    """
    if strategy_funnel:
        return strategy_funnel

    keyword_lower = keyword.lower()

    # 行動 (Bottom of funnel - highest intent)
    action_patterns = [
        "見積", "依頼", "相談", "申込", "問い合わせ", "無料",
    ]
    for pattern in action_patterns:
        if pattern in keyword_lower:
            return "行動"

    # 検討 (Consideration)
    consideration_patterns = [
        "事例", "導入", "費用", "料金", "メリット", "デメリット",
    ]
    for pattern in consideration_patterns:
        if pattern in keyword_lower:
            return "検討"

    # 興味 (Interest)
    interest_patterns = [
        "比較", "vs", "おすすめ", "ランキング", "選び方",
    ]
    for pattern in interest_patterns:
        if pattern in keyword_lower:
            return "興味"

    # 認知 (Awareness - default and explicit patterns)
    awareness_patterns = [
        "やり方", "実装", "tutorial", "入門", "とは", "使い方", "方法",
    ]
    for pattern in awareness_patterns:
        if pattern in keyword_lower:
            return "認知"

    # Default
    return "認知"


def generate_strategy_output(
    content_plan: list, metadata: dict, gsc_metrics: dict | None,
    strategy_data: dict | None = None,
) -> dict:
    """content-strategy.json スキーマを生成する。

    content_plan の各項目をstrategy article形式に変換し、
    ファネル分類・ID付与・ステータス管理フィールドを追加する。
    """
    now = datetime.now()
    now_iso = now.isoformat()
    id_prefix = now.strftime("%Y-%m")

    gsc_enabled = gsc_metrics and gsc_metrics.get("enabled", False)
    gsc_total_impressions = gsc_metrics.get("total_impressions", 0) if gsc_metrics else 0

    strategy_keyword_areas = strategy_data.get("keyword_areas", {}) if strategy_data else {}

    articles = []
    funnel_counts = {"認知": 0, "興味": 0, "検討": 0, "行動": 0}

    for i, item in enumerate(content_plan):
        # 戦略のファネル分類を優先継承
        strategy_funnel = None
        if strategy_keyword_areas:
            match = match_strategy_keyword_area(item["keyword"], strategy_keyword_areas)
            if match:
                strategy_funnel = match[1].get("funnel")
        funnel = classify_funnel(item["keyword"], strategy_funnel=strategy_funnel)
        funnel_counts[funnel] = funnel_counts.get(funnel, 0) + 1

        # Funnel bonus calculation for strategy output
        funnel_bonus_map = {
            "行動": 15.0,
            "検討": 10.0,
            "興味": 5.0,
            "認知": 0.0,
        }
        funnel_bonus = funnel_bonus_map.get(funnel, 0.0)

        # Recalculate total score with funnel bonus
        score_breakdown = item["score_breakdown"].copy()
        score_breakdown["funnel_bonus"] = round(funnel_bonus, 1)

        total_score = round(
            score_breakdown["trend"]
            + score_breakdown["content_gap"]
            + score_breakdown["ga_performance"]
            + score_breakdown.get("gsc_position_bonus", 0.0)
            + score_breakdown.get("strategy_bonus", 0.0)
            + funnel_bonus,
            1,
        )

        article = {
            "id": f"strat-{id_prefix}-{i + 1:03d}",
            "keyword": item["keyword"],
            "status": "pending",
            "funnel": funnel,
            "category": "tech-tips",
            "seo_score": total_score,
            "score_breakdown": score_breakdown,
            "trend_direction": item["trend_direction"],
            "avg_interest": item["avg_interest"],
            "trend_change_pct": item["trend_change_pct"],
            "difficulty": item["difficulty"],
            "recommended_timing": item["recommended_timing"],
            "article_suggestions": item["article_suggestions"],
            "rising_queries": item["rising_queries"],
            "source": item["source"],
            "created_at": now_iso,
            "updated_at": now_iso,
            "published_slug": None,
            "published_date": None,
        }

        # GSC data: only include if present in source item
        if "gsc" in item:
            article["gsc"] = item["gsc"]

        articles.append(article)

    # Re-sort by updated seo_score (funnel bonus may change order)
    articles.sort(key=lambda x: x["seo_score"], reverse=True)

    # Re-assign IDs after sort to maintain score-ordered numbering
    for i, article in enumerate(articles):
        article["id"] = f"strat-{id_prefix}-{i + 1:03d}"

    total_candidates = len(articles)
    immediate_count = len(
        [a for a in articles if a["recommended_timing"] == "immediate"]
    )
    avg_score = (
        round(sum(a["seo_score"] for a in articles) / total_candidates, 1)
        if total_candidates
        else 0
    )
    top_keyword = articles[0]["keyword"] if articles else None

    by_status = {
        "pending": total_candidates,
        "in_progress": 0,
        "published": 0,
    }

    return {
        "metadata": {
            "generated_at": now_iso,
            "version": "1.0",
            "data_sources": {
                "ga_report": metadata.get("ga_report"),
                "trends_report": metadata.get("trends_report"),
                "gsc_report": metadata.get("gsc_report"),
                "strategy": metadata.get("strategy"),
            },
            "gsc_threshold": {
                "total_impressions": gsc_total_impressions,
                "gsc_scoring_enabled": gsc_enabled,
                "threshold_value": 100,
            },
            "scoring_max": {
                "trend": 40,
                "content_gap": 30,
                "ga_performance": 30,
                "gsc_position_bonus": 15,
                "funnel_bonus": 15,
                "strategy_bonus": 15,
                "theoretical_max": 145,
            },
        },
        "articles": articles,
        "summary": {
            "total_candidates": total_candidates,
            "by_status": by_status,
            "by_funnel": funnel_counts,
            "immediate_action": immediate_count,
            "avg_seo_score": avg_score,
            "top_keyword": top_keyword,
            "gsc_scoring_enabled": gsc_enabled,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="SEO Content Planner")
    parser.add_argument("--trends-report", required=True, help="trends-analyzer 出力JSON")
    parser.add_argument("--ga-report", help="ga-analyzer 出力JSON（任意）")
    parser.add_argument("--gsc-report", help="GSC export JSON（任意）")
    parser.add_argument("--strategy", help="seo-strategy.json パス（任意）")
    parser.add_argument(
        "--blog-dir",
        default="content/blog",
        help="既存公開記事ディレクトリ。frontmatter から tags/title を読み除外フィルタに使用（default: content/blog、存在しなければスキップ）",
    )
    parser.add_argument("--output", default="content_plan.json", help="出力ファイルパス")
    parser.add_argument("--top-n", type=int, default=15, help="出力する記事ネタ候補数")
    parser.add_argument(
        "--output-format",
        choices=["content_plan", "content_strategy"],
        default="content_plan",
        help="出力フォーマット (default: content_plan)",
    )

    args = parser.parse_args()

    # データ読み込み
    trends_data = load_json(args.trends_report)

    ga_metrics = None
    if args.ga_report:
        print(f"Loading GA report: {args.ga_report}")
        ga_data = load_json(args.ga_report)
        ga_metrics = extract_ga_metrics(ga_data)
        print(
            f"  Organic ratio: {ga_metrics['organic_ratio']:.1%}, "
            f"Total sessions: {ga_metrics['total_sessions']}"
        )

    gsc_metrics = None
    if args.gsc_report:
        print(f"Loading GSC report: {args.gsc_report}")
        gsc_data = load_json(args.gsc_report)
        gsc_metrics = extract_gsc_metrics(gsc_data)

    strategy_data = None
    if args.strategy:
        print(f"Loading strategy: {args.strategy}")
        strategy_data = load_strategy(args.strategy)

    published_keywords: set[str] = set()
    if args.blog_dir:
        published_keywords = load_published_articles(args.blog_dir)
        if published_keywords:
            print(
                f"Loaded {len(published_keywords)} published-article keywords from {args.blog_dir}"
            )

    # スコアリング
    print(f"\nScoring {len(trends_data.get('trend_scores', []))} keywords...")
    content_plan = compute_seo_scores(
        trends_data,
        ga_metrics,
        args.top_n,
        gsc_metrics=gsc_metrics,
        strategy_data=strategy_data,
        published_keywords=published_keywords,
    )

    # 出力フォーマット分岐
    if args.output_format == "content_strategy":
        # content-strategy.json 形式
        strategy_metadata = {
            "ga_report": args.ga_report,
            "trends_report": args.trends_report,
            "gsc_report": args.gsc_report,
            "strategy": args.strategy,
        }
        output = generate_strategy_output(
            content_plan, strategy_metadata, gsc_metrics, strategy_data=strategy_data
        )

        # JSON出力
        output_path = Path(args.output)
        output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2))
        print(f"\nContent strategy saved: {output_path}")

        # サマリー表示
        summary = output["summary"]
        print("\n=== Content Strategy Summary ===")
        print(f"  Total candidates: {summary['total_candidates']}")
        print(f"  Immediate action: {summary['immediate_action']}")
        print(f"  Avg SEO score: {summary['avg_seo_score']}")
        print(f"  GSC scoring: {'enabled' if summary['gsc_scoring_enabled'] else 'disabled'}")
        print(f"  Funnel distribution: {summary['by_funnel']}")

        for i, article in enumerate(output["articles"][:10], 1):
            timing_label = {
                "immediate": "[今すぐ]",
                "within_2_weeks": "[2週間以内]",
                "within_1_month": "[1ヶ月以内]",
                "low_priority": "[優先度低]",
            }.get(article["recommended_timing"], "")

            direction = {
                "rising": "↑",
                "declining": "↓",
                "stable": "→",
            }.get(article["trend_direction"], "?")

            gsc_label = ""
            if "gsc" in article:
                gsc_label = f" [GSC: pos={article['gsc']['avg_position']}, {article['gsc']['action_type']}]"

            print(
                f"  {i}. {direction} [{article['funnel']}] {article['keyword']} "
                f"(SEO: {article['seo_score']}, {article['difficulty']}) "
                f"{timing_label}{gsc_label}"
            )
            if article["article_suggestions"]:
                print(f"     -> {article['article_suggestions'][0]}")

    else:
        # 既存 content_plan 形式（後方互換）
        output = {
            "content_plan": content_plan,
            "summary": {
                "total_candidates": len(content_plan),
                "immediate_action": len(
                    [c for c in content_plan if c["recommended_timing"] == "immediate"]
                ),
                "avg_seo_score": round(
                    sum(c["seo_score"] for c in content_plan) / len(content_plan), 1
                )
                if content_plan
                else 0,
                "top_keyword": content_plan[0]["keyword"] if content_plan else None,
            },
            "metadata": {
                "generated_at": datetime.now().isoformat(),
                "ga_report": args.ga_report,
                "trends_report": args.trends_report,
            },
        }

        # JSON出力
        output_path = Path(args.output)
        output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2))
        print(f"\nContent plan saved: {output_path}")

        # サマリー表示
        print("\n=== Content Plan Summary ===")
        for i, item in enumerate(content_plan[:10], 1):
            timing_label = {
                "immediate": "[今すぐ]",
                "within_2_weeks": "[2週間以内]",
                "within_1_month": "[1ヶ月以内]",
                "low_priority": "[優先度低]",
            }.get(item["recommended_timing"], "")

            direction = {
                "rising": "↑",
                "declining": "↓",
                "stable": "→",
            }.get(item["trend_direction"], "?")

            print(
                f"  {i}. {direction} {item['keyword']} "
                f"(SEO: {item['seo_score']}, {item['difficulty']}) "
                f"{timing_label}"
            )
            if item["article_suggestions"]:
                print(f"     -> {item['article_suggestions'][0]}")


if __name__ == "__main__":
    main()
