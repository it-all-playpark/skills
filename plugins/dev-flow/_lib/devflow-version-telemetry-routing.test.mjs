// F4: dev-flow.js / pr-iterate.js の成功 handoff・失敗 handoff（writeFailureTelemetry）の
// journal-save prompt に quality_model_config / plugin_version の telemetry キーが実際に
// 埋め込まれることを VM 挙動テストで検証する（issue #636: source anchor 走査から移行）。
// PLUGIN_VERSION 宣言のマーカー存在・plugin.json 一致は _lib/plugin-version.sync.test.mjs が
// 別途 pin する（本ファイルからは削除済み）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  makeDevFlowSandbox,
  makePrIterateSandbox,
  runWorkflowCapture,
} from './test-helpers/vm-sandbox.mjs';
import { QUALITY_MODEL } from './quality-model.mjs';
import { PLUGIN_VERSION } from './plugin-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

function assertJournalSaveHasKeys(calls, contextLabel) {
  const journalSaveCalls = calls.filter((c) => c.label?.startsWith('journal-save'));
  assert.ok(journalSaveCalls.length > 0, `${contextLabel}: label 'journal-save*' の call が見つからない`);
  const qualityMatched = journalSaveCalls.some(
    (c) => c.prompt.includes(`"quality_model_config":"${QUALITY_MODEL}"`),
  );
  assert.ok(
    qualityMatched,
    `${contextLabel}: journal-save prompt に "quality_model_config":"${QUALITY_MODEL}" を含む call が見つからない`,
  );
  const versionMatched = journalSaveCalls.some(
    (c) => c.prompt.includes(`"plugin_version":"${PLUGIN_VERSION}"`),
  );
  assert.ok(
    versionMatched,
    `${contextLabel}: journal-save prompt に "plugin_version":"${PLUGIN_VERSION}" を含む call が見つからない`,
  );
}

test('dev-flow.js 成功 run の journal-save prompt が quality_model_config / plugin_version を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
  assert.equal(error, null, `成功 run はエラーなく完走するべき: ${error?.message}`);
  assertJournalSaveHasKeys(calls, 'dev-flow success');
});

test('dev-flow.js empty-diff 失敗 run の journal-save prompt が quality_model_config / plugin_version を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'diff-gate': { hash: 'H', empty: true },
      'diff-gate-retry': { hash: 'H', empty: true },
      'issue-labels': null,
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
  assert.ok(error, 'empty-diff gate で throw するべき');
  assertJournalSaveHasKeys(calls, 'dev-flow empty-diff failure');
});

test('pr-iterate.js 単体起動 run の journal-save prompt が quality_model_config / plugin_version を含む', async () => {
  const { ctx, calls } = makePrIterateSandbox();
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `pr-iterate 単体起動はエラーなく完走するべき: ${error?.message}`);
  assertJournalSaveHasKeys(calls, 'pr-iterate standalone');
});
