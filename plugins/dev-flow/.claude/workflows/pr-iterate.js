export const meta = {
  name: 'pr-iterate',
  description: 'PR を review ⇄ fix で LGTM になるまで反復（上限 10）。単体起動も dev-flow からのサブ呼びも可',
  phases: [
    { title: 'Iterate' },
  ],
}

// ==== BEGIN inline: _lib/plugin-version.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
const PLUGIN_VERSION = '0.3.0'

function normalizePluginCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{12}$/.test(value) ? value : null
}
// ==== END inline: _lib/plugin-version.mjs ====
// ==== BEGIN inline: _lib/agent-namespace.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
const AGENT_NAMESPACE = 'dev-flow:'

function nsAgentOpts(opts) {
  const bare = opts == null ? undefined : opts.agentType
  if (typeof bare !== 'string' || bare.trim() === '') {
    throw new Error('nsAgentOpts: opts.agentType が必要（受信: ' + JSON.stringify(bare) + '）')
  }
  if (bare.indexOf(':') !== -1) {
    throw new Error(
      'nsAgentOpts: agentType は bare な論理名で渡す（namespace はここで付与する。受信: '
      + JSON.stringify(bare) + '）',
    )
  }
  return { ...opts, agentType: AGENT_NAMESPACE + bare }
}
// ==== END inline: _lib/agent-namespace.mjs ====

// ==== BEGIN inline: _lib/resolve-arg.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
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

const JOURNAL_PENDING_DIR = '~/.claude/journal/pending';

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
  error_phase,
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
  if (error_phase) payload.error_phase = String(error_phase);
  return JSON.stringify(payload);
}

function fnv1a32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (c >>> 8), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function journalEffectId(payload) {
  const s = String(payload ?? '');
  const lo = fnv1a32(s, 0x811c9dc5);
  const hi = fnv1a32(s, 0x811c9dc5 ^ 0x9e3779b9);
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

function buildJournalPendingPath({ prefix, id, effectId }) {
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

const JOURNAL_LOG_STATUSES = ['logged', 'save_failed', 'log_failed'];

function classifyJournalLogStatus({ saved, logged }) {
  if (saved !== true) return 'save_failed';
  if (logged === true) return 'logged';
  return 'log_failed';
}

const JOURNAL_PAYLOAD_BASENAME_RE = /^payload-[A-Za-z0-9._-]+\.json$/;

function buildJournalSaveInstr({ payload, savePath, saveDir, fileName }) {
  if (payload == null) throw new Error('journal-handoff: payload is required');
  if (savePath != null && saveDir != null) {
    throw new Error('journal-handoff: savePath と saveDir は同時に指定できません');
  }

  const bodyBlock = `<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n${payload}\n<<<JOURNAL_HANDOFF_BODY_END>>>\n\n`;
  const verbatimRule = `本文は絶対に shell（echo/printf/heredoc 等）へ渡さず、必ず Write tool の\n`
    + `content 引数として渡すこと。エスケープ・改変・pretty-print も禁止する。\n`;
  const idempotentReadRule = (target) => `${target} が既に存在する場合は、先に **Read tool** で同ファイルを`
    + `読んでから **Write tool** で上書きせよ（Write tool は既存ファイルを未 Read のまま上書きできない）。`
    + `Read が失敗しても Write は必ず試み、Read の成否を saved の判定に混ぜないこと。\n`;

  if (savePath != null) {
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

const JOURNAL_TILDE_PREFIX = '~/.claude/journal/';

function validateJournalSavedPath(path, { requiredDirSuffix } = {}) {
  if (typeof path !== 'string' || path === '') return false;
  const abs = path.startsWith(JOURNAL_TILDE_PREFIX) ? path.slice(1) : path;
  if (!abs.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(abs)) return false;
  if (abs.includes('..')) return false;

  const idx = abs.lastIndexOf('/');
  const dirPart = idx === 0 ? '/' : abs.slice(0, idx);
  const basePart = abs.slice(idx + 1);
  if (!JOURNAL_PAYLOAD_BASENAME_RE.test(basePart)) return false;
  if (requiredDirSuffix && !dirPart.endsWith(requiredDirSuffix)) return false;

  return true;
}

function buildJournalLogInstr({ prefix, id, payloadPath, payload }) {
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

async function runJournalHandoff({ agent: runAgent, log, saveSchema, logSchema, payload, savePath, prefix, id, subject, logLabel, phase }) {
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

const ABORT_ERROR_CATEGORY = 'abort';
const ABORT_ERROR_MSG_MAX = 500;

function buildAbortErrorMsg({ phase, label, error }) {
  const raw = error && typeof error === 'object' && 'message' in error ? error.message : error;
  const msg = String(raw ?? 'unknown error').replace(/\s+/g, ' ').trim() || 'unknown error';
  return `abort@${phase || '?'}/${label || '?'}: ${msg}`.slice(0, ABORT_ERROR_MSG_MAX);
}

function buildAbortHandoffPayload({ skill, args, issue, repo, pr_number, journal_sh, phase, label, error, telemetry }) {
  return buildJournalHandoffPayload({
    skill,
    outcome: 'failure',
    args,
    issue,
    repo,
    pr_number,
    journal_sh,
    error_category: ABORT_ERROR_CATEGORY,
    error_msg: buildAbortErrorMsg({ phase, label, error }),
    error_phase: phase || undefined,
    telemetry,
  });
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

function recordSubagentInvocation(counts, agentType) {
  const key = typeof agentType === 'string' && agentType.trim() !== '' ? agentType : 'unknown';
  counts[key] = (counts[key] || 0) + 1;
  return counts;
}

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
// issue の受入条件。dev-flow が nested 起動時に渡す。単体起動（/pr-iterate <pr>）は
// issue context を持たないため未指定になり、acceptanceCriteriaBlock が空文字を返して
// AC 無しでレビューする（fail-open — AC 取得のために gh 呼び出しを増やさない）。
const ACCEPTANCE_CRITERIA = args?.acceptance_criteria
// plugin の commit（12 桁 hex）。dev-flow が nested 起動時に prerun の値を渡す。単体起動は prerun を
// 経ないので未指定 → null（取得のために exec-proxy を増やさない）。telemetry 記録専用で gate の入力にしない
const PLUGIN_COMMIT = normalizePluginCommit(args?.plugin_commit)
const MAX = args?.max_iterations == null
  ? 10
  : Number(resolvePositiveIntArg(args.max_iterations, 'max_iterations'))
// NESTED: dev-flow が workflow('pr-iterate') を nested 起動する際に渡す呼び出し元情報。
// cwd/head_ref は必須（欠落は明示 throw。legacy fallback や他形式の受理はしない）、repo/epoch/
// head_sha は optional。単体起動（/pr-iterate <pr>）は未指定のため NESTED=null。
const NESTED = args?.nested == null
  ? null
  : (() => {
      const n = args.nested
      if (typeof n !== 'object' || n === null
        || typeof n.cwd !== 'string' || n.cwd.trim() === ''
        || typeof n.head_ref !== 'string' || n.head_ref.trim() === '') {
        throw new Error(`pr-iterate: args.nested が不正形です（cwd/head_ref は非空文字列が必須）: ${JSON.stringify(n)}`)
      }
      // head_sha（optional）: dev-flow の PR phase が push 直後に取った PR head の commit sha。
      // nested 起動では pr-meta probe を起動しないため、review#1 時点の sha_prev はここから受ける。
      if (n.head_sha !== undefined && typeof n.head_sha !== 'string') {
        throw new Error(`pr-iterate: args.nested.head_sha は string（受信: ${JSON.stringify(n.head_sha)}）`)
      }
      return n
    })()
const REVIEW_STUCK = 2   // 同一 topic がこの回数出たら stuck と判定し人間へエスカレーション

// run あたりの subagent (agent()) 起動数カウント（返り値 subagent_invocations）。agent() の代わりに全 call site を
// trackedAgent 経由で呼び、SUBAGENT_COUNTS へ計上する。
// StructuredOutput 契約違反（subagent が StructuredOutput を呼ばず完了 — 一過性のモデル逸脱）に
// 限定して同一 prompt で 1 回だけリトライする。それ以外の throw はそのまま
// 伝播させる（fail-closed 維持）。retry も実 agent() 起動なので SUBAGENT_COUNTS へ再計上する。
// review: リトライは `opts.retryOnContractViolation === true` の opt-in call site
// 限定（既定はリトライしない）。commit・push・journal 追記・PR コメント投稿等の副作用を伴う
// call site を無差別リトライすると、副作用完了後に StructuredOutput 未達で終わった agent を
// 同一 prompt で再実行して二重 push・journal 二重追記・重複コメントを起こし得るため、副作用の
// ない読み取り専用 probe 系 call site（dev-flow.js の resolve-base / worktree-base-check 等）
// のみで有効化する。pr-iterate.js の call site（fix / review / commit-ensure / journal-save /
// journal-log 等）はいずれも副作用を伴うため opt-in しない（dev-flow.js と同型実装のみ共有）。
const SUBAGENT_COUNTS = {};
// ABORT_CTX: top-level abort handoff が catch から参照する「直前に何が起きていたか」の
// 可変 state。pr-iterate は単一 phase（'Iterate'）固定のため phase は書き換えない。label は
// trackedAgent が呼ばれるたびに最新化する（dev-flow.js の ABORT_CTX と同趣旨。型注記と同じく
// try 内 const/let は catch から見えないため、try 外のこの object へ写す）。
const ABORT_CTX = { phase: 'Iterate', label: null }
// 全 call site は `opts.model` を渡さず agent frontmatter の既定 model で spawn する（dev-flow.js と同型）。
// pr-reviewer の null（credit 切れ / terminal API error / user skip）に対する再試行は callReviewAgent の
// schema-retry（別 label）のみ。
async function trackedAgent(prompt, opts) {
  ABORT_CTX.phase = opts?.phase ?? ABORT_CTX.phase; ABORT_CTX.label = opts?.label ?? null;
  recordSubagentInvocation(SUBAGENT_COUNTS, opts?.agentType);
  try {
    return await agent(prompt, nsAgentOpts(opts));
  } catch (e) {
    if (!opts?.retryOnContractViolation) throw e;
    if (!String(e?.message ?? e).includes('without calling StructuredOutput')) throw e;
    log(`⚠️ ${opts?.label ?? 'agent'} が StructuredOutput 契約違反で失敗 — 同一 prompt で 1 回だけリトライ（issue #527）`);
    recordSubagentInvocation(SUBAGENT_COUNTS, opts?.agentType);
    return agent(prompt, nsAgentOpts(opts));
  }
}

// fail-open 規定の exec-proxy 呼び出し用ラッパ。trackedAgent が throw した場合
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

// ---- Review de-churn モデル（Plan ループ収束モデルの Review 版を inline 複製）----
// cold start の pr-reviewer は moving target を生む（毎回 fresh context で全 PR diff を再レビューし、
// Adversarial Opener の「能動的に探せ」指示と相まって、安定コードに新しい主観的 major を捻り出しうる）。
// orchestrator 側で churn だけを殺す（ゲートは堅いまま）:
//   1. 既出 findings を pr-reviewer に渡し「対応済み・新規 critical/major のみ・蒸し返し禁止」を指示
//   2. 同一 topic が REVIEW_STUCK 回出たら stuck と判定（fingerprint を JS 側で突合）→ status:'stuck' で人間へ
//   3. fix の applied:false を検出したら status:'fix_failed' で即座に人間へエスカレーション
//      （無言で MAX 回燃やさない。現状この返り値は捨てられていた）
//   4. critical/major は常にブロック（**relax は入れない** = ゲート後退なし）。
//      Plan ループ収束モデルの PLAN_RELAX_FROM 相当は移植しない — Review は main にマージされる実コードの最後のゲートで
//      merge は手動。「N 回回ったから major 残ったまま approve」は既知の major 出荷になり実害が大きい。
//   5. lgtm / stuck / fix_failed / max_reached は throw せず status で返し、終端理由を log() で可視化。
// loader 制約（ESM import 不可）への対応として、stuck 検出は _lib/stuck-detector.mjs を canonical とし tools/sync-inlines.mjs で inline 生成する（本ファイルに手書き複製は持たない）。

// ==== BEGIN inline: _lib/stuck-detector.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

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

const REVIEW_ROUTE_CI_GATE = 'ci_gate';
const REVIEW_ROUTE_FIX_LOOP = 'fix_loop';
const REVIEW_ROUTE_CONTRACT_MISMATCH = 'contract_mismatch';

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

function isOutsideWorktree(file, worktree) {
  const f = typeof file === 'string' ? file.trim() : '';
  if (f === '') return false;
  if (f.includes('://')) return true;
  if (f === '~' || f.startsWith('~/')) return true;
  if (f.startsWith('/')) {
    const wt = typeof worktree === 'string' ? worktree.trim().replace(/\/+$/, '') : '';
    if (!wt.startsWith('/')) return false;
    return !(f === wt || f.startsWith(wt + '/'));
  }
  let depth = 0;
  for (const seg of f.split('/')) {
    if (seg === '..') depth -= 1;
    else if (seg !== '' && seg !== '.') depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

function excludeOutsideWorktree(outcome, worktree) {
  const blocking = Array.isArray(outcome?.blocking) ? outcome.blocking : [];
  const inside = [];
  const outside = [];
  for (const f of blocking) (isOutsideWorktree(f?.file, worktree) ? outside : inside).push(f);
  if (outside.length === 0) return { outcome, outside };
  return {
    outcome: { ...outcome, blocking: inside, route: inside.length === 0 ? REVIEW_ROUTE_CI_GATE : outcome.route },
    outside,
  };
}
// ==== END inline: _lib/review-normalize.mjs ====
// ==== BEGIN inline: _lib/review-finding-scrub.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

const SUBSHELL_SPAN_RE = /\$\([^)]*\)/g
const URL_RE = /https?:\/\/\S+/g
const CHAINED_LINE_RE = /^.*&&.*$/gm
const COMMAND_PREFIX_RE = /^(git|gh|sh|bash|node|npm|curl|wget|ssh|scp|rsync)\s.*$/gm

const META_VOCAB_RE = /分類器|classifier|excludedCommands|起動形|bare ?形|システムプロンプト|system prompt|(プロンプト|prompt)\s*(に|へ|には)[^。]*(書|記載|含め)|検知[^。]*(回避|されな|されるため)|回避手順|迂回|(guard|hook|ガード)[^。]*(無効|外|迂回)|(agent|subagent|エージェント)\s*(への|に対する)指示/i

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

function buildFixIssuesText(blocking) {
  return blocking
    .map((x) => `- [${x.severity}] ${x.file ?? ''}${x.line ? ':' + x.line : ''} ${scrubReviewFindingText(x.description)}${x.suggestion ? ' → ' + scrubReviewFindingText(x.suggestion) : ''}`)
    .join('\n')
}
// ==== END inline: _lib/review-finding-scrub.mjs ====
// ==== BEGIN inline: _lib/review-ac.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

function acceptanceCriteriaBlock(acceptanceCriteria, { scope = 'full' } = {}) {
  if (!Array.isArray(acceptanceCriteria)) return '';
  const items = acceptanceCriteria
    .filter((a) => typeof a === 'string')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (items.length === 0) return '';
  const numbered = items.map((a, idx) => `${idx + 1}. ${a}`).join('\n');
  const instruction = scope === 'delta'
    ? `このラウンドは fix delta（前回 review 以降の差分）のみを読む。AC は delta 外まで含めた`
      + `新規の未達探しには使わず、既出 findings の中に AC 未達があれば今回の delta で解消されたか`
      + `だけを確認せよ。delta 外の AC 未達を新規 finding として報告するな`
      + `（severity は他の finding と同じ基準で付ける。AC 未達であることだけを理由に critical へ引き上げない）。\n`
    : `diff がこれらを満たしているかも判定に含めよ。未達があれば issue として報告せよ`
      + `（severity は他の finding と同じ基準で付ける。AC 未達であることだけを理由に critical へ引き上げない）。\n`;
  return `issue の受入条件（acceptance criteria）:\n${numbered}\n` + instruction;
}
// ==== END inline: _lib/review-ac.mjs ====
// ==== BEGIN inline: _lib/review-delta.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function isDeltaSha(s) {
  return typeof s === 'string' && SHA_RE.test(s.trim());
}

function resolveReviewScope({ iteration, shaPrev, shaNow }) {
  if (!(Number(iteration) >= 2)) return { scope: 'full', range: null, reason: null };
  if (!isDeltaSha(shaPrev)) return { scope: 'full', range: null, reason: 'sha_prev_unavailable' };
  if (!isDeltaSha(shaNow)) return { scope: 'full', range: null, reason: 'sha_now_unavailable' };
  const prev = shaPrev.trim();
  const now = shaNow.trim();
  if (prev.toLowerCase() === now.toLowerCase()) return { scope: 'full', range: null, reason: 'sha_unchanged' };
  return { scope: 'delta', range: `${prev}..${now}`, reason: null };
}

function reviewDeltaBlock({ shaPrev, shaNow }) {
  const range = `${shaPrev.trim()}..${shaNow.trim()}`;
  return `delta_range: ${range}\n`
    + `\`git diff ${range}\` が fix delta。既出 findings が delta で解消されたかの確認と、`
    + `delta 内の新規 critical/major のみ報告せよ。PR 全 diff の再読は不要。\n`;
}

function parseShortstatLines(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '') return 0;
  const ins = /(\d+) insertions?\(\+\)/.exec(t);
  const del = /(\d+) deletions?\(-\)/.exec(t);
  if (!ins && !del) return /\d+ files? changed/.test(t) ? 0 : null;
  return (ins ? Number.parseInt(ins[1], 10) : 0) + (del ? Number.parseInt(del[1], 10) : 0);
}
// ==== END inline: _lib/review-delta.mjs ====

// ==== BEGIN inline: _lib/md-cell.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

function mdCell(v) {
  if (v == null) return '';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
// ==== END inline: _lib/md-cell.mjs ====

// ==== BEGIN inline: _lib/pr-comment-format.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

const DECISION_LABEL = {
  'approve': '承認 (LGTM)',
  'request-changes': '変更要求',
  'comment': 'コメント',
};

const SEV_LABEL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };

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
  'ci_error': '⚠️ CI エラー — CI ステータスを確定できなかった（proxy が結果を返さなかった）。`gh pr checks <PR>` で実状態を確認すること。人間へエスカレーション',
  'ci_pending': '⏳ CI 未完了 — checks pending。人間/CI 完了待ちへエスカレーション',
  'review_contract_error': '⚠️ REVIEW CONTRACT ERROR — reviewer の decision/blocking 矛盾の再発、または reviewer が StructuredOutput 契約違反で結果を返さず。人間へエスカレーション',
};

const CI_LAST_STATUS_LABEL = {
  'passed': '✅ passed',
  'failed': '🔴 failed',
  'pending': '⏳ pending（未完了）',
  'no_checks': 'no_checks（CI 未設定）',
  'error': '⚠️ error（ステータス取得失敗 — `gh pr checks <PR>` で実状態を確認すること）',
};

function formatCiLastStatusLine(ciLastStatus, ciLastFailedChecks, pr) {
  if (ciLastStatus == null) return '**最終 CI 状態**: 未観測（この run では CI を判定していない — `gh pr checks <PR>` で確認すること）'.replace('<PR>', String(pr));
  const label = (CI_LAST_STATUS_LABEL[ciLastStatus] ?? ciLastStatus).replace('<PR>', String(pr));
  if (ciLastStatus === 'failed') {
    const names = (ciLastFailedChecks || []).map((n) => `\`${mdCell(n)}\``);
    return `**最終 CI 状態**: ${label} — ${names.length ? names.join(', ') : '（check 名不明）'}`;
  }
  return `**最終 CI 状態**: ${label}`;
}

function buildTerminalSummaryBody({ pr, status, iterations, lastDecision, lastSummary, lastVerificationEvidence, history, ciWaitSeconds, ciPollAttempts, ciLastStatus = null, ciLastFailedChecks = [], humanFollowups = [] }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const lines = [];

  lines.push(`## PR #${pr} — pr-iterate 終了レポート`);
  lines.push('');
  lines.push(`### ${(STATUS_HEADLINE[status] ?? status).replace('<PR>', String(pr))}`);
  lines.push('');

  lines.push('| 終了状態 | 反復回数 | 最終判定 |');
  lines.push('|---|---|---|');
  const decEmoji = DECISION_EMOJI[lastDecision] ?? '';
  const decLabel = DECISION_LABEL[lastDecision] ?? lastDecision ?? '—';
  lines.push(`| ${status} | ${iterations} | ${decEmoji} ${decLabel} |`);

  lines.push('');
  lines.push(`**最終判定理由**: ${lastSummary}`);

  lines.push('');
  lines.push(formatCiLastStatusLine(ciLastStatus, ciLastFailedChecks, pr));

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

  const followups = (humanFollowups || []).filter((f) => f != null);
  if (followups.length > 0) {
    lines.push('');
    lines.push(`### 👤 人間側 follow-up（worktree の外を指す指摘 — 自動修正の対象外・${followups.length} 件）`);
    lines.push('');
    lines.push(...formatFindingsList(followups, { withIter: followups.every((f) => f.iter != null) }));
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
// ==== END inline: _lib/pr-comment-format.mjs ====

// ==== BEGIN inline: _lib/workflow-post-helpers.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

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

function bodySaveInstr(body, { bodyFile, saveDir, fileName }, delimName) {
  const resolve = bodyFile
    ? `保存先は固定パス \`${bodyFile}\` とし、以降 <BODY_FILE> はこのパスを指す。\n`
    : `まず Bash で \`printf '%s\\n' "${saveDir}/${fileName}"\` を 1 回だけ実行し、出力された絶対パスを <BODY_FILE> とする。\n`
  return `## 本文の保存\n`
    + resolve
    + `<BODY_FILE> は Bash で事前に作らない（空ファイルの作成も禁止）。**Write tool** で新規作成する。\n`
    + `<BODY_FILE> が既に存在する場合（前回の残り）のみ、先に **Read tool** で読んでから Write tool で上書きせよ。\n`
    + `**Write tool** を使い、下記 delimiter 内の本文を\n`
    + `**一字一句そのまま** <BODY_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。backtick やコードフェンスを\n`
    + `エスケープ・改変しないこと。以降のコマンドの \`--body-file\` には <BODY_FILE> を指定する。\n`
    + `<<<${delimName}_BODY_BEGIN>>>\n${body}\n<<<${delimName}_BODY_END>>>\n\n`
}

function ghBareStepInstr(cmd) {
  return `\`${cmd}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ`
    + `（cd 前置・bash 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止）。\n`
}
// ==== END inline: _lib/workflow-post-helpers.mjs ====
// ==== BEGIN inline: _lib/ci-check.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

const CI_POLL_SECONDS = 45;
const CI_WAIT_CEILING_SECONDS = 300;
const CI_MAX_POLLS = Math.floor(CI_WAIT_CEILING_SECONDS / CI_POLL_SECONDS) + 1;
const CI_TURN_MARGIN = 3;

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
    waited_seconds: { type: 'number' },
    poll_attempts: { type: 'number' },
    epoch: { type: 'number' },
  },
};

function ciCheckPrompt({ pr, repo }) {
  return `## Objective\nPR #${pr} の CI ステータスを取得し、JSON をそのまま返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n`
    + `- 実行するスクリプト以外のファイルを変更しない\n\n`
    + `## Steps\n`
    + `1. \`gh pr checks ${pr}${repo ? ' --repo ' + repo : ''} --json name,state,bucket\` を gh を先頭トークンとする bare 単文で実行せよ`
    + `（リダイレクト・パイプ・複合コマンドは使わない）。`
    + `このコマンドの exit code を判定に使ってはならない（pending で 8、失敗ありで 1 を返す仕様であり、fetch 自体の成否とは無関係）。\n`
    + `2. \`check-ci --checks-data '<手順1の stdout を一字一句そのまま。要約・整形・省略禁止>' `
    + `--fetch-error-data '<手順1の stderr を一字一句そのまま。stderr が空なら本オプション自体を省略>'\` `
    + `を単文で実行し、stdout の JSON を読め。\n`
    + `3. その stdout JSON（{status, failed_checks, waited_seconds, poll_attempts, ...}）をそのまま返せ。要約・加工するな。`
    + `1 回の取得で判定を確定させ、待機や再取得は行うな。\n\n`
    + `## Output format\n`
    + `{ "status": "passed"|"failed"|"pending"|"no_checks"|"error", "failed_checks": [{name, bucket, state}, ...], `
    + `"waited_seconds": number, "poll_attempts": number }\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}

const CI_WAIT = {
  type: 'object',
  required: ['slept'],
  properties: {
    slept: { type: 'boolean' },
    seconds: { type: 'number' },
  },
};

function ciWaitPrompt({ seconds }) {
  return `## Objective\nCI 完了待ちのため ${seconds} 秒待機し、結果 JSON を返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push, gh\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。ファイル・git を変更しない\n\n`
    + `## Steps\n`
    + `1. \`ci-wait ${seconds}\` を ci-wait を先頭トークンとする bare 単文で実行せよ（リダイレクト・パイプ・複合コマンドは使わない）。\n`
    + `2. stdout の JSON（{"slept": boolean, "seconds": number}）をそのまま返せ。要約・加工するな。\n\n`
    + `## Output format\n`
    + `{ "slept": boolean, "seconds": number }\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}
// ==== END inline: _lib/ci-check.mjs ====

// journal-save（stage1）の返り値 schema。JOURNAL_RESULT（journal-log/stage2）と対で使う。
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
          // 同一問題の再出現を orchestrator が stuck 突合するための安定 ID。
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
    // 検証根拠の箇条書き（1 項目 1 文）。summary は結論 1-2 文に留める
    verification_evidence: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 120 } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
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


// 終端 dirty 検出と fix 適用後 commit 保証の exec-proxy スキーマ。
const DIRTY_STATUS = { type: 'object', required: ['dirty'], properties: { dirty: { type: 'boolean' }, files: { type: 'number' } } }
// head_sha / delta_shortstat は次 round の review を fix delta に絞るための材料（optional。欠落は
// resolveReviewScope が full review にフォールバックする — 新規 agent spawn を増やさず既存 probe の出力を拡張する）。
const COMMIT_ENSURE = {
  type: 'object', required: ['dirty'],
  properties: {
    dirty: { type: 'boolean' }, committed: { type: 'boolean' }, pushed: { type: 'boolean' },
    head_sha: { type: 'string' }, delta_shortstat: { type: 'string' },
  },
}

phase('Iterate')

// repo (owner/name) probe: PR の base repo URL から owner/name を導出する（telemetry の repo 解決用）。
// fail-open — probe 失敗/null でも repo を省略するだけで workflow は継続する。
// head_ref/base_ref/cwd は isolation probe の失敗メッセージ・probe 対象パス解決にも使う。
// head_sha は review#1 時点の PR head commit sha（review#2 の fix delta の起点）。取得失敗は
// 空文字 → resolveReviewScope が full review にフォールバックする（fail-open）。
const PR_META = {
  type: 'object', required: ['url'],
  properties: { url: { type: 'string' }, head_ref: { type: 'string' }, base_ref: { type: 'string' }, cwd: { type: 'string' }, head_sha: { type: 'string' }, epoch: { type: 'number' } },
}
// nested 起動（dev-flow → workflow('pr-iterate')）では pr-meta probe を起動しない。
// 根拠: cwd/head_ref/repo/epoch は dev-flow が Setup/PR phase で既に確定済みの値として
// args.nested に保持しており、pr-iterate 側での再取得は冗長な exec-proxy 呼び出しになる。
let prMeta
let REPO
if (NESTED) {
  prMeta = {
    url: '', head_ref: NESTED.head_ref, base_ref: '', cwd: NESTED.cwd,
    ...(typeof NESTED.head_sha === 'string' ? { head_sha: NESTED.head_sha } : {}),
    ...(Number.isFinite(NESTED.epoch) ? { epoch: NESTED.epoch } : {}),
  }
  REPO = NESTED.repo ?? null
  log('nested 起動 — pr-meta / isolation-cleanup を skip（dev-flow Setup 側の .devflow-tmp cleanup が run 間衛生を担保）')
} else {
  prMeta = await failOpenAgent(
    `## Objective\nPR #${PR} の URL・head/base branch 名・head commit sha・現在の作業ディレクトリ絶対パスを取得する（telemetry の repo 解決 / isolation probe / review#2 以降の fix delta 起点用）。\n\n## Instructions\n次のコマンドをそのまま実行し、出力を対応するキーへ格納せよ（各コマンド失敗時は throw せず該当キーを空文字で返すこと。epoch のみコマンド失敗時は省略可）:\n- \`gh pr view ${PR} --json url -q .url\` → url\n- \`gh pr view ${PR} --json headRefName -q .headRefName\` → head_ref\n- \`gh pr view ${PR} --json baseRefName -q .baseRefName\` → base_ref\n- \`gh pr view ${PR} --json headRefOid -q .headRefOid\` → head_sha（40 桁 hex をそのまま）\n- \`pwd\` → cwd（現在の作業ディレクトリの絶対パス）\n- \`date +%s\` → epoch(現在時刻の epoch 秒整数。isolation probe 対象パスの run 毎一意化用)\n\n## Output format\n{ "url": string, "head_ref": string, "base_ref": string, "head_sha": string, "cwd": string, "epoch": number }\n\n## Tools\n使用可: Bash のみ\n\n## Boundary\nファイル変更・git 操作禁止。\n\n## Token cap\n100 語以内で完結すること。`,
    { agentType: 'dev-runner-haiku-ro', schema: PR_META, label: 'pr-meta', phase: 'Iterate' },
  )
  REPO = repoFromGithubUrl(prMeta?.url)
  if (!REPO) log('⚠️ repo (owner/name) を解決できず — telemetry の repo は省略される')
}
// ==== BEGIN inline: _lib/isolation-probe.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

const ISOLATION_PROBE_CLEANUP_GLOB = '.devflow-tmp/.isolation-probe*';

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
// 手前）に進入する前に probe で早期検知する（dev-flow.js Setup phase と同型パターン）。
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
try {
// isoTargetPath: 回避手順で提示する新規 worktree 先。isoWt（書き込みに失敗した共有 checkout の cwd）
// とは別の孤立した先を提示する必要があるため、cwd 自体を git worktree add の対象にしない
// （レビュー指摘: 共有 checkout の cwd を worktree 作成先として提示するのは誤り）。
const isoTargetPath = `${isoWt.replace(/\/\.claude\/worktrees\/.*$/, '')}/.claude/worktrees/pr-${PR}`
// isolation cleanup: probe の直前に前 run が残した stale な probe artifact を除去する
// （残っていると isolation が正常でも probe が written:false に倒れる）。
// 除去範囲は ISOLATION_PROBE_CLEANUP_GLOB（`.devflow-tmp/.isolation-probe*` — probe artifact の
// token 形・legacy 形のみ）に絞る: nested 起動（dev-flow → workflow('pr-iterate')）
// では isoWt が実行中の dev-flow worktree 自身になり、`.devflow-tmp` 全体を消すと当該 run が既に
// 書いた run 専用 scratch（journal payload 等の .devflow-tmp 配下生成物）を
// run 途中で失う。`.devflow-tmp` 全体の除去は run 開始
// 時点である dev-flow Setup 側の責務。fail-open: 失敗しても run は継続する（残っていれば直後の
// probe が written:false で fail-closed に倒れ、復旧手順は同一）。
// nested 起動時は skip する（skip 理由は上の pr-meta 分岐で log 済み — dev-flow
// Setup が run 開始時に .devflow-tmp 全体を cleanup 済みのため重複起動が不要）。
let isoClean = null
if (!NESTED) {
  isoClean = await failOpenAgent(isolationCleanupPrompt(isoWt, ISOLATION_PROBE_CLEANUP_GLOB), { agentType: 'dev-runner-haiku', schema: ISOLATION_CLEANUP, label: 'isolation-cleanup', phase: 'Iterate' })
  if (!isoClean || isoClean.cleaned !== true) log(`⚠️ isolation cleanup が完了しなかった（fail-open で続行）: ${isoClean?.error ?? 'agent null'}`)
}
// isoToken: probe 対象パスを run 毎に一意にする。pr-meta probe（fail-open）が
// 取得した epoch を使い、取得できなければ PR 番号へ fallback する。nested 起動（dev-flow →
// workflow('pr-iterate')）時、probe ファイルは実行中 dev-flow run の worktree の
// `.devflow-tmp/.isolation-probe-<token>` に書かれるが一意名のため dev-flow 側の .devflow-tmp
// 配下生成物・probe ファイルと衝突しない。
const isoToken = String(prMeta?.epoch ?? PR)
const isoProbe = await failOpenAgent(isolationProbePrompt(isoWt, isoToken), { agentType: 'dev-runner-haiku-wo', schema: ISOLATION_PROBE, label: 'isolation-probe', phase: 'Iterate' })
if (isoProbe && isoProbe.written === false) {
  throw new Error(isolationFailureMessage({
    // startRef は PR の head（base ではない）— pr-iterate は既存 PR の変更を含む worktree を
    // 再現させる必要がある。base 起点だと fix 対象の diff を持たない worktree を提示してしまう。
    worktree: isoWt, branch: prMeta?.head_ref || '?', startRef: `origin/${prMeta?.head_ref || '?'}`,
    workflowName: 'pr-iterate', workflowArgs: PR, targetPath: isoTargetPath, error: isoProbe.error,
  }))
}
if (!isoProbe) log('⚠️ isolation probe 自体が失敗 — 書き込み可否を診断できず（fail-open で続行）')

let lastReview = null
let lgtm = false
let i = 0
let terminal = null              // 早期終端理由（stuck / fix_failed）。null なら lgtm / max_reached で判定
let terminalPath = 'review'  // 最終 iteration の終端経路 'ci' | 'review'。各 iteration 冒頭で review に戻し、CI-failed 分岐で ci に上書きする
let fixTerminalReason = null  // fix_failed の 3 分岐 'null_after_retry' | 'applied_false' | 'commit_unensured'。fix_failed 以外は null
let fixesApplied = 0  // fix.applied===true の累積回数（dev-flow が stale-eval 警告の判定に使う）
let fixNullRetries = 0  // fix agent が null または throw（schema 不一致・StructuredOutput 契約違反等の技術的失敗）で 1 回 retry した累積回数
let reviewNullRetries = 0  // review agent が throw または null で schema-retry した累積回数
let fixUncommittedRecovered = 0  // fix が applied:true なのに未コミット変更が残っており ensure-committed が commit+push で回収した回数
let totalCiWaitSeconds = 0  // script 側 ci-wait ループの累積待機秒数（全 ci-check ラウンド合算）
let totalCiPollAttempts = 0  // 同上の累積ポーリング（ci-check spawn）回数
// 直近の ci-check#i 応答が返した epoch。dev-flow の iterate_end 給電元として返り値
// end_epoch に載せる。応答が epoch を欠く/非数値なら更新せず、直前の値（または null）を保持する（fail-open）。
let lastCiEpoch = null
// 最後に観測した CI 状態。CI gate（blocking 0 件 round）と blocking round の 1 回判定の両方で
// 上書きし、全終端の返り値 ci_last_status / ci_last_failed_checks と終端サマリの「最終 CI 状態」行に載せる。
// null は「この run で一度も CI を判定していない」（review_contract_error 等の早期終端）。
let ciLastStatus = null        // 'passed' | 'failed' | 'pending' | 'no_checks' | 'error' | null
let ciLastFailedChecks = []    // ciLastStatus==='failed' のときの check 名配列
function observeCi(ciEff) {
  ciLastStatus = ciEff.status
  ciLastFailedChecks = ciEff.status === 'failed'
    ? (ciEff.failed_checks ?? []).map((c) => String(c?.name ?? 'unknown'))
    : []
}
// ci-check の failed_checks を fix loop へ流す synthetic blocking finding に変換する（CI gate と blocking round で共用）。
// topic `ci::<name>` は reviewSeen の stuck 検出キー — 同一 check が REVIEW_STUCK 回失敗し続ければ stuck 終端になる。
// failed_checks items are {name, bucket, state} per check-ci.sh output (no conclusion field).
function ciFailedFindings(ciEff) {
  return (ciEff.failed_checks && ciEff.failed_checks.length > 0)
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
}
// CI finding を fix prompt の箇条書きにする。topic（ci::<name>）を明示して、review 指摘と合流させたときに
// fix agent が「どの check が赤か」を取り違えないようにする。
function buildCiIssuesText(ciFindings) {
  return ciFindings
    .map((x) => `- [${x.severity}] ${x.topic}: ${x.description}${x.suggestion ? ' → ' + x.suggestion : ''}`)
    .join('\n')
}
// CI failure を含む fix prompt に必ず添える手順。
// (a) 失敗ログを見ずに推測で直すと、check 名だけでは原因（例: rules ファイルの byte 上限超過）に届かない。
// (b) CI は PR head ではなく base とのマージ結果（merge ref）を検証する — base に先に入った変更と合わさって
//     初めて赤になるケースは PR ブランチ単体の再現で見えない（base 側の先行変更が原因のとき）。
function ciFixGuidance({ pr, base }) {
  const baseRef = base ? `origin/${base}` : 'origin/<base branch>'
  return `CI 失敗の修正手順（必須）:\n`
    + `(a) 修正の前に bare 単文 \`gh pr checks ${pr}\` で失敗している check と link（run URL の \`/runs/<run-id>/\` が run-id）を確認し、`
    + `\`gh run view <run-id> --log-failed\` で失敗ログを取得して原因を特定してから修正すること（check 名だけから推測で直さない）。\n`
    + `(b) CI は PR ブランチ単体ではなく base branch とのマージ結果を検証している。PR ブランチ単体で失敗が再現しない場合は、`
    + `\`git fetch origin\` の後 \`git merge ${baseRef}\` で base をマージした状態を作って再現を確認し、その状態で修正すること`
    + `${base ? '' : '（base branch 名は `gh pr view ' + pr + ' --json baseRefName` で確認）'}。\n`
}
// fix agent の prompt（review 指摘・CI 失敗の両経路）。必須 5 要素（Objective / Output format / Tools / Boundary /
// Token cap）を揃える。Boundary は incentive-structural — fix agent は直せない指摘を前に worktree の外や
// GitHub 上の状態を書き換える経路を自分で組み立てるため、禁止を prompt 側で明示する。
function fixPrompt({ objective, issuesHeading, issuesText, guidance = '' }) {
  return `## Objective\n${objective}\n\n`
    + `## Steps\n(1) \`gh pr checkout ${PR}\` で PR ブランチを checkout、(2) 下記の${issuesHeading}を修正、`
    + `(3) Conventional Commits 形式で commit、(4) \`git push\` で push。\n\n`
    + `解消すべき${issuesHeading}:\n${issuesText}\n`
    + (guidance ? `\n${guidance}` : '')
    + `\n## Output format\n{ "applied": boolean, "files": string[], "summary": string }。applied は修正を commit・push まで終えたときだけ true。files は変更したファイルの repo 相対パス。JSON のみ返せ。\n`
    + `\n## Tools\n使用可: Read, Edit, Write, Grep, Glob, Bash（git、\`gh pr checkout\` / \`gh pr checks\` / \`gh pr view\` / \`gh run view\`、テスト実行）。subagent の起動は禁止。\n`
    + `\n## Boundary\n`
    + `- 書き込みは worktree（${isoWt}）の中だけ。worktree の外のファイル・他 repo（別の clone や worktree を含む）を変更しない\n`
    + `- ブランチを作らない（\`git branch\` / \`git checkout -b\` / \`git switch -c\` / \`git worktree add\` を使わない）。commit・push は PR ブランチにだけ行う\n`
    + `- \`gh api\` で GitHub 上の状態を変更しない（ref・ブランチ・PR・issue・comment の作成・更新・削除を含む）\n`
    + `- 直すのに worktree の外の変更が要る指摘は直さず、その旨を summary に書く\n`
    + `\n## Token cap\nsummary は 300 字以内。指摘に関係するファイルだけを読み、無関係な探索・リファクタをしない。\n`
}
const reviewSeen = makeSeenTracker(REVIEW_STUCK)  // findings 累積 & stuck 検出（_lib/stuck-detector.mjs）
const history = []               // ラウンド履歴 [{iteration, decision, summary, blocking, minor, scope, delta_lines}]
// worktree の外を指す blocking finding（_lib/review-normalize.mjs の excludeOutsideWorktree）。fix には渡さず、
// reviewSeen にも register しない（直さない指摘で stuck を誤発火させない）。終端サマリーの人間側 follow-up と
// 返り値 human_followups に載せる。同じ topic + file は最初の 1 件だけ残す。
const humanFollowups = []
function routeInsideWorktree(outcome, iteration) {
  const { outcome: inside, outside } = excludeOutsideWorktree(outcome, isoWt)
  if (!outside.length) return outcome
  for (const f of outside) {
    if (!humanFollowups.some((h) => h.topic === f.topic && h.file === f.file)) humanFollowups.push({ iter: iteration, ...f })
  }
  log(`iteration ${iteration}: worktree の外を指す blocking ${outside.length} 件（${outside.map((f) => f.file).join(' / ')}）を fix から外し人間側 follow-up へ回す`
    + `${inside.blocking.length === 0 ? ' — 残りの blocking 0 件のため CI 判定へ進む' : ''}`)
  return inside
}
// review#i（i ≥ 2）を fix delta に絞るための sha 追跡（canonical は _lib/review-delta.mjs）。
// shaNow: 現在の PR head（review#1 は pr-meta / nested args の head_sha、以降は ensure-committed の head_sha）。
// shaPrev: 直前 round の review 時点の head。delta = shaPrev..shaNow。どちらかが欠ければ full にフォールバック。
// pendingDeltaLines: ensure-committed が shortstat から出した delta の変更行数（次 round の history 用）。
let shaNow = isDeltaSha(prMeta?.head_sha) ? prMeta.head_sha.trim() : null
let shaPrev = null
let pendingDeltaLines = null
if (shaNow == null) log('⚠️ review#1 時点の head sha を取得できず — review#2 は full review にフォールバックする（fail-open）')

// fix agent が throw（StructuredOutput 契約違反等の harness 例外）または null（schema 不一致/技術的
// 失敗）の場合のみ、同一 findings で 1 回だけ再試行する（callReviewAgent と同一契約）。
// applied:false（agent の明示判断による修正不能）は retry しない — stuck 検出等の incentive-structural
// 機構は不変。retry は iteration ごと最大 1 回で有限（review#N-contract-retry :604-614 と同パターン、
// MAX 非消費）
// model は dev-runner frontmatter の sonnet を上書きして opus で起動する。opus reviewer の指摘は設計判断を
// 伴う修正が中心で、sonnet は maxTurns 50 内に終わらず null（fix_failed）になりやすい。frontmatter は
// analyze-clarify と共用なので変えず、この call site だけで渡す。
const FIX_MODEL = 'opus'
// effort も frontmatter の high を call site で medium に下げる。opts.effort は frontmatter より優先され、
// paired replay で medium は high と完走率・品質同等のまま所要・コストが下がった（frontmatter は共用なので変えない）。
const FIX_EFFORT = 'medium'
async function callFixAgent(prompt, i) {
  let fix = null
  try {
    fix = await trackedAgent(prompt, { agentType: 'dev-runner', schema: FIX, label: `fix#${i}`, phase: 'Iterate', model: FIX_MODEL, effort: FIX_EFFORT })
  } catch (e) {
    log(`⚠️ fix#${i} が例外を投げた（StructuredOutput 契約違反等）: ${e?.message ?? e}`)
  }
  let retried = false
  if (fix == null) {
    retried = true
    fixNullRetries++
    log(`⚠️ fix#${i} が null（schema 不一致/技術的失敗）— 同一 findings で 1 回だけ再試行する（fix-null-retry）`)
    try {
      fix = await trackedAgent(prompt, { agentType: 'dev-runner', schema: FIX, label: `fix#${i}-retry`, phase: 'Iterate', model: FIX_MODEL, effort: FIX_EFFORT })
    } catch (e) {
      log(`⚠️ fix#${i}-retry も例外: ${e?.message ?? e}`)
    }
  }
  return { fix, retried }
}

// review agent の throw（StructuredOutput 契約違反等の harness 例外）と null（schema 不一致）を
// 同一の契約失敗として扱い、呼び出しごと最大 1 回だけ同一 prompt で再試行する。
// retry 後も失敗なら null を返し、呼び出し側が status:'review_contract_error' で graceful に終了する。
async function callReviewAgent(prompt, label) {
  let review = null
  try {
    review = await trackedAgent(prompt, { agentType: 'pr-reviewer', schema: REVIEW, label, phase: 'Iterate' })
  } catch (e) {
    log(`⚠️ ${label} が例外を投げた（StructuredOutput 契約違反等）: ${e?.message ?? e}`)
  }
  if (review == null) {
    reviewNullRetries++
    log(`⚠️ ${label} が結果を返さず — 同一 prompt で 1 回だけ再試行する（schema-retry）`)
    try {
      review = await trackedAgent(prompt, { agentType: 'pr-reviewer', schema: REVIEW, label: `${label}-schema-retry`, phase: 'Iterate' })
    } catch (e) {
      log(`⚠️ ${label}-schema-retry も例外: ${e?.message ?? e}`)
    }
  }
  return review
}

// `git status --porcelain` の dirty 判定基準（commit-ensure と終端の worktree-dirty-check で共有）。
// 「出力が空か」では判定しない: agent の Bash 出力は stdout と stderr が混ざり、読めないファイル
// （.env.example 等）について git が出す `<path>: Operation not permitted` 警告だけで clean な worktree を
// dirty と読み、commit-ensure が fix_failed で終端する。exit 非0 は判定不能として dirty 側に
// 倒す（clean 側に倒すと未コミット変更を見逃して次 iteration へ進み、fail-safe が崩れる）。
const PORCELAIN_DIRTY_RULE = '【dirty 判定基準】出力のうち porcelain 行（先頭 2 文字が状態コード（空白・M・T・A・D・R・C・U・?・! のいずれか）で、3 文字目が空白の行。例: ` M a.ts` / `?? b.ts`）だけを数える。'
  + '`<path>: Operation not permitted` のような警告行や `warning:` で始まる行など、porcelain 形式でない行は数えない（警告行だけが出ていて porcelain 行が 0 行なら変更なし＝clean）。'
  + 'porcelain 行が 1 行以上あれば変更あり＝dirty。コマンドが exit 非0 で失敗した場合は判定不能として変更あり＝dirty とみなす。'

// fix 適用直後の commit 保証。fix agent の self-report（applied:true）を信用せず
// 決定論スクリプトで worktree の未コミット変更を検証し、dirty なら commit+push で回収する。
// 失敗ポリシー: fail-safe — null/schema 不一致/回収失敗（dirty なのに committed&&pushed でない）は
// false を返し、呼び出し側が terminal='fix_failed' で人間へエスカレーションする
// （未コミットのまま次 iteration へ進むと再 review が stale な PR diff を見るため、状態不明を green と同一視しない）。
// 併せて次 round の review を fix delta に絞る材料（head_sha / delta_shortstat）を同じ spawn で取る
// （新規 agent spawn を増やさない）。shaPrev（この round の review 時点の head sha）が確定している
// ときだけ shortstat 手順を含める。返り値 { ensured, headSha, deltaLines } の headSha / deltaLines は
// 取得失敗で null（次 round は resolveReviewScope が full にフォールバックする）。
// .git へ書き込む add / commit と network を伴う push は `git -C ${isoWt}` を付けない bare 形にする
// : `git -C` 形は sandbox の excludedCommands に当たらず sandbox 内で走り、push は
// credential helper が、add / commit は `.git` が write deny 下の repo で index.lock 作成が失敗する。
// subagent の cwd は isoWt（agent 自身の pwd / nested は NESTED.cwd）なので -C を外しても対象は
// 変わらない。読み取りのみの status / rev-list / rev-parse / diff は -C のまま。
// status の dirty 判定は PORCELAIN_DIRTY_RULE に従う。
async function ensureFixCommitted(i, shaPrev) {
  const withDelta = isDeltaSha(shaPrev)
  let ensured = null
  try {
    ensured = await trackedAgent(
      `## Objective\nfix#${i} 適用後の作業ツリーに未コミット変更が残っていないことを保証し（残っていれば commit + push で回収する）、commit 後の head sha${withDelta ? ' と fix delta の行数' : ''}を返す。\n\n## Steps\n以下を順に bare 単文（先頭トークンが git。cd 前置・bash 前置・env 代入前置・&& 連結禁止）で実行せよ:\n${PORCELAIN_DIRTY_RULE}\n1. \`git -C ${isoWt} status --porcelain\` を実行する。判定基準で clean（porcelain 行が 0 行）なら dirty:false, committed:false, pushed:false として手順 5 へ進む。\n2. 判定基準で dirty（porcelain 行が 1 行以上、または exit 非0）なら dirty:true とし、順に実行: \`git add -A\` → \`git commit -m "fix(pr-${PR}): commit leftover review fixes (iteration ${i})"\` → \`git push\`（push が失敗した場合のみ \`git push -u origin HEAD\` を実行）。\n3. \`git -C ${isoWt} status --porcelain\` を再実行し、手順 1 と同じ判定基準で判定する。clean（porcelain 行が 0 行）なら committed:true、dirty なら committed:false。\n4. \`git -C ${isoWt} rev-list "@{u}"..HEAD --count\` を実行する。警告行を除いた出力が 0 なら pushed:true。コマンド失敗または非数値出力なら pushed:false。dirty:true とする。\n5. \`git -C ${isoWt} rev-parse HEAD\` を実行し、stdout の 40 桁 hex をそのまま head_sha とする（失敗時は空文字）。\n${withDelta ? `6. \`git -C ${isoWt} diff --shortstat ${shaPrev.trim()}..HEAD\` を実行し、stdout の 1 行を一字一句そのまま delta_shortstat とする（stdout が空なら空文字。失敗時はキーを省略）。\n7. { "dirty": <1の結果>, "committed": <3の結果>, "pushed": <4の結果>, "head_sha": <5の結果>, "delta_shortstat": <6の結果> } を返す。` : `6. { "dirty": <1の結果>, "committed": <3の結果>, "pushed": <4の結果>, "head_sha": <5の結果> } を返す。`}\n\n## Output format\n{ "dirty": boolean, "committed": boolean, "pushed": boolean, "head_sha": string${withDelta ? ', "delta_shortstat": string' : ''} }\nprose 禁止。JSON のみ返せ。\n\n## Tools\n使用可: Bash, Read\n\n## Boundary\n上記 git コマンド以外のファイル変更・git 操作禁止。\n\n## Token cap\nJSON のみ。1 行以内。`,
      { agentType: 'dev-runner-haiku', schema: COMMIT_ENSURE, label: `commit-ensure#${i}`, phase: 'Iterate' },
    )
  } catch (e) {
    log(`⚠️ commit-ensure#${i} が例外: ${e?.message ?? e}`)
  }
  const headSha = isDeltaSha(ensured?.head_sha) ? ensured.head_sha.trim() : null
  const deltaLines = withDelta ? parseShortstatLines(ensured?.delta_shortstat) : null
  if (ensured == null) return { ensured: false, headSha, deltaLines }
  if (ensured.dirty === false) return { ensured: true, headSha, deltaLines }
  if (ensured.committed === true && ensured.pushed === true) {
    fixUncommittedRecovered++
    log(`⚠️ fix#${i} は applied:true だが未コミット変更が残っていた — ensure-committed が commit+push で回収した`)
    return { ensured: true, headSha, deltaLines }
  }
  return { ensured: false, headSha, deltaLines }
}

for (i = 1; i <= MAX; i++) {
  terminalPath = 'review'
  const prior = reviewSeen.prior()   // 前 iteration までの累積 findings
  // review scope: i ≥ 2 で sha_prev..sha_now が確定していれば delta、確定できなければ full（fail-open。
  // delta を空扱いにして approve へ倒さない）。scope / delta_lines は round の history に載せる。
  const reviewScope = resolveReviewScope({ iteration: i, shaPrev, shaNow })
  const roundScope = reviewScope.scope
  const roundDeltaLines = roundScope === 'delta' ? pendingDeltaLines : null
  if (reviewScope.reason) log(`⚠️ review#${i}: ${reviewScope.reason} — fix delta を確定できず full review にフォールバック（fail-open）`)
  const reviewPrompt = (roundScope === 'delta'
      ? `PR #${PR} の fix delta を批判的にレビューせよ。gh pr view で宣言意図を確認し、読む diff は下記 delta_range に限定する。\n`
        + reviewDeltaBlock({ shaPrev, shaNow })
      : `PR #${PR} を批判的にレビューせよ。gh pr view / gh pr diff で実 diff を確認し、宣言意図に照合する。\n`)
    + `summary は結論 1-2 文に留めよ。検証した根拠（テスト実行・diff 照合・edge case 確認等）は verification_evidence に 1 項目 1 文の配列で列挙せよ。\n`
    + acceptanceCriteriaBlock(ACCEPTANCE_CRITERIA, { scope: roundScope })
    + (prior.length
        ? `既出 findings（前ラウンドまでに指摘済み。author は対応済みのはず）:\n${JSON.stringify(prior)}\n`
          + `**新規の critical/major のみ報告**せよ。前ラウンドで対応済み・却下済みの論点の蒸し返し、`
          + `別観点の上乗せ（moving target）は禁止。既出問題を再提起する場合は既出と同じ topic 文字列を`
          + `必ず再利用せよ（orchestrator が topic で stuck を突合する）。`
        : '')
  const review = await callReviewAgent(reviewPrompt, `review#${i}`)
  // この round の review が見た head を次 round の delta 起点にする（review が失敗しても更新して構わない —
  // 失敗時は直後に break する）。
  shaPrev = shaNow
  if (review == null) {
    terminal = 'review_contract_error'
    log(`⚠️ iteration ${i}: review#${i} が schema-retry 後も結果を返さず（StructuredOutput 契約違反）。人間へエスカレーション`)
    break
  }
  lastReview = review

  let effReview = review
  let outcome = routeInsideWorktree(classifyReviewRoute(review), i)

  // contract mismatch（approve だが blocking あり）: 同一 iteration 内で 1 回だけ再 review する。
  // MAX は消費しない — 有限性は「iteration ごと最大 1 回」で担保する。
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
      history.push({ iteration: i, decision: review.decision, summary: review.summary, blocking: outcome.blocking, minor: outcome.minor, scope: roundScope, delta_lines: roundDeltaLines })
      break
    }
    effReview = rereview
    lastReview = rereview
    outcome = routeInsideWorktree(classifyReviewRoute(rereview), i)

    if (outcome.route === 'contract_mismatch') {
      // 再 review 後も decision と blocking の矛盾が再発 — 無限ループせず人間へエスカレーション。
      // 注意: この mismatch review の blocking は reviewSeen に register しない
      // （fix を挟まない再 review が REVIEW_STUCK を 1 iteration 内で誤発火させるため）。
      terminal = 'review_contract_error'
      log(`⚠️ iteration ${i}: review contract mismatch が再 review 後も再発（decision=approve、blocking ${outcome.blocking.length} 件）。人間へエスカレーション`)

      history.push({ iteration: i, decision: effReview.decision, summary: effReview.summary, blocking: outcome.blocking, minor: outcome.minor, scope: roundScope, delta_lines: roundDeltaLines })

      break
    }
  }

  if (outcome.route === 'ci_gate') {
    // CI gate — restores the gate lost in eb8aa7e。blocking 0 件の comment/request-changes も
    // ここへ合流する。lgtm 確定時の投稿のみ decision で分岐する（approve でなければ捏造しない）。
    // pr-reviewer may LGTM the code but CI must also be green before we declare lgtm.
    // no_checks is treated as passing (consistent with e4e2b92: repos without CI are fine).
    //
    // ci-check は 1 spawn = 1 判定。pending なら script 側で ci-wait（ci-wait exec-proxy）を
    // 挟んで再 spawn する。待機は nominal 積算（ci-wait 回数 × CI_POLL_SECONDS）で、次の wait を足すと
    // CI_WAIT_CEILING_SECONDS を超える時点で打ち切り、最後の判定（pending）で ci_pending 終端へ流す
    // （spawn 回数の上限 CI_MAX_POLLS は ceiling から導出した同値の guard。ループ条件を変えても
    // exec-proxy.md の「spawn 回数は CI_MAX_POLLS で有界」が黙って崩れないよう明示する）。
    // ci-wait の返り値は slept===true のときだけ加算する: null / throw / slept:false は実待機が
    // 成立していない証拠であり、nominal に加算すると実待機ゼロのまま poll を消費し尽くして誤った
    // ci_wait_seconds を報告する。待機失敗を検出した時点で即座に ci_pending 終端へ流す
    // （直前 ci-check の pending 判定を維持したままループを抜ける）。
    // waited_seconds / poll_attempts の値は check-ci accounting と同じ意味（(N-1)×M / N）だが積算主体は script。
    let ci = null
    let ciEff = null
    let gateWaited = 0   // この gate の nominal 累積待機秒
    let gatePolls = 0    // この gate の ci-check spawn 回数
    for (;;) {
      gatePolls += 1
      const ciLabel = gatePolls === 1 ? `ci-check#${i}` : `ci-check#${i}.${gatePolls}`
      ci = await failOpenAgent(
        ciCheckPrompt({ pr: PR, repo: REPO }),
        { agentType: 'dev-runner-haiku-ro', schema: CI_STATUS, label: ciLabel, phase: 'Iterate' },
      )
      if (ci == null) log(`⚠️ ${ciLabel} が結果を返さず — fail-open で status=error（ci_error 終端）扱い`)
      ciEff = ci ?? { status: 'error', failed_checks: [] }
      if (Number.isFinite(ci?.epoch)) lastCiEpoch = ci.epoch
      if (ciEff.status !== 'pending') break
      if (gateWaited + CI_POLL_SECONDS > CI_WAIT_CEILING_SECONDS || gatePolls >= CI_MAX_POLLS) {
        log(`iteration ${i}: CI pending のまま待機上限 ${CI_WAIT_CEILING_SECONDS}s / poll 上限 ${CI_MAX_POLLS} 回に到達（累積 ${gateWaited}s / poll ${gatePolls} 回）— ci_pending で終端`)
        break
      }
      const waitResult = await failOpenAgent(
        ciWaitPrompt({ seconds: CI_POLL_SECONDS }),
        { agentType: 'dev-runner-haiku-ro', schema: CI_WAIT, label: `ci-wait#${i}-${gatePolls}`, phase: 'Iterate' },
      )
      if (waitResult?.slept !== true) {
        log(`⚠️ iteration ${i}: ci-wait#${i}-${gatePolls} が実待機を報告しなかった（${waitResult == null ? 'null/throw' : 'slept=false'}）— 実待機ゼロを nominal 加算で隠さず ci_pending で終端（累積 ${gateWaited}s / poll ${gatePolls} 回）`)
        break
      }
      gateWaited += CI_POLL_SECONDS
      log(`iteration ${i}: CI pending — ${CI_POLL_SECONDS}s 待機して再判定（累積 ${gateWaited}s / 上限 ${CI_WAIT_CEILING_SECONDS}s）`)
    }
    // waited/poll は route（passed/pending/failed/error）に関わらず常に加算する（script 側積算）。
    totalCiWaitSeconds += gateWaited
    totalCiPollAttempts += gatePolls
    observeCi(ciEff)
    log(`iteration ${i}: ci-check waited_seconds=${gateWaited} poll_attempts=${gatePolls}（累積 waited=${totalCiWaitSeconds}s poll=${totalCiPollAttempts}）`)

    if (ciEff.status === 'passed' || ciEff.status === 'no_checks') {
      lgtm = true
      log(`iteration ${i}: LGTM（CI status=${ciEff.status}）`)

      // lgtm 確定ラウンドの history を記録（blocking なし、minor は保持）
      history.push({ iteration: i, decision: effReview.decision, summary: effReview.summary, blocking: [], minor: outcome.minor, scope: roundScope, delta_lines: roundDeltaLines })

      break
    } else if (ciEff.status === 'error') {
      // status:'error' は check-ci の gh fetch 失敗分類か、proxy の空応答（turn 上限到達等）の fail-open 合成。
      // 原因を 1 つに断定できないので CI failure と誤解釈せず、実状態の確認手順を添えて人間へ渡す。
      terminal = 'ci_error'
      log(`⚠️ CI check returned error — CI ステータスを確定できなかった（proxy が結果を返さなかった）。gh pr checks ${PR} で実状態を確認すること。人間へエスカレーション`)
      break
    } else if (ciEff.status === 'pending') {
      terminal = 'ci_pending'
      log(`⚠️ CI pending — checks incomplete, never auto-approve. 人間/CI 完了待ちへエスカレーション`)
      break
    } else if (ciEff.status === 'failed') {
      // ciEff.status === 'failed': convert failed_checks into synthetic blocking findings and route
      // through the existing fix path. Repeated identical ci::<name> topics hit REVIEW_STUCK
      // automatically via the existing stuckTopics computation below.
      const ciFindings = ciFailedFindings(ciEff)

      terminalPath = 'ci'

      // Register CI findings into reviewSeen exactly like the existing blocking loop so that
      // repeated identical CI failures (same ci::<name> topic) trigger REVIEW_STUCK escalation.
      for (const x of ciFindings) reviewSeen.register(x)
      const ciStuckTopics = reviewSeen.stuckTopics()
      log(`iteration ${i}: ${effReview.decision} だが CI failed — ${ciFindings.length} failing check(s)`
        + `${ciStuckTopics.length ? ` [REVIEW_STUCK: ${ciStuckTopics.join(' / ')}]` : ''}`)

      // CI-failed ラウンドの history 記録（blocking は synthetic CI findings、minor は保持）
      const ciRound = { iteration: i, decision: effReview.decision, summary: effReview.summary, blocking: ciFindings, minor: outcome.minor, scope: roundScope, delta_lines: roundDeltaLines }
      history.push(ciRound)

      if (ciStuckTopics.length) {
        terminal = 'stuck'
        log(`⚠️ Review STUCK — 同一 CI failure topic が ${REVIEW_STUCK} 回反復（${ciStuckTopics.join(' / ')}）。`
          + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
        break
      }

      const issuesText = buildCiIssuesText(ciFindings)

      const ciFixPrompt = fixPrompt({
        objective: `PR #${PR} の CI 失敗を修正し、PR ブランチへ commit・push する。`,
        issuesHeading: ' CI 失敗',
        issuesText,
        guidance: ciFixGuidance({ pr: PR, base: prMeta?.base_ref }),
      })
      const { fix, retried } = await callFixAgent(ciFixPrompt, i)
      if (retried) ciRound.fix_retried = true

      if (fix == null || fix.applied !== true) {
        fixTerminalReason = fix == null ? 'null_after_retry' : 'applied_false'
        terminal = 'fix_failed'
        log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}${retried ? '（retry 後も null）' : ''}。`
          + `無言で再レビューを繰り返さず人間へエスカレーション`)
        break
      }

      const ciEnsure = await ensureFixCommitted(i, shaPrev)
      if (!ciEnsure.ensured) {
        fixTerminalReason = 'commit_unensured'
        terminal = 'fix_failed'
        log(`⚠️ fix#${i} 適用後の commit 保証に失敗（未コミット変更の残存 또는 commit/push 失敗/状態不明）— 未コミットのまま次 iteration へ進まず人間へエスカレーション`)
        break
      }
      shaNow = ciEnsure.headSha
      pendingDeltaLines = ciEnsure.deltaLines

      // CI fix applied — continue to next iteration for re-review + re-CI-check
      fixesApplied++
      continue
    }
  } else {
    // outcome.route === 'fix_loop'（blocking あり、decision は request-changes/comment。approve はここへ来ない）
    const reviewBlocking = outcome.blocking

    // blocking round でも CI を 1 回だけ判定する。review が毎 round blocking を出す PR では
    // ci_gate に一度も到達せず、CI が赤のまま stuck / fix_failed で終端して誰にも見えなかった。
    // ここでは待機しない（pending は finding にせず観測のみ — review ⇄ fix の各 round に CI_WAIT_CEILING_SECONDS
    // を足さない）。failed のときだけ ci::<name> を review の blocking と同じ fix prompt に合流させ、
    // reviewSeen にも register して同一 check の反復失敗を REVIEW_STUCK に乗せる。
    // null / error は fail-open（finding を足さず fix へ進む。CI 状態は ci_last_status で人間に見せる）。
    // terminalPath は 'review' のまま（返り値 terminal_path の 'ci' は「CI-failed 分岐（ci_gate）に入った」の意味を保つ）。
    const ciProbe = await failOpenAgent(
      ciCheckPrompt({ pr: PR, repo: REPO }),
      { agentType: 'dev-runner-haiku-ro', schema: CI_STATUS, label: `ci-check#${i}`, phase: 'Iterate' },
    )
    if (ciProbe == null) log(`⚠️ ci-check#${i} が結果を返さず — blocking round では finding を足さず status=error として記録のみ（fail-open）`)
    const ciProbeEff = ciProbe ?? { status: 'error', failed_checks: [] }
    if (Number.isFinite(ciProbe?.epoch)) lastCiEpoch = ciProbe.epoch
    totalCiPollAttempts += 1
    observeCi(ciProbeEff)
    const ciFindings = ciProbeEff.status === 'failed' ? ciFailedFindings(ciProbeEff) : []
    if (ciFindings.length) {
      log(`iteration ${i}: CI failed（${ciFindings.map((x) => x.topic).join(' / ')}）— review の blocking と合流させて fix へ渡す`)
    } else {
      log(`iteration ${i}: ci-check status=${ciProbeEff.status} — blocking round では待機せず review 指摘の fix へ進む`)
    }
    const blocking = [...reviewBlocking, ...ciFindings]

    // blocking findings を topic 単位で累積し出現回数を数える（stuck 検出 fingerprint）
    for (const x of blocking) reviewSeen.register(x)
    const stuckTopics = reviewSeen.stuckTopics()
    log(`iteration ${i}: ${effReview.decision} — blocking ${reviewBlocking.length} 件${ciFindings.length ? ` + CI ${ciFindings.length} 件` : ''}`
      + `${stuckTopics.length ? ` [REVIEW_STUCK: ${stuckTopics.join(' / ')}]` : ''}`)

    // history に記録（blocking findings と minor を含む。CI finding は blocking に合流済み）
    const round = { iteration: i, decision: effReview.decision, summary: effReview.summary, blocking, minor: outcome.minor, scope: roundScope, delta_lines: roundDeltaLines }
    history.push(round)

    // stuck: 同一 topic が REVIEW_STUCK 回繰り返した = fix が刺さっていない。relax せず人間へエスカレーション。
    if (stuckTopics.length) {
      terminal = 'stuck'
      log(`⚠️ Review STUCK — 同一 topic が ${REVIEW_STUCK} 回反復（${stuckTopics.join(' / ')}）。`
        + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
      break
    }

    // minor は fix loop の対象外 — issuesText / fix agent プロンプトに一切含めない。
    // description/suggestion はメタ指示・迂回手順の verbatim 伝播遮断のため buildFixIssuesText で
    // スクラブしてから埋め込む（canonical は _lib/review-finding-scrub.mjs）。
    // CI finding（ci::<name>）は synthetic な決定論テキストなのでスクラブ対象外 — review 指摘の後ろに合流させる。
    const issuesText = buildFixIssuesText(reviewBlocking)
      + (ciFindings.length ? `\n${buildCiIssuesText(ciFindings)}` : '')

    // fix は dev-runner agent に直接指示する（専用の pr-fix skill は持たない）。
    const reviewFixPrompt = fixPrompt({
      objective: `PR #${PR} のレビュー指摘を修正し、PR ブランチへ commit・push する。`,
      issuesHeading: '指摘',
      issuesText,
      guidance: ciFindings.length
        ? `上記のうち \`ci::<name>\` は CI の失敗 check である（review 指摘と併せて同じ commit で解消してよい）。\n`
          + ciFixGuidance({ pr: PR, base: prMeta?.base_ref })
        : '',
    })
    const { fix, retried } = await callFixAgent(reviewFixPrompt, i)
    if (retried) round.fix_retried = true

    // fix の applied:false を検出して人間へエスカレーション（無言で MAX 回燃やさない）。
    if (fix == null || fix.applied !== true) {
      fixTerminalReason = fix == null ? 'null_after_retry' : 'applied_false'
      terminal = 'fix_failed'
      log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}${retried ? '（retry 後も null）' : ''}。`
        + `無言で再レビューを繰り返さず人間へエスカレーション`)
      break
    }

    const fixEnsure = await ensureFixCommitted(i, shaPrev)
    if (!fixEnsure.ensured) {
      fixTerminalReason = 'commit_unensured'
      terminal = 'fix_failed'
      log(`⚠️ fix#${i} 適用後の commit 保証に失敗（未コミット変更の残存 또는 commit/push 失敗/状態不明）— 未コミットのまま次 iteration へ進まず人間へエスカレーション`)
      break
    }
    shaNow = fixEnsure.headSha
    pendingDeltaLines = fixEnsure.deltaLines
    fixesApplied++
  }
}

const status = lgtm ? 'lgtm' : (terminal ?? 'max_reached')
log(`pr-iterate 終端: status=${status}（iterations=${Math.min(i, MAX)}）`)

// 異常終端時の worktree dirty 検出（返り値 worktree_dirty）。advisory — 失敗は fail-open
// （'unknown' + 警告のみ。gate・status には影響しない）。lgtm 終端では probe しない（agent 呼び出し追加ゼロ）。
let worktreeDirty = null  // 'dirty' | 'clean' | 'unknown' | null(=lgtm で未実施)
if (status !== 'lgtm') {
  const probe = await failOpenAgent(
    `## Objective\npr-iterate 異常終端（status=${status}）時点の作業ツリーが dirty（未コミット変更あり）かを検出する。\n\n## Steps\n\`git -C ${isoWt} status --porcelain\` を bare 単文（先頭トークンが git。cd 前置・bash 前置・env 代入前置・&& 連結禁止）で実行せよ。${PORCELAIN_DIRTY_RULE}clean（porcelain 行が 0 行）なら { "dirty": false, "files": 0 }。dirty なら { "dirty": true, "files": <porcelain 行の行数> }。\n\n## Output format\n{ "dirty": boolean, "files": number }\nprose 禁止。JSON のみ返せ。\n\n## Tools\n使用可: Bash, Read\n\n## Boundary\n読み取り専用。ファイル変更・git mutation 禁止。\n\n## Token cap\nJSON のみ。1 行以内。`,
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
  ciLastStatus,
  ciLastFailedChecks,
  humanFollowups,
})
log(`終端 CI 状態: ${ciLastStatus ?? '未観測'}${ciLastStatus === 'failed' ? `（${ciLastFailedChecks.join(', ')}）` : ''}`)
log('終端サマリーは comment として投稿する（formal review は投稿しない — issue #524）')

if (POST_TERMINAL_SUMMARY) {
  // formal review（`gh` の `pr review --approve`/`--request-changes` サブコマンド）指示は
  // post-summary prompt に含めない — approve 指示が safety classifier に self-approval として
  // blocked され、fail-open のため終端サマリが silent に欠落する。
  // 投稿は `gh pr comment` 単一経路のみを使う。
  // 本文は worktree の .devflow-tmp/ 固定パスへ Write で新規作成させ、gh は bare 単文で 1 回だけ実行させる。
  const summaryBodyFile = `${isoWt}/.devflow-tmp/pr-iterate-summary-${PR}.md`
  const summaryInstructions = ghBareStepInstr(`gh pr comment ${PR}${REPO ? ` --repo ${REPO}` : ''} --body-file ${summaryBodyFile}`)
    + `投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
    + `投稿失敗時でも posted:false を返し throw しないこと。原因調査・再試行・別の起動形での実行はしない。\n`

  const summaryPost = await failOpenAgent(
    `## Objective\nPR #${PR} に pr-iterate の終端サマリーコメントを投稿する（status: ${status}）。\n\n`
    + bodySaveInstr(summaryBody, { bodyFile: summaryBodyFile }, 'PR_ITERATE')
    + `## Instructions\n`
    + summaryInstructions
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Read, Write\n`
    + `\n## Boundary\n<BODY_FILE> 以外のファイルを変更しない。git commit 禁止。\n`
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
  // telemetry キーは dev-flow/references/telemetry.md の 12 キーに限る（_lib/telemetry-keys.test.mjs が pin）。
  // round ごとの詳細・CI 待ち・retry 回数等は返り値に載る。
  telemetry: {
    merge_tier: 'PR_ITERATE',
    iterate_status: status,
    review_model_config: 'opus',  // pr-reviewer の model。override を渡さないので agents/pr-reviewer.md frontmatter の値（一致は review-model-frontmatter.test.mjs が pin）
    plugin_version: PLUGIN_VERSION,  // _lib/plugin-version.mjs の定数。plugin.json との一致は plugin-version.sync.test.mjs が pin
    plugin_commit: PLUGIN_COMMIT,  // plugin の commit（12 桁 hex / null）。記録専用
  },
})
// journal handoff: choreography 本体は canonical _lib/journal-handoff.mjs の
// runJournalHandoff。journal_log_status は 3 値 closed enum
// （logged/save_failed/log_failed）で返り値へ現れる。fail-open は維持（gate 判定には無影響）。
const journalLogStatus = await runJournalHandoff({
  agent: trackedAgent,
  log,
  saveSchema: JOURNAL_SAVE_RESULT,
  logSchema: JOURNAL_RESULT,
  payload: telemetryHandoff,
  savePath: `${isoWt}/.devflow-tmp/payload-priterate-${PR}.json`,
  prefix: 'priterate',
  id: PR,
  subject: 'pr-iterate 終端',
  logLabel: 'journal-log',
  phase: 'Iterate',
})

return {
  pr: PR,
  status,
  iterations: Math.min(i, MAX),
  fixes_applied: fixesApplied,
  last_decision: lastReview?.decision ?? null,
  last_summary: lastReview?.summary ?? null,
  ci_wait_seconds: totalCiWaitSeconds,
  ci_poll_attempts: totalCiPollAttempts,
  ci_last_status: ciLastStatus,  // 最後に観測した CI 状態（null は未観測）。stuck / fix_failed 終端でも CI 赤を呼び出し側に見せる
  ci_last_failed_checks: ciLastFailedChecks,
  fix_null_retries: fixNullRetries,
  review_null_retries: reviewNullRetries,
  worktree_dirty: worktreeDirty,
  fix_uncommitted_recovered: fixUncommittedRecovered,
  terminal_path: terminalPath,
  fix_terminal_reason: fixTerminalReason,
  history,
  human_followups: humanFollowups,  // worktree の外を指すとして fix から外した blocking finding（nested では dev-flow の終端サマリーが表示する）
  subagent_invocations: buildSubagentInvocations(SUBAGENT_COUNTS),
  journal_log_status: journalLogStatus,
  ...(lastCiEpoch != null ? { end_epoch: lastCiEpoch } : {}),
}
} catch (e) {
  // top-level abort handoff: 終端 handoff 到達前の throw（isolation probe fail-closed 等）でも
  // journal entry を 1 件残す。表現は buildAbortHandoffPayload の単一形。fail-open で元の例外を必ず rethrow する。
  try {
    const abortPayload = buildAbortHandoffPayload({
      skill: 'pr-iterate', args: `pr=${PR}`, repo: REPO, pr_number: Number(PR),
      phase: ABORT_CTX.phase, label: ABORT_CTX.label, error: e,
      telemetry: {
        merge_tier: 'PR_ITERATE',
        review_model_config: 'opus',
        plugin_version: PLUGIN_VERSION,
        plugin_commit: PLUGIN_COMMIT,
      },
    })
    const abortLogStatus = await runJournalHandoff({
      agent: trackedAgent,
      log,
      saveSchema: JOURNAL_SAVE_RESULT,
      logSchema: JOURNAL_RESULT,
      payload: abortPayload,
      savePath: `${isoWt}/.devflow-tmp/payload-priterate-${PR}-abort.json`,
      prefix: 'priterate',
      id: PR,
      subject: 'pr-iterate abort',
      logLabel: 'journal-log-abort',
      phase: 'Iterate',
    })
    log(`⚠️ pr-iterate abort（${ABORT_CTX.label ?? '?'}）— abort telemetry handoff: ${abortLogStatus}`)
  } catch (handoffErr) {
    log(`⚠️ abort telemetry handoff 自体が失敗（fail-open）: ${handoffErr?.message ?? handoffErr}`)
  }
  throw e
}
