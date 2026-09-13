// Guard test: exec-proxy label → agentType routing (issue #323, task F2/F4。issue #636 で VM 化).
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
//   検証は dev-flow.js / pr-iterate.js を VM で実行し、agent() に実際に渡った
//   {label, agentType} を EXPECTED（label → agentType）と突合する。各 label に到達する
//   scenario を用意し、EXPECTED の全 label が少なくとも 1 scenario で観測されることも要求する
//   （到達しなくなった label は routing が検証されないまま残るため）。
//
// Run: npx vitest run _lib/exec-proxy-routing.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = join(here, '..', '.claude', 'workflows');
const devFlowSrc = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(workflowDir, 'pr-iterate.js'), 'utf8');

const RO = 'dev-flow:dev-runner-haiku-ro';
const RW = 'dev-flow:dev-runner-haiku';
const WO = 'dev-flow:dev-runner-haiku-wo';
const RUNNER = 'dev-flow:dev-runner';

// label が固定文字列のものは完全一致、`#${i}` / suffix 付きのものは prefix 一致（末尾 '*'）
const EXPECTED_DEV_FLOW = {
  // read-only tier
  'contract-probe#*': RO,
  'issue-meta': RO,
  'diff-gate': RO,
  'diff-gate-retry': RO,
  'danger-grep': RO,
  'danger-grep-final': RO,
  'ui-verify-config': RO,
  'ui-verify-config-final': RO,
  'diff-hash-eval': RO,
  'diff-hash-pr': RO,
  'diff-hash-merge': RO,
  'changed-files': RO,
  'changed-files-final': RO,
  'ci-checks': RO,
  'ci-final': RO,
  'gh-pr-view': RO,
  'tree-diff-numstat': RO,
  'head-tree-oid': RO,
  'issue-labels': RO,
  'cross-repo-artifacts': RO,
  'ci-check-lite': RO,
  // write/Skill tier
  'test#*': RW,
  'test#final': RW,
  'ui-verify-server*': RW,
  'ui-verify-teardown*': RW,
  'redgreen:*': RW,
  'reconcile-sync': RW,
  'journal-save': RW,
  'journal-log': RW,
  'journal-log-failure': RW,
  'journal-log-abort': RW,
  'post-summary': RW,
  // write-only probe
  'isolation-probe': WO,
  // 判断寄り
  'analyze#*': RUNNER,
  'pr#*': RUNNER,
};

const EXPECTED_PR_ITERATE = {
  'pr-meta': RO,
  'ci-check#*': RO,
  'isolation-cleanup': RW,
  'isolation-probe': WO,
  'commit-ensure#*': RW,
  'journal-save': RW,
  'journal-log': RW,
  'post-summary': RW,
  'fix#*': RUNNER,
};

function expectedFor(table, label) {
  if (Object.prototype.hasOwnProperty.call(table, label)) return { key: label, agentType: table[label] };
  // 固定 label を優先し、prefix は長い順に照合する（'test#final' が 'test#*' に吸われないように）
  const prefixes = Object.keys(table).filter((k) => k.endsWith('*')).sort((a, b) => b.length - a.length);
  for (const k of prefixes) {
    if (label.startsWith(k.slice(0, -1))) return { key: k, agentType: table[k] };
  }
  return null;
}

// dev-flow.js scenarios は test-helpers/dev-flow-scenarios.mjs に共有定義（subagent-invocations-routing と共用）

async function runDevFlowScenario(name) {
  const sc = DEV_FLOW_SCENARIOS[name];
  const { ctx, calls } = makeDevFlowSandbox({ overrides: sc.overrides ?? {}, workflow: sc.workflow });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, name);
  assert.equal(error !== null, sc.expectError === true, `scenario ${name}: throw の有無が想定と異なる: ${error?.message}`);
  return calls;
}

async function runPrIterate() {
  const { ctx, calls } = makePrIterateSandbox({
    overrides: {
      'review#1': { decision: 'request_changes', issues: [{ severity: 'major', topic: 't', file: 'a.js', line: 1, description: 'd', suggestion: null }], summary: 'ng' },
    },
  });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'pr-iterate');
  assert.equal(error, null, `pr-iterate run が throw した: ${error?.message}`);
  return calls;
}

function assertRouting(calls, table, where) {
  const observedKeys = new Set();
  for (const c of calls) {
    const exp = expectedFor(table, c.label);
    if (!exp) continue;
    observedKeys.add(exp.key);
    assert.equal(c.agentType, exp.agentType, `${where}: label '${c.label}' は agentType '${exp.agentType}' へ routing されるべきだが '${c.agentType}'`);
  }
  return observedKeys;
}

// ---- (a)(b) dev-flow.js: 全 scenario の観測 call が EXPECTED どおりに routing され、EXPECTED の全 label が到達する ----

test('[exec-proxy-routing] dev-flow.js: 全 scenario で観測される exec-proxy label が EXPECTED の agentType へ routing される', async () => {
  const observed = new Set();
  for (const name of Object.keys(DEV_FLOW_SCENARIOS)) {
    const calls = await runDevFlowScenario(name);
    for (const k of assertRouting(calls, EXPECTED_DEV_FLOW, `dev-flow.js[${name}]`)) observed.add(k);
  }
  const unreached = Object.keys(EXPECTED_DEV_FLOW).filter((k) => !observed.has(k));
  assert.deepEqual(unreached, [], `dev-flow.js: EXPECTED の label が全 scenario で観測されなかった（到達 scenario を追加するか、call site 消滅なら EXPECTED から外す）: ${unreached.join(', ')}`);
});

// Guard against the 'dev-runner-haiku' → 'dev-runner-haiku-ro' prefix-match footgun:
// write/Skill-tier の観測 agentType は '-ro' で終わらない（EXPECTED の値そのものを完全一致で突合している）。
test("[exec-proxy-routing] dev-flow.js write/Skill-tier labels do NOT route to 'dev-runner-haiku-ro'", async () => {
  const calls = await runDevFlowScenario('final-reconcile-ui');
  for (const c of calls) {
    const exp = expectedFor(EXPECTED_DEV_FLOW, c.label);
    if (exp?.agentType !== RW) continue;
    assert.ok(!c.agentType.endsWith('-ro'), `label '${c.label}' は write/Skill tier のはずだが '${c.agentType}'`);
  }
});

// ---- (c) pr-iterate.js routing ----

test('[exec-proxy-routing] pr-iterate.js: 観測される exec-proxy label が EXPECTED の agentType へ routing され、全 label が到達する', async () => {
  const calls = await runPrIterate();
  const observed = assertRouting(calls, EXPECTED_PR_ITERATE, 'pr-iterate.js');
  const unreached = Object.keys(EXPECTED_PR_ITERATE).filter((k) => !observed.has(k));
  assert.deepEqual(unreached, [], `pr-iterate.js: EXPECTED の label が観測されなかった: ${unreached.join(', ')}`);
});

// ---- (d) pr-iterate.js: no more mid-loop post-review#${i} call sites (issue #392) ----
//
// issue #392 AC-1/AC-3 consolidates PR posting to a single terminal `post-summary` call.
// review⇄fix loop を 1 往復させても per-round の post-review#i は発行されない。
test("[exec-proxy-routing] pr-iterate.js emits zero 'post-review#' calls across a review⇄fix round (issue #392 AC-1)", async () => {
  const calls = await runPrIterate();
  const postReview = calls.filter((c) => c.label.startsWith('post-review#'));
  assert.equal(postReview.length, 0, `post-review# は 0 件のはずだが ${postReview.length} 件: ${postReview.map((c) => c.label).join(', ')}`);
  assert.equal(calls.filter((c) => c.label === 'post-summary').length, 1, 'post-summary はちょうど 1 回');
});

// ---- (f) verbatim-transcription guard (AC-2, issue #372) ----
//
// post-comment exec-proxy の prompt は workflow 側で確定した本文を bodySaveInstr の delimiter で
// verbatim 転写させる（agent 側の要約・判断を挟まない）。両 workflow の post-summary prompt に
// delimiter ペアと `--body-file <BODY_FILE>` 指示があることで観測する。
test('[exec-proxy-routing] dev-flow.js / pr-iterate.js の post-summary prompt は bodySaveInstr の delimiter で本文を verbatim 転写させる', async () => {
  const df = (await runDevFlowScenario('baseline')).find((c) => c.label === 'post-summary');
  assert.ok(df, 'dev-flow.js: post-summary が無い');
  assert.ok(df.prompt.includes('<<<DEV_FLOW_BODY_BEGIN>>>') && df.prompt.includes('<<<DEV_FLOW_BODY_END>>>'), 'dev-flow.js: post-summary prompt に DEV_FLOW_BODY delimiter が無い');
  assert.ok(df.prompt.includes('--body-file <BODY_FILE>'), 'dev-flow.js: post-summary prompt が <BODY_FILE> 経由の投稿を指示していない');

  const pi = (await runPrIterate()).find((c) => c.label === 'post-summary');
  assert.ok(pi, 'pr-iterate.js: post-summary が無い');
  assert.ok(pi.prompt.includes('<<<PR_ITERATE_BODY_BEGIN>>>') && pi.prompt.includes('<<<PR_ITERATE_BODY_END>>>'), 'pr-iterate.js: post-summary prompt に PR_ITERATE_BODY delimiter が無い');
  assert.ok(pi.prompt.includes('--body-file <BODY_FILE>'), 'pr-iterate.js: post-summary prompt が <BODY_FILE> 経由の投稿を指示していない');
});
