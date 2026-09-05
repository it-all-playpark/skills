// dev-flow Final reconcile phase: `finalReconcile === 'unavailable'` になったとき、PR head sha に
// pin した CI check を決定論的に判定する純関数群。判断は一切 LLM に委ねない
// （agent は verbatim 転写のみで、pass/fail の分岐は本ファイルの finalCiVerdict が行う）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証する。

// HOLD 理由の分類（呼び出し元が「決定論チェックで解消しうる」か「人間判断が必須」かを区別するために使う）。
// merge-tier.mjs 側にも同値の HOLD_REASON_KINDS を独立定義する（canonical は ESM import 禁止のため
// module 間で定数を共有できない）。同値性は serial task の routing test が両方 import して pin する。
export const FINAL_CI_KIND_DETERMINISTIC = 'deterministic_recheck';
export const FINAL_CI_KIND_HUMAN = 'human_judgment';

// finalCiVerdict が返す reason の closed enum。
export const FINAL_CI_REASONS = [
  'ok',
  'no-expected-sha',
  'fetch-failed',
  'invalid',
  'sha-mismatch',
  'no-checks',
  'pending',
  'failure',
];

// gh pr view --json headRefOid,statusCheckRollup の exec-proxy 応答の agent() schema。
export const FINAL_CI_META = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    headRefOid: { type: ['string', 'null'] },
    statusCheckRollup: { type: 'array', items: { type: 'object' } },
    error: { type: 'string' },
    epoch: { type: 'number' },
  },
};

const SHA40_RE = /^[0-9a-f]{40}$/i;

function isSha40(value) {
  return typeof value === 'string' && SHA40_RE.test(value);
}

// statusCheckRollup の 1 要素を { name, state } に正規化する。
// 不正な形（object でない / __typename 不明 / name 欠落）は null を返し呼び出し側で 'invalid' に倒す。
//
// SKIPPED / NEUTRAL を pass に含めるのは pr-iterate/scripts/check-ci.sh の is_passed（pass|skipping）と
// 同一規則にするため（repo 間で判定が食い違わないようにする）。未知 conclusion / state は failure に
// 倒す（fail-closed）。
function normalizeCheck(item) {
  if (!item || typeof item !== 'object') return null;
  const typename = item.__typename;
  if (typename === 'CheckRun') {
    const name = item.name;
    if (typeof name !== 'string' || name.length === 0) return null;
    const status = String(item.status ?? '').toUpperCase();
    if (status !== 'COMPLETED') {
      return { name, state: 'pending' };
    }
    const conclusion = String(item.conclusion ?? '').toUpperCase();
    if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
      return { name, state: 'success' };
    }
    return { name, state: 'failure' };
  }
  if (typename === 'StatusContext') {
    const name = item.context;
    if (typeof name !== 'string' || name.length === 0) return null;
    const state = String(item.state ?? '').toUpperCase();
    if (state === 'SUCCESS') return { name, state: 'success' };
    if (state === 'PENDING' || state === 'EXPECTED') return { name, state: 'pending' };
    return { name, state: 'failure' };
  }
  return null;
}

/**
 * ci-final exec-proxy へ渡す prompt を組み立てる純粋関数。
 * gh pr view を bare 単文で 1 回実行し、headRefOid と statusCheckRollup を verbatim で
 * 包んで返させるだけ（判定はさせない）。
 *
 * @param {object} opts
 * @param {number|string} opts.pr - 対象 PR 番号
 * @param {string|null} opts.repo - owner/name。null / 空なら --repo を付けない
 * @returns {string}
 */
export function finalCiPrompt({ pr, repo }) {
  const cmd = `gh pr view ${pr}${repo ? ' --repo ' + repo : ''} --json headRefOid,statusCheckRollup`;
  return `## Objective\n`
    + `PR #${pr} の head sha と CI check 一覧を取得し、JSON をそのまま返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n\n`
    + `## Steps\n`
    + `1. \`${cmd}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ`
    + `（cd 前置・bash 前置・環境変数代入前置・&& 連結は使わない）。\n`
    + `2. stdout が空、JSON として不正、またはコマンドが実行できなかった場合は `
    + `\`{"ok": false, "error": "<stderr の要約>"}\` を返せ。失敗時に ok:true を生成してはならない。`
    + `原因調査はするな。再試行禁止。\n`
    + `3. それ以外は stdout の JSON object から headRefOid と statusCheckRollup を取り出し、`
    + `\`{"ok": true, "headRefOid": <string>, "statusCheckRollup": <array を一字一句そのまま>}\` `
    + `に包んで返せ。要約・整形・省略禁止。\n\n`
    + `## Output format\n`
    + `{"ok": true, "headRefOid": string, "statusCheckRollup": array} または {"ok": false, "error": string}\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内（statusCheckRollup を除く）。`;
}

/**
 * PR head sha に pin した CI check の決定論判定。LLM 判定を一切含まない純関数。
 * 入力 meta を mutate しない。
 *
 * @param {object} opts
 * @param {string} opts.expectedSha - reconcile-sync 成功時の head sha（40hex 必須）
 * @param {object|null} opts.meta - ci-final exec-proxy の応答（FINAL_CI_META 形）
 * @returns {{verified: boolean, reason: string, kind: string|null, checkNames: string[], headRefOid: string|null}}
 */
export function finalCiVerdict({ expectedSha, meta }) {
  if (!isSha40(expectedSha)) {
    return { verified: false, reason: 'no-expected-sha', kind: FINAL_CI_KIND_HUMAN, checkNames: [], headRefOid: null };
  }

  if (meta === null || meta === undefined || meta.ok !== true) {
    return { verified: false, reason: 'fetch-failed', kind: FINAL_CI_KIND_DETERMINISTIC, checkNames: [], headRefOid: null };
  }

  if (!isSha40(meta.headRefOid)) {
    return { verified: false, reason: 'invalid', kind: FINAL_CI_KIND_DETERMINISTIC, checkNames: [], headRefOid: null };
  }

  if (meta.headRefOid.toLowerCase() !== expectedSha.toLowerCase()) {
    return { verified: false, reason: 'sha-mismatch', kind: FINAL_CI_KIND_HUMAN, checkNames: [], headRefOid: meta.headRefOid };
  }

  if (!Array.isArray(meta.statusCheckRollup)) {
    return { verified: false, reason: 'invalid', kind: FINAL_CI_KIND_DETERMINISTIC, checkNames: [], headRefOid: meta.headRefOid };
  }

  const normalized = [];
  for (const item of meta.statusCheckRollup) {
    const n = normalizeCheck(item);
    if (n === null) {
      return { verified: false, reason: 'invalid', kind: FINAL_CI_KIND_DETERMINISTIC, checkNames: [], headRefOid: meta.headRefOid };
    }
    normalized.push(n);
  }

  if (normalized.length === 0) {
    return { verified: false, reason: 'no-checks', kind: FINAL_CI_KIND_HUMAN, checkNames: [], headRefOid: meta.headRefOid };
  }

  const failures = normalized.filter((c) => c.state === 'failure').map((c) => c.name);
  if (failures.length > 0) {
    return { verified: false, reason: 'failure', kind: FINAL_CI_KIND_HUMAN, checkNames: failures, headRefOid: meta.headRefOid };
  }

  const pendings = normalized.filter((c) => c.state === 'pending').map((c) => c.name);
  if (pendings.length > 0) {
    return { verified: false, reason: 'pending', kind: FINAL_CI_KIND_DETERMINISTIC, checkNames: pendings, headRefOid: meta.headRefOid };
  }

  return {
    verified: true,
    reason: 'ok',
    kind: null,
    checkNames: normalized.map((c) => c.name),
    headRefOid: meta.headRefOid,
  };
}
