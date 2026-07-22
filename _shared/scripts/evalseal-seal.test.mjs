// issue #411 (epic #390 Phase 3): EvalSeal seal/check 決定論 script のテスト。
//
// 実 git repo（tmpdir に git init）を使い、CLI 経由で evalseal-seal.mjs を起動して
// stdout の JSON 1行を検証する。TDD: このテストを先に書き red を確認してから
// evalseal-seal.mjs を実装する。

import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReceipt } from '../../_lib/trust-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, 'evalseal-seal.mjs');
const FIXTURES_DIR = join(__dirname, '..', '..', '_lib', 'fixtures', 'trust');

let tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'evalseal-test-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/it-all-playpark/skills.git']);
  writeFileSync(join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function writeTempJson(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'evalseal-test-payload-'));
  tmpDirs.push(dir);
  const file = join(dir, 'payload.json');
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

function gitRevParse(repo, ref) {
  return execFileSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8' }).trim();
}

function runScript(args, opts = {}) {
  const out = execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
  return JSON.parse(out.trim());
}

function sealArgs(repo, obligationFile, overrides = {}) {
  return [
    '--worktree', overrides.worktree ?? repo,
    '--base', overrides.base ?? 'HEAD',
    '--identity', overrides.identity ?? '411',
    '--configured-mode', overrides.configuredMode ?? 'shadow',
    '--tree-source', overrides.treeSource ?? 'head',
    ...(overrides.qualityModel ? ['--quality-model', overrides.qualityModel] : []),
    '--obligation-file', obligationFile,
  ];
}

// ---- (a) seal 正常系 ----

test('seal: ok:true, receipt が evalseal/1 schema に合格し record_integrity は advisory、anchors が実 OID と一致する', () => {
  const repo = initRepo();
  const obligation = { verdict: 'pass', reason_code: 'OK', evidence: ['e1', 'unicode: café \n line2'], context: { foo: 'bar' } };
  const obligationFile = writeTempJson(obligation);

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, true);
  assert.equal(out.mode, 'shadow');
  assert.equal(out.stage, 'evaluate');

  const receipt = out.receipt;
  assert.deepEqual(validateReceipt(receipt), { ok: true, reason_code: 'OK', detail: '' });
  assert.equal(receipt.trust.record_integrity, 'advisory');
  assert.equal(receipt.schema_version, 'evalseal/1');
  assert.equal(receipt.subject.kind, 'pull_request');
  assert.equal(receipt.subject.identity, '411');
  assert.equal(receipt.outcome.verdict, 'pass');
  assert.equal(receipt.outcome.reason_code, 'OK');

  const headOid = gitRevParse(repo, 'HEAD');
  const treeOid = gitRevParse(repo, 'HEAD^{tree}');
  assert.equal(receipt.anchors.head_oid, headOid);
  assert.equal(receipt.anchors.base_oid, headOid);
  assert.equal(receipt.anchors.tree_oid, treeOid);
  assert.match(receipt.anchors.bundle_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.anchors.evidence_digest, /^sha256:[0-9a-f]{64}$/);

  assert.ok(out.envelope);
  assert.equal(out.envelope.layer, 'evalseal');
  assert.equal(out.envelope.mode, 'shadow');
  assert.equal(out.envelope.receipt_id, receipt.receipt_id);
});

test('seal: tree-source working は untracked 変更を反映し tree-source head とは異なる tree_oid になる（実 index/working tree は不変）', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'pass', reason_code: 'OK', evidence: [] });

  const beforeHead = runScript(sealArgs(repo, obligationFile, { treeSource: 'head' }));
  const beforeWorking = runScript(sealArgs(repo, obligationFile, { treeSource: 'working' }));
  assert.equal(beforeHead.receipt.anchors.tree_oid, beforeWorking.receipt.anchors.tree_oid);

  writeFileSync(join(repo, 'untracked.txt'), 'x\n');

  const afterHead = runScript(sealArgs(repo, obligationFile, { treeSource: 'head' }));
  const afterWorking = runScript(sealArgs(repo, obligationFile, { treeSource: 'working' }));

  assert.equal(afterHead.receipt.anchors.tree_oid, beforeHead.receipt.anchors.tree_oid);
  assert.notEqual(afterWorking.receipt.anchors.tree_oid, afterHead.receipt.anchors.tree_oid);

  // 実 index / working tree が不変であることの確認（untracked のまま、staged になっていない）
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.match(status, /^\?\? untracked\.txt/m);
});

// ---- (b) 決定論 ----

test('seal determinism: 同一入力を2回実行すると receipt は deep equal（envelope.run_id のみ異なる）', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'fail', reason_code: 'SCHEMA_MISSING_FIELD', evidence: ['a', 'b'] });
  const args = sealArgs(repo, obligationFile, { identity: '77', configuredMode: 'advisory', qualityModel: 'fable' });

  const out1 = runScript(args);
  const out2 = runScript(args);

  assert.deepEqual(out1.receipt, out2.receipt);
  assert.notEqual(out1.envelope.run_id, out2.envelope.run_id);
});

// ---- (c) remote slug 不一致 → off ----

test('remote が allowlist と別 slug なら mode off で receipt なし', () => {
  const repo = initRepo();
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git']);
  const obligationFile = writeTempJson({ verdict: 'pass', reason_code: 'OK', evidence: [] });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.deepEqual(out, { ok: true, mode: 'off' });
});

// ---- (d) TRUST_KILL_SWITCH ----

test('TRUST_KILL_SWITCH=1 なら allowlist 一致でも mode off', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'pass', reason_code: 'OK', evidence: [] });

  const out = runScript(sealArgs(repo, obligationFile), { env: { TRUST_KILL_SWITCH: '1' } });

  assert.deepEqual(out, { ok: true, mode: 'off' });
});

// ---- (e) configured-mode out-of-enum ----

test('configured-mode が enum 外なら ok:false（resolveLayerMode の throw を捕捉）', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'pass', reason_code: 'OK', evidence: [] });

  const out = runScript(sealArgs(repo, obligationFile, { configuredMode: 'bogus-mode' }));

  assert.equal(out.ok, false);
  assert.equal(typeof out.error, 'string');
  assert.ok(out.error.length > 0);
});

// ---- (f) obligation の不正値 ----

test('obligation.verdict が TRUST_VERDICTS 外なら ok:false', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'bogus', reason_code: 'OK', evidence: [] });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, false);
});

test('obligation.evidence が配列でないなら ok:false', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'pass', reason_code: 'OK', evidence: 'not-an-array' });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, false);
});

test('obligation.reason_code が TRUST_REASON_CODES 外なら ok:false', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'pass', reason_code: 'BOGUS_CODE', evidence: [] });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, false);
});

// ---- (g) check: pass → 旧 receipt の失効 (DIGEST_MISMATCH) ----

test('check: seal 直後の同一 tree では pass、その後 1 commit 追加すると inconclusive + DIGEST_MISMATCH', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'pass', reason_code: 'OK', evidence: ['e1'] });
  const sealOut = runScript(sealArgs(repo, obligationFile));
  const receiptFile = writeTempJson(sealOut.receipt);

  const checkArgsBase = [
    '--worktree', repo,
    '--base', 'HEAD',
    '--identity', '411',
    '--configured-mode', 'shadow',
    '--tree-source', 'head',
    '--check-receipt-file', receiptFile,
  ];

  const checkOut1 = runScript(checkArgsBase);
  assert.equal(checkOut1.ok, true);
  assert.deepEqual(checkOut1.check, { verdict: 'pass', reason_code: 'OK' });

  writeFileSync(join(repo, 'second.txt'), 'more\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'second commit']);

  const checkOut2 = runScript(checkArgsBase);
  assert.equal(checkOut2.ok, true);
  assert.equal(checkOut2.check.verdict, 'inconclusive');
  assert.equal(checkOut2.check.reason_code, 'DIGEST_MISMATCH');
});

// ---- (h) adversarial fixture 全6種 → inconclusive（成功扱いゼロ） ----

const ADVERSARIAL_FIXTURES = [
  'adversarial-cross-protocol.json',
  'adversarial-digest-mismatch.json',
  'adversarial-schema-invalid.json',
  'adversarial-unknown-field.json',
  'adversarial-unknown-enum.json',
  'adversarial-capability-missing.json',
];

for (const file of ADVERSARIAL_FIXTURES) {
  test(`check: adversarial fixture ${file} は verdict==='inconclusive'（成功扱いゼロ）`, () => {
    const repo = initRepo();
    const fixturePath = join(FIXTURES_DIR, file);

    const out = runScript([
      '--worktree', repo,
      '--base', 'HEAD',
      '--identity', '411',
      '--configured-mode', 'shadow',
      '--tree-source', 'head',
      '--check-receipt-file', fixturePath,
    ]);

    assert.equal(out.ok, true);
    assert.equal(out.check.verdict, 'inconclusive');
    assert.notEqual(out.check.verdict, 'pass');
  });
}

// ---- (i) tampered receipt_id ----

test('check: receipt_id を改竄した receipt は inconclusive + RECEIPT_ID_MISMATCH', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'pass', reason_code: 'OK', evidence: ['e1'] });
  const sealOut = runScript(sealArgs(repo, obligationFile));
  const tampered = { ...sealOut.receipt, receipt_id: 'sha256:' + '0'.repeat(64) };
  const receiptFile = writeTempJson(tampered);

  const out = runScript([
    '--worktree', repo,
    '--base', 'HEAD',
    '--identity', '411',
    '--configured-mode', 'shadow',
    '--tree-source', 'head',
    '--check-receipt-file', receiptFile,
  ]);

  assert.equal(out.ok, true);
  assert.equal(out.check.verdict, 'inconclusive');
  assert.equal(out.check.reason_code, 'RECEIPT_ID_MISMATCH');
});

// ---- CLI usage エラー ----

test('必須引数欠落は usage を stderr + exit 1', () => {
  try {
    runScript(['--worktree', '/tmp']);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});

test('--obligation-file / --check-receipt-file のどちらも無ければ usage + exit 1', () => {
  const repo = initRepo();
  try {
    runScript([
      '--worktree', repo,
      '--base', 'HEAD',
      '--identity', '411',
      '--configured-mode', 'shadow',
      '--tree-source', 'head',
    ]);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});
