// UI Verify: dev-flow の Evaluate phase に付随する agent-browser ベースの UI 検証ゲート向け純関数群。
// isUiPath: 変更ファイルが UI 検証対象かを判定する。
// validateUiVerifyConfig: リポジトリの ui-verify 設定（up / down 形式）を正規化・検証する。旧形式のキーは移行先付きで error。
// uiVerifyPort / uiVerifyPorts: issue 番号から衝突しにくい port（群）を導出する。
// expandUiVerifyPlaceholders: コマンド・env・URL 中の {port.<name>} 等を実値へ置換する。
//
// dev-flow はツールを知らない。project が宣言した up（一回限りの run と常駐する serve を宣言順に）
// を起動・待機し、検証後に down で片付けるだけ。DB・backend・frontend をどう起動するかは宣言側の責務。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

const UI_FILE_EXTS = new Set(['tsx', 'jsx', 'vue', 'svelte', 'css', 'scss', 'sass', 'less', 'html']);
const UI_CODE_EXTS = new Set(['ts', 'js', 'mjs', 'cjs']);
const UI_SEGMENT_RE = /(^|\/)(components|pages|app|layouts|views)\//;
const TEST_PATH_RE = /(\.test\.|\.spec\.|(^|\/)__tests__\/)/;

const UI_VERIFY_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const UI_VERIFY_PORT_REF_RE = /\{port\.([A-Za-z][A-Za-z0-9_-]*)\}/g;
const UI_VERIFY_RUN_TIMEOUT_SEC = 600;
const UI_VERIFY_SERVE_TIMEOUT_SEC = 180;
const UI_VERIFY_TTL_SEC = 1800;
// login に書ける agent-browser の subcommand（ページ操作と待機のみ。eval / close / 設定変更は不可）
const UI_VERIFY_LOGIN_SUBCOMMANDS = new Set([
  'open', 'click', 'dblclick', 'fill', 'type', 'press', 'keyboard', 'select', 'check', 'uncheck',
  'hover', 'focus', 'scroll', 'scrollintoview', 'wait', 'find', 'back', 'forward', 'reload',
]);
// smoke の console error から機械的に除外する既定パターン（dev モードの既知ノイズ）
const UI_VERIFY_CONSOLE_IGNORE_DEFAULT = [
  '\\[HMR\\]', '\\[Fast Refresh\\]', '\\bwebpack\\b', 'favicon\\.ico', 'React DevTools',
];
// 1 本目の port は旧 uiVerifyPort と同値。2 本目以降は 1000 刻み（issue % 1000 の帯を名前ごとに分ける）。
const UI_VERIFY_PORT_STRIDE = 1000;

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

function uivIsPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function uivIsNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function uivIsPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function uivValidateEnvMap(env, where) {
  if (env === undefined) return { ok: true, env: {} };
  if (!uivIsPlainObject(env) || Object.values(env).some((v) => typeof v !== 'string')) {
    return { ok: false, error: `${where} は string 値の object である必要がある` };
  }
  return { ok: true, env: { ...env } };
}

function uivValidateStringList(v, where) {
  if (v === undefined || v === null) return { ok: true, list: null };
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    return { ok: false, error: `${where} は string[] である必要がある` };
  }
  return { ok: true, list: v };
}

function uivValidateScenarios(raw) {
  if (raw === undefined || raw === null) return { ok: true, scenarios: null };
  if (!Array.isArray(raw)) return { ok: false, error: 'scenarios は array である必要がある' };
  for (const s of raw) {
    if (!uivIsPlainObject(s) || !uivIsNonEmptyString(s.name)) {
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
  return { ok: true, scenarios: raw };
}

function uivValidateReady(ready, where) {
  if (!uivIsPlainObject(ready)) {
    return { ok: false, error: `${where}.ready は { http } / { tcp } / { log } のいずれか 1 つを持つ object 必須` };
  }
  const kinds = ['http', 'tcp', 'log'].filter((k) => ready[k] !== undefined);
  if (kinds.length !== 1) {
    return { ok: false, error: `${where}.ready は http / tcp / log のうち厳密に 1 つを指定する` };
  }
  const kind = kinds[0];
  const value = ready[kind];
  if (kind === 'tcp') {
    if (!(uivIsPositiveInt(value) || uivIsNonEmptyString(value))) {
      return { ok: false, error: `${where}.ready.tcp は port 番号か "{port.<name>}" である必要がある` };
    }
    return { ok: true, ready: { tcp: String(value) } };
  }
  if (!uivIsNonEmptyString(value)) return { ok: false, error: `${where}.ready.${kind} は非空 string 必須` };
  if (kind === 'http' && !/^https?:\/\//.test(value)) {
    return { ok: false, error: `${where}.ready.http は http(s):// で始まる URL である必要がある` };
  }
  if (kind === 'log') {
    try { new RegExp(value); } catch { return { ok: false, error: `${where}.ready.log が正規表現として不正` }; }
  }
  return { ok: true, ready: { [kind]: value } };
}

function uivValidateStep(step, where, { allowServe }) {
  if (!uivIsPlainObject(step)) return { ok: false, error: `${where} は object 必須` };
  if (!uivIsNonEmptyString(step.name) || !UI_VERIFY_NAME_RE.test(step.name)) {
    return { ok: false, error: `${where}.name は英字始まりの [A-Za-z0-9_-] 必須` };
  }
  const hasRun = step.run !== undefined;
  const hasServe = step.serve !== undefined;
  if (hasRun === hasServe) {
    return { ok: false, error: `${where} は run（一回限り）か serve（常駐）のどちらか一方を持つ` };
  }
  if (hasServe && !allowServe) return { ok: false, error: `${where}: down に serve は書けない（run のみ）` };
  const command = hasRun ? step.run : step.serve;
  if (!uivIsNonEmptyString(command)) return { ok: false, error: `${where}.${hasRun ? 'run' : 'serve'} は非空 string 必須` };
  if (step.cwd !== undefined && (typeof step.cwd !== 'string' || step.cwd.startsWith('/') || step.cwd.split('/').includes('..'))) {
    return { ok: false, error: `${where}.cwd は worktree 相対 path（"/" 始まり・".." 不可）である必要がある` };
  }
  const env = uivValidateEnvMap(step.env, `${where}.env`);
  if (!env.ok) return env;
  if (step.timeout_sec !== undefined && !uivIsPositiveInt(step.timeout_sec)) {
    return { ok: false, error: `${where}.timeout_sec は正の整数である必要がある` };
  }
  const out = {
    name: step.name,
    kind: hasRun ? 'run' : 'serve',
    command,
    cwd: step.cwd ?? null,
    env: env.env,
    timeout_sec: step.timeout_sec ?? (hasRun ? UI_VERIFY_RUN_TIMEOUT_SEC : UI_VERIFY_SERVE_TIMEOUT_SEC),
  };
  if (hasServe) {
    const r = uivValidateReady(step.ready, where);
    if (!r.ok) return r;
    out.ready = r.ready;
  } else if (step.ready !== undefined) {
    return { ok: false, error: `${where}: ready は serve にのみ書ける` };
  }
  return { ok: true, step: out };
}

function uivCollectPortRefs(text, into) {
  if (typeof text !== 'string') return;
  for (const m of text.matchAll(UI_VERIFY_PORT_REF_RE)) into.add(m[1]);
}

// 旧形式（install_command + dev_command + {port} の 1 プロセス前提）のキー。変換して受理はせず、
// 移行先を示して config error にする（後方互換 scaffolding を持たない）。
const UI_VERIFY_LEGACY_KEYS = ['install_command', 'dev_command', 'ready_path', 'cwd'];

export function validateUiVerifyConfig(cfg) {
  if (!uivIsPlainObject(cfg)) {
    return { ok: false, error: 'ui-verify config は object である必要がある' };
  }
  const legacyKeys = UI_VERIFY_LEGACY_KEYS.filter((k) => cfg[k] !== undefined);
  if (legacyKeys.length) {
    return {
      ok: false,
      error: `旧形式のキー ${legacyKeys.join(' / ')} は受理しない。up へ移行する: `
        + 'install_command → up[] の { "name": "install", "run": <command> }、'
        + 'dev_command → up[] の { "name": "app", "serve": <command（{port} は {port.app}）>, "ready": { "http": "http://127.0.0.1:{port.app}<ready_path>" } }、'
        + 'cwd → 各 step の cwd',
    };
  }
  const src = cfg;

  let base_port = 4000;
  if (src.base_port !== undefined) {
    if (typeof src.base_port !== 'number' || !Number.isInteger(src.base_port) || src.base_port < 1024 || src.base_port > 65535) {
      return { ok: false, error: 'base_port は 1024〜65535 の整数である必要がある' };
    }
    base_port = src.base_port;
  }

  let ports = ['app'];
  if (src.ports !== undefined) {
    if (!Array.isArray(src.ports) || src.ports.length === 0 || src.ports.some((p) => typeof p !== 'string' || !UI_VERIFY_NAME_RE.test(p))) {
      return { ok: false, error: 'ports は英字始まりの [A-Za-z0-9_-] 名の非空 string[] である必要がある' };
    }
    if (new Set(src.ports).size !== src.ports.length) return { ok: false, error: 'ports の名前が重複している' };
    ports = src.ports;
  }
  if (base_port + 999 + UI_VERIFY_PORT_STRIDE * (ports.length - 1) > 65535) {
    return { ok: false, error: `base_port ${base_port} から ports ${ports.length} 本を割り当てると 65535 を超える` };
  }

  const env = uivValidateEnvMap(src.env, 'env');
  if (!env.ok) return env;

  const envFiles = uivValidateStringList(src.env_files, 'env_files');
  if (!envFiles.ok) return envFiles;

  if (!Array.isArray(src.up) || src.up.length === 0) return { ok: false, error: 'up は非空 array 必須' };
  const up = [];
  for (const [i, s] of src.up.entries()) {
    const v = uivValidateStep(s, `up[${i}]`, { allowServe: true });
    if (!v.ok) return v;
    up.push(v.step);
  }
  if (!up.some((s) => s.kind === 'serve')) return { ok: false, error: 'up に serve（常駐プロセス）が 1 つも無い' };

  const down = [];
  if (src.down !== undefined) {
    if (!Array.isArray(src.down)) return { ok: false, error: 'down は array である必要がある' };
    for (const [i, s] of src.down.entries()) {
      const v = uivValidateStep(s, `down[${i}]`, { allowServe: false });
      if (!v.ok) return v;
      down.push(v.step);
    }
  }
  const names = [...up, ...down].map((s) => s.name);
  if (new Set(names).size !== names.length) return { ok: false, error: 'up / down の name が重複している' };

  let base_url = 'http://127.0.0.1:{port}';
  if (src.base_url !== undefined) {
    if (!uivIsNonEmptyString(src.base_url) || !/^https?:\/\//.test(src.base_url)) {
      return { ok: false, error: 'base_url は http(s):// で始まる string である必要がある' };
    }
    base_url = src.base_url.replace(/\/+$/, '');
  }

  let smoke_path = '/';
  if (src.smoke_path !== undefined) {
    if (typeof src.smoke_path !== 'string' || !src.smoke_path.startsWith('/')) {
      return { ok: false, error: 'smoke_path は "/" で始まる string である必要がある' };
    }
    smoke_path = src.smoke_path;
  }

  // login は agent-browser の argv 列。ui-verify-stack がシェルを通さず順に実行する（LLM を挟まない）。
  let login = null;
  if (src.login !== undefined && src.login !== null) {
    const cmds = uivIsPlainObject(src.login) ? src.login.commands : undefined;
    if (!Array.isArray(cmds) || cmds.length === 0
      || cmds.some((c) => !Array.isArray(c) || c.length === 0 || c.some((a) => typeof a !== 'string'))) {
      return { ok: false, error: 'login は { commands: string[][]（agent-browser の argv 配列の非空 array） } である必要がある' };
    }
    const bad = cmds.find((c) => !UI_VERIFY_LOGIN_SUBCOMMANDS.has(c[0]));
    if (bad) {
      return { ok: false, error: `login.commands の "${bad[0]}" は使えない（可: ${[...UI_VERIFY_LOGIN_SUBCOMMANDS].join(', ')}）` };
    }
    if (cmds.some((c) => c.some((a) => a === '--session' || a.startsWith('--session=')))) {
      return { ok: false, error: 'login.commands に --session は書けない（session は dev-flow が付ける）' };
    }
    login = { commands: cmds };
  }

  let console_ignore = UI_VERIFY_CONSOLE_IGNORE_DEFAULT;
  if (src.console_ignore !== undefined) {
    const ci = uivValidateStringList(src.console_ignore, 'console_ignore');
    if (!ci.ok) return ci;
    for (const re of ci.list) {
      try { new RegExp(re); } catch { return { ok: false, error: `console_ignore の "${re}" が正規表現として不正` }; }
    }
    console_ignore = ci.list;
  }

  let ttl_sec = UI_VERIFY_TTL_SEC;
  if (src.ttl_sec !== undefined) {
    if (!uivIsPositiveInt(src.ttl_sec)) return { ok: false, error: 'ttl_sec は正の整数である必要がある' };
    ttl_sec = src.ttl_sec;
  }

  const sc = uivValidateScenarios(src.scenarios);
  if (!sc.ok) return sc;

  // 未宣言の {port.<name>} 参照は実行時に置換されず残るので、宣言時点で弾く。
  const refs = new Set();
  for (const s of [...up, ...down]) {
    uivCollectPortRefs(s.command, refs);
    for (const v of Object.values(s.env)) uivCollectPortRefs(v, refs);
    if (s.ready) uivCollectPortRefs(s.ready.http ?? s.ready.tcp ?? s.ready.log, refs);
  }
  for (const v of Object.values(env.env)) uivCollectPortRefs(v, refs);
  uivCollectPortRefs(base_url, refs);
  for (const c of login ? login.commands : []) for (const a of c) uivCollectPortRefs(a, refs);
  const unknown = [...refs].filter((r) => !ports.includes(r));
  if (unknown.length) return { ok: false, error: `未宣言の port 名を参照している: ${unknown.join(', ')}（ports に宣言する）` };

  return {
    ok: true,
    config: {
      base_port,
      ports,
      env: env.env,
      env_files: envFiles.list ?? [],
      up,
      down,
      base_url,
      smoke_path,
      login,
      console_ignore,
      ttl_sec,
      scenarios: sc.scenarios,
    },
  };
}

export function uiVerifyPort(basePort, issue) {
  const n = Number(issue);
  if (!Number.isFinite(n)) return basePort;
  return basePort + (n % 1000);
}

export function uiVerifyPorts(basePort, issue, names) {
  const first = uiVerifyPort(basePort, issue);
  const out = {};
  for (const [i, name] of names.entries()) out[name] = first + i * UI_VERIFY_PORT_STRIDE;
  return out;
}

// {port.<name>} / {port}（ports の先頭）/ {state_dir} / {worktree} / {base_url} を置換する。
// それ以外の {..}（シェルの ${VAR} 等）には触らない。
export function expandUiVerifyPlaceholders(text, vars) {
  if (typeof text !== 'string') return text;
  const ports = vars.ports ?? {};
  const firstName = Object.keys(ports)[0];
  return text
    .replace(UI_VERIFY_PORT_REF_RE, (whole, name) => (ports[name] !== undefined ? String(ports[name]) : whole))
    .replace(/\{port\}/g, () => (firstName !== undefined ? String(ports[firstName]) : '{port}'))
    .replace(/\{state_dir\}/g, () => vars.state_dir ?? '{state_dir}')
    .replace(/\{worktree\}/g, () => vars.worktree ?? '{worktree}')
    .replace(/\{base_url\}/g, () => vars.base_url ?? '{base_url}');
}
