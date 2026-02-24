#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "gspread>=6.0",
#     "google-auth-oauthlib>=1.0",
# ]
# ///
"""Search business card data in Google Spreadsheet via gspread with OAuth2."""

import argparse
import json
import sys
from pathlib import Path

import gspread

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent

HEADERS = [
    "姓", "名", "姓ふりがな", "名ふりがな",
    "会社名", "部署", "役職",
    "郵便番号", "住所",
    "電話番号", "携帯番号", "FAX",
    "メールアドレス", "Webサイト", "SNS",
    "登録日時",
]

FIELD_KEYS = [
    "last_name", "first_name", "last_name_kana", "first_name_kana",
    "company", "department", "title",
    "postal_code", "address",
    "phone", "mobile", "fax",
    "email", "website", "sns",
    "registered_at",
]

# Field groups for --field filtering
NAME_INDICES = [0, 1, 2, 3]  # 姓, 名, 姓ふりがな, 名ふりがな
COMPANY_INDICES = [4]  # 会社名
ALL_SEARCH_INDICES = NAME_INDICES + COMPANY_INDICES


def load_env() -> dict[str, str]:
    """Load .env file from skill directory."""
    env_file = SKILL_DIR / ".env"
    if not env_file.exists():
        return {}
    env = {}
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def get_client(credentials_path: str | None = None) -> gspread.Client:
    """Authenticate with OAuth2 (Desktop app flow)."""
    kwargs = {}
    if credentials_path:
        kwargs["credentials_filename"] = credentials_path
    return gspread.oauth(**kwargs)


def normalize(text: str) -> str:
    """Normalize text for case-insensitive matching (casefold)."""
    return text.casefold()


def search_rows(
    records: list[list[str]],
    query: str,
    field: str,
) -> list[dict[str, str]]:
    """Search rows by partial match on specified fields."""
    if field == "name":
        indices = NAME_INDICES
    elif field == "company":
        indices = COMPANY_INDICES
    else:
        indices = ALL_SEARCH_INDICES

    normalized_query = normalize(query)
    results = []

    for row in records[1:]:  # skip header
        if len(row) < len(FIELD_KEYS):
            row = row + [""] * (len(FIELD_KEYS) - len(row))
        matched = any(
            normalized_query in normalize(row[i])
            for i in indices
            if i < len(row)
        )
        if matched:
            entry = {FIELD_KEYS[i]: row[i] for i in range(min(len(FIELD_KEYS), len(row)))}
            results.append(entry)

    return results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Search business card data in Google Spreadsheet",
    )
    parser.add_argument("--query", required=True, help="Search keyword (partial match)")
    parser.add_argument("--credentials", help="Path to OAuth credentials.json")
    parser.add_argument("--spreadsheet-id", help="Spreadsheet ID (overrides .env)")
    parser.add_argument(
        "--field",
        choices=["name", "company", "all"],
        default="all",
        help="Field to search: name (姓/名/ふりがな), company (会社名), all (default)",
    )
    args = parser.parse_args()

    env = load_env()
    spreadsheet_id = args.spreadsheet_id or env.get("SPREADSHEET_ID")

    if not spreadsheet_id:
        print("Error: --spreadsheet-id or SPREADSHEET_ID in .env required", file=sys.stderr)
        sys.exit(1)

    client = get_client(args.credentials)
    sh = client.open_by_key(spreadsheet_id)
    ws = sh.sheet1
    records = ws.get_all_values()

    results = search_rows(records, args.query, args.field)
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
