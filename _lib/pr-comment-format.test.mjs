import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewCommentBody, buildTerminalSummaryBody } from './pr-comment-format.mjs';

// ─── buildReviewCommentBody ───────────────────────────────────────────────────

test('buildReviewCommentBody: approve -> 承認/LGTM ラベルを含む見出し', () => {
  const body = buildReviewCommentBody({
    pr: 42,
    iteration: 1,
    decision: 'approve',
    blocking: [],
  });
  assert.ok(typeof body === 'string', 'string を返す');
  assert.ok(body.includes('1'), 'iteration 番号を含む');
  assert.ok(body.includes('承認') || body.includes('LGTM'), 'approve ラベルを含む');
});

test('buildReviewCommentBody: request-changes -> 変更要求 ラベルを含む見出し', () => {
  const body = buildReviewCommentBody({
    pr: 10,
    iteration: 2,
    decision: 'request-changes',
    blocking: [],
  });
  assert.ok(body.includes('変更要求'), 'request-changes ラベルを含む');
  assert.ok(body.includes('2'), 'iteration 番号を含む');
});

test('buildReviewCommentBody: comment -> コメント ラベルを含む見出し', () => {
  const body = buildReviewCommentBody({
    pr: 7,
    iteration: 3,
    decision: 'comment',
    blocking: [],
  });
  assert.ok(body.includes('コメント'), 'comment ラベルを含む');
  assert.ok(body.includes('3'), 'iteration 番号を含む');
});

test('buildReviewCommentBody: blocking 空の場合は "blocking 指摘なし" を表示', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'approve',
    blocking: [],
  });
  assert.ok(body.includes('blocking 指摘なし'), 'blocking 空時の表示');
});

test('buildReviewCommentBody: finding に file/line/suggestion すべて有り', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'request-changes',
    blocking: [
      {
        severity: 'error',
        file: 'src/foo.ts',
        line: 42,
        description: 'null check missing',
        suggestion: 'add null guard',
      },
    ],
  });
  assert.ok(body.includes('error'), 'severity を含む');
  assert.ok(body.includes('src/foo.ts'), 'file を含む');
  assert.ok(body.includes('42'), 'line を含む');
  assert.ok(body.includes('null check missing'), 'description を含む');
  assert.ok(body.includes('add null guard'), 'suggestion を含む');
  // bullet format: `- [severity] file:line description → suggestion`
  assert.ok(body.includes('- [error]'), 'bullet 形式を含む');
  assert.ok(body.includes('src/foo.ts:42'), 'file:line 形式を含む');
  assert.ok(body.includes('→'), '矢印区切り');
});

test('buildReviewCommentBody: finding に file/line なし', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'request-changes',
    blocking: [
      {
        severity: 'warning',
        description: 'unused variable',
      },
    ],
  });
  assert.ok(body.includes('warning'), 'severity を含む');
  assert.ok(body.includes('unused variable'), 'description を含む');
  // file:line は含まない
  assert.ok(!body.match(/undefined:undefined/), 'file:line が undefined にならない');
});

test('buildReviewCommentBody: finding に suggestion なし', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'request-changes',
    blocking: [
      {
        severity: 'error',
        file: 'src/bar.ts',
        line: 10,
        description: 'type error',
      },
    ],
  });
  assert.ok(body.includes('type error'), 'description を含む');
  // suggestion の矢印が出ない
  assert.ok(!body.includes('→ undefined'), 'undefined suggestion を出力しない');
});

test('buildReviewCommentBody: 複数 finding をすべてリスト', () => {
  const body = buildReviewCommentBody({
    pr: 3,
    iteration: 2,
    decision: 'request-changes',
    blocking: [
      { severity: 'error', description: 'first error' },
      { severity: 'warning', description: 'second warning' },
    ],
  });
  assert.ok(body.includes('first error'), '1件目を含む');
  assert.ok(body.includes('second warning'), '2件目を含む');
});

test('buildReviewCommentBody: 決定性（同入力 -> 同出力）', () => {
  const input = {
    pr: 99,
    iteration: 5,
    decision: 'request-changes',
    blocking: [
      { severity: 'error', file: 'a.ts', line: 1, description: 'desc', suggestion: 'fix' },
    ],
  };
  const first = buildReviewCommentBody(input);
  const second = buildReviewCommentBody(input);
  assert.equal(first, second, '同入力 -> バイト完全一致');
});

// ─── buildTerminalSummaryBody ─────────────────────────────────────────────────

test('buildTerminalSummaryBody: lgtm -> LGTM/承認 見出し', () => {
  const body = buildTerminalSummaryBody({
    pr: 42,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'looks good',
    history: [],
  });
  assert.ok(typeof body === 'string', 'string を返す');
  assert.ok(body.includes('42'), 'PR 番号を含む');
  assert.ok(body.includes('LGTM') || body.includes('承認'), 'lgtm 見出しを含む');
});

test('buildTerminalSummaryBody: stuck -> 人間レビューへエスカレーション(stuck)', () => {
  const body = buildTerminalSummaryBody({
    pr: 10,
    status: 'stuck',
    iterations: 3,
    lastDecision: 'request-changes',
    lastSummary: 'not improving',
    history: [],
  });
  assert.ok(body.includes('stuck') || body.includes('エスカレーション'), 'stuck 見出しを含む');
  assert.ok(body.includes('人間レビュー') || body.includes('エスカレーション'), '人間レビューへの言及');
});

test('buildTerminalSummaryBody: fix_failed -> 自動修正失敗', () => {
  const body = buildTerminalSummaryBody({
    pr: 5,
    status: 'fix_failed',
    iterations: 1,
    lastDecision: 'request-changes',
    lastSummary: 'fix failed',
    history: [],
  });
  assert.ok(body.includes('自動修正失敗') || body.includes('fix_failed'), 'fix_failed 見出しを含む');
});

test('buildTerminalSummaryBody: max_reached -> 上限到達', () => {
  const body = buildTerminalSummaryBody({
    pr: 8,
    status: 'max_reached',
    iterations: 10,
    lastDecision: 'request-changes',
    lastSummary: 'max iterations hit',
    history: [],
  });
  assert.ok(body.includes('上限到達') || body.includes('max_reached'), 'max_reached 見出しを含む');
});

test('buildTerminalSummaryBody: iterations と lastDecision/lastSummary を含む', () => {
  const body = buildTerminalSummaryBody({
    pr: 20,
    status: 'lgtm',
    iterations: 4,
    lastDecision: 'approve',
    lastSummary: 'all checks pass',
    history: [],
  });
  assert.ok(body.includes('4'), 'iteration 数を含む');
  assert.ok(body.includes('all checks pass'), 'lastSummary を含む');
});

test('buildTerminalSummaryBody: history セクションをレンダリング', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [
      {
        iteration: 1,
        decision: 'request-changes',
        summary: 'needs work',
        blocking: [
          { severity: 'error', description: 'something wrong' },
        ],
      },
      {
        iteration: 2,
        decision: 'approve',
        summary: 'looks good now',
        blocking: [],
      },
    ],
  });
  // 各ラウンドの decision が含まれる
  assert.ok(body.includes('request-changes') || body.includes('変更要求'), 'iteration 1 decision');
  assert.ok(body.includes('approve') || body.includes('承認'), 'iteration 2 decision');
  // summary が含まれる
  assert.ok(body.includes('needs work'), 'iteration 1 summary');
  assert.ok(body.includes('looks good now'), 'iteration 2 summary');
  // blocking count/list
  assert.ok(body.includes('something wrong') || body.includes('1'), 'blocking finding');
});

test('buildTerminalSummaryBody: idempotency marker を埋め込む', () => {
  const body = buildTerminalSummaryBody({
    pr: 55,
    status: 'stuck',
    iterations: 3,
    lastDecision: 'request-changes',
    lastSummary: 'still stuck',
    history: [],
  });
  // status と iterations を含む安定マーカー行
  assert.ok(body.includes('stuck'), 'status をマーカーに含む');
  assert.ok(body.includes('3'), 'iterations をマーカーに含む');
});

test('buildTerminalSummaryBody: 決定性（同入力 -> 同出力）', () => {
  const input = {
    pr: 77,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'perfect',
    history: [
      {
        iteration: 1,
        decision: 'request-changes',
        summary: 'minor issues',
        blocking: [{ severity: 'warning', description: 'style' }],
      },
      {
        iteration: 2,
        decision: 'approve',
        summary: 'fixed',
        blocking: [],
      },
    ],
  };
  const first = buildTerminalSummaryBody(input);
  const second = buildTerminalSummaryBody(input);
  assert.equal(first, second, '同入力 -> バイト完全一致');
});
