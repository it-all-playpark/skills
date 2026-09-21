// guard-blocked-routing.test.mjs
// dev-flow.js の execImplementPhase native wiring（issue #448 F3）を VM sandbox で検証する
// （issue #673 で dev-implement-fable 一本の経路に追随）。
//
// 検証対象:
// (a) guard_blocked は replan ループ（reimpl-blocked#b）を 0 回にし、blockSeen へ approach_mismatch
//     findings を一切残さず、evaluator の focus_areas に guard_blocked(<task_id>) 接頭辞の concern を
//     到達させる
// (b) blocking_reason が注入される下流（dev-implement-fable の再 spawn prompt / evaluator prompt）に
//     迂回語彙（fetch|FETCH_HEAD|mirror|checkout）が一切現れない
//     （run wf_17d7a7be 相当の実迂回コマンド列 fixture を使用）
// (c) journal handoff payload（journal-save prompt）に error_category:guard_blocked と guard_id が到達する
// (d) approach_mismatch → guard_blocked の順で返る run: approach 側のみ reimpl-blocked#1 が発火し
//     その prompt にスクラブ済み finding が 1 件入り、guard_blocked で b=2 は発火しない
// (e) 旧 string blocking_reason を返す stub は partition throw で明示 error になる

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const FABLE = 'dev-flow:dev-implement-fable';

// run wf_17d7a7be 相当の実迂回コマンド列 fixture（issue #448 の実害）。
const EVASION_COMMAND_FIXTURE =
  'git clone --mirror https://github.com/it-all-playpark/skills /tmp/m && '
  + 'git -C <wt> fetch /tmp/m && '
  + 'git checkout FETCH_HEAD -- .claude/workflows/dev-flow.js';

const EVASION_VOCAB_RE = /fetch|FETCH_HEAD|mirror|checkout/i;

const STANDARD_REQ = {
  summary: 's', acceptance_criteria: ['a', 'b', 'c', 'd'], issue_type: 'fix', scope: 'src',
  estimated_change_file_count: 4, shape: 'standard', issue_number: 1, issue_title: 'stub-issue-title',
};

const guardBlocked = {
  status: 'BLOCKED', task_id: 'issue-1', files: [], summary: '', concerns: [],
  blocking_reason: { block_class: 'guard_blocked', guard_id: 'inline-edit-guard', detail: EVASION_COMMAND_FIXTURE },
};

async function run(overrides) {
  const journalPrompts = [];
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'analyze#1': STANDARD_REQ,
      'journal-save': ({ prompt }) => { journalPrompts.push(prompt); return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' }; },
      ...overrides,
    },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'guard-blocked-routing');
  return { calls, result, error, journalPrompts };
}

// blocking_reason が注入される下流: 再 spawn prompt（reimpl-blocked#b）と evaluator prompt
const injectionCalls = (calls) => calls.filter((c) => (c.agentType === FABLE && c.label.startsWith('reimpl-blocked#')) || c.agentType === 'dev-flow:evaluator');

// ============================================================
// (a)+(b)+(c): 単一 task が guard_blocked
// ============================================================
test('[guard-blocked-routing] guard_blocked: reimpl-blocked 0回・findings非登録・evaluator focus_areas到達・迂回語彙非混入・telemetry到達', async () => {
  const { calls, result, error, journalPrompts } = await run({ 'impl:serial:issue-1': guardBlocked });
  assert.equal(error, null, `guard_blocked のみの run は throw しないはずだが: ${error?.message}`);

  // (a) reimpl-blocked#b の呼び出しが 0 回
  const replanCalls = calls.filter((c) => c.label.startsWith('reimpl-blocked'));
  assert.equal(replanCalls.length, 0, `guard_blocked task は reimpl-blocked を発火しないはずだが ${replanCalls.length} 回発火した`);

  // (a) 全 dev-implement-fable prompt に approach_mismatch findings が現れない（blockSeen 非登録の検証）
  for (const c of calls.filter((c) => c.agentType === FABLE)) {
    assert.ok(!c.prompt.includes('"dimension":"approach_mismatch"'), `prompt(label=${c.label}) に approach_mismatch findings が混入している: ${c.prompt.slice(0, 300)}`);
  }

  // (a) evaluator prompt の focus_areas に guard_blocked(<task_id>) 接頭辞の concern が到達する
  const evalCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(evalCalls.length >= 1, 'evaluator 呼び出しが 1 回以上あるはず');
  assert.ok(evalCalls[0].prompt.includes('guard_blocked(issue-1)[guard=inline-edit-guard]'),
    `evaluator prompt に guard_blocked(issue-1) 接頭辞の concern が含まれるべきだが:\n${evalCalls[0].prompt.slice(0, 800)}`);

  // (b) 下流 prompt に迂回語彙が一切現れない
  const inj = injectionCalls(calls);
  assert.ok(inj.length >= 1, 'evaluator の呼び出しが 1 回以上あるはず');
  for (const c of inj) {
    assert.equal(EVASION_VOCAB_RE.test(c.prompt), false, `prompt(label=${c.label}, agentType=${c.agentType}) に迂回語彙が混入している: ${c.prompt.slice(0, 400)}`);
  }

  // (c) journal handoff payload に error_category:guard_blocked と guard_id が到達する
  assert.equal(journalPrompts.length, 1, `journal-save(success) は 1 回のはずだが ${journalPrompts.length} 回だった`);
  assert.ok(journalPrompts[0].includes('"error_category":"guard_blocked"'), `journal payload に "error_category":"guard_blocked" が含まれるべきだが:\n${journalPrompts[0].slice(0, 800)}`);
  assert.ok(journalPrompts[0].includes('"guard_id":"inline-edit-guard"'), `journal payload に "guard_id":"inline-edit-guard" が含まれるべきだが:\n${journalPrompts[0].slice(0, 800)}`);

  assert.ok(result?.pr_url != null, `完走経路では result.pr_url が存在するべきだが ${JSON.stringify(result?.pr_url)} だった`);
});

// ============================================================
// (d): approach_mismatch → guard_blocked の順で返る run
// ============================================================
test('[guard-blocked-routing] approach_mismatch → guard_blocked: approach 側のみ reimpl-blocked#1 が発火しスクラブ済み finding が入り、guard_blocked で b=2 は発火しない', async () => {
  const { calls, error } = await run({
    'impl:serial:issue-1': {
      status: 'BLOCKED', task_id: 'issue-1', files: [], summary: '', concerns: [],
      blocking_reason: { block_class: 'approach_mismatch', detail: 'patch-api approach failed' },
    },
    'reimpl-blocked#1:serial:issue-1': guardBlocked,
  });
  assert.equal(error, null, `mixed approach/guard run は throw しないはずだが: ${error?.message}`);

  const replanCalls = calls.filter((c) => c.label.startsWith('reimpl-blocked'));
  assert.deepEqual(replanCalls.map((c) => c.label), ['reimpl-blocked#1:serial:issue-1'], `approach_mismatch のみ reimpl-blocked#1 を 1 回発火すべきだが: ${replanCalls.map((c) => c.label).join(', ')}`);
  assert.equal(replanCalls[0].agentType, FABLE, `reimpl-blocked#1 の agentType が ${replanCalls[0].agentType}`);
  assert.ok(replanCalls[0].prompt.includes('patch-api approach failed'), `reimpl-blocked#1 prompt にスクラブ済み finding が含まれるべきだが:\n${replanCalls[0].prompt.slice(0, 800)}`);
  const findingCount = (replanCalls[0].prompt.match(/"dimension":"approach_mismatch"/g) || []).length;
  assert.equal(findingCount, 1, `reimpl-blocked#1 prompt の approach_mismatch findings は 1 件のみのはずだが ${findingCount} 件だった`);

  const evalCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(evalCalls.length >= 1, 'evaluator 呼び出しが 1 回以上あるはず');
  assert.ok(evalCalls[0].prompt.includes('guard_blocked(issue-1)[guard=inline-edit-guard]'), 'evaluator prompt に guard_blocked concern が到達していない');
  for (const c of injectionCalls(calls)) {
    assert.equal(EVASION_VOCAB_RE.test(c.prompt), false, `prompt(label=${c.label}, agentType=${c.agentType}) に迂回語彙が混入している: ${c.prompt.slice(0, 400)}`);
  }
});

// ============================================================
// (e): 旧 string blocking_reason を返す stub は throw で明示 error
// ============================================================
test('[guard-blocked-routing] 旧 string blocking_reason: partition throw が明示 error として伝播する', async () => {
  const { error } = await run({
    'impl:serial:issue-1': { status: 'BLOCKED', task_id: 'issue-1', files: [], summary: '', concerns: [], blocking_reason: 'free text blocked' },
  });
  assert.ok(error !== null, '旧 string blocking_reason は throw で検出されるべきだが error が null だった');
});
