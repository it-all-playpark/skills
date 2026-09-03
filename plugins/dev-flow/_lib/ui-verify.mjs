// UI Verify: dev-flow の Evaluate phase に付随する agent-browser ベースの UI 検証ゲート向け純関数群。
// isUiPath: 変更ファイルが UI 検証対象かを判定する。
// validateUiVerifyConfig: リポジトリの ui-verify 設定を正規化・検証する。
// uiVerifyPort: issue 番号から衝突しにくい dev server port を導出する。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

const UI_FILE_EXTS = new Set(['tsx', 'jsx', 'vue', 'svelte', 'css', 'scss', 'sass', 'less', 'html']);
const UI_CODE_EXTS = new Set(['ts', 'js', 'mjs', 'cjs']);
const UI_SEGMENT_RE = /(^|\/)(components|pages|app|layouts|views)\//;
const TEST_PATH_RE = /(\.test\.|\.spec\.|(^|\/)__tests__\/)/;

export function isUiPath(file) {
  if (typeof file !== 'string' || file.length === 0) return false;
  if (TEST_PATH_RE.test(file)) return false;
  const m = /\.([^./]+)$/.exec(file);
  if (!m) return false;
  const ext = m[1].toLowerCase();
  if (UI_FILE_EXTS.has(ext)) return true;
  if (UI_CODE_EXTS.has(ext) && UI_SEGMENT_RE.test(file)) return true;
  return false;
}

export function validateUiVerifyConfig(cfg) {
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
    return { ok: false, error: 'ui-verify config は object である必要がある' };
  }

  if (typeof cfg.install_command !== 'string' || cfg.install_command.trim() === '') {
    return { ok: false, error: 'install_command は非空 string 必須' };
  }
  if (typeof cfg.dev_command !== 'string' || cfg.dev_command.trim() === '') {
    return { ok: false, error: 'dev_command は非空 string 必須' };
  }
  if (!cfg.dev_command.includes('{port}')) {
    return { ok: false, error: 'dev_command は部分文字列 "{port}" を含む必要がある' };
  }

  let cwd = null;
  if (cfg.cwd !== undefined) {
    if (typeof cfg.cwd !== 'string') return { ok: false, error: 'cwd は string 必須' };
    cwd = cfg.cwd;
  }

  let base_port = 4000;
  if (cfg.base_port !== undefined) {
    if (typeof cfg.base_port !== 'number' || !Number.isInteger(cfg.base_port) || cfg.base_port < 1024 || cfg.base_port > 65535) {
      return { ok: false, error: 'base_port は 1024〜65535 の整数である必要がある' };
    }
    base_port = cfg.base_port;
  }

  let ready_path = '/';
  if (cfg.ready_path !== undefined) {
    if (typeof cfg.ready_path !== 'string' || !cfg.ready_path.startsWith('/')) {
      return { ok: false, error: 'ready_path は "/" で始まる string である必要がある' };
    }
    ready_path = cfg.ready_path;
  }

  let env_files = [];
  if (cfg.env_files !== undefined) {
    if (!Array.isArray(cfg.env_files) || cfg.env_files.some((f) => typeof f !== 'string')) {
      return { ok: false, error: 'env_files は string[] である必要がある' };
    }
    env_files = cfg.env_files;
  }

  let scenarios = null;
  if (cfg.scenarios !== undefined && cfg.scenarios !== null) {
    if (!Array.isArray(cfg.scenarios)) {
      return { ok: false, error: 'scenarios は array である必要がある' };
    }
    for (const s of cfg.scenarios) {
      if (typeof s !== 'object' || s === null || Array.isArray(s) || typeof s.name !== 'string' || s.name.trim() === '') {
        return { ok: false, error: 'scenarios の各要素は name:string 必須' };
      }
      if (s.steps !== undefined && (!Array.isArray(s.steps) || s.steps.some((x) => typeof x !== 'string'))) {
        return { ok: false, error: 'scenarios[].steps は string[] である必要がある' };
      }
      if (s.checks !== undefined && (!Array.isArray(s.checks) || s.checks.some((x) => typeof x !== 'string'))) {
        return { ok: false, error: 'scenarios[].checks は string[] である必要がある' };
      }
      if (s.ac_index !== undefined && typeof s.ac_index !== 'number') {
        return { ok: false, error: 'scenarios[].ac_index は number である必要がある' };
      }
    }
    scenarios = cfg.scenarios;
  }

  return {
    ok: true,
    config: { install_command: cfg.install_command, dev_command: cfg.dev_command, cwd, base_port, ready_path, env_files, scenarios },
  };
}

export function uiVerifyPort(basePort, issue) {
  const n = Number(issue);
  if (!Number.isFinite(n)) return basePort;
  return basePort + (n % 1000);
}
