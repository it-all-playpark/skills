// _lib/ci-check.mjs（ci-check の定数 / schema / prompt の canonical）の単体テスト。
//
// 守っている不変条件:
//   - attempt ループが dev-runner-haiku-ro の maxTurns (10) を超えない
//     （(attempt 数 × 2) - 1 <= 10。超えると CI gate が maxTurns 打ち切りで壊れる）
//   - CI_STATUS の status enum は closed（'error' が欠けると gh fetch 失敗を green と誤認しうる）
//   - prompt が決定論的で、repo 指定の有無で --repo フラグが正しく出し分けられる
//
// prompt 本文が dev-flow.js / pr-iterate.js の inline 区間と全文一致することは
// _lib/workflow-inlines.sync.test.mjs（sync-inlines --check 相当）が保証するため、ここでは扱わない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CI_MAX_ATTEMPTS, CI_POLL_SECONDS, CI_STATUS, ciCheckPrompt } from './ci-check.mjs';

// ============================================================
// 定数
// ============================================================

test('[ci-check] attempt ループが dev-runner-haiku-ro の maxTurns (10) を超えない', () => {
  // fetch / classify / sleep がそれぞれ 1 turn を消費する。最終 attempt に sleep は無い。
  const worstCaseTurns = (CI_MAX_ATTEMPTS * 2) - 1;
  assert.ok(
    worstCaseTurns <= 10,
    `(attempt 数 × 2) - 1 = ${worstCaseTurns} は dev-runner-haiku-ro の maxTurns (10) を超えてはならない`,
  );
});

test('[ci-check] pending 待機の ceiling が 90 秒である', () => {
  assert.equal((CI_MAX_ATTEMPTS - 1) * CI_POLL_SECONDS, 90);
});

// ============================================================
// schema
// ============================================================

test('[ci-check] CI_STATUS の status enum は 5 値の closed enum', () => {
  assert.deepEqual(
    CI_STATUS.properties.status.enum,
    ['passed', 'failed', 'pending', 'no_checks', 'error'],
  );
  assert.deepEqual(CI_STATUS.required, ['status']);
});

test('[ci-check] CI_STATUS の failed_checks 要素は {name, bucket, state}', () => {
  const props = CI_STATUS.properties.failed_checks.items.properties;
  assert.deepEqual(Object.keys(props).sort(), ['bucket', 'name', 'state']);
});

test('[ci-check] CI_STATUS は clock telemetry 給電用の optional epoch を持つ', () => {
  assert.equal(CI_STATUS.properties.epoch.type, 'number');
  assert.ok(!CI_STATUS.required.includes('epoch'), 'epoch は optional でなければならない');
});

// ============================================================
// prompt
// ============================================================

test('[ci-check] ciCheckPrompt は決定論的（同入力 -> 同出力）', () => {
  const a = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  const b = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  assert.equal(a, b);
});

test('[ci-check] repo 指定ありなら --repo フラグを含む', () => {
  const p = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  assert.ok(p.includes('gh pr checks 123 --repo owner/name --json name,state,bucket'), p.slice(0, 400));
});

test('[ci-check] repo が null なら --repo フラグを含まない', () => {
  const p = ciCheckPrompt({ pr: 123, repo: null });
  assert.ok(p.includes('gh pr checks 123 --json name,state,bucket'), p.slice(0, 400));
  assert.ok(!p.includes('--repo'), '--repo は出力されてはならない');
});

test('[ci-check] pr が文字列でも同じ prompt になる（dev-flow は number, pr-iterate は string 由来）', () => {
  assert.equal(ciCheckPrompt({ pr: 123, repo: null }), ciCheckPrompt({ pr: '123', repo: null }));
});

test('[ci-check] prompt に attempt ループ定数が展開されている', () => {
  const p = ciCheckPrompt({ pr: 1, repo: null });
  assert.ok(p.includes(`次を最大 ${CI_MAX_ATTEMPTS} 回繰り返せ`), 'max-attempts が展開されていない');
  assert.ok(p.includes(`--poll-seconds ${CI_POLL_SECONDS}`), 'poll-seconds が展開されていない');
  assert.ok(p.includes(`最大 ${(CI_MAX_ATTEMPTS - 1) * CI_POLL_SECONDS} 秒`), 'ceiling が展開されていない');
});

test('[ci-check] prompt は read-only 契約（Write/Edit/commit/push 禁止）を明示する', () => {
  const p = ciCheckPrompt({ pr: 1, repo: null });
  assert.ok(p.includes('禁止: Write, Edit, git commit, git push'));
  assert.ok(p.includes('読み取り専用'));
});
