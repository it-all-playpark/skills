import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

import {
  JOURNAL_LOG_STATUSES,
  buildJournalFinalizeCommand,
  buildJournalHandoffPayload,
  buildJournalLogInstr,
  buildJournalSaveInstr,
  classifyJournalLogStatus,
  repoFromGithubUrl,
  validateJournalSavedPath,
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

// ---- buildJournalSaveInstr (stage1) ----

test('buildJournalSaveInstr embeds the payload verbatim between JOURNAL_HANDOFF_BODY delimiters, including Japanese/backtick/nested-escaped-JSON edge cases', () => {
  const instr = buildJournalSaveInstr({ payload: EDGE_CASE_PAYLOAD, saveDir: null });
  const match = instr.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(match, 'expected instr to contain the delimited payload block');
  assert.equal(match[1], EDGE_CASE_PAYLOAD);
});

test('buildJournalSaveInstr instructs Write tool usage and forbids passing the payload through shell', () => {
  const instr = buildJournalSaveInstr({ payload: '{"ok":true}', saveDir: null });
  assert.ok(instr.includes('Write tool'));
  assert.ok(instr.includes('echo'));
  assert.ok(instr.includes('printf'));
  assert.ok(instr.includes('heredoc'));
});

test('buildJournalSaveInstr throws when payload is null', () => {
  assert.throws(
    () => buildJournalSaveInstr({ payload: null, saveDir: null }),
    /payload is required/,
  );
});

test('buildJournalSaveInstr uses mkdir -p + saveDir mktemp when saveDir is given', () => {
  const instr = buildJournalSaveInstr({ payload: '{"ok":true}', saveDir: '/wt/.devflow-tmp' });
  assert.ok(instr.includes('mkdir -p "/wt/.devflow-tmp"'));
  assert.ok(instr.includes('mktemp "/wt/.devflow-tmp/payload-XXXXXX.json"'));
});

test('buildJournalSaveInstr falls back to ${TMPDIR:-/tmp} mktemp when saveDir is null', () => {
  const instr = buildJournalSaveInstr({ payload: '{"ok":true}', saveDir: null });
  assert.ok(instr.includes('mktemp "${TMPDIR:-/tmp}/payload-XXXXXX.json"'));
  assert.ok(!instr.includes('mkdir -p'));
});


// ---- validateJournalSavedPath ----

test('validateJournalSavedPath accepts an absolute payload path under the required dir suffix', () => {
  assert.equal(
    validateJournalSavedPath('/wt/.devflow-tmp/payload-abc123.json', { requiredDirSuffix: '/.devflow-tmp' }),
    true,
  );
});

test('validateJournalSavedPath accepts an absolute payload path with no requiredDirSuffix constraint', () => {
  assert.equal(validateJournalSavedPath('/tmp/x/payload-a1.json', {}), true);
  assert.equal(validateJournalSavedPath('/tmp/x/payload-a1.json'), true);
});

test('validateJournalSavedPath rejects a relative path', () => {
  assert.equal(validateJournalSavedPath('wt/.devflow-tmp/payload-abc123.json', {}), false);
});

test('validateJournalSavedPath rejects a path containing ..', () => {
  assert.equal(validateJournalSavedPath('/wt/.devflow-tmp/../payload-abc123.json', {}), false);
});

test('validateJournalSavedPath rejects shell metacharacters', () => {
  assert.equal(validateJournalSavedPath('/tmp/payload-a b.json', {}), false);
  assert.equal(validateJournalSavedPath('/tmp/payload-a;rm.json', {}), false);
  assert.equal(validateJournalSavedPath('/tmp/payload-a$(x).json', {}), false);
  assert.equal(validateJournalSavedPath('/tmp/payload-a`x`.json', {}), false);
  assert.equal(validateJournalSavedPath('/tmp/payload-a"x".json', {}), false);
});

test('validateJournalSavedPath rejects a dir suffix mismatch', () => {
  assert.equal(
    validateJournalSavedPath('/wt/other-dir/payload-abc123.json', { requiredDirSuffix: '/.devflow-tmp' }),
    false,
  );
});

test('validateJournalSavedPath rejects a path not ending in .json', () => {
  assert.equal(validateJournalSavedPath('/tmp/payload-abc123.txt', {}), false);
});

test('validateJournalSavedPath rejects a basename not matching the payload- pattern', () => {
  assert.equal(validateJournalSavedPath('/tmp/other-abc123.json', {}), false);
  assert.equal(validateJournalSavedPath('/tmp/payload.json', {}), false);
});

test('validateJournalSavedPath rejects non-string input', () => {
  assert.equal(validateJournalSavedPath(null, {}), false);
  assert.equal(validateJournalSavedPath(undefined, {}), false);
  assert.equal(validateJournalSavedPath(42, {}), false);
});

// ---- buildJournalLogInstr (stage2) ----

test('buildJournalLogInstr leaves no <PAYLOAD_FILE> placeholder and embeds the real path plus the pending dir', () => {
  const instr = buildJournalLogInstr({ prefix: 'devflow', id: 433, payloadPath: '/wt/.devflow-tmp/payload-abc123.json' });
  assert.ok(!instr.includes('<PAYLOAD_FILE>'));
  assert.ok(instr.includes('/wt/.devflow-tmp/payload-abc123.json'));
  assert.ok(instr.includes('pending'));
  assert.ok(instr.includes('logged:false'));
});

test('buildJournalLogInstr embeds exactly buildJournalFinalizeCommand with the placeholder substituted', () => {
  const payloadPath = '/wt/.devflow-tmp/payload-abc123.json';
  const instr = buildJournalLogInstr({ prefix: 'devflow', id: 433, payloadPath });
  const expectedCmd = buildJournalFinalizeCommand({ prefix: 'devflow', id: 433 }).split('<PAYLOAD_FILE>').join(payloadPath);
  assert.ok(instr.includes(expectedCmd));
});

// ---- classifyJournalLogStatus ----

test('JOURNAL_LOG_STATUSES is the closed 3-value enum', () => {
  assert.deepEqual(JOURNAL_LOG_STATUSES, ['logged', 'save_failed', 'log_failed']);
});

test('classifyJournalLogStatus returns save_failed when saved is not true', () => {
  assert.equal(classifyJournalLogStatus({ saved: false, logged: true }), 'save_failed');
  assert.equal(classifyJournalLogStatus({ saved: undefined, logged: true }), 'save_failed');
  assert.equal(classifyJournalLogStatus({ saved: null, logged: true }), 'save_failed');
});

test('classifyJournalLogStatus returns logged when saved is true and logged is true', () => {
  assert.equal(classifyJournalLogStatus({ saved: true, logged: true }), 'logged');
});

test('classifyJournalLogStatus returns log_failed when saved is true but logged is not true', () => {
  assert.equal(classifyJournalLogStatus({ saved: true, logged: false }), 'log_failed');
  assert.equal(classifyJournalLogStatus({ saved: true, logged: undefined }), 'log_failed');
  assert.equal(classifyJournalLogStatus({ saved: true, logged: null }), 'log_failed');
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

// ---- conformance: call sites use the canonical Write-tool-verbatim helpers ----
//
// issue #494 F3: all payload-carrying journal handoff call sites — the 3 telemetry sites
// (dev-flow.js Merge tier, pr-iterate.js Iterate, dev-improve.js File) and dev-flow.js's
// writeFailureTelemetry (outcome:'failure'/'partial') — migrate to the 2-stage
// buildJournalSaveInstr + buildJournalLogInstr split, so the payload body is carried as a file
// on disk and the finalize prompt takes only a path, regardless of outcome. The saveDir
// passed to buildJournalSaveInstr pins the payload file under the worktree's gitignored
// `.devflow-tmp/` (dev-flow: `${WT}/.devflow-tmp`, pr-iterate: `${isoWt}/.devflow-tmp`) rather
// than `${TMPDIR:-/tmp}`, so validateJournalSavedPath can pin `requiredDirSuffix`. This test
// pins that neither workflow references the removed single-stage buildJournalHandoffInstr /
// buildFailureJournalInstr names.

test('workflows construct journal handoff instructions through the canonical Write-tool-verbatim helpers', () => {
  const devFlow = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  const prIterate = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

  // dev-flow.js: Merge tier telemetry handoff uses the 2-stage split, worktree-scoped saveDir.
  assert.equal(
    (devFlow.match(/buildJournalSaveInstr\(\{ payload: telemetryHandoff, saveDir: `\$\{WT\}\/\.devflow-tmp` \}\)/g) ?? []).length,
    1,
  );
  // dev-flow.js: writeFailureTelemetry (needs_clarification/cross_repo/empty_diff) also uses the
  // 2-stage split with the same worktree-scoped saveDir — no local single-stage helper remains.
  assert.equal(
    (devFlow.match(/buildJournalSaveInstr\(\{ payload, saveDir: `\$\{WT\}\/\.devflow-tmp` \}\)/g) ?? []).length,
    1,
  );
  assert.equal(
    (devFlow.match(/buildJournalLogInstr\(\{ prefix: 'devflow', id: ISSUE, payloadPath: journalSavedPath \}\)/g) ?? []).length,
    2, // Merge tier success handoff + writeFailureTelemetry
  );
  assert.ok(!devFlow.includes('buildFailureJournalInstr'));
  // pr-iterate.js: Iterate telemetry handoff uses the 2-stage split, worktree-scoped saveDir.
  assert.equal(
    (prIterate.match(/buildJournalSaveInstr\(\{ payload: telemetryHandoff, saveDir: `\$\{isoWt\}\/\.devflow-tmp` \}\)/g) ?? []).length,
    1,
  );
  assert.equal(
    (prIterate.match(/buildJournalLogInstr\(\{ prefix: 'priterate'/g) ?? []).length,
    1,
  );
  // dev-improve.js: run 専用 worktree を持たないため saveDir は TMPDIR 配下の固定サブディレクトリ。
  // 他 2 経路と同じディレクトリ固定の防御を保つため requiredDirSuffix で pin されていること。
  const devImprove = readFileSync(join(repoRoot, '.claude/workflows/dev-improve.js'), 'utf8');
  assert.equal(
    (devImprove.match(/buildJournalSaveInstr\(\{ payload: improveHandoff, saveDir: '\$\{TMPDIR:-\/tmp\}\/dev-improve' \}\)/g) ?? []).length,
    1,
  );
  assert.equal(
    (devImprove.match(/validateJournalSavedPath\(saveRes\.path, \{ requiredDirSuffix: '\/dev-improve' \}\)/g) ?? []).length,
    1,
  );
  assert.ok(!devImprove.includes('buildJournalHandoffInstr('));
  // The removed single-stage buildJournalHandoffInstr is not referenced by either workflow.
  assert.ok(!devFlow.includes('buildJournalHandoffInstr('));
  assert.ok(!prIterate.includes('buildJournalHandoffInstr('));
  assert.ok(!devFlow.includes('buildJournalHandoffCommand'));
  assert.ok(!prIterate.includes('buildJournalHandoffCommand'));
  assert.ok(!devFlow.includes("<<'TELEMETRY_EOF'"));
  assert.ok(!prIterate.includes("<<'TELEMETRY_EOF'"));
});
