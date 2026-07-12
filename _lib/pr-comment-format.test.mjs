import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewCommentBody, buildTerminalSummaryBody } from './pr-comment-format.mjs';
import { mdCell } from './md-cell.mjs';
globalThis.mdCell = mdCell;

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

test('buildTerminalSummaryBody: 末尾マーカーが /<!-- pr-iterate:(lgtm|stuck|fix_failed|max_reached|ci_error|ci_pending):\\d+ -->$/ で末尾一致 (AC-5)', () => {
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
    '| 終了状態 | 総反復 | 最終判定 |',
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
    '| iter | 判定 | blocking | minor | summary |',
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
  const truncated = 'a'.repeat(120) + '\u2026';
  assert.ok(body.includes(truncated), '120文字+… が反復履歴テーブルに出る');

  // テーブル行（`| <数字> |` で始まる行）に evidence 文字列が混入しないことを検証
  const tableRows = body.split('\n').filter(l => /^\| \d+ \|/.test(l));
  assert.ok(tableRows.length > 0, 'テーブル行が存在する');
  for (const row of tableRows) {
    assert.ok(!row.includes('evidence item X'), 'テーブル行に evidence が混入しない');
  }
});

// (5) buildReviewCommentBody に summary / verificationEvidence を渡すと表示される
test('buildReviewCommentBody: summary と verificationEvidence を渡すと **summary** + **検証根拠** が出る', () => {
  const body = buildReviewCommentBody({
    pr: 3,
    iteration: 1,
    decision: 'approve',
    blocking: [],
    summary: '結論文',
    verificationEvidence: ['根拠1'],
  });
  assert.ok(body.includes('**summary**: 結論文'), '**summary**: が出る');
  assert.ok(body.includes('**検証根拠**:'), '**検証根拠**: が出る');
  assert.ok(body.includes('- 根拠1'), '箇条書き項目が出る');

  // 判定行の後に summary が来ることを確認（順序検証）
  const summaryIdx = body.indexOf('**summary**:');
  const decisionIdx = body.indexOf('**判定**:');
  assert.ok(decisionIdx < summaryIdx, '判定行より後に **summary** が来る');
});

// (6) buildReviewCommentBody で summary / verificationEvidence を渡さない場合、現行出力と完全一致
test('buildReviewCommentBody: summary / verificationEvidence 省略時は現行出力と完全一致', () => {
  const withoutNew = buildReviewCommentBody({
    pr: 5,
    iteration: 2,
    decision: 'request-changes',
    blocking: [{ severity: 'critical', description: 'issue' }],
  });
  const withUndefined = buildReviewCommentBody({
    pr: 5,
    iteration: 2,
    decision: 'request-changes',
    blocking: [{ severity: 'critical', description: 'issue' }],
    summary: undefined,
    verificationEvidence: undefined,
  });
  assert.ok(!withoutNew.includes('**summary**'), '省略時: **summary** を含まない');
  assert.ok(!withoutNew.includes('**検証根拠**'), '省略時: **検証根拠** を含まない');
  assert.equal(withoutNew, withUndefined, '省略と undefined 明示で出力が完全一致');
});

// (7) evidence 項目に改行を含む文字列を渡すと mdCell で <br> になる
test('buildReviewCommentBody: evidence 項目の改行が mdCell で <br> に変換される', () => {
  const body = buildReviewCommentBody({
    pr: 1,
    iteration: 1,
    decision: 'approve',
    blocking: [],
    summary: '要約',
    verificationEvidence: ['a\nb'],
  });
  assert.ok(body.includes('- a<br>b'), 'evidence 改行が <br> に変換される');
});

// --- New tests: minor findings + review_contract_error status (issue #321, F2) ---------

// (1) buildReviewCommentBody: minor 2 件 + blocking 0 件 -> blocking 指摘なし + minor テーブル両方出る
test('buildReviewCommentBody: minor 2 件 + blocking 0 件で「blocking 指摘なし」と minor テーブルが両方出る', () => {
  const body = buildReviewCommentBody({
    pr: 20,
    iteration: 1,
    decision: 'comment',
    blocking: [],
    minor: [
      { severity: 'minor', file: 'src/a.ts', line: 3, description: 'style nit', suggestion: 'use const' },
      { severity: 'minor', description: 'naming nit' },
    ],
  });
  assert.ok(body.includes('✅ blocking 指摘なし'), 'blocking 指摘なしが出る');
  assert.ok(body.includes('**minor 指摘（fix loop 対象外・参考）**: 2 件'), 'minor 見出しに件数 2 が出る');
  assert.ok(body.includes('| # | 重大度 | 場所 | 指摘 | 提案 |'), 'minor テーブルヘッダが出る');
  assert.ok(body.includes('🟡 minor'), 'minor 重大度ラベルが出る');
  assert.ok(body.includes('style nit'), 'minor description が出る');
  assert.ok(body.includes('use const'), 'minor suggestion が出る');
  assert.ok(body.includes('naming nit'), '2件目の minor description が出る');
});

// (2) minor 省略時の出力が変更前の期待値と一致（回帰保証）
test('buildReviewCommentBody: minor 省略時は minor 表示を含まない（回帰保証）', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 2,
    decision: 'request-changes',
    blocking: [{ severity: 'critical', description: 'issue' }],
  });
  assert.ok(!body.includes('minor 指摘'), 'minor 省略時は minor 見出しを含まない');
  const bodyWithEmptyMinor = buildReviewCommentBody({
    pr: 5,
    iteration: 2,
    decision: 'request-changes',
    blocking: [{ severity: 'critical', description: 'issue' }],
    minor: [],
  });
  assert.equal(body, bodyWithEmptyMinor, 'minor 省略と空配列で出力が完全一致');
});

// (3) minor の description/suggestion に | と \n を含む場合 mdCell でエスケープされる
test('buildReviewCommentBody: minor の description/suggestion が mdCell でエスケープされる', () => {
  const body = buildReviewCommentBody({
    pr: 5,
    iteration: 1,
    decision: 'comment',
    blocking: [],
    minor: [
      { severity: 'minor', description: 'pipe|char\nnewline', suggestion: 'fix|this\nplease' },
    ],
  });
  assert.ok(body.includes('pipe\\|char'), 'minor description の | が \\| にエスケープされる');
  assert.ok(body.includes('<br>'), 'minor 改行が <br> に変換される');
});

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

// (5) buildTerminalSummaryBody: history に minor を持つ round -> 反復履歴テーブルに minor 件数列、全 minor 詳細 details が出る
test('buildTerminalSummaryBody: history の minor が反復履歴テーブルの minor 列と全 minor 詳細 details に出る', () => {
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
  assert.ok(body.includes('| iter | 判定 | blocking | minor | summary |'), '反復履歴テーブルに minor 列ヘッダが出る');
  assert.ok(body.includes('| 1 | 💬 コメント | 0 | 2 | minor only |'), 'iteration 1 の minor 件数 2 が出る');
  assert.ok(body.includes('| 2 | ✅ 承認 (LGTM) | 0 | 0 | looks good |'), 'iteration 2 の minor 件数 0 が出る（キー無し）');
  assert.ok(body.includes('全 minor 指摘の詳細（fix loop 対象外・2 件）'), '全 minor 詳細見出しが件数付きで出る');
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
  assert.ok(!body.includes('全 minor 指摘の詳細'), 'minor 0 件なら全 minor 詳細 details は出ない');
});
