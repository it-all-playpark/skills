// local-verify: ci の AC（repo の ci_verify で CI の check が判定する AC。issue #861）を、PR を出す前に
// pg-broker の使い捨て Postgres に向けたローカル実行（plugin bin/ の local-verify）で判定する経路の純関数（issue #863）。
//
// Validate が green になった後・Evaluate の前に、ci の AC があり repo が "dev-flow".local_verify を宣言した run だけ
// local-verify start → wait（終わるまで繰り返す）→ stop を exec-proxy で呼ぶ。
//   passed（exit 0）: ci の AC を satisfied にする（根拠は log_path と exit code）。PR に ci_verify.label は付けるが
//     pr-iterate は check の結果を待たない（ci_verify.wait:false）
//   failed（exit 非 0・timeout）: log_tail を付けて dev-implementer に差し戻す。回数は agent AC の差し戻しと同じ
//     AGENT_AC_REIMPL_MAX に含め、上限後も失敗なら ci の AC を agent の未達に数えて ac_agent_unsatisfied で HOLD
//   unavailable（pg-broker のソケットに届かない・DB を確保できない）/ error（proxy の応答が無い・宣言不正等）:
//     fail-open。従来どおり pr-iterate が LGTM 後に CI の check を待って判定する。理由は終端サマリーに 1 行出す
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

// start が DB の確保（pg-broker create。broker 側の上限は 240 秒）を待つ秒数と、wait 1 回あたりの待機秒数。
// どちらも 1 回の Bash 呼び出し（timeout 600000）に収まる値にする。
export const LOCAL_VERIFY_START_WAIT_SEC = 300
export const LOCAL_VERIFY_WAIT_SEC = 480
// 差し戻しに添える log の末尾の上限（文字）。local-verify も同じ長さで切って返す。
export const LOCAL_VERIFY_TAIL_MAX = 4000
// local-verify の state dir（worktree 内の .devflow-tmp は realized diff から除外される）。
export const LOCAL_VERIFY_STATE_DIR = '.devflow-tmp/local-verify'

// local-verify start の --config-pct に渡す値。Setup 時に検証した宣言（normalizeLocalVerify の結果）を JSON にして
// percent-encoding し、shell のクォートが要らない文字（英数字と . _ - %）だけの 1 トークンにする。
// local-verify はこれを宣言として使い、worktree の宣言（実装で書き換えられうる）が一致しなければ error を返す。
export function localVerifyConfigArg(cfg) {
  return encodeURIComponent(JSON.stringify(cfg)).replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

// wait の最大回数。timeout_seconds を 1 回の待機秒数で割った回数 + 1（local-verify 側も timeout_seconds で
// command を止めて timeout を返すので、これは応答が欠けたときの workflow 側の安全上限）。
export function localVerifyWaitPolls(timeoutSeconds) {
  const t = Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 0
  return Math.ceil(t / LOCAL_VERIFY_WAIT_SEC) + 1
}

// local-verify start / wait の stdout JSON を判定に畳む。
//   'passed' | 'failed' | 'unavailable' | 'error' | 'running'（まだ実行中 — wait を続ける）
// passed は exit_code 0 が揃ったときだけ（転記の食い違いを passed に倒さない）。
export function localVerifyVerdict(res) {
  if (!res || typeof res !== 'object') return 'error'
  switch (res.status) {
    case 'passed': return res.exit_code === 0 ? 'passed' : 'error'
    case 'failed':
    case 'timeout': return 'failed'
    case 'unavailable': return 'unavailable'
    case 'running': return 'running'
    default: return 'error'
  }
}

// local-verify が失敗した run の差し戻し（fix_feedback）。ci の AC ごとに 1 項目、log の末尾を添える。
export function localVerifyFeedback({ result, command, acIndexes, acceptanceCriteria }) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const how = result?.status === 'timeout' ? 'timeout_seconds を超えて止められた' : `exit ${result?.exit_code ?? '?'} で失敗した`
  const logTail = String(result?.log_tail ?? '').slice(-LOCAL_VERIFY_TAIL_MAX)
  return (Array.isArray(acIndexes) ? acIndexes : []).map((i) => ({
    severity: 'major',
    topic: `AC-${i + 1} 未達`,
    ac_index: i,
    description: `AC-${i + 1}「${String(acs[i] ?? '')}」のローカル実行（\`${command}\`。pg-broker の使い捨て Postgres に向けて実行）が ${how}`,
    suggestion: 'log_tail（失敗した実行の出力の末尾）から原因を特定して実装を直せ。テストの期待値を弱めて通さない。全文は log_path にある',
    log_path: typeof result?.log_path === 'string' ? result.log_path : null,
    log_tail: logTail,
  }))
}

// applyCiAcResults（_lib/ac-actor.mjs）に渡す ci AC の判定（source:'local'）。passed / failed で決着した run だけ作る。
export function localVerifyCiOutcome(localVerify) {
  if (!localVerify || !['passed', 'failed'].includes(localVerify.status)) return null
  return {
    source: 'local',
    status: localVerify.status,
    command: localVerify.command,
    exit_code: localVerify.exit_code ?? null,
    log_path: localVerify.log_path ?? null,
  }
}
