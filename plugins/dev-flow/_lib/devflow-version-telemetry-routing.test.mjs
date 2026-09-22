// F4: dev-flow.js / pr-iterate.js の成功 handoff・失敗 handoff（writeFailureTelemetry）の
// journal-save prompt に eval_model_config / review_model_config / plugin_version の telemetry キーが
// 実際に埋め込まれること、旧 quality_model_config / quality_model_fallback_label が載らないことを
// VM 挙動テストで検証する（issue #636: source anchor 走査から移行）。
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
import { PLUGIN_VERSION } from './plugin-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

// evaluator / pr-reviewer は override を渡さないので frontmatter の 'opus'（値の一致は review-model-frontmatter.test.mjs が pin）。
// eval_model_config / impl_model_config は evaluator / dev-implement-fable を spawn する dev-flow 側の entry にのみ載る。
function assertJournalSaveHasKeys(calls, contextLabel, { evalModel }) {
  const journalSaveCalls = calls.filter((c) => c.label?.startsWith('journal-save'));
  assert.ok(journalSaveCalls.length > 0, `${contextLabel}: label 'journal-save*' の call が見つからない`);
  const has = (needle) => journalSaveCalls.some((c) => c.prompt.includes(needle));
  if (evalModel) {
    assert.ok(has('"eval_model_config":"opus"'), `${contextLabel}: journal-save prompt に "eval_model_config":"opus" を含む call が見つからない`);
    assert.ok(has('"impl_model_config":"fable"'), `${contextLabel}: journal-save prompt に "impl_model_config":"fable" を含む call が見つからない`);
  } else {
    assert.ok(!has('"eval_model_config"'), `${contextLabel}: journal-save prompt に eval_model_config が載っている（evaluator を spawn しない workflow）`);
    assert.ok(!has('"impl_model_config"'), `${contextLabel}: journal-save prompt に impl_model_config が載っている（implementer を spawn しない workflow）`);
  }
  assert.ok(has('"review_model_config":"opus"'), `${contextLabel}: journal-save prompt に "review_model_config":"opus" を含む call が見つからない`);
  assert.ok(has(`"plugin_version":"${PLUGIN_VERSION}"`), `${contextLabel}: journal-save prompt に "plugin_version":"${PLUGIN_VERSION}" を含む call が見つからない`);
  for (const stale of ['"quality_model_config"', '"quality_model_fallback_label"']) {
    assert.ok(!has(stale), `${contextLabel}: journal-save prompt に撤去済みキー ${stale} が載っている`);
  }
}

test('dev-flow.js 成功 run の journal-save prompt が eval_model_config / review_model_config / plugin_version を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
  assert.equal(error, null, `成功 run はエラーなく完走するべき: ${error?.message}`);
  assertJournalSaveHasKeys(calls, 'dev-flow success', { evalModel: true });
});

test('dev-flow.js empty-diff 失敗 run の journal-save prompt が eval_model_config / review_model_config / plugin_version を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'diff-gate': { hash: 'H', empty: true },
      'diff-gate-retry': { hash: 'H', empty: true },
      'issue-labels': null,
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
  assert.ok(error, 'empty-diff gate で throw するべき');
  assertJournalSaveHasKeys(calls, 'dev-flow empty-diff failure', { evalModel: true });
});

test('dev-flow.js abort run（eval#1 null）の journal-save prompt が eval_model_config / review_model_config / plugin_version を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { 'eval#1': null } });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
  assert.ok(error, 'eval#1 null は need() で abort するべき（model fallback による再試行は無い）');
  const evalCalls = calls.filter((c) => c.label === 'eval#1');
  assert.equal(evalCalls.length, 1, 'eval#1 は 1 回だけ呼ばれる（null でも再試行しない）');
  assertJournalSaveHasKeys(calls, 'dev-flow abort', { evalModel: true });
});

test('pr-iterate.js 単体起動 run の journal-save prompt が review_model_config / plugin_version を含み eval_model_config を含まない', async () => {
  const { ctx, calls } = makePrIterateSandbox();
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `pr-iterate 単体起動はエラーなく完走するべき: ${error?.message}`);
  assertJournalSaveHasKeys(calls, 'pr-iterate standalone', { evalModel: false });
});
