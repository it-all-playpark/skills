// issue #411 (epic #390 Phase 3, feasibility spike): pinned verifier ed25519 署名 receipt の
// 検証を行う非配線 prototype `evalseal-verify.mjs` のテスト。
//
// AC-3 の核心（(d)）: pubkey が agent write 圏（--repo-root 配下）にあると、他条件が全て
// 揃っていても 'trusted-environment' へ到達できないことを実証する。
//
// TDD: このテストを先に書き red を確認してから evalseal-verify.mjs を実装する。

import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeReceiptId } from '../../_lib/trust-digest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, 'evalseal-verify.mjs');
const FIXTURES_DIR = join(__dirname, '..', '..', '_lib', 'fixtures', 'trust');

let tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function mkTmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function runScript(args) {
  const out = execFileSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

function loadValidReceipt() {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'valid-evalseal.json'), 'utf8'));
}

function writeJson(dir, name, obj) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

// 外部 pinned 鍵ディレクトリ（agent write 圏の外 = repo-root と無関係な tmpdir）で
// keygen する共通セットアップ。
function keygenOutside() {
  const keyDir = mkTmpDir('evalseal-verify-keys-');
  const out = runScript(['keygen', '--out-dir', keyDir]);
  assert.equal(out.ok, true);
  return { keyDir, keyFile: out.key_file, pubkeyFile: out.pubkey_file };
}

function signReceipt(receiptFile, keyFile, sigOutDir) {
  const sigOut = join(sigOutDir, 'receipt.sig');
  const out = runScript(['sign', '--receipt-file', receiptFile, '--key-file', keyFile, '--sig-out', sigOut]);
  assert.equal(out.ok, true);
  assert.equal(out.sig_file, sigOut);
  return sigOut;
}

// ---- keygen ----

test('keygen: 出力 dir に .key / .pub ファイルを生成する', () => {
  const keyDir = mkTmpDir('evalseal-verify-keygen-');
  const out = runScript(['keygen', '--out-dir', keyDir]);

  assert.equal(out.ok, true);
  assert.match(out.key_file, /evalseal-verifier\.key$/);
  assert.match(out.pubkey_file, /evalseal-verifier\.pub$/);
  assert.match(readFileSync(out.key_file, 'utf8'), /BEGIN PRIVATE KEY/);
  assert.match(readFileSync(out.pubkey_file, 'utf8'), /BEGIN PUBLIC KEY/);
});

// ---- (a) 正常系: 鍵が repo 外 pinned, 署名有効, schema 合格 → trusted-environment ----

test('verify: 鍵が repo 外 pinned かつ署名有効かつ schema 合格なら trusted-environment', () => {
  const { keyFile, pubkeyFile } = keygenOutside();
  const repoRoot = mkTmpDir('evalseal-verify-repo-');
  const receiptFile = writeJson(repoRoot, 'receipt.json', loadValidReceipt());
  const sigFile = signReceipt(receiptFile, keyFile, repoRoot);

  const out = runScript([
    'verify',
    '--receipt-file', receiptFile,
    '--pubkey-file', pubkeyFile,
    '--sig-file', sigFile,
    '--repo-root', repoRoot,
  ]);

  assert.equal(out.ok, true);
  assert.equal(out.trust_level, 'trusted-environment');
  assert.equal(out.reason, 'ok');
});

// ---- (b) 改竄 receipt: outcome.verdict を書き換え (receipt_id は攻撃者が再計算して自己整合させる) ----
// → schema は通るが、署名は元 bytes に対するものなので invalid-signature へ倒れる。

test('verify: outcome.verdict を書き換えた receipt (receipt_id は改竄後に再計算済み) は advisory + invalid-signature', () => {
  const { keyFile, pubkeyFile } = keygenOutside();
  const repoRoot = mkTmpDir('evalseal-verify-repo-');
  const original = loadValidReceipt();
  const receiptFile = writeJson(repoRoot, 'receipt.json', original);
  const sigFile = signReceipt(receiptFile, keyFile, repoRoot);

  const tampered = { ...original, outcome: { ...original.outcome, verdict: 'fail' } };
  // 攻撃者が改竄後の内容で receipt_id を再計算し自己整合させる (schema 自体は通す)。
  tampered.receipt_id = computeReceiptId(tampered);
  const tamperedFile = writeJson(repoRoot, 'tampered.json', tampered);

  const out = runScript([
    'verify',
    '--receipt-file', tamperedFile,
    '--pubkey-file', pubkeyFile,
    '--sig-file', sigFile,
    '--repo-root', repoRoot,
  ]);

  assert.equal(out.ok, true);
  assert.equal(out.trust_level, 'advisory');
  assert.equal(out.reason, 'invalid-signature');
});

// ---- (c) 別鍵で sign した sig → advisory ----

test('verify: verify 時の pubkey と異なる鍵で sign した signature は advisory', () => {
  const { pubkeyFile } = keygenOutside();
  const otherKey = keygenOutside();
  const repoRoot = mkTmpDir('evalseal-verify-repo-');
  const receiptFile = writeJson(repoRoot, 'receipt.json', loadValidReceipt());
  const sigFile = signReceipt(receiptFile, otherKey.keyFile, repoRoot);

  const out = runScript([
    'verify',
    '--receipt-file', receiptFile,
    '--pubkey-file', pubkeyFile,
    '--sig-file', sigFile,
    '--repo-root', repoRoot,
  ]);

  assert.equal(out.ok, true);
  assert.equal(out.trust_level, 'advisory');
  assert.equal(out.reason, 'invalid-signature');
});

// ---- (d) AC-3 の核心: pubkey を --repo-root 配下に copy して verify → advisory + pubkey-inside-repo ----

test('verify: pubkey が --repo-root 配下にコピーされていると、署名・schema が正当でも advisory + pubkey-inside-repo (AC-3)', () => {
  const { keyFile, pubkeyFile } = keygenOutside();
  const repoRoot = mkTmpDir('evalseal-verify-repo-');
  const receiptFile = writeJson(repoRoot, 'receipt.json', loadValidReceipt());
  const sigFile = signReceipt(receiptFile, keyFile, repoRoot);

  // pinned 鍵を agent write 圏 (repo-root 配下) に複製する — PR から書き込み可能な位置。
  const copiedPubkey = join(repoRoot, 'evalseal-verifier.pub');
  copyFileSync(pubkeyFile, copiedPubkey);

  const out = runScript([
    'verify',
    '--receipt-file', receiptFile,
    '--pubkey-file', copiedPubkey,
    '--sig-file', sigFile,
    '--repo-root', repoRoot,
  ]);

  assert.equal(out.ok, true);
  assert.equal(out.trust_level, 'advisory');
  assert.equal(out.reason, 'pubkey-inside-repo');
});

// ---- (e) schema 不正 fixture → advisory + schema-invalid ----

test('verify: adversarial-schema-invalid.json は advisory + schema-invalid', () => {
  const out = runScript([
    'verify',
    '--receipt-file', join(FIXTURES_DIR, 'adversarial-schema-invalid.json'),
    '--pubkey-file', '/nonexistent/evalseal-verifier.pub',
    '--sig-file', '/nonexistent/receipt.sig',
    '--repo-root', '/nonexistent/repo-root',
  ]);

  assert.equal(out.ok, true);
  assert.equal(out.trust_level, 'advisory');
  assert.equal(out.reason, 'schema-invalid');
});

// ---- (f) canonical bytes 決定論: key 順序を入れ替えた JSON でも署名検証が通る ----

test('verify: 同一 receipt を key 順序入替した JSON でも canonicalJsonBytes の決定論により署名検証が通り trusted-environment', () => {
  const { keyFile, pubkeyFile } = keygenOutside();
  const repoRoot = mkTmpDir('evalseal-verify-repo-');
  const original = loadValidReceipt();
  const originalFile = writeJson(repoRoot, 'receipt-original.json', original);
  const sigFile = signReceipt(originalFile, keyFile, repoRoot);

  // 値は同一だが top-level / nested object の key 挿入順序を反転させた別ファイル。
  const reordered = {
    receipt_id: original.receipt_id,
    anchors: {
      tree_oid: original.anchors.tree_oid,
      head_oid: original.anchors.head_oid,
      base_oid: original.anchors.base_oid,
    },
    trust: { record_integrity: original.trust.record_integrity },
    outcome: { reason_code: original.outcome.reason_code, verdict: original.outcome.verdict },
    instrument: {
      capabilities: original.instrument.capabilities,
      config_digest: original.instrument.config_digest,
      adapter_version: original.instrument.adapter_version,
      adapter: original.instrument.adapter,
    },
    subject: {
      revision_digest: original.subject.revision_digest,
      identity: original.subject.identity,
      kind: original.subject.kind,
    },
    schema_version: original.schema_version,
  };
  const reorderedFile = writeJson(repoRoot, 'receipt-reordered.json', reordered);

  const out = runScript([
    'verify',
    '--receipt-file', reorderedFile,
    '--pubkey-file', pubkeyFile,
    '--sig-file', sigFile,
    '--repo-root', repoRoot,
  ]);

  assert.equal(out.ok, true);
  assert.equal(out.trust_level, 'trusted-environment');
  assert.equal(out.reason, 'ok');
});

// ---- CLI usage エラー ----

test('サブコマンド不明は usage を stderr + exit 1', () => {
  try {
    runScript(['bogus']);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});

test('verify に必須引数欠落は usage を stderr + exit 1', () => {
  try {
    runScript(['verify', '--receipt-file', '/tmp/x.json']);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /Usage:/);
  }
});
