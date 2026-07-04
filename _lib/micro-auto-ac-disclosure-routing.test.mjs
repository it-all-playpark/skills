// micro AUTO run で classifyMergeTier に evalSkipped:true が渡り、
// merge_tier_reasons に AC未検証文言が含まれることを VM sandbox で検証する（issue #233）。
// _lib/green-fix-micro-eval.test.mjs の VM sandbox パターン（makeCountingSandbox / runDevFlowInSandbox）を踏襲。
//
// テスト構成:
//   (A) micro AUTO run → merge_tier===AUTO かつ reasons に AC未検証文言 かつ post-summary にも文言 かつ evaluator 0 件
//   (B) standard shape run → merge_tier===REVIEW かつ文言なし（evaluator が走るので開示不要）
//   (C) micro AUTO run で evaluator が 0 件であること（開示文言の前提確認）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// micro shape 用の analyzeReq（acceptance_criteria あり・estimated_change_file_count: 1）
const MICRO_REQ = {
  summary: 's',
  acceptance_criteria: ['ac1'],
  issue_type: 'fix',
  scope: 'docs',
  estimated_change_file_count: 1,
  shape: 'micro',
};

// standard shape 用の analyzeReq（empty-diff-evaluate-routing.test.mjs の STANDARD_REQ 相当）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['ac1', 'ac2'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

/**
 * sandbox を構築する。
 * shape に応じて realized-diff / changed-files の stub を切り替える。
 */
function makeSandbox(analyzeReq, opts) {
  const calls = [];
  const {
    realizedFiles = ['docs/a.md'],
    changedFiles = ['docs/a.md'],
    iterateResult = { status: 'lgtm', iterations: 1, fixes_applied: 0 },
  } = opts || {};

  const agentStub = async (prompt, agentOpts) => {
    const label = agentOpts && agentOpts.label ? agentOpts.label : '';
    const agentType = agentOpts && agentOpts.agentType ? agentOpts.agentType : '';
    calls.push({ label, agentType, prompt: String(prompt || '') });

    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-233' };
    if (label.startsWith('analyze')) return analyzeReq;
    // file_changes は既定 realizedFiles（docs/a.md）と一致させ、宣言外扱いによる
    // micro Evaluate 強制（issue #272 F2）が誤発火しないようにする。
    if (agentType === 'dev-planner') return { summary: 'p', serial: [{ id: 'T1', desc: 't', file_changes: ['docs/a.md'], test_plan: '' }], parallel: [] };
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: realizedFiles };
    if (label === 'declared-path-check') return { files: [] };
    if (label === 'changed-files') return { files: changedFiles };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (label.startsWith('diff-gate')) return { hash: 'H', empty: false };
    if (label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (agentType === 'evaluator') return {
      verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
      ac_results: [], security_clearance: [],
    };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const sandbox = {
    phase: () => {}, log: () => {}, agent: agentStub, parallel: parallelStub,
    workflow: async () => iterateResult, args: '1',
    console, JSON, Math, String, Number, Boolean, Array, Object, Error, RegExp, Promise, Symbol, Map, Set, Date,
  };
  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;
  let caughtError = null;
  let returned = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      returned = await result.catch((e) => { caughtError = e; return null; });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, returned };
}

// ============================================================
// (A) micro AUTO run → merge_tier===AUTO + AC未検証文言あり + post-summary に文言あり
// ============================================================

test('[micro-auto-ac-disclosure] (A) micro AUTO run → merge_tier===AUTO かつ AC未検証文言を含む', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeSandbox(MICRO_REQ, {
    realizedFiles: ['docs/a.md'],
    changedFiles: ['docs/a.md'],
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  if (error) assert.fail(`(A) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(A) return object を返すべき');
  assert.strictEqual(returned.merge_tier, 'AUTO', `(A) micro AUTO run なら merge_tier===AUTO のはずだが: ${returned.merge_tier}`);
  assert.ok(
    returned.merge_tier_reasons.some((r) => r.includes('AC は未検証（micro eval skip）')),
    `(A) merge_tier_reasons に AC未検証文言を含むべきだが: ${JSON.stringify(returned.merge_tier_reasons)}`,
  );
  const postSummary = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary !== undefined, '(A) post-summary 呼び出しが存在すべき');
  assert.ok(
    postSummary.prompt.includes('AC は未検証（micro eval skip）'),
    `(A) post-summary prompt に AC未検証文言を含むべきだが: ${postSummary.prompt.slice(0, 500)}`,
  );
});

// ============================================================
// (B) standard shape run → merge_tier===REVIEW かつ AC未検証文言なし
// ============================================================

test('[micro-auto-ac-disclosure] (B) standard run → merge_tier===REVIEW かつ AC未検証文言なし', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeSandbox(STANDARD_REQ, {
    realizedFiles: ['src/foo.ts'],
    changedFiles: ['src/foo.ts'],
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  if (error) assert.fail(`(B) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(B) return object を返すべき');
  assert.strictEqual(returned.merge_tier, 'REVIEW', `(B) standard run なら merge_tier===REVIEW のはずだが: ${returned.merge_tier}`);
  assert.ok(
    returned.merge_tier_reasons.every((r) => !r.includes('AC は未検証（micro eval skip）')),
    `(B) REVIEW tier では AC未検証文言なし: ${JSON.stringify(returned.merge_tier_reasons)}`,
  );
});

// ============================================================
// (C) micro AUTO run で evaluator が 0 件
// ============================================================

test('[micro-auto-ac-disclosure] (C) micro AUTO run → evaluator が 0 件（AC未検証開示の前提確認）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeSandbox(MICRO_REQ, {
    realizedFiles: ['docs/a.md'],
    changedFiles: ['docs/a.md'],
  });
  const { error } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.strictEqual(
    evaluatorCalls.length, 0,
    `(C) micro AUTO run では evaluator は 0 件のはずだが ${evaluatorCalls.length} 件`
    + ` (全 agentTypes: ${calls.map((c) => c.agentType).filter(Boolean).join(', ')})`,
  );
});
