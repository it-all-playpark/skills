export const meta = {
  name: 'pr-iterate',
  description: 'PR を review ⇄ fix で LGTM になるまで反復（上限 10）。単体起動も dev-flow からのサブ呼びも可',
  phases: [
    { title: 'Iterate' },
  ],
}

function resolvePositiveIntArg(args, name) {
  const raw = (typeof args === 'string' || typeof args === 'number')
    ? args
    : (args?.[name] ?? args?.[0]);
  const s = String(raw ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error(`${name}: 正の整数が必要です（受信: ${JSON.stringify(s)}）`);
  }
  return s;
}

// args 正規化: 単体 /pr-iterate <pr> でも dev-flow からの workflow('pr-iterate', {pr}) でも受ける
const PR = resolvePositiveIntArg(args, 'pr')
const MAX = Number(args?.max_iterations ?? 10)
const REVIEW_STUCK = 2   // 同一 topic がこの回数出たら stuck と判定し人間へエスカレーション（issue #126）

// ---- Review de-churn モデル（issue #126。#123 Plan ループ収束モデルの Review 版を inline 複製）----
// cold start の pr-reviewer は moving target を生む（毎回 fresh context で全 PR diff を再レビューし、
// Adversarial Opener の「能動的に探せ」指示と相まって、安定コードに新しい主観的 major を捻り出しうる）。
// orchestrator 側で churn だけを殺す（ゲートは堅いまま）:
//   1. 既出 findings を pr-reviewer に渡し「対応済み・新規 critical/major のみ・蒸し返し禁止」を指示
//   2. 同一 topic が REVIEW_STUCK 回出たら stuck と判定（fingerprint を JS 側で突合）→ status:'stuck' で人間へ
//   3. fix の applied:false を検出したら status:'fix_failed' で即座に人間へエスカレーション
//      （無言で MAX 回燃やさない。現状この返り値は捨てられていた）
//   4. critical/major は常にブロック（**relax は入れない** = ゲート後退なし）。
//      #123 の PLAN_RELAX_FROM 相当は移植しない — Review は main にマージされる実コードの最後のゲートで
//      merge は手動。「N 回回ったから major 残ったまま approve」は既知の major 出荷になり実害が大きい。
//   5. lgtm / stuck / fix_failed / max_reached は throw せず status で返し、終端理由を log() で可視化。
// loader 制約（commit 6243022: ESM import 不可）により dev-flow.js の planSeen ロジックは共有できず inline 複製する。

// issue の fingerprint（topic）を導出する。pr-reviewer が同一問題に同じ topic 文字列を返せば
// それを優先し、無ければ file + description から安定キーを合成する（同一指摘の再出現を突合するため）。
function issueTopic(x) {
  if (x && typeof x.topic === 'string' && x.topic.trim()) return x.topic.trim()
  const file = (x && x.file != null) ? String(x.file) : ''
  const desc = (x && x.description != null) ? String(x.description) : JSON.stringify(x)
  return `${file}::${desc}`
}

// ---- PR コメント生成関数 inline コピー（_lib/pr-comment-format.mjs から export 除去）-----------
// loader 制約（ESM import 不可）のため関数本体を inline コピーしている。
// _lib/pr-comment-format.sync.test.mjs がこの inline コピーの byte 一致を CI で保証する。
// この関数を修正する際は、必ず _lib/pr-comment-format.mjs の元も同期すること。

const DECISION_LABEL = {
  'approve': '承認 (LGTM)',
  'request-changes': '変更要求',
  'comment': 'コメント',
};

function buildReviewCommentBody({ pr, iteration, decision, blocking }) {
  const label = DECISION_LABEL[decision] ?? decision;
  const lines = [];

  lines.push(`## PR #${pr} — レビュー結果 (iteration ${iteration})`);
  lines.push('');
  lines.push(`**判定**: ${label}`);
  lines.push('');
  lines.push('### Blocking 指摘');

  if (!blocking || blocking.length === 0) {
    lines.push('blocking 指摘なし');
  } else {
    for (const f of blocking) {
      const loc = f.file != null
        ? `${f.file}${f.line != null ? ':' + f.line : ''} `
        : '';
      const sug = f.suggestion != null ? ` → ${f.suggestion}` : '';
      lines.push(`- [${f.severity}] ${loc}${f.description}${sug}`);
    }
  }

  return lines.join('\n');
}

const STATUS_HEADLINE = {
  'lgtm': '🎉 LGTM',
  'stuck': '⚠️ STUCK — 人間レビューへエスカレーション',
  'fix_failed': '⚠️ 自動修正失敗 — 人間へエスカレーション',
  'max_reached': '⚠️ 反復上限到達',
};

function buildTerminalSummaryBody({ pr, status, iterations, lastDecision, lastSummary, history }) {
  const headline = STATUS_HEADLINE[status] ?? status;
  const lines = [];

  lines.push(`## PR #${pr} — pr-iterate 終了レポート`);
  lines.push('');
  lines.push(`### ${headline}`);
  lines.push('');
  lines.push(`- **総反復回数**: ${iterations}`);
  lines.push(`- **最終判定**: ${DECISION_LABEL[lastDecision] ?? lastDecision}`);
  lines.push(`- **最終判定理由**: ${lastSummary}`);

  if (history && history.length > 0) {
    lines.push('');
    lines.push('### 反復履歴');
    for (const round of history) {
      const roundLabel = DECISION_LABEL[round.decision] ?? round.decision;
      lines.push('');
      lines.push(`#### Iteration ${round.iteration}: ${roundLabel}`);
      lines.push(`${round.summary}`);
      if (round.blocking && round.blocking.length > 0) {
        lines.push(`- blocking 指摘数: ${round.blocking.length}`);
        for (const f of round.blocking) {
          const loc = f.file != null
            ? `${f.file}${f.line != null ? ':' + f.line : ''} `
            : '';
          const sug = f.suggestion != null ? ` → ${f.suggestion}` : '';
          lines.push(`  - [${f.severity}] ${loc}${f.description}${sug}`);
        }
      } else {
        lines.push('- blocking 指摘なし');
      }
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('*このコメントは pr-iterate により自動生成されました。*');
  lines.push(`<!-- pr-iterate:${status}:${iterations} -->`);

  return lines.join('\n');
}

// ---- 投稿本文を agent に保存・投稿させるヘルパー --------------------------------------
// workflow runtime には fs/os/path（require）も Date.now() も無いため、orchestrator 側で
// 一時ファイルを書き出すことはできない。代わりに本文を delimiter 付きで agent プロンプトへ
// 埋め込み、agent 側で Write tool を使って一時ファイルへ保存させてから --body-file で投稿させる。
// Write tool の content 引数は shell（echo/heredoc）を経由しないため、triple-backtick や
// バッククォートを含むレビュー本文でもフェンス境界・コマンド置換が衝突しない
// （旧 writeTempBody の「本文を shell に通さない」意図を agent 側で構造的に再現する）。
function bodySaveInstr(body) {
  return `## 本文の保存\n`
    + `まず Bash で \`mktemp /tmp/pr-iterate-XXXXXX.md\` を実行して一時ファイルを作成し、\n`
    + `そのパスを <BODY_FILE> とする。次に **Write tool** を使い、下記 delimiter 内の本文を\n`
    + `**一字一句そのまま** <BODY_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。backtick やコードフェンスを\n`
    + `エスケープ・改変しないこと。以降のコマンドの \`--body-file\` には <BODY_FILE> を指定する。\n`
    + `<<<PR_ITERATE_BODY_BEGIN>>>\n${body}\n<<<PR_ITERATE_BODY_END>>>\n\n`
}

// ---- POST_RESULT schema（dev-runner 経由の PR 投稿結果）-----------------------------------
const POST_RESULT = {
  type: 'object',
  required: ['posted'],
  properties: {
    posted: { type: 'boolean' },
    method: { type: 'string' },
    url: { type: 'string' },
  },
}

const REVIEW = {
  type: 'object',
  required: ['decision', 'issues', 'summary'],
  properties: {
    decision: { type: 'string', enum: ['approve', 'request-changes', 'comment'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          // 同一問題の再出現を orchestrator が stuck 突合するための安定 ID（issue #126）。
          // 既出指摘を再提起する場合は前ラウンドと同じ文字列を必ず再利用する。
          topic: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const FIX = {
  type: 'object',
  required: ['applied', 'summary'],
  properties: {
    applied: { type: 'boolean' },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

// CI gate schema — restores the gate lost in eb8aa7e (issue #133).
// dev-runner runs pr-iterate/scripts/check-ci.sh and returns its stdout JSON unchanged.
// failed_checks items match script output: {name, bucket, state} (conclusion was removed in
// the bucket-field migration; see issue #133 / ci::bats-fabricated-schema).
// 'error' status means gh API failed (auth/network); escalate to human immediately.
const CI_STATUS = {
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
  },
}

phase('Iterate')

let lastReview = null
let lgtm = false
let i = 0
let terminal = null              // 早期終端理由（stuck / fix_failed）。null なら lgtm / max_reached で判定
const reviewSeen = {}            // topic → { issue, count }（findings 累積 & stuck 検出。issue #126）
const history = []               // ラウンド履歴 [{iteration, decision, summary, blocking}]

for (i = 1; i <= MAX; i++) {
  const prior = Object.values(reviewSeen).map((s) => s.issue)   // 前 iteration までの累積 findings
  const review = await agent(
    `PR #${PR} を批判的にレビューせよ。gh pr view / gh pr diff で実 diff を確認し、宣言意図に照合する。\n`
    + (prior.length
        ? `既出 findings（前ラウンドまでに指摘済み。author は対応済みのはず）:\n${JSON.stringify(prior)}\n`
          + `**新規の critical/major のみ報告**せよ。前ラウンドで対応済み・却下済みの論点の蒸し返し、`
          + `別観点の上乗せ（moving target）は禁止。既出問題を再提起する場合は既出と同じ topic 文字列を`
          + `必ず再利用せよ（orchestrator が topic で stuck を突合する）。`
        : ''),
    { agentType: 'pr-reviewer', schema: REVIEW, label: `review#${i}`, phase: 'Iterate' },
  )
  if (review == null) throw new Error(`pr-iterate: review#${i} が結果を返しませんでした（skip された可能性）`)
  lastReview = review

  if (review.decision === 'approve') {
    // CI gate — restores the gate lost in eb8aa7e (issue #133).
    // pr-reviewer may LGTM the code but CI must also be green before we declare lgtm.
    // no_checks is treated as passing (consistent with e4e2b92: repos without CI are fine).
    const ci = await agent(
      `## Objective\n`
      + `PR #${PR} の CI ステータスを取得し、JSON をそのまま返せ。\n\n`
      + `## Tools\n`
      + `- 使用可: Bash のみ\n`
      + `- 禁止: Write, Edit, git commit, git push\n\n`
      + `## Boundary\n`
      + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n`
      + `- 実行するスクリプト以外のファイルを変更しない\n\n`
      + `## Steps\n`
      + `skills repo（インストール済みの場合は \`$HOME/.claude/skills\`、`
      + `またはリポジトリのワーキングツリーを locate して）の `
      + `\`pr-iterate/scripts/check-ci.sh\` を実行せよ:\n`
      + `\`\`\`\nbash pr-iterate/scripts/check-ci.sh ${PR}\n\`\`\`\n`
      + `スクリプトの stdout JSON（{status, failed_checks, ...}）をそのまま返せ。\n\n`
      + `## Output format\n`
      + `{ "status": "passed"|"failed"|"pending"|"no_checks"|"error", "failed_checks": [{name, bucket, state}, ...] }\n`
      + `prose 禁止。JSON のみ返せ。\n\n`
      + `## Token cap\n`
      + `JSON のみ。1 行以内。`,
      { agentType: 'dev-runner', schema: CI_STATUS, label: `ci-check#${i}`, phase: 'Iterate' },
    )

    if (ci == null) throw new Error(`pr-iterate: ci-check#${i} が結果を返しませんでした`)

    if (ci.status === 'passed' || ci.status === 'no_checks') {
      lgtm = true
      log(`iteration ${i}: LGTM（CI status=${ci.status}）`)

      // approve ラウンドの history を記録（blocking なし）
      history.push({ iteration: i, decision: review.decision, summary: review.summary, blocking: [] })

      // per-round 投稿: approve（self-PR 検出 → --approve 失敗時 gh pr comment へフォールバック）
      const approveBody = buildReviewCommentBody({ pr: PR, iteration: i, decision: review.decision, blocking: [] })
      const approvePost = await agent(
        `## Objective\nPR #${PR} に pr-iterate のレビュー結果コメントを投稿する（iteration ${i}、判定: approve）。\n\n`
        + bodySaveInstr(approveBody)
        + `## Instructions\n`
        + `保存した <BODY_FILE> を使って以下の手順で投稿せよ：\n`
        + `1. self-PR 検出: \`gh pr view ${PR} --json author -q .author.login\` の出力と \`gh api user -q .login\` の出力を比較する。\n`
        + `2. 自分自身の PR である場合（または --approve が "Cannot approve your own pull request" エラーになる場合）は、\n`
        + `   \`gh pr comment ${PR} --body-file <BODY_FILE>\` でコメント投稿にフォールバックする。\n`
        + `3. 自分自身の PR でない場合は \`gh pr review ${PR} --approve --body-file <BODY_FILE>\` を試みる。\n`
        + `   失敗した場合（"Cannot approve your own pull request" 等）は \`gh pr comment ${PR} --body-file <BODY_FILE>\` にフォールバックする。\n`
        + `4. 投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
        + `5. 投稿失敗時でも posted:false を返し throw しないこと。\n`
        + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
        + `\n## Tools\n使用可: Bash, Write\n`
        + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
        + `\n## Token cap\n200 語以内で完結すること。`,
        { agentType: 'dev-runner', schema: POST_RESULT, label: `post-review#${i}`, phase: 'Iterate' },
      )
      if (!approvePost?.posted) {
        log(`⚠️ post-review#${i} (approve) の投稿に失敗しました（posted=${approvePost?.posted ?? 'null'}）。ワークフローは継続します。`)
      }

      break
    } else if (ci.status === 'error') {
      // Real gh API error (auth failure, network error, etc.) — do not misinterpret as CI failure.
      // Surface to human immediately; retrying pr-fix on a non-existent bug would waste cycles.
      terminal = 'ci_error'
      log(`⚠️ CI check returned error — gh API failed (auth/network). 人間へエスカレーション`)
      break
    } else if (ci.status === 'pending') {
      terminal = 'ci_pending'
      log(`⚠️ CI pending — checks incomplete, never auto-approve. 人間/CI 完了待ちへエスカレーション`)
      break
    } else if (ci.status === 'failed') {
      // ci.status === 'failed': convert failed_checks into synthetic blocking findings and route
      // through the existing pr-fix path. Repeated identical ci::<name> topics hit REVIEW_STUCK
      // automatically via the existing stuckTopics computation below.
      // failed_checks items are {name, bucket, state} per check-ci.sh output (no conclusion field).
      const ciFindings = (ci.failed_checks && ci.failed_checks.length > 0)
        ? ci.failed_checks.map((c) => ({
            severity: 'critical',
            topic: `ci::${c.name}`,
            description: `CI check failed: ${c.name} (${c.state ?? c.bucket})`,
            suggestion: 'CI を green にする',
          }))
        : [{
            severity: 'critical',
            topic: 'ci::unknown',
            description: 'CI failed (no specific check details available)',
            suggestion: 'CI を green にする',
          }]

      // Register CI findings into reviewSeen exactly like the existing blocking loop so that
      // repeated identical CI failures (same ci::<name> topic) trigger REVIEW_STUCK escalation.
      for (const x of ciFindings) {
        const t = issueTopic(x)
        if (reviewSeen[t]) { reviewSeen[t].issue = x; reviewSeen[t].count += 1 }
        else reviewSeen[t] = { issue: x, count: 1 }
      }
      const ciStuckTopics = Object.entries(reviewSeen).filter(([, s]) => s.count >= REVIEW_STUCK).map(([t]) => t)
      log(`iteration ${i}: approve but CI failed — ${ciFindings.length} failing check(s)`
        + `${ciStuckTopics.length ? ` [REVIEW_STUCK: ${ciStuckTopics.join(' / ')}]` : ''}`)

      if (ciStuckTopics.length) {
        terminal = 'stuck'
        log(`⚠️ Review STUCK — 同一 CI failure topic が ${REVIEW_STUCK} 回反復（${ciStuckTopics.join(' / ')}）。`
          + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
        break
      }

      const issuesText = ciFindings
        .map((x) => `- [${x.severity}] ${x.description}${x.suggestion ? ' → ' + x.suggestion : ''}`)
        .join('\n')

      const fix = await agent(
        `PR #${PR} の CI 失敗を修正する。次の CI 失敗を解消するため \`Skill: pr-fix ${PR}\` を実行し、`
        + `修正を push まで行え。解消すべき CI 失敗:\n${issuesText}`,
        { agentType: 'dev-runner', schema: FIX, label: `fix#${i}`, phase: 'Iterate' },
      )

      if (fix == null || fix.applied !== true) {
        terminal = 'fix_failed'
        log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}。`
          + `無言で再レビューを繰り返さず人間へエスカレーション`)
        break
      }

      // CI fix applied — continue to next iteration for re-review + re-CI-check
      continue
    }
  }

  const blocking = review.issues.filter((x) => x.severity === 'critical' || x.severity === 'major')

  // blocking findings を topic 単位で累積し出現回数を数える（stuck 検出 fingerprint。issue #126）
  for (const x of blocking) {
    const t = issueTopic(x)
    if (reviewSeen[t]) { reviewSeen[t].issue = x; reviewSeen[t].count += 1 }
    else reviewSeen[t] = { issue: x, count: 1 }
  }
  const stuckTopics = Object.entries(reviewSeen).filter(([, s]) => s.count >= REVIEW_STUCK).map(([t]) => t)
  log(`iteration ${i}: ${review.decision} — blocking ${blocking.length} 件`
    + `${stuckTopics.length ? ` [REVIEW_STUCK: ${stuckTopics.join(' / ')}]` : ''}`)

  // history に記録（blocking findings を含む）
  history.push({ iteration: i, decision: review.decision, summary: review.summary, blocking })

  // per-round 投稿: request-changes または comment
  const roundBody = buildReviewCommentBody({ pr: PR, iteration: i, decision: review.decision, blocking })
  const roundPost = await agent(
    `## Objective\nPR #${PR} に pr-iterate のレビュー結果コメントを投稿する（iteration ${i}、判定: ${review.decision}）。\n\n`
    + bodySaveInstr(roundBody)
    + `## Instructions\n`
    + (review.decision === 'request-changes'
      ? `保存した <BODY_FILE> を使って以下の手順で投稿せよ：\n`
        + `1. self-PR 検出: \`gh pr view ${PR} --json author -q .author.login\` の出力と \`gh api user -q .login\` の出力を比較する。\n`
        + `2. 自分自身の PR である場合（または --request-changes が "Can not request changes on your own pull request" エラーになる場合）は、\n`
        + `   \`gh pr comment ${PR} --body-file <BODY_FILE>\` でコメント投稿にフォールバックする。\n`
        + `3. 自分自身の PR でない場合は \`gh pr review ${PR} --request-changes --body-file <BODY_FILE>\` を試みる。\n`
        + `   失敗した場合（"Can not request changes on your own pull request" 等）は \`gh pr comment ${PR} --body-file <BODY_FILE>\` にフォールバックする。\n`
      : `保存した <BODY_FILE> を使い、以下のコマンドをそのまま実行せよ: \`gh pr review ${PR} --comment --body-file <BODY_FILE>\`\n`)
    + `投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
    + `投稿失敗時でも posted:false を返し throw しないこと。\n`
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n`
    + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
    + `\n## Token cap\n200 語以内で完結すること。`,
    { agentType: 'dev-runner', schema: POST_RESULT, label: `post-review#${i}`, phase: 'Iterate' },
  )
  if (!roundPost?.posted) {
    log(`⚠️ post-review#${i} (${review.decision}) の投稿に失敗しました（posted=${roundPost?.posted ?? 'null'}）。ワークフローは継続します。`)
  }

  // stuck: 同一 topic が REVIEW_STUCK 回繰り返した = fix が刺さっていない。relax せず人間へエスカレーション。
  if (stuckTopics.length) {
    terminal = 'stuck'
    log(`⚠️ Review STUCK — 同一 topic が ${REVIEW_STUCK} 回反復（${stuckTopics.join(' / ')}）。`
      + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
    break
  }

  // pr-fix は portable skill。汎用 workflow agent から Skill 経由で実行する。
  const issuesText = blocking
    .map((x) => `- [${x.severity}] ${x.file ?? ''}${x.line ? ':' + x.line : ''} ${x.description}${x.suggestion ? ' → ' + x.suggestion : ''}`)
    .join('\n')

  // pr-fix は portable skill。Skill を持つ dev-runner agent 経由で実行する。
  const fix = await agent(
    `PR #${PR} のレビュー指摘を修正する。次の指摘を解消するため \`Skill: pr-fix ${PR}\` を実行し、`
    + `修正を push まで行え。解消すべき指摘:\n${issuesText}`,
    { agentType: 'dev-runner', schema: FIX, label: `fix#${i}`, phase: 'Iterate' },
  )

  // fix の applied:false を検出して人間へエスカレーション（無言で MAX 回燃やさない。issue #126）。
  if (fix == null || fix.applied !== true) {
    terminal = 'fix_failed'
    log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}。`
      + `無言で再レビューを繰り返さず人間へエスカレーション`)
    break
  }
}

const status = lgtm ? 'lgtm' : (terminal ?? 'max_reached')
log(`pr-iterate 終端: status=${status}（iterations=${Math.min(i, MAX)}）`)

// 終端サマリーを PR に 1 回だけ投稿する
const summaryBody = buildTerminalSummaryBody({
  pr: PR,
  status,
  iterations: Math.min(i, MAX),
  lastDecision: lastReview?.decision ?? null,
  lastSummary: lastReview?.summary ?? null,
  history,
})
const summaryPost = await agent(
  `## Objective\nPR #${PR} に pr-iterate の終端サマリーコメントを投稿する（status: ${status}）。\n\n`
  + bodySaveInstr(summaryBody)
  + `## Instructions\n`
  + `保存した <BODY_FILE> を使い、以下のコマンドをそのまま実行せよ: \`gh pr comment ${PR} --body-file <BODY_FILE>\`\n`
  + `投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
  + `投稿失敗時でも posted:false を返し throw しないこと。\n`
  + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
  + `\n## Tools\n使用可: Bash, Write\n`
  + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
  + `\n## Token cap\n200 語以内で完結すること。`,
  { agentType: 'dev-runner', schema: POST_RESULT, label: `post-summary`, phase: 'Iterate' },
)
if (!summaryPost?.posted) {
  log(`⚠️ post-summary の投稿に失敗しました（posted=${summaryPost?.posted ?? 'null'}）。ワークフローは継続します。`)
}

return {
  pr: PR,
  status,
  iterations: Math.min(i, MAX),
  last_decision: lastReview?.decision ?? null,
  last_summary: lastReview?.summary ?? null,
}
