// issue #297 (F4): CI checks 委譲 auto-close の dev-flow.js 配線回帰テスト。
//
// F3 で追加した Merge tier phase の ci-checks exec-proxy（classifyMergeTier() の後・
// buildDevflowSummaryBody() の前）を VM sandbox で固定する:
//   (a) green auto-close: build 系 check 全 pass なら turbopack-sandbox ENV item が
//       checkItem され、post-summary の環境ノートに「CI で確認済み（check名列挙）」が現れる。
//   (b) fail-open: ci-checks 呼び出し失敗（ok:false）でも workflow は完走し、
//       ENV item は据え置き（「CI で確認済み」を含まない）。
//   (c) allowlist 外は未呼出: npm-cache-eperm 等 build 検証系でない ENV key は
//       ci-checks を呼ばず、ENV item 自体は生成される（vacuous pass 防止の positive assert）。
//   (d) merge tier 不変: auto-close の有無で merge tier 判定・収束判定（軸A 不変）が変わらない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';
import { gateLane, isConvergedUnderPolicy, DEFAULT_GATE_POLICY } from './gate-policy.mjs';
import { makeLedger, appendItem, checkItem } from './goal-ledger.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// responder factory: concerns と ci-checks 応答だけをシナリオ別に差し替える
// （ハーネスは _lib/eval-concern-resolutions-routing.test.mjs の createResponder を土台にする）
// ============================================================

function createResponder({ concerns, ciChecksResponse }) {
  return function ({ label, agentType }) {
    // Setup(worktree)
    // Setup(resolve-base): base 解決 probe（issue #298）
    if (label === 'resolve-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-297' };
    }
    // Analyze: 必ず standard（micro だと Evaluate が skip され Merge tier phase の前提が崩れる）
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a'],
        issue_type: 'fix',
        scope: 'src',
        estimated_change_file_count: 3,
        shape: 'standard',
      };
    }
    // Plan: dev-planner（1 task を serial に置く — task 0 件だと implementer が呼ばれず
    // concerns が classifyConcerns に到達しない）
    if (agentType === 'dev-planner') {
      return {
        summary: 'p',
        serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }],
        parallel: [],
      };
    }
    // Plan reviewer
    if (agentType === 'plan-reviewer') {
      return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    }
    // Security floor / danger-grep 系（danger-grep, danger-grep-final）
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（test#0 等）
    if (label.startsWith('test')) {
      return { tests: 'passed', green: true, summary: '' };
    }
    // Evaluate: evaluator。item_updates フィールドは契約に存在しないため使わない
    // （AC の checkItem は ac_results の satisfied:true 経由のみ）
    if (agentType === 'evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
        concern_resolutions: [],
      };
    }
    // realized-diff / declared-path-check / changed-files → files: [] で undeclared を発生させない
    if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') {
      return { files: [] };
    }
    // PR 系
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // diff-gate / diff-hash 系
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    // post-summary（dev-runner）
    if (label === 'post-summary') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // ci-checks（dev-runner-haiku）: シナリオ別の応答
    if (label === 'ci-checks') {
      return ciChecksResponse;
    }
    // implementer（本経路の main call。concerns はシナリオ別）
    if (agentType === 'implementer') {
      return {
        status: 'DONE_WITH_CONCERNS',
        task_id: 't1',
        files: ['src/x.ts'],
        summary: 's',
        concerns,
      };
    }
    // デフォルト（worktree-deps / ui-verify-config 等）
    return null;
  };
}

async function runScenario({ concerns, ciChecksResponse }) {
  const { ctx, calls } = makeRecordingSandbox(createResponder({ concerns, ciChecksResponse }));
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  return { calls, err };
}

function assertNoCrash(err, scenarioName) {
  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`[${scenarioName}] dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }
}

const TURBOPACK_CONCERNS = [
  'sandbox 内で next build が TurbopackInternalError で失敗した',
  'next build 実行時に TurbopackInternalError が再発した（再現性あり）',
];

const NPM_CACHE_CONCERNS = [
  'npm install が EPERM で失敗（cache folder contains root-owned files）',
];

const BATS_CONCERNS = [
  'sandbox 環境に bats がインストールされていないため bats テストは CI に委譲した',
];

// ============================================================
// (a) green auto-close
// ============================================================

let sharedGreen = null;
async function ensureGreenRun() {
  if (sharedGreen !== null) return;
  sharedGreen = await runScenario({
    concerns: TURBOPACK_CONCERNS,
    ciChecksResponse: { ok: true, checks: [{ name: 'Vercel', bucket: 'pass' }, { name: 'build', bucket: 'pass' }] },
  });
}

test('[ci-checks][a] crash guard: green auto-close シナリオが sandbox でクラッシュしない', async () => {
  await ensureGreenRun();
  assertNoCrash(sharedGreen.err, 'a-green');
});

test('[ci-checks][AC-1][a] ci-checks 呼び出しが発生し gh pr checks コマンドを prompt に含む', async () => {
  await ensureGreenRun();
  const { calls } = sharedGreen;
  const ciCall = calls.find((c) => c.label === 'ci-checks');
  assert.ok(
    ciCall != null,
    `label === 'ci-checks' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    ciCall.prompt.includes('gh pr checks 1 --json name,bucket'),
    `ci-checks の prompt に gh pr checks コマンドが含まれていない:\n${ciCall.prompt}`,
  );
});

test('[ci-checks][AC-1][a] post-summary の環境ノートに ✅ CI確認済 と CI で確認済み（check名列挙）が現れる', async () => {
  await ensureGreenRun();
  const { calls } = sharedGreen;
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post != null, `label === 'post-summary' の call が見つからない`);
  assert.ok(
    post.prompt.includes('✅ CI確認済'),
    `post-summary の prompt に「✅ CI確認済」が含まれていない:\n${post.prompt.slice(0, 2000)}`,
  );
  assert.ok(
    post.prompt.includes('CI で確認済み（Vercel, build）'),
    `post-summary の prompt に「CI で確認済み（Vercel, build）」が含まれていない:\n${post.prompt.slice(0, 2000)}`,
  );
});

// ============================================================
// (b) fail-open
// ============================================================

let sharedFailOpen = null;
async function ensureFailOpenRun() {
  if (sharedFailOpen !== null) return;
  sharedFailOpen = await runScenario({
    concerns: TURBOPACK_CONCERNS,
    ciChecksResponse: { ok: false, error: 'x' },
  });
}

test('[ci-checks][b] crash guard: fail-open シナリオが sandbox でクラッシュしない', async () => {
  await ensureFailOpenRun();
  assertNoCrash(sharedFailOpen.err, 'b-fail-open');
});

test('[ci-checks][AC-2][b] ci-checks 失敗でも workflow は完走し(post-summary 呼び出し有り)、環境ノートに CI 確認済みは現れない', async () => {
  await ensureFailOpenRun();
  const { calls } = sharedFailOpen;
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(
    post != null,
    `label === 'post-summary' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})。workflow が完走していない可能性`,
  );
  assert.ok(
    post.prompt.includes('ENV-TURBOPACK-SANDBOX'),
    `post-summary の prompt に ENV-TURBOPACK-SANDBOX 行が含まれていない:\n${post.prompt.slice(0, 2000)}`,
  );
  assert.ok(
    !post.prompt.includes('CI で確認済み'),
    `ci-checks 失敗時は fail-open で ENV item を据え置くはずが「CI で確認済み」が現れている:\n${post.prompt.slice(0, 2000)}`,
  );
});

// ============================================================
// (c) allowlist 外は未呼出
// ============================================================

let sharedAllowlist = null;
async function ensureAllowlistRun() {
  if (sharedAllowlist !== null) return;
  sharedAllowlist = await runScenario({
    concerns: NPM_CACHE_CONCERNS,
    ciChecksResponse: { ok: true, checks: [{ name: 'Vercel', bucket: 'pass' }] },
  });
}

test('[ci-checks][c] crash guard: allowlist 外シナリオが sandbox でクラッシュしない', async () => {
  await ensureAllowlistRun();
  assertNoCrash(sharedAllowlist.err, 'c-allowlist');
});

test('[ci-checks][AC-3][c] ENV-NPM-CACHE-EPERM item が post-summary の環境ノートに存在し(positive assert)、CI で確認済みを含まず、ci-checks は未呼出', async () => {
  await ensureAllowlistRun();
  const { calls } = sharedAllowlist;
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post != null, `label === 'post-summary' の call が見つからない`);
  assert.ok(
    post.prompt.includes('ENV-NPM-CACHE-EPERM'),
    `post-summary の prompt に ENV-NPM-CACHE-EPERM 行が含まれていない（ENV item 生成の positive 確認 失敗。vacuous pass の疑い）:\n${post.prompt.slice(0, 2000)}`,
  );
  // ENV-NPM-CACHE-EPERM を含む行に「CI で確認済み」を含まないことを確認する
  const npmLine = post.prompt.split('\n').find((l) => l.includes('ENV-NPM-CACHE-EPERM'));
  assert.ok(npmLine != null);
  assert.ok(
    !npmLine.includes('CI で確認済み'),
    `ENV-NPM-CACHE-EPERM 行に「CI で確認済み」が含まれている（allowlist 外なのに解消されている）:\n${npmLine}`,
  );
  const ciCalls = calls.filter((c) => c.label === 'ci-checks');
  assert.equal(
    ciCalls.length,
    0,
    `label === 'ci-checks' の call は 0 件のはずが ${ciCalls.length} 件発生している（allowlist 外 ENV item のみのため exec-proxy を発行すべきでない）`,
  );
});

// ============================================================
// (d) merge tier 不変
// ============================================================

test('[ci-checks][AC-4][d] green auto-close と fail-open で Merge tier テーブルの値行が一致する', async () => {
  await ensureGreenRun();
  await ensureFailOpenRun();
  const extractMergeTierRow = (calls) => {
    const post = calls.find((c) => c.label === 'post-summary');
    assert.ok(post != null);
    const lines = post.prompt.split('\n');
    const headerIdx = lines.findIndex((l) => l.includes('| Merge tier |'));
    assert.ok(headerIdx >= 0, `Merge tier テーブルのヘッダ行が見つからない`);
    // ヘッダ行の次は区切り行(|---|...)、その次が値行
    const valueRow = lines[headerIdx + 2];
    assert.ok(valueRow != null && valueRow.trim().length > 0, `Merge tier テーブルの値行が見つからない`);
    return valueRow;
  };
  const greenRow = extractMergeTierRow(sharedGreen.calls);
  const failOpenRow = extractMergeTierRow(sharedFailOpen.calls);
  assert.equal(
    greenRow,
    failOpenRow,
    `auto-close の有無で Merge tier テーブルの値行が変わっている（AC-4 違反）:\ngreen: ${greenRow}\nfail-open: ${failOpenRow}`,
  );
});

test('[ci-checks][AC-4][d] gate-policy: checked/unchecked な ENV item(minor, inspection) は共に advisory lane で、isConvergedUnderPolicy は checkItem 前後で同値', () => {
  const envItemBase = {
    id: 'ENV-TURBOPACK-SANDBOX',
    text: 't',
    dimension: 'environment',
    severity: 'minor',
    source: 'concern',
    check: { kind: 'inspection' },
  };

  // gateLane は checked の有無に関わらず lane 分類（dimension/severity/source/check.kind）で決まる
  const uncheckedItem = { ...envItemBase, checked: false };
  const checkedItem = { ...envItemBase, checked: true };
  assert.equal(gateLane(uncheckedItem, DEFAULT_GATE_POLICY), 'advisory');
  assert.equal(gateLane(checkedItem, DEFAULT_GATE_POLICY), 'advisory');

  // isConvergedUnderPolicy: checkItem 前後で同値（advisory は収束を block しないため元々 true のまま）
  let ledger = makeLedger();
  ledger = appendItem(ledger, envItemBase).ledger;
  const convergedBefore = isConvergedUnderPolicy(ledger, DEFAULT_GATE_POLICY);
  ledger = checkItem(ledger, 'ENV-TURBOPACK-SANDBOX', 'CI で確認済み（Vercel, build）');
  const convergedAfter = isConvergedUnderPolicy(ledger, DEFAULT_GATE_POLICY);
  assert.equal(convergedBefore, true);
  assert.equal(convergedAfter, true);
  assert.equal(convergedBefore, convergedAfter);
});

// ============================================================
// (e) bats green auto-close
// ============================================================

let sharedBatsGreen = null;
async function ensureBatsGreenRun() {
  if (sharedBatsGreen !== null) return;
  sharedBatsGreen = await runScenario({
    concerns: BATS_CONCERNS,
    ciChecksResponse: {
      ok: true,
      checks: [
        { name: 'Bats Tests (issue #93 helpers)', bucket: 'pass' },
        { name: 'Node Unit Tests (workflow arg resolver)', bucket: 'pass' },
      ],
    },
  });
}

test('[ci-checks][e] crash guard: bats green auto-close シナリオが sandbox でクラッシュしない', async () => {
  await ensureBatsGreenRun();
  assertNoCrash(sharedBatsGreen.err, 'e-bats-green');
});

test('[ci-checks][AC-2][e] bats/test 系 check 全 pass で ENV-BATS-SANDBOX が auto-close される', async () => {
  await ensureBatsGreenRun();
  const { calls } = sharedBatsGreen;
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post != null, `label === 'post-summary' の call が見つからない`);
  assert.ok(
    post.prompt.includes('ENV-BATS-SANDBOX'),
    `post-summary の prompt に ENV-BATS-SANDBOX 行が含まれていない:\n${post.prompt.slice(0, 2000)}`,
  );
  assert.ok(
    post.prompt.includes('✅ CI確認済'),
    `post-summary の prompt に「✅ CI確認済」が含まれていない:\n${post.prompt.slice(0, 2000)}`,
  );
  assert.ok(
    post.prompt.includes('CI で確認済み（Bats Tests (issue #93 helpers), Node Unit Tests (workflow arg resolver)）'),
    `post-summary の prompt に bats-sandbox の CI 確認済み文字列が含まれていない:\n${post.prompt.slice(0, 2000)}`,
  );
});

// ============================================================
// (f) bats pending 据え置き
// ============================================================

let sharedBatsPending = null;
async function ensureBatsPendingRun() {
  if (sharedBatsPending !== null) return;
  sharedBatsPending = await runScenario({
    concerns: BATS_CONCERNS,
    ciChecksResponse: {
      ok: true,
      checks: [
        { name: 'Bats Tests (issue #93 helpers)', bucket: 'pending' },
        { name: 'Node Unit Tests (workflow arg resolver)', bucket: 'pass' },
      ],
    },
  });
}

test('[ci-checks][f] crash guard: bats pending 据え置きシナリオが sandbox でクラッシュしない', async () => {
  await ensureBatsPendingRun();
  assertNoCrash(sharedBatsPending.err, 'f-bats-pending');
});

test('[ci-checks][AC-3][f] bats/test 系 check が pending のとき ENV-BATS-SANDBOX は据え置かれる(positive assert)', async () => {
  await ensureBatsPendingRun();
  const { calls } = sharedBatsPending;
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post != null, `label === 'post-summary' の call が見つからない`);
  assert.ok(
    post.prompt.includes('ENV-BATS-SANDBOX'),
    `post-summary の prompt に ENV-BATS-SANDBOX 行が含まれていない（ENV item 生成の positive 確認 失敗。vacuous pass の疑い）:\n${post.prompt.slice(0, 2000)}`,
  );
  const batsLine = post.prompt.split('\n').find((l) => l.includes('ENV-BATS-SANDBOX'));
  assert.ok(batsLine != null);
  assert.ok(
    !batsLine.includes('CI で確認済み'),
    `ENV-BATS-SANDBOX 行に「CI で確認済み」が含まれている（pending なのに解消されている）:\n${batsLine}`,
  );
});

// ============================================================
// (g) per-key 独立性
// ============================================================

let sharedPerKey = null;
async function ensurePerKeyRun() {
  if (sharedPerKey !== null) return;
  sharedPerKey = await runScenario({
    concerns: [...TURBOPACK_CONCERNS, ...BATS_CONCERNS],
    ciChecksResponse: {
      ok: true,
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'Vercel', bucket: 'pass' },
        { name: 'Bats Tests (issue #93 helpers)', bucket: 'fail' },
      ],
    },
  });
}

test('[ci-checks][g] crash guard: per-key 独立性シナリオが sandbox でクラッシュしない', async () => {
  await ensurePerKeyRun();
  assertNoCrash(sharedPerKey.err, 'g-per-key');
});

test('[ci-checks][AC-4][g] turbopack-sandbox は auto-close、bats-sandbox は据え置きの per-key 独立判定', async () => {
  await ensurePerKeyRun();
  const { calls } = sharedPerKey;
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post != null, `label === 'post-summary' の call が見つからない`);
  const turbopackLine = post.prompt.split('\n').find((l) => l.includes('ENV-TURBOPACK-SANDBOX'));
  const batsLine = post.prompt.split('\n').find((l) => l.includes('ENV-BATS-SANDBOX'));
  assert.ok(turbopackLine != null, `ENV-TURBOPACK-SANDBOX 行が見つからない:\n${post.prompt.slice(0, 2000)}`);
  assert.ok(batsLine != null, `ENV-BATS-SANDBOX 行が見つからない:\n${post.prompt.slice(0, 2000)}`);
  assert.ok(
    turbopackLine.includes('CI で確認済み'),
    `ENV-TURBOPACK-SANDBOX 行に「CI で確認済み」が含まれていない（build/Vercel が pass なのに auto-close されていない）:\n${turbopackLine}`,
  );
  assert.ok(
    !batsLine.includes('CI で確認済み'),
    `ENV-BATS-SANDBOX 行に「CI で確認済み」が含まれている（bats check が fail なのに解消されている）:\n${batsLine}`,
  );
});
