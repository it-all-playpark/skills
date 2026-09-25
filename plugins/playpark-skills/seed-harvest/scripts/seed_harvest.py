#!/usr/bin/env python3
"""
Harvest blog topic candidates from merged PRs across GitHub owners into
seed/_topics/<topic-slug>.json, build per-topic slices from PR bodies/diffs,
and rank topics against external demand sensors.

Subcommands:
  harvest    merged PRs (+ feat/fix direct-push commits) since the last run -> seed/_topics/*.json
  slice      one topic's PR bodies / comments / diffs -> seed/_topics/slices/<slug>.md (< --max-kb)
  sense      match pending topics against Hatena / Zenn / Qiita / HN / Google Suggest
  mark-used  set a topic's status to used:<article-slug>

No repository is cloned: everything is read through `gh` (search / pr view / pr diff / api).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

DEFAULT_OWNERS = ["it-all-playpark", "playpark-llc"]
TOPICS_DIR = "_topics"
STATE_FILE = ".seed-harvest-state.json"
DEFAULT_LOOKBACK_DAYS = 30
SEARCH_LIMIT = 1000
HARD_LIMIT_BYTES = 102400  # pretool-context-guard の plain-file read 上限。slice はこれ未満に収める
DEFAULT_MAX_KB = 80
MAX_METRICS = 20

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
CONVENTIONAL_RE = re.compile(r"^(?P<type>[a-zA-Z]+)(?:\((?P<scope>[^)]*)\))?!?:\s*(?P<rest>.*)$")
# ブログ記事・SNS 告知の PR（docs(blog) / assets(blog) / fix(blog) / chore(sns) 等）は scope で判定する
EXCLUDED_SCOPES = {"blog", "sns"}
DEPS_SCOPES = {"deps", "deps-dev"}
DEPS_TITLE_RE = re.compile(r"^(?:update dependency|update module|bump\s)", re.IGNORECASE)
BOT_AUTHORS = {"renovate", "renovate[bot]", "app/renovate", "dependabot", "dependabot[bot]", "app/dependabot"}
PR_SQUASH_SUFFIX_RE = re.compile(r"\(#\d+\)\s*$")

TERM_RE = re.compile(r"(?<![A-Za-z0-9_./-])([A-Za-z][A-Za-z0-9]*(?:[.+][A-Za-z0-9]+)*)(?![A-Za-z0-9_-])")
# 主題語にしない語。conventional commit の語・英語の機能語・全 PR に出る一般語。
STOPWORDS = {
    w.lower()
    for w in (
        "feat fix chore docs refactor test tests style perf build ci revert assets wip merge "
        "add adds added update updates remove removes use uses support make move rename replace "
        "the a an and or of to in on for with from by is are be not no via when if as at into "
        "pr prs ci cd api apis json yaml toml md url urls cli ui ux id ids ok ng todo readme "
        "ac hold lgtm llm ai mcp sdk http https html css js ts tsx jsx sql db env pdf csv "
        "claude github git gh"
    ).split()
}

METRIC_PATTERNS = [
    re.compile(
        r"\d[\d,]*(?:\.\d+)?\s*(?:%|％|ms\b|秒|分|時間|倍|円|件|KB\b|MB\b|GB\b|tokens?\b|トークン|x\b)",
        re.IGNORECASE,
    ),
    re.compile(r"\$\s?\d"),
    re.compile(r"\d[^\n]{0,30}(?:→|->)[^\n]{0,30}\d"),
    re.compile(r"(?:before|after|一致率|レイテンシ|latency|コスト|cost)[^\n]*\d", re.IGNORECASE),
]
FAILURE_RE = re.compile(r"失敗|エラー|落ち|壊れ|不具合|バグ|止ま|abort|fail|error|bug|regression|broken", re.IGNORECASE)
CAUSE_RE = re.compile(r"原因|根本|root cause|caused by|because", re.IGNORECASE)
REMEDY_RE = re.compile(r"対策|修正|解決|直し|直す|回避|\bfix|resolve|mitigat", re.IGNORECASE)

LOCKFILE_RE = re.compile(
    r"(?:^|/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|flake\.lock|go\.sum)$"
)

FEEDS = {
    "hatena": "https://b.hatena.ne.jp/hotentry/it.rss",
    "zenn": "https://zenn.dev/feed",
    "qiita": "https://qiita.com/popular-items/feed",
}
HN_URL = "https://hn.algolia.com/api/v1/search?tags=story&query={q}&numericFilters=created_at_i>={since}"
SUGGEST_URL = "https://suggestqueries.google.com/complete/search?client=firefox&hl=ja&ie=utf-8&oe=utf-8&q={q}"
HN_LOOKBACK_DAYS = 30


# ---------------------------------------------------------------- utilities


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=False)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def to_zulu(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if slug:
        return slug
    return "topic-" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]


def split_title(title: str) -> tuple[str | None, str | None, str]:
    m = CONVENTIONAL_RE.match(title.strip())
    if not m:
        return None, None, title.strip()
    return m.group("type").lower(), (m.group("scope") or "").lower() or None, m.group("rest")


def extract_terms(title: str) -> list[str]:
    """Product-name-like tokens from a title (conventional prefix stripped), in order, deduped.

    A token qualifies when it contains an uppercase letter (Jev, TypeSafe, PostToolUse) and is
    not a stopword. Lowercase identifiers such as file names or skill names are not subject terms.
    """
    _, _, rest = split_title(title)
    seen: dict[str, str] = {}
    for m in TERM_RE.finditer(rest):
        token = m.group(1)
        if not any(c.isupper() for c in token):
            continue
        if token.lower() in STOPWORDS or len(token) < 2:
            continue
        seen.setdefault(token.lower(), token)
    return list(seen.values())


def exclusion_reason(title: str, author: str | None) -> str | None:
    stripped = title.strip()
    if stripped.startswith("Merge "):
        return "merge_commit"
    if (author or "").lower() in BOT_AUTHORS:
        return "dependency_update"
    ctype, scope, rest = split_title(stripped)
    if scope in EXCLUDED_SCOPES:
        return "blog_or_sns"
    if scope in DEPS_SCOPES or DEPS_TITLE_RE.match(rest) or DEPS_TITLE_RE.match(stripped):
        return "dependency_update"
    return None


def metric_lines(text: str) -> list[str]:
    out: list[str] = []
    for raw in text.splitlines():
        line = raw.strip().lstrip("-*|> ").strip()
        if not line:
            continue
        if any(p.search(line) for p in METRIC_PATTERNS):
            out.append(line[:200])
    return out


def candidate_reasons(item: dict[str, Any], known_terms: set[str]) -> list[str]:
    text = f"{item['title']}\n{item.get('body') or ''}"
    reasons: list[str] = []
    if metric_lines(item.get("body") or ""):
        reasons.append("metrics")
    if FAILURE_RE.search(text) and CAUSE_RE.search(text) and REMEDY_RE.search(text):
        reasons.append("failure_cause_fix")
    ctype, _, _ = split_title(item["title"])
    if ctype == "feat" and any(t.lower() not in known_terms for t in item["terms"]):
        reasons.append("new_tool")
    return reasons


def first_point(body: str) -> str:
    for raw in (body or "").splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "<!--", "```", "|")) or re.fullmatch(r"[-*_=]{3,}", line):
            continue
        return line.lstrip("-*> ").strip()[:200]
    return ""


# ---------------------------------------------------------------- harvest


def resolve_since(args_since: str | None, state: dict[str, Any]) -> str:
    if args_since:
        datetime.strptime(args_since, "%Y-%m-%d")  # ValueError -> usage error
        return args_since
    last = (state.get("lastRunAt") or "")[:10]
    if last:
        return last
    return (now_utc() - timedelta(days=DEFAULT_LOOKBACK_DAYS)).strftime("%Y-%m-%d")


def search_merged_prs(owners: list[str], since: str) -> list[dict[str, Any]]:
    cmd = ["gh", "search", "prs"]
    for owner in owners:
        cmd.extend(["--owner", owner])
    cmd.extend([
        "--merged-at", f">={since}",
        "--limit", str(SEARCH_LIMIT),
        "--json", "repository,number,title,body,url,closedAt,author",
    ])
    res = run(cmd)
    if res.returncode != 0:
        raise RuntimeError(f"gh search prs failed: {res.stderr.strip() or 'command_failed'}")
    items = []
    for pr in json.loads(res.stdout or "[]"):
        repo = (pr.get("repository") or {}).get("nameWithOwner") or ""
        items.append({
            "kind": "pr",
            "repo": repo,
            "number": pr.get("number"),
            "url": pr.get("url"),
            "title": pr.get("title") or "",
            "body": pr.get("body") or "",
            "mergedAt": pr.get("closedAt"),
            "author": (pr.get("author") or {}).get("login"),
        })
    return items


def search_direct_commits(owners: list[str], since: str) -> list[dict[str, Any]]:
    items = []
    for owner in owners:
        res = run([
            "gh", "api", "-X", "GET", "search/commits",
            "-f", f"q=org:{owner} committer-date:>={since}",
            "-f", "per_page=100",
        ])
        if res.returncode != 0:
            raise RuntimeError(f"gh api search/commits failed: {res.stderr.strip() or 'command_failed'}")
        for c in (json.loads(res.stdout or "{}").get("items") or []):
            message = ((c.get("commit") or {}).get("message") or "").strip()
            subject, _, body = message.partition("\n")
            ctype, _, _ = split_title(subject)
            if ctype not in {"feat", "fix"} or PR_SQUASH_SUFFIX_RE.search(subject):
                continue
            items.append({
                "kind": "commit",
                "repo": (c.get("repository") or {}).get("full_name") or "",
                "sha": c.get("sha"),
                "url": c.get("html_url"),
                "title": subject,
                "body": body.strip(),
                "mergedAt": ((c.get("commit") or {}).get("committer") or {}).get("date"),
                "author": (c.get("author") or {}).get("login"),
            })
    return items


def load_topics(topics_dir: Path) -> dict[str, dict[str, Any]]:
    topics: dict[str, dict[str, Any]] = {}
    if not topics_dir.is_dir():
        return topics
    for path in sorted(topics_dir.glob("*.json")):
        data = load_json(path)
        if isinstance(data, dict) and data.get("slug"):
            topics[data["slug"]] = data
    return topics


def known_urls(topics: dict[str, dict[str, Any]]) -> set[str]:
    urls: set[str] = set()
    for t in topics.values():
        for entry in (t.get("prs") or []) + (t.get("commits") or []):
            if entry.get("url"):
                urls.add(entry["url"])
    return urls


def choose_key(item: dict[str, Any], spread: dict[str, set[str]], count: dict[str, int],
               existing_terms: set[str]) -> str | None:
    if not item["terms"]:
        return None
    return min(
        item["terms"],
        key=lambda t: (
            t.lower() not in existing_terms,
            -len(spread[t.lower()]),
            -count[t.lower()],
            t.lower(),
        ),
    )


def group_candidates(candidates: list[dict[str, Any]], existing_terms: set[str]) -> dict[str, dict[str, Any]]:
    """Bundle candidates by subject term. The term shared by the most repos wins, so
    PRs about the same tool in different repos land in one topic."""
    spread: dict[str, set[str]] = {}
    count: dict[str, int] = {}
    for item in candidates:
        for t in item["terms"]:
            spread.setdefault(t.lower(), set()).add(item["repo"])
            count[t.lower()] = count.get(t.lower(), 0) + 1

    groups: dict[str, dict[str, Any]] = {}
    for item in candidates:
        key = choose_key(item, spread, count, existing_terms)
        if key is None:
            ident = item.get("number") or (item.get("sha") or "")[:7]
            gkey = f"{item['repo'].split('/')[-1]}-{ident}"
            label = item["title"]
        else:
            gkey = key.lower()
            label = key
        group = groups.setdefault(gkey, {"topic": label, "items": []})
        group["items"].append(item)
    return groups


def source_entry(item: dict[str, Any]) -> dict[str, Any]:
    entry = {
        "repo": item["repo"],
        "url": item["url"],
        "title": item["title"],
        "mergedAt": item.get("mergedAt"),
        "reasons": item["reasons"],
    }
    if item["kind"] == "pr":
        entry["number"] = item["number"]
    else:
        entry["sha"] = item["sha"]
    return entry


def merge_into_topic(topic: dict[str, Any], items: list[dict[str, Any]], stamp: str) -> None:
    for item in items:
        bucket = "prs" if item["kind"] == "pr" else "commits"
        topic.setdefault(bucket, []).append(source_entry(item))
        point = f"{item['repo']}: {item['title']}"
        detail = first_point(item.get("body") or "")
        topic.setdefault("points", []).append(f"{point} — {detail}" if detail else point)
        for line in metric_lines(item.get("body") or ""):
            if line not in topic.setdefault("metrics", []) and len(topic["metrics"]) < MAX_METRICS:
                topic["metrics"].append(line)
        for t in item["terms"]:
            if t not in topic.setdefault("terms", []):
                topic["terms"].append(t)
    topic["repos"] = sorted({e["repo"] for e in topic.get("prs", []) + topic.get("commits", [])})
    topic["updatedAt"] = stamp


def pending_topic_for(topics: dict[str, dict[str, Any]], topic_label: str) -> dict[str, Any] | None:
    for t in topics.values():
        if t.get("status") == "pending" and (t.get("topic") or "").lower() == topic_label.lower():
            return t
    return None


def new_slug(topics: dict[str, dict[str, Any]], label: str, stamp_date: str) -> str:
    base = slugify(label)
    if base not in topics:
        return base
    slug = f"{base}-{stamp_date.replace('-', '')}"
    n = 2
    while slug in topics:
        slug = f"{base}-{stamp_date.replace('-', '')}-{n}"
        n += 1
    return slug


def cmd_harvest(args: argparse.Namespace) -> int:
    seed = Path(args.seed)
    topics_dir = seed / TOPICS_DIR
    state_path = seed / STATE_FILE
    state = load_json(state_path) or {}
    try:
        since = resolve_since(args.since, state)
    except ValueError:
        print(f"invalid --since (expected YYYY-MM-DD): {args.since}", file=sys.stderr)
        return 2
    owners = args.owner or DEFAULT_OWNERS
    known_terms = {t.lower() for t in state.get("knownTerms") or []}

    try:
        items = search_merged_prs(owners, since)
        if not args.no_commits:
            pr_titles = {(i["repo"], i["title"].strip()) for i in items}
            items += [c for c in search_direct_commits(owners, since)
                      if (c["repo"], c["title"].strip()) not in pr_titles]
    except (RuntimeError, json.JSONDecodeError) as e:
        print(str(e), file=sys.stderr)
        return 1

    topics = load_topics(topics_dir)
    seen_urls = known_urls(topics)
    stats = {"fetched": len(items), "excluded": 0, "not_candidate": 0, "already_harvested": 0}
    candidates: list[dict[str, Any]] = []
    all_terms: set[str] = set()
    for item in items:
        if exclusion_reason(item["title"], item.get("author")):
            stats["excluded"] += 1
            continue
        item["terms"] = extract_terms(item["title"])
        all_terms.update(t.lower() for t in item["terms"])
        if item["url"] in seen_urls:
            stats["already_harvested"] += 1
            continue
        item["reasons"] = candidate_reasons(item, known_terms)
        if not item["reasons"]:
            stats["not_candidate"] += 1
            continue
        candidates.append(item)
        seen_urls.add(item["url"])

    existing_terms = {(t.get("topic") or "").lower() for t in topics.values() if t.get("status") == "pending"}
    groups = group_candidates(candidates, existing_terms)
    stamp = to_zulu(now_utc())
    written: list[str] = []
    for group in groups.values():
        topic = pending_topic_for(topics, group["topic"])
        if topic is None:
            slug = new_slug(topics, group["topic"], stamp[:10])
            topic = {
                "topic": group["topic"],
                "slug": slug,
                "status": "pending",
                "terms": [],
                "repos": [],
                "prs": [],
                "commits": [],
                "points": [],
                "metrics": [],
                "demand": None,
                "createdAt": stamp,
            }
            topics[slug] = topic
        merge_into_topic(topic, group["items"], stamp)
        written.append(topic["slug"])

    if not args.dry_run:
        for slug in written:
            save_json(topics_dir / f"{slug}.json", topics[slug])
        state["lastRunAt"] = stamp
        state["knownTerms"] = sorted(known_terms | all_terms)
        save_json(state_path, state)

    print(json.dumps({
        "since": since,
        "owners": owners,
        "dry_run": args.dry_run,
        "topics": sorted(set(written)),
        **stats,
        "candidates": len(candidates),
    }, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------- slice


def split_diff(diff: str) -> list[dict[str, str]]:
    chunks: list[dict[str, str]] = []
    for part in re.split(r"(?m)^(?=diff --git )", diff):
        if not part.strip():
            continue
        m = re.match(r"diff --git a/(\S+) b/(\S+)", part)
        chunks.append({"path": m.group(2) if m else "", "text": part})
    return chunks


def fetch_source(entry: dict[str, Any]) -> dict[str, Any]:
    if entry.get("number") is not None:
        view = run(["gh", "pr", "view", entry["url"], "--json", "title,body,comments"])
        if view.returncode != 0:
            raise RuntimeError(f"gh pr view failed for {entry['url']}: {view.stderr.strip()}")
        diff = run(["gh", "pr", "diff", entry["url"]])
        if diff.returncode != 0:
            raise RuntimeError(f"gh pr diff failed for {entry['url']}: {diff.stderr.strip()}")
        data = json.loads(view.stdout or "{}")
        comments = [
            f"{(c.get('author') or {}).get('login') or 'unknown'}: {c.get('body') or ''}"
            for c in data.get("comments") or []
        ]
        return {"heading": f"{entry['repo']}#{entry['number']}: {data.get('title') or entry['title']}",
                "url": entry["url"], "body": data.get("body") or "", "comments": comments,
                "diff": diff.stdout}
    res = run(["gh", "api", f"repos/{entry['repo']}/commits/{entry['sha']}",
               "-H", "Accept: application/vnd.github.diff"])
    if res.returncode != 0:
        raise RuntimeError(f"gh api commit diff failed for {entry['url']}: {res.stderr.strip()}")
    return {"heading": f"{entry['repo']}@{entry['sha'][:7]}: {entry['title']}", "url": entry["url"],
            "body": "", "comments": [], "diff": res.stdout}


def render_slice(topic: dict[str, Any], sources: list[dict[str, Any]]) -> str:
    lines = [f"# Topic: {topic['topic']}", "", f"Topic file: {TOPICS_DIR}/{topic['slug']}.json",
             f"Repos: {', '.join(topic.get('repos') or [])}", ""]
    for src in sources:
        lines += [f"## {src['heading']}", "", f"URL: <{src['url']}>", ""]
        if src["body"]["text"]:
            lines += ["### Body", "", src["body"]["text"], ""]
        if src["comments"]:
            lines += ["### Comments", ""]
            lines += [f"- {c['text']}" for c in src["comments"]]
            lines.append("")
        if src["diff"]:
            lines += ["### Diff", "", "```diff"]
            for chunk in src["diff"]:
                lines.append(chunk["text"].rstrip("\n"))
            lines += ["```", ""]
    return "\n".join(lines) + "\n"


def truncate_bytes(text: str, max_bytes: int) -> str:
    return text.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")


def shrink_step(sources: list[dict[str, Any]]) -> bool:
    """Reduce the largest shrinkable block once. Diffs go first, then comments, then bodies.
    Returns False when nothing is left to shrink."""
    for layer in ("diff", "comments", "body"):
        blocks = []
        for src in sources:
            if layer == "body":
                blocks.append(src["body"])
            else:
                blocks.extend(src[layer])
        blocks = [b for b in blocks if not b.get("final")]
        if not blocks:
            continue
        target = max(blocks, key=lambda b: len(b["text"].encode("utf-8")))
        size = len(target["text"].encode("utf-8"))
        label = target.get("path") or layer
        if size > 2048:
            target["text"] = truncate_bytes(target["text"], size // 2) + f"\n... ({label}: truncated from {size} bytes)"
        else:
            target["text"] = f"... ({label}: omitted, {size} bytes)"
            target["final"] = True
        return True
    return False


def cmd_slice(args: argparse.Namespace) -> int:
    if not SLUG_RE.match(args.topic):
        print(f"invalid topic slug: {args.topic}", file=sys.stderr)
        return 2
    if not 1 <= args.max_kb <= 99:
        print("--max-kb must be 1..99 (slice must stay under 100KB)", file=sys.stderr)
        return 2
    seed = Path(args.seed)
    topic = load_json(seed / TOPICS_DIR / f"{args.topic}.json")
    if not isinstance(topic, dict):
        print(f"topic not found: {args.topic}", file=sys.stderr)
        return 2
    entries = (topic.get("prs") or []) + (topic.get("commits") or [])
    if not entries:
        print(f"topic has no sources: {args.topic}", file=sys.stderr)
        return 2

    sources = []
    try:
        for entry in entries:
            raw = fetch_source(entry)
            diff_chunks = [
                {"path": c["path"], "text": f"(diff omitted: {c['path']} is a lockfile)", "final": True}
                if LOCKFILE_RE.search(c["path"]) else c
                for c in split_diff(raw["diff"])
            ]
            sources.append({
                "heading": raw["heading"],
                "url": raw["url"],
                "body": {"text": raw["body"].strip()},
                "comments": [{"text": c.strip()} for c in raw["comments"] if c.strip()],
                "diff": diff_chunks,
            })
    except (RuntimeError, json.JSONDecodeError) as e:
        print(str(e), file=sys.stderr)
        return 1

    limit = min(args.max_kb * 1024, HARD_LIMIT_BYTES - 1)
    truncated = False
    content = render_slice(topic, sources)
    while len(content.encode("utf-8")) >= limit:
        if not shrink_step(sources):
            print(f"slice still exceeds {limit} bytes after shrinking", file=sys.stderr)
            return 3
        truncated = True
        content = render_slice(topic, sources)

    out = Path(args.output) if args.output else seed / TOPICS_DIR / "slices" / f"{args.topic}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(content, encoding="utf-8")
    print(json.dumps({"slice_path": str(out), "topic": args.topic, "bytes": len(content.encode("utf-8")),
                      "sources": len(sources), "truncated": truncated}, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- sense


def fetch_url(url: str) -> tuple[str | None, str | None]:
    res = run(["curl", "-fsSL", "--max-time", "15", "-A", "seed-harvest", url])
    if res.returncode != 0:
        return None, f"curl exit {res.returncode}: {res.stderr.strip()[:200]}"
    return res.stdout, None


def feed_texts(xml_text: str) -> list[str]:
    root = ET.fromstring(xml_text)
    texts = []
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] not in {"item", "entry"}:
            continue
        parts = []
        for child in el:
            if child.tag.rsplit("}", 1)[-1] in {"title", "description", "summary", "content"}:
                parts.append("".join(child.itertext()))
        texts.append(" ".join(parts))
    return texts


def term_pattern(term: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![A-Za-z0-9]){re.escape(term)}(?![A-Za-z0-9])", re.IGNORECASE)


def unknown(error: str) -> dict[str, Any]:
    return {"status": "unknown", "error": error}


def sense_feed(feed_cache: dict[str, Any], name: str, term: str) -> dict[str, Any]:
    if name not in feed_cache:
        body, err = fetch_url(FEEDS[name])
        if err:
            feed_cache[name] = unknown(err)
        elif "<!DOCTYPE" in (body or "") or "<!ENTITY" in (body or ""):
            # entity 展開（billion laughs 等）を stdlib parser に渡さない
            feed_cache[name] = unknown("doctype not allowed")
        else:
            try:
                feed_cache[name] = feed_texts(body or "")
            except ET.ParseError as e:
                feed_cache[name] = unknown(f"parse error: {e}")
    cached = feed_cache[name]
    if isinstance(cached, dict):
        return cached
    pat = term_pattern(term)
    return {"status": "ok", "hits": sum(1 for t in cached if pat.search(t))}


def sense_hn(term: str) -> dict[str, Any]:
    since = int((now_utc() - timedelta(days=HN_LOOKBACK_DAYS)).timestamp())
    body, err = fetch_url(HN_URL.format(q=quote(term), since=since))
    if err:
        return unknown(err)
    try:
        hits = json.loads(body or "").get("nbHits")
    except (json.JSONDecodeError, AttributeError) as e:
        return unknown(f"parse error: {e}")
    if not isinstance(hits, int):
        return unknown("nbHits missing")
    return {"status": "ok", "hits": hits}


def sense_suggest(term: str) -> dict[str, Any]:
    body, err = fetch_url(SUGGEST_URL.format(q=quote(term)))
    if err:
        return unknown(err)
    try:
        data = json.loads(body or "")
        suggestions = data[1]
    except (json.JSONDecodeError, IndexError, KeyError, TypeError) as e:
        return unknown(f"parse error: {e}")
    if not isinstance(suggestions, list):
        return unknown("suggestions missing")
    pat = term_pattern(term)
    return {"status": "ok", "hits": sum(1 for s in suggestions if isinstance(s, str) and pat.search(s))}


def aggregate(sensors: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Sum hits over sensors that answered. A failed sensor is `unknown`, never 0:
    if no sensor answered, score is null rather than 0."""
    ok = [s["hits"] for s in sensors.values() if s["status"] == "ok"]
    if not ok:
        status = "unknown"
    elif len(ok) < len(sensors):
        status = "partial"
    else:
        status = "ok"
    return {"status": status, "score": sum(ok) if ok else None, "sensors": sensors}


def cmd_sense(args: argparse.Namespace) -> int:
    seed = Path(args.seed)
    topics_dir = seed / TOPICS_DIR
    topics = load_topics(topics_dir)
    if args.topic:
        targets = [topics[args.topic]] if args.topic in topics else []
    else:
        targets = [t for t in topics.values() if t.get("status") == "pending"]
    if not targets:
        print("no pending topics", file=sys.stderr)
        return 2

    feed_cache: dict[str, Any] = {}
    stamp = to_zulu(now_utc())
    ranked, unranked = [], []
    for topic in targets:
        term = topic["topic"]
        sensors = {name: sense_feed(feed_cache, name, term) for name in FEEDS}
        sensors["hn"] = sense_hn(term)
        sensors["google_suggest"] = sense_suggest(term)
        demand = aggregate(sensors)
        demand["checkedAt"] = stamp
        topic["demand"] = demand
        save_json(topics_dir / f"{topic['slug']}.json", topic)
        row = {"slug": topic["slug"], "topic": term, "status": demand["status"], "score": demand["score"]}
        (unranked if demand["score"] is None else ranked).append(row)

    ranked.sort(key=lambda r: (-r["score"], r["slug"]))
    print(json.dumps({"ranked": ranked, "unranked": unranked}, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------- mark-used


def cmd_mark_used(args: argparse.Namespace) -> int:
    if not SLUG_RE.match(args.topic) or not SLUG_RE.match(args.article):
        print("topic / article slug must match ^[a-z0-9][a-z0-9-]*$", file=sys.stderr)
        return 2
    path = Path(args.seed) / TOPICS_DIR / f"{args.topic}.json"
    topic = load_json(path)
    if not isinstance(topic, dict):
        print(f"topic not found: {args.topic}", file=sys.stderr)
        return 2
    topic["status"] = f"used:{args.article}"
    topic["updatedAt"] = to_zulu(now_utc())
    save_json(path, topic)
    print(json.dumps({"topic": args.topic, "status": topic["status"]}, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--seed", default="seed", help="Seed root directory (default: seed)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("harvest", parents=[common], help="Collect merged PRs since the last run into seed/_topics/*.json")
    p.add_argument("--since", help="YYYY-MM-DD (default: last run date, or 30 days ago on the first run)")
    p.add_argument("--owner", action="append", help=f"GitHub owner (repeatable, default: {' '.join(DEFAULT_OWNERS)})")
    p.add_argument("--no-commits", action="store_true", help="Skip feat/fix direct-push commits")
    p.add_argument("--dry-run", action="store_true", help="Print the result without writing files")
    p.set_defaults(func=cmd_harvest)

    p = sub.add_parser("slice", parents=[common], help="Build seed/_topics/slices/<topic>.md from PR bodies and diffs")
    p.add_argument("topic")
    p.add_argument("--max-kb", type=int, default=DEFAULT_MAX_KB, help="Size ceiling in KiB, 1..99 (default: 80)")
    p.add_argument("-o", "--output", help="Output path (default: seed/_topics/slices/<topic>.md)")
    p.set_defaults(func=cmd_slice)

    p = sub.add_parser("sense", parents=[common], help="Score pending topics against external demand sensors")
    p.add_argument("--topic", help="Only this topic slug")
    p.set_defaults(func=cmd_sense)

    p = sub.add_parser("mark-used", parents=[common], help="Mark a topic as used by an article")
    p.add_argument("topic")
    p.add_argument("article")
    p.set_defaults(func=cmd_mark_used)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
