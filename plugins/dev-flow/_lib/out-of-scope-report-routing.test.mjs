// _lib/out-of-scope-report-routing.test.mjs
// 範囲外にした作業と人間側 follow-up が人間の目に届く経路を VM 実行で pin する（issue #793）。
//   (a) dev-implementer が out_of_scope[] を返すと、PR 本文（pr#1 prompt）と dev-flow 終端サマリー（post-summary prompt）の
//       「この PR に含めなかったもの」節にその項目がそのまま載る
//   (b) 差し戻し（reimpl）で out_of_scope を返さなければ前回分が残る / 返せば置き換わる
//   (c) out_of_scope が無い run は節を出さない
//   (d) nested pr-iterate が返した human_followups は dev-flow 終端サマリーの人間側 follow-up 節に出る

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const STANDARD = ['src/x.ts', 'src/y.ts', 'src/z.ts'];
const impl = (extra = {}) => ({ status: 'DONE', task_id: 'issue-1', files: [...STANDARD], summary: 's', concerns: [], ...extra });
const OOS_A = 'telemetry キー impl_retry_count の削除（issue 本文の「削除するもの」にあるが AC に無い）';
const OOS_B = 'dotfiles の excludedCommands から dev-flow-doctor を外す（worktree 外）';
const evalWith = (sat) => ({
  verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
  ac_results: sat.map((s, i) => ({ ac_index: i, satisfied: s, verified_by: 'inspection', evidence: s ? 'ok' : 'ng' })),
  security_clearance: [], concern_resolutions: [],
});

async function run(overrides, { workflow } = {}) {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    ...(workflow ? { workflow } : {}),
    extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: ['worker 数の上限を設定で変えられる', '上限超過は 429 を返す'] }) }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'out-of-scope-report');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const prPrompt = calls.find((c) => c.label === 'pr#1')?.prompt;
  const summaryPrompt = calls.find((c) => c.label === 'post-summary')?.prompt;
  assert.ok(prPrompt, 'PR phase が走っていない');
  assert.ok(summaryPrompt, '終端サマリーの投稿が走っていない');
  return { result, calls, prPrompt, summaryPrompt };
}

test('[out-of-scope] (a) implementer の out_of_scope[] が PR 本文と終端サマリーの「この PR に含めなかったもの」に載る', async () => {
  const { prPrompt, summaryPrompt } = await run({ 'impl:serial:issue-1': impl({ out_of_scope: [OOS_A, OOS_B] }) });
  assert.ok(prPrompt.includes(`## この PR に含めなかったもの\n- ${OOS_A}\n- ${OOS_B}`), `PR 本文に節が無い: ${prPrompt}`);
  assert.ok(prPrompt.indexOf('## この PR に含めなかったもの') < prPrompt.indexOf('Closes #1'), 'Closes 行より前に置く');
  assert.ok(summaryPrompt.includes(`### この PR に含めなかったもの\n\n- ${OOS_A}\n- ${OOS_B}`), `終端サマリーに節が無い: ${summaryPrompt}`);
});

test('[out-of-scope] (b) 差し戻しで out_of_scope を返さなければ前回分が残り、返せば置き換わる', async () => {
  const keep = await run({
    'impl:serial:issue-1': impl({ out_of_scope: [OOS_A] }),
    'eval#1': evalWith([false, true]),
    'reimpl#1:serial:issue-1': impl(),
    'eval#2': evalWith([true, true]),
  });
  assert.ok(keep.calls.some((c) => c.label === 'reimpl#1:serial:issue-1'), '差し戻しが走っていない');
  assert.ok(keep.prPrompt.includes(`- ${OOS_A}`), '空の差し戻しで前回の out_of_scope が落ちた');

  const replace = await run({
    'impl:serial:issue-1': impl({ out_of_scope: [OOS_A] }),
    'eval#1': evalWith([false, true]),
    'reimpl#1:serial:issue-1': impl({ out_of_scope: [OOS_B] }),
    'eval#2': evalWith([true, true]),
  });
  assert.ok(replace.prPrompt.includes(`- ${OOS_B}`));
  assert.ok(!replace.prPrompt.includes(OOS_A), '差し戻しが返した out_of_scope で置き換わっていない');
  assert.ok(replace.summaryPrompt.includes(`- ${OOS_B}`));
});

test('[out-of-scope] (c) out_of_scope が無い run は PR 本文にも終端サマリーにも節を出さない', async () => {
  const { prPrompt, summaryPrompt } = await run({});
  assert.ok(!prPrompt.includes('この PR に含めなかったもの'));
  assert.ok(!summaryPrompt.includes('この PR に含めなかったもの'));
  assert.ok(!summaryPrompt.includes('人間側 follow-up'));
});

test('[out-of-scope] (d) nested pr-iterate の human_followups は dev-flow 終端サマリーの人間側 follow-up 節に出る', async () => {
  const followup = { iter: 1, severity: 'major', topic: 'out', file: '~/ghq/github.com/acme/dotfiles/claude-code/settings.json', description: 'dotfiles 側の許可が無い', suggestion: '人間が足す' };
  const { summaryPrompt } = await run({}, { workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0, human_followups: [followup] }) });
  assert.ok(summaryPrompt.includes('### 👤 人間側 follow-up（worktree の外を指す指摘 — 自動修正の対象外・1 件）'), `終端サマリーに follow-up 節が無い: ${summaryPrompt}`);
  assert.ok(summaryPrompt.includes(`1. 🟠 major — \`${followup.file}\``));
  assert.ok(summaryPrompt.includes(followup.description));
});
