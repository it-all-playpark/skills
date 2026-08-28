// Worktree Base Check: dev-flow の Setup phase で既存 worktree の起点(base)一致を検証する純関数群
// （issue #517、resolve-base.mjs（issue #298）と同型のパターン）。
// WORKTREE_BASE_PROBE: exec-proxy（dev-runner-haiku-ro）が返す worktree 存在/upstream probe の schema。
// worktreeBaseProbePrompt: dev-runner-haiku-ro へ渡す verbatim 転写 prompt を組み立てる純関数。
// checkWorktreeBase: probe を元に既存 worktree の起点一致を決定論的に判定する純関数
//   （未存在→素通り / upstream 一致→再利用可 / upstream 空・不一致・probe 不正→throw、fail-closed）。
//
// 2候補制の不変条件（issue #528）: worktree 候補は 既定=repo 内 `.claude/worktrees/df-<issue>` /
// write deny repo 向け退避先=repo 外 sibling `<repo>-wt/df-<issue>` の2つ。探索順は常に
// repo 内が先勝ち（決定論）で、既定動作（repo 内 worktree）はこの優先順により不変。
//
// issue #527: probe prompt は絶対パス引数を一切持たないコマンド構成
// （git worktree list --porcelain / git config --get branch.<name>.*）を採る。
// issue #519 review 時点の「複合 if を避ければ git -C 単体は guard を通過する」という前提は
// 現環境で成立しない実測があり（EnterWorktree 済みセッションの worktree-isolation guard は
// git -C 単体を含め絶対パス引数を持つコマンドを「too complex to verify that it stays inside
// the worktree」で拒否する）、パス引数が構造的に存在しない手順へ置き換えた。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

export const WORKTREE_BASE_PROBE = {
  type: 'object',
  required: ['ok', 'worktree_exists', 'upstream_remote', 'upstream_merge'],
  properties: {
    ok: { type: 'boolean' },
    worktree_exists: { type: 'boolean' },
    upstream_remote: { type: 'string' },
    upstream_merge: { type: 'string' },
  },
};

export function worktreeBaseProbePrompt(issue) {
  // issue #527: worktree-isolation guard は絶対パス引数を持つコマンド（git -C 単体を含む）を
  // 「too complex to verify that it stays inside the worktree」で拒否する実測があり、issue #519
  // review の「git -C 単体は通過」前提は現環境で成立しない。パス引数を一切持たないコマンド列
  // （git worktree list --porcelain / git config --get branch.<name>.*）へ置換し、guard が
  // 検証すべきパス引数が構造的に存在しない状態にする。
  // issue #528: worktree 候補は repo 内(WTD_IN)/repo 外(WTD_EXT)の2つ。探索は WTD_IN が
  // 常に先勝ちする決定論的順序（既定動作＝repo 内 worktree を不変に保つ）。
  const wtdInSuffix = '.claude/worktrees/df-' + issue;
  const wtdExtSuffix = '-wt/df-' + issue;
  return 'リポジトリルートで以下の手順を **この順で** 実行し、各コマンドの結果から JSON を組み立てて返せ'
    + '（各コマンドの stdout は **verbatim** に扱い、要約・脚色をしない。判定は下記の組み立てルールのみに従う）:\n\n'
    + '1. 次を実行する: `git worktree list --porcelain`\n'
    + '   出力は worktree ごとのブロック（`worktree <絶対パス>` 行、`branch refs/heads/<name>` 行等）に'
    + '分かれる（git は main worktree を必ず先頭に出す）。先頭ブロックの worktree パスを ROOT とする。\n'
    + '   WTD_IN = `${ROOT}/' + wtdInSuffix + '`\n'
    + '   WTD_EXT = `${ROOT}' + wtdExtSuffix + '`\n'
    + '   worktree パスが WTD_IN に一致するブロックがあれば WTD=WTD_IN、worktree_exists=true とする。'
    + '無ければ WTD_EXT に一致するブロックを探し、あれば WTD=WTD_EXT、worktree_exists=true とする'
    + '（WTD_IN が常に先勝ちする決定論的な優先順位である）。どちらも無ければ worktree_exists=false、'
    + 'upstream_remote=""、upstream_merge="" とし、手順2〜3 は実行せず Output format へ進む。\n'
    + '   一致したブロックに `branch refs/heads/<name>` 行が無い場合（detached HEAD）も同様に'
    + ' upstream_remote=""、upstream_merge="" とし、手順2〜3 は実行しない。あれば `refs/heads/` を'
    + '除いた名前を BR とする。\n\n'
    + '2. 次を実行する（<BR> は手順1で求めた branch 名に置換する。branch 設定は worktree 間で共有される'
    + ' `.git/config` にあるため -C は不要）: `git config --get branch.<BR>.remote`\n'
    + '   成功（exit code 0）した場合 stdout の1行を upstream_remote とする。失敗（exit code 非0）した'
    + '場合は upstream_remote を空文字列 "" とする。\n\n'
    + '3. 次を実行する（<BR> は手順1で求めた branch 名に置換する）: `git config --get branch.<BR>.merge`\n'
    + '   成功（exit code 0）した場合 stdout の1行を upstream_merge とする。失敗（exit code 非0）した'
    + '場合は upstream_merge を空文字列 "" とする。\n\n'
    + '## Output format\n'
    + '次の1行 JSON のみを返す（前後に説明文を付けない）: '
    + '{"ok":true,"worktree_exists":<bool>,"upstream_remote":"<string>","upstream_merge":"<string>"}\n\n'
    + '## Tools\n'
    + '使用可: Bash（`git worktree list --porcelain` 1回と `git config --get` 最大2回の読み取り専用'
    + ' bare 単文のみ。パイプ・リダイレクト・複合コマンド・変数代入・`git -C`・`test` は使わない）。'
    + '禁止: Write, Edit（ファイル変更禁止）、git push / git fetch --prune 等の書き込み・変更系コマンド。\n\n'
    + '## Boundary\n'
    + 'ファイル変更・git 設定変更・commit・push を一切行わない。手順1〜3の読み取り専用 bare 単文'
    + '（パイプ・リダイレクト・複合コマンド・変数代入なし）のみ実行する。\n\n'
    + '## Token cap\n'
    + '80 語以内で応答せよ（JSON 本体以外の説明を付けない）。';
}

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
