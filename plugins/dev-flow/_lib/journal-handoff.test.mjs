import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

import {
  JOURNAL_LOG_STATUSES,
  buildJournalHandoffPayload,
  buildJournalLogInstr,
  buildJournalPendingPath,
  buildJournalSaveInstr,
  classifyJournalLogStatus,
  journalEffectId,
  repoFromGithubUrl,
  runJournalHandoff,
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

// AC-1/AC-2: exercise the stage2 naming + verbatim-copy contract against a scratch journal dir
// (not just the literal instruction string).
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

const PENDING_PREFIX = '~/.claude/journal/pending/';

// Simulates the agent step described by buildJournalLogInstr: Read the payload file, then Write
// its content verbatim to the JS-determined pending path. stage2 carries no shell any more, so
// what is under test is the naming contract (stable effect ID derived from the payload) plus the
// verbatim copy. The `~` prefix — expanded by the Write tool in production — is rebased onto a
// scratch dir so the test never touches the real journal.
function simulateStage2({ prefix, id, payloadFile, journalDir }) {
  const payload = readFileSync(payloadFile, 'utf8');
  const pendingPath = buildJournalPendingPath({ prefix, id, effectId: journalEffectId(payload) });
  assert.ok(pendingPath.startsWith(PENDING_PREFIX), `pending パスの接頭辞が変わっている: ${pendingPath}`);
  const rebased = join(journalDir, 'pending', pendingPath.slice(PENDING_PREFIX.length));
  mkdirSync(dirname(rebased), { recursive: true });
  writeFileSync(rebased, payload, 'utf8');
  return rebased;
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

const SAVE_PATH = '/wt/.devflow-tmp/payload-devflow-494.json';
const SHELL_DIR = '${TMPDIR:-/tmp}/dev-improve';

test('buildJournalSaveInstr (savePath) embeds the payload verbatim between JOURNAL_HANDOFF_BODY delimiters, including Japanese/backtick/nested-escaped-JSON edge cases', () => {
  const instr = buildJournalSaveInstr({ payload: EDGE_CASE_PAYLOAD, savePath: SAVE_PATH });
  const match = instr.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(match, 'expected instr to contain the delimited payload block');
  assert.equal(match[1], EDGE_CASE_PAYLOAD);
});

test('buildJournalSaveInstr (saveDir) embeds the payload verbatim between JOURNAL_HANDOFF_BODY delimiters', () => {
  const instr = buildJournalSaveInstr({ payload: EDGE_CASE_PAYLOAD, saveDir: SHELL_DIR, fileName: 'payload-dev-improve.json' });
  const match = instr.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(match, 'expected instr to contain the delimited payload block');
  assert.equal(match[1], EDGE_CASE_PAYLOAD);
});

test('buildJournalSaveInstr instructs Write tool usage and forbids passing the payload through shell', () => {
  for (const instr of [
    buildJournalSaveInstr({ payload: '{"ok":true}', savePath: SAVE_PATH }),
    buildJournalSaveInstr({ payload: '{"ok":true}', saveDir: SHELL_DIR, fileName: 'payload-dev-improve.json' }),
  ]) {
    assert.ok(instr.includes('Write tool'));
    assert.ok(instr.includes('echo'));
    assert.ok(instr.includes('printf'));
    assert.ok(instr.includes('heredoc'));
  }
});

// issue #498 review: Write tool refuses to overwrite an existing file it hasn't Read in the
// same session. savePath / saveDir fileName are fixed across runs (worktree reuse, TMPDIR
// persistence), so a stale payload from a prior run makes stage1 deterministically
// save_failed unless the instruction tells the agent to Read-then-Write (same idempotency
// pattern as isolationProbePrompt, issue #482).
test('buildJournalSaveInstr instructs a Read-before-overwrite idempotency step for both modes', () => {
  const savePathInstr = buildJournalSaveInstr({ payload: '{"ok":true}', savePath: SAVE_PATH });
  assert.ok(savePathInstr.includes('Read tool'));
  assert.ok(savePathInstr.includes('既に存在する場合'));
  assert.ok(/Read tool[\s\S]*Write tool/.test(savePathInstr), 'Read の指示は Write の指示より前に現れるべき');

  const saveDirInstr = buildJournalSaveInstr({ payload: '{"ok":true}', saveDir: SHELL_DIR, fileName: 'payload-dev-improve.json' });
  assert.ok(saveDirInstr.includes('Read tool'));
  assert.ok(saveDirInstr.includes('既に存在する場合'));
  assert.ok(/Read tool[\s\S]*Write tool/.test(saveDirInstr), 'Read の指示は Write の指示より前に現れるべき');
});

// payloadPath は stage2 の Read tool パスへ splice されるため、呼び出し側の検証規律に依存せず
// buildJournalLogInstr 自身でも同じ決定論検証を通す（将来の呼び出し側が検証を忘れても
// 未検証 splice が復活しない）。
test('buildJournalLogInstr throws when payloadPath violates the payload path contract', () => {
  for (const bad of [
    'relative/payload-x.json',
    '/wt/.devflow-tmp/telemetry.json',
    '/wt/.devflow-tmp/payload-x.json; rm -rf /',
    '/wt/../.devflow-tmp/payload-x.json',
    '',
    null,
    undefined,
  ]) {
    assert.throws(
      () => buildJournalLogInstr({ prefix: 'devflow', id: 494, payloadPath: bad }),
      /invalid payloadPath/,
      `payloadPath=${JSON.stringify(bad ?? null)} は reject されるべき`,
    );
  }
});

test('buildJournalLogInstr accepts a contract-conforming payloadPath and splices it into the stage2 instruction', () => {
  const instr = buildJournalLogInstr({ prefix: 'devflow', id: 494, payloadPath: SAVE_PATH, payload: '{"skill":"dev-flow"}' });
  assert.ok(instr.includes(SAVE_PATH));
  assert.ok(!instr.includes('<PAYLOAD_FILE>'));
});

test('buildJournalSaveInstr throws when payload is null', () => {
  assert.throws(
    () => buildJournalSaveInstr({ payload: null, savePath: SAVE_PATH }),
    /payload is required/,
  );
});

// savePath モード（dev-flow / pr-iterate）: 保存先が JS 側で確定しているので shell を一切使わない。
// Bash 依存を残すと、repo 配下を Bash から書けない環境（skills repo の自己改変ガードは worktree 配下も
// 含めて deny する）で保存コマンドが EPERM になり、agent が別ディレクトリへ退避して保存先検証に落ちる。
test('buildJournalSaveInstr (savePath) pins the absolute path and uses no shell', () => {
  const instr = buildJournalSaveInstr({ payload: '{"ok":true}', savePath: SAVE_PATH });
  assert.ok(instr.includes(SAVE_PATH));
  assert.ok(instr.includes('Write tool'));
  assert.ok(!instr.includes('mktemp'), 'savePath モードでは一時ファイル生成コマンドを使ってはならない');
  assert.ok(!instr.includes('mkdir -p'), 'savePath モードでは mkdir -p を使ってはならない');
  assert.ok(!instr.includes('<PAYLOAD_FILE>'), 'savePath モードではパスが確定しているため placeholder は残らない');
});

// savePath は stage2 の bash コマンドへそのまま splice されるので、申告値と同じ決定論検証を
// 構築時点でも通す。
test('buildJournalSaveInstr throws when savePath violates the payload path contract', () => {
  for (const bad of [
    'relative/payload-x.json',
    '/wt/.devflow-tmp/telemetry.json',
    '/wt/.devflow-tmp/payload-x.txt',
    '/wt/../.devflow-tmp/payload-x.json',
    '/wt/.devflow-tmp/payload-x.json; rm -rf /',
    '',
  ]) {
    assert.throws(
      () => buildJournalSaveInstr({ payload: '{}', savePath: bad }),
      /invalid savePath/,
      `savePath=${JSON.stringify(bad)} は reject されるべき`,
    );
  }
});

test('buildJournalSaveInstr throws when both savePath and saveDir are given', () => {
  assert.throws(
    () => buildJournalSaveInstr({ payload: '{}', savePath: SAVE_PATH, saveDir: SHELL_DIR, fileName: 'payload-dev-improve.json' }),
    /同時に指定できません/,
  );
});

test('buildJournalSaveInstr throws when neither savePath nor saveDir is given', () => {
  assert.throws(
    () => buildJournalSaveInstr({ payload: '{}' }),
    /savePath か saveDir/,
  );
});

// saveDir モード（dev-improve）: 保存先が shell 展開に依存するので絶対パスは shell に組み立てさせるが、
// ファイル名は固定。mktemp テンプレート payload-XXXXXX.json は X 列が suffix の前にあるため BSD
// mktemp では展開されずリテラル名のファイルを exit 0 で作り、一意性が silent に失われる。
test('buildJournalSaveInstr (saveDir) resolves the path via shell with a fixed file name and never uses mktemp', () => {
  const instr = buildJournalSaveInstr({ payload: '{"ok":true}', saveDir: SHELL_DIR, fileName: 'payload-dev-improve.json' });
  assert.ok(instr.includes('mkdir -p "${TMPDIR:-/tmp}/dev-improve"'));
  assert.ok(instr.includes('"${TMPDIR:-/tmp}/dev-improve/payload-dev-improve.json"'));
  assert.ok(!instr.includes('mktemp'), 'mktemp は BSD でテンプレートを展開しないため使ってはならない');
  assert.ok(!instr.includes('XXXXXX'), 'mktemp テンプレートは残っていてはならない');
});

test('buildJournalSaveInstr (saveDir) throws when fileName violates the payload-*.json contract', () => {
  for (const bad of ['telemetry.json', 'payload-x.txt', '../payload-x.json', '', undefined]) {
    assert.throws(
      () => buildJournalSaveInstr({ payload: '{}', saveDir: SHELL_DIR, fileName: bad }),
      /invalid fileName/,
      `fileName=${JSON.stringify(bad ?? null)} は reject されるべき`,
    );
  }
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

test('buildJournalLogInstr embeds the source payload path and the JS-determined pending path, and keeps the fail-open contract', () => {
  const payloadPath = '/wt/.devflow-tmp/payload-abc123.json';
  const payload = '{"skill":"dev-flow","outcome":"success"}';
  const instr = buildJournalLogInstr({ prefix: 'devflow', id: 433, payloadPath, payload });
  assert.ok(!instr.includes('<PAYLOAD_FILE>'));
  assert.ok(instr.includes(payloadPath));
  assert.ok(instr.includes(buildJournalPendingPath({ prefix: 'devflow', id: 433, effectId: journalEffectId(payload) })));
  assert.ok(instr.includes('logged:false'));
});

// issue #526 regression pin: stage2 の指示に shell 構文が 1 つでも戻ると、EnterWorktree 済み
// セッションの worktree 分離ガードに `too complex to verify that it stays inside the worktree`
// で拒否され、dev-flow / pr-iterate のテレメトリが再び全損する（2026-08-20〜28 の実害）。
// 「Write tool のみで書く」という stage2 の性質を、生成文字列の側から機械的に固定する。
test('buildJournalLogInstr (issue #526) emits no shell constructs — stage2 writes through the Write tool only', () => {
  const instr = buildJournalLogInstr({
    prefix: 'devflow',
    id: 526,
    payloadPath: '/wt/.devflow-tmp/payload-abc123.json',
    payload: EDGE_CASE_PAYLOAD,
  });
  for (const shellToken of ['$(', '&&', '||', '>/dev/null', '${', '|', 'mktemp', 'shasum', 'mkdir ', 'mv ', 'cp ', 'jq ']) {
    assert.ok(
      !instr.includes(shellToken),
      `stage2 の指示に shell 構文 '${shellToken}' が含まれている: ${instr}`,
    );
  }
  assert.ok(instr.includes('Write tool'));
  assert.ok(instr.includes('Read tool'));
});

// stage2 は payload 本文を prompt に載せない（結論値がこの prompt へ構造的に現れない）。
// payload を引数に取るのは書き込み先ファイル名の effect ID 算出のためだけである。
test('buildJournalLogInstr never embeds the payload body in the stage2 prompt', () => {
  const instr = buildJournalLogInstr({
    prefix: 'devflow',
    id: 433,
    payloadPath: '/wt/.devflow-tmp/payload-abc123.json',
    payload: EDGE_CASE_PAYLOAD,
  });
  assert.ok(!instr.includes(EDGE_CASE_PAYLOAD));
  assert.ok(!instr.includes('"outcome":"success"'));
  assert.ok(!instr.includes('日本語テスト名の検証'));
});

test('buildJournalLogInstr throws when payload is missing or not a string', () => {
  const payloadPath = '/wt/.devflow-tmp/payload-abc123.json';
  for (const bad of [undefined, null, '', 42, {}]) {
    assert.throws(
      () => buildJournalLogInstr({ prefix: 'devflow', id: 433, payloadPath, payload: bad }),
      /payload is required/,
      `payload=${JSON.stringify(bad ?? null)} は reject されるべき`,
    );
  }
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

// ---- journalEffectId / buildJournalPendingPath ----

test('buildJournalPendingPath rejects unsafe path parts', () => {
  const effectId = journalEffectId('{}');
  assert.throws(() => buildJournalPendingPath({ prefix: 'bad/prefix', id: 251, effectId }), /invalid prefix/);
  assert.throws(() => buildJournalPendingPath({ prefix: 'priterate', id: '251;rm', effectId }), /invalid id/);
  assert.throws(() => buildJournalPendingPath({ prefix: 'devflow', id: 251, effectId: '../escape' }), /invalid effectId/);
  assert.throws(() => buildJournalPendingPath({ prefix: 'devflow', id: 251, effectId: 'ABCDEF0123456789' }), /invalid effectId/);
});

test('buildJournalPendingPath builds the pending path under the tilde journal dir', () => {
  const effectId = journalEffectId('{"skill":"dev-flow"}');
  assert.equal(
    buildJournalPendingPath({ prefix: 'devflow', id: 526, effectId }),
    `~/.claude/journal/pending/devflow-526-effect-${effectId}.json`,
  );
});

test('journalEffectId is deterministic, 16 lowercase hex, and separates payloads that differ only in a high byte', () => {
  assert.match(journalEffectId(EDGE_CASE_PAYLOAD), /^[0-9a-f]{16}$/);
  assert.equal(journalEffectId(EDGE_CASE_PAYLOAD), journalEffectId(EDGE_CASE_PAYLOAD));
  assert.notEqual(
    journalEffectId('{"skill":"dev-flow","outcome":"success"}'),
    journalEffectId('{"skill":"dev-flow","outcome":"failure"}'),
  );
  // 'あ'(U+3042) と 'B'(U+0042) は下位バイトが同一。下位バイトだけを混ぜる実装だと衝突するため、
  // 日本語を含む payload の識別が落ちていないことをここで固定する。
  assert.notEqual(journalEffectId('あ'), journalEffectId('B'));
});

test('AC-1/AC-2: the stage2 copy against a real payload file produces exactly one valid-JSON effect file matching the payload', () => {
  withScratchJournalDir((journalDir) => {
    const { dir, file } = writeTempPayloadFile(EDGE_CASE_PAYLOAD);
    try {
      simulateStage2({ prefix: 'devflow', id: 433, payloadFile: file, journalDir });

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

test('AC-1/AC-2: re-running stage2 with an identical payload file does not create a duplicate entry (idempotent overwrite)', () => {
  withScratchJournalDir((journalDir) => {
    const payload = '{"skill":"dev-flow","outcome":"success","issue":412}';
    const { dir, file } = writeTempPayloadFile(payload);
    try {
      simulateStage2({ prefix: 'devflow', id: 412, payloadFile: file, journalDir });
      const firstListing = listPending(journalDir);
      simulateStage2({ prefix: 'devflow', id: 412, payloadFile: file, journalDir });
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
      simulateStage2({ prefix: 'devflow', id: 412, payloadFile: a.file, journalDir });
      simulateStage2({ prefix: 'devflow', id: 412, payloadFile: b.file, journalDir });

      const files = listPending(journalDir).sort();
      assert.equal(files.length, 2);
      assert.notEqual(files[0], files[1]);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});

test('AC-1/AC-2: stage2 writes a single plain *.json entry (no dot-prefixed or non-json leftovers)', () => {
  withScratchJournalDir((journalDir) => {
    const { dir, file } = writeTempPayloadFile('{"skill":"pr-iterate","outcome":"success"}');
    try {
      simulateStage2({ prefix: 'priterate', id: 99, payloadFile: file, journalDir });

      const files = listPending(journalDir);
      assert.ok(files.every((f) => !f.startsWith('.')));
      assert.ok(files.every((f) => f.endsWith('.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// issue #526: `jq -e` による pending/ 書き込み前の JSON 検証は shell と一緒に無くなった。
// 壊れた payload は pending/ に届いたうえで Stop hook（stop-devflow-telemetry.sh）が
// malformed/ へ隔離し、replay runbook で回収する経路に移った。ここで固定するのは
// 「stage2 が失敗しても throw せず logged:false を返す」という fail-open 契約のみで、
// 呼び出し側はこれを log_failed として観測できる（classifyJournalLogStatus のテスト参照）。
test('AC3 (issue #526): the stage2 instruction keeps the fail-open contract — never throw, report logged:false', () => {
  const instr = buildJournalLogInstr({
    prefix: 'devflow',
    id: 526,
    payloadPath: '/wt/.devflow-tmp/payload-abc123.json',
    payload: '{"skill":"dev-flow","outcome":"success"}',
  });
  assert.match(instr, /throw せず/);
  assert.ok(instr.includes('{logged:false}'));
  assert.ok(instr.includes('{logged:true}'));
});

// ---- runJournalHandoff (F2/AC5/AC7: deps-injected 2-stage choreography) ----

const HANDOFF_SAVE_PATH = '/wt/.devflow-tmp/payload-devflow-556.json';
const HANDOFF_PAYLOAD = '{"skill":"dev-flow","outcome":"success"}';
const HANDOFF_SAVE_SCHEMA = { type: 'object', properties: { saved: { type: 'boolean' } } };
const HANDOFF_LOG_SCHEMA = { type: 'object', properties: { logged: { type: 'boolean' } } };

function makeStubAgent(responders) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    const responder = responders[opts.label];
    if (!responder) throw new Error(`unexpected label: ${opts.label}`);
    return responder({ prompt, opts });
  };
  return { agent, calls };
}

function makeStubLog() {
  const messages = [];
  return { log: (msg) => messages.push(msg), messages };
}

test('runJournalHandoff (happy path) saves then logs and returns logged, calling agent twice with the expected labels/agentType/phase', async () => {
  const { agent, calls } = makeStubAgent({
    'journal-save': async () => ({ saved: true, path: HANDOFF_SAVE_PATH }),
    'journal-log-failure': async () => ({ logged: true, summary: 'ok' }),
  });
  const { log } = makeStubLog();

  const status = await runJournalHandoff({
    agent,
    log,
    saveSchema: HANDOFF_SAVE_SCHEMA,
    logSchema: HANDOFF_LOG_SCHEMA,
    payload: HANDOFF_PAYLOAD,
    savePath: HANDOFF_SAVE_PATH,
    prefix: 'devflow',
    id: 556,
    subject: 'dev-flow 失敗',
    logLabel: 'journal-log-failure',
    phase: 'Setup',
  });

  assert.equal(status, 'logged');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.label, 'journal-save');
  assert.equal(calls[0].opts.agentType, 'dev-runner-haiku');
  assert.equal(calls[0].opts.phase, 'Setup');
  assert.equal(calls[0].opts.schema, HANDOFF_SAVE_SCHEMA);
  assert.equal(calls[1].opts.label, 'journal-log-failure');
  assert.equal(calls[1].opts.agentType, 'dev-runner-haiku');
  assert.equal(calls[1].opts.phase, 'Setup');
  assert.equal(calls[1].opts.schema, HANDOFF_LOG_SCHEMA);

  assert.ok(calls[0].prompt.includes(HANDOFF_PAYLOAD));
  assert.ok(calls[0].prompt.includes(HANDOFF_SAVE_PATH));

  const pendingPath = buildJournalPendingPath({ prefix: 'devflow', id: 556, effectId: journalEffectId(HANDOFF_PAYLOAD) });
  assert.ok(calls[1].prompt.includes(pendingPath));
});

test('runJournalHandoff returns save_failed and never calls stage2 when stage1 reports saved:false', async () => {
  const { agent, calls } = makeStubAgent({
    'journal-save': async () => ({ saved: false }),
    'journal-log-failure': async () => { throw new Error('stage2 should not be called'); },
  });
  const { log } = makeStubLog();

  const status = await runJournalHandoff({
    agent,
    log,
    saveSchema: HANDOFF_SAVE_SCHEMA,
    logSchema: HANDOFF_LOG_SCHEMA,
    payload: HANDOFF_PAYLOAD,
    savePath: HANDOFF_SAVE_PATH,
    prefix: 'devflow',
    id: 556,
    subject: 'dev-flow 失敗',
    logLabel: 'journal-log-failure',
    phase: 'Setup',
  });

  assert.equal(status, 'save_failed');
  assert.equal(calls.length, 1);
});

test('runJournalHandoff returns log_failed and warns via the log dep when stage2 reports logged:false', async () => {
  const { agent } = makeStubAgent({
    'journal-save': async () => ({ saved: true, path: HANDOFF_SAVE_PATH }),
    'journal-log-failure': async () => ({ logged: false }),
  });
  const { log, messages } = makeStubLog();

  const status = await runJournalHandoff({
    agent,
    log,
    saveSchema: HANDOFF_SAVE_SCHEMA,
    logSchema: HANDOFF_LOG_SCHEMA,
    payload: HANDOFF_PAYLOAD,
    savePath: HANDOFF_SAVE_PATH,
    prefix: 'devflow',
    id: 556,
    subject: 'dev-flow 失敗',
    logLabel: 'journal-log-failure',
    phase: 'Setup',
  });

  assert.equal(status, 'log_failed');
  assert.ok(messages.length >= 1, 'log dep should have been called with a warning');
});

// AC7 順序 pin: stage2 呼び出し直前に journalLogStatus を log_failed へ倒す preset が
// canonical 側で保証されていることを、stage2 responder が throw するケースで固定する。
// preset が無いと catch 節で 'save_failed'（初期値）のまま返ってしまい、実際の失敗段
// （stage2）と観測 status が食い違う（issue #499）。
test('runJournalHandoff (AC7 order pin) returns log_failed — not save_failed — when stage2 responder throws, and the throw never escapes', async () => {
  const { agent, calls } = makeStubAgent({
    'journal-save': async () => ({ saved: true, path: HANDOFF_SAVE_PATH }),
    'journal-log-failure': async () => { throw new Error('stage2 boom'); },
  });
  const { log } = makeStubLog();

  const status = await runJournalHandoff({
    agent,
    log,
    saveSchema: HANDOFF_SAVE_SCHEMA,
    logSchema: HANDOFF_LOG_SCHEMA,
    payload: HANDOFF_PAYLOAD,
    savePath: HANDOFF_SAVE_PATH,
    prefix: 'devflow',
    id: 556,
    subject: 'dev-flow 失敗',
    logLabel: 'journal-log-failure',
    phase: 'Setup',
  });

  assert.equal(status, 'log_failed');
  assert.equal(calls.length, 2);
});

test('runJournalHandoff returns save_failed and never calls stage2 when stage1 responder throws', async () => {
  const { agent, calls } = makeStubAgent({
    'journal-save': async () => { throw new Error('stage1 boom'); },
    'journal-log-failure': async () => { throw new Error('stage2 should not be called'); },
  });
  const { log } = makeStubLog();

  const status = await runJournalHandoff({
    agent,
    log,
    saveSchema: HANDOFF_SAVE_SCHEMA,
    logSchema: HANDOFF_LOG_SCHEMA,
    payload: HANDOFF_PAYLOAD,
    savePath: HANDOFF_SAVE_PATH,
    prefix: 'devflow',
    id: 556,
    subject: 'dev-flow 失敗',
    logLabel: 'journal-log-failure',
    phase: 'Setup',
  });

  assert.equal(status, 'save_failed');
  assert.equal(calls.length, 1);
});

// ---- conformance: call sites use the canonical Write-tool-verbatim helpers ----
//
// issue #494 F3 / #556 F4: all payload-carrying journal handoff call sites — the 3
// telemetry sites (dev-flow.js Merge tier, pr-iterate.js Iterate, dev-improve.js File) and
// dev-flow.js's writeFailureTelemetry (outcome:'failure'/'partial') — carry the payload body
// as a file on disk and the finalize prompt takes only a path, regardless of outcome.
// dev-flow.js's writeFailureTelemetry / Merge tier and pr-iterate.js's Iterate terminus
// route through the canonical `runJournalHandoff` choreography (_lib/journal-handoff.mjs,
// issue #556) rather than repeating the 2-stage buildJournalSaveInstr + buildJournalLogInstr
// choreography inline; dev-improve.js (no per-run worktree) keeps the inline saveDir+fileName
// mode this function does not support. dev-flow / pr-iterate use the `savePath` mode: the
// payload file sits under the worktree's gitignored `.devflow-tmp/` (dev-flow: `${WT}/.devflow-tmp`,
// pr-iterate: `${isoWt}/.devflow-tmp`) at a path the workflow fixes itself, so the
// agent-reported path is never used. This test pins that neither workflow references the
// removed single-stage buildJournalHandoffInstr / buildFailureJournalInstr names.

test('workflows construct journal handoff instructions through the canonical Write-tool-verbatim helpers', () => {
  const devFlow = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  const prIterate = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

  // dev-flow.js: writeFailureTelemetry and the Merge tier success path both route through the
  // canonical runJournalHandoff with the worktree-scoped savePath fixed by the workflow itself
  // (agent-reported path never used — enforced inside the canonical, not per call site).
  assert.equal(
    (devFlow.match(/savePath: `\$\{WT\}\/\.devflow-tmp\/payload-devflow-\$\{ISSUE\}\.json`/g) ?? []).length,
    1, // Merge tier success handoff
  );
  assert.equal(
    (devFlow.match(/savePath: `\$\{WT\}\/\.devflow-tmp\/payload-devflow-\$\{ISSUE\}-failure\.json`/g) ?? []).length,
    1, // writeFailureTelemetry
  );
  assert.equal(
    (devFlow.match(/(?<!function )runJournalHandoff\(\{/g) ?? []).length,
    2,
  );
  // logLabel は現行値のまま維持されている（issue #556 AC6）。
  assert.ok(devFlow.includes("logLabel: 'journal-log',"));
  assert.ok(devFlow.includes("logLabel: 'journal-log-failure',"));
  assert.ok(!devFlow.includes('validateJournalSavedPath(journalSaveRes.path'));
  assert.ok(!devFlow.includes('buildFailureJournalInstr'));
  // pr-iterate.js: Iterate telemetry handoff routes through the same canonical, worktree-scoped
  // savePath, logLabel 現行値維持。
  assert.equal(
    (prIterate.match(/savePath: `\$\{isoWt\}\/\.devflow-tmp\/payload-priterate-\$\{PR\}\.json`/g) ?? []).length,
    1,
  );
  assert.equal(
    (prIterate.match(/(?<!function )runJournalHandoff\(\{/g) ?? []).length,
    1,
  );
  assert.ok(prIterate.includes("logLabel: 'journal-log',"));
  assert.ok(!prIterate.includes('validateJournalSavedPath(journalSaveRes.path'));
  // dev-improve.js: run 専用 worktree を持たないため saveDir は TMPDIR 配下の固定サブディレクトリ。
  // 他 2 経路と同じディレクトリ固定の防御を保つため requiredDirSuffix で pin されていること。
  const devImprove = readFileSync(join(repoRoot, '.claude/workflows/dev-improve.js'), 'utf8');
  assert.equal(
    (devImprove.match(/buildJournalSaveInstr\(\{ payload: improveHandoff, saveDir: '\$\{TMPDIR:-\/tmp\}\/dev-improve', fileName: 'payload-dev-improve\.json' \}\)/g) ?? []).length,
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
