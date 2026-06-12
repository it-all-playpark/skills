// empty-diff gate と diff-hash 乖離検出の VM sandbox routing テスト（issue #215）。
// _lib/refloor-shape-routing.test.mjs の makeCountingSandbox / runDevFlowInSandbox パターンを踏襲。
//
// stub に label==='diff-gate' / 'diff-gate-retry' / 'diff-hash-eval' / 'diff-hash-pr' の分岐を追加し
// テストごとに可変の {hash, empty} を返す。
//
// analyzeReq は standard shape（estimated_change_file_count:3, acceptance_criteria あり, issue_type:'fix'）で
// runEval を成立させる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

function makeCountingSandbox(analyzeReq, diffHashConfig) {
  const calls = [];
  const {
    gateEmpty = false,
    retryEmpty = false,
    evalHash = 'H',
    prHash = 'H',
    iterateResult = { status: 'lgtm', iterations: 1, fixes_applied: 0 },
  } = diffHashConfig || {};

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };
    if (label === 'diff-gate-retry') return { hash: retryEmpty ? 'EMPTY' : 'H', empty: retryEmpty };
    if (label === 'diff-hash-eval') return { hash: evalHash, empty: false };
    if (label === 'diff-hash-pr') return { hash: prHash, empty: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return analyzeReq;
    if (agentType === 'dev-planner') return { summary: 'p', serial: [{ id: 'T1', desc: 't', file_changes: ['src/foo.ts'], test_plan: '' }], parallel: [] };
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { hits: [] };
    if (label === 'realized-diff') return { files: ['src/foo.ts'] };
    if (label === 'declared-path-check') return { files: [] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (agentType === 'evaluator') return { verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [] };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'changed-files') return { files: ['src/foo.ts'] };
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

const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['ac1', 'ac2'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
};

// (A) diff-gate empty:false → reimpl-empty-diff 0 件・diff-gate-retry 0 件・正常完了
test('[empty-diff] (A) diff-gate empty:false → reimpl-empty-diff 0 件・diff-gate-retry 0 件・正常完了', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: false });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  const reimplCalls = calls.filter((c) => c.label.startsWith('reimpl-empty-diff'));
  assert.strictEqual(reimplCalls.length, 0, `(A) empty:false なら reimpl-empty-diff 0 件のはずだが ${reimplCalls.length} 件`);
  const retryGateCalls = calls.filter((c) => c.label === 'diff-gate-retry');
  assert.strictEqual(retryGateCalls.length, 0, `(A) empty:false なら diff-gate-retry 0 件のはずだが ${retryGateCalls.length} 件`);
  if (error) assert.fail(`(A) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(A) return object を返すべき');
});

// (B) diff-gate empty:true / diff-gate-retry empty:false → reimpl-empty-diff >= 1・diff-gate-retry 1 件・正常完了
test('[empty-diff] (B) diff-gate empty:true / diff-gate-retry empty:false → reimpl-empty-diff >= 1・diff-gate-retry 1 件・正常完了', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: true, retryEmpty: false });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  const reimplCalls = calls.filter((c) => c.label.startsWith('reimpl-empty-diff'));
  assert.ok(reimplCalls.length >= 1, `(B) reimpl-empty-diff >= 1 件のはずだが ${reimplCalls.length} 件`);
  const retryGateCalls = calls.filter((c) => c.label === 'diff-gate-retry');
  assert.strictEqual(retryGateCalls.length, 1, `(B) diff-gate-retry は 1 件のはずだが ${retryGateCalls.length} 件（無限ループ禁止）`);
  // (B+) empty-diff gate 後に test#retry が呼ばれること（issue #219 fix 3 の確認）
  const retryTestCalls = calls.filter((c) => c.label.startsWith('test#retry'));
  assert.ok(retryTestCalls.length >= 1, `(B) empty-diff gate 後に test#retry が >= 1 件呼ばれるはずだが ${retryTestCalls.length} 件（issue #219: validate 再実行）`);
  if (error) assert.fail(`(B) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(B) return object を返すべき');
});

// (C) diff-gate empty:true / diff-gate-retry empty:true → throw・evaluator 0 件（fail-fast）
test('[empty-diff] (C) diff-gate empty:true / diff-gate-retry empty:true → throw し evaluator 0 件（fail-fast）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: true, retryEmpty: true });
  const { error } = await runDevFlowInSandbox(src, ctx);
  assert.ok(error !== null, '(C) 両方 empty:true なら workflow が throw すべきだが error が null だった');
  assert.ok(typeof error?.message === 'string' && error.message.includes('empty-diff gate'), `(C) error.message に 'empty-diff gate' を含むべきだが: ${error?.message}`);
  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.strictEqual(evaluatorCalls.length, 0, `(C) evaluator は 0 件のはずだが ${evaluatorCalls.length} 件（fail-fast であること）`);
});

// (D) eval hash AAA != PR hash BBB → eval_tree_stale===true かつ post-summary に stale 警告
test('[empty-diff] (D) eval hash AAA != PR hash BBB → eval_tree_stale===true かつ post-summary に stale 警告', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: false, evalHash: 'AAA', prHash: 'BBB' });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(D) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(D) return object を返すべき');
  assert.strictEqual(returned?.eval_tree_stale, true, `(D) eval hash 不一致なら eval_tree_stale===true のはずだが ${JSON.stringify(returned?.eval_tree_stale)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(D) post-summary の agent 呼び出しが存在すべき');
  assert.ok(postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), `(D) post-summary prompt に stale 警告を含むべきだが: ${postSummaryCall?.prompt?.slice(0, 300)}`);
});

// (E) 両 hash 'AAA' 一致 → eval_tree_stale===false・post-summary に stale 警告なし（誤検知なし）
test('[empty-diff] (E) eval hash AAA == PR hash AAA → eval_tree_stale===false・post-summary に stale 警告なし', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: false, evalHash: 'AAA', prHash: 'AAA' });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(E) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(E) return object を返すべき');
  assert.strictEqual(returned?.eval_tree_stale, false, `(E) hash 一致なら eval_tree_stale===false のはずだが ${JSON.stringify(returned?.eval_tree_stale)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(E) post-summary の agent 呼び出しが存在すべき');
  assert.ok(!postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), `(E) hash 一致時は post-summary prompt に stale 警告を含むべきでない`);
});

// (F) diff-gate empty:true / diff-gate-retry empty:false → test#retry >= 1・evaluator が呼ばれること（issue #219）
test('[empty-diff] (F) empty-diff gate retry 後に validate 再実行 → test#retry >= 1 かつ evaluator が呼ばれること', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: true, retryEmpty: false });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  // test#retry-N が呼ばれて validate が再実行されること（issue #219 fix 3）
  const retryTestCalls = calls.filter((c) => c.label.startsWith('test#retry'));
  assert.ok(retryTestCalls.length >= 1, `(F) test#retry >= 1 件のはずだが ${retryTestCalls.length} 件（validate 再実行確認）`);
  // evaluator も通常通り呼ばれること
  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.ok(evaluatorCalls.length >= 1, `(F) evaluator >= 1 件のはずだが ${evaluatorCalls.length} 件（evaluate phase が実行されること）`);
  if (error) assert.fail(`(F) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(F) return object を返すべき');
});

// (G) empty-diff gate retry 後に danger-grep が retry 後 tree を見ること（issue #219 major fix）
// gate 移動により Security floor が retry 後に実行される → danger-grep は reimpl-empty-diff より後に呼ばれる invariant。
// もし gate が Security floor の後にあれば danger-grep は reimpl-empty-diff より前に来る（旧バグ）。
test('[empty-diff] (G) retry 後に danger-grep が reimpl-empty-diff より後に呼ばれること（Security floor が retry 後 tree を見る）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: true, retryEmpty: false });
  const { error } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(G) 想定外エラー: ${error.message}`);
  const reimplIdx = calls.findIndex((c) => c.label.startsWith('reimpl-empty-diff'));
  assert.ok(reimplIdx >= 0, `(G) reimpl-empty-diff が呼ばれていない`);
  const dangerGrepIdx = calls.findIndex((c) => c.label.startsWith('danger-grep'));
  assert.ok(dangerGrepIdx >= 0, `(G) danger-grep が呼ばれていない`);
  assert.ok(
    dangerGrepIdx > reimplIdx,
    `(G) danger-grep（calls[${dangerGrepIdx}]）は reimpl-empty-diff（calls[${reimplIdx}]）より後に呼ばれるべき。`
    + `danger-grep が retry 前の空 tree を見ると dangerHits が空のまま security path 強制が不発になる（issue #219）。`
    + `実際の順序: reimpl-empty-diff=${reimplIdx}, danger-grep=${dangerGrepIdx}`,
  );
});

// (H) 両 hash 一致 + fixes_applied=2 → eval_tree_stale===true かつ post-summary に stale 警告
// pr-iterate fix 適用由来の stale 検出ピン（issue #233）
test('[empty-diff] (H) 両 hash 一致 + fixes_applied=2 → eval_tree_stale===true + stale 警告あり', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: false,
    evalHash: 'AAA',
    prHash: 'AAA',
    iterateResult: { status: 'lgtm', iterations: 3, fixes_applied: 2 },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(H) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(H) return object を返すべき');
  assert.strictEqual(returned?.eval_tree_stale, true, `(H) fixes_applied=2 なら eval_tree_stale===true のはずだが ${JSON.stringify(returned?.eval_tree_stale)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(H) post-summary の agent 呼び出しが存在すべき');
  assert.ok(postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), `(H) post-summary prompt に stale 警告を含むべきだが: ${postSummaryCall?.prompt?.slice(0, 300)}`);
});

// (I) 両 hash 一致 + status='stuck' → eval_tree_stale===true（status !== 'lgtm' 側の OR 分岐）
test('[empty-diff] (I) 両 hash 一致 + status=stuck → eval_tree_stale===true（status !== lgtm 由来）+ stale 警告あり', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: false,
    evalHash: 'AAA',
    prHash: 'AAA',
    iterateResult: { status: 'stuck', iterations: 5, fixes_applied: 3 },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(I) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(I) return object を返すべき');
  assert.strictEqual(returned?.eval_tree_stale, true, `(I) status=stuck なら eval_tree_stale===true のはずだが ${JSON.stringify(returned?.eval_tree_stale)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(I) post-summary の agent 呼び出しが存在すべき');
  assert.ok(postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), `(I) post-summary prompt に stale 警告を含むべきだが: ${postSummaryCall?.prompt?.slice(0, 300)}`);
});

// (J) 両 hash 一致 + status=lgtm + fixes_applied=0 → eval_tree_stale===false（誤検知なし）
test('[empty-diff] (J) 両 hash 一致 + status=lgtm + fixes_applied=0 → eval_tree_stale===false（誤検知なし）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: false,
    evalHash: 'AAA',
    prHash: 'AAA',
    iterateResult: { status: 'lgtm', iterations: 1, fixes_applied: 0 },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(J) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(J) return object を返すべき');
  assert.strictEqual(returned?.eval_tree_stale, false, `(J) status=lgtm + fixes_applied=0 なら eval_tree_stale===false のはずだが ${JSON.stringify(returned?.eval_tree_stale)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(J) post-summary の agent 呼び出しが存在すべき');
  assert.ok(!postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), `(J) hash 一致 + lgtm + no-fix 時は post-summary prompt に stale 警告を含むべきでない`);
});
