// Journal telemetry handoff helpers for workflow runtime.
// Workflow loader cannot import ESM, so tools/sync-inlines.mjs injects this file
// into .claude/workflows/*.js. Keep this file import-free and deterministic.
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// stage2 が Write tool へ渡す最終書き込み先。shell 展開ではなく Write tool 側の `~` 展開に
// 依存する（stage2 は shell を一切使わない — buildJournalLogInstr のコメント参照）。
// 副作用として CLAUDE_JOURNAL_DIR による書き込み先の差し替えは効かない。同 env を読むのは
// dev-flow-doctor / dev-improve の解析スクリプトとその test harness だけで、書き込み側の
// production 経路では設定されないため、読み手（Stop hook）との不一致は生じない。
const JOURNAL_PENDING_DIR = '~/.claude/journal/pending';

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

// journalEffectId(payload): stable 16-hex effect ID derived from the payload string in pure JS.
// 以前は stage2 の shell が `shasum -a 256 | cut -c1-16` で算出していたが、その算出には変数代入と
// コマンド置換が必要で、それが worktree 分離ガードの拒否要因だった（issue #526）。JS 側で先に
// 確定させることで stage2 の書き込み先が prompt 構築時点で定まり、stage2 から shell を完全に外せる。
//
// 幅は従来と同じ 64bit（16 hex）で、衝突時の影響も従来と同じ「別 payload の entry を上書きする」
// クラスに留まる。暗号学的強度は不要 — 用途は同一 payload の再実行で同一ファイル名を再現する
// 冪等命名だけで、内容の真正性検証には使わない。BigInt を避けて 32bit 2 本（seed 違いの FNV-1a）に
// 分けているのは、workflow runtime が制限付き JS sandbox であり、inline 生成先とテストで同一挙動を
// 保証する必要があるため。
function fnv1a32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    // 上位バイトも混ぜる: payload は日本語を含みうるので下位バイトだけでは区別が落ちる。
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (c >>> 8), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function journalEffectId(payload) {
  const s = String(payload ?? '');
  const lo = fnv1a32(s, 0x811c9dc5);
  const hi = fnv1a32(s, 0x811c9dc5 ^ 0x9e3779b9);
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

// buildJournalPendingPath({ prefix, id, effectId }): stage2 が Write tool へ渡す最終パス。
// prefix / id は Write tool のパスへ splice されるので、shell へ渡していた頃と同じ決定論検証を
// 残す（パス要素の混入は書き込み先の乗っ取りに直結するため、経路が shell でなくなっても緩めない）。
export function buildJournalPendingPath({ prefix, id, effectId }) {
  const safePrefix = String(prefix ?? '').trim();
  const safeId = String(id ?? '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(safePrefix)) {
    throw new Error(`journal-handoff: invalid prefix: ${JSON.stringify(prefix)}`);
  }
  if (!/^[1-9][0-9]*$/.test(safeId)) {
    throw new Error(`journal-handoff: invalid id: ${JSON.stringify(id)}`);
  }
  if (!/^[0-9a-f]{16}$/.test(String(effectId ?? ''))) {
    throw new Error(`journal-handoff: invalid effectId: ${JSON.stringify(effectId ?? null)}`);
  }
  return `${JOURNAL_PENDING_DIR}/${safePrefix}-${safeId}-effect-${effectId}.json`;
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
//   呼び出し側は agent 申告の path を使わず、この `savePath` をそのまま stage2 へ渡す（確定値が
//   あるのに申告値を信用する理由がない）。agent が別の場所へ書いていた場合は stage2 の jq 検証が
//   落ちて log_failed になり、欠落は観測可能なまま。
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
  // 冪等化: Write tool は同一セッション内で
  // 未 Read の既存ファイルを上書きできない。savePath / saveDir とも保存先ファイル名は run を
  // またいで固定（worktree 再利用・TMPDIR 永続時は前 run の payload が残り得る）なので、
  // 上書き前に Read を試みる一手順を必須にする。Read の成否は saved の判定に混ぜない
  // （Read 失敗＝新規ファイルの可能性が高いだけで、それ自体は保存失敗ではない）。
  const idempotentReadRule = (target) => `${target} が既に存在する場合は、先に **Read tool** で同ファイルを`
    + `読んでから **Write tool** で上書きせよ（Write tool は既存ファイルを未 Read のまま上書きできない）。`
    + `Read が失敗しても Write は必ず試み、Read の成否を saved の判定に混ぜないこと。\n`;

  if (savePath != null) {
    // stage2 の Read tool パスへそのまま splice されるので、申告値に対するのと同じ決定論検証を
    // 構築時点でも通す（絶対パス / 限定 charset / '..' 不可 / basename 契約）。
    if (!validateJournalSavedPath(savePath)) {
      throw new Error(`journal-handoff: invalid savePath: ${JSON.stringify(savePath)}`);
    }
    return `## Journal handoff payload の保存\n`
      + `1. ${idempotentReadRule(`\`${savePath}\``)}`
      + `2. **Write tool** を使い、下記 delimiter 内の JSON を **一字一句そのまま**\n`
      + `\`${savePath}\` へ書き出せ。${verbatimRule}`
      + `Bash は使うな。保存先は上記のパスで固定されており、一時ファイル名を作る必要はない。\n`
      + bodyBlock
      + `3. 書き出しに成功したら {saved:true, path:"${savePath}"} を返せ。\n`
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
    + `2. ${idempotentReadRule('<PAYLOAD_FILE>')}`
    + `3. 次に **Write tool** を使い、下記 delimiter 内の JSON を\n`
    + `**一字一句そのまま** <PAYLOAD_FILE> へ書き出せ。${verbatimRule}`
    + bodyBlock
    + `4. 書き出しに成功したら {saved:true, path:<PAYLOAD_FILE の絶対パス>} を返せ。\n`
    + `失敗した場合は throw せず {saved:false} を返せ。\n`;
}

// validateJournalSavedPath(path, { requiredDirSuffix }): deterministic injection guard for any
// path that gets spliced into the stage2 instruction (buildJournalLogInstr) — both the
// JS-constructed `savePath` (checked at build time) and the path an agent claims to have saved
// to in `saveDir` mode. Rejects anything that is not a plain absolute path built from a
// restricted charset, contains '..', or whose basename violates the payload basename contract
// (JOURNAL_PAYLOAD_BASENAME_RE). requiredDirSuffix optionally pins the containing directory
// (e.g. '/.devflow-tmp').
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

// buildJournalLogInstr({ prefix, id, payloadPath, payload }): stage2 instruction string.
// prompt には payload 本文を載せない — 載るのは 2 つのファイルパスだけで、結論値は構造的に
// この prompt へ現れない（payload は書き込み先ファイル名の effect ID 算出にのみ使う）。
//
// stage2 が shell を一切使わないのは必須の性質で、緩めると issue #526 が再発する: 従来の
// 単行 finalize コマンドは redirect・変数代入・コマンド置換・パイプを含み、EnterWorktree 済み
// セッションの worktree 分離ガードに `too complex to verify that it stays inside the worktree`
// で拒否されていた。dev-flow / pr-iterate は常にその分離セッションから走るため、stage2 が
// shell に依存する限りテレメトリは記録されない。Write tool は同じセッションから pending/ へ
// 書けることが実測で確認されており（stage1 と isolation probe が同経路）、`~` も Write tool
// 側で展開される。
//
// 代償: `jq -e` による事前検証と mktemp→mv の atomic 公開が無くなる。壊れた JSON や
// （他セッションの Stop hook と競合した場合の）部分書き込みは pending/ に現れうるが、Stop hook
// 側が malformed/ へ隔離し replay runbook で回収できるため、silent loss ではなく観測可能な
// 劣化に留まる。shell を残して「ガードに拒否され 8 日間 1 件も記録されない」状態に戻すより、
// この劣化を受け入れる方が telemetry の可用性は高い。
//
// payloadPath は呼び出し側の検証を信用せずここでも再検証する（Write tool のパスへ splice される
// 値なので、将来の呼び出し側が検証を忘れても崩れないようにする）。
export function buildJournalLogInstr({ prefix, id, payloadPath, payload }) {
  if (!validateJournalSavedPath(payloadPath)) {
    throw new Error(`journal-handoff: invalid payloadPath: ${JSON.stringify(payloadPath ?? null)}`);
  }
  if (typeof payload !== 'string' || payload === '') {
    throw new Error(`journal-handoff: payload is required for effect ID derivation`);
  }
  const pendingPath = buildJournalPendingPath({ prefix, id, effectId: journalEffectId(payload) });

  return `## Journal pending への書き出し\n`
    + `1. **Read tool** で \`${payloadPath}\` を読め。\n`
    + `2. 読み取った内容を **一字一句そのまま**、**Write tool** で \`${pendingPath}\` へ書け。\n`
    + `再整形・pretty-print・truncate は禁止する。**Bash は使うな** — 書き込みは Write tool のみで行う。\n`
    + `${pendingPath} が既に存在する場合は、先に **Read tool** で読んでから Write tool で上書きせよ\n`
    + `（Write tool は既存ファイルを未 Read のまま上書きできない）。\n`
    + `3. 書き込みに成功したら {logged:true} を返せ。どの手順で失敗しても throw せず {logged:false} を返せ。\n`;
}

// journal handoff choreography（issue #494/#499/#556）: journal-save（stage1）→ journal-log（stage2）の
// 2 段 agent 呼び出しと journal_log_status の帰属を canonical 化する。dev-flow.js の
// writeFailureTelemetry / Merge tier 成功 path、pr-iterate.js の終端の 3 call site が使う。
// 順序不変条件: stage2 呼び出しの直前に journalLogStatus を log_failed へ倒す — stage2 が throw
// すると catch へ抜けて再代入が走らないため、preset が無いと stage2 の失敗が save_failed として
// 誤帰属される（issue #499）。fail-open: 例外は内部で吸収し、3 値 closed enum
// （logged / save_failed / log_failed）のいずれかを必ず返す。gate・merge tier には影響しない。
// deps 注入: agent は呼び出し側の trackedAgent（subagent_invocations 計上のため）、
// saveSchema/logSchema は workflow 側定義の JOURNAL_SAVE_RESULT / JOURNAL_RESULT を渡す。
// savePath は呼び出し側 JS が絶対パスで確定して渡す（agent 申告の path は使わない — 申告値を
// 信用すると別ディレクトリの同名ファイルが stage2 へ渡りうる）。dev-improve の saveDir+fileName
// モードは対象外（本関数は savePath モード専用）。
// agent は destructure 時に `runAgent` へ alias する（`agent(` という bare 呼び出しリテラルを
// 本体コードへ残さないため）。dev-flow.js / pr-iterate.js の静的検証
// _lib/subagent-invocations-routing.test.mjs は「bare agent( 呼び出しは trackedAgent wrapper
// 内の 2 箇所のみ」を pin しており、本関数が inline 生成される両ワークフローで `agent(` リテラルが
// 増えると誤検出する。呼び出し側の deps 注入契約（キー名 `agent`）は変えない。
export async function runJournalHandoff({ agent: runAgent, log, saveSchema, logSchema, payload, savePath, prefix, id, subject, logLabel, phase }) {
  let journalLogStatus = 'save_failed'
  try {
    const journalSaveRes = await runAgent(
      `## Objective\n${subject}の telemetry handoff payload を一時ファイルへ保存する。\n\n`
      + `## Instructions\n`
      + buildJournalSaveInstr({ payload, savePath })
      + `\n## Output format\n{ "saved": boolean, "path": string }\n`
      + `\n## Tools\n使用可: Write, Read（保存先は指示で固定済み — Bash は不要。Read は既存 payload の\n`
      + `冪等上書きに必要）\n`
      + `\n## Boundary\n作成した一時ファイル以外のファイルを変更しない。git 操作禁止。\n`
      + `\n## Token cap\n120 語以内。`,
      { agentType: 'dev-runner-haiku', schema: saveSchema, label: 'journal-save', phase },
    )
    const journalSavedPath = journalSaveRes?.saved === true ? savePath : null
    if (journalSavedPath) {
      journalLogStatus = classifyJournalLogStatus({ saved: true, logged: false })
      const journalPost = await runAgent(
        `## Objective\n${subject}の telemetry handoff を ~/.claude/journal/pending/ に書き出す（Stop hook が journal へ flush する）。\n\n`
        + `## Instructions\n`
        + buildJournalLogInstr({ prefix, id, payloadPath: journalSavedPath, payload })
        + `\n## Output format\n{ "logged": boolean, "summary": string }\n`
        + `\n## Tools\n使用可: Read, Write のみ\n`
        + `\n## Boundary\n~/.claude/journal 以外のファイルを変更しない。git 操作禁止。\n`
        + `\n## Token cap\n100 語以内で完結すること。`,
        { agentType: 'dev-runner-haiku', schema: logSchema, label: logLabel, phase },
      )
      journalLogStatus = classifyJournalLogStatus({ saved: true, logged: journalPost?.logged === true })
      if (!journalPost?.logged) log(`⚠️ ${logLabel} の記録に失敗しました（logged=${journalPost?.logged ?? 'null'}）。ワークフローは継続します。`)
    } else {
      journalLogStatus = classifyJournalLogStatus({ saved: false })
      log('⚠️ journal-save 失敗（fail-open）— telemetry 記録漏れの可能性')
    }
  } catch (e) {
    log(`⚠️ journal handoff 失敗（fail-open）: ${e?.message ?? e}`)
  }
  return journalLogStatus
}

export function repoFromGithubUrl(url) {
  const match = String(url ?? '').match(
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:[\/#?]|$)/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
