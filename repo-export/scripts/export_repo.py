#!/usr/bin/env python3
"""
GitHub Repository Export Script
Exports repository contents to a single Markdown file using repomix.
"""

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import tempfile


def parse_repo_url(url: str) -> str:
    """Normalize a GitHub URL / short form into a canonical https URL."""
    stripped = url.rstrip('/')
    if stripped.startswith('https://github.com/'):
        parts = stripped.replace('https://github.com/', '').split('/')
    elif stripped.startswith('git@github.com:'):
        parts = stripped.replace('git@github.com:', '').replace('.git', '').split('/')
    else:
        # Assume owner/repo format
        parts = stripped.split('/')

    if len(parts) >= 2 and parts[0] and parts[1]:
        owner = parts[0]
        repo = parts[1].replace('.git', '')
        return f"https://github.com/{owner}/{repo}"
    raise ValueError(f"Invalid repository URL: {url}")


def resolve_repomix_cmd() -> list[str]:
    """Resolve the command used to invoke repomix.

    Priority: REPOMIX_CMD env var > PATH `repomix` binary > `npx --yes repomix`.
    """
    env_cmd = os.environ.get('REPOMIX_CMD')
    if env_cmd:
        return shlex.split(env_cmd)
    if shutil.which('repomix'):
        return ['repomix']
    return ['npx', '--yes', 'repomix']


def parse_total_tokens(stdout: str) -> int | None:
    """Extract the token count from repomix's 'Total Tokens:' summary line."""
    total_tokens_line = None
    for line in stdout.splitlines():
        if 'Total Tokens:' in line:
            total_tokens_line = line

    if total_tokens_line is None:
        return None

    after_label = total_tokens_line.split('Total Tokens:', 1)[1]
    digits = ''.join(ch for ch in after_label if ch.isdigit())
    if not digits:
        return None
    return int(digits)


def build_repomix_args(
    remote_url: str,
    output: str,
    branch: str | None,
    path: str | None,
    compress: bool,
) -> list[str]:
    """Build repomix CLI args for a single export run."""
    args = ['--remote', remote_url, '--style', 'markdown', '-o', output]
    if branch:
        args.extend(['--remote-branch', branch])
    if path:
        clean_path = path.rstrip('/')
        # `**/` prefix on the second pattern avoids repomix/fast-glob's
        # static-prefix scandir optimization crashing with ENOTDIR when
        # clean_path is a single file rather than a directory (live smoke
        # verified: `README,README/**` crashes on octocat/Hello-World's
        # single-file README; `README,**/README/**` does not, and both
        # single-file and directory cases match correctly).
        args.extend(['--include', f"{clean_path},**/{clean_path}/**"])
    if compress:
        args.append('--compress')
    return args


def run_repomix(repomix_cmd: list[str], args: list[str]) -> subprocess.CompletedProcess:
    """Run repomix, transcribing its stdout/stderr verbatim to ours."""
    result = subprocess.run(repomix_cmd + args, capture_output=True, text=True)
    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    return result


def export_repo(
    url: str,
    output: str,
    branch: str | None = None,
    path: str | None = None,
    compress: bool = False,
) -> None:
    """Export repository to a markdown file via repomix."""
    remote_url = parse_repo_url(url)
    repomix_cmd = resolve_repomix_cmd()

    if compress:
        baseline_tokens: int | None = None
        tmp_file = tempfile.NamedTemporaryFile(suffix='.md', delete=False)
        tmp_path = tmp_file.name
        tmp_file.close()

        try:
            baseline_args = build_repomix_args(
                remote_url, tmp_path, branch, path, compress=False
            )
            baseline_result = run_repomix(repomix_cmd, baseline_args)
            if baseline_result.returncode == 0:
                baseline_tokens = parse_total_tokens(baseline_result.stdout)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

        print(f"TOKENS_RAW={baseline_tokens if baseline_tokens is not None else 'unknown'}")

        compressed_args = build_repomix_args(remote_url, output, branch, path, compress=True)
        result = run_repomix(repomix_cmd, compressed_args)
        if result.returncode != 0:
            raise RuntimeError(f"repomix failed with exit code {result.returncode}")

        tokens = parse_total_tokens(result.stdout)
        print(f"TOKENS={tokens if tokens is not None else 'unknown'}")
        return

    args = build_repomix_args(remote_url, output, branch, path, compress=False)
    result = run_repomix(repomix_cmd, args)
    if result.returncode != 0:
        raise RuntimeError(f"repomix failed with exit code {result.returncode}")

    tokens = parse_total_tokens(result.stdout)
    print(f"TOKENS={tokens if tokens is not None else 'unknown'}")


def main():
    parser = argparse.ArgumentParser(description='Export GitHub repository to Markdown via repomix')
    parser.add_argument('url', help='GitHub repository URL or owner/repo')
    parser.add_argument('-o', '--output', default='repo-export.md', help='Output file path')
    parser.add_argument('-b', '--branch', help='Branch name (default: repository default branch)')
    parser.add_argument('-p', '--path', help='Only export files under this path')
    parser.add_argument('--compress', action='store_true', help='Enable repomix code compression')

    args = parser.parse_args()

    try:
        export_repo(args.url, args.output, args.branch, args.path, args.compress)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
