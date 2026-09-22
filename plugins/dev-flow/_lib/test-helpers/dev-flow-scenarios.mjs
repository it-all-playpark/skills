/**
 * dev-flow-scenarios.mjs — dev-flow.js の各経路へ到達させる最小 override の共有定義
 *
 * exec-proxy-routing.test.mjs（label→agentType の網羅観測）と
 * subagent-invocations-routing.test.mjs（全経路で agent() 起動数と telemetry の突合）が同じ scenario 集合を
 * 使う。新しい exec-proxy label / 経路を dev-flow.js に足したら、ここに到達 scenario を足す
 * （exec-proxy-routing の「EXPECTED 全 label 到達」assert が未登録を検出する）。
 *
 * 各 scenario: { overrides, workflow?, extra?, expectError? }
 *   overrides   — makeDevFlowSandbox の label 単位 override
 *   workflow    — nested workflow() stub（省略時は lgtm / fixes_applied:0）
 *   extra       — makeDevFlowSandbox の extra（args.setup.analyze を差し替える scenario が使う）
 *   expectError — run が throw で終端することを期待する scenario（abort / empty-diff）
 */

import { mergeTierFacts, STANDARD_FILES, shapeOverrides, analyzeArgs } from './vm-sandbox.mjs';

const UI_FILE = 'src/components/Foo.tsx';
const VALID_UI_CFG = { install_command: 'npm ci', dev_command: 'npm run dev -- --port {port}', base_port: 4100, ready_path: '/', env_files: [] };
const UI_OVERRIDES = {
  'danger-grep': { risk: { ok: true, hits: [] }, files: [UI_FILE], struct: null, diffhash: { hash: 'AAA', empty: false } },
  'merge-tier-facts': mergeTierFacts({ files: [UI_FILE] }),
  'ui-verify-config': { found: true, config: VALID_UI_CFG },
  'ui-verify-config-final': { found: true, config: VALID_UI_CFG },
  'ui-verify-server': { ok: true, phase: 'ready', port: 4100, pid: 1 },
  'ui-verify-server-final': { ok: true, phase: 'ready', port: 4100, pid: 1 },
  'ui-verify': { ok: true, mode: 'smoke', checks: [], console_errors: [], screenshots: [], summary: 'ok' },
  'ui-verify-final': { ok: true, mode: 'smoke', checks: [], console_errors: [], screenshots: [], summary: 'ok' },
  'ui-verify-teardown': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
  'ui-verify-teardown-final': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
};

// 実効 shape は realized diff の file 数で決まる（issue #676）: complex は shapeOverrides('complex')（realized 7 件）、
// micro（lite）は danger-grep の files を空にする。
const AC2 = [
  { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
];

export const DEV_FLOW_SCENARIOS = {
  baseline: {},
  // diff-gate が空 → diff-gate-retry
  'diff-gate-retry': {
    overrides: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H2', empty: false } },
  },
  // eval hash と PR hash の不一致 → tree-diff-numstat（Merge tier は merge-tier-facts の head_tree が eval と一致で再収束）
  'hash-mismatch': {
    overrides: {
      'diff-hash-pr': { hash: 'BBB', empty: false },
      'tree-diff-numstat': { ok: true, files: ['docs/a.md (+0/-500)'] },
      'merge-tier-facts': mergeTierFacts({ tree: 'AAA' }),
    },
  },
  // Merge tier で merge-tier-facts の diffhash が secfloor と不一致 → facts の risk / changed で再判定
  'merge-rescan': { overrides: { 'merge-tier-facts': mergeTierFacts({ hash: 'CCC' }) } },
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
  // evaluator が test 実証 AC を返す → redgreen（1 spawn バッチ。results[k].index は prompt のペア順）
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
      redgreen: { results: [{ index: 0, red: true, green: true, reason: 'ok', testcmd_ran: true }] },
    },
  },
  // dev-implement-fable が CI で検証可能な環境事象を concern に返す → ENV item → merge-tier-facts の checks で CI 委譲
  'ci-checks': {
    overrides: {
      'impl:serial:issue-1': {
        status: 'DONE', task_id: 'issue-1', files: [...STANDARD_FILES], summary: 's',
        concerns: ['sandbox 内で next build が TurbopackInternalError で失敗した'],
      },
      'merge-tier-facts': mergeTierFacts({ checks: [{ name: 'build', bucket: 'pass' }] }),
    },
  },
  // complex（realized 7 files）: eval#1 critical → reimpl#1（dev-implement-fable へ fix_feedback 付き差し戻し）→ eval#2 pass
  'complex-fix': {
    overrides: {
      ...shapeOverrides('complex'),
      'eval#1': {
        verdict: 'fail', total: 5, threshold: 7,
        feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
        feedback_level: 'implementation', ac_results: AC2, security_clearance: [],
      },
      'eval#2': {
        verdict: 'pass', total: 9, threshold: 7, feedback: [], feedback_level: 'implementation',
        ac_results: AC2, security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts で修正済み' }],
      },
    },
  },
  // Validate red → green-fix#1 → test#2 green
  'green-fix': { overrides: { 'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' } } },
  // PR body に Closes 行が無い → closes-reinject → closes-recheck（既定 responder で Closes 付き body。issue #661）
  'closes-reinject': {
    overrides: { 'closes-check': { ok: true, body: '**x**\n\n## 変更\n（なし）\n' } },
  },
  // clean micro lite route（realized 0 files → micro。pr-review-lite + ci-check-lite で lgtm 終端、nested pr-iterate 起動なし）
  lite: {
    overrides: {
      'danger-grep': { risk: { ok: true, hits: [] }, files: [], struct: null, diffhash: null },
      'ci-check-lite': { status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 0 },
    },
  },
  // Analyze のゲート（comment_conflicts 非空）→ analyze-clarify#1（dev-runner）1 spawn → needs_clarification
  // （isolation-probe / fable / PR は 0 件。writeFailureTelemetry 経由の failure handoff。issue #690）
  'analyze-clarify': {
    extra: { args: analyzeArgs(1, { analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_conflicts: ['conflict: comment #1 by alice（OWNER, 2026-01-01T00:00:00Z）: hmm'] }) },
  },
  // cross-repo ラベル + 外部 repo の dirty 成果物 → graceful 終了（issue-labels / cross-repo-artifacts）
  'cross-repo': {
    overrides: {
      'diff-gate': { hash: 'EMPTY', empty: true },
      'issue-labels': { ok: true, labels: ['cross-repo'] },
      'impl:serial:issue-1': { status: 'DONE', task_id: 'issue-1', files: ['/tmp/other-repo/bar.ts'], summary: 's', concerns: [] },
      'cross-repo-artifacts': { ok: true, found: 1, artifacts: [{ path: '/tmp/other-repo/bar.ts', exists: true, repo_root: '/tmp/other-repo', dirty: true }] },
    },
  },
  // empty-diff で fail-fast → writeFailureTelemetry（journal-log-failure）
  'empty-diff': {
    overrides: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H', empty: true }, 'issue-labels': null },
    expectError: true,
  },
  // Evaluate で throw（need() 経由の非 fail-open call site）→ top-level abort handoff（journal-log-abort）
  abort: { overrides: { 'eval#1': () => { throw new Error('injected'); } }, expectError: true },
};
