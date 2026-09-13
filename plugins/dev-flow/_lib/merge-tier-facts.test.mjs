import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseMergeTierFacts, isWellFormedRiskFact, mergeTierFactsTopLevelKeys, mergeTierFactsPrompt } from './merge-tier-facts.mjs';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function fullFacts() {
  return {
    diffhash: { ok: true, value: { hash: TREE, empty: false, epoch: 1 } },
    risk: { ok: true, value: { ok: true, hits: [{ file: 'a.js', class: 'exec-sink', severity: 'critical' }] } },
    changed: { ok: true, value: { files: ['src/x.ts', 'docs/a.md'] } },
    pr: { ok: true, value: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: SHA } },
    head_tree: { ok: true, value: { tree: TREE } },
    checks: { ok: true, value: { checks: [{ name: 'build', bucket: 'pass' }] } },
    epoch: 2,
  };
}

// (1) 全サブ結果正常 → 旧 6 spawn の個別形へそのまま写る
test('全サブ結果正常 → 各フィールドが旧 spawn の形で素通し', () => {
  const r = parseMergeTierFacts(fullFacts());
  assert.equal(r.mergeDiffHash, TREE);
  assert.deepEqual(r.risk, { ok: true, hits: [{ file: 'a.js', class: 'exec-sink', severity: 'critical' }] });
  assert.deepEqual(r.changedFiles, ['src/x.ts', 'docs/a.md']);
  assert.deepEqual(r.prMeta, { ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: SHA });
  assert.equal(r.headTreeOid, TREE);
  assert.deepEqual(r.checks, { ok: true, checks: [{ name: 'build', bucket: 'pass' }] });
});

// (2) null 入力 → risk fail-closed 合成、他は fail-open の既定値
test('null 入力 → risk fail-closed (hits=[])、他フィールドは null / ok:false', () => {
  const r = parseMergeTierFacts(null);
  assert.equal(r.mergeDiffHash, null);
  assert.equal(r.risk.ok, false);
  assert.deepEqual(r.risk.hits, []);
  assert.equal(typeof r.risk.error, 'string');
  assert.equal(r.changedFiles, null);
  assert.equal(r.prMeta.ok, false);
  assert.equal(typeof r.prMeta.error, 'string');
  assert.equal(r.headTreeOid, null);
  assert.equal(r.checks.ok, false);
  assert.equal(isWellFormedRiskFact(null), false);
  assert.equal(mergeTierFactsTopLevelKeys(null), 'null');
});

// (3) サブ結果独立性: 1 つを壊しても他は無傷（6 通り）
const BREAKERS = {
  diffhash: { ok: false, value: null, error: 'worktree-diff-hash.sh failed' },
  risk: { ok: false, value: null, error: 'no valid JSON' },
  changed: { ok: false, value: null, error: 'git diff failed' },
  pr: { ok: false, value: null, error: 'gh pr view failed' },
  head_tree: { ok: false, value: null, error: 'skipped: pr headRefOid unavailable' },
  checks: { ok: false, value: null, error: 'gh pr checks failed' },
};
const FIELD_OF = { diffhash: 'mergeDiffHash', risk: 'risk', changed: 'changedFiles', pr: 'prMeta', head_tree: 'headTreeOid', checks: 'checks' };

for (const [key, broken] of Object.entries(BREAKERS)) {
  test(`${key} だけ ok:false → ${FIELD_OF[key]} だけ既定値に倒れ、他 5 フィールドは正常値のまま`, () => {
    const facts = { ...fullFacts(), [key]: broken };
    const r = parseMergeTierFacts(facts);
    const good = parseMergeTierFacts(fullFacts());
    for (const [k, f] of Object.entries(FIELD_OF)) {
      if (k === key) continue;
      assert.deepEqual(r[f], good[f], `${f} が ${key} の失敗に巻き込まれた`);
    }
    switch (key) {
      case 'diffhash': assert.equal(r.mergeDiffHash, null); break;
      case 'risk':
        assert.deepEqual(r.risk, { ok: false, hits: [], error: 'no valid JSON' });
        assert.equal(isWellFormedRiskFact(facts), false);
        break;
      case 'changed': assert.equal(r.changedFiles, null); break;
      case 'pr': assert.deepEqual(r.prMeta, { ok: false, error: 'gh pr view failed' }); break;
      case 'head_tree': assert.equal(r.headTreeOid, null); break;
      case 'checks': assert.deepEqual(r.checks, { ok: false, error: 'gh pr checks failed' }); break;
      default: assert.fail('unreachable');
    }
  });
}

// (4) risk: スクリプト自身が ok:false を報告（契約通りの形）→ そのまま採用（fail-closed だが well-formed）
test('risk.value が {ok:false} の契約通り応答 → そのまま採用し isWellFormedRiskFact は true', () => {
  const facts = { ...fullFacts(), risk: { ok: true, value: { ok: false, hits: [], error: 'git failed', exit_code: 128 } } };
  const r = parseMergeTierFacts(facts);
  assert.deepEqual(r.risk, { ok: false, hits: [], error: 'git failed', exit_code: 128 });
  assert.equal(isWellFormedRiskFact(facts), true);
});

// (5) risk: 契約外形状（ok 非boolean / hits 非配列 / value 非object）→ fail-closed 合成
test('risk.value が契約外形状 → fail-closed 合成（hits=[]）', () => {
  for (const bad of [{ ok: 'yes', hits: [] }, { ok: true, hits: 'x' }, 'str', null, 42]) {
    const r = parseMergeTierFacts({ ...fullFacts(), risk: { ok: true, value: bad } });
    assert.equal(r.risk.ok, false, `value=${JSON.stringify(bad)}`);
    assert.deepEqual(r.risk.hits, []);
  }
});

// (6) changed: files に非 string 混入 / files 欠落 → null（空配列は正常 0 件として維持）
test('changed.value.files が string[] でない → null、[] は [] のまま', () => {
  assert.equal(parseMergeTierFacts({ ...fullFacts(), changed: { ok: true, value: { files: ['a', 1] } } }).changedFiles, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), changed: { ok: true, value: {} } }).changedFiles, null);
  assert.deepEqual(parseMergeTierFacts({ ...fullFacts(), changed: { ok: true, value: { files: [] } } }).changedFiles, []);
});

// (7) pr: 値の欠落は null に正規化し ok:true は維持（classifyMergeableState が 'unknown' に倒す）
test('pr.value のフィールド欠落 → null に正規化（ok:true 維持）', () => {
  const r = parseMergeTierFacts({ ...fullFacts(), pr: { ok: true, value: { mergeable: 'UNKNOWN' } } });
  assert.deepEqual(r.prMeta, { ok: true, mergeable: 'UNKNOWN', mergeStateStatus: null, headRefOid: null });
});

// (8) head_tree: 空 / 非 string の tree → null。前後空白は trim（旧 head-tree-oid spawn と同じ受理条件）
test('head_tree.value.tree が空 / 非 string → null、空白付きは trim して採用', () => {
  assert.equal(parseMergeTierFacts({ ...fullFacts(), head_tree: { ok: true, value: { tree: '' } } }).headTreeOid, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), head_tree: { ok: true, value: { tree: '   ' } } }).headTreeOid, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), head_tree: { ok: true, value: { tree: 42 } } }).headTreeOid, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), head_tree: { ok: true, value: { tree: ` ${TREE}\n` } } }).headTreeOid, TREE);
});

// (9) diffhash: hash 非 string / 空文字 → null
test('diffhash.value.hash が string でない / 空 → null', () => {
  assert.equal(parseMergeTierFacts({ ...fullFacts(), diffhash: { ok: true, value: { hash: 123, empty: false } } }).mergeDiffHash, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), diffhash: { ok: true, value: { hash: '', empty: false } } }).mergeDiffHash, null);
});

// (10) error 欠落の ok:false → fallback メッセージ
test('ok:false かつ error 欠落 → fallback の error 文字列', () => {
  const r = parseMergeTierFacts({ ...fullFacts(), risk: { ok: false }, pr: { ok: false }, checks: { ok: false } });
  assert.match(r.risk.error, /fail-closed/);
  assert.match(r.prMeta.error, /unavailable/);
  assert.match(r.checks.error, /unavailable/);
});

// (11) top-level 契約外形状の診断文字列
test('mergeTierFactsTopLevelKeys は診断用にキー一覧 / 型名を返す', () => {
  assert.equal(mergeTierFactsTopLevelKeys({ foo: 1, bar: 2 }), 'foo,bar');
  assert.equal(mergeTierFactsTopLevelKeys({}), '(none)');
  assert.equal(mergeTierFactsTopLevelKeys('x'), 'string');
});

// (12) prompt: gh 2 コマンドは bare 単文、script は bare 名先頭トークン、stdout は argv 転写。
// prompt に sandbox / excludedCommands / 特定パス起動の理由を書かない（.claude/rules/dev-flow.md）。
test('mergeTierFactsPrompt: gh 2 コマンド + merge-tier-facts bare 名の 3 手順で、gh 出力は argv 転写', () => {
  const p = mergeTierFactsPrompt({ wt: '/tmp/wt', base: 'main', pr: 42, repo: 'acme/skills' });
  assert.ok(p.includes('`gh pr view 42 --repo acme/skills --json mergeable,mergeStateStatus,headRefOid`'));
  assert.ok(p.includes('`gh pr checks 42 --repo acme/skills --json name,bucket`'));
  assert.ok(p.includes('`merge-tier-facts --worktree /tmp/wt --base origin/main --pr-view-data \''));
  assert.ok(p.includes('--checks-data \''));
  assert.ok(p.includes('当該オプション自体を省略せよ'));
  assert.ok(!/sandbox|excludedCommands/i.test(p), 'prompt に起動形の理由を書かない');
  assert.ok(!p.includes('bash merge-tier-facts'), 'bash 前置しない');
  assert.ok(!p.includes('.sh '), '拡張子付き呼び出しをしない');
});

test('mergeTierFactsPrompt: repo 省略時は --repo を付けない', () => {
  const p = mergeTierFactsPrompt({ wt: '/tmp/wt', base: 'dev', pr: 7 });
  assert.ok(p.includes('`gh pr view 7 --json mergeable,mergeStateStatus,headRefOid`'));
  assert.ok(p.includes('`gh pr checks 7 --json name,bucket`'));
  assert.ok(p.includes('--base origin/dev '));
  assert.ok(!p.includes('--repo'));
});
