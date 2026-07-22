// Journal telemetry handoff helpers for workflow runtime.
// Workflow loader cannot import ESM, so tools/sync-inlines.mjs injects this file
// into .claude/workflows/*.js. Keep this file import-free and deterministic.
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const JOURNAL_PENDING_DIR = '${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}/pending';
const JOURNAL_HANDOFF_DELIMITER = 'TELEMETRY_EOF';

export function buildJournalHandoffPayload({
  skill,
  outcome,
  args,
  issue,
  repo,
  pr_number,
  journal_sh,
  telemetry,
  error_category,
  error_msg,
}) {
  if (!skill) throw new Error('journal-handoff: skill is required');
  if (!outcome) throw new Error('journal-handoff: outcome is required');

  const payload = { skill, outcome };
  if (args) payload.args = args;
  if (issue != null && issue !== '') payload.issue = Number(issue);
  if (repo != null && repo !== '') payload.repo = String(repo);
  if (pr_number != null && pr_number !== '') payload.pr_number = Number(pr_number);
  if (journal_sh) payload.journal_sh = journal_sh;
  if (telemetry != null) payload.telemetry = telemetry;
  if (error_category) payload.error_category = error_category;
  if (error_msg) payload.error_msg = error_msg;
  return JSON.stringify(payload);
}

export function buildJournalHandoffCommand({ prefix, id, payload }) {
  const safePrefix = String(prefix ?? '').trim();
  const safeId = String(id ?? '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(safePrefix)) {
    throw new Error(`journal-handoff: invalid prefix: ${JSON.stringify(prefix)}`);
  }
  if (!/^[1-9][0-9]*$/.test(safeId)) {
    throw new Error(`journal-handoff: invalid id: ${JSON.stringify(id)}`);
  }
  if (payload == null) throw new Error('journal-handoff: payload is required');

  // Stable effect-ID naming (sha256 of payload, first 16 hex chars) + mktemp/mv atomic
  // write: partial JSON can never be visible under a *.json name (tmp is dot-prefixed
  // and non-.json until the atomic `mv -f`), and re-running with an identical payload
  // reproduces the same final filename (idempotent overwrite, no duplicate entries).
  return `mkdir -p ${JOURNAL_PENDING_DIR} && __jh_tmp=$(mktemp "${JOURNAL_PENDING_DIR}/.${safePrefix}-${safeId}.XXXXXX") && cat > "$__jh_tmp" <<'${JOURNAL_HANDOFF_DELIMITER}' && __jh_id=$(shasum -a 256 "$__jh_tmp" | cut -c1-16) && mv -f "$__jh_tmp" "${JOURNAL_PENDING_DIR}/${safePrefix}-${safeId}-effect-\${__jh_id}.json"\n${String(payload)}\n${JOURNAL_HANDOFF_DELIMITER}`;
}

export function repoFromGithubUrl(url) {
  const match = String(url ?? '').match(
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:[\/#?]|$)/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
