// _lib/analyze-contract.test.mjs
// buildReqFromContract（args.setup.analyze → REQ の whitelist 検証）と analyzeGateReasons（3 条件ゲート）
// の pin テスト（issue #690: Analyze を prerun の script 段へ移し、Workflow 側は検証とゲートだけ）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildReqFromContract, analyzeGateReasons, ANALYZE_PATH_INPUT } from './analyze-contract.mjs';
import { classifyShape } from './triviality.mjs';

// prerun-analyze.sh の ok:true 出力と同形
function baseAnalyze(overrides = {}) {
  return {
    ok: true,
    analyze_path: 'contract',
    jev_reasons: [],
    issue_title: 'feat: add --contract mode to analyze-issue.sh',
    issue_type: 'feat',
    acceptance_criteria: ['AC1: parse t1/t2 contracts', 'AC2: fallback preserved'],
    scope: '本文スコープ全文（AC 節除く）',
    scope_truncated: false,
    scope_total_chars: 20,
    issue_body: '## 概要\n本文\n## 受け入れ基準\n- [ ] AC1',
    issue_body_truncated: false,
    breaking_keyword_scan: false,
    breaking_change: false,
    breaking_evidence: '',
    comment_count: 0,
    comment_overrides: [],
    comment_conflicts: [],
    uncertain: [],
    contract: 't1',
    ac_heading_near_miss: [],
    duration_seconds: 4,
    ...overrides,
  };
}

// (1) 正常系 → REQ 全キー検証
test('[analyze-contract] (1) contract 経路の正常系 → REQ 全キー検証', () => {
  const req = buildReqFromContract(baseAnalyze(), 690);
  assert.ok(req !== null);
  assert.equal(req.summary, 'Issue #690: feat: add --contract mode to analyze-issue.sh');
  assert.equal(req.issue_number, 690);
  assert.equal(req.issue_title, 'feat: add --contract mode to analyze-issue.sh');
  assert.equal(req.issue_type, 'feat');
  assert.deepEqual(req.acceptance_criteria, ['AC1: parse t1/t2 contracts', 'AC2: fallback preserved']);
  assert.equal(req.scope, '本文スコープ全文（AC 節除く）');
  assert.equal(req.scope_truncated, false);
  assert.equal(req.scope_total_chars, 20);
  assert.equal(req.breaking_change, false);
  assert.equal(req.breaking_keyword_scan, false);
  assert.equal(req.breaking_evidence, '');
  assert.deepEqual(req.comment_overrides, []);
  assert.deepEqual(req.comment_conflicts, []);
  assert.deepEqual(req.uncertain, []);
  assert.equal(req.analyze_path, 'contract');
  assert.deepEqual(req.jev_reasons, []);
  assert.equal(req.comment_count, 0);
  assert.equal(req.issue_body, '## 概要\n本文\n## 受け入れ基準\n- [ ] AC1');
  assert.equal(req.issue_body_truncated, false);
});

test('[analyze-contract] (1b) issue_number は文字列で渡っても number になる（Workflow の ISSUE は string）', () => {
  const req = buildReqFromContract(baseAnalyze(), '690');
  assert.equal(req.issue_number, 690);
});

test('[analyze-contract] (1c) 未知キー（contract / ac_heading_near_miss / duration_seconds / ok）は REQ に混入しない', () => {
  const req = buildReqFromContract(baseAnalyze({ shape: 'complex', estimated_change_file_count: 9 }), 690);
  for (const k of ['ok', 'contract', 'ac_heading_near_miss', 'duration_seconds', 'shape', 'estimated_change_file_count']) {
    assert.equal(Object.prototype.hasOwnProperty.call(req, k), false, `REQ に ${k} が混入している`);
  }
});

// (2) Jev 経路: breaking_change / comment_overrides / uncertain が verbatim で運ばれる
test('[analyze-contract] (2) jev 経路: breaking_change=true / comment_overrides / uncertain / jev_reasons が REQ に運ばれる', () => {
  const req = buildReqFromContract(baseAnalyze({
    analyze_path: 'jev',
    jev_reasons: ['breaking_keyword_scan true', 'comments present (1)'],
    breaking_change: true,
    breaking_evidence: 'Jev noul p=0.95（breaking 系キーワード hit）',
    comment_overrides: ['override: comment #1 by reporter（NONE, 2026-01-01T00:00:00Z）: 訂正: 30 箇所'],
    uncertain: ['breaking_keyword_scan: Jev 応答なし'],
    comment_count: 1,
  }), 690);
  assert.ok(req !== null);
  assert.equal(req.analyze_path, 'jev');
  assert.deepEqual(req.jev_reasons, ['breaking_keyword_scan true', 'comments present (1)']);
  assert.equal(req.breaking_change, true);
  assert.match(req.breaking_evidence, /0\.95/);
  assert.equal(req.comment_overrides.length, 1);
  assert.equal(req.uncertain.length, 1);
  assert.equal(req.comment_count, 1);
});

test('[analyze-contract] (2b) REQ の配列は入力と別インスタンス（呼び出し側の mutate が setup に漏れない）', () => {
  const analyze = baseAnalyze({ uncertain: ['x'] });
  const req = buildReqFromContract(analyze, 690);
  req.uncertain.push('y');
  req.acceptance_criteria.push('z');
  assert.deepEqual(analyze.uncertain, ['x']);
  assert.equal(analyze.acceptance_criteria.length, 2);
});

// (3) whitelist 不合格 → null
test('[analyze-contract] (3a) 非 object / 配列 / null / undefined → null', () => {
  for (const v of [null, undefined, 'str', 42, [], [baseAnalyze()]]) {
    assert.equal(buildReqFromContract(v, 690), null, `入力 ${JSON.stringify(v)} で null になっていない`);
  }
});

test('[analyze-contract] (3b) ok が true でない → null（ok:false は Workflow 側で needs_clarification に倒す）', () => {
  assert.equal(buildReqFromContract(baseAnalyze({ ok: false, reason: 'gh failed' }), 690), null);
  assert.equal(buildReqFromContract(baseAnalyze({ ok: 'true' }), 690), null);
});

test('[analyze-contract] (3c) analyze_path が contract / jev 以外（sonnet / 欠落 / 空）→ null', () => {
  assert.deepEqual(ANALYZE_PATH_INPUT, ['contract', 'jev']);
  for (const v of ['sonnet', '', undefined, null, 'contract ']) {
    assert.equal(buildReqFromContract(baseAnalyze({ analyze_path: v }), 690), null, `analyze_path=${JSON.stringify(v)} で null になっていない`);
  }
});

test('[analyze-contract] (3d) issue_title が空 / 非 string → null', () => {
  assert.equal(buildReqFromContract(baseAnalyze({ issue_title: '' }), 690), null);
  assert.equal(buildReqFromContract(baseAnalyze({ issue_title: 12 }), 690), null);
});

test('[analyze-contract] (3e) issue_type が空 / 非 string → null、enum 外は受理（classifyShape が floor=complex）', () => {
  assert.equal(buildReqFromContract(baseAnalyze({ issue_type: '' }), 690), null);
  assert.equal(buildReqFromContract(baseAnalyze({ issue_type: null }), 690), null);
  const req = buildReqFromContract(baseAnalyze({ issue_type: 'wip' }), 690);
  assert.ok(req !== null);
  assert.equal(classifyShape(req, 1).shape, 'complex');
});

test('[analyze-contract] (3f) acceptance_criteria が非配列 / 空文字要素 / 非 string 要素 → null、空配列は受理', () => {
  assert.equal(buildReqFromContract(baseAnalyze({ acceptance_criteria: 'a' }), 690), null);
  assert.equal(buildReqFromContract(baseAnalyze({ acceptance_criteria: ['a', ''] }), 690), null);
  assert.equal(buildReqFromContract(baseAnalyze({ acceptance_criteria: ['a', 1] }), 690), null);
  const req = buildReqFromContract(baseAnalyze({ acceptance_criteria: [] }), 690);
  assert.ok(req !== null);
  assert.deepEqual(req.acceptance_criteria, []);
});

test('[analyze-contract] (3g) acceptance_criteria は 20 件で切る', () => {
  const ac = Array.from({ length: 25 }, (_, i) => `AC${i}`);
  const req = buildReqFromContract(baseAnalyze({ acceptance_criteria: ac }), 690);
  assert.equal(req.acceptance_criteria.length, 20);
});

test('[analyze-contract] (3h) breaking_change / breaking_keyword_scan が非 boolean → null', () => {
  assert.equal(buildReqFromContract(baseAnalyze({ breaking_change: 'true' }), 690), null);
  assert.equal(buildReqFromContract(baseAnalyze({ breaking_keyword_scan: 1 }), 690), null);
  const a = baseAnalyze(); delete a.breaking_change;
  assert.equal(buildReqFromContract(a, 690), null);
});

test('[analyze-contract] (3i) comment_overrides / comment_conflicts / uncertain / jev_reasons が string 配列でない → null', () => {
  for (const k of ['comment_overrides', 'comment_conflicts', 'uncertain', 'jev_reasons']) {
    assert.equal(buildReqFromContract(baseAnalyze({ [k]: 'x' }), 690), null, `${k}: string で null になっていない`);
    assert.equal(buildReqFromContract(baseAnalyze({ [k]: [1] }), 690), null, `${k}: [1] で null になっていない`);
    const a = baseAnalyze(); delete a[k];
    assert.equal(buildReqFromContract(a, 690), null, `${k}: 欠落で null になっていない`);
  }
});

test('[analyze-contract] (3j) scope が非 string / scope_truncated が非 boolean → null', () => {
  assert.equal(buildReqFromContract(baseAnalyze({ scope: null }), 690), null);
  assert.equal(buildReqFromContract(baseAnalyze({ scope_truncated: 'false' }), 690), null);
});

// (4) optional キー
test('[analyze-contract] (4a) scope_total_chars / comment_count は非負整数のときだけ REQ に載る', () => {
  const a = baseAnalyze({ scope_total_chars: -1, comment_count: 'x' });
  const req = buildReqFromContract(a, 690);
  assert.equal(Object.prototype.hasOwnProperty.call(req, 'scope_total_chars'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(req, 'comment_count'), false);
});

test('[analyze-contract] (4b) issue_body / issue_body_truncated は型が合うときだけ REQ に載る（欠落は Fable prompt が AC を正とする）', () => {
  const a = baseAnalyze(); delete a.issue_body; delete a.issue_body_truncated;
  const req = buildReqFromContract(a, 690);
  assert.equal(Object.prototype.hasOwnProperty.call(req, 'issue_body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(req, 'issue_body_truncated'), false);
  const req2 = buildReqFromContract(baseAnalyze({ issue_body: 42, issue_body_truncated: 'yes' }), 690);
  assert.equal(Object.prototype.hasOwnProperty.call(req2, 'issue_body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(req2, 'issue_body_truncated'), false);
  const req3 = buildReqFromContract(baseAnalyze({ issue_body_truncated: true }), 690);
  assert.equal(req3.issue_body_truncated, true);
});

test('[analyze-contract] (4c) breaking_evidence が非 string → 空文字', () => {
  const req = buildReqFromContract(baseAnalyze({ breaking_evidence: null }), 690);
  assert.equal(req.breaking_evidence, '');
});

// (5) classifyShape との接続（REQ が triviality.mjs の入力契約を満たす）
test('[analyze-contract] (5) REQ は classifyShape の入力として動く（realized 3 / AC 2 / feat → standard、breaking → complex）', () => {
  const req = buildReqFromContract(baseAnalyze(), 690);
  assert.equal(classifyShape(req, 3).shape, 'standard');
  const breaking = buildReqFromContract(baseAnalyze({ breaking_change: true, breaking_evidence: 'e' }), 690);
  assert.equal(classifyShape(breaking, 1).shape, 'complex');
});

// (6) analyzeGateReasons: 3 条件ゲート
test('[analyze-gate] (6a) 正常系（AC 非空 / conflicts 空 / uncertain 空）→ 空配列（ゲートは引かない）', () => {
  const req = buildReqFromContract(baseAnalyze({ comment_overrides: ['override: x'] }), 690);
  assert.deepEqual(analyzeGateReasons(req), []);
});

test('[analyze-gate] (6b) AC 空 → 1 行（受け入れ基準の書き方を案内）', () => {
  const req = buildReqFromContract(baseAnalyze({ acceptance_criteria: [] }), 690);
  const reasons = analyzeGateReasons(req);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /acceptance_criteria が空/);
});

test('[analyze-gate] (6c) comment_conflicts 非空 → 各 conflict が 1 行ずつ', () => {
  const req = buildReqFromContract(baseAnalyze({ comment_conflicts: ['conflict: c1', 'override（権限なし: author_association=NONE）: c2'] }), 690);
  const reasons = analyzeGateReasons(req);
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /矛盾.*conflict: c1/);
  assert.match(reasons[1], /権限なし/);
});

test('[analyze-gate] (6d) uncertain 非空 → 各項目が 1 行ずつ（Jev 低確信 / 応答なし / 無効）', () => {
  const req = buildReqFromContract(baseAnalyze({ uncertain: ['breaking_keyword_scan: Jev 応答なし', 'comment #1 by a: Jev 無効（DEVFLOW_JEV_DISABLE=1）'] }), 690);
  const reasons = analyzeGateReasons(req);
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /Jev 応答なし/);
  assert.match(reasons[1], /DEVFLOW_JEV_DISABLE=1/);
});

test('[analyze-gate] (6e) 3 条件が同時 → 全部積まれる（AC 空が先頭）', () => {
  const req = buildReqFromContract(baseAnalyze({ acceptance_criteria: [], comment_conflicts: ['c'], uncertain: ['u'] }), 690);
  const reasons = analyzeGateReasons(req);
  assert.equal(reasons.length, 3);
  assert.match(reasons[0], /acceptance_criteria が空/);
});

test('[analyze-gate] (6f) null / undefined 入力でも throw せず AC 空として扱う', () => {
  assert.equal(analyzeGateReasons(null).length, 1);
  assert.equal(analyzeGateReasons(undefined).length, 1);
});
