// issue #376 F2: clean-micro-lite 経路の判断系 agent() 呼び出し数を実測し、AC-1 の計数
// スコープを再ピンする routing test。
//
// AC-1 再ピン定義（plan-reviewer critical finding ac-target-infeasible::AC-1 への対応）:
//   AC-1 の計数対象は「判断系 agent」— agentType ∈ {dev-planner, implementer, dev-runner,
//   pr-reviewer} — の呼び出しのみとする。dev-runner-haiku / dev-runner-haiku-ro
//   （exec-proxy: Setup base/worktree/deps・danger-grep・realized-diff・structural-classify・
//   diff-hash・ci-check・post-comment・journal・clock）は W7 軸A invariant のゲート/構造呼び出し
//   であり削減禁止のため計数対象外とする。issue の「22→10」はこの判断系スコープへ再定義する。
//   **この再ピンは issue owner の enum/定義確認を要する（ambiguity。plan の
//   architecture_decisions[0] 参照）** — 実測 pin はこのスコープ定義を前提にした暫定値であり、
//   owner が別スコープ（例: 全 substantive agent 呼び出し）を意図していた場合は再校正が必要。
//
// TDD red（F2 作成時点）: dev-flow.js には clean-micro 専用の lite pr-review 経路
// （pr-reviewer を 1 回だけ呼び、blocking findings が無ければ workflow('pr-iterate') を
// 呼ばずに lgtm 終端する経路）が未実装。現行コードは shape に関わらず常に
// `workflow('pr-iterate', ...)`（.claude/workflows/dev-flow.js 3787行目付近）を無条件で呼ぶため、
// (B) clean-lite で pr-reviewer が 1 回だけ呼ばれ workflow('pr-iterate') が呼ばれない、
// および (C) escalate ケースで pr-reviewer 呼び出しが観測される、の各 assert が fail する
// （pr-reviewer は現行コードのどのパスでも呼ばれないため reviewerCalls.length は常に 0）。
// F3 で lite 経路を実装後、`npx vitest run _lib/lite-route-routing.test.mjs` で全 assert 緑化する。
// 実測確認済み（F2 時点）: (A) は現行構成で 3 回（analyze#/plan#trivial/pr#。F3 後は
// pr-review-lite が加わり 4 回想定、いずれも <=10 を満たすため現時点でも green）。
// (D) は danger hit 時の Evaluate 強制実行が既存実装で機能しているため現時点でも green
// （AC-3 の非退行 control）。red は (B)(C) の 2 件のみ。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// AC-1 判断系スコープ（再ピン定義）。dev-runner-haiku / dev-runner-haiku-ro は含めない。
const JUDGEMENT_AGENT_TYPES = new Set(['dev-planner', 'implementer', 'dev-runner', 'pr-reviewer']);

// clean-micro-lite が成立する analyzeReq: shape='micro' floor（count<=2, ac<=4）・
// breaking_change:false・issue_type は enum 内。
function makeCleanMicroReq() {
  return {
    summary: 'clean micro fix',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'fix',
    scope: 'src',
    estimated_change_file_count: 1,
    breaking_change: false,
    breaking_keyword_scan: false,
  };
}

/**
 * lite-route-routing 専用の VM sandbox。shape-loop-routing.test.mjs の
 * makeCountingSandbox と同型だが、以下を追加する:
 *   - agentType==='pr-reviewer' の応答を reviewOverride で制御可能にする
 *   - label.startsWith('danger-grep') の hits を dangerHits で制御可能にする
 *   - workflow() 呼び出しを workflowCalls 配列に記録する
 *
 * @param {object} analyzeReq - Analyze phase の agent が返す req（shape 判定に使う）
 * @param {object} [opts]
 * @param {string[]} [opts.dangerHits] - danger-grep stub が返す hits（既定 []）
 * @param {object|null} [opts.reviewOverride] - pr-reviewer stub が返す review（既定 clean review）
 * @returns {{ ctx: vm.Context, calls: Array<{label:string, agentType:string}>, workflowCalls: Array<{name:string, opts:object}> }}
 */
function makeLiteRouteSandbox(analyzeReq, opts = {}) {
  const dangerHits = opts.dangerHits ?? [];
  const reviewOverride = 'reviewOverride' in opts ? opts.reviewOverride : { decision: 'approve', issues: [] };

  const calls = [];
  const workflowCalls = [];

  const agentStub = async (prompt, agentOpts) => {
    const label = agentOpts?.label ?? '';
    const agentType = agentOpts?.agentType ?? '';
    calls.push({ label, agentType });

    // Setup
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-376' };
    }
    // Analyze（contract-probe#... は startsWith('analyze') に一致しないため素通りし、
    // req = null のまま analyze#... の分岐へ落ちる）
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    // Plan
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // lite pr-review（F3 で追加予定。agentType 判定を label より先に置き、
    // 'pr-review-lite' 等 label.startsWith('pr') とも一致するラベルの誤マッチを避ける）
    if (agentType === 'pr-reviewer') {
      return reviewOverride;
    }
    // lite CI gate（issue #376 F3 fix — 未stub だと ciLite が null のまま非 green 扱いになり、
    // clean lite review でも常に workflow('pr-iterate') へ escalate してしまうため、
    // clean シナリオでは CI green を明示的に返す）。label.startsWith('pr') より先に置く
    // 必要はない（'ci-check-lite' は 'pr' で始まらない）が、明確化のため 'ci-check' 判定を
    // 独立させる。
    if (label.startsWith('ci-check')) {
      return { status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 0 };
    }
    // Security floor: danger-grep
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: dangerHits };
    }
    // Security floor: realized-diff（issue #376 F3 fix — 未stub だと realizedCount が NaN になり
    // refloorShape が fail-safe で complex へ raise、EFFECTIVE_SHAPE!=='micro' となって
    // state.runEval が強制 true になり LITE ゲートを常に無効化してしまうため、clean シナリオでは
    // realized 変更なしを明示的に返す）。
    if (label === 'realized-diff') {
      return { files: [] };
    }
    // Validate: test runner
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [],
        security_clearance: [],
      };
    }
    // PR 作成
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // implementer
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async (name, wfOpts) => {
    workflowCalls.push({ name, opts: wfOpts });
    return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
  };

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    args: '376',
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls, workflowCalls };
}

async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      await result.catch((e) => {
        caughtError = e;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return caughtError;
}

function failOnStructuralCrash(err) {
  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }
}

// ============================================================
// (A) AC-1: 判断系 agent 呼び出し数 <= 10（clean-micro-lite 経路）
// ============================================================

test('[lite-route][A] clean-micro-lite: 判断系 agent（dev-planner/implementer/dev-runner/pr-reviewer）呼び出しが 10 以下', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeLiteRouteSandbox(makeCleanMicroReq());
  const err = await runDevFlowInSandbox(src, ctx);
  failOnStructuralCrash(err);

  const judgementCalls = calls.filter((c) => JUDGEMENT_AGENT_TYPES.has(c.agentType));
  // 実測 pin: F2 時点（lite 未実装）では analyze#(dev-runner) + plan#trivial(dev-planner) +
  // pr#(dev-runner) の 3 回。F3 で pr-review-lite（pr-reviewer）が追加されても 4 回で、
  // いずれも AC-1 の 10 以下を満たす。exact 値ではなく上限のみを pin する
  // （F3 が呼び出し数を増減させても他の struct test で検出できるため、ここでは AC-1 の
  // 数値目標そのものを固定する）。
  assert.ok(
    judgementCalls.length <= 10,
    `AC-1: 判断系 agent 呼び出しは 10 以下であるべきだが ${judgementCalls.length} 回だった`
      + ` (labels: ${judgementCalls.map((c) => `${c.agentType}:${c.label}`).join(', ')})`,
  );
  assert.ok(
    judgementCalls.length >= 1,
    'clean-micro-lite でも analyze / PR 等の最小限の判断系呼び出しは発生するはず（0 は sandbox 設定ミスの疑い）',
  );
});

// ============================================================
// (B) clean-lite: pr-reviewer 1 回のみ、workflow('pr-iterate') は呼ばれない
// ============================================================

test('[lite-route][B] clean-micro-lite: pr-reviewer 呼び出しが 1 回のみで workflow(\'pr-iterate\') は呼ばれない', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls, workflowCalls } = makeLiteRouteSandbox(makeCleanMicroReq(), {
    reviewOverride: { decision: 'approve', issues: [] },
  });
  const err = await runDevFlowInSandbox(src, ctx);
  failOnStructuralCrash(err);

  const reviewerCalls = calls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(
    reviewerCalls.length,
    1,
    `clean-micro-lite: pr-reviewer は 1 回（lite 1-pass review）呼ばれるべきだが ${reviewerCalls.length} 回だった`,
  );
  // lite pass の label に 'pr-review-lite' 等、lite 経路であることが分かる語が含まれること
  assert.ok(
    reviewerCalls.length === 0 || /lite/i.test(reviewerCalls[0].label),
    `pr-reviewer の label に lite 経路である旨が含まれること（実際の label: ${reviewerCalls[0]?.label}）`,
  );
  assert.equal(
    workflowCalls.length,
    0,
    `clean-micro-lite: workflow('pr-iterate') は呼ばれないべきだが ${workflowCalls.length} 回呼ばれた`,
  );
});

// ============================================================
// (C) escalate: lite review が blocking（critical/major）を返す → workflow('pr-iterate') が呼ばれる
// ============================================================

test('[lite-route][C] lite review が critical finding を返す → workflow(\'pr-iterate\') へ escalate する', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const blockingReview = {
    decision: 'request-changes',
    issues: [{ severity: 'critical', description: 'security issue' }],
  };
  const { ctx, calls, workflowCalls } = makeLiteRouteSandbox(makeCleanMicroReq(), {
    reviewOverride: blockingReview,
  });
  const err = await runDevFlowInSandbox(src, ctx);
  failOnStructuralCrash(err);

  const reviewerCalls = calls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(
    reviewerCalls.length,
    1,
    `escalate ケース: lite pr-reviewer は 1 回呼ばれるべきだが ${reviewerCalls.length} 回だった`,
  );
  assert.equal(
    workflowCalls.length,
    1,
    `escalate ケース（critical finding）: workflow('pr-iterate') が 1 回呼ばれるべきだが ${workflowCalls.length} 回だった`,
  );
  if (workflowCalls.length > 0) {
    assert.equal(workflowCalls[0].name, 'pr-iterate');
  }
});

// ============================================================
// (D) AC-3: danger-grep hit（runEval=true 強制）では lite に入らず現行 security path を通す
// ============================================================

test('[lite-route][D] danger-grep hit（micro でも runEval 強制）: lite をバイパスし workflow(\'pr-iterate\') + Evaluate 系呼び出しが現れる（AC-3）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls, workflowCalls } = makeLiteRouteSandbox(makeCleanMicroReq(), {
    dangerHits: ['xss'],
  });
  const err = await runDevFlowInSandbox(src, ctx);
  failOnStructuralCrash(err);

  // AC-3 軸A invariant: danger hit時は security path（通常の Evaluate 強制実行等）が
  // 現行どおり働くこと。Evaluate 系（evaluator agentType）の呼び出しが現れる。
  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    `danger-grep hit（micro）: Evaluate（evaluator 呼び出し）が security path 強制で発生するはずだが `
      + `${evaluatorCalls.length} 回だった`,
  );
  // danger hit 時は lite ゲート条件 `!state.runEval` が false になり lite に入らない
  // （lite の pr-reviewer 呼び出しは発生しない — 現行 workflow('pr-iterate') フル経路のみ）。
  const reviewerCalls = calls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(
    reviewerCalls.length,
    0,
    `danger-grep hit ケース: lite pr-reviewer は呼ばれないべきだが ${reviewerCalls.length} 回だった`
      + '（danger hit は lite をバイパスしフル workflow(\'pr-iterate\') へ委譲するはず）',
  );
  assert.equal(
    workflowCalls.length,
    1,
    `danger-grep hit ケース: workflow('pr-iterate') が 1 回呼ばれるべきだが ${workflowCalls.length} 回だった`,
  );
});
