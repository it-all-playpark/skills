// pr-body-sync-routing.test.mjs — PR body の Closes 行決定論検証 / 再投入 / merge tier HOLD と
// Final AC reconcile 後の AC checkbox 同期を dev-flow.js を VM 実行して観測する（issue #661 F3）。
//
// pr-artifacts.test.mjs 末尾の routing test（PR body verbatim 転写）と同型: dev-flow.js を strip して
// vm sandbox で実行し、agent() に実際に渡った {label, agentType, prompt, opts} を観測する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

async function run(overrides = {}, workflow) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides, workflow });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'pr-body-sync-routing');
  assert.equal(error, null, `dev-flow run が throw した: ${error?.message}`);
  return { result, calls };
}

// closes-check / closes-recheck の exec-proxy 応答（gh pr view --json body の stdout 全文を raw で返す。issue #713）。
function view(body) {
  return { ok: true, raw: JSON.stringify({ body }) };
}

// ---- 1. 既定 run: Closes 行あり → 'verified'、再投入なし ----

test('[pr-body-sync-routing] 既定 run: closes-check のみ 1 回、prompt に gh pr view --json body、pr_closes_status=verified', async () => {
  const { result, calls } = await run();

  const closesCheck = calls.filter((c) => c.label === 'closes-check');
  assert.equal(closesCheck.length, 1, `closes-check は 1 回のはずだが ${closesCheck.length} 回`);
  assert.equal(closesCheck[0].agentType, 'dev-flow:dev-runner-haiku-ro');
  assert.equal(closesCheck[0].opts.phase, 'PR');
  assert.ok(closesCheck[0].prompt.includes('gh pr view 1 --json body'), 'closes-check prompt に gh pr view --json body が無い');

  assert.equal(calls.filter((c) => c.label === 'closes-reinject').length, 0, 'closes-reinject は呼ばれないはず');
  assert.equal(calls.filter((c) => c.label === 'closes-recheck').length, 0, 'closes-recheck は呼ばれないはず');

  assert.equal(result?.pr_closes_status, 'verified');
  assert.notEqual(result?.merge_tier, 'HOLD');
});

// ---- 2. Closes 欠落 → closes-reinject → closes-recheck（既定 responder で Closes 付き）→ 'reinjected' ----

test('[pr-body-sync-routing] Closes 欠落 → closes-reinject で再投入 → closes-recheck で確認 → pr_closes_status=reinjected', async () => {
  const { result, calls } = await run({ 'closes-check': view('**x**\n') });

  const reinject = calls.filter((c) => c.label === 'closes-reinject');
  assert.equal(reinject.length, 1, `closes-reinject は 1 回のはずだが ${reinject.length} 回`);
  assert.equal(reinject[0].agentType, 'dev-flow:dev-runner-haiku');
  assert.ok(reinject[0].prompt.includes('gh pr edit 1'), 'closes-reinject prompt に gh pr edit 1 が無い');
  assert.ok(reinject[0].prompt.includes('--body-file /tmp/wt/.devflow-tmp/pr-body-reinject.md'), 'closes-reinject prompt に --body-file 指示が無い');
  assert.ok(reinject[0].prompt.includes('<<<PR_BODY_BEGIN>>>'), 'closes-reinject prompt に PR_BODY delimiter が無い');
  assert.ok(reinject[0].prompt.includes('Closes #1\n<<<PR_BODY_END>>>'), 'closes-reinject prompt の本文が Closes #1 で終わらない');

  const recheck = calls.filter((c) => c.label === 'closes-recheck');
  assert.equal(recheck.length, 1, `closes-recheck は 1 回のはずだが ${recheck.length} 回`);

  assert.equal(result?.pr_closes_status, 'reinjected');
  assert.notEqual(result?.merge_tier, 'HOLD');
});

// ---- 3. Closes 欠落 + 再投入失敗（edited:false）→ closes-recheck は呼ばれず 'missing' → HOLD ----

test('[pr-body-sync-routing] Closes 欠落 + 再投入失敗 → closes-recheck 未呼出、pr_closes_status=missing、merge_tier=HOLD', async () => {
  const { result, calls } = await run({
    'closes-check': view('**x**\n'),
    'closes-reinject': { edited: false },
  });

  assert.equal(calls.filter((c) => c.label === 'closes-recheck').length, 0, 'closes-recheck は呼ばれないはず');
  assert.equal(result?.pr_closes_status, 'missing');
  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok(
    Array.isArray(result?.merge_tier_hold_reasons) && result.merge_tier_hold_reasons.some((r) => r.code === 'pr_closes_missing'),
    `merge_tier_hold_reasons に pr_closes_missing が無い: ${JSON.stringify(result?.merge_tier_hold_reasons)}`,
  );
});

// ---- 4. Closes 欠落 + 再投入成功だが再確認でも依然欠落 → 'missing' → HOLD ----

test('[pr-body-sync-routing] 再投入後も Closes 欠落のまま → pr_closes_status=missing、merge_tier=HOLD', async () => {
  const { result } = await run({
    'closes-check': view('**x**\n'),
    'closes-recheck': view('still none'),
  });

  assert.equal(result?.pr_closes_status, 'missing');
  assert.equal(result?.merge_tier, 'HOLD');
});

// ---- 5. closes-check probe 失敗（null）→ 再投入せず 'unverified'、HOLD にしない（fail-open） ----

test('[pr-body-sync-routing] closes-check probe 失敗（null）→ closes-reinject 未呼出、pr_closes_status=unverified、HOLD にならない', async () => {
  const { result, calls } = await run({ 'closes-check': null });

  assert.equal(calls.filter((c) => c.label === 'closes-reinject').length, 0, 'closes-reinject は呼ばれないはず');
  assert.equal(result?.pr_closes_status, 'unverified');
  assert.notEqual(result?.merge_tier, 'HOLD');
});

// ---- 5b. closes-check の raw が不正 JSON / body 欠落 → 再投入せず 'unverified'（missing にしない。issue #713） ----

test('[pr-body-sync-routing] closes-check の raw が不正 JSON / body 欠落 → closes-reinject 未呼出、pr_closes_status=unverified、HOLD にならない', async () => {
  for (const raw of ['{"body": "Closes #1', '{"title":"x"}']) {
    const { result, calls } = await run({ 'closes-check': { ok: true, raw } });
    assert.equal(calls.filter((c) => c.label === 'closes-reinject').length, 0, `closes-reinject は呼ばれないはず (raw=${raw})`);
    assert.equal(result?.pr_closes_status, 'unverified', `raw=${raw}`);
    assert.notEqual(result?.merge_tier, 'HOLD', `raw=${raw}`);
  }
});

// ---- 5c. PR #711 型: stdout を raw で受ければ Closes 行ありの本文は verified（issue #713 の誤 HOLD 回帰） ----

test('[pr-body-sync-routing] closes-check prompt は raw 返却を指示し、stdout 全文の raw から Closes #1 を検出して verified', async () => {
  const body = '**refactor(dev-flow): x**\n\n## 変更\n- a\n\n## 受入条件\n- [x] AC-1\n\n## 設計判断\n（なし）\n\n## 検証\n- ok\n\nCloses #1\n';
  const { result, calls } = await run({ 'closes-check': { ok: true, raw: JSON.stringify({ body }) + '\n' } });

  const closesCheck = calls.find((c) => c.label === 'closes-check');
  assert.ok(closesCheck.prompt.includes('{"ok": true, "raw": string}'), 'closes-check prompt が raw 返却を指示していない');
  assert.equal(calls.filter((c) => c.label === 'closes-reinject').length, 0, 'closes-reinject は呼ばれないはず');
  assert.equal(result?.pr_closes_status, 'verified');
  assert.notEqual(result?.merge_tier, 'HOLD');
});

// ---- 6. AC checkbox 同期: fix 適用 + lgtm 終端 + Final AC reconcile reverified ----

test('[pr-body-sync-routing] fix 適用 + lgtm + Final AC reconcile reverified → ac-checkbox-sync が PR body を再生成して gh pr edit', async () => {
  const { result, calls } = await run(
    {
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: false, verified_by: 'inspection', evidence: 'ng' },
        ],
        item_resolutions: [],
      },
    },
    async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  );

  const sync = calls.filter((c) => c.label === 'ac-checkbox-sync');
  assert.equal(sync.length, 1, `ac-checkbox-sync は 1 回のはずだが ${sync.length} 回`);
  assert.equal(sync[0].agentType, 'dev-flow:dev-runner-haiku');
  assert.equal(sync[0].opts.phase, 'Final reconcile');
  assert.ok(sync[0].prompt.includes('- [x] a\n- [ ] b'), `ac-checkbox-sync prompt に AC checkbox の充足状況が反映されていない:\n${sync[0].prompt}`);
  assert.ok(sync[0].prompt.includes('gh pr edit 1'), 'ac-checkbox-sync prompt に gh pr edit 1 が無い');
  assert.ok(sync[0].prompt.includes('--body-file /tmp/wt/.devflow-tmp/pr-body-final.md'), 'ac-checkbox-sync prompt に --body-file 指示が無い');
  assert.ok(sync[0].prompt.includes('Closes #1'), 'ac-checkbox-sync prompt の本文に Closes #1 が無い');

  assert.equal(result?.pr_body_synced, true);
});

// ---- 7. AC checkbox 同期が起動しないケース ----

test('[pr-body-sync-routing] fixes_applied=0（既定 run）では ac-checkbox-sync は呼ばれず pr_body_synced=null', async () => {
  const { result, calls } = await run();
  assert.equal(calls.filter((c) => c.label === 'ac-checkbox-sync').length, 0);
  assert.equal(result?.pr_body_synced, null);
});

test('[pr-body-sync-routing] fixes_applied>0 でも Final AC reconcile が unavailable なら ac-checkbox-sync は呼ばれない', async () => {
  const { result, calls } = await run(
    {
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'final-ac-reconcile': null,
    },
    async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  );
  assert.equal(calls.filter((c) => c.label === 'ac-checkbox-sync').length, 0);
  assert.equal(result?.pr_body_synced, null);
});

// ---- 8. ac-checkbox-sync 失敗は fail-open ----

test('[pr-body-sync-routing] ac-checkbox-sync が edited:false を返しても run は throw せず merge_tier は HOLD にならない', async () => {
  const { result } = await run(
    {
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        item_resolutions: [],
      },
      'ac-checkbox-sync': { edited: false },
    },
    async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  );

  assert.equal(result?.pr_body_synced, false);
  assert.notEqual(result?.merge_tier, 'HOLD');
});
