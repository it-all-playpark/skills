// ui-verify-stack.mjs の ttl（teardown が来なくても supervisor が自ら止める）を実プロセスで pin する。

import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  TIMEOUT, basePort, cli, listening, setupStack, stackCfg, stateDir, teardownStack, up, writeConfig,
} from './ui-verify-stack-test-helpers.mjs';

beforeEach(setupStack);
afterEach(teardownStack);

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
