import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isUiPath, validateUiVerifyConfig, uiVerifyPort, uiVerifyPorts, expandUiVerifyPlaceholders,
} from './ui-verify.mjs';

// ── isUiPath ────────────────────────────────────────────────────────────────

test('isUiPath: UI 拡張子は true', () => {
  assert.equal(isUiPath('src/Button.tsx'), true);
  assert.equal(isUiPath('src/Button.jsx'), true);
  assert.equal(isUiPath('src/Comp.vue'), true);
  assert.equal(isUiPath('src/Comp.svelte'), true);
  assert.equal(isUiPath('src/style.css'), true);
  assert.equal(isUiPath('src/style.scss'), true);
  assert.equal(isUiPath('src/style.sass'), true);
  assert.equal(isUiPath('src/style.less'), true);
  assert.equal(isUiPath('public/index.html'), true);
});

test('isUiPath: components/pages/app/layouts/views 配下の .ts/.js/.mjs/.cjs は true', () => {
  assert.equal(isUiPath('src/components/Button.ts'), true);
  assert.equal(isUiPath('src/pages/index.js'), true);
  assert.equal(isUiPath('app/layout.mjs'), true);
  assert.equal(isUiPath('src/layouts/Main.cjs'), true);
  assert.equal(isUiPath('src/views/Home.ts'), true);
  assert.equal(isUiPath('components/Button.ts'), true); // 先頭一致 (^)
});

test('isUiPath: 非 UI segment の .ts/.js は false', () => {
  assert.equal(isUiPath('src/lib/util.ts'), false);
  assert.equal(isUiPath('_lib/goal-ledger.mjs'), false);
  assert.equal(isUiPath('scripts/foo.js'), false);
});

test('isUiPath: test ファイルは常に false', () => {
  assert.equal(isUiPath('src/components/Button.test.tsx'), false);
  assert.equal(isUiPath('src/components/Button.spec.tsx'), false);
  assert.equal(isUiPath('src/__tests__/Button.tsx'), false);
  assert.equal(isUiPath('__tests__/Button.tsx'), false);
  assert.equal(isUiPath('src/components/__tests__/Button.ts'), false);
});

test('isUiPath: 非 string / 空文字は false', () => {
  assert.equal(isUiPath(''), false);
  assert.equal(isUiPath(null), false);
  assert.equal(isUiPath(undefined), false);
  assert.equal(isUiPath(123), false);
  assert.equal(isUiPath({}), false);
});

test('isUiPath: 無関係な拡張子は false', () => {
  assert.equal(isUiPath('README.md'), false);
  assert.equal(isUiPath('_lib/ui-verify.mjs'), false);
});

// ── validateUiVerifyConfig ──────────────────────────────────────────────────

const MIN_UP = [{ name: 'app', serve: 'npm run dev -- --port {port}', ready: { http: 'http://127.0.0.1:{port}/' } }];

test('validateUiVerifyConfig: 最小 config（serve 1 つ）は既定値で正規化される', () => {
  const res = validateUiVerifyConfig({ up: MIN_UP });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.config, {
    base_port: 4000,
    ports: ['app'],
    env: {},
    env_files: [],
    up: [
      { name: 'app', kind: 'serve', command: 'npm run dev -- --port {port}', cwd: null, env: {}, timeout_sec: 180, ready: { http: 'http://127.0.0.1:{port}/' } },
    ],
    down: [],
    base_url: 'http://127.0.0.1:{port}',
    smoke_path: '/',
    login: null,
    console_ignore: ['\\[HMR\\]', '\\[Fast Refresh\\]', '\\bwebpack\\b', 'favicon\\.ico', 'React DevTools'],
    ttl_sec: 1800,
    scenarios: null,
  });
});

for (const [label, cfg, keys] of [
  ['install_command + dev_command', { install_command: 'npm ci', dev_command: 'npm run dev -- --port {port}' }, /install_command \/ dev_command/],
  ['dev_command のみ', { dev_command: 'x {port}' }, /dev_command/],
  ['up と旧形式の併記', { up: MIN_UP, install_command: 'npm ci' }, /install_command/],
  ['ready_path', { up: MIN_UP, ready_path: '/health' }, /ready_path/],
  ['top-level cwd', { up: MIN_UP, cwd: 'apps/web' }, /cwd/],
]) {
  test(`validateUiVerifyConfig: 旧形式のキー（${label}）は変換せず移行先を示して ok:false`, () => {
    const res = validateUiVerifyConfig(cfg);
    assert.equal(res.ok, false);
    assert.match(res.error, /旧形式のキー/);
    assert.match(res.error, keys);
    assert.match(res.error, /up へ移行/);
    assert.match(res.error, /serve/);
  });
}

test('validateUiVerifyConfig: base_port が範囲外なら ok:false', () => {
  assert.equal(validateUiVerifyConfig({ up: MIN_UP, base_port: 1023 }).ok, false);
  assert.equal(validateUiVerifyConfig({ up: MIN_UP, base_port: 65536 }).ok, false);
  assert.equal(validateUiVerifyConfig({ up: MIN_UP, base_port: 4000.5 }).ok, false);
  assert.equal(validateUiVerifyConfig({ up: MIN_UP, base_port: 'abc' }).ok, false);
});

test('validateUiVerifyConfig: env_files が非配列/非string要素なら ok:false', () => {
  assert.equal(validateUiVerifyConfig({ up: MIN_UP, env_files: '.env' }).ok, false);
  assert.equal(validateUiVerifyConfig({ up: MIN_UP, env_files: [1] }).ok, false);
});

test('validateUiVerifyConfig: scenarios 要素の name 欠落は ok:false', () => {
  const res = validateUiVerifyConfig({ up: MIN_UP, scenarios: [{ steps: ['a'] }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /name/);
});

test('validateUiVerifyConfig: scenarios が非配列なら ok:false', () => {
  const res = validateUiVerifyConfig({ up: MIN_UP, scenarios: 'foo' });
  assert.equal(res.ok, false);
});

test('validateUiVerifyConfig: cfg が object でないなら ok:false', () => {
  assert.equal(validateUiVerifyConfig(null).ok, false);
  assert.equal(validateUiVerifyConfig(undefined).ok, false);
  assert.equal(validateUiVerifyConfig('x').ok, false);
  assert.equal(validateUiVerifyConfig(42).ok, false);
  assert.equal(validateUiVerifyConfig([]).ok, false);
});

// ── uiVerifyPort ─────────────────────────────────────────────────────────────

test('uiVerifyPort: 通常の issue 番号', () => {
  assert.equal(uiVerifyPort(4000, 5), 4005);
  assert.equal(uiVerifyPort(4000, 285), 4285);
});

test('uiVerifyPort: issue % 1000 で mod される', () => {
  assert.equal(uiVerifyPort(4000, 1285), 4285);
  assert.equal(uiVerifyPort(4000, 2000), 4000);
});

test('uiVerifyPort: 非有限 issue は basePort をそのまま返す', () => {
  assert.equal(uiVerifyPort(4000, NaN), 4000);
  assert.equal(uiVerifyPort(4000, Infinity), 4000);
  assert.equal(uiVerifyPort(4000, 'not-a-number'), 4000);
  assert.equal(uiVerifyPort(4000, undefined), 4000);
});

test('uiVerifyPort: 数値文字列は Number() 変換される', () => {
  assert.equal(uiVerifyPort(4000, '42'), 4042);
});

// ── 新形式（up / down）──────────────────────────────────────────────────────

// DB（宣言側が用意したサーバー）→ migrate/seed → backend → frontend の 4 段構成。
// dev-flow はコマンドの中身を知らないことを、ツール名を含む宣言がそのまま通ることで確認する。
const STACK_CFG = {
  base_port: 6100,
  ports: ['web', 'api', 'db'],
  env: {
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:{port.db}/postgres?sslmode=disable',
  },
  up: [
    { name: 'install', run: 'pnpm install --frozen-lockfile' },
    { name: 'db', serve: 'pglite-server --db={state_dir}/pglite --port={port.db}', ready: { tcp: '{port.db}' } },
    { name: 'migrate', run: 'pnpm --filter backend exec prisma migrate deploy', timeout_sec: 300 },
    { name: 'api', serve: 'node --import tsx src/server.ts', cwd: 'packages/backend', env: { PORT: '{port.api}' }, ready: { http: 'http://127.0.0.1:{port.api}/health' } },
    { name: 'web', serve: 'pnpm --filter frontend dev --port {port.web}', ready: { log: 'Ready in' } },
  ],
  down: [{ name: 'dump-logs', run: 'echo done' }],
  base_url: 'http://localhost:{port.web}/',
  smoke_path: '/dashboard',
  login: {
    commands: [
      ['open', '{base_url}/login'],
      ['find', 'label', 'メールアドレス', 'fill', 'e2e@test.local'],
      ['click', 'button[type=submit]'],
      ['wait', '--url', '**/dashboard'],
    ],
  },
  console_ignore: ['ResizeObserver loop'],
  ttl_sec: 900,
  scenarios: [{ name: 'shift', steps: ['open /shifts'], checks: ['table visible'] }],
};

test('validateUiVerifyConfig: 新形式は宣言順の up と既定値を正規化する', () => {
  const res = validateUiVerifyConfig(STACK_CFG);
  assert.equal(res.ok, true, res.error);
  const c = res.config;
  assert.deepEqual(c.ports, ['web', 'api', 'db']);
  assert.deepEqual(c.up.map((s) => `${s.kind}:${s.name}`), ['run:install', 'serve:db', 'run:migrate', 'serve:api', 'serve:web']);
  assert.equal(c.up[0].timeout_sec, 600);
  assert.equal(c.up[1].timeout_sec, 180);
  assert.equal(c.up[2].timeout_sec, 300);
  assert.deepEqual(c.up[1].ready, { tcp: '{port.db}' });
  assert.equal(c.up[3].cwd, 'packages/backend');
  assert.deepEqual(c.down.map((s) => s.name), ['dump-logs']);
  assert.equal(c.base_url, 'http://localhost:{port.web}', '末尾の / は落とす');
  assert.equal(c.smoke_path, '/dashboard');
  assert.deepEqual(c.login, { commands: STACK_CFG.login.commands });
  assert.deepEqual(c.console_ignore, ['ResizeObserver loop']);
  assert.equal(c.ttl_sec, 900);
});

test('validateUiVerifyConfig: 新形式の既定 base_url は ports 先頭の {port}', () => {
  const res = validateUiVerifyConfig({ up: [{ name: 'app', serve: 'x {port}', ready: { tcp: '{port}' } }] });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.config.ports, ['app']);
  assert.equal(res.config.base_url, 'http://127.0.0.1:{port}');
  assert.equal(res.config.ttl_sec, 1800);
});

test('validateUiVerifyConfig: ready.log が宣言済みの port 名を参照するなら受理する', () => {
  const res = validateUiVerifyConfig({ ports: ['web', 'api'], up: [{ name: 'a', serve: 'x --port {port.api}', ready: { log: 'listening on {port.api}' } }] });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.config.up[0].ready, { log: 'listening on {port.api}' });
});

for (const [label, cfg, re] of [
  ['up が無い', { base_port: 5000 }, /up は非空 array/],
  ['up が空', { up: [] }, /up/],
  ['serve が 1 つも無い', { up: [{ name: 'a', run: 'x' }] }, /serve/],
  ['run と serve の両方', { up: [{ name: 'a', run: 'x', serve: 'y', ready: { tcp: 1 } }] }, /どちらか一方/],
  ['serve に ready が無い', { up: [{ name: 'a', serve: 'x' }] }, /ready/],
  ['ready が 2 種類', { up: [{ name: 'a', serve: 'x', ready: { tcp: 1, log: 'x' } }] }, /厳密に 1 つ/],
  ['ready.http が URL でない', { up: [{ name: 'a', serve: 'x', ready: { http: '/health' } }] }, /http/],
  ['ready.log が不正な正規表現', { up: [{ name: 'a', serve: 'x', ready: { log: '(' } }] }, /正規表現/],
  ['run に ready', { up: [{ name: 'a', run: 'x', ready: { tcp: 1 } }, { name: 'b', serve: 'x', ready: { tcp: 1 } }] }, /serve にのみ/],
  ['down に serve', { up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }], down: [{ name: 'b', serve: 'y' }] }, /down/],
  ['name の重複', { up: [{ name: 'a', run: 'x' }, { name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /重複/],
  ['name が不正', { up: [{ name: '1st', serve: 'x', ready: { tcp: 1 } }] }, /name/],
  ['cwd が絶対 path', { up: [{ name: 'a', serve: 'x', cwd: '/etc', ready: { tcp: 1 } }] }, /cwd/],
  ['cwd が .. で外に出る', { up: [{ name: 'a', serve: 'x', cwd: '../other', ready: { tcp: 1 } }] }, /cwd/],
  ['env が string 以外', { env: { A: 1 }, up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /env/],
  ['timeout_sec が 0', { up: [{ name: 'a', serve: 'x', timeout_sec: 0, ready: { tcp: 1 } }] }, /timeout_sec/],
  ['未宣言の port 名を参照', { ports: ['web'], up: [{ name: 'a', serve: 'x --port {port.api}', ready: { tcp: '{port.web}' } }] }, /api/],
  ['ready.log が未宣言の port 名を参照', { ports: ['web'], up: [{ name: 'a', serve: 'x --port {port.web}', ready: { log: 'listening on {port.apl}' } }] }, /未宣言の port 名を参照している: apl/],
  ['ports の重複', { ports: ['a', 'a'], up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /重複/],
  ['ports 帯が 65535 を超える', { base_port: 64000, ports: ['a', 'b', 'c'], up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /65535/],
  ['login.commands が空', { login: { commands: [] }, up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /login/],
  ['login が自然文（旧 steps）', { login: { steps: ['ログインする'] }, up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /login/],
  ['login.commands の要素が argv 配列でない', { login: { commands: ['open /login'] }, up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /argv/],
  ['login.commands に許可外の subcommand', { login: { commands: [['eval', 'document.cookie']] }, up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /eval/],
  ['login.commands に --session', { login: { commands: [['open', '/login', '--session', 'x']] }, up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /--session/],
  ['login.commands が未宣言の port を参照', { login: { commands: [['open', 'http://127.0.0.1:{port.api}/']] }, up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /api/],
  ['console_ignore が不正な正規表現', { console_ignore: ['('], up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /console_ignore/],
  ['console_ignore が string[] でない', { console_ignore: 'x', up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /console_ignore/],
  ['smoke_path が / 始まりでない', { smoke_path: 'x', up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /smoke_path/],
  ['base_url が URL でない', { base_url: 'localhost:3000', up: [{ name: 'a', serve: 'x', ready: { tcp: 1 } }] }, /base_url/],
]) {
  test(`validateUiVerifyConfig: 新形式 — ${label}は ok:false`, () => {
    const res = validateUiVerifyConfig(cfg);
    assert.equal(res.ok, false);
    assert.match(res.error, re);
  });
}

// ── uiVerifyPorts / expandUiVerifyPlaceholders ──────────────────────────────

test('uiVerifyPorts: 先頭は uiVerifyPort と同値、以降は 1000 刻み', () => {
  assert.deepEqual(uiVerifyPorts(6100, 1496, ['web', 'api', 'db']), { web: 6596, api: 7596, db: 8596 });
  assert.equal(uiVerifyPorts(6100, 1496, ['web']).web, uiVerifyPort(6100, 1496));
});

test('expandUiVerifyPlaceholders: 既知の placeholder だけを置換し ${VAR} には触らない', () => {
  const vars = { ports: { web: 3010, api: 3011 }, state_dir: '/s', worktree: '/w', base_url: 'http://127.0.0.1:3010' };
  assert.equal(
    expandUiVerifyPlaceholders('cd {worktree} && PORT={port.api} WEB={port} D={state_dir} U={base_url} H=${HOME} X={port.nope}', vars),
    'cd /w && PORT=3011 WEB=3010 D=/s U=http://127.0.0.1:3010 H=${HOME} X={port.nope}',
  );
});
