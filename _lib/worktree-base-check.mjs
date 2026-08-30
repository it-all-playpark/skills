// Worktree Base Check: dev-flow の Setup phase で既存 worktree の起点(base)一致を検証する純関数群
// （issue #517、resolve-base.mjs（issue #298）と同型のパターン）。
// probe 供給元は issue #550 案1 で resolve-base.mjs の SETUP_BASE_PROBE / setupBaseProbePrompt
// （resolve-base + worktree-base-check 統合 exec-proxy、1 回の呼び出し）に一本化された。
// checkWorktreeBase は probe object の worktree_exists/upstream_remote/upstream_merge フィールドのみ
// を読むため、統合 probe object をそのまま渡せる（本ファイル独自の schema/prompt は持たない）。
// checkWorktreeBase: probe を元に既存 worktree の起点一致を決定論的に判定する純関数
//   （未存在→素通り / upstream 一致→再利用可 / upstream 空・不一致・probe 不正→throw、fail-closed）。
//
// 2候補制の不変条件（issue #528）: worktree 候補は 既定=repo 内 `.claude/worktrees/df-<issue>` /
// write deny repo 向け退避先=repo 外 sibling `<repo>-wt/df-<issue>` の2つ。探索順は常に
// repo 内が先勝ち（決定論）で、既定動作（repo 内 worktree）はこの優先順により不変。
// probe（`git worktree list --porcelain` の探索・`prunable` 判定を含む）の具体手順は
// resolve-base.mjs の setupBaseProbePrompt 手順B へ移設した（issue #550 案1）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

const RECOVERY_STEPS = 'このいずれかで復旧して再実行せよ: '
  + '(1) `git worktree remove .claude/worktrees/df-<issue>`'
  + '（repo 外配置の場合は `<repo>-wt/df-<issue>`。失敗時は --force）'
  + 'で当該 worktree を削除して dev-flow を再実行する'
  + '（origin/<base> 起点で作り直される）、'
  + '(2) 既存 worktree の起点を意図しているなら --base を明示して一致させて再実行する。';

export function checkWorktreeBase({ issue, base, probe }) {
  if (typeof probe !== 'object' || probe === null || Array.isArray(probe) || probe.ok !== true) {
    throw new Error(
      'dev-flow: 既存 worktree の起点を確認できなかった（exec-proxy 応答なし/不正）'
      + ' — Setup で中断（fail-closed）。'
      + RECOVERY_STEPS,
    );
  }

  if (probe.worktree_exists === false) {
    return {
      status: 'no_worktree',
      logLine: 'worktree-base-check: worktree 未存在 — 新規作成経路（検証 skip）',
    };
  }

  // issue #527: probe は upstream_remote/upstream_merge を分割して返す（決定論合成は JS 側）。
  const remote = typeof probe.upstream_remote === 'string' ? probe.upstream_remote.trim() : '';
  const merge = typeof probe.upstream_merge === 'string' ? probe.upstream_merge.trim() : '';
  const headsPrefix = 'refs/heads/';
  const short = merge.startsWith(headsPrefix) ? merge.slice(headsPrefix.length) : merge;
  const upstream = remote !== '' && short !== '' ? remote + '/' + short : '';

  const expected = 'origin/' + base;

  if (upstream === expected) {
    return {
      status: 'match',
      logLine: 'worktree-base-check: 既存 worktree の起点 ' + expected + ' が一致 — 再利用可',
    };
  }

  const pushedBranchUpstream = 'origin/feature/issue-' + issue;

  if (upstream === pushedBranchUpstream) {
    return {
      status: 'match_pushed',
      logLine: 'worktree-base-check: 既存 worktree の upstream が ' + pushedBranchUpstream
        + '（PR 作成済み、git push -u で書き換え済み）— 起点不一致ではなく再利用可',
    };
  }

  if (upstream === '') {
    throw new Error(
      'dev-flow: 既存 worktree の起点を判定できなかった（upstream tracking 未設定）'
      + ' — Setup で中断（fail-closed）。'
      + '期待する起点: ' + expected + '。'
      + RECOVERY_STEPS,
    );
  }

  throw new Error(
    'dev-flow: 既存 worktree の起点が一致しない — Setup で中断（fail-closed）。'
    + '実際の起点: ' + upstream + ' / 期待する起点: ' + expected + '。'
    + 'PR diff に base 間差分が混入するのを防ぐための検証であり、danger-grep のセキュリティ'
    + 'シグナルではなく設定不一致である。'
    + RECOVERY_STEPS,
  );
}
