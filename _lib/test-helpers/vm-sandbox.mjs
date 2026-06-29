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
 *   - createSharedRunner(responder, extraSandbox?): { run } を返す（memoized 実行）
 */

import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// ============================================================
// createSharedRunner: memoized 共有実行ランナー（任意 export）
//
// 複数テストが同じ sandbox 実行結果を参照する場合（ensureSharedRun パターン）を共有化する。
// ============================================================

/**
 * dev-flow.js を 1 度だけ実行し、結果をメモ化するランナーを返す。
 *
 * @param {(opts: {label: string, agentType: string, prompt: string}) => unknown} responder
 * @param {Record<string, unknown>} [extraSandbox={}]
 * @returns {{ run: () => Promise<{calls: Array<{label: string, agentType: string, prompt: string}>, err: Error|null}> }}
 */
export function createSharedRunner(responder, extraSandbox = {}) {
  let memo = null;

  const here = dirname(fileURLToPath(import.meta.url));
  // _lib/test-helpers/vm-sandbox.mjs → repo root は 3 up
  const repoRoot = join(here, '..', '..');
  const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

  const run = async () => {
    if (memo !== null) return memo;
    const src = readFileSync(devFlowPath, 'utf8');
    const { ctx, calls } = makeRecordingSandbox(responder, extraSandbox);
    const err = await runDevFlowInSandbox(src, ctx);
    memo = { calls, err };
    return memo;
  };

  return { run };
}
