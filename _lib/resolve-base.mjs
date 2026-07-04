// Resolve Base: dev-flow の Setup phase 冒頭で BASE branch を確定する純関数群（issue #298）。
// normalizeBaseArg: args.base を正規化する（未指定は null、非文字列は throw）。
// RESOLVE_BASE_PROBE: exec-proxy（dev-runner-haiku）が返す origin refs probe の schema。
// resolveBasePrompt: dev-runner-haiku へ渡す verbatim 転写 prompt を組み立てる純関数。
// resolveBase: probe を元に BASE を決定論的に解決する純関数
//   （明示指定→存在検証 / 未指定→origin/dev→origin/HEAD フォールバック / 解決不能→throw）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

export function normalizeBaseArg(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }
  throw new Error('dev-flow: args.base は非空文字列で指定せよ（受信: ' + JSON.stringify(raw) + '）');
}

export const RESOLVE_BASE_PROBE = {
  type: 'object',
  required: ['ok', 'default_branch', 'dev_exists', 'requested_exists'],
  properties: {
    ok: { type: 'boolean' },
    default_branch: { type: 'string' },
    dev_exists: { type: 'boolean' },
    requested_exists: { type: 'boolean' },
  },
};

export function resolveBasePrompt(baseArg) {
  const req = typeof baseArg === 'string' ? baseArg : '';
  const cmd = 'REQ="' + req + '"; '
    + 'DB=$(git ls-remote --symref origin HEAD 2>/dev/null | awk \'/^ref:/{sub("refs/heads/","",$2); print $2; exit}\'); '
    + 'DEV=false; git ls-remote --exit-code --heads origin dev >/dev/null 2>&1 && DEV=true; '
    + 'REQE=false; if [ -n "$REQ" ]; then git ls-remote --exit-code --heads origin "$REQ" >/dev/null 2>&1 && REQE=true; fi; '
    + 'printf \'{"ok":true,"default_branch":"%s","dev_exists":%s,"requested_exists":%s}\\n\' "$DB" "$DEV" "$REQE"';
  return 'リポジトリルートで次のコマンドをそのまま実行し、stdout の JSON 1 行をそのまま **verbatim** で返せ'
    + '（判定や脚色をしない。要約・整形・追加コメントは付けない）:\n\n'
    + cmd
    + '\n\n'
    + '## Output format\n'
    + 'stdout の JSON 1 行のみ。それ以外の文字列を出力しない。\n\n'
    + '## Tools\n'
    + '使用可: Bash（git ls-remote 等の読み取り専用コマンドのみ）。禁止: Write, Edit（ファイル変更禁止）、'
    + 'git push / git fetch --prune 等の書き込み・変更系コマンド。\n\n'
    + '## Boundary\n'
    + 'ファイル変更・git 設定変更・commit・push を一切行わない。読み取り系 git コマンド（git ls-remote）のみ実行する。\n\n'
    + '## Token cap\n'
    + '80 語以内で応答せよ（JSON 本体以外の説明を付けない）。';
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
