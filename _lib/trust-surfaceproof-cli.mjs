#!/usr/bin/env node
// issue #410 (#390 Phase 2): SurfaceProof adapter の thin CLI。
//
// _lib/trust-surfaceproof.mjs（pure core）と dev-issue-analyze/scripts/surfaceproof-snapshot.sh
// （gh api / curl I/O）の間を繋ぐ。stdin JSON -> stdout JSON。失敗は stderr へ JSON を書いて
// exit 1。Date.now/Math.random は使用しない（決定論を保つ）。
//
// サブコマンド:
//   plan-fetch  stdin: snapshot          -> stdout: {urls:[{url,kind,allowed,reason_code}]}
//   freeze      stdin: snapshot          -> stdout: {frozen, units, pack:{input_pack_digest}, receipt}
//               [--fetches <path>] 外部 URL fetch 結果 JSON（省略可。省略時、allowlist 通過
//               link が未 fetch のまま残ると verdict は pass にならず inconclusive になる）
//   reconcile   stdin: 現在 snapshot     -> stdout: {reconcile:{status,reasons}, receipt}
//               --frozen <path> 必須 / [--presented <path>] presented_unit_ids JSON 配列（省略時は全 unit）

import { readFileSync } from 'node:fs';
import {
  extractLinkUnits,
  evaluateUrlPolicy,
  buildInventory,
  freezeSource,
  buildPresentationPack,
  reconcileSource,
  buildSurfaceProofReceipt,
} from './trust-surfaceproof.mjs';

const SUBCOMMANDS = ['plan-fetch', 'freeze', 'reconcile'];

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function readStdinJson() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (e) {
    return fail(`stdin の読み取りに失敗: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fail(`stdin が有効な JSON ではない: ${e.message}`);
  }
}

function readJsonFile(path) {
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

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fetches' || a === '--frozen' || a === '--presented') {
      opts[a.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

// snapshot.fetch_errors が 0 件（= comments 等の取得が全て成功）のときのみ
// 'issue-read' capability を認める。403/404 等の権限不足は capabilities=[] にして
// checkCapabilities 側の CAPABILITY_MISSING で拾わせる（偽 pass 防止）。
function deriveCapabilities(snapshot) {
  const errors = Array.isArray(snapshot?.fetch_errors) ? snapshot.fetch_errors : [];
  return errors.length === 0 ? ['issue-read'] : [];
}

// body + （comments fetch が成功している場合のみ）各 comment 本文から link unit を
// 抽出する対象テキストを集める（buildInventory の link 抽出ロジックと同じ考え方）。
function collectLinkTexts(snapshot) {
  const issue = snapshot && typeof snapshot.issue === 'object' && snapshot.issue !== null ? snapshot.issue : {};
  const texts = [typeof issue.body === 'string' ? issue.body : ''];
  const fetchErrors = Array.isArray(snapshot?.fetch_errors) ? snapshot.fetch_errors : [];
  const commentsFetchError = fetchErrors.some((e) => e && typeof e === 'object' && e.resource === 'comments');
  if (!commentsFetchError && Array.isArray(snapshot?.comments)) {
    for (const c of snapshot.comments) {
      if (c && typeof c.body === 'string') texts.push(c.body);
    }
  }
  return texts;
}

function planFetch(snapshot) {
  const seen = new Set();
  const urls = [];
  for (const text of collectLinkTexts(snapshot)) {
    for (const { kind, url } of extractLinkUnits(text)) {
      if (seen.has(url)) continue;
      seen.add(url);
      const policyCheck = evaluateUrlPolicy(url);
      urls.push({ url, kind, allowed: policyCheck.allowed, reason_code: policyCheck.reason_code });
    }
  }
  return { urls };
}

// units（buildInventory 直後は全 unit が presentation:'presented' 固定）へ
// pack.presentation_map の実提示状態をマージしてから reconcileSource へ渡す
// （fixtures テストの runPipeline と同型。issue #416 review 指摘: マージを省くと
// --presented による omission が reconcileSource から見えず、comment-only AC unit を
// 省いても verdict=pass になってしまう）。
function applyPresentationMap(units, presentationMap) {
  return units.map((u) => ({ ...u, presentation: presentationMap[u.unit_id] }));
}

function cmdFreeze(snapshot, opts) {
  const fetchResults = opts.fetches ? readJsonFile(opts.fetches) : [];
  const safeFetchResults = Array.isArray(fetchResults) ? fetchResults : [];
  // freezeSource へも同じ fetchResults を渡し、frozen.confirmed_fetched_unit_ids が実際に
  // fetch 済みだった required unit の id と一致するようにする（cmdReconcile 側で
  // fetchResults 無しに units を作り直しても、この id 集合で omission 検出を継続できる。
  // issue #416 review 指摘の CLI reconcile 境界バグ修正）。
  const frozen = freezeSource(snapshot, safeFetchResults);
  const units = buildInventory(snapshot, safeFetchResults);
  const presentedUnitIds = units.map((u) => u.unit_id);
  const pack = buildPresentationPack(units, presentedUnitIds);
  const presentedUnits = applyPresentationMap(units, pack.presentation_map);
  // requireFetchAttempted: true — freeze 時点で allowlist 通過 link が --fetches 省略等で
  // 一度も fetch されていない（fetch === 'not_attempted'）場合、それを見過ごして pass に
  // しない（issue #416 review 指摘: freeze は「fetch 未実施」と「fetch 済みで検証済み」を
  // 区別できる必要がある）。reconcile 経路（cmdReconcile）は既定 false のままで
  // not_attempted を許容する（Analyze 直前の再照合は freeze 時点の判定を再度覆さない設計）。
  const reconcile = reconcileSource({ frozen, currentSnapshot: snapshot, units: presentedUnits, requireFetchAttempted: true });
  const capabilities = deriveCapabilities(snapshot);
  const receipt = buildSurfaceProofReceipt({ frozen, input_pack_digest: pack.input_pack_digest, reconcile, capabilities });
  return { frozen, units: presentedUnits, pack: { input_pack_digest: pack.input_pack_digest }, receipt };
}

function cmdReconcile(currentSnapshot, opts) {
  if (!opts.frozen) return fail('reconcile には --frozen <path> が必要');
  const frozen = readJsonFile(opts.frozen);
  const units = buildInventory(currentSnapshot, []);
  const presentedUnitIds = opts.presented ? readJsonFile(opts.presented) : units.map((u) => u.unit_id);
  const pack = buildPresentationPack(units, Array.isArray(presentedUnitIds) ? presentedUnitIds : units.map((u) => u.unit_id));
  const presentedUnits = applyPresentationMap(units, pack.presentation_map);
  // requireFetchAttempted は既定 false のまま呼ぶ — not_attempted な link の許容は
  // freeze 時点の判定を踏襲する設計意図（上記 cmdFreeze のコメント参照）。
  const reconcile = reconcileSource({ frozen, currentSnapshot, units: presentedUnits });
  const capabilities = deriveCapabilities(currentSnapshot);
  const receipt = buildSurfaceProofReceipt({ frozen, input_pack_digest: pack.input_pack_digest, reconcile, capabilities });
  return { reconcile, receipt };
}

function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!SUBCOMMANDS.includes(subcommand)) {
    return fail(`未知の subcommand "${subcommand ?? ''}"（許可: ${SUBCOMMANDS.join(', ')}）`);
  }
  const opts = parseArgs(rest);
  const input = readStdinJson();

  let result;
  try {
    if (subcommand === 'plan-fetch') {
      result = planFetch(input);
    } else if (subcommand === 'freeze') {
      result = cmdFreeze(input, opts);
    } else {
      result = cmdReconcile(input, opts);
    }
  } catch (e) {
    return fail(e.message);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  return undefined;
}

main();
