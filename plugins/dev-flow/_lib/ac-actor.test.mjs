// _lib/ac-actor.test.mjs
// AC の actor 分類（agent / human）と、ac_results の actor 別集計・差し戻し用 fix_feedback の pin（issue #747）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AC_ACTORS, AC_SCOPES, AGENT_AC_REIMPL_MAX, classifyAcActor, acActorsOf, unsatisfiedAcByActor, agentAcFeedback, classifyAcScope, mixedScopeAcReasons, isObservationalAc, acObservationalOf, deterministicAcIndexes, demoteUnprovenObservationalAc } from './ac-actor.mjs';

// repo 内外が混ざった AC（テスト・README・rules の削除と dotfiles の excludedCommands の変更を 1 つに書いたもの）
const MIXED_AC = '古い skill を参照するテスト・README・rules を削除し、dotfiles の excludedCommands から dev-flow-doctor を外す';
// repo 外の作業だけを書いた AC
const EXTERNAL_AC = 'dotfiles の `claude-code/settings.json` の excludedCommands に dev-flow-health の起動形を足す';

test('[ac-actor] 「ローカルで測って PR 本文に書く」型の AC は agent', () => {
  assert.equal(classifyAcActor('512Mi で、想定する同時生成数の worker を持てることをローカルで測り、PR 本文に書く'), 'agent');
  assert.equal(classifyAcActor('Merge tier の HOLD 理由で、人手 AC 待ちとエージェント AC 未達を区別できる'), 'agent');
});

test('[ac-actor] （人手）表記・staging・本番・外部サービス・issue へのコメントは human', () => {
  for (const ac of [
    'staging で実測する（人手）',
    'Cloud Run の設定値を確認する(人手)',
    'staging にデプロイして動作確認する',
    'ステージング環境で 1 回生成する',
    '本番環境の worker 数を 4 に変更する',
    'production 環境で flag を有効にする',
    '外部サービスの Webhook 設定を更新する',
    '結果を issue にコメントする',
    '計測値を issue へのコメントで共有する',
  ]) assert.equal(classifyAcActor(ac), 'human', ac);
});

test('[ac-actor] inline code で引用しただけの `（人手）` は human にしない', () => {
  assert.equal(classifyAcActor('`（人手）` と書かれた AC だけが未達の場合は、差し戻さずに HOLD（人手待ち）になる'), 'agent');
  assert.equal(classifyAcActor('`staging` ラベルの付いた PR を skip する'), 'agent');
});

test('[ac-actor] 空・非文字列は agent（判定できない AC は差し戻し側に倒す）', () => {
  assert.equal(classifyAcActor(''), 'agent');
  assert.equal(classifyAcActor(null), 'agent');
  assert.deepEqual(AC_ACTORS, ['agent', 'human']);
  assert.ok(Number.isInteger(AGENT_AC_REIMPL_MAX) && AGENT_AC_REIMPL_MAX >= 1);
});

test('[ac-actor] acActorsOf は index 順に actor を返す（非配列は空）', () => {
  assert.deepEqual(acActorsOf(['ローカルで測る', 'staging で確認する（人手）']), ['agent', 'human']);
  assert.deepEqual(acActorsOf(undefined), []);
});

test('[ac-actor] unsatisfiedAcByActor: satisfied:false だけを actor 別に数え、範囲外・重複・不正 index は数えない', () => {
  const actors = ['agent', 'human', 'agent'];
  const r = unsatisfiedAcByActor([
    { ac_index: 0, satisfied: false },
    { ac_index: 1, satisfied: false },
    { ac_index: 2, satisfied: true },
    { ac_index: 0, satisfied: false },
    { ac_index: 7, satisfied: false },
    { ac_index: '1', satisfied: false },
    null,
  ], actors);
  assert.deepEqual(r, { agent: [0], human: [1] });
  assert.deepEqual(unsatisfiedAcByActor(null, actors), { agent: [], human: [] });
});

test('[ac-actor] agentAcFeedback: evaluator feedback と同じ形で AC 番号・本文・根拠と PR 本文の返し方を渡す', () => {
  const fb = agentAcFeedback([0], ['ローカルで測り PR 本文に書く'], [{ ac_index: 0, satisfied: false, evidence: 'コードのコメントにだけ記載' }]);
  assert.equal(fb.length, 1);
  assert.equal(fb[0].severity, 'major');
  assert.equal(fb[0].topic, 'AC-1 未達');
  assert.match(fb[0].description, /AC-1「ローカルで測り PR 本文に書く」/);
  assert.match(fb[0].description, /コードのコメントにだけ記載/);
  assert.match(fb[0].suggestion, /pr_notes/);
  assert.match(fb[0].suggestion, /design_decisions/);
  assert.match(agentAcFeedback([0], ['x'], [])[0].description, /根拠なし/);
});

test('[ac-scope] repo 外の目印と repo 内の目印が 1 つの AC にあれば mixed、repo 外だけなら external、どちらも無ければ repo', () => {
  assert.deepEqual(AC_SCOPES, ['repo', 'external', 'mixed']);
  assert.equal(classifyAcScope(MIXED_AC), 'mixed');
  assert.equal(classifyAcScope(EXTERNAL_AC), 'external');
  assert.equal(classifyAcScope('worker 数の上限を設定で変えられる'), 'repo');
  for (const ac of [
    'plugins/dev-flow/_lib/a.mjs を直し、~/.claude/settings.json の allow にも足す',
    'vitest を green にし、別 repo の CI 設定も更新する',
    'README に手順を書き、settings.local.json の deny を外す',
  ]) assert.equal(classifyAcScope(ac), 'mixed', ac);
  for (const ac of [
    '`~/.claude/settings.json` の allow に bin を足す',
    '他のリポジトリの workflow を更新する',
    'dotfiles に worktree を作って excludedCommands を直す',
  ]) assert.equal(classifyAcScope(ac), 'external', ac);
});

test('[ac-scope] 他 repo の参照は対象 repo と違うときだけ repo 外（repo 省略時は判定しない）', () => {
  const repo = 'it-all-playpark/skills';
  assert.equal(classifyAcScope('acme/infra#206 の設定を入れる', { repo }), 'external');
  assert.equal(classifyAcScope('https://github.com/acme/infra の設定を入れ、テストを足す', { repo }), 'mixed');
  assert.equal(classifyAcScope('It-All-Playpark/Skills#786 の再発をテストで防ぐ', { repo }), 'repo');
  assert.equal(classifyAcScope('acme/infra#206 の設定を入れる'), 'repo');
});

// 過去 issue の repo 内 AC（本文そのまま）。repo 外の語は否定・件数 0・不要・条件・理由の言及・grep 対象として
// 出てくるだけで、作業は repo 内で完結する。skills 絶対パスは bin-bare-name-routing.test.mjs の禁止パターンに
// かからないよう組み立てる。
const SKILLS_ABS = ['~/.claude', 'skills/'].join('/');
const PAST_REPO_ACS = {
  493: 'probe prompt / throw メッセージいずれにも sandbox・permission・excludedCommands・guard 名を理由として述べる記述が無いことを静的テストで pin する（`_lib/` の canonical と `.claude/workflows/*.js` の inline 双方を対象）',
  569: 'dev-flow の実行経路（`.claude/workflows/*.js`、`_lib/*.mjs`）に `' + SKILLS_ABS + '` 絶対パスが 0 箇所',
  606: '契約文の理由が「verbatim 転写の破壊」として書かれており、sandbox / excludedCommands を理由にしていない（`_lib/isolation-control-reason.test.mjs` が green）',
  637: 'wrapper script は `plugins/dev-flow/bin/` の bare 名で公開し、既存 exec-proxy と同じ起動形（先頭トークン = bare 名。cd / bash / node 前置なし）で呼ぶ。dotfiles 側 `sandbox.excludedCommands` への登録が必要なら PR 本文にその bare 名を明記する',
  640: '`tests/run-node-tests.sh` green、`bash tests/run-all-bats.sh` green。telemetry キー追加は受け側（skills）で完結する passthrough 経路のため dotfiles 側の変更は不要 — 変更が必要になった場合は PR 本文にその理由を書く',
  16: "`grep -r '~/.claude/skills' --include='*.md' --include='*.sh' --include='*.ts' --include='*.py'` がヒット 0件",
  570: '非 dev-flow skill の `.md` から `' + SKILLS_ABS + '` 絶対パス記述が 0 箇所',
  576: '`bug-hunt` / `code-audit-team` / `incident-response` の `allowed-tools` に `' + SKILLS_ABS + '` を含む行が 0 件で、`${CLAUDE_PLUGIN_ROOT}` 版のみが残っている',
};

test('[ac-scope] 過去 issue の repo 内 AC（否定・件数 0・不要・条件・理由の言及・grep 対象）は repo で、actor は agent', () => {
  const repo = 'it-all-playpark/skills';
  for (const [n, ac] of Object.entries(PAST_REPO_ACS)) {
    assert.equal(classifyAcScope(ac, { repo }), 'repo', `#${n}: ${ac}`);
    assert.equal(classifyAcActor(ac, { repo }), 'agent', `#${n}: ${ac}`);
  }
  assert.deepEqual(mixedScopeAcReasons(Object.values(PAST_REPO_ACS), { repo }), []);
});

test('[ac-scope] 否定の節にある目印だけを除き、同じ AC の別の節で repo 外を作業対象にしていれば数える', () => {
  assert.equal(classifyAcScope('dotfiles の settings.json は変更しない'), 'repo');
  assert.equal(classifyAcScope('テストを足し、dotfiles の excludedCommands は変更しない'), 'repo');
  assert.equal(classifyAcScope('README の `' + SKILLS_ABS + '` 記述を 0 箇所にし、dotfiles の excludedCommands に bare 名を足す'), 'mixed');
});

test('[ac-scope] 対象 repo が dotfiles のときは dotfiles / excludedCommands / settings.json を repo 内として扱う', () => {
  const repo = 'it-all-playpark/dotfiles';
  assert.equal(classifyAcScope('claude-code/settings.json の excludedCommands に bare 名を足し、bats テストを足す', { repo }), 'repo');
  assert.equal(classifyAcScope('dotfiles の README を更新する', { repo }), 'repo');
  assert.equal(classifyAcScope('claude-code/settings.json の excludedCommands に bare 名を足し、bats テストを足す', { repo: 'it-all-playpark/skills' }), 'mixed');
  assert.equal(classifyAcScope('~/.claude/settings.json の allow に bin を足す', { repo }), 'external', '~/.claude はどの repo の worktree でもない');
});

test('[ac-scope] （人手）と明記した AC は repo 内外が混ざっていても mixed にせず external（human）', () => {
  const ac = 'vitest を green にし、dotfiles の excludedCommands に bare 名を足す（人手）';
  assert.equal(classifyAcScope(ac), 'external');
  assert.equal(classifyAcActor(ac), 'human');
  assert.deepEqual(mixedScopeAcReasons([ac]), []);
  assert.equal(classifyAcScope('vitest を green にし、dotfiles の excludedCommands に `（人手）` を足す'), 'mixed', 'inline code の（人手）は明記に数えない');
});

test('[ac-actor] repo 外の作業だけを書いた AC は human（エージェント AC 未達に数えない）', () => {
  assert.equal(classifyAcActor(EXTERNAL_AC), 'human');
  assert.equal(classifyAcActor(MIXED_AC), 'agent', 'mixed は analyze ゲートで止めるので actor は agent のまま');
  const actors = acActorsOf(['worker 数の上限を設定で変えられる', EXTERNAL_AC]);
  assert.deepEqual(actors, ['agent', 'human']);
  assert.deepEqual(unsatisfiedAcByActor([{ ac_index: 1, satisfied: false }], actors), { agent: [], human: [1] });
  assert.deepEqual(acActorsOf(['acme/infra#206 の設定を入れる'], { repo: 'it-all-playpark/skills' }), ['human']);
});

test('[ac-scope] mixedScopeAcReasons: 混ざった AC だけを AC 番号・本文・repo 外の目印つきで 1 行ずつ返し、分割を求める', () => {
  const reasons = mixedScopeAcReasons(['worker 数の上限を設定で変えられる', MIXED_AC, EXTERNAL_AC]);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /^AC-2「/);
  assert.ok(reasons[0].includes(MIXED_AC));
  assert.match(reasons[0], /dotfiles \/ excludedCommands/);
  assert.match(reasons[0], /repo 内の AC と repo 外の AC に分割/);
  assert.deepEqual(mixedScopeAcReasons(['worker 数の上限を設定で変えられる', EXTERNAL_AC]), []);
  assert.deepEqual(mixedScopeAcReasons(undefined), []);
});

// 観測型 AC の分類規則 v2（issue #844）。過去 issue の AC 本文そのまま。
// positive control: inspection で達成扱いになり、実際に動かすと満たさなかった既知 9 issue の AC
const KNOWN_OBSERVATIONAL_ACS = {
  // 撤去済みキー名は removed-phase-invariant.test.mjs の (c) スキャンに掛かるため join で組み立てる
  '423-5': `AC-5: 変更前後で各 5 run 以上の A/B を実施し、\`${['plan', 'iter'].join('_')}\` / \`eval_iter\` / \`iterate_status\` / findings 件数 / \`duration_seconds\` の比較表が作成されている`,
  '431-4': '`error_category` / `error_msg` が失敗 run の journal entry に到達する',
  '431-5': 'pr-iterate 単体起動で `iterate_status` / `ci_wait_seconds` / `ci_poll_attempts` が記録される',
  '471-6': 'AC-6: receipt 欠落時に `trust_evalseal_missing_reason` が closed enum 値で journal telemetry の `telemetry` へ到達する（実 `journal.sh` との結合テストで確認）',
  '471-12': 'AC-12: 修正後の run で `missing_receipt.evalseal.rate` が修正前（1.0）と同一コマンドで比較可能な形で記録される',
  '476-1': 'AC-1: PR stage probe が receipt を生成できなかった run で、理由が closed enum 値として telemetry へ記録される',
  '476-8': 'AC-8: 修正後の実 run で `layer_status.effectdelta.stages` に `pr` が 1 件以上現れる（修正前 0 件と同一コマンドで比較可能）',
  '485-1': '実 dev-flow run（本 repo、AC を持つ PR）で redgreen-verify.sh の verdict_cmd 実行を直接検証し、fail_open の root cause（vitest sandbox EPERM 再発 / adapter 検出失敗 / .veridelta RunStore 非共有 等）を切り分けて特定する',
  '485-4': "修正後の直近 dev-flow run（min_runs>=5）で `analyze-dev-flow-telemetry.sh --window 30d` の vdelta_verdict fail_open rate が閾値0.5未満に低下していることを確認する（doctor anomaly 'vdelta_unhealthy' が再発火しない）",
  '491-6': 'AC-6: 修正後の run において `trust-receipts-report.sh --window 30d` の `missing_receipt.evalseal.reason_distribution` に `unrecorded` 以外の closed enum 値が現れる（実測。run 数が 0 の場合は本 AC を満たさないものとする）',
  '495-4': 'receipt の evidence が実行証跡ファイル由来であることを統合テストで検証する。evidence ファイルが欠落・不正な場合は receipt を発行せず `inconclusive` に倒す（成功扱いにしない）ことを含める',
  '526-1': 'dev-flow を1回流すと `~/.claude/journal/` に `*-dev-flow-*.json` が生成される',
  '526-3': 'pr-iterate 単体起動でも同様に記録される',
  '815-5': '長文欄を上限いっぱいにした本文で PR を作成し、closes-check が `verified` になる（転写で後半が落ちないことを少なくとも 1 run で実測）',
};
// negative control: 観測の語を含むが、否定形・文書の内容・定数の編集・コード構造・名詞の「実測」で、コード読みで確かめられる AC
const NON_OBSERVATIONAL_ACS = {
  '807-3': 'spawn の prompt に payload 以外の結論値・要約を載せない（classifier による journal-log ブロックの面を広げない）',
  '561-5': 'AC-5: `.claude/agents/evaluator.md` と `.claude/agents/pr-reviewer.md` に confidence の判定基準が記載され、verdict と独立に付ける旨が明記されている',
  '786-5': 'journal の prune で残す一覧（`PRUNE_KEEP_DEFAULT`）から doctor / improve を外す',
  '556-5': 'journal choreography が `_lib/journal-handoff.mjs` へ deps 注入形で canonical 化され、',
  'corporate-site#915-1': '`real-case-catalog.md` が存在し、実案件14本すべてに解法パターン・引用可能な実測値・実測セッション数が入っている',
};

test('[ac-observational] positive control: 既知 9 issue の AC は観測型で、actor は human', () => {
  const repo = 'it-all-playpark/skills';
  for (const [id, ac] of Object.entries(KNOWN_OBSERVATIONAL_ACS)) {
    assert.equal(isObservationalAc(ac), true, `#${id}: ${ac}`);
    assert.equal(classifyAcActor(ac, { repo }), 'human', `#${id}: ${ac}`);
  }
});

test('[ac-observational] negative control: 否定形・文書の内容・定数の編集・コード構造・名詞の「実測」は観測型にしない', () => {
  for (const [id, ac] of Object.entries(NON_OBSERVATIONAL_ACS)) {
    assert.equal(isObservationalAc(ac), false, `#${id}: ${ac}`);
  }
  assert.equal(classifyAcActor(NON_OBSERVATIONAL_ACS['807-3']), 'agent');
  assert.equal(classifyAcActor(NON_OBSERVATIONAL_ACS['786-5']), 'agent');
});

test('[ac-observational] 強い語は否定・言及の節でも発火し、OBS_STRONG_NEG（実測しない・計測不要）だけ外す', () => {
  assert.equal(isObservationalAc('変更前後で計測し、差分が記述されている'), true, '強い語は言及の節でも発火');
  assert.equal(isObservationalAc('計測を行い PR 本文に書く'), true);
  assert.equal(isObservationalAc('この変更は実測しない'), false);
  assert.equal(isObservationalAc('A/B は不要'), false);
  assert.equal(isObservationalAc('計測値を定数に持つ'), false, '「計測」が名詞（計測値）なら強い語にしない');
});

test('[ac-observational] 弱い語は否定・言及の節では発火せず、inline code と鉤括弧の引用の中は見ない', () => {
  assert.equal(isObservationalAc('run ごとに duration が journal に記録される'), true);
  assert.equal(isObservationalAc('journal に記録されないことを確かめる'), false, '否定の節');
  assert.equal(isObservationalAc('telemetry のキー名を変える'), false, '言及の節（キー名）');
  assert.equal(isObservationalAc('`journal` を引数に取る'), false, 'inline code の中');
  assert.equal(isObservationalAc('見出しを「計測する」から「確認」に変える'), false, '鉤括弧の引用の中');
  assert.equal(isObservationalAc(''), false);
  assert.equal(isObservationalAc(null), false);
  assert.deepEqual(acObservationalOf(['worker 数の上限を設定で変えられる', KNOWN_OBSERVATIONAL_ACS['526-3']]), [false, true]);
  assert.deepEqual(acObservationalOf(undefined), []);
});

test('[ac-observational] classifyAcActor: 観測型は既存の human 判定（（人手）・repo 外）の後、agent の前で human にする', () => {
  assert.equal(classifyAcActor('修正後の実 run で receipt が生成される'), 'human');
  assert.equal(classifyAcActor('staging で計測する（人手）'), 'human');
  assert.equal(classifyAcActor('worker 数の上限を設定で変えられる'), 'agent');
  // repo 内外が混ざった AC は観測型でなければ analyze ゲートに任せて agent のまま
  assert.equal(classifyAcActor(MIXED_AC), 'agent');
});

test('[ac-observational] deterministicAcIndexes: red→green 実証で deterministic 昇格して checked の AC-<n> だけを 0 始まりで返す', () => {
  assert.deepEqual(deterministicAcIndexes([
    { id: 'AC-1', checked: true, check: { kind: 'deterministic' } },
    { id: 'AC-2', checked: true, check: { kind: 'inspection' } },
    { id: 'AC-3', checked: false, check: { kind: 'deterministic' } },
    { id: 'AC-FINAL-4', checked: true, check: { kind: 'deterministic' } },
    { id: 'SEC-X', checked: true, check: { kind: 'deterministic' } },
    null,
  ]), [0]);
  assert.deepEqual(deterministicAcIndexes(undefined), []);
});

test('[ac-observational] demoteUnprovenObservationalAc: 実証の無い観測型 AC の satisfied:true を未達に倒し、実証済み・非観測型は変えない', () => {
  const results = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'コードを読んだ' },
    { ac_index: 1, satisfied: true, verified_by: 'test', evidence: 'test green' },
    { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 3, satisfied: false, verified_by: 'inspection', evidence: 'ng' },
  ];
  const out = demoteUnprovenObservationalAc(results, [true, true, false, true], [1]);
  assert.equal(out[0].satisfied, false);
  assert.equal(out[0].observational, true);
  assert.match(out[0].evidence, /観測型 AC/);
  assert.match(out[0].evidence, /コードを読んだ/);
  assert.equal(out[1], results[1], 'red→green 実証済みは変えない');
  assert.equal(out[2], results[2], '非観測型は変えない');
  assert.deepEqual(out[3], { ...results[3], observational: true });
  assert.equal(results[0].satisfied, true, '入力は書き換えない');
  assert.equal(demoteUnprovenObservationalAc(null, [true], []), null);
  // 倒した AC は actor human なので人手 AC 待ちに数え、差し戻し（agent）には数えない
  const actors = ['human', 'human', 'agent', 'human'];
  assert.deepEqual(unsatisfiedAcByActor(out, actors), { agent: [], human: [0, 3] });
});
