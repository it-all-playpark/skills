// _lib/analyze-contract.mjs
// buildReqFromContract: dev-issue-analyze の `--contract` モード出力 (F1) から REQ 互換オブジェクトを
// 決定論構成する純粋関数。dev-flow の Analyze phase が DEPTH==='standard' のときのみ試行する
// 決定論 parse 降格経路 (issue #374) が使用する。whitelist 検証に 1 つでも不合格なら null を返し、
// 呼び出し元は現行の sonnet(dev-runner) analyze へ fail-open fallback する。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// whitelist 検証項目（全て合格して初めて採用）:
//   - contract が object（配列・null 除く）
//   - contract.eligible === true
//   - contract.contract が 't1' か 't2' のいずれか
//   - contract.title が非空 string
//   - contract.issue_type が feat/fix/docs/refactor のいずれか
//   - contract.acceptance_criteria が長さ1以上の配列で全要素が非空 string
//   - contract.breaking_keyword_scan === false（boolean 厳格。true は defense-in-depth で reject）
//   - contract.scope が string
//
// 合格時、REQ 互換オブジェクトをキー個別 copy で構成する（spread しない — 未知キーの混入防止）。
// `shape` キーは出力しない（classifyShape の複数 floor 安全則をそのまま働かせるため）。
// estimated_change_file_count は正の整数として導出できたときのみキーを立てる（欠落時は
// classifyShape の complex floor 安全則がそのまま働く）。
export function buildReqFromContract(contract, issueNumber) {
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) return null
  if (contract.eligible !== true) return null
  if (contract.contract !== 't1' && contract.contract !== 't2') return null
  if (typeof contract.title !== 'string' || contract.title.length === 0) return null

  const validTypes = ['feat', 'fix', 'docs', 'refactor']
  if (!validTypes.includes(contract.issue_type)) return null

  if (!Array.isArray(contract.acceptance_criteria) || contract.acceptance_criteria.length === 0) return null
  if (!contract.acceptance_criteria.every((ac) => typeof ac === 'string' && ac.length > 0)) return null

  if (contract.breaking_keyword_scan !== false) return null
  if (typeof contract.scope !== 'string') return null

  const req = {
    summary: `Issue #${issueNumber}: ${contract.title}`,
    issue_type: contract.issue_type,
    acceptance_criteria: contract.acceptance_criteria.slice(0, 20),
    scope: contract.scope,
    breaking_change: false,
    breaking_keyword_scan: false,
    breaking_evidence: '',
    ambiguities: [],
  }
  if (Number.isInteger(contract.estimated_change_file_count) && contract.estimated_change_file_count > 0) {
    req.estimated_change_file_count = contract.estimated_change_file_count
  }
  return req
}
