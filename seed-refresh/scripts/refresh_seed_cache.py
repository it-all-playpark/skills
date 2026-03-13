#!/usr/bin/env python3
"""
Bulk refresh seed cache files when repository updates are newer than exportedAt.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


REPO_EXPORT_SCRIPT = Path.home() / ".claude/skills/repo-export/scripts/export_repo.py"
REPO_COMMIT_SCRIPT = Path.home() / ".claude/skills/repo-commit/scripts/export_commit.py"
REPO_ISSUE_SCRIPT = Path.home() / ".claude/skills/repo-issue/scripts/export_issue.py"
REPO_PR_SCRIPT = Path.home() / ".claude/skills/repo-pr/scripts/export_pr.py"

EXPORT_FILE = "exported.md"
COMMIT_FILE = "commits.md"
ISSUE_FILE = "issues.md"
PR_FILE = "pr-summary.md"


@dataclass
class SeedResult:
    seed_dir: Path
    repo_url: str | None
    branch_checked: str | None = None
    latest_commit_at: str | None = None
    exported_at: str | None = None
    status: str = "skipped"
    reason: str | None = None
    refreshed: bool = False


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=False)


def parse_iso8601(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_zulu(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_repo_path(repo_url: str) -> str | None:
    raw = repo_url.strip()
    if not raw:
        return None

    if raw.startswith("git@github.com:"):
        path = raw.replace("git@github.com:", "", 1)
    elif raw.startswith("https://github.com/"):
        parsed = urlparse(raw)
        path = parsed.path.lstrip("/")
    else:
        path = raw

    path = path.removesuffix(".git").strip("/")
    parts = path.split("/")
    if len(parts) < 2:
        return None
    return f"{parts[0]}/{parts[1]}"


def load_manifest(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def save_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def get_latest_commit_date(repo_path: str, branch: str) -> tuple[str | None, str | None, str | None]:
    # 1) requested branch (default: main)
    by_branch = run(["gh", "api", f"repos/{repo_path}/commits/{branch}", "--jq", ".commit.committer.date"])
    if by_branch.returncode == 0:
        return by_branch.stdout.strip(), branch, None

    # 2) default branch fallback
    default_branch_res = run(["gh", "api", f"repos/{repo_path}", "--jq", ".default_branch"])
    if default_branch_res.returncode != 0:
        return None, None, "failed_to_resolve_default_branch"

    default_branch = default_branch_res.stdout.strip()
    if not default_branch:
        return None, None, "empty_default_branch"

    by_default = run(
        ["gh", "api", f"repos/{repo_path}/commits/{default_branch}", "--jq", ".commit.committer.date"]
    )
    if by_default.returncode != 0:
        return None, default_branch, "failed_to_get_latest_commit"

    return by_default.stdout.strip(), default_branch, None


def check_dependencies() -> list[str]:
    missing: list[str] = []
    for script in [REPO_EXPORT_SCRIPT, REPO_COMMIT_SCRIPT, REPO_ISSUE_SCRIPT, REPO_PR_SCRIPT]:
        if not script.exists():
            missing.append(str(script))
    return missing


def refresh_seed(seed_dir: Path, repo_url: str, branch: str) -> tuple[bool, str | None]:
    exported_path = seed_dir / EXPORT_FILE
    commits_path = seed_dir / COMMIT_FILE
    issues_path = seed_dir / ISSUE_FILE
    pr_path = seed_dir / PR_FILE

    commands = [
        ["python3", str(REPO_EXPORT_SCRIPT), repo_url, "-o", str(exported_path), "-b", branch],
        ["python3", str(REPO_COMMIT_SCRIPT), repo_url, "-o", str(commits_path), "--limit", "50"],
        ["python3", str(REPO_ISSUE_SCRIPT), repo_url, "-o", str(issues_path), "--state", "all", "--limit", "30"],
        ["python3", str(REPO_PR_SCRIPT), repo_url, "-o", str(pr_path), "--state", "merged", "--limit", "30"],
    ]

    for cmd in commands:
        res = run(cmd)
        if res.returncode != 0:
            stderr = res.stderr.strip() or "command_failed"
            return False, stderr
    return True, None


def resolve_seed_dirs(seed_arg: str) -> list[Path]:
    base = Path(seed_arg)
    if base.is_file() and base.name == "manifest.json":
        return [base.parent]
    if base.is_dir():
        manifest = base / "manifest.json"
        if manifest.exists():
            return [base]
        return sorted([p.parent for p in base.glob("*/manifest.json")])
    return sorted([p.parent for p in Path(".").glob(f"{seed_arg.rstrip('/')}/manifest.json")])


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Refresh seed caches if repository branch has newer commits than manifest.exportedAt"
    )
    parser.add_argument("--seed", default="seed", help="Seed root directory or specific seed directory (default: seed)")
    parser.add_argument("--branch", default="main", help="Branch to compare against (default: main)")
    parser.add_argument("--force", action="store_true", help="Refresh without date comparison")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be refreshed without updating files")
    parser.add_argument("--limit", type=int, default=0, help="Max seed directories to process (0 = no limit)")
    args = parser.parse_args()

    missing = check_dependencies()
    if missing:
        print("Missing dependency scripts:", file=sys.stderr)
        for item in missing:
            print(f"- {item}", file=sys.stderr)
        return 1

    seed_dirs = resolve_seed_dirs(args.seed)
    if not seed_dirs:
        print("No seed directories found.", file=sys.stderr)
        return 1

    if args.limit > 0:
        seed_dirs = seed_dirs[: args.limit]

    results: list[SeedResult] = []

    for seed_dir in seed_dirs:
        manifest_path = seed_dir / "manifest.json"
        result = SeedResult(seed_dir=seed_dir, repo_url=None)

        manifest = load_manifest(manifest_path)
        if manifest is None:
            result.status = "error"
            result.reason = "invalid_manifest"
            results.append(result)
            continue

        repo_url = (manifest.get("source") or manifest.get("url") or "").strip()
        exported_at_raw = (manifest.get("exportedAt") or "").strip()
        exported_at = parse_iso8601(exported_at_raw)

        result.repo_url = repo_url or None
        result.exported_at = exported_at_raw or None

        if not repo_url:
            result.status = "error"
            result.reason = "missing_source_or_url"
            results.append(result)
            continue

        repo_path = parse_repo_path(repo_url)
        if not repo_path:
            result.status = "error"
            result.reason = "invalid_repo_url"
            results.append(result)
            continue

        latest_raw, branch_checked, err = get_latest_commit_date(repo_path, args.branch)
        result.branch_checked = branch_checked
        result.latest_commit_at = latest_raw

        if err:
            result.status = "error"
            result.reason = err
            results.append(result)
            continue

        latest = parse_iso8601(latest_raw)
        if latest is None:
            result.status = "error"
            result.reason = "invalid_latest_commit_date"
            results.append(result)
            continue

        if not args.force:
            if exported_at is None:
                result.status = "error"
                result.reason = "invalid_or_missing_exportedAt"
                results.append(result)
                continue
            if latest <= exported_at:
                result.status = "skipped"
                result.reason = "up_to_date"
                results.append(result)
                continue

        if args.dry_run:
            result.status = "would_refresh"
            result.reason = "dry_run"
            result.refreshed = True
            results.append(result)
            continue

        ok, refresh_err = refresh_seed(seed_dir, repo_url, branch_checked or args.branch)
        if not ok:
            result.status = "error"
            result.reason = refresh_err
            results.append(result)
            continue

        now = datetime.now(timezone.utc)
        manifest["exportedAt"] = to_zulu(now)
        save_manifest(manifest_path, manifest)

        result.status = "refreshed"
        result.reason = "updated"
        result.refreshed = True
        result.exported_at = manifest["exportedAt"]
        results.append(result)

    total = len(results)
    refreshed = sum(1 for r in results if r.status in {"refreshed", "would_refresh"})
    skipped = sum(1 for r in results if r.status == "skipped")
    errors = sum(1 for r in results if r.status == "error")

    for r in results:
        branch_note = f" branch={r.branch_checked}" if r.branch_checked else ""
        print(f"[{r.status}] {r.seed_dir}{branch_note}")
        if r.reason:
            print(f"  reason: {r.reason}")
        if r.latest_commit_at:
            print(f"  latest: {r.latest_commit_at}")
        if r.exported_at:
            print(f"  exportedAt: {r.exported_at}")

    print(
        f"\nSummary: total={total}, refreshed={refreshed}, skipped={skipped}, errors={errors}, dry_run={args.dry_run}"
    )

    return 0 if errors == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
