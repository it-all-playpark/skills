#!/usr/bin/env python3
"""
GitHub Commit Export Script
Exports Commit history to a Markdown file using gh CLI.

Time basis notes:
- `--since` filtering is delegated entirely to the GitHub API `since=`
  parameter, which is committer-date based. No client-side date filtering
  is performed here.
- The `- **Date**:` column in the output is always commit.author.date
  (author date), independent of the `--since` time basis. A rebased/squashed
  commit can therefore show an author date outside the `--since` window
  while still being included, because it was in-window by committer date.
"""

import subprocess
import sys
import json
import argparse
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


def parse_repo_url(url: str) -> tuple[str, str]:
    """Extract owner/repo from GitHub URL."""
    url = url.rstrip('/')
    if url.startswith('https://github.com/'):
        parts = url.replace('https://github.com/', '').split('/')
    elif url.startswith('git@github.com:'):
        parts = url.replace('git@github.com:', '').replace('.git', '').split('/')
    else:
        # Assume owner/repo format
        parts = url.split('/')

    if len(parts) >= 2:
        return parts[0], parts[1].replace('.git', '')
    raise ValueError(f"Invalid repository URL: {url}")


def get_default_branch(owner: str, repo: str) -> str:
    """Get default branch name."""
    result = subprocess.run(
        ['gh', 'api', f'repos/{owner}/{repo}', '--jq', '.default_branch'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get default branch: {result.stderr}")
    return result.stdout.strip()


def resolve_since(value: str, now: datetime) -> str:
    """Resolve a --since value to an ISO 8601 UTC string (YYYY-MM-DDTHH:MM:SSZ).

    Accepts:
      - Relative days: "45d" -> now - 45 days
      - Date only: "2026-07-01" -> "2026-07-01T00:00:00Z"
      - ISO 8601 (with "T"): "2026-07-01T12:00:00Z" -> normalized to UTC

    `now` is injected by the caller (rather than computed here) so tests can
    pin it deterministically.
    """
    m = re.fullmatch(r'(\d+)d', value)
    if m:
        resolved = now - timedelta(days=int(m.group(1)))
        return resolved.strftime('%Y-%m-%dT%H:%M:%SZ')

    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return f"{value}T00:00:00Z"

    if 'T' in value:
        try:
            dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            raise ValueError(
                f"Invalid --since value: {value!r} (expected YYYY-MM-DD, ISO 8601, or Nd)"
            )
        dt = dt.astimezone(timezone.utc)
        return dt.strftime('%Y-%m-%dT%H:%M:%SZ')

    raise ValueError(
        f"Invalid --since value: {value!r} (expected YYYY-MM-DD, ISO 8601, or Nd)"
    )


def get_commits(owner: str, repo: str, branch: str, limit: int,
                since: str | None, author: str | None) -> list[dict]:
    """Get commits using gh API.

    `since` (if provided) must already be a resolved ISO 8601 UTC string
    (see resolve_since) and is passed through to the API `since=` param
    as-is (committer-date based, per GitHub API semantics).
    """
    # Build API URL with query params
    api_url = f'repos/{owner}/{repo}/commits?sha={branch}&per_page={limit}'

    if since:
        api_url += f'&since={since}'
    if author:
        api_url += f'&author={author}'

    result = subprocess.run(
        ['gh', 'api', api_url],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get commits: {result.stderr}")

    return json.loads(result.stdout)


def get_commit_files(owner: str, repo: str, sha: str) -> list[str]:
    """Fetch changed file names for a single commit via gh API.

    Deliberately avoids --jq: when a commit's `files` field is null (seen on
    some commit types), --jq '.files[].filename' exits non-zero and would
    hard-fail the gh invocation itself. Parsing the JSON in Python lets a
    null/missing `files` key degrade to an empty list instead.
    """
    result = subprocess.run(
        ['gh', 'api', f'repos/{owner}/{repo}/commits/{sha}'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get files for {sha[:7]}: {result.stderr}")
    data = json.loads(result.stdout)
    return [f['filename'] for f in (data.get('files') or []) if f.get('filename')]


def format_date(iso_date: str | None) -> str:
    """Format ISO date to readable format."""
    if not iso_date:
        return '-'
    try:
        dt = datetime.fromisoformat(iso_date.replace('Z', '+00:00'))
        return dt.strftime('%Y-%m-%d %H:%M')
    except (ValueError, AttributeError):
        return iso_date


def export_commits(url: str, output: str, branch: str | None = None,
                   limit: int = 100, since: str | None = None, author: str | None = None,
                   no_merges: bool = False, files: bool = False):
    """Export commits to markdown file."""
    owner, repo = parse_repo_url(url)
    print(f"📋 Exporting commits from {owner}/{repo}...")

    # Get default branch if not specified
    if not branch:
        branch = get_default_branch(owner, repo)
    print(f"   Branch: {branch}, Limit: {limit}")

    resolved_since = None
    if since:
        resolved_since = resolve_since(since, datetime.now(timezone.utc))
        print(f"   Since: {resolved_since}")
    if author:
        print(f"   Author: {author}")

    # Get commits
    commits = get_commits(owner, repo, branch, limit, resolved_since, author)

    if no_merges:
        commits = [c for c in commits if len(c.get('parents') or []) <= 1]

    print(f"   Found {len(commits)} commits")

    # Build markdown
    lines = [
        f"# Commits: {repo}\n",
        f"Source: <https://github.com/{owner}/{repo}>",
        f"Branch: {branch}",
        f"Exported: {datetime.now().strftime('%Y-%m-%d')}",
        f"Total Commits: {len(commits)}",
    ]

    if resolved_since:
        lines.append(f"Since: {resolved_since}")
    if no_merges:
        lines.append("Merges: excluded")
    if author:
        lines.append(f"Author filter: {author}")

    lines.append("\n---\n")

    for commit in commits:
        sha_full = commit.get('sha', '?')
        sha = sha_full[:7]
        commit_data = commit.get('commit', {})
        message = commit_data.get('message', 'No message')

        # Split message into title and body
        message_lines = message.split('\n', 1)
        title = message_lines[0]
        body = message_lines[1].strip() if len(message_lines) > 1 else ''

        author_data = commit_data.get('author', {})
        author_name = author_data.get('name', 'unknown')
        # Note: this is always author date, independent of the --since
        # (committer-date based) filtering window. See module docstring.
        date = format_date(author_data.get('date'))

        commit_url = commit.get('html_url', '')

        # Get stats if available
        stats = commit.get('stats', {})
        additions = stats.get('additions', 0)
        deletions = stats.get('deletions', 0)

        lines.append(f"## {title}\n")
        lines.append(f"- **SHA**: [{sha}]({commit_url})")
        lines.append(f"- **Author**: {author_name}")
        lines.append(f"- **Date**: {date}")

        if files:
            file_list = get_commit_files(owner, repo, sha_full)
            files_str = ', '.join(file_list) if file_list else '(none)'
            lines.append(f"- **Files**: {files_str}")

        if additions or deletions:
            lines.append(f"- **Changes**: +{additions} -{deletions}")

        if body:
            lines.append(f"\n{body}")

        lines.append("\n---\n")

    # Write output
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text('\n'.join(lines), encoding='utf-8')
    print(f"\n✅ Exported to {output_path}")
    print(f"   Total commits: {len(commits)}")


def main():
    parser = argparse.ArgumentParser(description='Export GitHub Commits to Markdown')
    parser.add_argument('url', help='GitHub repository URL or owner/repo')
    parser.add_argument('-o', '--output', default='commits.md', help='Output file path')
    parser.add_argument('--branch', help='Branch to export commits from')
    parser.add_argument('--limit', type=int, default=100, help='Maximum commits to export')
    parser.add_argument(
        '--since',
        help='Only commits after this date: YYYY-MM-DD, ISO 8601, or relative Nd '
             '(e.g. 45d). Committer-date based (GitHub API semantics)'
    )
    parser.add_argument('--author', help='Filter by author username')
    parser.add_argument(
        '--no-merges', action='store_true',
        help='Exclude merge commits (commits with more than one parent)'
    )
    parser.add_argument(
        '--files', action='store_true',
        help='Include changed file list per commit (one extra API call per commit)'
    )

    args = parser.parse_args()

    try:
        export_commits(
            args.url, args.output, args.branch, args.limit, args.since, args.author,
            no_merges=args.no_merges, files=args.files
        )
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
