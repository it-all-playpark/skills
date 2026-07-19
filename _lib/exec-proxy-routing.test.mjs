// Guard test: exec-proxy label → agentType routing (issue #323, task F2/F4).
//
// Background:
//   dev-flow.js / pr-iterate.js の決定論 exec-proxy 呼び出しは capability 別に 3 agent へ
//   routing される (architecture_decisions 参照):
//     - dev-runner-haiku-ro: read-only 決定論 proxy (danger-grep / diff-hash /
//       changed-files / CI read 系など)
//     - dev-runner-haiku: write/Skill 系 proxy 専任 (worktree 作成 / test 実行 /
//       redgreen / journal / ui-verify-server / PR コメント投稿 (post-summary。issue #392 で
//       per-round post-review#i 投稿は終端 post-summary へ統合済み) など)
//     - dev-runner: 判断寄り (fix / analyze)
//
//   .claude/workflows/*.js はランタイム注入 global を使うため ESM import できない。
//   よって _lib/dev-runner-model.test.mjs と同じ戦略 (source-as-string regex) で検証する。
//   agent() の呼び出しは `{ agentType: '...', schema: ..., label: '...', phase: '...' }`
//   という object literal が 1 行に収まる形で書かれているため、label を含む行を特定し、
//   その行内の agentType 文字列を検証する ("label を含む行の window に agentType 文字列が
//   あるか" 方式)。
//
//   'dev-runner-haiku' への誤マッチ回避: 'dev-runner-haiku-ro' は文字列として
//   'dev-runner-haiku' を prefix に含むため、`dev-runner-haiku` 単体を期待するアサーションは
//   閉じクォート直後を確認する (`agentType:\s*'dev-runner-haiku'` は末尾の `'` を要求するため
//   `'dev-runner-haiku-ro'` にはマッチしない)。
//
// Run: npx vitest run _lib/exec-proxy-routing.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const prIteratePath = join(repoRoot, '.claude', 'workflows', 'pr-iterate.js');

const devFlowSrc = readFileSync(devFlowPath, 'utf8');
const prIterateSrc = readFileSync(prIteratePath, 'utf8');

/**
 * Find the line in `source` whose `label:` value matches `labelLiteral` exactly
 * (i.e. `label: '<labelLiteral>'` with the closing quote immediately after, so that
 * e.g. 'diff-gate' does not accidentally match a line for 'diff-gate-retry').
 * Returns the matching line, or null if not found.
 */
function findLineByExactLabel(source, labelLiteral) {
  const escaped = labelLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`label:\\s*'${escaped}'`);
  const lines = source.split('\n');
  for (const line of lines) {
    if (re.test(line)) return line;
  }
  return null;
}

/**
 * Find the line in `source` whose `label:` value matches a template-literal pattern
 * containing `labelPrefix` (e.g. label: `test#${i}` — backtick-quoted, not a plain string).
 * Returns the matching line, or null if not found.
 */
function findLineByLabelPrefix(source, labelPrefix) {
  const escaped = labelPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`label:\\s*[\`']${escaped}`);
  const lines = source.split('\n');
  for (const line of lines) {
    if (re.test(line)) return line;
  }
  return null;
}

/**
 * Find ALL lines in `source` whose `label:` value matches a template-literal pattern
 * containing `labelPrefix` (same matching rule as findLineByLabelPrefix, but returns
 * every matching line instead of only the first). Used to verify that every call site
 * sharing a label prefix (e.g. `post-review#${i}` appearing at multiple branch points)
 * has been migrated consistently, and to detect missing/extra call sites via count.
 */
function findAllLinesByLabelPrefix(source, labelPrefix) {
  const escaped = labelPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`label:\\s*[\`']${escaped}`);
  return source.split('\n').filter((line) => re.test(line));
}

/**
 * Find the first line in `source` containing `substring` literally (plain string search,
 * not regex). Used for labels embedded in ternary/interpolated expressions (e.g.
 * `label: isRetry ? \`test#retry-${i}\` : \`test#${i}\`` in dev-flow.js) where the label
 * token is not immediately adjacent to `label:`.
 */
function findLineBySubstring(source, substring) {
  const lines = source.split('\n');
  for (const line of lines) {
    // Require `agentType:` on the same line so that helper/local-variable lines that
    // merely reference the label text (e.g. `const testLabel = isRetry ? ...`) are
    // skipped in favor of the actual agent() call options line.
    if (line.includes(substring) && line.includes('agentType:')) return line;
  }
  return null;
}

function assertAgentTypeOnLine(line, label, expectedAgentType, source) {
  assert.ok(line !== null, `Could not find agent() call with label '${label}' in ${source}`);
  assert.match(
    line,
    new RegExp(`agentType:\\s*'${expectedAgentType}'`),
    `label '${label}' should route to agentType:'${expectedAgentType}', but found: ${line}`,
  );
}

// ---- (a) dev-flow.js: read-only exec-proxy labels → dev-runner-haiku-ro ----

const READ_ONLY_LABELS = [
  'resolve-base',
  'diff-gate',
  'diff-gate-retry',
  'danger-grep',
  'danger-grep-final',
  'realized-diff',
  'structural-classify',
  'ui-verify-config',
  'ui-verify-config-final',
  'diff-hash-eval',
  'diff-hash-pr',
  'diff-hash-secfloor',
  'diff-hash-merge',
  'changed-files',
  'changed-files-final',
  'ci-checks',
];

for (const label of READ_ONLY_LABELS) {
  test(`[exec-proxy-routing] dev-flow.js label '${label}' routes to agentType:'dev-runner-haiku-ro'`, () => {
    const line = findLineByExactLabel(devFlowSrc, label);
    assertAgentTypeOnLine(line, label, 'dev-runner-haiku-ro', 'dev-flow.js');
  });
}

// clock# probe (issue #371 F2): duration telemetry の時刻取得 exec-proxy も read-only（Bash `date +%s` のみ）。
test("[exec-proxy-routing] dev-flow.js label 'clock#' routes to agentType:'dev-runner-haiku-ro'", () => {
  const line = findLineByLabelPrefix(devFlowSrc, 'clock#');
  assertAgentTypeOnLine(line, 'clock#', 'dev-runner-haiku-ro', 'dev-flow.js');
});

// ---- (b) dev-flow.js: write/Skill exec-proxy labels stay on dev-runner-haiku ----

test("[exec-proxy-routing] dev-flow.js label 'worktree' stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineByExactLabel(devFlowSrc, 'worktree');
  assertAgentTypeOnLine(line, 'worktree', 'dev-runner-haiku', 'dev-flow.js');
});

test("[exec-proxy-routing] dev-flow.js label 'worktree-deps' stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineByExactLabel(devFlowSrc, 'worktree-deps');
  assertAgentTypeOnLine(line, 'worktree-deps', 'dev-runner-haiku', 'dev-flow.js');
});

test("[exec-proxy-routing] dev-flow.js label 'test#' (Validate GREEN) stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineBySubstring(devFlowSrc, 'test#${i}');
  assertAgentTypeOnLine(line, 'test#${i}', 'dev-runner-haiku', 'dev-flow.js');
});

test("[exec-proxy-routing] dev-flow.js label 'test#final' stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineByExactLabel(devFlowSrc, 'test#final');
  assertAgentTypeOnLine(line, 'test#final', 'dev-runner-haiku', 'dev-flow.js');
});

test("[exec-proxy-routing] dev-flow.js label 'ui-verify-server' stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineByLabelPrefix(devFlowSrc, 'ui-verify-server');
  assertAgentTypeOnLine(line, 'ui-verify-server', 'dev-runner-haiku', 'dev-flow.js');
});

test("[exec-proxy-routing] dev-flow.js label 'ui-verify-teardown' stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineByLabelPrefix(devFlowSrc, 'ui-verify-teardown');
  assertAgentTypeOnLine(line, 'ui-verify-teardown', 'dev-runner-haiku', 'dev-flow.js');
});

test("[exec-proxy-routing] dev-flow.js label 'redgreen' stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineByLabelPrefix(devFlowSrc, 'redgreen');
  assertAgentTypeOnLine(line, 'redgreen', 'dev-runner-haiku', 'dev-flow.js');
});

test("[exec-proxy-routing] dev-flow.js label 'reconcile-sync' stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineByExactLabel(devFlowSrc, 'reconcile-sync');
  assertAgentTypeOnLine(line, 'reconcile-sync', 'dev-runner-haiku', 'dev-flow.js');
});

test("[exec-proxy-routing] dev-flow.js label 'journal-log' stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineByExactLabel(devFlowSrc, 'journal-log');
  assertAgentTypeOnLine(line, 'journal-log', 'dev-runner-haiku', 'dev-flow.js');
});

test("[exec-proxy-routing] dev-flow.js label 'journal-log-failure' stays on agentType:'dev-runner-haiku'", () => {
  const line = findLineByExactLabel(devFlowSrc, 'journal-log-failure');
  assertAgentTypeOnLine(line, 'journal-log-failure', 'dev-runner-haiku', 'dev-flow.js');
});

// Guard against the 'dev-runner-haiku' → 'dev-runner-haiku-ro' prefix-match footgun:
// every write/Skill-tier line asserted above must end the agentType string exactly at
// 'dev-runner-haiku' (immediately followed by a closing quote), not '-ro'.
test("[exec-proxy-routing] dev-flow.js write/Skill-tier labels do NOT match 'dev-runner-haiku-ro'", () => {
  const WRITE_TIER_LABELS = [
    { label: 'worktree', find: findLineByExactLabel },
    { label: 'worktree-deps', find: findLineByExactLabel },
    { label: 'test#${i}', find: findLineBySubstring },
    { label: 'test#final', find: findLineByExactLabel },
    { label: 'ui-verify-server', find: findLineByLabelPrefix },
    { label: 'ui-verify-teardown', find: findLineByLabelPrefix },
    { label: 'redgreen', find: findLineByLabelPrefix },
    { label: 'reconcile-sync', find: findLineByExactLabel },
    { label: 'journal-log', find: findLineByExactLabel },
    { label: 'journal-log-failure', find: findLineByExactLabel },
  ];
  for (const { label, find } of WRITE_TIER_LABELS) {
    const line = find(devFlowSrc, label);
    assert.ok(line !== null, `Could not find agent() call with label '${label}' in dev-flow.js`);
    assert.doesNotMatch(
      line,
      /agentType:\s*'dev-runner-haiku-ro'/,
      `label '${label}' must route to 'dev-runner-haiku' (write/Skill tier), not 'dev-runner-haiku-ro', but found: ${line}`,
    );
  }
});

// ---- (c) pr-iterate.js routing ----

test("[exec-proxy-routing] pr-iterate.js label 'pr-meta' routes to agentType:'dev-runner-haiku-ro'", () => {
  const line = findLineByExactLabel(prIterateSrc, 'pr-meta');
  assertAgentTypeOnLine(line, 'pr-meta', 'dev-runner-haiku-ro', 'pr-iterate.js');
});

test("[exec-proxy-routing] pr-iterate.js label 'ci-check#' routes to agentType:'dev-runner-haiku-ro'", () => {
  const line = findLineByLabelPrefix(prIterateSrc, 'ci-check#');
  assertAgentTypeOnLine(line, 'ci-check#', 'dev-runner-haiku-ro', 'pr-iterate.js');
});

test("[exec-proxy-routing] pr-iterate.js label 'journal-log' routes to agentType:'dev-runner-haiku'", () => {
  const line = findLineByExactLabel(prIterateSrc, 'journal-log');
  assertAgentTypeOnLine(line, 'journal-log', 'dev-runner-haiku', 'pr-iterate.js');
});

test("[exec-proxy-routing] pr-iterate.js label 'journal-log' does NOT match 'dev-runner-haiku-ro'", () => {
  const line = findLineByExactLabel(prIterateSrc, 'journal-log');
  assert.ok(line !== null, "Could not find agent() call with label 'journal-log' in pr-iterate.js");
  assert.doesNotMatch(
    line,
    /agentType:\s*'dev-runner-haiku-ro'/,
    `label 'journal-log' must route to 'dev-runner-haiku', not 'dev-runner-haiku-ro', but found: ${line}`,
  );
});

test("[exec-proxy-routing] pr-iterate.js label 'fix#' routes to agentType:'dev-runner'", () => {
  const line = findLineByLabelPrefix(prIterateSrc, 'fix#');
  assertAgentTypeOnLine(line, 'fix#', 'dev-runner', 'pr-iterate.js');
});

test("[exec-proxy-routing] pr-iterate.js label 'post-summary' routes to agentType:'dev-runner-haiku'", () => {
  const line = findLineByLabelPrefix(prIterateSrc, 'post-summary');
  assertAgentTypeOnLine(line, 'post-summary', 'dev-runner-haiku', 'pr-iterate.js');
});

// ---- (d) pr-iterate.js: no more mid-loop post-review#${i} call sites (issue #392) ----
//
// issue #392 AC-1/AC-3 consolidates PR posting to a single terminal `post-summary`
// call: the review⇄fix loop's per-round `post-review#${i}` postings (previously at
// 4-5 branch points: contract-error / approve / ci-gate / ci-failed / per-round) and
// `buildReviewCommentBody` were removed entirely. This guards against a regression
// reintroducing mid-loop PR posting.
test("[exec-proxy-routing] pr-iterate.js has zero label 'post-review#${i}' call sites (issue #392 AC-1: per-round posting removed)", () => {
  const lines = findAllLinesByLabelPrefix(prIterateSrc, 'post-review#');
  assert.equal(
    lines.length,
    0,
    `Expected zero 'post-review#\${i}' call sites in pr-iterate.js (issue #392 consolidates posting to terminal post-summary), found ${lines.length}:\n${lines.join('\n')}`,
  );
});

// ---- (e) dev-flow.js: post-summary migration (issue #372) ----

test("[exec-proxy-routing] dev-flow.js label 'post-summary' routes to agentType:'dev-runner-haiku'", () => {
  const line = findLineByExactLabel(devFlowSrc, 'post-summary');
  assertAgentTypeOnLine(line, 'post-summary', 'dev-runner-haiku', 'dev-flow.js');
});

// ---- (f) verbatim-transcription guard (AC-2, issue #372) ----
//
// All post-comment exec-proxy prompts must be verbatim transcriptions of a
// workflow-determined string (via bodySaveInstr), not agent-side summarization/judgement.
// pr-iterate.js has 2 bodySaveInstr( occurrences: 1 function definition + 1 call site
// (post-summary — the sole PR-posting call site after issue #392 consolidation).
test('[exec-proxy-routing] pr-iterate.js source contains at least 2 bodySaveInstr( occurrences (verbatim transcription guard)', () => {
  const count = (prIterateSrc.match(/bodySaveInstr\(/g) || []).length;
  assert.ok(
    count >= 2,
    `Expected pr-iterate.js to contain at least 2 'bodySaveInstr(' occurrences (verbatim-transcription guard for post-summary), found ${count}`,
  );
});

test("[exec-proxy-routing] dev-flow.js post-summary call site uses bodySaveInstr (verbatim transcription guard)", () => {
  assert.ok(
    devFlowSrc.includes('bodySaveInstr('),
    `Expected dev-flow.js to contain 'bodySaveInstr(' near its post-summary agent() call (verbatim-transcription guard)`,
  );
});
