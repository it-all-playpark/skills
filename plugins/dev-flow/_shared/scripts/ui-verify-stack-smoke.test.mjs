// ui-verify-stack.mjs の login / smoke を実プロセスの stack に対して pin する（agent-browser は fake で
// 置き換え、argv とシェル非経由を確かめる）。

import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOGIN, SCRIPT, TIMEOUT, cliWithEnv, down, root, setupFakeBrowser, setupStack, stackCfg, stateDir, teardownStack, up, writeConfig,
} from './ui-verify-stack-test-helpers.mjs';

beforeEach(setupStack);
afterEach(teardownStack);

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
