// VALIDATE_TEST_PROMPT（Validate phase の test 実行 exec-proxy prompt）を VM run で実際に
// test#1 へ渡る prompt として捕捉し、argv/token/データ echo/否定側で検証する（issue #636 P3b）。
//
// 旧版は dev-flow.js の VALIDATE_TEST_PROMPT 定義ブロックを readFileSync + slice して日本語の
// 指示文・規約文を部分一致で pin していたが、言い回し変更のみで落ちる pin だったため置換した。
// tests:'error' / tests:'failed' で green-fix ルーティングが分岐する挙動は
// _lib/validate-tests-error-skip-routing.test.mjs が既に VM sandbox で担っているため、
// 本ファイルでは重複させない。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

function responder({ label, agentType }) {
  if (label === 'setup-base') {
    return {
      ok: true, default_branch: 'main', dev_exists: false, requested_exists: false,
      worktree_exists: false, upstream_remote: '', upstream_merge: '',
    };
  }
  if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-553' };
  if (label.startsWith('analyze')) {
    return {
      summary: 's',
      acceptance_criteria: ['a', 'b'],
      issue_type: 'fix',
      scope: 'src',
      issue_number: 553,
      issue_title: 'stub-issue-title',
    };
  }
  if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
  if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
  if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
  if (agentType === 'dev-flow:dev-implement-fable') return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
  if (agentType === 'dev-flow:evaluator') {
    return {
      verdict: 'pass', total: 100, threshold: 80, feedback: [],
      feedback_level: 'implementation', ac_results: [], security_clearance: [],
    };
  }
  if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') return { files: [] };
  if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
  if (label === 'issue-meta') return { ok: true, number: 553, title: 'stub-issue-title' };
  return null;
}

let sharedCalls = null;
let sharedError = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const { ctx, calls } = makeRecordingSandbox(responder, { args: devFlowArgs('553') });
  const error = await runDevFlowInSandbox(devFlowSrc, ctx);
  sharedCalls = calls;
  sharedError = error;
}

function test1Prompt() {
  const c = sharedCalls.find((x) => x.label === 'test#1');
  assert.ok(
    c != null,
    `label === 'test#1' の call が見つからない (labels: ${sharedCalls.map((x) => x.label).join(', ')})`,
  );
  assert.equal(
    c.agentType,
    'dev-flow:dev-runner-haiku',
    `test#1 の agentType は 'dev-flow:dev-runner-haiku' のはずだが '${c.agentType}' だった`,
  );
  return c.prompt;
}

test('[validate-test-prompt] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  if (sharedError && (sharedError.name === 'ReferenceError' || sharedError.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${sharedError.name}: ${sharedError.message}`);
  }
});

test('[validate-test-prompt] test#1 prompt は末尾に date +%s（EPOCH_INSTRUCTION の実体）を含む', async () => {
  await ensureSharedRun();
  const prompt = test1Prompt();
  assert.ok(prompt.includes('date +%s'), 'test#1 prompt に "date +%s" が含まれていない');
});

test('[validate-test-prompt] test#1 prompt は trust-test-latest.json への証跡保存ブロックを含まない（issue #553）', async () => {
  await ensureSharedRun();
  const prompt = test1Prompt();
  assert.ok(!prompt.includes('trust-test-latest'), 'test#1 prompt に trust-test-latest への言及が残っている（証跡保存ブロックの除去漏れ）');
  assert.ok(!prompt.includes('証跡保存'), 'test#1 prompt に「証跡保存」という語が残っている（証跡保存ブロックの除去漏れ）');
  assert.ok(!prompt.includes('Write tool'), 'test#1 prompt に Write tool による JSON 保存指示が残っている（証跡保存ブロックの除去漏れ）');
});

test('[validate-test-prompt] test#1 prompt は tests:"error" / tests:"failed" の両キーを含む（issue #619）', async () => {
  await ensureSharedRun();
  const prompt = test1Prompt();
  assert.ok(prompt.includes('tests:"error"'), 'test#1 prompt に tests:"error" キーが含まれていない');
  assert.ok(prompt.includes('tests:"failed"'), 'test#1 prompt に tests:"failed" キーが含まれていない');
});

test('[validate-test-prompt] test#1 prompt は tests/run-*.sh を列挙して全本実行させ、全本 green のときだけ green:true を返させる（issue #720）', async () => {
  await ensureSharedRun();
  const prompt = test1Prompt();
  // 列挙コマンド（bare 単文）と対象 glob。1 本だけ選ばせる旧文言「それを優先し、」の残存も否定側で見る
  assert.ok(prompt.includes('ls -l /tmp/wt/tests'), 'test#1 prompt に tests ディレクトリの列挙コマンド（ls -l <WT>/tests）が無い');
  assert.ok(prompt.includes('tests/run-*.sh'), 'test#1 prompt に tests/run-*.sh が無い');
  assert.ok(!prompt.includes('あればそれを優先し、'), 'test#1 prompt に 1 本だけ選ばせる旧文言が残っている');
  // green:true は tests:"passed"（全本 green）分岐の行にだけ現れ、failed / error 分岐は green:false
  const lines = prompt.split('\n');
  const greenTrueLines = lines.filter((l) => l.includes('green:true'));
  assert.equal(greenTrueLines.length, 1, `green:true を含む行は全本 green の分岐 1 行だけのはず: ${JSON.stringify(greenTrueLines)}`);
  assert.ok(greenTrueLines[0].includes('tests:"passed"'), `green:true が tests:"passed" 分岐以外に現れる: ${greenTrueLines[0]}`);
  for (const key of ['tests:"failed"', 'tests:"error"']) {
    const line = lines.find((l) => l.includes(key));
    assert.ok(line && line.includes('green:false') && !line.includes('green:true'), `${key} 分岐が green:false を返させていない: ${line}`);
  }
});

test('[validate-test-prompt] 一部のスクリプトだけ起動失敗した場合は tests:"error" 側、tests:"failed" は実行されたテストの失敗だけ（issue #720）', async () => {
  await ensureSharedRun();
  const lines = test1Prompt().split('\n');
  const errorLine = lines.find((l) => l.includes('tests:"error"'));
  const failedLine = lines.find((l) => l.includes('tests:"failed"'));
  assert.ok(errorLine && errorLine.includes('一部だけ起動失敗'), `一部起動失敗が tests:"error" 分岐に書かれていない: ${errorLine}`);
  assert.ok(failedLine && !failedLine.includes('起動失敗'), `tests:"failed" 分岐に起動失敗が混入している（green-fix が空回りし CI 委譲に入らない）: ${failedLine}`);
});

test('[validate-test-prompt] Final reconcile の test#final は Validate の test#1 と同一 prompt（issue #720）', async () => {
  const { ctx, calls } = makeRecordingSandbox(
    (c) => (c.label === 'reconcile-sync' ? { ok: true, head: 'a'.repeat(40) } : responder(c)),
    { args: devFlowArgs('553'), workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }) },
  );
  await runDevFlowInSandbox(devFlowSrc, ctx);
  const t1 = calls.find((x) => x.label === 'test#1');
  const tf = calls.find((x) => x.label === 'test#final');
  assert.ok(t1 && tf, `test#1 / test#final の call が揃っていない (labels: ${calls.map((x) => x.label).join(', ')})`);
  assert.equal(tf.prompt, t1.prompt, 'test#final の prompt が test#1 と一致しない（全 tests/run-*.sh 実行指示が Final reconcile に届かない）');
});

test('[validate-test-prompt] test#1 prompt は起動失敗を tests:"failed" に潰す旧文言を含まない（issue #619）', async () => {
  await ensureSharedRun();
  const prompt = test1Prompt();
  assert.ok(
    !prompt.includes('それでも失敗するなら tests:"failed"'),
    '起動失敗を tests:"failed" に潰す旧文言が test#1 prompt に残っている',
  );
});

// 起動失敗ルールの行（EPERM と原因調査禁止を含む行）。3 分岐の行（tests:"..." を含む行）とは別行
function startFailureRuleLine(prompt) {
  const line = prompt.split('\n').find((l) => l.includes('EPERM') && l.includes('原因調査をするな'));
  assert.ok(line, `test#1 prompt に起動失敗ルールの行（EPERM / 原因調査をするな）が無い:\n${prompt}`);
  return line;
}

test('[validate-test-prompt] 起動失敗ルールは tests/run-*.sh とフォールバック（npm test / pnpm test 等）の両経路に適用される（issue #732）', async () => {
  await ensureSharedRun();
  const rule = startFailureRuleLine(test1Prompt());
  assert.ok(rule.includes('tests/run-*.sh'), `起動失敗ルールが tests/run-*.sh 経路に言及していない: ${rule}`);
  assert.ok(rule.includes('フォールバック'), `起動失敗ルールがフォールバック経路に言及していない: ${rule}`);
  for (const cmd of ['npm test', 'pnpm test']) {
    assert.ok(rule.includes(cmd), `起動失敗ルールがフォールバックの ${cmd} を対象に含めていない: ${rule}`);
  }
  // フォールバックの test コマンドも 1 回だけ実行させ、起動失敗で打ち切らせる
  const fallbackSentence = rule.split('。').find((s) => s.includes('フォールバックの test コマンド'));
  assert.ok(
    fallbackSentence && fallbackSentence.includes('1 回だけ') && fallbackSentence.includes('起動失敗'),
    `フォールバックの test コマンドを 1 回だけ実行し起動失敗で打ち切る文が無い: ${fallbackSentence}`,
  );
});

test('[validate-test-prompt] 起動失敗時の 4 種の回避策（環境変数前置・runner 切替・ロック/キャッシュ/store 削除・再試行）を禁止する（issue #732）', async () => {
  await ensureSharedRun();
  const rule = startFailureRuleLine(test1Prompt());
  const prohibition = rule.split('。').find((s) => s.includes('起動失敗時は') && s.includes('禁止'));
  assert.ok(prohibition, `起動失敗時の禁止事項の文が無い: ${rule}`);
  assert.ok(
    prohibition.includes('環境変数前置') && prohibition.includes('PNPM_HOME'),
    `環境変数前置（PNPM_HOME 等）の禁止が無い: ${prohibition}`,
  );
  assert.ok(
    prohibition.includes('パッケージマネージャ') && prohibition.includes('test runner') && prohibition.includes('pnpm → npm'),
    `別のパッケージマネージャ / runner への切替禁止が無い: ${prohibition}`,
  );
  for (const w of ['ロック', 'キャッシュ', 'store', '削除', '移動']) {
    assert.ok(prohibition.includes(w), `ロック / キャッシュ / store の削除・移動の禁止に「${w}」が無い: ${prohibition}`);
  }
  assert.ok(prohibition.includes('同一コマンドの再試行'), `同一コマンドの再試行の禁止が無い: ${prohibition}`);
});

test('[validate-test-prompt] tests:"passed" / "failed" / "error" の 3 分岐の判定文言は変わらない（issue #732）', async () => {
  await ensureSharedRun();
  const branches = test1Prompt().split('\n').filter((l) => /tests:"(passed|failed|error)"/.test(l));
  assert.deepEqual(branches, [
    '- 実行したすべてのスクリプトが green → tests:"passed"、green:true（green:true はこの分岐でのみ返せ）',
    '- 実行されたテストが 1 件以上失敗したスクリプトが 1 本でもある → tests:"failed"、green:false、失敗したスクリプトごとの要約を summary に入れる',
    '- 失敗したテストは無いが、1 本以上のスクリプトが起動失敗した（全本起動失敗も一部だけ起動失敗も含む。EPERM / permission denied / パッケージマネージャや test runner が起動不能 / 依存未解決）→ tests:"error"、green:false、起動失敗したスクリプト名と失敗要約を summary に入れる',
  ]);
});
