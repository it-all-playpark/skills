// _lib/implement-mode.sync.test.mjs
// IMPLEMENT_MODE（Implement 経路切替、全 shape）が閉じた 2 値 enum であること、および
// dev-flow.js に inline 生成区間として存在すること（手書き const への置換・区間削除の検出）を pin する。
// 区間本文の byte 一致は _lib/workflow-inlines.sync.test.mjs が全区間について検証する。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IMPLEMENT_MODE } from './implement-mode.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

test("IMPLEMENT_MODE is 'fable' or 'planner'", () => {
  assert.ok(['fable', 'planner'].includes(IMPLEMENT_MODE), `IMPLEMENT_MODE must be 'fable' | 'planner', got: ${JSON.stringify(IMPLEMENT_MODE)}`);
});

test('dev-flow.js has exactly one _lib/implement-mode.mjs inline zone carrying the same value', () => {
  const begins = devFlowSrc.match(/^\/\/ ==== BEGIN inline: _lib\/implement-mode\.mjs .*====$/gm) ?? [];
  assert.equal(begins.length, 1, `implement-mode inline zone が ${begins.length} 個`);
  const consts = devFlowSrc.match(/^const IMPLEMENT_MODE = '(fable|planner)'$/gm) ?? [];
  assert.equal(consts.length, 1, `const IMPLEMENT_MODE 行が ${consts.length} 個（手書き複製・区間外定義は禁止）`);
  assert.equal(consts[0], `const IMPLEMENT_MODE = '${IMPLEMENT_MODE}'`, 'dev-flow.js の inline 値が canonical と一致しない（tools/sync-inlines.mjs --write を実行）');
});
