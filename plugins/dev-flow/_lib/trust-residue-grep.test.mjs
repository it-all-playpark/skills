// repo 全体 grep pin テスト（issue #553 AC-6）。
// 'trust-test-latest' / 'trust-risk' の書き手（VALIDATE_TEST_PROMPT 等の証跡保存指示）が
// 復活したら fail する静的 pin。走査は git 管理対象パスに限定する（`git ls-files`（tracked）+
// `git ls-files --others --exclude-standard`（gitignore 未対象の untracked）の合算、
// claudedocs/ 配下は明示除外）。tracked のみ（`git ls-files` 単体）にすると、dev-flow の
// implementer は git add/commit を行わない運用（commit は PR phase）のため、本 issue 自身が
// 追加する新規ファイル（本ファイル・_lib/validate-test-prompt.test.mjs）が commit 前の
// Validate phase では untracked のまま残り、tracked-only 走査では常に検出漏れて whitelist と
// 一致せず fail する（自己言及的な False failure）。untracked 側も対象にすることで
// commit 前後どちらでも同じ検出結果になる。claudedocs/ を明示除外するのは、session ログ等の
// ローカル生成物（gitignore 対象外）が将来これらの語を含んでも無関係な flake にしないため。
//
// whitelist 選定基準: 以下 3 ファイルはいずれも「書込の負 pin / 検索パターンそのもの」であり
// 生産側の書き手ではないため許容する。
//   - _lib/isolation-probe-wiring.test.mjs: Setup worktree prompt が
//     trust-test-latest.json / trust-risk- を含まないことを assert.doesNotMatch で検査する
//     負 assert 2 行が、リテラルとして両語を含む。
//   - _lib/validate-test-prompt.test.mjs: VALIDATE_TEST_PROMPT が trust-test-latest を
//     含まないことを assert.doesNotMatch で検査する負 assert が、リテラルとして同語を含む。
//   - _lib/trust-residue-grep.test.mjs: 本ファイル自身。検索パターン（正規表現リテラル）と
//     このコメントが両語を含む。
// whitelist を安易に広げるな — 新たにここへ追加する前に、その出現が「読み手のいない書込の
// 復活」ではなく上記と同種の「書込の負 pin / 検索パターン」であることを確認せよ。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const WHITELIST = [
  '_lib/isolation-probe-wiring.test.mjs',
  '_lib/trust-residue-grep.test.mjs',
  '_lib/validate-test-prompt.test.mjs',
];

const RESIDUE_PATTERN = /trust-test-latest|trust-risk/;

function listScanFiles() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const untracked = execFileSync(
    'git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' },
  ).split('\0').filter(Boolean);
  const all = new Set([...tracked, ...untracked]);
  return [...all].filter((relPath) => !relPath.startsWith('claudedocs/'));
}

function findResidueHits() {
  const hits = [];
  for (const relPath of listScanFiles()) {
    let content;
    try {
      content = readFileSync(join(repoRoot, relPath), 'utf8');
    } catch {
      // 削除済み tracked ファイル・binary ファイルは skip
      continue;
    }
    if (RESIDUE_PATTERN.test(content)) {
      hits.push(relPath);
    }
  }
  return hits;
}

test('trust-test-latest / trust-risk の出現は whitelist 3 ファイルのみ', () => {
  const hits = findResidueHits();
  assert.deepStrictEqual(hits.sort(), [...WHITELIST].sort());
});
