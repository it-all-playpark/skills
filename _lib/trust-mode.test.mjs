import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  TRUST_LAYERS,
  TRUST_MODES,
  DEFAULT_TRUST_MODE,
  TRUST_SHADOW_REPO_SLUG,
  resolveLayerMode,
  resolveAllLayerModes,
  isGatingMode,
} from './trust-mode.mjs';

const OK_SLUG = 'it-all-playpark/skills';

// ---- (0) 定数 ----

test('TRUST_LAYERS は 3 layer 配列', () => {
  assert.deepEqual(TRUST_LAYERS, ['surfaceproof', 'evalseal', 'effectdelta']);
});

test('TRUST_MODES は off/shadow/advisory/blocking の 4 値配列', () => {
  assert.deepEqual(TRUST_MODES, ['off', 'shadow', 'advisory', 'blocking']);
});

test('DEFAULT_TRUST_MODE は off', () => {
  assert.equal(DEFAULT_TRUST_MODE, 'off');
});

test('TRUST_SHADOW_REPO_SLUG は it-all-playpark/skills', () => {
  assert.equal(TRUST_SHADOW_REPO_SLUG, 'it-all-playpark/skills');
});

// ---- (1) resolveLayerMode: allowlist 一致時の解決 ----

test('resolveLayerMode: slug 一致 + configuredMode=shadow → shadow', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'shadow', repoSlug: OK_SLUG, killSwitch: false }),
    'shadow',
  );
});

test('resolveLayerMode: slug 一致 + configuredMode=advisory → advisory', () => {
  assert.equal(
    resolveLayerMode({ layer: 'evalseal', configuredMode: 'advisory', repoSlug: OK_SLUG, killSwitch: false }),
    'advisory',
  );
});

test('resolveLayerMode: slug 一致 + configuredMode=blocking → blocking', () => {
  assert.equal(
    resolveLayerMode({ layer: 'effectdelta', configuredMode: 'blocking', repoSlug: OK_SLUG, killSwitch: false }),
    'blocking',
  );
});

test('resolveLayerMode: slug 一致 + configuredMode=off → off', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'off', repoSlug: OK_SLUG, killSwitch: false }),
    'off',
  );
});

// ---- (2) resolveLayerMode: allowlist 不一致 → fail-closed off ----

test('resolveLayerMode: repoSlug=null → off（configuredMode=blocking でも）', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'blocking', repoSlug: null, killSwitch: false }),
    'off',
  );
});

test('resolveLayerMode: repoSlug=undefined → off', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'blocking', repoSlug: undefined, killSwitch: false }),
    'off',
  );
});

test('resolveLayerMode: repoSlug=空文字 → off', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'blocking', repoSlug: '', killSwitch: false }),
    'off',
  );
});

test('resolveLayerMode: repoSlug=別repo → off', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'blocking', repoSlug: 'other/repo', killSwitch: false }),
    'off',
  );
});

test('resolveLayerMode: repoSlug=fork（it-all-playpark/skills-fork）→ off', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'blocking', repoSlug: 'it-all-playpark/skills-fork', killSwitch: false }),
    'off',
  );
});

test('resolveLayerMode: repoSlug=大文字違い（It-All-Playpark/Skills）→ off（大文字小文字区別）', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'blocking', repoSlug: 'It-All-Playpark/Skills', repoSlug2: undefined, killSwitch: false }),
    'off',
  );
});

// ---- (3) kill switch ----

test('resolveLayerMode: killSwitch=true → slug 一致 + blocking でも off', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'blocking', repoSlug: OK_SLUG, killSwitch: true }),
    'off',
  );
});

test('resolveLayerMode: killSwitch=true + repoSlug 不一致 → off', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'blocking', repoSlug: 'other/repo', killSwitch: true }),
    'off',
  );
});

// ---- (4) configuredMode の既定・出処外 ----

test('resolveLayerMode: configuredMode=null → off（DEFAULT_TRUST_MODE、slug 一致でも）', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: null, repoSlug: OK_SLUG, killSwitch: false }),
    'off',
  );
});

test('resolveLayerMode: configuredMode=undefined → off', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: undefined, repoSlug: OK_SLUG, killSwitch: false }),
    'off',
  );
});

test('resolveLayerMode: configuredMode=空文字 → off', () => {
  assert.equal(
    resolveLayerMode({ layer: 'surfaceproof', configuredMode: '', repoSlug: OK_SLUG, killSwitch: false }),
    'off',
  );
});

test('resolveLayerMode: configuredMode=out-of-enum("on") → throw', () => {
  assert.throws(
    () => resolveLayerMode({ layer: 'surfaceproof', configuredMode: 'on', repoSlug: OK_SLUG, killSwitch: false }),
    /trust-mode: 未知の configuredMode "on"/,
  );
});

test('resolveLayerMode: layer=out-of-enum("vdelta") → throw', () => {
  assert.throws(
    () => resolveLayerMode({ layer: 'vdelta', configuredMode: 'shadow', repoSlug: OK_SLUG, killSwitch: false }),
    /trust-mode: 未知の layer "vdelta"/,
  );
});

// ---- (5) resolveAllLayerModes ----

test('resolveAllLayerModes: 部分 config + slug 一致で各 layer を解決', () => {
  const result = resolveAllLayerModes({
    config: { surfaceproof: 'shadow', evalseal: 'blocking' },
    repoSlug: OK_SLUG,
    killSwitch: false,
  });
  assert.deepEqual(result, { surfaceproof: 'shadow', evalseal: 'blocking', effectdelta: 'off' });
});

test('resolveAllLayerModes: config 省略時は全 layer が off', () => {
  const result = resolveAllLayerModes({ config: {}, repoSlug: OK_SLUG, killSwitch: false });
  assert.deepEqual(result, { surfaceproof: 'off', evalseal: 'off', effectdelta: 'off' });
});

test('resolveAllLayerModes: repoSlug 不一致で全 layer off（configuredMode に依らず）', () => {
  const result = resolveAllLayerModes({
    config: { surfaceproof: 'blocking', evalseal: 'blocking', effectdelta: 'blocking' },
    repoSlug: 'other/repo',
    killSwitch: false,
  });
  assert.deepEqual(result, { surfaceproof: 'off', evalseal: 'off', effectdelta: 'off' });
});

test('resolveAllLayerModes: killSwitch=true で全 layer off', () => {
  const result = resolveAllLayerModes({
    config: { surfaceproof: 'blocking', evalseal: 'advisory', effectdelta: 'shadow' },
    repoSlug: OK_SLUG,
    killSwitch: true,
  });
  assert.deepEqual(result, { surfaceproof: 'off', evalseal: 'off', effectdelta: 'off' });
});

test('resolveAllLayerModes: config 内の未知 key は throw', () => {
  assert.throws(
    () => resolveAllLayerModes({ config: { surfaceproof: 'shadow', vdelta: 'shadow' }, repoSlug: OK_SLUG, killSwitch: false }),
    /trust-mode: 未知の config key "vdelta"/,
  );
});

// ---- (6) isGatingMode ----

test('isGatingMode: blocking のみ true', () => {
  assert.equal(isGatingMode('blocking'), true);
});

test('isGatingMode: shadow/advisory/off は false', () => {
  assert.equal(isGatingMode('shadow'), false);
  assert.equal(isGatingMode('advisory'), false);
  assert.equal(isGatingMode('off'), false);
});

test('isGatingMode: out-of-enum は throw', () => {
  assert.throws(() => isGatingMode('on'), /trust-mode: 未知の mode "on"/);
});
