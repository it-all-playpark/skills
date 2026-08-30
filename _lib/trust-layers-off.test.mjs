// trust-layer call site 撤去（issue #507）の静的 invariant。
//
// 撤去前（issue #448/#493 期）は「off だから call site が実行されない」ことを実測で pin していたが、
// call site 自体を撤去した現在は「call site が存在しない」ことを機械的に検証する方が正確かつ安価
// （sandbox VM 実行不要）。call site は監査改ざん同型の safety classifier 衝突により撤去済みで、
// 復帰は再設計 issue（`.claude/rules/dev-flow.md` の trust-layer sunset path の 3 条件）経由のみ —
// このテストは中途半端な call site 再追加を機械的に拒否する（誤って個別ファイルを復元しても、
// dev-flow.js からの参照 or telemetry トークン or inline 区間のいずれかで red になる）。
//
// テストケース:
//   (a) dev-flow.js 全文（コメント含む）に trust call site 由来パターンが 0 件
//   (b) .claude/workflows/ 配下の inline 生成区間に trust-mode.mjs / trust-wiring.mjs が無い
//   (c) dev-flow.js 全文に trust telemetry トークンが 0 件
//   (d) call-site 専用の成果物（exec-proxy スクリプト・call-site ヘルパ・routing test・専用 fixture）が
//       いずれも存在しない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowsDir = join(repoRoot, '.claude', 'workflows');
const devFlowPath = join(workflowsDir, 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// (a) dev-flow.js 全文に call site パターンが無い
// ============================================================

test('[trust-layers-off] (a) dev-flow.js に trust call site 由来パターンが0件', () => {
  const pattern = /surfaceproof-shadow|trust-seal|trust-effectdelta/;
  assert.equal(
    pattern.test(devFlowSrc), false,
    '(a) dev-flow.js に trust 由来の call site（label/コメント含む）が残っている',
  );
});

// ============================================================
// (b) inline 生成区間に trust-mode / trust-wiring が無い
// ============================================================

test('[trust-layers-off] (b) .claude/workflows/ 配下に trust-mode.mjs / trust-wiring.mjs の inline 区間が無い', () => {
  const workflowFiles = readdirSync(workflowsDir).filter((f) => f.endsWith('.js'));
  assert.ok(workflowFiles.length > 0, '(b) .claude/workflows/ 配下に *.js が見つからない');

  for (const file of workflowFiles) {
    const src = readFileSync(join(workflowsDir, file), 'utf8');
    assert.ok(
      !src.includes('// ==== BEGIN inline: _lib/trust-mode.mjs'),
      `(b) ${file} に _lib/trust-mode.mjs の inline 区間が残っている`,
    );
    assert.ok(
      !src.includes('// ==== BEGIN inline: _lib/trust-wiring.mjs'),
      `(b) ${file} に _lib/trust-wiring.mjs の inline 区間が残っている`,
    );
  }
});

// ============================================================
// (c) dev-flow.js 全文に telemetry トークンが無い
// ============================================================

test('[trust-layers-off] (c) dev-flow.js に trust telemetry トークンが0件', () => {
  const pattern = /trust_surfaceproof_shadow|trust_evalseal|trust_effectdelta_pr|trust_run_id|trust_receipts:/;
  assert.equal(
    pattern.test(devFlowSrc), false,
    '(c) dev-flow.js に trust telemetry トークンが残っている',
  );
});

// ============================================================
// (d) call-site 成果物が存在しない
// ============================================================

const REMOVED_PATHS = [
  '_lib/trust-wiring.mjs',
  '_lib/trust-wiring.test.mjs',
  '_lib/trust-surfaceproof.mjs',
  '_lib/trust-surfaceproof.test.mjs',
  '_lib/trust-surfaceproof-cli.mjs',
  '_lib/trust-surfaceproof-cli.test.mjs',
  '_lib/trust-surfaceproof-fixtures.test.mjs',
  '_lib/trust-effectdelta.mjs',
  '_lib/trust-effectdelta.test.mjs',
  '_lib/trust-effectdelta-cli.mjs',
  '_lib/trust-effectdelta-cli.test.mjs',
  '_lib/test-helpers/trust-layer-src.mjs',
  '_lib/surfaceproof-routing.test.mjs',
  '_lib/evalseal-routing.test.mjs',
  '_lib/effectdelta-routing.test.mjs',
  '_lib/effectdelta-obs-schema-routing.test.mjs',
  '_lib/trust-runid-routing.test.mjs',
  '_lib/fixtures/trust/surfaceproof',
  '_shared/scripts/evalseal-seal.mjs',
  '_shared/scripts/evalseal-seal.test.mjs',
  '_shared/scripts/evalseal-verify.mjs',
  '_shared/scripts/evalseal-verify.test.mjs',
  '_shared/scripts/effectdelta-github.sh',
  '_shared/scripts/effectdelta-github.bats',
  'dev-issue-analyze/scripts/surfaceproof-snapshot.sh',
  'dev-issue-analyze/scripts/surfaceproof-snapshot.bats',
];

for (const relPath of REMOVED_PATHS) {
  test(`[trust-layers-off] (d) ${relPath} は存在しない`, () => {
    assert.equal(
      existsSync(join(repoRoot, relPath)), false,
      `(d) 撤去済み call-site 成果物 ${relPath} が存在している`,
    );
  });
}
