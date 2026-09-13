// worktree-base-check routing test（issue #517、issue #550 案1 で統合 call site へ書き換え）:
// dev-flow.js の Setup phase に配線された setup-base（resolve-base + worktree-base-check 統合）
// exec-proxy 呼び出しを検証する。
//
// issue #636 AC-4: label/agentType/呼び出し順・resolveBase/checkWorktreeBase が同一 setupProbe
// を入力に使うことは、makeDevFlowSandbox を使った VM 実行の挙動（calls の label/agentType/opts、
// logs に現れる BASE 解決結果、throw の有無）で検証する。純粋な inline マーカーの存在確認
// （生成区間の整合性）のみ静的走査のまま残す。
//
// このテストは:
//   (a) dev-flow.js に _lib/worktree-base-check.mjs / _lib/resolve-base.mjs の inline マーカーが
//       存在する（inline 整合の静的走査）
//   (b) label:'setup-base' の call がちょうど1回記録され、agentType が
//       'dev-flow:dev-runner-haiku-ro'（読み取り専用）・opts.retryOnContractViolation:true・
//       opts.phase:'Setup' である（VM 挙動）
//   (c) 旧 label:'resolve-base' / label:'worktree-base-check' の call が記録されない
//       （4→1 統合の挙動側証跡）
//   (d) label:'setup-base' の call が label:'worktree'（Setup(worktree) agent）より前に記録される
//   (e) resolveBase(BASE_ARG, setupProbe) が setupProbe の内容に応じて実際に BASE を解決している
//       ことを log 出力（`base: origin/<BASE>（source: ...)`）で確認する
//   (f) checkWorktreeBase({ issue, base, probe }) が resolveBase が解決した base と同一の probe を
//       受け取っていることを、upstream 一致/不一致による throw の有無で確認する
// を assert する。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// Part 1: inline 整合（生成区間マーカーの静的存在確認）
// ============================================================

test('[worktree-base-check-routing] dev-flow.js に _lib/worktree-base-check.mjs の inline マーカーが存在する', () => {
  assert.ok(
    src.includes('// ==== BEGIN inline: _lib/worktree-base-check.mjs'),
    'dev-flow.js に "// ==== BEGIN inline: _lib/worktree-base-check.mjs" マーカーが存在しない',
  );
  assert.ok(
    src.includes('// ==== END inline: _lib/worktree-base-check.mjs ===='),
    'dev-flow.js に "// ==== END inline: _lib/worktree-base-check.mjs ====" マーカーが存在しない',
  );
});

test('[worktree-base-check-routing] dev-flow.js に _lib/resolve-base.mjs の inline マーカーが存在する', () => {
  assert.ok(
    src.includes('// ==== BEGIN inline: _lib/resolve-base.mjs'),
    'dev-flow.js に "// ==== BEGIN inline: _lib/resolve-base.mjs" マーカーが存在しない',
  );
  assert.ok(
    src.includes('// ==== END inline: _lib/resolve-base.mjs ===='),
    'dev-flow.js に "// ==== END inline: _lib/resolve-base.mjs ====" マーカーが存在しない',
  );
});

// ============================================================
// Part 2: VM 挙動（label / opts / calls 順序 / logs）
// ============================================================

test("[worktree-base-check-routing] setup-base call が1回だけ記録され agentType:'dev-flow:dev-runner-haiku-ro' / opts.retryOnContractViolation:true / opts.phase:'Setup' を持つ", async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const error = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, `既定 run はエラーなく完走するべき: ${error?.message}`);

  const setupBaseCalls = calls.filter((c) => c.label === 'setup-base');
  assert.equal(setupBaseCalls.length, 1, "label 'setup-base' の call はちょうど1回のはず");
  const [call] = setupBaseCalls;
  assert.equal(call.agentType, 'dev-flow:dev-runner-haiku-ro');
  assert.equal(call.opts.retryOnContractViolation, true);
  assert.equal(call.opts.phase, 'Setup');
});

test("[worktree-base-check-routing] 旧 label:'resolve-base' / label:'worktree-base-check' の call が記録されない（4→1 統合の挙動側証跡）", async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);

  assert.ok(!calls.some((c) => c.label === 'resolve-base'), "旧 label 'resolve-base' の call が記録されている");
  assert.ok(!calls.some((c) => c.label === 'worktree-base-check'), "旧 label 'worktree-base-check' の call が記録されている");
});

test("[worktree-base-check-routing] setup-base call が worktree call（Setup(worktree) agent）より前に記録される", async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);

  const setupBaseIdx = calls.findIndex((c) => c.label === 'setup-base');
  const worktreeIdx = calls.findIndex((c) => c.label === 'worktree');
  assert.notEqual(setupBaseIdx, -1, "label 'setup-base' の call が見つからない");
  assert.notEqual(worktreeIdx, -1, "label 'worktree' の call が見つからない");
  assert.ok(
    setupBaseIdx < worktreeIdx,
    'setup-base call が worktree call（Setup(worktree) agent）より後に記録されている（fail-closed 検証が再利用前に発火しない）',
  );
});

test('[worktree-base-check-routing] resolveBase(BASE_ARG, setupProbe): dev_exists:false → default_branch を BASE として解決する（同一 probe が渡っている挙動側証跡）', async () => {
  const { ctx, logs } = makeDevFlowSandbox({
    overrides: {
      'setup-base': {
        ok: true, default_branch: 'trunk', dev_exists: false, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '',
      },
    },
  });
  const error = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, `完走するはず: ${error?.message}`);
  assert.ok(
    logs.some((l) => l.includes('base: origin/trunk') && l.includes('source: origin/HEAD')),
    `logs に BASE=trunk（source: origin/HEAD）の解決結果が現れない: ${JSON.stringify(logs)}`,
  );
});

test('[worktree-base-check-routing] resolveBase: args.base 明示 + requested_exists:true → 明示 base を採用する', async () => {
  const { ctx, logs } = makeDevFlowSandbox({
    overrides: {
      'setup-base': {
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: true,
        worktree_exists: false, upstream_remote: '', upstream_merge: '',
      },
    },
    extra: { args: { issue: 1, base: 'release' } },
  });
  const error = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, `完走するはず: ${error?.message}`);
  assert.ok(
    logs.some((l) => l.includes('base: origin/release') && l.includes('source: explicit')),
    `logs に BASE=release（source: explicit）の解決結果が現れない: ${JSON.stringify(logs)}`,
  );
});

test('[worktree-base-check-routing] checkWorktreeBase({issue, base, probe}): worktree_exists:true + upstream が resolveBase の結果と一致 → 再利用可（throw しない）', async () => {
  const { ctx } = makeDevFlowSandbox({
    overrides: {
      'setup-base': {
        ok: true, default_branch: 'main', dev_exists: false, requested_exists: false,
        worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/main',
      },
    },
  });
  const error = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, `base 一致時は throw しないはず: ${error?.message}`);
});

test('[worktree-base-check-routing] checkWorktreeBase: worktree_exists:true + upstream 不一致 → fail-closed throw（checkWorktreeBase が resolveBase と同一 base を使っている挙動側証跡）', async () => {
  const { ctx } = makeDevFlowSandbox({
    overrides: {
      'setup-base': {
        ok: true, default_branch: 'main', dev_exists: false, requested_exists: false,
        worktree_exists: true, upstream_remote: 'origin', upstream_merge: 'refs/heads/other',
      },
    },
  });
  const error = await runDevFlowInSandbox(src, ctx);
  assert.ok(error, 'base 不一致時は throw するはず');
  assert.match(error.message, /起点が一致しない/);
});
