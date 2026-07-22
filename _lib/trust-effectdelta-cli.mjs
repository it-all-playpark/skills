#!/usr/bin/env node
// issue #412 (#390 Phase 4): EffectDelta adapter の thin CLI。
//
// _lib/trust-effectdelta.mjs（pure core）と _shared/scripts/effectdelta-github.sh
// （gh CLI I/O）の間を繋ぐ。_lib/trust-surfaceproof-cli.mjs（Phase 2）と同じ分業
// （script が fetch、CLI が pure 判定）を踏襲するが、入力は stdin JSON ではなく
// `--input <json-file>` で受ける（issue #412 task 仕様）。
//
// op は closed enum（pr-classify|comment-classify|derive-comment-id）。stdin ではなく
// --input file から JSON を読む点以外は trust-surfaceproof-cli.mjs と同型の
// read→dispatch→catch→fail() パターン。out-of-enum な op は stderr へ JSON error を
// 書いて exit 1。処理中の例外（resolveLayerMode の未知 layer/mode、pure core の
// 引数検証エラー等）も同様に catch して stderr + exit 1 にする。
//
// mode 解決は _lib/trust-mode.mjs の resolveLayerMode({layer:'effectdelta', ...}) を
// 使う。mode==='off' の場合は判定・receipt 構築を一切行わず `{ok:true, mode:'off'}`
// のみを返す（epic #390 AC-11/AC-15 非緩和 — off 経路は既存 gate に一切触れない。
// 呼び出し元 script は gh への書き込み前にこの early-return を確認して bail する）。
//
// run_id は _shared/scripts/evalseal-seal.mjs と同型で本ファイル内部で生成する
// （Date.now + crypto.randomBytes）。trust-effectdelta.mjs 自体（pure core）は
// Date.now/Math.random を禁止しているが、本ファイルは adapter 層でありその制約対象外
// （evalseal-seal.mjs と同じ規約）。

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolveLayerMode } from './trust-mode.mjs';
import { domainSeparatedDigest } from './trust-digest.mjs';
import { makeTrustRunId, buildTrustEnvelope } from './trust-telemetry.mjs';
import {
  derivePrEffectId,
  deriveCommentEffectId,
  classifyPrObservation,
  classifyCommentObservation,
  buildEffectDeltaReceipt,
} from './trust-effectdelta.mjs';

const OPS = ['pr-classify', 'comment-classify', 'derive-comment-id'];

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input') {
      opts.input = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

function readInputJson(path) {
  if (!path) return fail('--input <json-file> が必要');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return fail(`${path} の読み取りに失敗: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fail(`${path} が有効な JSON ではない: ${e.message}`);
  }
}

function resolveMode(input) {
  return resolveLayerMode({
    layer: 'effectdelta',
    configuredMode: input.configuredMode,
    repoSlug: input.repoSlug,
    killSwitch: input.killSwitch,
  });
}

function newTrustRunId() {
  return makeTrustRunId({ timestampMs: Date.now(), entropyHex: randomBytes(6).toString('hex') });
}

// derive-comment-id: comment write 前に effect_id のみを決定論導出する（gh への書き込み
// 前に script が marker を組み立てるための軽量 op）。mode==='off' なら呼び出し元で
// 既に早期 return 済みのはずだが、直接呼ばれた場合に備え本体でも mode を返す。
function cmdDeriveCommentId(input, mode) {
  const effect_id = deriveCommentEffectId({
    repo: input.repo,
    pr: input.pr,
    effect_type: input.effect_type,
    run_id: input.run_id,
    body_digest: input.body_digest,
  });
  return { ok: true, mode, op: 'derive-comment-id', effect_id };
}

function cmdPrClassify(input, mode) {
  const intended = input.intended ?? {};
  const effect_id = derivePrEffectId(intended);
  const observation = classifyPrObservation({
    intended,
    candidates: input.candidates === undefined ? null : input.candidates,
    readback: input.readback === undefined ? null : input.readback,
    responseLost: input.responseLost ?? false,
  });
  const readback_digest = input.readback
    ? domainSeparatedDigest('effectdelta/pr-readback/1', input.readback)
    : undefined;
  const subject_identity = `${intended.repo}#issue-${intended.issue}`;
  const receipt = buildEffectDeltaReceipt({
    effect_id,
    readback_digest,
    subject_identity,
    status: observation.status,
    config: { adapter: 'effectdelta-github', op: 'pr-classify' },
  });
  const run_id = newTrustRunId();
  const envelope = buildTrustEnvelope({ run_id, layer: 'effectdelta', mode, receipt });
  return { ok: true, mode, op: 'pr-classify', observation, effect_id, receipt, envelope };
}

// comment-classify: expected_body_digest は marker 埋め込み後（実際に投稿された/される）
// 本文の digest。省略時は body_digest（effect_id 導出に使う pre-marker digest）へ
// フォールバックする。effect_id は derive-comment-id と同じ入力から再導出する
// （script 側が別途 effect_id を渡す必要をなくし、単一導出経路を保つ）。
function cmdCommentClassify(input, mode) {
  const effect_id = deriveCommentEffectId({
    repo: input.repo,
    pr: input.pr,
    effect_type: input.effect_type,
    run_id: input.run_id,
    body_digest: input.body_digest,
  });
  const expectedBodyDigest = input.expected_body_digest ?? input.body_digest;
  const observation = classifyCommentObservation({
    effect_id,
    expected_body_digest: expectedBodyDigest,
    matches: input.matches === undefined ? null : input.matches,
    readback: input.readback === undefined ? null : input.readback,
    responseLost: input.responseLost ?? false,
    preexisting: input.preexisting ?? false,
  });
  const readback_digest = input.readback
    ? domainSeparatedDigest('effectdelta/comment-readback/1', input.readback)
    : undefined;
  const subject_identity = `${input.repo}#pr-${input.pr}`;
  const receipt = buildEffectDeltaReceipt({
    effect_id,
    readback_digest,
    subject_identity,
    status: observation.status,
    config: { adapter: 'effectdelta-github', op: 'comment-classify', effect_type: input.effect_type },
  });
  const run_id = newTrustRunId();
  const envelope = buildTrustEnvelope({ run_id, layer: 'effectdelta', mode, receipt });
  return { ok: true, mode, op: 'comment-classify', observation, effect_id, receipt, envelope };
}

function main() {
  const [op, ...rest] = process.argv.slice(2);
  if (!OPS.includes(op)) {
    return fail(`未知の op "${op ?? ''}"（許可: ${OPS.join(', ')}）`);
  }
  const opts = parseArgs(rest);
  const input = readInputJson(opts.input);

  let result;
  try {
    const mode = resolveMode(input);
    if (mode === 'off') {
      result = { ok: true, mode: 'off' };
    } else if (op === 'derive-comment-id') {
      result = cmdDeriveCommentId(input, mode);
    } else if (op === 'pr-classify') {
      result = cmdPrClassify(input, mode);
    } else {
      result = cmdCommentClassify(input, mode);
    }
  } catch (e) {
    return fail(e.message);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  return undefined;
}

main();
