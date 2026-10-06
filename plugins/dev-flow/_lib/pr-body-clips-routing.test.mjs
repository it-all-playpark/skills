// _lib/pr-body-clips-routing.test.mjs
// PR 本文で builder が切った要約行と pr_sections の合計上限超過を、黙らせずに journal と終端サマリーへ出す経路を
// VM 実行で pin する（issue #815）。
//   (a) note / decision が clip された run → journal handoff の telemetry.pr_body_clips に件数、終端サマリーに
//       「PR 本文で切れた項目 N 件」節
//   (b) change bullet の clip も同じく数える
//   (c) pr_sections の markdown 合計が上限を超えた run → 切らずに PR 本文へ載せ、超過字数を journal と終端サマリーに出す
//   (d) clip が起きない run（長文は pr_sections で返した）→ telemetry キーも節も出さない

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
const LONG_NOTE = `対応表: ${Array.from({ length: 40 }, (_, i) => `item-${i + 1} → 移植済み`).join(' / ')}`;
const LONG_DECISION = { title: `references は ${'skills/daily-blog-factory/references/'.repeat(4)} に移す`, rationale: '移植先の構成に合わせる' };
const TABLE = ['| # | 項目 |', '|---|---|', ...Array.from({ length: 40 }, (_, i) => `| ${i + 1} | item-${i + 1} |`)].join('\n');

async function run(overrides) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'pr-body-clips');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const prPrompt = calls.find((c) => c.label === 'pr#1')?.prompt;
  const summaryPrompt = calls.find((c) => c.label === 'post-summary')?.prompt;
  assert.ok(prPrompt, 'PR phase が走っていない');
  assert.ok(summaryPrompt, '終端サマリーの投稿が走っていない');
  return { result, calls, prPrompt, summaryPrompt, telemetry: handoffTelemetry(calls) };
}

function handoffTelemetry(calls) {
  const save = calls.find((c) => c.label === 'journal-log');
  assert.ok(save, `journal handoff が呼ばれていない: ${calls.map((c) => c.label).join(', ')}`);
  const m = save.prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(m, 'journal-log prompt に JOURNAL_HANDOFF_BODY delimiter が無い');
  return JSON.parse(m[1]).telemetry ?? {};
}

test('[pr-body-clips] (a) note / decision が本文で切られた run は journal（telemetry.pr_body_clips）と終端サマリーに件数が出る', async () => {
  const { prPrompt, summaryPrompt, telemetry } = await run({
    'impl:serial:issue-1': impl({ pr_notes: [{ section: 'verification', text: LONG_NOTE }], design_decisions: [LONG_DECISION] }),
  });
  assert.ok(prPrompt.includes('- 検証: 対応表: item-1 → 移植済み'), 'note は本文に載る');
  assert.ok(!prPrompt.includes(LONG_NOTE), 'note は本文で切られている（前提）');
  assert.deepEqual(telemetry.pr_body_clips, { note: 1, decision: 1, change_bullet: 0, sections_over_chars: 0 }, JSON.stringify(telemetry));
  assert.ok(summaryPrompt.includes('### ✂️ PR 本文で切れた項目 2 件\n\n- 検証（pr_notes）: 1 件\n- 設計判断: 1 件\n'), `終端サマリーに節が無い: ${summaryPrompt}`);
  assert.ok(summaryPrompt.includes('表・長文は pr_sections で返せば切られずに載る'));
});

test('[pr-body-clips] (b) change bullet の clip も数える', async () => {
  const longFiles = Array.from({ length: 12 }, (_, i) => `src/very-long-component-file-name-${i}.ts`);
  const { telemetry, summaryPrompt } = await run({ 'impl:serial:issue-1': impl({ files: longFiles }) });
  assert.deepEqual(telemetry.pr_body_clips, { note: 0, decision: 0, change_bullet: 1, sections_over_chars: 0 }, JSON.stringify(telemetry));
  assert.ok(summaryPrompt.includes('### ✂️ PR 本文で切れた項目 1 件\n\n- 変更: 1 件\n'), summaryPrompt);
});

test('[pr-body-clips] (c) pr_sections の合計が上限を超えても切らずに載せ、超過字数を journal と終端サマリーに出す', async () => {
  const half = 'x'.repeat(PR_SECTIONS_MAX_CHARS / 2 + 50);
  const { prPrompt, telemetry, summaryPrompt } = await run({
    'impl:serial:issue-1': impl({ pr_sections: [{ heading: 'a', markdown: half }, { heading: 'b', markdown: half }] }),
  });
  assert.equal((prPrompt.match(new RegExp(half, 'g')) ?? []).length, 2, '上限超過でも pr_sections は切らずに本文へ載る');
  assert.deepEqual(telemetry.pr_body_clips, { note: 0, decision: 0, change_bullet: 0, sections_over_chars: 100 }, JSON.stringify(telemetry));
  assert.ok(summaryPrompt.includes('### ✂️ PR 本文の長文欄が上限超過\n\n- 長文欄（pr_sections）が合計上限を 100 字超過（切らずに載せた）'), summaryPrompt);
});

test('[pr-body-clips] (d) clip が起きない run（長文は pr_sections）は telemetry キーも終端サマリーの節も出さない', async () => {
  const { prPrompt, telemetry, summaryPrompt } = await run({
    'impl:serial:issue-1': impl({ pr_notes: [{ section: 'verification', text: '対応表は下の折りたたみ' }], pr_sections: [{ heading: '対応表', markdown: TABLE }] }),
  });
  assert.ok(prPrompt.includes(`<details><summary>対応表</summary>\n\n${TABLE}\n\n</details>`), '対応表は本文に載る');
  assert.ok(!('pr_body_clips' in telemetry), JSON.stringify(telemetry));
  assert.ok(!summaryPrompt.includes('✂️'), summaryPrompt);
});
