import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildJournalHandoffCommand, buildJournalHandoffPayload, repoFromGithubUrl } from './journal-handoff.mjs';

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

test('buildJournalHandoffPayload includes repo and pr_number top-level between issue and journal_sh', () => {
  const payload = buildJournalHandoffPayload({
    skill: 'dev-flow',
    outcome: 'success',
    issue: 309,
    repo: 'acme/skills',
    pr_number: 12,
    telemetry: { merge_tier: 'REVIEW' },
  });

  assert.equal(
    payload,
    '{"skill":"dev-flow","outcome":"success","issue":309,"repo":"acme/skills","pr_number":12,"telemetry":{"merge_tier":"REVIEW"}}',
  );
});

test('buildJournalHandoffPayload omits repo/pr_number when not provided', () => {
  const payload = buildJournalHandoffPayload({
    skill: 'dev-flow',
    outcome: 'success',
    issue: 309,
    telemetry: { merge_tier: 'REVIEW' },
  });

  assert.ok(!payload.includes('"repo"'));
  assert.ok(!payload.includes('"pr_number"'));
});

test('repoFromGithubUrl parses owner/name from GitHub pull request and repo URLs', () => {
  assert.equal(repoFromGithubUrl('https://github.com/acme/skills/pull/12'), 'acme/skills');
  assert.equal(repoFromGithubUrl('https://github.com/acme/skills'), 'acme/skills');
});

test('repoFromGithubUrl returns null for non-GitHub or malformed input', () => {
  assert.equal(repoFromGithubUrl('http://x'), null);
  assert.equal(repoFromGithubUrl(''), null);
  assert.equal(repoFromGithubUrl(null), null);
  assert.equal(repoFromGithubUrl('https://example.com/a/b'), null);
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
