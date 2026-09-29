// _lib/ac-actor.test.mjs
// AC の actor 分類（agent / human）と、ac_results の actor 別集計・差し戻し用 fix_feedback の pin（issue #747）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AC_ACTORS, AGENT_AC_REIMPL_MAX, classifyAcActor, acActorsOf, unsatisfiedAcByActor, agentAcFeedback } from './ac-actor.mjs';

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
