// plan-iterate-wiring-routing: dev-flow.js の「配線」を VM 挙動として検証する（issue #636）。
//
// 旧来は dev-flow.js のソース文字列（`iterateStatus: iterate?.status ?? null,` 等の行）を
// src.includes / regex で pin していた。ここでは dev-flow.js を VM で実際に実行し、
// 配線が切れたときに変わる観測値（返り値・agent() 呼び出し回数・journal telemetry・
// post-summary の構造 marker）だけを assert する。
//
// テストケース:
//   (a) pr-iterate が fix_failed で終端 → merge_tier=HOLD / eval_staleness=iterate_incomplete /
//       journal telemetry に iterate_status・iterate_rounds / post-summary に HOLD marker と
//       history 末尾 round の file パス（iterateHistory・iterateIterations 配線）
//
// 旧 (b)（plan-reviewer の relax 収束と planConcerns の配線）は issue #673 で plan review ループごと
// 削除した。plan_verdict は常に null、planConcerns は常に空で、merge tier は planConcerns を入力に持たない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

// ============================================================
// (a) pr-iterate 非 LGTM 終端の配線
// ============================================================

test('[wiring] (a) pr-iterate fix_failed → HOLD / iterate_incomplete / telemetry と summary に iterate 情報が配線される', async () => {
  const history = [{
    iteration: 3,
    decision: 'request_changes',
    summary: 's',
    blocking: [{ severity: 'major', topic: 't', file: 'src/wired-by-history.ts', line: 7, description: 'd', suggestion: null }],
    minor: [],
  }];
  const { ctx, calls } = makeDevFlowSandbox({
    workflow: async () => ({ status: 'fix_failed', iterations: 3, fixes_applied: 1, history }),
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.ok(result !== null, '(a) workflow は return object を返すべきだが null だった');

  assert.equal(result.iterate_status, 'fix_failed');
  assert.equal(result.eval_staleness, 'iterate_incomplete', `(a) eval_staleness: ${JSON.stringify(result.eval_staleness)}`);
  assert.equal(result.merge_tier, 'HOLD', `(a) merge_tier: ${JSON.stringify(result.merge_tier)}`);
  assert.ok(
    (result.merge_tier_reasons ?? []).some((r) => r.includes('fix_failed')),
    `(a) merge_tier_reasons に iterate status を含む理由が無い: ${JSON.stringify(result.merge_tier_reasons)}`,
  );
  assert.equal(result.plan_verdict, null, '(a) plan review ループは存在しないため plan_verdict は null のはず');

  const journal = calls.find((c) => c.label === 'journal-save');
  assert.ok(journal, '(a) journal-save が呼ばれていない');
  assert.ok(journal.prompt.includes('"iterate_status":"fix_failed"'), `(a) telemetry に iterate_status が無い:\n${journal.prompt.slice(0, 600)}`);
  assert.ok(journal.prompt.includes('"iterate_rounds":3'), `(a) telemetry に iterate_rounds=3 が無い:\n${journal.prompt.slice(0, 600)}`);
  assert.ok(journal.prompt.includes('"eval_staleness":"iterate_incomplete"'), `(a) telemetry に eval_staleness が無い:\n${journal.prompt.slice(0, 600)}`);

  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, '(a) post-summary が呼ばれていない');
  assert.ok(post.prompt.includes('<!-- dev-flow:HOLD -->'), '(a) post-summary に HOLD marker が無い');
  assert.ok(
    post.prompt.includes('src/wired-by-history.ts'),
    '(a) post-summary に iterateHistory 末尾 round の file パスが無い（iterateHistory / iterateIterations の配線切れ）',
  );
});
