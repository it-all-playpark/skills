#!/usr/bin/env python3
"""Create a GitHub issue from a prepared markdown body file."""

from __future__ import annotations

import argparse
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


def split_csv(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def build_command(args: argparse.Namespace) -> list[str]:
    cmd = [
        "gh",
        "issue",
        "create",
        "--title",
        args.title,
        "--body-file",
        str(args.body_file),
    ]

    if args.repo:
        cmd.extend(["--repo", args.repo])

    for label in split_csv(args.labels):
        cmd.extend(["--label", label])

    for assignee in split_csv(args.assignees):
        cmd.extend(["--assignee", assignee])

    if args.milestone:
        cmd.extend(["--milestone", args.milestone])

    return cmd


def ensure_body_file(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"body file not found: {path}")
    if not path.is_file():
        raise ValueError(f"body path is not a file: {path}")
    if path.stat().st_size == 0:
        raise ValueError(f"body file is empty: {path}")


def ensure_gh_ready() -> None:
    if shutil.which("gh") is None:
        raise RuntimeError("gh CLI is not installed or not in PATH")

    auth = subprocess.run(
        ["gh", "auth", "status"],
        capture_output=True,
        text=True,
    )
    if auth.returncode != 0:
        message = (auth.stderr or auth.stdout or "unknown auth error").strip()
        raise RuntimeError(f"gh auth check failed: {message}")


def command_to_string(cmd: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in cmd)


def run(args: argparse.Namespace) -> int:
    ensure_body_file(args.body_file)
    cmd = build_command(args)

    if args.dry_run:
        preview = args.body_file.read_text(encoding="utf-8").splitlines()
        print("Dry run: issue will not be created.")
        print(f"Command: {command_to_string(cmd)}")
        print(f"Body file: {args.body_file}")
        print("Body preview (first 20 lines):")
        for line in preview[:20]:
            print(line)
        return 0

    ensure_gh_ready()
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "unknown gh error").strip()
        print(f"Failed to create issue: {message}", file=sys.stderr)
        return result.returncode

    output = (result.stdout or "").strip()
    if output:
        print(output.splitlines()[-1])
    else:
        print("Issue created, but no URL returned by gh.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a GitHub issue from a markdown file.",
    )
    parser.add_argument("--title", required=True, help="Issue title")
    parser.add_argument(
        "--body-file",
        type=Path,
        required=True,
        help="Path to markdown file used as issue body",
    )
    parser.add_argument("--repo", help="Target repository in owner/repo format")
    parser.add_argument("--labels", help="Comma-separated labels")
    parser.add_argument("--assignees", help="Comma-separated assignees")
    parser.add_argument("--milestone", help="Milestone name")
    parser.add_argument("--dry-run", action="store_true", help="Preview only")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        sys.exit(run(args))
    except (FileNotFoundError, ValueError, RuntimeError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
