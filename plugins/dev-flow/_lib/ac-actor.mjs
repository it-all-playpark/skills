// _lib/ac-actor.mjs
// AC を actor（'agent' | 'human'）に決定論分類し、Evaluate の差し戻しと Merge tier の HOLD 理由を actor で
// 分ける純関数群（issue #747）。
//
// actor の意味:
//   - 'agent': 実装エージェントが worktree 内で満たせる AC（ローカル計測して PR 本文に書く、を含む）。
//     evaluator が satisfied:false を返したら gate_policy に依らず dev-implementer へ差し戻す。
//     差し戻し上限を使い切っても未達なら Merge tier は 'ac_agent_unsatisfied'（ループの取りこぼし）で HOLD。
//   - 'human': `（人手）` 表記・staging / 本番環境・外部サービスの操作・issue へのコメントを要する AC。
//     エージェントは worktree の外に出ない（agents/dev-implementer.md）ので差し戻しても満たせない。
//     未達は差し戻さず Merge tier の 'ac_human_pending'（人手 AC 待ち）へ回す。
// 判定できない AC は 'agent' に倒す。human への誤分類は差し戻しを失い未達のまま人間へ流れるが、agent への誤分類は
// 差し戻しの上限（AGENT_AC_REIMPL_MAX）で止まり、HOLD 理由に取りこぼしとして残るため。
//
// inline code（`...`）は判定前に除く。AC 本文が `（人手）` 等の語を識別子として引用しているだけのものを
// human にしないため。
//
// AC が指す作業の場所（scope）も決定論で分類する（issue #793）:
//   - 'external': repo 外（dotfiles・excludedCommands・settings.json・~/.claude・他 repo）の作業だけを書いた AC。
//     worktree では満たせないので actor は 'human'。
//   - 'mixed': repo 外の作業と repo 内の作業（テスト・README・rules・repo 内パス等）が 1 つの AC に混ざっている。
//     agent 部分を満たしても AC 全体は未達のまま残り、human 部分は差し戻しても満たせない。analyze ゲートで
//     needs_clarification にして AC を repo 内 / repo 外に分割させる（mixedScopeAcReasons）。
//   - 'repo': それ以外。
// repo 外の目印は inline code の中も見る（設定名・パスは inline code で書かれるのが普通のため）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

export const AC_ACTORS = ['agent', 'human']

// agent AC の未達だけを理由にした差し戻しの上限。standard shape（EVAL_PASSES=1）でもこの回数までは
// evaluate を延長して差し戻す。incentive-structural — 満たせない AC で差し戻しが続くのを総回数で止める。
export const AGENT_AC_REIMPL_MAX = 2

const HUMAN_AC_PATTERNS = [
  /[（(]\s*人手\s*[)）]/,
  /staging|ステージング/i,
  /本番/,
  /\bprod(uction)?\s*(環境|environment)/i,
  /外部サービス/,
  /issue\s*(に|へ)(の)?\s*コメント/i,
]

// inline code の区切り（バッククォート）は \x60 で書く（sync-inlines の stripComments は regex literal を
// 解釈せず、生のバッククォートを template literal の開始と読むため）。
const INLINE_CODE_RE = /\x60[^\x60]*\x60/g

export const AC_SCOPES = ['repo', 'external', 'mixed']

// repo 外を指す目印。g 付きで持ち、判定にも除去にも replace / match だけを使う（test() は lastIndex を持ち越すため使わない）。
const EXTERNAL_AC_PATTERNS = [
  /dotfiles/gi,
  /excludedCommands/g,
  /settings(\.local)?\.json/g,
  /~\/\.claude\b/g,
  /(別|他|ほか)の?\s*(repo|リポジトリ)/gi,
]

// 他 repo の参照（github.com/<owner>/<repo> と <owner>/<repo>#<n>）。repo（対象 repo の owner/name）と一致するものは repo 内。
const REPO_REF_RE = /github\.com\/([\w.-]+\/[\w.-]+)|(?:^|[^\w./-])([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#\d+/g

// repo 内の作業を指す目印（repo 外の目印を取り除いた残りに対して見る）。
const REPO_AC_PATTERNS = [
  /テスト|\btests?\b|vitest|\bbats\b|fixture/i,
  /README|AGENTS\.md|ドキュメント/,
  /\brules\b|ルール/,
  /(repo|リポジトリ|worktree)\s*内/i,
  /(^|[\s\x60(（、「])(plugins|tools|src|lib|_lib|tests|scripts|docs|\.claude|\.github)[/]/,
]

function normalizeRepoSlug(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\.git$/, '')
}

// AC 本文から repo 外の目印を取り除いた残りと、見つかった目印を返す。
function splitExternalMarkers(ac, repo) {
  let text = String(ac ?? '')
  const markers = []
  for (const re of EXTERNAL_AC_PATTERNS) {
    text = text.replace(re, (m) => { markers.push(m); return ' ' })
  }
  const self = normalizeRepoSlug(repo)
  text = text.replace(REPO_REF_RE, (m, urlSlug, refSlug) => {
    const slug = normalizeRepoSlug(urlSlug ?? refSlug)
    if (!self || slug === self) return m
    markers.push(slug)
    return ' '
  })
  return { rest: text, markers }
}

// AC を 'repo' | 'external' | 'mixed' に分類する。opts.repo は対象 repo の owner/name（他 repo 参照の判定に使う。
// 省略時は他 repo 参照を判定しない）。
export function classifyAcScope(ac, opts = {}) {
  const { rest, markers } = splitExternalMarkers(ac, opts?.repo)
  if (markers.length === 0) return 'repo'
  return REPO_AC_PATTERNS.some((re) => re.test(rest)) ? 'mixed' : 'external'
}

export function classifyAcActor(ac, opts = {}) {
  const text = String(ac ?? '').replace(INLINE_CODE_RE, ' ')
  if (HUMAN_AC_PATTERNS.some((re) => re.test(text))) return 'human'
  return classifyAcScope(ac, opts) === 'external' ? 'human' : 'agent'
}

export function acActorsOf(acceptanceCriteria, opts = {}) {
  return (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((ac) => classifyAcActor(ac, opts))
}

// analyze ゲートの理由行: repo 内外が混ざった AC ごとに 1 行。非空なら needs_clarification（source=analyze）で止める。
export function mixedScopeAcReasons(acceptanceCriteria, opts = {}) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const reasons = []
  acs.forEach((ac, i) => {
    if (classifyAcScope(ac, opts) !== 'mixed') return
    const { markers } = splitExternalMarkers(ac, opts?.repo)
    reasons.push(`AC-${i + 1}「${String(ac)}」は repo 内の作業と repo 外の作業（${[...new Set(markers)].join(' / ')}）が混ざっている — dev-flow は 1 issue = 1 PR・単一 worktree で repo 外の作業を満たせない。この AC を repo 内の AC と repo 外の AC に分割し、repo 外の AC には（人手）と明記してから再起動せよ`)
  })
  return reasons
}

// evaluator / final-ac-reconcile の ac_results から satisfied:false の ac_index を actor 別に返す。
// actors の範囲外の ac_index（evaluator の誤応答）は数えない。同じ index の重複は 1 件にする。
export function unsatisfiedAcByActor(acResults, actors) {
  const out = { agent: [], human: [] }
  const list = Array.isArray(actors) ? actors : []
  for (const r of (Array.isArray(acResults) ? acResults : [])) {
    if (!r || r.satisfied !== false || !Number.isInteger(r.ac_index)) continue
    const actor = list[r.ac_index]
    if (!AC_ACTORS.includes(actor)) continue
    if (!out[actor].includes(r.ac_index)) out[actor].push(r.ac_index)
  }
  return out
}

// agent AC の未達を dev-implementer へ渡す fix_feedback 項目にする（evaluator feedback と同じ形）。
// 「計測して PR 本文に書く」型の AC は、コードのコメントでは PR 本文に届かないので pr_notes / design_decisions で
// 返すよう suggestion に明記する。
export function agentAcFeedback(indexes, acceptanceCriteria, acResults) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const results = Array.isArray(acResults) ? acResults : []
  return (Array.isArray(indexes) ? indexes : []).map((i) => {
    const r = results.find((x) => x && x.ac_index === i)
    const evidence = r && typeof r.evidence === 'string' && r.evidence.trim() ? r.evidence.trim() : '根拠なし'
    return {
      severity: 'major',
      topic: `AC-${i + 1} 未達`,
      description: `AC-${i + 1}「${String(acs[i] ?? '')}」を evaluator が satisfied:false と判定（${evidence}）`,
      suggestion: 'worktree 内で満たせ。計測値・検証結果を PR 本文に書く AC は pr_notes、設計判断は design_decisions に入れて返せ（コードのコメントだけでは PR 本文に載らない）',
    }
  })
}
