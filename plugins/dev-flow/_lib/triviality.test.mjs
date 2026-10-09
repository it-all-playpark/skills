import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as triviality from './triviality.mjs';
import { classifyShape } from './triviality.mjs';

// classifyShape(req, realizedCount): 実効 shape は realized file 数 + issue 由来の決定論特徴量
// （AC 数 / issue_type / 構造化 breaking_change）だけで決まる（issue #676）。
// 事前見積もり（req.shape / req.estimated_change_file_count）は入力にならない。

const baseReq = (over = {}) => ({
  summary: 'fix a bug in foo',
  acceptance_criteria: ['x', 'y'],
  issue_type: 'fix',
  scope: 'src/foo.ts',
  ...over,
});

// ---- realized count 入力での micro / standard / complex 判定 ----

test('realized=1, ac=2, type=fix, no breaking → shape=micro', () => {
  const result = classifyShape(baseReq(), 1);
  assert.equal(result.shape, 'micro');
  assert.match(result.reason, /realized 1 file\(s\)/);
});

test('realized=2, ac=4, type=fix → shape=micro (issue #272 floor 緩和の境界)', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['a', 'b', 'c', 'd'] }), 2);
  assert.equal(result.shape, 'micro');
});

test('realized=0（変更 0 件）, ac=2 → shape=micro', () => {
  const result = classifyShape(baseReq(), 0);
  assert.equal(result.shape, 'micro');
});

test('realized=3, ac=2, type=feat → shape=standard', () => {
  const result = classifyShape(baseReq({ issue_type: 'feat' }), 3);
  assert.equal(result.shape, 'standard');
  assert.match(result.reason, /realized 3 file\(s\), 2 AC, type=feat → shape=standard/);
});

test('realized=2, ac=5, type=fix → shape=standard (AC 数で micro 境界の 1 個外)', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['a', 'b', 'c', 'd', 'e'] }), 2);
  assert.equal(result.shape, 'standard');
});

test('realized=5, ac=6, type=feat → shape=standard (standard 境界上限)', () => {
  const result = classifyShape(baseReq({ issue_type: 'feat', acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f'] }), 5);
  assert.equal(result.shape, 'standard');
});

test('realized=6, ac=2, type=feat → shape=complex', () => {
  const result = classifyShape(baseReq({ issue_type: 'feat' }), 6);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /realized 6 file\(s\)/);
});

test('realized=3, ac=7, type=feat → shape=complex (ac>6)', () => {
  const result = classifyShape(baseReq({ issue_type: 'feat', acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), 3);
  assert.equal(result.shape, 'complex');
});

// ---- count 欠損 → complex（changed-files probe 失敗の安全弁）----

test('realizedCount=NaN → shape=complex, reason に missing/safe', () => {
  const result = classifyShape(baseReq(), NaN);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /missing|safe/i);
});

test('realizedCount 未指定(undefined) → shape=complex', () => {
  const result = classifyShape(baseReq(), undefined);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /missing|safe/i);
});

test('realizedCount=-1 → shape=complex', () => {
  const result = classifyShape(baseReq(), -1);
  assert.equal(result.shape, 'complex');
});

test("realizedCount が文字列 '1' (型不正) → shape=complex", () => {
  const result = classifyShape(baseReq(), '1');
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /missing|safe/i);
});

// ---- breaking_change=true → complex（realized が小さくても floor）----

test('breaking_change=true, realized=1, ac=1 → shape=complex, reason に analyze structured', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['x'], breaking_change: true, breaking_keyword_scan: false }), 1);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /analyze structured breaking_change=true/);
});

test('breaking_change と breaking_keyword_scan 両方 true → shape=complex, reason に両由来', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['x'], breaking_change: true, breaking_keyword_scan: true }), 1);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /analyze structured breaking_change=true/);
  assert.match(result.reason, /keyword scan hit/);
});

test('breaking_keyword_scan=true のみ (breaking_change=false) → keyword-alone は floor 不採用 (issue #364)', () => {
  const result = classifyShape(baseReq({ breaking_change: false, breaking_keyword_scan: true }), 1);
  assert.equal(result.shape, 'micro');
  assert.match(result.reason, /keyword/);
  assert.match(result.reason, /不採用/);
});

test('breaking_change / breaking_keyword_scan 未指定 → 非 breaking (realized/ac 由来の shape)', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: ['x'] }), 1);
  assert.equal(result.shape, 'micro');
  assert.ok(!/breaking/i.test(result.reason), `reason should not mention breaking, got: ${result.reason}`);
});

test('scope / summary に breaking 文言があっても両 flag false → complex にならない (PR #277 regression)', () => {
  const result = classifyShape(baseReq({
    acceptance_criteria: ['x'], scope: 'breaking change in API', summary: '破壊的変更を避けるための修正',
    breaking_change: false, breaking_keyword_scan: false,
  }), 1);
  assert.equal(result.shape, 'micro');
});

// ---- issue_type / acceptance_criteria の floor ----

test("issue_type='style' (enum 外) → shape=complex", () => {
  const result = classifyShape(baseReq({ issue_type: 'style' }), 1);
  assert.equal(result.shape, 'complex');
});

for (const issueType of ['feat', 'fix', 'docs', 'refactor', 'chore', 'test', 'perf', 'ci']) {
  test(`issue_type='${issueType}', realized=1, ac=2, no breaking → shape=micro`, () => {
    const result = classifyShape(baseReq({ issue_type: issueType, breaking_change: false }), 1);
    assert.equal(result.shape, 'micro');
  });
}

test('acceptance_criteria が null → shape=complex, reason に missing/safe', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: null }), 1);
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /missing|safe/i);
});

test('acceptance_criteria 欠落 → shape=complex', () => {
  const req = baseReq();
  delete req.acceptance_criteria;
  assert.equal(classifyShape(req, 1).shape, 'complex');
});

// ---- 事前見積もりは入力にならない（issue #676）----

test("req.shape='complex' があっても realized=1/ac=2 なら shape=micro（LLM raise 廃止）", () => {
  const result = classifyShape(baseReq({ shape: 'complex' }), 1);
  assert.equal(result.shape, 'micro');
  assert.ok(!/raise|LLM/i.test(result.reason), `reason should not mention LLM raise, got: ${result.reason}`);
});

test("req.shape='micro' があっても realized=6 なら shape=complex（lower も無い）", () => {
  const result = classifyShape(baseReq({ shape: 'micro' }), 6);
  assert.equal(result.shape, 'complex');
});

test('req.estimated_change_file_count=7 があっても realized=1 なら shape=micro（見積もりは無視）', () => {
  const result = classifyShape(baseReq({ estimated_change_file_count: 7 }), 1);
  assert.equal(result.shape, 'micro');
});

test('req.estimated_change_file_count=1 があっても realizedCount 欠損なら shape=complex（見積もりで補完しない）', () => {
  const result = classifyShape(baseReq({ estimated_change_file_count: 1 }), NaN);
  assert.equal(result.shape, 'complex');
});

test('refloorShape / mergeShape / SHAPE_RANK は export されない（realized 一本化、issue #676）', () => {
  assert.equal('refloorShape' in triviality, false);
  assert.equal('mergeShape' in triviality, false);
  assert.equal('SHAPE_RANK' in triviality, false);
  assert.deepEqual(Object.keys(triviality).sort(), ['classifyShape']);
});

// ---- 差分の中身による補正（issue #740）: ファイル種別の重み・削除主体の 1 段下げ・追加行数 ----

const stat = (path, added, deleted) => ({ path, added, deleted });
const codeStats = (n, added, deleted) => Array.from({ length: n }, (_, i) => stat(`src/m${i}.ts`, added, deleted));

// shift-bud#1513（PR shift-bud#1515）相当: docs 2 + 本番 2（うち削除だけ 1）+ テスト 2（うち 1 は対応本番あり）、+24/-128
const SHIFT_BUD_1513 = [
  stat('docs/DOMAIN_PATTERNS_GUIDE.md', 4, 14),
  stat('docs/UBIQUITOUS_LANGUAGE.md', 4, 14),
  stat('src/domain/planning-constraints.ts', 0, 36),
  stat('src/domain/constraint-violation.service.ts', 2, 1),
  stat('src/domain/planning-constraints.test.ts', 6, 40),
  stat('src/solver/solve-month.objectives.test.ts', 8, 23),
];

test('shift-bud#1513 相当（6 files, +24/-128, AC 3, type=chore）→ micro（file 数判定では complex）', () => {
  assert.equal(SHIFT_BUD_1513.reduce((n, s) => n + s.added, 0), 24);
  assert.equal(SHIFT_BUD_1513.reduce((n, s) => n + s.deleted, 0), 128);
  const req = baseReq({ issue_type: 'chore', acceptance_criteria: ['a', 'b', 'c'] });
  const result = classifyShape(req, 6, SHIFT_BUD_1513);
  assert.ok(['micro', 'standard'].includes(result.shape), `micro か standard のはずだが ${result.shape}`);
  assert.equal(result.shape, 'micro');
  assert.equal(result.uncorrected_shape, 'complex');
  // shape_reason に補正の根拠（重み付け後 count / 追加・削除行数 / 1 段下げの有無）が載る
  assert.match(result.reason, /^realized 6 file\(s\) → weighted 3（docs 2 \/ 対応本番ありの test 1 を除外）/);
  assert.match(result.reason, /\+10\/-60 lines/);
  assert.match(result.reason, /file 数判定 complex, 重み・行数判定 standard/);
  assert.match(result.reason, /削除主体.*1 段下げ/);
  assert.match(result.reason, /→ shape=micro$/);
});

test('shift-bud#1513 相当でも行数が取れない（lineStats=null）なら file 数判定の complex のまま', () => {
  const req = baseReq({ issue_type: 'chore', acceptance_criteria: ['a', 'b', 'c'] });
  const result = classifyShape(req, 6, null);
  assert.equal(result.shape, 'complex');
  assert.equal(result.reason, 'realized 6 file(s), 3 AC, type=chore → shape=complex');
});

// ---- 行数を取れないときは file 数判定と同じ結果（補正なし）----

// 不正要素は realizedCount と同じ件数に揃え、件数不一致ではなく要素の不正で fallback することを見る。
// どの要素も「docs・削除主体」なので、補正が掛かれば必ず shape が下がる入力にしてある。
const withCount = (n, bad) => [...codeStats(n - 1, 0, 100).map((s, i) => ({ ...s, path: `docs/d${i}.md` })), bad];
const invalidLineStats = [
  ['null', () => null],
  ['undefined', () => undefined],
  ['配列でない', () => stat('docs/a.md', 0, 100)],
  ['added が NaN', (n) => withCount(n, stat('src/a.ts', NaN, 100))],
  ['deleted が負', (n) => withCount(n, stat('src/a.ts', 0, -1))],
  ['added が小数', (n) => withCount(n, stat('src/a.ts', 0.5, 100))],
  ['added が文字列', (n) => withCount(n, stat('src/a.ts', '0', 100))],
  ['path 欠落', (n) => withCount(n, { added: 0, deleted: 100 })],
  ['null 要素', (n) => withCount(n, null)],
];
for (const count of [1, 3, 6]) {
  for (const [label, makeStats] of invalidLineStats) {
    test(`lineStats=${label}, realized=${count} → file 数判定と同じ shape / reason / uncorrected_shape`, () => {
      const req = baseReq({ issue_type: 'refactor' });
      const expected = count <= 2 ? 'micro' : count <= 5 ? 'standard' : 'complex';
      const result = classifyShape(req, count, makeStats(count));
      assert.deepEqual(result, {
        shape: expected,
        reason: `realized ${count} file(s), 2 AC, type=refactor → shape=${expected}`,
        uncorrected_shape: expected,
      });
    });
  }
}

test('lineStats の件数が realizedCount と合わない → 補正なし（file 数判定）', () => {
  const result = classifyShape(baseReq(), 6, codeStats(2, 0, 100));
  assert.equal(result.shape, 'complex');
  assert.equal(result.reason, 'realized 6 file(s), 2 AC, type=fix → shape=complex');
});

// ---- 1. ファイル種別の重み ----

test('docs/** と *.md は数えない: docs 4 + 本番 1 → micro（file 数判定では standard）', () => {
  const stats = [stat('docs/a.txt', 10, 0), stat('README.md', 10, 0), stat('plugins/x/SKILL.md', 10, 0), stat('docs/guide/b.md', 10, 0), stat('src/a.ts', 10, 0)];
  const result = classifyShape(baseReq(), 5, stats);
  assert.equal(result.uncorrected_shape, 'standard');
  assert.equal(result.shape, 'micro');
  assert.match(result.reason, /weighted 1（docs 4 \/ 対応本番ありの test 0 を除外）/);
  assert.match(result.reason, /1 段下げなし/);
});

test('対応する本番ファイルも変えたテスト（*.test.* / *.spec.* / __tests__/ / .bats）は数えない', () => {
  const stats = [
    stat('src/foo.ts', 10, 0), stat('src/foo.test.ts', 10, 0),
    stat('src/bar.tsx', 10, 0), stat('src/__tests__/bar.tsx', 10, 0),
    stat('scripts/baz.sh', 10, 0), stat('scripts/baz.bats', 10, 0),
    stat('src/qux.service.ts', 10, 0), stat('test/qux.service.spec.ts', 10, 0),
  ];
  const result = classifyShape(baseReq({ issue_type: 'feat' }), 8, stats);
  assert.match(result.reason, /weighted 4（docs 0 \/ 対応本番ありの test 4 を除外）/);
  assert.equal(result.shape, 'standard');
  assert.equal(result.uncorrected_shape, 'complex');
});

test('Ruby / PHP のテスト（*_spec.rb / *_test.rb / *Test.php）も対応する本番ファイルを変えていれば数えない', () => {
  const stats = [
    stat('app/models/foo.rb', 10, 0), stat('spec/models/foo_spec.rb', 10, 0),
    stat('lib/bar.rb', 10, 0), stat('test/lib/bar_test.rb', 10, 0),
    stat('src/Baz.php', 10, 0), stat('tests/Unit/BazTest.php', 10, 0),
  ];
  const result = classifyShape(baseReq({ issue_type: 'feat' }), 6, stats);
  assert.match(result.reason, /weighted 3（docs 0 \/ 対応本番ありの test 3 を除外）/);
  assert.equal(result.shape, 'standard');
  assert.equal(result.uncorrected_shape, 'complex');
});

test('対応する本番ファイルを変えていないテストは数える', () => {
  const stats = [stat('src/foo.ts', 10, 0), stat('src/other.test.ts', 10, 0), stat('src/another.spec.ts', 10, 0)];
  const result = classifyShape(baseReq(), 3, stats);
  assert.match(result.reason, /weighted 3（docs 0 \/ 対応本番ありの test 0 を除外）/);
  assert.equal(result.shape, 'standard');
});

test('変更がテストだけの run は補正しない（削除主体でも下げない）', () => {
  const stats = [stat('src/a.test.ts', 0, 90), stat('src/b.test.ts', 0, 90), stat('scripts/c.bats', 0, 90)];
  const result = classifyShape(baseReq({ issue_type: 'test' }), 3, stats);
  assert.equal(result.shape, 'standard');
  assert.equal(result.uncorrected_shape, 'standard');
  assert.match(result.reason, /^realized 3 file\(s\), 2 AC, type=test → shape=standard（test-only のため補正なし）$/);
});

// ---- 2. 削除主体の差分は 1 段下げる ----

test('削除主体（追加 < 削除×0.3）: standard → micro', () => {
  const result = classifyShape(baseReq(), 3, codeStats(3, 1, 20));
  assert.equal(result.uncorrected_shape, 'standard');
  assert.equal(result.shape, 'micro');
  assert.match(result.reason, /\+3\/-60 lines/);
  assert.match(result.reason, /削除主体（追加 < 削除×0\.3）で 1 段下げ/);
});

test('削除主体: complex → standard（AC 7 で complex でも 1 段だけ下げる）', () => {
  const ac7 = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const result = classifyShape(baseReq({ acceptance_criteria: ac7 }), 3, codeStats(3, 0, 50));
  assert.equal(result.uncorrected_shape, 'complex');
  assert.equal(result.shape, 'standard');
});

test('追加 = 削除×0.3 ちょうど → 下げない（閾値未満のみ）', () => {
  const result = classifyShape(baseReq(), 3, codeStats(3, 3, 10));
  assert.equal(result.shape, 'standard');
  assert.match(result.reason, /\+9\/-30 lines/);
  assert.match(result.reason, /1 段下げなし/);
});

test('削除 0 行 → 下げない', () => {
  const result = classifyShape(baseReq(), 3, codeStats(3, 0, 0));
  assert.equal(result.shape, 'standard');
  assert.match(result.reason, /1 段下げなし/);
});

test('docs の削除は削除主体の判定に入れない（重み付け後の行数で比べる）', () => {
  const stats = [stat('docs/old.md', 0, 500), stat('src/a.ts', 40, 0), stat('src/b.ts', 40, 0), stat('src/c.ts', 40, 0)];
  const result = classifyShape(baseReq(), 4, stats);
  assert.equal(result.shape, 'standard');
  assert.match(result.reason, /\+120\/-0 lines/);
});

// ---- 3. 追加行数の閾値（complex は file 数と追加行数の AND）----

test('広く浅い変更: 重み付け後 8 files でも追加 100 行以下なら standard', () => {
  const result = classifyShape(baseReq({ issue_type: 'refactor' }), 8, codeStats(8, 12, 10));
  assert.equal(result.uncorrected_shape, 'complex');
  assert.equal(result.shape, 'standard');
  assert.match(result.reason, /\+96\/-80 lines/);
});

test('重み付け後 8 files かつ追加 100 行超 → complex のまま', () => {
  const result = classifyShape(baseReq({ issue_type: 'feat' }), 8, codeStats(8, 13, 10));
  assert.equal(result.shape, 'complex');
  assert.match(result.reason, /\+104\/-80 lines/);
  assert.match(result.reason, /→ shape=complex$/);
});

test('追加行数が少なくても AC 7 は complex（AC 境界は変えない）', () => {
  const ac7 = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const result = classifyShape(baseReq({ acceptance_criteria: ac7 }), 8, codeStats(8, 1, 1));
  assert.equal(result.shape, 'complex');
});

test('補正は file 数判定より上げない: 1 file に +1000 行でも micro', () => {
  const result = classifyShape(baseReq(), 1, [stat('src/big.ts', 1000, 0)]);
  assert.equal(result.shape, 'micro');
  assert.equal(result.uncorrected_shape, 'micro');
});

test('keyword-alone の可視化は補正ありの reason にも残る', () => {
  const result = classifyShape(baseReq({ breaking_change: false, breaking_keyword_scan: true }), 3, codeStats(3, 0, 30));
  assert.equal(result.shape, 'micro');
  assert.match(result.reason, /不採用/);
});

// ---- safe floor は補正より先に効く（削除主体・docs だけの行数があっても complex）----

test('floor: realizedCount=NaN は lineStats があっても complex', () => {
  const result = classifyShape(baseReq(), NaN, [stat('docs/a.md', 0, 100)]);
  assert.equal(result.shape, 'complex');
  assert.equal(result.uncorrected_shape, 'complex');
  assert.match(result.reason, /safe floor=complex/);
});

test('floor: acceptance_criteria 欠損は lineStats があっても complex', () => {
  const result = classifyShape(baseReq({ acceptance_criteria: null }), 1, [stat('docs/a.md', 0, 100)]);
  assert.equal(result.shape, 'complex');
  assert.equal(result.uncorrected_shape, 'complex');
});

test('floor: enum 外 issue_type は lineStats があっても complex', () => {
  const result = classifyShape(baseReq({ issue_type: 'style' }), 1, [stat('src/a.ts', 0, 100)]);
  assert.equal(result.shape, 'complex');
  assert.equal(result.uncorrected_shape, 'complex');
});

test('floor: breaking_change=true（後方互換を保たない変更）は lineStats があっても complex', () => {
  const result = classifyShape(baseReq({ breaking_change: true }), 1, [stat('src/a.ts', 0, 100)]);
  assert.equal(result.shape, 'complex');
  assert.equal(result.uncorrected_shape, 'complex');
  assert.match(result.reason, /breaking_change=true/);
});
