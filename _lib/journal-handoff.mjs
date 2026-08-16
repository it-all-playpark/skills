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
// tool per buildJournalSaveInstr) via `jq -e` BEFORE ever touching pending/, then performs
// the same stable-effect-ID naming + mktemp/mv atomic write as the previous heredoc-based
// command: partial JSON can never be visible under a *.json name (tmp is dot-prefixed and
// non-.json until the atomic `mv -f`, and lives in the same pending/ filesystem so the mv is
// atomic), and re-running with an identical payload reproduces the same final filename
// (idempotent overwrite, no duplicate entries). `<PAYLOAD_FILE>` is a literal placeholder —
// the caller (buildJournalLogInstr) must substitute it with a real, validated file path
// before running the command. A jq parse failure (malformed JSON) short-circuits the `&&`
// chain so nothing is ever written under pending/.
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

export const JOURNAL_LOG_STATUSES = ['logged', 'save_failed', 'log_failed'];

// classifyJournalLogStatus({ saved, logged }): reduces the 2-stage handoff outcome to the
// 3-value closed enum reported on the caller's return object. saved!==true means stage1
// (journal-save) never produced a validated payload file, so stage2 could not even be
// attempted. logged===true means stage2 (journal-log) ran the finalize command successfully.
export function classifyJournalLogStatus({ saved, logged }) {
  if (saved !== true) return 'save_failed';
  if (logged === true) return 'logged';
  return 'log_failed';
}

// stage1 が作る payload ファイルの basename 契約。validateJournalSavedPath の basename 検証と
// 同一パターンで、fileName モードの呼び出し側が渡す名前もこれに従う。
const JOURNAL_PAYLOAD_BASENAME_RE = /^payload-[A-Za-z0-9._-]+\.json$/;

// buildJournalSaveInstr({ payload, savePath | saveDir }): stage1 instruction string. Persists the
// journal handoff payload verbatim to a file so that stage2 (buildJournalLogInstr) can be driven
// by a path alone — the payload body has no reason to be re-stated in the prompt that writes
// under pending/, and keeping it out means a long telemetry blob is carried as data on disk
// rather than as prompt text. Either way the agent must write `payload` via the **Write tool**
// content argument only, never through shell/echo/printf/heredoc, and never re-escape or
// pretty-print it (same pattern as _lib/workflow-post-helpers.mjs bodySaveInstr).
//
// 2 つのモードがあるのは、保存先が JS 側で確定しているかどうかで実行可能な手段が変わるため:
//
// - `savePath`（dev-flow / pr-iterate — worktree パスが JS 側で確定している）: 保存先の絶対パスが
//   prompt 構築時点で決まるので **shell を一切使わない**。これは必須の性質で、repo 配下を Bash から
//   書けない環境（skills repo の自己改変ガードは worktree 配下も含めて deny する）では
//   `mktemp "<worktree>/…"` が EPERM になり、agent が別ディレクトリへ退避して保存先固定の検証に
//   落ちる。Write tool は同じ場所へ書けるので（isolation probe が同経路）、パスを固定して渡す。
//   呼び出し側は同じ `savePath` を stage2 へ渡し、agent 申告の path とは完全一致でのみ突合する
//   （確定値があるのに申告値を信用する理由がない）。
// - `saveDir` + `fileName`（run 専用 worktree を持たない dev-improve）: 保存先が `${TMPDIR:-/tmp}` の
//   shell 展開に依存し JS 側で解決できないため、shell に絶対パスを組み立てさせてから Write する。
//   ファイル名は固定で、mktemp は使わない — テンプレート `payload-XXXXXX.json` は X 列が suffix の
//   前にあるため BSD mktemp では展開されず、リテラル名のファイルを exit 0 で作る（一意性が silent に
//   失われる）。呼び出し側は申告パスを requiredDirSuffix で pin する（絶対パスが JS 側で確定しない
//   ため完全一致はできない）。
export function buildJournalSaveInstr({ payload, savePath, saveDir, fileName }) {
  if (payload == null) throw new Error('journal-handoff: payload is required');
  if (savePath != null && saveDir != null) {
    throw new Error('journal-handoff: savePath と saveDir は同時に指定できません');
  }

  const bodyBlock = `<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n${payload}\n<<<JOURNAL_HANDOFF_BODY_END>>>\n\n`;
  const verbatimRule = `本文は絶対に shell（echo/printf/heredoc 等）へ渡さず、必ず Write tool の\n`
    + `content 引数として渡すこと。エスケープ・改変・pretty-print も禁止する。\n`;

  if (savePath != null) {
    // stage2 の bash コマンドへそのまま splice されるので、申告値に対するのと同じ決定論検証を
    // 構築時点でも通す（絶対パス / 限定 charset / '..' 不可 / basename 契約）。
    if (!validateJournalSavedPath(savePath)) {
      throw new Error(`journal-handoff: invalid savePath: ${JSON.stringify(savePath)}`);
    }
    return `## Journal handoff payload の保存\n`
      + `1. **Write tool** を使い、下記 delimiter 内の JSON を **一字一句そのまま**\n`
      + `\`${savePath}\` へ書き出せ。${verbatimRule}`
      + `Bash は使うな。保存先は上記のパスで固定されており、一時ファイル名を作る必要はない。\n`
      + bodyBlock
      + `2. 書き出しに成功したら {saved:true, path:"${savePath}"} を返せ。\n`
      + `失敗した場合は throw せず {saved:false} を返せ。\n`;
  }

  if (!saveDir) throw new Error('journal-handoff: savePath か saveDir のどちらかが必要です');
  if (!JOURNAL_PAYLOAD_BASENAME_RE.test(String(fileName ?? ''))) {
    throw new Error(`journal-handoff: invalid fileName: ${JSON.stringify(fileName ?? null)}`);
  }
  const resolveCmd = `mkdir -p "${saveDir}" && printf '%s\\n' "${saveDir}/${fileName}"`;

  return `## Journal handoff payload の保存\n`
    + `1. まず Bash で \`${resolveCmd}\` を実行し、\n`
    + `出力された絶対パスを <PAYLOAD_FILE> とする。\n`
    + `2. 次に **Write tool** を使い、下記 delimiter 内の JSON を\n`
    + `**一字一句そのまま** <PAYLOAD_FILE> へ書き出せ。${verbatimRule}`
    + bodyBlock
    + `3. 書き出しに成功したら {saved:true, path:<PAYLOAD_FILE の絶対パス>} を返せ。\n`
    + `失敗した場合は throw せず {saved:false} を返せ。\n`;
}

// validateJournalSavedPath(path, { requiredDirSuffix }): deterministic injection guard run on
// the path an agent claims to have saved a stage1 payload to, before that string is spliced
// into the stage2 bash command (buildJournalLogInstr). Rejects anything that is not a plain
// absolute path built from a restricted charset, contains '..', or whose basename does not
// match the expected `payload-*.json` shape produced by buildJournalSaveInstr's mktemp
// template. requiredDirSuffix optionally pins the containing directory (e.g. '/.devflow-tmp').
export function validateJournalSavedPath(path, { requiredDirSuffix } = {}) {
  if (typeof path !== 'string' || path === '') return false;
  if (!path.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(path)) return false;
  if (path.includes('..')) return false;

  const idx = path.lastIndexOf('/');
  const dirPart = idx === 0 ? '/' : path.slice(0, idx);
  const basePart = path.slice(idx + 1);
  if (!JOURNAL_PAYLOAD_BASENAME_RE.test(basePart)) return false;
  if (requiredDirSuffix && !dirPart.endsWith(requiredDirSuffix)) return false;

  return true;
}

// buildJournalLogInstr({ prefix, id, payloadPath }): stage2 instruction string. Takes only a
// (pre-validated, see validateJournalSavedPath) file path — never the payload body — so
// conclusion values structurally cannot appear in this prompt. Splices payloadPath into
// buildJournalFinalizeCommand's `<PAYLOAD_FILE>` placeholder and instructs the agent to run it
// as-is, failing open (logged:false, no throw) on any error including jq parse failures.
export function buildJournalLogInstr({ prefix, id, payloadPath }) {
  const finalizeCmd = buildJournalFinalizeCommand({ prefix, id })
    .split('<PAYLOAD_FILE>')
    .join(payloadPath);

  return `## Journal pending への書き出し\n`
    + `次のコマンドをそのまま実行せよ: \`${finalizeCmd}\`\n`
    + `jq の parse error を含め失敗しても throw せず logged:false を返すこと。\n`;
}

export function repoFromGithubUrl(url) {
  const match = String(url ?? '').match(
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:[\/#?]|$)/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
