// issue #480: EFFECTDELTA_OBS（dev-flow.js line 3252、inline 生成区間外）の mode/op enum 制約 +
// schema_invalid 写像の regression test。
//
// 背景: EFFECTDELTA_OBS は mode/op を無制約 `{type:'string'}` で宣言しており、実運用で観測された
// 契約違反 payload（mode:"pr-observe" — op 名が mode 位置に入った agent 組み立て payload）を弾けない。
// この schema は 'trust-effectdelta-pr'（PR phase）と 'post-summary' の shadow 分岐（Merge tier
// phase）の 2 箇所の agent() 呼び出しに渡る。issue #480 は mode を TRUST_MODES enum
// （off|shadow|advisory|blocking）、op を closed enum ['pr-classify','comment-ensure'] に制約し、
// 契約違反 payload を #476 の理由コード 'schema_invalid'（telemetry キー
// trust_effectdelta_pr_missing_reason）へ写像することを求める。
//
// 本ファイルは _lib/effectdelta-routing.test.mjs のローカル copy（ハーネス部分は verbatim）に、
// makeRecordingSandbox の extraSandbox で agent stub を上書きして opts.schema をキャプチャする
// 仕組みと、外部依存無しのミニ JSON-schema validator を追加したもの。
//
// テスト群:
//   1. schema 形状の固定（mode.enum / op.enum / required / additionalProperties）
//   2. 実 payload fixture の通過（3経路正常系 + kill switch + エラー形）/ 拒否（enum 外 mode/op）
//   3. schema_invalid 写像 + fail-open（mode:"pr-observe" 契約違反 payload の regression、
//      正しい shadow payload の baseline 保持）
//
// dev-flow.js は変更しない（このファイル自体が TDD red フェーズの土台）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// runDevFlowCapture: evalseal-routing.test.mjs / surfaceproof-routing.test.mjs / effectdelta-routing.test.mjs
// と同型のローカル copy（{result, error} を返す）。
async function runDevFlowCapture(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
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

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

const ALLOWLISTED_REPO = 'it-all-playpark/skills';

const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  estimated_change_file_count: 3,
  shape: 'standard',
  issue_number: 412,
  issue_title: 'stub-issue-title',
};

function evaluatorResponseFor(req) {
  return {
    verdict: 'pass', total: 100, threshold: 80, feedback: [],
    feedback_level: 'implementation',
    ac_results: (req.acceptance_criteria ?? []).map((_, i) => ({
      ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok',
    })),
    security_clearance: [], concern_resolutions: [],
  };
}

// journal-save (stage1, issue #494) prompt から telemetry payload を JSON.parse して返す
// （journal-handoff.mjs の Write-tool verbatim delimiter <<<JOURNAL_HANDOFF_BODY_BEGIN/END>>> から抽出。
// journal-log (stage2) はファイルパスのみを扱い payload literal を含まない）。
function extractTelemetryPayload(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n(\{[\s\S]*?\})\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// createResponder: standard shape シナリオ共通の responder factory（effectdelta-routing.test.mjs と
// 同型）。overrides は label 単位。repo:null/undefined は 'worktree' 応答から repo フィールドを
// 省略（allowlist 不一致 → off）。
function createResponder({ repo = null, req = STANDARD_REQ, overrides = {} } = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'resolve-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-412', ...(repo ? { repo } : {}) };
    if (label.startsWith('analyze')) return req;
    if (agentType === 'dev-planner') {
      return { summary: 'p', serial: [{ id: 't1', desc: 'd', file_changes: ['src/x.ts'], test_plan: 'tp' }], parallel: [] };
    }
    if (agentType === 'plan-reviewer') return { score: 100, verdict: 'pass', findings: [], summary: 'ok' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/x.ts'] };
    if (agentType === 'evaluator') return evaluatorResponseFor(req);
    if (agentType === 'pr-reviewer') return { decision: 'approve', issues: [] };
    if (label.startsWith('ci-check')) return { status: 'passed', failed_checks: [], waited_seconds: 0, poll_attempts: 0 };
    // trust-effectdelta-* / post-summary は override で明示指定しない限り応答しない
    // （未知 label → null、fail-open の実測）ため 'pr' 始まり判定より先に置く必要は無い
    // （'trust-effectdelta-pr' は 'pr' で始まらない）。
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'changed-files') return { files: ['src/x.ts'] };
    if (label === 'changed-files-final') return { files: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'ci-checks') return { ok: false, error: 'stub: no checks' };
    if (label === 'gh-pr-view') return { ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label.startsWith('trust-') || label.startsWith('surfaceproof-shadow')) return null;
    if (label === 'issue-meta') return { ok: true, number: 412, title: 'stub-issue-title' };
    return null;
  };
}

function sampleEnvelope({ stage, verdict = 'pass' } = {}) {
  return {
    run_id: `trust-1-${stage}aaaaaaaaaaaa`.slice(0, 25),
    layer: 'effectdelta',
    mode: 'shadow',
    schema_version: 'effectdelta/1',
    receipt_id: `r-${stage}`,
    verdict,
    reason_code: 'OK',
    record_integrity: 'advisory',
    subject_kind: 'pull_request',
    subject_identity: '412',
    revision_digest: `digest-${stage}`,
  };
}

function sampleReceipt({ stage, verdict = 'pass' } = {}) {
  return {
    schema_version: 'effectdelta/1',
    subject: { kind: 'pull_request', identity: '412', revision_digest: `digest-${stage}` },
    instrument: { adapter: 'effectdelta-github', adapter_version: '1.0.0', config_digest: 'config-digest', capabilities: ['gh-write-once'] },
    outcome: { verdict, reason_code: 'OK' },
    trust: { record_integrity: 'advisory' },
    anchors: { effect_id: `effect-${stage}` },
    receipt_id: `r-${stage}`,
  };
}

// ============================================================
// makeSchemaCaptureSandbox: agent stub を上書きし opts.schema をキャプチャする sandbox factory。
// makeRecordingSandbox の built-in agent/calls は extraSandbox.agent 上書きで shadow される
// （spread が最後なので有効）ため、schema を記録する独自 calls 配列を使う。
// ============================================================
function makeSchemaCaptureSandbox({ repo = null, req = STANDARD_REQ, overrides = {} } = {}) {
  const responder = createResponder({ repo, req, overrides });
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ label: opts?.label ?? '', agentType: opts?.agentType ?? '', prompt: prompt ?? '', schema: opts?.schema });
    const r = responder({ label: opts?.label ?? '', agentType: opts?.agentType ?? '', prompt: prompt ?? '' });
    return r === undefined ? null : r;
  };
  const { ctx } = makeRecordingSandbox(responder, {
    agent,
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 0 }),
    args: '412',
  });
  return { ctx, calls };
}

// ============================================================
// ミニ JSON-schema validator（外部依存禁止）。対応: type（'object'/'string'/'boolean'/'number' と
// ['string','null'] 型配列）/ enum（Array.includes）/ required / properties（トップレベルのみ）。
// additionalProperties 未指定は許容（余剰キーを通す）。
// ============================================================
function typeMatches(type, value) {
  if (type === 'null') return value === null;
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number';
  return false;
}

function validate(schema, payload) {
  const errors = [];
  const checkType = (type, value, path) => {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${path}: type mismatch (expected ${types.join('|')}, got ${JSON.stringify(value)})`);
    }
  };

  if (schema.type) checkType(schema.type, payload, '$');
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!(payload && Object.prototype.hasOwnProperty.call(payload, key))) {
        errors.push(`missing required key: ${key}`);
      }
    }
  }
  if (schema.properties && payload && typeof payload === 'object') {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      const value = payload[key];
      if (propSchema.type) checkType(propSchema.type, value, key);
      if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(value)) {
        errors.push(`${key}: value ${JSON.stringify(value)} not in enum [${propSchema.enum.join(', ')}]`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// ============================================================
// テスト群 1 — schema 形状の固定（AC-1/AC-2）
// ============================================================

test('[effectdelta-obs-schema] group1: EFFECTDELTA_OBS の mode/op enum と required/additionalProperties が固定されている', async () => {
  const { ctx, calls } = makeSchemaCaptureSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-effectdelta-pr': { ok: true, mode: 'shadow', op: 'pr-classify', observation: { status: 'observed', reason_code: 'OK' }, effect_id: 'e', receipt: sampleReceipt({ stage: 'pr' }), envelope: sampleEnvelope({ stage: 'pr' }) },
      'post-summary': { ok: true, posted: true, method: 'm', url: 'u', mode: 'shadow', op: 'comment-ensure', effect_id: 'e', receipt: sampleReceipt({ stage: 'sc' }), envelope: sampleEnvelope({ stage: 'sc' }) },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'group1');

  const prCall = calls.find((c) => c.label === 'trust-effectdelta-pr');
  const summaryCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(prCall, "group1: 'trust-effectdelta-pr' の呼び出しが存在するはず");
  assert.ok(summaryCall, "group1: 'post-summary' の呼び出しが存在するはず");

  for (const [name, call] of [['trust-effectdelta-pr', prCall], ['post-summary', summaryCall]]) {
    const schema = call.schema;
    assert.ok(schema, `group1(${name}): opts.schema が渡されているはず`);
    // vm.createContext は別 realm のため Array の deepEqual は prototype 差で構造比較が失敗し得る
    // （evalseal-routing.test.mjs 等の precedent どおり JSON.stringify で内容比較する）。
    assert.equal(
      JSON.stringify(schema.properties?.mode?.enum),
      JSON.stringify(['off', 'shadow', 'advisory', 'blocking']),
      `group1(${name}): schema.properties.mode.enum が TRUST_MODES と一致するはず`,
    );
    assert.equal(
      JSON.stringify(schema.properties?.op?.enum),
      JSON.stringify(['pr-classify', 'comment-ensure']),
      `group1(${name}): schema.properties.op.enum が closed enum と一致するはず`,
    );
    assert.equal(
      JSON.stringify(schema.required),
      JSON.stringify(['ok']),
      `group1(${name}): schema.required は fail-open 互換で ['ok'] のままのはず`,
    );
    assert.equal(
      schema.additionalProperties,
      undefined,
      `group1(${name}): schema.additionalProperties は未指定（余剰キー許容）のはず`,
    );
  }
});

// ============================================================
// テスト群 2 — 実 payload fixture の通過/拒否（AC-1/AC-2/AC-3/AC-4）
// ============================================================

test('[effectdelta-obs-schema] group2: 実 payload fixture がキャプチャした schema を通過/拒否する', async () => {
  const { ctx, calls } = makeSchemaCaptureSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-effectdelta-pr': { ok: true, mode: 'shadow', op: 'pr-classify', observation: { status: 'observed', reason_code: 'OK' }, receipt: sampleReceipt({ stage: 'pr' }), envelope: sampleEnvelope({ stage: 'pr' }) },
    },
  });
  await runDevFlowCapture(devFlowSrc, ctx);
  const schema = calls.find((c) => c.label === 'trust-effectdelta-pr')?.schema;
  assert.ok(schema, 'group2: trust-effectdelta-pr 呼び出しから schema をキャプチャできるはず');

  // 通過必須（_shared/scripts/effectdelta-github.sh の実出力形）
  const passFixtures = [
    {
      name: 'pr-observe 正常系（script line 186: CLI pr-classify passthrough）',
      payload: { ok: true, mode: 'shadow', op: 'pr-classify', observation: {}, effect_id: 'e', receipt: {}, envelope: {} },
    },
    {
      name: 'comment-prepare 正常系（script line 253-254、op キー無し + marker 余剰キー）',
      payload: { ok: true, mode: 'shadow', effect_id: 'e', marker: '<!-- devflow-effect: e -->' },
    },
    {
      name: 'comment-observe 正常系（script line 421 の jq projection）',
      payload: { ok: true, mode: 'shadow', op: 'comment-ensure', posted: true, url: 'https://x', observation: {}, effect_id: 'e', receipt: {}, envelope: {} },
    },
    {
      name: 'comment 系 kill switch（script line 244/345 — AC-3 の regression 固定）',
      payload: { ok: true, mode: 'off', op: 'comment-ensure', posted: false },
    },
    {
      name: 'pr-observe kill switch（op フィールド無し）',
      payload: { ok: true, mode: 'off' },
    },
    {
      name: 'エラー形（script emit_gh_error/die_json line 91-99）',
      payload: { ok: false, error: 'gh failed' },
    },
  ];
  for (const { name, payload } of passFixtures) {
    const { valid, errors } = validate(schema, payload);
    assert.ok(valid, `group2 pass(${name}): schema を通過するはずだが拒否された: ${JSON.stringify(errors)}`);
  }

  // 拒否必須（enum 外の mode/op を含む契約違反 payload）
  const rejectFixtures = [
    { name: '実観測の契約違反（AC-1 regression: mode:"pr-observe"）', payload: { ok: true, mode: 'pr-observe', op: 'pr-observe', posted: false } },
    { name: 'op:"comment-prepare"（enum 外）', payload: { ok: true, mode: 'shadow', op: 'comment-prepare' } },
    { name: 'op:"comment-classify"（CLI 内部値、enum 外）', payload: { ok: true, mode: 'shadow', op: 'comment-classify' } },
    { name: 'op:"derive-comment-id"（CLI 内部値、enum 外）', payload: { ok: true, mode: 'shadow', op: 'derive-comment-id' } },
    { name: 'mode:"on"（trust mode enum 外）', payload: { ok: true, mode: 'on' } },
  ];
  for (const { name, payload } of rejectFixtures) {
    const { valid } = validate(schema, payload);
    assert.equal(valid, false, `group2 reject(${name}): schema で拒否されるべきだが通過した: ${JSON.stringify(payload)}`);
  }
});

// ============================================================
// テスト群 3 — schema_invalid 写像 + fail-open（AC-5/AC-6/AC-7）
// ============================================================

test("[effectdelta-obs-schema] group3(i): mode:'pr-observe' 契約違反 payload → trust_effectdelta_pr_missing_reason='schema_invalid' + trust_receipts に stage:'pr' 無し + fail-open 完走", async () => {
  const { ctx, calls } = makeSchemaCaptureSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-effectdelta-pr': {
        ok: true, mode: 'pr-observe', op: 'pr-observe', observation: { status: 'observed' },
        effect_id: 'e', receipt: sampleReceipt({ stage: 'pr' }), envelope: sampleEnvelope({ stage: 'pr' }),
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'group3-i');
  assert.equal(error, null, `group3(i): 契約違反 payload でも run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, 'group3(i): workflow は return object を返すべきだが null だった');

  const journalCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall, "group3(i): 'journal-log' の呼び出しが存在すること（fail-open で完走）");
  const payload = extractTelemetryPayload(journalCall.prompt);
  assert.ok(payload, 'group3(i): journal-log prompt から telemetry payload を JSON.parse できるはず');
  assert.equal(
    payload?.telemetry?.trust_effectdelta_pr_missing_reason,
    'schema_invalid',
    `group3(i): trust_effectdelta_pr_missing_reason は 'schema_invalid' のはずだが ${payload?.telemetry?.trust_effectdelta_pr_missing_reason}`,
  );

  const receipts = payload?.telemetry?.trust_receipts ?? [];
  assert.ok(
    !receipts.some((r) => r.stage === 'pr'),
    "group3(i): 契約違反 payload（mode:'pr-observe'）の receipt は trust_receipts の stage:'pr' に記録されてはならない",
  );

  assert.ok(
    calls.some((c) => c.label.startsWith('pr#')),
    "group3(i): PR 作成呼び出し（label 'pr#...'）が存在するはず（fail-open で PR 作成経路は不変）",
  );
});

test("[effectdelta-obs-schema] group3(ii): baseline — 正しい shadow payload → trust_receipts に stage:'pr' entry が存在する（AC-7 既存挙動保持）", async () => {
  const { ctx, calls } = makeSchemaCaptureSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'trust-effectdelta-pr': {
        ok: true, mode: 'shadow', op: 'pr-classify', observation: { status: 'observed', reason_code: 'OK' },
        effect_id: 'e', receipt: sampleReceipt({ stage: 'pr' }), envelope: sampleEnvelope({ stage: 'pr' }),
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'group3-ii');
  assert.ok(result !== null, 'group3(ii): workflow は return object を返すべきだが null だった');

  const journalCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall, "group3(ii): 'journal-log' の呼び出しが存在すること");
  const payload = extractTelemetryPayload(journalCall.prompt);
  assert.ok(payload, 'group3(ii): journal-log prompt から telemetry payload を JSON.parse できるはず');
  const receipts = payload?.telemetry?.trust_receipts ?? [];
  assert.ok(
    receipts.some((r) => r.stage === 'pr'),
    "group3(ii): 正しい shadow payload では trust_receipts に stage:'pr' の entry が存在するはず（AC-7 既存挙動保持）",
  );
});

// PR #481 レビュー指摘: post-summary shadow 分岐（dev-flow.js post-summary receipt push）は
// mode !== 'off' のみで receipt を記録しており、trust-effectdelta-pr 側（group3(i)/(ii)）に
// 追加した TRUST_MODES.includes guard が無かった。schema は 'trust-effectdelta-pr' と
// 'post-summary' の2箇所で共用されるため、schema 検証を素通りし得る契約違反 payload
// （mode がTRUST_MODES外）は summary-comment stage の receipt としても記録されてはならない。
test("[effectdelta-obs-schema] group3(iii): mode:'pr-observe' 契約違反 payload（post-summary/shadow） → trust_receipts に stage:'summary-comment' 無し + fail-open 完走", async () => {
  const { ctx, calls } = makeSchemaCaptureSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'post-summary': {
        ok: true, posted: true, mode: 'pr-observe', op: 'comment-ensure', url: 'http://x', effect_id: 'e',
        observation: { status: 'observed', reason_code: 'OK' },
        receipt: sampleReceipt({ stage: 'summary-comment' }),
        envelope: sampleEnvelope({ stage: 'summary-comment' }),
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'group3-iii');
  assert.equal(error, null, `group3(iii): 契約違反 payload でも run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, 'group3(iii): workflow は return object を返すべきだが null だった');

  const journalCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall, "group3(iii): 'journal-log' の呼び出しが存在すること（fail-open で完走）");
  const payload = extractTelemetryPayload(journalCall.prompt);
  assert.ok(payload, 'group3(iii): journal-log prompt から telemetry payload を JSON.parse できるはず');

  const receipts = payload?.telemetry?.trust_receipts ?? [];
  assert.ok(
    !receipts.some((r) => r.stage === 'summary-comment'),
    "group3(iii): 契約違反 payload（mode:'pr-observe'）の receipt は trust_receipts の stage:'summary-comment' に記録されてはならない",
  );
});

test("[effectdelta-obs-schema] group3(iv): baseline — 正しい shadow payload（post-summary） → trust_receipts に stage:'summary-comment' entry が存在する（既存挙動保持）", async () => {
  const { ctx, calls } = makeSchemaCaptureSandbox({
    repo: ALLOWLISTED_REPO,
    overrides: {
      'post-summary': {
        ok: true, posted: true, mode: 'shadow', op: 'comment-ensure', url: 'http://x', effect_id: 'e',
        observation: { status: 'observed', reason_code: 'OK' },
        receipt: sampleReceipt({ stage: 'summary-comment' }),
        envelope: sampleEnvelope({ stage: 'summary-comment' }),
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'group3-iv');
  assert.ok(result !== null, 'group3(iv): workflow は return object を返すべきだが null だった');

  const journalCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall, "group3(iv): 'journal-log' の呼び出しが存在すること");
  const payload = extractTelemetryPayload(journalCall.prompt);
  assert.ok(payload, 'group3(iv): journal-log prompt から telemetry payload を JSON.parse できるはず');
  const receipts = payload?.telemetry?.trust_receipts ?? [];
  assert.ok(
    receipts.some((r) => r.stage === 'summary-comment'),
    "group3(iv): 正しい shadow payload では trust_receipts に stage:'summary-comment' の entry が存在するはず（既存挙動保持）",
  );
});
