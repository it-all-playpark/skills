// ui-verify-stack*.test.mjs が共有する fixture と CLI 呼び出し。test 本体ではない（名前が *.test.mjs で
// 終わらないので vitest の収集対象にならない）。
//
// test は 1 ファイル内では直列に走るため、実プロセスの stack を up → down する test を複数ファイルに分けて
// ファイル間で並列にしている。root / wt / stateDir / basePort は live binding で、各 test ファイルの
// beforeEach(setupStack) が test ごとに作り直す。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SCRIPT = join(here, 'ui-verify-stack.mjs');
export const TIMEOUT = 60_000;
// stack の状態確認（ready / stop file / supervisor の生死）の間隔だけを縮める。ttl_sec / timeout_sec は
// 各 test が宣言した値のまま効く。
export const TEST_POLL_MS = '50';

export let root;
export let wt;
export let stateDir;
export let basePort;

export function cli(args) {
  const out = execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 90_000, env: { ...process.env, UI_VERIFY_POLL_MS: TEST_POLL_MS },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

export function writeConfig(cfg) {
  const p = join(root, 'cfg.json');
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

export const up = (cfgPath, extra = []) => cli(['up', '--worktree', wt, '--state-dir', stateDir, '--issue', '7', '--config', cfgPath, ...extra]);
export const down = () => cli(['down', '--state-dir', stateDir, '--timeout-sec', '30']);

export function listening(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}

export async function get(url) {
  const r = await fetch(url);
  return r.text();
}

export function setupStack() {
  root = mkdtempSync(join(tmpdir(), 'uvs-'));
  wt = join(root, 'wt');
  stateDir = join(wt, '.devflow-tmp', 'ui-verify');
  execFileSync('mkdir', ['-p', wt]);
  // 1000 刻みで最大 3 本割り当てる（+ 使用中ならずらす分）。Linux の ephemeral 帯（32768〜）に掛かると、
  // 並列に走る他 test の connect / ready 確認が割り当て済み port を送信元に取り、serve が EADDRINUSE で落ちる。
  // 帯の上端 + 2000 + ずらし幅が 32768 未満に収まる 10000〜29999 から選ぶ。
  basePort = 10000 + Math.floor(Math.random() * 20000);
  writeFileSync(join(root, 'srv.mjs'), [
    "import http from 'node:http';",
    'const port = Number(process.argv[2]);',
    "http.createServer((req, res) => res.end(`${process.env.TAG ?? ''}|${process.env.API_URL ?? ''}`))",
    "  .listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));",
  ].join('\n'));
}

export function teardownStack() {
  try { down(); } catch { /* best-effort */ }
  rmSync(root, { recursive: true, force: true });
}

export function stackCfg(overrides = {}) {
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

// up の途中（run の実行中 / serve の ready 待ち）に停止要求が来たケース
export function slowCfg(overrides = {}) {
  const cfg = stackCfg(overrides);
  cfg.up = [{ name: 'slow', run: 'sleep 20' }, cfg.up[2]];
  return cfg;
}

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

export function setupFakeBrowser() {
  const bin = join(root, 'fake-agent-browser');
  writeFileSync(bin, FAKE_AB.replace(/^\n/, ''), { mode: 0o755 });
  const log = join(root, 'ab.log');
  writeFileSync(log, '');
  return {
    env: { ...process.env, UI_VERIFY_AGENT_BROWSER: bin, FAKE_AB_LOG: log },
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

export function cliWithEnv(args, env) {
  const out = execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 90_000, env: { ...env, UI_VERIFY_POLL_MS: TEST_POLL_MS },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

export const LOGIN = [
  ['open', '{base_url}/login'],
  ['fill', 'input[name=email]', 'e2e-owner@test.local; rm -rf /'],
  ['click', 'button[type=submit]'],
];
