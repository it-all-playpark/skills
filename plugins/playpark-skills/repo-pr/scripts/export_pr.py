#!/usr/bin/env python3
"""
GitHub PR Export Script
Exports Pull Request information to a Markdown file using gh CLI.
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


def get_pull_requests(owner: str, repo: str, state: str, limit: int) -> list[dict]:
    """Get pull requests using gh CLI."""
    # Build gh command
    cmd = [
        'gh', 'pr', 'list',
        '--repo', f'{owner}/{repo}',
        '--limit', str(limit),
        '--json', 'number,title,state,author,createdAt,mergedAt,closedAt,labels,body,url'
    ]

    # Add state filter
    if state == 'all':
        cmd.extend(['--state', 'all'])
    elif state == 'merged':
        cmd.extend(['--state', 'merged'])
    elif state == 'closed':
        cmd.extend(['--state', 'closed'])
    else:
        cmd.extend(['--state', 'open'])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get PRs: {result.stderr}")

    return json.loads(result.stdout)


def format_date(iso_date: str | None) -> str:
    """Format ISO date to readable format."""
    if not iso_date:
        return '-'
    try:
        dt = datetime.fromisoformat(iso_date.replace('Z', '+00:00'))
        return dt.strftime('%Y-%m-%d')
    except (ValueError, AttributeError):
        return iso_date


def export_prs(url: str, output: str, state: str = 'all', limit: int = 50):
    """Export PRs to markdown file."""
    owner, repo = parse_repo_url(url)
    print(f"📋 Exporting PRs from {owner}/{repo}...")
    print(f"   State: {state}, Limit: {limit}")

    # Get PRs
    prs = get_pull_requests(owner, repo, state, limit)
    print(f"   Found {len(prs)} pull requests")

    # Build markdown
    lines = [
        f"# Pull Requests: {repo}\n",
        f"Source: <https://github.com/{owner}/{repo}>",
        f"Exported: {datetime.now().strftime('%Y-%m-%d')}",
        f"Total PRs: {len(prs)}",
        f"Filter: {state}\n",
        "---\n"
    ]

    for pr in prs:
        number = pr.get('number', '?')
        title = pr.get('title', 'Untitled')
        pr_state = pr.get('state', 'unknown')
        author = pr.get('author', {}).get('login', 'unknown')
        created = format_date(pr.get('createdAt'))
        merged = format_date(pr.get('mergedAt'))
        closed = format_date(pr.get('closedAt'))
        labels = [l.get('name', '') for l in pr.get('labels', [])]
        body = pr.get('body', '') or ''
        pr_url = pr.get('url', '')

        lines.append(f"## #{number}: {title}\n")
        lines.append(f"- **State**: {pr_state}")
        lines.append(f"- **Author**: {author}")
        lines.append(f"- **Created**: {created}")

        if merged != '-':
            lines.append(f"- **Merged**: {merged}")
        elif closed != '-':
            lines.append(f"- **Closed**: {closed}")

        if labels:
            lines.append(f"- **Labels**: {', '.join(labels)}")

        if pr_url:
            lines.append(f"- **URL**: {pr_url}")

        if body.strip():
            lines.append("\n### Description\n")
            # Truncate very long descriptions
            if len(body) > 2000:
                body = body[:2000] + "\n\n... (truncated)"
            lines.append(body)

        lines.append("\n---\n")

    # Write output
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text('\n'.join(lines), encoding='utf-8')
    print(f"\n✅ Exported to {output_path}")
    print(f"   Total PRs: {len(prs)}")


def main():
    parser = argparse.ArgumentParser(description='Export GitHub PRs to Markdown')
    parser.add_argument('url', help='GitHub repository URL or owner/repo')
    parser.add_argument('-o', '--output', default='pr-summary.md', help='Output file path')
    parser.add_argument('--state', choices=['open', 'closed', 'merged', 'all'],
                        default='all', help='PR state filter')
    parser.add_argument('--limit', type=int, default=50, help='Maximum PRs to export')

    args = parser.parse_args()

    try:
        export_prs(args.url, args.output, args.state, args.limit)
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
