import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

import { buildJournalHandoffCommand, buildJournalHandoffPayload, repoFromGithubUrl } from './journal-handoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// AC-10: run the generated command for real through bash, with CLAUDE_JOURNAL_DIR
// pointed at a scratch dir, to verify stable-effect-ID naming + atomic write behavior
// (not just the literal command string).
function withScratchJournalDir(fn) {
  const dir = mkdtempSync(join(os.tmpdir(), 'journal-handoff-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHandoffCommand(cmd, journalDir) {
  execFileSync('bash', ['-c', cmd], {
    env: { ...process.env, CLAUDE_JOURNAL_DIR: journalDir },
    encoding: 'utf8',
  });
}

function listPending(journalDir) {
  return readdirSync(join(journalDir, 'pending'));
}

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

test('buildJournalHandoffCommand writes payload via mktemp/mv atomic write with stable effect-ID naming', () => {
  const cmd = buildJournalHandoffCommand({
    prefix: 'priterate',
    id: 251,
    payload: '{"ok":true}',
  });

  assert.equal(
    cmd,
    'mkdir -p ${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}/pending'
      + ' && __jh_tmp=$(mktemp "${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}/pending/.priterate-251.XXXXXX")'
      + ' && cat > "$__jh_tmp" <<\'TELEMETRY_EOF\''
      + ' && __jh_id=$(shasum -a 256 "$__jh_tmp" | cut -c1-16)'
      + ' && mv -f "$__jh_tmp" "${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}/pending/priterate-251-effect-${__jh_id}.json"'
      + '\n{"ok":true}\nTELEMETRY_EOF',
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

test('AC-10: executing the command produces exactly one valid-JSON effect file matching the payload', () => {
  withScratchJournalDir((journalDir) => {
    const payload = '{"skill":"pr-iterate","outcome":"success"}';
    const cmd = buildJournalHandoffCommand({ prefix: 'priterate', id: 251, payload });

    runHandoffCommand(cmd, journalDir);

    const files = listPending(journalDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^priterate-251-effect-[0-9a-f]{16}\.json$/);
    // heredoc writes payload followed by its own line terminator (pre-existing
    // behavior, unrelated to this task's atomic-write change).
    const content = readFileSync(join(journalDir, 'pending', files[0]), 'utf8');
    assert.equal(content, `${payload}\n`);
    assert.doesNotThrow(() => JSON.parse(content));
  });
});

test('AC-10: re-running with an identical payload does not create a duplicate entry (idempotent overwrite)', () => {
  withScratchJournalDir((journalDir) => {
    const payload = '{"skill":"dev-flow","outcome":"success","issue":412}';
    const cmd = buildJournalHandoffCommand({ prefix: 'devflow', id: 412, payload });

    runHandoffCommand(cmd, journalDir);
    const firstListing = listPending(journalDir);
    runHandoffCommand(cmd, journalDir);
    const secondListing = listPending(journalDir);

    assert.equal(firstListing.length, 1);
    assert.deepEqual(secondListing, firstListing);
    const content = readFileSync(join(journalDir, 'pending', secondListing[0]), 'utf8');
    assert.equal(content, `${payload}\n`);
  });
});

test('AC-10: a different payload for the same prefix/id produces a distinct effect file (no collision)', () => {
  withScratchJournalDir((journalDir) => {
    const cmdA = buildJournalHandoffCommand({
      prefix: 'devflow',
      id: 412,
      payload: '{"skill":"dev-flow","outcome":"success"}',
    });
    const cmdB = buildJournalHandoffCommand({
      prefix: 'devflow',
      id: 412,
      payload: '{"skill":"dev-flow","outcome":"failure"}',
    });

    runHandoffCommand(cmdA, journalDir);
    runHandoffCommand(cmdB, journalDir);

    const files = listPending(journalDir).sort();
    assert.equal(files.length, 2);
    assert.notEqual(files[0], files[1]);
  });
});

test('AC-10: no dot-prefixed temp file remains after execution (atomic mv leaves no partial JSON)', () => {
  withScratchJournalDir((journalDir) => {
    const cmd = buildJournalHandoffCommand({
      prefix: 'priterate',
      id: 99,
      payload: '{"skill":"pr-iterate","outcome":"success"}',
    });

    runHandoffCommand(cmd, journalDir);

    const files = listPending(journalDir);
    assert.ok(files.every((f) => !f.startsWith('.')));
    assert.ok(files.every((f) => f.endsWith('.json')));
  });
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
