import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

/**
 * tracked-agent-failure-policy.test.mjs — trackedAgent( 全出現の 3 分類強制（issue #605）を
 * vm-sandbox 共有 harness による throw 注入マトリクスの挙動テストで検証する。
 *
 * dev-flow.js / pr-iterate.js の trackedAgent( call site は必ず以下いずれかに属する:
 *   1. need() 内                — throw は中断（run abort）。null も中断（既存 need() 契約）。
 *   2. failOpenAgent wrapper 内 — throw を吸収し null へ倒す（fail-open、continue）。
 *   3. ローカル try{}/pipeline() 包囲 — throw を吸収し継続する bare 呼び出し（fail-safe、continue）。
 *   4. 上記いずれでもない bare 呼び出し — throw は吸収されず run 全体の安全網 try まで伝播し abort する
 *      （fail-closed「据え置き」）。
 *
 * 各 label に対し実際に agent() を throw させて run を実行し、continue（error===null）/
 * abort（error!==null かつ abort handoff が発火）/ needs_clarification のいずれになるかを
 * EXPECTED テーブルと突合する。EXPECTED に無い label が観測されたら red にする
 * （新規 call site の分類強制を維持する）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_FLOW_PATH = join(HERE, '..', '.claude', 'workflows', 'dev-flow.js');
const PR_ITERATE_PATH = join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js');
const devFlowSrc = readFileSync(DEV_FLOW_PATH, 'utf8');
const prIterateSrc = readFileSync(PR_ITERATE_PATH, 'utf8');

const THROW = () => { throw new Error('injected'); };

// ============================================================
// dev-flow.js baseline 設定
// ============================================================
// 各 label は到達に必要な前提が異なる。baseline ごとに最小限の override で到達経路を作る。

// B1: 既定 run（fixes_applied:0、shape=standard）。最も多くの label がここで到達する。
const DF_B1 = { overrides: {} };
// B2: pr-iterate fix 適用後の Final reconcile 系（reconcile-sync 成功・test#final 既定 pass）。
const DF_B2 = {
  workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  overrides: { 'reconcile-sync': { ok: true, head: 'a'.repeat(40) } },
};
// B3: Security floor ↔ Merge tier の tree OID 再利用 miss（diff-hash-merge が Security floor と
// 異なる hash を返す）— danger-grep-final / changed-files（Merge tier 版）を実際に呼ばせる。
const DF_B3 = { overrides: { 'diff-hash-merge': { hash: 'BBB', empty: false } } };
// B4: Final reconcile が unavailable（test#final tests:'error'）→ ci-final の CI 委譲へ到達する。
const DF_B4 = {
  workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  overrides: {
    'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
    'test#final': { tests: 'error', summary: 'startup failed', green: false },
  },
};
// B5: Merge tier の danger-grep-final が新規 hit（auth）を報告 → one-shot security-clearance-final
// へ到達する（reuse miss も併用し実際に danger-grep-final を呼ばせる）。
const DF_B5 = {
  workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  overrides: {
    'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
    'test#final': { tests: 'passed', green: true, summary: '' },
    'diff-hash-merge': { hash: 'BBB', empty: false },
    'danger-grep-final': { ok: true, hits: [{ class: 'auth', file: 'src/x.ts' }] },
  },
};
// DANGER: danger-grep（Security floor）throw に加え、danger-grep-final（Merge tier）も fail-closed
// を返す複合 override。Merge tier は Security floor の結果を独立に再取得するため、danger-grep 単体の
// throw だけでは Merge tier 側の再取得で「clean」に復元されてしまい HOLD を再現できない
// （fail-closed が Security floor と Merge tier の両方で持続する現実的なシナリオとして構成する）。
const DF_DANGER = { overrides: { 'danger-grep-final': { ok: false, hits: [], error: 'still down' } } };

async function runDevFlowBaseline(config) {
  const { ctx, calls } = makeDevFlowSandbox({ issue: 1, overrides: config.overrides, workflow: config.workflow });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  return { result, error, calls };
}

async function runDevFlowThrow(config, label) {
  const overrides = { ...(config.overrides ?? {}), [label]: THROW };
  const { ctx, calls } = makeDevFlowSandbox({ issue: 1, overrides, workflow: config.workflow });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  return { result, error, calls };
}

// ============================================================
// EXPECTED_DEV_FLOW: label → { config, policy, reason, extra? }
// ============================================================
const EXPECTED_DEV_FLOW = {
  'setup-base': { config: DF_B1, policy: 'abort', reason: 'bare据え置き。base/worktree起点が確定しないままPR diffに基点差分が乗るため throw をそのまま abort させる' },
  worktree: { config: DF_B1, policy: 'abort', reason: 'need()包み。worktree未確定のまま以降のImplementへ進めない致命契約' },
  'isolation-cleanup': { config: DF_B1, policy: 'continue', reason: 'failOpenAgent経由。cleanup失敗はprobe成立に影響しないfail-open設計' },
  'isolation-probe': { config: DF_B1, policy: 'abort', reason: 'bare据え置き。bg-isolation検知はfail-closed設計で回避手順を提示するthrowを伝播させる' },
  'worktree-deps': { config: DF_B1, policy: 'abort', reason: 'bare据え置き。deps install結果不明のまま以降の実装を進めるべきでない' },
  "contract-probe#1": { config: DF_B1, policy: 'continue', reason: 'try/catchでthrowを吸収しsonnet analyzeへfallbackする既存のfail-open経路' },
  'analyze#1': { config: DF_B1, policy: 'abort', reason: 'need()包み。REQ取得不能のまま実装を進めない致命契約' },
  'issue-meta': {
    config: DF_B1,
    policy: 'needs_clarification',
    reason: 'try/catchで吸収するがprovenance突合が不合格になりneeds_clarificationで中断する',
  },
  'plan#standard': { config: DF_B1, policy: 'abort', reason: 'need()包み。計画取得不能のまま実装を進めない致命契約' },
  'impl:serial:t1': { config: DF_B1, policy: 'continue', reason: 'failOpenAgent経由。implementer失敗はnullとしてdropし継続する' },
  'test#1': {
    config: DF_B1,
    policy: 'continue',
    reason: 'try/catchで合成redへ変換しgreen-fixループへ継続する既存のfail-safe経路',
    extra: async ({ calls }) => {
      assert.ok(calls.some((c) => c.label === 'green-fix#1'), "test#1 throw 後に label 'green-fix#1' の call が見つからない");
    },
  },
  'diff-gate': { config: DF_B1, policy: 'abort', reason: 'need()包み。empty-diff gate判定不能のまま先へ進めない致命契約' },
  'danger-grep': {
    config: DF_DANGER,
    policy: 'continue',
    reason: 'try/catchで吸収しunified=nullのper-fieldフォールバック（risk fail-closed）へ倒す',
    extra: async ({ result }) => {
      assert.equal(result?.merge_tier, 'HOLD', 'danger-grep と danger-grep-final が共に fail-closed の場合 merge_tier は HOLD になるべき');
    },
  },
  'diff-hash-eval': { config: DF_B1, policy: 'continue', reason: 'failOpenAgent経由。stale検出をskipするだけのadvisory信号' },
  'eval#1': { config: DF_B1, policy: 'abort', reason: 'need()包み。評価取得不能のままPRへ進めない致命契約' },
  'diff-hash-pr': { config: DF_B1, policy: 'continue', reason: 'failOpenAgent経由。stale検出をskipするだけのadvisory信号' },
  'pr#1': { config: DF_B1, policy: 'abort', reason: 'need()包み。PR作成失敗のまま継続しない致命契約' },
  'diff-hash-merge': { config: DF_B1, policy: 'continue', reason: 'failOpenAgent経由。tree OID再利用判定をskipするだけのadvisory信号' },
  'gh-pr-view': { config: DF_B1, policy: 'abort', reason: 'bare据え置き。PR meta取得失敗のfail-open化は別issueの検討対象' },
  'post-summary': { config: DF_B1, policy: 'abort', reason: 'bare据え置き。投稿失敗の吸収整備は別issueの検討対象' },
  'journal-save': {
    config: DF_B1,
    policy: 'continue',
    reason: 'runJournalHandoff内のtry/catchで吸収しsave_failedを返すfail-open経路',
    extra: async ({ result }) => {
      assert.equal(result?.journal_log_status, 'save_failed', "journal-save throw 時は journal_log_status が 'save_failed' になるべき");
    },
  },
  'journal-log': {
    config: DF_B1,
    policy: 'continue',
    reason: 'runJournalHandoff内のtry/catchで吸収しlog_failedを返すfail-open経路',
    extra: async ({ result }) => {
      assert.equal(result?.journal_log_status, 'log_failed', "journal-log throw 時は journal_log_status が 'log_failed' になるべき");
    },
  },
  'reconcile-sync': { config: DF_B2, policy: 'abort', reason: 'bare据え置き。worktree同期不能のままFinal reconcileを進めない' },
  'test#final': { config: DF_B2, policy: 'continue', reason: 'try/catchで吸収しunavailable扱い（merge tier HOLD）へ倒すfail-safe経路' },
  'changed-files-final': { config: DF_B2, policy: 'abort', reason: 'bare据え置き。最終changed-files取得失敗のfail-open化は別issueの検討対象' },
  'final-ac-reconcile': { config: DF_B2, policy: 'abort', reason: 'bare据え置き。最終AC再検証不能のままmerge tierを確定しない契約' },
  'danger-grep-final': { config: DF_B3, policy: 'abort', reason: 'need()包み。Merge tier最終dangerチェック不能のまま先へ進めない契約' },
  'changed-files': { config: DF_B3, policy: 'abort', reason: 'need()包み。Merge tier changed-files取得不能のまま先へ進めない契約' },
  'ci-final': { config: DF_B4, policy: 'continue', reason: 'try/catchで吸収しunavailable維持（fail-closed）へ倒す既存経路' },
  'security-clearance-final': { config: DF_B5, policy: 'abort', reason: 'bare据え置き。security clearance不能をclearと同一視しない契約' },
};

for (const [label, spec] of Object.entries(EXPECTED_DEV_FLOW)) {
  test(`dev-flow.js: label '${label}' の agent throw は ${spec.policy}`, async () => {
    assert.ok(spec.reason.length >= 20, `EXPECTED_DEV_FLOW['${label}'].reason が 20 字未満`);
    const { result, error, calls } = await runDevFlowThrow(spec.config, label);
    if (spec.policy === 'continue') {
      assert.equal(error, null, `label '${label}' の throw は継続するべきだが run が abort した: ${error?.message}`);
      assert.equal(typeof result, 'object', `label '${label}' 継続後の result が object でない`);
    } else if (spec.policy === 'abort') {
      assert.ok(error, `label '${label}' の throw は run を abort させるべきだが継続した`);
      assert.match(error.message, /injected/, `label '${label}' の abort error message に 'injected' が含まれない: ${error?.message}`);
      const thrownIdx = calls.findIndex((c) => c.label === label);
      assert.ok(thrownIdx !== -1, `label '${label}' の call 自体が記録されていない`);
      assert.ok(
        calls.slice(thrownIdx + 1).some((c) => c.label?.startsWith('journal-')),
        `label '${label}' の throw 後に abort handoff（label が 'journal-' で始まる call）が見つからない`,
      );
    } else if (spec.policy === 'needs_clarification') {
      assert.equal(error, null, `label '${label}' は throw を吸収し needs_clarification で終端するべき: ${error?.message}`);
      assert.equal(result?.status, 'needs_clarification', `label '${label}' throw 後の result.status が needs_clarification でない: ${result?.status}`);
      assert.ok(!calls.some((c) => c.label?.startsWith('plan#')), `label '${label}' throw 後に plan# 系 call が呼ばれている（needs_clarification で中断されていない）`);
    } else {
      assert.fail(`未知の policy: ${spec.policy}`);
    }
    if (spec.extra) await spec.extra({ result, error, calls });
  });
}

// ── 未分類 label 検出（新規 call site の分類強制。issue #605）────────────
test('dev-flow.js: 全 baseline で観測される label は EXPECTED_DEV_FLOW に登録されている', async () => {
  const configs = [DF_B1, DF_B2, DF_B3, DF_B4, DF_B5, DF_DANGER];
  const observed = new Set();
  for (const config of configs) {
    const { calls } = await runDevFlowBaseline(config);
    for (const c of calls) observed.add(c.label);
  }
  const missing = [...observed].filter((l) => !(l in EXPECTED_DEV_FLOW));
  assert.equal(
    missing.length,
    0,
    `未分類の label が ${missing.length} 件: ${JSON.stringify(missing)}。\n` +
    `新規 call site は以下いずれかで解消すること:\n` +
    `  1. need() で包む（契約 null/throw は run を中断）\n` +
    `  2. failOpenAgent(...) 経由にする（throw を fail-open で吸収）\n` +
    `  3. この EXPECTED_DEV_FLOW に policy と reason（20 字以上）を登録する`,
  );
});

// ── 参照 sanity（走査ズレ検出）────────────────────────────────────
test("dev-flow.js baseline（B1）に 'setup-base' / 'plan#standard' / 'post-summary' が含まれる（走査ズレ検出）", async () => {
  const { calls } = await runDevFlowBaseline(DF_B1);
  const labels = calls.map((c) => c.label);
  assert.ok(labels.includes('setup-base'), "baseline に 'setup-base' が無い");
  // shape='standard' の既定 baseline では PLAN_SOLO 経路のため label は 'plan#standard'
  // （'plan#${i}' ループ形は complex shape でのみ到達し本 baseline では観測されない）。
  assert.ok(labels.includes('plan#standard'), "baseline に 'plan#standard' が無い");
  assert.ok(labels.includes('post-summary'), "baseline に 'post-summary' が無い");
});

// ============================================================
// pr-iterate.js baseline 設定
// ============================================================
// B1: 既定 run（review#1 が approve を返し 1 round で lgtm）。
const PR_B1 = { overrides: {} };
// B2: review#1 が request-changes → fix#1 → commit-ensure#1 → review#2 が approve で lgtm。
const PR_B2 = {
  overrides: {
    'review#1': () => ({ decision: 'request-changes', issues: [{ severity: 'critical', description: 'x', suggestion: 'y' }], summary: 'nope' }),
    'review#2': { decision: 'approve', issues: [], summary: 'ok now' },
  },
};

async function runPrIterateBaseline(config) {
  const { ctx, calls } = makePrIterateSandbox({ args: '5', overrides: config.overrides });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  return { result, error, calls };
}

async function runPrIterateThrow(config, label) {
  const overrides = { ...(config.overrides ?? {}), [label]: THROW };
  const { ctx, calls } = makePrIterateSandbox({ args: '5', overrides });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  return { result, error, calls };
}

// pr-iterate.js の全 bare trackedAgent( call site はローカル try/catch 包囲（issue #437/#520）。
// failOpenAgent 経由の呼び出しと合わせ、throw 起因の abort は無い（need() 包みが 0 件のため）。
const EXPECTED_PR_ITERATE = {
  'pr-meta': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。cwd/epoch取得失敗はfallbackするadvisory信号' },
  'isolation-cleanup': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。cleanup失敗はprobe成立に影響しないfail-open' },
  'isolation-probe': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。probe自体の失敗はfail-open（診断できないだけ）' },
  'review#1': { config: PR_B1, policy: 'continue', reason: 'callReviewAgent内try/catchで吸収しschema-retryへ倒すfail-safe経路' },
  'ci-check#1': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。throw/nullはstatus:errorに合成しci_errorへ流す' },
  'post-summary': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。投稿失敗はfail-openでgate判定に影響しない' },
  'journal-save': { config: PR_B1, policy: 'continue', reason: 'runJournalHandoff内try/catchで吸収するfail-open経路' },
  'journal-log': { config: PR_B1, policy: 'continue', reason: 'runJournalHandoff内try/catchで吸収するfail-open経路' },
  'fix#1': { config: PR_B2, policy: 'continue', reason: 'callFixAgent内try/catchで吸収しnull-retryへ倒すfail-safe経路' },
  'commit-ensure#1': { config: PR_B2, policy: 'continue', reason: 'try/catchで吸収しfix_failedエスカレーションへ倒すfail-safe経路' },
  'review#2': { config: PR_B2, policy: 'continue', reason: 'callReviewAgent内try/catchで吸収しschema-retryへ倒すfail-safe経路' },
  'ci-check#2': { config: PR_B2, policy: 'continue', reason: 'failOpenAgent経由。throw/nullはstatus:errorに合成しci_errorへ流す' },
};

for (const [label, spec] of Object.entries(EXPECTED_PR_ITERATE)) {
  test(`pr-iterate.js: label '${label}' の agent throw は ${spec.policy}`, async () => {
    assert.ok(spec.reason.length >= 20, `EXPECTED_PR_ITERATE['${label}'].reason が 20 字未満`);
    const { result, error } = await runPrIterateThrow(spec.config, label);
    assert.equal(error, null, `label '${label}' の throw は継続するべきだが run が abort した: ${error?.message}`);
    assert.equal(typeof result, 'object', `label '${label}' 継続後の result が object でない`);
  });
}

test('pr-iterate.js: 全 baseline で観測される label は EXPECTED_PR_ITERATE に登録されている', async () => {
  const configs = [PR_B1, PR_B2];
  const observed = new Set();
  for (const config of configs) {
    const { calls } = await runPrIterateBaseline(config);
    for (const c of calls) observed.add(c.label);
  }
  const missing = [...observed].filter((l) => !(l in EXPECTED_PR_ITERATE));
  assert.equal(
    missing.length,
    0,
    `未分類の label が ${missing.length} 件: ${JSON.stringify(missing)}。\n` +
    `新規 call site は以下いずれかで解消すること:\n` +
    `  1. need() で包む（契約 null/throw は run を中断）\n` +
    `  2. failOpenAgent(...) 経由にする（throw を fail-open で吸収）\n` +
    `  3. この EXPECTED_PR_ITERATE に policy と reason（20 字以上）を登録する`,
  );
});

test("pr-iterate.js baseline に 'pr-meta' / 'isolation-probe' が含まれる（走査ズレ検出）", async () => {
  const { calls } = await runPrIterateBaseline(PR_B1);
  const labels = calls.map((c) => c.label);
  assert.ok(labels.includes('pr-meta'), "baseline に 'pr-meta' が無い");
  assert.ok(labels.includes('isolation-probe'), "baseline に 'isolation-probe' が無い");
});

// ── fail-closed（throw ではない）行: isolation-probe が written:false を返す ──
test("pr-iterate.js: isolation-probe が {written:false} を返すと throw し message に isoWt（pr-meta の cwd）を含む", async () => {
  const { ctx } = makePrIterateSandbox({ args: '5', overrides: { 'isolation-probe': { written: false, error: 'x' } } });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(result, null, 'isolation-probe written:false は run を abort させるべき');
  assert.ok(error, 'isolation-probe written:false は throw するべき');
  assert.ok(error.message.includes('/tmp/wt'), `throw message に isoWt（pr-meta の既定 cwd '/tmp/wt'）が含まれない: ${error.message}`);
});

// ── drift pin: .claude/rules/dev-flow.md の diff-hash 行 ↔ 実装 ──────
test('.claude/rules/dev-flow.md の diff-hash 行の失敗検出セルに agent throw が明記されている（AC-4）', () => {
  const rulesPath = join(HERE, '..', '..', '..', '.claude', 'rules', 'dev-flow.md');
  const rulesSrc = readFileSync(rulesPath, 'utf8');
  const diffHashLine = rulesSrc.split('\n').find((line) => line.startsWith('| diff-hash |'));
  assert.ok(diffHashLine, '.claude/rules/dev-flow.md に `| diff-hash |` で始まる行が見つからない');
  const cols = diffHashLine.split('|').map((c) => c.trim());
  // cols[0] は空文字（先頭 `|` の前）、cols[1] は 'diff-hash'、cols[2] が失敗検出セル
  const failureDetectionCell = cols[2];
  assert.ok(
    failureDetectionCell && failureDetectionCell.includes('agent throw'),
    `diff-hash 行の失敗検出セルに 'agent throw' が含まれない: ${JSON.stringify(failureDetectionCell)}`,
  );
});
