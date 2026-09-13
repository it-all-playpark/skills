/**
 * vm-sandbox.mjs — VM sandbox ハーネス共有モジュール
 *
 * green-fix 系 4 ファイルで byte 完全一致していた sandbox ヘルパーを抽出した共有モジュール。
 * 差分（agentStub の返り値ロジック）は呼び出し側の responder 関数に委譲する。
 *
 * Export:
 *   - JS_GLOBALS: VM sandbox に expose する 15 個の JS 組み込みをまとめた object
 *   - makeRecordingSandbox(responder, extraSandbox?): {ctx, calls, logs, phases} を返す
 *     （calls の各要素は {label, agentType, prompt, opts, schema}。opts は agent() に渡された
 *     opts をそのまま、schema は opts?.schema ?? null）
 *   - devFlowArgs(issue?, setupOverrides?): dev-flow.js 用 args の既定形（{issue, setup}）を返す
 *     （setup は dev-flow-prerun の stdout JSON と同形）
 *   - runDevFlowInSandbox(src, ctx): dev-flow.js ソースを strip して sandbox 実行する
 *   - runWorkflowCapture(src, ctx, filename?): strip + wrap + vm 実行し {result, error} を返す
 *     （dev-flow.js / pr-iterate.js 共用。filename 既定は '.claude/workflows/dev-flow.js'）
 *   - assertNoCrash(error, name): error が ReferenceError/SyntaxError なら assert.fail する
 *   - devFlowResponder(overrides?, {issue?}?): dev-flow.js 標準経路（shape 'standard'）の既定 responder
 *   - prIterateResponder(overrides?): pr-iterate.js 単体起動の既定 responder
 *   - makeDevFlowSandbox({overrides?, issue?, workflow?, extra?}?): devFlowResponder を使った
 *     makeRecordingSandbox の薄い wrapper
 *   - makePrIterateSandbox({overrides?, args?, extra?}?): prIterateResponder を使った
 *     makeRecordingSandbox の薄い wrapper
 */

import vm from 'node:vm';
import assert from 'node:assert/strict';

// ============================================================
// JS_GLOBALS: VM sandbox に expose する JS 組み込み 15 個
// ============================================================

export const JS_GLOBALS = {
  console,
  JSON,
  Math,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Error,
  RegExp,
  Promise,
  Symbol,
  Map,
  Set,
  Date,
};

// ============================================================
// devFlowArgs: dev-flow.js 用 args の既定形（{issue, setup}）
// ============================================================

/**
 * dev-flow.js 用 args の既定形を返す。setup は dev-flow-prerun の stdout JSON と同形。
 *
 * @param {number|string} [issue=1]
 * @param {Record<string, unknown>} [setupOverrides={}]
 * @returns {{issue: string, setup: Record<string, unknown>}}
 */
export function devFlowArgs(issue = 1, setupOverrides = {}) {
  const n = String(issue);
  return {
    issue: n,
    setup: {
      ok: true, issue: Number(n), base: 'main', base_source: 'origin/dev',
      worktree: '/tmp/wt', branch: `feature/issue-${n}`, head: 'a'.repeat(40),
      worktree_status: 'created', clean: { ok: true },
      deps: { ok: true, note: '' }, stack: { frameworks: [] }, epoch: 1000,
      ...setupOverrides,
    },
  };
}

// ============================================================
// makeRecordingSandbox: 記録付き sandbox を生成する
// ============================================================

/**
 * agent() 呼び出しを記録し、responder に委譲する VM sandbox を作る。
 *
 * @param {(call: {label: string, agentType: string, prompt: string, opts: Record<string, unknown>}) => unknown} responder
 *   各 agent() 呼び出しに対する応答を返す関数。undefined を返した場合は null に変換する。
 * @param {Record<string, unknown>} [extraSandbox={}]
 *   sandbox に追加注入するプロパティ（args 等を上書きする際に使う。log/phase もここで上書き可）。
 * @returns {{
 *   ctx: vm.Context,
 *   calls: Array<{label: string, agentType: string, prompt: string, opts: Record<string, unknown>, schema: unknown}>,
 *   logs: string[],
 *   phases: string[],
 * }}
 */
export function makeRecordingSandbox(responder, extraSandbox = {}) {
  const calls = [];
  const logs = [];
  const phases = [];

  const agent = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const p = prompt ?? '';
    calls.push({ label, agentType, prompt: p, opts: opts ?? {}, schema: opts?.schema ?? null });
    const result = responder({ label, agentType, prompt: p, opts: opts ?? {} });
    if (result === undefined && label === 'issue-meta') {
      return { ok: true, number: 1, title: 'stub-issue-title' };
    }
    if (result === undefined && label === 'setup-base') {
      // issue #550 案1+案2: resolve-base + worktree-base-check 統合 probe のデフォルト応答。
      // 呼び出し側 responder が明示的に 'setup-base' を扱わない限り、base 解決は main、
      // worktree は未存在（新規作成経路）を返し checkWorktreeBase の fail-closed throw で
      // Setup 以降の call chain を壊さない（旧 worktree-base-check default の統合後継）。
      // epoch は start mark の給電元（issue #550 F1/F2）のため既定でも供給する。
      return {
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '', epoch: 1000,
      };
    }
    return result === undefined ? null : result;
  };

  // parallel() stub: runImplement が parallel(par) を呼ぶため（par が空なら []）
  const parallel = async (fns) => Promise.all((fns || []).map((f) => f()));

  // pipeline() stub: canary 実測契約（Claude Code 2.1.252、
  // report ~/.claude/logs/dev-flow-canary/canary-1788235573.json）準拠。
  // (1) 結果配列は入力順に対応（results[i] ↔ items[i]）
  // (2) callback が throw しても pipeline 全体は reject せず当該 item の結果を null にする
  // (3) callback が null/undefined を返した item は null になる
  const pipeline = async (items, cb) => Promise.all((items || []).map(async (item, i) => {
    try {
      const r = await cb(item, i);
      return r === undefined ? null : r;
    } catch {
      return null;
    }
  }));

  const sandbox = {
    // control fns（既定で呼び出しを logs/phases に記録する。extraSandbox で上書き可）
    phase: (t) => { phases.push(String(t)); },
    log: (m) => { logs.push(String(m)); },
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    args: devFlowArgs(1),
    // agent stub
    agent,
    parallel,
    pipeline,
    // JS 組み込み
    ...JS_GLOBALS,
    // caller の上書き（args 等）
    ...extraSandbox,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls, logs, phases };
}

// ============================================================
// runDevFlowInSandbox: dev-flow.js ソースを strip して sandbox 実行する
// （既存 green-fix 4 ファイルの当該関数を verbatim 移植）
// ============================================================

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<Error|null>} エラーがあれば Error、無ければ null
 */
export async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      await result.catch((e) => {
        caughtError = e;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return caughtError;
}

// ============================================================
// runWorkflowCapture: strip + wrap + vm 実行し {result, error} を返す
// （hash-reconverged-routing.test.mjs の runDevFlowCapture と同一ロジック。
// dev-flow.js / pr-iterate.js 共用のため filename を引数化する）
// ============================================================

/**
 * workflow ソースを strip して async IIFE でラップし vm sandbox で実行し、
 * 解決結果とエラーの両方を返す。
 *
 * @param {string} src - workflow の raw ソース（dev-flow.js / pr-iterate.js）
 * @param {vm.Context} ctx - vm コンテキスト
 * @param {string} [filename='.claude/workflows/dev-flow.js'] - vm.runInContext に渡す filename
 * @returns {Promise<{ result: unknown, error: Error|null }>}
 */
export async function runWorkflowCapture(src, ctx, filename = '.claude/workflows/dev-flow.js') {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename });
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

// ============================================================
// assertNoCrash: ReferenceError/SyntaxError のみを sandbox クラッシュとして fail させる
// ============================================================

/**
 * runDevFlowInSandbox / runWorkflowCapture が返す error を検査し、
 * ReferenceError/SyntaxError（sandbox 実行自体のクラッシュ）であれば assert.fail する。
 *
 * @param {Error|null} error
 * @param {string} name - fail メッセージに含めるテストケース識別子
 */
export function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] workflow が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// ============================================================
// devFlowResponder: dev-flow.js 標準経路（shape 'standard'）の既定 responder
// ============================================================

/**
 * dev-flow.js 標準経路（shape 'standard'）の既定応答を返す responder を生成する。
 * overrides[label] があればそれを優先する（関数なら {label, agentType, prompt, opts} で呼ぶ、
 * 値ならそのまま、null なら null）。
 *
 * @param {Record<string, unknown>} [overrides={}]
 * @param {{issue?: number}} [opts]
 * @returns {(ctx: {label: string, agentType: string, prompt: string, opts?: Record<string, unknown>}) => unknown}
 */
export function devFlowResponder(overrides = {}, { issue = 1 } = {}) {
  return function (callCtx) {
    const { label, agentType } = callCtx;
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      return typeof v === 'function' ? v(callCtx) : v;
    }
    if (label === 'setup-base') {
      return {
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '', epoch: 1000,
      };
    }
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: `feature/issue-${issue}` };
    if (label === 'isolation-cleanup') return { cleaned: true };
    if (label === 'isolation-probe') return { written: true };
    if (label === 'worktree-deps') return null;
    if (label.startsWith('analyze')) {
      return {
        summary: 's', acceptance_criteria: ['a', 'b'], issue_type: 'fix', scope: 'src',
        estimated_change_file_count: 3, shape: 'standard', issue_number: issue,
        issue_title: 'stub-issue-title',
      };
    }
    if (label === 'issue-meta') return { ok: true, number: issue, title: 'stub-issue-title' };
    if (agentType === 'dev-flow:dev-planner') {
      return {
        summary: 'p',
        serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp', depends_on: [] }],
        parallel: [],
      };
    }
    if (agentType === 'dev-flow:plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (agentType === 'dev-flow:implementer') {
      return { status: 'DONE', task_id: 't1', files: ['src/x.ts'], summary: 's', concerns: [] };
    }
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'AAA', empty: false } };
    }
    if (label === 'danger-grep-final') return { ok: true, hits: [] };
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'AAA', empty: false };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'changed-files') return { files: ['src/x.ts'] };
    if (label === 'gh-pr-view') {
      return { ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'a'.repeat(40) };
    }
    if (label === 'ci-checks') return { ok: false, error: 'stub' };
    if (label === 'post-summary') return { posted: true, method: 'gh', url: 'http://x', epoch: 2000 };
    if (label.startsWith('journal-save')) return { saved: true };
    if (label.startsWith('journal-log')) return { logged: true, summary: 'ok' };
    return null;
  };
}

// ============================================================
// prIterateResponder: pr-iterate.js 単体起動の既定 responder
// ============================================================

/**
 * pr-iterate.js 単体起動の既定応答を返す responder を生成する。
 * overrides[label] があればそれを優先する（関数なら {label, agentType, prompt, opts} で呼ぶ、
 * 値ならそのまま、null なら null）。
 *
 * @param {Record<string, unknown>} [overrides={}]
 * @returns {(ctx: {label: string, agentType: string, prompt: string, opts?: Record<string, unknown>}) => unknown}
 */
export function prIterateResponder(overrides = {}) {
  return function (callCtx) {
    const { label, agentType } = callCtx;
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      return typeof v === 'function' ? v(callCtx) : v;
    }
    if (label === 'pr-meta') {
      return {
        url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main',
        cwd: '/tmp/wt', epoch: 999,
      };
    }
    if (label === 'isolation-cleanup') return { cleaned: true };
    if (label === 'isolation-probe') return { written: true };
    if (agentType === 'dev-flow:pr-reviewer') return { decision: 'approve', issues: [], summary: 'ok' };
    if (label.startsWith('fix#')) return { applied: true, files: [], summary: 'fixed' };
    if (label.startsWith('commit-ensure#')) return { committed: true, pushed: true, dirty: false };
    if (label.startsWith('ci-check')) return { status: 'passed', failed_checks: [] };
    if (label.startsWith('post-')) return { posted: true, method: 'gh', url: 'http://x', epoch: 3000 };
    if (label === 'worktree-dirty') return { dirty: false };
    if (label.startsWith('journal-save')) return { saved: true };
    if (label.startsWith('journal-log')) return { logged: true, summary: 'ok' };
    return null;
  };
}

// ============================================================
// makeDevFlowSandbox / makePrIterateSandbox: 既定 responder を使った薄い wrapper
// ============================================================

/**
 * devFlowResponder を使った makeRecordingSandbox の薄い wrapper。
 *
 * @param {{overrides?: Record<string, unknown>, issue?: number, workflow?: Function, extra?: Record<string, unknown>}} [opts]
 * @returns {ReturnType<typeof makeRecordingSandbox>}
 */
export function makeDevFlowSandbox({ overrides = {}, issue = 1, workflow, extra = {} } = {}) {
  return makeRecordingSandbox(devFlowResponder(overrides, { issue }), {
    workflow: workflow ?? (async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 })),
    args: devFlowArgs(issue),
    ...extra,
  });
}

/**
 * prIterateResponder を使った makeRecordingSandbox の薄い wrapper。
 *
 * @param {{overrides?: Record<string, unknown>, args?: string, extra?: Record<string, unknown>}} [opts]
 * @returns {ReturnType<typeof makeRecordingSandbox>}
 */
export function makePrIterateSandbox({ overrides = {}, args = '5', extra = {} } = {}) {
  return makeRecordingSandbox(prIterateResponder(overrides), {
    workflow: async () => ({ status: 'lgtm' }),
    args,
    ...extra,
  });
}

