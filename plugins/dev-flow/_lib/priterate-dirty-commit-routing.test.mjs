// F3: pr-iterate の終端 dirty 検出（AC-2）と fix 適用直後の commit 保証（AC-3）の routing test（issue #437）
//   - fix 適用（applied:true）直後、ensure-committed.sh を exec-proxy で実行し worktree の未コミット変更を
//     検証する。dirty:false は no-op で継続、dirty:true で commit+push が成功すれば継続（回収カウンタ加算）、
//     null/schema 不一致/回収失敗（committed&&pushed でない）は fail-safe で terminal:'fix_failed'。
//   - status !== 'lgtm' の終端でのみ、worktree-dirty-check（--check-only）の advisory probe を実行する。
//     probe 失敗は fail-open（'unknown' + 警告のみ）。lgtm 終端では probe しない（agent 呼び出し追加ゼロ）。
//
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / runWorkflowCapture。round 系 call の応答だけを
// buildAgentStub の rounds で返し、それ以外は pr-iterate 単体起動の既定 responder に任せる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

/** buildAgentStub の戻り値（rounds と記録先 agentCalls）から pr-iterate.js の vm context を作る。 */
function makeSandbox({ rounds, agentCalls }) {
  return makePrIterateSandbox({ rounds, calls: agentCalls }).ctx;
}

const runPrIterate = (ctx) => runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');

function assertNoSandboxCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

/**
 * round 系 call の応答を label で分岐する rounds と、呼び出しの記録先 agentCalls を返す。
 * reviewerStub(label) -> review result（pr-reviewer 呼び出しごとに呼ばれる）
 * ciStub(label) -> CI status result（省略時は常に passed）
 * fixStub(label) -> fix result（省略時は常に applied:true）
 * commitEnsureStub(label) -> commit-ensure（--pr --iteration）result（省略時は { dirty: false, committed: false, pushed: false }）
 * dirtyCheckStub(label) -> worktree-dirty-check（--check-only）result（省略時は未 stub 扱い＝null、fail-open）
 */
function buildAgentStub({ reviewerStub, ciStub, fixStub, commitEnsureStub, dirtyCheckStub, agentCalls }) {
  const rounds = ({ label, agentType, prompt }) => {
    if (agentType === 'dev-flow:pr-reviewer') {
      return reviewerStub(label);
    }
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && prompt.includes('check-ci --checks-data')) {
      return ciStub ? ciStub(label) : { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] };
    }
    if (label.startsWith('fix#')) {
      return fixStub ? fixStub(label) : { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('commit-ensure#')) {
      return commitEnsureStub ? commitEnsureStub(label) : { dirty: false, committed: false, pushed: false };
    }
    if (label === 'worktree-dirty-check') {
      return dirtyCheckStub ? dirtyCheckStub(label) : null;
    }
    return undefined;
  };
  return { rounds, agentCalls };
}

// ---- D1 [AC-3]: commit-ensure が dirty:false（正常ケース）-> no-op で継続、lgtm ----
test('[D1][AC-3] fix applied:true + commit-ensure dirty:false -> commit-ensure#1 が --pr --iteration 1 で呼ばれ、no-op で lgtm', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const commitEnsureCalls = agentCalls.filter((c) => c.label.startsWith('commit-ensure#'));
  assert.equal(commitEnsureCalls.length, 1, `commit-ensure# は 1 回であるべきだが ${commitEnsureCalls.length} 回だった`);
  const commitEnsurePrompt = commitEnsureCalls[0].prompt;
  assert.ok(
    commitEnsurePrompt.includes('git') && commitEnsurePrompt.includes('status --porcelain'),
    `commit-ensure#1 の prompt に 'git' と 'status --porcelain' を含むべき。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`,
  );
  assert.ok(
    commitEnsurePrompt.includes('fix(pr-5)'),
    `commit-ensure#1 の prompt に 'fix(pr-5)' コミットメッセージを含むべき。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`,
  );
  for (const forbidden of ['ensure-committed.sh', ['~/.claude', 'skills'].join('/'), 'sandbox', 'excludedCommands']) {
    assert.ok(
      !commitEnsurePrompt.includes(forbidden),
      `commit-ensure#1 の prompt は '${forbidden}' を含んではならない。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`,
    );
  }
  // add / commit / push は cwd で実行する bare 単文。worktree は upstream を持たない（起動元 repo の .git/config は
  // sandbox 内から書けない）ので、push は remote と HEAD を明示し、push 済みの判定は origin/<head_ref> と比べる
  const gitCmds = commitEnsurePrompt.match(/`git [^`]*`/g) ?? [];
  assert.ok(
    gitCmds.includes('`git add -A`') && commitEnsurePrompt.includes('`git commit -m "fix(pr-5)')
      && gitCmds.includes('`git push origin HEAD`'),
    `commit-ensure#1 の prompt は bare \`git add -A\` / \`git commit\` / \`git push origin HEAD\` を含むべき: ${gitCmds.join(' | ')}`,
  );
  assert.deepEqual([...new Set(gitCmds.filter((c) => c.includes(' push')))], ['`git push origin HEAD`'],
    `commit-ensure#1 の push は \`git push origin HEAD\` だけ（-u を付けない）: ${gitCmds.join(' | ')}`);
  assert.ok(
    commitEnsurePrompt.includes('`git -C /tmp/wt rev-list "origin/feature/x"..HEAD --count`'),
    `commit-ensure#1 の push 済み判定は origin/<head_ref> と比べるべき: ${gitCmds.join(' | ')}`,
  );

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 0, `fix_uncommitted_recovered は 0 であるべきだが ${result?.fix_uncommitted_recovered} だった`);
});

// ---- D2 [AC-3 回収]: commit-ensure が dirty:true+committed+pushed -> 継続して lgtm、回収カウンタ加算 ----
test('[D2][AC-3 回収] commit-ensure dirty:true+committed:true+pushed:true -> 継続して lgtm、fix_uncommitted_recovered=1', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const commitEnsureStub = () => ({ dirty: true, committed: true, pushed: true });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 1, `fix_uncommitted_recovered は 1 であるべきだが ${result?.fix_uncommitted_recovered} だった`);
});

// ---- D3 [AC-3 fail-safe]: commit-ensure が null -> fix_failed、review#2 は呼ばれない ----
test('[D3][AC-3 fail-safe] commit-ensure が null -> status:fix_failed、review#2 は呼ばれない（pr-reviewer 呼び出し1回）', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    throw new Error(`unexpected pr-reviewer label (review#2 should not run): ${label}`);
  };
  const commitEnsureStub = () => null;
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.equal(reviewerCalls.length, 1, `pr-reviewer 呼び出しは 1 回であるべきだが ${reviewerCalls.length} 回だった`);
  assert.equal(result?.status, 'fix_failed', `result.status は fix_failed であるべきだが '${result?.status}' だった`);
});

// ---- D4 [AC-3 fail-safe]: commit-ensure が dirty:true+committed:true+pushed:false（push 失敗）-> fix_failed ----
test('[D4][AC-3 fail-safe] commit-ensure dirty:true+committed:true+pushed:false -> status:fix_failed', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const commitEnsureStub = () => ({ dirty: true, committed: true, pushed: false });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'fix_failed', `result.status は fix_failed であるべきだが '${result?.status}' だった`);
});

// ---- D5 [AC-2]: stuck 終端 + worktree-dirty-check dirty:true -> result.worktree_dirty='dirty' ----
test('[D5][AC-2] stuck 終端 + worktree-dirty-check dirty:true -> result.worktree_dirty=dirty', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const dirtyCheckStub = () => ({ dirty: true, files: 2 });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, dirtyCheckStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `result.status は stuck であるべきだが '${result?.status}' だった`);
  assert.equal(result?.worktree_dirty, 'dirty', `result.worktree_dirty は dirty であるべきだが '${result?.worktree_dirty}' だった`);
  assert.equal(agentCalls.filter((c) => c.label === 'worktree-dirty-check').length, 1, 'stuck 終端では worktree-dirty-check が 1 回呼ばれるべき');
});

// ---- D6 [AC-2 fail-open]: stuck 終端 + worktree-dirty-check probe が null -> worktree_dirty='unknown'、落ちない ----
test('[D6][AC-2 fail-open] stuck 終端 + worktree-dirty-check probe が null -> status:stuck（落ちない）、worktree_dirty=unknown', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const dirtyCheckStub = () => null;
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, dirtyCheckStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `result.status は stuck であるべきだが '${result?.status}' だった`);
  assert.equal(result?.worktree_dirty, 'unknown', `result.worktree_dirty は unknown であるべきだが '${result?.worktree_dirty}' だった`);
});

// ---- D7 [AC-2 lgtm 非実施]: 正常 lgtm 経路 -> worktree-dirty-check は呼ばれず、worktree_dirty=null ----
test('[D7][AC-2 lgtm 非実施] 正常 lgtm 経路 -> worktree-dirty-check 呼び出し0回、result.worktree_dirty=null', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);

  const dirtyCheckCalls = agentCalls.filter((c) => c.label === 'worktree-dirty-check');
  assert.equal(dirtyCheckCalls.length, 0, `worktree-dirty-check の呼び出しは 0 回であるべきだが ${dirtyCheckCalls.length} 回だった`);
  assert.equal(result?.worktree_dirty, null, `result.worktree_dirty は null であるべきだが '${result?.worktree_dirty}' だった`);
});

// ---- D8〜D11 (issue #742): git status --porcelain の dirty 判定は porcelain 行の有無で行う ----
// sandbox 内では読めないファイル（.env.example 等）について git が `<path>: Operation not permitted` を
// stderr に出し、agent の Bash 出力では stdout と混ざる。「出力が空か」で判定すると警告行だけの clean な
// worktree を dirty と読み、commit-ensure が fix_failed で終端する。

function stepLine(prompt, n) {
  const m = prompt.match(new RegExp(`(?:^|\\n)${n}\\. ([^\\n]*)`));
  return m ? m[1] : '';
}

function assertPorcelainRule(prompt, where) {
  assert.ok(prompt.includes('porcelain 行'), `${where} の prompt は porcelain 行で判定すべき: ${prompt.slice(0, 600)}`);
  assert.ok(
    prompt.includes('先頭 2 文字が状態コード') && prompt.includes('3 文字目が空白'),
    `${where} の prompt は porcelain 行の形（先頭 2 文字が状態コード＋空白）を明記すべき: ${prompt.slice(0, 600)}`,
  );
  assert.ok(
    prompt.includes('Operation not permitted') && prompt.includes('数えない'),
    `${where} の prompt は \`: Operation not permitted\` 等の警告行を数えないと明記すべき: ${prompt.slice(0, 600)}`,
  );
  assert.ok(
    /警告行だけが出ていて porcelain 行が 0 行なら[^。]*clean/.test(prompt),
    `${where} の prompt は警告行だけのとき clean と明記すべき: ${prompt.slice(0, 600)}`,
  );
  assert.ok(
    /porcelain 行が 1 行以上あれば[^。]*dirty/.test(prompt),
    `${where} の prompt は porcelain 行が 1 行以上なら dirty と明記すべき: ${prompt.slice(0, 600)}`,
  );
  assert.ok(
    /exit 非0[^。]*dirty/.test(prompt),
    `${where} の prompt は exit 非0 を dirty 側に倒すべき（fail-safe）: ${prompt.slice(0, 600)}`,
  );
  for (const forbidden of ['出力が空なら', '出力が空でなければ', '出力が非空なら', '非空行数']) {
    assert.ok(!prompt.includes(forbidden), `${where} の prompt に「${forbidden}」基準が残っている: ${prompt.slice(0, 600)}`);
  }
}

test('[D8][#742 AC-3] commit-ensure prompt: 手順 1 / 3 の dirty 判定が porcelain 行の有無で、警告行は数えない', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const { error } = await runPrIterate(makeSandbox(agentStub));
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const prompt = agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '';
  assertPorcelainRule(prompt, 'commit-ensure#1');
  const s1 = stepLine(prompt, 1);
  const s2 = stepLine(prompt, 2);
  const s3 = stepLine(prompt, 3);
  assert.ok(
    s1.includes('status --porcelain') && /porcelain 行が 0 行[^。]*dirty:false/.test(s1),
    `手順 1 は porcelain 行 0 行で dirty:false とすべき: ${s1}`,
  );
  assert.ok(
    /porcelain 行が 1 行以上/.test(s2) && s2.includes('dirty:true') && s2.includes('`git add -A`'),
    `手順 2 は porcelain 行 1 行以上で dirty:true とし commit/push で回収すべき: ${s2}`,
  );
  assert.ok(
    s3.includes('status --porcelain') && s3.includes('手順 1 と同じ判定基準')
      && /porcelain 行が 0 行[^。]*committed:true/.test(s3) && /dirty なら committed:false/.test(s3),
    `手順 3 は手順 1 と同じ基準で committed を判定すべき: ${s3}`,
  );
  // commit-ensure の prompt は sandbox 回避の指示と読まれないよう 'sandbox' を含めない（D1 と同じ制約）
  assert.ok(!prompt.includes('sandbox'), 'commit-ensure#1 の prompt は sandbox を含んではならない');
});

test('[D9][#742 AC-1] 警告行だけの clean worktree（commit-ensure dirty:false）-> review#2 に進み lgtm、fix_failed にしない', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const fixStub = () => ({ applied: true, summary: 'PR 本文を追記', files: [] });
  const agentStub = buildAgentStub({ reviewerStub, fixStub, commitEnsureStub, agentCalls });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewLabels = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer').map((c) => c.label);
  assert.ok(reviewLabels.includes('review#2'), `review#2 に進むべきだが review 呼び出しは ${JSON.stringify(reviewLabels)}`);
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 0);
});

test('[D10][#742 AC-2 fail-safe] porcelain 行が残り回収できない（dirty:true+committed:false）-> fix_failed、review#2 は呼ばれない', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    throw new Error(`unexpected pr-reviewer label (review#2 should not run): ${label}`);
  };
  const commitEnsureStub = () => ({ dirty: true, committed: false, pushed: true });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.equal(reviewerCalls.length, 1, `pr-reviewer 呼び出しは 1 回であるべきだが ${reviewerCalls.length} 回だった`);
  assert.equal(result?.status, 'fix_failed', `result.status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 0);
});

test('[D11][#742 AC-3] 終端の worktree-dirty-check prompt も porcelain 行の有無で判定し、files は porcelain 行数', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const dirtyCheckStub = () => ({ dirty: false, files: 0 });
  const agentStub = buildAgentStub({ reviewerStub, dirtyCheckStub, agentCalls });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `result.status は stuck であるべきだが '${result?.status}' だった`);
  assert.equal(result?.worktree_dirty, 'clean');
  const prompt = agentCalls.find((c) => c.label === 'worktree-dirty-check')?.prompt ?? '';
  assertPorcelainRule(prompt, 'worktree-dirty-check');
  assert.ok(prompt.includes('<porcelain 行の行数>'), `files は porcelain 行の行数を返すべき: ${prompt.slice(0, 600)}`);
});
