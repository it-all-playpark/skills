// _lib/diffhash-prompt-contract.test.mjs
// Pin test: dhPrompt（diff-hash exec-proxy prompt）の bare 単文 / argv 転写契約を固定する
// （issue #606 task F2）。
//
// dhPrompt は dev-runner-haiku-ro へ渡す prompt で、`worktree-diff-hash ${WT} origin/${BASE}` を
// 実行させ stdout の JSON 1 行を verbatim で返させる。ci-check prompt（同ファイル内
// `を gh を先頭トークンとする bare 単文で実行せよ`）と同水準の bare 単文 / argv 転写契約が
// 入っていることをここで pin する。
//
// dhPrompt は `.claude/workflows/dev-flow.js` の inline 生成区間の外にある
// （直前のマーカーは `// ==== END inline: _lib/cross-repo-gate.mjs ====`）ため直接編集する。
//
// .claude/workflows/*.js はランタイム注入 global を使うため ESM import できない。
// よって既存 *-routing.test.mjs 群と同じ戦略（source-as-string assert）で検証する。
//
// Run: npx vitest run _lib/diffhash-prompt-contract.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

const start = src.indexOf('const dhPrompt = ');
const end = src.indexOf('state.dhPrompt = dhPrompt', start);

test('[diffhash-prompt-contract] dhPrompt ブロックの開始・終了マーカーが両方見つかる', () => {
  assert.ok(start >= 0, '`const dhPrompt = ` が dev-flow.js に見つからない');
  assert.ok(end >= 0, '`state.dhPrompt = dhPrompt` が dev-flow.js に見つからない');
});

const block = src.slice(start, end);

// ---- (a) bare 単文契約 ----

test('[diffhash-prompt-contract] (a) block に "bare 単文" が含まれる', () => {
  assert.ok(block.includes('bare 単文'), 'dhPrompt ブロックに "bare 単文" が見つからない');
});

test('[diffhash-prompt-contract] (a) block に "先頭トークンが worktree-diff-hash" が含まれる', () => {
  assert.ok(
    block.includes('先頭トークンが worktree-diff-hash'),
    'dhPrompt ブロックに "先頭トークンが worktree-diff-hash" が見つからない',
  );
});

// ---- (b) which による絶対パス解決の禁止 ----

test('[diffhash-prompt-contract] (b) block に "which による絶対パス解決" が含まれる', () => {
  assert.ok(
    block.includes('which による絶対パス解決'),
    'dhPrompt ブロックに "which による絶対パス解決" が見つからない',
  );
});

// ---- (c) 禁止する前置・連結パターン ----

test('[diffhash-prompt-contract] (c) block に "cd 前置" が含まれる', () => {
  assert.ok(block.includes('cd 前置'), 'dhPrompt ブロックに "cd 前置" が見つからない');
});

test('[diffhash-prompt-contract] (c) block に "環境変数代入前置" が含まれる', () => {
  assert.ok(block.includes('環境変数代入前置'), 'dhPrompt ブロックに "環境変数代入前置" が見つからない');
});

test('[diffhash-prompt-contract] (c) block に "&& 連結" が含まれる', () => {
  assert.ok(block.includes('&& 連結'), 'dhPrompt ブロックに "&& 連結" が見つからない');
});

// ---- (d) 理由: verbatim 転写の破壊 ----

test('[diffhash-prompt-contract] (d) block に "転写の破壊" が含まれる', () => {
  assert.ok(block.includes('転写の破壊'), 'dhPrompt ブロックに "転写の破壊" が見つからない');
});

// ---- (e) cd 不要の明示 ----

test('[diffhash-prompt-contract] (e) block に "cd は不要" が含まれる', () => {
  assert.ok(block.includes('cd は不要'), 'dhPrompt ブロックに "cd は不要" が見つからない');
});

// ---- (f) argv 行不変（byte 単位） ----

test('[diffhash-prompt-contract] (f) argv 行 `worktree-diff-hash ${WT} origin/${BASE}` が不変に保たれている', () => {
  assert.ok(
    block.includes('worktree-diff-hash ${WT} origin/${BASE}'),
    'dhPrompt ブロックに argv 行 `worktree-diff-hash ${WT} origin/${BASE}` が見つからない',
  );
});

// ---- (g) 旧 cd 前置が不在 ----

test('[diffhash-prompt-contract] (g) 旧 "cd ${WT} で作業" 前置が block から除去されている', () => {
  assert.ok(
    !block.includes('cd ${WT} で作業'),
    'dhPrompt ブロックに旧 "cd ${WT} で作業" 前置が残っている',
  );
});

// ---- (h) 禁止語（実行制御名を理由に書かない） ----

test('[diffhash-prompt-contract] (h) block に禁止語 sandbox / excludedCommands / permission / 迂回 が含まれない', () => {
  assert.doesNotMatch(block, /sandbox/i, 'dhPrompt ブロックに "sandbox" が含まれている');
  assert.doesNotMatch(block, /excludedCommands/i, 'dhPrompt ブロックに "excludedCommands" が含まれている');
  assert.doesNotMatch(block, /permission/i, 'dhPrompt ブロックに "permission" が含まれている');
  assert.doesNotMatch(block, /迂回/, 'dhPrompt ブロックに "迂回" が含まれている');
});

// ---- (i) 同水準の対照: ci-check 契約文がまだ存在すること ----

test('[diffhash-prompt-contract] (i) ci-check の bare 単文契約文が dev-flow.js に存在する（同水準の基準）', () => {
  assert.ok(
    src.includes('を gh を先頭トークンとする bare 単文で実行せよ'),
    'dev-flow.js に ci-check の bare 単文契約文 "を gh を先頭トークンとする bare 単文で実行せよ" が見つからない',
  );
});
