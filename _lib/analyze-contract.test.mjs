// _lib/analyze-contract.test.mjs
// buildReqFromContract の whitelist 検証 + REQ 互換出力の pin テスト（tdd: 先に書く）。
// issue #374 task F2。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildReqFromContract } from './analyze-contract.mjs';
import { classifyShape } from './triviality.mjs';

function baseContract(overrides = {}) {
  return {
    contract: 't1',
    eligible: true,
    ineligible_reason: '',
    issue_number: 374,
    title: 'Add --contract mode to analyze-issue.sh',
    issue_type: 'feat',
    acceptance_criteria: ['AC1: parse t1/t2 contracts', 'AC2: fallback preserved'],
    scope: '本文スコープ全文（AC 節除く）',
    breaking_keyword_scan: false,
    ...overrides,
  };
}

// (1) eligible t1 正常系 → REQ 全キー検証
test('[analyze-contract] (1) eligible t1 正常系 → REQ 全キー検証', () => {
  const req = buildReqFromContract(baseContract(), 374);
  assert.ok(req !== null);
  assert.equal(req.summary, 'Issue #374: Add --contract mode to analyze-issue.sh');
  assert.equal(req.issue_type, 'feat');
  assert.deepEqual(req.acceptance_criteria, ['AC1: parse t1/t2 contracts', 'AC2: fallback preserved']);
  assert.equal(req.scope, '本文スコープ全文（AC 節除く）');
  assert.equal(req.breaking_change, false);
  assert.equal(req.breaking_keyword_scan, false);
  assert.equal(req.breaking_evidence, '');
  assert.deepEqual(req.ambiguities, []);
});

// (2) estimated_change_file_count: 存在時は転写、欠落/0/非整数/負値はキー省略
test('[analyze-contract] (2a) estimated_change_file_count 正の整数は転写される', () => {
  const req = buildReqFromContract(baseContract({ estimated_change_file_count: 3 }), 374);
  assert.equal(req.estimated_change_file_count, 3);
});

test('[analyze-contract] (2b) estimated_change_file_count 欠落はキー省略', () => {
  const req = buildReqFromContract(baseContract(), 374);
  assert.ok(!('estimated_change_file_count' in req));
});

test('[analyze-contract] (2c) estimated_change_file_count === 0 はキー省略', () => {
  const req = buildReqFromContract(baseContract({ estimated_change_file_count: 0 }), 374);
  assert.ok(!('estimated_change_file_count' in req));
});

test('[analyze-contract] (2d) estimated_change_file_count 非整数はキー省略', () => {
  const req = buildReqFromContract(baseContract({ estimated_change_file_count: 2.5 }), 374);
  assert.ok(!('estimated_change_file_count' in req));
});

test('[analyze-contract] (2e) estimated_change_file_count 負値はキー省略', () => {
  const req = buildReqFromContract(baseContract({ estimated_change_file_count: -1 }), 374);
  assert.ok(!('estimated_change_file_count' in req));
});

// (3) shape キーが出力に無い
test('[analyze-contract] (3) shape キーが出力に無い', () => {
  const req = buildReqFromContract(baseContract({ estimated_change_file_count: 2 }), 374);
  assert.ok(!('shape' in req));
});

// (4) eligible:false → null
test('[analyze-contract] (4) eligible:false → null', () => {
  assert.equal(buildReqFromContract(baseContract({ eligible: false }), 374), null);
});

// (5) contract:'none' → null
test('[analyze-contract] (5) contract:\'none\' → null', () => {
  assert.equal(buildReqFromContract(baseContract({ contract: 'none' }), 374), null);
});

// (6) issue_type 'chore' → null
test('[analyze-contract] (6) issue_type \'chore\' (out-of-enum) → null', () => {
  assert.equal(buildReqFromContract(baseContract({ issue_type: 'chore' }), 374), null);
});

// (7) breaking_keyword_scan:true → null
test('[analyze-contract] (7) breaking_keyword_scan:true → null', () => {
  assert.equal(buildReqFromContract(baseContract({ breaking_keyword_scan: true }), 374), null);
});

// (8) acceptance_criteria 空配列/非配列/空文字混入 → null
test('[analyze-contract] (8a) acceptance_criteria 空配列 → null', () => {
  assert.equal(buildReqFromContract(baseContract({ acceptance_criteria: [] }), 374), null);
});

test('[analyze-contract] (8b) acceptance_criteria 非配列 → null', () => {
  assert.equal(buildReqFromContract(baseContract({ acceptance_criteria: 'not-an-array' }), 374), null);
});

test('[analyze-contract] (8c) acceptance_criteria 空文字混入 → null', () => {
  assert.equal(buildReqFromContract(baseContract({ acceptance_criteria: ['AC1', ''] }), 374), null);
});

// (9) AC 21 件 → 20 件 cap
test('[analyze-contract] (9) AC 21 件 → 20 件 cap', () => {
  const ac21 = Array.from({ length: 21 }, (_, i) => `AC${i + 1}`);
  const req = buildReqFromContract(baseContract({ acceptance_criteria: ac21 }), 374);
  assert.equal(req.acceptance_criteria.length, 20);
  assert.deepEqual(req.acceptance_criteria, ac21.slice(0, 20));
});

// (10) null/非 object 入力 → null
test('[analyze-contract] (10a) null 入力 → null', () => {
  assert.equal(buildReqFromContract(null, 374), null);
});

test('[analyze-contract] (10b) 非 object 入力（string） → null', () => {
  assert.equal(buildReqFromContract('not-an-object', 374), null);
});

test('[analyze-contract] (10c) 非 object 入力（number） → null', () => {
  assert.equal(buildReqFromContract(42, 374), null);
});

test('[analyze-contract] (10d) 配列入力 → null', () => {
  assert.equal(buildReqFromContract([], 374), null);
});

test('[analyze-contract] (10e) undefined 入力 → null', () => {
  assert.equal(buildReqFromContract(undefined, 374), null);
});

// title 非空 string 検証（whitelist の一部）
test('[analyze-contract] title 空文字 → null', () => {
  assert.equal(buildReqFromContract(baseContract({ title: '' }), 374), null);
});

// scope が string でない → null
test('[analyze-contract] scope が string でない → null', () => {
  assert.equal(buildReqFromContract(baseContract({ scope: null }), 374), null);
});

// ---- classifyShape 結合検証（dev-flow.js と同一の _lib/triviality.mjs を import）----

// count 省略出力を classifyShape に通すと shape:'complex'（floor 安全則）
test('[analyze-contract][classifyShape統合] estimated_change_file_count 省略 → shape:\'complex\'（AC-4 安全則）', () => {
  const req = buildReqFromContract(baseContract(), 374); // 欠落
  const { shape } = classifyShape(req);
  assert.equal(shape, 'complex');
});

// count:2 + AC<=4 なら 'micro'
test('[analyze-contract][classifyShape統合] count:2 + AC<=4 → shape:\'micro\'', () => {
  const req = buildReqFromContract(baseContract({ estimated_change_file_count: 2 }), 374);
  const { shape } = classifyShape(req);
  assert.equal(shape, 'micro');
});
