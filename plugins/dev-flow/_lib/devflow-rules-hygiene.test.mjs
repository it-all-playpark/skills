// devflow-rules-hygiene.test.mjs
// `.claude/rules/dev-flow.md` の hygiene（サイズ上限・経緯記述ゼロ・references への
// ポインタ存在・不変条件アンカー存在・paths frontmatter 不変）を pin する静的テスト（issue #635）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findHistoryTerms } from './test-helpers/history-terms.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rulesPath = join(REPO_ROOT, '.claude', 'rules', 'dev-flow.md');
const rulesSrc = readFileSync(rulesPath, 'utf8');

test('(a) .claude/rules/dev-flow.md は 10240 bytes 以下', () => {
  const size = Buffer.byteLength(rulesSrc, 'utf8');
  assert.ok(size <= 10240, `.claude/rules/dev-flow.md が ${size} bytes（上限 10240 bytes）`);
});

test('(b) .claude/rules/dev-flow.md に経緯記述（禁止辞書ヒット）が存在しない', () => {
  const lines = rulesSrc.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const terms = findHistoryTerms(line);
    if (terms.length > 0) {
      hits.push(`${i + 1}: ${line} (${terms.join(',')})`);
    }
  });
  assert.equal(hits.length, 0, `経緯記述を含む行が見つかった:\n${hits.join('\n')}`);
});

const REFERENCES_DIR = 'plugins/dev-flow/dev-flow/references/';
const REFERENCE_FILES = [
  'pipeline.md',
  'telemetry.md',
  'justification-classes.md',
  'exec-proxy.md',
  'inline-generation.md',
  'dev-improve.md',
];

test('(c) references ディレクトリへのポインタと 6 ファイル名が rules に含まれ、実在する', () => {
  assert.ok(
    rulesSrc.includes(REFERENCES_DIR),
    `rules に "${REFERENCES_DIR}" への言及が見つからない`,
  );
  for (const name of REFERENCE_FILES) {
    assert.ok(rulesSrc.includes(name), `rules に references ファイル名 "${name}" への言及が見つからない`);
    const fullPath = join(REPO_ROOT, 'plugins', 'dev-flow', 'dev-flow', 'references', name);
    assert.ok(existsSync(fullPath), `references ファイルが存在しない: ${fullPath}`);
  }
});

const INVARIANT_ANCHORS = [
  'merge は常に人間',
  '軸A',
  '1 issue = 1 PR',
  'sandbox / excludedCommands / 特定パス起動の理由を書いてはならない',
  '**例外はない**',
  'tools/sync-inlines.mjs --write',
  'Date.now',
  'PER_KEY_TELEMETRY_KEYS',
  'written:false',
];

test('(d) 不変条件アンカーが全て rules に残っている', () => {
  const missing = INVARIANT_ANCHORS.filter((anchor) => !rulesSrc.includes(anchor));
  assert.equal(missing.length, 0, `不変条件アンカーが欠落している: ${JSON.stringify(missing)}`);
});

const EXPECTED_PATHS = [
  'plugins/dev-flow/.claude/workflows/**',
  'plugins/dev-flow/agents/**',
  'plugins/dev-flow/.claude/agents/**',
  'plugins/dev-flow/_lib/**',
  'plugins/dev-flow/_shared/**',
  'plugins/dev-flow/dev-flow/**',
  'plugins/dev-flow/dev-flow-doctor/**',
  'plugins/dev-flow/dev-flow-improve/**',
  'tools/**',
];

test('(e) frontmatter の paths 配列が現状と同一の 9 エントリを含む', () => {
  const frontmatterMatch = rulesSrc.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatterMatch, 'frontmatter が見つからない');
  const frontmatter = frontmatterMatch[1];
  for (const p of EXPECTED_PATHS) {
    assert.ok(frontmatter.includes(`"${p}"`), `frontmatter の paths に "${p}" が含まれない`);
  }
});
