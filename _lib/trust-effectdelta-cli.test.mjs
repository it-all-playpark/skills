// issue #412 (#390 Phase 4): trust-effectdelta-cli.mjs の thin CLI 境界 test。
//
// CLI をサブプロセスとして spawn し、実際の argv/--input file 境界を通して検証する
// （_lib/trust-effectdelta.test.mjs は pure core の単体検証であり、CLI 側の
// mode 解決・envelope 構築・op dispatch・エラーハンドリングは CLI 境界で検証する必要が
// ある。_lib/trust-surfaceproof-cli.test.mjs と同じ spawnSync パターンを踏襲）。
//
// NOTE: リポジトリのテストランナーは vitest（tests/run-node-tests.sh, issue #356 の
// vitest 移行後は `node --test` フォールバック無し）。他の `_lib/*-cli.test.mjs` と
// 同様に `import { test } from 'vitest'` を使う。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'trust-effectdelta-cli.mjs');

const REPO_SLUG = 'it-all-playpark/skills';

function withTmpDir(fn) {
  const tmp = mkdtempSync(join(os.tmpdir(), 'effectdelta-cli-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function runCli(op, inputObj, extraArgs = []) {
  return withTmpDir((tmp) => {
    const inputPath = join(tmp, 'input.json');
    writeFileSync(inputPath, JSON.stringify(inputObj), 'utf8');
    const args = op == null ? [...extraArgs] : [op, '--input', inputPath, ...extraArgs];
    return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
  });
}

function runCliOk(op, inputObj) {
  const res = runCli(op, inputObj);
  if (res.status !== 0) {
    throw new Error(`CLI ${op} failed (status=${res.status}): stdout=${res.stdout} stderr=${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

// ---- op dispatch / error handling ----

test('未知の op は stderr に JSON error を書いて exit 1', () => {
  const res = runCli('bogus-op', { repoSlug: REPO_SLUG, killSwitch: false, configuredMode: 'shadow' });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  const errObj = JSON.parse(res.stderr);
  assert.match(errObj.error, /bogus-op/);
});

test('op 未指定は stderr に JSON error を書いて exit 1', () => {
  const res = runCli(null, {});
  assert.equal(res.status, 1);
  const errObj = JSON.parse(res.stderr);
  assert.match(errObj.error, /op/);
});

test('--input 省略は stderr に JSON error を書いて exit 1', () => {
  const res = spawnSync(process.execPath, [CLI_PATH, 'pr-classify'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  const errObj = JSON.parse(res.stderr);
  assert.match(errObj.error, /--input/);
});

test('--input が有効な JSON でないファイルは stderr に JSON error を書いて exit 1', () => {
  withTmpDir((tmp) => {
    const inputPath = join(tmp, 'input.json');
    writeFileSync(inputPath, 'not json', 'utf8');
    const res = spawnSync(process.execPath, [CLI_PATH, 'pr-classify', '--input', inputPath], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    const errObj = JSON.parse(res.stderr);
    assert.ok(errObj.error);
  });
});

// ---- mode off 早期 return ----

test('killSwitch===true なら mode off で {ok:true, mode:"off"} のみ返す（pr-classify）', () => {
  const out = runCliOk('pr-classify', {
    repoSlug: REPO_SLUG,
    killSwitch: true,
    configuredMode: 'shadow',
    intended: { repo: 'org/repo', issue: 1, base: 'main', head_oid: 'a'.repeat(40) },
    candidates: [],
    readback: null,
    responseLost: false,
  });
  assert.deepEqual(out, { ok: true, mode: 'off' });
});

test('repoSlug が allowlist と不一致なら mode off で {ok:true, mode:"off"} のみ返す（comment-classify）', () => {
  const out = runCliOk('comment-classify', {
    repoSlug: 'someone-else/fork',
    killSwitch: false,
    configuredMode: 'shadow',
    repo: 'org/repo',
    pr: 5,
    effect_type: 'summary-comment',
    run_id: 'run-1',
    body_digest: `sha256:${'a'.repeat(64)}`,
    matches: [],
    readback: null,
  });
  assert.deepEqual(out, { ok: true, mode: 'off' });
});

test('configuredMode 未指定(デフォルトoff)なら derive-comment-id も mode off のみ返す', () => {
  const out = runCliOk('derive-comment-id', {
    repoSlug: REPO_SLUG,
    killSwitch: false,
    repo: 'org/repo',
    pr: 5,
    effect_type: 'summary-comment',
    run_id: 'run-1',
    body_digest: `sha256:${'a'.repeat(64)}`,
  });
  assert.deepEqual(out, { ok: true, mode: 'off' });
});

// ---- derive-comment-id ----

test('derive-comment-id: mode shadow で effect_id を返す（決定論）', () => {
  const input = {
    repoSlug: REPO_SLUG,
    killSwitch: false,
    configuredMode: 'shadow',
    repo: 'org/repo',
    pr: 5,
    effect_type: 'summary-comment',
    run_id: 'run-1',
    body_digest: `sha256:${'b'.repeat(64)}`,
  };
  const out1 = runCliOk('derive-comment-id', input);
  const out2 = runCliOk('derive-comment-id', { ...input });
  assert.equal(out1.ok, true);
  assert.equal(out1.mode, 'shadow');
  assert.equal(out1.op, 'derive-comment-id');
  assert.ok(typeof out1.effect_id === 'string' && out1.effect_id.startsWith('sha256:'));
  assert.equal(out1.effect_id, out2.effect_id);
});

// ---- pr-classify ----

test('pr-classify: readback一致 + candidates中1件 -> observed/OK, receipt/envelope が妥当な形状', () => {
  const headOid = 'c'.repeat(40);
  const intended = { repo: 'org/repo', issue: 42, base: 'main', head_oid: headOid };
  const openMatch = { number: 1, url: 'https://github.com/org/repo/pull/1', baseRefName: 'main', headRefOid: headOid, state: 'OPEN' };
  const out = runCliOk('pr-classify', {
    repoSlug: REPO_SLUG,
    killSwitch: false,
    configuredMode: 'shadow',
    intended,
    candidates: [openMatch],
    readback: openMatch,
    responseLost: false,
  });
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'shadow');
  assert.equal(out.op, 'pr-classify');
  assert.deepEqual(out.observation, { status: 'observed', reason_code: 'OK' });
  assert.ok(typeof out.effect_id === 'string');
  assert.equal(out.receipt.schema_version, 'effectdelta/1');
  assert.equal(out.receipt.outcome.verdict, 'pass');
  assert.equal(out.receipt.anchors.effect_id, out.effect_id);
  assert.equal(out.receipt.trust.record_integrity, 'advisory');
  assert.equal(out.envelope.layer, 'effectdelta');
  assert.equal(out.envelope.mode, 'shadow');
  assert.equal(out.envelope.receipt_id, out.receipt.receipt_id);
  assert.equal(out.envelope.verdict, 'pass');
});

test('pr-classify: candidates=null (listing失敗) かつ responseLost=false -> inconclusive/PROBE_FAILED', () => {
  const intended = { repo: 'org/repo', issue: 42, base: 'main', head_oid: 'd'.repeat(40) };
  const out = runCliOk('pr-classify', {
    repoSlug: REPO_SLUG,
    killSwitch: false,
    configuredMode: 'shadow',
    intended,
    candidates: null,
    readback: null,
    responseLost: false,
  });
  assert.deepEqual(out.observation, { status: 'inconclusive', reason_code: 'PROBE_FAILED' });
  assert.equal(out.receipt.outcome.verdict, 'inconclusive');
});

test('pr-classify: intended 欠落は stderr JSON error + exit 1', () => {
  const res = runCli('pr-classify', {
    repoSlug: REPO_SLUG,
    killSwitch: false,
    configuredMode: 'shadow',
    intended: { repo: 'org/repo', base: 'main' },
    candidates: [],
    readback: null,
  });
  assert.equal(res.status, 1);
  const errObj = JSON.parse(res.stderr);
  assert.ok(errObj.error);
});

// ---- comment-classify ----

test('comment-classify: exactly-1 + readback一致 -> observed/OK', () => {
  const bodyDigest = `sha256:${'e'.repeat(64)}`;
  const input = {
    repoSlug: REPO_SLUG,
    killSwitch: false,
    configuredMode: 'shadow',
    repo: 'org/repo',
    pr: 9,
    effect_type: 'summary-comment',
    run_id: 'run-9',
    body_digest: bodyDigest,
  };
  const derived = runCliOk('derive-comment-id', input);
  const matchedEntry = { id: 100, body_digest: bodyDigest, author: 'github-actions[bot]', pr: 9 };
  const out = runCliOk('comment-classify', {
    ...input,
    matches: [matchedEntry],
    readback: matchedEntry,
  });
  assert.equal(out.ok, true);
  assert.equal(out.op, 'comment-classify');
  assert.deepEqual(out.observation, { status: 'observed', reason_code: 'OK' });
  assert.equal(out.effect_id, derived.effect_id);
  assert.equal(out.receipt.outcome.verdict, 'pass');
});

test('comment-classify: preexisting=true で1件発見(今回投稿せず) -> observed/DUPLICATE_EFFECT', () => {
  const bodyDigest = `sha256:${'f'.repeat(64)}`;
  const matchedEntry = { id: 101, body_digest: bodyDigest, author: 'github-actions[bot]', pr: 9 };
  const out = runCliOk('comment-classify', {
    repoSlug: REPO_SLUG,
    killSwitch: false,
    configuredMode: 'shadow',
    repo: 'org/repo',
    pr: 9,
    effect_type: 'summary-comment',
    run_id: 'run-9',
    body_digest: bodyDigest,
    matches: [matchedEntry],
    readback: null,
    preexisting: true,
  });
  assert.deepEqual(out.observation, { status: 'observed', reason_code: 'DUPLICATE_EFFECT' });
});

test('comment-classify: matches 2件以上 -> mismatch/DUPLICATE_EFFECT', () => {
  const bodyDigest = `sha256:${'0'.repeat(64)}`;
  const entryA = { id: 1, body_digest: bodyDigest, author: 'a', pr: 9 };
  const entryB = { id: 2, body_digest: bodyDigest, author: 'a', pr: 9 };
  const out = runCliOk('comment-classify', {
    repoSlug: REPO_SLUG,
    killSwitch: false,
    configuredMode: 'shadow',
    repo: 'org/repo',
    pr: 9,
    effect_type: 'summary-comment',
    run_id: 'run-9',
    body_digest: bodyDigest,
    matches: [entryA, entryB],
    readback: entryA,
  });
  assert.deepEqual(out.observation, { status: 'mismatch', reason_code: 'DUPLICATE_EFFECT' });
  assert.equal(out.receipt.outcome.verdict, 'fail');
});

test('comment-classify: responseLost=true かつ matches=[] -> inconclusive/RESPONSE_LOST', () => {
  const bodyDigest = `sha256:${'1'.repeat(64)}`;
  const out = runCliOk('comment-classify', {
    repoSlug: REPO_SLUG,
    killSwitch: false,
    configuredMode: 'shadow',
    repo: 'org/repo',
    pr: 9,
    effect_type: 'summary-comment',
    run_id: 'run-9',
    body_digest: bodyDigest,
    matches: [],
    readback: null,
    responseLost: true,
  });
  assert.deepEqual(out.observation, { status: 'inconclusive', reason_code: 'RESPONSE_LOST' });
});
