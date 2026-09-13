// prerun setup: dev-flow.js の Setup phase が args.setup（dev-flow-prerun の stdout JSON）を
// fail-closed に検証・要約するための純関数群。
//
// dev-flow-prerun（wrapper preflight の bare 名 launcher）が base 解決・worktree 作成/再利用・
// .devflow-tmp の clean・deps install・framework 検出を行い、その結果を stdout JSON 1 行として
// 返す。wrapper がそれを Workflow({ args: { issue, setup } }) の args.setup として渡すため、
// dev-flow.js 側はこれを唯一の入力源として検証する（workflow 内 fallback は持たない）。
// validatePrerunSetup: args.setup を検証し、Setup phase が使う正規化済み値を返す純関数。
//   raw が欠落/非 object/配列、raw.ok !== true、必須キー欠落/型不正のいずれも即 throw する
//   （fallback を作らない — 後方互換 scaffolding 禁止）。
// rejectLegacyBaseArg: 旧形式 args.base（base は dev-flow-prerun が解決し args.setup.base で渡る）
//   を検出し即 throw する純関数。Setup phase の try 節に入る前（args 節）で呼ぶことを想定する。
// summarizePrerunDeps: prerun の deps 結果（advisory）を implementer prompt 注入用の警告文と
//   ログ行に要約する純関数。deps.ok:false でも top-level ok には影響しない（fail-open）。
// hasNextJs: stack.frameworks に 'next' が含まれるかを判定する純関数。Turbopack 規約注入の判定に使う。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

export const PRERUN_SETUP_REQUIRED = ['ok', 'base', 'worktree', 'head', 'deps', 'stack', 'epoch'];

export const PRERUN_MISSING_MSG = 'dev-flow: args.setup が無い — /dev-flow wrapper（dev-flow/SKILL.md の preflight）で `dev-flow-prerun --issue <N> --worktree <path>` を実行し、その stdout JSON を Workflow の args.setup に渡せ（workflow 内 fallback は無い）';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringifyForError(value) {
  if (value === undefined) return 'undefined';
  try {
    const repr = JSON.stringify(value);
    return repr === undefined ? String(value) : repr;
  } catch {
    return String(value);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function rejectLegacyBaseArg(args) {
  if (isPlainObject(args) && Object.prototype.hasOwnProperty.call(args, 'base')) {
    throw new Error('dev-flow: args.base は受理しない — base は dev-flow-prerun [--base <ref>] が解決し args.setup.base で渡る');
  }
}

export function validatePrerunSetup(raw, issue) {
  if (!isPlainObject(raw)) {
    throw new Error(PRERUN_MISSING_MSG);
  }

  if (raw.ok !== true) {
    throw new Error(
      `dev-flow: args.setup.ok が true でない — dev-flow-prerun が失敗している`
      + `（base_error: ${raw.base_error ?? '-'} / worktree_error: ${raw.worktree_error ?? '-'} / worktree_status: ${raw.worktree_status ?? '-'}）。`
      + `SKILL.md の preflight に従い prerun の失敗を解消してから再実行せよ`,
    );
  }

  const fail = (key, value) => {
    throw new Error(`dev-flow: args.setup の必須キーが欠落/型不正: ${key}（受信: ${stringifyForError(value)}）`);
  };

  if (!isNonEmptyString(raw.base)) fail('base', raw.base);
  if (!isNonEmptyString(raw.worktree) || !raw.worktree.startsWith('/')) fail('worktree', raw.worktree);
  if (!isNonEmptyString(raw.head)) fail('head', raw.head);
  if (!isPlainObject(raw.deps)) fail('deps', raw.deps);
  if (typeof raw.deps.ok !== 'boolean') fail('deps.ok', raw.deps.ok);
  if (typeof raw.deps.note !== 'string') fail('deps.note', raw.deps.note);
  if (!isPlainObject(raw.stack)) fail('stack', raw.stack);
  if (!Array.isArray(raw.stack.frameworks)) fail('stack.frameworks', raw.stack.frameworks);
  if (!(Number.isInteger(raw.epoch) && raw.epoch > 0)) fail('epoch', raw.epoch);

  const repo = isNonEmptyString(raw.repo) ? raw.repo : null;
  const branch = isNonEmptyString(raw.branch) ? raw.branch : `feature/issue-${issue}`;
  const frameworks = raw.stack.frameworks.filter((f) => typeof f === 'string');

  return {
    base: raw.base.trim(),
    worktree: raw.worktree,
    branch,
    head: raw.head,
    repo,
    deps: { ok: raw.deps.ok, note: raw.deps.note },
    frameworks,
    epoch: raw.epoch,
  };
}

export function summarizePrerunDeps(deps) {
  const note = deps && typeof deps.note === 'string' ? deps.note : '';
  if (deps && deps.ok === true) {
    return {
      outcome: 'ok',
      logLine: 'Setup(deps): ' + (note ? `依存インストール完了 — ${note}` : 'lockfile なし / 依存なし — install skip'),
      implNote: null,
    };
  }
  const msg = note || '依存インストール結果を確認できなかった';
  return {
    outcome: 'warn',
    logLine: `⚠️ Setup(deps): ${msg}（fail-open で続行）`,
    implNote: `依存インストール警告: ${msg}。この worktree では依存（node_modules 等）が未整備の可能性がある。自分の task の実装/テスト実行に必要なら worktree 直下で install コマンド（例: npm ci）を自分で実行してよい（lockfile は書き換えるな）。\n`,
  };
}

export function hasNextJs(frameworks) {
  return Array.isArray(frameworks) && frameworks.includes('next');
}
