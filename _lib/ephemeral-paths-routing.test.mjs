// ephemeral-paths-routing: VM sandbox routing test for ephemeral path filter behavior.
// Tests:
//   (A) micro 見積もり + realized-diff が ephemeral 込みファイル一覧を返す → shape_refloored===false かつ evaluator 0 回
//       (ephemeral を除外した non-ephemeral が 2 件 → refloorShape('micro', 2) → micro → refloor 誤発火なし)
//   (B) micro 見積もり + realized-diff が ephemeral 込み 8 件（non-ephemeral 6 件）→ shape_refloored===true かつ effective_shape==='complex'
//       (filter 後 6 件 → refloorShape('micro', 6) → complex → 正しく refloor する側の pin)
//   (C) standard 見積もり + declared-path-check が plan 宣言外 ['u1.ts','u2.ts','u3.ts'] を返す
//       → evaluator#1 の prompt に '宣言外変更' が 1 回だけ出現 かつ u1.ts/u2.ts/u3.ts が全部その 1 item 内に含まれる
//   (D) declared-path-check が ephemeral のみ ['evaluator.staged.md'] を返す
//       → '宣言外変更' が evaluator prompt に出現しない

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers ----

/**
 * ephemeral-paths-routing 専用の VM sandbox を組む。
 * refloor-shape-routing.test.mjs の makeCountingSandbox と同型。
 * 相違点: calls 配列に { label, agentType, prompt } を記録する（prompt も記録するよう拡張）。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {string[]} realizedFiles - realized-diff stub が返すファイル一覧
 * @param {string[]} declaredPathCheckFiles - declared-path-check stub が返すファイル一覧
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox(analyzeReq, realizedFiles, declaredPathCheckFiles) {
  if (declaredPathCheckFiles === undefined) declaredPathCheckFiles = [];
  const calls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt) });

    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    if (label.startsWith('danger-grep')) {
      return { hits: [] };
    }
    if (label === 'realized-diff') {
      return { files: realizedFiles };
    }
    if (label === 'declared-path-check') {
      return { files: declaredPathCheckFiles };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
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
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    args: '1',
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
  return { ctx, calls };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * refloor-shape-routing.test.mjs の runDevFlowInSandbox と同型: return object を解決して返す。
 */
async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = '(async () => {\n' + stripped + '\n})();';

  let caughtError = null;
  let returned = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      returned = await result.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, returned };
}

// ============================================================
// (A) micro 見積もり + realized-diff が ephemeral 込みファイル一覧を返す
//     → shape_refloored===false かつ evaluator 0 回（refloor 誤発火が再現しない — AC 2）
// ============================================================

test('[ephemeral-paths-routing] (A) micro + realized ephemeral 3 件 non-ephemeral 2 件 → shape_refloored===false evaluator 0 回', async () => {
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'fix',
    scope: 'src',
    estimated_change_file_count: 1,
    shape: 'micro',
  };

  const realizedFiles = [
    'a.md',
    'b.md',
    'evaluator.staged.md',
    'fm_3821.txt',
    '.devflow-tmp/handoff.json',
  ];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(microReq, realizedFiles);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.equal(
    evaluatorCalls.length,
    0,
    '(A) micro + ephemeral 3 件 + non-ephemeral 2 件: evaluator は 0 回のはずだが ' + evaluatorCalls.length + ' 回'
      + ' (ephemeral filter 後 non-ephemeral=2 → refloorShape(micro,2) → micro → runEval=false)',
  );

  assert.ok(returned !== null, '(A) workflow は return object を返すべきだが null だった');
  assert.strictEqual(
    returned && returned.shape_refloored,
    false,
    '(A) returned.shape_refloored は false のはずだが ' + JSON.stringify(returned && returned.shape_refloored) + ' だった',
  );
});

// ============================================================
// (B) micro 見積もり + realized-diff が ephemeral 込み 8 件（non-ephemeral 6 件）
//     → shape_refloored===true / effective_shape==='complex'
// ============================================================

test('[ephemeral-paths-routing] (B) micro + realized ephemeral 2 件 non-ephemeral 6 件 → shape_refloored===true effective_shape===complex', async () => {
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'fix',
    scope: 'src',
    estimated_change_file_count: 1,
    shape: 'micro',
  };

  const realizedFiles = [
    'src/a.ts',
    'src/b.ts',
    'src/c.ts',
    'src/d.ts',
    'src/e.ts',
    'src/f.ts',
    'evaluator.staged.md',
    'fm_9999.txt',
  ];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(microReq, realizedFiles);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    '(B) micro + non-ephemeral 6 件: evaluator は >= 1 回のはずだが ' + evaluatorCalls.length + ' 回'
      + ' (ephemeral filter 後 non-ephemeral=6 → refloorShape(micro,6) → complex → runEval=true)',
  );

  assert.ok(returned !== null, '(B) workflow は return object を返すべきだが null だった');
  assert.strictEqual(
    returned && returned.shape_refloored,
    true,
    '(B) returned.shape_refloored は true のはずだが ' + JSON.stringify(returned && returned.shape_refloored) + ' だった',
  );
  assert.strictEqual(
    returned && returned.effective_shape,
    'complex',
    "(B) returned.effective_shape は 'complex' のはずだが " + JSON.stringify(returned && returned.effective_shape) + ' だった',
  );
});

// ============================================================
// (C) standard 見積もり + declared-path-check stub が plan 宣言外の ['u1.ts','u2.ts','u3.ts'] を返す
//     → eval#1 の prompt に '宣言外変更' が 1 回だけ / u1.ts/u2.ts/u3.ts が全部含まれる
// ============================================================

test('[ephemeral-paths-routing] (C) standard + declared-path-check 宣言外 3 件 → evaluator prompt に "宣言外変更" 1 回 + 全パス含む', async () => {
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  const declaredPathCheckFiles = ['u1.ts', 'u2.ts', 'u3.ts'];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(standardReq, ['src/a.ts', 'src/b.ts'], declaredPathCheckFiles);
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const eval1Call = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1Call != null, '(C) evaluator eval#1 が呼ばれていない');

  const prompt1 = eval1Call.prompt;

  const matchCount = (prompt1.match(/宣言外変更/g) || []).length;
  assert.equal(
    matchCount,
    1,
    '(C) evaluator eval#1 prompt の "宣言外変更" 出現回数は 1 回のはずだが ' + matchCount + ' 回だった'
      + ' (1 item に集約されていれば 1 回のみ)',
  );

  for (const p of ['u1.ts', 'u2.ts', 'u3.ts']) {
    assert.ok(
      prompt1.includes(p),
      '(C) evaluator eval#1 prompt に ' + p + ' が含まれるはずだが見つからなかった',
    );
  }
});

// ============================================================
// (D) declared-path-check stub が ephemeral のみ ['evaluator.staged.md'] を返す
//     → '宣言外変更' が evaluator prompt に出現しない
// ============================================================

test('[ephemeral-paths-routing] (D) declared-path-check が ephemeral のみ → "宣言外変更" が evaluator prompt に出現しない', async () => {
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  const declaredPathCheckFiles = ['evaluator.staged.md'];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(standardReq, ['src/a.ts', 'src/b.ts'], declaredPathCheckFiles);
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const evalCalls = calls.filter((c) => c.agentType === 'evaluator');
  for (const c of evalCalls) {
    assert.ok(
      !c.prompt.includes('宣言外変更'),
      "(D) evaluator prompt に '宣言外変更' が出現してはいけないが含まれていた"
        + " (ephemeral のみ ['evaluator.staged.md'] は filter 後 0 件になるはず)",
    );
  }
});
