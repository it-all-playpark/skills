#!/usr/bin/env python3
"""detect-stuck-findings.py - Detect stuck findings in evaluator-optimizer Plan-Review Loop.

Purpose
-------
In the dev-plan-impl -> dev-plan-review evaluator-optimizer loop, the same
"major"-or-above finding may persist across iterations, indicating that
revise attempts are not converging. This script mechanically determines
whether the loop is stuck by comparing the last two iterations' findings
using a (dimension, topic) fingerprint.

Input
-----
--history <path>        Path to plan-review-history.json (canonical schema).
                        Non-existent or empty -> escalate=false.
                        Corrupt JSON -> stderr warning, escalate=false, exit 0.
--min-severity <level>  Minimum severity to fingerprint. One of:
                        "critical", "major" (default), "minor".

History schema (canonical)
--------------------------
[
  {
    "iteration": 1,
    "score": 72,
    "verdict": "revise" | "pass" | "block",
    "findings": [
      {
        "severity": "critical" | "major" | "minor",
        "dimension": "...",
        "topic": "...",
        "description": "...",
        "suggestion": "..."
      }
    ]
  }
]

Legacy severity aliases are honored:
  - "blocking"     -> "major"
  - "non-blocking" -> "minor"

Output (stdout, JSON)
---------------------
{
  "escalate": true | false,
  "current_iteration": <int>,
  "stuck_findings": [ {"dimension": "...", "topic": "..."} ],
  "checked_severities": ["critical", "major"]
}

Exit code
---------
0 on normal completion (including "history missing" and "corrupt"). Non-zero
only on unexpected internal errors or invalid CLI arguments.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

SEVERITY_ORDER = {"critical": 3, "major": 2, "minor": 1}
SEVERITY_ALIAS = {
    "critical": "critical",
    "major": "major",
    "minor": "minor",
    # Legacy (pre-#46) aliases
    "blocking": "major",
    "non-blocking": "minor",
}


def normalize_severity(raw: str | None) -> str | None:
    if not raw:
        return None
    return SEVERITY_ALIAS.get(raw.lower())


def meets_severity(finding_severity: str | None, min_severity: str) -> bool:
    normalized = normalize_severity(finding_severity)
    if normalized is None:
        return False
    return SEVERITY_ORDER[normalized] >= SEVERITY_ORDER[min_severity]


def fingerprint_set(findings: Iterable[dict[str, Any]], min_severity: str) -> set[tuple[str, str]]:
    result: set[tuple[str, str]] = set()
    for f in findings or []:
        if not isinstance(f, dict):
            continue
        if not meets_severity(f.get("severity"), min_severity):
            continue
        dimension = f.get("dimension") or ""
        topic = f.get("topic") or ""
        if not dimension and not topic:
            continue
        result.add((dimension, topic))
    return result


def load_history(history_path: Path) -> list[dict[str, Any]]:
    """Load history file. Returns [] on missing or corrupt."""
    if not history_path.exists():
        return []
    try:
        with history_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(
            f"Warning: failed to parse history file ({history_path}): {e}",
            file=sys.stderr,
        )
        return []
    if not isinstance(data, list):
        print(
            f"Warning: history file is not a JSON array: {history_path}",
            file=sys.stderr,
        )
        return []
    return data


def detect_stuck(history: list[dict[str, Any]], min_severity: str) -> dict[str, Any]:
    checked = [s for s, v in SEVERITY_ORDER.items() if v >= SEVERITY_ORDER[min_severity]]
    checked.sort(key=lambda s: -SEVERITY_ORDER[s])

    current_iteration = len(history)
    if current_iteration < 2:
        return {
            "escalate": False,
            "current_iteration": current_iteration,
            "stuck_findings": [],
            "checked_severities": checked,
        }

    prev_entry = history[-2]
    curr_entry = history[-1]
    prev_findings = prev_entry.get("findings", []) if isinstance(prev_entry, dict) else []
    curr_findings = curr_entry.get("findings", []) if isinstance(curr_entry, dict) else []

    prev_keys = fingerprint_set(prev_findings, min_severity)
    curr_keys = fingerprint_set(curr_findings, min_severity)
    stuck = sorted(prev_keys & curr_keys)

    return {
        "escalate": bool(stuck),
        "current_iteration": current_iteration,
        "stuck_findings": [{"dimension": d, "topic": t} for (d, t) in stuck],
        "checked_severities": checked,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Detect stuck findings in evaluator-optimizer plan-review history"
    )
    parser.add_argument("--history", required=True, help="Path to plan-review-history.json")
    parser.add_argument(
        "--min-severity",
        default="major",
        choices=["critical", "major", "minor"],
        help="Minimum severity to fingerprint (default: major)",
    )
    args = parser.parse_args()

    history = load_history(Path(args.history))
    result = detect_stuck(history, args.min_severity)
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
