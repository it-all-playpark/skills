import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

import {
  buildJournalFinalizeCommand,
  buildJournalHandoffInstr,
  buildJournalHandoffPayload,
  repoFromGithubUrl,
} from './journal-handoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// issue #433 regression fixture: a payload that stresses the multi-escaping class the
// Write-tool verbatim pattern is meant to eliminate — a Japanese test name, a backtick-quoted
// shell anchor, and a JSON string value whose content is itself an escaped JSON string
// (mirrors the devflow-411 malformed-park incident shape, but valid here).
const EDGE_CASE_PAYLOAD = JSON.stringify({
  skill: 'dev-flow',
  outcome: 'success',
  telemetry: {
    vdelta_verdicts: [
      {
        ac: 'AC-1',
        name: '日本語テスト名の検証',
        anchor: '`vdelta show run_x --raw`',
        raw: '{"verdict":"{\\"transitions\\":{\\"new_fail\\":[]}}"}',
      },
    ],
  },
});

// AC-1/AC-2: run the generated finalize command for real through bash, with
// CLAUDE_JOURNAL_DIR pointed at a scratch dir, to verify jq validation + stable-effect-ID
// naming + atomic write behavior (not just the literal command string).
function withScratchJournalDir(fn) {
  const dir = mkdtempSync(join(os.tmpdir(), 'journal-handoff-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTempPayloadFile(content) {
  const dir = mkdtempSync(join(os.tmpdir(), 'journal-handoff-payload-'));
  const file = join(dir, 'payload.json');
  writeFileSync(file, content, 'utf8');
  return { dir, file };
}

// Simulates the agent step: buildJournalFinalizeCommand returns a command containing the
// literal placeholder `<PAYLOAD_FILE>`; the caller substitutes it with a real path (in
// production this is done by the agent per buildJournalHandoffInstr's instructions).
function runFinalize({ prefix, id, payloadFile, journalDir }) {
  const cmd = buildJournalFinalizeCommand({ prefix, id }).split('<PAYLOAD_FILE>').join(payloadFile);
  execFileSync('bash', ['-c', cmd], {
    env: { ...process.env, CLAUDE_JOURNAL_DIR: journalDir },
    encoding: 'utf8',
  });
}

function listPending(journalDir) {
  try {
    return readdirSync(join(journalDir, 'pending'));
  } catch {
    return [];
  }
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

// ---- buildJournalHandoffInstr ----

test('buildJournalHandoffInstr embeds the payload verbatim between delimiters, including Japanese/backtick/nested-escaped-JSON edge cases', () => {
  const instr = buildJournalHandoffInstr({ prefix: 'devflow', id: 433, payload: EDGE_CASE_PAYLOAD });
  const match = instr.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(match, 'expected instr to contain the delimited payload block');
  assert.equal(match[1], EDGE_CASE_PAYLOAD);
});

test('buildJournalHandoffInstr instructs Write tool usage and forbids passing the payload through shell', () => {
  const instr = buildJournalHandoffInstr({ prefix: 'devflow', id: 433, payload: '{"ok":true}' });
  assert.ok(instr.includes('Write tool'));
  assert.ok(instr.includes('echo'));
  assert.ok(instr.includes('printf'));
  assert.ok(instr.includes('heredoc'));
});

test('buildJournalHandoffInstr never includes the payload outside the delimited block (finalize command stays payload-free)', () => {
  const instr = buildJournalHandoffInstr({ prefix: 'devflow', id: 433, payload: EDGE_CASE_PAYLOAD });
  const afterEnd = instr.slice(instr.indexOf('<<<JOURNAL_HANDOFF_BODY_END>>>'));
  assert.ok(!afterEnd.includes(EDGE_CASE_PAYLOAD));
});

test('buildJournalHandoffInstr embeds the buildJournalFinalizeCommand result with a substitute-and-run + fail-open instruction', () => {
  const instr = buildJournalHandoffInstr({ prefix: 'devflow', id: 433, payload: '{"ok":true}' });
  const finalizeCmd = buildJournalFinalizeCommand({ prefix: 'devflow', id: 433 });
  assert.ok(instr.includes(finalizeCmd));
  assert.ok(instr.includes('<PAYLOAD_FILE>'));
  assert.ok(instr.includes('実パスに置換'));
  assert.ok(instr.includes('logged:false'));
});

test('buildJournalHandoffInstr throws when payload is null', () => {
  assert.throws(
    () => buildJournalHandoffInstr({ prefix: 'devflow', id: 433, payload: null }),
    /payload is required/,
  );
});

// ---- buildJournalFinalizeCommand ----

test('buildJournalFinalizeCommand rejects unsafe filename parts', () => {
  assert.throws(
    () => buildJournalFinalizeCommand({ prefix: 'bad/prefix', id: 251 }),
    /invalid prefix/,
  );
  assert.throws(
    () => buildJournalFinalizeCommand({ prefix: 'priterate', id: '251;rm' }),
    /invalid id/,
  );
});

test('AC-1/AC-2: executing the finalize command against a real payload file produces exactly one valid-JSON effect file matching the payload', () => {
  withScratchJournalDir((journalDir) => {
    const { dir, file } = writeTempPayloadFile(EDGE_CASE_PAYLOAD);
    try {
      runFinalize({ prefix: 'devflow', id: 433, payloadFile: file, journalDir });

      const files = listPending(journalDir);
      assert.equal(files.length, 1);
      assert.match(files[0], /^devflow-433-effect-[0-9a-f]{16}\.json$/);
      const content = readFileSync(join(journalDir, 'pending', files[0]), 'utf8');
      assert.equal(content, EDGE_CASE_PAYLOAD);
      assert.doesNotThrow(() => JSON.parse(content));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('AC-1/AC-2: re-running the finalize command with an identical payload file does not create a duplicate entry (idempotent overwrite)', () => {
  withScratchJournalDir((journalDir) => {
    const payload = '{"skill":"dev-flow","outcome":"success","issue":412}';
    const { dir, file } = writeTempPayloadFile(payload);
    try {
      runFinalize({ prefix: 'devflow', id: 412, payloadFile: file, journalDir });
      const firstListing = listPending(journalDir);
      runFinalize({ prefix: 'devflow', id: 412, payloadFile: file, journalDir });
      const secondListing = listPending(journalDir);

      assert.equal(firstListing.length, 1);
      assert.deepEqual(secondListing, firstListing);
      const content = readFileSync(join(journalDir, 'pending', secondListing[0]), 'utf8');
      assert.equal(content, payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('AC-1/AC-2: a different payload for the same prefix/id produces a distinct effect file (no collision)', () => {
  withScratchJournalDir((journalDir) => {
    const a = writeTempPayloadFile('{"skill":"dev-flow","outcome":"success"}');
    const b = writeTempPayloadFile('{"skill":"dev-flow","outcome":"failure"}');
    try {
      runFinalize({ prefix: 'devflow', id: 412, payloadFile: a.file, journalDir });
      runFinalize({ prefix: 'devflow', id: 412, payloadFile: b.file, journalDir });

      const files = listPending(journalDir).sort();
      assert.equal(files.length, 2);
      assert.notEqual(files[0], files[1]);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});

test('AC-1/AC-2: no dot-prefixed temp file remains after execution (atomic mv leaves no partial JSON)', () => {
  withScratchJournalDir((journalDir) => {
    const { dir, file } = writeTempPayloadFile('{"skill":"pr-iterate","outcome":"success"}');
    try {
      runFinalize({ prefix: 'priterate', id: 99, payloadFile: file, journalDir });

      const files = listPending(journalDir);
      assert.ok(files.every((f) => !f.startsWith('.')));
      assert.ok(files.every((f) => f.endsWith('.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('AC-1: a malformed JSON payload (devflow-411-style extra closing brace) fails jq -e validation and writes nothing to pending/', () => {
  withScratchJournalDir((journalDir) => {
    // Mirrors the devflow-411 malformed-park incident shape: an extra `}` mid-structure.
    const malformed = '{"skill":"dev-flow","outcome":"success","telemetry":{"vdelta_verdicts":[{"ac":"AC-1"}]}}}';
    const { dir, file } = writeTempPayloadFile(malformed);
    try {
      let threw = false;
      try {
        runFinalize({ prefix: 'devflow', id: 411, payloadFile: file, journalDir });
      } catch (err) {
        threw = true;
        assert.notEqual(err.status, 0);
      }
      assert.ok(threw, 'expected the finalize command to fail (non-zero exit) on malformed JSON');

      const files = listPending(journalDir);
      assert.equal(files.filter((f) => f.endsWith('.json')).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- conformance: call sites use the canonical Write-tool-verbatim helper ----

test('workflows construct journal handoff instructions through the canonical Write-tool-verbatim helper', () => {
  const devFlow = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  const prIterate = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

  assert.equal(
    (devFlow.match(/buildJournalHandoffInstr\(\{ prefix: 'devflow'/g) ?? []).length,
    2,
  );
  assert.equal(
    (prIterate.match(/buildJournalHandoffInstr\(\{ prefix: 'priterate'/g) ?? []).length,
    1,
  );
  assert.ok(!devFlow.includes('buildJournalHandoffCommand'));
  assert.ok(!prIterate.includes('buildJournalHandoffCommand'));
  assert.ok(!devFlow.includes("<<'TELEMETRY_EOF'"));
  assert.ok(!prIterate.includes("<<'TELEMETRY_EOF'"));
});
