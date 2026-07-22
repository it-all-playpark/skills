#!/usr/bin/env node
// issue #411 (epic #390 Phase 3, feasibility spike): pinned verifier ed25519 署名 receipt の
// 検証を行う **非配線** prototype。dev-flow への配線はしない（feasibility のみ）。
//
// PR から変更不能な verifier のみが 'trusted-environment' を取得できることを、外部
// pinned 鍵による ed25519 署名 receipt の最小経路で実証する。'trusted-environment' を
// 出力するコードパスは runVerify の単一 return のみであり、以下 3 条件を **全て**
// 満たす場合に限る:
//   (i)   validateReceipt(receipt).ok === true
//   (ii)  受け取った署名が pubkey で有効
//   (iii) realpath(pubkey-file) が realpath(repo-root) 配下に無い
//         （= 鍵が agent write 圏の外に pinned されている）
// 1 つでも欠ければ resolveTrustLevel({ verifier: 'same-harness' })（= 'advisory'）へ倒す。
//
// stdout には JSON 1行のみ出力する。CLI 引数不正のみ usage を stderr に出して exit 1、
// それ以外の実行時失敗（ファイル読めない等）は verify の場合 reason で表現し ok:true
// のまま exit 0 とする（この prototype は decision path の実証が目的であり、
// exec-proxy fail-open ポリシーへ配線する対象ではない）。
//
// 書き込みは keygen/sign が指定された出力先ファイルへ書くのみ。ネットワークアクセスなし。

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import { validateReceipt, resolveTrustLevel } from '../../_lib/trust-schema.mjs';
import { canonicalJsonBytes } from '../../_lib/trust-digest.mjs';

const SUBCOMMANDS = ['keygen', 'sign', 'verify'];

class UsageError extends Error {}

function usage() {
  process.stderr.write(
    [
      'Usage: evalseal-verify.mjs <keygen|sign|verify> [options]',
      '  keygen --out-dir <dir>',
      '  sign --receipt-file <path> --key-file <path> --sig-out <path>',
      '  verify --receipt-file <path> --pubkey-file <path> --sig-file <path> --repo-root <path>',
      '',
    ].join('\n'),
  );
}

function flagToOptionName(key) {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function parseArgs(argv) {
  const [sub, ...rest] = argv;
  if (!SUBCOMMANDS.includes(sub)) {
    throw new UsageError(`unknown subcommand: ${sub ?? '(none)'} (allowed: ${SUBCOMMANDS.join(', ')})`);
  }

  const args = { sub };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    switch (flag) {
      case '--out-dir':
        args.outDir = rest[(i += 1)];
        break;
      case '--receipt-file':
        args.receiptFile = rest[(i += 1)];
        break;
      case '--key-file':
        args.keyFile = rest[(i += 1)];
        break;
      case '--sig-out':
        args.sigOut = rest[(i += 1)];
        break;
      case '--pubkey-file':
        args.pubkeyFile = rest[(i += 1)];
        break;
      case '--sig-file':
        args.sigFile = rest[(i += 1)];
        break;
      case '--repo-root':
        args.repoRoot = rest[(i += 1)];
        break;
      default:
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }

  const requiredBySub = {
    keygen: ['outDir'],
    sign: ['receiptFile', 'keyFile', 'sigOut'],
    verify: ['receiptFile', 'pubkeyFile', 'sigFile', 'repoRoot'],
  };
  for (const key of requiredBySub[sub]) {
    if (!args[key]) {
      throw new UsageError(`missing required argument for ${sub}: ${flagToOptionName(key)}`);
    }
  }

  return args;
}

// pinned verifier 側の鍵対を生成する（spike 用: 本来は verifier インフラ側で一度だけ行い、
// 秘密鍵は PR から到達不能な場所に保管される想定）。
function runKeygen(args) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keyFile = join(args.outDir, 'evalseal-verifier.key');
  const pubkeyFile = join(args.outDir, 'evalseal-verifier.pub');
  writeFileSync(keyFile, privateKey, { mode: 0o600 });
  writeFileSync(pubkeyFile, publicKey);
  return { ok: true, key_file: keyFile, pubkey_file: pubkeyFile };
}

// receipt の canonicalJsonBytes に対して署名する（pinned verifier 側の動作の模擬）。
function runSign(args) {
  const receipt = JSON.parse(readFileSync(args.receiptFile, 'utf8'));
  const privateKeyPem = readFileSync(args.keyFile, 'utf8');
  const bytes = Buffer.from(canonicalJsonBytes(receipt), 'utf8');
  const signature = cryptoSign(null, bytes, privateKeyPem);
  writeFileSync(args.sigOut, signature.toString('base64'));
  return { ok: true, sig_file: args.sigOut };
}

// pubkeyFile の realpath が repoRoot の realpath 配下 (自身含む) にあるかを判定する。
function isPathInsideRoot(targetPath, rootPath) {
  const realTarget = realpathSync(targetPath);
  const realRoot = realpathSync(rootPath);
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
}

function advisory(reason) {
  return { ok: true, trust_level: resolveTrustLevel({ verifier: 'same-harness' }), reason };
}

function runVerify(args) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(args.receiptFile, 'utf8'));
  } catch {
    return advisory('schema-invalid');
  }

  const validation = validateReceipt(receipt);
  if (!validation.ok) {
    return advisory('schema-invalid');
  }

  let pubkeyPem;
  try {
    pubkeyPem = readFileSync(args.pubkeyFile, 'utf8');
  } catch {
    return advisory('pubkey-unreadable');
  }

  let signatureBytes;
  try {
    signatureBytes = Buffer.from(readFileSync(args.sigFile, 'utf8').trim(), 'base64');
  } catch {
    return advisory('signature-unreadable');
  }

  const receiptBytes = Buffer.from(canonicalJsonBytes(receipt), 'utf8');
  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(null, receiptBytes, pubkeyPem, signatureBytes);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return advisory('invalid-signature');
  }

  // (iii) 鍵が agent write 圏 (repo-root 配下) の外にあるかを最後に検証する。
  // realpath 解決に失敗した場合は安全側 (圏内扱い = advisory) に倒す。
  let pubkeyInsideRepo;
  try {
    pubkeyInsideRepo = isPathInsideRoot(args.pubkeyFile, args.repoRoot);
  } catch {
    pubkeyInsideRepo = true;
  }
  if (pubkeyInsideRepo) {
    return advisory('pubkey-inside-repo');
  }

  return {
    ok: true,
    trust_level: resolveTrustLevel({ verifier: 'external-pinned', tamper_evident: true }),
    reason: 'ok',
  };
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

  const result = args.sub === 'keygen' ? runKeygen(args) : args.sub === 'sign' ? runSign(args) : runVerify(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

main();
