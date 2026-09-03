import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  BLOCK_CLASSES,
  GUARD_ID_PATTERN,
  normalizeBlockingReason,
  scrubBlockingDetail,
  partitionBlocked,
  buildGuardBlockedConcern,
  buildApproachBlockFinding,
} from './block-routing.mjs'

// run wf_17d7a7be 相当の実迂回コマンド列 fixture（issue #448 の実害）。
const EVASION_COMMAND_FIXTURE =
  'git clone --mirror https://github.com/it-all-playpark/skills /tmp/m && ' +
  'git -C <wt> fetch /tmp/m && ' +
  'git checkout FETCH_HEAD -- .claude/workflows/dev-flow.js'

const EVASION_VOCAB_RE = /fetch|FETCH_HEAD|mirror|checkout/i

test('BLOCK_CLASSES: 閉enum は approach_mismatch/guard_blocked の2値', () => {
  assert.deepEqual(BLOCK_CLASSES, ['approach_mismatch', 'guard_blocked'])
})

test('GUARD_ID_PATTERN: IMPL schema と共有する単一真実源の pattern 文字列', () => {
  assert.equal(GUARD_ID_PATTERN, '^[a-z][a-z0-9-]{0,39}$')
})

// (a) 迂回コマンド列 fixture を scrubBlockingDetail に通し、出力が evasion 語彙に一切マッチしないこと
test('scrubBlockingDetail: run wf_17d7a7be 相当の迂回コマンド列は evasion 語彙を一切含まない出力になる', () => {
  const scrubbed = scrubBlockingDetail(EVASION_COMMAND_FIXTURE)
  assert.equal(EVASION_VOCAB_RE.test(scrubbed), false)
  assert.notEqual(scrubbed, '')
})

// (b) buildGuardBlockedConcern / buildApproachBlockFinding の出力にも同 regex 不在
test('buildGuardBlockedConcern: 出力に evasion 語彙が残らない', () => {
  const concern = buildGuardBlockedConcern({ task_id: 'F3', guard_id: 'inline-edit-guard', detail: EVASION_COMMAND_FIXTURE })
  assert.equal(EVASION_VOCAB_RE.test(concern), false)
  assert.match(concern, /^guard_blocked\(F3\)\[guard=inline-edit-guard\]: /)
})

test('buildApproachBlockFinding: topic/description に evasion 語彙が残らない', () => {
  const finding = buildApproachBlockFinding({ task_id: 'F3', detail: EVASION_COMMAND_FIXTURE })
  assert.equal(EVASION_VOCAB_RE.test(finding.topic), false)
  assert.equal(EVASION_VOCAB_RE.test(finding.description), false)
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.dimension, 'approach_mismatch')
  assert.equal(finding.suggestion, '同アプローチでは進行不可。代替設計を立案すること（現アプローチの再試行は禁止）。')
  assert.ok(finding.topic.length <= 60)
})

// (c) 過剰 redact 容認テスト: 正当な自然文が過剰 redact されても非空・機能維持
test('scrubBlockingDetail: 正当な自然文の過剰 redact は容認するが非空を保証する', () => {
  const text = 'API の fetch 層が未対応で JSON parse に失敗する'
  const scrubbed = scrubBlockingDetail(text)
  assert.notEqual(scrubbed, '')
  assert.match(scrubbed, /\[REDACTED\]/)
})

test('scrubBlockingDetail: 過剰 redact 下でも buildApproachBlockFinding が非空の topic/description を返す', () => {
  const finding = buildApproachBlockFinding({ task_id: 'F1', detail: 'API の fetch 層が未対応で JSON parse に失敗する' })
  assert.notEqual(finding.topic, '')
  assert.notEqual(finding.description, '')
})

test('scrubBlockingDetail: 過剰 redact 下でも partitionBlocked が正常動作する', () => {
  const results = [
    { status: 'BLOCKED', task_id: 'F1', blocking_reason: { block_class: 'approach_mismatch', detail: 'API の fetch 層が未対応で JSON parse に失敗する' } },
  ]
  const { approachBlocked, guardBlocked } = partitionBlocked(results)
  assert.equal(guardBlocked.length, 0)
  assert.equal(approachBlocked.length, 1)
  assert.equal(approachBlocked[0].task_id, 'F1')
  assert.notEqual(approachBlocked[0].detail, '')
})

test('scrubBlockingDetail: 全滅時は非空保証で [REDACTED] を返す', () => {
  assert.equal(scrubBlockingDetail(''), '[REDACTED]')
  assert.equal(scrubBlockingDetail('   '), '[REDACTED]')
  assert.equal(scrubBlockingDetail('`git checkout FETCH_HEAD`'), '[REDACTED-CMD]')
})

test('scrubBlockingDetail: バッククォート span を REDACTED-CMD に置換する', () => {
  const scrubbed = scrubBlockingDetail('before `git fetch origin` after')
  assert.equal(scrubbed, 'before [REDACTED-CMD] after')
})

test('scrubBlockingDetail: $(...) サブシェルを REDACTED-CMD に置換する', () => {
  const scrubbed = scrubBlockingDetail('result: $(git rev-parse HEAD) done')
  assert.equal(scrubbed, 'result: [REDACTED-CMD] done')
})

test('scrubBlockingDetail: http(s) URL を REDACTED-CMD に置換する', () => {
  const scrubbed = scrubBlockingDetail('see https://github.com/it-all-playpark/skills for detail')
  assert.equal(scrubbed, 'see [REDACTED-CMD] for detail')
})

test('scrubBlockingDetail: 500 文字で切り詰める', () => {
  const long = 'a'.repeat(600)
  const scrubbed = scrubBlockingDetail(long)
  assert.equal(scrubbed.length, 500)
})

// (d) normalizeBlockingReason
test('normalizeBlockingReason: string 入力は throw（free text 受理禁止）', () => {
  assert.throws(() => normalizeBlockingReason('BLOCKED: free text'), /object/)
})

test('normalizeBlockingReason: 配列入力は throw', () => {
  assert.throws(() => normalizeBlockingReason(['approach_mismatch']))
})

test('normalizeBlockingReason: number 入力は throw', () => {
  assert.throws(() => normalizeBlockingReason(42))
})

test('normalizeBlockingReason: undefined 入力は throw（null のみ fallback 対象）', () => {
  assert.throws(() => normalizeBlockingReason(undefined))
})

test('normalizeBlockingReason: block_class が out-of-enum なら throw', () => {
  assert.throws(() => normalizeBlockingReason({ block_class: 'unknown_class', detail: 'x' }), /out-of-enum/)
})

test('normalizeBlockingReason: detail が非 string なら throw', () => {
  assert.throws(() => normalizeBlockingReason({ block_class: 'approach_mismatch', detail: 123 }))
})

test('normalizeBlockingReason: null → approach_mismatch へ決定論 fallback', () => {
  assert.deepEqual(normalizeBlockingReason(null), {
    block_class: 'approach_mismatch',
    detail: 'BLOCKED（詳細未申告）',
    guard_id: null,
  })
})

test('normalizeBlockingReason: guard_blocked で guard_id が pattern 違反なら throw', () => {
  assert.throws(() => normalizeBlockingReason({ block_class: 'guard_blocked', detail: 'x', guard_id: 'Inline_Edit_Guard!' }), /pattern/)
})

test('normalizeBlockingReason: guard_blocked で guard_id 欠落 → unspecified', () => {
  const result = normalizeBlockingReason({ block_class: 'guard_blocked', detail: 'hook denied' })
  assert.deepEqual(result, { block_class: 'guard_blocked', detail: 'hook denied', guard_id: 'unspecified' })
})

test('normalizeBlockingReason: guard_blocked で guard_id が null → unspecified', () => {
  const result = normalizeBlockingReason({ block_class: 'guard_blocked', detail: 'hook denied', guard_id: null })
  assert.deepEqual(result, { block_class: 'guard_blocked', detail: 'hook denied', guard_id: 'unspecified' })
})

test('normalizeBlockingReason: guard_blocked で guard_id が pattern 準拠なら保持する', () => {
  const result = normalizeBlockingReason({ block_class: 'guard_blocked', detail: 'hook denied', guard_id: 'inline-edit-guard' })
  assert.deepEqual(result, { block_class: 'guard_blocked', detail: 'hook denied', guard_id: 'inline-edit-guard' })
})

test('normalizeBlockingReason: approach_mismatch では guard_id 指定があっても null に正規化する', () => {
  const result = normalizeBlockingReason({ block_class: 'approach_mismatch', detail: 'design mismatch', guard_id: 'ignored' })
  assert.deepEqual(result, { block_class: 'approach_mismatch', detail: 'design mismatch', guard_id: null })
})

// (e) partitionBlocked の振り分けと BLOCKED 以外の無視
test('partitionBlocked: guard_blocked/approach_mismatch を振り分け、BLOCKED 以外は無視する', () => {
  const results = [
    { status: 'DONE', task_id: 'F1' },
    { status: 'BLOCKED', task_id: 'F2', blocking_reason: { block_class: 'guard_blocked', detail: 'hook denied', guard_id: 'inline-edit-guard' } },
    { status: 'BLOCKED', task_id: 'F3', blocking_reason: { block_class: 'approach_mismatch', detail: 'API 設計が破綻' } },
    { status: 'DONE_WITH_CONCERNS', task_id: 'F4' },
    null,
  ]
  const { guardBlocked, approachBlocked } = partitionBlocked(results)
  assert.deepEqual(guardBlocked, [{ task_id: 'F2', guard_id: 'inline-edit-guard', detail: 'hook denied' }])
  assert.deepEqual(approachBlocked, [{ task_id: 'F3', detail: 'API 設計が破綻' }])
})

test('partitionBlocked: blocking_reason が null の BLOCKED task は approach_mismatch fallback に入る', () => {
  const results = [{ status: 'BLOCKED', task_id: 'F5', blocking_reason: null }]
  const { approachBlocked, guardBlocked } = partitionBlocked(results)
  assert.equal(guardBlocked.length, 0)
  assert.deepEqual(approachBlocked, [{ task_id: 'F5', detail: 'BLOCKED（詳細未申告）' }])
})

test('partitionBlocked: normalize の throw はそのまま伝播する', () => {
  const results = [{ status: 'BLOCKED', task_id: 'F6', blocking_reason: 'free text blocked' }]
  assert.throws(() => partitionBlocked(results))
})

test('partitionBlocked: 空配列は空の振り分け結果を返す', () => {
  assert.deepEqual(partitionBlocked([]), { guardBlocked: [], approachBlocked: [] })
})

// (f) 決定論性: 同一入力2回で同一出力
test('決定論性: scrubBlockingDetail は同一入力に対し常に同一出力を返す', () => {
  const a = scrubBlockingDetail(EVASION_COMMAND_FIXTURE)
  const b = scrubBlockingDetail(EVASION_COMMAND_FIXTURE)
  assert.equal(a, b)
})

test('決定論性: normalizeBlockingReason は同一入力に対し常に同一出力を返す', () => {
  const input = { block_class: 'guard_blocked', detail: 'hook denied', guard_id: 'inline-edit-guard' }
  assert.deepEqual(normalizeBlockingReason(input), normalizeBlockingReason(input))
})

test('決定論性: partitionBlocked は同一入力に対し常に同一出力を返す', () => {
  const results = [{ status: 'BLOCKED', task_id: 'F2', blocking_reason: { block_class: 'guard_blocked', detail: 'hook denied', guard_id: 'inline-edit-guard' } }]
  assert.deepEqual(partitionBlocked(results), partitionBlocked(results))
})

test('決定論性: buildGuardBlockedConcern / buildApproachBlockFinding は同一入力に対し常に同一出力を返す', () => {
  const args = { task_id: 'F3', guard_id: 'inline-edit-guard', detail: EVASION_COMMAND_FIXTURE }
  assert.equal(buildGuardBlockedConcern(args), buildGuardBlockedConcern(args))
  assert.deepEqual(buildApproachBlockFinding(args), buildApproachBlockFinding(args))
})
