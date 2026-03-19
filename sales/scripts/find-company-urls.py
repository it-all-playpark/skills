#!/usr/bin/env python3
"""企業名で Google 検索して公式HP URLを特定し profile.yml に追加する.

標準ライブラリのみ使用。Google 検索結果の HTML をパースして URL を抽出する。

Usage:
    python3 find-company-urls.py [--dry-run] [--company NAME]

環境変数:
    SALES_REPO_PATH: sales リポジトリパス（デフォルト: ~/ghq/github.com/playpark-llc/sales）
"""

import argparse
import glob
import json
import os
import re
import ssl
import sys
import time
from html.parser import HTMLParser
from urllib.parse import parse_qs, unquote, urlencode, urlparse
from urllib.request import Request, urlopen

import yaml

SALES_DIR = os.environ.get(
    "SALES_REPO_PATH",
    os.path.expanduser("~/ghq/github.com/playpark-llc/sales"),
)
COMPANIES_DIR = os.path.join(SALES_DIR, "companies")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
TIMEOUT = 15

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# 除外するドメイン（SNS、求人、ポータル等）
EXCLUDE_DOMAINS = {
    "facebook.com", "twitter.com", "x.com", "instagram.com", "linkedin.com",
    "youtube.com", "tiktok.com", "note.com", "ameblo.jp",
    "indeed.com", "recruit.co.jp", "en-japan.com", "doda.jp",
    "mynavi.jp", "rikunabi.com", "hellowork.mhlw.go.jp",
    "google.com", "google.co.jp", "maps.google.com",
    "wikipedia.org", "wikidata.org",
    "tabelog.com", "gnavi.co.jp", "hotpepper.jp",
    "info.gbiz.go.jp", "houjin-bangou.nta.go.jp",
    "baseconnect.in", "jp.indeed.com",
    "minkabu.jp", "nikkei.com", "toyokeizai.net",
    "amazon.co.jp", "rakuten.co.jp",
}


def fetch(url: str) -> str | None:
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
                return data.decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  WARN: fetch failed {url}: {e}", file=sys.stderr)
        return None


class GoogleResultParser(HTMLParser):
    """Google 検索結果ページから URL を抽出する."""

    def __init__(self):
        super().__init__()
        self.urls: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        attrs_d = dict(attrs)
        href = attrs_d.get("href", "")

        # Google の /url?q=... パターン
        if href.startswith("/url?"):
            parsed = parse_qs(urlparse(href).query)
            if "q" in parsed:
                url = parsed["q"][0]
                if url.startswith("http"):
                    self.urls.append(url)
        elif href.startswith("http") and "google" not in href:
            self.urls.append(href)


def is_excluded(url: str) -> bool:
    """除外ドメインかチェック."""
    try:
        domain = urlparse(url).netloc.lower()
        for excl in EXCLUDE_DOMAINS:
            if domain == excl or domain.endswith("." + excl):
                return True
    except Exception:
        return True
    return False


def search_company_url(company_name: str, address: str = "") -> str | None:
    """Google 検索で企業の公式HPを探す."""
    # 検索クエリ: 企業名 + "会社概要" で公式サイトを優先
    query = f"{company_name} 会社概要"

    # 住所から地域情報を追加（同名企業の区別）
    if address:
        # 都道府県を抽出
        m = re.match(r"〒?\d{3}-?\d{4}\s*(.{2,4}[都道府県])", address)
        if not m:
            m = re.match(r"(.{2,4}[都道府県])", address)
        if m:
            query += f" {m.group(1)}"

    encoded = urlencode({"q": query}, encoding="utf-8")
    search_url = f"https://www.google.com/search?{encoded}&hl=ja&num=10"

    html = fetch(search_url)
    if not html:
        return None

    parser = GoogleResultParser()
    try:
        parser.feed(html)
    except Exception:
        pass

    # 候補をフィルタリング
    candidates = []
    for url in parser.urls:
        if is_excluded(url):
            continue
        # PDF や画像は除外
        path = urlparse(url).path.lower()
        if any(path.endswith(ext) for ext in [".pdf", ".jpg", ".png", ".gif"]):
            continue
        candidates.append(url)

    if not candidates:
        return None

    # ホームページ（トップページ or /company ページ）を優先
    for url in candidates:
        parsed = urlparse(url)
        path = parsed.path.rstrip("/")
        # トップページ or 会社概要ページ
        if path in ("", "/company", "/about", "/corporate", "/profile"):
            # ドメインのトップを返す
            return f"{parsed.scheme}://{parsed.netloc}/"

    # 最初の候補のドメインルートを返す
    parsed = urlparse(candidates[0])
    return f"{parsed.scheme}://{parsed.netloc}/"


def verify_url(url: str) -> bool:
    """URL にアクセスできるか確認."""
    try:
        req = Request(url, headers={"User-Agent": UA}, method="HEAD")
        with urlopen(req, timeout=10, context=CTX) as resp:
            return resp.status < 400
    except Exception:
        # HEAD が拒否される場合は GET で再試行
        try:
            req = Request(url, headers={"User-Agent": UA})
            with urlopen(req, timeout=10, context=CTX) as resp:
                return resp.status < 400
        except Exception:
            return False


def main():
    parser = argparse.ArgumentParser(description="Google検索で企業HPのURLを特定")
    parser.add_argument("--dry-run", action="store_true", help="変更を書き込まない")
    parser.add_argument("--company", type=str, help="特定企業のみ処理")
    args = parser.parse_args()

    profiles = sorted(glob.glob(f"{COMPANIES_DIR}/*/profile.yml"))
    updated = 0
    results = []

    for profile_path in profiles:
        company = os.path.basename(os.path.dirname(profile_path))
        if args.company and args.company != company:
            continue

        with open(profile_path) as f:
            profile = yaml.safe_load(f) or {}

        # 既に URL がある場合はスキップ
        existing_url = profile.get("url", "")
        if existing_url and existing_url not in (None, "", "~", "null"):
            continue

        name = profile.get("name", company)
        address = profile.get("address", "")

        print(f"SEARCH: {company} ({name})", file=sys.stderr)
        url = search_company_url(name, address)

        if not url:
            results.append({"company": company, "status": "NOT_FOUND"})
            time.sleep(2)
            continue

        # URL の到達確認
        if verify_url(url):
            results.append({"company": company, "status": "FOUND", "url": url})
            if not args.dry_run:
                profile["url"] = url
                with open(profile_path, "w") as f:
                    yaml.dump(
                        profile, f, allow_unicode=True,
                        default_flow_style=False, sort_keys=False,
                    )
            updated += 1
        else:
            results.append({
                "company": company, "status": "UNREACHABLE", "url": url,
            })

        time.sleep(2)  # Google rate limit 対策

    summary = {
        "total_searched": len(results),
        "found": updated,
        "dry_run": args.dry_run,
        "results": results,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
