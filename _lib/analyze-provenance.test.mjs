// _lib/analyze-provenance.test.mjs
// verifyAnalyzeProvenance の決定論突合検証（tdd: 先に書く）。issue #451 task F1。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { verifyAnalyzeProvenance } from './analyze-provenance.mjs';

function baseProbe(overrides = {}) {
  return {
    ok: true,
    number: 451,
    title: 'Add deterministic provenance check to Analyze phase',
    ...overrides,
  };
}

function baseReq(overrides = {}) {
  return {
    issue_number: 451,
    issue_title: 'Add deterministic provenance check to Analyze phase',
    ...overrides,
  };
}

// (1) probe が null → probe_failed
test('[analyze-provenance] (1a) probe が null → probe_failed', () => {
  const result = verifyAnalyzeProvenance(baseReq(), null, 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe_failed');
  assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
});

test('[analyze-provenance] (1b) probe が非 object（string） → probe_failed', () => {
  const result = verifyAnalyzeProvenance(baseReq(), 'not-an-object', 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe_failed');
});

test('[analyze-provenance] (1c) probe.ok !== true → probe_failed', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe({ ok: false }), 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe_failed');
});

test('[analyze-provenance] (1d) probe.ok が未設定（undefined） → probe_failed', () => {
  const probe = baseProbe();
  delete probe.ok;
  const result = verifyAnalyzeProvenance(baseReq(), probe, 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe_failed');
});

// (2) probe.number と issueNumber 不一致 → probe_issue_mismatch
test('[analyze-provenance] (2a) probe.number が issueNumber と不一致 → probe_issue_mismatch', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe({ number: 999 }), 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe_issue_mismatch');
});

test('[analyze-provenance] (2b) issueNumber が string でも Number 突合で一致は通る', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe(), '451');
  assert.notEqual(result.reason, 'probe_issue_mismatch');
});

// (3) probe.title が非空 string でない → probe_title_empty
test('[analyze-provenance] (3a) probe.title が空文字 → probe_title_empty', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe({ title: '' }), 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe_title_empty');
});

test('[analyze-provenance] (3b) probe.title が空白のみ → probe_title_empty', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe({ title: '   ' }), 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe_title_empty');
});

test('[analyze-provenance] (3c) probe.title が非 string（null） → probe_title_empty', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe({ title: null }), 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe_title_empty');
});

// (4) req.issue_number 欠落・不一致 → req_issue_mismatch
test('[analyze-provenance] (4a) req.issue_number 欠落 → req_issue_mismatch', () => {
  const req = baseReq();
  delete req.issue_number;
  const result = verifyAnalyzeProvenance(req, baseProbe(), 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'req_issue_mismatch');
});

test('[analyze-provenance] (4b) req.issue_number 不一致 → req_issue_mismatch', () => {
  const result = verifyAnalyzeProvenance(baseReq({ issue_number: 999 }), baseProbe(), 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'req_issue_mismatch');
});

// (5) title 不一致 → title_mismatch
test('[analyze-provenance] (5a) req.issue_title が probe.title と不一致 → title_mismatch', () => {
  const result = verifyAnalyzeProvenance(baseReq({ issue_title: 'Something else entirely' }), baseProbe(), 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'title_mismatch');
});

test('[analyze-provenance] (5b) title の前後空白・連続空白差は一致扱い', () => {
  const result = verifyAnalyzeProvenance(
    baseReq({ issue_title: '  Add deterministic  provenance check to  Analyze phase  ' }),
    baseProbe(),
    451,
  );
  assert.equal(result.ok, true);
});

test('[analyze-provenance] (5c) title の case 違いは不一致扱い', () => {
  const result = verifyAnalyzeProvenance(
    baseReq({ issue_title: 'add deterministic provenance check to analyze phase' }),
    baseProbe(),
    451,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'title_mismatch');
});

// (6) 全合格 → ok:true
test('[analyze-provenance] (6a) 全合格 → ok:true, reason:null, detail:null', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe(), 451);
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.detail, null);
});

test('[analyze-provenance] (6b) issueNumber が string \'451\' でも Number 突合で全合格', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe(), '451');
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

// (7) comment_count 突合（PR #578）: probe が comment_count を報告している場合のみ検証する
test('[analyze-provenance] (7a) probe.comment_count 未設定 → 突合 skip（後方互換）で全合格', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe(), 451);
  assert.equal(result.ok, true);
});

test('[analyze-provenance] (7b) probe.comment_count 有り・req.comment_count 一致 → 全合格', () => {
  const result = verifyAnalyzeProvenance(
    baseReq({ comment_count: 2 }),
    baseProbe({ comment_count: 2 }),
    451,
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test('[analyze-provenance] (7c) probe.comment_count 有り・req.comment_count 欠落 → req_comment_count_invalid', () => {
  const result = verifyAnalyzeProvenance(baseReq(), baseProbe({ comment_count: 2 }), 451);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'req_comment_count_invalid');
});

test('[analyze-provenance] (7d) probe.comment_count 有り・req.comment_count が数値でない → req_comment_count_invalid', () => {
  const result = verifyAnalyzeProvenance(
    baseReq({ comment_count: 'two' }),
    baseProbe({ comment_count: 2 }),
    451,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'req_comment_count_invalid');
});

test('[analyze-provenance] (7e) probe.comment_count と req.comment_count が不一致 → comment_count_mismatch（comments 取得漏れの検出）', () => {
  const result = verifyAnalyzeProvenance(
    baseReq({ comment_count: 0 }),
    baseProbe({ comment_count: 3 }),
    451,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'comment_count_mismatch');
});

test('[analyze-provenance] (7f) probe.comment_count が 0 のとき req.comment_count も 0 なら全合格（0 は有効な一致値）', () => {
  const result = verifyAnalyzeProvenance(
    baseReq({ comment_count: 0 }),
    baseProbe({ comment_count: 0 }),
    451,
  );
  assert.equal(result.ok, true);
});
