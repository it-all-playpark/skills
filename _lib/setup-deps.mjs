// Setup Deps: dev-flow の Setup phase で worktree 確定直後に依存インストールを試みる
// fail-open exec-proxy 向けの純関数群（issue #120 の ensure-worktree-deps.sh を接続する）。
// setupDepsPrompt: dev-runner-haiku へ渡す verbatim 転写 prompt を組み立てる。
// summarizeDepsResult: exec-proxy から返る JSON を { outcome, logLine, implNote } へ正規化する。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

export function setupDepsPrompt(worktree) {
  return `cd ${worktree} で作業。次を実行し **stdout の JSON 1 行をそのまま** verbatim で返せ（判定や脚色をしない）:\n`
    + `bash ~/.claude/skills/_shared/scripts/ensure-worktree-deps.sh --path ${worktree} --lockfile-only --skip-custom`;
}

function warningImplNote(detail) {
  return `依存インストール警告: ${detail}。この worktree では依存（node_modules 等）が未整備の可能性がある。`
    + `自分の task の実装/テスト実行に必要なら worktree 直下で install コマンド（例: npm ci）を自分で実行してよい（lockfile は書き換えるな）。\n`;
}

function describeResult(r) {
  const ecosystem = r && typeof r.ecosystem === 'string' ? r.ecosystem : 'unknown';
  const pm = r && typeof r.pm === 'string' ? r.pm : 'unknown';
  const status = r && typeof r.status === 'string' ? r.status : 'unknown';
  const command = r && typeof r.command === 'string' ? r.command : null;
  return { ecosystem, pm, status, command };
}

export function summarizeDepsResult(res) {
  if (typeof res !== 'object' || res === null || Array.isArray(res) || typeof res.status !== 'string') {
    return {
      outcome: 'unverified',
      logLine: '⚠️ Setup(deps): 依存インストール結果を確認できなかった（exec-proxy 応答なし/不正） — fail-open で続行',
      implNote: warningImplNote('依存インストールの実行結果を確認できなかった（exec-proxy から有効な応答が得られなかった）'),
    };
  }

  const status = res.status;

  if (status === 'no_dependencies') {
    return {
      outcome: 'no_dependencies',
      logLine: 'Setup(deps): lockfile なし — install skip (no-op)',
      implNote: null,
    };
  }

  if (status === 'success') {
    const results = Array.isArray(res.results) ? res.results : [];
    const failing = results.filter((r) => {
      const d = describeResult(r);
      return d.status === 'failed' || d.status === 'pm_not_found';
    });

    if (failing.length > 0) {
      const details = failing
        .map((r) => {
          const d = describeResult(r);
          return `${d.ecosystem}/${d.pm}${d.command ? ` (${d.command})` : ''}: ${d.status}`;
        })
        .join(', ');
      return {
        outcome: 'failed',
        logLine: `⚠️ Setup(deps): 依存インストールに失敗した項目あり — ${details}（fail-open で続行）`,
        implNote: warningImplNote(`依存インストールの一部に失敗した（${details}）`),
      };
    }

    const summary = results.map((r) => {
      const d = describeResult(r);
      return `${d.pm}:${d.status}`;
    }).join(', ');
    return {
      outcome: 'installed',
      logLine: `Setup(deps): 依存インストール完了${summary ? ` — ${summary}` : ''}`,
      implNote: null,
    };
  }

  if (status === 'partial' || status === 'failed') {
    const results = Array.isArray(res.results) ? res.results : [];
    const failing = results.filter((r) => {
      const d = describeResult(r);
      return d.status === 'failed' || d.status === 'pm_not_found';
    });
    const details = failing
      .map((r) => {
        const d = describeResult(r);
        return `${d.ecosystem}/${d.pm}${d.command ? ` (${d.command})` : ''}: ${d.status}`;
      })
      .join(', ');
    const errorPart = typeof res.error === 'string' && res.error.length > 0 ? res.error : null;
    const detail = [details, errorPart].filter(Boolean).join(' / ') || `status:${status}`;
    return {
      outcome: 'failed',
      logLine: `⚠️ Setup(deps): 依存インストールが ${status} で終了 — ${detail}（fail-open で続行）`,
      implNote: warningImplNote(`依存インストールが ${status} で終了した（${detail}）`),
    };
  }

  return {
    outcome: 'unverified',
    logLine: `⚠️ Setup(deps): 未知の status "${status}" — 依存インストール結果を確認できなかった（fail-open で続行）`,
    implNote: warningImplNote(`exec-proxy が未知の status "${status}" を返した`),
  };
}
