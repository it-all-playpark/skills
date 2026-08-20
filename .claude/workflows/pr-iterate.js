export const meta = {
  name: 'pr-iterate',
  description: 'PR を review ⇄ fix で LGTM になるまで反復（上限 10）。単体起動も dev-flow からのサブ呼びも可',
  phases: [
    { title: 'Iterate' },
  ],
}

// ==== BEGIN inline: _lib/quality-model.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// 品質ゲート系 4 agent（dev-planner / plan-reviewer / evaluator / pr-reviewer）の model override。
// frontmatter 既定は opus。Fable 5 試験運用中は 'fable'、戻すときはこの 1 行を 'opus' にする。
// effort は agent() opts に存在しないため frontmatter（high）固定。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
const QUALITY_MODEL = 'fable'
// ==== END inline: _lib/quality-model.mjs ====

// ==== BEGIN inline: _lib/resolve-arg.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// 正の整数 arg を正規化する。dev-flow / pr-iterate の entrypoint 共通。
// 受理: bare string '120' / number 120 / array ['120'] / object {issue:'120'} | {pr:'120'}
// 拒否(throw): 空 / 未展開テンプレート '{' / '0' / 負数 / 小数 / 非数字混入
// NOTE: name に対応するキー（args[name]）と bare/array 形式のみを解決する。
//       cross-name fallback（例: name='pr' のときに args.issue を採用する）は
//       型安全性を損なう footgun のため意図的に除外している。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
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
// ==== END inline: _lib/resolve-arg.mjs ====

// ==== BEGIN inline: _lib/journal-handoff.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// Journal telemetry handoff helpers for workflow runtime.
// Workflow loader cannot import ESM, so tools/sync-inlines.mjs injects this file
// into .claude/workflows/*.js. Keep this file import-free and deterministic.
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const JOURNAL_PENDING_DIR = '${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}/pending';

function buildJournalHandoffPayload({
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
function buildJournalFinalizeCommand({ prefix, id }) {
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

const JOURNAL_LOG_STATUSES = ['logged', 'save_failed', 'log_failed'];

// classifyJournalLogStatus({ saved, logged }): reduces the 2-stage handoff outcome to the
// 3-value closed enum reported on the caller's return object. saved!==true means stage1
// (journal-save) never produced a validated payload file, so stage2 could not even be
// attempted. logged===true means stage2 (journal-log) ran the finalize command successfully.
function classifyJournalLogStatus({ saved, logged }) {
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
function buildJournalSaveInstr({ payload, savePath, saveDir, fileName }) {
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
    // stage2 の bash コマンドへそのまま splice されるので、申告値に対するのと同じ決定論検証を
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
// path that gets spliced into the stage2 bash command (buildJournalLogInstr) — both the
// JS-constructed `savePath` (checked at build time) and the path an agent claims to have saved
// to in `saveDir` mode. Rejects anything that is not a plain absolute path built from a
// restricted charset, contains '..', or whose basename violates the payload basename contract
// (JOURNAL_PAYLOAD_BASENAME_RE). requiredDirSuffix optionally pins the containing directory
// (e.g. '/.devflow-tmp').
function validateJournalSavedPath(path, { requiredDirSuffix } = {}) {
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
// file path — never the payload body — so conclusion values structurally cannot appear in this
// prompt. Splices payloadPath into buildJournalFinalizeCommand's `<PAYLOAD_FILE>` placeholder
// and instructs the agent to run it as-is, failing open (logged:false, no throw) on any error
// including jq parse failures. payloadPath is re-validated here rather than trusting the caller
// to have done it: the value is spliced into a bash command, so the guard must not depend on
// call-site discipline that a future caller can forget.
function buildJournalLogInstr({ prefix, id, payloadPath }) {
  if (!validateJournalSavedPath(payloadPath)) {
    throw new Error(`journal-handoff: invalid payloadPath: ${JSON.stringify(payloadPath ?? null)}`);
  }
  const finalizeCmd = buildJournalFinalizeCommand({ prefix, id })
    .split('<PAYLOAD_FILE>')
    .join(payloadPath);

  return `## Journal pending への書き出し\n`
    + `次のコマンドをそのまま実行せよ: \`${finalizeCmd}\`\n`
    + `jq の parse error を含め失敗しても throw せず logged:false を返すこと。\n`;
}

function repoFromGithubUrl(url) {
  const match = String(url ?? '').match(
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:[\/#?]|$)/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
// ==== END inline: _lib/journal-handoff.mjs ====
// ==== BEGIN inline: _lib/subagent-invocations.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// subagent-invocations: run あたりの subagent (agent-invoke) 起動数カウント用の純関数群。
// I/O なし・Date.now/Math.random 不使用。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

/**
 * counts（plain object）の counts[key] を +1 する。
 * agentType が非空文字列の string でなければ 'unknown' へ計上する（fail-safe）。
 * @param {object} counts - mutate 対象のカウント集計 object
 * @param {string|undefined} agentType - subagent の agentType
 * @returns {object} counts（同一 object）
 */
function recordSubagentInvocation(counts, agentType) {
  const key = typeof agentType === 'string' && agentType.trim() !== '' ? agentType : 'unknown';
  counts[key] = (counts[key] || 0) + 1;
  return counts;
}

/**
 * counts から telemetry 用の { total, by_type } を組み立てる。
 * by_type はキーを sort した新 object（counts を mutate しない）。
 * @param {object} counts - recordSubagentInvocation の集計 object
 * @returns {{total: number, by_type: object}}
 */
function buildSubagentInvocations(counts) {
  const keys = Object.keys(counts).sort();
  let total = 0;
  const by_type = {};
  for (const key of keys) {
    const value = counts[key];
    total += value;
    by_type[key] = value;
  }
  return { total, by_type };
}

/**
 * byType（{agentType: number} 形式）を counts へ加算 merge する。
 * byType が null/undefined/非 object なら no-op。数値でない値は skip する。
 * @param {object} counts - mutate 対象のカウント集計 object
 * @param {object|null|undefined} byType - merge 元
 * @returns {object} counts（同一 object）
 */
function mergeSubagentCounts(counts, byType) {
  if (byType == null || typeof byType !== 'object') {
    return counts;
  }
  for (const key of Object.keys(byType)) {
    const value = byType[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }
    counts[key] = (counts[key] || 0) + value;
  }
  return counts;
}
// ==== END inline: _lib/subagent-invocations.mjs ====

// args 正規化: 単体 /pr-iterate <pr> でも dev-flow からの workflow('pr-iterate', {pr}) でも受ける
const PR = resolvePositiveIntArg(args, 'pr')
const POST_TERMINAL_SUMMARY = args?.post_terminal_summary !== false
const MAX = args?.max_iterations == null
  ? 10
  : Number(resolvePositiveIntArg(args.max_iterations, 'max_iterations'))
const REVIEW_STUCK = 2   // 同一 topic がこの回数出たら stuck と判定し人間へエスカレーション（issue #126）

// run あたりの subagent (agent()) 起動数カウント。agent() の代わりに全 call site を
// trackedAgent() 経由で呼び、SUBAGENT_COUNTS へ計上する（issue #445。dev-flow.js と同型）。
const SUBAGENT_COUNTS = {};
async function trackedAgent(prompt, opts) {
  recordSubagentInvocation(SUBAGENT_COUNTS, opts?.agentType);
  return agent(prompt, opts);
}

// fail-open 規定の exec-proxy 呼び出し用ラッパ（issue #499）。trackedAgent が throw した場合
// （isolation guard 等による StructuredOutput 未返却）も run 全体を落とさず null に落とす。
// throw と schema 不一致（既存の null 返却）を呼び出し側で同一の fail-open 経路へ合流させる。
async function failOpenAgent(prompt, opts) {
  try {
    return await trackedAgent(prompt, opts)
  } catch (e) {
    log(`⚠️ ${opts?.label ?? 'exec-proxy'} が例外を投げた（StructuredOutput 未返却等）— fail-open で null 扱い: ${e?.message ?? e}`)
    return null
  }
}

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
// loader 制約（ESM import 不可）への対応として、stuck 検出は _lib/stuck-detector.mjs を canonical とし tools/sync-inlines.mjs で inline 生成する（手書き複製は廃止。issue #208）。

// ==== BEGIN inline: _lib/stuck-detector.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// dev-flow.js の planSeen/blockSeen/evalSeen と pr-iterate.js の reviewSeen が共有する
// stuck 検出 canonical。incentive-structural クラス — W7、撤去禁止。issue #123/#125/#126/#208。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// 命名注記: goal-ledger.mjs の topicKey と同一ファイル dev-flow.js に inline されるため
// 識別子衝突を避けて stuckTopicKey と命名。

// topic fingerprint を導出する。
// (a) x == null → ''
// (b) typeof x === 'string' → x をそのまま返す
// (c) typeof x.topic === 'string' かつ x.topic.trim() が非空 → x.topic.trim()
// (d) x.file != null → `${String(x.file)}::${x.description != null ? String(x.description) : JSON.stringify(x)}`
// (e) x.description != null かつ String(x.description) が非空 → String(x.description)
// (f) それ以外 → JSON.stringify(x)
function stuckTopicKey(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x.topic === 'string' && x.topic.trim()) return x.topic.trim();
  if (x.file != null) {
    return `${String(x.file)}::${x.description != null ? String(x.description) : JSON.stringify(x)}`;
  }
  if (x.description != null && String(x.description)) return String(x.description);
  return JSON.stringify(x);
}

// stuck 検出 closure tracker を返す。
// 内部 state は plain object（Map 禁止 — Object.values/entries の列挙順序まで現行と一致させるため）。
// register(item): topic → { item, count } に累積。同一 topic の再登録は item を最新版で上書き + count 加算。
// prior(): Object.values(seen).map((s) => s.item) を返す。
// stuckTopics(): count >= threshold の topic キー配列を返す。
function makeSeenTracker(threshold) {
  const seen = {};
  return {
    register(item) {
      const t = stuckTopicKey(item);
      if (seen[t]) { seen[t].item = item; seen[t].count += 1 }
      else seen[t] = { item, count: 1 };
    },
    prior() {
      return Object.values(seen).map((s) => s.item);
    },
    stuckTopics() {
      return Object.entries(seen).filter(([, s]) => s.count >= threshold).map(([t]) => t);
    },
  };
}
// ==== END inline: _lib/stuck-detector.mjs ====

// ==== BEGIN inline: _lib/review-normalize.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// pr-iterate.js の review 経路（decision × blocking findings）を正規化する canonical。issue #321。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// review 経路の 3 値 enum。
const REVIEW_ROUTE_CI_GATE = 'ci_gate';
const REVIEW_ROUTE_FIX_LOOP = 'fix_loop';
const REVIEW_ROUTE_CONTRACT_MISMATCH = 'contract_mismatch';

// pr-reviewer の review 結果を route へ正規化する純粋関数。
//
// blocking findings の有無を一次入力、review.decision を tie-break とする:
//   - blocking.length === 0                              → REVIEW_ROUTE_CI_GATE（decision に依らず）
//   - blocking.length > 0 && decision === 'approve'       → REVIEW_ROUTE_CONTRACT_MISMATCH
//   - blocking.length > 0 && decision !== 'approve'       → REVIEW_ROUTE_FIX_LOOP
//
// blocking = severity が 'critical' または 'major' の issue（pr-iterate.js 現行の blocking 定義と同一）。
// minor = severity が 'minor' の issue。
// severity は REVIEW schema で enum ['critical','major','minor'] に制約済みのため
// out-of-enum の追加ハンドリングは入れない。
//
// review が null/undefined、review.issues が配列でない場合も throw せず空配列として扱う。
function classifyReviewRoute(review) {
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const blocking = issues.filter((x) => x.severity === 'critical' || x.severity === 'major');
  const minor = issues.filter((x) => x.severity === 'minor');

  let route;
  if (blocking.length === 0) {
    route = REVIEW_ROUTE_CI_GATE;
  } else if (review?.decision === 'approve') {
    route = REVIEW_ROUTE_CONTRACT_MISMATCH;
  } else {
    route = REVIEW_ROUTE_FIX_LOOP;
  }

  return { route, blocking, minor };
}
// ==== END inline: _lib/review-normalize.mjs ====
// ==== BEGIN inline: _lib/review-finding-scrub.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// review-finding-scrub: pr-reviewer が返す blocking finding（review.blocking[].description/suggestion）を
// fix agent へのプロンプトに埋め込む前に決定論スクラブする純関数群。issue #503。
//
// 背景: pr-reviewer の suggestion がメタレベル指示（『今後の fix prompt には〜と書くな』
// 『分類器に検知されるため〜』等）を含むと、fix_loop 経路（pr-iterate.js の issuesText 組み立て）
// で無加工のまま fix agent への実行指示に変換されてしまう。_lib/block-routing.mjs の
// scrubBlockingDetail（issue #448、guard 迂回コマンド列の遮断）と同 precedent の、別脅威モデル向け
// チョークポイント。
//
// W7 正当化クラス: incentive-structural（永続・撤去禁止）。suggestion は fix prompt へ構造的に
// 埋め込まれるため、メタ指示が実行指示化される incentive/構造要因はモデル能力に非依存
// （賢いモデルほど巧妙なメタ指示を書き分け得るため、モデル世代が進んでも撤去しない）。
//
// backtick-span を redact しない理由（#448 との設計上の分岐）: #448 の対象（blocking_reason.detail）は
// guard 迂回コマンド列であり backtick 内容が常にノイズだったが、review suggestion は
// `parseInput` のようなコード識別子を正当に含む object-level 指示が大半を占める。backtick-span を
// 一律 redact すると fix agent が対象を特定できず fix 品質が壊滅するため、コマンド系パターン
// （subshell / URL / && 連結行 / 行頭コマンド）と、閉じたメタ語彙の文単位 redaction のみを行う。
//
// 設計根拠（文単位の丸ごと置換を選ぶ理由）: メタ指示を含む文は丸ごと [REDACTED-META] に置換する
// （内容の伝播遮断）。trigger 語だけを抜いて指示本体の文を残す方式は採らない —
// 遮断機構自体が「どの語を避ければ通るか」を教える回避装置になってしまうため。
//
// fail-toward-redaction: この repo は meta-repo であり、正当な object-level suggestion が
// 『prompt』『迂回』等の語に言及し得る（例: 本 issue 自身の修正指示）。誤検知は redaction 側に
// 倒す。severity/file/line は常に保持されるため、redaction されても fix agent は対象を特定できる。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で pr-iterate.js へ全文 inline
// 生成される。直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const SUBSHELL_SPAN_RE = /\$\([^)]*\)/g
const URL_RE = /https?:\/\/\S+/g
const CHAINED_LINE_RE = /^.*&&.*$/gm
const COMMAND_PREFIX_RE = /^(git|gh|sh|bash|node|npm|curl|wget|ssh|scp|rsync)\s.*$/gm

// 閉じた高精度メタ語彙。分類器/hook/guard の存在・検知・回避手順そのものへの言及、および
// 「将来の prompt/システムプロンプトに何を書くか」という meta-level な指示の定型を対象にする。
const META_VOCAB_RE = /分類器|classifier|excludedCommands|起動形|bare ?形|システムプロンプト|system prompt|(プロンプト|prompt)\s*(に|へ|には)[^。]*(書|記載|含め)|検知[^。]*(回避|されな|されるため)|回避手順|迂回|(guard|hook|ガード)[^。]*(無効|外|迂回)|(agent|subagent|エージェント)\s*(への|に対する)指示/i

// 『。』と改行で文に分割し、メタ語彙にマッチする文だけを丸ごと [REDACTED-META] に置換して再結合する。
function scrubMetaSentences(text) {
  const parts = text.split(/(。|\n)/)
  const out = parts.map((part) => {
    if (part === '。' || part === '\n') return part
    return META_VOCAB_RE.test(part) ? '[REDACTED-META]' : part
  })
  return out.join('')
}

function scrubReviewFindingText(text) {
  let scrubbed = String(text)
  scrubbed = scrubbed.replace(SUBSHELL_SPAN_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(URL_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(CHAINED_LINE_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(COMMAND_PREFIX_RE, '[REDACTED-CMD]')
  scrubbed = scrubMetaSentences(scrubbed)
  scrubbed = scrubbed.replace(/\s+/g, ' ').trim()
  scrubbed = scrubbed.slice(0, 500)
  return scrubbed === '' ? '[REDACTED]' : scrubbed
}

// pr-iterate.js の fix_loop 経路（issue #503 対象）で issuesText を組み立てる。現行フォーマット
// （`- [${severity}] ${file}:${line} ${description} → ${suggestion}`）を維持しつつ、description/
// suggestion のみをスクラブする。severity/file/line は構造フィールドなので素通しする。
function buildFixIssuesText(blocking) {
  return blocking
    .map((x) => `- [${x.severity}] ${x.file ?? ''}${x.line ? ':' + x.line : ''} ${scrubReviewFindingText(x.description)}${x.suggestion ? ' → ' + scrubReviewFindingText(x.suggestion) : ''}`)
    .join('\n')
}
// ==== END inline: _lib/review-finding-scrub.mjs ====

// ==== BEGIN inline: _lib/md-cell.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// mdCell: Markdown テーブルセルの値をエスケープする純粋関数。
// I/O なし、非決定性なし。同入力 -> byte 一致。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

/**
 * Markdown テーブルセルの値をエスケープする。
 * パイプ文字を \| に、改行を <br> に変換する。
 * @param {*} v
 * @returns {string}
 */
function mdCell(v) {
  if (v == null) return '';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
// ==== END inline: _lib/md-cell.mjs ====

// ==== BEGIN inline: _lib/pr-comment-format.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// buildTerminalSummaryBody / terminalReviewAction: pr-iterate の終端サマリー
// markdown 生成、および終端 review action（approve/request-changes/comment）
// を決定する純粋関数。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const DECISION_LABEL = {
  'approve': '承認 (LGTM)',
  'request-changes': '変更要求',
  'comment': 'コメント',
};

const SEV_LABEL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };

/**
 * finding 配列を番号付き箇条書き markdown 行配列へ変換する。
 * 1 finding = 見出し行（severity + 場所）+ `指摘` 行 + （suggestion があれば）`提案` 行。
 * @param {Array} list - finding 配列（severity, file, line, description, suggestion, 任意で iter）
 * @param {object} [opts]
 * @param {boolean} [opts.withIter] - true の場合、見出し行末尾に `（反復 N 回目）` を付与する
 * @returns {string[]}
 */
function formatFindingsList(list, { withIter = false } = {}) {
  const out = [];
  let idx = 1;
  for (const f of list) {
    const sev = SEV_LABEL[f.severity] ?? f.severity;
    const loc = f.file != null
      ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
      : '場所指定なし';
    const iterSuffix = withIter ? `（反復 ${f.iter} 回目）` : '';
    out.push(`${idx}. ${sev} — ${loc}${iterSuffix}`);
    out.push(`   - 指摘: ${mdCell(f.description)}`);
    if (f.suggestion != null) {
      out.push(`   - 提案: ${mdCell(f.suggestion)}`);
    }
    idx++;
  }
  return out;
}

const STATUS_HEADLINE = {
  'lgtm': '🎉 LGTM',
  'stuck': '⚠️ STUCK — 人間レビューへエスカレーション',
  'fix_failed': '⚠️ 自動修正失敗 — 人間へエスカレーション',
  'max_reached': '⚠️ 反復上限到達',
  'ci_error': '⚠️ CI エラー — gh API 失敗（auth/network）。人間へエスカレーション',
  'ci_pending': '⏳ CI 未完了 — checks pending。人間/CI 完了待ちへエスカレーション',
  'review_contract_error': '⚠️ REVIEW CONTRACT ERROR — reviewer の decision/blocking 矛盾の再発、または reviewer が StructuredOutput 契約違反で結果を返さず。人間へエスカレーション',
};

/**
 * 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.status - 'lgtm' | 'stuck' | 'fix_failed' | 'max_reached' | 'ci_error' | 'ci_pending' | 'review_contract_error'
 * @param {number} opts.iterations - 総反復回数
 * @param {string} opts.lastDecision - 最終判定
 * @param {string} opts.lastSummary - 最終サマリーテキスト
 * @param {string[]} [opts.lastVerificationEvidence] - 最終検証根拠リスト（任意）
 * @param {Array} opts.history - ラウンド履歴 [{iteration, decision, summary, blocking, minor}]
 * @param {number} [opts.ciWaitSeconds] - CI pending 待機の累積秒数（任意。ci-check の attempt ループ待機分）
 * @param {number} [opts.ciPollAttempts] - CI ステータス取得の累積ポーリング回数（任意）
 * @returns {string}
 */
function buildTerminalSummaryBody({ pr, status, iterations, lastDecision, lastSummary, lastVerificationEvidence, history, ciWaitSeconds, ciPollAttempts }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const lines = [];

  lines.push(`## PR #${pr} — pr-iterate 終了レポート`);
  lines.push('');
  lines.push(`### ${STATUS_HEADLINE[status] ?? status}`);
  lines.push('');

  lines.push('| 終了状態 | 反復回数 | 最終判定 |');
  lines.push('|---|---|---|');
  const decEmoji = DECISION_EMOJI[lastDecision] ?? '';
  const decLabel = DECISION_LABEL[lastDecision] ?? lastDecision ?? '—';
  lines.push(`| ${status} | ${iterations} | ${decEmoji} ${decLabel} |`);

  lines.push('');
  lines.push(`**最終判定理由**: ${lastSummary}`);

  if (ciWaitSeconds != null || ciPollAttempts != null) {
    lines.push('');
    lines.push(`**CI 待機**: ${ciWaitSeconds ?? 0}秒（ポーリング ${ciPollAttempts ?? 0} 回）`);
  }

  const evList2 = lastVerificationEvidence || [];
  if (evList2.length > 0) {
    lines.push('');
    lines.push('**検証根拠**:');
    for (const e of evList2) lines.push(`- ${mdCell(e)}`);
  }

  const histList = history || [];
  if (histList.length > 0) {
    lines.push('');
    lines.push('### 反復履歴');
    lines.push('');
    lines.push('| 反復 | 判定 | 要修正 (blocking) | 軽微 (minor) | 総評 |');
    lines.push('|---|---|---|---|---|');
    for (const round of histList) {
      const rEmoji = DECISION_EMOJI[round.decision] ?? '';
      const rLabel = DECISION_LABEL[round.decision] ?? round.decision;
      const bCount = (round.blocking ?? []).length;
      const mCount = (round.minor ?? []).length;
      const rawSummary = mdCell(round.summary);
      const rSummary = rawSummary.length > 120 ? rawSummary.slice(0, 120) + '…' : rawSummary;
      lines.push(`| ${round.iteration} | ${rEmoji} ${rLabel} | ${bCount} | ${mCount} | ${rSummary} |`);
    }
  }

  const allBlocking = histList.flatMap((r) => (r.blocking ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalBlocking = allBlocking.length;
  if (totalBlocking > 0) {
    lines.push('');
    lines.push(`<details><summary>要修正（blocking）指摘の全詳細（${totalBlocking} 件）</summary>`);
    lines.push('');
    lines.push(...formatFindingsList(allBlocking, { withIter: true }));
    lines.push('');
    lines.push('</details>');
  }

  const allMinor = histList.flatMap((r) => (r.minor ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalMinor = allMinor.length;
  if (totalMinor > 0) {
    lines.push('');
    lines.push(`<details><summary>軽微な指摘（minor）の全詳細（自動修正対象外・${totalMinor} 件）</summary>`);
    lines.push('');
    lines.push(...formatFindingsList(allMinor, { withIter: true }));
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  lines.push('---');
  lines.push('*このコメントは pr-iterate により自動生成されました。*');
  lines.push(`<!-- pr-iterate:${status}:${iterations} -->`);

  return lines.join('\n');
}

/**
 * 終端レビューアクションを決定する純粋関数（AC-2）。
 * @param {object} opts
 * @param {string} opts.status - 'lgtm'|'stuck'|'fix_failed'|'max_reached'|'ci_error'|'ci_pending'|'review_contract_error'
 * @param {string|null} opts.lastDecision - 'approve'|'request-changes'|'comment'|null
 * @param {number} opts.blockingCount - 終端時点の blocking finding 総数
 * @returns {'approve'|'request-changes'|'comment'}
 */
function terminalReviewAction({ status, lastDecision, blockingCount }) {
  if (status === 'lgtm' && lastDecision === 'approve') return 'approve';
  if (blockingCount > 0 && lastDecision === 'request-changes') return 'request-changes';
  return 'comment';
}
// ==== END inline: _lib/pr-comment-format.mjs ====

// ==== BEGIN inline: _lib/workflow-post-helpers.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// workflow-post-helpers: PR/Issue コメント投稿・ジャーナル記録用の共通スキーマ・ヘルパー。
// I/O なし。bodySaveInstr は agent 向け instruction 文字列を生成する純粋関数。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const POST_RESULT = {
  type: 'object',
  required: ['posted'],
  properties: {
    posted: { type: 'boolean' },
    method: { type: 'string' },
    url: { type: 'string' },
  },
}

const JOURNAL_RESULT = {
  type: 'object',
  required: ['logged'],
  properties: {
    logged: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

/**
 * PR/Issue コメント本文保存の agent 向け instruction を生成する。
 * Write tool 経由で一時ファイルに保存させる手順を返す。
 * @param {string} body - 保存する本文
 * @param {string} tmpPrefix - mktemp の prefix（例: 'dev-flow', 'pr-iterate'）
 * @param {string} delimName - delimiter 名（例: 'DEV_FLOW', 'PR_ITERATE'）
 */
function bodySaveInstr(body, tmpPrefix, delimName) {
  return `## 本文の保存\n`
    + `まず Bash で \`mktemp "\${TMPDIR:-/tmp}/${tmpPrefix}-XXXXXX.md"\` を実行して一時ファイルを作成し、\n`
    + `そのパスを <BODY_FILE> とする。次に **Write tool** を使い、下記 delimiter 内の本文を\n`
    + `**一字一句そのまま** <BODY_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。backtick やコードフェンスを\n`
    + `エスケープ・改変しないこと。以降のコマンドの \`--body-file\` には <BODY_FILE> を指定する。\n`
    + `<<<${delimName}_BODY_BEGIN>>>\n${body}\n<<<${delimName}_BODY_END>>>\n\n`
}
// ==== END inline: _lib/workflow-post-helpers.mjs ====

// journal-save（stage1）の返り値 schema。JOURNAL_RESULT（journal-log/stage2）と対で使う（issue #494）。
const JOURNAL_SAVE_RESULT = {
  type: 'object',
  required: ['saved'],
  properties: {
    saved: { type: 'boolean' },
    path: { type: 'string' },
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
        required: ['severity', 'topic', 'file', 'description', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          // 同一問題の再出現を orchestrator が stuck 突合するための安定 ID（issue #126）。
          // 既出指摘を再提起する場合は前ラウンドと同じ文字列を必ず再利用する。
          topic: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string', maxLength: 300 },
          suggestion: { type: 'string', maxLength: 200 },
        },
      },
    },
    summary: { type: 'string', maxLength: 200 },
    // 検証根拠の箇条書き（1 項目 1 文）。summary は結論 1-2 文に留める（issue #242）
    verification_evidence: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 120 } },
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
// dev-runner-haiku-ro fetches the CI snapshot with a bare `gh pr checks` call, classifies it with
// pr-iterate/scripts/check-ci.sh (a pure transform over that snapshot), and returns the script's
// stdout JSON unchanged. The fetch lives in the agent rather than inside the script because an
// exec-proxy script must not carry authenticated network I/O (issue #488).
// failed_checks items match script output: {name, bucket, state} (conclusion was removed in
// the bucket-field migration; see issue #133 / ci::bats-fabricated-schema).
// 'error' status means the gh fetch failed (auth/network); escalate to human immediately.
//
// Bounded wait for pending CI: CI_MAX_ATTEMPTS attempts spaced CI_POLL_SECONDS apart, so the
// ceiling is (CI_MAX_ATTEMPTS-1)*CI_POLL_SECONDS = 90s (unchanged from the previous --wait-seconds 90).
// The agent now spends one Bash turn per fetch, per classify, and per sleep, so the worst case is
// 3+3+2 = 8 tool calls; keep the product within dev-runner-haiku-ro's maxTurns (10) when tuning these.
const CI_MAX_ATTEMPTS = 3
const CI_POLL_SECONDS = 45
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
    // ci-check の attempt ループの累積待機秒数 / ポーリング（gh fetch）回数（issue #324）。
    // 待機なし（1 attempt で確定）でも script は常に返す。
    waited_seconds: { type: 'number' },
    poll_attempts: { type: 'number' },
    // dev-flow の clock telemetry（issue #443）が iterate_end の給電元として読む optional epoch。
    // 旧版 check-ci.sh（epoch 非対応）や失敗時は省略され、返り値の end_epoch も省略される（fail-open）。
    epoch: { type: 'number' },
  },
}

// issue #437: 終端 dirty 検出（AC-2）と fix 適用後 commit 保証（AC-3）の exec-proxy スキーマ。
const DIRTY_STATUS = { type: 'object', required: ['dirty'], properties: { dirty: { type: 'boolean' }, files: { type: 'number' } } }
const COMMIT_ENSURE = { type: 'object', required: ['dirty'], properties: { dirty: { type: 'boolean' }, committed: { type: 'boolean' }, pushed: { type: 'boolean' } } }

phase('Iterate')

// repo (owner/name) probe: PR の base repo URL から owner/name を導出する（telemetry の repo 解決用。issue #309）。
// fail-open — probe 失敗/null でも repo を省略するだけで workflow は継続する。
// head_ref/base_ref/cwd は isolation probe（issue #449）の失敗メッセージ・probe 対象パス解決にも使う。
const PR_META = {
  type: 'object', required: ['url'],
  properties: { url: { type: 'string' }, head_ref: { type: 'string' }, base_ref: { type: 'string' }, cwd: { type: 'string' }, epoch: { type: 'number' } },
}
const prMeta = await failOpenAgent(
  `## Objective\nPR #${PR} の URL・head/base branch 名・現在の作業ディレクトリ絶対パスを取得する（telemetry の repo 解決 / isolation probe 用）。\n\n## Instructions\n次のコマンドをそのまま実行し、出力を対応するキーへ格納せよ（各コマンド失敗時は throw せず該当キーを空文字で返すこと。epoch のみコマンド失敗時は省略可）:\n- \`gh pr view ${PR} --json url -q .url\` → url\n- \`gh pr view ${PR} --json headRefName -q .headRefName\` → head_ref\n- \`gh pr view ${PR} --json baseRefName -q .baseRefName\` → base_ref\n- \`pwd\` → cwd（現在の作業ディレクトリの絶対パス）\n- \`date +%s\` → epoch(現在時刻の epoch 秒整数。isolation probe 対象パスの run 毎一意化用)\n\n## Output format\n{ "url": string, "head_ref": string, "base_ref": string, "cwd": string, "epoch": number }\n\n## Tools\n使用可: Bash のみ\n\n## Boundary\nファイル変更・git 操作禁止。\n\n## Token cap\n80 語以内で完結すること。`,
  { agentType: 'dev-runner-haiku-ro', schema: PR_META, label: 'pr-meta', phase: 'Iterate' },
)
const REPO = repoFromGithubUrl(prMeta?.url)
if (!REPO) log('⚠️ repo (owner/name) を解決できず — telemetry の repo は省略される')
// ==== BEGIN inline: _lib/isolation-probe.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// Isolation probe: dev-flow の Setup phase 完了直後に bg-isolation guard を早期検知する純関数群
// （bg job から dev-flow を起動する際、呼び出し元セッションが自身の cwd を worktree へ isolate
// していないと、harness の bg-isolation guard により implementer の Write/Edit tool 呼び出しが
// 共有チェックアウトへの書き込みとして拒否される。放置すると Implement/Evaluate まで数十 agent
// 分の呼び出しを浪費した後に empty-diff として発覚するため、Setup 完了直後に probe で早期検知する）。
//
// isolationCleanupPrompt: probe の直前に gitignored な作業用パスを除去させる prompt を組み立てる
//   純関数（trust 証跡等を run 間で持ち越さない衛生目的）。除去範囲 target は呼び出し元が明示的に渡す
//   必須引数: dev-flow Setup は run 開始時点なので `.devflow-tmp` 全体を消せるが、pr-iterate は
//   dev-flow から nested 起動されると isoWt が実行中 run の worktree 自身になるため、
//   `.devflow-tmp/.isolation-probe` だけに絞る（当該 run が既に書いた trust 証跡を run 途中で
//   消さない）。デフォルト値を持たせると、呼び出し元が範囲を意識しないまま広い方を選ぶ。
//   probe の成立自体はもう本 prompt の実行成否に依存しない（下記 isolationProbePrompt 参照）。
// isolationProbePrompt: probe 専用 agent（Write tool のみ）へ渡す prompt を組み立てる純関数
//   （worktree 直下の run 毎に一意なパスへ Write tool で実際に書き込ませ、成否を {written, error} で
//   verbatim 報告させる）。token は呼び出し元が渡す必須引数: probe 対象パスに run 毎の一意な token
//   を含めることで、cleanup が blocked/skip されて前 run の残置物が残っていても probe が成立する
//   （成立が cleanup の成功に依存しない — issue #521）。cleanup は trust 証跡の持ち越し防止等の
//   衛生目的で独立に残る。
// isolationErrorKind: probe の error 文字列を既知シグネチャで分類する純関数。written:false の原因が
//   「isolation 不成立」なのか「その他の書き込み失敗（上書き拒否等）」なのかを isolationFailureMessage
//   が出し分けるための判別根拠にする。
//   「File has not been read yet. Read it first before writing to it.」は Write tool の
//   「既存ファイルは同一セッション内で Read 済みでないと上書き拒否」エラー文言そのもの（issue #482
//   で実測）。token による一意化後もこのシグネチャが出る場合は同一 run 内の再実行など probe パス
//   自体が既存ファイルだったケースであり、isolation 不成立とは別原因として区別する。
// isolationFailureMessage: probe が written:false を返した場合の throw メッセージを組み立てる純関数
//   （branch/起点 ref/workflow 名・args を含む復旧手順 — worktree 作成/EnterWorktree/Workflow 再実行 — を返す）。
//   呼び出し元（dev-flow.js / pr-iterate.js）ごとに workflow 名・再実行 args・回避手順で提示する
//   worktree 先（targetPath）・新規 worktree の起点 ref（startRef）が異なるため、いずれも呼び出し元が
//   明示的に渡す必須引数にする（デフォルト値による暗黙の workflow 名混同を避ける — issue #455 レビュー指摘）。
//   startRef は `origin/<ref>` 等の完全な ref 式を受け取る（関数側で origin/ を補わない）。
//   dev-flow は未実装 issue の作業を base から始めるため `origin/<base>`、pr-iterate は既存 PR の
//   head を再現する必要があるため `origin/<head_ref>` を渡す（base 起点だと PR の変更を含まない
//   worktree を提示してしまう — issue #455 レビュー指摘）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。
//
// 不変条件: 本ファイルが生成する prompt / メッセージは、実行制御の名称（sandbox・permission・
// excludedCommands・guard 等）を「だからこの経路を使え」という形の理由として述べない。
// 転写契約に判断余地を持ち込ませないための規範であり、`.claude/rules/dev-flow.md` の exec-proxy 節が
// 正典。canonical と 2 つの inline 生成区間の双方を _lib/isolation-control-reason.test.mjs が pin する。

function isolationCleanupPrompt(worktree, target) {
  return `worktree ${worktree} の gitignored な作業用パス \`${target}\` を除去せよ。手順:\n`
    + `1. \`git -C ${worktree} clean -fdx -- ${target}\` を 1 回だけ実行する`
    + `（\`${target}\` が存在しない場合もこのコマンドは成功する）\n`
    + `2. 成功したら {"cleaned": true} を返せ。\n`
    + `コマンドがエラーを返した場合は、例外を投げずに `
    + `{"cleaned": false, "error": "<エラーメッセージ全文>"} を返せ。\n`
    + `\`${target}\` 以外のパスには触れるな。`;
}

function isolationProbePrompt(worktree, token) {
  const tok = String(token).replace(/[^A-Za-z0-9._-]/g, '-');
  const path = `${worktree}/.devflow-tmp/.isolation-probe-${tok}`;
  return `Objective: 絶対パス \`${path}\` へ Write tool で内容 "ok" を書き込み、結果を verbatim 報告せよ。\n`
    + `Tools: 使用可: Write のみ。他の tool は使用禁止。\n`
    + `Boundary: \`${path}\` 以外のパスに書き込むな。Write tool がエラー・拒否を返した場合、`
    + `他の手段でファイルを作成しようと試みるな — 1 回の Write の結果をそのまま報告せよ。\n`
    + `成功したら {"written": true} を返せ。`
    + `Write tool がエラー・拒否を返した場合は、例外を投げずに `
    + `{"written": false, "error": "<エラーメッセージ全文>"} を返せ。`;
}

function isolationErrorKind(error) {
  const text = String(error ?? '');
  if (/has not been read/i.test(text)) return 'overwrite_refused';
  if (/parent bg session hasn'?t isolated|bg.?isolation/i.test(text)) return 'isolation';
  return 'unknown';
}

function isolationFailureMessage({ worktree, branch, startRef, workflowName, workflowArgs, targetPath, error }) {
  const wt = targetPath || worktree;
  const relWt = wt.includes('.claude/worktrees/') ? wt.slice(wt.indexOf('.claude/worktrees/')) : wt;
  const kind = isolationErrorKind(error);
  const heading = kind === 'overwrite_refused'
    ? `${workflowName}: isolation probe 書き込み失敗 — 既存 probe ファイルの上書き拒否`
      + `（isolation 不成立とは別原因。前 run の残置物が同名パスに残っている可能性）`
    : kind === 'isolation'
      ? `${workflowName}: worktree isolation エラー — implementer が ${worktree} に書き込めません`
        + `（bg-isolation guard の可能性: 呼び出し元セッションの cwd がこの worktree へ isolate されていない）`
      : `${workflowName}: isolation probe 書き込み失敗 — 原因を特定できず`
        + `（isolation 不成立の可能性を含む）`;
  return `${heading}。\n`
    + `対処: 呼び出し元セッションで以下を実行してから ${workflowName} を再起動してください`
    + `（新しい worktree には前 run の残置物が無いため、残置物が原因だった場合も同時に解消します）:\n`
    + `  1. git worktree add -b ${branch} ${wt} ${startRef}\n`
    + `     （branch ${branch} がローカルに既存なら -b と起点を外して \`git worktree add ${wt} ${branch}\`、`
    + `さらに他 worktree で checkout 済みなら \`git worktree add --force ${wt} ${branch}\`、`
    + `worktree ${wt} 自体が既存なら本手順ごと不要）\n`
    + `  2. EnterWorktree({ path: "${relWt}" })\n`
    + `  3. Workflow({ name: "${workflowName}", args: "${workflowArgs}" }) を再実行\n`
    + (error ? `probe error: ${error}` : '');
}
// ==== END inline: _lib/isolation-probe.mjs ====

// isolation probe: bg 起動セッションが cwd を worktree へ isolate していないと fix stage の
// Write/Edit tool 呼び出しが harness の bg-isolation guard に拒否される。review loop（fix stage の
// 手前）に進入する前に probe で早期検知する（issue #449。dev-flow.js Setup phase と同型パターン）。
// 失敗（written:false）は fail-closed（即中断）、probe 自体の失敗（null）は fail-open（警告のみ）。
const ISOLATION_PROBE = {
  type: 'object', required: ['written'],
  properties: { written: { type: 'boolean' }, error: { type: 'string' } },
}
const ISOLATION_CLEANUP = {
  type: 'object', required: ['cleaned'],
  properties: { cleaned: { type: 'boolean' }, error: { type: 'string' } },
}
const isoWt = prMeta?.cwd || '.'
// cwd 欠落は後段に効く: journal-save の savePath が相対パスになり buildJournalSaveInstr が
// throw するため、その run の telemetry は決定論的に save_failed になる（fail-open なので run は
// 継続する）。原因が pr-meta probe 側にあることを追えるよう fallback 発生を明示する。
if (!prMeta?.cwd) log('⚠️ pr-meta が cwd を返さなかったため isoWt=. で継続します（telemetry は save_failed になります）')
// isoTargetPath: 回避手順で提示する新規 worktree 先。isoWt（書き込みに失敗した共有 checkout の cwd）
// とは別の孤立した先を提示する必要があるため、cwd 自体を git worktree add の対象にしない
// （issue #455 レビュー指摘: 共有 checkout の cwd を worktree 作成先として提示するのは誤り）。
const isoTargetPath = `${isoWt.replace(/\/\.claude\/worktrees\/.*$/, '')}/.claude/worktrees/pr-${PR}`
// isolation cleanup（issue #493）: probe の直前に前 run が残した stale な probe artifact を除去する
// （残っていると isolation が正常でも probe が written:false に倒れる — issue #482）。
// 除去範囲は `.devflow-tmp/.isolation-probe` のみに絞る: nested 起動（dev-flow → workflow('pr-iterate')）
// では isoWt が実行中の dev-flow worktree 自身になり、`.devflow-tmp` 全体を消すと当該 run が既に
// 書いた trust 証跡（trust-risk-eval.json 等）を run 途中で失う。`.devflow-tmp` 全体の除去は run 開始
// 時点である dev-flow Setup 側の責務。fail-open: 失敗しても run は継続する（残っていれば直後の
// probe が written:false で fail-closed に倒れ、復旧手順は同一）。
const isoClean = await failOpenAgent(isolationCleanupPrompt(isoWt, '.devflow-tmp/.isolation-probe'), { agentType: 'dev-runner-haiku', schema: ISOLATION_CLEANUP, label: 'isolation-cleanup', phase: 'Iterate' })
if (!isoClean || isoClean.cleaned !== true) log(`⚠️ isolation cleanup が完了しなかった（fail-open で続行）: ${isoClean?.error ?? 'agent null'}`)
// isoToken: probe 対象パスを run 毎に一意にする（issue #521）。pr-meta probe（fail-open）が
// 取得した epoch を使い、取得できなければ PR 番号へ fallback する。nested 起動（dev-flow →
// workflow('pr-iterate')）時、probe ファイルは実行中 dev-flow run の worktree の
// `.devflow-tmp/.isolation-probe-<token>` に書かれるが一意名のため dev-flow 側 trust 証跡・probe
// ファイルと衝突しない。
const isoToken = String(prMeta?.epoch ?? PR)
const isoProbe = await failOpenAgent(isolationProbePrompt(isoWt, isoToken), { agentType: 'dev-runner-haiku-wo', schema: ISOLATION_PROBE, label: 'isolation-probe', phase: 'Iterate' })
if (isoProbe && isoProbe.written === false) {
  throw new Error(isolationFailureMessage({
    // startRef は PR の head（base ではない）— pr-iterate は既存 PR の変更を含む worktree を
    // 再現させる必要がある。base 起点だと fix 対象の diff を持たない worktree を提示してしまう
    // （issue #455 レビュー指摘）。
    worktree: isoWt, branch: prMeta?.head_ref || '?', startRef: `origin/${prMeta?.head_ref || '?'}`,
    workflowName: 'pr-iterate', workflowArgs: PR, targetPath: isoTargetPath, error: isoProbe.error,
  }))
}
if (!isoProbe) log('⚠️ isolation probe 自体が失敗 — 書き込み可否を診断できず（fail-open で続行）')

let lastReview = null
let lgtm = false
let i = 0
let terminal = null              // 早期終端理由（stuck / fix_failed）。null なら lgtm / max_reached で判定
let fixesApplied = 0  // fix.applied===true の累積回数（dev-flow が stale-eval 警告の判定に使う。issue #233）
let fixNullRetries = 0  // fix agent が null または throw（schema 不一致・StructuredOutput 契約違反等の技術的失敗）で 1 回 retry した累積回数。issue #347 / #520
let reviewNullRetries = 0  // review agent が throw または null で schema-retry した累積回数。issue #437
let fixUncommittedRecovered = 0  // fix が applied:true なのに未コミット変更が残っており ensure-committed が commit+push で回収した回数（issue #437）
let totalCiWaitSeconds = 0  // ci-check の attempt ループの累積待機秒数（全 ci-check ラウンド合算。issue #324）
let totalCiPollAttempts = 0  // 同上の累積ポーリング（gh fetch）回数
// 直近の ci-check#i 応答が返した epoch（issue #443）。dev-flow の iterate_end 給電元として返り値
// end_epoch に載せる。応答が epoch を欠く/非数値なら更新せず、直前の値（または null）を保持する（fail-open）。
let lastCiEpoch = null
const reviewSeen = makeSeenTracker(REVIEW_STUCK)  // findings 累積 & stuck 検出（_lib/stuck-detector.mjs。issue #126）
const history = []               // ラウンド履歴 [{iteration, decision, summary, blocking, minor}]

// fix agent が throw（StructuredOutput 契約違反等の harness 例外）または null（schema 不一致/技術的
// 失敗）の場合のみ、同一 findings で 1 回だけ再試行する（callReviewAgent と同一契約。issue #437 / #520）。
// applied:false（agent の明示判断による修正不能）は retry しない — stuck 検出等の incentive-structural
// 機構は不変。retry は iteration ごと最大 1 回で有限（review#N-contract-retry :604-614 と同パターン、
// MAX 非消費）。issue #347
async function callFixAgent(prompt, i) {
  let fix = null
  try {
    fix = await trackedAgent(prompt, { agentType: 'dev-runner', schema: FIX, label: `fix#${i}`, phase: 'Iterate' })
  } catch (e) {
    log(`⚠️ fix#${i} が例外を投げた（StructuredOutput 契約違反等）: ${e?.message ?? e}`)
  }
  let retried = false
  if (fix == null) {
    retried = true
    fixNullRetries++
    log(`⚠️ fix#${i} が null（schema 不一致/技術的失敗）— 同一 findings で 1 回だけ再試行する（fix-null-retry）`)
    try {
      fix = await trackedAgent(prompt, { agentType: 'dev-runner', schema: FIX, label: `fix#${i}-retry`, phase: 'Iterate' })
    } catch (e) {
      log(`⚠️ fix#${i}-retry も例外: ${e?.message ?? e}`)
    }
  }
  return { fix, retried }
}

// review agent の throw（StructuredOutput 契約違反等の harness 例外）と null（schema 不一致）を
// 同一の契約失敗として扱い、呼び出しごと最大 1 回だけ同一 prompt で再試行する（issue #437）。
// retry 後も失敗なら null を返し、呼び出し側が status:'review_contract_error' で graceful に終了する。
async function callReviewAgent(prompt, label) {
  let review = null
  try {
    review = await trackedAgent(prompt, { agentType: 'pr-reviewer', model: QUALITY_MODEL, schema: REVIEW, label, phase: 'Iterate' })
  } catch (e) {
    log(`⚠️ ${label} が例外を投げた（StructuredOutput 契約違反等）: ${e?.message ?? e}`)
  }
  if (review == null) {
    reviewNullRetries++
    log(`⚠️ ${label} が結果を返さず — 同一 prompt で 1 回だけ再試行する（schema-retry）`)
    try {
      review = await trackedAgent(prompt, { agentType: 'pr-reviewer', model: QUALITY_MODEL, schema: REVIEW, label: `${label}-schema-retry`, phase: 'Iterate' })
    } catch (e) {
      log(`⚠️ ${label}-schema-retry も例外: ${e?.message ?? e}`)
    }
  }
  return review
}

// fix 適用直後の commit 保証（AC-3, issue #437）。fix agent の self-report（applied:true）を信用せず
// 決定論スクリプトで worktree の未コミット変更を検証し、dirty なら commit+push で回収する。
// 失敗ポリシー: fail-safe — null/schema 不一致/回収失敗（dirty なのに committed&&pushed でない）は
// false を返し、呼び出し側が terminal='fix_failed' で人間へエスカレーションする
// （未コミットのまま次 iteration へ進むと再 review が stale な PR diff を見るため、状態不明を green と同一視しない）。
async function ensureFixCommitted(i) {
  let ensured = null
  try {
    ensured = await trackedAgent(
      `## Objective\nfix#${i} 適用後の作業ツリーに未コミット変更が残っていないことを保証する（残っていれば commit + push で回収する）。\n\n## Steps\n以下を順に bare 単文（先頭トークンが git。cd 前置・bash 前置・env 代入前置・&& 連結禁止）で実行せよ:\n1. \`git -C ${isoWt} status --porcelain\` を実行する。出力が空なら { "dirty": false, "committed": false, "pushed": false } を返して終了。\n2. 出力が空でなければ順に実行: \`git -C ${isoWt} add -A\` → \`git -C ${isoWt} commit -m "fix(pr-${PR}): commit leftover review fixes (iteration ${i})"\` → \`git -C ${isoWt} push\`（push が失敗した場合のみ \`git -C ${isoWt} push -u origin HEAD\` を実行）。\n3. \`git -C ${isoWt} status --porcelain\` を再実行する。出力が空なら committed:true、空でなければ committed:false。\n4. \`git -C ${isoWt} rev-list "@{u}"..HEAD --count\` を実行する。出力が 0 なら pushed:true。コマンド失敗または非数値出力なら pushed:false。\n5. { "dirty": true, "committed": <3の結果>, "pushed": <4の結果> } を返す。\n\n## Output format\n{ "dirty": boolean, "committed": boolean, "pushed": boolean }\nprose 禁止。JSON のみ返せ。\n\n## Tools\n使用可: Bash, Read\n\n## Boundary\n上記 git コマンド以外のファイル変更・git 操作禁止。\n\n## Token cap\nJSON のみ。1 行以内。`,
      { agentType: 'dev-runner-haiku', schema: COMMIT_ENSURE, label: `commit-ensure#${i}`, phase: 'Iterate' },
    )
  } catch (e) {
    log(`⚠️ commit-ensure#${i} が例外: ${e?.message ?? e}`)
  }
  if (ensured == null) return false
  if (ensured.dirty === false) return true
  if (ensured.committed === true && ensured.pushed === true) {
    fixUncommittedRecovered++
    log(`⚠️ fix#${i} は applied:true だが未コミット変更が残っていた — ensure-committed が commit+push で回収した`)
    return true
  }
  return false
}

for (i = 1; i <= MAX; i++) {
  const prior = reviewSeen.prior()   // 前 iteration までの累積 findings
  const reviewPrompt = `PR #${PR} を批判的にレビューせよ。gh pr view / gh pr diff で実 diff を確認し、宣言意図に照合する。\n`
    + `summary は結論 1-2 文に留めよ。検証した根拠（テスト実行・diff 照合・edge case 確認等）は verification_evidence に 1 項目 1 文の配列で列挙せよ。\n`
    + (prior.length
        ? `既出 findings（前ラウンドまでに指摘済み。author は対応済みのはず）:\n${JSON.stringify(prior)}\n`
          + `**新規の critical/major のみ報告**せよ。前ラウンドで対応済み・却下済みの論点の蒸し返し、`
          + `別観点の上乗せ（moving target）は禁止。既出問題を再提起する場合は既出と同じ topic 文字列を`
          + `必ず再利用せよ（orchestrator が topic で stuck を突合する）。`
        : '')
  const review = await callReviewAgent(reviewPrompt, `review#${i}`)
  if (review == null) {
    terminal = 'review_contract_error'
    log(`⚠️ iteration ${i}: review#${i} が schema-retry 後も結果を返さず（StructuredOutput 契約違反）。人間へエスカレーション`)
    break
  }
  lastReview = review

  let effReview = review
  let outcome = classifyReviewRoute(review)

  // contract mismatch（approve だが blocking あり）: 同一 iteration 内で 1 回だけ再 review する。
  // MAX は消費しない — 有限性は「iteration ごと最大 1 回」で担保する（issue #321）。
  if (outcome.route === 'contract_mismatch') {
    log(`⚠️ iteration ${i}: review contract mismatch — decision=approve だが blocking ${outcome.blocking.length} 件。1 回だけ再 review する`)
    const rereview = await callReviewAgent(
      reviewPrompt
      + `\n\n直前の review 出力は decision='approve' なのに critical/major の issues が ${outcome.blocking.length} 件あり矛盾している。`
      + `直前の出力: ${JSON.stringify(review)}。`
      + `blocking issues が実在するなら decision を request-changes/comment にし、実在しないなら issues から除いて、`
      + `decision と issues が整合した結果を再出力せよ。既出問題の topic 文字列は同一のものを再利用せよ。`,
      `review#${i}-contract-retry`,
    )
    if (rereview == null) {
      terminal = 'review_contract_error'
      log(`⚠️ iteration ${i}: review#${i}-contract-retry が schema-retry 後も結果を返さず（StructuredOutput 契約違反）。人間へエスカレーション`)
      history.push({ iteration: i, decision: review.decision, summary: review.summary, blocking: outcome.blocking, minor: outcome.minor })
      break
    }
    effReview = rereview
    lastReview = rereview
    outcome = classifyReviewRoute(rereview)

    if (outcome.route === 'contract_mismatch') {
      // 再 review 後も decision と blocking の矛盾が再発 — 無限ループせず人間へエスカレーション。
      // 注意: この mismatch review の blocking は reviewSeen に register しない
      // （fix を挟まない再 review が REVIEW_STUCK を 1 iteration 内で誤発火させるため）。
      terminal = 'review_contract_error'
      log(`⚠️ iteration ${i}: review contract mismatch が再 review 後も再発（decision=approve、blocking ${outcome.blocking.length} 件）。人間へエスカレーション`)

      history.push({ iteration: i, decision: effReview.decision, summary: effReview.summary, blocking: outcome.blocking, minor: outcome.minor })

      break
    }
  }

  if (outcome.route === 'ci_gate') {
    // CI gate — restores the gate lost in eb8aa7e (issue #133)。blocking 0 件の comment/request-changes も
    // ここへ合流する（AC-1/AC-2、issue #321）。lgtm 確定時の投稿のみ decision で分岐する（approve でなければ捏造しない）。
    // pr-reviewer may LGTM the code but CI must also be green before we declare lgtm.
    // no_checks is treated as passing (consistent with e4e2b92: repos without CI are fine).
    const ci = await failOpenAgent(
      `## Objective\n`
      + `PR #${PR} の CI ステータスを取得し、JSON をそのまま返せ。\n\n`
      + `## Tools\n`
      + `- 使用可: Bash のみ\n`
      + `- 禁止: Write, Edit, git commit, git push\n\n`
      + `## Boundary\n`
      + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n`
      + `- 実行するスクリプト以外のファイルを変更しない\n\n`
      + `## Steps\n`
      + `attempt=1 から開始し、次を最大 ${CI_MAX_ATTEMPTS} 回繰り返せ:\n`
      + `1. \`gh pr checks ${PR}${REPO ? ' --repo ' + REPO : ''} --json name,state,bucket\` を gh を先頭トークンとする bare 単文で実行せよ`
      + `（リダイレクト・パイプ・複合コマンドは使わない）。`
      + `このコマンドの exit code を判定に使ってはならない（pending で 8、失敗ありで 1 を返す仕様であり、fetch 自体の成否とは無関係）。\n`
      + `2. \`bash ~/.claude/skills/pr-iterate/scripts/check-ci.sh --checks-data '<手順1の stdout を一字一句そのまま。要約・整形・省略禁止>' `
      + `--fetch-error-data '<手順1の stderr を一字一句そのまま。stderr が空なら本オプション自体を省略>' `
      + `--attempt <attempt> --max-attempts ${CI_MAX_ATTEMPTS} --poll-seconds ${CI_POLL_SECONDS}\` `
      + `を単文で実行し、stdout の JSON を読め。\n`
      + `3. その JSON の \`next_action\` が \`"poll"\` なら \`sleep ${CI_POLL_SECONDS}\` を単文で実行し、attempt を 1 増やして 1 へ戻れ。`
      + `\`"done"\` なら 4 へ進め。\n`
      + `4. 最後に得た stdout JSON（{status, failed_checks, waited_seconds, poll_attempts, ...}）をそのまま返せ。要約・加工するな。\n`
      + `CI pending 時は最大 ${(CI_MAX_ATTEMPTS - 1) * CI_POLL_SECONDS} 秒（${CI_POLL_SECONDS} 秒間隔）待ってから確定する（AC-1/AC-2）。\n\n`
      + `## Output format\n`
      + `{ "status": "passed"|"failed"|"pending"|"no_checks"|"error", "failed_checks": [{name, bucket, state}, ...], `
      + `"waited_seconds": number, "poll_attempts": number }\n`
      + `prose 禁止。JSON のみ返せ。\n\n`
      + `## Token cap\n`
      + `JSON のみ。1 行以内。`,
      { agentType: 'dev-runner-haiku-ro', schema: CI_STATUS, label: `ci-check#${i}`, phase: 'Iterate' },
    )

    if (ci == null) {
      log(`⚠️ ci-check#${i} が結果を返さず — fail-open で status=error（ci_error 終端）扱い`)
    }
    const ciEff = ci ?? { status: 'error', failed_checks: [] }

    // waited_seconds/poll_attempts は route（passed/pending/failed/error）に関わらず常に加算する。
    totalCiWaitSeconds += Number(ciEff.waited_seconds ?? 0)
    totalCiPollAttempts += Number(ciEff.poll_attempts ?? 0)
    if (Number.isFinite(ci?.epoch)) lastCiEpoch = ci.epoch
    log(`iteration ${i}: ci-check waited_seconds=${ciEff.waited_seconds ?? 0} poll_attempts=${ciEff.poll_attempts ?? 0}`
      + `（累積 waited=${totalCiWaitSeconds}s poll=${totalCiPollAttempts}）`)

    if (ciEff.status === 'passed' || ciEff.status === 'no_checks') {
      lgtm = true
      log(`iteration ${i}: LGTM（CI status=${ciEff.status}）`)

      // lgtm 確定ラウンドの history を記録（blocking なし、minor は保持）
      history.push({ iteration: i, decision: effReview.decision, summary: effReview.summary, blocking: [], minor: outcome.minor })

      break
    } else if (ciEff.status === 'error') {
      // Real gh API error (auth failure, network error, etc.) — do not misinterpret as CI failure.
      // Surface to human immediately; retrying a fix on a non-existent bug would waste cycles.
      terminal = 'ci_error'
      log(`⚠️ CI check returned error — gh API failed (auth/network). 人間へエスカレーション`)
      break
    } else if (ciEff.status === 'pending') {
      terminal = 'ci_pending'
      log(`⚠️ CI pending — checks incomplete, never auto-approve. 人間/CI 完了待ちへエスカレーション`)
      break
    } else if (ciEff.status === 'failed') {
      // ciEff.status === 'failed': convert failed_checks into synthetic blocking findings and route
      // through the existing fix path. Repeated identical ci::<name> topics hit REVIEW_STUCK
      // automatically via the existing stuckTopics computation below.
      // failed_checks items are {name, bucket, state} per check-ci.sh output (no conclusion field).
      const ciFindings = (ciEff.failed_checks && ciEff.failed_checks.length > 0)
        ? ciEff.failed_checks.map((c) => ({
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
      for (const x of ciFindings) reviewSeen.register(x)
      const ciStuckTopics = reviewSeen.stuckTopics()
      log(`iteration ${i}: ${effReview.decision} だが CI failed — ${ciFindings.length} failing check(s)`
        + `${ciStuckTopics.length ? ` [REVIEW_STUCK: ${ciStuckTopics.join(' / ')}]` : ''}`)

      // CI-failed ラウンドの history 記録（blocking は synthetic CI findings、minor は保持）
      const ciRound = { iteration: i, decision: effReview.decision, summary: effReview.summary, blocking: ciFindings, minor: outcome.minor }
      history.push(ciRound)

      if (ciStuckTopics.length) {
        terminal = 'stuck'
        log(`⚠️ Review STUCK — 同一 CI failure topic が ${REVIEW_STUCK} 回反復（${ciStuckTopics.join(' / ')}）。`
          + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
        break
      }

      const issuesText = ciFindings
        .map((x) => `- [${x.severity}] ${x.description}${x.suggestion ? ' → ' + x.suggestion : ''}`)
        .join('\n')

      const ciFixPrompt = `PR #${PR} の CI 失敗を修正する。手順: (1) \`gh pr checkout ${PR}\` で PR ブランチを checkout、`
        + `(2) 下記の CI 失敗を修正、(3) Conventional Commits 形式で commit、(4) \`git push\` で push。`
        + `解消すべき CI 失敗:\n${issuesText}`
      const { fix, retried } = await callFixAgent(ciFixPrompt, i)
      if (retried) ciRound.fix_retried = true

      if (fix == null || fix.applied !== true) {
        terminal = 'fix_failed'
        log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}${retried ? '（retry 後も null）' : ''}。`
          + `無言で再レビューを繰り返さず人間へエスカレーション`)
        break
      }

      if (!(await ensureFixCommitted(i))) {
        terminal = 'fix_failed'
        log(`⚠️ fix#${i} 適用後の commit 保証に失敗（未コミット変更の残存 또는 commit/push 失敗/状態不明）— 未コミットのまま次 iteration へ進まず人間へエスカレーション`)
        break
      }

      // CI fix applied — continue to next iteration for re-review + re-CI-check
      fixesApplied++
      continue
    }
  } else {
    // outcome.route === 'fix_loop'（blocking あり、decision は request-changes/comment。approve はここへ来ない）
    const blocking = outcome.blocking

    // blocking findings を topic 単位で累積し出現回数を数える（stuck 検出 fingerprint。issue #126）
    for (const x of blocking) reviewSeen.register(x)
    const stuckTopics = reviewSeen.stuckTopics()
    log(`iteration ${i}: ${effReview.decision} — blocking ${blocking.length} 件`
      + `${stuckTopics.length ? ` [REVIEW_STUCK: ${stuckTopics.join(' / ')}]` : ''}`)

    // history に記録（blocking findings と minor を含む）
    const round = { iteration: i, decision: effReview.decision, summary: effReview.summary, blocking, minor: outcome.minor }
    history.push(round)

    // stuck: 同一 topic が REVIEW_STUCK 回繰り返した = fix が刺さっていない。relax せず人間へエスカレーション。
    if (stuckTopics.length) {
      terminal = 'stuck'
      log(`⚠️ Review STUCK — 同一 topic が ${REVIEW_STUCK} 回反復（${stuckTopics.join(' / ')}）。`
        + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
      break
    }

    // minor は fix loop の対象外 — issuesText / fix agent プロンプトに一切含めない（AC-5、issue #321）。
    // description/suggestion はメタ指示・迂回手順の verbatim 伝播遮断のため buildFixIssuesText で
    // スクラブしてから埋め込む（issue #503。canonical は _lib/review-finding-scrub.mjs）。
    const issuesText = buildFixIssuesText(blocking)

    // fix は dev-runner agent に直接指示する（旧 pr-fix skill は issue #116 で削除）。
    const fixPrompt = `PR #${PR} のレビュー指摘を修正する。手順: (1) \`gh pr checkout ${PR}\` で PR ブランチを checkout、`
      + `(2) 下記の指摘を修正、(3) Conventional Commits 形式で commit、(4) \`git push\` で push。`
      + `解消すべき指摘:\n${issuesText}`
    const { fix, retried } = await callFixAgent(fixPrompt, i)
    if (retried) round.fix_retried = true

    // fix の applied:false を検出して人間へエスカレーション（無言で MAX 回燃やさない。issue #126）。
    if (fix == null || fix.applied !== true) {
      terminal = 'fix_failed'
      log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}${retried ? '（retry 後も null）' : ''}。`
        + `無言で再レビューを繰り返さず人間へエスカレーション`)
      break
    }

    if (!(await ensureFixCommitted(i))) {
      terminal = 'fix_failed'
      log(`⚠️ fix#${i} 適用後の commit 保証に失敗（未コミット変更の残存 또는 commit/push 失敗/状態不明）— 未コミットのまま次 iteration へ進まず人間へエスカレーション`)
      break
    }
    fixesApplied++
  }
}

const status = lgtm ? 'lgtm' : (terminal ?? 'max_reached')
log(`pr-iterate 終端: status=${status}（iterations=${Math.min(i, MAX)}）`)

// 異常終端時の worktree dirty 検出（AC-2, issue #437）。advisory telemetry — 失敗は fail-open
// （'unknown' + 警告のみ。gate・status には影響しない）。lgtm 終端では probe しない（agent 呼び出し追加ゼロ）。
let worktreeDirty = null  // 'dirty' | 'clean' | 'unknown' | null(=lgtm で未実施)
if (status !== 'lgtm') {
  const probe = await failOpenAgent(
    `## Objective\npr-iterate 異常終端（status=${status}）時点の作業ツリーが dirty（未コミット変更あり）かを検出する。\n\n## Steps\n\`git -C ${isoWt} status --porcelain\` を bare 単文（先頭トークンが git。cd 前置・bash 前置・env 代入前置・&& 連結禁止）で実行せよ。出力が空なら { "dirty": false, "files": 0 }。出力が非空なら { "dirty": true, "files": <出力の非空行数> }。\n\n## Output format\n{ "dirty": boolean, "files": number }\nprose 禁止。JSON のみ返せ。\n\n## Tools\n使用可: Bash, Read\n\n## Boundary\n読み取り専用。ファイル変更・git mutation 禁止。\n\n## Token cap\nJSON のみ。1 行以内。`,
    { agentType: 'dev-runner-haiku-ro', schema: DIRTY_STATUS, label: 'worktree-dirty-check', phase: 'Iterate' },
  )
  worktreeDirty = probe == null ? 'unknown' : (probe.dirty === true ? 'dirty' : 'clean')
  if (worktreeDirty === 'dirty') log(`⚠️ 終端 status=${status} で作業ツリーが dirty（未コミット変更 ${probe?.files ?? '?'} 件）— fix 適用分が失われる可能性。人間が確認すること`)
  if (worktreeDirty === 'unknown') log('⚠️ worktree-dirty-check probe に失敗 — dirty 状態は不明（fail-open で続行）')
}

// 終端サマリーを PR に 1 回だけ投稿する
const summaryBody = buildTerminalSummaryBody({
  pr: PR,
  status,
  iterations: Math.min(i, MAX),
  lastDecision: lastReview?.decision ?? null,
  lastSummary: lastReview?.summary ?? '(review agent が StructuredOutput 契約違反で結果を返さなかったため最終判定なし)',
  lastVerificationEvidence: lastReview?.verification_evidence ?? null,
  history,
  ciWaitSeconds: totalCiWaitSeconds,
  ciPollAttempts: totalCiPollAttempts,
})
const terminalBlockingCount = (history[history.length - 1]?.blocking ?? []).length
const termAction = terminalReviewAction({ status, lastDecision: lastReview?.decision ?? null, blockingCount: terminalBlockingCount })
log(`終端サマリーは comment として投稿する（参考: 旧 formal review action=${termAction}。formal review は投稿しない — issue #524）`)

if (POST_TERMINAL_SUMMARY) {
  // formal review（`gh` の `pr review --approve`/`--request-changes` サブコマンド）指示は
  // post-summary prompt に含めない — approve 指示が safety classifier に self-approval として
  // blocked され、fail-open のため終端サマリが silent に欠落する（issue #524）。
  // 投稿は `gh pr comment` 単一経路のみを使う。
  const summaryInstructions = `保存した <BODY_FILE> を使い、以下のコマンドをそのまま実行せよ: \`gh pr comment ${PR} --body-file <BODY_FILE>\`\n`
    + `投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
    + `投稿失敗時でも posted:false を返し throw しないこと。\n`

  const summaryPost = await failOpenAgent(
    `## Objective\nPR #${PR} に pr-iterate の終端サマリーコメントを投稿する（status: ${status}）。\n\n`
    + bodySaveInstr(summaryBody, 'pr-iterate', 'PR_ITERATE')
    + `## Instructions\n`
    + summaryInstructions
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n`
    + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
    + `\n## Token cap\n200 語以内で完結すること。`,
    { agentType: 'dev-runner-haiku', schema: POST_RESULT, label: `post-summary`, phase: 'Iterate' },
  )
  if (!summaryPost?.posted) {
    log(`⚠️ post-summary の投稿に失敗しました（posted=${summaryPost?.posted ?? 'null'}）。ワークフローは継続します。`)
  }
}

const telemetryHandoff = buildJournalHandoffPayload({
  skill: 'pr-iterate',
  outcome: 'success',
  args: `pr=${PR}`,
  repo: REPO,
  pr_number: Number(PR),
  telemetry: {
    merge_tier: 'PR_ITERATE',
    iterate_status: status,
    ci_wait_seconds: totalCiWaitSeconds,
    ci_poll_attempts: totalCiPollAttempts,
    fix_null_retries: fixNullRetries,
    review_null_retries: reviewNullRetries,
    fix_uncommitted_recovered: fixUncommittedRecovered,
    ...(worktreeDirty != null ? { worktree_dirty: worktreeDirty } : {}),
    subagent_invocations: buildSubagentInvocations(SUBAGENT_COUNTS),
  },
})
// journal handoff（issue #494）: journal-save（payload をファイルへ verbatim 永続化）→
// journal-log（検証済みファイルパスを finalize command で pending/ へ格納）の 2 段構成。
// payload 本文はディスク上のデータとして運び、pending/ へ書き出す prompt 自体はパスのみを
// 持つ。journal_log_status は 3 値 closed enum
// （logged/save_failed/log_failed）で返り値へ現れる。fail-open は維持（gate 判定には無影響）。
let journalLogStatus = 'save_failed'
try {
  const journalPayloadPath = `${isoWt}/.devflow-tmp/payload-priterate-${PR}.json`
  const journalSaveRes = await trackedAgent(
    `## Objective\npr-iterate 終端の telemetry handoff payload を一時ファイルへ保存する。\n\n`
    + `## Instructions\n`
    + buildJournalSaveInstr({ payload: telemetryHandoff, savePath: journalPayloadPath })
    + `\n## Output format\n{ "saved": boolean, "path": string }\n`
    + `\n## Tools\n使用可: Write, Read（保存先は指示で固定済み — Bash は不要。Read は既存 payload の\n`
    + `冪等上書きに必要）\n`
    + `\n## Boundary\n作成した一時ファイル以外のファイルを変更しない。git 操作禁止。\n`
    + `\n## Token cap\n120 語以内。`,
    { agentType: 'dev-runner-haiku', schema: JOURNAL_SAVE_RESULT, label: 'journal-save', phase: 'Iterate' },
  )
  // 保存先は JS 側で確定しているので agent 申告の path は使わない（確定値があるのに申告値を信用する
  // 理由がなく、suffix 一致で通すと別ディレクトリの同名ファイルが stage2 へ渡りうる）。agent が別の
  // 場所へ書いていた場合は stage2 の jq 検証が落ちて log_failed になり、欠落は観測可能なまま。
  const journalSavedPath = journalSaveRes?.saved === true ? journalPayloadPath : null

  if (journalSavedPath) {
    // stage1 は成功済み。stage2 が throw（schema 不一致・proxy 実行失敗等）すると catch へ
    // 抜けて代入が走らないため、呼び出し前に log_failed へ倒しておく。こうしないと stage2 の
    // 失敗が save_failed として報告され、観測した status が実際の失敗段と食い違う。
    journalLogStatus = classifyJournalLogStatus({ saved: true, logged: false })
    const journalPost = await trackedAgent(
      `## Objective\npr-iterate 終端 status の telemetry handoff を ~/.claude/journal/pending/ に書き出す（Stop hook が journal へ flush する）。\n\n`
      + `## Instructions\n`
      + buildJournalLogInstr({ prefix: 'priterate', id: PR, payloadPath: journalSavedPath })
      + `\n## Output format\n{ "logged": boolean, "summary": string }\n`
      + `\n## Tools\n使用可: Bash のみ\n`
      + `\n## Boundary\n~/.claude/journal 以外のファイルを変更しない。git 操作禁止。\n`
      + `\n## Token cap\n100 語以内で完結すること。`,
      { agentType: 'dev-runner-haiku', schema: JOURNAL_RESULT, label: 'journal-log', phase: 'Iterate' },
    )
    journalLogStatus = classifyJournalLogStatus({ saved: true, logged: journalPost?.logged === true })
    if (!journalPost?.logged) {
      log(`⚠️ journal-log の記録に失敗しました（logged=${journalPost?.logged ?? 'null'}）。ワークフローは継続します。`)
    }
  } else {
    journalLogStatus = classifyJournalLogStatus({ saved: false })
    log('⚠️ journal-save 失敗（fail-open）— telemetry 記録漏れの可能性')
  }
} catch (e) {
  log(`⚠️ journal handoff 失敗（fail-open）: ${e?.message ?? e}`)
}

return {
  pr: PR,
  status,
  iterations: Math.min(i, MAX),
  fixes_applied: fixesApplied,
  last_decision: lastReview?.decision ?? null,
  last_summary: lastReview?.summary ?? null,
  ci_wait_seconds: totalCiWaitSeconds,
  ci_poll_attempts: totalCiPollAttempts,
  fix_null_retries: fixNullRetries,
  review_null_retries: reviewNullRetries,
  worktree_dirty: worktreeDirty,
  fix_uncommitted_recovered: fixUncommittedRecovered,
  history,
  subagent_invocations: buildSubagentInvocations(SUBAGENT_COUNTS),
  journal_log_status: journalLogStatus,
  ...(lastCiEpoch != null ? { end_epoch: lastCiEpoch } : {}),
}
