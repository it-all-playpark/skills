/**
 * vm-sandbox.mjs — VM sandbox ハーネス共有モジュール
 *
 * green-fix 系 4 ファイルで byte 完全一致していた sandbox ヘルパーを抽出した共有モジュール。
 * 差分（agentStub の返り値ロジック）は呼び出し側の responder 関数に委譲する。
 *
 * Export:
 *   - JS_GLOBALS: VM sandbox に expose する 15 個の JS 組み込みをまとめた object
 *   - makeRecordingSandbox(responder, extraSandbox?): {ctx, calls} を返す
 *   - runDevFlowInSandbox(src, ctx): dev-flow.js ソースを strip して sandbox 実行する
 */

import vm from 'node:vm';

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
// makeRecordingSandbox: 記録付き sandbox を生成する
// ============================================================

/**
 * agent() 呼び出しを記録し、responder に委譲する VM sandbox を作る。
 *
 * @param {(opts: {label: string, agentType: string, prompt: string}) => unknown} responder
 *   各 agent() 呼び出しに対する応答を返す関数。undefined を返した場合は null に変換する。
 * @param {Record<string, unknown>} [extraSandbox={}]
 *   sandbox に追加注入するプロパティ（args 等を上書きする際に使う）。
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
export function makeRecordingSandbox(responder, extraSandbox = {}) {
  const calls = [];

  const agent = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const p = prompt ?? '';
    calls.push({ label, agentType, prompt: p });
    const result = responder({ label, agentType, prompt: p });
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

  const sandbox = {
    // control fns
    phase: () => {},
    log: () => {},
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    args: '1',
    // agent stub
    agent,
    parallel,
    // JS 組み込み
    ...JS_GLOBALS,
    // caller の上書き（args 等）
    ...extraSandbox,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
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

