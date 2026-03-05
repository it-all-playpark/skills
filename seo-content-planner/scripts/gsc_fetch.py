#!/usr/bin/env python3
"""
GSC Search Analytics Fetcher for SEO Content Planner

Queries the Google Search Console Search Analytics API and saves
the raw response as JSON. Provides both a CLI interface and an
importable function for use from seo_planner.py.

CLI Usage:
    python gsc_fetch.py \\
        --site "sc-domain:playpark.co.jp" \\
        --output claudedocs/gsc-report-2026-03.json \\
        --days 28 --limit 500

Function Usage:
    from gsc_fetch import fetch_gsc_data
    data = fetch_gsc_data(site="sc-domain:playpark.co.jp", days=28)

Dependencies:
    pip install google-auth google-auth-oauthlib google-api-python-client
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# Add _lib to path for config loader
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_lib"))
from config import merge_config

try:
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
except ImportError:
    print(
        "ERROR: Required packages not installed. Run:\n"
        "  pip install google-auth google-auth-oauthlib google-api-python-client",
        file=sys.stderr,
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# Auth configuration (mirrors gsc_query.py)
# ---------------------------------------------------------------------------
SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"]
DEFAULT_OAUTH_CLIENT = Path.home() / ".config" / "ga4" / "client_secret.json"
DEFAULT_TOKEN_PATH = Path.home() / ".gsc_tokens.json"

# Module-level overrides, settable via configure() or CLI
_oauth_client: Optional[Path] = None
_token_path: Path = DEFAULT_TOKEN_PATH


def configure(
    oauth_client: Path | None = None,
    token_path: Path | None = None,
) -> None:
    """Override default auth paths (useful when imported as a library)."""
    global _oauth_client, _token_path
    if oauth_client is not None:
        _oauth_client = oauth_client
    if token_path is not None:
        _token_path = token_path


# ---------------------------------------------------------------------------
# Authentication (same dual-strategy pattern as gsc_query.py)
# ---------------------------------------------------------------------------
def get_credentials() -> Credentials:
    """Obtain Google OAuth credentials.

    Strategy 1 -- OAuth client JSON file (preferred):
        Reads ``~/.config/ga4/client_secret.json``. If a cached token exists
        at ``~/.gsc_tokens.json`` it is loaded and refreshed when expired.
        Otherwise an interactive ``InstalledAppFlow`` is launched.

    Strategy 2 -- Environment variables (fallback):
        Uses ``GOOGLE_CLIENT_ID``, ``GOOGLE_CLIENT_SECRET``, and
        ``GOOGLE_REFRESH_TOKEN`` to build credentials directly.

    Returns:
        A valid ``google.oauth2.credentials.Credentials`` instance.

    Raises:
        SystemExit: When no viable credentials source is found.
    """
    oauth_client = _oauth_client or DEFAULT_OAUTH_CLIENT
    token_path = _token_path

    # --- Strategy 1: OAuth client JSON file ---
    if oauth_client.exists():
        creds: Credentials | None = None

        if token_path.exists():
            try:
                creds = Credentials.from_authorized_user_file(
                    str(token_path), SCOPES
                )
            except Exception:
                creds = None

        # Refresh expired credentials
        if creds and creds.expired and creds.refresh_token:
            from google.auth.transport.requests import Request

            try:
                creds.refresh(Request())
            except Exception as exc:
                print(
                    f"Token refresh failed ({exc}). Re-authenticating...",
                    file=sys.stderr,
                )
                creds = None
            else:
                _save_token(token_path, creds)
                return creds

        if creds and creds.valid:
            return creds

        # Interactive OAuth flow for new / invalid tokens
        creds = _run_oauth_flow(oauth_client)
        _save_token(token_path, creds)
        print(f"Token saved to: {token_path}", file=sys.stderr)
        return creds

    # --- Strategy 2: Environment variables ---
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    refresh_token = os.environ.get("GOOGLE_REFRESH_TOKEN")

    if not all([client_id, client_secret, refresh_token]):
        print(
            "ERROR: Missing credentials. Either:\n"
            f"  1. Place OAuth client JSON at {DEFAULT_OAUTH_CLIENT}\n"
            "  2. Set env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, "
            "GOOGLE_REFRESH_TOKEN",
            file=sys.stderr,
        )
        sys.exit(1)

    return Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=SCOPES,
    )


def _run_oauth_flow(oauth_client: Path) -> Credentials:
    """Run the interactive OAuth installed-app flow."""
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print(
            "ERROR: pip install google-auth-oauthlib",
            file=sys.stderr,
        )
        sys.exit(1)

    print("Launching OAuth 2.0 authentication flow...", file=sys.stderr)
    flow = InstalledAppFlow.from_client_secrets_file(
        str(oauth_client), SCOPES
    )
    return flow.run_local_server(port=0)


def _save_token(token_path: Path, creds: Credentials) -> None:
    """Persist credentials to disk with restricted permissions."""
    token_path.write_text(creds.to_json())
    os.chmod(token_path, 0o600)


def _build_service():
    """Build the Search Console API service client."""
    creds = get_credentials()
    return build("searchconsole", "v1", credentials=creds)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def fetch_gsc_data(
    site: str,
    days: int = 28,
    limit: int = 500,
    dimensions: list[str] | None = None,
) -> dict:
    """Fetch GSC Search Analytics data and return the raw API response.

    Args:
        site: Site URL registered in Search Console
              (e.g. ``"sc-domain:playpark.co.jp"``).
        days: Number of trailing days to query. The window ends 3 days
              before today to ensure data finality.
        limit: Maximum number of rows to return.
        dimensions: Dimensions for the query. Defaults to
                    ``["query", "page"]``.

    Returns:
        The raw JSON response from the Search Analytics API as a ``dict``.

    Raises:
        SystemExit: On authentication failure or HTTP errors.
    """
    if dimensions is None:
        dimensions = ["query", "page"]

    service = _build_service()

    # GSC data has a ~3-day processing lag
    end_date = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=days + 3)).strftime("%Y-%m-%d")

    request_body = {
        "startDate": start_date,
        "endDate": end_date,
        "dimensions": dimensions,
        "rowLimit": limit,
        "dataState": "final",
    }

    try:
        response = (
            service.searchanalytics()
            .query(siteUrl=site, body=request_body)
            .execute()
        )
    except HttpError as exc:
        print(f"ERROR: GSC API request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    return response


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _print_summary(response: dict) -> None:
    """Print a concise summary of the fetched data to stderr."""
    rows = response.get("rows", [])
    row_count = len(rows)

    total_impressions = sum(r.get("impressions", 0) for r in rows)
    total_clicks = sum(r.get("clicks", 0) for r in rows)

    print(f"Rows fetched:      {row_count}", file=sys.stderr)
    print(f"Total impressions: {total_impressions:,.0f}", file=sys.stderr)
    print(f"Total clicks:      {total_clicks:,.0f}", file=sys.stderr)

    if total_impressions > 0:
        overall_ctr = total_clicks / total_impressions * 100
        print(f"Overall CTR:       {overall_ctr:.2f}%", file=sys.stderr)


def main() -> None:
    global _oauth_client, _token_path

    # Load project config
    config = merge_config({"site": None}, "seo-content-planner")

    parser = argparse.ArgumentParser(
        description="Fetch GSC Search Analytics data and save as JSON.",
    )
    parser.add_argument(
        "--site",
        required=False,
        default=None,
        help='Site URL registered in GSC (e.g. "sc-domain:playpark.co.jp")',
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output JSON file path",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=28,
        help="Number of trailing days to query (default: 28)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=500,
        help="Maximum row count (default: 500)",
    )
    parser.add_argument(
        "--dimensions",
        nargs="+",
        default=["query", "page"],
        help='Dimensions to query (default: "query" "page")',
    )
    parser.add_argument(
        "--oauth-client",
        type=Path,
        default=DEFAULT_OAUTH_CLIENT,
        help=f"Path to OAuth client secrets JSON (default: {DEFAULT_OAUTH_CLIENT})",
    )
    parser.add_argument(
        "--token-path",
        type=Path,
        default=DEFAULT_TOKEN_PATH,
        help=f"Path to cached OAuth tokens (default: {DEFAULT_TOKEN_PATH})",
    )

    args = parser.parse_args()

    # Apply auth overrides before any API call
    _oauth_client = args.oauth_client
    _token_path = args.token_path

    # Resolve site: CLI arg > config
    site = args.site or config.get("site")
    if not site:
        print("Error: --site is required (or set in .claude/skill-config.json)", file=sys.stderr)
        sys.exit(1)
    args.site = site

    print(
        f"Fetching GSC data for {args.site} "
        f"(last {args.days} days, limit {args.limit})...",
        file=sys.stderr,
    )

    response = fetch_gsc_data(
        site=args.site,
        days=args.days,
        limit=args.limit,
        dimensions=args.dimensions,
    )

    # Write JSON output
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(response, ensure_ascii=False, indent=2) + "\n",
    )
    print(f"\nSaved to: {output_path}", file=sys.stderr)

    # Summary on stderr so stdout stays clean for piping
    _print_summary(response)


if __name__ == "__main__":
    main()
