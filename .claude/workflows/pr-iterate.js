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

phase('Iterate')

let lastReview = null
let lgtm = false
let i = 0
let terminal = null              // 早期終端理由（stuck / fix_failed）。null なら lgtm / max_reached で判定
const reviewSeen = {}            // topic → { issue, count }（findings 累積 & stuck 検出。issue #126）

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
    lgtm = true
    log(`iteration ${i}: LGTM`)
    break
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

return {
  pr: PR,
  status,
  iterations: Math.min(i, MAX),
  last_decision: lastReview?.decision ?? null,
  last_summary: lastReview?.summary ?? null,
}
