// issue #471 (epic #390 Phase 6): EvalSeal (evalseal/2) seal/check 決定論 script のテスト。
//
// 実 git repo（tmpdir に git init）を使い、CLI 経由で evalseal-seal.mjs を起動して
// stdout の JSON 1行を検証する。obligation は closed {asserted:{evidence,context}} schema
// のみを受理し、outcome.verdict は --evidence-file から機械導出される（AC-2/AC-3/AC-4/AC-5）。

import { test, afterEach, vi } from 'vitest';
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

// このファイルは各テストが実 git repo (init/config/commit) + evalseal-seal.mjs CLI
// 起動 (内部で複数回 git を subprocess 実行) を組み合わせる統合テストであり、通常の
// vitest testTimeout デフォルト (5000ms) は CI 負荷時のプロセス生成コストに対して
// マージンが薄い。実測: フル suite 実行時の CPU 競合下でこのファイル内の異なる
// テスト（4 CLI 呼び出しを行うテスト等）が入れ替わりで 5000ms を超過する
// (単発では 2〜3s 台、負荷時は 5.3〜7.6s 観測)。アサーションは一切変更せず、
// このファイル全体の実行時間予算のみ引き上げる。
vi.setConfig({ testTimeout: 20000 });

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

function writeTempRaw(text) {
  const dir = mkdtempSync(join(tmpdir(), 'evalseal-test-raw-'));
  tmpDirs.push(dir);
  const file = join(dir, 'evidence.txt');
  writeFileSync(file, text);
  return file;
}

function nonexistentPath() {
  const dir = mkdtempSync(join(tmpdir(), 'evalseal-test-missing-'));
  tmpDirs.push(dir);
  return join(dir, 'nonexistent.json');
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

const CLEAN_BUNDLE = { risk: { ok: true, hits: [] }, test: { green: true } };
const DANGER_BUNDLE = { risk: { ok: true, hits: [{ class: 'secrets', file: 'x' }] }, test: { green: true } };
const TESTWEAKENING_ONLY_BUNDLE = { risk: { ok: true, hits: [{ class: 'test-weakening', file: 'x' }] }, test: { green: true } };
const RED_TEST_BUNDLE = { risk: { ok: true, hits: [] }, test: { green: false } };
const RISK_FAIL_BUNDLE = { risk: { ok: false, hits: [] }, test: { green: true } };
const NO_GREEN_BUNDLE = { risk: { ok: true, hits: [] }, test: {} };

function sealArgs(repo, obligationFile, overrides = {}) {
  const evidenceFile = overrides.evidenceFile ?? writeTempJson(CLEAN_BUNDLE);
  return [
    '--worktree', overrides.worktree ?? repo,
    '--base', overrides.base ?? 'HEAD',
    '--identity', overrides.identity ?? '411',
    '--configured-mode', overrides.configuredMode ?? 'shadow',
    '--tree-source', overrides.treeSource ?? 'head',
    ...(overrides.qualityModel ? ['--quality-model', overrides.qualityModel] : []),
    '--obligation-file', obligationFile,
    '--evidence-file', evidenceFile,
  ];
}

function cleanObligationFile() {
  return writeTempJson({ asserted: { evidence: ['e1', 'unicode: café \n line2'], context: { foo: 'bar' } } });
}

// ---- (a) seal 正常系 ----

test('seal: ok:true, receipt が evalseal/2 schema に合格し record_integrity は advisory、anchors が実 OID と一致する', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, true);
  assert.equal(out.mode, 'shadow');
  assert.equal(out.stage, 'evaluate');

  const receipt = out.receipt;
  assert.deepEqual(validateReceipt(receipt), { ok: true, reason_code: 'OK', detail: '' });
  assert.equal(receipt.trust.record_integrity, 'advisory');
  assert.equal(receipt.schema_version, 'evalseal/2');
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
  assert.match(receipt.anchors.evidence_bundle_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.anchors.asserted_digest, /^sha256:[0-9a-f]{64}$/);

  assert.ok(out.envelope);
  assert.equal(out.envelope.layer, 'evalseal');
  assert.equal(out.envelope.mode, 'shadow');
  assert.equal(out.envelope.receipt_id, receipt.receipt_id);
});

test('seal: tree-source working は untracked 変更を反映し tree-source head とは異なる tree_oid になる（実 index/working tree は不変）', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ asserted: { evidence: [], context: {} } });
  const evidenceFile = writeTempJson(CLEAN_BUNDLE);

  const beforeHead = runScript(sealArgs(repo, obligationFile, { treeSource: 'head', evidenceFile }));
  const beforeWorking = runScript(sealArgs(repo, obligationFile, { treeSource: 'working', evidenceFile }));
  assert.equal(beforeHead.receipt.anchors.tree_oid, beforeWorking.receipt.anchors.tree_oid);

  writeFileSync(join(repo, 'untracked.txt'), 'x\n');

  const afterHead = runScript(sealArgs(repo, obligationFile, { treeSource: 'head', evidenceFile }));
  const afterWorking = runScript(sealArgs(repo, obligationFile, { treeSource: 'working', evidenceFile }));

  assert.equal(afterHead.receipt.anchors.tree_oid, beforeHead.receipt.anchors.tree_oid);
  assert.notEqual(afterWorking.receipt.anchors.tree_oid, afterHead.receipt.anchors.tree_oid);

  // 実 index / working tree が不変であることの確認（untracked のまま、staged になっていない）
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.match(status, /^\?\? untracked\.txt/m);
});

// ---- (b) 決定論 ----

test('seal determinism: 同一入力を2回実行すると receipt は deep equal（envelope.run_id のみ異なる）', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ asserted: { evidence: ['a', 'b'], context: {} } });
  const evidenceFile = writeTempJson(DANGER_BUNDLE);
  const args = sealArgs(repo, obligationFile, { identity: '77', configuredMode: 'advisory', qualityModel: 'fable', evidenceFile });

  const out1 = runScript(args);
  const out2 = runScript(args);

  assert.deepEqual(out1.receipt, out2.receipt);
  assert.notEqual(out1.envelope.run_id, out2.envelope.run_id);
});

// ---- (c) remote slug 不一致 → off ----

test('remote が allowlist と別 slug なら mode off で receipt なし', () => {
  const repo = initRepo();
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git']);
  const obligationFile = writeTempJson({ asserted: { evidence: [], context: {} } });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.deepEqual(out, { ok: true, mode: 'off' });
});

// ---- (d) TRUST_KILL_SWITCH ----

test('TRUST_KILL_SWITCH=1 なら allowlist 一致でも mode off', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ asserted: { evidence: [], context: {} } });

  const out = runScript(sealArgs(repo, obligationFile), { env: { TRUST_KILL_SWITCH: '1' } });

  assert.deepEqual(out, { ok: true, mode: 'off' });
});

// ---- (e) configured-mode out-of-enum ----

test('configured-mode が enum 外なら ok:false（resolveLayerMode の throw を捕捉）', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ asserted: { evidence: [], context: {} } });

  const out = runScript(sealArgs(repo, obligationFile, { configuredMode: 'bogus-mode' }));

  assert.equal(out.ok, false);
  assert.equal(typeof out.error, 'string');
  assert.ok(out.error.length > 0);
});

// ---- (f) obligation の closed schema 違反 (AC-2) ----

test('obligation top-level に verdict を書くと ok:false（derived 区画への外部入力経路が無い）', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ asserted: { evidence: ['e1'], context: {} }, verdict: 'pass' });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, false);
  assert.match(out.error, /unknown top-level key/);
});

test('obligation top-level に reason_code / evidence を直下に書くと ok:false（旧 evalseal/1 形式は非受理）', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ verdict: 'pass', reason_code: 'OK', evidence: ['e1'] });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, false);
});

test('obligation.asserted が欠落なら ok:false', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({});

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, false);
});

test('obligation.asserted.evidence が配列でないなら ok:false', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ asserted: { evidence: 'not-an-array', context: {} } });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, false);
});

test('obligation.asserted.context が欠落なら ok:false', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ asserted: { evidence: [] } });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, false);
});

test('obligation.asserted に未知キーがあれば ok:false', () => {
  const repo = initRepo();
  const obligationFile = writeTempJson({ asserted: { evidence: [], context: {}, extra: 1 } });

  const out = runScript(sealArgs(repo, obligationFile));

  assert.equal(out.ok, false);
});

// ---- (g) evidence bundle からの verdict 機械導出 (AC-3/AC-4) ----

test('AC-4: clean evidence bundle (risk.ok:true, hits:[], test.green:true) は pass', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
  const evidenceFile = writeTempJson(CLEAN_BUNDLE);

  const out = runScript(sealArgs(repo, obligationFile, { evidenceFile }));

  assert.equal(out.ok, true);
  assert.equal(out.receipt.outcome.verdict, 'pass');
  assert.equal(out.receipt.outcome.reason_code, 'OK');
});

test('AC-4: floor 違反 hit (class!==test-weakening) を含む evidence bundle は fail（同一 obligation で verdict のみ変わる）', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();

  const passOut = runScript(sealArgs(repo, obligationFile, { evidenceFile: writeTempJson(CLEAN_BUNDLE) }));
  const failOut = runScript(sealArgs(repo, obligationFile, { evidenceFile: writeTempJson(DANGER_BUNDLE) }));

  assert.equal(passOut.receipt.outcome.verdict, 'pass');
  assert.equal(failOut.receipt.outcome.verdict, 'fail');
  assert.equal(failOut.receipt.outcome.reason_code, 'OK');
  // asserted 区画は同一 obligation から生成しているため asserted_digest は不変
  assert.equal(passOut.receipt.anchors.asserted_digest, failOut.receipt.anchors.asserted_digest);
});

test('AC-4: hits が test-weakening class のみなら floor 違反扱いされず pass', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
  const evidenceFile = writeTempJson(TESTWEAKENING_ONLY_BUNDLE);

  const out = runScript(sealArgs(repo, obligationFile, { evidenceFile }));

  assert.equal(out.receipt.outcome.verdict, 'pass');
});

test('test.green===false は fail', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
  const evidenceFile = writeTempJson(RED_TEST_BUNDLE);

  const out = runScript(sealArgs(repo, obligationFile, { evidenceFile }));

  assert.equal(out.receipt.outcome.verdict, 'fail');
  assert.equal(out.receipt.outcome.reason_code, 'OK');
});

test('AC-3: evidence-file が存在しない場合は inconclusive + EVIDENCE_NOT_DERIVED（receipt は発行される）', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();

  const out = runScript(sealArgs(repo, obligationFile, { evidenceFile: nonexistentPath() }));

  assert.equal(out.ok, true);
  assert.equal(out.receipt.outcome.verdict, 'inconclusive');
  assert.equal(out.receipt.outcome.reason_code, 'EVIDENCE_NOT_DERIVED');
  assert.match(out.receipt.anchors.evidence_bundle_digest, /^sha256:[0-9a-f]{64}$/);
});

test('AC-3: evidence-file が不正 JSON の場合は inconclusive + EVIDENCE_NOT_DERIVED', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
  const evidenceFile = writeTempRaw('not json {');

  const out = runScript(sealArgs(repo, obligationFile, { evidenceFile }));

  assert.equal(out.ok, true);
  assert.equal(out.receipt.outcome.verdict, 'inconclusive');
  assert.equal(out.receipt.outcome.reason_code, 'EVIDENCE_NOT_DERIVED');
});

test('AC-3: evidence bundle の risk.ok===false は fail ではなく inconclusive + EVIDENCE_NOT_DERIVED', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
  const evidenceFile = writeTempJson(RISK_FAIL_BUNDLE);

  const out = runScript(sealArgs(repo, obligationFile, { evidenceFile }));

  assert.equal(out.ok, true);
  assert.equal(out.receipt.outcome.verdict, 'inconclusive');
  assert.equal(out.receipt.outcome.reason_code, 'EVIDENCE_NOT_DERIVED');
});

test('test.green 欠落は inconclusive + EVIDENCE_NOT_DERIVED', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
  const evidenceFile = writeTempJson(NO_GREEN_BUNDLE);

  const out = runScript(sealArgs(repo, obligationFile, { evidenceFile }));

  assert.equal(out.receipt.outcome.verdict, 'inconclusive');
  assert.equal(out.receipt.outcome.reason_code, 'EVIDENCE_NOT_DERIVED');
});

test('test.green===null は inconclusive + EVIDENCE_NOT_DERIVED', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
  const evidenceFile = writeTempJson({ risk: { ok: true, hits: [] }, test: { green: null } });

  const out = runScript(sealArgs(repo, obligationFile, { evidenceFile }));

  assert.equal(out.receipt.outcome.verdict, 'inconclusive');
  assert.equal(out.receipt.outcome.reason_code, 'EVIDENCE_NOT_DERIVED');
});

// ---- (h) asserted 区画の変更は verdict/evidence_bundle_digest に影響しない (AC-5) ----

test('AC-5: asserted.evidence のみ変更しても outcome.verdict / evidence_bundle_digest は不変、receipt_id / asserted_digest だけが変わる', () => {
  const repo = initRepo();
  const evidenceFile = writeTempJson(CLEAN_BUNDLE);
  const obligationFile1 = writeTempJson({ asserted: { evidence: ['e1'], context: { foo: 'bar' } } });
  const obligationFile2 = writeTempJson({ asserted: { evidence: ['e1', 'e2-different'], context: { foo: 'bar' } } });

  const out1 = runScript(sealArgs(repo, obligationFile1, { evidenceFile }));
  const out2 = runScript(sealArgs(repo, obligationFile2, { evidenceFile }));

  assert.equal(out1.receipt.outcome.verdict, out2.receipt.outcome.verdict);
  assert.equal(out1.receipt.anchors.evidence_bundle_digest, out2.receipt.anchors.evidence_bundle_digest);
  assert.notEqual(out1.receipt.anchors.asserted_digest, out2.receipt.anchors.asserted_digest);
  assert.notEqual(out1.receipt.receipt_id, out2.receipt.receipt_id);
});

// ---- (i) check: pass → 旧 receipt の失効 (DIGEST_MISMATCH) ----

test('check: seal 直後の同一 tree では pass、その後 1 commit 追加すると inconclusive + DIGEST_MISMATCH', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
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

// ---- (j) adversarial fixture 全6種 → inconclusive（成功扱いゼロ） ----

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

// ---- (k) tampered receipt_id ----

test('check: receipt_id を改竄した receipt は inconclusive + RECEIPT_ID_MISMATCH', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
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

test('--obligation-file 指定時に --evidence-file 未指定なら usage + exit 1', () => {
  const repo = initRepo();
  const obligationFile = cleanObligationFile();
  try {
    runScript([
      '--worktree', repo,
      '--base', 'HEAD',
      '--identity', '411',
      '--configured-mode', 'shadow',
      '--tree-source', 'head',
      '--obligation-file', obligationFile,
    ]);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});
