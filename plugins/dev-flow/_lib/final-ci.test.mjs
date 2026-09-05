import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  FINAL_CI_KIND_DETERMINISTIC,
  FINAL_CI_KIND_HUMAN,
  FINAL_CI_REASONS,
  FINAL_CI_META,
  finalCiPrompt,
  finalCiVerdict,
} from './final-ci.mjs';

const SHA_A = '7c4fcadc81d948db6f3053ddbc9788af15a470d6';
const SHA_B = 'b55733ea1234567890abcdef1234567890abcdef';

function checkRun(name, status, conclusion) {
  return { __typename: 'CheckRun', name, status, conclusion };
}

function statusContext(context, state) {
  return { __typename: 'StatusContext', context, state };
}

// --- (a) sha 一致 + 全 success ---

test('finalCiVerdict: sha 一致 + CheckRun 3 件全 COMPLETED/SUCCESS → verified:true/ok/kind null', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [
      checkRun('lint', 'COMPLETED', 'SUCCESS'),
      checkRun('build', 'COMPLETED', 'SUCCESS'),
      checkRun('test', 'COMPLETED', 'SUCCESS'),
    ],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.deepEqual(result, {
    verified: true,
    reason: 'ok',
    kind: null,
    checkNames: ['lint', 'build', 'test'],
    headRefOid: SHA_A,
  });
});

// --- (b) headRefOid が別 40hex ---

test('finalCiVerdict: headRefOid が別 sha → sha-mismatch/human_judgment/verified:false', () => {
  const meta = { ok: true, headRefOid: SHA_B, statusCheckRollup: [checkRun('lint', 'COMPLETED', 'SUCCESS')] };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'sha-mismatch');
  assert.equal(result.kind, FINAL_CI_KIND_HUMAN);
  assert.equal(result.headRefOid, SHA_B);
});

// --- (c) 1 件 status IN_PROGRESS → pending ---

test('finalCiVerdict: 1 件 status IN_PROGRESS → pending/deterministic_recheck/checkNames はその1件のみ', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [
      checkRun('lint', 'COMPLETED', 'SUCCESS'),
      checkRun('build', 'IN_PROGRESS', null),
    ],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'pending');
  assert.equal(result.kind, FINAL_CI_KIND_DETERMINISTIC);
  assert.deepEqual(result.checkNames, ['build']);
});

// --- (d) 1 件 conclusion FAILURE → failure ---

test('finalCiVerdict: 1 件 conclusion FAILURE → failure/human_judgment', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [
      checkRun('lint', 'COMPLETED', 'SUCCESS'),
      checkRun('build', 'COMPLETED', 'FAILURE'),
    ],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'failure');
  assert.equal(result.kind, FINAL_CI_KIND_HUMAN);
  assert.deepEqual(result.checkNames, ['build']);
});

// --- (e) meta null / ok:false → fetch-failed ---

test('finalCiVerdict: meta が null → fetch-failed/deterministic_recheck', () => {
  const result = finalCiVerdict({ expectedSha: SHA_A, meta: null });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'fetch-failed');
  assert.equal(result.kind, FINAL_CI_KIND_DETERMINISTIC);
  assert.equal(result.headRefOid, null);
});

test('finalCiVerdict: meta.ok !== true → fetch-failed/deterministic_recheck', () => {
  const result = finalCiVerdict({ expectedSha: SHA_A, meta: { ok: false, error: 'boom' } });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'fetch-failed');
  assert.equal(result.kind, FINAL_CI_KIND_DETERMINISTIC);
});

// --- (f) statusCheckRollup [] → no-checks ---

test('finalCiVerdict: statusCheckRollup が空配列 → no-checks/human_judgment', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: [] };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'no-checks');
  assert.equal(result.kind, FINAL_CI_KIND_HUMAN);
  assert.deepEqual(result.checkNames, []);
});

// --- (g) expectedSha が不正 → no-expected-sha ---

test('finalCiVerdict: expectedSha が null → no-expected-sha/human_judgment', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: [checkRun('lint', 'COMPLETED', 'SUCCESS')] };
  const result = finalCiVerdict({ expectedSha: null, meta });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'no-expected-sha');
  assert.equal(result.kind, FINAL_CI_KIND_HUMAN);
  assert.deepEqual(result.checkNames, []);
  assert.equal(result.headRefOid, null);
});

test('finalCiVerdict: expectedSha が短縮 sha(8hex) → no-expected-sha', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: [checkRun('lint', 'COMPLETED', 'SUCCESS')] };
  const result = finalCiVerdict({ expectedSha: 'deadbeef', meta });
  assert.equal(result.reason, 'no-expected-sha');
});

test('finalCiVerdict: expectedSha が非文字列(数値) → no-expected-sha', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: [checkRun('lint', 'COMPLETED', 'SUCCESS')] };
  const result = finalCiVerdict({ expectedSha: 12345, meta });
  assert.equal(result.reason, 'no-expected-sha');
});

// --- (h) headRefOid が非 40hex / 非文字列 → invalid ---

test('finalCiVerdict: meta.headRefOid が非 40hex → invalid/deterministic_recheck', () => {
  const meta = { ok: true, headRefOid: 'shortsha', statusCheckRollup: [checkRun('lint', 'COMPLETED', 'SUCCESS')] };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'invalid');
  assert.equal(result.kind, FINAL_CI_KIND_DETERMINISTIC);
  assert.equal(result.headRefOid, null);
});

test('finalCiVerdict: meta.headRefOid が非文字列 → invalid', () => {
  const meta = { ok: true, headRefOid: null, statusCheckRollup: [checkRun('lint', 'COMPLETED', 'SUCCESS')] };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'invalid');
});

// --- (i) 大文字小文字違いの同一 sha ---

test('finalCiVerdict: expectedSha と headRefOid の大文字小文字違いは一致扱い', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A.toUpperCase(),
    statusCheckRollup: [checkRun('lint', 'COMPLETED', 'SUCCESS')],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.verified, true);
  assert.equal(result.reason, 'ok');
});

// --- (j) SKIPPED/NEUTRAL は success、未知 conclusion は failure ---

test('finalCiVerdict: 真の SUCCESS が1件でもあれば SKIPPED/NEUTRAL 混在は success 扱い', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [
      checkRun('a', 'COMPLETED', 'SKIPPED'),
      checkRun('b', 'COMPLETED', 'NEUTRAL'),
      checkRun('c', 'COMPLETED', 'SUCCESS'),
    ],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.verified, true);
  assert.equal(result.reason, 'ok');
});

// issue #600 レビュー指摘: 全 SKIPPED/NEUTRAL（真の SUCCESS が1件も無い）は「test が1件も
// 実行されていない」ことを意味するため no-checks へ倒す（draft PR で test job が条件付き skip
// される場合等に、CI 委譲が誤って ci_verified へ昇格することを防ぐ）。
test('finalCiVerdict: 全 SKIPPED/NEUTRAL（真の SUCCESS 0件）は no-checks/human_judgment', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [
      checkRun('a', 'COMPLETED', 'SKIPPED'),
      checkRun('b', 'COMPLETED', 'NEUTRAL'),
    ],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'no-checks');
  assert.equal(result.kind, FINAL_CI_KIND_HUMAN);
  assert.deepEqual(result.checkNames, ['a', 'b']);
});

test('finalCiVerdict: 未知 conclusion WHATEVER は failure（fail-closed）', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [checkRun('a', 'COMPLETED', 'WHATEVER')],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'failure');
  assert.equal(result.kind, FINAL_CI_KIND_HUMAN);
});

// --- (k) StatusContext ---

test('finalCiVerdict: StatusContext state SUCCESS は success', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: [statusContext('x', 'SUCCESS')] };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.verified, true);
  assert.equal(result.reason, 'ok');
});

test('finalCiVerdict: StatusContext state PENDING は pending', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: [statusContext('x', 'PENDING')] };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'pending');
  assert.equal(result.kind, FINAL_CI_KIND_DETERMINISTIC);
});

test('finalCiVerdict: StatusContext state EXPECTED は pending', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: [statusContext('x', 'EXPECTED')] };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'pending');
});

test('finalCiVerdict: StatusContext state FAILURE 系は failure', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: [statusContext('x', 'ERROR')] };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'failure');
  assert.equal(result.kind, FINAL_CI_KIND_HUMAN);
});

// --- (l) __typename 未知 / name 欠落 → invalid ---

test('finalCiVerdict: __typename 未知 → invalid', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [{ __typename: 'SomethingElse', name: 'x', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'invalid');
  assert.equal(result.kind, FINAL_CI_KIND_DETERMINISTIC);
});

test('finalCiVerdict: CheckRun で name 欠落 → invalid', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'invalid');
});

test('finalCiVerdict: StatusContext で context 欠落 → invalid', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [{ __typename: 'StatusContext', state: 'SUCCESS' }],
  };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'invalid');
});

test('finalCiVerdict: statusCheckRollup が配列でない → invalid', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: 'not-an-array' };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'invalid');
  assert.equal(result.kind, FINAL_CI_KIND_DETERMINISTIC);
});

test('finalCiVerdict: statusCheckRollup の要素が非 object → invalid', () => {
  const meta = { ok: true, headRefOid: SHA_A, statusCheckRollup: ['not-an-object'] };
  const result = finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.equal(result.reason, 'invalid');
});

// --- (m) 入力 meta を mutate しない ---

test('finalCiVerdict: 入力 meta を mutate しない', () => {
  const meta = {
    ok: true,
    headRefOid: SHA_A,
    statusCheckRollup: [checkRun('lint', 'COMPLETED', 'SUCCESS')],
  };
  const before = JSON.parse(JSON.stringify(meta));
  finalCiVerdict({ expectedSha: SHA_A, meta });
  assert.deepEqual(meta, before);
});

// --- (n) finalCiPrompt ---

test('finalCiPrompt: repo 指定ありで gh pr view コマンドと --repo を含む', () => {
  const prompt = finalCiPrompt({ pr: 12, repo: 'o/r' });
  assert.ok(prompt.includes('gh pr view 12 --repo o/r --json headRefOid,statusCheckRollup'));
});

test('finalCiPrompt: repo が null なら --repo を含まない', () => {
  const prompt = finalCiPrompt({ pr: 12, repo: null });
  assert.ok(prompt.includes('gh pr view 12 --json headRefOid,statusCheckRollup'));
  assert.ok(!prompt.includes('--repo'));
});

test('finalCiPrompt: 禁止語を含まない（exec-proxy 規範）', () => {
  const prompt = finalCiPrompt({ pr: 12, repo: 'o/r' });
  assert.ok(!/sandbox|excludedCommands|permission|EPERM|迂回|代替手順|guard/i.test(prompt));
});

// --- (o) FINAL_CI_REASONS closed enum ---

test('FINAL_CI_REASONS は8値で全 finalCiVerdict の reason がこの集合に含まれる', () => {
  assert.equal(FINAL_CI_REASONS.length, 8);
  const cases = [
    finalCiVerdict({ expectedSha: SHA_A, meta: { ok: true, headRefOid: SHA_A, statusCheckRollup: [checkRun('a', 'COMPLETED', 'SUCCESS')] } }),
    finalCiVerdict({ expectedSha: null, meta: null }),
    finalCiVerdict({ expectedSha: SHA_A, meta: null }),
    finalCiVerdict({ expectedSha: SHA_A, meta: { ok: true, headRefOid: 'bad', statusCheckRollup: [] } }),
    finalCiVerdict({ expectedSha: SHA_A, meta: { ok: true, headRefOid: SHA_B, statusCheckRollup: [] } }),
    finalCiVerdict({ expectedSha: SHA_A, meta: { ok: true, headRefOid: SHA_A, statusCheckRollup: [] } }),
    finalCiVerdict({ expectedSha: SHA_A, meta: { ok: true, headRefOid: SHA_A, statusCheckRollup: [checkRun('a', 'IN_PROGRESS', null)] } }),
    finalCiVerdict({ expectedSha: SHA_A, meta: { ok: true, headRefOid: SHA_A, statusCheckRollup: [checkRun('a', 'COMPLETED', 'FAILURE')] } }),
  ];
  for (const c of cases) {
    assert.ok(FINAL_CI_REASONS.includes(c.reason), `unexpected reason: ${c.reason}`);
  }
});

// --- FINAL_CI_META schema shape ---

test('FINAL_CI_META は required に ok を持つ object schema', () => {
  assert.equal(FINAL_CI_META.type, 'object');
  assert.deepEqual(FINAL_CI_META.required, ['ok']);
  assert.equal(FINAL_CI_META.properties.ok.type, 'boolean');
  assert.deepEqual(FINAL_CI_META.properties.headRefOid.type, ['string', 'null']);
  assert.equal(FINAL_CI_META.properties.statusCheckRollup.type, 'array');
});
