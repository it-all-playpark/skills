#!/usr/bin/env python3
"""
Google Trends Fetcher - pytrends でトレンドデータを取得

Usage:
    python trends_fetch.py --ga-report ga_report.json [options]
    python trends_fetch.py --keywords "Claude Code,AI開発" [options]

Input (choose one):
    --ga-report         ga-analyzer の出力JSONパス（キーワード自動抽出）
    --keywords          カンマ区切りのキーワードリスト（手動指定）

Options:
    --output            出力ファイルパス (default: trends_report.json)
    --geo               リージョン (default: JP)
    --timeframe         期間 (default: today 3-m) e.g., today 1-m, today 12-m, 2024-01-01 2024-06-01
    --top-n             GA レポートから抽出するキーワード上位数 (default: 10)
    --cache-dir         キャッシュディレクトリ (default: .trends_cache)
    --no-cache          キャッシュを無効化
    --language          キーワード抽出言語 (default: ja)
"""

import argparse
import hashlib
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    from pytrends.request import TrendReq
except ImportError:
    print("Error: pytrends package not installed")
    print("Run: pip install pytrends")
    sys.exit(1)


# --- Keyword Extraction from GA Report ---

# ページタイトルから除去するパターン
STRIP_PATTERNS = [
    r"\s*[|｜]\s*合同会社playpark.*$",
    r"\s*[-–—]\s*合同会社playpark.*$",
    r"^【(.+?)】",  # 【】の中身は残してブラケット除去
    r"^\d+:\s*",
    r"^404:.*$",
]

# 一般的すぎるタイトル（除外）
IGNORE_TITLES = {
    "ブログ",
    "トップページ",
    "ホーム",
    "home",
    "blog",
    "404",
    "not found",
}


def extract_keywords_from_ga(ga_data: dict, top_n: int = 10) -> list[dict]:
    """GA4レポートからSEO関連キーワードを抽出する。

    抽出ソース:
    1. content.page_titles → ページタイトルからキーワード抽出
    2. conversion.landing_pages → ランディングページURLからスラッグ抽出
    """
    keywords = []
    seen = set()

    # Source 1: ページタイトル
    page_titles = ga_data.get("content", {}).get("page_titles", {}).get("rows", [])
    for row in page_titles:
        title = row.get("pageTitle", "")
        views = int(row.get("screenPageViews", 0))

        # 一般的すぎるタイトルを除外
        if any(ig in title.lower() for ig in IGNORE_TITLES):
            continue

        # タイトルをクリーンアップ
        cleaned = title
        for pat in STRIP_PATTERNS:
            match = re.search(r"^【(.+?)】", cleaned)
            if match and pat == r"^【(.+?)】":
                cleaned = match.group(1) + " " + re.sub(pat, "", cleaned)
            else:
                cleaned = re.sub(pat, "", cleaned).strip()

        cleaned = cleaned.strip()
        if not cleaned or len(cleaned) < 3:
            continue

        # タイトルからコアキーワードを抽出（先頭部分を優先）
        # 例: "Claude Code Skills設計のベストプラクティス" → "Claude Code Skills設計"
        core = extract_core_keyword(cleaned)
        if core and core.lower() not in seen:
            seen.add(core.lower())
            keywords.append({
                "keyword": core,
                "source": "page_title",
                "original_title": title,
                "views": views,
            })

    # Source 2: ランディングページURL
    landing_pages = (
        ga_data.get("conversion", {}).get("landing_pages", {}).get("rows", [])
    )
    for row in landing_pages:
        path = row.get("landingPagePlusQueryString", "")
        sessions = int(row.get("sessions", 0))
        slug = extract_slug_keyword(path)
        if slug and slug.lower() not in seen:
            seen.add(slug.lower())
            keywords.append({
                "keyword": slug,
                "source": "landing_page",
                "original_path": path,
                "sessions": sessions,
            })

    # ビュー/セッション数でソートして上位N件
    keywords.sort(key=lambda x: x.get("views", x.get("sessions", 0)), reverse=True)
    return keywords[:top_n]


def extract_core_keyword(title: str) -> str:
    """タイトルからコアキーワード（検索意図の核心）を抽出する。

    pytrends のクエリ長制限を考慮し、短く意味のあるキーワードを抽出する。
    """
    # ダッシュやパイプで分割し、最も情報量の多い部分を取得
    parts = re.split(r"\s*[-–—|｜]\s*", title)
    if parts:
        main = max(parts, key=len).strip()
    else:
        main = title.strip()

    # 【】内のテキストがあればそれをコアとして優先
    bracket_match = re.search(r"【(.+?)】", main)
    if bracket_match:
        core = bracket_match.group(1)
        if len(core) <= 30:
            return core

    # 長すぎる場合はさらに分割を試みる
    if len(main) > 25:
        # 「の」「を」「で」「と」「に」「は」「が」で区切って先頭の意味単位を取得
        cut = re.match(r"^(.{4,25}?)[のをはがでにと]", main)
        if cut:
            return cut.group(1)
        # スペースで分割して先頭2-3トークンを取得
        tokens = main.split()
        if len(tokens) >= 2:
            result = " ".join(tokens[:3])
            if len(result) <= 30:
                return result
            return " ".join(tokens[:2])
        return main[:25]
    return main


def extract_slug_keyword(path: str) -> str | None:
    """URLパスからキーワードを抽出する。"""
    if not path or path in ("/", "?", "(not set)"):
        return None
    # パスの最後のセグメントを取得
    segments = [s for s in path.strip("/").split("/") if s and s != "blog"]
    if not segments:
        return None
    slug = segments[-1].split("?")[0]
    # ハイフンをスペースに変換
    keyword = slug.replace("-", " ").replace("_", " ")
    if len(keyword) < 3:
        return None
    return keyword


# --- Google Trends Data Fetching ---


def build_cache_key(keywords: list[str], geo: str, timeframe: str) -> str:
    """キャッシュキーを生成する。"""
    raw = f"{sorted(keywords)}:{geo}:{timeframe}"
    return hashlib.md5(raw.encode()).hexdigest()


def load_cache(cache_dir: Path, cache_key: str, max_age_hours: int = 24) -> dict | None:
    """キャッシュからデータを読み込む。"""
    cache_file = cache_dir / f"{cache_key}.json"
    if not cache_file.exists():
        return None
    data = json.loads(cache_file.read_text())
    cached_at = datetime.fromisoformat(data.get("cached_at", "2000-01-01"))
    age_hours = (datetime.now() - cached_at).total_seconds() / 3600
    if age_hours > max_age_hours:
        return None
    return data


def save_cache(cache_dir: Path, cache_key: str, data: dict) -> None:
    """キャッシュにデータを保存する。"""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{cache_key}.json"
    data["cached_at"] = datetime.now().isoformat()
    cache_file.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def fetch_trends_with_retry(
    pytrends: TrendReq,
    kw_list: list[str],
    geo: str,
    timeframe: str,
    max_retries: int = 3,
) -> dict:
    """リトライ付きでpytrendsからデータを取得する。"""
    for attempt in range(max_retries):
        try:
            pytrends.build_payload(kw_list, cat=0, timeframe=timeframe, geo=geo)
            interest_over_time = pytrends.interest_over_time()
            related_queries = pytrends.related_queries()

            # Convert DataFrame to dict with string date keys
            iot_dict = {}
            if not interest_over_time.empty:
                df = interest_over_time.drop(columns=["isPartial"], errors="ignore")
                for idx, row in df.iterrows():
                    date_key = str(idx.date()) if hasattr(idx, "date") else str(idx)
                    iot_dict[date_key] = {col: int(val) for col, val in row.items()}

            return {
                "interest_over_time": iot_dict,
                "related_queries": {
                    kw: {
                        "top": (
                            rq.get("top").to_dict(orient="records")
                            if rq.get("top") is not None
                            else []
                        ),
                        "rising": (
                            rq.get("rising").to_dict(orient="records")
                            if rq.get("rising") is not None
                            else []
                        ),
                    }
                    for kw, rq in related_queries.items()
                },
            }
        except Exception as e:
            if attempt < max_retries - 1:
                wait = 2 ** (attempt + 1) * 10  # 20s, 40s, 80s
                print(
                    f"  Rate limited (attempt {attempt + 1}/{max_retries}), "
                    f"retrying in {wait}s... ({e})"
                )
                time.sleep(wait)
            else:
                print(f"  Failed after {max_retries} retries: {e}")
                return {"error": str(e)}
    return {"error": "max retries exceeded"}


def fetch_all_trends(
    keywords: list[str],
    geo: str = "JP",
    timeframe: str = "today 3-m",
    cache_dir: Path | None = None,
) -> dict:
    """全キーワードのトレンドデータを取得する。

    pytrends は1回のリクエストで最大5キーワードまで比較可能。
    5件ごとにバッチ処理する。
    """
    pytrends = TrendReq(hl="ja", tz=540)
    results = {}

    # 5件ずつバッチ処理
    for i in range(0, len(keywords), 5):
        batch = keywords[i : i + 5]
        print(f"Fetching trends for: {batch}")

        # キャッシュチェック
        if cache_dir:
            cache_key = build_cache_key(batch, geo, timeframe)
            cached = load_cache(cache_dir, cache_key)
            if cached:
                print(f"  Using cached data")
                results[",".join(batch)] = cached
                continue

        data = fetch_trends_with_retry(pytrends, batch, geo, timeframe)
        results[",".join(batch)] = data

        # キャッシュ保存
        if cache_dir and "error" not in data:
            save_cache(cache_dir, cache_key, data)

        # レート制限対策: バッチ間で待機
        if i + 5 < len(keywords):
            time.sleep(5)

    return results


def compute_trend_scores(trends_data: dict, keywords: list[str]) -> list[dict]:
    """トレンドデータからキーワードごとのスコアを算出する。

    スコア要素:
    - trend_direction: 上昇/安定/下降 (直近1/4期間 vs 全期間平均)
    - avg_interest: 平均関心度 (0-100)
    - peak_interest: ピーク関心度
    - rising_queries_count: 関連する上昇クエリ数
    """
    scores = []
    for kw in keywords:
        score = {
            "keyword": kw,
            "avg_interest": 0,
            "peak_interest": 0,
            "trend_direction": "unknown",
            "trend_change_pct": 0,
            "rising_queries": [],
            "top_queries": [],
        }

        # interest_over_time からスコアを算出
        for batch_key, batch_data in trends_data.items():
            if "error" in batch_data:
                continue
            iot = batch_data.get("interest_over_time", {})
            if not iot:
                continue

            values = []
            for date_str, row in iot.items():
                if kw in row:
                    values.append(row[kw])

            if values:
                score["avg_interest"] = round(sum(values) / len(values), 1)
                score["peak_interest"] = max(values)

                # トレンド方向: 後半1/4 vs 前半3/4の平均比較
                quarter = max(1, len(values) // 4)
                recent = values[-quarter:]
                earlier = values[:-quarter] if len(values) > quarter else values
                recent_avg = sum(recent) / len(recent)
                earlier_avg = sum(earlier) / len(earlier) if earlier else 1
                change_pct = (
                    ((recent_avg - earlier_avg) / earlier_avg * 100)
                    if earlier_avg > 0
                    else 0
                )
                score["trend_change_pct"] = round(change_pct, 1)
                if change_pct > 15:
                    score["trend_direction"] = "rising"
                elif change_pct < -15:
                    score["trend_direction"] = "declining"
                else:
                    score["trend_direction"] = "stable"

            # related queries
            rq = batch_data.get("related_queries", {}).get(kw, {})
            score["rising_queries"] = [
                q.get("query", "") for q in rq.get("rising", [])[:5]
            ]
            score["top_queries"] = [
                q.get("query", "") for q in rq.get("top", [])[:5]
            ]

        scores.append(score)

    return scores


# --- Main ---


def main():
    parser = argparse.ArgumentParser(description="Google Trends Fetcher")
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--ga-report", help="ga-analyzer の出力JSONパス")
    input_group.add_argument("--keywords", help="カンマ区切りのキーワードリスト")

    parser.add_argument("--output", default="trends_report.json", help="出力ファイルパス")
    parser.add_argument("--geo", default="JP", help="リージョン (default: JP)")
    parser.add_argument(
        "--timeframe", default="today 3-m", help="期間 (default: today 3-m)"
    )
    parser.add_argument(
        "--top-n", type=int, default=10, help="GA レポートから抽出するキーワード上位数"
    )
    parser.add_argument("--cache-dir", default=".trends_cache", help="キャッシュディレクトリ")
    parser.add_argument("--no-cache", action="store_true", help="キャッシュを無効化")

    args = parser.parse_args()

    # キーワード取得
    if args.ga_report:
        print(f"Loading GA report: {args.ga_report}")
        with open(args.ga_report) as f:
            ga_data = json.load(f)
        keyword_entries = extract_keywords_from_ga(ga_data, args.top_n)
        if not keyword_entries:
            print("Error: No keywords extracted from GA report")
            sys.exit(1)
        keywords = [e["keyword"] for e in keyword_entries]
        print(f"Extracted {len(keywords)} keywords: {keywords}")
    else:
        keywords = [kw.strip() for kw in args.keywords.split(",") if kw.strip()]
        keyword_entries = [{"keyword": kw, "source": "manual"} for kw in keywords]

    # Trends データ取得
    cache_dir = None if args.no_cache else Path(args.cache_dir)
    raw_trends = fetch_all_trends(keywords, args.geo, args.timeframe, cache_dir)

    # スコアリング
    trend_scores = compute_trend_scores(raw_trends, keywords)

    # 出力データ構成
    output = {
        "keywords": keyword_entries,
        "trend_scores": trend_scores,
        "raw_trends": raw_trends,
        "metadata": {
            "geo": args.geo,
            "timeframe": args.timeframe,
            "generated_at": datetime.now().isoformat(),
            "source": args.ga_report or "manual",
            "keyword_count": len(keywords),
        },
    }

    # JSON出力
    output_path = Path(args.output)
    # Serialize datetime keys in raw_trends
    output_json = json.dumps(output, ensure_ascii=False, indent=2, default=str)
    output_path.write_text(output_json)
    print(f"\nTrends report saved: {output_path}")

    # サマリー表示
    print("\n=== Trend Scores Summary ===")
    for s in sorted(trend_scores, key=lambda x: x["avg_interest"], reverse=True):
        direction = {"rising": "↑", "declining": "↓", "stable": "→"}.get(
            s["trend_direction"], "?"
        )
        print(
            f"  {direction} {s['keyword']}: "
            f"avg={s['avg_interest']}, peak={s['peak_interest']}, "
            f"change={s['trend_change_pct']:+.1f}%"
        )


if __name__ == "__main__":
    main()
