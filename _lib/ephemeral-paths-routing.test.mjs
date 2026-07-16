// ephemeral-paths-routing: VM sandbox routing test for ephemeral path filter behavior.
//
// 新挙動（F2 実装済み）: refloor count は filterEphemeralPaths 後の一覧のうち
// plan file_changes に宣言済みの件数のみで数える（diffDeclaredPaths で宣言外を除外）。
// 宣言外の non-ephemeral 変更は refloor（size 信号）には混ぜず、
// 「micro でも Evaluate 強制 + 宣言外 concern を evaluator prompt へ注入」という
// 監査経路で扱う（宣言外は size 信号ではなく監査信号）。
//
// Tests:
//   (A) micro 見積もり + realized-diff が ephemeral 込みファイル一覧を返す → shape_refloored===false かつ evaluator 0 回
//       (ephemeral を除外した non-ephemeral 2 件を dev-planner stub の file_changes に宣言させ、宣言外 0 件にする
//        → refloorShape('micro', 2) → micro → refloor 誤発火なし・undeclared=0 で Evaluate 強制もかからない)
//   (B) micro 見積もり + realized-diff が ephemeral 込み 8 件（non-ephemeral 6 件）→ shape_refloored===true かつ effective_shape==='complex'
//       (non-ephemeral 6 件を dev-planner stub の file_changes に宣言させ、宣言外 0 件にする
//        → declared count=6 → refloorShape('micro', 6) → complex → 正しく refloor する側の pin)
//   (C) standard 見積もり + realized-diff stub が宣言外 ['u1.ts','u2.ts','u3.ts'] を返す
//       → evaluator#1 の prompt に '宣言外変更' が 2 回出現 かつ u1.ts/u2.ts/u3.ts が全部その item 内に含まれる
//       (porcelain 統合後: realized-diff スナップショットが declared-path-check と同一参照。
//        standard は refloor に関わらず常に Evaluate を実行するため、宣言外監査の挙動は F2 前後で不変。
//        issue #296 (F4) 以降: focus_areas の raw dump に加え、CONCERN-* item は未解消 concern 一覧
//        （concern_resolutions による resolve-with-evidence 経路）にも eval#1 から載るため、
//        同一 item のテキストが focus_areas / 未解消 concern 一覧の 2 箇所に出現し出現回数は 1→2 になる)
//   (D) realized-diff stub が ephemeral のみ ['evaluator.staged.md'] を返す
//       → filter 後 0 件 → 宣言外なし → '宣言外変更' が evaluator prompt に出現しない
//   (E) porcelain 取得 1 回ピン: realized-diff が 1 回 / declared-path-check が 0 回
//   (F) micro 見積もり + non-ephemeral 宣言外 1 件のみ → shape_refloored===false（declared count=0 で refloor 不発）
//       だが evaluator >= 1 回・evaluator prompt に宣言外 concern が含まれる
//       (宣言外は size 信号ではなく監査信号であることの pin)

import { test } from 'vitest';
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
 * porcelain 統合（F3）後: declared-path-check stub は削除。realized-diff が唯一のスナップショット。
 *
 * F2 新挙動対応: dev-planner stub の file_changes を declaredFiles で差し替え可能にする。
 * refloor count は宣言済み変更のみで数えるため、refloor を発火させたいシナリオ（A/B）では
 * realizedFiles の non-ephemeral 分をそのまま declaredFiles に渡す必要がある。
 * 省略時（デフォルト []）は従来どおり全て宣言外になる（C/D/E の宣言外監査シナリオ用）。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {string[]} realizedFiles - realized-diff stub が返すファイル一覧
 * @param {string[]} [declaredFiles] - dev-planner stub が file_changes として宣言するファイル一覧
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox(analyzeReq, realizedFiles, declaredFiles = []) {
  const calls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt) });

    // Setup(resolve-base): base 解決 probe（issue #298）
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    if (agentType === 'dev-planner') {
      const serial = declaredFiles.length
        ? [{ id: 't1', desc: 'stub task', file_changes: declaredFiles, test_plan: '', depends_on: [] }]
        : [];
      return { summary: 'p', serial, parallel: [] };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label === 'realized-diff') {
      return { files: realizedFiles };
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

  // non-ephemeral 2 件（a.md, b.md）を plan file_changes に宣言する。
  // 宣言しないと新挙動（宣言外は refloor ではなく Evaluate 強制）で undeclared.length>0 になり
  // evaluator 0 回の assert が壊れる。
  const declaredFiles = ['a.md', 'b.md'];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(microReq, realizedFiles, declaredFiles);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.equal(
    evaluatorCalls.length,
    0,
    '(A) micro + ephemeral 3 件 + 宣言済み non-ephemeral 2 件: evaluator は 0 回のはずだが ' + evaluatorCalls.length + ' 回'
      + ' (ephemeral filter 後 non-ephemeral=2・宣言済みで undeclared=0 → refloorShape(micro,2) → micro → runEval=false)',
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

  // non-ephemeral 6 件を全て plan file_changes に宣言する。
  // 宣言しないと新挙動では declared count=0 になり refloorShape(micro,0)→micro のままで
  // refloor が発火しない（この test の pin が壊れる）。
  const declaredFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(microReq, realizedFiles, declaredFiles);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    '(B) micro + 宣言済み non-ephemeral 6 件: evaluator は >= 1 回のはずだが ' + evaluatorCalls.length + ' 回'
      + ' (ephemeral filter 後・宣言済みで undeclared=0 → declared count=6 → refloorShape(micro,6) → complex → runEval=true)',
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
// (C) standard 見積もり + realized-diff stub が宣言外 ['u1.ts','u2.ts','u3.ts'] を返す
//     → eval#1 の prompt に '宣言外変更' が 1 回だけ / u1.ts/u2.ts/u3.ts が全部含まれる
//     (porcelain 統合後: realized-diff スナップショットが declared-path-check と同一参照)
// ============================================================

test('[ephemeral-paths-routing] (C) standard + realized-diff 宣言外 3 件 → evaluator prompt に "宣言外変更" 2 回（focus_areas + 未解消 concern 一覧） + 全パス含む', async () => {
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  // realized-diff が宣言外 3 件を返す（declaredFiles を省略 → dev-planner stub の file_changes は
  // 空のまま → diffDeclaredPaths で全て宣言外判定になる）。standard は refloor に関わらず常に
  // Evaluate を実行するため、宣言外監査の挙動は F2（refloor の declared-only 化）前後で不変。
  const realizedFiles = ['u1.ts', 'u2.ts', 'u3.ts'];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(standardReq, realizedFiles);
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
    2,
    '(C) evaluator eval#1 prompt の "宣言外変更" 出現回数は 2 回のはずだが ' + matchCount + ' 回だった'
      + ' (1 item に集約された上で focus_areas + 未解消 concern 一覧の2箇所に載る。issue #296)',
  );

  for (const p of ['u1.ts', 'u2.ts', 'u3.ts']) {
    assert.ok(
      prompt1.includes(p),
      '(C) evaluator eval#1 prompt に ' + p + ' が含まれるはずだが見つからなかった',
    );
  }
});

// ============================================================
// (D) realized-diff stub が ephemeral のみ ['evaluator.staged.md'] を返す
//     → filter 後 0 件 → refloor count 0 で standard 維持 → 宣言外なし
//     → '宣言外変更' が evaluator prompt に出現しない
// ============================================================

test('[ephemeral-paths-routing] (D) realized-diff が ephemeral のみ → "宣言外変更" が evaluator prompt に出現しない', async () => {
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  // realized-diff が ephemeral のみを返す → filterEphemeralPaths 後 0 件 → 宣言外なし
  const realizedFiles = ['evaluator.staged.md'];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(standardReq, realizedFiles);
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

// ============================================================
// (E) porcelain 取得 1 回ピン:
//     - realized-diff が 1 回だけ呼ばれる（refloor + declared-path-check 両方が参照）
//     - declared-path-check が 0 回（統合後は realized スナップショットを再利用）
//     - realized-diff が宣言外ファイルを返すと evaluator prompt に '宣言外変更' が出現する
//       （= declared-path-check が realized.files と同一スナップショットを参照している実証）
// ============================================================

test('[ephemeral-paths-routing] (E) porcelain 取得 1 回ピン: realized-diff=1 / declared-path-check=0 / 宣言外ファイル→evaluator prompt に出現', async () => {
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    estimated_change_file_count: 3,
    shape: 'standard',
  };

  // realized-diff が宣言外 1 件を返す（declaredFiles を省略 → dev-planner stub の file_changes は
  // 空のまま → diffDeclaredPaths で全て宣言外判定になる）
  const realizedFiles = ['undeclared-file.ts'];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(standardReq, realizedFiles);
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  // porcelain 呼び出し 1 回ピン
  const realizedDiffCalls = calls.filter((c) => c.label === 'realized-diff');
  assert.equal(
    realizedDiffCalls.length,
    1,
    '(E) realized-diff は 1 回のはずだが ' + realizedDiffCalls.length + ' 回だった',
  );

  const declaredPathCheckCalls = calls.filter((c) => c.label === 'declared-path-check');
  assert.equal(
    declaredPathCheckCalls.length,
    0,
    '(E) declared-path-check は 0 回のはずだが ' + declaredPathCheckCalls.length + ' 回だった'
      + ' (porcelain 統合後は realized スナップショットを再利用)',
  );

  // realized-diff が宣言外ファイルを返すと evaluator prompt に '宣言外変更' が出現する
  const eval1Call = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1Call != null, '(E) evaluator eval#1 が呼ばれていない');
  assert.ok(
    eval1Call.prompt.includes('宣言外変更'),
    '(E) evaluator prompt に "宣言外変更" が含まれるはずだが見つからなかった'
      + ' (realized-diff と declared-path-check が同一スナップショットを参照している実証)',
  );
  assert.ok(
    eval1Call.prompt.includes('undeclared-file.ts'),
    '(E) evaluator prompt に undeclared-file.ts が含まれるはずだが見つからなかった',
  );
});

// ============================================================
// (F) micro 見積もり + non-ephemeral 宣言外 1 件のみ
//     → shape_refloored===false（declared count=0 で refloor 不発）だが
//       evaluator >= 1 回・evaluator prompt に宣言外 concern が含まれる
//     (宣言外は size 信号ではなく監査信号であることの pin — 原因(3) の中核)
// ============================================================

test('[ephemeral-paths-routing] (F) micro + non-ephemeral 宣言外 1 件 → shape_refloored===false だが evaluator >= 1 回 + 宣言外 concern を注入', async () => {
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'fix',
    scope: 'src',
    estimated_change_file_count: 1,
    shape: 'micro',
  };

  // non-ephemeral 宣言外 1 件のみ（declaredFiles を省略 → dev-planner stub の file_changes は
  // 空のまま → diffDeclaredPaths で全て宣言外判定になる → declared count=0 で refloor は不発だが、
  // undeclared.length>0 により micro でも Evaluate を強制する）
  const realizedFiles = ['leftover-handoff.md'];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox(microReq, realizedFiles);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  assert.ok(returned !== null, '(F) workflow は return object を返すべきだが null だった');
  assert.strictEqual(
    returned && returned.shape_refloored,
    false,
    '(F) returned.shape_refloored は false のはずだが ' + JSON.stringify(returned && returned.shape_refloored) + ' だった'
      + ' (declared count=0 → refloorShape(micro,0) → micro のまま、refloor は不発)',
  );

  const evaluatorCalls = calls.filter((c) => c.agentType === 'evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    '(F) micro + 宣言外 non-ephemeral 1 件: evaluator は >= 1 回のはずだが ' + evaluatorCalls.length + ' 回'
      + ' (undeclared.length>0 → runEval=true で micro でも Evaluate を強制)',
  );

  const eval1Call = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1Call != null, '(F) evaluator eval#1 が呼ばれていない');
  assert.ok(
    eval1Call.prompt.includes('宣言外変更'),
    '(F) evaluator prompt に "宣言外変更" concern が含まれるはずだが見つからなかった'
      + ' (宣言外は size 信号ではなく監査信号 — refloor には混ぜず Evaluate 強制 + concern 注入で扱う)',
  );
  assert.ok(
    eval1Call.prompt.includes('leftover-handoff.md'),
    '(F) evaluator prompt に leftover-handoff.md が含まれるはずだが見つからなかった',
  );
});
