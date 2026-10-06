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
// ただし repo 外を「作業の対象」として指していない目印は数えない:
//   - 目印を含む節（、。— 等で区切った単位）が否定・不在・条件・言及の形（「〜しない」「〜が無い」「0 箇所」
//     「不要」「必要なら」「理由にしていない」「記述」「grep」等）のもの。repo 内のファイルから文字列を
//     消す・repo 外を変えないと書いた AC を repo 外扱いにしないため
//   - 対象 repo 自身が持つもの（対象 repo が dotfiles のときの dotfiles / excludedCommands / settings.json）
// mixed の AC でも（人手）と明記されていれば external にする（人間が repo 外の作業として引き受けたと読む）。
// 判定に迷う形は repo 側に倒す（agent への誤分類は AGENT_AC_REIMPL_MAX で止まる。上の actor の倒し方と同じ理由）。
//
// 観測型 AC（issue #844）: 実行して出力・記録を観測しないと確かめられない AC（「実 run の journal に記録される」
// 「計測して比較する」等）。evaluator のコード読み（inspection）では確かめられないので actor は 'human'。
// Evaluate / Final reconcile は test の red→green 実証で deterministic 昇格したときだけ checked にし、それ以外は
// 差し戻さず ac_human_pending へ回す（merge 後の実 run・計測が要る AC は run 内で証跡を作れず、差し戻しても
// AGENT_AC_REIMPL_MAX を使い切ってから HOLD になるだけのため）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

export const AC_ACTORS = ['agent', 'human']

// agent AC の未達だけを理由にした差し戻しの上限。standard shape（EVAL_PASSES=1）でもこの回数までは
// evaluate を延長して差し戻す。incentive-structural — 満たせない AC で差し戻しが続くのを総回数で止める。
export const AGENT_AC_REIMPL_MAX = 2

const EXPLICIT_HUMAN_RE = /[（(]\s*人手\s*[)）]/

const HUMAN_AC_PATTERNS = [
  EXPLICIT_HUMAN_RE,
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
// ownedBy: 対象 repo の名前（owner/name の name）がこれと一致するときは repo 内のものとして数えない。
const EXTERNAL_AC_PATTERNS = [
  { re: /dotfiles/gi, ownedBy: 'dotfiles' },
  { re: /excludedCommands/g, ownedBy: 'dotfiles' },
  { re: /settings(\.local)?\.json/g, ownedBy: 'dotfiles' },
  { re: /~\/\.claude\b/g, ownedBy: null },
  { re: /(別|他|ほか)の?\s*(repo|リポジトリ)/gi, ownedBy: null },
]

// 節の区切り。目印が否定・言及の節にあるかは節単位で見る。
const CLAUSE_SEP_RE = /[、，,。．；;—–\n]/g

// repo 外を作業の対象として指していない節の形（否定・不在・件数 0・不要・条件・言及・grep 対象）。g なし（test() で使う）。
const MENTION_CLAUSE_PATTERNS = [
  /(が|は|も)\s*(無|な)い/,
  /[てで]いない/,
  /しない|せず/,
  /不要/,
  /含ま(ない|ず)|を含む行/,
  /(^|[^\d])0\s*(箇所|件|個|行)|ヒット\s*0/,
  /必要(なら|に?なった場合|な場合|があれば)/,
  /記述|言及|理由(として|に)/,
  /\bgrep\b/i,
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

// 否定・言及の形をとる節の [start, end) 範囲を返す。
function mentionRanges(text) {
  const ranges = []
  let start = 0
  const push = (end) => {
    const clause = text.slice(start, end)
    if (MENTION_CLAUSE_PATTERNS.some((re) => re.test(clause))) ranges.push([start, end])
  }
  for (const m of text.matchAll(CLAUSE_SEP_RE)) {
    push(m.index)
    start = m.index + m[0].length
  }
  push(text.length)
  return ranges
}

// AC 本文から repo 外の目印を取り除いた残りと、作業の対象として repo 外を指す目印を返す。
// 目印は同じ長さの空白で置き換える（節の範囲を元の offset のまま使うため）。
function splitExternalMarkers(ac, repo) {
  const src = String(ac ?? '')
  const mentions = mentionRanges(src)
  const inMention = (off) => mentions.some(([s, e]) => off >= s && off < e)
  const self = normalizeRepoSlug(repo)
  const selfName = self.includes('/') ? self.split('/')[1] : ''
  const markers = []
  let text = src
  for (const { re, ownedBy } of EXTERNAL_AC_PATTERNS) {
    text = text.replace(re, (m, ...args) => {
      const off = args[args.length - 2]
      const owned = ownedBy !== null && ownedBy === selfName
      if (!owned && !inMention(off)) markers.push(m)
      return ' '.repeat(m.length)
    })
  }
  text = text.replace(REPO_REF_RE, (m, urlSlug, refSlug, off) => {
    const slug = normalizeRepoSlug(urlSlug ?? refSlug)
    if (!self || slug === self) return m
    if (!inMention(off)) markers.push(slug)
    return ' '.repeat(m.length)
  })
  return { rest: text, markers }
}

// AC を 'repo' | 'external' | 'mixed' に分類する。opts.repo は対象 repo の owner/name（他 repo 参照と自 repo が持つ
// 目印の判定に使う。省略時は他 repo 参照を判定しない）。
export function classifyAcScope(ac, opts = {}) {
  const { rest, markers } = splitExternalMarkers(ac, opts?.repo)
  if (markers.length === 0) return 'repo'
  if (!REPO_AC_PATTERNS.some((re) => re.test(rest))) return 'external'
  return EXPLICIT_HUMAN_RE.test(String(ac ?? '').replace(INLINE_CODE_RE, ' ')) ? 'external' : 'mixed'
}

// 観測型 AC の分類規則（v2）。手順: inline code を除く → 鉤括弧の引用「…」を除く → CLAUSE_SEP_RE で節に分ける →
// 1 節でも発火すれば観測型。
// 強い語: OBS_STRONG_NEG でなければ、否定・言及の節でも発火（「実測 / 計測」は動詞形だけ。実測値・実測表では発火しない）
const OBS_STRONG_RE = /(実測|計測)(する|し|で|でき|を行|に基づ|[）)]|$)|A\/B\s*(を|で|テスト|比較)|比較表|(実|修正後の|直近の?)\s*(dev-flow\s*)?run\s*([（(][^）)]*[）)])?\s*(で|において|の)|1\s*件以上\s*(現れ|記録|残|出)/i
const OBS_STRONG_NEG_RE = /(実測|計測|A\/B)\S{0,4}(しない|不要|しなくてよい)/
// 弱い語: OBS_NEG・既存 MENTION_CLAUSE_PATTERNS・OBS_MENTION_EXTRA のどれにも当たらない節でのみ発火
const OBS_WEAK_RE = /生成される|記録される|出力される|journal|telemetry|receipt|verdict|件数/i
const OBS_NEG_RE = /しない|せず|[てで]いない|ない(こと|$)|載せない|残さない|書かない|出さない|読まない|使わない|渡さない|含めない/
const OBS_MENTION_EXTRA_RE = /を\s*(削除|外す|撤去|消す)|(削除|撤去)する|記載|明記|整合|一致|canonical|化され|扱い|キー名|識別子|表記/
const QUOTE_RE = /「[^」]*」/g

// AC が観測型（実行して出力・記録を観測しないと確かめられない）か。
export function isObservationalAc(ac) {
  const text = String(ac ?? '').replace(INLINE_CODE_RE, ' ').replace(QUOTE_RE, ' ')
  return text.split(CLAUSE_SEP_RE).some((clause) => {
    if (OBS_STRONG_RE.test(clause) && !OBS_STRONG_NEG_RE.test(clause)) return true
    if (OBS_NEG_RE.test(clause) || OBS_MENTION_EXTRA_RE.test(clause)) return false
    if (MENTION_CLAUSE_PATTERNS.some((re) => re.test(clause))) return false
    return OBS_WEAK_RE.test(clause)
  })
}

export function acObservationalOf(acceptanceCriteria) {
  return (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((ac) => isObservationalAc(ac))
}

export function classifyAcActor(ac, opts = {}) {
  const text = String(ac ?? '').replace(INLINE_CODE_RE, ' ')
  if (HUMAN_AC_PATTERNS.some((re) => re.test(text))) return 'human'
  if (classifyAcScope(ac, opts) === 'external') return 'human'
  return isObservationalAc(ac) ? 'human' : 'agent'
}

export function acActorsOf(acceptanceCriteria, opts = {}) {
  return (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((ac) => classifyAcActor(ac, opts))
}

// ledger の AC-<n> item のうち、red→green 実証で deterministic 昇格して checked の AC の index（0 始まり）。
export function deterministicAcIndexes(ledgerItems) {
  const out = []
  for (const it of (Array.isArray(ledgerItems) ? ledgerItems : [])) {
    const m = it && typeof it.id === 'string' ? /^AC-(\d+)$/.exec(it.id) : null
    if (m && it.checked === true && it.check && it.check.kind === 'deterministic') out.push(Number(m[1]) - 1)
  }
  return out
}

// evaluator / final-ac-reconcile の ac_results で、deterministic 昇格していない観測型 AC を satisfied:false に倒し
// observational:true を付ける（inspection や red→green 不成立の satisfied:true を達成扱いにしない）。
// 倒した AC は actor 'human' なので unsatisfiedAcByActor で人手 AC 待ちに数えられ、差し戻しの対象にならない。
// 非配列はそのまま返す。
export function demoteUnprovenObservationalAc(acResults, observational, provenIndexes) {
  if (!Array.isArray(acResults)) return acResults
  const obs = Array.isArray(observational) ? observational : []
  const proven = Array.isArray(provenIndexes) ? provenIndexes : []
  return acResults.map((r) => {
    if (!r || !Number.isInteger(r.ac_index) || obs[r.ac_index] !== true || proven.includes(r.ac_index)) return r
    if (r.satisfied !== true) return { ...r, observational: true }
    const evidence = typeof r.evidence === 'string' && r.evidence.trim() ? `（evaluator: ${r.evidence.trim()}）` : ''
    return { ...r, satisfied: false, observational: true, evidence: `観測型 AC — test の red→green 実証が無く、実行しないと確かめられない${evidence}` }
  })
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
