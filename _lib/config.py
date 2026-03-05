"""Project config loader for Python-based skills.

Loads skill configuration from .claude/skill-config.json with legacy fallback.
"""

import json
import subprocess
from pathlib import Path


def _get_git_root() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def load_skill_config(skill_name: str) -> dict:
    """Load config for a skill from .claude/skill-config.json.

    Fallback order:
    1. .claude/skill-config.json の skill セクション
    2. .claude/{skill_name}.json (旧形式)
    3. seo-strategy の場合は .claude/seo-config.json も探す
    4. どれもなければ {}
    """
    root = _get_git_root()
    if not root:
        return {}

    root_path = Path(root)

    # 1. skill-config.json の skill セクション
    project_path = root_path / ".claude" / "skill-config.json"
    if project_path.exists():
        data = json.loads(project_path.read_text())
        section = data.get(skill_name)
        if section is not None:
            return section

    # 2. フォールバック: 旧形式
    legacy_path = root_path / ".claude" / f"{skill_name}.json"
    if legacy_path.exists():
        return json.loads(legacy_path.read_text())

    # 3. seo-strategy 特殊ケース
    if skill_name == "seo-strategy":
        seo_legacy = root_path / ".claude" / "seo-config.json"
        if seo_legacy.exists():
            return json.loads(seo_legacy.read_text())

    return {}


def merge_config(defaults: dict, skill_name: str) -> dict:
    """Deep merge: defaults → project config."""
    config = defaults.copy()
    skill_cfg = load_skill_config(skill_name)
    _deep_merge(config, skill_cfg)
    return config


def _deep_merge(base: dict, override: dict) -> None:
    """In-place deep merge of override into base."""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
