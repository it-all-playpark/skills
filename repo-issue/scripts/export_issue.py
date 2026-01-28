#!/usr/bin/env python3
"""
GitHub Issue Export Script
Exports Issue information to a Markdown file using gh CLI.
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


def get_issues(owner: str, repo: str, state: str, limit: int, labels: str | None) -> list[dict]:
    """Get issues using gh CLI."""
    cmd = [
        'gh', 'issue', 'list',
        '--repo', f'{owner}/{repo}',
        '--limit', str(limit),
        '--json', 'number,title,state,author,createdAt,closedAt,labels,body,url,comments'
    ]

    # Add state filter
    if state == 'all':
        cmd.extend(['--state', 'all'])
    elif state == 'closed':
        cmd.extend(['--state', 'closed'])
    else:
        cmd.extend(['--state', 'open'])

    # Add label filter
    if labels:
        cmd.extend(['--label', labels])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get issues: {result.stderr}")

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


def export_issues(url: str, output: str, state: str = 'all', limit: int = 50, labels: str | None = None):
    """Export issues to markdown file."""
    owner, repo = parse_repo_url(url)
    print(f"📋 Exporting issues from {owner}/{repo}...")
    print(f"   State: {state}, Limit: {limit}")
    if labels:
        print(f"   Labels: {labels}")

    # Get issues
    issues = get_issues(owner, repo, state, limit, labels)
    print(f"   Found {len(issues)} issues")

    # Build markdown
    lines = [
        f"# Issues: {repo}\n",
        f"Source: <https://github.com/{owner}/{repo}>",
        f"Exported: {datetime.now().strftime('%Y-%m-%d')}",
        f"Total Issues: {len(issues)}",
        f"Filter: state={state}" + (f", labels={labels}" if labels else ""),
        "\n---\n"
    ]

    for issue in issues:
        number = issue.get('number', '?')
        title = issue.get('title', 'Untitled')
        issue_state = issue.get('state', 'unknown')
        author = issue.get('author', {}).get('login', 'unknown')
        created = format_date(issue.get('createdAt'))
        closed = format_date(issue.get('closedAt'))
        issue_labels = [l.get('name', '') for l in issue.get('labels', [])]
        body = issue.get('body', '') or ''
        issue_url = issue.get('url', '')
        comments = len(issue.get('comments', []))

        lines.append(f"## #{number}: {title}\n")
        lines.append(f"- **State**: {issue_state}")
        lines.append(f"- **Author**: {author}")
        lines.append(f"- **Created**: {created}")

        if closed != '-':
            lines.append(f"- **Closed**: {closed}")

        if issue_labels:
            lines.append(f"- **Labels**: {', '.join(issue_labels)}")

        if comments > 0:
            lines.append(f"- **Comments**: {comments}")

        if issue_url:
            lines.append(f"- **URL**: {issue_url}")

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
    print(f"   Total issues: {len(issues)}")


def main():
    parser = argparse.ArgumentParser(description='Export GitHub Issues to Markdown')
    parser.add_argument('url', help='GitHub repository URL or owner/repo')
    parser.add_argument('-o', '--output', default='issues.md', help='Output file path')
    parser.add_argument('--state', choices=['open', 'closed', 'all'],
                        default='all', help='Issue state filter')
    parser.add_argument('--limit', type=int, default=50, help='Maximum issues to export')
    parser.add_argument('--labels', help='Filter by labels (comma-separated)')

    args = parser.parse_args()

    try:
        export_issues(args.url, args.output, args.state, args.limit, args.labels)
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
