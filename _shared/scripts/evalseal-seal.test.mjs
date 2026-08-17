// issue #471 (epic #390 Phase 6): EvalSeal (evalseal/2) seal/check 決定論 script のテスト。
// issue #495 で obligation/evidence の入力インターフェースを --obligation-file/--evidence-file
// から --risk-file/--test-file/--context-json（実行証跡ファイル 2 本 + 数値 context）へ置換した
// ことに合わせて全面書き換え。deriveOutcome の pass/fail 判定条件・resolveTrustLevel の
// same-harness 'advisory' 固定・fail-open 設計・receipt schema（evalseal/2）は不変（非目標）。
//
// 実 git repo（tmpdir に git init）を使い、CLI 経由で evalseal-seal.mjs を起動して
// stdout の JSON 1行を検証する。risk file は diff-risk-classify.sh の stdout JSON
// （{ok, hits:[{file,class,severity,pattern?}]} 相当）、test file は dev-flow GREEN schema
// （{tests, green, summary?, epoch?}）を模す。

import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReceipt } from '../../_lib/trust-schema.mjs';
import { sha256Hex } from '../../_lib/trust-digest.mjs';

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

const CLEAN_RISK = { ok: true, hits: [] };
const DANGER_RISK = { ok: true, hits: [{ class: 'secrets', file: 'x' }] };
const TESTWEAKENING_ONLY_RISK = { ok: true, hits: [{ class: 'test-weakening', file: 'x' }] };
const RISK_FAIL = { ok: false, hits: [], error: 'grep failed', exit_code: 1 };

const GREEN_TEST = { tests: 'passed', green: true };
const RED_TEST = { tests: 'failed', green: false };
const NO_GREEN_TEST = { tests: 'no_tests' };
const NULL_GREEN_TEST = { tests: 'no_tests', green: null };

function sealArgs(repo, overrides = {}) {
  const riskFile = overrides.riskFile ?? writeTempJson(CLEAN_RISK);
  const testFile = overrides.testFile ?? writeTempJson(GREEN_TEST);
  return [
    '--worktree', overrides.worktree ?? repo,
    '--base', overrides.base ?? 'HEAD',
    '--identity', overrides.identity ?? '411',
    '--configured-mode', overrides.configuredMode ?? 'shadow',
    '--tree-source', overrides.treeSource ?? 'head',
    ...(overrides.qualityModel ? ['--quality-model', overrides.qualityModel] : []),
    '--risk-file', riskFile,
    '--test-file', testFile,
    ...(overrides.contextJson !== undefined ? ['--context-json', overrides.contextJson] : []),
  ];
}

// ---- (a) seal 正常系 ----

test('seal: ok:true, receipt が evalseal/2 schema に合格し record_integrity は advisory、anchors が実 OID と一致し evidence_bundle_digest が入力ファイル raw byte から再計算可能', () => {
  const repo = initRepo();
  const riskFile = writeTempJson(CLEAN_RISK);
  const testFile = writeTempJson(GREEN_TEST);

  const out = runScript(sealArgs(repo, { riskFile, testFile }));

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

  // evidence_bundle_digest は risk/test 両ファイルの raw byte から決定論導出される
  // （実行証跡ファイル由来であることの統合検証。issue #495）。
  const riskRaw = readFileSync(riskFile, 'utf8');
  const testRaw = readFileSync(testFile, 'utf8');
  assert.equal(receipt.anchors.evidence_bundle_digest, sha256Hex(`${riskRaw}\n${testRaw}`));

  assert.ok(out.envelope);
  assert.equal(out.envelope.layer, 'evalseal');
  assert.equal(out.envelope.mode, 'shadow');
  assert.equal(out.envelope.receipt_id, receipt.receipt_id);
});

test('seal: tree-source working は untracked 変更を反映し tree-source head とは異なる tree_oid になる（実 index/working tree は不変）', () => {
  const repo = initRepo();
  const riskFile = writeTempJson(CLEAN_RISK);
  const testFile = writeTempJson(GREEN_TEST);

  const beforeHead = runScript(sealArgs(repo, { treeSource: 'head', riskFile, testFile }));
  const beforeWorking = runScript(sealArgs(repo, { treeSource: 'working', riskFile, testFile }));
  assert.equal(beforeHead.receipt.anchors.tree_oid, beforeWorking.receipt.anchors.tree_oid);

  writeFileSync(join(repo, 'untracked.txt'), 'x\n');

  const afterHead = runScript(sealArgs(repo, { treeSource: 'head', riskFile, testFile }));
  const afterWorking = runScript(sealArgs(repo, { treeSource: 'working', riskFile, testFile }));

  assert.equal(afterHead.receipt.anchors.tree_oid, beforeHead.receipt.anchors.tree_oid);
  assert.notEqual(afterWorking.receipt.anchors.tree_oid, afterHead.receipt.anchors.tree_oid);

  // 実 index / working tree が不変であることの確認（untracked のまま、staged になっていない）
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.match(status, /^\?\? untracked\.txt/m);
});

// ---- 決定論 ----

test('seal determinism: 同一入力を2回実行すると receipt は deep equal（envelope.run_id のみ異なる）', () => {
  const repo = initRepo();
  const riskFile = writeTempJson(DANGER_RISK);
  const testFile = writeTempJson(GREEN_TEST);
  const args = sealArgs(repo, { identity: '77', configuredMode: 'advisory', qualityModel: 'fable', riskFile, testFile });

  const out1 = runScript(args);
  const out2 = runScript(args);

  assert.deepEqual(out1.receipt, out2.receipt);
  assert.notEqual(out1.envelope.run_id, out2.envelope.run_id);
});

// ---- remote slug 不一致 → off ----

test('remote が allowlist と別 slug なら mode off で receipt なし', () => {
  const repo = initRepo();
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git']);

  const out = runScript(sealArgs(repo));

  assert.deepEqual(out, { ok: true, mode: 'off' });
});

// ---- TRUST_KILL_SWITCH ----

test('TRUST_KILL_SWITCH=1 なら allowlist 一致でも mode off', () => {
  const repo = initRepo();

  const out = runScript(sealArgs(repo), { env: { TRUST_KILL_SWITCH: '1' } });

  assert.deepEqual(out, { ok: true, mode: 'off' });
});

// ---- configured-mode out-of-enum ----

test('configured-mode が enum 外なら ok:false（resolveLayerMode の throw を捕捉）', () => {
  const repo = initRepo();

  const out = runScript(sealArgs(repo, { configuredMode: 'bogus-mode' }));

  assert.equal(out.ok, false);
  assert.equal(typeof out.error, 'string');
  assert.ok(out.error.length > 0);
});

// ---- (b)(c)(d) 実行証跡ファイルからの verdict 機械導出（deriveOutcome 判定条件は非目標として不変） ----

test('(a) 有効 risk(ok:true,hits:[])+test(green:true) は pass', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: writeTempJson(CLEAN_RISK), testFile: writeTempJson(GREEN_TEST) }));

  assert.equal(out.ok, true);
  assert.equal(out.receipt.outcome.verdict, 'pass');
  assert.equal(out.receipt.outcome.reason_code, 'OK');
});

test('(b) floor 違反 hit (class!==test-weakening) を含む risk file は fail', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: writeTempJson(DANGER_RISK), testFile: writeTempJson(GREEN_TEST) }));

  assert.equal(out.ok, true);
  assert.equal(out.receipt.outcome.verdict, 'fail');
  assert.equal(out.receipt.outcome.reason_code, 'OK');
});

test('(c) green:false は fail', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: writeTempJson(CLEAN_RISK), testFile: writeTempJson(RED_TEST) }));

  assert.equal(out.receipt.outcome.verdict, 'fail');
  assert.equal(out.receipt.outcome.reason_code, 'OK');
});

test('(d) hits が test-weakening class のみ + green:true なら floor 違反扱いされず pass', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: writeTempJson(TESTWEAKENING_ONLY_RISK), testFile: writeTempJson(GREEN_TEST) }));

  assert.equal(out.receipt.outcome.verdict, 'pass');
});

// ---- (e)(f) 証跡ファイル欠落・不正 → receipt 不発行（AC4） ----

test('(e) risk file が欠落している場合は ok:false、receipt キーは存在しない（成功扱いにしない）', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: nonexistentPath(), testFile: writeTempJson(GREEN_TEST) }));

  assert.equal(out.ok, false);
  assert.equal(typeof out.error, 'string');
  assert.match(out.error, /risk/);
  assert.equal('receipt' in out, false);
});

test('(f) test file が不正 JSON の場合は ok:false、receipt キーは存在しない', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: writeTempJson(CLEAN_RISK), testFile: writeTempRaw('not json {') }));

  assert.equal(out.ok, false);
  assert.equal(typeof out.error, 'string');
  assert.match(out.error, /test/);
  assert.equal('receipt' in out, false);
});

test('risk file が plain object でない（配列）場合も ok:false、receipt キーは存在しない', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: writeTempJson([1, 2, 3]), testFile: writeTempJson(GREEN_TEST) }));

  assert.equal(out.ok, false);
  assert.equal('receipt' in out, false);
});

// ---- (g)(h) 有効 JSON だが verdict 導出不能 → inconclusive receipt（issue #471 AC-3 保持） ----

test('(g) risk.ok:false の有効 JSON は ok:true・receipt あり・verdict=inconclusive/EVIDENCE_NOT_DERIVED', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: writeTempJson(RISK_FAIL), testFile: writeTempJson(GREEN_TEST) }));

  assert.equal(out.ok, true);
  assert.ok(out.receipt);
  assert.equal(out.receipt.outcome.verdict, 'inconclusive');
  assert.equal(out.receipt.outcome.reason_code, 'EVIDENCE_NOT_DERIVED');
  assert.match(out.receipt.anchors.evidence_bundle_digest, /^sha256:[0-9a-f]{64}$/);
});

test('(h) green 非 boolean (欠落) は inconclusive receipt', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: writeTempJson(CLEAN_RISK), testFile: writeTempJson(NO_GREEN_TEST) }));

  assert.equal(out.receipt.outcome.verdict, 'inconclusive');
  assert.equal(out.receipt.outcome.reason_code, 'EVIDENCE_NOT_DERIVED');
});

test('green===null は inconclusive receipt', () => {
  const repo = initRepo();
  const out = runScript(sealArgs(repo, { riskFile: writeTempJson(CLEAN_RISK), testFile: writeTempJson(NULL_GREEN_TEST) }));

  assert.equal(out.receipt.outcome.verdict, 'inconclusive');
  assert.equal(out.receipt.outcome.reason_code, 'EVIDENCE_NOT_DERIVED');
});

// ---- (i) 旧引数の完全撤去 ----

test('(i) --obligation-file は unknown argument として usage + exit 1（legacy fallback なし）', () => {
  const repo = initRepo();
  try {
    runScript(['--worktree', repo, '--base', 'HEAD', '--identity', '411', '--configured-mode', 'shadow', '--tree-source', 'head', '--obligation-file', '/tmp/x']);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
    assert.match(String(e.stderr), /unknown argument/);
  }
});

test('--evidence-file は unknown argument として usage + exit 1（legacy fallback なし）', () => {
  const repo = initRepo();
  try {
    runScript(['--worktree', repo, '--base', 'HEAD', '--identity', '411', '--configured-mode', 'shadow', '--tree-source', 'head', '--evidence-file', '/tmp/x']);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /unknown argument/);
  }
});

// ---- (j) --context-json は asserted_digest/receipt_id にのみ反映され verdict/evidence_bundle_digest は不変 ----

test('(j) --context-json {issue,eval_iters} を渡すと asserted_digest/receipt_id が変わるが verdict/evidence_bundle_digest は不変', () => {
  const repo = initRepo();
  const riskFile = writeTempJson(CLEAN_RISK);
  const testFile = writeTempJson(GREEN_TEST);

  const out1 = runScript(sealArgs(repo, { riskFile, testFile }));
  const out2 = runScript(sealArgs(repo, { riskFile, testFile, contextJson: JSON.stringify({ issue: 1, eval_iters: 2 }) }));

  assert.equal(out1.receipt.outcome.verdict, out2.receipt.outcome.verdict);
  assert.equal(out1.receipt.anchors.evidence_bundle_digest, out2.receipt.anchors.evidence_bundle_digest);
  assert.notEqual(out1.receipt.anchors.asserted_digest, out2.receipt.anchors.asserted_digest);
  assert.notEqual(out1.receipt.receipt_id, out2.receipt.receipt_id);
});

test('--context-json が不正 JSON なら usage + exit 1', () => {
  const repo = initRepo();
  try {
    runScript(sealArgs(repo, { contextJson: 'not-json' }));
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});

test('--context-json が配列 (plain object でない) なら usage + exit 1', () => {
  const repo = initRepo();
  try {
    runScript(sealArgs(repo, { contextJson: '[1,2,3]' }));
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});

// ---- (k) check 経路の非回帰 ----

test('(k) check: seal 直後の同一 tree では pass、その後 1 commit 追加すると inconclusive + DIGEST_MISMATCH', () => {
  const repo = initRepo();
  const sealOut = runScript(sealArgs(repo));
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

// ---- adversarial fixture 全6種 → inconclusive（成功扱いゼロ） ----

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

// ---- tampered receipt_id ----

test('check: receipt_id を改竄した receipt は inconclusive + RECEIPT_ID_MISMATCH', () => {
  const repo = initRepo();
  const sealOut = runScript(sealArgs(repo));
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

test('--risk-file/--test-file / --check-receipt-file のどちらも無ければ usage + exit 1', () => {
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

test('--risk-file/--test-file と --check-receipt-file の併用は usage + exit 1', () => {
  const repo = initRepo();
  try {
    runScript([
      ...sealArgs(repo),
      '--check-receipt-file', writeTempJson({}),
    ]);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});

test('--risk-file のみ指定で --test-file 未指定なら usage + exit 1', () => {
  const repo = initRepo();
  try {
    runScript([
      '--worktree', repo,
      '--base', 'HEAD',
      '--identity', '411',
      '--configured-mode', 'shadow',
      '--tree-source', 'head',
      '--risk-file', writeTempJson(CLEAN_RISK),
    ]);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});

test('--test-file のみ指定で --risk-file 未指定なら usage + exit 1', () => {
  const repo = initRepo();
  try {
    runScript([
      '--worktree', repo,
      '--base', 'HEAD',
      '--identity', '411',
      '--configured-mode', 'shadow',
      '--tree-source', 'head',
      '--test-file', writeTempJson(GREEN_TEST),
    ]);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});
