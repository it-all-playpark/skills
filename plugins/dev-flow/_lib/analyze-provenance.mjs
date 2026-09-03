// _lib/analyze-provenance.mjs
// verifyAnalyzeProvenance: dev-flow の Analyze phase (sonnet analyze 経路) が返す REQ の issue 取得
// 実在性を、ground-truth probe（gh issue view --json number,title の exec-proxy 結果）との決定論突合
// で検証する純粋関数（issue #451）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// fail-closed の理由（W7 分類: incentive-structural）: probe（issue-meta exec-proxy）に到達できない、
// または probe 自体が要求 issue と不一致という状況は、analyze agent 自身も issue 本文を取得できて
// いない状況と等価であり、捏造 REQ のまま Implement phase へ進行させるより中断（needs_clarification）
// の方がコストが低い。analyze agent に「取得成功」を self-report させる incentive を与えないため、
// 判定は本関数のような決定論突合のみに委ねる。
//
// comment_count 突合（PR #578）: probe（`gh issue view --json number,title,comments`）が
// comments 配列の要素数を comment_count として報告している場合のみ、REQ 側の comment_count
// （dev-issue-analyze skill 出力を sonnet analyze agent が verbatim 転写した値）と突合する。
// probe が comment_count を報告していない（ISSUE_META.comment_count は非 required — number/title と
// 同じ precedent）場合は判定不能のため skip する（既存 fixture・呼び出し側との後方互換）。これは
// issue #573 が直した「sonnet analyze 経路が comments を読まないまま Implement へ進み、comment に
// よる訂正が黙って落ちる」バグの再発防止で、agent に「comments を読んだ」ことを self-report させず
// probe の機械的カウントと突合する（W7 分類: incentive-structural、既存の analyze provenance 突合と
// 同じ設計）。
//
// 判定順（最初に落ちた項目の reason を返す）:
//   1. probe が null/非object または probe.ok !== true            → 'probe_failed'
//   2. Number(probe.number) !== Number(issueNumber)                 → 'probe_issue_mismatch'
//   3. probe.title が非空 string でない（trim 後空含む）           → 'probe_title_empty'
//   4. Number(req?.issue_number) !== Number(issueNumber)             → 'req_issue_mismatch'
//   5. norm(req?.issue_title) !== norm(probe.title)                  → 'title_mismatch'
//   6. probe.comment_count が有限数値のとき、req?.comment_count が
//      有限数値でない                                                → 'req_comment_count_invalid'
//   7. probe.comment_count が有限数値のとき、
//      Number(req.comment_count) !== Number(probe.comment_count)     → 'comment_count_mismatch'
//   8. 全合格                                                        → ok:true
//
// norm は trim + 連続空白の単一空白畳み込みのみ（case・記号は保持 — 過剰正規化は反証力を落とす）。
export function verifyAnalyzeProvenance(req, probe, issueNumber) {
  const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ')

  if (probe === null || typeof probe !== 'object' || Array.isArray(probe) || probe.ok !== true) {
    return {
      ok: false,
      reason: 'probe_failed',
      detail: 'issue metadata の決定論取得に失敗（gh 到達不能の可能性）— 取得検証不能のため fail-closed',
    }
  }

  if (Number(probe.number) !== Number(issueNumber)) {
    return {
      ok: false,
      reason: 'probe_issue_mismatch',
      detail: `probe.number(${probe.number}) と issueNumber(${issueNumber}) が不一致`,
    }
  }

  if (typeof probe.title !== 'string' || probe.title.trim().length === 0) {
    return {
      ok: false,
      reason: 'probe_title_empty',
      detail: 'probe.title が非空文字列でない',
    }
  }

  if (Number(req?.issue_number) !== Number(issueNumber)) {
    return {
      ok: false,
      reason: 'req_issue_mismatch',
      detail: `req.issue_number(${req?.issue_number}) と issueNumber(${issueNumber}) が不一致`,
    }
  }

  if (norm(req?.issue_title) !== norm(probe.title)) {
    return {
      ok: false,
      reason: 'title_mismatch',
      detail: `req.issue_title(${JSON.stringify(req?.issue_title)}) が probe.title(${JSON.stringify(probe.title)}) と不一致`,
    }
  }

  if (typeof probe.comment_count === 'number' && Number.isFinite(probe.comment_count)) {
    if (typeof req?.comment_count !== 'number' || !Number.isFinite(req.comment_count)) {
      return {
        ok: false,
        reason: 'req_comment_count_invalid',
        detail: `req.comment_count(${JSON.stringify(req?.comment_count)}) が数値でない（probe.comment_count=${probe.comment_count}）`,
      }
    }

    if (Number(req.comment_count) !== Number(probe.comment_count)) {
      return {
        ok: false,
        reason: 'comment_count_mismatch',
        detail: `req.comment_count(${req.comment_count}) が probe.comment_count(${probe.comment_count}) と不一致 — comments 取得漏れの疑い（PR #578）`,
      }
    }
  }

  return { ok: true, reason: null, detail: null }
}
