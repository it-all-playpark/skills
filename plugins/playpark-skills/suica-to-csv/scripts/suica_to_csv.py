#!/usr/bin/env python3
"""Convert モバイルSuica残高ご利用明細 PDF text data to マネーフォワードクラウド経費 CSV."""

import csv
import io
import re
import sys
from pathlib import Path


# --- Operator classification ---

OPERATOR_MAP = {
    "地": "東京メトロ",
    "都": "都営地下鉄",
    "京王": "京王電鉄",
    "京急": "京急電鉄",
    "JW": "JR西日本",
    "ＪＷ": "JR西日本",
    "ＭＲ": "モノレール",
    "MR": "モノレール",
    "りんかい": "りんかい線",
    "ﾘﾝｶｲ": "りんかい線",
    "TX": "つくばエクスプレス",
    "ＴＸ": "つくばエクスプレス",
}

BUS_COMPANY_MAP = {
    "関東自動": "関東自動車",
    "神奈中": "神奈中バス",
    "西武バス": "西武バス",
    "東武バス": "東武バス",
    "国際興業": "国際興業バス",
    "都営バス": "都営バス",
    "京王バス": "京王バス",
    "小田急バス": "小田急バス",
    "東急バス": "東急バス",
    "京急バス": "京急バス",
    "京成バス": "京成バス",
    "関東バス": "関東バス",
}

# CSV header for マネーフォワードクラウド経費
MF_HEADER = [
    "日付", "支払先・内容", "経費科目", "金額（税込）",
    "自社出席代表者名", "自社出席者人数", "他社出席代表者名", "他社出席者人数",
    "メモ", "費用負担部門名", "費用負担部門コード", "プロジェクト名",
    "税区分", "通貨", "為替レート", "貸方勘定科目", "貸方補助科目", "事前申請番号",
]


def detect_year_range(filename: str) -> tuple[int, int]:
    """Detect start/end year from PDF filename pattern.

    Filename pattern: JE80F025072508792_YYYYMMDD_YYYYMMDDHHMMSS.pdf
    where first date is start date and second is export date.
    """
    match = re.search(r"_(\d{4})(\d{2})\d{2}_(\d{4})\d{10}", filename)
    if match:
        start_year = int(match.group(1))
        start_month = int(match.group(2))
        end_year = int(match.group(3))
        return start_year, end_year

    # Fallback: current year for months > 6, next year for months <= 6
    from datetime import date
    now = date.today()
    return now.year, now.year + 1


def classify_operator(station: str) -> tuple[str, str]:
    """Classify operator from station name. Returns (operator, clean_station_name)."""
    clean = station.strip()

    # Full-width space separation (e.g., "地　新橋" or "都　新橋")
    if re.match(r"^(地|都)\s+", clean) or re.match(r"^(地|都)　", clean):
        prefix = clean[0]
        station_name = re.sub(r"^(地|都)[\s　]+", "", clean)
        return OPERATOR_MAP[prefix], station_name

    # Direct prefix (e.g., "地恵比寿", "地六本木")
    if clean.startswith("地") and len(clean) > 1 and not clean.startswith("地下"):
        return "東京メトロ", clean[1:]

    # Other prefixes
    for prefix, operator in OPERATOR_MAP.items():
        if clean.startswith(prefix):
            return operator, clean[len(prefix):]

    return "JR東日本", clean


def classify_bus(company_raw: str) -> str:
    """Classify bus company from raw name."""
    for key, name in BUS_COMPANY_MAP.items():
        if key in company_raw:
            return name
    return company_raw


def parse_amount(amount_str: str) -> int:
    """Parse amount string like '-1,980' to absolute integer 1980."""
    cleaned = amount_str.replace(",", "").replace("，", "").strip()
    return abs(int(cleaned))


def month_to_year(month: int, start_year: int, end_year: int) -> int:
    """Determine year for a given month based on year range."""
    if start_year == end_year:
        return start_year
    # If data spans year boundary (e.g., 2025-2026), months >= start month use start_year
    # This heuristic works for typical Suica statements spanning ~3 months
    if month >= 7:  # Jul-Dec → start_year
        return start_year
    else:  # Jan-Jun → end_year
        return end_year


def parse_transactions(text: str, start_year: int, end_year: int) -> list[dict]:
    """Parse Suica transaction text lines into structured records."""
    rows = []

    # Match train lines: MM DD 入/＊入 STATION 出 STATION AMOUNT
    train_pattern = re.compile(
        r"(\d{2})\s+(\d{2})\s+(?:＊)?入\s+(.+?)\s+出\s+(.+?)\s+(-?[\d,，]+)"
    )
    # Match bus lines: MM DD ﾊﾞｽ等 COMPANY AMOUNT
    bus_pattern = re.compile(
        r"(\d{2})\s+(\d{2})\s+(?:ﾊﾞｽ等|バス等)\s+(.+?)\s+(-?[\d,，]+)"
    )

    for line in text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue

        # Try bus pattern first (more specific)
        bus_match = bus_pattern.match(line)
        if bus_match:
            month = int(bus_match.group(1))
            day = int(bus_match.group(2))
            company_raw = bus_match.group(3).strip()
            amount = parse_amount(bus_match.group(4))

            if amount == 0:
                continue

            year = month_to_year(month, start_year, end_year)
            company = classify_bus(company_raw)

            rows.append({
                "date": f"{year}/{month:02d}/{day:02d}",
                "payee": company,
                "category": "バス代",
                "amount": amount,
                "memo": company,
            })
            continue

        # Try train pattern
        train_match = train_pattern.match(line)
        if train_match:
            month = int(train_match.group(1))
            day = int(train_match.group(2))
            station_in = train_match.group(3).strip()
            station_out = train_match.group(4).strip()
            amount = parse_amount(train_match.group(5))

            if amount == 0:
                continue

            year = month_to_year(month, start_year, end_year)
            operator_in, clean_in = classify_operator(station_in)
            operator_out, clean_out = classify_operator(station_out)

            # Use entry station's operator as payee
            payee = operator_in
            memo = f"{clean_in} → {clean_out}"

            rows.append({
                "date": f"{year}/{month:02d}/{day:02d}",
                "payee": payee,
                "category": "電車代",
                "amount": amount,
                "memo": memo,
            })

    return rows


def to_mf_csv(rows: list[dict]) -> str:
    """Convert parsed rows to MF Cloud CSV string with BOM."""
    output = io.StringIO()
    output.write("\ufeff")  # UTF-8 BOM

    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(MF_HEADER)

    for row in rows:
        writer.writerow([
            row["date"],       # 日付
            row["payee"],      # 支払先・内容
            row["category"],   # 経費科目
            row["amount"],     # 金額（税込）
            "",                # 自社出席代表者名
            "",                # 自社出席者人数
            "",                # 他社出席代表者名
            "",                # 他社出席者人数
            row["memo"],       # メモ
            "",                # 費用負担部門名
            "",                # 費用負担部門コード
            "",                # プロジェクト名
            "",                # 税区分
            "JPY",             # 通貨
            "1",               # 為替レート
            "",                # 貸方勘定科目
            "",                # 貸方補助科目
            "",                # 事前申請番号
        ])

    return output.getvalue()


def main():
    if len(sys.argv) < 2:
        print("Usage: suica_to_csv.py <transaction_text_file> [--start-year YYYY] [--end-year YYYY]")
        print("  Reads parsed Suica transaction text and outputs MF Cloud CSV.")
        sys.exit(1)

    input_file = Path(sys.argv[1])
    start_year = None
    end_year = None

    # Parse optional args
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--start-year" and i + 1 < len(args):
            start_year = int(args[i + 1])
            i += 2
        elif args[i] == "--end-year" and i + 1 < len(args):
            end_year = int(args[i + 1])
            i += 2
        else:
            i += 1

    if start_year is None or end_year is None:
        sy, ey = detect_year_range(input_file.name)
        start_year = start_year or sy
        end_year = end_year or ey

    text = input_file.read_text(encoding="utf-8")
    rows = parse_transactions(text, start_year, end_year)

    if not rows:
        print("ERROR: No transactions parsed. Check input format.", file=sys.stderr)
        sys.exit(1)

    csv_content = to_mf_csv(rows)

    output_path = Path.cwd() / "suica_transactions.csv"
    output_path.write_text(csv_content, encoding="utf-8")

    # Summary
    train_count = sum(1 for r in rows if r["category"] == "電車代")
    bus_count = sum(1 for r in rows if r["category"] == "バス代")
    total = sum(r["amount"] for r in rows)
    print(f"✅ Generated: {output_path}")
    print(f"   Rows: {len(rows)} (電車代: {train_count}, バス代: {bus_count})")
    print(f"   Total: {total:,} JPY")


if __name__ == "__main__":
    main()
