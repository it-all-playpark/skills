// ui-verify-routing: VM sandbox routing test for dev-flow の ui-verify 統合（issue #285 F3）。
// realized-shape-routing.test.mjs / ephemeral-paths-routing.test.mjs のパターンを踏襲する。
//
// 責務: ui-verify の opt-in 分岐（AC-2 の 0 オーバーヘッド）・fail-open 経路（AC-3）・
// try/finally teardown 保証（AC-4）・micro 強制 Evaluate + smoke-only 固定（AC-5）を
// agent() label 単位の responder で pin する。ui-verifier 自体の判定品質は範囲外
// （dev-runner-haiku / ui-verifier subagent の中身は F4/F5 の責務）。
//
// responder は label で分岐し、未知 label には null を返す（既存 vm-sandbox routing test と
// 同じ fail-open 設計。新規 agent 呼び出しを need() で包まない実装であることの間接検証）。
//
// label: stack 起動は 'ui-verify-stack'、決定的な smoke（exec-proxy）は 'ui-verify-smoke'、
// LLM の scenario（ui-verifier）は 'ui-verify'（telemetry で smoke と scenario を区別するため。issue #768）。
//
// テストケース（issue 本文のシーケンスどおり）:
//   (a) realized-diff が UI ファイルを返すが 'ui-verify-config' が {found:false,config:null}
//       → 'ui-verify-stack' は呼ばれず、micro なら evaluator 0 回（AC-2）
//   (b) 非 UI ファイルのみ → 'ui-verify-config' 自体が呼ばれない（0 オーバーヘッド、AC-2）
//   (c) micro + UI touch + 有効 config（scenarios 定義済みでも） → evaluator >= 1 回（AC-5）
//       + 'ui-verify-smoke' prompt に smoke 指定 + 'ui-verify-teardown' が呼ばれる
//   (d) 'ui-verify-stack' が {ok:false,phase:'ready',error:'timeout'}
//       → 検証（smoke / scenario）不発 + teardown 発火 + return.ui_verify==='failed_open'（AC-3）
//   (e) phase:'install' 失敗 → return.ui_verify==='setup_failed'（AC-3）
//   (f) 'ui-verify-smoke' responder が throw → 'ui-verify-teardown' は呼ばれる（AC-4）
//   (g) [struct] runEval 行に `|| uiTouched` が含まれる
//
// TDD red: F3 実装前は 'ui-verify-config' 等の新規 label 呼び出しが存在せず、
// calls に現れない・returned.ui_verify が undefined のため全テストが赤くなる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ---- VM sandbox helpers（realized-shape-routing.test.mjs / ephemeral-paths-routing.test.mjs と同型）----

/**
 * ui-verify-routing 専用の VM sandbox を組む。
 * label 単位の overrides を渡せる点が主眼（ui-verify-config / ui-verify-stack / ui-verify-smoke /
 * ui-verify / ui-verify-teardown の各分岐をテストケースごとに差し替える）。
 *
 * @param {object} opts
 * @param {object} opts.analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {string[]} opts.realizedFiles - realized-diff stub が返すファイル一覧
 * @param {string[]} [opts.declaredFiles=realizedFiles] - dev-implementer stub が files として申告するファイル一覧
 * @param {string[]} [opts.changedFiles=realizedFiles] - changed-files stub が返すファイル一覧（merge tier 判定用）
 * @param {Record<string, unknown|Function>} [opts.overrides={}] - label 単位の応答上書き
 *   （関数を渡すと `({prompt, opts}) => ...` として呼ばれる。throw もそのまま伝播する）
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeUiVerifySandbox({ analyzeReq, realizedFiles, declaredFiles, changedFiles, overrides = {} }) {
  const calls = [];
  const decl = declaredFiles ?? realizedFiles;
  const chg = changedFiles ?? realizedFiles;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, opts });
      return v;
    }

    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return analyzeReq;
    // label 'danger-grep'（issue #544 統合呼び出し）: risk/files を 1 応答で返す
    // （files は旧 realized-diff 相当）。
    if (label === 'danger-grep') return { risk: { ok: true, hits: [] }, files: realizedFiles, struct: null, diffhash: null };
    if (label === 'danger-grep-final') return { ok: true, hits: [] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation', ac_results: [], security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'changed-files') return { files: chg };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 'issue-1', files: decl, summary: '', concerns: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    args: devFlowArgs('1'),
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

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * return object を解決して返す。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<{ error: Error|null, returned: object|null }>}
 */
async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let returned = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      returned = await result.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, returned };
}

// 検証の呼び出し（smoke / scenario のどちらか）。stack 起動失敗時などに「検証していない」ことを見る
const isVerifyCall = (c) => c.label === 'ui-verify-smoke' || c.label === 'ui-verify';

// micro に落ちる req（count=1 ≤ 2, ac.length=2 ≤ 3, type=feat → floor='micro'）
const microReq = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const VALID_CFG = {
  base_port: 4100,
  up: [{ name: 'app', serve: 'npm run dev -- --port {port}', ready: { http: 'http://127.0.0.1:{port}/' } }],
  env_files: [],
  // scenarios を定義していても micro では smoke-only 固定であることを (c) で pin する
  scenarios: [{ name: 's1', steps: ['click #btn'], checks: ['#result visible'], ac_index: 0 }],
};

// ============================================================
// (a) realized-diff が UI ファイルを返すが 'ui-verify-config' が {found:false,config:null}
//     → 'ui-verify-stack' は呼ばれず、micro なら evaluator 0 回（AC-2）
// ============================================================

test('[ui-verify] (a) UI touch だが config 無し → ui-verify-stack 不発 + evaluator 0 回', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: false, config: null },
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    calls.some((c) => c.label === 'ui-verify-config'),
    '(a) UI パス touch なら ui-verify-config は呼ばれるはず',
  );
  assert.ok(
    !calls.some((c) => c.label === 'ui-verify-stack'),
    '(a) config found:false なら ui-verify-stack は呼ばれないはず',
  );
  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.equal(
    evaluatorCalls.length,
    0,
    `(a) config 無しは uiTouched=false のため evaluator は 0 回のはずだが ${evaluatorCalls.length} 回`,
  );
  assert.ok(returned !== null, '(a) workflow は return object を返すべきだが null だった');
  assert.equal(returned?.ui_verify, 'skipped', `(a) returned.ui_verify は 'skipped' のはずだが ${JSON.stringify(returned?.ui_verify)}`);
});

// ============================================================
// (b) 非 UI ファイルのみ → 'ui-verify-config' 自体が呼ばれない（0 オーバーヘッド、AC-2）
// ============================================================

test('[ui-verify] (b) 非 UI ファイルのみ → ui-verify-config が一切呼ばれない（0 オーバーヘッド）', async () => {
  // 'src/lib/util.ts' は isUiPath で false（非 UI segment の .ts）
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/lib/util.ts'],
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    !calls.some((c) => c.label && c.label.startsWith('ui-verify')),
    '(b) 非 UI ファイルのみでは ui-verify* label が一切呼ばれないはず（0 オーバーヘッド）',
  );
  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.equal(evaluatorCalls.length, 0, `(b) evaluator は 0 回のはずだが ${evaluatorCalls.length} 回`);
  assert.ok(returned !== null, '(b) workflow は return object を返すべきだが null だった');
  assert.equal(returned?.ui_verify, 'skipped', `(b) returned.ui_verify は 'skipped' のはずだが ${JSON.stringify(returned?.ui_verify)}`);
});

// ============================================================
// (c) micro + UI touch + 有効 config（scenarios 定義済みでも）
//     → evaluator >= 1 回（AC-5）+ 'ui-verify-smoke' prompt に smoke 指定 + 'ui-verify-teardown' が呼ばれる
// ============================================================

test('[ui-verify] (c) micro + UI touch + 有効 config → Evaluate 強制 + smoke-only 固定 + teardown 実行', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: VALID_CFG },
      'ui-verify-stack': { ok: true, phase: 'ready', port: 4100, pid: 1234 },
      'ui-verify-smoke': { ok: true, mode: 'smoke', checks: [], console_errors: [], screenshots: [], summary: 'load ok' },
      'ui-verify-teardown': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    `(c) micro + UI touch + config あり: evaluator は >= 1 回のはずだが ${evaluatorCalls.length} 回 (AC-5)`,
  );

  const uiVerifyCall = calls.find((c) => c.label === 'ui-verify-smoke');
  assert.ok(uiVerifyCall, "(c) 'ui-verify-smoke' label の呼び出しが存在すること");
  assert.ok(
    uiVerifyCall.prompt.includes('smoke'),
    "(c) 'ui-verify-smoke' prompt に smoke 指定が含まれること（micro は scenarios 定義済みでも smoke-only 固定）",
  );

  assert.ok(
    calls.some((c) => c.label === 'ui-verify-teardown'),
    "(c) 正常系でも 'ui-verify-teardown' が呼ばれること",
  );

  assert.ok(returned !== null, '(c) workflow は return object を返すべきだが null だった');
  assert.equal(returned?.ui_verify, 'passed', `(c) returned.ui_verify は 'passed' のはずだが ${JSON.stringify(returned?.ui_verify)}`);
  assert.equal(returned?.ui_verify_mode, 'smoke', `(c) returned.ui_verify_mode は 'smoke' のはずだが ${JSON.stringify(returned?.ui_verify_mode)}`);
});

// ============================================================
// (d) 'ui-verify-stack' が {ok:false,phase:'ready',error:'timeout'}
//     → 検証（smoke / scenario）不発 + teardown 発火 + return.ui_verify==='failed_open'（AC-3）
// ============================================================

test('[ui-verify] (d) dev サーバー ready timeout → 検証不発 + teardown 発火 + failed_open', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: VALID_CFG },
      'ui-verify-stack': { ok: false, phase: 'ready', error: 'timeout' },
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    !calls.some(isVerifyCall),
    "(d) dev サーバー起動失敗時は 'ui-verify-smoke' / 'ui-verify' label が呼ばれないはず",
  );
  assert.ok(
    calls.some((c) => c.label === 'ui-verify-teardown'),
    "(d) 失敗時でも 'ui-verify-teardown' が呼ばれるはず（fail-open + teardown 保証）",
  );
  assert.ok(returned !== null, '(d) workflow は return object を返すべきだが null だった');
  assert.equal(
    returned?.ui_verify,
    'failed_open',
    `(d) returned.ui_verify は 'failed_open' のはずだが ${JSON.stringify(returned?.ui_verify)}`,
  );
});

// ============================================================
// (e) phase:'install' 失敗 → return.ui_verify==='setup_failed'（AC-3）
// ============================================================

test("[ui-verify] (e) install phase 失敗 → return.ui_verify==='setup_failed'", async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: VALID_CFG },
      'ui-verify-stack': { ok: false, phase: 'install', error: 'npm ci failed' },
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    !calls.some(isVerifyCall),
    "(e) install 失敗時は 'ui-verify-smoke' / 'ui-verify' label が呼ばれないはず",
  );
  assert.ok(returned !== null, '(e) workflow は return object を返すべきだが null だった');
  assert.equal(
    returned?.ui_verify,
    'setup_failed',
    `(e) returned.ui_verify は 'setup_failed' のはずだが ${JSON.stringify(returned?.ui_verify)}`,
  );
});

// ============================================================
// (f) 'ui-verify-smoke' responder が throw → 'ui-verify-teardown' は呼ばれる（AC-4 の workflow 側保証）
// ============================================================

test("[ui-verify] (f) smoke が throw しても ui-verify-teardown は必ず呼ばれ、run 全体は続行する（try/catch/finally 保証）", async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: VALID_CFG },
      'ui-verify-stack': { ok: true, phase: 'ready', port: 4100, pid: 1234 },
      'ui-verify-smoke': () => {
        throw new Error('smoke exec-proxy crashed (forced failure test)');
      },
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  // smoke 呼び出し自体は発生している（throw は agent() 呼び出しの結果として発生）
  assert.ok(calls.some((c) => c.label === 'ui-verify-smoke'), "(f) 'ui-verify-smoke' 呼び出しは発生しているはず");
  // throw しても finally は必ず実行される（workflow 側の保証）
  assert.ok(
    calls.some((c) => c.label === 'ui-verify-teardown'),
    "(f) 'ui-verify-smoke' が throw しても 'ui-verify-teardown' は try/finally により必ず呼ばれるはず",
  );
  // advisory な補助 gate の失敗が run 全体を落としてはならない（fail-open 契約。PR #286 review）
  assert.equal(error, null, `(f) 'ui-verify-smoke' throw で run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(returned !== null, "(f) 'ui-verify-smoke' throw 時も workflow は return object を返すべきだが null だった（run 全体が死んだことを示す）");
  assert.equal(
    returned?.ui_verify,
    'failed_open',
    `(f) 'ui-verify-smoke' throw 時は returned.ui_verify が 'failed_open' のはずだが ${JSON.stringify(returned?.ui_verify)}`,
  );
});

// ============================================================
// (g) standard shape + UI touch + 有効 config → eval#1 prompt に
//     ui_verification（ui-verifier の raw result）が注入される（F3: runUiVerifyFlow 抽出の pin）
// ============================================================

// standard に落ちる req（count=3 ≤ 5, ac.length=4 ≤ 6, type=feat → floor='standard'）
const standardReq = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

test('[ui-verify] (g) eval#1 prompt に ui_verification（ui-verifier raw result）が注入される', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: standardReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: VALID_CFG },
      'ui-verify-stack': { ok: true, phase: 'ready', port: 4100, pid: 1234 },
      'ui-verify-smoke': { ok: true, mode: 'smoke', checks: [], console_errors: [], screenshots: [], summary: 'SENTINEL-UI-OK' },
      'ui-verify-teardown': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.ok(returned !== null, '(g) workflow は return object を返すべきだが null だった');

  const evalCall = calls.find((c) => c.label === 'eval#1');
  assert.ok(evalCall, "(g) 'eval#1' label の呼び出しが存在すること");
  assert.ok(evalCall.prompt.includes('ui_verification'), "(g) eval#1 prompt に 'ui_verification' セクションが含まれること");
  assert.ok(evalCall.prompt.includes('SENTINEL-UI-OK'), "(g) eval#1 prompt に ui-verifier の raw summary('SENTINEL-UI-OK') が含まれること");
});

// runEval が uiTouched で合成されること（micro でも UI touch なら Evaluate 強制）は (c) が VM 挙動で
// 検証する。ソース文字列 `|| uiTouched` の pin は削除した（issue #636）。

// ============================================================
// (h)〜(k) 汎用 stack 形式（up / down）。dev-flow は宣言を ui-verify-stack に渡すだけで、
// コマンドを prompt に埋め込まない（宣言コマンドは ui-verify-stack が sandbox 内で実行する）。
// ============================================================

const STACK_CFG = {
  base_port: 6100,
  ports: ['web', 'api', 'db'],
  up: [
    { name: 'db', serve: 'SENTINEL-DB-CMD --port {port.db}', ready: { tcp: '{port.db}' } },
    { name: 'seed', run: 'SENTINEL-SEED-CMD' },
    { name: 'web', serve: 'SENTINEL-WEB-CMD {port.web}', ready: { http: 'http://127.0.0.1:{port.web}/' } },
  ],
  base_url: 'http://127.0.0.1:{port.web}',
  smoke_path: '/select-tenant',
  login: { commands: [['open', '{base_url}/login'], ['click', 'SENTINEL-LOGIN-STEP']] },
};

test('[ui-verify] (h) stack 形式: up は worktree / state-dir / issue だけを渡し、宣言コマンドを prompt に埋め込まない', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: STACK_CFG },
      'ui-verify-stack': { ok: true, phase: 'ready', base_url: 'http://127.0.0.1:6596', smoke_url: 'http://127.0.0.1:6596/select-tenant', port: 6596 },
      'ui-verify-smoke': { ok: true, mode: 'smoke', checks: [], console_errors: [], screenshots: [], summary: 'ok' },
      'ui-verify-teardown': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, error?.message);

  const up = calls.find((c) => c.label === 'ui-verify-stack');
  assert.ok(up, "(h) 'ui-verify-stack' が呼ばれること");
  assert.ok(!calls.some((c) => c.label.startsWith('ui-verify-server')), "(h) stack 起動の label に旧名 'ui-verify-server' を使わない（issue #768）");
  assert.match(up.prompt, /ui-verify-stack up --worktree '\/tmp\/wt' --state-dir '\/tmp\/wt\/\.devflow-tmp\/ui-verify' --issue 1/);
  assert.ok(!/SENTINEL-(DB|SEED|WEB)-CMD/.test(up.prompt), '(h) 宣言コマンドは prompt に埋め込まない（ui-verify-stack が config を読む）');

  // smoke は LLM を挟まない: exec-proxy が ui-verify-stack smoke を叩くだけ（login もその中で決定的に実行）
  const verify = calls.find((c) => c.label === 'ui-verify-smoke');
  assert.equal(verify.agentType, 'dev-flow:dev-runner-haiku', '(h) smoke は ui-verifier（LLM）ではなく exec-proxy');
  assert.ok(!calls.some((c) => c.label === 'ui-verify'), "(h) smoke は scenario 用の label 'ui-verify' で記録しない（issue #768）");
  assert.ok(verify.prompt.includes("ui-verify-stack smoke --state-dir '/tmp/wt/.devflow-tmp/ui-verify' --session 'devflow-1'"));
  assert.ok(!verify.prompt.includes('SENTINEL-LOGIN-STEP'), '(h) login の中身は prompt に載せない（スクリプトが spec から読む）');
  assert.ok(!calls.some((c) => c.agentType === 'dev-flow:ui-verifier'), '(h) smoke では ui-verifier を spawn しない');
  assert.ok(!calls.some((c) => c.label === 'ui-verify-login'), '(h) smoke の login は smoke コマンドの中で済む');

  const down = calls.find((c) => c.label === 'ui-verify-teardown');
  assert.ok(down.prompt.includes("ui-verify-stack down --state-dir '/tmp/wt/.devflow-tmp/ui-verify'"), '(h) teardown は ui-verify-stack down');
  assert.ok(!/pgrep 等で確認/.test(down.prompt), '(h) sandbox で使えない pgrep を teardown に要求しない');
  assert.equal(returned?.ui_verify, 'passed');
});

for (const [phase, expected] of [['config', 'setup_failed'], ['setup', 'setup_failed'], ['start', 'failed_open'], ['ready', 'failed_open'], ['timeout', 'failed_open']]) {
  test(`[ui-verify] (i) stack 形式: up が phase:'${phase}' で失敗 → ${expected} + teardown 発火`, async () => {
    const { ctx, calls } = makeUiVerifySandbox({
      analyzeReq: microReq,
      realizedFiles: ['src/components/Foo.tsx'],
      overrides: {
        'ui-verify-config': { found: true, config: STACK_CFG },
        'ui-verify-stack': { ok: false, phase, step: 'seed', error: 'exit 1' },
      },
    });
    const { returned } = await runDevFlowInSandbox(src, ctx);
    assert.ok(!calls.some(isVerifyCall), `(i) ${phase} 失敗時は検証（smoke / scenario）を呼ばない`);
    assert.ok(calls.some((c) => c.label === 'ui-verify-teardown'), `(i) ${phase} 失敗時も teardown は呼ぶ`);
    assert.equal(returned?.ui_verify, expected);
  });
}

test('[ui-verify] (j) stack 形式の config が不正 → ui-verify-stack を呼ばず setup_failed', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: { ...STACK_CFG, ports: ['web'] } }, // {port.db} が未宣言
    },
  });
  const { returned } = await runDevFlowInSandbox(src, ctx);
  assert.ok(!calls.some((c) => c.label === 'ui-verify-stack'));
  assert.equal(returned?.ui_verify, 'setup_failed');
});

// ============================================================
// (k) scenario: login は ui-verify-stack login（exec-proxy）で決定的に済ませ、ui-verifier には scenario だけを渡す
// ============================================================

const SCENARIO_CFG = { ...STACK_CFG, scenarios: [{ name: 'shift', steps: ['open /shifts'], checks: ['table visible'], ac_index: 0 }] };

test('[ui-verify] (k) scenario + login → ui-verify-login（exec-proxy）→ ui-verifier の順で、ui-verifier にログイン操作をさせない', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: standardReq,
    realizedFiles: ['src/components/A.tsx', 'src/components/B.tsx', 'src/components/C.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: SCENARIO_CFG },
      'ui-verify-stack': { ok: true, phase: 'ready', base_url: 'http://127.0.0.1:6596', port: 6596 },
      'ui-verify-login': { ok: true, ran: 2, total: 2 },
      'ui-verify': { ok: true, mode: 'scenario', checks: [{ ac_index: 0, action: 'open /shifts', result: 'pass' }], console_errors: [], screenshots: [], summary: 'ok' },
      'ui-verify-teardown': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, error?.message);
  const li = calls.findIndex((c) => c.label === 'ui-verify-login');
  const vi = calls.findIndex((c) => c.label === 'ui-verify');
  assert.ok(li >= 0 && vi > li, '(k) login → ui-verifier の順');
  assert.equal(calls[li].agentType, 'dev-flow:dev-runner-haiku');
  assert.ok(calls[li].prompt.includes("ui-verify-stack login --state-dir '/tmp/wt/.devflow-tmp/ui-verify' --session 'devflow-1'"));
  assert.equal(calls[vi].agentType, 'dev-flow:ui-verifier');
  assert.ok(!calls.some((c) => c.label === 'ui-verify-smoke'), "(k) scenario は smoke 用の label 'ui-verify-smoke' で記録しない（issue #768）");
  assert.ok(calls[vi].prompt.includes('ログイン済み'));
  assert.ok(!calls[vi].prompt.includes('SENTINEL-LOGIN-STEP'), '(k) ui-verifier に login 手順を渡さない');
  assert.equal(returned?.ui_verify, 'passed');
  assert.equal(returned?.ui_verify_mode, 'scenario');
});

test('[ui-verify] (k) scenario で login が失敗 → ui-verifier を呼ばず findings（UI 検証 NG）', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: standardReq,
    realizedFiles: ['src/components/A.tsx', 'src/components/B.tsx', 'src/components/C.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: SCENARIO_CFG },
      'ui-verify-stack': { ok: true, phase: 'ready', base_url: 'http://127.0.0.1:6596', port: 6596 },
      'ui-verify-login': { ok: false, ran: 1, total: 2, failed: { index: 1, command: 'click SENTINEL-LOGIN-STEP' }, error: 'element not found' },
      'ui-verify-teardown': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, error?.message);
  assert.ok(!calls.some((c) => c.label === 'ui-verify'), '(k) login 失敗時は ui-verifier を呼ばない');
  assert.ok(calls.some((c) => c.label === 'ui-verify-teardown'));
  assert.equal(returned?.ui_verify, 'findings');
});

test('[ui-verify] (k) scenario で login の exec-proxy が null → failed_open', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: standardReq,
    realizedFiles: ['src/components/A.tsx', 'src/components/B.tsx', 'src/components/C.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: SCENARIO_CFG },
      'ui-verify-stack': { ok: true, phase: 'ready', base_url: 'http://127.0.0.1:6596', port: 6596 },
      'ui-verify-login': null,
      'ui-verify-teardown': { server_stopped: true, session_closed: true, leftover: [], notes: '' },
    },
  });
  const { returned } = await runDevFlowInSandbox(src, ctx);
  assert.ok(!calls.some((c) => c.label === 'ui-verify'));
  assert.equal(returned?.ui_verify, 'failed_open');
});

// ============================================================
// (l) 環境起因の失敗（ui-verify-stack が env_failure:true を付ける）は findings にせず failed_open。
//     ページに届いた後の失敗（env_failure 無し）は従来どおり findings。
// ============================================================

const READY_SRV = { ok: true, phase: 'ready', base_url: 'http://127.0.0.1:6596', smoke_url: 'http://127.0.0.1:6596/select-tenant', port: 6596 };
const TEARDOWN_OK = { server_stopped: true, session_closed: true, leftover: [], notes: '' };

test('[ui-verify] (l) smoke が env_failure（stack 不在・agent-browser 不在・接続不可）→ failed_open（findings にしない）', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: STACK_CFG },
      'ui-verify-stack': READY_SRV,
      'ui-verify-smoke': { ok: false, mode: 'smoke', checks: [{ action: 'open http://127.0.0.1:6596/select-tenant', result: 'fail', evidence: 'net::ERR_CONNECTION_REFUSED' }], console_errors: [], screenshots: [], summary: 'load 失敗', env_failure: true },
      'ui-verify-teardown': TEARDOWN_OK,
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, error?.message);
  assert.ok(calls.some((c) => c.label === 'ui-verify-teardown'));
  assert.equal(returned?.ui_verify, 'failed_open');
  const evalCall = calls.find((c) => c.label === 'eval#1');
  assert.ok(evalCall && !evalCall.prompt.includes('ui_verification'), '(l) 検証できていない raw result は evaluator に渡さない');
});

test('[ui-verify] (l) smoke がページに届いた後の失敗（env_failure 無し）→ findings', async () => {
  const { ctx } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: STACK_CFG },
      'ui-verify-stack': READY_SRV,
      'ui-verify-smoke': { ok: false, mode: 'smoke', checks: [{ action: 'open http://127.0.0.1:6596/select-tenant', result: 'fail', evidence: 'net::ERR_EMPTY_RESPONSE' }], console_errors: [], screenshots: [], summary: 'load 失敗' },
      'ui-verify-teardown': TEARDOWN_OK,
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, error?.message);
  assert.equal(returned?.ui_verify, 'findings');
});

test('[ui-verify] (l) smoke の networkidle 待ちが skip（非致命）なら passed', async () => {
  const { ctx } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: STACK_CFG },
      'ui-verify-stack': READY_SRV,
      'ui-verify-smoke': { ok: true, mode: 'smoke', checks: [{ action: 'open x', result: 'pass' }, { action: 'wait --load networkidle', result: 'skip', evidence: 'networkidle 待ちは失敗（非致命）' }], console_errors: [], screenshots: [], summary: 'load ok（networkidle 待ちは失敗）' },
      'ui-verify-teardown': TEARDOWN_OK,
    },
  });
  const { returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(returned?.ui_verify, 'passed');
});

test('[ui-verify] (l) scenario で login が env_failure（agent-browser 不在・stack 不在）→ ui-verifier を呼ばず failed_open', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: standardReq,
    realizedFiles: ['src/components/A.tsx', 'src/components/B.tsx', 'src/components/C.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: SCENARIO_CFG },
      'ui-verify-stack': READY_SRV,
      'ui-verify-login': { ok: false, error: 'agent-browser を実行できない（agent-browser: ENOENT）', env_failure: true },
      'ui-verify-teardown': TEARDOWN_OK,
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, error?.message);
  assert.ok(!calls.some((c) => c.label === 'ui-verify'), '(l) 環境起因の login 失敗では ui-verifier を呼ばない');
  assert.ok(calls.some((c) => c.label === 'ui-verify-teardown'));
  assert.equal(returned?.ui_verify, 'failed_open');
});

// ============================================================
// (m) up が phase:'starting' を返したら ui-verify-wait#N（exec-proxy）を繰り返し、
//     ready なら検証へ進む / wait_ceiling_sec から決まる回数を使い切ったら failed_open / wait が null なら failed_open
// ============================================================

const STARTING = (extra = {}) => ({ ok: false, phase: 'starting', base_url: 'http://127.0.0.1:6596', port: 6596, wait_ceiling_sec: 1000, ...extra });
const waitLabels = (calls) => calls.filter((c) => c.label.startsWith('ui-verify-wait')).map((c) => c.label);

test('[ui-verify] (m) up が starting → wait#1 が starting → wait#2 で ready → smoke へ進み passed', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: STACK_CFG },
      'ui-verify-stack': STARTING(),
      'ui-verify-wait#1': STARTING(),
      'ui-verify-wait#2': READY_SRV,
      'ui-verify-smoke': { ok: true, mode: 'smoke', checks: [], console_errors: [], screenshots: [], summary: 'ok' },
      'ui-verify-teardown': TEARDOWN_OK,
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, error?.message);
  assert.deepEqual(waitLabels(calls), ['ui-verify-wait#1', 'ui-verify-wait#2'], '(m) ready になったら wait をやめる');
  const w = calls.find((c) => c.label === 'ui-verify-wait#1');
  assert.equal(w.agentType, 'dev-flow:dev-runner-haiku');
  assert.ok(w.prompt.includes("ui-verify-stack wait --state-dir '/tmp/wt/.devflow-tmp/ui-verify' --wait-sec 480"));
  assert.ok(w.prompt.includes('timeout 600000'));
  const wi = calls.findIndex((c) => c.label === 'ui-verify-wait#2');
  const vi = calls.findIndex((c) => c.label === 'ui-verify-smoke');
  assert.ok(vi > wi, '(m) ready の後に smoke');
  assert.equal(returned?.ui_verify, 'passed');
});

test('[ui-verify] (m) starting のまま wait_ceiling_sec から決まる回数を使い切る → 検証せず failed_open + teardown', async () => {
  // ceil(1000 / 480) + 1 = 4 回
  const overrides = {
    'ui-verify-config': { found: true, config: STACK_CFG },
    'ui-verify-stack': STARTING(),
    'ui-verify-teardown': TEARDOWN_OK,
  };
  for (let i = 1; i <= 8; i++) overrides[`ui-verify-wait#${i}`] = STARTING();
  const { ctx, calls } = makeUiVerifySandbox({ analyzeReq: microReq, realizedFiles: ['src/components/Foo.tsx'], overrides });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, error?.message);
  assert.deepEqual(waitLabels(calls), ['ui-verify-wait#1', 'ui-verify-wait#2', 'ui-verify-wait#3', 'ui-verify-wait#4']);
  assert.ok(!calls.some(isVerifyCall), '(m) ready にならなければ検証しない');
  assert.ok(calls.some((c) => c.label === 'ui-verify-teardown'), '(m) teardown で stack を止める');
  assert.equal(returned?.ui_verify, 'failed_open');
});

test('[ui-verify] (m) up の応答に wait_ceiling_sec が無ければ wait は既定 2 回で打ち切る', async () => {
  const overrides = {
    'ui-verify-config': { found: true, config: STACK_CFG },
    'ui-verify-stack': STARTING({ wait_ceiling_sec: undefined }),
    'ui-verify-teardown': TEARDOWN_OK,
  };
  for (let i = 1; i <= 8; i++) overrides[`ui-verify-wait#${i}`] = STARTING({ wait_ceiling_sec: undefined });
  const { ctx, calls } = makeUiVerifySandbox({ analyzeReq: microReq, realizedFiles: ['src/components/Foo.tsx'], overrides });
  const { returned } = await runDevFlowInSandbox(src, ctx);
  assert.deepEqual(waitLabels(calls), ['ui-verify-wait#1', 'ui-verify-wait#2']);
  assert.equal(returned?.ui_verify, 'failed_open');
});

test('[ui-verify] (m) wait の応答が null → 繰り返さず failed_open + teardown', async () => {
  const { ctx, calls } = makeUiVerifySandbox({
    analyzeReq: microReq,
    realizedFiles: ['src/components/Foo.tsx'],
    overrides: {
      'ui-verify-config': { found: true, config: STACK_CFG },
      'ui-verify-stack': STARTING(),
      'ui-verify-wait#1': null,
      'ui-verify-wait#2': READY_SRV,
      'ui-verify-teardown': TEARDOWN_OK,
    },
  });
  const { error, returned } = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, error?.message);
  assert.deepEqual(waitLabels(calls), ['ui-verify-wait#1']);
  assert.ok(!calls.some(isVerifyCall));
  assert.ok(calls.some((c) => c.label === 'ui-verify-teardown'));
  assert.equal(returned?.ui_verify, 'failed_open');
});

// ============================================================
// (n) label が実態どおり（issue #768）: stack 起動は 'ui-verify-stack'（旧名 ui-verify-server を使わない）、
//     smoke（exec-proxy）と scenario（ui-verifier）は別の label で記録される
// ============================================================

test('[ui-verify] (n) smoke と scenario は別の label（ui-verify-smoke / ui-verify）、stack 起動は ui-verify-stack で記録される', async () => {
  const run = async (analyzeReq, realizedFiles, config, verifyLabel, mode) => {
    const { ctx, calls } = makeUiVerifySandbox({
      analyzeReq,
      realizedFiles,
      overrides: {
        'ui-verify-config': { found: true, config },
        'ui-verify-stack': READY_SRV,
        'ui-verify-login': { ok: true, ran: 2, total: 2 },
        [verifyLabel]: { ok: true, mode, checks: [], console_errors: [], screenshots: [], summary: 'ok' },
        'ui-verify-teardown': TEARDOWN_OK,
      },
    });
    const { error, returned } = await runDevFlowInSandbox(src, ctx);
    assert.equal(error, null, error?.message);
    assert.equal(returned?.ui_verify_mode, mode);
    return calls;
  };
  const smokeCalls = await run(microReq, ['src/components/Foo.tsx'], STACK_CFG, 'ui-verify-smoke', 'smoke');
  const scenarioCalls = await run(standardReq, ['src/components/A.tsx', 'src/components/B.tsx', 'src/components/C.tsx'], SCENARIO_CFG, 'ui-verify', 'scenario');

  const verifyCalls = (calls) => calls.filter(isVerifyCall).map((c) => ({ label: c.label, agentType: c.agentType }));
  assert.deepEqual(verifyCalls(smokeCalls), [{ label: 'ui-verify-smoke', agentType: 'dev-flow:dev-runner-haiku' }]);
  assert.deepEqual(verifyCalls(scenarioCalls), [{ label: 'ui-verify', agentType: 'dev-flow:ui-verifier' }]);

  for (const calls of [smokeCalls, scenarioCalls]) {
    const up = calls.filter((c) => c.prompt.includes('ui-verify-stack up '));
    assert.deepEqual(up.map((c) => c.label), ['ui-verify-stack'], 'stack 起動（ui-verify-stack up）は label ui-verify-stack で 1 回');
    assert.ok(!calls.some((c) => c.label.startsWith('ui-verify-server')), "旧名 'ui-verify-server' の label を使わない");
  }
});
