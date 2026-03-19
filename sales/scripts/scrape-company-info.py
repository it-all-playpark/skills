#!/usr/bin/env python3
"""企業HPから会社概要情報をスクレイピングして profile.yml を補完する.

標準ライブラリのみ使用（外部パッケージ不要）。

Usage:
    python3 scrape-company-info.py [--dry-run] [--company NAME]

環境変数:
    SALES_REPO_PATH: sales リポジトリパス（デフォルト: ~/ghq/github.com/playpark-llc/sales）
"""

import argparse
import glob
import os
import re
import ssl
import sys
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

import yaml

SALES_DIR = os.environ.get(
    "SALES_REPO_PATH",
    os.path.expanduser("~/ghq/github.com/playpark-llc/sales"),
)
COMPANIES_DIR = os.path.join(SALES_DIR, "companies")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
TIMEOUT = 15

# SSL 検証を緩和（古い企業サイト対策）
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# ─── HTML パーサー ───────────────────────────────────────────────

class TableExtractor(HTMLParser):
    """HTML から table(th/td) と dl(dt/dd) のキー・値ペアを抽出する."""

    def __init__(self):
        super().__init__()
        self.pairs: list[tuple[str, str]] = []
        self.links: list[tuple[str, str]] = []  # (text, href)
        self._tag_stack: list[str] = []
        self._current_text = ""
        self._row_cells: list[str] = []
        self._dt_text = ""
        self._in_dt = False
        self._in_dd = False
        self._dd_text = ""

    def handle_starttag(self, tag, attrs):
        self._tag_stack.append(tag)
        attrs_d = dict(attrs)

        if tag == "a" and "href" in attrs_d:
            self._current_href = attrs_d["href"]
        else:
            self._current_href = None

        if tag in ("th", "td"):
            self._current_text = ""
        elif tag == "tr":
            self._row_cells = []
        elif tag == "dt":
            self._in_dt = True
            self._dt_text = ""
        elif tag == "dd":
            self._in_dd = True
            self._dd_text = ""

    def handle_endtag(self, tag):
        if self._tag_stack and self._tag_stack[-1] == tag:
            self._tag_stack.pop()

        if tag in ("th", "td"):
            self._row_cells.append(self._current_text.strip())
            self._current_text = ""
        elif tag == "tr":
            if len(self._row_cells) >= 2:
                self.pairs.append((self._row_cells[0], self._row_cells[1]))
            self._row_cells = []
        elif tag == "dt":
            self._in_dt = False
        elif tag == "dd":
            self._in_dd = False
            if self._dt_text.strip() and self._dd_text.strip():
                self.pairs.append((self._dt_text.strip(), self._dd_text.strip()))
            self._dt_text = ""
            self._dd_text = ""
        elif tag == "a":
            pass

    def handle_data(self, data):
        if self._tag_stack and self._tag_stack[-1] in ("th", "td"):
            self._current_text += data
        if self._in_dt:
            self._dt_text += data
        if self._in_dd:
            self._dd_text += data

        # リンク収集
        if self._tag_stack and self._tag_stack[-1] == "a":
            href = getattr(self, "_current_href", None)
            if href:
                self.links.append((data.strip(), href))


class LinkExtractor(HTMLParser):
    """HTML から全 <a> リンクを抽出する."""

    def __init__(self):
        super().__init__()
        self.links: list[tuple[str, str]] = []  # (text, href)
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


# ─── フィールドマッチング ────────────────────────────────────────

FIELD_PATTERNS = {
    "representative_name": [r"代表者", r"代表取締役", r"CEO", r"社長"],
    "capital_stock": [r"資本金"],
    "employee_count": [r"従業員数", r"従業員", r"社員数"],
    "date_of_establishment": [r"設立", r"創業", r"創立"],
    "business_summary": [r"事業内容", r"事業概要", r"主な事業", r"業務内容"],
}

ABOUT_KEYWORDS = ["会社概要", "会社情報", "企業情報", "企業概要", "会社案内"]
ABOUT_PATHS = ["company", "about", "corporate", "profile", "gaiyou", "gaiyo"]


def match_pairs(pairs: list[tuple[str, str]]) -> dict:
    """キー・値ペアからフィールドにマッチングする."""
    result = {}
    for label, value in pairs:
        if not value or len(value) > 500:
            continue
        for field_key, patterns in FIELD_PATTERNS.items():
            if field_key in result:
                continue
            for pat in patterns:
                if re.search(pat, label):
                    result[field_key] = value
                    break
    return result


# ─── 正規化 ──────────────────────────────────────────────────────

def normalize_capital(raw: str) -> int | None:
    if not raw:
        return None
    raw = raw.replace(",", "").replace("，", "").replace(" ", "").replace("　", "")
    # 全角数字を半角に
    raw = raw.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    # 「5千万円」「3百万円」等の漢数字混在パターン
    unit_map = {"千": 1_000, "百": 100, "十": 10}
    for unit_char, unit_val in unit_map.items():
        m = re.search(rf"(\d+)\s*{unit_char}\s*(\d*)\s*万", raw)
        if m:
            major = int(m.group(1)) * unit_val
            minor = int(m.group(2)) if m.group(2) else 0
            return (major + minor) * 10_000
    m = re.search(r"([\d.]+)\s*億", raw)
    if m:
        return int(float(m.group(1)) * 100_000_000)
    m = re.search(r"([\d.]+)\s*万", raw)
    if m:
        return int(float(m.group(1)) * 10_000)
    m = re.search(r"(\d[\d]*)", raw)
    if m:
        val = int(m.group(1))
        return val if val > 100 else None  # 100円以下は誤検出として除外
    return None


def normalize_employee(raw: str) -> int | None:
    if not raw:
        return None
    m = re.search(r"(\d[\d,]*)", raw.replace(",", ""))
    return int(m.group(1)) if m else None


def normalize_date(raw: str) -> str | None:
    if not raw:
        return None
    raw = raw.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    m = re.search(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", raw)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(r"(\d{4})\s*年\s*(\d{1,2})\s*月", raw)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-01"
    m = re.search(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", raw)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    era_map = {"明治": 1868, "大正": 1912, "昭和": 1926, "平成": 1989, "令和": 2019}
    for era, base in era_map.items():
        m = re.search(
            rf"{era}\s*(\d{{1,2}})\s*年\s*(\d{{1,2}})\s*月(?:\s*(\d{{1,2}})\s*日)?",
            raw,
        )
        if m:
            year = base + int(m.group(1)) - 1
            month = int(m.group(2))
            day = int(m.group(3)) if m.group(3) else 1
            return f"{year}-{month:02d}-{day:02d}"
    return None


# ─── HTTP ────────────────────────────────────────────────────────

def fetch(url: str) -> str | None:
    try:
        req = Request(url, headers={"User-Agent": UA})
        with urlopen(req, timeout=TIMEOUT, context=CTX) as resp:
            data = resp.read()
            # エンコーディング推定
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


def find_about_url(base_url: str, html: str) -> str | None:
    parser = LinkExtractor()
    try:
        parser.feed(html)
    except Exception:
        return None

    # テキストマッチ
    for text, href in parser.links:
        if any(kw in text for kw in ABOUT_KEYWORDS):
            return urljoin(base_url, href)

    # パスマッチ
    for text, href in parser.links:
        full = urljoin(base_url, href)
        path = urlparse(full).path.lower()
        if any(p in path for p in ABOUT_PATHS):
            return full

    return None


def extract_from_html(html: str) -> dict:
    parser = TableExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    return match_pairs(parser.pairs)


# ─── メイン処理 ──────────────────────────────────────────────────

def scrape_company(name: str, base_url: str) -> dict:
    result = {}

    html = fetch(base_url)
    if not html:
        return result

    # トップページから抽出
    result.update(extract_from_html(html))

    # 会社概要ページを探す
    about_url = find_about_url(base_url, html)
    if about_url and about_url.rstrip("/") != base_url.rstrip("/"):
        time.sleep(0.5)
        about_html = fetch(about_url)
        if about_html:
            about_data = extract_from_html(about_html)
            for k, v in about_data.items():
                result[k] = v

    # 正規化
    if "capital_stock" in result:
        n = normalize_capital(result["capital_stock"])
        if n:
            result["capital_stock"] = n
        else:
            del result["capital_stock"]

    if "employee_count" in result:
        n = normalize_employee(result["employee_count"])
        if n:
            result["employee_count"] = n
        else:
            del result["employee_count"]

    if "date_of_establishment" in result:
        n = normalize_date(result["date_of_establishment"])
        if n:
            result["date_of_establishment"] = n
        else:
            del result["date_of_establishment"]

    return result


def main():
    parser = argparse.ArgumentParser(description="企業HPから会社情報をスクレイピング")
    parser.add_argument("--dry-run", action="store_true", help="変更を書き込まない")
    parser.add_argument("--company", type=str, help="特定企業のみ処理")
    args = parser.parse_args()

    profiles = sorted(glob.glob(f"{COMPANIES_DIR}/*/profile.yml"))
    updated_total = 0
    results = []

    for profile_path in profiles:
        company = os.path.basename(os.path.dirname(profile_path))
        if args.company and args.company != company:
            continue

        with open(profile_path) as f:
            profile = yaml.safe_load(f) or {}

        url = profile.get("url", "")
        if not url:
            results.append({"company": company, "status": "SKIP", "reason": "URL なし"})
            continue

        missing = [
            k for k in [
                "capital_stock", "employee_count", "representative_name",
                "date_of_establishment", "business_summary",
            ]
            if not profile.get(k) or profile.get(k) in (None, "", "~", "null", 0)
        ]

        if not missing:
            results.append({"company": company, "status": "SKIP", "reason": "充足済"})
            continue

        print(f"SCRAPE: {company} ({url})", file=sys.stderr)
        scraped = scrape_company(company, url)

        updates = {k: scraped[k] for k in missing if k in scraped and scraped[k]}

        if not updates:
            results.append({
                "company": company, "status": "NO_DATA",
                "reason": "マッチするデータなし", "missing": missing,
            })
            continue

        results.append({
            "company": company, "status": "UPDATED",
            "updates": {k: str(v) for k, v in updates.items()},
        })

        if not args.dry_run:
            profile.update(updates)
            with open(profile_path, "w") as f:
                yaml.dump(
                    profile, f, allow_unicode=True,
                    default_flow_style=False, sort_keys=False,
                )

        updated_total += 1
        time.sleep(1)

    # 結果サマリーを stdout に JSON で出力
    import json
    summary = {
        "total_companies": len(profiles),
        "updated": updated_total,
        "dry_run": args.dry_run,
        "results": results,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
