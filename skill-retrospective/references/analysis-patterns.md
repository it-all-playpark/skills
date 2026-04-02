# Analysis Patterns

Pattern detection algorithms for skill-retrospective.

## 5-Axis Analysis Framework

### Axis 1: Recurring Failures

**Detection**: Group journal entries by `(skill, error.category, error_message_normalized)`.
Pattern detected when group size >= 2.

**Normalization**: Strip file paths, line numbers, and dynamic values from error messages:
```
"src/auth.ts:42 - unused import" → "unused import"
"TS2305: Module 'foo' has no exported member 'bar'" → "TS2305: Module has no exported member"
```

**Scoring**:
- frequency = number of occurrences
- impact = severity from error category (high=3, medium=2, low=1)
- preventability = 3 if skill.md has no mention, 2 if partial, 1 if covered

**Output**: Pattern title, count, affected skill, normalized error

### Axis 2: Instruction Gaps

**Detection**: For each failure, check if the affected skill's SKILL.md contains:
1. The error category keyword
2. The prerequisite/step that would prevent the error
3. Any guard or check related to the error

**Criteria**: Gap detected when skill.md contains 0 mentions of the relevant error
prevention mechanism.

**Example**:
```
Failure: "npm: command 'npm install' failed - ENOENT node_modules"
Skill: git-prepare/SKILL.md
Search: "npm install" OR "node_modules" OR "dependency install"
Result: 0 matches → INSTRUCTION GAP
```

### Axis 3: Guard Deficiency

**Detection**: Failure could have been prevented by a pre-condition check that
the skill should perform but doesn't.

**Common missing guards**:

| Guard | Prevents | Check |
|-------|----------|-------|
| lockfile exists | wrong package manager | `test -f package-lock.json` |
| node_modules exists | missing deps | `test -d node_modules` |
| .env exists | missing env vars | `test -f .env` |
| port available | address in use | `lsof -i :PORT` |
| git clean | accidental overwrites | `git status --porcelain` |
| branch up-to-date | stale branch | `git fetch && git diff HEAD..origin` |

### Axis 4: Workflow Inefficiency

**Detection**: Entries where `recovery.turns_spent` > 2, indicating the skill
required significant manual intervention.

**Thresholds**:
- turns_spent > 2: Mild inefficiency (note for potential improvement)
- turns_spent > 5: Significant inefficiency (recommend skill modification)
- turns_spent > 10: Critical inefficiency (immediate attention needed)

**Grouping**: Aggregate by `(skill, error.phase)` to identify which phases
consistently require extra turns.

### Axis 5: Environment Issues

**Detection**: Filter entries where `error.category == "env"`.

These are grouped as environment issues and analyzed for:
1. Common setup steps that are missing
2. Project-specific requirements not documented
3. Cross-project patterns (e.g., always need npm install after worktree)

### Axis 6: Phase-Level Bottleneck Detection

**Detection**: For orchestrator skills (dev-kickoff, dev-flow), correlate child skill
journal entries by timestamp to reconstruct per-phase timing.

**Method**:
1. Group entries by `context.issue` and time window (within 1 hour)
2. Order child skill entries chronologically: dev-issue-analyze → dev-plan-impl → dev-implement → dev-validate → dev-evaluate
3. Calculate per-phase turn count from `duration_turns`
4. Flag phases that consistently exceed median + 1 stddev

**Thresholds**:
- Phase avg > 2x overall median: Bottleneck (investigate skill)
- Phase failure rate > 10%: Reliability concern

### Axis 7: Efficiency Trend Analysis

**Detection**: Track turn count trends over time for each skill.

**Method**:
1. Group entries by `(skill, week)` or `(skill, 10-entry rolling window)`
2. Calculate per-period average turn count
3. Detect regression: current period avg > previous period avg * 1.3
4. Detect improvement: current period avg < previous period avg * 0.7

**Output**: Trend direction (improving/stable/regressing) with magnitude.

### Axis 8: Journal Coverage Audit

**Detection**: Verify all workflow skills have journal logging instrumented.

**Method**:
1. List all skills in `$SKILLS_DIR` with SKILL.md
2. Filter to workflow/orchestration skills (has `allowed-tools` or calls other skills)
3. Check for `## Journal Logging` section in SKILL.md
4. Check for `journal.sh` references

**Output**: Coverage percentage and list of unlogged skills.
Should be run periodically (weekly recommended) to catch newly added skills.

## Scoring Formula

```
pattern_score = frequency * impact * preventability

Where:
  frequency     = count of occurrences (1-N)
  impact        = category severity (1-3)
  preventability = how fixable via skill.md (1-3)
```

**Priority thresholds**:
- score >= 9: Critical - immediate proposal
- score >= 4: Important - include in retrospective
- score < 4: Minor - mention but don't prioritize

## Proposal Generation Rules

1. **One proposal per pattern** - don't generate overlapping proposals
2. **Minimal diff** - propose smallest change that prevents the failure
3. **Respect existing structure** - add to existing sections when possible
4. **No behavioral changes** - only add guards, instructions, or documentation
5. **Concrete over abstract** - include exact commands, paths, and conditions
