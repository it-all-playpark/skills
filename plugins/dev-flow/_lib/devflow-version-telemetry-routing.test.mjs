// F4: dev-flow.js の成功 handoff / 失敗 handoff（writeFailureTelemetry）に
// quality_model_config / plugin_version が配線されていることを静的に pin する（issue #601）。
// 併せて PLUGIN_VERSION 宣言が dev-flow.js / pr-iterate.js の双方でちょうど 1 回現れ、
// plugin.json の version と一致することを検証する。
//
// 他の *-routing.test.mjs と同様、workflow ソースを readFileSync で読み正規表現で静的検証する
// 手法を採る（VM 実行はしない）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');
const pluginJsonPath = join(repoRoot, '.claude-plugin/plugin.json');

const devFlowSrc = readFileSync(devFlowPath, 'utf8');
const prIterateSrc = readFileSync(prIteratePath, 'utf8');
const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));

const PLUGIN_VERSION_DECL_RE = /^const PLUGIN_VERSION = '([^']+)'$/m;

// (a) 成功 handoff（'dev-flow 完走' を subject に持つ buildJournalHandoffPayload 呼び出し）の
// telemetry object に quality_model_config / plugin_version の両方が配線されている。
test('dev-flow.js success handoff telemetry wires quality_model_config and plugin_version', () => {
  const idx = devFlowSrc.indexOf("subject: 'dev-flow 完走'");
  assert.ok(idx >= 0, "dev-flow.js に subject: 'dev-flow 完走' が見つかりません");
  const window = devFlowSrc.slice(Math.max(0, idx - 3000), idx);
  assert.match(
    window,
    /quality_model_config:\s*QUALITY_MODEL/,
    '成功 handoff の telemetry に quality_model_config: QUALITY_MODEL が配線されていません',
  );
  assert.match(
    window,
    /plugin_version:\s*PLUGIN_VERSION/,
    '成功 handoff の telemetry に plugin_version: PLUGIN_VERSION が配線されていません',
  );
});

// (b) writeFailureTelemetry 関数本体（次の runJournalHandoff( 呼び出しまで）に
// quality_model_config / plugin_version / ...telemetry の 3 要素が含まれる。
test('dev-flow.js writeFailureTelemetry wires quality_model_config, plugin_version and preserves ...telemetry spread', () => {
  const startIdx = devFlowSrc.indexOf('async function writeFailureTelemetry(');
  assert.ok(startIdx >= 0, 'dev-flow.js に async function writeFailureTelemetry( が見つかりません');
  const endIdx = devFlowSrc.indexOf('runJournalHandoff(', startIdx);
  assert.ok(endIdx >= 0, 'writeFailureTelemetry 以降に runJournalHandoff( 呼び出しが見つかりません');
  const body = devFlowSrc.slice(startIdx, endIdx);
  assert.match(
    body,
    /quality_model_config:\s*QUALITY_MODEL/,
    'writeFailureTelemetry の telemetry に quality_model_config: QUALITY_MODEL が配線されていません',
  );
  assert.match(
    body,
    /plugin_version:\s*PLUGIN_VERSION/,
    'writeFailureTelemetry の telemetry に plugin_version: PLUGIN_VERSION が配線されていません',
  );
  assert.match(
    body,
    /\.\.\.telemetry/,
    'writeFailureTelemetry の telemetry object に ...telemetry の spread が残っていません（呼び出し側キーが優先されなくなります）',
  );
});

// (c) dev-flow.js: PLUGIN_VERSION 宣言がちょうど 1 回現れ、plugin.json の version と一致する。
test('dev-flow.js declares PLUGIN_VERSION exactly once and it matches plugin.json version', () => {
  const matches = [...devFlowSrc.matchAll(new RegExp(PLUGIN_VERSION_DECL_RE, 'gm'))];
  assert.equal(
    matches.length,
    1,
    `dev-flow.js に const PLUGIN_VERSION = '...' 宣言がちょうど 1 回現れる必要があります（実際: ${matches.length} 回）`,
  );
  assert.equal(
    matches[0][1],
    pluginJson.version,
    `dev-flow.js の PLUGIN_VERSION ('${matches[0][1]}') が plugin.json の version ('${pluginJson.version}') と一致しません`,
  );
});

// (d) pr-iterate.js: 同様に PLUGIN_VERSION 宣言がちょうど 1 回現れ、plugin.json の version と一致する
// （両 workflow が同一 version を持つことの pin）。
test('pr-iterate.js declares PLUGIN_VERSION exactly once and it matches plugin.json version', () => {
  const matches = [...prIterateSrc.matchAll(new RegExp(PLUGIN_VERSION_DECL_RE, 'gm'))];
  assert.equal(
    matches.length,
    1,
    `pr-iterate.js に const PLUGIN_VERSION = '...' 宣言がちょうど 1 回現れる必要があります（実際: ${matches.length} 回）`,
  );
  assert.equal(
    matches[0][1],
    pluginJson.version,
    `pr-iterate.js の PLUGIN_VERSION ('${matches[0][1]}') が plugin.json の version ('${pluginJson.version}') と一致しません`,
  );
});
