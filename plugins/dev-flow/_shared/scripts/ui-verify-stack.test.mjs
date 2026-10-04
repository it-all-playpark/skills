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

test('up: 旧形式（install_command + dev_command）も同じ経路で起動できる', async () => {
  const res = up(writeConfig({
    install_command: 'echo installed > installed.txt',
    dev_command: `node ${join(root, 'srv.mjs')} {port}`,
    base_port: basePort,
  }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.legacy, true);
  assert.equal(res.port, basePort + 7);
  assert.ok(existsSync(join(wt, 'installed.txt')), 'install は worktree を cwd に走る');
}, TIMEOUT);

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
