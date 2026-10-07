// ui-verify-stack.mjs の wait（up が --wait-sec 超過で phase:starting を返した後の待ち直しと総上限）を
// 実プロセスで pin する。

import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TIMEOUT, basePort, cli, get, setupStack, slowCfg, stackCfg, stateDir, teardownStack, up, writeConfig,
} from './ui-verify-stack-test-helpers.mjs';

beforeEach(setupStack);
afterEach(teardownStack);

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
