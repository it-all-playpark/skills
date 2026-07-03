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
    calls.push({ label, agentType, prompt: String(prompt ?? ''), phase: opts?.phase ?? null });

    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };
    if (label === 'diff-gate-retry') return { hash: retryEmpty ? 'EMPTY' : 'H', empty: retryEmpty };
    if (label === 'diff-hash-eval') return { hash: evalHash, empty: false };
    if (label === 'diff-hash-pr') return { hash: prHash, empty: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return analyzeReq;
    if (agentType === 'dev-planner') return { summary: 'p', serial: [{ id: 'T1', desc: 't', file_changes: ['src/foo.ts'], test_plan: '' }], parallel: [] };
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
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

// (D) eval hash AAA != PR hash BBB → eval_staleness==='hash_mismatch' かつ post-summary に stale 警告
test('[empty-diff] (D) eval hash AAA != PR hash BBB → eval_staleness===hash_mismatch かつ post-summary に stale 警告', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: false, evalHash: 'AAA', prHash: 'BBB' });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(D) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(D) return object を返すべき');
  assert.strictEqual(returned?.eval_staleness, 'hash_mismatch', `(D) eval hash 不一致なら eval_staleness==='hash_mismatch' のはずだが ${JSON.stringify(returned?.eval_staleness)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(D) post-summary の agent 呼び出しが存在すべき');
  assert.ok(postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), `(D) post-summary prompt に stale 警告を含むべきだが: ${postSummaryCall?.prompt?.slice(0, 300)}`);
});

// (E) 両 hash 'AAA' 一致 → eval_staleness==='none'・post-summary に stale 警告なし（誤検知なし）
test('[empty-diff] (E) eval hash AAA == PR hash AAA → eval_staleness===none・post-summary に stale 警告なし', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: false, evalHash: 'AAA', prHash: 'AAA' });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(E) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(E) return object を返すべき');
  assert.strictEqual(returned?.eval_staleness, 'none', `(E) hash 一致なら eval_staleness==='none' のはずだが ${JSON.stringify(returned?.eval_staleness)}`);
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

// (H) 両 hash 一致 + fixes_applied=2 → eval_staleness==='iterate_fixed' かつ post-summary に情報行あり（⚠️ は出ない）
// pr-iterate fix 適用由来の stale 検出ピン（issue #233/#288、AC-1: ℹ️ 格下げピン）
test('[empty-diff] (H) 両 hash 一致 + fixes_applied=2 → eval_staleness===iterate_fixed + ℹ️ 情報行あり・⚠️ stale 警告なし', async () => {
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
  assert.strictEqual(returned?.eval_staleness, 'iterate_fixed', `(H) fixes_applied=2 なら eval_staleness==='iterate_fixed' のはずだが ${JSON.stringify(returned?.eval_staleness)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(H) post-summary の agent 呼び出しが存在すべき');
  assert.ok(postSummaryCall?.prompt?.includes('件の fix を適用して LGTM 終端'), `(H) post-summary prompt に fix 件数の情報行を含むべきだが: ${postSummaryCall?.prompt?.slice(0, 300)}`);
  assert.ok(!postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), `(H) iterate_fixed のみなら post-summary prompt に ⚠️ stale 警告を含むべきでない`);
});

// (I) 両 hash 一致 + status='stuck' → eval_staleness==='iterate_incomplete'（status !== 'lgtm' 側の分岐、AC-3）
test('[empty-diff] (I) 両 hash 一致 + status=stuck → eval_staleness===iterate_incomplete（status !== lgtm 由来）+ stale 警告あり', async () => {
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
  assert.strictEqual(returned?.eval_staleness, 'iterate_incomplete', `(I) status=stuck なら eval_staleness==='iterate_incomplete' のはずだが ${JSON.stringify(returned?.eval_staleness)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(I) post-summary の agent 呼び出しが存在すべき');
  assert.ok(postSummaryCall?.prompt?.includes('pr-iterate が LGTM 以外で終端した'), `(I) post-summary prompt に stale 警告を含むべきだが: ${postSummaryCall?.prompt?.slice(0, 300)}`);
});

// (K) empty-diff gate retry 経路の phase タグが 'Validate'（'Security floor' でない）こと（issue #253）
// runValidateLoop('retry') は empty-diff gate 内（phase('Security floor') 呼び出し前）で実行されるため、
// test#retry-N / green-fix#retry-N の agent 呼び出しに付く phase タグは 'Validate' が正しい。
test('[empty-diff] (K) retry 経路の test#retry / green-fix#retry call の phase タグが Validate であること（issue #253）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: true, retryEmpty: false });
  const { error } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(K) 想定外エラー: ${error.message}`);
  // test#retry-N calls の phase が全て 'Validate' であること
  const retryTestCalls = calls.filter((c) => c.label.startsWith('test#retry'));
  assert.ok(retryTestCalls.length >= 1, `(K) test#retry-N が 1 件以上呼ばれるはず（gateEmpty:true で retry 経路が発火）`);
  for (const c of retryTestCalls) {
    assert.strictEqual(c.phase, 'Validate', `(K) test#retry call（label=${c.label}）の phase は 'Validate' のはずだが '${c.phase}'（Security floor タグ誤帰属）`);
  }
  // green-fix#retry-N calls の phase が全て 'Validate' であること（green が false になりうる場合は呼ばれる）
  const retryGreenFixCalls = calls.filter((c) => c.label.startsWith('green-fix#retry'));
  for (const c of retryGreenFixCalls) {
    assert.strictEqual(c.phase, 'Validate', `(K) green-fix#retry call（label=${c.label}）の phase は 'Validate' のはずだが '${c.phase}'（Security floor タグ誤帰属）`);
  }
});

// (J) 両 hash 一致 + status=lgtm + fixes_applied=0 → eval_staleness==='none'（誤検知なし）
test('[empty-diff] (J) 両 hash 一致 + status=lgtm + fixes_applied=0 → eval_staleness===none（誤検知なし）', async () => {
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
  assert.strictEqual(returned?.eval_staleness, 'none', `(J) status=lgtm + fixes_applied=0 なら eval_staleness==='none' のはずだが ${JSON.stringify(returned?.eval_staleness)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(J) post-summary の agent 呼び出しが存在すべき');
  assert.ok(!postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), `(J) hash 一致 + lgtm + no-fix 時は post-summary prompt に stale 警告を含むべきでない`);
});

// (L) 経路A(hash 不一致) + 経路B(iterate fix あり) 同時発生 → hash_mismatch が優先される（AC-2 precedence ピン）
test('[empty-diff] (L) hash 不一致 + iterate fix 同時発生 → eval_staleness===hash_mismatch が優先（iterate_fixed 情報行は出ない）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: false,
    evalHash: 'AAA',
    prHash: 'BBB',
    iterateResult: { status: 'lgtm', iterations: 3, fixes_applied: 2 },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(L) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(L) return object を返すべき');
  assert.strictEqual(returned?.eval_staleness, 'hash_mismatch', `(L) hash 不一致 + iterate fix 同時発生でも hash_mismatch が優先されるはずだが ${JSON.stringify(returned?.eval_staleness)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(L) post-summary の agent 呼び出しが存在すべき');
  assert.ok(postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), `(L) post-summary prompt に ⚠️ hash 警告を含むべきだが: ${postSummaryCall?.prompt?.slice(0, 300)}`);
});

// (M) micro path（runEval=false）で iterate fix があっても stale 関連の行が一切出ない（AC-4）
test('[empty-diff] (M) micro path（runEval=false）+ iterate fix あり → eval_staleness===none・stale 行なし', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const MICRO_REQ = {
    summary: 's',
    acceptance_criteria: ['ac1'],
    issue_type: 'docs',
    scope: 'docs',
    estimated_change_file_count: 1,
    shape: 'micro',
  };
  const { ctx, calls } = makeCountingSandbox(MICRO_REQ, {
    gateEmpty: false,
    evalHash: 'AAA',
    prHash: 'AAA',
    iterateResult: { status: 'lgtm', iterations: 2, fixes_applied: 2 },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(M) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(M) return object を返すべき');
  assert.strictEqual(returned?.eval_staleness, 'none', `(M) runEval=false なら iterate fix があっても eval_staleness==='none' のはずだが ${JSON.stringify(returned?.eval_staleness)}`);
  const postSummaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummaryCall !== undefined, '(M) post-summary の agent 呼び出しが存在すべき');
  assert.ok(!postSummaryCall?.prompt?.includes('Evaluate は古い tree に対して実行された'), '(M) runEval=false 時は post-summary prompt に ⚠️ hash 警告を含むべきでない');
  assert.ok(!postSummaryCall?.prompt?.includes('pr-iterate が LGTM 以外で終端した'), '(M) runEval=false 時は post-summary prompt に iterate_incomplete 警告を含むべきでない');
  assert.ok(!postSummaryCall?.prompt?.includes('件の fix を適用して LGTM 終端'), '(M) runEval=false 時は post-summary prompt に iterate_fixed 情報行を含むべきでない');
});

// (N) telemetry handoff に eval_staleness が到達すること（AC-5）
test('[empty-diff] (N) journal-log の telemetry handoff payload に eval_staleness が含まれること', async () => {
  const src = readFileSync(devFlowPath, 'utf8');

  // hash_mismatch ケース
  const sbox1 = makeCountingSandbox(STANDARD_REQ, { gateEmpty: false, evalHash: 'AAA', prHash: 'BBB' });
  const r1 = await runDevFlowInSandbox(src, sbox1.ctx);
  if (r1.error && (r1.error.name === 'ReferenceError' || r1.error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${r1.error.name}: ${r1.error.message}`);
  if (r1.error) assert.fail(`(N-hash_mismatch) 想定外エラー: ${r1.error.message}`);
  const journalCall1 = sbox1.calls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall1 !== undefined, '(N) journal-log の agent 呼び出しが存在すべき');
  assert.ok(journalCall1?.prompt?.includes('"eval_staleness":"hash_mismatch"'), `(N) journal-log prompt に "eval_staleness":"hash_mismatch" を含むべきだが: ${journalCall1?.prompt?.slice(0, 500)}`);

  // none ケース
  const sbox2 = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: false,
    evalHash: 'AAA',
    prHash: 'AAA',
    iterateResult: { status: 'lgtm', iterations: 1, fixes_applied: 0 },
  });
  const r2 = await runDevFlowInSandbox(src, sbox2.ctx);
  if (r2.error && (r2.error.name === 'ReferenceError' || r2.error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${r2.error.name}: ${r2.error.message}`);
  if (r2.error) assert.fail(`(N-none) 想定外エラー: ${r2.error.message}`);
  const journalCall2 = sbox2.calls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall2 !== undefined, '(N) journal-log の agent 呼び出しが存在すべき（none ケース）');
  assert.ok(journalCall2?.prompt?.includes('"eval_staleness":"none"'), `(N) journal-log prompt に "eval_staleness":"none" を含むべきだが: ${journalCall2?.prompt?.slice(0, 500)}`);
});
