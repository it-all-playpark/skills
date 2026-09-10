// top-level abort handoff のルーティングテスト（issue #607）。
// pr-iterate.js にも dev-flow.js と同種の穴があった（handoff は終端 1 箇所のみで、isolation probe の
// fail-closed throw 等の handoff 到達前の例外で telemetry が全損する）ため、同機構
// （top-level try/catch + journal-log-abort）で同時に塞いだ。makeSandbox / runPrIterateCapture は
// priterate-journal-log.test.mjs のパターンを踏襲し、isolationProbeResult / journalSaveThrows
// オプションと 'journal-log-abort' stub を追加する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');

function makeSandbox({ isolationProbeResult, journalSaveThrows } = {}) {
  const calls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    // pr-meta: repo/cwd probe。isoWt=/tmp/wt, repo=acme/skills を確定させる。
    if (label === 'pr-meta' && agentType === 'dev-flow:dev-runner-haiku-ro') {
      return { url: 'https://github.com/acme/skills/pull/5', cwd: '/tmp/wt' };
    }

    // isolation cleanup: 常に成功させる（probe 成立への影響を排除）。
    if (label === 'isolation-cleanup' && agentType === 'dev-flow:dev-runner-haiku') {
      return { cleaned: true };
    }

    // isolation probe: 既定は書き込み成功。isolationProbeResult が指定されればそれを返す。
    if (label === 'isolation-probe' && agentType === 'dev-flow:dev-runner-haiku-wo') {
      return isolationProbeResult ?? { written: true };
    }

    // pr-reviewer: 1 round で LGTM へ（isolation probe が通った場合の完走経路用）
    if (agentType === 'dev-flow:pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }

    // 投稿系
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }

    // journal-save (stage1): 通常終端・abort 終端の双方で共有する call site。
    if (label === 'journal-save' && agentType === 'dev-flow:dev-runner-haiku') {
      if (journalSaveThrows) throw new Error('journal-save boom');
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }

    // journal-log (stage2, 通常終端)
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      return { logged: true, summary: 'ok' };
    }

    // journal-log-abort (stage2, abort 終端)
    if (label === 'journal-log-abort' && agentType === 'dev-flow:dev-runner-haiku') {
      return { logged: true, summary: 'ok' };
    }

    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm' });

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    args: '5',
    console, JSON, Math, String, Number, Boolean, Array, Object, Error,
    RegExp, Promise, Symbol, Map, Set, Date,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

async function runPrIterateCapture(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/pr-iterate.js' });
    if (resultPromise && typeof resultPromise.then === 'function') {
      resolvedResult = await resultPromise.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { result: resolvedResult, error: caughtError };
}

const src = readFileSync(prIteratePath, 'utf8');

// ============================================================
// (1) isolation probe fail-closed
// ============================================================
test("[abort-telemetry] (1) isolation probe fail-closed（written:false）→ run が throw し abort entry 1 件", async () => {
  const { ctx, calls } = makeSandbox({
    isolationProbeResult: { written: false, error: "parent bg session hasn't isolated" },
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.ok(error !== null, '(1) isolation probe fail-closed で run が throw すべきだが error が null だった');
  assert.ok(/isolation/i.test(String(error?.message ?? '')),
    `(1) error.message に isolation 系メッセージを含むべきだが: ${error?.message}`);

  const saveCalls = calls.filter((c) => c.label === 'journal-save' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(1) journal-save は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of [
    '"skill":"pr-iterate"', '"outcome":"failure"', '"error_category":"abort"',
    '"error_msg":"abort@Iterate/isolation-probe: ', '"error_phase":"Iterate"',
    '"abort_label":"isolation-probe"', '"merge_tier":"PR_ITERATE"', '"iterate_rounds":0',
    '"pr_number":5', '"args":"pr=5"', '"repo":"acme/skills"',
  ]) {
    assert.ok(savePrompt.includes(key),
      `(1) journal-save prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 900)}`);
  }
  assert.ok(savePrompt.includes('/tmp/wt/.devflow-tmp/payload-priterate-5-abort.json'),
    `(1) journal-save prompt に abort savePath が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 900)}`);

  const logAbortCalls = calls.filter((c) => c.label === 'journal-log-abort' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(logAbortCalls.length, 1, `(1) journal-log-abort は 1 回のはずだが ${logAbortCalls.length} 回だった`);
  const logAbortPrompt = logAbortCalls[0]?.prompt ?? '';
  assert.ok(logAbortPrompt.includes('/tmp/wt/.devflow-tmp/payload-priterate-5-abort.json'),
    `(1) journal-log-abort prompt に abort savePath が含まれるべきだが含まれていなかった。prompt:\n${logAbortPrompt.slice(0, 900)}`);
  assert.ok(!logAbortPrompt.includes('"error_category"'),
    `(1) journal-log-abort prompt に結論値リテラル '"error_category"' が含まれるべきではないが含まれていた。prompt:\n${logAbortPrompt.slice(0, 900)}`);

  const logCalls = calls.filter((c) => c.label === 'journal-log' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(logCalls.length, 0, `(1) 通常終端の journal-log は 0 回のはずだが ${logCalls.length} 回だった`);
});

// ============================================================
// (2) fail-open: journal-save 自体が throw しても元の例外は変わらない
// ============================================================
test('[abort-telemetry] (2) fail-open: journal-save stub が throw しても元の isolation エラーを rethrow し journal-log-abort は 0 回', async () => {
  const { ctx, calls } = makeSandbox({
    isolationProbeResult: { written: false, error: "parent bg session hasn't isolated" },
    journalSaveThrows: true,
  });

  const { error } = await runPrIterateCapture(src, ctx);

  assert.ok(error !== null, '(2) error が null だった');
  assert.ok(/isolation/i.test(String(error?.message ?? '')),
    `(2) handoff 自体の失敗で元の例外が置き換わってはならないが: ${error?.message}`);

  const logAbortCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logAbortCalls.length, 0, `(2) journal-save が失敗した場合 journal-log-abort は 0 回のはずだが ${logAbortCalls.length} 回だった`);
});

// ============================================================
// (3) lgtm 完走（回帰）
// ============================================================
test('[abort-telemetry] (3) lgtm 完走経路: journal-log-abort が 0 回・journal-log が 1 回・journal_log_status===logged', async () => {
  const { ctx, calls } = makeSandbox();

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const logAbortCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logAbortCalls.length, 0, `(3) lgtm 完走では journal-log-abort は 0 回のはずだが ${logAbortCalls.length} 回だった`);

  const logCalls = calls.filter((c) => c.label === 'journal-log' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(logCalls.length, 1, `(3) journal-log は 1 回のはずだが ${logCalls.length} 回だった`);

  assert.equal(result?.journal_log_status, 'logged',
    `(3) lgtm 完走では result.journal_log_status は 'logged' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});

// ============================================================
// (4) 静的 pin
// ============================================================
test('[abort-telemetry] (4) 静的 pin: ABORT_CTX 宣言 / try 開始位置 / iterate_rounds 反映 / 末尾 catch+rethrow', () => {
  assert.equal((src.match(/const ABORT_CTX = \{/g) ?? []).length, 1,
    `(4) 'const ABORT_CTX = {' は 1 回のみのはずだが ${(src.match(/const ABORT_CTX = \{/g) ?? []).length} 回だった`);

  const cwdLogIdx = src.indexOf("if (!prMeta?.cwd) log(");
  assert.ok(cwdLogIdx >= 0, `(4) isoWt 確定直後の cwd 警告 log 行が見つからなかった`);
  const cwdLogLineEnd = src.indexOf('\n', cwdLogIdx);
  const tryIdx = src.indexOf('try {', cwdLogIdx);
  assert.ok(tryIdx >= 0, `(4) cwd 警告 log 行以降に 'try {' が見つからなかった`);
  assert.ok(tryIdx - cwdLogLineEnd <= 2,
    `(4) 'try {' は cwd 警告 log 行の直後（2 行以内）にあるべきだが、離れた位置にあった（cwdLogLineEnd=${cwdLogLineEnd}, tryIdx=${tryIdx}）`);

  const isolationInlineEndIdx = src.indexOf('// ==== END inline: _lib/isolation-probe.mjs ====');
  assert.ok(isolationInlineEndIdx >= 0, `(4) isolation-probe.mjs inline END marker が見つからなかった`);
  assert.ok(isolationInlineEndIdx < tryIdx,
    `(4) isolation-probe.mjs の inline 区間は try の外にあるべき（END marker index=${isolationInlineEndIdx} < try index=${tryIdx}）`);

  assert.ok(src.includes('ABORT_CTX.iterate_rounds = i'),
    `(4) ループ内で 'ABORT_CTX.iterate_rounds = i' の反映が見つからなかった`);

  const lastCatchIdx = src.lastIndexOf('} catch (e) {');
  assert.ok(lastCatchIdx >= 0, `(4) 末尾の '} catch (e) {' ブロックが見つからなかった`);
  const tailBlock = src.slice(lastCatchIdx);
  assert.ok(tailBlock.includes('throw e'),
    `(4) 最終 '} catch (e) {' ブロック内に 'throw e' が含まれるべきだが含まれていなかった`);
});
