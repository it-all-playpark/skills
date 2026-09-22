// _lib/analyze-contract.mjs
// buildReqFromContract: dev-flow-prerun の analyze 段（prerun-analyze.sh = `analyze-issue --contract` の
// 決定論 parse + Jev 有界判定）の出力 `args.setup.analyze` から REQ を決定論構成する純粋関数。
// dev-flow の Analyze phase はこの whitelist 検証と 3 条件ゲート（AC 空 / comment_conflicts 非空 /
// uncertain 非空）だけを行い、通常経路では agent を 1 つも spawn しない（issue #690）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// whitelist 検証項目（1 つでも不合格なら null。呼び出し元は prerun 出力の契約違反として throw する —
// LLM 転写経路は存在しないので fallback 先は無い）:
//   - analyze が object（配列・null 除く）で analyze.ok === true
//   - analyze.analyze_path が 'contract' か 'jev'（'sonnet' はゲート後に Workflow 側が付ける値で入力には現れない）
//   - analyze.issue_title が非空 string
//   - analyze.issue_type が非空 string（enum 外は classifyShape が floor=complex に倒すので here では弾かない）
//   - analyze.acceptance_criteria が配列で全要素が非空 string（空配列は許容 — AC 空ゲートは Workflow 側）
//   - analyze.breaking_change / breaking_keyword_scan が boolean
//   - analyze.comment_overrides / comment_conflicts / uncertain / jev_reasons が string 配列
//   - analyze.scope が string、analyze.scope_truncated が boolean
//
// 合格時、REQ をキー個別 copy で構成する（spread しない — 未知キーの混入防止）。
// 事前 shape 見積もりは REQ に載せない — 実効 shape は realized diff の file 数から classifyShape が決める（issue #676）。
export const ANALYZE_PATH_INPUT = ['contract', 'jev']

function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === 'string')
}

export function buildReqFromContract(analyze, issueNumber) {
  if (analyze === null || typeof analyze !== 'object' || Array.isArray(analyze)) return null
  if (analyze.ok !== true) return null
  if (!ANALYZE_PATH_INPUT.includes(analyze.analyze_path)) return null
  if (typeof analyze.issue_title !== 'string' || analyze.issue_title.length === 0) return null
  if (typeof analyze.issue_type !== 'string' || analyze.issue_type.length === 0) return null

  if (!Array.isArray(analyze.acceptance_criteria)) return null
  if (!analyze.acceptance_criteria.every((ac) => typeof ac === 'string' && ac.length > 0)) return null

  if (typeof analyze.breaking_change !== 'boolean') return null
  if (typeof analyze.breaking_keyword_scan !== 'boolean') return null
  if (!isStringArray(analyze.comment_overrides)) return null
  if (!isStringArray(analyze.comment_conflicts)) return null
  if (!isStringArray(analyze.uncertain)) return null
  if (!isStringArray(analyze.jev_reasons)) return null
  if (typeof analyze.scope !== 'string') return null
  if (typeof analyze.scope_truncated !== 'boolean') return null

  const req = {
    summary: `Issue #${issueNumber}: ${analyze.issue_title}`,
    issue_number: Number(issueNumber),
    issue_title: analyze.issue_title,
    issue_type: analyze.issue_type,
    acceptance_criteria: analyze.acceptance_criteria.slice(0, 20),
    scope: analyze.scope,
    scope_truncated: analyze.scope_truncated,
    breaking_change: analyze.breaking_change,
    breaking_keyword_scan: analyze.breaking_keyword_scan,
    breaking_evidence: typeof analyze.breaking_evidence === 'string' ? analyze.breaking_evidence : '',
    comment_overrides: analyze.comment_overrides.slice(),
    comment_conflicts: analyze.comment_conflicts.slice(),
    uncertain: analyze.uncertain.slice(),
    analyze_path: analyze.analyze_path,
    jev_reasons: analyze.jev_reasons.slice(),
  }
  if (Number.isInteger(analyze.scope_total_chars) && analyze.scope_total_chars >= 0) {
    req.scope_total_chars = analyze.scope_total_chars
  }
  if (Number.isInteger(analyze.comment_count) && analyze.comment_count >= 0) {
    req.comment_count = analyze.comment_count
  }
  // issue_body / issue_body_truncated（issue #668）: Implement phase が dev-implement-fable へ issue 本文として
  // 渡す。型が合うときだけキーを立てる（欠落は Fable prompt 側で「本文なし・AC を正とする」に倒れる）。
  if (typeof analyze.issue_body === 'string') {
    req.issue_body = analyze.issue_body
  }
  if (typeof analyze.issue_body_truncated === 'boolean') {
    req.issue_body_truncated = analyze.issue_body_truncated
  }
  return req
}

// analyzeGateReasons: Analyze phase の 3 条件ゲート。非空なら needs_clarification（source=analyze）で終端し、
// ゲート後にだけ sonnet を 1 spawn して人間向け missing_context を生成する。
//   - AC 空: 決定論 parse が AC 見出し / 項目を見つけられなかった
//   - comment_conflicts 非空: body と comment の矛盾、または権限なし / 低確信の上書き（fail-closed）
//   - uncertain 非空: Jev の低確信 / 応答なし / 無効（fail-closed）
// 返り値は人間向けの理由行（missing_context の決定論部分）。
export function analyzeGateReasons(req) {
  const reasons = []
  if (!Array.isArray(req?.acceptance_criteria) || req.acceptance_criteria.length === 0) {
    reasons.push('acceptance_criteria が空 — issue に受け入れ基準（`## 受け入れ基準` / `## Acceptance Criteria` 見出し + checkbox / 箇条書き）を書いてから再起動せよ')
  }
  for (const c of (req?.comment_conflicts ?? [])) reasons.push(`issue body と comment の矛盾（どちらが有効か確定できない）: ${c}`)
  for (const u of (req?.uncertain ?? [])) reasons.push(`決定論 / Jev で確定できない判定: ${u}`)
  return reasons
}
