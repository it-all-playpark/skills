// issue #445 F2: dev-flow.js の subagent 起動数カウント（trackedAgent wrapper）配線を
// 検証する実行ベース統合テスト。
//
// devflow-duration-telemetry.test.mjs / devflow-journal-log.test.mjs の makeSandbox 実装を
// 同型コピーする repo precedent に倣い、agentStub の応答分岐は本ファイル内に複製する。
// VM sandbox 実行部分は共通ヘルパー _lib/test-helpers/vm-sandbox.mjs の
// makeRecordingSandbox / runDevFlowInSandbox を再利用する（calls 配列で agent() 呼び出しを
// 記録済みのため、journal-log 呼び出し直前までの累積呼び出し数を calls の index からそのまま
// 取得できる）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// standard 経路に落ちる req（count=3, ac=4件, type='feat' → floor='standard'）。
// LITE route（TRIVIAL 前提）に入らず、workflow('pr-iterate') を経由してフル経路を通す
// （devflow-journal-log.test.mjs / devflow-duration-telemetry.test.mjs と同一 fixture）。
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

/**
 * agentStub 応答分岐（devflow-journal-log.test.mjs の makeSandbox と同型コピー）。
 * makeRecordingSandbox の responder シグネチャ（{label, agentType, prompt} => 値、同期関数）に
 * 合わせて素の関数として実装する。
 *
 * @param {string[]} journalPrompts - journal-log 呼び出しの prompt を捕捉する配列
 * @returns {(opts: {label: string, agentType: string, prompt: string}) => unknown}
 */
function makeResponder(journalPrompts) {
  return ({ label, agentType, prompt }) => {
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    }
    if (label.startsWith('analyze')) {
      return ANALYZE_REQ;
    }
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [], parallel: [] };
    }
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
      };
    }
    if (agentType === 'dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'https://github.com/acme/skills/pull/1', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    if (label === 'post-summary') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save' && agentType === 'dev-runner-haiku') {
      journalPrompts.push(prompt);
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    if (label === 'journal-log' && agentType === 'dev-runner-haiku') {
      return { logged: true, summary: 'ok' };
    }
    if (agentType === 'implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    if (label === 'issue-meta') {
      return { ok: true, number: 1, title: 'stub-issue-title' };
    }
    return null;
  };
}

/**
 * journal-save (stage1, issue #494) prompt から `<<<HANDOFF_DATA_BEGIN>>>`〜`END` 区間の JSON を
 * 抽出して parse する（journal-log (stage2) はファイルパスのみを扱い payload literal を含まない）。
 * @param {string} prompt
 * @returns {object}
 */
function parseJournalHandoffPayload(prompt) {
  const match = prompt.match(/<<<HANDOFF_DATA_BEGIN>>>\n([\s\S]*?)\n<<<HANDOFF_DATA_END>>>/);
  assert.ok(match, `journal-save prompt に HANDOFF_DATA delimiter が見つからない。prompt:\n${prompt}`);
  return JSON.parse(match[1]);
}

test('[subagent-invocations] journal handoff の subagent_invocations.total は journal-log 呼び出し直前までの累積呼び出し数と一致し、by_type 合計 = total', async () => {
  const journalPrompts = [];
  const { ctx, calls } = makeRecordingSandbox(makeResponder(journalPrompts));

  const error = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // issue #494: telemetry payload は journal-save (stage1) の呼び出し直前に JS 側で構築される
  // ため、subagent_invocations.total は journal-save の calls 配列 index と一致する。
  const journalIdx = calls.findIndex((c) => c.label === 'journal-save');
  assert.ok(journalIdx >= 0, 'journal-save 呼び出しが発生しなかった');

  const capturedPrompt = journalPrompts[0] ?? '';
  const payload = parseJournalHandoffPayload(capturedPrompt);
  const inv = payload.telemetry?.subagent_invocations;
  assert.ok(inv, 'telemetry.subagent_invocations が journal handoff payload に存在しない');

  assert.equal(
    inv.total,
    journalIdx,
    `subagent_invocations.total (${inv.total}) は journal-log 呼び出し直前までの累積呼び出し数 ` +
    `(calls 配列中の journal-log の index = ${journalIdx}) と一致するべき`,
  );

  const byTypeSum = Object.values(inv.by_type ?? {}).reduce((a, b) => a + b, 0);
  assert.equal(byTypeSum, inv.total, 'by_type の値の合計は total と一致するべき');
});

test('[subagent-invocations] nested pr-iterate の subagent_invocations（total=3, by_type={pr-reviewer:1, dev-runner-haiku:2}）が dev-flow run 合計へ合算される', async () => {
  const journalPrompts = [];
  const responder = makeResponder(journalPrompts);
  const { ctx, calls } = makeRecordingSandbox(responder, {
    workflow: async () => ({
      status: 'lgtm',
      fixes_applied: 0,
      subagent_invocations: { total: 3, by_type: { 'pr-reviewer': 1, 'dev-runner-haiku': 2 } },
    }),
  });

  const error = await runDevFlowInSandbox(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // issue #494: telemetry payload は journal-save (stage1) の呼び出し直前に JS 側で構築される
  // ため、subagent_invocations.total は journal-save の calls 配列 index と一致する。
  const journalIdx = calls.findIndex((c) => c.label === 'journal-save');
  assert.ok(journalIdx >= 0, 'journal-save 呼び出しが発生しなかった');

  const capturedPrompt = journalPrompts[0] ?? '';
  const payload = parseJournalHandoffPayload(capturedPrompt);
  const inv = payload.telemetry?.subagent_invocations;
  assert.ok(inv, 'telemetry.subagent_invocations が journal handoff payload に存在しない');

  // 自 run の own 呼び出し数（journalIdx）+ nested pr-iterate の total(3) が合算されているべき
  assert.equal(
    inv.total,
    journalIdx + 3,
    `合算後 total (${inv.total}) は own 呼び出し数 (${journalIdx}) + nested total(3) と一致するべき`,
  );

  // standard 経路（LITE route 非該当）では own run 側に agentType:'pr-reviewer' 呼び出しは
  // 発生しない（'pr-reviewer' は LITE route の pr-review-lite でのみ使われる）ため、
  // 合算後は nested の 1 件のみになるはず。
  assert.equal(
    inv.by_type['pr-reviewer'],
    1,
    `by_type['pr-reviewer'] は nested pr-iterate 由来の 1 のみであるべきだが ${inv.by_type['pr-reviewer']} だった`,
  );

  // 'dev-runner-haiku' は own run 側でも複数回使われるため、own run の実測回数 + nested の 2 と一致するべき。
  // journal-log 自身も agentType:'dev-runner-haiku' だが、payload 構築時点ではまだ SUBAGENT_COUNTS に
  // 計上されていない（trackedAgent は呼び出し前に計上するが、journal-log 呼び出しはこの後）ため、
  // calls 配列中 journalIdx より前（= payload 構築時点までに実際に起きた own 呼び出し）のみを数える。
  const ownDevRunnerHaikuCount = calls
    .filter((c, idx) => idx < journalIdx && c.agentType === 'dev-runner-haiku')
    .length;
  assert.equal(
    inv.by_type['dev-runner-haiku'],
    ownDevRunnerHaikuCount + 2,
    `by_type['dev-runner-haiku'] (${inv.by_type['dev-runner-haiku']}) は own run 実測回数 ` +
    `(${ownDevRunnerHaikuCount}) + nested の 2 と一致するべき`,
  );
});
