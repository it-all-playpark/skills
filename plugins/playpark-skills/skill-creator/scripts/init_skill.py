#!/usr/bin/env python3
"""
init_skill.py - Initialize a new skill from repo template.

Reads skill-creator/assets/skill-template.md and creates a new skill directory
at the repository root with SKILL.md, scripts/, and references/ subdirectories.

Usage:
    init_skill.py <skill-name>
"""

import sys
from pathlib import Path


def title_case(name: str) -> str:
    return " ".join(w.capitalize() for w in name.split("-"))


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: init_skill.py <skill-name>", file=sys.stderr)
        return 1

    skill_name = sys.argv[1]
    if not skill_name.replace("-", "").isalnum() or skill_name != skill_name.lower():
        print(f"error: skill-name must be lowercase hyphen-case: {skill_name}", file=sys.stderr)
        return 1

    script_path = Path(__file__).resolve()
    repo_root = script_path.parent.parent.parent
    template_path = script_path.parent.parent / "assets" / "skill-template.md"
    skill_dir = repo_root / skill_name

    if not template_path.exists():
        print(f"error: template not found: {template_path}", file=sys.stderr)
        return 1
    if skill_dir.exists():
        print(f"error: skill directory already exists: {skill_dir}", file=sys.stderr)
        return 1

    template = template_path.read_text(encoding="utf-8")
    rendered = template.replace("{{skill_name}}", skill_name).replace(
        "{{skill_title}}", title_case(skill_name)
    )

    skill_dir.mkdir(parents=True)
    (skill_dir / "scripts").mkdir()
    (skill_dir / "references").mkdir()
    (skill_dir / "SKILL.md").write_text(rendered, encoding="utf-8")

    print(f"created: {skill_dir}")
    print("next:")
    print(f"  1. edit {skill_dir}/SKILL.md and replace {{{{...}}}} placeholders")
    print(f"  2. add scripts to {skill_dir}/scripts/")
    print(f"  3. run tests/subagent-dispatch-lint.sh if skill uses Task/Agent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
