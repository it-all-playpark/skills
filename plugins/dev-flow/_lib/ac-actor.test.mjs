// _lib/ac-actor.test.mjs
// AC の actor 分類（agent / human）と、ac_results の actor 別集計・差し戻し用 fix_feedback の pin（issue #747）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AC_ACTORS, AC_SCOPES, AGENT_AC_REIMPL_MAX, classifyAcActor, acActorsOf, unsatisfiedAcByActor, agentAcFeedback, classifyAcScope, mixedScopeAcReasons } from './ac-actor.mjs';

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
