"""Project config loader for Python-based skills.

Loads skill configuration with global → project merge (legacy fallback supported).
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


def _load_global_skill_config(skill_name: str) -> dict:
    """Load skill section from global ~/.claude/skill-config.json."""
    global_path = Path.home() / ".claude" / "skill-config.json"
    if global_path.exists():
        try:
            data = json.loads(global_path.read_text())
            section = data.get(skill_name)
            if section is not None:
                return section
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def load_skill_config(skill_name: str) -> dict:
    """Load config for a skill: global → project merge.

    Merge order (later wins):
    1. ~/.claude/skill-config.json の skill セクション (グローバル)
    2. .claude/skill-config.json の skill セクション (プロジェクト)
    3. .claude/{skill_name}.json (旧形式フォールバック)
    4. seo-strategy の場合は .claude/seo-config.json も探す
    """
    # Layer 1: Global
    global_cfg = _load_global_skill_config(skill_name)

    # Layer 2: Project (+ legacy fallback)
    project_cfg: dict = {}
    root = _get_git_root()

    if root:
        root_path = Path(root)

        # 2a. skill-config.json の skill セクション
        project_path = root_path / ".claude" / "skill-config.json"
        if project_path.exists():
            try:
                data = json.loads(project_path.read_text())
                section = data.get(skill_name)
                if section is not None:
                    project_cfg = section
            except (json.JSONDecodeError, OSError):
                pass

        # 2b. フォールバック: 旧形式
        if not project_cfg:
            legacy_path = root_path / ".claude" / f"{skill_name}.json"
            if legacy_path.exists():
                try:
                    project_cfg = json.loads(legacy_path.read_text())
                except (json.JSONDecodeError, OSError):
                    pass

            # seo-strategy 特殊ケース
            if not project_cfg and skill_name == "seo-strategy":
                seo_legacy = root_path / ".claude" / "seo-config.json"
                if seo_legacy.exists():
                    try:
                        project_cfg = json.loads(seo_legacy.read_text())
                    except (json.JSONDecodeError, OSError):
                        pass

    # Merge: global + project (project wins)
    if not global_cfg:
        return project_cfg or {}
    if not project_cfg:
        return global_cfg
    result = global_cfg.copy()
    _deep_merge(result, project_cfg)
    return result


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
