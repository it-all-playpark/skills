// ui-verify-stack.mjs の実プロセス test。fake service は node の http server（孫プロセスとして起動する
// ケースを含む）で、up → 別プロセスからの down → 停止確認、失敗系、前回 stack の回収を pin する。
// CLI として子プロセスで起動する（supervisor が detached で残る実運用と同じ形）。
// ttl は ui-verify-stack-ttl.test.mjs、up の途中の停止要求は ui-verify-stack-starting.test.mjs、wait は
// ui-verify-stack-wait.test.mjs、login / smoke は ui-verify-stack-smoke.test.mjs（vitest はファイル間でしか
// 並列にしないので、sleep / ttl を待つ test を分けて全体の所要時間を縮めている）。
// fixture と CLI 呼び出しは ui-verify-stack-test-helpers.mjs が共有する。

import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, matchesGlob, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SCRIPT, TEST_POLL_MS, TIMEOUT, basePort, cli, down, get, listening, root, setupStack, stackCfg, stateDir, teardownStack, up, writeConfig, wt,
} from './ui-verify-stack-test-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

beforeEach(setupStack);
afterEach(teardownStack);

test('up: 宣言順に run / serve を実行し ready を返す。down で孫まで止まり down steps が走る', async () => {
  const res = up(writeConfig(stackCfg()));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.phase, 'ready');
  const port = basePort + 7;
  assert.deepEqual(res.ports, { web: port, api: port + 1000 });
  assert.equal(res.base_url, `http://127.0.0.1:${port}`);
  assert.equal(res.smoke_url, `http://127.0.0.1:${port}/home`);
  assert.equal(readFileSync(join(stateDir, 'prep.txt'), 'utf8').trim(), 'prepared');

  // up のプロセスが終わった後も service は生きている（supervisor が detached で残る）
  assert.equal(await get(res.base_url), `web|http://127.0.0.1:${port + 1000}`);
  assert.equal(await get(`http://127.0.0.1:${port + 1000}`), `api|http://127.0.0.1:${port + 1000}`);

  const d = down();
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.stopped, true);
  assert.deepEqual(d.leftover, []);
  assert.equal(d.stop_reason, 'requested');
  assert.equal(await listening(port), false);
  assert.equal(await listening(port + 1000), false, '孫プロセス（bash -c 配下の node）も止まる');
  assert.equal(readFileSync(join(wt, 'down.txt'), 'utf8').trim(), 'down-ran');

  // 冪等
  const d2 = down();
  assert.equal(d2.ok, true);
  assert.equal(d2.stopped, false);
}, TIMEOUT);

test('up: run step の失敗は phase:setup + step 名を返し、先に起きた serve も止める', async () => {
  const cfg = stackCfg();
  cfg.up = [cfg.up[1], { name: 'seed', run: 'echo boom >&2; exit 3' }, cfg.up[2]];
  const res = up(writeConfig(cfg));
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'setup');
  assert.equal(res.step, 'seed');
  assert.match(res.error, /seed: exit 3/);
  assert.match(readFileSync(res.log, 'utf8'), /boom/);
  const d = down();
  assert.equal(d.ok, true);
  assert.equal(await listening(basePort + 7 + 1000), false, '失敗前に起きた api も止まっている');
}, TIMEOUT);

test('up: serve が ready 前に終了したら phase:start', () => {
  const cfg = stackCfg();
  cfg.up = [{ name: 'web', serve: 'exit 1', ready: { tcp: '{port.web}' } }];
  const res = up(writeConfig(cfg));
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'start');
  assert.equal(res.step, 'web');
}, TIMEOUT);

test('up: ready が timeout_sec 内に来なければ phase:ready', () => {
  const cfg = stackCfg();
  cfg.up = [{ name: 'web', serve: 'sleep 30', timeout_sec: 2, ready: { tcp: '{port.web}' } }];
  const res = up(writeConfig(cfg));
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'ready');
  assert.match(res.error, /ready timeout after 2s/);
}, TIMEOUT);

test('up: 同じ state dir に前回の stack が残っていれば先に止めてから起動する', async () => {
  const cfgPath = writeConfig(stackCfg());
  const first = up(cfgPath);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = up(cfgPath);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.ports, first.ports, '前回の stack が止まったので同じ port を取り直せる');
  assert.equal(readFileSync(join(wt, 'down.txt'), 'utf8').trim(), 'down-ran', '前回 stack の down steps が走っている');
}, TIMEOUT);

test('up: 割当候補の port が使用中なら次の空きへずらす', async () => {
  const busy = net.createServer();
  await new Promise((r) => busy.listen(basePort + 7, '127.0.0.1', r));
  try {
    const res = up(writeConfig(stackCfg()));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.ports.web, basePort + 8);
  } finally {
    busy.close();
  }
}, TIMEOUT);

test('up: 旧形式（install_command + dev_command）は移行先を示す phase:config', () => {
  const res = up(writeConfig({
    install_command: 'echo installed > installed.txt',
    dev_command: `node ${join(root, 'srv.mjs')} {port}`,
    base_port: basePort,
  }));
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'config');
  assert.match(res.error, /旧形式/);
  assert.match(res.error, /serve/);
  assert.ok(!existsSync(join(wt, 'installed.txt')), '旧形式のコマンドは実行しない');
});

test('wait: stack が無ければ ok:false', () => {
  const w = cli(['wait', '--state-dir', stateDir, '--wait-sec', '1']);
  assert.equal(w.ok, false);
  assert.match(w.error, /stack が無い/);
});

test('up: config 不正 / state dir が worktree 自身 → phase:config', () => {
  const bad = up(writeConfig({ up: [{ name: 'a', serve: 'x' }] }));
  assert.equal(bad.ok, false);
  assert.equal(bad.phase, 'config');
  assert.match(bad.error, /ready/);

  const self = cli(['up', '--worktree', wt, '--state-dir', wt, '--config', writeConfig(stackCfg())]);
  assert.equal(self.ok, false);
  assert.equal(self.phase, 'config');
  assert.ok(existsSync(wt), 'worktree は消さない');
});

test('up: ready.log の未宣言 {port.<name>} は ready 待ちに入らず phase:config', () => {
  const cfg = stackCfg();
  cfg.up = [{ ...cfg.up[2], ready: { log: 'listening on {port.apl}' } }];
  const res = up(writeConfig(cfg));
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.phase, 'config');
  assert.match(res.error, /apl/);
  assert.ok(!existsSync(join(stateDir, 'spec.json')), 'stack を起動しない');
});

test('up: --config 無しなら worktree の skill-config.json の "dev-flow".ui_verify を読む', () => {
  writeFileSync(join(wt, 'skill-config.json'), JSON.stringify({ 'dev-flow': { ui_verify: { up: [] } } }));
  const res = cli(['up', '--worktree', wt, '--state-dir', stateDir]);
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'config');
  assert.match(res.error, /up は非空 array/);
});

test('down: state が無ければ no-op / usage error は exit 2', () => {
  const d = down();
  assert.deepEqual(d, { ok: true, stopped: false, was_running: false, leftover: [] });
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'bogus'], { stdio: 'pipe' }), (e) => e.status === 2);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'down'], { stdio: 'pipe' }), (e) => e.status === 2);
});

test('extractErrorMessages: JSON の形に依存しすぎず error だけ拾う / テキスト出力にも対応', async () => {
  const { extractErrorMessages } = await import('./ui-verify-stack.mjs');
  assert.deepEqual(extractErrorMessages(JSON.stringify([{ level: 'ERROR', message: 'a' }, { level: 'warning', message: 'b' }])), ['a']);
  assert.deepEqual(extractErrorMessages('[error] boom\n[log] fine\n[pageerror] bad'), ['boom', 'bad']);
  assert.deepEqual(extractErrorMessages(JSON.stringify({ data: { errors: [{ message: 'x' }] } }), { allErrors: true }), ['x']);
});

// agent-browser 0.38.1 の実出力（--json）をそのまま fixture にする
const REAL_LIFECYCLE = { effectiveLaunch: { browserLaunched: true, engine: 'chrome', launchHash: 1 }, launched: false, relaunchedBrowser: false, restartedBackground: false, restoreStatus: 'not_configured', reused: true, saveStatus: 'not_attempted' };
const REAL_CONSOLE_JSON = JSON.stringify({ success: true, data: { lifecycle: REAL_LIFECYCLE, messages: [
  { args: [{ type: 'string', value: 'boom-console' }], text: 'boom-console', type: 'error' },
  { args: [{ type: 'string', value: 'plain-log' }], text: 'plain-log', type: 'log' },
] }, error: null });
const REAL_ERRORS_JSON = JSON.stringify({ success: true, data: { errors: [
  { column: 85, line: 0, text: 'Error: boom-uncaught\n    at http://127.0.0.1:6100/app.js:1:85', url: null },
], lifecycle: REAL_LIFECYCLE }, error: null });

test('extractErrorMessages: agent-browser 0.38.1 実出力の console --json から error レベルだけ拾う', async () => {
  const { extractErrorMessages } = await import('./ui-verify-stack.mjs');
  assert.deepEqual(extractErrorMessages(REAL_CONSOLE_JSON), ['boom-console']);
});

test('extractErrorMessages: agent-browser 0.38.1 実出力の errors --json は level を問わず全件（lifecycle は拾わない）', async () => {
  const { extractErrorMessages } = await import('./ui-verify-stack.mjs');
  const got = extractErrorMessages(REAL_ERRORS_JSON, { allErrors: true });
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.match(got[0], /^Error: boom-uncaught/);
});

// ── test を速く回すための仕掛けが実運用と test 収集に漏れないこと ──────────────────────────

test('POLL_MS: UI_VERIFY_POLL_MS が無ければ状態確認の間隔は実運用の既定 500ms（test だけが縮める）', () => {
  const pollMs = (env) => execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then((m) => process.stdout.write(String(m.POLL_MS)))`,
  ], { encoding: 'utf8', env });
  const prod = { ...process.env };
  delete prod.UI_VERIFY_POLL_MS;
  assert.equal(pollMs(prod), '500');
  assert.equal(pollMs({ ...prod, UI_VERIFY_POLL_MS: TEST_POLL_MS }), TEST_POLL_MS);
});

test('ui-verify-stack-test-helpers.mjs（test 用の共通部分）は vitest の収集対象にならない', async () => {
  const repo = join(here, '..', '..', '..', '..');
  const { default: config } = await import(pathToFileURL(join(repo, 'vitest.config.mjs')).href);
  const collected = (abs) => {
    const rel = relative(repo, abs);
    return config.test.include.some((g) => matchesGlob(rel, g)) && !config.test.exclude.some((g) => matchesGlob(rel, g));
  };
  assert.equal(collected(join(here, 'ui-verify-stack-test-helpers.mjs')), false);
  assert.equal(collected(fileURLToPath(import.meta.url)), true, '同じ判定で test ファイル自身は収集される');
});
