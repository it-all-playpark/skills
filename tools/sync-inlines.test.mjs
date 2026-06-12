// tools/sync-inlines.test.mjs
// node:test fixture-based tests for tools/sync-inlines.mjs
//
// Fixtures are generated at runtime in a tmpdir; never committed.
// Cleanup is done in finally blocks to ensure removal even on failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  stripComments,
  checkForbiddenTokens,
  transformCanonical,
  scanMarkers,
  syncRepo,
  collectTopLevelDeclNames,
} from './sync-inlines.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sync-inlines.mjs');

// Helper: create a minimal fixture repo in a tmpdir
// extraCanonicals: { 'fake2.mjs': content, ... } — written to _lib/ alongside fake.mjs
function makeFixtureRepo(canonicalContent, workflowContent, { multiWf = false, secondWfContent = null, extraCanonicals = {} } = {}) {
  const tmp = mkdtempSync(join(os.tmpdir(), 'sync-inlines-'));
  mkdirSync(join(tmp, '_lib'), { recursive: true });
  mkdirSync(join(tmp, '.claude', 'workflows'), { recursive: true });
  writeFileSync(join(tmp, '_lib', 'fake.mjs'), canonicalContent, 'utf8');
  writeFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), workflowContent, 'utf8');
  if (multiWf && secondWfContent !== null) {
    writeFileSync(join(tmp, '.claude', 'workflows', 'wf2.js'), secondWfContent, 'utf8');
  }
  for (const [name, content] of Object.entries(extraCanonicals)) {
    writeFileSync(join(tmp, '_lib', name), content, 'utf8');
  }
  return tmp;
}

// Helper: run CLI via spawnSync
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test (1): export prefix stripping — all variants
// ─────────────────────────────────────────────────────────────────────────────

test('transformCanonical strips export function', () => {
  const src = `export function foo() {\n  return 1;\n}\n`;
  const result = transformCanonical(src, 'test');
  assert.equal(result, `function foo() {\n  return 1;\n}\n`);
});

test('transformCanonical strips export const', () => {
  const src = `export const FOO = 42;\n`;
  assert.equal(transformCanonical(src, 'test'), `const FOO = 42;\n`);
});

test('transformCanonical strips export let', () => {
  const src = `export let bar = 'x';\n`;
  assert.equal(transformCanonical(src, 'test'), `let bar = 'x';\n`);
});

test('transformCanonical strips export class', () => {
  const src = `export class MyClass {}\n`;
  assert.equal(transformCanonical(src, 'test'), `class MyClass {}\n`);
});

test('transformCanonical strips export async function', () => {
  const src = `export async function doThing() {}\n`;
  assert.equal(transformCanonical(src, 'test'), `async function doThing() {}\n`);
});

test('transformCanonical preserves comments verbatim', () => {
  const src = `// This exports something\nexport const X = 1;\n// end\n`;
  assert.equal(transformCanonical(src, 'test'), `// This exports something\nconst X = 1;\n// end\n`);
});

test('transformCanonical normalizes trailing newline to exactly one', () => {
  const src = `export const A = 1;\n\n\n`;
  const result = transformCanonical(src, 'test');
  assert.ok(result.endsWith('\n'));
  assert.ok(!result.endsWith('\n\n'));
});

test('transformCanonical errors on export default', () => {
  const src = `export default function() {}\n`;
  assert.throws(() => transformCanonical(src, 'test'), /export default/i);
});

test('transformCanonical errors on export { }', () => {
  const src = `export { foo, bar };\n`;
  assert.throws(() => transformCanonical(src, 'test'), /export/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (2): --write then --check exit codes
// ─────────────────────────────────────────────────────────────────────────────

test('--write then --check exits 0 (no drift)', () => {
  const canonical = `export const VALUE = 99;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\n// old content\n${markerEnd}\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    const writeResult = runCli(['--write', '--root', tmp]);
    assert.equal(writeResult.status, 0, `--write failed: ${writeResult.stderr}`);
    const checkResult = runCli(['--check', '--root', tmp]);
    assert.equal(checkResult.status, 0, `--check should be 0 after --write, got: ${checkResult.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--check exits 1 when inline section has 1-byte drift', () => {
  const canonical = `export const VALUE = 99;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  // After transform, inline should be: `const VALUE = 99;\n`
  // We put a 1-byte drift: `const VALUE = 98;\n`
  const wf = `${markerBegin}\nconst VALUE = 98;\n${markerEnd}\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    const checkResult = runCli(['--check', '--root', tmp]);
    assert.equal(checkResult.status, 1, `--check should be 1 on drift, got: ${checkResult.status}`);
    assert.ok(checkResult.stderr.includes('fake.mjs') || checkResult.stderr.length > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (3): forbidden token guard
// ─────────────────────────────────────────────────────────────────────────────

test('stripComments removes // line comments', () => {
  const src = `// import foo from 'bar'\nconst x = 1;\n`;
  const stripped = stripComments(src);
  assert.ok(!stripped.includes('import'));
  assert.ok(stripped.includes('const x = 1;'));
});

test('stripComments removes /* block */ comments', () => {
  const src = `/* Date.now() here */\nconst y = 2;\n`;
  const stripped = stripComments(src);
  assert.ok(!stripped.includes('Date.now'));
  assert.ok(stripped.includes('const y = 2;'));
});

test('stripComments preserves string literals containing //', () => {
  const src = `const s = "foo // bar";\n`;
  const stripped = stripComments(src);
  assert.ok(stripped.includes('foo // bar'));
});

test('stripComments preserves template literals containing //', () => {
  const src = 'const s = `foo // bar`;\n';
  const stripped = stripComments(src);
  assert.ok(stripped.includes('foo // bar'));
});

test('checkForbiddenTokens: comment-only import does NOT error', () => {
  // gate-policy.mjs has 'import' in its header comment - must not error
  const src = `// INLINE COPY POLICY: ESM import を使えないため inline コピー\nexport const X = 1;\n`;
  // Should not throw
  assert.doesNotThrow(() => checkForbiddenTokens(src, 'test'));
});

test('checkForbiddenTokens: comment-only Date.now does NOT error', () => {
  const src = `// Date.now() の語を含む comment\nexport const X = 1;\n`;
  assert.doesNotThrow(() => checkForbiddenTokens(src, 'test'));
});

test('checkForbiddenTokens: code-level import statement errors', () => {
  const src = `import x from 'y';\nexport const X = 1;\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /import/i);
});

test('checkForbiddenTokens: require() in code errors', () => {
  const src = `const m = require('mod');\nexport const X = 1;\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /require/i);
});

test('checkForbiddenTokens: Date.now() in code errors', () => {
  const src = `export const ts = Date.now();\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /Date\.now/i);
});

test('checkForbiddenTokens: Math.random() in code errors', () => {
  const src = `export const r = Math.random();\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /Math\.random/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (4): export default errors
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo errors on canonical with export default', () => {
  const canonical = `export default function() {}\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\n${markerEnd}\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /export/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (5): marker integrity errors
// ─────────────────────────────────────────────────────────────────────────────

test('scanMarkers errors on BEGIN without END', () => {
  const src = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====\ncode\n`;
  assert.throws(() => scanMarkers(src, 'wf.js'), /END.*missing|no matching END/i);
});

test('scanMarkers errors on END without preceding BEGIN', () => {
  const src = `// ==== END inline: _lib/fake.mjs ====\n`;
  assert.throws(() => scanMarkers(src, 'wf.js'), /BEGIN.*missing|unexpected END/i);
});

test('scanMarkers errors on BEGIN/END path mismatch', () => {
  const src = [
    `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`,
    `code`,
    `// ==== END inline: _lib/other.mjs ====`,
    ``,
  ].join('\n');
  assert.throws(() => scanMarkers(src, 'wf.js'), /mismatch|path/i);
});

test('syncRepo errors on duplicate inline of same canonical in one workflow', () => {
  const canonical = `export const X = 1;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\nconst X = 1;\n${markerEnd}\n${markerBegin}\nconst X = 1;\n${markerEnd}\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /duplicate/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('syncRepo errors when canonical file does not exist', () => {
  const markerBegin = `// ==== BEGIN inline: _lib/nonexistent.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/nonexistent.mjs ====`;
  const wf = `${markerBegin}\ncode\n${markerEnd}\n`;
  const tmp = mkdtempSync(join(os.tmpdir(), 'sync-inlines-'));
  mkdirSync(join(tmp, '_lib'), { recursive: true });
  mkdirSync(join(tmp, '.claude', 'workflows'), { recursive: true });
  writeFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), wf, 'utf8');
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /not found|ENOENT|exist/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (6): same canonical inlined into two different workflow files
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo regenerates inline in both workflow files when canonical shared', () => {
  const canonical = `export const SHARED = 'hello';\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf1 = `before\n${markerBegin}\nold content 1\n${markerEnd}\nafter\n`;
  const wf2 = `before\n${markerBegin}\nold content 2\n${markerEnd}\nafter\n`;
  const tmp = makeFixtureRepo(canonical, wf1, { multiWf: true, secondWfContent: wf2 });
  try {
    const result = syncRepo(tmp, { write: true });
    // Both files should be in results and changed
    const changedFiles = result.results.filter(r => r.changed).map(r => r.file);
    assert.ok(changedFiles.some(f => f.includes('wf.js')), 'wf.js should be changed');
    assert.ok(changedFiles.some(f => f.includes('wf2.js')), 'wf2.js should be changed');
    // Verify the written content
    const wf1Written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    const wf2Written = readFileSync(join(tmp, '.claude', 'workflows', 'wf2.js'), 'utf8');
    const expected = `const SHARED = 'hello';\n`;
    assert.ok(wf1Written.includes(expected), `wf.js should contain transformed content`);
    assert.ok(wf2Written.includes(expected), `wf2.js should contain transformed content`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (7): workflow file with zero markers passes through unchanged
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo leaves workflow file with no markers unchanged', () => {
  const canonical = `export const X = 1;\n`;
  const wf = `// just a regular workflow file\nconst a = 1;\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    const result = syncRepo(tmp, { write: false });
    const wfResult = result.results.find(r => r.file.includes('wf.js'));
    // Either not in results or changed=false
    if (wfResult) {
      assert.equal(wfResult.changed, false);
    }
    // File content unchanged
    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.equal(written, wf);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: CLI usage errors
// ─────────────────────────────────────────────────────────────────────────────

test('CLI exits 2 with no flags', () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
});

test('CLI exits 2 with both --write and --check', () => {
  const result = runCli(['--write', '--check']);
  assert.equal(result.status, 2);
});

test('CLI exits 2 with unknown flag', () => {
  const result = runCli(['--unknown-flag']);
  assert.equal(result.status, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t1-t3): collectTopLevelDeclNames unit tests
// ─────────────────────────────────────────────────────────────────────────────

test('collectTopLevelDeclNames extracts function, async function, const, let, var, class', () => {
  const src = `function foo(){}\nasync function bar(){}\nconst A = 1;\nlet b = 2;\nvar c = 3;\nclass D {}\n`;
  const names = collectTopLevelDeclNames(src);
  assert.deepEqual(names.sort(), ['A', 'D', 'b', 'bar', 'c', 'foo'].sort());
});

test('collectTopLevelDeclNames excludes indented nested declarations', () => {
  const src = `function outer() {\n  const inner = 1;\n}\n`;
  const names = collectTopLevelDeclNames(src);
  assert.ok(names.includes('outer'), 'should include outer');
  assert.ok(!names.includes('inner'), 'should NOT include inner (indented)');
});

test('collectTopLevelDeclNames excludes declarations in comments', () => {
  const src = `// const ghost = 1;\nconst real = 2;\n`;
  const names = collectTopLevelDeclNames(src);
  assert.ok(names.includes('real'), 'should include real');
  assert.ok(!names.includes('ghost'), 'should NOT include ghost (in comment)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t4): function declaration collision between two canonicals
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo throws on function declaration collision between two canonicals', () => {
  const canonical1 = `export function topicKey(x) { return x; }\n`;
  const canonical2 = `export function topicKey(y) { return y; }\n`;
  const markerBegin1 = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd1 = `// ==== END inline: _lib/fake.mjs ====`;
  const markerBegin2 = `// ==== BEGIN inline: _lib/fake2.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd2 = `// ==== END inline: _lib/fake2.mjs ====`;
  const wf = `${markerBegin1}\n${markerEnd1}\n${markerBegin2}\n${markerEnd2}\n`;
  const tmp = makeFixtureRepo(canonical1, wf, { extraCanonicals: { 'fake2.mjs': canonical2 } });
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /collision/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t5): const collision between two canonicals — explicit message, not SyntaxError
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo throws on const collision between two canonicals with explicit collision message', () => {
  const canonical1 = `export const topicKey = 1;\n`;
  const canonical2 = `export const topicKey = 2;\n`;
  const markerBegin1 = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd1 = `// ==== END inline: _lib/fake.mjs ====`;
  const markerBegin2 = `// ==== BEGIN inline: _lib/fake2.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd2 = `// ==== END inline: _lib/fake2.mjs ====`;
  const wf = `${markerBegin1}\n${markerEnd1}\n${markerBegin2}\n${markerEnd2}\n`;
  const tmp = makeFixtureRepo(canonical1, wf, { extraCanonicals: { 'fake2.mjs': canonical2 } });
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /collision/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t6): syntax error canonical throws with 'syntax' in message
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo throws with /syntax/i on canonical with syntax error', () => {
  const canonical = `export const X = ;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\n${markerEnd}\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /syntax/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t7): non-colliding two canonicals in one workflow — normal case
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo succeeds when two canonicals have no collision', () => {
  const canonical1 = `export const A = 1;\n`;
  const canonical2 = `export const B = 2;\n`;
  const markerBegin1 = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd1 = `// ==== END inline: _lib/fake.mjs ====`;
  const markerBegin2 = `// ==== BEGIN inline: _lib/fake2.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd2 = `// ==== END inline: _lib/fake2.mjs ====`;
  const wf = `${markerBegin1}\n// old A\n${markerEnd1}\n${markerBegin2}\n// old B\n${markerEnd2}\n`;
  const tmp = makeFixtureRepo(canonical1, wf, { extraCanonicals: { 'fake2.mjs': canonical2 } });
  try {
    assert.doesNotThrow(() => syncRepo(tmp, { write: true }));
    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.ok(written.includes('const A = 1;'), 'should contain A');
    assert.ok(written.includes('const B = 2;'), 'should contain B');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t8): same canonical in two different workflow files — per-file scope guard
// (guard: collision detection is per workflow file, not global)
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo does NOT collision-error when same canonical is inlined in two different workflow files', () => {
  const canonical = `export function topicKey(x) { return x; }\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf1 = `${markerBegin}\n// old 1\n${markerEnd}\n`;
  const wf2 = `${markerBegin}\n// old 2\n${markerEnd}\n`;
  const tmp = makeFixtureRepo(canonical, wf1, { multiWf: true, secondWfContent: wf2 });
  try {
    assert.doesNotThrow(() => syncRepo(tmp, { write: true }));
    const wf1Written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    const wf2Written = readFileSync(join(tmp, '.claude', 'workflows', 'wf2.js'), 'utf8');
    assert.ok(wf1Written.includes('function topicKey'), 'wf.js should contain topicKey');
    assert.ok(wf2Written.includes('function topicKey'), 'wf2.js should contain topicKey');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
