// _lib/workflow-post-helpers.test.mjs
// Unit tests for workflow-post-helpers canonical.
//
// TDD-first: これらのテストが GREEN になることで canonical の仕様適合を保証する。
// node --test _lib/workflow-post-helpers.test.mjs で実行。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bodySaveInstr, POST_RESULT, JOURNAL_RESULT } from './workflow-post-helpers.mjs';

const SAMPLE_BODY = '## PR サマリー\n\nこれはサンプル本文です。\n```js\nconst x = 1;\n```';

// -----------------------------------------------------------------------
// bodySaveInstr: dev-flow パラメータ（'dev-flow', 'DEV_FLOW'）
// -----------------------------------------------------------------------

test('bodySaveInstr(body, "dev-flow", "DEV_FLOW") — 現行 dev-flow.js 版とバイト一致', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'dev-flow', 'DEV_FLOW');
  const expected = `## 本文の保存\n`
    + `まず Bash で \`mktemp "\${TMPDIR:-/tmp}/dev-flow-XXXXXX.md"\` を実行して一時ファイルを作成し、\n`
    + `そのパスを <BODY_FILE> とする。次に **Write tool** を使い、下記 delimiter 内の本文を\n`
    + `**一字一句そのまま** <BODY_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。backtick やコードフェンスを\n`
    + `エスケープ・改変しないこと。以降のコマンドの \`--body-file\` には <BODY_FILE> を指定する。\n`
    + `<<<DEV_FLOW_BODY_BEGIN>>>\n${SAMPLE_BODY}\n<<<DEV_FLOW_BODY_END>>>\n\n`;
  assert.equal(result, expected);
});

test('bodySaveInstr(body, "dev-flow", "DEV_FLOW") — mktemp "${TMPDIR:-/tmp}/dev-flow-XXXXXX.md" を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'dev-flow', 'DEV_FLOW');
  assert.ok(
    result.includes('${TMPDIR:-/tmp}/dev-flow-XXXXXX.md'),
    'mktemp "${TMPDIR:-/tmp}/dev-flow-XXXXXX.md" パターンが存在しない',
  );
});

test('bodySaveInstr(body, "dev-flow", "DEV_FLOW") — DEV_FLOW delimiter を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'dev-flow', 'DEV_FLOW');
  assert.ok(
    result.includes(`<<<DEV_FLOW_BODY_BEGIN>>>\n${SAMPLE_BODY}\n<<<DEV_FLOW_BODY_END>>>`),
    '<<<DEV_FLOW_BODY_BEGIN/END>>> delimiter が存在しない',
  );
});

test('bodySaveInstr(body, "dev-flow", "DEV_FLOW") — "Write tool" 安全文言を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'dev-flow', 'DEV_FLOW');
  assert.ok(
    result.includes('Write tool'),
    '"Write tool" という injection 対策文言が存在しない',
  );
});

test('bodySaveInstr(body, "dev-flow", "DEV_FLOW") — shell（echo/printf/heredoc）へ渡さない 安全文言を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'dev-flow', 'DEV_FLOW');
  assert.ok(
    result.includes('shell（echo/printf/heredoc 等）へ'),
    '"shell（echo/printf/heredoc 等）へ" という injection 対策文言が存在しない',
  );
});

// -----------------------------------------------------------------------
// bodySaveInstr: pr-iterate パラメータ（'pr-iterate', 'PR_ITERATE'）
// -----------------------------------------------------------------------

test('bodySaveInstr(body, "pr-iterate", "PR_ITERATE") — 現行 pr-iterate.js 版とバイト一致', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'pr-iterate', 'PR_ITERATE');
  const expected = `## 本文の保存\n`
    + `まず Bash で \`mktemp "\${TMPDIR:-/tmp}/pr-iterate-XXXXXX.md"\` を実行して一時ファイルを作成し、\n`
    + `そのパスを <BODY_FILE> とする。次に **Write tool** を使い、下記 delimiter 内の本文を\n`
    + `**一字一句そのまま** <BODY_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。backtick やコードフェンスを\n`
    + `エスケープ・改変しないこと。以降のコマンドの \`--body-file\` には <BODY_FILE> を指定する。\n`
    + `<<<PR_ITERATE_BODY_BEGIN>>>\n${SAMPLE_BODY}\n<<<PR_ITERATE_BODY_END>>>\n\n`;
  assert.equal(result, expected);
});

test('bodySaveInstr(body, "pr-iterate", "PR_ITERATE") — mktemp "${TMPDIR:-/tmp}/pr-iterate-XXXXXX.md" を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'pr-iterate', 'PR_ITERATE');
  assert.ok(
    result.includes('${TMPDIR:-/tmp}/pr-iterate-XXXXXX.md'),
    'mktemp "${TMPDIR:-/tmp}/pr-iterate-XXXXXX.md" パターンが存在しない',
  );
});

test('bodySaveInstr(body, "pr-iterate", "PR_ITERATE") — PR_ITERATE delimiter を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'pr-iterate', 'PR_ITERATE');
  assert.ok(
    result.includes(`<<<PR_ITERATE_BODY_BEGIN>>>\n${SAMPLE_BODY}\n<<<PR_ITERATE_BODY_END>>>`),
    '<<<PR_ITERATE_BODY_BEGIN/END>>> delimiter が存在しない',
  );
});

test('bodySaveInstr(body, "pr-iterate", "PR_ITERATE") — "Write tool" 安全文言を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'pr-iterate', 'PR_ITERATE');
  assert.ok(
    result.includes('Write tool'),
    '"Write tool" という injection 対策文言が存在しない',
  );
});

test('bodySaveInstr(body, "pr-iterate", "PR_ITERATE") — shell（echo/printf/heredoc）へ渡さない 安全文言を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, 'pr-iterate', 'PR_ITERATE');
  assert.ok(
    result.includes('shell（echo/printf/heredoc 等）へ'),
    '"shell（echo/printf/heredoc 等）へ" という injection 対策文言が存在しない',
  );
});

// -----------------------------------------------------------------------
// POST_RESULT schema
// -----------------------------------------------------------------------

test('POST_RESULT — type は "object"', () => {
  assert.equal(POST_RESULT.type, 'object');
});

test('POST_RESULT — required は ["posted"] のみ', () => {
  assert.deepEqual(POST_RESULT.required, ['posted']);
});

test('POST_RESULT — properties に posted がある', () => {
  assert.ok('posted' in POST_RESULT.properties, 'POST_RESULT.properties.posted が存在しない');
});

test('POST_RESULT — properties に method がある', () => {
  assert.ok('method' in POST_RESULT.properties, 'POST_RESULT.properties.method が存在しない');
});

test('POST_RESULT — properties に url がある', () => {
  assert.ok('url' in POST_RESULT.properties, 'POST_RESULT.properties.url が存在しない');
});

// -----------------------------------------------------------------------
// JOURNAL_RESULT schema
// -----------------------------------------------------------------------

test('JOURNAL_RESULT — type は "object"', () => {
  assert.equal(JOURNAL_RESULT.type, 'object');
});

test('JOURNAL_RESULT — required は ["logged"] のみ', () => {
  assert.deepEqual(JOURNAL_RESULT.required, ['logged']);
});

test('JOURNAL_RESULT — properties に logged がある', () => {
  assert.ok('logged' in JOURNAL_RESULT.properties, 'JOURNAL_RESULT.properties.logged が存在しない');
});

test('JOURNAL_RESULT — properties に summary がある', () => {
  assert.ok('summary' in JOURNAL_RESULT.properties, 'JOURNAL_RESULT.properties.summary が存在しない');
});
