// _lib/pr-sections-trim-routing.test.mjs
// pr_sections の markdown 合計が PR_SECTIONS_MAX_CHARS を超えた run の経路を VM 実行で pin する（issue #815 / #928）。
//   (a) Evaluate より前に dev-implementer へ要約を 1 回だけ差し戻し、なお超過なら builder は切らずに PR 本文へ載せる
//   (b) 差し戻しで implementer が要約した pr_sections が前回分を置き換える

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';
import { PR_SECTIONS_MAX_CHARS } from './pr-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const STANDARD = ['src/x.ts', 'src/y.ts', 'src/z.ts'];
const impl = (extra = {}) => ({ status: 'DONE', task_id: 'issue-1', files: [...STANDARD], summary: 's', concerns: [], ...extra });
const TABLE = ['| # | 項目 |', '|---|---|', ...Array.from({ length: 40 }, (_, i) => `| ${i + 1} | item-${i + 1} |`)].join('\n');
const HALF = 'x'.repeat(PR_SECTIONS_MAX_CHARS / 2 + 50);
const OVER = [{ heading: 'a', markdown: HALF }, { heading: 'b', markdown: HALF }];

async function run(overrides) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'pr-sections-trim');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const prPrompt = calls.find((c) => c.label === 'pr#1')?.prompt;
  assert.ok(prPrompt, 'PR phase が走っていない');
  return { calls, prPrompt };
}

test('[pr-sections-trim] (a) pr_sections の合計が上限を超えたら Evaluate より前に implementer へ要約を 1 回差し戻し、なお超過なら切らずに載せる', async () => {
  const { prPrompt, calls } = await run({ 'impl:serial:issue-1': impl({ pr_sections: OVER }) });
  const trim = calls.filter((c) => c.label === 'sections-trim:serial:issue-1');
  assert.equal(trim.length, 1, `要約の差し戻しは 1 回だけ: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(trim[0].prompt.includes('"pr_sections_over_limit":{"total_chars":' + (PR_SECTIONS_MAX_CHARS + 100)), trim[0].prompt);
  assert.ok(calls.findIndex((c) => c.label === 'sections-trim:serial:issue-1') < calls.findIndex((c) => c.label.startsWith('eval')), 'Evaluate より前に差し戻す');
  assert.equal((prPrompt.match(new RegExp(HALF, 'g')) ?? []).length, 2, '差し戻し後も超過なら pr_sections は切らずに本文へ載る');
});

test('[pr-sections-trim] (b) 差し戻しで implementer が要約した pr_sections が前回分を置き換える', async () => {
  const { prPrompt } = await run({
    'impl:serial:issue-1': impl({ pr_sections: OVER }),
    'sections-trim:serial:issue-1': impl({ pr_sections: [{ heading: '対応表', markdown: TABLE }] }),
  });
  assert.ok(prPrompt.includes(`<details><summary>対応表</summary>\n\n${TABLE}\n\n</details>`), '要約後の対応表が載る');
  assert.ok(!prPrompt.includes(HALF), '超過していた前回分は載らない');
});
