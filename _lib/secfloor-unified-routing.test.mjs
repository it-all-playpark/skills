// Issue #550 (S2): Security floor 統合 exec-proxy (danger-grep / realized-diff /
// structural-classify / diff-hash-secfloor の 4→1 統合) の routing / 挙動 pin。
//
// (A) source pin（dev-flow.js の raw ソースを regex で検証。exec-proxy-routing.test.mjs /
//     structural-classify-routing.test.mjs と同じ戦略）:
//   1. label 'danger-grep'（Security floor 側）は agentType:'dev-runner-haiku-ro' かつ schema: SECFLOOR
//   2. dev-flow.js に label 'realized-diff' / 'structural-classify' / 'diff-hash-secfloor' が
//      存在しない（4→1 の削減を source count で実測 — AC2）
//   3. dev-flow.js に '--out' 文字列が存在しない（AC1）
//   4. label 'danger-grep-final' は agentType:'dev-runner-haiku-ro'（AC1）
//   5. 統合呼び出し（execSecurityFloorPhase 内の trackedAgent）が try/catch で包まれている
//      （need() では包まれていない）
//   6. 統合呼び出しの prompt が secfloor-classify.sh を参照する
//
// (B) 挙動 pin（AC3/AC4/軸A。_lib canonical を直接 import して検証。
//     eval-concern-resolutions-routing.test.mjs の import 方式に倣う）:
//   (a) unified=null（agent drop 相当）→ parseSecfloorFields → risk.ok===false →
//       seedSecurityLedger 済み ledger に reconcileDanger を適用すると SEC seed 全件
//       unchecked（fail-closed）で、classifyMergeTier 相当の判定が HOLD になる
//   (b) stub throw ケース: execSecurityFloorPhase と同型の try/catch → unified=null 化を
//       再現する薄い harness で、例外が伝播せず（run abort しない）(a) と同一の
//       fail-closed HOLD へ到達する
//   (c) risk 正常 + files 欠落 → dangerHits は正常算出されつつ realizedCount 相当が NaN →
//       refloorShape が complex へ raise
//   (d) risk 欠落 + files 正常 → SEC fail-closed だが files は正常配列のまま（独立性）
//   (e) 全フィールド正常 + hits 空 → SEC seed が 'danger-grep clean' で自動 check され
//       blocking 未 checked 0 件（現行 blocking 判定と一致 — 軸A 非抵触 pin）
//   (f) testsurf: risk.ok:false 時に reconcileTestsurf が既存 TESTSURF item 据え置き・
//       新規 seed なしの現行ポリシーのままであること
//
// Run: npx vitest run _lib/secfloor-unified-routing.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSecfloorFields } from './secfloor-unified.mjs';
import { reconcileDanger, seedSecurityLedger, classifyMergeTier } from './merge-tier.mjs';
import { policyBlockingItems, DEFAULT_GATE_POLICY } from './gate-policy.mjs';
import { makeLedger, appendItem } from './goal-ledger.mjs';
import { secHitsOf, reconcileTestsurf } from './testsurf.mjs';
import { refloorShape } from './triviality.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

function findLineByExactLabel(source, labelLiteral) {
  const escaped = labelLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`label:\\s*'${escaped}'`);
  const lines = source.split('\n');
  for (const line of lines) {
    if (re.test(line)) return line;
  }
  return null;
}

// ============================================================
// (A) source pin
// ============================================================

test("[secfloor-unified-routing][A1] label 'danger-grep'（Security floor）は agentType:'dev-runner-haiku-ro' かつ schema:SECFLOOR", () => {
  const line = findLineByExactLabel(devFlowSrc, 'danger-grep');
  assert.ok(line !== null, "label 'danger-grep' の agent() call が見つからない");
  assert.match(line, /agentType:\s*'dev-runner-haiku-ro'/, `danger-grep は dev-runner-haiku-ro へ routing されるべきだが: ${line}`);
  assert.match(line, /schema:\s*SECFLOOR/, `danger-grep は schema:SECFLOOR を使うべきだが: ${line}`);
});

test("[secfloor-unified-routing][A2] dev-flow.js に label 'realized-diff' / 'structural-classify' / 'diff-hash-secfloor' が存在しない（4→1 統合。AC2）", () => {
  for (const label of ['realized-diff', 'structural-classify', 'diff-hash-secfloor']) {
    const line = findLineByExactLabel(devFlowSrc, label);
    assert.equal(line, null, `label '${label}' は統合により消滅しているはずだが見つかった: ${line}`);
  }
});

test("[secfloor-unified-routing][A3] dev-flow.js に '--out' 文字列が存在しない（AC1: 証跡書き込み撤去）", () => {
  assert.ok(
    !devFlowSrc.includes('--out'),
    "dev-flow.js に '--out' が残っている（trust-layer call site 撤去後の証跡書き込みは撤去済みのはず）",
  );
});

test("[secfloor-unified-routing][A4] label 'danger-grep-final'（Merge tier）は agentType:'dev-runner-haiku-ro'（AC1: agentType 復帰）", () => {
  const line = findLineByExactLabel(devFlowSrc, 'danger-grep-final');
  assert.ok(line !== null, "label 'danger-grep-final' の agent() call が見つからない");
  assert.match(line, /agentType:\s*'dev-runner-haiku-ro'/, `danger-grep-final は dev-runner-haiku-ro へ routing されるべきだが: ${line}`);
});

test('[secfloor-unified-routing][A5] execSecurityFloorPhase の統合呼び出しは try/catch で包まれ need() では包まれない', () => {
  const fnStart = devFlowSrc.indexOf('async function execSecurityFloorPhase(state)');
  assert.ok(fnStart !== -1, 'execSecurityFloorPhase 関数定義が見つからない');
  const nextFnIdx = devFlowSrc.indexOf('\nasync function ', fnStart + 1);
  const fnBody = devFlowSrc.slice(fnStart, nextFnIdx === -1 ? devFlowSrc.length : nextFnIdx);

  const callIdx = fnBody.indexOf('unified = await trackedAgent(');
  assert.ok(callIdx !== -1, 'execSecurityFloorPhase 本体内に unified = await trackedAgent( が見つからない');
  const labelIdx = fnBody.indexOf("label: 'danger-grep'", callIdx);
  assert.ok(labelIdx !== -1, "unified 呼び出し内に label: 'danger-grep' が見つからない");

  const before = fnBody.slice(Math.max(0, callIdx - 400), callIdx);
  const after = fnBody.slice(labelIdx, labelIdx + 200);

  assert.match(before, /try\s*\{/, 'unified 呼び出し前に try { が無い（throw を吸収する契約が崩れている）');
  assert.match(after, /\}\s*catch/, 'unified 呼び出し後に catch が無い（throw を吸収する契約が崩れている）');
  assert.doesNotMatch(
    before,
    /need\(\s*$/,
    'unified 呼び出し直前が need( で終わっている（null で run abort させず fail-closed HOLD へ倒す契約に反する）',
  );
});

test('[secfloor-unified-routing][A6] 統合呼び出しの prompt が secfloor-classify.sh を参照する', () => {
  const fnStart = devFlowSrc.indexOf('async function execSecurityFloorPhase(state)');
  assert.ok(fnStart !== -1);
  const nextFnIdx = devFlowSrc.indexOf('\nasync function ', fnStart + 1);
  const fnBody = devFlowSrc.slice(fnStart, nextFnIdx === -1 ? devFlowSrc.length : nextFnIdx);
  assert.ok(
    fnBody.includes('secfloor-classify.sh'),
    'execSecurityFloorPhase の統合呼び出し prompt が secfloor-classify.sh を参照していない',
  );
});

// ============================================================
// (B) 挙動 pin — 純関数レベルで per-field 独立性と fail-closed → HOLD を検証
// ============================================================

// (a)/(b) 共通ヘルパー: SEC seed ledger を作り reconcileDanger を適用して blocking 未 checked /
// classifyMergeTier の tier を返す
function reconcileAndClassify(risk) {
  let ledger = makeLedger();
  for (const seed of seedSecurityLedger()) ledger = appendItem(ledger, seed).ledger;
  ledger = reconcileDanger(ledger, risk);
  const secItems = ledger.items.filter((it) => it.source === 'seed' && it.dimension === 'security');
  const blocking = policyBlockingItems(ledger, DEFAULT_GATE_POLICY);
  const converged = blocking.every((it) => it.checked);
  const { tier } = classifyMergeTier({ converged, shape: 'micro', docsOrTestOnly: false });
  return { secItems, converged, tier };
}

test('[secfloor-unified-routing][B-a] unified=null（agent drop）→ risk fail-closed → SEC seed 全 unchecked + HOLD', () => {
  const { risk } = parseSecfloorFields(null);
  assert.equal(risk.ok, false);

  const { secItems, converged, tier } = reconcileAndClassify(risk);
  assert.ok(secItems.length > 0, 'SEC seed が 1 件も存在しない（seedSecurityLedger の配線が壊れている）');
  for (const it of secItems) {
    assert.notEqual(it.checked, true, `SEC item ${it.id} は unchecked のはずだが checked=${it.checked}`);
    assert.equal(it.fail_closed, true, `SEC item ${it.id} は fail_closed:true のはずだが ${it.fail_closed}`);
  }
  assert.equal(converged, false, 'fail-closed 時は blocking item が全 checked にならず converged=false のはず');
  assert.equal(tier, 'HOLD', `fail-closed 時は classifyMergeTier が HOLD を返すべきだが '${tier}'`);
});

// (b) stub throw ケース: execSecurityFloorPhase と同型の try/catch → unified=null 化を再現する
// 薄い harness。throw が伝播しない（run abort しない）ことと、(a) と同一の fail-closed HOLD へ
// 到達することを pin する。
async function secfloorCallWithFailoverToNull(agentCall) {
  let unified = null;
  try {
    unified = await agentCall();
  } catch (_e) {
    unified = null;
  }
  return parseSecfloorFields(unified);
}

test('[secfloor-unified-routing][B-b] 統合呼び出しが throw（StructuredOutput 未返却等）→ 例外が伝播せず (a) と同一の fail-closed HOLD', async () => {
  const throwingAgentCall = async () => { throw new Error('proxy execution failed'); };
  const { risk } = await secfloorCallWithFailoverToNull(throwingAgentCall);
  assert.equal(risk.ok, false);

  const { secItems, converged, tier } = reconcileAndClassify(risk);
  for (const it of secItems) {
    assert.notEqual(it.checked, true);
    assert.equal(it.fail_closed, true);
  }
  assert.equal(converged, false);
  assert.equal(tier, 'HOLD', `throw 経路も fail-closed HOLD へ到達すべきだが '${tier}'`);
});

test('[secfloor-unified-routing][B-c] risk 正常 + files 欠落 → dangerHits は正常算出されつつ realizedCount 相当は NaN → refloorShape が complex へ raise', () => {
  const unified = {
    risk: { ok: true, hits: [{ file: 'src/auth.ts', class: 'auth', severity: 'critical' }] },
    files: 'not-an-array',
    struct: null,
    diffhash: null,
  };
  const { risk, files } = parseSecfloorFields(unified);
  assert.equal(risk.ok, true);
  const dangerHits = [...new Set(secHitsOf(risk).map((h) => h.class))];
  assert.deepEqual(dangerHits, ['auth'], 'risk 正常時は SEC hit クラスが正しく算出されるべき');

  assert.equal(files, null, 'files 型不正は null（fail-safe）に落ちるべき');
  // dev-flow.js execSecurityFloorPhase と同型のパターン: realized?.files ? .length : NaN
  const realized = files == null ? null : { files };
  const realizedCount = realized?.files ? realized.files.length : NaN;
  assert.ok(Number.isNaN(realizedCount), 'files 欠落時の realizedCount は NaN であるべき（?? [] で 0 に潰さない）');

  const refloor = refloorShape('micro', realizedCount);
  assert.equal(refloor.shape, 'complex', `files 欠落（NaN）は complex 安全弁へ raise されるべきだが '${refloor.shape}'`);
  assert.equal(refloor.refloored, true);
});

test('[secfloor-unified-routing][B-d] risk 欠落 + files 正常 → SEC fail-closed だが files は正常配列のまま（独立性）', () => {
  const unified = { files: ['src/foo.ts', 'src/bar.ts'], struct: null, diffhash: null };
  const { risk, files } = parseSecfloorFields(unified);
  assert.equal(risk.ok, false, 'risk 欠落時は fail-closed であるべき');
  assert.deepEqual(files, ['src/foo.ts', 'src/bar.ts'], 'risk の欠落が files フィールドへ波及してはならない');
});

test("[secfloor-unified-routing][B-e] 全フィールド正常 + hits 空 → SEC seed は 'danger-grep clean' で自動 check、blocking 未 checked 0 件（軸A 非抵触）", () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: [],
    struct: { ok: true, available: true, structural: [], format_only: [] },
    diffhash: { hash: 'H', empty: false },
  };
  const { risk } = parseSecfloorFields(unified);
  let ledger = makeLedger();
  for (const seed of seedSecurityLedger()) ledger = appendItem(ledger, seed).ledger;
  ledger = reconcileDanger(ledger, risk);
  const secItems = ledger.items.filter((it) => it.source === 'seed' && it.dimension === 'security');
  for (const it of secItems) {
    assert.equal(it.checked, true, `hit 無しの clean 時は自動 check されるべきだが SEC item ${it.id} が unchecked`);
    assert.equal(it.evidence, 'danger-grep clean');
  }
  const blocking = policyBlockingItems(ledger, DEFAULT_GATE_POLICY);
  assert.equal(
    blocking.filter((it) => !it.checked).length,
    0,
    'danger-grep clean 時は blocking 未 checked が 0 件であるべき（現行 blocking 判定と一致）',
  );
});

test('[secfloor-unified-routing][B-f] risk.ok:false 時、reconcileTestsurf は既存 TESTSURF item を据え置き・新規 seed なし', () => {
  const { risk } = parseSecfloorFields(null);
  assert.equal(risk.ok, false);

  let ledger = makeLedger();
  ledger = appendItem(ledger, {
    id: 'TESTSURF-SKIP', text: 't', dimension: 'test-integrity', severity: 'critical',
    source: 'seed', check: { kind: 'deterministic' }, checked: false,
  }).ledger;
  const before = ledger;
  const after = reconcileTestsurf(ledger, risk);
  assert.deepEqual(after, before, 'risk.ok!==true 時、reconcileTestsurf は ledger を一切 touch しないはず（既存据え置き）');
  assert.equal(after.items.length, before.items.length, '新規 TESTSURF seed が発生してはならない');
});
