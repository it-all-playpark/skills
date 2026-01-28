#!/usr/bin/env python3
"""
GitHub Commit Export Script
Exports Commit history to a Markdown file using gh CLI.
"""

import subprocess
import sys
import json
import argparse
from datetime import datetime
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


def get_commits(owner: str, repo: str, branch: str, limit: int,
                since: str | None, author: str | None) -> list[dict]:
    """Get commits using gh API."""
    # Build API URL with query params
    api_url = f'repos/{owner}/{repo}/commits?sha={branch}&per_page={limit}'

    if since:
        api_url += f'&since={since}T00:00:00Z'
    if author:
        api_url += f'&author={author}'

    result = subprocess.run(
        ['gh', 'api', api_url],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get commits: {result.stderr}")

    return json.loads(result.stdout)


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
                   limit: int = 100, since: str | None = None, author: str | None = None):
    """Export commits to markdown file."""
    owner, repo = parse_repo_url(url)
    print(f"📋 Exporting commits from {owner}/{repo}...")

    # Get default branch if not specified
    if not branch:
        branch = get_default_branch(owner, repo)
    print(f"   Branch: {branch}, Limit: {limit}")
    if since:
        print(f"   Since: {since}")
    if author:
        print(f"   Author: {author}")

    # Get commits
    commits = get_commits(owner, repo, branch, limit, since, author)
    print(f"   Found {len(commits)} commits")

    # Build markdown
    lines = [
        f"# Commits: {repo}\n",
        f"Source: <https://github.com/{owner}/{repo}>",
        f"Branch: {branch}",
        f"Exported: {datetime.now().strftime('%Y-%m-%d')}",
        f"Total Commits: {len(commits)}",
    ]

    if since:
        lines.append(f"Since: {since}")
    if author:
        lines.append(f"Author filter: {author}")

    lines.append("\n---\n")

    for commit in commits:
        sha = commit.get('sha', '?')[:7]
        commit_data = commit.get('commit', {})
        message = commit_data.get('message', 'No message')

        # Split message into title and body
        message_lines = message.split('\n', 1)
        title = message_lines[0]
        body = message_lines[1].strip() if len(message_lines) > 1 else ''

        author_data = commit_data.get('author', {})
        author_name = author_data.get('name', 'unknown')
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
    parser.add_argument('--since', help='Only commits after this date (YYYY-MM-DD)')
    parser.add_argument('--author', help='Filter by author username')

    args = parser.parse_args()

    try:
        export_commits(args.url, args.output, args.branch, args.limit, args.since, args.author)
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
