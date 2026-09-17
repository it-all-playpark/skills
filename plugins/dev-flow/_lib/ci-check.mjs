// ci-check: pr-iterate の CI gate（`ci-check#i`）と dev-flow lite route の `ci-check-lite` が
// 共有する CI ステータス取得の契約 — 定数 / StructuredOutput schema / prompt 本文。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証する。
//
// なぜ canonical 化するか: 以前は同じ prompt 本文・schema・定数が dev-flow.js と pr-iterate.js に
// 手で複製されており（inline 生成区間の外）、CI polling の仕様を変えると 2 箇所を手で同期する
// 必要があった。片側だけ直すと lite route と pr-iterate で CI 判定が食い違う。
//
// REVIEW schema をここに含めないのは、両者が実際に異なるため（dev-flow 側のみ clock telemetry の
// 給電元として optional `epoch` を持つ）。統合すると pr-iterate の受理 schema が変わる。

// ci-check は 1 spawn = 1 判定。必要 turn = 2（gh fetch + check-ci）+ 1（StructuredOutput）
// + CI_TURN_MARGIN = 6。ci-wait は 1（sleep）+ 1（StructuredOutput）+ CI_TURN_MARGIN = 5。
// どちらも dev-runner-haiku-ro の maxTurns を超えないこと（_lib/ci-check.test.mjs が agent md を
// 実読して pin）。CI 待ちのループは workflow script 側（pr-iterate.js）が持ち、CI 所要時間は
// turn 会計に影響しない（issue #663。旧: agent 内 attempt ループで ceiling 90 秒、attempt 増で
// StructuredOutput 未達 → ci_error に化けた issue #621）。
export const CI_POLL_SECONDS = 45; // script 側 ci-wait ループの poll 間隔（秒）
export const CI_WAIT_CEILING_SECONDS = 300; // script 側ループの nominal 総待機上限（秒）
export const CI_MAX_POLLS = Math.floor(CI_WAIT_CEILING_SECONDS / CI_POLL_SECONDS) + 1; // ci-check spawn 回数の上限
// 実測マージン。文書化 worst case 8 tool call に対し実測 10 で StructuredOutput 未達だった差分に基づく。
export const CI_TURN_MARGIN = 3;

// CI gate schema — the gate lost in eb8aa7e (issue #133) を復元したもの。
// dev-runner-haiku-ro が bare `gh pr checks` で CI snapshot を取得し、
// pr-iterate/scripts/check-ci.sh（snapshot に対する純変換）で分類して stdout JSON を verbatim で返す。
// fetch を script でなく agent 側に置くのは、exec-proxy script が認証付き network I/O を
// 持ってはならないため（issue #488）。
// failed_checks の要素は script 出力と一致する {name, bucket, state}
// （conclusion は bucket-field migration で削除。issue #133 / ci::bats-fabricated-schema）。
// status:'error' は check-ci が gh fetch 失敗を分類した値。workflow 側は proxy の空応答（turn 上限到達等）も fail-open で同じ 'error' に合成するため、受け手は原因を 1 つに断定できない（issue #621）。即座に人間へエスカレーションする。
export const CI_STATUS = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'pending', 'no_checks', 'error'] },
    failed_checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bucket: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
    // check-ci.sh が常に出す accounting キー（1 spawn = 1 判定では常に 0 / 1）。
    // workflow は読まず script 側で積算する（issue #663）。
    waited_seconds: { type: 'number' },
    poll_attempts: { type: 'number' },
    // dev-flow の clock telemetry（issue #443）が iterate_end の給電元として読む optional epoch。
    // 旧版 check-ci.sh（epoch 非対応）や失敗時は省略され、返り値の end_epoch も省略される（fail-open）。
    epoch: { type: 'number' },
  },
};

/**
 * ci-check exec-proxy の prompt を組み立てる純粋関数。
 *
 * @param {object} opts
 * @param {number|string} opts.pr - 対象 PR 番号
 * @param {string|null} opts.repo - owner/name。null / 空なら --repo を付けない（cwd の repo を使う）
 * @returns {string} dev-runner-haiku-ro へ渡す prompt
 */
export function ciCheckPrompt({ pr, repo }) {
  return `## Objective\nPR #${pr} の CI ステータスを取得し、JSON をそのまま返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n`
    + `- 実行するスクリプト以外のファイルを変更しない\n\n`
    + `## Steps\n`
    + `1. \`gh pr checks ${pr}${repo ? ' --repo ' + repo : ''} --json name,state,bucket\` を gh を先頭トークンとする bare 単文で実行せよ`
    + `（リダイレクト・パイプ・複合コマンドは使わない）。`
    + `このコマンドの exit code を判定に使ってはならない（pending で 8、失敗ありで 1 を返す仕様であり、fetch 自体の成否とは無関係）。\n`
    + `2. \`check-ci --checks-data '<手順1の stdout を一字一句そのまま。要約・整形・省略禁止>' `
    + `--fetch-error-data '<手順1の stderr を一字一句そのまま。stderr が空なら本オプション自体を省略>'\` `
    + `を単文で実行し、stdout の JSON を読め。\n`
    + `3. その stdout JSON（{status, failed_checks, waited_seconds, poll_attempts, ...}）をそのまま返せ。要約・加工するな。`
    + `1 回の取得で判定を確定させ、待機や再取得は行うな。\n\n`
    + `## Output format\n`
    + `{ "status": "passed"|"failed"|"pending"|"no_checks"|"error", "failed_checks": [{name, bucket, state}, ...], `
    + `"waited_seconds": number, "poll_attempts": number }\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}

// ci-wait exec-proxy の応答 schema — script 側 ci-wait ループの 1 poll 分の sleep 完了報告。
export const CI_WAIT = {
  type: 'object',
  required: ['slept'],
  properties: {
    slept: { type: 'boolean' },
    seconds: { type: 'number' },
  },
};

/**
 * ci-wait exec-proxy の prompt を組み立てる純粋関数。
 *
 * @param {object} opts
 * @param {number} opts.seconds - sleep 秒数
 * @returns {string} dev-runner-haiku-ro へ渡す prompt
 */
export function ciWaitPrompt({ seconds }) {
  return `## Objective\nCI 完了待ちのため ${seconds} 秒待機し、結果 JSON を返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push, gh\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。ファイル・git を変更しない\n\n`
    + `## Steps\n`
    + `1. \`sleep ${seconds}\` を sleep を先頭トークンとする bare 単文で実行せよ（リダイレクト・パイプ・複合コマンドは使わない）。\n`
    + `2. 完了したら {"slept": true, "seconds": ${seconds}} を返せ。\n\n`
    + `## Output format\n`
    + `{ "slept": boolean, "seconds": number }\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}
