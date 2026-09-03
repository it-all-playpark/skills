import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AGENT_NAMESPACE, nsAgentOpts } from './agent-namespace.mjs';

test('nsAgentOpts: bare 論理名へ plugin namespace を付与する', () => {
  const out = nsAgentOpts({ agentType: 'dev-runner-haiku-ro', label: 'setup-base', phase: 'Setup' });
  assert.equal(out.agentType, 'dev-flow:dev-runner-haiku-ro');
});

test('nsAgentOpts: agentType 以外の opts は素通しする', () => {
  const schema = { type: 'object' };
  const out = nsAgentOpts({ agentType: 'implementer', label: 'impl:1', phase: 'Implement', schema, retryOnContractViolation: true });
  assert.equal(out.label, 'impl:1');
  assert.equal(out.phase, 'Implement');
  assert.equal(out.schema, schema);
  assert.equal(out.retryOnContractViolation, true);
});

test('nsAgentOpts: 入力 opts を破壊しない（複製を返す）', () => {
  const input = { agentType: 'evaluator', label: 'eval#1' };
  const out = nsAgentOpts(input);
  assert.equal(input.agentType, 'evaluator');
  assert.notEqual(out, input);
});

test('nsAgentOpts: agentType 欠落は throw する（fail-closed）', () => {
  assert.throws(() => nsAgentOpts({ label: 'no-type' }), /opts\.agentType が必要/);
  assert.throws(() => nsAgentOpts({ agentType: '' }), /opts\.agentType が必要/);
  assert.throws(() => nsAgentOpts({ agentType: '   ' }), /opts\.agentType が必要/);
  assert.throws(() => nsAgentOpts(undefined), /opts\.agentType が必要/);
  assert.throws(() => nsAgentOpts(null), /opts\.agentType が必要/);
});

test('nsAgentOpts: 既に namespace 付きの agentType は throw する（二重付与防止）', () => {
  assert.throws(
    () => nsAgentOpts({ agentType: 'dev-flow:evaluator' }),
    /bare な論理名で渡す/,
  );
});

test('AGENT_NAMESPACE: plugin 名と一致する', () => {
  assert.equal(AGENT_NAMESPACE, 'dev-flow:');
});
