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

export function classifyAcActor(ac) {
  const text = String(ac ?? '').replace(INLINE_CODE_RE, ' ')
  return HUMAN_AC_PATTERNS.some((re) => re.test(text)) ? 'human' : 'agent'
}

export function acActorsOf(acceptanceCriteria) {
  return (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map(classifyAcActor)
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
