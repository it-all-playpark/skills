import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DANGER_CLASSES,
  seedSecurityLedger,
  reconcileDanger,
  isDocsOrTestOnly,
  classifyMergeTier,
  newlyUncheckedSecClasses,
} from './merge-tier.mjs';

// ---- Task 1: DANGER_CLASSES + seedSecurityLedger ----

test('DANGER_CLASSES は diff-risk-classify.sh の 7 クラスと一致', () => {
  assert.deepEqual(DANGER_CLASSES, [
    'auth', 'crypto', 'config', 'data-migration', 'public-api', 'exec-sink', 'dependency',
  ]);
});

test('seedSecurityLedger は 7 クラスを blocking seed item として返す', () => {
  const seeds = seedSecurityLedger();
  assert.equal(seeds.length, 7);
  for (const s of seeds) {
    assert.equal(s.source, 'seed');
    assert.equal(s.dimension, 'security');
    assert.equal(s.severity, 'major');           // source:'seed' で blocking。hit 時に critical へ raise
    assert.deepEqual(s.check, { kind: 'deterministic' });
    assert.ok(s.id.startsWith('SEC-'));
    assert.ok(s.text.length > 0);
  }
  assert.equal(seeds[0].id, 'SEC-AUTH');
  assert.equal(seeds[3].id, 'SEC-DATA-MIGRATION');
});

// ---- Task 2: reconcileDanger ----

function ledgerWithSeeds() {
  return {
    items: seedSecurityLedger().map((it) => ({ checked: false, evidence: null, floor: false, ...it })),
    round: 0,
  };
}

test('reconcileDanger: clean クラスは checked=true(evidence=grep clean)', () => {
  const out = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [] });
  for (const it of out.items) {
    assert.equal(it.checked, true);
    assert.match(it.evidence, /clean/);
    assert.equal(it.severity, 'major');
  }
});

test('reconcileDanger: hit クラスは critical へ raise + checked=false 据え置き', () => {
  const out = reconcileDanger(ledgerWithSeeds(), {
    ok: true,
    hits: [{ class: 'auth' }, { class: 'crypto' }],
  });
  const auth = out.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(auth.severity, 'critical');
  assert.equal(auth.floor, true);
  assert.equal(auth.checked, false);
  const cfg = out.items.find((it) => it.id === 'SEC-CONFIG');
  assert.equal(cfg.severity, 'major');
  assert.equal(cfg.checked, true);
});

test('reconcileDanger: 未知 hit クラスは無視(対応 seed なし)', () => {
  const out = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'bogus' }] });
  assert.ok(out.items.every((it) => it.checked === true));
});

test('reconcileDanger: checked=true(evaluator clearance 済み)の hit item を 2 度目に reconcile しても checked が保持される(HOLD 巻き戻し防止)', () => {
  // Step 1: 初回 reconcile — auth hit → critical/unchecked
  const step1 = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const authAfterStep1 = step1.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authAfterStep1.checked, false);
  assert.equal(authAfterStep1.severity, 'critical');

  // Step 2: evaluator が clearance → checked=true に
  const ledgerCleared = {
    ...step1,
    items: step1.items.map((it) =>
      it.id === 'SEC-AUTH' ? { ...it, checked: true, evidence: 'security cleared: no auth bypass' } : it,
    ),
  };
  const authCleared = ledgerCleared.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authCleared.checked, true);

  // Step 3: 2 度目 reconcile(Merge tier phase) — auth は依然 hit だが checked を維持すべき
  const step3 = reconcileDanger(ledgerCleared, { ok: true, hits: [{ class: 'auth' }] });
  const authAfterStep3 = step3.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authAfterStep3.checked, true, 'checked=true(clearance 済み)は 2 度目 reconcile で維持される');
  assert.equal(authAfterStep3.severity, 'critical', 'severity は引き続き critical のまま');

  // 非 hit クラスは依然 clean
  const cfgAfterStep3 = step3.items.find((it) => it.id === 'SEC-CONFIG');
  assert.equal(cfgAfterStep3.checked, true);
});

test('reconcileDanger: pr-iterate で新クラスが hit に増えた場合は unchecked(HOLD)', () => {
  // auth を先に clearance 済みにした ledger から出発
  const step1 = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const ledgerCleared = {
    ...step1,
    items: step1.items.map((it) =>
      it.id === 'SEC-AUTH' ? { ...it, checked: true, evidence: 'security cleared: ok' } : it,
    ),
  };

  // pr-iterate 後に crypto も新たに hit
  const step2 = reconcileDanger(ledgerCleared, {
    ok: true,
    hits: [{ class: 'auth' }, { class: 'crypto' }],
  });
  const authAfter = step2.items.find((it) => it.id === 'SEC-AUTH');
  const cryptoAfter = step2.items.find((it) => it.id === 'SEC-CRYPTO');
  assert.equal(authAfter.checked, true, 'auth: clearance 済みは維持');
  assert.equal(cryptoAfter.checked, false, 'crypto: 新 hit は unchecked(HOLD を保つ)');
  assert.equal(cryptoAfter.severity, 'critical');
});

test('reconcileDanger: danger-grep error は全 SEC seed を unchecked のまま返す(fail-closed)', () => {
  const cleaned = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [] });
  assert.ok(cleaned.items.every((it) => it.checked === true), 'precondition: clean risk checks all SEC seeds');

  const out = reconcileDanger(cleaned, { ok: false, hits: [], error: 'script failed' });
  for (const it of out.items) {
    assert.equal(it.checked, false, `${it.id} should fail closed`);
    assert.match(it.evidence, /script failed/);
  }

  const mergeTier = classifyMergeTier({
    shape: 'micro',
    converged: false,
    unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: true,
    escalateCount: 0,
  });
  assert.equal(mergeTier.tier, 'HOLD');
});

// AC #3: ツール欠落(fail-closed) と danger 実検出の evidence 語彙が区別できること
test('reconcileDanger: risk.ok:false (tool 欠落/fail-closed) のとき evidence が tool-unavailable を示す語彙を含む', () => {
  // error あり: evidence に "unavailable" または "fail-closed" の語彙が含まれ、
  // "danger" 実検出と誤認できない形になること
  const outWithError = reconcileDanger(ledgerWithSeeds(), { ok: false, error: 'No such file or directory' });
  for (const it of outWithError.items) {
    assert.equal(it.checked, false, `${it.id} should be unchecked (fail-closed)`);
    // tool 欠落/fail-closed の文言を含む（"danger" 検出ではなく "unavailable" / "fail-closed" 語彙）
    assert.match(it.evidence, /unavailable|fail-closed/i,
      `fail-closed evidence should indicate tool unavailability, got: ${it.evidence}`);
    // danger 実検出の evidence 語彙 ("danger-grep clean", critical/floor raise) と
    // 混同できないよう、evidence が "danger-grep clean" や "danger detected" ではないことを確認
    assert.doesNotMatch(it.evidence, /^danger-grep clean$/,
      'fail-closed evidence must not say "danger-grep clean"');
  }
});

test('reconcileDanger: risk.ok:false かつ error なし (空/null) のとき evidence が tool-unavailable を示す', () => {
  // error フィールドなし
  const outNoError = reconcileDanger(ledgerWithSeeds(), { ok: false });
  for (const it of outNoError.items) {
    assert.equal(it.checked, false, `${it.id} should be unchecked (fail-closed)`);
    assert.match(it.evidence, /unavailable|fail-closed/i,
      `no-error fail-closed evidence should indicate tool unavailability, got: ${it.evidence}`);
  }
});

test('reconcileDanger: risk.ok:false と risk.ok:true(hit) の evidence 語彙が区別可能', () => {
  // fail-closed (tool 欠落)
  const failClosed = reconcileDanger(ledgerWithSeeds(), { ok: false, error: 'diff-risk-classify.sh not found' });
  const failEvidence = failClosed.items.find((it) => it.id === 'SEC-AUTH')?.evidence ?? '';
  assert.match(failEvidence, /unavailable|fail-closed/i, `fail-closed evidence: ${failEvidence}`);

  // danger 実検出 (risk.ok:true + hit)
  const hitResult = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const authHit = hitResult.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authHit.severity, 'critical', 'danger hit raises to critical');
  assert.equal(authHit.floor, true, 'danger hit sets floor=true');
  assert.equal(authHit.checked, false, 'danger hit is unchecked');
  // hit item の evidence はない（unchecked のまま）か、あっても "unavailable" ではない
  if (authHit.evidence !== null && authHit.evidence !== undefined) {
    assert.doesNotMatch(String(authHit.evidence), /unavailable|fail-closed/i,
      `danger hit evidence must not say "unavailable": ${authHit.evidence}`);
  }

  // clean item は "danger-grep clean" のまま
  const cleanItem = hitResult.items.find((it) => it.id === 'SEC-CONFIG');
  assert.match(cleanItem.evidence, /clean/, `clean evidence: ${cleanItem.evidence}`);
  assert.doesNotMatch(cleanItem.evidence, /unavailable|fail-closed/i,
    `clean evidence must not say "unavailable": ${cleanItem.evidence}`);
});

// ---- Task 3: isDocsOrTestOnly + classifyMergeTier ----

test('isDocsOrTestOnly: md/test/bats のみ → true', () => {
  assert.equal(isDocsOrTestOnly(['docs/a.md', 'README.md']), true);
  assert.equal(isDocsOrTestOnly(['_lib/foo.test.mjs', 'x/foo.bats']), true);
  assert.equal(isDocsOrTestOnly(['src/foo.ts']), false);
  assert.equal(isDocsOrTestOnly([]), false);
});

test('classifyMergeTier: 未収束 → HOLD', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: false, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /収束/.test(x)));
});

test('classifyMergeTier: 未解消 danger → HOLD', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: true, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
});

// breaking 検出は「analyze 構造化判定」と「issue title/body keyword scan」の 2 入力を
// 持つ（issue #278）。HOLD reason で由来を区別表示できることを origin ごとに担保する。

test('classifyMergeTier: breakingStructured のみ true → HOLD、reasons に構造化判定文言を含み keyword scan 文言を含まない', () => {
  const r = classifyMergeTier({ shape: 'complex', converged: true, unresolvedDanger: false, breakingStructured: true, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => x.includes('構造化判定')), `reasons に構造化判定文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(!r.reasons.some((x) => x.includes('keyword scan')), `reasons に keyword scan 文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: breakingKeyword のみ true → HOLD、reasons に keyword scan 文言を含み構造化判定文言を含まない', () => {
  const r = classifyMergeTier({ shape: 'complex', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: true, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => x.includes('keyword scan')), `reasons に keyword scan 文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(!r.reasons.some((x) => x.includes('構造化判定')), `reasons に構造化判定文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: breakingStructured と breakingKeyword が両方 true → HOLD、reasons に両文言が別要素として存在する', () => {
  const r = classifyMergeTier({ shape: 'complex', converged: true, unresolvedDanger: false, breakingStructured: true, breakingKeyword: true, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
  const structuredReason = r.reasons.find((x) => x.includes('構造化判定'));
  const keywordReason = r.reasons.find((x) => x.includes('keyword scan'));
  assert.ok(structuredReason, `reasons に構造化判定文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(keywordReason, `reasons に keyword scan 文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.notEqual(structuredReason, keywordReason, '両文言は別々の reasons 要素であるべき');
});

test('classifyMergeTier: breakingStructured / breakingKeyword が両方 false → HOLD にならない（regression）', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => /breaking|構造化判定|keyword scan/.test(x)), `breaking 関連 reason が無いはずだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: ESCALATE 項目あり → HOLD', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 2 });
  assert.equal(r.tier, 'HOLD');
});

test('classifyMergeTier: micro + docs/test-only + clean + 収束 → AUTO', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'AUTO');
});

test('classifyMergeTier: 収束済だが micro でない/コード変更 → REVIEW', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});

test('classifyMergeTier: micro だが docs/test-only でない → REVIEW', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});


test('classifyMergeTier: AC 未達(unsatisfiedAc:true) → HOLD', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, unsatisfiedAc: true });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /AC 未達/.test(x)));
});

test('classifyMergeTier: unsatisfiedAc:false は既存 REVIEW 挙動不変', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, unsatisfiedAc: false });
  assert.equal(r.tier, 'REVIEW');
});

test('classifyMergeTier: unsatisfiedAc 未指定でも REVIEW(後方互換 — フラグ省略時は false 扱い)', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});

test('classifyMergeTier: unsatisfiedAc:true は AUTO 条件(micro+docs/test-only)でも HOLD に勝つ', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0, unsatisfiedAc: true });
  assert.equal(r.tier, 'HOLD');
});

// ---- evalSkipped フラグ（issue #233）----

test('classifyMergeTier: evalSkipped:true + micro AUTO → tier===AUTO かつ AC未検証文言を含む', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0, evalSkipped: true });
  assert.equal(r.tier, 'AUTO');
  assert.ok(r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), `reasons に AC未検証文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: evalSkipped:false + micro AUTO → tier===AUTO かつ AC未検証文言を含まない', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0, evalSkipped: false });
  assert.equal(r.tier, 'AUTO');
  assert.ok(!r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), `evalSkipped:false では AC未検証文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: evalSkipped 未指定 + micro AUTO → 従来通り reasons 1 件のみ（既存挙動不変）', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'AUTO');
  assert.equal(r.reasons.length, 1, `evalSkipped 未指定時は reasons 1 件のはずだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(!r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), 'evalSkipped 未指定では AC未検証文言なし');
});

test('classifyMergeTier: evalSkipped:true + standard → REVIEW かつ AC未検証文言なし（非AUTO ゲート境界不変）', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, evalSkipped: true });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), `REVIEW tier では AC未検証文言なし: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: evalSkipped:true + HOLD 条件(unsatisfiedAc:true) → HOLD かつ AC未検証文言なし（非AUTO ゲート境界不変）', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0, unsatisfiedAc: true, evalSkipped: true });
  assert.equal(r.tier, 'HOLD');
  assert.ok(!r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), `HOLD tier では AC未検証文言なし: ${JSON.stringify(r.reasons)}`);
});

// ---- fail_closed フラグ + dangerFailClosed HOLD reason（issue #271）----

test('reconcileDanger: fail-closed (risk.ok:false) では全 SEC seed item が fail_closed===true かつ checked===false', () => {
  const out = reconcileDanger(ledgerWithSeeds(), { ok: false, error: 'script failed' });
  for (const it of out.items) {
    assert.equal(it.fail_closed, true, `${it.id} should be fail_closed`);
    assert.equal(it.checked, false, `${it.id} should be unchecked`);
  }
});

test('reconcileDanger: fail-closed した ledger を clean で再 reconcile すると各 SEC item が fail_closed===false かつ checked===true に戻る(stale フラグ解消)', () => {
  const failClosed = reconcileDanger(ledgerWithSeeds(), { ok: false, error: 'script failed' });
  const recovered = reconcileDanger(failClosed, { ok: true, hits: [] });
  for (const it of recovered.items) {
    assert.equal(it.fail_closed, false, `${it.id} should have fail_closed cleared`);
    assert.equal(it.checked, true, `${it.id} should be checked (clean)`);
  }
});

test('reconcileDanger: 実 hit(risk.ok:true + hits) で reconcile した SEC item は fail_closed===false(実 hit は fail-closed でない)', () => {
  const out = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const auth = out.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(auth.fail_closed, false, 'hit item も fail_closed は false(danger_hits とは別軸)');
  const cfg = out.items.find((it) => it.id === 'SEC-CONFIG');
  assert.equal(cfg.fail_closed, false, 'clean item も fail_closed は false');
});

test('classifyMergeTier: dangerFailClosed:true → tier===HOLD かつ reasons に fail-closed 文言を含む', () => {
  const r = classifyMergeTier({
    shape: 'standard',
    converged: false,
    unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false,
    escalateCount: 0,
    dangerFailClosed: true,
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /fail-closed/.test(x)), `reasons に fail-closed 文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: dangerFailClosed 未指定 → 従来通り(regression なし)', () => {
  const rNotConverged = classifyMergeTier({ shape: 'standard', converged: false, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(rNotConverged.tier, 'HOLD');
  assert.ok(!rNotConverged.reasons.some((x) => /fail-closed/.test(x)));

  const rBreaking = classifyMergeTier({ shape: 'complex', converged: true, unresolvedDanger: false, breakingStructured: true, breakingKeyword: true, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(rBreaking.tier, 'HOLD');
  assert.ok(!rBreaking.reasons.some((x) => /fail-closed/.test(x)));

  const rAuto = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(rAuto.tier, 'AUTO');
  assert.ok(!rAuto.reasons.some((x) => /fail-closed/.test(x)));

  const rReview = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(rReview.tier, 'REVIEW');
  assert.ok(!rReview.reasons.some((x) => /fail-closed/.test(x)));
});

// ---- reconcileDanger: stale evidence クリア（issue #299）----

test('reconcileDanger: checked=true(evidence="danger-grep clean")+floor=false の SEC item が hit に転じたとき evidence が null にクリアされる（自己矛盾 evidence を残さない）', () => {
  const clean = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [] });
  const authClean = clean.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authClean.checked, true);
  assert.match(authClean.evidence, /clean/);
  assert.equal(authClean.floor, false);

  const hit = reconcileDanger(clean, { ok: true, hits: [{ class: 'auth' }] });
  const authHit = hit.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authHit.checked, false);
  assert.equal(authHit.severity, 'critical');
  assert.equal(authHit.floor, true);
  assert.equal(authHit.evidence, null, 'stale "danger-grep clean" evidence は null にクリアされるべき');
});

test('reconcileDanger: checked=false のまま引き続き hit する SEC item も evidence が null にクリアされる', () => {
  const seeded = {
    items: seedSecurityLedger().map((it) => ({ checked: false, evidence: 'some stale text', floor: false, ...it })),
    round: 0,
  };
  const hit = reconcileDanger(seeded, { ok: true, hits: [{ class: 'auth' }] });
  const authHit = hit.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authHit.checked, false);
  assert.equal(authHit.evidence, null);
});

test('reconcileDanger: floor=true+checked=true(evaluator clearance 済み)の SEC item が引き続き hit する場合は item 全体(evidence 含む)が据え置かれる', () => {
  const step1 = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const cleared = {
    ...step1,
    items: step1.items.map((it) =>
      it.id === 'SEC-AUTH' ? { ...it, checked: true, evidence: 'security cleared: no auth bypass' } : it),
  };
  const step2 = reconcileDanger(cleared, { ok: true, hits: [{ class: 'auth' }] });
  const auth = step2.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(auth.checked, true);
  assert.equal(auth.floor, true);
  assert.equal(auth.evidence, 'security cleared: no auth bypass', 'clearance 済みの evidence は据え置かれる');
});

// ---- newlyUncheckedSecClasses（issue #299）----

function secItem(overrides) {
  return {
    id: `SEC-${(overrides.danger_class ?? 'auth').toUpperCase()}`,
    dimension: 'security',
    source: 'seed',
    checked: false,
    fail_closed: false,
    danger_class: 'auth',
    ...overrides,
  };
}

test('newlyUncheckedSecClasses: before で checked(danger-grep clean) → after で unchecked に転じた class が返る', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false, floor: true, severity: 'critical', evidence: null })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), ['auth']);
});

test('newlyUncheckedSecClasses: before から unchecked のままの class は返らない', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: false })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), []);
});

test('newlyUncheckedSecClasses: floor+checked 維持(clearance 済み)の class は返らない', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: true, floor: true, evidence: 'security cleared: ok' })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: true, floor: true, evidence: 'security cleared: ok' })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), []);
});

test('newlyUncheckedSecClasses: after で fail_closed:true の item は除外される', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false, fail_closed: true, evidence: 'danger-grep unavailable (fail-closed)' })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), []);
});

test('newlyUncheckedSecClasses: SEC seed 以外(source評価者やdimension eval)の item は無視される', () => {
  const before = {
    items: [
      secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' }),
      { id: 'EV-1', dimension: 'eval', source: 'evaluator', checked: true },
    ],
  };
  const after = {
    items: [
      secItem({ danger_class: 'auth', checked: false, evidence: null }),
      { id: 'EV-1', dimension: 'eval', source: 'evaluator', checked: false },
    ],
  };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), ['auth']);
});

test('newlyUncheckedSecClasses: before に同 id が無い item は対象外', () => {
  const before = { items: [] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), []);
});

test('newlyUncheckedSecClasses: 複数 class が after.items の順序で返る', () => {
  const before = {
    items: [
      secItem({ danger_class: 'crypto', checked: true, evidence: 'danger-grep clean' }),
      secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' }),
    ],
  };
  const after = {
    items: [
      secItem({ danger_class: 'auth', checked: false }),
      secItem({ danger_class: 'crypto', checked: false }),
    ],
  };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), ['auth', 'crypto']);
});

test('newlyUncheckedSecClasses: 入力 ledger を mutate しない', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false, evidence: null })] };
  const beforeSnapshot = JSON.parse(JSON.stringify(before));
  const afterSnapshot = JSON.parse(JSON.stringify(after));
  newlyUncheckedSecClasses(before, after);
  assert.deepEqual(before, beforeSnapshot);
  assert.deepEqual(after, afterSnapshot);
});

// ---- classifyMergeTier: finalReconcile / finalTestGreen（Final reconcile phase, issue #320）----

test('classifyMergeTier: finalReconcile/finalTestGreen 未指定 → 既存挙動不変、reasons に final 関連文言なし', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
  });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => /final/i.test(x)), `reasons に final 関連文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile:"skipped" + finalTestGreen:null → 既存挙動不変', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    finalReconcile: 'skipped', finalTestGreen: null,
  });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => /final/i.test(x)), `reasons に final 関連文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile:"reverified" + finalTestGreen:true → REVIEW のまま', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    finalReconcile: 'reverified', finalTestGreen: true,
  });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => /final/i.test(x)), `reasons に final 関連文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile:"reverified" + finalTestGreen:false → HOLD + reason に "final test red" を含む', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    finalReconcile: 'reverified', finalTestGreen: false,
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => x.includes('final test red')), `reasons に 'final test red' を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile:"unavailable" → HOLD + reason に "Final reconcile 再検証不能" を含む', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    finalReconcile: 'unavailable',
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => x.includes('Final reconcile 再検証不能')), `reasons に 'Final reconcile 再検証不能' を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: micro+docsOrTestOnly の AUTO ケースに finalReconcile:"reverified"+finalTestGreen:true を足しても AUTO のまま', () => {
  const r = classifyMergeTier({
    shape: 'micro', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: true, escalateCount: 0,
    finalReconcile: 'reverified', finalTestGreen: true,
  });
  assert.equal(r.tier, 'AUTO');
  assert.ok(!r.reasons.some((x) => /final/i.test(x)), `reasons に final 関連文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile:"bogus"(out-of-enum) → throw', () => {
  assert.throws(() => classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    finalReconcile: 'bogus',
  }), /invalid finalReconcile/);
});
