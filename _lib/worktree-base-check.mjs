// Worktree Base Check: dev-flow の Setup phase で既存 worktree の起点(base)一致を検証する純関数群
// （issue #517、resolve-base.mjs（issue #298）と同型のパターン）。
// WORKTREE_BASE_PROBE: exec-proxy（dev-runner-haiku-ro）が返す worktree 存在/upstream probe の schema。
// worktreeBaseProbePrompt: dev-runner-haiku-ro へ渡す verbatim 転写 prompt を組み立てる純関数。
// checkWorktreeBase: probe を元に既存 worktree の起点一致を決定論的に判定する純関数
//   （未存在→素通り / upstream 一致→再利用可 / upstream 空・不一致・probe 不正→throw、fail-closed）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

export const WORKTREE_BASE_PROBE = {
  type: 'object',
  required: ['ok', 'worktree_exists', 'upstream'],
  properties: {
    ok: { type: 'boolean' },
    worktree_exists: { type: 'boolean' },
    upstream: { type: 'string' },
  },
};

export function worktreeBaseProbePrompt(issue) {
  // issue #519 review: 入れ子 $() + 複合 if を含む単一スクリプトは worktree-isolation guard に
  // 拒否され得る（git -C 単体は通過）。guard が検証できる独立コマンド列（test -d / git -C）に分割し、
  // 各コマンドの結果から agent 自身が JSON を組み立てる形へ変更する。
  const wtdSuffix = '.claude/worktrees/df-' + issue;
  return 'リポジトリルートで以下の手順を **この順で** 実行し、各コマンドの結果から JSON を組み立てて返せ'
    + '（各コマンドの stdout は **verbatim** に扱い、要約・脚色をしない。判定は下記の組み立てルールのみに従う）:\n\n'
    + '1. 次を実行する: `git rev-parse --path-format=absolute --git-common-dir`\n'
    + '   出力（例: `/path/to/repo/.git`）の末尾の `/.git` を除いた文字列を ROOT とする。\n'
    + '   WTD = `${ROOT}/' + wtdSuffix + '`\n\n'
    + '2. 次を実行する（<WTD> は手順1で求めた絶対パスに置換する）: `test -d "<WTD>"`\n'
    + '   exit code が 0 なら worktree_exists=true、0 以外なら worktree_exists=false とする。\n\n'
    + '3. worktree_exists=true の場合のみ、次を実行する（<WTD> は同じ絶対パス）: '
    + '`git -C "<WTD>" rev-parse --abbrev-ref --symbolic-full-name @{upstream}`\n'
    + '   成功（exit code 0）した場合 stdout の1行を upstream とする。失敗（exit code 非0。upstream 未設定等）'
    + 'した場合は upstream を空文字列 "" とする。worktree_exists=false の場合は手順3を実行せず'
    + ' upstream を空文字列 "" とする。\n\n'
    + '## Output format\n'
    + '次の1行 JSON のみを返す（前後に説明文を付けない）: '
    + '{"ok":true,"worktree_exists":<bool>,"upstream":"<string>"}\n\n'
    + '## Tools\n'
    + '使用可: Bash（手順1〜3の git rev-parse / test -d / git -C rev-parse の読み取り専用コマンドのみ、'
    + '上記以外のコマンドは実行しない）。禁止: Write, Edit（ファイル変更禁止）、'
    + 'git push / git fetch --prune 等の書き込み・変更系コマンド。\n\n'
    + '## Boundary\n'
    + 'ファイル変更・git 設定変更・commit・push を一切行わない。手順1〜3の読み取り系 git/test コマンド'
    + '（bare 単文、パイプ・リダイレクト・複合コマンドなし）のみ実行する。\n\n'
    + '## Token cap\n'
    + '80 語以内で応答せよ（JSON 本体以外の説明を付けない）。';
}

const RECOVERY_STEPS = 'このいずれかで復旧して再実行せよ: '
  + '(1) `git worktree remove .claude/worktrees/df-<issue>`'
  + '（失敗時は --force）で当該 worktree を削除して dev-flow を再実行する'
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

  const expected = 'origin/' + base;

  if (probe.upstream === expected) {
    return {
      status: 'match',
      logLine: 'worktree-base-check: 既存 worktree の起点 ' + expected + ' が一致 — 再利用可',
    };
  }

  const pushedBranchUpstream = 'origin/feature/issue-' + issue;

  if (probe.upstream === pushedBranchUpstream) {
    return {
      status: 'match_pushed',
      logLine: 'worktree-base-check: 既存 worktree の upstream が ' + pushedBranchUpstream
        + '（PR 作成済み、git push -u で書き換え済み）— 起点不一致ではなく再利用可',
    };
  }

  if (probe.upstream === '') {
    throw new Error(
      'dev-flow: 既存 worktree の起点を判定できなかった（upstream tracking 未設定）'
      + ' — Setup で中断（fail-closed）。'
      + '期待する起点: ' + expected + '。'
      + RECOVERY_STEPS,
    );
  }

  throw new Error(
    'dev-flow: 既存 worktree の起点が一致しない — Setup で中断（fail-closed）。'
    + '実際の起点: ' + probe.upstream + ' / 期待する起点: ' + expected + '。'
    + 'PR diff に base 間差分が混入するのを防ぐための検証であり、danger-grep のセキュリティ'
    + 'シグナルではなく設定不一致である。'
    + RECOVERY_STEPS,
  );
}
