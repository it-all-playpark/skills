#!/usr/bin/env python3
"""
SEO Content Planner - GA4実績 × Trendsデータから記事ネタを提案

Usage:
    python seo_planner.py --ga-report ga_report.json --trends-report trends_report.json [options]
    python seo_planner.py --trends-report trends_report.json [options]

Required:
    --trends-report     trends-analyzer の出力JSONパス

Optional:
    --ga-report         ga-analyzer の出力JSONパス（より精度の高いスコアリングに使用）
    --output            出力ファイルパス (default: content_plan.json)
    --top-n             出力する記事ネタ候補数 (default: 15)
"""

import argparse
import json
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


def compute_seo_scores(
    trends_data: dict, ga_metrics: dict | None = None, top_n: int = 15
) -> list[dict]:
    """GA4実績 × トレンドスコアからSEOスコアを算出する。

    スコアリング基準:
    - trend_score (0-40): トレンド方向 × 関心度
    - content_gap_score (0-30): 関連上昇クエリの多さ（未カバー領域の発見）
    - ga_performance_score (0-30): GA実績（ある場合）
    """
    trend_scores = trends_data.get("trend_scores", [])
    keywords_meta = {
        kw["keyword"]: kw for kw in trends_data.get("keywords", [])
    }

    results = []
    for ts in trend_scores:
        kw = ts["keyword"]
        meta = keywords_meta.get(kw, {})

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

        total_score = round(trend_score + content_gap_score + ga_score, 1)

        # 記事ネタの方向性を推定
        suggestions = generate_article_suggestions(kw, ts, meta)

        # 推奨公開時期
        recommended_timing = estimate_timing(ts)

        # 難易度推定
        difficulty = estimate_difficulty(avg_interest, rising_count)

        results.append({
            "keyword": kw,
            "seo_score": total_score,
            "score_breakdown": {
                "trend": round(trend_score, 1),
                "content_gap": round(content_gap_score, 1),
                "ga_performance": round(ga_score, 1),
            },
            "trend_direction": ts.get("trend_direction", "unknown"),
            "avg_interest": avg_interest,
            "trend_change_pct": ts.get("trend_change_pct", 0),
            "difficulty": difficulty,
            "recommended_timing": recommended_timing,
            "article_suggestions": suggestions,
            "rising_queries": ts.get("rising_queries", []),
            "source": meta.get("source", "unknown"),
        })

    # スコア順でソート
    results.sort(key=lambda x: x["seo_score"], reverse=True)
    return results[:top_n]


def generate_article_suggestions(
    keyword: str, trend_score: dict, meta: dict
) -> list[str]:
    """キーワードとトレンドデータから記事ネタの切り口を提案する。"""
    suggestions = []

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


def main():
    parser = argparse.ArgumentParser(description="SEO Content Planner")
    parser.add_argument("--trends-report", required=True, help="trends-analyzer 出力JSON")
    parser.add_argument("--ga-report", help="ga-analyzer 出力JSON（任意）")
    parser.add_argument("--output", default="content_plan.json", help="出力ファイルパス")
    parser.add_argument("--top-n", type=int, default=15, help="出力する記事ネタ候補数")

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

    # スコアリング
    print(f"\nScoring {len(trends_data.get('trend_scores', []))} keywords...")
    content_plan = compute_seo_scores(trends_data, ga_metrics, args.top_n)

    # 出力データ構成
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
            print(f"     → {item['article_suggestions'][0]}")


if __name__ == "__main__":
    main()
