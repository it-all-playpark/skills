// _lib/bin-bare-name-routing.test.mjs
// dev-flow 実行経路（.claude/workflows/*.js / _lib/*.mjs）から skills 実体固定の絶対パスを
// 全廃し、plugin bin/ 経由の bare 名（拡張子なし）呼び出しへ移行したことを pin する（issue #569）。
//
// AC1: 絶対パス literal が 0 箇所。
// AC2: workflow が使う call site が bare 名で配線されている。
// [first-token]: bash 前置の bare 名呼び出しや拡張子付き呼び出しの残存が無い。
// [bin]: workflow が使う bare 名は全て bin/ に存在し、bin/ は core 1 本 + dev-flow 22 本に分割一致する。
//
// AC1 の検査文字列自体が禁止パターンの literal を含むと自己矛盾するため、
// join() で組み立てる（_lib/*.mjs は本テストファイル自身も走査対象に含むため）。
//
// Run: npx vitest run _lib/bin-bare-name-routing.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowsDir = join(repoRoot, '.claude', 'workflows');
const libDir = join(repoRoot, '_lib');
const binDir = join(repoRoot, 'bin');

const ABS_TILDE = ['~/.claude', 'skills/'].join('/');
const ABS_HOME = ['$HOME/.claude', 'skills/'].join('/');

const BARE = [
  'cross-repo-artifacts',
  'detect-and-install',
  'diff-risk-classify',
  'ensure-worktree-deps',
  'redgreen-verify',
  'secfloor-classify',
  'structural-classify',
  'ui-verify-server',
  'veridelta-archive',
  'worktree-diff-hash',
  'worktree-teardown',
  'journal',
  'check-ci',
  'analyze-issue',
  'hypothesis-check',
  'analyze-dev-flow-telemetry',
  'detect-stack',
  'ac-lint',
  'run-diagnostics',
  'baseline-snapshot',
  'compare-baseline',
  'validate-canary-report',
  'trust-receipts-report',
];

function listFiles(dir, ext) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => join(dir, f));
}

const workflowFiles = listFiles(workflowsDir, '.js');
const libFiles = listFiles(libDir, '.mjs');

// ---- [AC1] .claude/workflows/*.js と _lib/*.mjs に skills 絶対パスが 0 箇所 ----

test('[bin-bare-name-routing][AC1] .claude/workflows/*.js に skills 絶対パスが 0 箇所', () => {
  for (const file of workflowFiles) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes(ABS_TILDE), `${file} に禁止パターン '${ABS_TILDE}' が残っている`);
    assert.ok(!src.includes(ABS_HOME), `${file} に禁止パターン '${ABS_HOME}' が残っている`);
  }
});

test('[bin-bare-name-routing][AC1] _lib/*.mjs に skills 絶対パスが 0 箇所', () => {
  for (const file of libFiles) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes(ABS_TILDE), `${file} に禁止パターン '${ABS_TILDE}' が残っている`);
    assert.ok(!src.includes(ABS_HOME), `${file} に禁止パターン '${ABS_HOME}' が残っている`);
  }
});

// ---- [AC2] 各 call site が bare 名で配線されている ----

const devFlowSrc = readFileSync(join(workflowsDir, 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(workflowsDir, 'pr-iterate.js'), 'utf8');
const devImproveSrc = readFileSync(join(workflowsDir, 'dev-improve.js'), 'utf8');

const DEV_FLOW_NEEDLES = [
  'ensure-worktree-deps --path ${worktree} --lockfile-only --skip-custom',
  'worktree-diff-hash ${WT} origin/${BASE}',
  'cross-repo-artifacts ${WT} ',
  'secfloor-classify ${WT} origin/${BASE}',
  'ui-verify-server start ',
  'ui-verify-server stop --state-dir',
  'redgreen-verify ${WT} ',
  'diff-risk-classify origin/${BASE}',
  '`check-ci --checks-data',
  '`analyze-issue ${ISSUE} --issue-json <ISSUE_JSON> --contract',
  '`detect-stack .',
];

for (const needle of DEV_FLOW_NEEDLES) {
  test(`[bin-bare-name-routing][AC2] dev-flow.js が '${needle}' を含む`, () => {
    assert.ok(devFlowSrc.includes(needle), `dev-flow.js に bare 名 call site '${needle}' が見つからない`);
  });
}

test("[bin-bare-name-routing][AC2] dev-flow.js の journal_sh: 'journal' がちょうど2回存在する", () => {
  const needle = "journal_sh: 'journal'";
  let count = 0;
  let idx = 0;
  while (true) {
    idx = devFlowSrc.indexOf(needle, idx);
    if (idx === -1) break;
    count += 1;
    idx += needle.length;
  }
  assert.equal(count, 2, `journal_sh: 'journal' の出現回数が期待(2)と異なる: ${count}`);
});

test("[bin-bare-name-routing][AC2] pr-iterate.js が '`check-ci --checks-data' を含む", () => {
  assert.ok(prIterateSrc.includes('`check-ci --checks-data'), "pr-iterate.js に bare 名 call site '`check-ci --checks-data' が見つからない");
});

const DEV_IMPROVE_NEEDLES = [
  '`hypothesis-check --metric',
  '`analyze-dev-flow-telemetry --window 30d',
  '`ac-lint <BODY_FILE>',
  '`journal log dev-improve',
];

for (const needle of DEV_IMPROVE_NEEDLES) {
  test(`[bin-bare-name-routing][AC2] dev-improve.js が '${needle}' を含む`, () => {
    assert.ok(devImproveSrc.includes(needle), `dev-improve.js に bare 名 call site '${needle}' が見つからない`);
  });
}

// ---- [first-token] bash 前置・.sh 拡張子残存が無い ----

const bashPrefixRe = new RegExp('\\bbash (' + BARE.join('|') + ')(\\s|`)');
const dotShRe = new RegExp('(' + BARE.join('|') + ')\\.sh (\\$\\{|origin/|--|start |stop |<)');

for (const [name, src] of [
  ['dev-flow.js', devFlowSrc],
  ['pr-iterate.js', prIterateSrc],
  ['dev-improve.js', devImproveSrc],
]) {
  test(`[bin-bare-name-routing][first-token] ${name} に bash 前置の bare 名呼び出しが残っていない`, () => {
    assert.doesNotMatch(src, bashPrefixRe, `${name} に 'bash <bare名>' 前置が残っている`);
  });
  test(`[bin-bare-name-routing][first-token] ${name} に .sh 拡張子付き呼び出しが残っていない`, () => {
    assert.doesNotMatch(src, dotShRe, `${name} に '<bare名>.sh' 拡張子付き呼び出しが残っている`);
  });
}

// ---- [bin] workflow が使う bare 名は全て bin/ に存在し、bin/ は core 1 本 + dev-flow 22 本に分割一致する ----

test('[bin-bare-name-routing][bin] plugins/dev-flow/bin は BARE から journal を除いた 22 名に完全一致する', () => {
  const actual = readdirSync(binDir).sort();
  const expected = BARE.filter((name) => name !== 'journal').sort();
  assert.deepEqual(actual, expected, `plugins/dev-flow/bin の内容が期待 22 名と一致しない: actual=${JSON.stringify(actual)}`);
});

test("[bin-bare-name-routing][bin] plugins/playpark-core/bin は ['journal'] に完全一致する", () => {
  const coreBinDir = join(repoRoot, '..', 'playpark-core', 'bin');
  const actual = readdirSync(coreBinDir).sort();
  assert.deepEqual(actual, ['journal'], `plugins/playpark-core/bin の内容が ['journal'] と一致しない: actual=${JSON.stringify(actual)}`);
});
