#!/usr/bin/env python3
"""企業の追加情報（ニュース・求人・IT関連動向）を収集する.

既存の find-company-urls.py / scrape-company-info.py と同じパターンで
標準ライブラリのみ使用。Google 検索結果の HTML をパースして情報を抽出する。

Usage:
    python3 analyze-prospect.py --company "企業名" --url "https://..." [--dry-run]

Output: JSON
{
  "company": "企業名",
  "news": [{"title": "...", "date": "...", "url": "..."}],
  "hiring": {"found": true, "positions": [...], "source_urls": [...]},
  "it_signals": {"found": true, "mentions": [...], "source_urls": [...]}
}
"""

import argparse
import json
import re
import ssl
import sys
import time
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

# ─── 定数 ────────────────────────────────────────────────────────

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
TIMEOUT = 15
RATE_LIMIT_SEC = 2

# SSL 検証を緩和（古い企業サイト対策）
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# ニュースページを検出するキーワードとパス
NEWS_LINK_KEYWORDS = [
    "お知らせ", "ニュース", "新着情報", "トピックス", "topics",
    "プレスリリース", "press", "information", "info",
]
NEWS_PATH_PATTERNS = [
    "news", "topics", "info", "information", "press", "release",
    "oshirase", "whatsnew",
]

# 求人関連キーワード（Google 検索結果から抽出）
HIRING_KEYWORDS = [
    "求人", "採用", "募集", "リクルート", "キャリア",
    "エンジニア", "SE", "プログラマ", "開発者",
    "DX推進", "情シス", "情報システム", "IT担当",
    "社内SE", "システム管理", "インフラ",
]

# IT シグナルキーワード
IT_SIGNAL_KEYWORDS = [
    "DX", "デジタルトランスフォーメーション", "デジタル化",
    "システム導入", "システム刷新", "システム更新",
    "クラウド", "SaaS", "AI", "RPA", "IoT",
    "業務効率化", "ペーパーレス", "電子化",
    "情報システム", "基幹システム", "ERP",
    "セキュリティ", "サイバー",
    "IT投資", "IT戦略", "IT人材",
]


# ─── HTTP ────────────────────────────────────────────────────────


def fetch(url: str) -> str | None:
    """URL からHTML を取得する."""
    try:
        req = Request(url, headers={"User-Agent": UA})
        with urlopen(req, timeout=TIMEOUT, context=CTX) as resp:
            data = resp.read()
            ct = resp.headers.get("Content-Type", "")
            enc = "utf-8"
            if "charset=" in ct:
                enc = ct.split("charset=")[-1].split(";")[0].strip()
            try:
                return data.decode(enc)
            except (UnicodeDecodeError, LookupError):
                try:
                    return data.decode("shift_jis")
                except UnicodeDecodeError:
                    return data.decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  WARN: fetch failed {url}: {e}", file=sys.stderr)
        return None


# ─── HTML パーサー ───────────────────────────────────────────────


class GoogleResultParser(HTMLParser):
    """Google 検索結果ページから URL とスニペットを抽出する."""

    def __init__(self):
        super().__init__()
        self.results: list[dict] = []
        self._urls: list[str] = []
        self._current_text: list[str] = []
        self._in_body = False

    def handle_starttag(self, tag, attrs):
        if tag == "body":
            self._in_body = True
        if tag != "a":
            return
        attrs_d = dict(attrs)
        href = attrs_d.get("href", "")

        if href.startswith("/url?"):
            parsed = parse_qs(urlparse(href).query)
            if "q" in parsed:
                url = parsed["q"][0]
                if url.startswith("http"):
                    self._urls.append(url)
        elif href.startswith("http") and "google" not in href:
            self._urls.append(href)

    def handle_data(self, data):
        if self._in_body:
            self._current_text.append(data)

    @property
    def urls(self) -> list[str]:
        return self._urls

    @property
    def full_text(self) -> str:
        return " ".join(self._current_text)


class LinkExtractor(HTMLParser):
    """HTML から全 <a> リンクを抽出する."""

    def __init__(self):
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._in_a = False
        self._href = ""
        self._text = ""

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            attrs_d = dict(attrs)
            if "href" in attrs_d:
                self._in_a = True
                self._href = attrs_d["href"]
                self._text = ""

    def handle_endtag(self, tag):
        if tag == "a" and self._in_a:
            self.links.append((self._text.strip(), self._href))
            self._in_a = False

    def handle_data(self, data):
        if self._in_a:
            self._text += data


class NewsListParser(HTMLParser):
    """ニュース一覧ページからタイトル・日付・URLを抽出する.

    一般的なニュース一覧パターン:
    - <a>タグ内のテキスト = タイトル
    - 近隣の日付パターン (YYYY.MM.DD, YYYY/MM/DD, YYYY年MM月DD日)
    """

    def __init__(self, base_url: str):
        super().__init__()
        self.items: list[dict] = []
        self._base_url = base_url
        self._in_a = False
        self._href = ""
        self._text = ""
        self._buffer: list[str] = []
        self._pending_date = ""

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            attrs_d = dict(attrs)
            if "href" in attrs_d:
                self._in_a = True
                self._href = attrs_d["href"]
                self._text = ""

    def handle_endtag(self, tag):
        if tag == "a" and self._in_a:
            text = self._text.strip()
            if text and len(text) > 5 and self._href:
                full_url = urljoin(self._base_url, self._href)
                item = {"title": text, "url": full_url, "date": ""}
                if self._pending_date:
                    item["date"] = self._pending_date
                    self._pending_date = ""
                self.items.append(item)
            self._in_a = False

    def handle_data(self, data):
        if self._in_a:
            self._text += data

        # 日付パターンを検出してバッファ
        stripped = data.strip()
        date_match = re.search(
            r"(\d{4})[./年\-](\d{1,2})[./月\-](\d{1,2})[日]?", stripped
        )
        if date_match:
            y, m, d = date_match.group(1), date_match.group(2), date_match.group(3)
            self._pending_date = f"{y}-{int(m):02d}-{int(d):02d}"


# ─── Google 検索 ─────────────────────────────────────────────────


def google_search(query: str) -> GoogleResultParser:
    """Google 検索を実行し、パース結果を返す."""
    encoded = urlencode({"q": query}, encoding="utf-8")
    search_url = f"https://www.google.com/search?{encoded}&hl=ja&num=10"

    html = fetch(search_url)
    parser = GoogleResultParser()
    if html:
        try:
            parser.feed(html)
        except Exception:
            pass
    return parser


# ─── Step 1: ニュース取得 ────────────────────────────────────────


def find_news_page_url(base_url: str, html: str) -> str | None:
    """トップページからニュース一覧ページのURLを探す."""
    parser = LinkExtractor()
    try:
        parser.feed(html)
    except Exception:
        return None

    # テキストマッチ
    for text, href in parser.links:
        for kw in NEWS_LINK_KEYWORDS:
            if kw in text.lower() or kw in text:
                return urljoin(base_url, href)

    # パスマッチ
    for _text, href in parser.links:
        full = urljoin(base_url, href)
        path = urlparse(full).path.lower()
        for pat in NEWS_PATH_PATTERNS:
            if pat in path:
                return full

    return None


def scrape_news(company_name: str, base_url: str, max_items: int = 5) -> list[dict]:
    """企業HPのニュース一覧から最新ニュースを取得する."""
    html = fetch(base_url)
    if not html:
        return []

    news_url = find_news_page_url(base_url, html)
    if not news_url:
        return []

    print(f"  NEWS: found news page {news_url}", file=sys.stderr)
    time.sleep(1)

    news_html = fetch(news_url)
    if not news_html:
        return []

    parser = NewsListParser(news_url)
    try:
        parser.feed(news_html)
    except Exception:
        pass

    # 重複除去（タイトルベース）
    seen_titles: set[str] = set()
    unique_items: list[dict] = []
    for item in parser.items:
        title = item["title"]
        # 明らかにナビゲーションリンクは除外
        if len(title) < 8:
            continue
        if title not in seen_titles:
            seen_titles.add(title)
            unique_items.append(item)

    return unique_items[:max_items]


# ─── Step 2: 求人情報取得 ────────────────────────────────────────


def search_hiring(company_name: str) -> dict:
    """Google 検索で求人情報の有無と内容を取得する."""
    query = f'"{company_name}" 求人'
    parser = google_search(query)

    positions: list[str] = []
    source_urls: list[str] = []

    full_text = parser.full_text

    # スニペットから職種・ポジションを抽出
    for kw in HIRING_KEYWORDS:
        if kw in full_text:
            # キーワード周辺のテキストを抽出（前後50文字）
            for m in re.finditer(re.escape(kw), full_text):
                start = max(0, m.start() - 30)
                end = min(len(full_text), m.end() + 30)
                context = full_text[start:end].strip()
                # 重複や短すぎるものを除外
                if context and len(context) > 5 and context not in positions:
                    positions.append(context)
                    if len(positions) >= 5:
                        break
            if len(positions) >= 5:
                break

    # 求人関連URLを収集（最大3件）
    for url in parser.urls[:10]:
        domain = urlparse(url).netloc.lower()
        if any(
            d in domain
            for d in [
                "indeed", "recruit", "en-japan", "doda", "mynavi",
                "rikunabi", "wantedly", "green-japan", "type.jp",
            ]
        ):
            if url not in source_urls:
                source_urls.append(url)
                if len(source_urls) >= 3:
                    break

    found = bool(positions) or bool(source_urls)
    return {
        "found": found,
        "positions": positions[:5],
        "source_urls": source_urls[:3],
    }


# ─── Step 3: IT シグナル取得 ─────────────────────────────────────


def search_it_signals(company_name: str) -> dict:
    """Google 検索で IT/DX 関連ニュースを取得する."""
    mentions: list[str] = []
    source_urls: list[str] = []

    queries = [
        f'"{company_name}" DX',
        f'"{company_name}" システム',
    ]

    for query in queries:
        parser = google_search(query)
        full_text = parser.full_text

        # IT関連キーワードを含むスニペットを抽出
        for kw in IT_SIGNAL_KEYWORDS:
            if kw in full_text:
                for m in re.finditer(re.escape(kw), full_text):
                    start = max(0, m.start() - 40)
                    end = min(len(full_text), m.end() + 40)
                    context = full_text[start:end].strip()
                    if context and len(context) > 8 and context not in mentions:
                        mentions.append(context)
                        if len(mentions) >= 5:
                            break
                if len(mentions) >= 5:
                    break

        # 関連URLを収集
        for url in parser.urls[:5]:
            if url not in source_urls:
                source_urls.append(url)
                if len(source_urls) >= 5:
                    break

        time.sleep(RATE_LIMIT_SEC)

    found = bool(mentions)
    return {
        "found": found,
        "mentions": mentions[:5],
        "source_urls": source_urls[:5],
    }


# ─── メイン ──────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="企業の追加情報（ニュース・求人・IT動向）を収集"
    )
    parser.add_argument(
        "--company", type=str, required=True, help="企業名"
    )
    parser.add_argument(
        "--url", type=str, default="", help="企業HP URL"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="実行内容を表示するのみ"
    )
    args = parser.parse_args()

    company_name = args.company
    base_url = args.url

    if args.dry_run:
        print(
            json.dumps(
                {
                    "mode": "dry-run",
                    "company": company_name,
                    "url": base_url,
                    "actions": [
                        f"Scrape news from {base_url}" if base_url else "Skip news (no URL)",
                        f'Google search: "{company_name} 求人"',
                        f'Google search: "{company_name} DX"',
                        f'Google search: "{company_name} システム"',
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    print(f"ANALYZE: {company_name}", file=sys.stderr)

    # Step 1: ニュース取得
    news: list[dict] = []
    if base_url:
        print(f"  STEP1: Scraping news from {base_url}", file=sys.stderr)
        news = scrape_news(company_name, base_url)
        time.sleep(RATE_LIMIT_SEC)
    else:
        print("  STEP1: Skip news (no URL provided)", file=sys.stderr)

    # Step 2: 求人情報
    print(f'  STEP2: Searching hiring info for "{company_name}"', file=sys.stderr)
    hiring = search_hiring(company_name)
    time.sleep(RATE_LIMIT_SEC)

    # Step 3: IT シグナル
    print(f'  STEP3: Searching IT signals for "{company_name}"', file=sys.stderr)
    it_signals = search_it_signals(company_name)

    result = {
        "company": company_name,
        "url": base_url,
        "news": news,
        "hiring": hiring,
        "it_signals": it_signals,
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
