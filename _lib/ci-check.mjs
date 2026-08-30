// ci-check: pr-iterate の CI gate（`ci-check#i`）と dev-flow lite route の `ci-check-lite` が
// 共有する CI ステータス取得の契約 — attempt ループ定数 / StructuredOutput schema / prompt 本文。
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

// Bounded wait for pending CI: CI_MAX_ATTEMPTS 回を CI_POLL_SECONDS 間隔で試すので
// ceiling は (CI_MAX_ATTEMPTS-1)*CI_POLL_SECONDS = 90 秒。
// agent は fetch / classify / sleep でそれぞれ 1 Bash turn を消費するため最悪 3+3+2 = 8 tool call。
// 調整時は (attempt 数 × 2) - 1 が dev-runner-haiku-ro の maxTurns (10) を超えないこと。
export const CI_MAX_ATTEMPTS = 3;
export const CI_POLL_SECONDS = 45;

// CI gate schema — the gate lost in eb8aa7e (issue #133) を復元したもの。
// dev-runner-haiku-ro が bare `gh pr checks` で CI snapshot を取得し、
// pr-iterate/scripts/check-ci.sh（snapshot に対する純変換）で分類して stdout JSON を verbatim で返す。
// fetch を script でなく agent 側に置くのは、exec-proxy script が認証付き network I/O を
// 持ってはならないため（issue #488）。
// failed_checks の要素は script 出力と一致する {name, bucket, state}
// （conclusion は bucket-field migration で削除。issue #133 / ci::bats-fabricated-schema）。
// status:'error' は gh fetch 自体の失敗（auth/network）を意味し、即座に人間へエスカレーションする。
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
    // ci-check の attempt ループの累積待機秒数 / ポーリング（gh fetch）回数（issue #324）。
    // 待機なし（1 attempt で確定）でも script は常に返す。
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
    + `attempt=1 から開始し、次を最大 ${CI_MAX_ATTEMPTS} 回繰り返せ:\n`
    + `1. \`gh pr checks ${pr}${repo ? ' --repo ' + repo : ''} --json name,state,bucket\` を gh を先頭トークンとする bare 単文で実行せよ`
    + `（リダイレクト・パイプ・複合コマンドは使わない）。`
    + `このコマンドの exit code を判定に使ってはならない（pending で 8、失敗ありで 1 を返す仕様であり、fetch 自体の成否とは無関係）。\n`
    + `2. \`bash ~/.claude/skills/pr-iterate/scripts/check-ci.sh --checks-data '<手順1の stdout を一字一句そのまま。要約・整形・省略禁止>' `
    + `--fetch-error-data '<手順1の stderr を一字一句そのまま。stderr が空なら本オプション自体を省略>' `
    + `--attempt <attempt> --max-attempts ${CI_MAX_ATTEMPTS} --poll-seconds ${CI_POLL_SECONDS}\` `
    + `を単文で実行し、stdout の JSON を読め。\n`
    + `3. その JSON の \`next_action\` が \`"poll"\` なら \`sleep ${CI_POLL_SECONDS}\` を単文で実行し、attempt を 1 増やして 1 へ戻れ。`
    + `\`"done"\` なら 4 へ進め。\n`
    + `4. 最後に得た stdout JSON（{status, failed_checks, waited_seconds, poll_attempts, ...}）をそのまま返せ。要約・加工するな。\n`
    + `CI pending 時は最大 ${(CI_MAX_ATTEMPTS - 1) * CI_POLL_SECONDS} 秒（${CI_POLL_SECONDS} 秒間隔）待ってから確定する。\n\n`
    + `## Output format\n`
    + `{ "status": "passed"|"failed"|"pending"|"no_checks"|"error", "failed_checks": [{name, bucket, state}, ...], `
    + `"waited_seconds": number, "poll_attempts": number }\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}
