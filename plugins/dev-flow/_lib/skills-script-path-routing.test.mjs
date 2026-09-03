// _lib/skills-script-path-routing.test.mjs
// Pin test: skills 内部 script のパス解決を固定する（issue #484 task F1）。
//
// `.claude/workflows/dev-flow.js` は、skills リポジトリ（it-all-playpark/skills）内部にのみ
// 存在する script 群（analyze-issue.sh / journal.sh）を
// `${WT}/...`（WT=対象repoのworktree）相対で subagent prompt / journal handoff payload に
// 埋め込んでいた。対象 repo が skills 自身でない場合（例: veridelta）にこれらの script は WT 配下に
// 存在せず Exit 127 で落ちる。修正後の期待状態は plugin bin/ の bare 名（issue #569）を使うこと
// である。この test は修正後の期待状態を固定する。
//
// .claude/workflows/*.js はランタイム注入 global を使うため ESM import できない。
// よって既存 *-routing.test.mjs 群と同じ戦略（source-as-string assert）で検証する。
//
// Run: npx vitest run _lib/skills-script-path-routing.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while (true) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count += 1;
    idx += needle.length;
  }
  return count;
}

// ---- (a) 禁止パターン不在: WT 相対で skills 内部 script を呼んではならない ----

test('[skills-script-path-routing] (a) dev-flow.js に `${WT}/dev-issue-analyze/` が残っていない', () => {
  assert.ok(
    !src.includes('${WT}/dev-issue-analyze/'),
    'dev-flow.js に禁止パターン `${WT}/dev-issue-analyze/` が残っている（対象repoがskills以外だとExit 127）',
  );
});

test('[skills-script-path-routing] (a) dev-flow.js に `${WT}/skill-retrospective/` が残っていない', () => {
  assert.ok(
    !src.includes('${WT}/skill-retrospective/'),
    'dev-flow.js に禁止パターン `${WT}/skill-retrospective/` が残っている（対象repoがskills以外だとExit 127）',
  );
});

// ---- (b) 固定パス存在（出現回数込み）----

test('[skills-script-path-routing] (b) analyze-issue が bare 名で1回存在する', () => {
  const needle = 'analyze-issue ${ISSUE} --issue-json <ISSUE_JSON> --contract';
  const count = countOccurrences(src, needle);
  assert.equal(count, 1, `bare 名呼び出し '${needle}' の出現回数が期待(1)と異なる: ${count}`);
});

test("[skills-script-path-routing] (b) journal_sh が bare 名 'journal' で2回存在する", () => {
  const needle = "journal_sh: 'journal'";
  const count = countOccurrences(src, needle);
  assert.equal(count, 2, `bare 名 '${needle}' の出現回数が期待(2)と異なる: ${count}`);
});

// ---- (c) 負の対照（誤爆防止）: 対象repo自身のファイルを指す WT 相対パスは修正対象外 ----

test('[skills-script-path-routing] (c) `${WT}/tests/run-tests.sh`（対象repoのテストランナー）は残っている', () => {
  assert.ok(
    src.includes('${WT}/tests/run-tests.sh'),
    '`${WT}/tests/run-tests.sh` が見つからない（修正対象外の WT 相対パスまで誤って書き換えた可能性）',
  );
});
