// tools/jev-backtest.test.mjs
// tools/jev-backtest.mjs の純関数テスト。network / gh は呼ばない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import {
  parseUnifiedDiff, matchFinding, baselineKind, evaluatePolicy, buildPolicies,
  jevScore, buildJevState, loadJournal, loadJevCache, hunkId, hunkDigest, MAX_STATE_CHARS,
} from './jev-backtest.mjs';

const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -10,3 +10,4 @@ function f() {',
  ' const x = 1;',
  '-return x;',
  '+const y = 2;',
  '+return x + y;',
  ' }',
  '@@ -50,2 +51,2 @@',
  '-old',
  '+new',
  ' ctx',
  'diff --git a/docs/g.md b/docs/g.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/g.md',
  '@@ -0,0 +1,2 @@',
  '+# title',
  '+body',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/old.txt b/renamed.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to renamed.txt',
  '',
].join('\n');

test('parseUnifiedDiff: files / hunks / ranges / counts', () => {
  const files = parseUnifiedDiff(DIFF);
  assert.deepEqual(files.map((f) => f.path), ['src/a.js', 'docs/g.md', 'img.png', 'renamed.txt']);
  const a = files[0];
  assert.equal(a.hunks.length, 2);
  assert.equal(a.hunks[0].newStart, 10);
  assert.equal(a.hunks[0].newLines, 4);
  assert.equal(a.hunks[0].added, 2);
  assert.equal(a.hunks[0].removed, 1);
  assert.equal(a.hunks[1].newStart, 51);
  assert.equal(a.hunks[1].newLines, 2);
  assert.ok(a.hunks[0].text.startsWith('@@ -10,3 +10,4 @@'));
  const g = files[1];
  assert.equal(g.oldPath, null);
  assert.equal(g.hunks[0].newLines, 2);
  assert.equal(files[2].binary, true);
  assert.equal(files[3].hunks.length, 0);
  assert.equal(files[3].oldPath, 'old.txt');
});

test('matchFinding: hunk / tolerance / file / outside', () => {
  const files = parseUnifiedDiff(DIFF);
  assert.deepEqual(matchFinding({ file: 'src/a.js', line: 12 }, files), { level: 'hunk', hunkIndex: 0, path: 'src/a.js' });
  // 10..13 の hunk に ±3 で 16 まで届く
  assert.equal(matchFinding({ file: 'src/a.js', line: 16 }, files).level, 'hunk');
  assert.equal(matchFinding({ file: 'src/a.js', line: 17 }, files).level, 'file');
  assert.equal(matchFinding({ file: 'src/a.js', line: 51 }, files).hunkIndex, 1);
  assert.equal(matchFinding({ file: 'src/a.js', line: null }, files).level, 'file');
  assert.equal(matchFinding({ file: 'src/a.js', line: 0 }, files).level, 'file');
  assert.equal(matchFinding({ file: './src/a.js', line: 11 }, files).level, 'hunk');
  assert.equal(matchFinding({ file: 'src/a.js:11', line: 11 }, files).level, 'hunk');
  assert.equal(matchFinding({ file: 'a.js', line: 11 }, files).level, 'hunk'); // 末尾一致
  assert.equal(matchFinding({ file: 'src/none.js', line: 1 }, files).level, 'outside');
  assert.equal(matchFinding({ file: null, line: 1 }, files).level, 'outside');
});

test('baselineKind: lockfile / inline marker / docs / test / logic', () => {
  const h = (text) => ({ text });
  assert.equal(baselineKind('package-lock.json', h('@@\n+x')), 'generated');
  assert.equal(baselineKind('plugins/playpark-skills/skills-lock.json', h('@@\n+x')), 'generated');
  assert.equal(baselineKind('plugins/dev-flow/.claude/workflows/dev-flow.js', h('@@\n+// ==== BEGIN inline: _lib/x.mjs ====\n+foo')), 'generated');
  assert.equal(baselineKind('plugins/dev-flow/.claude/workflows/dev-flow.js', h('@@\n+// INLINE COPY POLICY: ...')), 'generated');
  assert.equal(baselineKind('plugins/dev-flow/.claude/workflows/dev-flow.js', h('@@\n+const x = 1')), 'logic');
  assert.equal(baselineKind('docs/x.md', h('@@\n+# t')), 'docs');
  assert.equal(baselineKind('tools/foo.test.mjs', h('@@\n+t')), 'test');
  assert.equal(baselineKind('skill/scripts/foo.bats', h('@@\n+t')), 'test');
  assert.equal(baselineKind('tests/run.sh', h('@@\n+t')), 'test');
  assert.equal(baselineKind('src/x.ts', h('@@\n+t')), 'logic');
});

function mkHunk(repo, pr, path, index, lines, baseKind, jev = null) {
  return { id: hunkId(repo, pr, path, index), repo, pr, path, lines, baseKind, jev, hunk: { text: 'x' } };
}

test('evaluatePolicy: hunk-level miss, file-level miss only when all hunks excluded, outside ignored', () => {
  const R = 'o/r';
  const hunks = [
    mkHunk(R, 1, 'a.js', 0, 10, 'logic'),
    mkHunk(R, 1, 'a.js', 1, 5, 'generated'),
    mkHunk(R, 1, 'b.md', 0, 3, 'docs'),
    mkHunk(R, 1, 'c.md', 0, 2, 'docs'),
  ];
  const findings = [
    { kind: 'blocking', repo: R, pr: 1, file: 'a.js', line: 1, match: { level: 'hunk', hunkIndex: 1, path: 'a.js' }, hunkId: hunkId(R, 1, 'a.js', 1) },
    { kind: 'blocking', repo: R, pr: 1, file: 'a.js', line: 99, match: { level: 'file', hunkIndex: null, path: 'a.js' }, hunkId: null },
    { kind: 'minor', repo: R, pr: 1, file: 'b.md', line: 99, match: { level: 'file', hunkIndex: null, path: 'b.md' }, hunkId: null },
    { kind: 'minor', repo: R, pr: 1, file: 'zz', line: 1, match: { level: 'outside', hunkIndex: null, path: null }, hunkId: null },
  ];
  const pol = buildPolicies(false);
  const r1 = evaluatePolicy(hunks, findings, pol['baseline:lock+gen']);
  assert.equal(r1.hunks_excluded, 1);
  assert.equal(r1.lines_excluded, 5);
  assert.equal(r1.blocking_n, 2);
  assert.equal(r1.blocking_recall, 0.5);     // hunk 一致の finding が除外 hunk 上 → miss。file 一致は a.js に残る hunk があるので hit
  assert.equal(r1.minor_n, 1);              // outside は分母から外れる
  assert.equal(r1.minor_recall, 1);
  const r2 = evaluatePolicy(hunks, findings, pol['baseline:lock+gen+docs']);
  assert.equal(r2.hunks_excluded, 3);
  assert.equal(r2.minor_recall, 0);          // b.md の全 hunk が除外 → file 一致でも miss
  assert.equal(r2.minor_missed[0].file, 'b.md');
});

test('buildPolicies: jev policies respect thresholds and null-safety', () => {
  const pol = buildPolicies(true);
  const lo = mkHunk('o/r', 1, 'a.js', 0, 1, 'logic', { needs_review: 0.05, kind: 'formatting_only', kind_confidence: 0.95 });
  const hi = mkHunk('o/r', 1, 'a.js', 1, 1, 'logic', { needs_review: 0.9, kind: 'logic', kind_confidence: 0.99 });
  const none = mkHunk('o/r', 1, 'a.js', 2, 1, 'generated', null);
  assert.equal(pol['jev:needs_review<0.1'](lo), true);
  assert.equal(pol['jev:needs_review<0.1'](hi), false);
  assert.equal(pol['jev:needs_review<0.1'](none), false);   // 未スコアは除外しない（fail-closed）
  assert.equal(pol['jev:kind∈{generated,formatting_only,rename_only}∧conf≥0.9'](lo), true);
  assert.equal(pol['jev:kind∈{generated,formatting_only,rename_only}∧conf≥0.9'](hi), false);
  assert.equal(pol['jev:needs_review<0.2 ∨ baseline:lock+gen'](none), true);
});

test('jevScore: request shape and answer extraction (mock fetch)', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { needs_review: { type: 'noul', noul: 0.12 }, kind: { type: 'choice', choice: 'docs', confidence: 0.81, probabilities: { docs: 0.81, logic: 0.1 } } }, usage: { input_tokens: 321, output_tokens: 20 } }) };
  };
  const state = buildJevState('o/r', 'docs/x.md', { header: '@@ -1 +1 @@', text: '@@ -1 +1 @@\n-a\n+b\n', added: 1, removed: 1 });
  const a = await jevScore(state, 'KEY', fetchImpl);
  assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(captured.init.headers.Authorization, 'Bearer KEY');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(Object.keys(body.questions).sort(), ['kind', 'needs_review']);
  assert.equal(body.questions.needs_review.type, 'noul');
  assert.equal(body.questions.kind.type, 'choice');
  assert.equal(body.state.file, 'docs/x.md');
  assert.deepEqual(a, { model: 'jev-1.13.0', needs_review: 0.12, kind: 'docs', kind_confidence: 0.81, kind_probabilities: { docs: 0.81, logic: 0.1 }, input_tokens: 321 });
});

test('jevScore: non-2xx throws with status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  await assert.rejects(() => jevScore({ diff: 'x' }, 'K', fetchImpl), /jev 429: rate limited/);
});

test('buildJevState: truncates oversized hunk under state budget', () => {
  const big = 'x'.repeat(MAX_STATE_CHARS * 2);
  const s = buildJevState('o/r', 'a.js', { header: '@@', text: big, added: 1, removed: 0 });
  assert.ok(s.diff.length < MAX_STATE_CHARS);
  assert.ok(s.diff.endsWith('[... hunk truncated for length ...]\n'));
});

test('loadJournal: collects findings per PR, dedupes across runs/iterations, defaults repo', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'jev-bt-'));
  try {
    const f1 = { severity: 'major', topic: 't1', file: 'a.js', line: 3, description: 'd' };
    const m1 = { severity: 'minor', topic: 'm1', file: 'b.md', line: 9 };
    writeFileSync(join(dir, '2026-01-01-pr-iterate-1.json'), JSON.stringify({ context: { pr_number: 7 }, telemetry: { iterate_history: [{ iteration: 1, blocking: [f1], minor: [m1] }, { iteration: 2, blocking: [], minor: [m1] }] } }));
    writeFileSync(join(dir, '2026-01-02-pr-iterate-2.json'), JSON.stringify({ context: { pr_number: 7, repo: 'it-all-playpark/skills' }, telemetry: { iterate_history: [{ iteration: 1, blocking: [f1] }] } }));
    writeFileSync(join(dir, '2026-01-03-pr-iterate-3.json'), JSON.stringify({ context: { pr_number: 8, repo: 'x/y' }, telemetry: { iterate_history: [{ iteration: 1, blocking: [{ severity: 'critical', file: 'c.ts', line: 1 }] }] } }));
    writeFileSync(join(dir, '2026-01-04-pr-iterate-4.json'), JSON.stringify({ context: { pr_number: 9 }, telemetry: { iterate_history: [] } }));
    writeFileSync(join(dir, '2026-01-05-dev-flow-1.json'), JSON.stringify({ telemetry: { iterate_history: [{ blocking: [f1] }] } }));
    writeFileSync(join(dir, '2026-01-06-pr-iterate-5.json'), 'not json');
    const prs = loadJournal(dir);
    assert.deepEqual(prs.map((p) => `${p.repo}#${p.pr}`), ['it-all-playpark/skills#7', 'x/y#8']);
    const p7 = prs[0];
    assert.equal(p7.runs.length, 2);
    assert.equal(p7.findings.length, 2);
    assert.deepEqual(p7.findings.map((f) => f.kind), ['blocking', 'minor']);
    assert.equal(prs[1].findings[0].severity, 'critical');
    assert.equal(prs[1].findings[0].kind, 'blocking');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadJevCache / hunkDigest', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'jev-bt-'));
  try {
    const f = join(dir, 'c.jsonl');
    writeFileSync(f, JSON.stringify({ key: 'k1', answer: { needs_review: 0.3 } }) + '\nbroken\n' + JSON.stringify({ key: 'k2', answer: null }) + '\n');
    const c = loadJevCache(f);
    assert.equal(c.size, 2);
    assert.equal(c.get('k1').answer.needs_review, 0.3);
    assert.equal(loadJevCache(join(dir, 'missing.jsonl')).size, 0);
    assert.equal(hunkDigest('abc'), hunkDigest('abc'));
    assert.notEqual(hunkDigest('abc'), hunkDigest('abd'));
    assert.equal(hunkDigest('abc').length, 16);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
