// ui-verify-stack.mjs の up の途中（run の実行中 / serve の ready 待ち）に来た停止要求と ttl を
// 実プロセスで pin する。

import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TIMEOUT, basePort, cli, listening, setupStack, slowCfg, stackCfg, stateDir, teardownStack, up, writeConfig, wt,
} from './ui-verify-stack-test-helpers.mjs';

beforeEach(setupStack);
afterEach(teardownStack);

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
