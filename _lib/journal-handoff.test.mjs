import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildJournalHandoffCommand, buildJournalHandoffPayload } from './journal-handoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

test('buildJournalHandoffPayload creates compact handoff JSON', () => {
  const payload = buildJournalHandoffPayload({
    skill: 'pr-iterate',
    outcome: 'success',
    args: 'pr=251',
    telemetry: { merge_tier: 'PR_ITERATE', iterate_status: 'lgtm' },
  });

  assert.equal(
    payload,
    '{"skill":"pr-iterate","outcome":"success","args":"pr=251","telemetry":{"merge_tier":"PR_ITERATE","iterate_status":"lgtm"}}',
  );
});

test('buildJournalHandoffCommand writes payload to pending dir with safe filename', () => {
  const cmd = buildJournalHandoffCommand({
    prefix: 'priterate',
    id: 251,
    payload: '{"ok":true}',
  });

  assert.equal(
    cmd,
    "mkdir -p ~/.claude/journal/pending && cat > ~/.claude/journal/pending/priterate-251-$(date +%s).json <<'TELEMETRY_EOF'\n{\"ok\":true}\nTELEMETRY_EOF",
  );
});

test('buildJournalHandoffCommand rejects unsafe filename parts', () => {
  assert.throws(
    () => buildJournalHandoffCommand({ prefix: 'bad/prefix', id: 251, payload: '{}' }),
    /invalid prefix/,
  );
  assert.throws(
    () => buildJournalHandoffCommand({ prefix: 'priterate', id: '251;rm', payload: '{}' }),
    /invalid id/,
  );
});

test('workflows construct journal commands through the canonical helper', () => {
  const devFlow = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  const prIterate = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

  assert.equal(
    (devFlow.match(/const journalCmd = buildJournalHandoffCommand\(\{ prefix: 'devflow'/g) ?? []).length,
    2,
  );
  assert.equal(
    (prIterate.match(/const journalCmd = buildJournalHandoffCommand\(\{ prefix: 'priterate'/g) ?? []).length,
    1,
  );
  assert.ok(!devFlow.includes('const journalCmd = `mkdir -p ~/.claude/journal/pending'));
  assert.ok(!prIterate.includes('journal.sh log pr-iterate'));
});
