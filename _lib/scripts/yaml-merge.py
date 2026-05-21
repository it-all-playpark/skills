#!/usr/bin/env python3
"""yaml-merge.py — internal YAML merge helper for build-skill-overlay.sh.

Merges two YAML frontmatter dicts (portable + overlay) with overlay-wins semantics.
Emits a unified YAML document to stdout.

Usage:
  python3 yaml-merge.py <portable.yaml> <overlay.yaml>

Exit codes:
  0  success — merged YAML written to stdout
  1  usage error (wrong number of args)
  2  YAML parse error in either file

stdout: merged YAML (key: value pairs, sorted=False to preserve insertion order)
stderr: warnings and error messages
"""

import sys
import os

try:
    import yaml
except ImportError:
    print("error: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)


def load_yaml(path: str) -> dict:
    """Load YAML from file; exit 2 on parse error."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as exc:
        print(f"error: failed to parse YAML in '{path}': {exc}", file=sys.stderr)
        sys.exit(2)
    except OSError as exc:
        print(f"error: cannot read '{path}': {exc}", file=sys.stderr)
        sys.exit(2)

    if data is None:
        return {}
    if not isinstance(data, dict):
        print(
            f"error: expected YAML mapping in '{path}', got {type(data).__name__}",
            file=sys.stderr,
        )
        sys.exit(2)
    return data


def merge(portable: dict, overlay: dict) -> dict:
    """Merge overlay into portable with overlay-wins semantics.

    Keys present in both → overlay wins (warn to stderr).
    Keys only in overlay → added to result.
    Keys only in portable → kept as-is.
    """
    result = dict(portable)
    for key, val in overlay.items():
        if key in portable:
            print(
                f"[yaml-merge] warning: overlay field '{key}' overrides portable value",
                file=sys.stderr,
            )
        result[key] = val
    return result


def _str_representer(dumper, data):
    """Represent multi-line strings as block scalar (|) to preserve readability.

    Single-line strings use the default style; strings containing newlines are
    emitted as literal block scalars so that `description: |` style is preserved
    in the merged frontmatter (matches the original portable SKILL.md style).
    """
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: yaml-merge.py <portable.yaml> <overlay.yaml>", file=sys.stderr)
        sys.exit(1)

    portable_path = sys.argv[1]
    overlay_path = sys.argv[2]

    portable = load_yaml(portable_path)
    overlay = load_yaml(overlay_path)

    merged = merge(portable, overlay)

    # Register block-style representer for multi-line strings before dumping.
    yaml.add_representer(str, _str_representer)

    # Dump merged YAML preserving insertion order, block style.
    print(
        yaml.dump(
            merged,
            default_flow_style=False,
            allow_unicode=True,
            sort_keys=False,
            width=1000,
        ),
        end="",
    )


if __name__ == "__main__":
    main()
