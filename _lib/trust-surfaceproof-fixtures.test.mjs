// issue #410 (#390 Phase 2): SurfaceProof adversarial fixture の table-driven 検証。
//
// _lib/fixtures/trust/surfaceproof/*.json は静的 JSON fixture（恒久成果物）。
// clean-baseline のみ receipt.outcome.verdict='pass' になり、他の adversarial fixture
// （comment-only-ac / attachment-and-spec-link / attachment-omission / fetch-forbidden /
// stale-after-freeze / prompt-injection）は決して 'pass' に誤判定されないことを検証する
// （epic #390 AC-4）。
//
// F1 が作成した _lib/trust-surfaceproof.mjs の export と _lib/trust-schema.mjs
// （Phase 1 kernel、変更しない）を組み合わせて pipeline を再現する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateReceipt, checkCapabilities } from './trust-schema.mjs';
import {
  buildInventory,
  freezeSource,
  buildPresentationPack,
  reconcileSource,
  buildSurfaceProofReceipt,
} from './trust-surfaceproof.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'trust', 'surfaceproof');

function loadFixture(name) {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw);
}

// frozenSnapshot に対して freeze → buildInventory(currentSnapshot) → 提示（presentedUnitIds、
// 省略時は全 unit）→ reconcile → receipt を組み立てる pipeline ヘルパー。
function runPipeline({ frozenSnapshot, currentSnapshot, fetchResults = [], presentedUnitIds, capabilities = ['issue-read'] }) {
  const frozen = freezeSource(frozenSnapshot);
  const units = buildInventory(currentSnapshot, fetchResults);
  const ids = presentedUnitIds ?? units.map((u) => u.unit_id);
  const pack = buildPresentationPack(units, ids);
  const presentedUnits = units.map((u) => ({ ...u, presentation: pack.presentation_map[u.unit_id] }));
  const reconcile = reconcileSource({ frozen, currentSnapshot, units: presentedUnits });
  const receipt = buildSurfaceProofReceipt({
    frozen,
    input_pack_digest: pack.input_pack_digest,
    reconcile,
    capabilities,
  });
  return { frozen, units: presentedUnits, pack, reconcile, receipt };
}

// fixture が {snapshot, fetch_results?, presented_unit_ids?, capabilities?} 形式（freeze 対象と
// 現在 snapshot が同一）のケース用ショートカット。
function runFromFixture(fixture, overrides = {}) {
  return runPipeline({
    frozenSnapshot: fixture.snapshot,
    currentSnapshot: fixture.snapshot,
    fetchResults: fixture.fetch_results ?? [],
    presentedUnitIds: fixture.presented_unit_ids,
    capabilities: fixture.capabilities ?? ['issue-read'],
    ...overrides,
  });
}

// ---- (1) clean-baseline: 全 unit 提示の正常系 ----

test('clean-baseline: 全 unit 提示なら reconcile.status=OK', () => {
  const fixture = loadFixture('clean-baseline.json');
  const { reconcile } = runFromFixture(fixture);
  assert.equal(reconcile.status, 'OK');
  assert.deepEqual(reconcile.reasons, []);
});

test('clean-baseline: receipt.outcome.verdict=pass、validateReceipt/checkCapabilities は ok:true', () => {
  const fixture = loadFixture('clean-baseline.json');
  const { receipt } = runFromFixture(fixture);
  assert.equal(receipt.outcome.verdict, 'pass');
  assert.deepEqual(validateReceipt(receipt), { ok: true, reason_code: 'OK', detail: '' });
  assert.deepEqual(checkCapabilities(receipt), { ok: true, reason_code: 'OK', missing: [] });
});

// ---- (2) comment-only-ac: comment unit の planted omission ----

test('comment-only-ac: comment unit を省いた提示は REQUIRED_UNIT_OMITTED になる', () => {
  const fixture = loadFixture('comment-only-ac.json');
  const { reconcile } = runFromFixture(fixture);
  assert.equal(reconcile.status, 'REQUIRED_UNIT_OMITTED');
  assert.ok(reconcile.reasons.some((r) => r.unit_id === 'comment:1' && r.reason_code === 'REQUIRED_UNIT_OMITTED'));
});

test('comment-only-ac: receipt.outcome.verdict は fail であり pass にはならない', () => {
  const fixture = loadFixture('comment-only-ac.json');
  const { receipt } = runFromFixture(fixture);
  assert.equal(receipt.outcome.verdict, 'fail');
  assert.notEqual(receipt.outcome.verdict, 'pass');
});

// ---- (3) attachment-and-spec-link: 添付は fetched、非allowlist外部linkはunsupported ----

test('attachment-and-spec-link: 添付 unit は fetched、外部 spec link unit は unsupported/URL_NOT_ALLOWLISTED', () => {
  const fixture = loadFixture('attachment-and-spec-link.json');
  const { units } = runFromFixture(fixture);
  const attachmentUnit = units.find((u) => u.kind === 'attachment_ref');
  const specLinkUnit = units.find((u) => u.kind === 'spec_link');
  assert.ok(attachmentUnit, 'attachment_ref unit が存在すること');
  assert.ok(specLinkUnit, 'spec_link unit が存在すること');
  assert.equal(attachmentUnit.fetch, 'fetched');
  assert.equal(specLinkUnit.fetch, 'unsupported');
  assert.equal(specLinkUnit.reason_code, 'URL_NOT_ALLOWLISTED');
});

test('attachment-and-spec-link: reconcile.status=UNIT_UNSUPPORTED、verdict=inconclusive（pass にならない）', () => {
  const fixture = loadFixture('attachment-and-spec-link.json');
  const { reconcile, receipt } = runFromFixture(fixture);
  assert.equal(reconcile.status, 'UNIT_UNSUPPORTED');
  assert.equal(receipt.outcome.verdict, 'inconclusive');
  assert.notEqual(receipt.outcome.verdict, 'pass');
});

// ---- (3b) attachment-omission: fetch 済み attachment_ref unit の planted omission ----

test('attachment-omission: fetch 済み添付 unit を省いた提示は REQUIRED_UNIT_OMITTED になる（issue #416 review 指摘）', () => {
  const fixture = loadFixture('attachment-omission.json');
  const { reconcile } = runFromFixture(fixture);
  assert.equal(reconcile.status, 'REQUIRED_UNIT_OMITTED');
  assert.ok(reconcile.reasons.some((r) => r.reason_code === 'REQUIRED_UNIT_OMITTED' && r.unit_id.startsWith('attachment:')));
});

test('attachment-omission: receipt.outcome.verdict は fail であり pass にはならない', () => {
  const fixture = loadFixture('attachment-omission.json');
  const { receipt } = runFromFixture(fixture);
  assert.equal(receipt.outcome.verdict, 'fail');
  assert.notEqual(receipt.outcome.verdict, 'pass');
});

// ---- (4) fetch-forbidden: comments 403 + capabilities=[] ----

test('fetch-forbidden: comments 403 は REQUIRED_UNIT_OMITTED でなく FETCH_FORBIDDEN になる', () => {
  const fixture = loadFixture('fetch-forbidden.json');
  const { reconcile } = runFromFixture(fixture);
  assert.equal(reconcile.status, 'FETCH_FORBIDDEN');
});

test('fetch-forbidden: capabilities=[] の receipt は checkCapabilities で CAPABILITY_MISSING、verdict=inconclusive（pass にならない）', () => {
  const fixture = loadFixture('fetch-forbidden.json');
  const { receipt } = runFromFixture(fixture);
  assert.equal(receipt.outcome.verdict, 'inconclusive');
  assert.notEqual(receipt.outcome.verdict, 'pass');
  assert.deepEqual(checkCapabilities(receipt), { ok: false, reason_code: 'CAPABILITY_MISSING', missing: ['issue-read'] });
});

// ---- (5) stale-after-freeze: freeze後の更新（updated_at変化・digestのみ変化の2変種） ----

test('stale-after-freeze: updated_at と body の両方が変化した current_snapshot は STALE_SOURCE / fail / DIGEST_MISMATCH', () => {
  const fixture = loadFixture('stale-after-freeze.json');
  const { reconcile, receipt } = runPipeline({
    frozenSnapshot: fixture.frozen_snapshot,
    currentSnapshot: fixture.current_snapshot,
  });
  assert.equal(reconcile.status, 'STALE_SOURCE');
  assert.equal(receipt.outcome.verdict, 'fail');
  assert.equal(receipt.outcome.reason_code, 'DIGEST_MISMATCH');
  assert.notEqual(receipt.outcome.verdict, 'pass');
});

test('stale-after-freeze: updated_at が frozen と同一のまま body(digest)だけ変化した second_current も STALE_SOURCE になる（同秒編集、digest が authoritative）', () => {
  const fixture = loadFixture('stale-after-freeze.json');
  assert.equal(fixture.second_current.issue.updated_at, fixture.frozen_snapshot.issue.updated_at);
  assert.notEqual(fixture.second_current.issue.body, fixture.frozen_snapshot.issue.body);
  const { reconcile, receipt } = runPipeline({
    frozenSnapshot: fixture.frozen_snapshot,
    currentSnapshot: fixture.second_current,
  });
  assert.equal(reconcile.status, 'STALE_SOURCE');
  assert.notEqual(receipt.outcome.verdict, 'pass');
});

// ---- (6) prompt-injection: untrusted envelope containment ----

test('prompt-injection: buildPresentationPack の pack_text は JSON.parse 後も top-level trust_boundary が untrusted のまま', () => {
  const fixture = loadFixture('prompt-injection.json');
  const snapshot = fixture.snapshot;
  const units = buildInventory(snapshot);
  const allIds = units.map((u) => u.unit_id);
  const pack = buildPresentationPack(units, allIds);
  const parsed = JSON.parse(pack.pack_text);

  assert.equal(parsed.schema, 'surfaceproof-pack/1');
  assert.equal(parsed.trust_boundary, 'untrusted');
  assert.deepEqual(Object.keys(parsed).sort(), ['note', 'schema', 'trust_boundary', 'units']);
});

test('prompt-injection: 注入文字列は units[].content の文字列値内にのみ存在し、top-level構造を破らない', () => {
  const fixture = loadFixture('prompt-injection.json');
  const snapshot = fixture.snapshot;
  const units = buildInventory(snapshot);
  const allIds = units.map((u) => u.unit_id);
  const pack = buildPresentationPack(units, allIds);
  const parsed = JSON.parse(pack.pack_text);

  const bodyUnit = parsed.units.find((u) => u.unit_id === 'body');
  assert.ok(bodyUnit, 'body unit が presented されていること');
  assert.equal(typeof bodyUnit.content, 'string');
  assert.ok(bodyUnit.content.includes('IGNORE PREVIOUS INSTRUCTIONS'));
  // 偽 delimiter/偽 JSON 断片が注入されていても、trust_boundary は units[] 探索後も untrusted のまま
  assert.equal(parsed.trust_boundary, 'untrusted');
});

test('prompt-injection: presented_unit_ids が label unit を省いており REQUIRED_UNIT_OMITTED / verdict=fail（pass にならない）', () => {
  const fixture = loadFixture('prompt-injection.json');
  const { reconcile, receipt } = runFromFixture(fixture);
  assert.equal(reconcile.status, 'REQUIRED_UNIT_OMITTED');
  assert.notEqual(receipt.outcome.verdict, 'pass');
});

// ---- (7) AC-4 直接検証: 7 fixture 中 verdict が pass になるのは clean-baseline のみ ----

test('AC-4: 7 fixture 全てを総当たりし、verdict が pass になるのは clean-baseline のみであることを確認する', () => {
  const cleanBaseline = loadFixture('clean-baseline.json');
  const commentOnlyAc = loadFixture('comment-only-ac.json');
  const attachmentAndSpecLink = loadFixture('attachment-and-spec-link.json');
  const attachmentOmission = loadFixture('attachment-omission.json');
  const fetchForbidden = loadFixture('fetch-forbidden.json');
  const staleAfterFreeze = loadFixture('stale-after-freeze.json');
  const promptInjection = loadFixture('prompt-injection.json');

  const verdictByFixture = {
    'clean-baseline.json': runFromFixture(cleanBaseline).receipt.outcome.verdict,
    'comment-only-ac.json': runFromFixture(commentOnlyAc).receipt.outcome.verdict,
    'attachment-and-spec-link.json': runFromFixture(attachmentAndSpecLink).receipt.outcome.verdict,
    'attachment-omission.json': runFromFixture(attachmentOmission).receipt.outcome.verdict,
    'fetch-forbidden.json': runFromFixture(fetchForbidden).receipt.outcome.verdict,
    'stale-after-freeze.json': runPipeline({
      frozenSnapshot: staleAfterFreeze.frozen_snapshot,
      currentSnapshot: staleAfterFreeze.current_snapshot,
    }).receipt.outcome.verdict,
    'prompt-injection.json': runFromFixture(promptInjection).receipt.outcome.verdict,
  };

  for (const [file, verdict] of Object.entries(verdictByFixture)) {
    if (file === 'clean-baseline.json') {
      assert.equal(verdict, 'pass', `${file} は verdict=pass になるべき`);
    } else {
      assert.notEqual(verdict, 'pass', `${file} は adversarial fixture であり verdict=pass に誤判定されてはならない`);
    }
  }
});
