// _lib/ci-check.mjs（ci-check / ci-wait の定数 / schema / prompt の canonical）の単体テスト。
//
// 守っている不変条件:
//   - ci-check 1 spawn（2 + 1 + margin = 6）と ci-wait 1 spawn（1 + 1 + margin = 5）が
//     dev-runner-haiku-ro の maxTurns を超えない（agent md を実読して pin。issue #663）
//   - CI_WAIT_CEILING_SECONDS=300, CI_POLL_SECONDS=45, CI_MAX_POLLS=7（script 側 ci-wait ループの定数）
//   - prompt にループ・sleep 指示が無い（ci-check は 1 spawn = 1 判定。issue #663）
//   - CI_STATUS の status enum は closed（'error' が欠けると gh fetch 失敗を green と誤認しうる）
//   - prompt が決定論的で、repo 指定の有無で --repo フラグが正しく出し分けられる
//
// prompt 本文が dev-flow.js / pr-iterate.js の inline 区間と全文一致することは
// _lib/workflow-inlines.sync.test.mjs（sync-inlines --check 相当）が保証するため、ここでは扱わない。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CI_POLL_SECONDS, CI_WAIT_CEILING_SECONDS, CI_MAX_POLLS, CI_TURN_MARGIN, CI_STATUS, CI_WAIT, ciCheckPrompt, ciWaitPrompt } from './ci-check.mjs';
import * as mod from './ci-check.mjs';

// ============================================================
// 定数
// ============================================================

// turn 会計の純関数（式は _lib/ci-check.mjs のコメントと一致させる）
function ciCheckTurns(margin) {
  return 2 + 1 + margin;
}
function ciWaitTurns(margin) {
  return 1 + 1 + margin;
}
function readMaxTurns() {
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'dev-runner-haiku-ro.md');
  const src = readFileSync(p, 'utf8');
  const m = src.match(/^maxTurns:\s*(\d+)\s*$/m);
  assert.ok(m, `${p} の frontmatter に maxTurns が無い`);
  return Number(m[1]);
}

test('[ci-check] ci-check 1 spawn の必要 turn（gh fetch + check-ci + StructuredOutput + margin = 6）が dev-runner-haiku-ro の maxTurns を超えない', () => {
  const maxTurns = readMaxTurns();
  assert.equal(ciCheckTurns(CI_TURN_MARGIN), 6);
  assert.ok(ciCheckTurns(CI_TURN_MARGIN) <= maxTurns, `必要 turn ${ciCheckTurns(CI_TURN_MARGIN)} が maxTurns ${maxTurns} を超えている`);
});

test('[ci-check] ci-wait 1 spawn の必要 turn（sleep + StructuredOutput + margin = 5）が maxTurns を超えない', () => {
  const maxTurns = readMaxTurns();
  assert.equal(ciWaitTurns(CI_TURN_MARGIN), 5);
  assert.ok(ciWaitTurns(CI_TURN_MARGIN) <= maxTurns, `必要 turn ${ciWaitTurns(CI_TURN_MARGIN)} が maxTurns ${maxTurns} を超えている`);
});

test('[ci-check] CI_TURN_MARGIN は 3（実測: 文書化 worst case 8 に対し 10 tool call で StructuredOutput 未達）', () => {
  assert.equal(CI_TURN_MARGIN, 3);
});

test('[ci-check] script 側ループの定数: CI_WAIT_CEILING_SECONDS=300 / CI_POLL_SECONDS=45 / CI_MAX_POLLS=7', () => {
  assert.equal(CI_WAIT_CEILING_SECONDS, 300);
  assert.equal(CI_POLL_SECONDS, 45);
  assert.equal(CI_MAX_POLLS, 7);
  assert.ok(CI_POLL_SECONDS * (CI_MAX_POLLS - 1) <= CI_WAIT_CEILING_SECONDS);
});

test('[ci-check] agent 内 attempt ループ定数 CI_MAX_ATTEMPTS は export されない（ループは script 側へ移設。issue #663）', () => {
  assert.equal(mod.CI_MAX_ATTEMPTS, undefined);
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

test('[ci-check] CI_WAIT schema は slept を required に持つ', () => {
  assert.deepEqual(CI_WAIT.required, ['slept']);
  assert.equal(CI_WAIT.properties.slept.type, 'boolean');
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

test('[ci-check] ciCheckPrompt にループ・sleep 指示が無い（1 spawn = 1 判定）', () => {
  const p = ciCheckPrompt({ pr: 1, repo: 'o/n' });
  assert.ok(!/\battempt\b/i.test(p), 'attempt という語を含んではならない');
  assert.ok(!p.includes('--max-attempts'), '--max-attempts を含んではならない');
  assert.ok(!p.includes('--poll-seconds'), '--poll-seconds を含んではならない');
  assert.ok(!p.includes('--attempt '), '--attempt を含んではならない');
  assert.ok(!/\bsleep\b/i.test(p), 'sleep という語を含んではならない');
  assert.ok(!p.includes('繰り返'), '繰り返し指示を含んではならない');
  assert.ok(!p.includes('next_action'), 'next_action への言及を含んではならない');
  assert.ok(p.includes('"poll_attempts": number'), 'Output format の poll_attempts キーは残す');
});

test('ciCheckPrompt: check-ci を plugin bin/ の bare 名（先頭トークン）で呼び、skills 絶対パスと bash 前置を含まない（issue #569）', () => {
  const p = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  assert.ok(p.includes('`check-ci --checks-data'), 'bare 名 check-ci --checks-data を含む');
  assert.ok(!p.includes('check-ci.sh'), '拡張子付き名を含まない');
  assert.ok(!p.includes(['~/.claude', 'skills/'].join('/')), 'skills 絶対パスを含まない');
  assert.ok(!p.includes('bash check-ci'), 'bash 前置を付けない');
});

test('[ci-check] ciWaitPrompt は seconds を ci-wait の bare 単文として展開し、ci-check 識別語や bare sleep を含まない', () => {
  const w = ciWaitPrompt({ seconds: 45 });
  assert.ok(w.includes('`ci-wait 45`'), 'ci-wait 45 を bare 単文として含む');
  assert.ok(!/`sleep \d+`/.test(w), 'bare sleep 単文を含まない');
  assert.ok(!w.includes('check-ci'), 'check-ci を含んではならない');
  assert.ok(!w.includes('--checks-data'), '--checks-data を含んではならない');
  assert.ok(!w.includes('gh pr checks'), 'gh pr checks を含んではならない');
  assert.equal(w, ciWaitPrompt({ seconds: 45 }), '決定論的であること');
});
