import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  hasCrossRepoLabel,
  crossRepoCandidatePaths,
  summarizeCrossRepoArtifacts,
  crossRepoReturnNote,
} from './cross-repo-gate.mjs';

// ── hasCrossRepoLabel ───────────────────────────────────────────────────────

test('hasCrossRepoLabel: 文字列配列に cross-repo が含まれれば true', () => {
  assert.equal(hasCrossRepoLabel(['bug', 'cross-repo']), true);
});

test('hasCrossRepoLabel: {name} オブジェクト配列（gh --json labels の生形式）でも true', () => {
  assert.equal(hasCrossRepoLabel([{ name: 'bug' }, { name: 'cross-repo' }]), true);
});

test('hasCrossRepoLabel: 空配列は false', () => {
  assert.equal(hasCrossRepoLabel([]), false);
});

test('hasCrossRepoLabel: null は false', () => {
  assert.equal(hasCrossRepoLabel(null), false);
});

test('hasCrossRepoLabel: 非配列は false', () => {
  assert.equal(hasCrossRepoLabel({ name: 'cross-repo' }), false);
  assert.equal(hasCrossRepoLabel(undefined), false);
  assert.equal(hasCrossRepoLabel('cross-repo'), false);
});

test('hasCrossRepoLabel: 部分一致 (cross-repo-x) は false（厳密一致のみ）', () => {
  assert.equal(hasCrossRepoLabel(['cross-repo-x']), false);
  assert.equal(hasCrossRepoLabel([{ name: 'cross-repo-x' }]), false);
});

test('hasCrossRepoLabel: 一致するラベルが無ければ false', () => {
  assert.equal(hasCrossRepoLabel(['bug', 'enhancement']), false);
});

// ── crossRepoCandidatePaths ─────────────────────────────────────────────────

const worktree = '/Users/x/ghq/github.com/o/r/.claude/worktrees/df-432';

test('crossRepoCandidatePaths: worktree 配下のパスは除外される', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: [`${worktree}/_lib/foo.mjs`, '/Users/x/other-repo/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ['/Users/x/other-repo/bar.ts']);
});

test('crossRepoCandidatePaths: ~/ 開始のパスは許容される', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: ['~/other-repo/baz.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ['~/other-repo/baz.ts']);
});

test('crossRepoCandidatePaths: 相対パスは除外される', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: ['src/foo.ts', '../sibling/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, []);
});

test('crossRepoCandidatePaths: BLOCKED task の files は除外される', () => {
  const implResults = [
    { status: 'BLOCKED', task_id: 'F1', files: ['/Users/x/other-repo/bar.ts'] },
    { status: 'DONE', task_id: 'F2', files: ['/Users/x/other-repo/baz.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ['/Users/x/other-repo/baz.ts']);
});

test('crossRepoCandidatePaths: NEEDS_CONTEXT task の files も除外される（DONE/DONE_WITH_CONCERNS 以外）', () => {
  const implResults = [
    { status: 'NEEDS_CONTEXT', task_id: 'F1', files: ['/Users/x/other-repo/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, []);
});

test('crossRepoCandidatePaths: DONE_WITH_CONCERNS も対象に含まれる', () => {
  const implResults = [
    { status: 'DONE_WITH_CONCERNS', task_id: 'F1', files: ['/Users/x/other-repo/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ['/Users/x/other-repo/bar.ts']);
});

test('crossRepoCandidatePaths: .devflow-tmp/ を含むパスは除外される', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: ['/Users/x/other-repo/.devflow-tmp/scratch.md', '/Users/x/other-repo/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ['/Users/x/other-repo/bar.ts']);
});

test('crossRepoCandidatePaths: 重複は排除される', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: ['/Users/x/other-repo/bar.ts'] },
    { status: 'DONE', task_id: 'F2', files: ['/Users/x/other-repo/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ['/Users/x/other-repo/bar.ts']);
});

test('crossRepoCandidatePaths: 最大 50 件に cap される', () => {
  const files = Array.from({ length: 60 }, (_, i) => `/Users/x/other-repo/file-${i}.ts`);
  const implResults = [{ status: 'DONE', task_id: 'F1', files }];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.equal(paths.length, 50);
});

test('crossRepoCandidatePaths: implResults が null なら空配列', () => {
  assert.deepEqual(crossRepoCandidatePaths(null, worktree), []);
});

test('crossRepoCandidatePaths: implResults が非配列なら空配列', () => {
  assert.deepEqual(crossRepoCandidatePaths({}, worktree), []);
});

test('crossRepoCandidatePaths: files が非配列の要素は無視される', () => {
  const implResults = [{ status: 'DONE', task_id: 'F1', files: null }];
  assert.deepEqual(crossRepoCandidatePaths(implResults, worktree), []);
});

test('crossRepoCandidatePaths: worktree 末尾スラッシュありでも前方一致で除外される', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: [`${worktree}/foo.ts`, '/Users/x/other-repo/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, `${worktree}/`);
  assert.deepEqual(paths, ['/Users/x/other-repo/bar.ts']);
});

test('crossRepoCandidatePaths: 単一引用符を含むパスは除外される（shell quoting breakout 防止, PR #434）', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: ["/Users/x/other-repo/'; rm -rf /; echo '.ts", '/Users/x/other-repo/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ['/Users/x/other-repo/bar.ts']);
});

test('crossRepoCandidatePaths: 改行を含むパスは除外される（コマンド行注入防止, PR #434）', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: ['/Users/x/other-repo/foo\nrm -rf /.ts', '/Users/x/other-repo/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ['/Users/x/other-repo/bar.ts']);
});

test('crossRepoCandidatePaths: 制御文字（NUL等）を含むパスは除外される（PR #434）', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: ['/Users/x/other-repo/foo\x00.ts', '/Users/x/other-repo/bar.ts'] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ['/Users/x/other-repo/bar.ts']);
});

test('crossRepoCandidatePaths: 危険文字を含まない通常パスは影響を受けない', () => {
  const implResults = [
    { status: 'DONE', task_id: 'F1', files: ["/Users/x/other-repo/file (copy).ts"] },
  ];
  const paths = crossRepoCandidatePaths(implResults, worktree);
  assert.deepEqual(paths, ["/Users/x/other-repo/file (copy).ts"]);
});

// ── summarizeCrossRepoArtifacts ──────────────────────────────────────────────

test('summarizeCrossRepoArtifacts: found>=1 かつ ok:true で handoff true', () => {
  const res = { ok: true, found: 2, artifacts: [{ repo_root: '/x/other-repo', dirty: true }] };
  const summary = summarizeCrossRepoArtifacts(res);
  assert.equal(summary.handoff, true);
  assert.equal(summary.found, 2);
  assert.deepEqual(summary.artifacts, [{ repo_root: '/x/other-repo', dirty: true }]);
});

test('summarizeCrossRepoArtifacts: found=0 は handoff false', () => {
  const res = { ok: true, found: 0, artifacts: [] };
  const summary = summarizeCrossRepoArtifacts(res);
  assert.equal(summary.handoff, false);
  assert.equal(summary.found, 0);
});

test('summarizeCrossRepoArtifacts: null は fail-safe で handoff false, found 0, artifacts []', () => {
  const summary = summarizeCrossRepoArtifacts(null);
  assert.deepEqual(summary, { handoff: false, found: 0, artifacts: [] });
});

test('summarizeCrossRepoArtifacts: ok:false は handoff false', () => {
  const summary = summarizeCrossRepoArtifacts({ ok: false, found: 3, artifacts: [] });
  assert.equal(summary.handoff, false);
  assert.equal(summary.found, 0);
});

test('summarizeCrossRepoArtifacts: found フィールド欠落（schema 不一致）は handoff false', () => {
  const summary = summarizeCrossRepoArtifacts({ ok: true, artifacts: [] });
  assert.equal(summary.handoff, false);
  assert.equal(summary.found, 0);
});

test('summarizeCrossRepoArtifacts: found が数値でない場合も handoff false', () => {
  const summary = summarizeCrossRepoArtifacts({ ok: true, found: '2', artifacts: [] });
  assert.equal(summary.handoff, false);
});

test('summarizeCrossRepoArtifacts: artifacts が配列でなければ空配列に正規化される', () => {
  const summary = summarizeCrossRepoArtifacts({ ok: true, found: 1, artifacts: null });
  assert.deepEqual(summary.artifacts, []);
});

// ── crossRepoReturnNote ──────────────────────────────────────────────────────

test('crossRepoReturnNote: dirty な artifact の path・repo_root と手動 commit/PR 化の趣旨を含む', () => {
  const note = crossRepoReturnNote([
    { path: '/Users/x/other-repo/src/a.ts', repo_root: '/Users/x/other-repo', dirty: true },
    { path: '/Users/x/clean-repo/src/b.ts', repo_root: '/Users/x/clean-repo', dirty: false },
  ]);
  assert.match(note, /別リポジトリ/);
  assert.match(note, /手動/);
  assert.match(note, /commit/);
  assert.match(note, /\/Users\/x\/other-repo\/src\/a\.ts/);
  assert.match(note, /\/Users\/x\/other-repo/);
  assert.doesNotMatch(note, /\/Users\/x\/clean-repo/);
});

test('crossRepoReturnNote: artifacts 空なら空一覧の定型文を返す', () => {
  const note = crossRepoReturnNote([]);
  assert.equal(typeof note, 'string');
  assert.match(note, /別リポジトリ/);
});

test('crossRepoReturnNote: artifacts 空の返り値は現行の定型文と完全一致する', () => {
  const note = crossRepoReturnNote([]);
  const header = '実装成果は本 repo の worktree ではなく別リポジトリの working tree に存在する'
    + '（cross-repo issue）。以下のファイルを手動で commit / PR 化すること。'
    + '放置すると成果物が失われる。';
  assert.equal(note, `${header}\n対象リポジトリ: なし（成果物は検出されなかった）`);
});

test('crossRepoReturnNote: 放置すると成果物が失われる旨に言及する', () => {
  const note = crossRepoReturnNote([{ repo_root: '/x/r', dirty: true }]);
  assert.match(note, /放置/);
  assert.match(note, /失われる/);
});

test('crossRepoReturnNote: null artifacts は空配列相当として扱われる', () => {
  const note = crossRepoReturnNote(null);
  assert.equal(typeof note, 'string');
});

test('crossRepoReturnNote: path 欠落の dirty artifact でも throw せず repo_root を含み undefined を含まない', () => {
  const note = crossRepoReturnNote([{ repo_root: '/x/r', dirty: true }]);
  assert.match(note, /\/x\/r/);
  assert.doesNotMatch(note, /undefined/);
});

test('crossRepoReturnNote: dirty artifact ありの場合は git add -A への注意書きを含む', () => {
  const note = crossRepoReturnNote([{ path: '/x/r/a.ts', repo_root: '/x/r', dirty: true }]);
  assert.match(note, /git add -A/);
});
