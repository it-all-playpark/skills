// _lib/improve-rank.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPROVE_MAX,
  IMPROVE_BACKPRESSURE_OPEN,
  candidateKey,
  validateCandidate,
  rankCandidates,
  selectTop,
  buildImproveIssueBody,
  buildBacklogSection,
} from './improve-rank.mjs';

const METRICS = ['iterate_unhealthy_rate', 'micro_share', 'cap_pinned_count'];

function validCand(over = {}) {
  return {
    source: 'doctor-anomaly',
    title: '改善候補X',
    evidence: ['journal entry 20260712T211350-dev-flow: iterate_status=stuck'],
    acceptance_criteria: ['stuck 終端率が下がる仕組みを実装する'],
    expected_metric_delta: { metric: 'iterate_unhealthy_rate', current: 0.3, target: 0.15, min_runs: 5 },
    risk: 'low',
    target_paths: ['dev-flow-doctor/scripts/run-diagnostics.sh'],
    ...over,
  };
}

test('定数: cap=2 / backpressure=2', () => {
  assert.equal(IMPROVE_MAX, 2);
  assert.equal(IMPROVE_BACKPRESSURE_OPEN, 2);
});

test('candidateKey: 記号・空白を無視した fingerprint（日本語対応）', () => {
  assert.equal(candidateKey({ title: 'Fix: eval loop（改善）!' }), candidateKey({ title: 'fix eval loop 改善' }));
  assert.notEqual(candidateKey({ title: 'A案' }), candidateKey({ title: 'B案' }));
  assert.equal(candidateKey(null), '');
});

test('validateCandidate: 正常系 true', () => {
  assert.equal(validateCandidate(validCand(), METRICS), true);
});

test('validateCandidate: evidence 空 / 空文字列要素は false', () => {
  assert.equal(validateCandidate(validCand({ evidence: [] }), METRICS), false);
  assert.equal(validateCandidate(validCand({ evidence: ['  '] }), METRICS), false);
});

test('validateCandidate: out-of-enum source / risk / metric は false', () => {
  assert.equal(validateCandidate(validCand({ source: 'llm-freeform' }), METRICS), false);
  assert.equal(validateCandidate(validCand({ risk: 'unknown' }), METRICS), false);
  const c = validCand();
  c.expected_metric_delta = { ...c.expected_metric_delta, metric: 'bogus' };
  assert.equal(validateCandidate(c, METRICS), false);
});

test('validateCandidate: AC 空 / min_runs 非正整数は false', () => {
  assert.equal(validateCandidate(validCand({ acceptance_criteria: [] }), METRICS), false);
  const c = validCand();
  c.expected_metric_delta = { ...c.expected_metric_delta, min_runs: 0 };
  assert.equal(validateCandidate(c, METRICS), false);
});

test('rankCandidates: score 降順 → risk 昇順 → key 昇順の決定論', () => {
  const a = validCand({ title: 'aaa', risk: 'high' });
  const b = validCand({ title: 'bbb', risk: 'low' });
  const c = validCand({ title: 'ccc', risk: 'low' });
  const ranked = rankCandidates([a, b, c], [
    { index: 0, score: 50 }, { index: 1, score: 50 }, { index: 2, score: 90 },
  ]);
  assert.deepEqual(ranked.map((x) => x.title), ['ccc', 'bbb', 'aaa']);
  // score 不在 index は 0 扱い
  const ranked2 = rankCandidates([a, b], [{ index: 1, score: 10 }]);
  assert.deepEqual(ranked2.map((x) => x.title), ['bbb', 'aaa']);
});

test('selectTop: 上位 IMPROVE_MAX 件が file、残りは backlog', () => {
  const cands = [validCand({ title: '1' }), validCand({ title: '2' }), validCand({ title: '3' })];
  const r = selectTop(cands, 0);
  assert.equal(r.file.length, 2);
  assert.equal(r.backlog.length, 1);
  assert.equal(r.backpressure, false);
});

test('selectTop: open 数 >= 2 で backpressure（全候補 backlog へ）', () => {
  const cands = [validCand({ title: '1' })];
  const r = selectTop(cands, 2);
  assert.deepEqual(r.file, []);
  assert.equal(r.backlog.length, 1);
  assert.equal(r.backpressure, true);
  // fail-closed 経路: openImproveCount=Infinity でも backpressure
  assert.equal(selectTop(cands, Infinity).backpressure, true);
});

test('buildImproveIssueBody: evidence / AC / hypothesis を含む', () => {
  const body = buildImproveIssueBody(validCand(), { hypothesisBlock: '<HYP>' });
  assert.match(body, /## Evidence/);
  assert.match(body, /journal entry 20260712T211350/);
  assert.match(body, /- \[ \] stuck 終端率が下がる/);
  assert.match(body, /<HYP>/);
  assert.doesNotMatch(body, /dev-flow-canary/);
});

test('buildImproveIssueBody: core path 接触で canary AC を自動追記', () => {
  const body = buildImproveIssueBody(
    validCand({ target_paths: ['.claude/workflows/dev-flow.js'] }),
    { hypothesisBlock: '<HYP>' },
  );
  assert.match(body, /dev-flow-canary/);
});

test('buildImproveIssueBody: reconcile-revert は target_paths が空でも canary AC を追記', () => {
  const body = buildImproveIssueBody(
    validCand({ source: 'reconcile-revert', target_paths: [] }),
    { hypothesisBlock: '<HYP>' },
  );
  assert.match(body, /dev-flow-canary/);
});

test('buildBacklogSection: cycle 見出しと候補行', () => {
  const s = buildBacklogSection({ today: '2026-07-13T00:00:00Z', losers: [validCand()] });
  assert.match(s, /### cycle 2026-07-13T00:00:00Z/);
  assert.match(s, /\[doctor-anomaly\] 改善候補X/);
});
