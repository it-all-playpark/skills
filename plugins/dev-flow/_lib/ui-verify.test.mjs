import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isUiPath, validateUiVerifyConfig, uiVerifyPort } from './ui-verify.mjs';

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

test('validateUiVerifyConfig: 最小 config は既定値で正規化される', () => {
  const res = validateUiVerifyConfig({
    install_command: 'npm ci',
    dev_command: 'npm run dev -- --port {port}',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.config, {
    install_command: 'npm ci',
    dev_command: 'npm run dev -- --port {port}',
    cwd: null,
    base_port: 4000,
    ready_path: '/',
    env_files: [],
    scenarios: null,
  });
});

test('validateUiVerifyConfig: full config は値をそのまま正規化する', () => {
  const res = validateUiVerifyConfig({
    install_command: 'pnpm install',
    dev_command: 'pnpm dev --port {port}',
    cwd: 'apps/web',
    base_port: 5000,
    ready_path: '/health',
    env_files: ['.env.local'],
    scenarios: [
      { name: 'home', steps: ['open /'], checks: ['no console errors'], ac_index: 1 },
    ],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.config, {
    install_command: 'pnpm install',
    dev_command: 'pnpm dev --port {port}',
    cwd: 'apps/web',
    base_port: 5000,
    ready_path: '/health',
    env_files: ['.env.local'],
    scenarios: [
      { name: 'home', steps: ['open /'], checks: ['no console errors'], ac_index: 1 },
    ],
  });
});

test('validateUiVerifyConfig: install_command 欠落は ok:false', () => {
  const res = validateUiVerifyConfig({ dev_command: 'npm run dev -- --port {port}' });
  assert.equal(res.ok, false);
  assert.match(res.error, /install_command/);
});

test('validateUiVerifyConfig: install_command が空文字/非stringは ok:false', () => {
  assert.equal(validateUiVerifyConfig({ install_command: '', dev_command: 'x {port}' }).ok, false);
  assert.equal(validateUiVerifyConfig({ install_command: 1, dev_command: 'x {port}' }).ok, false);
});

test('validateUiVerifyConfig: dev_command 欠落は ok:false', () => {
  const res = validateUiVerifyConfig({ install_command: 'npm ci' });
  assert.equal(res.ok, false);
  assert.match(res.error, /dev_command/);
});

test('validateUiVerifyConfig: dev_command に {port} が無ければ ok:false', () => {
  const res = validateUiVerifyConfig({ install_command: 'npm ci', dev_command: 'npm run dev' });
  assert.equal(res.ok, false);
  assert.match(res.error, /\{port\}/);
});

test('validateUiVerifyConfig: base_port が範囲外なら ok:false', () => {
  assert.equal(validateUiVerifyConfig({ install_command: 'npm ci', dev_command: 'x {port}', base_port: 1023 }).ok, false);
  assert.equal(validateUiVerifyConfig({ install_command: 'npm ci', dev_command: 'x {port}', base_port: 65536 }).ok, false);
  assert.equal(validateUiVerifyConfig({ install_command: 'npm ci', dev_command: 'x {port}', base_port: 4000.5 }).ok, false);
  assert.equal(validateUiVerifyConfig({ install_command: 'npm ci', dev_command: 'x {port}', base_port: 'abc' }).ok, false);
});

test('validateUiVerifyConfig: ready_path が /始まりでないなら ok:false', () => {
  const res = validateUiVerifyConfig({ install_command: 'npm ci', dev_command: 'x {port}', ready_path: 'health' });
  assert.equal(res.ok, false);
  assert.match(res.error, /ready_path/);
});

test('validateUiVerifyConfig: env_files が非配列/非string要素なら ok:false', () => {
  assert.equal(validateUiVerifyConfig({ install_command: 'npm ci', dev_command: 'x {port}', env_files: '.env' }).ok, false);
  assert.equal(validateUiVerifyConfig({ install_command: 'npm ci', dev_command: 'x {port}', env_files: [1] }).ok, false);
});

test('validateUiVerifyConfig: scenarios 要素の name 欠落は ok:false', () => {
  const res = validateUiVerifyConfig({
    install_command: 'npm ci',
    dev_command: 'x {port}',
    scenarios: [{ steps: ['a'] }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /name/);
});

test('validateUiVerifyConfig: scenarios が非配列なら ok:false', () => {
  const res = validateUiVerifyConfig({ install_command: 'npm ci', dev_command: 'x {port}', scenarios: 'foo' });
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
