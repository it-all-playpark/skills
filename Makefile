# Makefile — skills repo build automation
#
# Targets:
#   make skills        — build all skill overlay artifacts (idempotent full rebuild)
#   make setup         — configure git hooks + build skills (developer setup)
#   make install-link  — install per-skill symlinks in ~/.claude/skills
#   make uninstall-link — restore previous ~/.claude/skills state
#   make test          — run all bats tests
#   make help          — show this help

SHELL := bash
.SHELLFLAGS := -euo pipefail -c

REPO_ROOT := $(shell git rev-parse --show-toplevel 2>/dev/null || pwd)
LIB_SCRIPTS := $(REPO_ROOT)/_lib/scripts

.PHONY: skills setup install-link uninstall-link test help

# Build all skill overlay artifacts
skills:
	@bash $(LIB_SCRIPTS)/build-all-skills.sh --repo-root "$(REPO_ROOT)"

# Developer setup: configure core.hooksPath + build skills
# FORCE_HOOKS_PATH can be set to override conflicting core.hooksPath (use with caution)
setup:
	@result=$$(bash $(LIB_SCRIPTS)/check-hooks-path.sh --check --repo-root "$(REPO_ROOT)" 2>/dev/null); \
	  status=$$(printf '%s' "$$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null); \
	  if [ "$$status" = "conflict" ] && [ "$(FORCE_HOOKS_PATH)" != "1" ]; then \
	    current=$$(printf '%s' "$$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['current'])" 2>/dev/null); \
	    echo "error: core.hooksPath is already set to a different value:"; \
	    echo "  current: $$current"; \
	    echo "  target: .githooks"; \
	    echo "To override, run: make setup FORCE_HOOKS_PATH=1"; \
	    exit 1; \
	  fi; \
	  if [ "$(FORCE_HOOKS_PATH)" = "1" ]; then \
	    bash $(LIB_SCRIPTS)/check-hooks-path.sh --apply --force --repo-root "$(REPO_ROOT)"; \
	  else \
	    bash $(LIB_SCRIPTS)/check-hooks-path.sh --apply --repo-root "$(REPO_ROOT)"; \
	  fi
	@$(MAKE) skills

# Install per-skill symlinks in ~/.claude/skills
install-link: skills
	@bash $(LIB_SCRIPTS)/install-claude-skills-link.sh install \
	  --repo-root "$(REPO_ROOT)"

# Restore previous ~/.claude/skills state
uninstall-link:
	@bash $(LIB_SCRIPTS)/install-claude-skills-link.sh restore

# Run all bats tests
test:
	@bash $(REPO_ROOT)/tests/run-all-bats.sh

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  skills        Build all skill overlay artifacts (.build/skills/)"
	@echo "  setup         Configure git hooks (core.hooksPath) + build skills"
	@echo "  install-link  Install per-skill symlinks in ~/.claude/skills"
	@echo "  uninstall-link Restore previous ~/.claude/skills state"
	@echo "  test          Run all bats tests"
	@echo "  help          Show this help"
