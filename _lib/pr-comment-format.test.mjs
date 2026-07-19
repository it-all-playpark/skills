import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildTerminalSummaryBody, terminalReviewAction } from './pr-comment-format.mjs';
import { mdCell } from './md-cell.mjs';
globalThis.mdCell = mdCell;

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
  assert.ok(body.includes('| 終了状態 | 反復回数 | 最終判定 |'), 'at-a-glance テーブルヘッダを含む');
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

test('buildTerminalSummaryBody: ci_error -> ⚠️ CI エラー 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 12,
    status: 'ci_error',
    iterations: 2,
    lastDecision: 'request-changes',
    lastSummary: 'gh api failed',
    history: [],
  });
  assert.ok(body.includes('⚠️ CI エラー'), 'ci_error 見出しを含む');
  assert.ok(body.includes('エスカレーション'), '人間エスカレーションへの言及');
});

test('buildTerminalSummaryBody: ci_pending -> ⏳ CI 未完了 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 13,
    status: 'ci_pending',
    iterations: 2,
    lastDecision: 'request-changes',
    lastSummary: 'checks pending',
    history: [],
  });
  assert.ok(body.includes('⏳ CI 未完了'), 'ci_pending 見出しを含む');
});

test('buildTerminalSummaryBody: 末尾マーカーが /<!-- pr-iterate:(lgtm|stuck|fix_failed|max_reached|ci_error|ci_pending):\\d+ -->$/ で末尾一致・完全一致で含まれる (AC-3)', () => {
  for (const status of ['lgtm', 'stuck', 'fix_failed', 'max_reached', 'ci_error', 'ci_pending']) {
    const body = buildTerminalSummaryBody({
      pr: 55,
      status,
      iterations: 3,
      lastDecision: 'request-changes',
      lastSummary: 'summary',
      history: [],
    });
    assert.ok(
      /<!-- pr-iterate:(lgtm|stuck|fix_failed|max_reached|ci_error|ci_pending):\d+ -->$/.test(body),
      status + ': 末尾マーカーが正規表現に一致する',
    );
    assert.ok(
      body.includes(`<!-- pr-iterate:${status}:3 -->`),
      status + ': マーカーが完全一致で含まれる (AC-3)',
    );
  }
});

test('buildTerminalSummaryBody: history 3 round（うち 2 round に blocking 計 3 件）で "#### Iteration" 見出しが存在せず <details> が 1 個だけ・統合テーブルに 反復 列と 3 行が入る (AC-7)', () => {
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
  assert.ok(body.includes('| 反復 |'), '統合テーブルに 反復 列を含む');
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
  const truncated = 'x'.repeat(120) + '…';
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

// --- New tests: verification_evidence support ------------------------------------

// (1) buildTerminalSummaryBody with lastVerificationEvidence — snapshot pin
test('buildTerminalSummaryBody: lastVerificationEvidence を渡すと **検証根拠**: + 箇条書きが出る（スナップショット pin）', () => {
  const body = buildTerminalSummaryBody({
    pr: 10,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: '問題なし',
    lastVerificationEvidence: ['根拠A', '根拠B'],
    history: [
      { iteration: 1, decision: 'request-changes', summary: 'issues', blocking: [] },
      { iteration: 2, decision: 'approve', summary: 'fixed', blocking: [] },
    ],
  });

  const expectedBody = [
    '## PR #10 — pr-iterate 終了レポート',
    '',
    '### 🎉 LGTM',
    '',
    '| 終了状態 | 反復回数 | 最終判定 |',
    '|---|---|---|',
    '| lgtm | 2 | ✅ 承認 (LGTM) |',
    '',
    '**最終判定理由**: 問題なし',
    '',
    '**検証根拠**:',
    '- 根拠A',
    '- 根拠B',
    '',
    '### 反復履歴',
    '',
    '| 反復 | 判定 | 要修正 (blocking) | 軽微 (minor) | 総評 |',
    '|---|---|---|---|---|',
    '| 1 | 🔴 変更要求 | 0 | 0 | issues |',
    '| 2 | ✅ 承認 (LGTM) | 0 | 0 | fixed |',
    '',
    '---',
    '*このコメントは pr-iterate により自動生成されました。*',
    '<!-- pr-iterate:lgtm:2 -->',
  ].join('\n');

  assert.equal(body, expectedBody, 'スナップショット全文一致');
});

// (2) lastVerificationEvidence が undefined のとき現行出力と完全一致
test('buildTerminalSummaryBody: lastVerificationEvidence が undefined のとき **検証根拠** を含まない', () => {
  const withoutEvidence = buildTerminalSummaryBody({
    pr: 5,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [],
  });
  const withUndefined = buildTerminalSummaryBody({
    pr: 5,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    lastVerificationEvidence: undefined,
    history: [],
  });
  assert.ok(!withoutEvidence.includes('**検証根拠**'), 'undefined 時: **検証根拠** を含まない');
  assert.equal(withoutEvidence, withUndefined, 'undefined 省略と undefined 明示で出力が完全一致');
});

// (3) lastVerificationEvidence が空配列 [] のとき (2) と同一
test('buildTerminalSummaryBody: lastVerificationEvidence が [] のとき **検証根拠** を含まない', () => {
  const withoutEvidence = buildTerminalSummaryBody({
    pr: 5,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [],
  });
  const withEmpty = buildTerminalSummaryBody({
    pr: 5,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    lastVerificationEvidence: [],
    history: [],
  });
  assert.ok(!withEmpty.includes('**検証根拠**'), '空配列時: **検証根拠** を含まない');
  assert.equal(withoutEvidence, withEmpty, '省略と空配列で出力が完全一致');
});

// (4) history の round.summary が 120 文字超でテーブル truncation、evidence 非混入
test('buildTerminalSummaryBody: 長文 summary truncation + evidence がテーブル行に混入しない', () => {
  const longSummary = 'a'.repeat(130);
  const body = buildTerminalSummaryBody({
    pr: 7,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    lastVerificationEvidence: ['evidence item X'],
    history: [
      { iteration: 1, decision: 'approve', summary: longSummary, blocking: [] },
    ],
  });
  const truncated = 'a'.repeat(120) + '…';
  assert.ok(body.includes(truncated), '120文字+… が反復履歴テーブルに出る');

  // テーブル行（`| <数字> |` で始まる行）に evidence 文字列が混入しないことを検証
  const tableRows = body.split('\n').filter(l => /^\| \d+ \|/.test(l));
  assert.ok(tableRows.length > 0, 'テーブル行が存在する');
  for (const row of tableRows) {
    assert.ok(!row.includes('evidence item X'), 'テーブル行に evidence が混入しない');
  }
});

// --- New tests: minor findings + review_contract_error status (issue #321, F2) ---------

// (4) STATUS_HEADLINE: review_contract_error
test('buildTerminalSummaryBody: review_contract_error -> ⚠️ REVIEW CONTRACT ERROR 見出しとマーカーが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 30,
    status: 'review_contract_error',
    iterations: 4,
    lastDecision: 'approve',
    lastSummary: 'decision と blocking が矛盾',
    history: [],
  });
  assert.ok(body.includes('⚠️ REVIEW CONTRACT ERROR'), 'review_contract_error 見出しを含む');
  assert.ok(body.includes('<!-- pr-iterate:review_contract_error:4 -->'), '終端マーカーに review_contract_error が出る');
});

// (5) buildTerminalSummaryBody: history に minor を持つ round -> 反復履歴テーブルに minor 件数列、全 minor 詳細 details が箇条書きで出る
test('buildTerminalSummaryBody: history の minor が反復履歴テーブルの minor 列と全 minor 詳細 details（箇条書き）に出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 40,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [
      {
        iteration: 1,
        decision: 'comment',
        summary: 'minor only',
        blocking: [],
        minor: [
          { severity: 'minor', description: 'nit one' },
          { severity: 'minor', description: 'nit two' },
        ],
      },
      {
        iteration: 2,
        decision: 'approve',
        summary: 'looks good',
        blocking: [],
      },
    ],
  });
  assert.ok(body.includes('| 反復 | 判定 | 要修正 (blocking) | 軽微 (minor) | 総評 |'), '反復履歴テーブルヘッダが新レイアウトで出る');
  assert.ok(body.includes('| 1 | 💬 コメント | 0 | 2 | minor only |'), 'iteration 1 の minor 件数 2 が出る');
  assert.ok(body.includes('| 2 | ✅ 承認 (LGTM) | 0 | 0 | looks good |'), 'iteration 2 の minor 件数 0 が出る（キー無し）');
  assert.ok(body.includes('軽微な指摘（minor）の全詳細（自動修正対象外・2 件）'), '全 minor 詳細見出しが件数付きで出る');
  assert.ok(body.includes('1. 🟡 minor — 場所指定なし（反復 1 回目）'), '全 minor 詳細の見出し行に反復番号が付く');
  assert.ok(body.includes('nit one'), '全 minor 詳細に nit one が出る');
  assert.ok(body.includes('nit two'), '全 minor 詳細に nit two が出る');
});

// (6) history round に minor キーが無い場合も throw せず minor 列 0、details も出ない
test('buildTerminalSummaryBody: history 全 round に minor キーが無い場合 throw せず minor 列 0・全 minor 詳細 details は出ない', () => {
  const body = buildTerminalSummaryBody({
    pr: 41,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'all good',
    history: [
      { iteration: 1, decision: 'approve', summary: 'ok', blocking: [] },
    ],
  });
  assert.ok(body.includes('| 1 | ✅ 承認 (LGTM) | 0 | 0 | ok |'), 'minor キー無しでも minor 列 0 で出る');
  assert.ok(!body.includes('軽微な指摘（minor）の全詳細'), 'minor 0 件なら全 minor 詳細 details は出ない');
});

// --- buildTerminalSummaryBody: ci wait telemetry (F2) ---------------------

test('buildTerminalSummaryBody: ciWaitSeconds/ciPollAttempts を渡すと **CI 待機** 行が出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 55,
    status: 'ci_pending',
    iterations: 3,
    lastDecision: 'approve',
    lastSummary: 'CI 未完了',
    history: [],
    ciWaitSeconds: 90,
    ciPollAttempts: 6,
  });
  assert.ok(
    body.includes('**CI 待機**: 90秒（ポーリング 6 回）'),
    '**CI 待機** 行に累積秒数とポーリング回数が出る',
  );
});

test('buildTerminalSummaryBody: ciWaitSeconds/ciPollAttempts 省略時は **CI 待機** 行を含まない（回帰保証）', () => {
  const body = buildTerminalSummaryBody({
    pr: 56,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'ok',
    history: [],
  });
  assert.ok(!body.includes('**CI 待機**'), 'ciWaitSeconds/ciPollAttempts 省略時は **CI 待機** 行を含まない');
});

// --- terminalReviewAction (AC-2) ---------------------------------------------

test('terminalReviewAction: status=lgtm, lastDecision=approve -> approve', () => {
  const action = terminalReviewAction({ status: 'lgtm', lastDecision: 'approve', blockingCount: 0 });
  assert.equal(action, 'approve', 'lgtm + approve は approve');
});

test('terminalReviewAction: status=lgtm, lastDecision=comment -> comment（approve でない lgtm）', () => {
  const action = terminalReviewAction({ status: 'lgtm', lastDecision: 'comment', blockingCount: 0 });
  assert.equal(action, 'comment', 'lgtm でも approve でなければ comment');
});

test('terminalReviewAction: status=stuck, lastDecision=request-changes, blockingCount=2 -> request-changes', () => {
  const action = terminalReviewAction({ status: 'stuck', lastDecision: 'request-changes', blockingCount: 2 });
  assert.equal(action, 'request-changes', 'blocking>0 + request-changes は request-changes');
});

test('terminalReviewAction: status=max_reached, lastDecision=request-changes, blockingCount=1 -> request-changes', () => {
  const action = terminalReviewAction({ status: 'max_reached', lastDecision: 'request-changes', blockingCount: 1 });
  assert.equal(action, 'request-changes', 'blocking>0 + request-changes は request-changes');
});

test('terminalReviewAction: status=review_contract_error, lastDecision=approve, blockingCount=3 -> comment（approve だが lgtm でない）', () => {
  const action = terminalReviewAction({ status: 'review_contract_error', lastDecision: 'approve', blockingCount: 3 });
  assert.equal(action, 'comment', '(a)(b) いずれにも非該当のため comment に落ちる（承認・変更要求を捏造しない）');
});

test('terminalReviewAction: status=ci_pending, lastDecision=comment, blockingCount=0 -> comment', () => {
  const action = terminalReviewAction({ status: 'ci_pending', lastDecision: 'comment', blockingCount: 0 });
  assert.equal(action, 'comment');
});

test('terminalReviewAction: status=fix_failed, lastDecision=request-changes, blockingCount=0 -> comment（blocking 0 で非該当）', () => {
  const action = terminalReviewAction({ status: 'fix_failed', lastDecision: 'request-changes', blockingCount: 0 });
  assert.equal(action, 'comment', 'blockingCount=0 だと (b) 非該当のため comment');
});

test('terminalReviewAction: lastDecision=null -> comment', () => {
  const action = terminalReviewAction({ status: 'lgtm', lastDecision: null, blockingCount: 0 });
  assert.equal(action, 'comment', 'lastDecision null は (a)(b) 非該当で comment');
});

test('terminalReviewAction: 決定性（同入力 -> 同出力）', () => {
  const input = { status: 'stuck', lastDecision: 'request-changes', blockingCount: 5 };
  const first = terminalReviewAction(input);
  const second = terminalReviewAction(input);
  assert.equal(first, second, '同入力 -> 同出力');
});
