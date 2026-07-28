// Journal telemetry handoff helpers for workflow runtime.
// Workflow loader cannot import ESM, so tools/sync-inlines.mjs injects this file
// into .claude/workflows/*.js. Keep this file import-free and deterministic.
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const JOURNAL_PENDING_DIR = '${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}/pending';

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

// buildJournalFinalizeCommand({ prefix, id }): returns a single-line bash command that
// validates a payload file (already written verbatim to disk elsewhere, e.g. by the Write
// tool per buildJournalHandoffInstr) via `jq -e` BEFORE ever touching pending/, then performs
// the same stable-effect-ID naming + mktemp/mv atomic write as the previous heredoc-based
// command: partial JSON can never be visible under a *.json name (tmp is dot-prefixed and
// non-.json until the atomic `mv -f`, and lives in the same pending/ filesystem so the mv is
// atomic), and re-running with an identical payload reproduces the same final filename
// (idempotent overwrite, no duplicate entries). `<PAYLOAD_FILE>` is a literal placeholder —
// the caller (the agent executing the instruction from buildJournalHandoffInstr) must
// substitute it with a real file path before running the command. A jq parse failure
// (malformed JSON) short-circuits the `&&` chain so nothing is ever written under pending/.
export function buildJournalFinalizeCommand({ prefix, id }) {
  const safePrefix = String(prefix ?? '').trim();
  const safeId = String(id ?? '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(safePrefix)) {
    throw new Error(`journal-handoff: invalid prefix: ${JSON.stringify(prefix)}`);
  }
  if (!/^[1-9][0-9]*$/.test(safeId)) {
    throw new Error(`journal-handoff: invalid id: ${JSON.stringify(id)}`);
  }

  return `jq -e . "<PAYLOAD_FILE>" >/dev/null && mkdir -p ${JOURNAL_PENDING_DIR} && __jh_tmp=$(mktemp "${JOURNAL_PENDING_DIR}/.${safePrefix}-${safeId}.XXXXXX") && cp "<PAYLOAD_FILE>" "$__jh_tmp" && __jh_id=$(shasum -a 256 "$__jh_tmp" | cut -c1-16) && mv -f "$__jh_tmp" "${JOURNAL_PENDING_DIR}/${safePrefix}-${safeId}-effect-\${__jh_id}.json"`;
}

// buildJournalHandoffInstr({ prefix, id, payload }): agent 向け instruction 文字列を生成する。
// _lib/workflow-post-helpers.mjs の bodySaveInstr と同じ Write-tool verbatim パターン — payload
// を shell/heredoc へ一切通さず、agent に **Write tool** の content 引数として <PAYLOAD_FILE> へ
// そのまま書かせることで、heredoc + プロンプト + tool-call JSON という多重エスケープの発生源
// そのものを除去する。書き出し後、buildJournalFinalizeCommand の結果（jq -e 検証込み）を
// <PAYLOAD_FILE> を実パスに置換した上でそのまま実行させ、失敗（jq parse error 含む）しても
// throw せず logged:false を返させる（既存の telemetry fail-open ポリシーを維持）。
export function buildJournalHandoffInstr({ prefix, id, payload }) {
  if (payload == null) throw new Error('journal-handoff: payload is required');
  const finalizeCmd = buildJournalFinalizeCommand({ prefix, id });

  return `## Journal handoff の書き出し\n`
    + `1. まず Bash で \`mktemp "\${TMPDIR:-/tmp}/journal-handoff-XXXXXX.json"\` を実行し、\n`
    + `出力されたパスを <PAYLOAD_FILE> とする。\n`
    + `2. 次に **Write tool** を使い、下記 delimiter 内の JSON を\n`
    + `**一字一句そのまま** <PAYLOAD_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。エスケープ・改変・pretty-print も\n`
    + `禁止する。\n`
    + `<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n${payload}\n<<<JOURNAL_HANDOFF_BODY_END>>>\n\n`
    + `3. <PAYLOAD_FILE> を実パスに置換した上で、次のコマンドをそのまま実行せよ: \`${finalizeCmd}\`\n`
    + `jq の parse error を含め失敗しても throw せず logged:false を返すこと。\n`;
}

export function repoFromGithubUrl(url) {
  const match = String(url ?? '').match(
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:[\/#?]|$)/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
