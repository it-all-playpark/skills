import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  MULTIREVIEW_LENSES,
  MULTIREVIEW_PROBLEM_CLASSES,
  normalizeReviewTopic,
  mergeLensReviews,
  applyAdversarialVerdicts,
  buildLensReviewPrompt,
  buildVerifyPrompt,
  buildAbRecordCommand,
} from './multireview.mjs';
import { stuckTopicKey, makeSeenTracker } from './stuck-detector.mjs';
import { classifyReviewRoute } from './review-normalize.mjs';

// multireview.mjs は stuckTopicKey を import せず自由識別子として参照する
// （pr-comment-format.mjs → mdCell と同じ inline precedent）。テスト側で注入する。
globalThis.stuckTopicKey = stuckTopicKey;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// --- MULTIREVIEW_LENSES -----------------------------------------------------

test('MULTIREVIEW_LENSES has exactly 2 lenses with expected dimensions', () => {
  assert.equal(MULTIREVIEW_LENSES.length, 2);
  assert.deepEqual(MULTIREVIEW_LENSES[0], {
    id: 'a',
    name: 'Correctness+Security',
    dimensions: ['Correctness', 'Security'],
  });
  assert.deepEqual(MULTIREVIEW_LENSES[1], {
    id: 'b',
    name: 'Testing+Maintainability+Performance',
    dimensions: ['Testing', 'Maintainability', 'Performance'],
  });
});

// --- MULTIREVIEW_PROBLEM_CLASSES / dictionary sync --------------------------

test('MULTIREVIEW_PROBLEM_CLASSES has all 20 enum values from stuck-topic-dictionary.md', () => {
  assert.equal(MULTIREVIEW_PROBLEM_CLASSES.length, 20);
  assert.ok(MULTIREVIEW_PROBLEM_CLASSES.includes('scope-mismatch'));
  assert.ok(MULTIREVIEW_PROBLEM_CLASSES.includes('naming-convention'));
});

test('MULTIREVIEW_PROBLEM_CLASSES matches stuck-topic-dictionary.md Problem-Class Enum table exactly', () => {
  const dict = readFileSync(join(repoRoot, '_shared/references/stuck-topic-dictionary.md'), 'utf8');
  const rows = [...dict.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]);
  assert.ok(rows.length > 0, 'dictionary table should have at least one enum row');
  assert.deepEqual([...MULTIREVIEW_PROBLEM_CLASSES].sort(), [...rows].sort());
});

// --- normalizeReviewTopic ----------------------------------------------------

test('normalizeReviewTopic: non-string / empty inputs -> empty string', () => {
  assert.equal(normalizeReviewTopic(null), '');
  assert.equal(normalizeReviewTopic(undefined), '');
  assert.equal(normalizeReviewTopic(42), '');
  assert.equal(normalizeReviewTopic({}), '');
  assert.equal(normalizeReviewTopic(''), '');
  assert.equal(normalizeReviewTopic('   '), '');
});

test('normalizeReviewTopic: removes zero-width chars then trims', () => {
  const zw = '​‌‍﻿';
  const input = `${zw}Logic Bug::Foo${zw}`;
  assert.equal(normalizeReviewTopic(input), 'logic-bug::Foo');
});

test('normalizeReviewTopic: lowercases + hyphenates problem-class segment, preserves detail suffix verbatim', () => {
  assert.equal(normalizeReviewTopic('Logic_Bug::_lib/Foo.mjs'), 'logic-bug::_lib/Foo.mjs');
  assert.equal(normalizeReviewTopic('TEST MISSING'), 'test-missing');
  assert.equal(
    normalizeReviewTopic('input-validation-missing::create-user'),
    'input-validation-missing::create-user',
  );
});

// --- mergeLensReviews ---------------------------------------------------------

test('mergeLensReviews: dedups case/underscore-varied topics via stuckTopicKey and keeps higher severity', () => {
  const lensA = MULTIREVIEW_LENSES[0];
  const lensB = MULTIREVIEW_LENSES[1];
  const lensResults = [
    {
      lens: lensA,
      review: {
        decision: 'comment',
        issues: [
          { severity: 'minor', topic: 'Logic Bug::x', file: 'a.mjs', line: 1, description: 'd1', suggestion: 's1' },
        ],
        summary: 'lens a summary',
      },
    },
    {
      lens: lensB,
      review: {
        decision: 'request-changes',
        issues: [
          { severity: 'critical', topic: 'logic-bug::x', file: 'a.mjs', description: 'd2', suggestion: 's2' },
        ],
        summary: 'lens b summary',
      },
    },
  ];

  const { review, stats } = mergeLensReviews(lensResults);

  assert.equal(review.issues.length, 1);
  assert.equal(review.issues[0].severity, 'critical');
  assert.equal(review.issues[0].topic, 'logic-bug::a.mjs');
  assert.equal(review.issues[0].description, 'd2');
  assert.equal(review.decision, 'request-changes');
  assert.equal(stats.merged_dupes, 1);
  assert.deepEqual(stats.lens_issue_counts, { a: 1, b: 1 });
});

// issue #418 A/B 実測（PR #420 review_only probe）で発見した実バグの再現テスト:
// 2 レンズが互いの出力を見ずに同一問題を報告すると、topic の `::` 以降（詳細 suffix）を
// 独立に自由生成し得るため、同一 file・同一 problem-class でも suffix 違いで dedup が
// 効かず blocking が重複していた。file をキーに含める canonicalizeMergeTopic で dedup する。
test('mergeLensReviews: same file + same problem-class but different free-text topic suffix still dedups (issue #418 regression)', () => {
  const lensResults = [
    {
      lens: MULTIREVIEW_LENSES[0],
      review: {
        decision: 'request-changes',
        issues: [
          {
            severity: 'major',
            topic: 'scope-mismatch::.claude/skills/skill-creator',
            file: 'skills-lock.json',
            line: 126,
            description: 'lock entry を除去しても既存マシンでは symlink が残り shadowing が継続する',
            suggestion: '既存マシン向けの手動 cleanup 手順を明記する',
          },
        ],
        summary: 'lens a summary',
      },
    },
    {
      lens: MULTIREVIEW_LENSES[1],
      review: {
        decision: 'request-changes',
        issues: [
          {
            severity: 'major',
            topic: 'scope-mismatch::skill-creator',
            file: 'skills-lock.json',
            line: 129,
            description: '同上の shadowing 問題を別 suffix で報告',
            suggestion: '同上',
          },
        ],
        summary: 'lens b summary',
      },
    },
  ];

  const { review, stats } = mergeLensReviews(lensResults);

  assert.equal(review.issues.length, 1);
  assert.equal(review.issues[0].topic, 'scope-mismatch::skills-lock.json');
  assert.equal(stats.merged_dupes, 1);
});

test('mergeLensReviews: same problem-class in different files does NOT dedup (negative control)', () => {
  const lensResults = [
    {
      lens: MULTIREVIEW_LENSES[0],
      review: {
        decision: 'request-changes',
        issues: [{ severity: 'major', topic: 'scope-mismatch::a.mjs', file: 'a.mjs', description: 'd1', suggestion: 's1' }],
        summary: 's',
      },
    },
    {
      lens: MULTIREVIEW_LENSES[1],
      review: {
        decision: 'request-changes',
        issues: [{ severity: 'major', topic: 'scope-mismatch::b.mjs', file: 'b.mjs', description: 'd2', suggestion: 's2' }],
        summary: 's',
      },
    },
  ];

  const { review, stats } = mergeLensReviews(lensResults);

  assert.equal(review.issues.length, 2);
  assert.equal(stats.merged_dupes, 0);
});

test('mergeLensReviews: same-severity tie-break prefers issue with file/line over file-only', () => {
  const lensResults = [
    {
      lens: MULTIREVIEW_LENSES[0],
      review: {
        decision: 'request-changes',
        issues: [{ severity: 'major', topic: 'X::y', file: 'f.mjs', description: 'd1', suggestion: 's1' }],
        summary: 's',
      },
    },
    {
      lens: MULTIREVIEW_LENSES[1],
      review: {
        decision: 'request-changes',
        issues: [{ severity: 'major', topic: 'x::y', file: 'f.mjs', line: 5, description: 'd2', suggestion: 's2' }],
        summary: 's',
      },
    },
  ];

  const { review } = mergeLensReviews(lensResults);

  assert.equal(review.issues.length, 1);
  assert.equal(review.issues[0].line, 5);
  assert.equal(review.issues[0].description, 'd2');
});

test('mergeLensReviews: truncates description/suggestion/summary per REVIEW schema maxLength', () => {
  const longDesc = 'd'.repeat(310);
  const longSuggestion = 's'.repeat(210);
  const longSummary = 'x'.repeat(210);
  const lensResults = [
    {
      lens: MULTIREVIEW_LENSES[0],
      review: {
        decision: 'request-changes',
        issues: [{ severity: 'major', topic: 'foo', file: 'f.mjs', description: longDesc, suggestion: longSuggestion }],
        summary: longSummary,
      },
    },
  ];

  const { review } = mergeLensReviews(lensResults);

  assert.equal(review.issues[0].description.length, 300);
  assert.equal(review.issues[0].suggestion.length, 200);
  assert.ok(review.summary.length <= 200);
});

test('mergeLensReviews: merges verification_evidence with lens prefix, truncates, caps at 6', () => {
  const lensResults = [
    {
      lens: MULTIREVIEW_LENSES[0],
      review: {
        decision: 'comment',
        issues: [],
        summary: 's',
        verification_evidence: ['e1', 'e2', 'e3', 'e4'],
      },
    },
    {
      lens: MULTIREVIEW_LENSES[1],
      review: {
        decision: 'comment',
        issues: [],
        summary: 's',
        verification_evidence: ['f1', 'f2', 'f3', 'f4'],
      },
    },
  ];

  const { review } = mergeLensReviews(lensResults);

  assert.equal(review.verification_evidence.length, 6);
  assert.equal(review.verification_evidence[0], '[lens-a] e1');
  assert.equal(review.verification_evidence[3], '[lens-a] e4');
  assert.equal(review.verification_evidence[4], '[lens-b] f1');
  assert.equal(review.verification_evidence[5], '[lens-b] f2');
  for (const e of review.verification_evidence) assert.ok(e.length <= 120);
});

test('mergeLensReviews: decision derivation — critical/major -> request-changes, minor-only -> comment, none -> approve', () => {
  const withCritical = mergeLensReviews([
    { lens: MULTIREVIEW_LENSES[0], review: { decision: 'approve', issues: [{ severity: 'critical', topic: 't1', file: 'f', description: 'd', suggestion: 's' }], summary: 's' } },
  ]);
  assert.equal(withCritical.review.decision, 'request-changes');

  const minorOnly = mergeLensReviews([
    { lens: MULTIREVIEW_LENSES[0], review: { decision: 'request-changes', issues: [{ severity: 'minor', topic: 't2', file: 'f', description: 'd', suggestion: 's' }], summary: 's' } },
  ]);
  assert.equal(minorOnly.review.decision, 'comment');

  const none = mergeLensReviews([
    { lens: MULTIREVIEW_LENSES[0], review: { decision: 'request-changes', issues: [], summary: 's' } },
  ]);
  assert.equal(none.review.decision, 'approve');
});

// --- AC-2: merged review is REVIEW-schema compatible and classifyReviewRoute-passable ---

test('AC-2: merged review passes classifyReviewRoute unchanged and satisfies REVIEW-shape invariants', () => {
  const lensResults = [
    {
      lens: MULTIREVIEW_LENSES[0],
      review: {
        decision: 'request-changes',
        issues: [{ severity: 'critical', topic: 'security-vuln::auth.ts', file: 'auth.ts', line: 12, description: 'sql injection', suggestion: 'parameterize' }],
        summary: 'found a critical issue',
      },
    },
    {
      lens: MULTIREVIEW_LENSES[1],
      review: {
        decision: 'comment',
        issues: [{ severity: 'minor', topic: 'naming-convention::foo.ts', file: 'foo.ts', description: 'bad name', suggestion: 'rename' }],
        summary: 'minor nit',
      },
    },
  ];

  const { review } = mergeLensReviews(lensResults);

  assert.ok('decision' in review);
  assert.ok('issues' in review);
  assert.ok('summary' in review);
  for (const issue of review.issues) {
    assert.ok(['critical', 'major', 'minor'].includes(issue.severity));
  }

  const outcome = classifyReviewRoute(review);
  assert.equal(outcome.route, 'fix_loop');
  assert.equal(outcome.blocking.length, 1);
  assert.equal(outcome.minor.length, 1);
});

test('AC-2: merged review with zero issues classifies as ci_gate via classifyReviewRoute', () => {
  const { review } = mergeLensReviews([
    { lens: MULTIREVIEW_LENSES[0], review: { decision: 'approve', issues: [], summary: 'looks fine' } },
    { lens: MULTIREVIEW_LENSES[1], review: { decision: 'approve', issues: [], summary: 'looks fine too' } },
  ]);
  const outcome = classifyReviewRoute(review);
  assert.equal(outcome.route, 'ci_gate');
});

// --- AC-3: normalized topics collapse under reviewSeen stuck detection ----------

test('AC-3: normalizeReviewTopic output collapses case/underscore-varied topics in makeSeenTracker (reviewSeen)', () => {
  const tracker = makeSeenTracker(2);
  const iter1Topic = normalizeReviewTopic('Logic Bug::_lib/foo.mjs');
  const iter2Topic = normalizeReviewTopic('logic_bug::_lib/foo.mjs');

  tracker.register({ severity: 'major', topic: iter1Topic, file: '_lib/foo.mjs', description: 'd1', suggestion: 's1' });
  tracker.register({ severity: 'major', topic: iter2Topic, file: '_lib/foo.mjs', description: 'd2', suggestion: 's2' });

  const stuck = tracker.stuckTopics();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0], 'logic-bug::_lib/foo.mjs');
});

test('AC-3: differently-normalized topics do NOT collapse (negative control)', () => {
  const tracker = makeSeenTracker(2);
  tracker.register({ severity: 'major', topic: normalizeReviewTopic('logic-bug::a.mjs'), file: 'a.mjs', description: 'd1', suggestion: 's1' });
  tracker.register({ severity: 'major', topic: normalizeReviewTopic('test-missing::b.mjs'), file: 'b.mjs', description: 'd2', suggestion: 's2' });

  const stuck = tracker.stuckTopics();
  assert.equal(stuck.length, 0);
});

// --- applyAdversarialVerdicts --------------------------------------------------

function sampleReview() {
  return {
    decision: 'request-changes',
    issues: [
      { severity: 'critical', topic: 'a', file: 'f', description: 'd', suggestion: 's' },
      { severity: 'minor', topic: 'b', file: 'f2', description: 'd2', suggestion: 's2' },
    ],
    summary: 'sum',
  };
}

test('applyAdversarialVerdicts: null verdicts -> fail-open, review unchanged', () => {
  const review = sampleReview();
  const result = applyAdversarialVerdicts(review, null);
  assert.equal(result.review, review);
  assert.equal(result.dropped, 0);
  assert.equal(result.fail_open, true);
});

test('applyAdversarialVerdicts: non-array verdicts -> fail-open, review unchanged', () => {
  const review = sampleReview();
  const result = applyAdversarialVerdicts(review, { not: 'an array' });
  assert.equal(result.review, review);
  assert.equal(result.dropped, 0);
  assert.equal(result.fail_open, true);
});

test('applyAdversarialVerdicts: removes rejected finding by index and re-derives decision', () => {
  const review = sampleReview();
  const result = applyAdversarialVerdicts(review, [{ index: 0, verdict: 'rejected', reason: 'not real' }]);
  assert.equal(result.fail_open, false);
  assert.equal(result.dropped, 1);
  assert.equal(result.review.issues.length, 1);
  assert.equal(result.review.issues[0].topic, 'b');
  assert.equal(result.review.decision, 'comment'); // only minor remains
});

test('applyAdversarialVerdicts: out-of-range / non-integer index is ignored', () => {
  const review = sampleReview();
  const result = applyAdversarialVerdicts(review, [
    { index: 99, verdict: 'rejected' },
    { index: 1.5, verdict: 'rejected' },
    { index: -1, verdict: 'rejected' },
  ]);
  assert.equal(result.dropped, 0);
  assert.deepEqual(result.review.issues, review.issues);
});

test('applyAdversarialVerdicts: confirmed verdicts keep the finding', () => {
  const review = sampleReview();
  const result = applyAdversarialVerdicts(review, [{ index: 0, verdict: 'confirmed' }, { index: 1, verdict: 'confirmed' }]);
  assert.equal(result.dropped, 0);
  assert.equal(result.review.issues.length, 2);
});

// --- buildLensReviewPrompt -----------------------------------------------------

test('buildLensReviewPrompt: includes PR number, dimension restriction, dictionary reference; no anti-churn when prior empty', () => {
  const prompt = buildLensReviewPrompt({ pr: 42, lens: MULTIREVIEW_LENSES[0], prior: [] });
  assert.ok(prompt.includes('PR #42'));
  assert.ok(prompt.includes('Correctness/Security'));
  assert.ok(prompt.includes('stuck-topic-dictionary.md'));
  assert.ok(!prompt.includes('既出 findings'));
});

// issue #418 A/B 実測（PR #417 review_only probe）で発見した見落とし: 単一パスなら拾えていた
// ファイルモード（実行権限）変更の critical bug が、Correctness+Security レンズでも見落とされた。
// dimension を絞ったことによる機械的な見落としを防ぐリマインドが Correctness レンズにのみ入ることを確認する。
test('buildLensReviewPrompt: Correctness lens includes file-mode check reminder, non-Correctness lens does not', () => {
  const correctnessLens = MULTIREVIEW_LENSES.find((l) => l.dimensions.includes('Correctness'));
  const otherLens = MULTIREVIEW_LENSES.find((l) => !l.dimensions.includes('Correctness'));

  const withCorrectness = buildLensReviewPrompt({ pr: 42, lens: correctnessLens, prior: [] });
  assert.ok(withCorrectness.includes('mode 変更'));
  assert.ok(withCorrectness.includes('実行権限'));

  const withoutCorrectness = buildLensReviewPrompt({ pr: 42, lens: otherLens, prior: [] });
  assert.ok(!withoutCorrectness.includes('mode 変更'));
});

test('buildLensReviewPrompt: includes anti-churn instructions when prior non-empty', () => {
  const prior = [{ topic: 'logic-bug::x', severity: 'major' }];
  const prompt = buildLensReviewPrompt({ pr: 42, lens: MULTIREVIEW_LENSES[1], prior });
  assert.ok(prompt.includes('Testing/Maintainability/Performance'));
  assert.ok(prompt.includes('既出 findings'));
  assert.ok(prompt.includes(JSON.stringify(prior)));
  assert.ok(prompt.includes('新規の critical/major のみ報告'));
  assert.ok(prompt.includes('同じ topic 文字列を'));
});

// --- buildVerifyPrompt ----------------------------------------------------------

test('buildVerifyPrompt: enumerates findings with 0-based index and adversarial-verification instructions', () => {
  const prompt = buildVerifyPrompt({
    pr: 42,
    issues: [
      { severity: 'critical', topic: 'a', file: 'f.mjs', line: 3, description: 'desc1', suggestion: 's1' },
      { severity: 'major', topic: 'b', file: 'g.mjs', description: 'desc2', suggestion: 's2' },
    ],
  });
  assert.ok(prompt.includes('PR #42'));
  assert.ok(prompt.includes('0. '));
  assert.ok(prompt.includes('1. '));
  assert.ok(prompt.includes('f.mjs:3'));
  assert.ok(prompt.includes('g.mjs'));
  assert.ok(prompt.includes('confirmed'));
  assert.ok(prompt.includes('rejected'));
  assert.ok(prompt.includes('列挙番号（0 始まり）'));
});

// --- buildAbRecordCommand --------------------------------------------------------

test('buildAbRecordCommand: builds ab-runs write command with pr/mode/epoch filename', () => {
  const cmd = buildAbRecordCommand({ pr: 418, mode: 'multi', payload: '{"ok":true}' });
  assert.ok(cmd.startsWith('mkdir -p ~/.claude/journal/ab-runs && cat > ~/.claude/journal/ab-runs/result-418-multi-$(date +%s).json <<'));
  assert.ok(cmd.includes('{"ok":true}'));
  assert.ok(cmd.trim().endsWith('AB_RUN_EOF'));
});

test('buildAbRecordCommand: accepts single mode', () => {
  const cmd = buildAbRecordCommand({ pr: 1, mode: 'single', payload: '{}' });
  assert.ok(cmd.includes('result-1-single-$(date +%s).json'));
});

test('buildAbRecordCommand: rejects invalid pr, mode, and missing payload', () => {
  assert.throws(() => buildAbRecordCommand({ pr: 'abc', mode: 'multi', payload: '{}' }), /invalid pr/);
  assert.throws(() => buildAbRecordCommand({ pr: '0', mode: 'multi', payload: '{}' }), /invalid pr/);
  assert.throws(() => buildAbRecordCommand({ pr: 418, mode: 'both', payload: '{}' }), /invalid mode/);
  assert.throws(() => buildAbRecordCommand({ pr: 418, mode: 'multi', payload: null }), /payload/);
});
