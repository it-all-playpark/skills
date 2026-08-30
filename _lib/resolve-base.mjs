// Resolve Base: dev-flow の Setup phase 冒頭で BASE branch を確定する純関数群（issue #298）。
// normalizeBaseArg: args.base を正規化する（未指定は null、非文字列は throw）。
// SETUP_BASE_PROBE: exec-proxy（dev-runner-haiku-ro）が返す統合 probe の schema（issue #550 案1）
//   — resolve-base（issue #298）と worktree-base-check（issue #517）の 2 probe を 1 回の
//   exec-proxy 呼び出しへ統合したもの。resolveBase() と checkWorktreeBase()
//   （_lib/worktree-base-check.mjs）はそれぞれ probe object の自分のフィールドしか読まないため、
//   単一の統合 probe object を両関数へそのまま渡せる。
// setupBaseProbePrompt: dev-runner-haiku-ro へ渡す verbatim 転写 prompt を組み立てる純関数。
// resolveBase: probe を元に BASE を決定論的に解決する純関数
//   （明示指定→存在検証 / 未指定→origin/dev→origin/HEAD フォールバック / 解決不能→throw）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

const BASE_ARG_ALLOWLIST = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function normalizeBaseArg(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (!BASE_ARG_ALLOWLIST.test(trimmed)) {
      throw new Error(
        'dev-flow: args.base に使用できない文字が含まれる（受信: ' + JSON.stringify(trimmed) + '）。'
        + '許可パターン: ' + BASE_ARG_ALLOWLIST.toString(),
      );
    }
    return trimmed;
  }
  throw new Error('dev-flow: args.base は非空文字列で指定せよ（受信: ' + JSON.stringify(raw) + '）');
}

export const SETUP_BASE_PROBE = {
  type: 'object',
  required: [
    'ok', 'default_branch', 'dev_exists', 'requested_exists',
    'worktree_exists', 'upstream_remote', 'upstream_merge',
  ],
  properties: {
    ok: { type: 'boolean' },
    default_branch: { type: 'string' },
    dev_exists: { type: 'boolean' },
    requested_exists: { type: 'boolean' },
    worktree_exists: { type: 'boolean' },
    upstream_remote: { type: 'string' },
    upstream_merge: { type: 'string' },
    epoch: { type: 'number' },
  },
};

export function setupBaseProbePrompt(baseArg, issue) {
  const req = typeof baseArg === 'string' ? baseArg : '';
  // 手順A（issue #298）: base 解決情報の取得。パス引数を含まない複合ワンライナーのため guard-safe
  // （worktree-isolation guard が拒否するのは絶対パス引数を持つコマンドであり、複合構文そのものでは
  // ない）。DB/DEV/REQE の値は printf で JSON 化せず echo で保持し、Output format の最終 JSON は
  // 手順B/C の結果と合わせて agent が組み立てる。
  const stepACmd = 'REQ="' + req + '"; '
    + 'DB=$(git ls-remote --symref origin HEAD 2>/dev/null | awk \'/^ref:/{sub("refs/heads/","",$2); print $2; exit}\'); '
    + 'DEV=false; git ls-remote --exit-code --heads origin "refs/heads/dev" >/dev/null 2>&1 && DEV=true; '
    + 'REQE=false; if [ -n "$REQ" ]; then git ls-remote --exit-code --heads origin "refs/heads/$REQ" >/dev/null 2>&1 && REQE=true; fi; '
    + 'echo "DB=$DB DEV=$DEV REQE=$REQE"';

  // 手順B（issue #517, #527, #528, #533）: 既存 worktree の起点検証。
  // issue #527: worktree-isolation guard は絶対パス引数を持つコマンド（git -C 単体を含む）を
  // 「too complex to verify that it stays inside the worktree」で拒否する実測があり、パス引数を
  // 一切持たないコマンド列（git worktree list --porcelain / git config --get branch.<name>.*）へ
  // 置換し、guard が検証すべきパス引数が構造的に存在しない状態にする。
  // issue #528: worktree 候補は repo 内(WTD_IN)/repo 外(WTD_EXT)の2つ。探索は WTD_IN が
  // 常に先勝ちする決定論的順序（既定動作＝repo 内 worktree を不変に保つ）。
  const wtdInSuffix = '.claude/worktrees/df-' + issue;
  const wtdExtSuffix = '-wt/df-' + issue;
  const stepBInstructions = '1. 次を実行する: `git worktree list --porcelain`\n'
    + '   出力は worktree ごとのブロック（`worktree <絶対パス>` 行、`branch refs/heads/<name>` 行等）に'
    + '分かれる（git は main worktree を必ず先頭に出す）。先頭ブロックの worktree パスを ROOT とする。\n'
    + '   WTD_IN = `${ROOT}/' + wtdInSuffix + '`\n'
    + '   WTD_EXT = `${ROOT}' + wtdExtSuffix + '`\n'
    + '   worktree パスが WTD_IN に一致するブロックを探す。見つかり、かつそのブロックに `prunable`'
    + ' で始まる行が **無ければ** WTD=WTD_IN、worktree_exists=true とする。見つからない、または'
    + '見つかっても `prunable` 行がある場合（正規の削除手順を経ず手動でディレクトリ削除された stale'
    + ' worktree — git のメタデータ上は残るが実体が無い）は WTD_IN には無いものとして扱い、WTD_EXT'
    + 'に一致するブロックを同じ基準（`prunable` 行が無いこと）で探し、あれば WTD=WTD_EXT、'
    + 'worktree_exists=true とする（WTD_IN が常に先勝ちする決定論的な優先順位である）。どちらも'
    + '無い、またはどちらも `prunable` 行付きの場合は worktree_exists=false、upstream_remote=""、'
    + 'upstream_merge="" とし、以降の手順B の続き（2〜3）は実行せず 手順C へ進む。\n'
    + '   （`prunable` 行が無い）一致したブロックに `branch refs/heads/<name>` 行が無い場合'
    + '（detached HEAD）も同様に upstream_remote=""、upstream_merge="" とし、手順2〜3 は実行しない。'
    + 'あれば `refs/heads/` を除いた名前を BR とする。\n\n'
    + '2. 次を実行する（<BR> は手順1で求めた branch 名に置換する。branch 設定は worktree 間で共有される'
    + ' `.git/config` にあるため -C は不要）: `git config --get branch.<BR>.remote`\n'
    + '   成功（exit code 0）した場合 stdout の1行を upstream_remote とする。失敗（exit code 非0）した'
    + '場合は upstream_remote を空文字列 "" とする。\n\n'
    + '3. 次を実行する（<BR> は手順1で求めた branch 名に置換する）: `git config --get branch.<BR>.merge`\n'
    + '   成功（exit code 0）した場合 stdout の1行を upstream_merge とする。失敗（exit code 非0）した'
    + '場合は upstream_merge を空文字列 "" とする。';

  return 'リポジトリルートで以下の手順を **この順で** 実行し、各コマンドの結果から JSON を組み立てて返せ'
    + '（各コマンドの stdout は **verbatim** に扱い、要約・脚色をしない。判定は下記の組み立てルールのみに従う）:\n\n'
    + '## 手順A: base 解決情報の取得（issue #298）\n'
    + '次のコマンドをそのまま実行する:\n\n' + stepACmd + '\n\n'
    + 'stdout の `DB=<default_branch> DEV=<true|false> REQE=<true|false>` から'
    + ' default_branch / dev_exists / requested_exists を得る。\n\n'
    + '## 手順B: 既存 worktree 起点検証（issue #517, #527, #528, #533）\n'
    + stepBInstructions + '\n\n'
    + '## 手順C: epoch 取得\n'
    + '次を実行する: `date +%s`\n'
    + '成功（exit code 0）した場合 stdout の値を epoch とする。失敗した場合は epoch キーを省略する'
    + '（fail-open。base 解決・worktree 起点検証の判定には一切影響しない）。\n\n'
    + '## Output format\n'
    + '次の1行 JSON のみを返す（前後に説明文を付けない）: '
    + '{"ok":true,"default_branch":"<string>","dev_exists":<bool>,"requested_exists":<bool>,'
    + '"worktree_exists":<bool>,"upstream_remote":"<string>","upstream_merge":"<string>",'
    + '"epoch":<number, 省略可>}\n\n'
    + '## Tools\n'
    + '使用可: Bash（手順A の複合ワンライナー1回、手順B の `git worktree list --porcelain` 1回と'
    + ' `git config --get` 最大2回の読み取り専用 bare 単文、手順C の `date +%s` 1回）。'
    + '手順B/C はパイプ・リダイレクト・複合コマンド・変数代入・`git -C`・`test` を使わない。'
    + '禁止: Write, Edit（ファイル変更禁止）、git push / git fetch --prune 等の書き込み・変更系コマンド。\n\n'
    + '## Boundary\n'
    + 'ファイル変更・git 設定変更・commit・push を一切行わない。手順A〜C の読み取り専用コマンドのみ実行する。\n\n'
    + '## Token cap\n'
    + '120 語以内で応答せよ（JSON 本体以外の説明を付けない）。';
}

export function resolveBase(baseArg, probe) {
  if (typeof probe !== 'object' || probe === null || Array.isArray(probe) || probe.ok !== true) {
    throw new Error(
      'dev-flow: base 解決に失敗 — origin の refs を確認できなかった（exec-proxy 応答なし/不正）。'
      + 'origin リモートとネットワークを確認して再実行せよ',
    );
  }

  if (baseArg !== null) {
    if (probe.requested_exists === true) {
      return { base: baseArg, source: 'explicit' };
    }
    throw new Error(
      'dev-flow: 指定された base "origin/' + baseArg + '" が origin に存在しない — Setup で中断'
      + '（設定ミス。danger-grep のセキュリティシグナルではない）。args.base を修正して再実行せよ',
    );
  }

  if (probe.dev_exists === true) {
    return { base: 'dev', source: 'origin/dev' };
  }

  if (typeof probe.default_branch === 'string' && probe.default_branch.trim() !== '') {
    return { base: probe.default_branch.trim(), source: 'origin/HEAD' };
  }

  throw new Error(
    'dev-flow: base を解決できなかった — origin/dev が存在せず origin/HEAD の default branch も取得できなかった。'
    + 'origin リモートの状態を確認し、args.base で明示指定して再実行せよ',
  );
}
