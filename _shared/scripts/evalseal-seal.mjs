#!/usr/bin/env node
// issue #471 (epic #390 Phase 6): EvalSeal (evalseal/2) の seal/check を行う決定論 Node script。
//
// obligation は asserted 区画（agent 判断。digest のみ receipt_id
// へ寄与し verdict には寄与しない）に閉じ、outcome.verdict は evalseal-seal.mjs が
// --evidence-file（diff-risk-classify.sh の risk 判定 + test green 判定を保存した evidence
// bundle）から機械導出する。obligation / CLI に verdict を外部から与える引数は一切存在しない
// （issue #471 AC-2）。evidence bundle が欠落・不正・導出条件不成立の場合は
// verdict='inconclusive' + reason_code='EVIDENCE_NOT_DERIVED' の receipt を発行する
// （receipt 自体は失わない。AC-3）。実際の floor 違反（test-weakening 以外の risk hit）または
// test red の場合のみ verdict='fail'（AC-4）。
//
// crypto を要する seal/検証は tools/sync-inlines.mjs の canonical 制約（ESM import 禁止）に
// 触れるため workflow inline ではなく本 script（dev-runner-haiku exec-proxy 経由・fail-open）
// に置く。Phase 1 の trust-*.mjs（未改変）を相対 import で再利用する。
//
// stdout には JSON 1 行のみを出力する。診断は stderr。実行時失敗（obligation/evidence 読み込み
// 失敗、git コマンド失敗、自己構築 receipt の schema 不一致 等）は `{"ok":false,"error":"..."}`
// を stdout へ出し exit 0 で終える（exec-proxy が verbatim 転写するため exit code に依存しない
// 設計）。引数不正（必須引数欠落・enum 外の --tree-source/--stage・
// --obligation-file/--check-receipt-file の両方指定 or 両方未指定・--obligation-file 指定時の
// --evidence-file 欠落）のみ usage を stderr に出して exit 1 とする。
//
// 書き込みは git object DB への write-tree（working tree の一時 index 経由の tree_oid 算出）
// 以外は行わない。ネットワークアクセスもしない。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLayerMode } from '../../_lib/trust-mode.mjs';
import { sha256Hex, domainSeparatedDigest, computeReceiptId } from '../../_lib/trust-digest.mjs';
import { validateReceipt, checkCapabilities, resolveTrustLevel } from '../../_lib/trust-schema.mjs';
import { makeTrustRunId, buildTrustEnvelope } from '../../_lib/trust-telemetry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TREE_SOURCES = ['working', 'head'];
const STAGES = ['evaluate', 'final'];
const ASSERTED_KEYS = ['evidence', 'context'];

class UsageError extends Error {}

function usage() {
  process.stderr.write(
    [
      'Usage: evalseal-seal.mjs',
      '  --worktree <path> --base <ref> --identity <str>',
      '  --configured-mode <off|shadow|advisory|blocking> --tree-source <working|head>',
      '  [--quality-model <str>] [--stage <evaluate|final>]',
      '  (--obligation-file <path> --evidence-file <path> | --check-receipt-file <path>)',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = { qualityModel: 'unknown', stage: 'evaluate' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--worktree':
        args.worktree = argv[(i += 1)];
        break;
      case '--base':
        args.base = argv[(i += 1)];
        break;
      case '--identity':
        args.identity = argv[(i += 1)];
        break;
      case '--configured-mode':
        args.configuredMode = argv[(i += 1)];
        break;
      case '--tree-source':
        args.treeSource = argv[(i += 1)];
        break;
      case '--quality-model':
        args.qualityModel = argv[(i += 1)];
        break;
      case '--obligation-file':
        args.obligationFile = argv[(i += 1)];
        break;
      case '--evidence-file':
        args.evidenceFile = argv[(i += 1)];
        break;
      case '--check-receipt-file':
        args.checkReceiptFile = argv[(i += 1)];
        break;
      case '--stage':
        args.stage = argv[(i += 1)];
        break;
      default:
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }

  for (const key of ['worktree', 'base', 'identity', 'configuredMode', 'treeSource']) {
    if (!args[key]) {
      throw new UsageError(`missing required argument: --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  }
  if (!TREE_SOURCES.includes(args.treeSource)) {
    throw new UsageError(`--tree-source must be one of ${TREE_SOURCES.join(', ')} (got: ${args.treeSource})`);
  }
  if (!STAGES.includes(args.stage)) {
    throw new UsageError(`--stage must be one of ${STAGES.join(', ')} (got: ${args.stage})`);
  }
  if (args.obligationFile && args.checkReceiptFile) {
    throw new UsageError('specify only one of --obligation-file / --check-receipt-file');
  }
  if (!args.obligationFile && !args.checkReceiptFile) {
    throw new UsageError('one of --obligation-file / --check-receipt-file is required');
  }
  if (args.obligationFile && !args.evidenceFile) {
    throw new UsageError('--evidence-file is required when --obligation-file is specified');
  }

  return args;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// obligation を closed schema {asserted: {evidence: string[], context: object}} として検証する。
// 過不足キー・型違反は文字列 error を返す（合格時は null）。verdict/reason_code/evidence を
// top-level に受理する経路は無い（issue #471 AC-2 — derived 区画への外部入力経路を構造的に断つ）。
function validateObligation(obligation) {
  if (!isPlainObject(obligation)) {
    return 'obligation must be a JSON object';
  }
  const topKeys = Object.keys(obligation);
  const unknownTop = topKeys.filter((k) => k !== 'asserted');
  if (unknownTop.length > 0) {
    return `obligation: unknown top-level key ${unknownTop.join(', ')}`;
  }
  if (!Object.prototype.hasOwnProperty.call(obligation, 'asserted')) {
    return 'obligation: missing required key asserted';
  }

  const asserted = obligation.asserted;
  if (!isPlainObject(asserted)) {
    return 'obligation.asserted must be an object';
  }
  const unknownAsserted = Object.keys(asserted).filter((k) => !ASSERTED_KEYS.includes(k));
  if (unknownAsserted.length > 0) {
    return `obligation.asserted: unknown key ${unknownAsserted.join(', ')}`;
  }
  const missingAsserted = ASSERTED_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(asserted, k));
  if (missingAsserted.length > 0) {
    return `obligation.asserted: missing required key ${missingAsserted.join(', ')}`;
  }
  if (!Array.isArray(asserted.evidence) || !asserted.evidence.every((e) => typeof e === 'string')) {
    return 'obligation.asserted.evidence must be an array of strings';
  }
  if (!isPlainObject(asserted.context)) {
    return 'obligation.asserted.context must be a plain object';
  }
  return null;
}

// evidence bundle の raw content から outcome.{verdict,reason_code} を機械導出する。
// 導出可能なのは JSON parse 成功・bundle/bundle.risk/bundle.test が plain object・
// bundle.risk.ok===true・bundle.risk.hits が配列・bundle.test.green が boolean の全条件を
// 満たす場合のみ。導出不能（risk.ok:false 含む）は fail ではなく inconclusive に倒す
// （issue #471 AC-3。clean と失敗の同一視も禁止 — floor 違反 hit / test red のみ fail、AC-4）。
function deriveOutcome(rawBundle) {
  const inconclusive = { verdict: 'inconclusive', reason_code: 'EVIDENCE_NOT_DERIVED' };

  let bundle;
  try {
    bundle = JSON.parse(rawBundle);
  } catch {
    return inconclusive;
  }
  if (!isPlainObject(bundle)) return inconclusive;
  if (!isPlainObject(bundle.risk)) return inconclusive;
  if (bundle.risk.ok !== true) return inconclusive;
  if (!Array.isArray(bundle.risk.hits)) return inconclusive;
  if (!isPlainObject(bundle.test)) return inconclusive;
  if (typeof bundle.test.green !== 'boolean') return inconclusive;

  const hasFloorViolation = bundle.risk.hits.some((hit) => isPlainObject(hit) && hit.class !== 'test-weakening');
  if (hasFloorViolation) return { verdict: 'fail', reason_code: 'OK' };
  if (bundle.test.green === false) return { verdict: 'fail', reason_code: 'OK' };
  return { verdict: 'pass', reason_code: 'OK' };
}

// git remote URL (https/ssh 両形式・.git 末尾あり/なし) を owner/name slug へ正規化する。
// 解釈できない・remote が無い場合は null を返す（throw しない）。
function slugFromRemoteUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null;
  const url = rawUrl.trim().replace(/\.git$/, '');

  // scp-like SSH 形式: git@host:owner/name
  const scpMatch = url.match(/^[^/@\s]+@[^:/\s]+:(.+)$/);
  if (scpMatch) {
    const path = scpMatch[1].replace(/^\/+/, '');
    return path === '' ? null : path;
  }

  // URL 形式: https://host/owner/name, ssh://git@host/owner/name, git://host/owner/name
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+/, '');
    return path === '' ? null : path;
  } catch {
    return null;
  }
}

function getRepoSlug(worktree) {
  let remoteUrl;
  try {
    remoteUrl = execFileSync('git', ['-C', worktree, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
  return slugFromRemoteUrl(remoteUrl);
}

// 一時 index で working tree 全体（staged + unstaged + untracked）の tree OID を算出する。
// _shared/scripts/worktree-diff-hash.sh と同一手法。実 index・working tree は変更しない。
function computeWorkingTreeOid(worktree) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'evalseal-index-'));
  const tmpIndex = join(tmpDir, 'index');
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    execFileSync('git', ['-C', worktree, 'read-tree', 'HEAD'], { env });
    execFileSync('git', ['-C', worktree, 'add', '-A'], { env });
    return execFileSync('git', ['-C', worktree, 'write-tree'], { env, encoding: 'utf8' }).trim();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function collectOids(worktree, base, treeSource) {
  const base_oid = execFileSync('git', ['-C', worktree, 'rev-parse', base], { encoding: 'utf8' }).trim();
  const head_oid = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree_oid =
    treeSource === 'head'
      ? execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
      : computeWorkingTreeOid(worktree);
  return { base_oid, head_oid, tree_oid };
}

// evaluator.md + toolchain (quality_model/node/git version) の domain-separated digest。
function computeBundleDigest(qualityModel) {
  const evaluatorMdPath = join(__dirname, '..', '..', '.claude', 'agents', 'evaluator.md');
  const evaluatorMd = readFileSync(evaluatorMdPath, 'utf8');
  const evaluator_md_digest = sha256Hex(evaluatorMd);
  const node_version = process.version;
  const git_version = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  return domainSeparatedDigest('evalseal/2:bundle', { evaluator_md_digest, quality_model: qualityModel, node_version, git_version });
}

function runSeal(args, mode) {
  const obligationRaw = readFileSync(args.obligationFile, 'utf8');
  const obligation = JSON.parse(obligationRaw);

  const obligationError = validateObligation(obligation);
  if (obligationError) {
    return { ok: false, error: obligationError };
  }

  const { worktree, base, identity, treeSource, qualityModel, stage } = args;
  const { base_oid, head_oid, tree_oid } = collectOids(worktree, base, treeSource);
  const bundle_digest = computeBundleDigest(qualityModel);

  // evidence bundle は欠落・読み取り不能でも空文字として扱い決定論的に続行する
  // （捏造せず inconclusive + EVIDENCE_NOT_DERIVED へ倒す。issue #471 edge case）。
  let rawBundle;
  try {
    rawBundle = readFileSync(args.evidenceFile, 'utf8');
  } catch {
    rawBundle = '';
  }
  const evidence_bundle_digest = sha256Hex(rawBundle);
  const { verdict, reason_code } = deriveOutcome(rawBundle);

  const asserted_digest = domainSeparatedDigest('evalseal/2:asserted', obligation.asserted);
  const revision_digest = sha256Hex(`${base_oid}\n${head_oid}\n${tree_oid}`);

  const receiptWithoutId = {
    schema_version: 'evalseal/2',
    subject: {
      kind: 'pull_request',
      identity: String(identity),
      revision_digest,
    },
    instrument: {
      adapter: 'dev-flow-evaluator',
      adapter_version: 'evalseal-seal/2',
      config_digest: bundle_digest,
      capabilities: ['tree-read'],
    },
    outcome: {
      verdict,
      reason_code,
    },
    trust: {
      // 同一 harness (evaluator) は常に 'advisory'。'trusted-environment' を出力し得る
      // 分岐・CLI オプションは意図的に一切設けない（epic #390 AC-2）。
      record_integrity: resolveTrustLevel({ verifier: 'same-harness' }),
    },
    anchors: {
      base_oid,
      head_oid,
      tree_oid,
      bundle_digest,
      evidence_bundle_digest,
      asserted_digest,
    },
  };
  const receipt_id = computeReceiptId(receiptWithoutId);
  const receipt = { ...receiptWithoutId, receipt_id };

  const validation = validateReceipt(receipt);
  if (!validation.ok) {
    return { ok: false, error: `self-validation failed: ${validation.reason_code} ${validation.detail}` };
  }
  const capCheck = checkCapabilities(receipt);
  if (!capCheck.ok) {
    return { ok: false, error: `self-capability-check failed: ${capCheck.reason_code}` };
  }

  const run_id = makeTrustRunId({ timestampMs: Date.now(), entropyHex: randomBytes(6).toString('hex') });
  const envelope = buildTrustEnvelope({ run_id, layer: 'evalseal', mode, receipt });

  return { ok: true, mode, stage, receipt, envelope };
}

function runCheck(args, mode) {
  const raw = readFileSync(args.checkReceiptFile, 'utf8');
  const receipt = JSON.parse(raw);

  const validation = validateReceipt(receipt);
  if (!validation.ok) {
    return { ok: true, mode, check: { verdict: 'inconclusive', reason_code: validation.reason_code } };
  }

  const capCheck = checkCapabilities(receipt);
  if (!capCheck.ok) {
    return { ok: true, mode, check: { verdict: 'inconclusive', reason_code: capCheck.reason_code } };
  }

  const { worktree, base, treeSource, qualityModel } = args;
  const { base_oid, head_oid, tree_oid } = collectOids(worktree, base, treeSource);
  const bundle_digest = computeBundleDigest(qualityModel);
  const anchors = receipt.anchors ?? {};

  // evidence_bundle_digest / asserted_digest は tree から再計算不能なため比較対象にしない
  // （存在は validateReceipt の必須 anchor 検証が保証する。issue #471）。
  const anchorsMatch =
    anchors.base_oid === base_oid &&
    anchors.head_oid === head_oid &&
    anchors.tree_oid === tree_oid &&
    (anchors.bundle_digest === undefined || anchors.bundle_digest === bundle_digest);

  if (!anchorsMatch) {
    return { ok: true, mode, check: { verdict: 'inconclusive', reason_code: 'DIGEST_MISMATCH' } };
  }

  return { ok: true, mode, check: { verdict: 'pass', reason_code: 'OK' } };
}

function run(args) {
  const repoSlug = getRepoSlug(args.worktree);
  const killSwitch = process.env.TRUST_KILL_SWITCH === '1';
  const mode = resolveLayerMode({ layer: 'evalseal', configuredMode: args.configuredMode, repoSlug, killSwitch });

  if (mode === 'off') {
    return { ok: true, mode: 'off' };
  }

  return args.checkReceiptFile ? runCheck(args, mode) : runSeal(args, mode);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    usage();
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
    return;
  }

  try {
    const result = run(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) })}\n`);
    process.exit(0);
  }
}

main();
