#!/usr/bin/env python3
"""
GitHub Repository Export Script
Exports repository contents to a single Markdown file using gh CLI.
"""

import subprocess
import sys
import json
import base64
import argparse
from pathlib import Path

# Binary file extensions to skip
BINARY_EXTENSIONS = {
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.bmp', '.tiff',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.pyc', '.pyo', '.class', '.o', '.obj',
    '.sqlite', '.db', '.lock',
}

# Files/dirs to skip
SKIP_PATTERNS = {
    'node_modules', '.git', '__pycache__', '.DS_Store',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.env', '.env.local', '.env.production',
}


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


def get_repo_tree(owner: str, repo: str, branch: str | None, path: str | None) -> list[dict]:
    """Get repository tree using gh API."""
    # Get default branch if not specified
    if not branch:
        result = subprocess.run(
            ['gh', 'api', f'repos/{owner}/{repo}', '--jq', '.default_branch'],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to get default branch: {result.stderr}")
        branch = result.stdout.strip()

    # Get tree
    result = subprocess.run(
        ['gh', 'api', f'repos/{owner}/{repo}/git/trees/{branch}?recursive=1'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get tree: {result.stderr}")

    tree_data = json.loads(result.stdout)
    files = []

    for item in tree_data.get('tree', []):
        if item['type'] != 'blob':
            continue

        file_path = item['path']

        # Filter by path prefix if specified
        if path and not file_path.startswith(path.rstrip('/') + '/') and file_path != path:
            continue

        # Skip patterns
        if any(skip in file_path.split('/') for skip in SKIP_PATTERNS):
            continue

        # Skip binary files
        ext = Path(file_path).suffix.lower()
        if ext in BINARY_EXTENSIONS:
            continue

        files.append({
            'path': file_path,
            'sha': item['sha'],
            'size': item.get('size', 0)
        })

    return sorted(files, key=lambda x: x['path'])


def get_file_content(owner: str, repo: str, sha: str) -> str | None:
    """Get file content by blob SHA."""
    result = subprocess.run(
        ['gh', 'api', f'repos/{owner}/{repo}/git/blobs/{sha}'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return None

    blob = json.loads(result.stdout)
    if blob.get('encoding') == 'base64':
        try:
            return base64.b64decode(blob['content']).decode('utf-8')
        except (UnicodeDecodeError, Exception):
            return None  # Binary content
    return blob.get('content')


def get_language_hint(file_path: str) -> str:
    """Get markdown code block language hint from file extension."""
    ext_map = {
        '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
        '.tsx': 'tsx', '.jsx': 'jsx', '.json': 'json', '.yaml': 'yaml',
        '.yml': 'yaml', '.md': 'markdown', '.html': 'html', '.css': 'css',
        '.scss': 'scss', '.less': 'less', '.sh': 'bash', '.bash': 'bash',
        '.zsh': 'zsh', '.fish': 'fish', '.sql': 'sql', '.go': 'go',
        '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
        '.rb': 'ruby', '.php': 'php', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
        '.hpp': 'cpp', '.cs': 'csharp', '.vue': 'vue', '.svelte': 'svelte',
        '.toml': 'toml', '.ini': 'ini', '.xml': 'xml', '.graphql': 'graphql',
        '.dockerfile': 'dockerfile', '.tf': 'terraform', '.hcl': 'hcl',
    }
    ext = Path(file_path).suffix.lower()
    name = Path(file_path).name.lower()

    if name == 'dockerfile':
        return 'dockerfile'
    if name == 'makefile':
        return 'makefile'

    return ext_map.get(ext, '')


def export_repo(url: str, output: str, branch: str | None = None, path: str | None = None):
    """Export repository to markdown file."""
    owner, repo = parse_repo_url(url)
    print(f"📦 Exporting {owner}/{repo}...")

    if branch:
        print(f"   Branch: {branch}")
    if path:
        print(f"   Path: {path}")

    # Get file tree
    files = get_repo_tree(owner, repo, branch, path)
    print(f"   Found {len(files)} text files")

    # Build markdown
    lines = [f"# {repo}\n"]
    if path:
        lines.append(f"Path: `{path}`\n")
    lines.append(f"Source: <{url}>\n")
    lines.append("---\n")

    for i, file_info in enumerate(files, 1):
        file_path = file_info['path']
        print(f"   [{i}/{len(files)}] {file_path}")

        content = get_file_content(owner, repo, file_info['sha'])
        if content is None:
            continue

        lang = get_language_hint(file_path)
        lines.append(f"\n## {file_path}\n")
        lines.append(f"```{lang}\n{content}\n```\n")

    # Write output
    output_path = Path(output)
    output_path.write_text('\n'.join(lines), encoding='utf-8')
    print(f"\n✅ Exported to {output_path}")
    print(f"   Total files: {len(files)}")


def main():
    parser = argparse.ArgumentParser(description='Export GitHub repository to Markdown')
    parser.add_argument('url', help='GitHub repository URL or owner/repo')
    parser.add_argument('-o', '--output', default='repo-export.md', help='Output file path')
    parser.add_argument('-b', '--branch', help='Branch name (default: repository default branch)')
    parser.add_argument('-p', '--path', help='Only export files under this path')

    args = parser.parse_args()

    try:
        export_repo(args.url, args.output, args.branch, args.path)
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
