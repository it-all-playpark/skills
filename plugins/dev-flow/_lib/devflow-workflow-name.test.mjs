// dev-flow.js の workflow meta.name rename ('dev-flow' -> 'dev-flow-run') を検証する。
//
// 背景: dev-flow.js の meta.name は skill 名（dev-flow/SKILL.md）と衝突しないよう
//       'dev-flow-run' へ改名する。一方、journal telemetry のキー `skill: 'dev-flow',` は
//       集計の連続性のため絶対に変更しない（不変条件）。
//
// このテストは:
//   (a) meta.name === 'dev-flow-run' が存在すること（識別子の完全一致 pin。export const meta は
//       VM 返り値に現れず観測不能なため source pin として残置する。issue #636 disposition class C）
//   (b) 旧 meta 名 `name: 'dev-flow',`（完全一致文字列）が存在しないこと（同上）
//   (c) VM 挙動: success / empty-diff failure / abort の 3 run いずれも journal-save 系 prompt の
//       telemetry JSON が `"skill":"dev-flow"` を含む（集計連続性 invariant を挙動で pin。
//       abort run はさらに `"error_category":"abort"` も含む）
//   (d) .claude/workflows/ 配下の全 *.js に workflow('dev-flow') 形式の nested 呼び出しが
//       存在しないこと（rename 漏れ検出。識別子の完全一致 pin として残置）
// を assert する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowDir = join(repoRoot, '.claude/workflows');

const devFlowPath = join(workflowDir, 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// (a) 新 meta 名が存在する
test('[workflow-name] dev-flow.js: meta.name が dev-flow-run である', () => {
  assert.ok(
    devFlowSrc.includes("name: 'dev-flow-run',"),
    "dev-flow.js に name: 'dev-flow-run', が存在しない（meta.name の rename が未適用）",
  );
});

// (b) 旧 meta 名が存在しない
test('[workflow-name] dev-flow.js: 旧 meta 名 name: \'dev-flow\', が残存しない', () => {
  assert.ok(
    !devFlowSrc.includes("name: 'dev-flow',"),
    "dev-flow.js に旧 meta 名 name: 'dev-flow', が残存している（rename 漏れ）",
  );
});

// (c) telemetry の skill:'dev-flow' 集計連続性 invariant を、3 call site（Merge tier success handoff /
// writeFailureTelemetry / top-level abort handoff、issue #607）に対応する 3 run で挙動確認する。
// journal-save 系 prompt に埋め込まれる telemetry JSON（JSON.stringify 出力、空白なし）を対象にする。

test('[workflow-name] VM: 成功 run の journal-save prompt JSON が "skill":"dev-flow" を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'workflow-name-success');
  if (error) assert.fail(`成功 run が想定外に throw した: ${error.message}`);

  const journalSave = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalSave != null, '成功 run に journal-save の call が見つからない');
  assert.ok(
    journalSave.prompt.includes('"skill":"dev-flow"'),
    `成功 run の journal-save prompt に '"skill":"dev-flow"' が含まれない。\nprompt (先頭800文字): ${journalSave.prompt.slice(0, 800)}`,
  );
});

test('[workflow-name] VM: empty-diff 失敗 run の journal-save 系 prompt JSON が "skill":"dev-flow" を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'diff-gate': { hash: 'H', empty: true },
      'diff-gate-retry': { hash: 'H', empty: true },
      'issue-labels': null,
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  // empty-diff gate は 1 回の差し戻し後も空 diff なら throw する（fail-fast、issue #215）。
  // writeFailureTelemetry（journal-save 呼び出し）は throw の直前に実行済みなので calls に残る。
  assert.ok(error !== null, 'empty-diff 失敗 run は throw するはずだが error が null だった');

  const journalSave = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalSave != null, 'empty-diff 失敗 run に journal-save の call が見つからない');
  assert.ok(
    journalSave.prompt.includes('"skill":"dev-flow"'),
    `empty-diff 失敗 run の journal-save prompt に '"skill":"dev-flow"' が含まれない。\nprompt (先頭800文字): ${journalSave.prompt.slice(0, 800)}`,
  );
});

test('[workflow-name] VM: abort run の journal-save 系 prompt JSON が "skill":"dev-flow" かつ "error_category":"abort" を含む', async () => {
  // 標準経路（devFlowResponder 既定 shape:'standard'）は plan-reviewer loop を通らず単発 pass
  // ラベル 'plan#standard' を使う（review loop の 'plan#1' は complex 経路のみ）。
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'plan#standard': () => { throw new Error('injected') } },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.ok(error !== null, 'plan#standard の throw は top-level catch で abort handoff 後に rethrow されるはずだが error が null だった');

  const journalSave = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalSave != null, 'abort run に journal-save の call が見つからない');
  assert.ok(
    journalSave.prompt.includes('"skill":"dev-flow"'),
    `abort run の journal-save prompt に '"skill":"dev-flow"' が含まれない。\nprompt (先頭800文字): ${journalSave.prompt.slice(0, 800)}`,
  );
  assert.ok(
    journalSave.prompt.includes('"error_category":"abort"'),
    `abort run の journal-save prompt に '"error_category":"abort"' が含まれない。\nprompt (先頭800文字): ${journalSave.prompt.slice(0, 800)}`,
  );
});

// (d) .claude/workflows/*.js に workflow('dev-flow') 形式の nested 呼び出しが無い
test('[workflow-name] .claude/workflows/*.js に workflow(\'dev-flow\') 形式の nested 呼び出しが存在しない', () => {
  const files = readdirSync(workflowDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, '.claude/workflows/ 配下に *.js が見つからない');

  const nestedCallPattern = /[Ww]orkflow\(\s*\{?\s*(name:\s*)?['"]dev-flow['"](?!-run)/;

  for (const file of files) {
    const filePath = join(workflowDir, file);
    const src = readFileSync(filePath, 'utf8');
    assert.doesNotMatch(
      src,
      nestedCallPattern,
      `${file} に workflow('dev-flow') 形式の nested 呼び出しが残存している（rename 漏れ）`,
    );
  }
});
