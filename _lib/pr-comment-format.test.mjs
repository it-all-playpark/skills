import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewCommentBody, buildTerminalSummaryBody, mdCell } from './pr-comment-format.mjs';

// --- mdCell ------------------------------------------------------------------

test('mdCell: null/undefined -> 空文字列', () => {
  assert.equal(mdCell(null), '');
  assert.equal(mdCell(undefined), '');
});

test('mdCell: | をエスケープする', () => {
  assert.equal(mdCell('a|b'), 'a\\|b');
});

test('mdCell: 改行を <br> に変換する', () => {
  assert.equal(mdCell('a\nb'), 'a<br>b');
  assert.equal(mdCell('a\r\nb'), 'a<br>b');
});

test('mdCell: 数値を文字列に変換する', () => {
  assert.equal(mdCell(42), '42');
});

// --- buildReviewCommentBody --------------------------------------------------

test('buildReviewCommentBody: approve -> 絵文字 ✅ + ラベルが判定行に出る', () => {
  const body = buildReviewCommentBody({
    pr: 42,
    iteration: 1,
    decision: 'approve',
    blocking: [],
  });
  assert.ok(body.includes('✅'), 'approve の絵文字 ✅ を含む');
  assert.ok(body.includes('承認'), 'approve のラベル "承認" を含む');
  assert.ok(body.includes('**判定**'), '判定行を含む');
});

test('buildReviewCommentBody: request-changes -> 絵文字 🔴 + ラベルが判定行に出る', () => {
  const body = buildReviewCommentBody({
    pr: 10,
    iteration: 2,
    decision: 'request-changes',
    blocking: [],
  });
  assert.ok(body.includes('🔴'), 'request-changes の絵文字 🔴 を含む');
  assert.ok(body.includes('変更要求'), 'request-changes のラベルを含む');
  assert.ok(body.includes('2'), 'iteration 番号を含む');
});

test('buildReviewCommentBody: comment -> 絵文字 💬 + ラベルが判定行に出る', () => {
  const body = buildReviewCommentBody({
    pr: 7,
    iteration: 3,
    decision: 'comment',
    blocking: [],
  });
  assert.ok(body.includes('💬'), 'comment の絵文字 💬 を含む');
  assert.ok(body.includes('コメント'), 'comment のラベルを含む');
  assert.ok(body.includes('3'), 'iteration 番号を含む');
});

test('buildReviewCommentBody: blocking 0 件で "✅ blocking 指摘なし" を含みテーブルヘッダを含まない', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'approve',
    blocking: [],
  });
  assert.ok(body.includes('✅ blocking 指摘なし'), 'blocking 空時の表示');
  assert.ok(!body.includes('| # | 重大度 |'), 'テーブルヘッダが存在しない');
});

test('buildReviewCommentBody: blocking 2 件（critical 1 / major 1）で件数内訳とテーブル行が出る', () => {
  const body = buildReviewCommentBody({
    pr: 3,
    iteration: 2,
    decision: 'request-changes',
    blocking: [
      { severity: 'critical', file: 'src/a.ts', line: 10, description: 'null check missing', suggestion: 'add null guard' },
      { severity: 'major', file: 'src/b.ts', description: 'unused import' },
    ],
  });
  assert.ok(body.includes('（critical 1 / major 1）'), '件数内訳を含む');
  assert.ok(body.includes('| # | 重大度 |'), 'テーブルヘッダを含む');
  assert.ok(body.includes('🔴 critical'), 'critical ラベルを含む');
  assert.ok(body.includes('🟠 major'), 'major ラベルを含む');
  assert.ok(body.includes('| 1 |'), 'テーブル行 1 を含む');
  assert.ok(body.includes('| 2 |'), 'テーブル行 2 を含む');
});

test('buildReviewCommentBody: description / suggestion に | と \\n を含む finding でエスケープされる (AC-4)', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'request-changes',
    blocking: [
      {
        severity: 'critical',
        description: 'pipe|char\nnewline',
        suggestion: 'fix|this\nplease',
      },
    ],
  });
  assert.ok(body.includes('pipe\\|char'), '| が \\| にエスケープされる');
  assert.ok(body.includes('<br>'), '改行が <br> に変換される');
  assert.ok(!body.match(/\npipe\|char/), '生の | + 改行がセルに残らない');
});

test('buildReviewCommentBody: f.file null / f.line null / f.suggestion null で — fallback', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'request-changes',
    blocking: [
      {
        severity: 'critical',
        description: 'some error',
      },
    ],
  });
  const rows = body.split('\n').filter(l => l.startsWith('|') && !l.startsWith('| #') && !l.startsWith('|---'));
  assert.ok(rows.some(r => r.includes(' — ')), '場所か suggestion に — が出る');
});

test('buildReviewCommentBody: f.file あり f.line null でバッククォート付き file のみ', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'request-changes',
    blocking: [
      {
        severity: 'major',
        file: 'src/foo.ts',
        description: 'issue here',
      },
    ],
  });
  assert.ok(body.includes('`src/foo.ts`'), 'file がバッククォート付きで出る');
  assert.ok(!body.includes(':undefined'), 'line null で :undefined が出ない');
});

test('buildReviewCommentBody: f.file あり f.line あり でバッククォート付き file:line', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'request-changes',
    blocking: [
      {
        severity: 'critical',
        file: 'src/foo.ts',
        line: 42,
        description: 'null check missing',
        suggestion: 'add null guard',
      },
    ],
  });
  assert.ok(body.includes('`src/foo.ts:42`'), 'file:line がバッククォート付きで出る');
  assert.ok(body.includes('null check missing'), 'description を含む');
  assert.ok(body.includes('add null guard'), 'suggestion を含む');
});

test('buildReviewCommentBody: blocking 1 件で "blocking 1 件" が判定行に出る', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'request-changes',
    blocking: [
      { severity: 'critical', description: 'critical issue' },
    ],
  });
  assert.ok(body.includes('blocking 1 件'), '件数が判定行に出る');
});

test('buildReviewCommentBody: 決定性（同入力 -> 同出力）', () => {
  const input = {
    pr: 99,
    iteration: 5,
    decision: 'request-changes',
    blocking: [
      { severity: 'critical', file: 'a.ts', line: 1, description: 'desc', suggestion: 'fix' },
    ],
  };
  const first = buildReviewCommentBody(input);
  const second = buildReviewCommentBody(input);
  assert.equal(first, second, '同入力 -> バイト完全一致');
});

// --- buildTerminalSummaryBody ------------------------------------------------

test('buildTerminalSummaryBody: lgtm -> 🎉 LGTM 見出しと at-a-glance テーブルが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 42,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'looks good',
    history: [],
  });
  assert.ok(body.includes('🎉 LGTM'), 'lgtm 見出しを含む');
  assert.ok(body.includes('| 終了状態 | 総反復 | 最終判定 |'), 'at-a-glance テーブルヘッダを含む');
  assert.ok(body.includes('✅'), 'approve 絵文字を含む');
});

test('buildTerminalSummaryBody: stuck -> ⚠️ STUCK 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 10,
    status: 'stuck',
    iterations: 3,
    lastDecision: 'request-changes',
    lastSummary: 'not improving',
    history: [],
  });
  assert.ok(body.includes('⚠️ STUCK'), 'stuck 見出しを含む');
  assert.ok(body.includes('エスカレーション'), '人間エスカレーションへの言及');
});

test('buildTerminalSummaryBody: fix_failed -> ⚠️ 自動修正失敗 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 5,
    status: 'fix_failed',
    iterations: 1,
    lastDecision: 'request-changes',
    lastSummary: 'fix failed',
    history: [],
  });
  assert.ok(body.includes('⚠️ 自動修正失敗'), 'fix_failed 見出しを含む');
});

test('buildTerminalSummaryBody: max_reached -> ⚠️ 反復上限到達 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 8,
    status: 'max_reached',
    iterations: 10,
    lastDecision: 'request-changes',
    lastSummary: 'max iterations hit',
    history: [],
  });
  assert.ok(body.includes('⚠️ 反復上限到達'), 'max_reached 見出しを含む');
});

test('buildTerminalSummaryBody: 末尾マーカーが /<!-- pr-iterate:(lgtm|stuck|fix_failed|max_reached):\\d+ -->$/ で末尾一致 (AC-5)', () => {
  for (const status of ['lgtm', 'stuck', 'fix_failed', 'max_reached']) {
    const body = buildTerminalSummaryBody({
      pr: 55,
      status,
      iterations: 3,
      lastDecision: 'request-changes',
      lastSummary: 'summary',
      history: [],
    });
    assert.ok(
      /<!-- pr-iterate:(lgtm|stuck|fix_failed|max_reached):\d+ -->$/.test(body),
      status + ': 末尾マーカーが正規表現に一致する',
    );
  }
});

test('buildTerminalSummaryBody: history 3 round（うち 2 round に blocking 計 3 件）で "#### Iteration" 見出しが存在せず <details> が 1 個だけ・統合テーブルに iter 列と 3 行が入る (AC-7)', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 3,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [
      {
        iteration: 1,
        decision: 'request-changes',
        summary: 'needs work',
        blocking: [
          { severity: 'critical', description: 'first critical' },
          { severity: 'major', description: 'first major' },
        ],
      },
      {
        iteration: 2,
        decision: 'request-changes',
        summary: 'still issues',
        blocking: [
          { severity: 'critical', description: 'second critical' },
        ],
      },
      {
        iteration: 3,
        decision: 'approve',
        summary: 'looks good',
        blocking: [],
      },
    ],
  });
  assert.ok(!body.includes('#### Iteration'), '#### Iteration 見出しが存在しない');
  const detailsMatches = body.match(/<details>/g);
  assert.ok(detailsMatches && detailsMatches.length === 1, '<details> が 1 個だけ存在する');
  assert.ok(body.includes('| iter |'), '統合テーブルに iter 列を含む');
  assert.ok(body.includes('first critical'), 'first critical が含まれる');
  assert.ok(body.includes('first major'), 'first major が含まれる');
  assert.ok(body.includes('second critical'), 'second critical が含まれる');
});

test('buildTerminalSummaryBody: <summary> 行の直後が空行であること', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'stuck',
    iterations: 2,
    lastDecision: 'request-changes',
    lastSummary: 'stuck',
    history: [
      {
        iteration: 1,
        decision: 'request-changes',
        summary: 'issue',
        blocking: [{ severity: 'critical', description: 'some issue' }],
      },
    ],
  });
  const lines = body.split('\n');
  const summaryLineIdx = lines.findIndex((l) => l.includes('<summary>'));
  assert.ok(summaryLineIdx !== -1, '<summary> 行が存在する');
  assert.equal(lines[summaryLineIdx + 1], '', '<summary> 直後が空行');
});

test('buildTerminalSummaryBody: history 空 / blocking 全 0 で details ブロック自体が無い', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'all good',
    history: [],
  });
  assert.ok(!body.includes('<details>'), 'details ブロックが存在しない');
});

test('buildTerminalSummaryBody: blocking 全 0 の history でも details ブロックが無い', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'all good',
    history: [
      { iteration: 1, decision: 'request-changes', summary: 'minor', blocking: [] },
      { iteration: 2, decision: 'approve', summary: 'ok', blocking: [] },
    ],
  });
  assert.ok(!body.includes('<details>'), 'blocking 0 なら details ブロックが存在しない');
});

test('buildTerminalSummaryBody: 反復履歴 summary が 120 文字超で truncate + "…"', () => {
  const longSummary = 'x'.repeat(130);
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [
      { iteration: 1, decision: 'approve', summary: longSummary, blocking: [] },
    ],
  });
  const truncated = 'x'.repeat(120) + '\u2026';
  assert.ok(body.includes(truncated), '120 文字で truncate + … が入る');
  assert.ok(!body.includes('x'.repeat(130)), '130 文字のままでは含まれない');
});

test('buildTerminalSummaryBody: **最終判定理由** が出力に含まれる', () => {
  const body = buildTerminalSummaryBody({
    pr: 20,
    status: 'lgtm',
    iterations: 4,
    lastDecision: 'approve',
    lastSummary: 'all checks pass',
    history: [],
  });
  assert.ok(body.includes('**最終判定理由**: all checks pass'), 'lastSummary を含む');
});

test('buildTerminalSummaryBody: history セクションの反復履歴テーブルに各 round の decision が出る', () => {
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
        blocking: [],
      },
      {
        iteration: 2,
        decision: 'approve',
        summary: 'looks good now',
        blocking: [],
      },
    ],
  });
  assert.ok(body.includes('変更要求'), 'iteration 1 decision');
  assert.ok(body.includes('承認'), 'iteration 2 decision');
  assert.ok(body.includes('needs work'), 'iteration 1 summary');
  assert.ok(body.includes('looks good now'), 'iteration 2 summary');
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
        blocking: [{ severity: 'major', description: 'style' }],
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
