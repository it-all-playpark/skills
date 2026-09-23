import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildCommitMessage,
  buildPrBody,
  prPhasePrompt,
  clip,
  hasClosesLine,
  verifyPrBody,
  closesVerdict,
  prBodyViewPrompt,
  prBodyEditPrompt,
  prPhaseFailure,
  PR_FAILED_STEP_VALUES,
  PR_BODY_MAX_CHARS,
  PR_BODY_HEADINGS,
  PR_CLOSES_STATUS_VALUES,
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

// ---- (e) closesVerdict の 3 値 ----

test('[pr-artifacts] closesVerdict: 取得失敗/不正は unknown、有れば present、無ければ missing', () => {
  assert.equal(closesVerdict({ view: null, issue: 642 }), 'unknown');
  assert.equal(closesVerdict({ view: { ok: false }, issue: 642 }), 'unknown');
  assert.equal(closesVerdict({ view: { ok: true, body: 123 }, issue: 642 }), 'unknown');
  assert.equal(closesVerdict({ view: { ok: true, body: 'x\nCloses #642\n' }, issue: 642 }), 'present');
  assert.equal(closesVerdict({ view: { ok: true, body: 'x\ny\n' }, issue: 642 }), 'missing');
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
  assert.ok(p.includes('`git push -u origin HEAD`'), '手順 3 の push が bare 形でない');
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

// ---- (g) prBodyViewPrompt / prBodyEditPrompt ----

test('[pr-artifacts] prBodyViewPrompt: gh pr view --json body を bare 単文で指示し、repo null なら --repo を省略する', () => {
  const withRepo = prBodyViewPrompt({ pr: 5, repo: 'o/r' });
  assert.ok(withRepo.includes('gh pr view 5 --repo o/r --json body'), withRepo);
  const withoutRepo = prBodyViewPrompt({ pr: 5, repo: null });
  assert.ok(!withoutRepo.includes('--repo'), withoutRepo);
  assert.ok(withoutRepo.includes('gh pr view 5 --json body'), withoutRepo);
});

test('[pr-artifacts] prBodyEditPrompt: gh pr edit --body-file を指示し、本文を delimiter で verbatim 転写させる', () => {
  const p = prBodyEditPrompt({ wt: '/w', pr: 5, repo: 'o/r', prBody: 'my body\nClose #5', fileName: 'pr-body-final.md' });
  assert.ok(p.includes('gh pr edit 5 --repo o/r --body-file /w/.devflow-tmp/pr-body-final.md'), p);
  assert.ok(p.includes('<<<PR_BODY_BEGIN>>>\nmy body\nClose #5<<<PR_BODY_END>>>'), p);
  assert.ok(p.includes('edited'), p);
});

// ---- (h) 決定論・throw しない ----

test('[pr-artifacts] prBodyViewPrompt / prBodyEditPrompt: 同一入力 → 同一出力（決定論）', () => {
  const v = { pr: 5, repo: 'o/r' };
  assert.equal(prBodyViewPrompt(v), prBodyViewPrompt(structuredClone(v)));
  const e = { wt: '/w', pr: 5, repo: 'o/r', prBody: 'x', fileName: 'f.md' };
  assert.equal(prBodyEditPrompt(e), prBodyEditPrompt(structuredClone(e)));
});

test('[pr-artifacts] verifyPrBody / closesVerdict / hasClosesLine: null / undefined 入力で throw しない', () => {
  assert.doesNotThrow(() => hasClosesLine(null, 1));
  assert.doesNotThrow(() => hasClosesLine(undefined, 1));
  assert.doesNotThrow(() => verifyPrBody(null, 1));
  assert.doesNotThrow(() => verifyPrBody(undefined, 1));
  assert.doesNotThrow(() => closesVerdict({ view: undefined, issue: 1 }));
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
  // 合成 plan（issue #673）: summary = issue title、単一 task issue-1。file_changes は dev-implement-fable の
  // 返却 files（既定 responder: src/x.ts）を adoptReportedFiles が取り込んだ後の形で pr-artifacts に渡る。
  const planStub = {
    summary: 'stub-issue-title',
    serial: [{ id: 'issue-1', desc: 'stub-issue-title', file_changes: ['src/x.ts'], test_plan: '', depends_on: [], agent: 'dev-implement-fable' }],
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
