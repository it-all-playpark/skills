import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildCommitMessage,
  buildPrBody,
  prPhasePrompt,
  clip,
  hasClosesLine,
  verifyPrBody,
  prBodyEditPrompt,
  prPhaseFailure,
  prPhaseFailureFacts,
  prPhaseRecoveryCommands,
  prPhaseFailureComment,
  PR_PHASE_FAILED_CATEGORY,
  PR_FAILED_STEP_VALUES,
  PR_BODY_MAX_CHARS,
  PR_BODY_HEADINGS,
  PR_CLOSES_STATUS_VALUES,
  PR_BODY_NOTES_MAX,
  PR_NOTE_SECTIONS,
  adoptImplPrNotes,
  PR_BODY_OUT_OF_SCOPE_HEADING,
  PR_BODY_OUT_OF_SCOPE_MAX,
  PR_BODY_OUT_OF_SCOPE_ITEM_MAX,
  PR_BODY_NOTE_MAX,
  PR_BODY_DECISIONS_MAX,
  PR_BODY_DECISION_MAX,
  PR_BODY_CHANGE_BULLET_MAX,
  PR_SECTIONS_MAX_CHARS,
  PR_SECTION_HEADING_MAX,
  PR_BODY_PLAN_KEYS,
  prBodyClipReport,
  prSectionsTrimFeedback,
  hasPrBodyClips,
  prBodyEvidenceInstr,
  planWithoutPrBodyMaterial,
  prPushLogPath,
  PR_PUSH_LOG_NAME,
  PR_PUSH_TAIL_BEGIN,
  PR_PUSH_TAIL_END,
  PR_PUSH_TAIL_UNAVAILABLE,
  PR_PUSH_TIMEOUT_REASON,
} from './pr-artifacts.mjs';

function req(o = {}) {
  return {
    summary: 'PR phase を純関数化する',
    issue_type: 'refactor',
    acceptance_criteria: ['AC one', 'AC two'],
    issue_number: 642,
    issue_title: 'refactor(dev-flow): PR phase を純関数で生成する',
    ...o,
  };
}

function plan(o = {}) {
  return {
    summary: 'pr-artifacts.mjs を追加し PR phase の spawn を haiku に切り替える',
    architecture_decisions: [
      { decision: 'commit message は純関数で組み立てる', rationale: 'diff 再読不要' },
      'PR body に LLM 生成文を足さない',
    ],
    serial: [
      { id: 'F1', desc: 'pr-artifacts.mjs を追加', file_changes: ['plugins/dev-flow/_lib/pr-artifacts.mjs: 新規'], test_plan: 'tp', depends_on: [] },
      { id: 'F2', desc: 'dev-flow.js の PR phase を切替', file_changes: ['plugins/dev-flow/.claude/workflows/dev-flow.js'], test_plan: 'tp', depends_on: [] },
    ],
    ...o,
  };
}

function ledger(items = []) {
  return { items, round: 1 };
}

const INPUT = { issue: 642, req: req(), plan: plan() };

// ---- buildCommitMessage ----

test('[pr-artifacts] commit message: Conventional Commits subject + plan.summary body', () => {
  const msg = buildCommitMessage(INPUT);
  const lines = msg.split('\n');
  assert.equal(lines[0], 'refactor(dev-flow): PR phase を純関数で生成する (#642)');
  assert.equal(lines[1], '');
  assert.equal(lines[2], plan().summary);
  assert.ok(msg.endsWith('\n'), 'commit message は末尾改行で終わる');
});

test('[pr-artifacts] commit message: issue title に Conventional prefix が無ければ plan.file_changes の共通 dir 末尾を scope にする', () => {
  const msg = buildCommitMessage({ issue: 7, req: req({ issue_type: 'fix', issue_title: 'ボタンが二重送信される' }), plan: plan() });
  assert.equal(msg.split('\n')[0], 'fix(dev-flow): ボタンが二重送信される (#7)');
});

test('[pr-artifacts] commit message: 共通 dir が無ければ scope 無し、issue_type 欠落は title の type、両方無ければ chore', () => {
  const p = plan({ serial: [{ id: 'a', desc: 'd', file_changes: ['src/a.ts'] }, { id: 'b', desc: 'd', file_changes: ['tests/b.ts'] }] });
  assert.equal(buildCommitMessage({ issue: 1, req: req({ issue_type: 'feat', issue_title: 'add x' }), plan: p }).split('\n')[0], 'feat: add x (#1)');
  assert.equal(buildCommitMessage({ issue: 2, req: req({ issue_type: undefined, issue_title: 'docs(readme): fix typo' }), plan: p }).split('\n')[0], 'docs(readme): fix typo (#2)');
  assert.equal(buildCommitMessage({ issue: 3, req: req({ issue_type: undefined, issue_title: 'tidy' }), plan: p }).split('\n')[0], 'chore: tidy (#3)');
});

test('[pr-artifacts] commit message: 同一入力 → 同一出力（決定論）', () => {
  assert.equal(buildCommitMessage(INPUT), buildCommitMessage(structuredClone(INPUT)));
});

test('[pr-artifacts] commit message: plan.summary 欠落でも subject のみで成立する', () => {
  const msg = buildCommitMessage({ issue: 642, req: req(), plan: plan({ summary: '' }) });
  assert.equal(msg, 'refactor(dev-flow): PR phase を純関数で生成する (#642)\n');
});

// ---- buildPrBody: 6 セクション固定構成（issue #661） ----

test('[pr-artifacts] PR body: 結論1行 + 4 見出し + Closes の 6 セクションを持つ', () => {
  const body = buildPrBody({ ...INPUT, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(body.startsWith(`**${plan().summary}**`), `結論1行が先頭に来る: ${body}`);
  for (const h of PR_BODY_HEADINGS) {
    assert.ok(body.includes(`\n${h}\n`), `section '${h}' が無い: ${body}`);
  }
  assert.ok(body.includes('- [ ] AC one\n- [ ] AC two'), '受入条件を checkbox 列挙する');
  assert.ok(body.includes('- commit message は純関数で組み立てる — diff 再読不要'), 'object 形の decision を decision — rationale で列挙');
  assert.ok(body.includes('- PR body に LLM 生成文を足さない'), 'string 形の decision をそのまま列挙');
  assert.ok(body.includes('- `plugins/dev-flow/_lib/`: pr-artifacts.mjs'), 'component 別 bullet（F1 の file_changes）');
  assert.ok(body.includes('- `plugins/dev-flow/.claude/workflows/`: dev-flow.js'), 'component 別 bullet（F2 の file_changes）');
  assert.ok(!body.includes('## 変更 task'), '旧 table セクションは無い');
  assert.ok(!body.includes('## 要約'), '旧要約見出しは無い');
  assert.ok(body.trimEnd().endsWith('Closes #642'), 'Closes #<issue> で終わる');
});

test('[pr-artifacts] PR body: ledger の AC-n が checked なら [x]、danger / testsurf hit を検証に列挙する', () => {
  const body = buildPrBody({
    ...INPUT,
    ledger: ledger([
      { id: 'AC-1', checked: true, evidence: 'red→green', dimension: 'ac' },
      { id: 'AC-2', checked: false, dimension: 'ac' },
    ]),
    testsurfHits: [{ class: 'test-weakening', pattern: 'skip', file: 'tests/a.test.mjs' }],
    dangerHits: [{ class: 'exec-sink', file: 'src/run.mjs' }],
  });
  assert.ok(body.includes('- [x] AC one\n- [ ] AC two'), `checked 反映: ${body}`);
  assert.ok(body.includes('danger-grep: 1 件（exec-sink: `src/run.mjs`）'), `danger 列挙: ${body}`);
  assert.ok(body.includes('test-surface: 1 件（skip: `tests/a.test.mjs`）'), `testsurf 列挙: ${body}`);
});

// issue #746: hit の class / file を取得できないとき `unknown: \`?\`` の穴埋め表記を出さない
test('[pr-artifacts] PR body: class 名 string の hit / file・class 欠落の hit でも `unknown: `?`` を出さない', () => {
  const body = buildPrBody({
    ...INPUT, ledger: ledger(), testsurfHits: [{ class: 'test-weakening' }],
    dangerHits: ['auth', 'public-api', { class: 'exec-sink' }, { file: 'src/a.ts' }, {}],
  });
  assert.ok(!body.includes('unknown'), `unknown が出ている: ${body}`);
  assert.ok(!body.includes('`?`'), `\`?\` が出ている: ${body}`);
  assert.ok(body.includes('danger-grep: 5 件（auth、public-api、exec-sink、`src/a.ts`、詳細不明）'), `danger 列挙: ${body}`);
  assert.ok(body.includes('test-surface: 1 件（詳細不明）'), `testsurf 列挙: ${body}`);
});

// issue #747: 実装エージェントが返した設計判断・計測値を PR 本文の「設計判断」「検証」に載せる
test('[pr-artifacts] adoptImplPrNotes: IMPL の design_decisions / pr_notes が PR 本文の「設計判断」「検証」に載る', () => {
  const synth = { summary: 's', serial: [{ id: 'issue-1', file_changes: ['src/a.ts'] }] };
  const adopted = adoptImplPrNotes(synth, [{
    status: 'DONE', task_id: 'issue-1',
    design_decisions: [{ title: 'worker 上限は 4', rationale: '512Mi で RSS 合計 380Mi に収まる' }],
    pr_notes: [
      { section: 'measurement', text: '512Mi で worker 4 本: app 全体の RSS 合計 380Mi（ローカル docker stats）' },
      { section: 'verification', text: 'pnpm vitest run src/worker.test.ts: 12 passed' },
    ],
  }]);
  const body = buildPrBody({ issue: 1, req: req(), plan: adopted, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  const decisions = body.slice(body.indexOf('## 設計判断'), body.indexOf('## 検証'));
  const verify = body.slice(body.indexOf('## 検証'), body.indexOf('Closes #1'));
  assert.ok(decisions.includes('- worker 上限は 4 — 512Mi で RSS 合計 380Mi に収まる'), `設計判断: ${decisions}`);
  assert.ok(verify.includes('- 計測: 512Mi で worker 4 本: app 全体の RSS 合計 380Mi（ローカル docker stats）'), `検証: ${verify}`);
  assert.ok(verify.includes('- 検証: pnpm vitest run src/worker.test.ts: 12 passed'), `検証: ${verify}`);
  assert.ok(verify.includes('danger-grep: なし'), 'hit 行は残る');
  assert.deepEqual(adopted.serial, synth.serial, 'serial は変えない');
  assert.deepEqual(PR_NOTE_SECTIONS, ['verification', 'measurement']);
});

test('[pr-artifacts] adoptImplPrNotes: 空の報告は前回分を保持し、非空の報告は置き換える・不正項目は捨てる', () => {
  const first = adoptImplPrNotes({ serial: [] }, [{ task_id: 't', design_decisions: [{ title: 'A', rationale: 'r' }], pr_notes: [{ section: 'measurement', text: 'm1' }] }]);
  const kept = adoptImplPrNotes(first, [{ task_id: 't', design_decisions: [], pr_notes: [] }]);
  assert.deepEqual(kept.architecture_decisions, [{ decision: 'A', rationale: 'r' }]);
  assert.deepEqual(kept.pr_notes, [{ section: 'measurement', text: 'm1' }]);
  const replaced = adoptImplPrNotes(kept, [{ task_id: 't', pr_notes: [{ section: 'measurement', text: 'm2' }, { section: 'other', text: 'x' }, { section: 'verification', text: '  ' }] }]);
  assert.deepEqual(replaced.pr_notes, [{ section: 'measurement', text: 'm2' }]);
  assert.deepEqual(replaced.architecture_decisions, [{ decision: 'A', rationale: 'r' }]);
  assert.deepEqual(adoptImplPrNotes({ serial: [] }, [{ design_decisions: [{ title: '', rationale: 'r' }] }]), { serial: [] });
});

// issue #793: 範囲外にした作業を PR 本文の「この PR に含めなかったもの」に載せる
test('[pr-artifacts] adoptImplPrNotes: out_of_scope は plan.out_of_scope に取り込み、PR 本文の Closes 行の前に節を足す（空なら節なし）', () => {
  const adopted = adoptImplPrNotes({ serial: [] }, [{ task_id: 't', out_of_scope: ['  telemetry キーの削除（AC 外）  ', '', 'dotfiles の変更（worktree 外）', 'dotfiles の変更（worktree 外）'] }]);
  assert.deepEqual(adopted.out_of_scope, ['telemetry キーの削除（AC 外）', 'dotfiles の変更（worktree 外）']);
  const body = buildPrBody({ issue: 1, req: req(), plan: plan({ out_of_scope: adopted.out_of_scope }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(body.includes(`${PR_BODY_OUT_OF_SCOPE_HEADING}\n- telemetry キーの削除（AC 外）\n- dotfiles の変更（worktree 外）\n\nCloses #1`), body);
  assert.ok(verifyPrBody(body, 1).ok, '節を足しても構造検証は通る');
  const kept = adoptImplPrNotes(adopted, [{ task_id: 't', out_of_scope: [] }]);
  assert.deepEqual(kept.out_of_scope, adopted.out_of_scope, '空の報告は前回分を保持する');
  assert.ok(!buildPrBody({ issue: 1, req: req(), plan: plan(), ledger: ledger(), testsurfHits: [], dangerHits: [] }).includes(PR_BODY_OUT_OF_SCOPE_HEADING));
  const many = Array.from({ length: PR_BODY_OUT_OF_SCOPE_MAX + 2 }, (_, i) => `oos-${i}`);
  const clipped = buildPrBody({ issue: 1, req: req(), plan: plan({ out_of_scope: many }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(clipped.includes(`- oos-${PR_BODY_OUT_OF_SCOPE_MAX - 1}\n（他 2 件）`), clipped);
});

test('[pr-artifacts] PR body: pr_notes は PR_BODY_NOTES_MAX 件まで、超過分は件数だけ出す', () => {
  const notes = Array.from({ length: PR_BODY_NOTES_MAX + 2 }, (_, i) => ({ section: 'verification', text: `note-${i}` }));
  const body = buildPrBody({ issue: 1, req: req(), plan: plan({ pr_notes: notes }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(body.includes(`- 検証: note-${PR_BODY_NOTES_MAX - 1}`));
  assert.ok(!body.includes(`- 検証: note-${PR_BODY_NOTES_MAX}`));
  assert.ok(body.includes('（他 2 件）'), body);
});

// ---- issue #815: pr_sections（複数行 markdown）は clip せず <details> に載せ、要約行の clip は報告する ----

// 40 行の対応表（ヘッダ 2 行 + 本体 40 行）。1 行あたり pr_notes の上限を超える長さにする。
const TABLE_40 = [
  '| # | 元の項目 | 移植先 | 状態 |',
  '|---|---|---|---|',
  ...Array.from({ length: 40 }, (_, i) => `| ${i + 1} | references/item-${i + 1}.md の節「${'説明'.repeat(10)}」 | skills/daily-blog-factory/references/item-${i + 1}.md | 移植済み |`),
].join('\n');

// <details> ブロックを除いた可視部。
function visiblePart(body) {
  return body.replace(/<details><summary>[^\n]*<\/summary>\n[\s\S]*?\n<\/details>(\n\n)?/g, '');
}

test('[pr-artifacts] pr_sections: 40 行の markdown table が改行を保ったまま切られずに <details> で本文に載る', () => {
  assert.ok(Array.from(TABLE_40).length > PR_BODY_NOTE_MAX * 10, 'fixture は pr_notes の上限より十分長い');
  const adopted = adoptImplPrNotes({ summary: 's', serial: [] }, [{
    status: 'DONE', task_id: 'issue-1',
    pr_sections: [{ heading: '落とした項目が無いことの対応表', markdown: `\n${TABLE_40.replace(/\n/g, '\r\n')}\n\n` }],
    pr_notes: [{ section: 'verification', text: '対応表は下の折りたたみ' }],
  }]);
  assert.deepEqual(adopted.pr_sections, [{ heading: '落とした項目が無いことの対応表', markdown: TABLE_40 }], 'CRLF 正規化・前後の空行除去のみ');
  const body = buildPrBody({ issue: 1, req: req(), plan: adopted, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(body.includes(`<details><summary>落とした項目が無いことの対応表</summary>\n\n${TABLE_40}\n\n</details>`), body);
  assert.equal(body.split('\n').filter((l) => /^\| \d+ \|/.test(l)).length, 40, '表の 40 行が 1 行ずつ残る');
  assert.ok(!body.includes('…'), '何も切られていない');
  assert.ok(body.indexOf('## 検証') < body.indexOf('<details>'), '「検証」の後に置く');
  assert.ok(body.indexOf('</details>') < body.indexOf('Closes #1'), 'Closes 行より前に置く');
  assert.ok(body.trimEnd().endsWith('Closes #1'));
  assert.ok(verifyPrBody(body, 1).ok, '構造検証は通る');
});

test('[pr-artifacts] pr_sections: heading は 1 行に畳み HTML をエスケープ、空項目は捨て、空の報告は前回分を保持する', () => {
  const first = adoptImplPrNotes({ serial: [] }, [{ pr_sections: [
    { heading: ' A <b> &\n表 ', markdown: '| a |\n|---|\n| 1 |' },
    { heading: '', markdown: 'x' },
    { heading: 'h', markdown: '  \n ' },
  ] }]);
  assert.deepEqual(first.pr_sections, [{ heading: 'A <b> & 表', markdown: '| a |\n|---|\n| 1 |' }]);
  const body = buildPrBody({ issue: 1, req: req(), plan: plan({ pr_sections: first.pr_sections }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(body.includes('<details><summary>A &lt;b&gt; &amp; 表</summary>\n\n| a |\n|---|\n| 1 |\n\n</details>'), body);
  const kept = adoptImplPrNotes(first, [{ pr_sections: [] }]);
  assert.deepEqual(kept.pr_sections, first.pr_sections);
  assert.ok(!buildPrBody({ issue: 1, req: req(), plan: plan(), ledger: ledger(), testsurfHits: [], dangerHits: [] }).includes('<details>'), 'pr_sections が無ければ <details> を出さない');
});

test('[pr-artifacts] pr_sections: 中身の </details> / <details> と行全体の Closes #<n> は無害化し、本物の Closes 行が落ちれば構造検証は Closes 欠落', () => {
  const markdown = '前置き\n</details>\n<DETAILS open>\nCloses #1\nCloses #999 \n文中の Closes #1 はそのまま';
  const body = buildPrBody({ issue: 1, req: req(), plan: plan({ pr_sections: [{ heading: 'h', markdown }] }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  const block = body.slice(body.indexOf('<details>'), body.lastIndexOf('</details>') + '</details>'.length);
  assert.equal((body.match(/<\/details>/gi) ?? []).length, 1, '閉じタグは builder が置いた 1 個だけ');
  assert.equal((body.match(/<details/gi) ?? []).length, 1, '開きタグは builder が置いた 1 個だけ');
  const Z = String.fromCharCode(0x200b);
  assert.ok(block.includes(`<${Z}/details>`) && block.includes(`<${Z}DETAILS open>`), block);
  assert.ok(block.includes(`\n${Z}Closes #1\n${Z}Closes #999 \n`), block);
  assert.ok(block.includes('文中の Closes #1 はそのまま'), '行全体一致でない Closes は変えない');
  assert.ok(verifyPrBody(body, 1).ok, '本物の Closes 行があれば構造検証は通る');
  const truncated = body.slice(0, body.lastIndexOf('Closes #1'));
  assert.equal(hasClosesLine(truncated, 1), false, '本物の Closes 行が落ちたら中身の偽物で present にしない');
  assert.ok(verifyPrBody(truncated, 1).missing.includes('Closes'));
  assert.equal(prBodyClipReport(plan({ pr_sections: [{ heading: 'h', markdown }] })).sections_over_chars, 0);
});

test('[pr-artifacts] pr_sections: 閉じていないコードフェンスは閉じ、<!-- は無害化して、後続の </details> と Closes 行を飲み込ませない', () => {
  const Z = String.fromCharCode(0x200b);
  const bodyOf = (markdown) => buildPrBody({ issue: 1, req: req(), plan: plan({ pr_sections: [{ heading: 'h', markdown }] }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  const blockOf = (body) => body.slice(body.indexOf('<details>'), body.lastIndexOf('</details>') + '</details>'.length);

  const backtick = blockOf(bodyOf('前置き\n```js\nconst a = 1;'));
  assert.ok(backtick.includes('const a = 1;\n```\n\n</details>'), `閉じフェンスが足される: ${backtick}`);
  const tilde = blockOf(bodyOf('~~~~\nx\n~~~'));
  assert.ok(tilde.includes('x\n~~~\n~~~~\n\n</details>'), `短い閉じは閉じとみなさず同じ長さで閉じる: ${tilde}`);
  const mixed = blockOf(bodyOf('```\n~~~\nx'));
  assert.ok(mixed.includes('x\n```\n\n</details>'), `別記号の行は閉じとみなさない: ${mixed}`);
  const balanced = blockOf(bodyOf('```\nx\n```\n後ろ'));
  assert.ok(balanced.includes('```\nx\n```\n後ろ\n\n</details>'), `閉じているフェンスは変えない: ${balanced}`);
  assert.ok(blockOf(bodyOf('   ```\nx\n```')).includes('   ```\nx\n```\n\n</details>'), '3 空白までのインデントもフェンスとして数える');
  const inline = blockOf(bodyOf('```npm test``` を実行する\n後ろ'));
  assert.ok(inline.includes('```npm test``` を実行する\n後ろ\n\n</details>'), `行頭のインラインコードはフェンスとみなさず閉じフェンスを足さない: ${inline}`);
  const inlineThenFence = blockOf(bodyOf('```a``` 説明\n```js\nx'));
  assert.ok(inlineThenFence.includes('x\n```\n\n</details>'), `インラインコード行の後の本物のフェンスは閉じる: ${inlineThenFence}`);

  const comment = bodyOf('前置き <!-- 閉じない');
  assert.ok(!comment.includes('<!--'), comment);
  assert.ok(comment.includes(`<!${Z}-- 閉じない`), comment);
  assert.ok(comment.trimEnd().endsWith('Closes #1'));
});

test('[pr-artifacts] PR body: pr_sections を上限いっぱいに載せても可視部（<details> の外）は PR_BODY_MAX_CHARS 以内', () => {
  const big = 'x'.repeat(PR_SECTIONS_MAX_CHARS / 2 - 10);
  const sections = [{ heading: 'h1', markdown: big }, { heading: 'h2', markdown: big }];
  const acs = Array.from({ length: 6 }, (_, i) => `AC${i}: ${'x'.repeat(300)}`);
  const longPath = (i) => `plugins/dev-flow/some/very/deeply/nested/directory/structure/for/testing/clip/f${i}.ts`;
  const body = buildPrBody({
    issue: 815,
    req: req({ acceptance_criteria: acs }),
    plan: plan({ summary: 'あ'.repeat(500), pr_sections: sections, pr_notes: Array.from({ length: 5 }, () => ({ section: 'verification', text: 'v'.repeat(400) })) }),
    ledger: ledger(),
    testsurfHits: Array.from({ length: 20 }, (_, i) => ({ pattern: `pat${i}`, file: longPath(i) })),
    dangerHits: Array.from({ length: 20 }, (_, i) => ({ class: `class${i}`, file: longPath(i) })),
  });
  const visible = visiblePart(body);
  assert.ok(Array.from(visible).length <= PR_BODY_MAX_CHARS, `可視部 ${Array.from(visible).length} 字が上限超過`);
  assert.ok(Array.from(body).length > PR_BODY_MAX_CHARS, '<details> の中は上限計測に入らない（本文全体は上限を超えうる）');
  assert.equal((body.match(new RegExp(big, 'g')) ?? []).length, 2, 'pr_sections は切られない');
  assert.ok(visible.trimEnd().endsWith('Closes #815'));
  assert.equal(prBodyClipReport(plan({ pr_sections: sections })).sections_over_chars, 0, '上限いっぱいは超過ではない');
  // 転写が verbatim なら Closes 行は残り、末尾の Closes 行が落ちれば欠落になる（実 PR での haiku 転写の実測は別）
  assert.ok(verifyPrBody(body, 815).ok, '構造検証は通る');
  assert.equal(hasClosesLine(body.slice(0, body.lastIndexOf('Closes #815')), 815), false);
});

test('[pr-artifacts] prSectionsTrimFeedback: pr_sections の合計が上限以内なら null、超えたら合計・内訳・指示を 1 件返す', () => {
  const at = [{ heading: 'a', markdown: 'x'.repeat(PR_SECTIONS_MAX_CHARS - 1) }, { heading: 'b', markdown: 'y' }];
  assert.equal(prSectionsTrimFeedback(plan({ pr_sections: at })), null, '上限ちょうどは差し戻さない');
  assert.equal(prSectionsTrimFeedback(plan()), null, 'pr_sections 無しは差し戻さない');
  const over = [{ heading: 'a', markdown: 'x'.repeat(PR_SECTIONS_MAX_CHARS) }, { heading: 'b', markdown: 'yy' }];
  const fb = prSectionsTrimFeedback(plan({ pr_sections: over }));
  assert.equal(fb.length, 1);
  assert.deepEqual(fb[0].pr_sections_over_limit, {
    total_chars: PR_SECTIONS_MAX_CHARS + 2,
    max_chars: PR_SECTIONS_MAX_CHARS,
    sections: [{ heading: 'a', chars: PR_SECTIONS_MAX_CHARS }, { heading: 'b', chars: 2 }],
  });
  assert.ok(fb[0].instruction.includes('コード・テストは変更しない'), fb[0].instruction);
  assert.ok(fb[0].instruction.includes(`${PR_SECTIONS_MAX_CHARS} 字以内`), fb[0].instruction);
});

test('[pr-artifacts] prBodyClipReport: 本文で「…」に切った note / decision / change bullet の件数と pr_sections の上限超過字数を返す', () => {
  const clean = prBodyClipReport(plan({ pr_notes: [{ section: 'verification', text: 'short' }] }));
  assert.deepEqual(clean, { note: 0, decision: 0, change_bullet: 0, sections_over_chars: 0 });
  assert.equal(hasPrBodyClips(clean), false);
  assert.equal(hasPrBodyClips(null), false);

  const p = plan({
    pr_notes: [
      { section: 'verification', text: 'n'.repeat(PR_BODY_NOTE_MAX) },
      { section: 'measurement', text: 'short' },
      ...Array.from({ length: 6 }, () => ({ section: 'verification', text: 'n'.repeat(PR_BODY_NOTE_MAX * 2) })),
    ],
    architecture_decisions: [{ decision: 'd'.repeat(PR_BODY_DECISION_MAX), rationale: 'r' }, 'ok'],
    serial: [{ id: 'T', file_changes: [`src/${'a'.repeat(PR_BODY_CHANGE_BULLET_MAX)}.ts`, 'lib/b.ts'] }],
    pr_sections: [{ heading: 'h', markdown: 'm'.repeat(PR_SECTIONS_MAX_CHARS + 7) }],
  });
  const report = prBodyClipReport(p);
  // note: 本文に出る先頭 5 件のうち上限超過は 1 件目と 3〜5 件目（6 件目以降は「他 N 件」で数えない）
  assert.deepEqual(report, { note: 4, decision: 1, change_bullet: 1, sections_over_chars: 7 });
  assert.equal(hasPrBodyClips(report), true);
  const body = buildPrBody({ issue: 1, req: req(), plan: p, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  const ellipsisLines = body.split('\n').filter((l) => l.startsWith('- ') && l.endsWith('…'));
  assert.equal(ellipsisLines.length, report.note + report.decision + report.change_bullet, '報告件数と本文の「…」行数が一致する');
  assert.ok(body.includes('m'.repeat(PR_SECTIONS_MAX_CHARS + 7)), '上限超過でも pr_sections は切らない');
});

test('[pr-artifacts] prBodyEvidenceInstr / planWithoutPrBodyMaterial: evaluator には本文テキストを渡し、plan の本文材料は外す', () => {
  const body = buildPrBody({ issue: 1, req: req(), plan: plan({ pr_notes: [{ section: 'measurement', text: 'RSS 380Mi' }] }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  const instr = prBodyEvidenceInstr(body);
  assert.ok(instr.includes(`<<<PR_BODY_PREVIEW_BEGIN>>>\n${body}<<<PR_BODY_PREVIEW_END>>>`), instr);
  assert.match(instr, /「PR 本文に書く」型の AC は、この本文テキスト/);
  assert.match(instr, /チェックボックス（- \[ \] \/ - \[x\]）は未確定であり、AC の充足・未達の根拠にするな/);
  const p = plan({ pr_notes: [{ section: 'measurement', text: 'x' }], pr_sections: [{ heading: 'h', markdown: 'm' }], out_of_scope: ['o'] });
  const stripped = planWithoutPrBodyMaterial(p);
  for (const k of PR_BODY_PLAN_KEYS) assert.ok(!(k in stripped), `${k} が残っている`);
  assert.equal(stripped.summary, p.summary);
  assert.deepEqual(stripped.serial, p.serial);
  assert.ok('pr_notes' in p, '入力 plan は変更しない');
  assert.deepEqual(PR_BODY_PLAN_KEYS, ['architecture_decisions', 'pr_notes', 'pr_sections', 'out_of_scope']);
  assert.equal(planWithoutPrBodyMaterial(null), null);
});

test('[pr-artifacts] PR body: hit なしは「なし」、AC / decisions / 変更 空でもセクションは残る', () => {
  const body = buildPrBody({ issue: 5, req: req({ acceptance_criteria: [] }), plan: plan({ architecture_decisions: [], serial: [] }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(body.includes('## 変更\n（なし）'), body);
  assert.ok(body.includes('## 受入条件\n（なし）'), body);
  assert.ok(body.includes('## 設計判断\n（なし）'), body);
  assert.ok(body.includes('danger-grep: なし'), body);
  assert.ok(body.includes('test-surface: なし'), body);
  assert.ok(body.trimEnd().endsWith('Closes #5'));
});

test('[pr-artifacts] PR body: plan.summary が空なら issue_title、両方空なら issue #<n> の変更 を結論にする', () => {
  const b1 = buildPrBody({ issue: 9, req: req({ issue_title: 'fallback title' }), plan: plan({ summary: '' }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(b1.startsWith('**fallback title**'), b1);
  const b2 = buildPrBody({ issue: 9, req: { issue_title: '' }, plan: plan({ summary: '' }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(b2.startsWith('**issue #9 の変更**'), b2);
});

test('[pr-artifacts] PR body: 結論は改行・連続空白を1空白に畳む', () => {
  const body = buildPrBody({ issue: 1, req: req(), plan: plan({ summary: '行1\n\n  行2   行3' }), ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(body.startsWith('**行1 行2 行3**'), body);
});

test('[pr-artifacts] PR body: 同一入力 → 同一出力（決定論）', () => {
  const input = { ...INPUT, ledger: ledger([{ id: 'AC-1', checked: true }]), testsurfHits: [], dangerHits: [] };
  assert.equal(buildPrBody(input), buildPrBody(structuredClone(input)));
});

test('[pr-artifacts] PR body: null / undefined の任意入力で throw しない', () => {
  const body = buildPrBody({ issue: 9, req: { issue_title: 't' }, plan: null, ledger: null, testsurfHits: null, dangerHits: undefined });
  assert.ok(body.trimEnd().endsWith('Closes #9'));
});

// ---- (a) 上限 pin: 巨大 planner 出力でも PR_BODY_MAX_CHARS 以下 ----

test('[pr-artifacts] PR body: 巨大 planner 出力でも PR_BODY_MAX_CHARS 以下・設計判断/変更 bullet は上限件数以下', () => {
  const bigSummary = 'あ'.repeat(2000);
  const decisions = Array.from({ length: 12 }, (_, i) => ({ decision: `決定${i}`.repeat(1), rationale: 'り'.repeat(400) }));
  const tasks = Array.from({ length: 40 }, (_, i) => ({
    id: `T${i}`,
    desc: 'd',
    file_changes: Array.from({ length: 10 }, (_, j) => `dir${i}-${j}/file${j}.ts`),
    test_plan: 'tp',
    depends_on: [],
  }));
  const acs = Array.from({ length: 6 }, (_, i) => `AC${i}: ${'x'.repeat(300)}`);
  const longPath = (i) => `plugins/dev-flow/some/very/deeply/nested/directory/structure/for/testing/clip/f${i}.ts`;
  const dangerHits = Array.from({ length: 20 }, (_, i) => ({ class: `class${i}`, file: longPath(i) }));
  const testsurfHits = Array.from({ length: 20 }, (_, i) => ({ pattern: `pat${i}`, file: longPath(i) }));

  const body = buildPrBody({
    issue: 642,
    req: req({ acceptance_criteria: acs }),
    plan: plan({ summary: bigSummary, architecture_decisions: decisions, serial: tasks }),
    ledger: ledger(),
    testsurfHits,
    dangerHits,
  });

  assert.ok(Array.from(body).length <= PR_BODY_MAX_CHARS, `body 長 ${Array.from(body).length} が上限超過:\n${body}`);
  assert.ok(!body.includes(longPath(0)), '上限超過時は hit の file path が clip されている必要がある');

  const decisionLines = body.split('\n').filter((l) => l.startsWith('- ') && /決定\d+/.test(l));
  assert.ok(decisionLines.length <= 5, `設計判断 bullet は5件以下: ${decisionLines.length}`);
  for (const l of decisionLines) assert.ok(Array.from(l).length <= 122, `設計判断行が長すぎる (${Array.from(l).length}): ${l}`);

  const firstLine = body.split('\n')[0];
  assert.ok(Array.from(firstLine).length <= 124, `結論行が長すぎる (${Array.from(firstLine).length}): ${firstLine}`);

  const changeSection = body.split('## 変更\n')[1].split('\n\n')[0];
  const changeBullets = changeSection.split('\n').filter((l) => l.startsWith('- `'));
  assert.ok(changeBullets.length <= 6, `変更 bullet は6件以下: ${changeBullets.length}`);
});

// ---- (b) 6 セクションの順序・存在（verifyPrBody） ----

test('[pr-artifacts] verifyPrBody: 通常 fixture で ok:true・missing 空・見出しが単調増加の順序で現れる', () => {
  const body = buildPrBody({ ...INPUT, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  const result = verifyPrBody(body, 642);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.missing, []);
  const indices = ['**', '## 変更', '## 受入条件', '## 設計判断', '## 検証', 'Closes #642'].map((marker) => body.indexOf(marker));
  for (const idx of indices) assert.ok(idx >= 0, `marker が見つからない: ${JSON.stringify(indices)}`);
  for (let i = 1; i < indices.length; i++) assert.ok(indices[i] > indices[i - 1], `順序が単調増加でない: ${JSON.stringify(indices)}`);
});

// ---- (c) Closes 行 ----

test('[pr-artifacts] Closes 行: 末尾に存在し hasClosesLine が真、欠落・桁違いでは偽', () => {
  const body = buildPrBody({ ...INPUT, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(body.trimEnd().endsWith('Closes #642'));
  assert.equal(hasClosesLine(body, 642), true);
  const withoutClosesLine = body.trimEnd().split('\n').slice(0, -1).join('\n');
  assert.equal(hasClosesLine(withoutClosesLine, 642), false);
  assert.equal(hasClosesLine('Closes #6420', 642), false);
});

// ---- (d) verifyPrBody: セクション欠落検出（PR #660 症状） ----

test('[pr-artifacts] verifyPrBody: ## 設計判断 以降が欠落した本文は missing に ## 検証 / Closes を含み ok:false', () => {
  const full = buildPrBody({ ...INPUT, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  const truncated = full.split('## 設計判断')[0].trimEnd();
  const result = verifyPrBody(truncated, 642);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('## 検証'), JSON.stringify(result));
  assert.ok(result.missing.includes('Closes'), JSON.stringify(result));
});

test('[pr-artifacts] PR_CLOSES_STATUS_VALUES は 4 値の closed enum', () => {
  assert.deepEqual(PR_CLOSES_STATUS_VALUES, ['verified', 'reinjected', 'missing', 'unverified']);
});

// ---- (f) acResults 優先 ----

test('[pr-artifacts] PR body: acResults が指定されれば ledger より優先してチェック判定する', () => {
  const body = buildPrBody({
    ...INPUT,
    ledger: ledger([
      { id: 'AC-1', checked: false },
      { id: 'AC-2', checked: true },
    ]),
    acResults: [
      { ac_index: 0, satisfied: true },
      { ac_index: 1, satisfied: false },
    ],
    testsurfHits: [],
    dangerHits: [],
  });
  assert.ok(body.includes('- [x] AC one\n- [ ] AC two'), body);
});

test('[pr-artifacts] PR body: acResults 未指定は ledger の checked に従う', () => {
  const body = buildPrBody({
    ...INPUT,
    ledger: ledger([{ id: 'AC-1', checked: true }, { id: 'AC-2', checked: false }]),
    testsurfHits: [],
    dangerHits: [],
  });
  assert.ok(body.includes('- [x] AC one\n- [ ] AC two'), body);
});

// ---- clip ----

test('[pr-artifacts] clip: code point 単位で数え、超過時は末尾 … に切り詰める', () => {
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip('abcdef', 5), 'abcd…');
  assert.equal(clip('あいうえお', 3), 'あい…');
});

// ---- prPhasePrompt (既存) ----

test('[pr-artifacts] prompt: 本文を verbatim 転写させ bare 単文の git / gh を順に実行させる', () => {
  const commitMessage = buildCommitMessage(INPUT);
  const prBody = buildPrBody({ ...INPUT, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  const p = prPhasePrompt({ wt: '/tmp/wt', base: 'main', branch: 'feature/issue-642', repo: 'o/r', issue: 642, commitMessage, prBody });
  assert.ok(p.includes(commitMessage), 'commit message 本文が prompt に verbatim で含まれる');
  assert.ok(p.includes(prBody), 'PR body 本文が prompt に verbatim で含まれる');
  assert.ok(p.includes('<<<COMMIT_MSG_BEGIN>>>') && p.includes('<<<COMMIT_MSG_END>>>'));
  assert.ok(p.includes('<<<PR_BODY_BEGIN>>>') && p.includes('<<<PR_BODY_END>>>'));
  assert.ok(p.includes('/tmp/wt/.devflow-tmp/commit-msg.txt') && p.includes('/tmp/wt/.devflow-tmp/pr-body.md'));
  // git は全て -C なしの bare 形（issue #700: `git -C` 形は sandbox 除外に当たらず、push は credential helper、
  // add / commit は write deny 下の .git で index.lock 作成が失敗する）
  assert.ok(p.includes('`git add -A`'), '手順 1 の add が bare 形でない');
  assert.ok(p.includes('`git commit -F /tmp/wt/.devflow-tmp/commit-msg.txt`'), '手順 2 の commit が bare 形でない');
  assert.ok(p.includes('3. `pr-push /tmp/wt/.devflow-tmp/push-output.log`'), '手順 3 の push が bare 名 pr-push でない');
  assert.ok(p.includes('`git rev-parse HEAD`'), '手順 6 の rev-parse が bare 形でない');
  assert.ok(!/git -C /.test(p), `prompt に git -C 形が含まれてはならない: ${p.match(/git -C [^\n]*/)?.[0]}`);
  assert.ok(p.includes('cwd は worktree（EnterWorktree 済み）なので git には -C も cd も付けない'), 'bare 注記が cwd=worktree 前提の文言になっていない');
  assert.ok(!p.includes('-C で worktree を渡しているため cd は不要'), '旧 bare 注記（-C 前提）が残っている');
  assert.ok(p.includes('`gh pr create --repo o/r --draft --base main --head feature/issue-642 --title "refactor(dev-flow): PR phase を純関数で生成する (#642)" --body-file /tmp/wt/.devflow-tmp/pr-body.md`'));
  assert.ok(p.includes('pr_url') && p.includes('pr_number') && p.includes('committed'));
});

test('[pr-artifacts] prompt: repo 未解決なら --repo を省略し、title の二重引用符はエスケープする', () => {
  const p = prPhasePrompt({ wt: '/w', base: 'dev', branch: 'b', repo: null, issue: 1, commitMessage: 'fix: say "hi" (#1)\n', prBody: 'Closes #1' });
  assert.ok(!p.includes('--repo'), p);
  assert.ok(p.includes('--title "fix: say \\"hi\\" (#1)"'), p);
});

test('[pr-artifacts] prompt: 同一入力 → 同一出力（決定論）', () => {
  const a = { wt: '/w', base: 'main', branch: 'b', repo: 'o/r', issue: 1, commitMessage: 'x (#1)\n', prBody: 'y' };
  assert.equal(prPhasePrompt(a), prPhasePrompt({ ...a }));
});

// ---- prPhasePrompt の中断契約 / prPhaseFailure (issue #682) ----

test('[pr-artifacts] prompt: 手順 2〜4 の失敗で failed_step / failure_reason を埋めて中断する契約と Output format を持つ', () => {
  const p = prPhasePrompt({ wt: '/w', base: 'main', branch: 'b', repo: 'o/r', issue: 1, commitMessage: 'x (#1)\n', prBody: 'y' });
  assert.ok(p.includes('"failed_step": "" | "commit" | "push" | "pr-create"'), 'Output format に failed_step の閉じた enum が無い');
  assert.ok(p.includes('"failure_reason": string'), 'Output format に failure_reason が無い');
  assert.ok(p.includes('stderr 末尾 1〜3 行'), 'failure_reason の内容（stderr 末尾 1〜3 行）が指示されていない');
  assert.ok(p.includes('failed_step:"commit" で中断'), '手順 2（commit）の中断指示が無い');
  assert.ok(p.includes('failed_step:"push" で中断'), '手順 3（push）の中断指示が無い');
  assert.ok(p.includes('failed_step:"pr-create" で中断'), '手順 4（pr-create）の中断指示が無い');
  assert.ok(p.includes('成功時は空文字'), '成功時に failed_step / failure_reason を空文字にする指示が無い');
});

// ---- prPhasePrompt の push timeout / 再発行禁止（issue #804） ----

test('[pr-artifacts] prompt: 手順 3 の push は Bash timeout: 600000 指定・run_in_background 禁止・完了前の gh pr create と再発行を禁じ、timeout はリトライせず failed_step:"push" で中断する', () => {
  const p = prPhasePrompt({ wt: '/w', base: 'main', branch: 'b', repo: 'o/r', issue: 1, commitMessage: 'x (#1)\n', prBody: 'y' });
  const step3 = p.split('\n').find((l) => l.startsWith('3. `pr-push '));
  assert.ok(step3, `手順 3 の push 行が無い: ${p}`);
  assert.ok(step3.includes('Bash tool の `timeout: 600000` を指定して実行'), `手順 3 に timeout: 600000 指定が無い: ${step3}`);
  assert.ok(step3.includes('`run_in_background` は使わない（禁止）'), `手順 3 に run_in_background 禁止が無い: ${step3}`);
  assert.ok(step3.includes('push の結果が返るまで手順 4（`gh pr create`）を実行しない'), `push 完了前の gh pr create 禁止が無い: ${step3}`);
  assert.ok(step3.includes('push を再発行しない（timeout・background 化した場合も含む）'), `push 再発行禁止が無い: ${step3}`);
  assert.ok(step3.includes('600 秒の timeout に達した場合はリトライせず、failed_step:"push"'), `timeout 到達時の中断（リトライしない）が無い: ${step3}`);
  assert.ok(step3.includes(`failure_reason に \`"${PR_PUSH_TIMEOUT_REASON}"\` を一字一句そのまま入れて中断する`), `failure_reason に timeout の固定文言を入れる指示が無い: ${step3}`);
  assert.ok(PR_PUSH_TIMEOUT_REASON.startsWith('push timed out after 600s'), PR_PUSH_TIMEOUT_REASON);
  // --no-verify は使わない（hook の検査を捨てない）: 付けない指示はあるが、付けた形の実行指示は無い
  assert.ok(step3.includes('`--no-verify` は付けない'), `--no-verify 不使用の指示が無い: ${step3}`);
  assert.ok(!/(git push|pr-push)[^`]*--no-verify/.test(p), 'push に --no-verify を付けた形がある');
  // timeout 指定は push の手順に付く（手順 4 の gh pr create より前）
  assert.ok(p.indexOf('timeout: 600000') < p.indexOf('4. `gh pr create'), 'timeout 指定が手順 4 より前（手順 3）に無い');
});

// ---- prPhasePrompt の push 出力末尾（issue #819） ----

test('[pr-artifacts] prompt: 手順 3 は pr-push に push log を渡し、failure_reason は PUSH_TAIL マーカー間の行を verbatim、マーカーが揃わなければ固定文言にして推測させない', () => {
  const p = prPhasePrompt({ wt: '/w', base: 'main', branch: 'b', repo: 'o/r', issue: 1, commitMessage: 'x (#1)\n', prBody: 'y' });
  const step3 = p.split('\n').find((l) => l.startsWith('3. `pr-push '));
  assert.ok(step3, `手順 3 の push 行が無い: ${p}`);
  // push log は .devflow-tmp/ 配下（ephemeral。realized-diff から除外される）
  assert.equal(prPushLogPath('/w'), `/w/.devflow-tmp/${PR_PUSH_LOG_NAME}`);
  assert.ok(step3.startsWith('3. `pr-push /w/.devflow-tmp/push-output.log`'), step3);
  // push は bare `git push` 単文として実行させない（出力が tool 上限で切れて末尾が見えない）
  assert.ok(!p.split('\n').some((l) => /^\d+\. `git push/.test(l)), 'bare git push を手順として実行させている');
  // (a) マーカーが揃えば間の行を verbatim
  assert.ok(step3.includes(`(a) 出力に \`${PR_PUSH_TAIL_BEGIN}\` と \`${PR_PUSH_TAIL_END}\` が両方見えるなら、その間の行を一字一句そのまま`), step3);
  // (b) マーカーが揃わなければ固定文言
  assert.equal(PR_PUSH_TAIL_UNAVAILABLE, 'push failed; output tail not available (tool output truncated)');
  assert.ok(step3.includes(`(b) 両マーカーが揃って見えない（出力が途中で切れた・コマンドが起動しなかった等）なら \`"${PR_PUSH_TAIL_UNAVAILABLE}"\` を一字一句そのまま入れる`), step3);
  // マーカーの外から理由を推測・要約させない
  assert.ok(step3.includes('マーカーの外にある出力（hook の途中経過等）から理由を推測・要約して書かない'), step3);
  // マーカー定数は pr-push.sh が出す行と一致する（script 側と prompt 側のずれ防止）
  const script = readFileSync(join(here, '..', 'dev-flow', 'scripts', 'pr-push.sh'), 'utf8');
  assert.ok(script.includes(`echo "${PR_PUSH_TAIL_BEGIN}"`) && script.includes(`echo "${PR_PUSH_TAIL_END}"`), 'pr-push.sh のマーカーが定数と一致しない');
  assert.ok(script.includes('git push -u origin HEAD'), 'pr-push.sh が git push -u origin HEAD を実行しない');
});

test('[pr-artifacts] prPhaseFailure: step:push なら pushLog のパスをエラー文に載せ、他の step・pushLog 未指定では載せない', () => {
  const pushLog = prPushLogPath('/wt');
  const pushFail = { pr_url: '', pr_number: 0, committed: true, failed_step: 'push', failure_reason: PR_PUSH_TAIL_UNAVAILABLE };
  const msg = prPhaseFailure(pushFail, { pushLog });
  assert.ok(msg.includes(`step: push、reason: ${PR_PUSH_TAIL_UNAVAILABLE}、push 出力全文: /wt/.devflow-tmp/push-output.log）`), msg);
  assert.ok(!prPhaseFailure({ ...pushFail, failed_step: 'commit' }, { pushLog }).includes('push 出力全文'));
  assert.ok(!prPhaseFailure({ ...pushFail, failed_step: 'pr-create' }, { pushLog }).includes('push 出力全文'));
  assert.ok(!prPhaseFailure(pushFail).includes('push 出力全文'));
  assert.equal(prPhaseFailure({ pr_url: 'http://x/pull/1', pr_number: 1, committed: true }, { pushLog }), null);
});

// ---- prPhasePrompt の cwd branch 照合（issue #700） ----

test('[pr-artifacts] prompt: 手順 0 で git rev-parse --abbrev-ref HEAD を branch と照合し、不一致なら git add 等を実行せず failed_step:"commit" で中断する', () => {
  const p = prPhasePrompt({ wt: '/w', base: 'main', branch: 'feature/issue-642', repo: 'o/r', issue: 642, commitMessage: 'x (#642)\n', prBody: 'y' });
  assert.ok(p.includes('`git rev-parse --abbrev-ref HEAD`'), '手順 0 の branch 確認コマンドが無い');
  assert.ok(p.includes('手順 0'), '手順 0 として明示されていない');
  assert.ok(p.includes('が `feature/issue-642` と一致するか確認する'), 'branch と照合する指示が無い');
  assert.ok(p.includes('git add 等の後続手順を一切実行せず、failed_step:"commit"'), '不一致時に後続手順を実行せず中断する指示が無い');
  assert.ok(p.includes('cwd branch mismatch: expected feature/issue-642'), 'failure_reason に cwd branch mismatch の内容が無い');
  assert.ok(p.includes('（pr_url は空文字、pr_number は 0、committed は false、head_sha は空文字）'), '不一致中断時の戻り値が明示されていない');
  // 手順 0 の branch 確認は手順 1（git add）より前に置かれる
  assert.ok(p.indexOf('git rev-parse --abbrev-ref HEAD') < p.indexOf('`git add -A`'), '手順 0 は手順 1（git add）より前に無ければならない');
});

test('[pr-artifacts] prPhaseFailure: 成功応答（committed:true・pr_url 非空・pr_number 正）は null', () => {
  assert.equal(prPhaseFailure({ pr_url: 'http://x/pull/1', pr_number: 1, committed: true }), null);
  assert.equal(prPhaseFailure({ pr_url: 'http://x/pull/7', pr_number: '7', committed: true, failed_step: '', failure_reason: '' }), null);
});

test('[pr-artifacts] prPhaseFailure: committed:false / pr_url 空 / pr_number 非正のいずれかで失敗文を返し step・reason・生の 3 値を含む', () => {
  const reason = "fatal: Unable to create '.git/index.lock': Operation not permitted";
  const msg = prPhaseFailure({ pr_url: '', pr_number: 0, committed: false, failed_step: 'commit', failure_reason: reason });
  assert.ok(msg.startsWith('dev-flow: PR phase 失敗（step: commit、reason: ' + reason + '）'), msg);
  assert.ok(msg.includes('pr_url=""') && msg.includes('pr_number=0') && msg.includes('committed=false'), msg);
  // 個別条件: どれか 1 つでも fail-closed
  assert.ok(prPhaseFailure({ pr_url: 'http://x/pull/1', pr_number: 1, committed: false, failed_step: 'push', failure_reason: 'remote: 403' }).includes('step: push、reason: remote: 403'));
  assert.ok(prPhaseFailure({ pr_url: '', pr_number: 1, committed: true, failed_step: 'pr-create', failure_reason: 'GraphQL: base branch not found' }).includes('step: pr-create、reason: GraphQL: base branch not found'));
  assert.ok(prPhaseFailure({ pr_url: 'http://x/pull/1', pr_number: 0, committed: true }) !== null);
  assert.ok(prPhaseFailure({ pr_url: 'http://x/pull/1', pr_number: 'abc', committed: true }) !== null);
  assert.ok(prPhaseFailure({ pr_url: 'http://x/pull/1', pr_number: 1.5, committed: true }) !== null);
});

test('[pr-artifacts] prPhaseFailure: failed_step 欠落 / enum 外は step: unknown、failure_reason 欠落は未報告と明記する', () => {
  const msg = prPhaseFailure({ pr_url: '', pr_number: 0, committed: false });
  assert.ok(msg.includes('step: unknown'), msg);
  assert.ok(msg.includes('reason: （proxy が failure_reason を返さず）'), msg);
  assert.ok(prPhaseFailure({ pr_url: '', pr_number: 0, committed: false, failed_step: 'add', failure_reason: 'x' }).includes('step: unknown、reason: x'));
  assert.deepEqual(PR_FAILED_STEP_VALUES, ['commit', 'push', 'pr-create']);
});

// ---- PR phase 失敗の failure 終端（issue #823）: workflow は throw せず、facts を返り値に載せる ----

test('[pr-artifacts] prompt: 中断時の head_sha は committed:true なら手順 6 の git rev-parse HEAD だけを実行して返す', () => {
  const p = prPhasePrompt({ wt: '/w', base: 'main', branch: 'b', repo: 'o/r', issue: 1, commitMessage: 'x (#1)\n', prBody: 'y' });
  assert.ok(p.includes('head_sha は committed が true なら手順 6 の `git rev-parse HEAD` だけを実行してその stdout・それ以外は空文字'), p);
});

test('[pr-artifacts] prPhaseFailureFacts: 成功は null、失敗は failed_step / failure_reason / committed と取れた head_sha・push log だけを返す', () => {
  assert.equal(prPhaseFailureFacts({ pr_url: 'http://x/pull/1', pr_number: 1, committed: true }), null);
  const pushLog = prPushLogPath('/wt');
  const push = prPhaseFailureFacts({ pr_url: '', pr_number: 0, committed: true, head_sha: ' abc123 ', failed_step: 'push', failure_reason: 'remote: 403\n' }, { pushLog });
  assert.deepEqual(push, { failed_step: 'push', failure_reason: 'remote: 403', committed: true, head_sha: 'abc123', push_log: '/wt/.devflow-tmp/push-output.log' });
  // head_sha が空・step が push 以外なら head_sha / push_log キー自体を持たない
  const commit = prPhaseFailureFacts({ pr_url: '', pr_number: 0, committed: false, head_sha: '', failed_step: 'commit', failure_reason: 'x' }, { pushLog });
  assert.deepEqual(commit, { failed_step: 'commit', failure_reason: 'x', committed: false });
  // committed 欠落は false（commit 済みと推測しない）、step 欠落は unknown
  assert.deepEqual(prPhaseFailureFacts({ pr_url: '', pr_number: 0 }), { failed_step: 'unknown', failure_reason: '（proxy が failure_reason を返さず）', committed: false });
  assert.equal(PR_PHASE_FAILED_CATEGORY, 'pr_phase_failed');
});

test('[pr-artifacts] prPhaseRecoveryCommands: committed と失敗段に応じて保存済みの .devflow-tmp の本文を使う回収コマンドだけを返す', () => {
  const common = { base: 'main', branch: 'feature/issue-9', repo: 'o/r', commitMessage: 'fix(x): "q" (#9)\n\nbody' };
  const create = 'gh pr create --draft --body-file .devflow-tmp/pr-body.md --repo o/r --base main --head feature/issue-9 --title "fix(x): \\"q\\" (#9)"';
  assert.deepEqual(prPhaseRecoveryCommands({ ...common, committed: false, failedStep: 'commit' }),
    ['git add -A', 'git commit -F .devflow-tmp/commit-msg.txt', 'git push -u origin HEAD', create, '/pr-iterate <N>']);
  assert.deepEqual(prPhaseRecoveryCommands({ ...common, committed: true, failedStep: 'push' }),
    ['git push -u origin HEAD', create, '/pr-iterate <N>']);
  // pr-create で落ちた run は push 済み
  assert.deepEqual(prPhaseRecoveryCommands({ ...common, committed: true, failedStep: 'pr-create' }), [create, '/pr-iterate <N>']);
  // 段が不明なら push を飛ばさない（再 push は up-to-date で終わる）
  assert.equal(prPhaseRecoveryCommands({ ...common, committed: true, failedStep: 'unknown' })[0], 'git push -u origin HEAD');
  // repo 不明なら --repo を付けない
  assert.ok(!prPhaseRecoveryCommands({ ...common, repo: null, committed: true, failedStep: 'push' })[1].includes('--repo'));
});

test('[pr-artifacts] prPhaseFailureComment: 失敗段・理由・commit 状態・branch・worktree・push log・回収コマンドを載せ、理由中の fence に負けない', () => {
  const facts = { failed_step: 'push', failure_reason: 'hook said ```boom```', committed: true, head_sha: 'f'.repeat(40), push_log: '/wt/.devflow-tmp/push-output.log' };
  const commands = prPhaseRecoveryCommands({ committed: true, failedStep: 'push', base: 'main', branch: 'feature/issue-9', repo: 'o/r', commitMessage: 't (#9)' });
  const body = prPhaseFailureComment({ worktree: '/wt', branch: 'feature/issue-9', facts, commands });
  for (const s of ['step: push', '`push`', '`feature/issue-9`', '`/wt`', '/wt/.devflow-tmp/push-output.log', 'f'.repeat(40), ...commands, '再生成しない']) {
    assert.ok(body.includes(s), `comment に '${s}' が無い:\n${body}`);
  }
  assert.ok(body.includes('````\nhook said ```boom```\n````'), `理由が内側の backtick より長い fence で囲まれていない:\n${body}`);
  const uncommitted = prPhaseFailureComment({ worktree: '/wt', branch: 'b', facts: { failed_step: 'commit', failure_reason: 'x', committed: false }, commands: ['git add -A'] });
  assert.ok(uncommitted.includes('commit: 未'), uncommitted);
  assert.ok(!uncommitted.includes('push 出力全文'), uncommitted);
});

// ---- (g) prBodyEditPrompt ----

test('[pr-artifacts] prBodyEditPrompt: gh pr edit --body-file を指示し、本文を delimiter で verbatim 転写させる', () => {
  const p = prBodyEditPrompt({ wt: '/w', pr: 5, repo: 'o/r', prBody: 'my body\nClose #5', fileName: 'pr-body-final.md' });
  assert.ok(p.includes('gh pr edit 5 --repo o/r --body-file /w/.devflow-tmp/pr-body-final.md'), p);
  assert.ok(p.includes('<<<PR_BODY_BEGIN>>>\nmy body\nClose #5<<<PR_BODY_END>>>'), p);
  assert.ok(p.includes('edited'), p);
});

// ---- (h) 決定論・throw しない ----

test('[pr-artifacts] prBodyEditPrompt: 同一入力 → 同一出力（決定論）', () => {
  const e = { wt: '/w', pr: 5, repo: 'o/r', prBody: 'x', fileName: 'f.md' };
  assert.equal(prBodyEditPrompt(e), prBodyEditPrompt(structuredClone(e)));
});

test('[pr-artifacts] verifyPrBody / hasClosesLine: null / undefined 入力で throw しない', () => {
  assert.doesNotThrow(() => hasClosesLine(null, 1));
  assert.doesNotThrow(() => hasClosesLine(undefined, 1));
  assert.doesNotThrow(() => verifyPrBody(null, 1));
  assert.doesNotThrow(() => verifyPrBody(undefined, 1));
});

// ---- dev-flow.js 配線（VM routing）----
// PR phase の spawn が dev-runner-haiku で、prompt に workflow 側で確定した commit message / PR body
// 本文（同じ state から buildCommitMessage / buildPrBody で再構築したもの）が verbatim で含まれることを
// dev-flow.js を VM 実行して観測する（issue #642）。
// NOTE (issue #661 / F1): この routing test は dev-flow.js の inline 区間を F3 が
// tools/sync-inlines.mjs --write で再生成するまで red のままでよい（本 task では inline 再生成しない）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

test('[pr-artifacts] dev-flow.js: pr#<issue> は dev-runner-haiku へ routing され、prompt に commit message / PR body 本文が verbatim で含まれる', async () => {
  // REQ は args.setup.analyze（prerun の analyze 段）から buildReqFromContract が組む。pr-artifacts が読む
  // キー（issue_type / acceptance_criteria / issue_title）を同じ値で持つ REQ 相当を期待値の組み立てに使う。
  const analyzeOverrides = { acceptance_criteria: ['AC one', 'AC two'], issue_type: 'refactor' };
  const a = prerunAnalyze(analyzeOverrides);
  const analyze = { summary: `Issue #1: ${a.issue_title}`, acceptance_criteria: a.acceptance_criteria, issue_type: a.issue_type, scope: a.scope, issue_number: 1, issue_title: a.issue_title };
  // 合成 plan（issue #673）: summary = issue title、単一 task issue-1。file_changes は dev-implementer の
  // 返却 files（既定 responder: src/x.ts）を adoptReportedFiles が取り込んだ後の形で pr-artifacts に渡る。
  const planStub = {
    summary: 'stub-issue-title',
    serial: [{ id: 'issue-1', desc: 'stub-issue-title', file_changes: ['src/x.ts'], test_plan: '', depends_on: [], agent: 'dev-implementer' }],
  };
  const { ctx, calls } = makeDevFlowSandbox({ extra: { args: analyzeArgs(1, analyzeOverrides) } });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'pr-artifacts routing');
  assert.equal(error, null, `dev-flow run が throw した: ${error?.message}`);

  const pr = calls.find((c) => c.label === 'pr#1');
  assert.ok(pr, "label 'pr#1' の agent() 呼び出しが観測されない");
  assert.equal(pr.agentType, 'dev-flow:dev-runner-haiku');

  const commitMessage = buildCommitMessage({ issue: 1, req: analyze, plan: planStub });
  assert.ok(pr.prompt.includes(`<<<COMMIT_MSG_BEGIN>>>\n${commitMessage}<<<COMMIT_MSG_END>>>`), `commit message 本文が verbatim で含まれない:\n${pr.prompt}`);
  assert.ok(pr.prompt.includes('<<<PR_BODY_BEGIN>>>\n**stub-issue-title**\n'), 'PR body 本文（結論1行）が verbatim で含まれない');
  assert.ok(pr.prompt.includes('- [ ] AC one\n- [ ] AC two') || pr.prompt.includes('- [x] AC one\n- [x] AC two'), 'PR body の受入条件 checkbox が含まれない');
  assert.ok(pr.prompt.includes('Closes #1\n<<<PR_BODY_END>>>'), 'PR body が Closes #1 で終わらない');
  assert.ok(pr.prompt.includes('`git commit -F /tmp/wt/.devflow-tmp/commit-msg.txt`'), 'commit -F 指示が無い');
  assert.ok(pr.prompt.includes('gh pr create') && pr.prompt.includes('--draft --base main --head feature/issue-1'), 'gh pr create の draft/base/head 指示が無い');
  assert.ok(!pr.prompt.includes('Skill: git-commit') && !pr.prompt.includes('Skill: git-pr'), 'git-commit / git-pr skill を呼んではならない');
});

test('[pr-artifacts] dev-flow.js: IMPL schema の pr_sections は heading / markdown 必須で maxLength が PR_SECTION_HEADING_MAX / PR_SECTIONS_MAX_CHARS と同値', () => {
  const m = devFlowSrc.match(/\n {4}pr_sections: \{\n[\s\S]*?\n {4}\},\n/);
  assert.ok(m, 'IMPL schema に pr_sections が無い');
  assert.match(m[0], /required: \['heading', 'markdown'\]/);
  assert.ok(m[0].includes(`heading: { type: 'string', maxLength: ${PR_SECTION_HEADING_MAX} }`), m[0]);
  assert.ok(m[0].includes(`markdown: { type: 'string', maxLength: ${PR_SECTIONS_MAX_CHARS} }`), m[0]);
});

// ---- issue #830: design_decisions / pr_notes / out_of_scope は schema の maxLength で書き手に収めさせ、builder は切らない ----

// IMPL schema（dev-flow.js）の 1 行要約欄の maxLength を読む。
const implSchemaSrc = (() => {
  const start = devFlowSrc.indexOf('\nconst IMPL = {');
  assert.ok(start >= 0, 'dev-flow.js に IMPL schema が無い');
  return devFlowSrc.slice(start, devFlowSrc.indexOf('\n}\n', start));
})();
function implMaxLength(re, what) {
  const m = implSchemaSrc.match(re);
  assert.ok(m, `IMPL schema の ${what} に maxLength が無い`);
  return Number(m[1]);
}
const IMPL_MAX = {
  title: implMaxLength(/\btitle: \{ type: 'string', maxLength: (\d+) \}/, 'design_decisions[].title'),
  rationale: implMaxLength(/\brationale: \{ type: 'string', maxLength: (\d+) \}/, 'design_decisions[].rationale'),
  note: implMaxLength(/\btext: \{ type: 'string', maxLength: (\d+) \}/, 'pr_notes[].text'),
  outOfScope: implMaxLength(/\bout_of_scope: \{ type: 'array', items: \{ type: 'string', maxLength: (\d+) \} \}/, 'out_of_scope[]'),
};

// builder が各欄に付ける区切りの字数（`- 決定 — 理由` / `- 検証: 本文` / `- 本文`）を本文の実出力から測る。
// 区切りを変えれば測り直されるので、不変条件は builder の実装と schema の両方に追従する。
function prBodyLineOverheads() {
  const adopted = adoptImplPrNotes({ serial: [] }, [{
    design_decisions: [{ title: '甲', rationale: '乙' }],
    pr_notes: PR_NOTE_SECTIONS.map((section, i) => ({ section, text: `丙${i}` })),
    out_of_scope: ['丁'],
  }]);
  const lines = buildPrBody({ issue: 1, req: req(), plan: adopted, ledger: ledger(), testsurfHits: [], dangerHits: [] }).split('\n');
  const len = (marker) => Array.from(lines.find((l) => l.includes(marker))).length;
  return {
    decision: len('甲') - 2,
    note: Math.max(...PR_NOTE_SECTIONS.map((_, i) => len(`丙${i}`) - 2)),
    outOfScope: len('丁') - 1,
  };
}

test('[pr-artifacts] dev-flow.js: IMPL schema の design_decisions / pr_notes / out_of_scope の maxLength + 区切りは clip 上限以下', () => {
  const sep = prBodyLineOverheads();
  assert.ok(sep.decision > 0 && sep.note > 0 && sep.outOfScope > 0, `区切りを測れない: ${JSON.stringify(sep)}`);
  assert.ok(IMPL_MAX.title + IMPL_MAX.rationale + sep.decision <= PR_BODY_DECISION_MAX,
    `design_decisions: title ${IMPL_MAX.title} + rationale ${IMPL_MAX.rationale} + 区切り ${sep.decision} > PR_BODY_DECISION_MAX ${PR_BODY_DECISION_MAX}`);
  assert.ok(IMPL_MAX.note + sep.note <= PR_BODY_NOTE_MAX,
    `pr_notes: text ${IMPL_MAX.note} + 区切り ${sep.note} > PR_BODY_NOTE_MAX ${PR_BODY_NOTE_MAX}`);
  assert.ok(IMPL_MAX.outOfScope + sep.outOfScope <= PR_BODY_OUT_OF_SCOPE_ITEM_MAX,
    `out_of_scope: item ${IMPL_MAX.outOfScope} + 区切り ${sep.outOfScope} > PR_BODY_OUT_OF_SCOPE_ITEM_MAX ${PR_BODY_OUT_OF_SCOPE_ITEM_MAX}`);
});

test('[pr-artifacts] PR body: schema の maxLength いっぱいの design_decisions / pr_notes / out_of_scope は 1 行も clip しない', () => {
  // code point で数えることも確かめるため、多バイト文字と ASCII を混ぜる
  const fill = (n, c) => Array.from({ length: n }, (_, i) => (i % 2 ? c : 'あ')).join('');
  const adopted = adoptImplPrNotes({ summary: 's', serial: [] }, [{
    status: 'DONE', task_id: 'issue-830',
    design_decisions: Array.from({ length: PR_BODY_DECISIONS_MAX }, () => ({ title: fill(IMPL_MAX.title, 't'), rationale: fill(IMPL_MAX.rationale, 'r') })),
    pr_notes: Array.from({ length: PR_BODY_NOTES_MAX }, (_, i) => ({ section: PR_NOTE_SECTIONS[i % PR_NOTE_SECTIONS.length], text: fill(IMPL_MAX.note, String(i)) })),
    out_of_scope: Array.from({ length: PR_BODY_OUT_OF_SCOPE_MAX }, (_, i) => fill(IMPL_MAX.outOfScope, String(i))),
  }]);
  const body = buildPrBody({ issue: 830, req: req(), plan: adopted, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  assert.ok(!body.includes('…'), `上限内の入力が切られた:\n${body.split('\n').filter((l) => l.includes('…')).join('\n')}`);
  const report = prBodyClipReport(adopted);
  assert.equal(report.decision, 0);
  assert.equal(report.note, 0);
  for (const d of adopted.architecture_decisions) assert.ok(body.includes(`- ${d.decision} — ${d.rationale}\n`), d.decision);
  for (const n of adopted.pr_notes) assert.ok(body.includes(`: ${n.text}\n`), n.text);
  for (const o of adopted.out_of_scope) assert.ok(body.includes(`- ${o}\n`), o);
});

test('[pr-artifacts] PR body: schema を外れた長さの入力は builder が backstop として「…」に切る', () => {
  const p = plan({
    architecture_decisions: [{ decision: 'd'.repeat(IMPL_MAX.title + 1), rationale: 'r'.repeat(PR_BODY_DECISION_MAX) }],
    pr_notes: [{ section: 'verification', text: 'n'.repeat(PR_BODY_NOTE_MAX) }],
    out_of_scope: ['o'.repeat(PR_BODY_OUT_OF_SCOPE_ITEM_MAX)],
  });
  const body = buildPrBody({ issue: 1, req: req(), plan: p, ledger: ledger(), testsurfHits: [], dangerHits: [] });
  const lineOf = (c) => body.split('\n').find((l) => l.includes(c.repeat(10)));
  assert.equal(Array.from(lineOf('d')).length, PR_BODY_DECISION_MAX);
  assert.ok(lineOf('d').endsWith('…'));
  assert.equal(Array.from(lineOf('n')).length, PR_BODY_NOTE_MAX);
  assert.ok(lineOf('n').endsWith('…'));
  assert.equal(Array.from(lineOf('o')).length, PR_BODY_OUT_OF_SCOPE_ITEM_MAX);
  assert.ok(lineOf('o').endsWith('…'));
  assert.deepEqual({ note: prBodyClipReport(p).note, decision: prBodyClipReport(p).decision }, { note: 1, decision: 1 });
});

test('[pr-artifacts] agents/dev-implementer.md: design_decisions / pr_notes / out_of_scope の字数の説明は IMPL schema の maxLength と一致', () => {
  const md = readFileSync(join(here, '..', 'agents', 'dev-implementer.md'), 'utf8');
  assert.ok(md.includes(`\`pr_notes[].text\` は ${IMPL_MAX.note} 字`), 'pr_notes の字数');
  assert.ok(md.includes(`\`title\` ${IMPL_MAX.title} 字・\`rationale\` ${IMPL_MAX.rationale} 字`), 'design_decisions の字数');
  assert.ok(md.includes(`\`out_of_scope\` は 1 項目 ${IMPL_MAX.outOfScope} 字まで`), 'out_of_scope の字数');
  const example = md.slice(md.indexOf('```json'), md.indexOf('```', md.indexOf('```json') + 7));
  assert.ok(example.includes(`決定（${IMPL_MAX.title} 字以内）`) && example.includes(`その理由（${IMPL_MAX.rationale} 字以内）`), example);
  assert.ok(example.includes(`${IMPL_MAX.note} 字以内）`), example);
  assert.ok(example.includes(`1 項目 1 文・${IMPL_MAX.outOfScope} 字以内）`), example);
  // clip 上限（PR 本文で切られる幅）を書き手の上限として案内しない
  assert.ok(!md.includes(`${PR_BODY_NOTE_MAX} 字`) && !md.includes(`${PR_BODY_DECISION_MAX} 字`), '古い clip 上限の字数が残っている');
});
