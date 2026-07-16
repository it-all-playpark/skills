import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, accessSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const DICT_PATH = path.join(REPO_ROOT, '_shared', 'references', 'stuck-topic-dictionary.md');

// (1) 辞書ファイルが存在し読める
test('stuck-topic-dictionary.md が存在し読める', () => {
  assert.doesNotThrow(
    () => accessSync(DICT_PATH),
    '_shared/references/stuck-topic-dictionary.md が存在しない',
  );
  const content = readFileSync(DICT_PATH, 'utf-8');
  assert.ok(content.length > 0, 'ファイルが空である');
});

// (2) 辞書本文に形式ルール記号 '::' が含まれる
test('辞書本文に形式ルール記号 "::" が含まれる', () => {
  const content = readFileSync(DICT_PATH, 'utf-8');
  assert.ok(
    content.includes('::'),
    '辞書本文に "<problem-class>::<詳細>" 形式を示す "::" が含まれない',
  );
});

// (3) 必須 problem-class が全て含まれる
const REQUIRED_CLASSES = [
  'scope-mismatch',
  'yagni-violation',
  'untestable-ac',
  'missing-file-reference',
  'wrong-file-target',
  'file-conflict-in-parallel',
  'dependency-contradiction',
  'self-containment-violation',
  'edge-case-unhandled',
  'error-handling-missing',
  'input-validation-missing',
  'security-vuln',
  'secret-exposure',
  'logic-bug',
  'regression',
  'test-missing',
  'test-weakening',
  'test-not-asserting',
  'performance-issue',
  'naming-convention',
];

test('辞書本文に必須 problem-class が全て含まれる', () => {
  const content = readFileSync(DICT_PATH, 'utf-8');
  const missing = REQUIRED_CLASSES.filter((cls) => !content.includes(cls));
  assert.deepEqual(
    missing,
    [],
    `以下の problem-class が辞書に見つからない: ${missing.join(', ')}`,
  );
});

// (4) 各 agent .md ファイルが辞書パスを参照している
// 注: この subtest 群は後続 task (F2/F3/F4) 完了まで red になる設計
const DICT_REF = '_shared/references/stuck-topic-dictionary.md';
const AGENTS = [
  '.claude/agents/plan-reviewer.md',
  '.claude/agents/evaluator.md',
  '.claude/agents/pr-reviewer.md',
];

for (const agentRelPath of AGENTS) {
  test(`${agentRelPath} が辞書パスを参照している`, () => {
    const agentPath = path.join(REPO_ROOT, agentRelPath);
    let content;
    try {
      content = readFileSync(agentPath, 'utf-8');
    } catch {
      assert.fail(`${agentRelPath} が読み込めない`);
    }
    assert.ok(
      content.includes(DICT_REF),
      `${agentRelPath} に "${DICT_REF}" の参照がない`,
    );
  });
}
