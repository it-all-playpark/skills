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
  'setup-base': RO,
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
  // write/Skill tier
  'worktree': RW,
  'worktree-deps': RW,
  'isolation-cleanup': RW,
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

// ============================================================
// dev-flow.js scenarios: 各 label へ到達させる最小の override
// ============================================================

const UI_FILE = 'src/components/Foo.tsx';
const VALID_UI_CFG = { install_command: 'npm ci', dev_command: 'npm run dev -- --port {port}', base_port: 4100, ready_path: '/', env_files: [] };
const UI_OVERRIDES = {
  'danger-grep': { risk: { ok: true, hits: [] }, files: [UI_FILE], struct: null, diffhash: { hash: 'AAA', empty: false } },
  'changed-files': { files: [UI_FILE] },
  'ui-verify-config': { found: true, config: VALID_UI_CFG },
  'ui-verify-config-final': { found: true, config: VALID_UI_CFG },
  'ui-verify-server': { ok: true, phase: 'ready', port: 4100, pid: 1 },
  'ui-verify-server-final': { ok: true, phase: 'ready', port: 4100, pid: 1 },
  'ui-verify': { ok: true, mode: 'smoke', checks: [], console_errors: [], screenshots: [], summary: 'ok' },
  'ui-verify-final': { ok: true, mode: 'smoke', checks: [], console_errors: [], screenshots: [], summary: 'ok' },
  'ui-verify-teardown': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
  'ui-verify-teardown-final': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
};

const DEV_FLOW_SCENARIOS = {
  baseline: {},
  // diff-gate が空 → diff-gate-retry
  'diff-gate-retry': {
    overrides: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H2', empty: false } },
  },
  // eval hash と PR hash の不一致 → tree-diff-numstat / head-tree-oid（Merge tier は eval と一致で再収束）
  'hash-mismatch': {
    overrides: {
      'diff-hash-pr': { hash: 'BBB', empty: false },
      'tree-diff-numstat': { ok: true, files: ['docs/a.md (+0/-500)'] },
      'head-tree-oid': { ok: true, tree: 'AAA' },
    },
  },
  // Merge tier で diff-hash-merge が secfloor と不一致 → danger-grep-final / changed-files 再実行
  'merge-rescan': { overrides: { 'diff-hash-merge': { hash: 'CCC', empty: false } } },
  // pr-iterate が fix を適用 → Final reconcile 経路（reconcile-sync / test#final / *-final）+ UI 経路
  'final-reconcile-ui': {
    overrides: {
      ...UI_OVERRIDES,
      'reconcile-sync': { ok: true, head: 'deadbeef' },
      'changed-files-final': { files: [UI_FILE] },
      'ci-final': { ok: true, headRefOid: 'a'.repeat(40), statusCheckRollup: [] },
    },
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  },
  // test#final が null（unavailable）→ reconcile-sync の head sha に pin した CI 委譲 ci-final（issue #599）
  'final-ci': {
    overrides: {
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'test#final': null,
      'ci-final': { ok: true, headRefOid: 'a'.repeat(40), statusCheckRollup: [] },
    },
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  },
  // evaluator が test 実証 AC を返す → redgreen:AC-1
  redgreen: {
    overrides: {
      'eval#1': {
        verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'test', evidence: 'ok', test_files: ['t.test.mjs'], impl_files: ['src/x.ts'] },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      },
      'redgreen:AC-1': { verdict: null, ok: true },
    },
  },
  // implementer が CI で検証可能な環境事象を concern に返す → ENV item → ci-checks
  'ci-checks': {
    overrides: {
      'impl:serial:t1': {
        status: 'DONE', task_id: 't1', files: ['src/x.ts'], summary: 's',
        concerns: ['sandbox 内で next build が TurbopackInternalError で失敗した'],
      },
      'ci-checks': { ok: true, checks: [{ name: 'build', bucket: 'pass' }] },
    },
  },
  // empty-diff で fail-fast → writeFailureTelemetry（journal-log-failure）
  'empty-diff': {
    overrides: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H', empty: true }, 'issue-labels': null },
    expectError: true,
  },
  // Plan で throw → top-level abort handoff（journal-log-abort）
  abort: { overrides: { 'plan#standard': () => { throw new Error('injected'); } }, expectError: true },
};

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
