// _lib/devflow-docs-counts.test.mjs
// issue #697: README / telemetry.md / agent 定義に書かれた数・役割が実装とずれないことを pin する。
// 期待値は実装（dev-flow.js の meta.phases・agents/ の実体・workflow の agentType 実呼び出し）から導出する。
//
// Run: npx vitest run _lib/devflow-docs-counts.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pluginRoot, '..', '..');

const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const devFlowSrc = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');

test('README: Atlas 紹介の phase 数が dev-flow.js の meta.phases と一致する', () => {
  const metaPhases = devFlowSrc.slice(devFlowSrc.indexOf('phases: ['), devFlowSrc.indexOf('],', devFlowSrc.indexOf('phases: [')));
  const count = (metaPhases.match(/\{ title: '/g) ?? []).length;
  assert.ok(count > 0, 'meta.phases が読めない');
  const m = readme.match(/dev-flow Pipeline Atlas\]\(docs\/dev-flow-atlas\.md\)\*\* — (\d+) phase/);
  assert.ok(m, 'README に Atlas 紹介の phase 数が無い');
  assert.equal(Number(m[1]), count);
});

test('README: dev-flow plugin の agent 数（plugin 行・agents/ 行）が agents/ の実体数と一致する', () => {
  const actual = readdirSync(join(pluginRoot, 'agents')).filter((n) => n.endsWith('.md')).length;
  const pluginLine = readme.match(/dev-flow\/\s+# issue-to-LGTM ワークフロー plugin（\d+ skills, (\d+) agents）/);
  const agentsLine = readme.match(/agents\/\s+# (\d+) dev-flow agent 実体/);
  assert.ok(pluginLine && agentsLine, 'README の plugin 構成図に agent 数の記述が無い');
  assert.equal(Number(pluginLine[1]), actual);
  assert.equal(Number(agentsLine[1]), actual);
});

test('telemetry.md: subagent_invocations の実測 agentType 列挙数と「N 種」が一致する', () => {
  const md = readFileSync(join(pluginRoot, 'dev-flow/references/telemetry.md'), 'utf8');
  const m = md.match(/実測 agentType は([\s\S]*?)の (\d+) 種/);
  assert.ok(m, 'telemetry.md に実測 agentType の列挙が無い');
  const listed = m[1].split('/').map((s) => s.trim()).filter(Boolean);
  assert.equal(listed.length, Number(m[2]), `列挙: ${listed.join(', ')}`);
});

test("dev-runner.md: 役割記述が agentType: 'dev-runner' の実呼び出し（analyze-clarify / PR fix / dev-improve の issue 操作）に合う", () => {
  const md = readFileSync(join(pluginRoot, 'agents/dev-runner.md'), 'utf8');
  const description = md.slice(md.indexOf('description:'), md.indexOf('model:'));
  assert.ok(!/test-green|issue analysis/.test(description), `description にテスト実行 / issue 分析が残っている:\n${description}`);
  assert.match(description, /analyze-clarify/);
  assert.match(description, /PR fix/);
  assert.match(description, /dev-improve/);
  assert.ok(!md.includes('| test green 確認 |'), 'テスト実行は dev-runner-haiku が担う');
  assert.ok(!md.includes('| issue 分析 |'), '通常経路の issue 分析は prerun の script が担う');
  const labels = [
    ['.claude/workflows/dev-flow.js', 'analyze-clarify#'],
    ['.claude/workflows/pr-iterate.js', 'fix#'],
    ['.claude/workflows/dev-improve.js', 'file-issue#'],
    ['.claude/workflows/dev-improve.js', 'hyp-update#'],
  ];
  for (const [rel, label] of labels) {
    const src = readFileSync(join(pluginRoot, rel), 'utf8');
    assert.ok(
      new RegExp(`agentType: 'dev-runner', schema: \\w+, label: \`${label}`).test(src),
      `${rel} の dev-runner 呼び出し（${label}）が見つからない — dev-runner.md の役割記述を見直す`,
    );
  }
});

test('evaluator.md: concern_resolutions の boolean キー不受理を現行仕様として書く', () => {
  const md = readFileSync(join(pluginRoot, 'agents/evaluator.md'), 'utf8');
  assert.ok(md.includes('boolean キーは受理しない（error）'));
  assert.ok(!md.includes('旧 resolved:true/false'));
});
