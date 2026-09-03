// issue #410 (#390 Phase 2): trust-telemetry.mjs のヘッダコメントが明記する宿題 —
// 「trust-mode.mjs / trust-digest.mjs は import しない self-containment のため layer 名・
// mode 値をローカル定数として重複定義しており、両定数の一致は Phase 2 の配線 test で担保する」
// を回収する固定テスト。kernel ファイル自体は変更しない（read-only 検証のみ）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TRUST_LAYERS, TRUST_MODES } from './trust-mode.mjs';
import { TELEMETRY_LAYERS, TELEMETRY_MODES } from './trust-telemetry.mjs';

test('trust-telemetry.TELEMETRY_LAYERS は trust-mode.TRUST_LAYERS と一致する', () => {
  assert.deepEqual(TELEMETRY_LAYERS, TRUST_LAYERS);
});

test('trust-telemetry.TELEMETRY_MODES は trust-mode.TRUST_MODES と一致する', () => {
  assert.deepEqual(TELEMETRY_MODES, TRUST_MODES);
});
