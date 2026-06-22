// Journal telemetry handoff helpers for workflow runtime.
// Workflow loader cannot import ESM, so tools/sync-inlines.mjs injects this file
// into .claude/workflows/*.js. Keep this file import-free and deterministic.
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const JOURNAL_PENDING_DIR = '~/.claude/journal/pending';
const JOURNAL_HANDOFF_DELIMITER = 'TELEMETRY_EOF';

export function buildJournalHandoffPayload({
  skill,
  outcome,
  args,
  issue,
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

  return `mkdir -p ${JOURNAL_PENDING_DIR} && cat > ${JOURNAL_PENDING_DIR}/${safePrefix}-${safeId}-$(date +%s).json <<'${JOURNAL_HANDOFF_DELIMITER}'\n${String(payload)}\n${JOURNAL_HANDOFF_DELIMITER}`;
}
