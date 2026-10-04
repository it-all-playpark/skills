// ui-verify-stack.mjs の実プロセス test。fake service は node の http server（孫プロセスとして起動する
// ケースを含む）で、up → 別プロセスからの down → 停止確認、失敗系、ttl、前回 stack の回収を pin する。
// CLI として子プロセスで起動する（supervisor が detached で残る実運用と同じ形）。

import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'ui-verify-stack.mjs');
const TIMEOUT = 60_000;

let root;
let wt;
let stateDir;
let basePort;

function cli(args) {
  const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 90_000 });
  return JSON.parse(out.trim().split('\n').pop());
}

function writeConfig(cfg) {
  const p = join(root, 'cfg.json');
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

const up = (cfgPath, extra = []) => cli(['up', '--worktree', wt, '--state-dir', stateDir, '--issue', '7', '--config', cfgPath, ...extra]);
const down = () => cli(['down', '--state-dir', stateDir, '--timeout-sec', '30']);

function listening(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}

async function get(url) {
  const r = await fetch(url);
  return r.text();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uvs-'));
  wt = join(root, 'wt');
  stateDir = join(wt, '.devflow-tmp', 'ui-verify');
  execFileSync('mkdir', ['-p', wt]);
  // 1000 刻みで最大 3 本割り当てるので 20000〜40999 の帯からランダムに選ぶ
  basePort = 20000 + Math.floor(Math.random() * 18000);
  writeFileSync(join(root, 'srv.mjs'), [
    "import http from 'node:http';",
    'const port = Number(process.argv[2]);',
    "http.createServer((req, res) => res.end(`${process.env.TAG ?? ''}|${process.env.API_URL ?? ''}`))",
    "  .listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));",
  ].join('\n'));
});

afterEach(() => {
  try { down(); } catch { /* best-effort */ }
  rmSync(root, { recursive: true, force: true });
});

function stackCfg(overrides = {}) {
  const srv = join(root, 'srv.mjs');
  return {
    base_port: basePort,
    ports: ['web', 'api'],
    env: { API_URL: 'http://127.0.0.1:{port.api}' },
    up: [
      { name: 'prep', run: 'echo prepared > {state_dir}/prep.txt' },
      // bash -c で 1 段挟み、service の孫プロセスまで process group ごと止まることを確かめる
      { name: 'api', serve: `bash -c 'node ${srv} {port.api}'`, env: { TAG: 'api' }, ready: { tcp: '{port.api}' } },
      { name: 'web', serve: `node ${srv} $UI_VERIFY_PORT_WEB`, env: { TAG: 'web' }, ready: { log: 'listening on' } },
    ],
    down: [{ name: 'cleanup', run: 'echo down-ran > {worktree}/down.txt' }],
    base_url: 'http://127.0.0.1:{port.web}',
    smoke_path: '/home',
    ...overrides,
  };
}

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

test('ttl: teardown が来なくても supervisor が ttl_sec で自ら止める', async () => {
  const res = up(writeConfig(stackCfg({ ttl_sec: 2 })));
  assert.equal(res.ok, true, JSON.stringify(res));
  const until = Date.now() + 20_000;
  let st;
  while (Date.now() < until) {
    st = cli(['status', '--state-dir', stateDir]);
    if (st.phase === 'stopped') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(st.phase, 'stopped');
  assert.equal(st.stop_reason, 'ttl');
  assert.equal(await listening(basePort + 7), false);
}, TIMEOUT);

test('ttl: ttl_sec は ready から数える（起動に ttl より長くかかっても検証の時間が残る）', async () => {
  const base = stackCfg({ ttl_sec: 3 });
  base.up[0] = { name: 'prep', run: 'sleep 4 && echo prepared > {state_dir}/prep.txt' };
  const res = up(writeConfig(base));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.phase, 'ready');
  // ready 直後はまだ動いている（起動時刻から数えると ready の時点で ttl を過ぎている）
  let st = cli(['status', '--state-dir', stateDir]);
  assert.equal(st.phase, 'ready', JSON.stringify(st));
  assert.equal(await listening(basePort + 7), true);
  assert.ok(Date.parse(st.deadline) >= Date.parse(st.ready_at) + 3000, `deadline=${st.deadline} ready_at=${st.ready_at}`);
  // ready から ttl_sec 経つと自ら止まる
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    st = cli(['status', '--state-dir', stateDir]);
    if (st.phase === 'stopped') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(st.phase, 'stopped');
  assert.equal(st.stop_reason, 'ttl');
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

// up の途中（run の実行中 / serve の ready 待ち）に停止要求が来たケース
function slowCfg(overrides = {}) {
  const cfg = stackCfg(overrides);
  cfg.up = [{ name: 'slow', run: 'sleep 20' }, cfg.up[2]];
  return cfg;
}

async function waitStatus(pred, ms = 20_000) {
  const until = Date.now() + ms;
  let st;
  while (Date.now() < until) {
    st = cli(['status', '--state-dir', stateDir]);
    if (pred(st)) return st;
    await new Promise((r) => setTimeout(r, 300));
  }
  return st;
}

test('up: --wait-sec を超えても停止は要求せず phase:starting を返し、wait で ready まで待てる', async () => {
  const cfg = stackCfg();
  cfg.up = [{ name: 'slow', run: 'sleep 3' }, cfg.up[2]];
  const res = up(writeConfig(cfg), ['--wait-sec', '1']);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.phase, 'starting');
  assert.equal(res.wait_ceiling_sec, 600 + 180 + 60, '総上限は up の timeout_sec 合計 + 余裕');
  assert.ok(!existsSync(join(stateDir, 'stop')), 'starting では停止を要求しない');

  const w = cli(['wait', '--state-dir', stateDir, '--wait-sec', '30']);
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.phase, 'ready');
  assert.equal(w.base_url, res.base_url);
  assert.equal(await get(w.base_url), `web|http://127.0.0.1:${basePort + 7 + 1000}`);
}, TIMEOUT);

test('up: run の実行中に down されたら即座に止まり、後続の serve は起動しない', async () => {
  const res = up(writeConfig(slowCfg()), ['--wait-sec', '2']);
  assert.equal(res.phase, 'starting', JSON.stringify(res));

  const d = cli(['down', '--state-dir', stateDir, '--timeout-sec', '5']);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.stopped, true);
  assert.equal(d.stop_reason, 'requested');
  const st = cli(['status', '--state-dir', stateDir]);
  assert.equal(st.phase, 'stopped');
  const step = (n) => st.steps.find((s) => s.name === n);
  assert.equal(step('slow').status, 'failed');
  assert.match(step('slow').error, /stopped \(requested\)/);
  assert.equal(step('web').status, 'pending', '停止要求後に serve を起動しない');
  assert.equal(readFileSync(join(wt, 'down.txt'), 'utf8').trim(), 'down-ran', 'down steps は走る');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await listening(basePort + 7), false);
}, TIMEOUT);

test('up: serve の ready 待ち中に down されたら止まる', async () => {
  const cfg = stackCfg();
  cfg.up = [{ name: 'web', serve: 'sleep 30', ready: { tcp: '{port.web}' } }];
  const res = up(writeConfig(cfg), ['--wait-sec', '1']);
  assert.equal(res.phase, 'starting', JSON.stringify(res));
  const d = cli(['down', '--state-dir', stateDir, '--timeout-sec', '5']);
  assert.equal(d.ok, true, JSON.stringify(d));
  const st = cli(['status', '--state-dir', stateDir]);
  assert.match(st.steps.find((s) => s.name === 'web').error, /stopped before ready \(requested\)/);
}, TIMEOUT);

test('ttl: up の途中では ttl_sec で止まらず、ready 前の期限は up の総上限 + ttl_sec', async () => {
  const res = up(writeConfig(slowCfg({ ttl_sec: 2 })), ['--wait-sec', '1']);
  assert.equal(res.phase, 'starting', JSON.stringify(res));
  await new Promise((r) => setTimeout(r, 3500));
  const st = cli(['status', '--state-dir', stateDir]);
  assert.equal(st.phase, 'starting', `ttl_sec を過ぎても up の途中では止まらない: ${JSON.stringify(st)}`);
  const spec = JSON.parse(readFileSync(join(stateDir, 'spec.json'), 'utf8'));
  assert.equal(
    Date.parse(st.deadline) - Date.parse(st.started_at),
    (spec.up_ceiling_sec + 2) * 1000,
    'ready 前の期限は各 step の timeout 合計（up_ceiling_sec）の上に ttl_sec を足した保険',
  );
  const d = cli(['down', '--state-dir', stateDir, '--timeout-sec', '5']);
  assert.equal(d.ok, true, JSON.stringify(d));
}, TIMEOUT);

test('wait: 総上限（wait_ceiling_sec）を超えたら stop を要求して phase:timeout、続く down で止まる', async () => {
  const res = up(writeConfig(slowCfg()), ['--wait-sec', '1']);
  assert.equal(res.phase, 'starting', JSON.stringify(res));
  const specPath = join(stateDir, 'spec.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  writeFileSync(specPath, JSON.stringify({ ...spec, up_ceiling_sec: 1 }));

  const w = cli(['wait', '--state-dir', stateDir, '--wait-sec', '10']);
  assert.equal(w.ok, false, JSON.stringify(w));
  assert.equal(w.phase, 'timeout');
  assert.match(w.error, /総上限 1s/);
  const d = cli(['down', '--state-dir', stateDir, '--timeout-sec', '5']);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(cli(['status', '--state-dir', stateDir]).steps.find((s) => s.name === 'web').status, 'pending');
}, TIMEOUT);

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

// ── login / smoke（agent-browser は fake で置き換え、argv とシェル非経由を確かめる）──────────

const FAKE_AB = `#!/usr/bin/env node
// fake agent-browser: argv を JSON 1 行で記録し、決め打ちの応答を返す
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AB_LOG, JSON.stringify(argv) + '\\n');
const sub = argv.filter((a, i) => !(a.startsWith('--') || argv[i - 1] === '--session'))[0];
if (argv.some((a) => a.includes('FAIL'))) { process.stderr.write('element not found'); process.exit(1); }
// FAKE_AB_FAIL_SUB に一致する subcommand を FAKE_AB_FAIL_MSG（実物の文言）で失敗させる
if (process.env.FAKE_AB_FAIL_SUB === sub) { process.stderr.write(process.env.FAKE_AB_FAIL_MSG || 'failed'); process.exit(1); }
if (sub === 'console' && !argv.includes('--clear')) {
  process.stdout.write(JSON.stringify({ success: true, data: { messages: [
    { type: 'error', text: 'Boom from page' },
    { type: 'log', text: 'just a log' },
    { type: 'error', text: '[HMR] connected' },
    { type: 'error', text: 'ResizeObserver loop limit exceeded' },
  ] } }));
} else if (sub === 'errors' && !argv.includes('--clear')) {
  process.stdout.write(JSON.stringify({ success: true, data: { errors: [{ message: 'Uncaught TypeError: x is undefined' }] } }));
} else if (sub === 'screenshot') {
  fs.writeFileSync(argv[argv.length - 1], 'png');
}
`;

function setupFakeBrowser() {
  const bin = join(root, 'fake-agent-browser');
  writeFileSync(bin, FAKE_AB.replace(/^\n/, ''), { mode: 0o755 });
  const log = join(root, 'ab.log');
  writeFileSync(log, '');
  return {
    env: { ...process.env, UI_VERIFY_AGENT_BROWSER: bin, FAKE_AB_LOG: log },
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

function cliWithEnv(args, env) {
  const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 90_000, env });
  return JSON.parse(out.trim().split('\n').pop());
}

const LOGIN = [
  ['open', '{base_url}/login'],
  ['fill', 'input[name=email]', 'e2e-owner@test.local; rm -rf /'],
  ['click', 'button[type=submit]'],
];

test('smoke: login（argv をシェルを通さずそのまま）→ clear → open → networkidle → errors/console → screenshot を UIVERIFY 形で返す', () => {
  const fake = setupFakeBrowser();
  const res = up(writeConfig(stackCfg({ login: { commands: LOGIN }, console_ignore: ['\\[HMR\\]', 'ResizeObserver'] })));
  assert.equal(res.ok, true, JSON.stringify(res));
  const r = cliWithEnv(['smoke', '--state-dir', stateDir, '--session', 'devflow-7'], fake.env);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, 'smoke');
  assert.deepEqual(r.checks.map((c) => [c.action, c.result]), [
    ['login', 'pass'], [`open ${res.smoke_url}`, 'pass'], ['wait --load networkidle', 'pass'],
  ]);
  // level=error のみ。console_ignore に当たるものは機械的に除外。page error は level を問わず拾う
  assert.deepEqual(r.console_errors, ['Uncaught TypeError: x is undefined', 'Boom from page']);
  assert.match(r.summary, /2 件除外/);
  assert.deepEqual(r.screenshots, [join(stateDir, 'smoke.png')]);
  assert.ok(existsSync(join(stateDir, 'smoke.png')));

  const calls = fake.calls();
  assert.ok(calls.every((c) => c[0] === '--session' && c[1] === 'devflow-7'), '全呼び出しに --session');
  const plain = calls.map((c) => c.slice(2).filter((a) => a !== '--json'));
  assert.deepEqual(plain.slice(0, 3), [
    ['open', `${res.base_url}/login`],
    ['fill', 'input[name=email]', 'e2e-owner@test.local; rm -rf /'], // シェルを通らないので 1 引数のまま
    ['click', 'button[type=submit]'],
  ]);
  assert.deepEqual(plain.slice(3), [
    ['console', '--clear'], ['errors', '--clear'],
    ['open', res.smoke_url], ['wait', '--load', 'networkidle'],
    ['errors'], ['console'], ['screenshot', join(stateDir, 'smoke.png')],
  ]);
}, TIMEOUT);

test('smoke: login が失敗したら open せず ok:false と失敗したコマンドを返す', () => {
  const fake = setupFakeBrowser();
  const res = up(writeConfig(stackCfg({ login: { commands: [['open', '{base_url}/login'], ['click', '#FAIL']] } })));
  assert.equal(res.ok, true, JSON.stringify(res));
  const r = cliWithEnv(['smoke', '--state-dir', stateDir, '--session', 's'], fake.env);
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.map((c) => [c.action, c.result]), [['login', 'fail']]);
  assert.match(r.checks[0].evidence, /click #FAIL: element not found/);
  assert.equal(r.env_failure, undefined);
  assert.equal(fake.calls().length, 2, 'login の失敗で打ち切る');
}, TIMEOUT);

test('smoke: smoke_url の open 失敗（接続はできた）は ok:false のアプリ起因（env_failure なし）', () => {
  const fake = setupFakeBrowser();
  const res = up(writeConfig(stackCfg({ smoke_path: '/FAIL' })));
  assert.equal(res.ok, true, JSON.stringify(res));
  const r = cliWithEnv(['smoke', '--state-dir', stateDir, '--session', 's'], fake.env);
  assert.equal(r.ok, false);
  assert.equal(r.env_failure, undefined);
  assert.equal(r.checks.at(-1).result, 'fail');
  assert.match(r.summary, /load 失敗/);
}, TIMEOUT);

test('smoke: networkidle 待ちの失敗は非致命 — check は skip で理由を evidence に残し、ok:true と summary が一致する', () => {
  const fake = setupFakeBrowser();
  const res = up(writeConfig(stackCfg()));
  assert.equal(res.ok, true, JSON.stringify(res));
  const env = { ...fake.env, FAKE_AB_FAIL_SUB: 'wait', FAKE_AB_FAIL_MSG: 'Timeout 25000ms exceeded' };
  const r = cliWithEnv(['smoke', '--state-dir', stateDir, '--session', 's'], env);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.env_failure, undefined);
  const w = r.checks.find((c) => c.action === 'wait --load networkidle');
  assert.equal(w.result, 'skip');
  assert.match(w.evidence, /networkidle/);
  assert.match(w.evidence, /Timeout 25000ms exceeded/);
  assert.ok(!r.checks.some((c) => c.result === 'fail'), 'fail の check を残さない（workflow が major finding にする）');
  assert.match(r.summary, /load ok（networkidle 待ちは失敗）/);
}, TIMEOUT);

test('smoke: smoke_url に接続できない（net::ERR_CONNECTION_REFUSED）は env_failure', () => {
  const fake = setupFakeBrowser();
  const res = up(writeConfig(stackCfg()));
  assert.equal(res.ok, true, JSON.stringify(res));
  const env = { ...fake.env, FAKE_AB_FAIL_SUB: 'open', FAKE_AB_FAIL_MSG: '✗ Navigation failed: net::ERR_CONNECTION_REFUSED' };
  const r = cliWithEnv(['smoke', '--state-dir', stateDir, '--session', 's'], env);
  assert.equal(r.ok, false);
  assert.equal(r.env_failure, true);
  assert.match(r.summary, /ERR_CONNECTION_REFUSED/);
}, TIMEOUT);

test('smoke / login: agent-browser が無いのは env_failure', () => {
  const res = up(writeConfig(stackCfg({ login: { commands: LOGIN } })));
  assert.equal(res.ok, true, JSON.stringify(res));
  const env = { ...process.env, UI_VERIFY_AGENT_BROWSER: join(root, 'no-such-agent-browser') };
  const s = cliWithEnv(['smoke', '--state-dir', stateDir, '--session', 's'], env);
  assert.equal(s.ok, false);
  assert.equal(s.env_failure, true, JSON.stringify(s));
  assert.match(s.summary, /agent-browser/);
  const l = cliWithEnv(['login', '--state-dir', stateDir, '--session', 's'], env);
  assert.equal(l.ok, false);
  assert.equal(l.env_failure, true, JSON.stringify(l));
}, TIMEOUT);

test('smoke / login: stack が無い・止まった（ttl / down）・supervisor が居ないのは env_failure', () => {
  const fake = setupFakeBrowser();
  const none = cliWithEnv(['smoke', '--state-dir', stateDir, '--session', 's'], fake.env);
  assert.equal(none.ok, false);
  assert.equal(none.env_failure, true);
  assert.match(none.summary, /stack が無い/);

  const res = up(writeConfig(stackCfg({ login: { commands: LOGIN } })));
  assert.equal(res.ok, true, JSON.stringify(res));
  const stackPath = join(stateDir, 'stack.json');
  const stack = JSON.parse(readFileSync(stackPath, 'utf8'));
  // supervisor が消えたのに phase が ready のまま残っている
  writeFileSync(stackPath, JSON.stringify({ ...stack, supervisor_pid: 2 ** 22 + 12345 }));
  const dead = cliWithEnv(['login', '--state-dir', stateDir, '--session', 's'], fake.env);
  assert.equal(dead.ok, false);
  assert.equal(dead.env_failure, true);
  assert.match(dead.error, /supervisor/);
  writeFileSync(stackPath, JSON.stringify(stack));

  assert.equal(down().ok, true);
  const stopped = cliWithEnv(['smoke', '--state-dir', stateDir, '--session', 's'], fake.env);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.env_failure, true);
  assert.match(stopped.summary, /ready でない/);
  assert.equal(fake.calls().length, 0, 'stack が使えないなら agent-browser を呼ばない');
}, TIMEOUT);

test('login: 接続できない（net::ERR_CONNECTION_REFUSED）は env_failure、操作の失敗はアプリ起因', () => {
  const fake = setupFakeBrowser();
  const res = up(writeConfig(stackCfg({ login: { commands: LOGIN } })));
  assert.equal(res.ok, true, JSON.stringify(res));
  const env = { ...fake.env, FAKE_AB_FAIL_SUB: 'open', FAKE_AB_FAIL_MSG: '✗ Navigation failed: net::ERR_CONNECTION_REFUSED' };
  const l = cliWithEnv(['login', '--state-dir', stateDir, '--session', 's'], env);
  assert.equal(l.ok, false);
  assert.equal(l.env_failure, true);
  const s = cliWithEnv(['smoke', '--state-dir', stateDir, '--session', 's'], env);
  assert.equal(s.ok, false);
  assert.equal(s.env_failure, true, 'smoke 内の login が環境起因で落ちたら smoke も env_failure');
}, TIMEOUT);

test('login: 宣言が無ければ skipped、stack が ready でなければ ok:false', () => {
  const fake = setupFakeBrowser();
  const none = cliWithEnv(['login', '--state-dir', stateDir, '--session', 's'], fake.env);
  assert.equal(none.ok, false);
  assert.match(none.error, /stack が無い/);

  const res = up(writeConfig(stackCfg()));
  assert.equal(res.ok, true, JSON.stringify(res));
  const r = cliWithEnv(['login', '--state-dir', stateDir, '--session', 's'], fake.env);
  assert.deepEqual(r, { ok: true, skipped: true, ran: 0, total: 0 });
  assert.equal(fake.calls().length, 0);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'login', '--state-dir', stateDir], { stdio: 'pipe' }), (e) => e.status === 2);
}, TIMEOUT);

test('login: 宣言どおり順に実行し、失敗位置を返す', () => {
  const fake = setupFakeBrowser();
  const res = up(writeConfig(stackCfg({ login: { commands: [['open', '{base_url}/login'], ['fill', '#FAIL', 'x'], ['click', '#never']] } })));
  assert.equal(res.ok, true, JSON.stringify(res));
  const r = cliWithEnv(['login', '--state-dir', stateDir, '--session', 's'], fake.env);
  assert.equal(r.ok, false);
  assert.equal(r.ran, 1);
  assert.equal(r.total, 3);
  assert.deepEqual(r.failed, { index: 1, command: 'fill #FAIL x' });
  assert.equal(r.env_failure, undefined, 'セレクタが見つからない等の操作の失敗はアプリ起因');
}, TIMEOUT);

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
