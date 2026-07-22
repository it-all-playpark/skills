// issue #409 (#390 Phase 1): trust-layer adversarial fixture の table-driven 検証。
//
// _lib/fixtures/trust/*.json は静的 JSON fixture（恒久成果物）。valid 3 件は
// receipt envelope として accept され、かつ fixture に貼り込んだ receipt_id が
// computeReceiptId(receipt) の再計算結果と一致すること（determinism のピン留め）を
// 検証する。adversarial 6 件は期待 reason_code で reject されることを検証する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeReceiptId } from './trust-digest.mjs';
import { validateReceipt, checkCapabilities } from './trust-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'trust');

function loadFixture(name) {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw);
}

// ---- (a) valid 3 件: accept + receipt_id determinism ピン留め ----

const VALID_CASES = [
  { file: 'valid-surfaceproof.json', schemaVersion: 'surfaceproof/1' },
  { file: 'valid-evalseal.json', schemaVersion: 'evalseal/1' },
  { file: 'valid-effectdelta.json', schemaVersion: 'effectdelta/1' },
];

for (const { file, schemaVersion } of VALID_CASES) {
  test(`valid fixture ${file} は validateReceipt で ok:true になる`, () => {
    const receipt = loadFixture(file);
    assert.equal(receipt.schema_version, schemaVersion);
    const result = validateReceipt(receipt);
    assert.deepEqual(result, { ok: true, reason_code: 'OK', detail: '' });
  });

  test(`valid fixture ${file} の receipt_id は静的 hex と一致する（determinism ピン）`, () => {
    const receipt = loadFixture(file);
    assert.equal(computeReceiptId(receipt), receipt.receipt_id);
  });

  test(`valid fixture ${file} は checkCapabilities で ok:true になる`, () => {
    const receipt = loadFixture(file);
    const result = checkCapabilities(receipt);
    assert.deepEqual(result, { ok: true, reason_code: 'OK', missing: [] });
  });

  test(`valid fixture ${file} は computeReceiptId を2回計算しても一致する（反復 determinism）`, () => {
    const receipt = loadFixture(file);
    const first = computeReceiptId(receipt);
    const second = computeReceiptId(receipt);
    assert.equal(first, second);
  });
}

// ---- (b) adversarial 各件: 期待 reason_code で reject ----

const ADVERSARIAL_CASES = [
  { file: 'adversarial-unknown-field.json', reasonCode: 'SCHEMA_UNKNOWN_FIELD' },
  { file: 'adversarial-unknown-enum.json', reasonCode: 'SCHEMA_UNKNOWN_ENUM' },
  { file: 'adversarial-schema-invalid.json', reasonCode: 'SCHEMA_MISSING_FIELD' },
  { file: 'adversarial-digest-mismatch.json', reasonCode: 'RECEIPT_ID_MISMATCH' },
  { file: 'adversarial-cross-protocol.json', reasonCode: 'RECEIPT_ID_MISMATCH' },
];

for (const { file, reasonCode } of ADVERSARIAL_CASES) {
  test(`adversarial fixture ${file} は validateReceipt で ${reasonCode} を返し reject される`, () => {
    const receipt = loadFixture(file);
    const result = validateReceipt(receipt);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, reasonCode);
  });
}

// ---- (c) capability-missing: schema 的には valid だが能力不足で pass に丸めない ----

test('adversarial-capability-missing.json は validateReceipt では ok:true になる（schema 自体は valid）', () => {
  const receipt = loadFixture('adversarial-capability-missing.json');
  const result = validateReceipt(receipt);
  assert.deepEqual(result, { ok: true, reason_code: 'OK', detail: '' });
});

test('adversarial-capability-missing.json は checkCapabilities で CAPABILITY_MISSING を返す（pass に丸めない）', () => {
  const receipt = loadFixture('adversarial-capability-missing.json');
  const result = checkCapabilities(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'CAPABILITY_MISSING');
  assert.deepEqual(result.missing, ['issue-read']);
});

test('adversarial-capability-missing.json の receipt_id も determinism を満たす（capabilities=[] を含めた digest）', () => {
  const receipt = loadFixture('adversarial-capability-missing.json');
  assert.equal(computeReceiptId(receipt), receipt.receipt_id);
});

// ---- cross-protocol の追加検証: domain-separated digest で protocol 間差し替えを検出 ----

test('adversarial-cross-protocol.json は surfaceproof の receipt_id を evalseal ペイロードへ流用しても一致しない', () => {
  const receipt = loadFixture('adversarial-cross-protocol.json');
  const surfaceproof = loadFixture('valid-surfaceproof.json');
  // cross-protocol fixture は surfaceproof の receipt_id をそのまま貼り込んでいる
  assert.equal(receipt.receipt_id, surfaceproof.receipt_id);
  // しかし schema_version が evalseal/1 に変わっているため実際の digest は一致しない
  assert.notEqual(computeReceiptId(receipt), receipt.receipt_id);
});
