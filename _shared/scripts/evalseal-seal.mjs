#!/usr/bin/env node
// issue #411 (epic #390 Phase 3): EvalSeal (evalseal/1) の seal/check を行う決定論 Node script。
//
// crypto を要する seal/検証は tools/sync-inlines.mjs の canonical 制約（ESM import 禁止）に
// 触れるため workflow inline ではなく本 script（dev-runner-haiku exec-proxy 経由・fail-open）
// に置く。Phase 1 の trust-*.mjs（未改変）を相対 import で再利用する。
//
// stdout には JSON 1 行のみを出力する。診断は stderr。実行時失敗（obligation 読み込み失敗、
// git コマンド失敗、自己構築 receipt の schema 不一致 等）は `{"ok":false,"error":"..."}` を
// stdout へ出し exit 0 で終える（exec-proxy が verbatim 転写するため exit code に依存しない
// 設計）。引数不正（必須引数欠落・enum 外の --tree-source/--stage・
// --obligation-file/--check-receipt-file の両方指定 or 両方未指定）のみ usage を stderr に
// 出して exit 1 とする。
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
import { validateReceipt, checkCapabilities, resolveTrustLevel, TRUST_VERDICTS, TRUST_REASON_CODES } from '../../_lib/trust-schema.mjs';
import { makeTrustRunId, buildTrustEnvelope } from '../../_lib/trust-telemetry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TREE_SOURCES = ['working', 'head'];
const STAGES = ['evaluate', 'final'];

class UsageError extends Error {}

function usage() {
  process.stderr.write(
    [
      'Usage: evalseal-seal.mjs',
      '  --worktree <path> --base <ref> --identity <str>',
      '  --configured-mode <off|shadow|advisory|blocking> --tree-source <working|head>',
      '  [--quality-model <str>] [--stage <evaluate|final>]',
      '  (--obligation-file <path> | --check-receipt-file <path>)',
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

  return args;
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
  return domainSeparatedDigest('evalseal/1:bundle', { evaluator_md_digest, quality_model: qualityModel, node_version, git_version });
}

function runSeal(args, mode) {
  const obligationRaw = readFileSync(args.obligationFile, 'utf8');
  const obligation = JSON.parse(obligationRaw);

  if (obligation === null || typeof obligation !== 'object' || Array.isArray(obligation)) {
    return { ok: false, error: 'obligation must be a JSON object' };
  }
  if (!TRUST_VERDICTS.includes(obligation.verdict)) {
    return { ok: false, error: `obligation.verdict is not a known TRUST_VERDICTS value: ${JSON.stringify(obligation.verdict)}` };
  }
  if (!TRUST_REASON_CODES.includes(obligation.reason_code)) {
    return { ok: false, error: `obligation.reason_code is not a known TRUST_REASON_CODES value: ${JSON.stringify(obligation.reason_code)}` };
  }
  if (!Array.isArray(obligation.evidence) || !obligation.evidence.every((e) => typeof e === 'string')) {
    return { ok: false, error: 'obligation.evidence must be an array of strings' };
  }

  const { worktree, base, identity, treeSource, qualityModel, stage } = args;
  const { base_oid, head_oid, tree_oid } = collectOids(worktree, base, treeSource);
  const bundle_digest = computeBundleDigest(qualityModel);
  const evidence_digest = domainSeparatedDigest('evalseal/1:evidence', obligation.evidence);
  const revision_digest = sha256Hex(`${base_oid}\n${head_oid}\n${tree_oid}`);

  const receiptWithoutId = {
    schema_version: 'evalseal/1',
    subject: {
      kind: 'pull_request',
      identity: String(identity),
      revision_digest,
    },
    instrument: {
      adapter: 'dev-flow-evaluator',
      adapter_version: 'evalseal-seal/1',
      config_digest: bundle_digest,
      capabilities: ['tree-read'],
    },
    outcome: {
      verdict: obligation.verdict,
      reason_code: obligation.reason_code,
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
      evidence_digest,
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
