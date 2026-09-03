// _lib/priterate-fix-scrub-routing.test.mjs
// F2 (issue #503): pr-iterate.js の review finding -> fix prompt 経路（fix_loop、blocking
// findings）が _lib/review-finding-scrub.mjs の buildFixIssuesText を経由することを source-read
// で pin する。メタ指示（『今後の prompt には〜と書くな』等）を含む suggestion が無加工のまま
// fix agent への実行指示に混入しないことを静的に保証する（CI 経路は本 issue のスコープ外）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');
const src = readFileSync(prIteratePath, 'utf8');

// ---- (a): buildFixIssuesText の定義（inline 区間由来）と呼び出しの両方が存在する ----
test('[a] pr-iterate.js に buildFixIssuesText の定義と呼び出しが存在する', () => {
  assert.ok(
    /function\s+buildFixIssuesText\s*\(/.test(src),
    'pr-iterate.js に buildFixIssuesText の関数定義が見つからない（_lib/review-finding-scrub.mjs の inline 区間が未追加）',
  );
  assert.ok(
    src.includes('buildFixIssuesText(blocking)'),
    'pr-iterate.js に buildFixIssuesText(blocking) の呼び出しが見つからない',
  );
});

// fix_loop 経路の抽出: 'outcome.route === \'fix_loop\'' を含むコメント行から
// callFixAgent(fixPrompt までのソース区間を対象にする。
function extractFixLoopRegion(source) {
  const startMarker = source.indexOf("outcome.route === 'fix_loop'");
  assert.ok(startMarker !== -1, "ソース中に \"outcome.route === 'fix_loop'\" を含む行が見つからない");
  const endMarker = source.indexOf('callFixAgent(fixPrompt', startMarker);
  assert.ok(endMarker !== -1, 'fix_loop 区間内に callFixAgent(fixPrompt が見つからない');
  return source.slice(startMarker, endMarker + 'callFixAgent(fixPrompt'.length);
}

// ---- (b): fix_loop 区間内で issuesText が buildFixIssuesText(blocking) で構築されている ----
test('[b] fix_loop 経路の issuesText は buildFixIssuesText(blocking) で構築される', () => {
  const region = extractFixLoopRegion(src);
  assert.ok(
    /const\s+issuesText\s*=\s*buildFixIssuesText\(blocking\)/.test(region),
    `fix_loop 区間内に 'const issuesText = buildFixIssuesText(blocking)' が見つからない。区間: ${region.slice(0, 400)}`,
  );
});

// ---- (c): 同区間内に旧来の無加工テンプレートが存在しない ----
test('[c] fix_loop 区間内に旧来の無加工テンプレート（x.description/x.suggestion 直接連結）が残存しない', () => {
  const region = extractFixLoopRegion(src);
  assert.ok(
    !/\.map\(\(x\)\s*=>\s*`-\s*\[\$\{x\.severity\}\][^`]*\$\{x\.description\}/.test(region),
    `fix_loop 区間内に旧来の無加工テンプレートが残存している。区間: ${region.slice(0, 600)}`,
  );
  assert.ok(
    !region.includes('${x.description}${x.suggestion'),
    `fix_loop 区間内に旧来の無加工連結パターンが残存している。区間: ${region.slice(0, 600)}`,
  );
});

// (d): CI 経路（ciFixPrompt 側）の issuesText は本 issue のスコープ外なので意図的に assert しない。
