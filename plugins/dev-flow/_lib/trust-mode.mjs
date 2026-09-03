// issue #409 (epic #390 Phase 1): trust-layer protocol kernel — layer 別 mode
// (off/shadow/advisory/blocking) と全体 kill switch を解決する純粋関数群。
//
// Phase 0 spec (claudedocs/2026-07-20-issue-390-phase0-child-decomposition-and-shadow-boundary.md
// §3「Shadow opt-in 境界決定」) の決定を実装する:
//   - repoSlug は allowlist（TRUST_SHADOW_REPO_SLUG）に厳密一致（===）する場合のみ非 off を許可。
//     null / undefined / 別 repo / fork / 大文字小文字違いは全て fail-closed で off。
//   - killSwitch===true は allowlist 一致・configuredMode に関わらず全 layer を強制 off。
//   - repoSlug の取得（git remote get-url / GITHUB_REPOSITORY 読み取り）は adapter の責務
//     （Phase 2+）であり、本モジュールは文字列注入のみ受ける（他モジュール非依存・import なし）。

export const TRUST_LAYERS = ['surfaceproof', 'evalseal', 'effectdelta'];

export const TRUST_MODES = ['off', 'shadow', 'advisory', 'blocking'];

export const DEFAULT_TRUST_MODE = 'off';

export const TRUST_SHADOW_REPO_SLUG = 'it-all-playpark/skills';

// layer 別の trust mode を解決する純粋関数。
//
// 優先順位:
//   (a) layer が TRUST_LAYERS 外 → throw
//   (b) configuredMode が null/undefined/空文字 → DEFAULT_TRUST_MODE、TRUST_MODES 外 → throw
//   (c) killSwitch === true → 'off'（全 layer 無効化）
//   (d) repoSlug が TRUST_SHADOW_REPO_SLUG と厳密一致しない → 'off'（fail-closed allowlist）
//   (e) 一致した場合のみ configuredMode をそのまま返す
export function resolveLayerMode({ layer, configuredMode, repoSlug, killSwitch }) {
  if (!TRUST_LAYERS.includes(layer)) {
    throw new Error(
      `trust-mode: 未知の layer "${layer}"（許可: ${TRUST_LAYERS.join(', ')}）`,
    );
  }

  const mode = configuredMode == null || configuredMode === '' ? DEFAULT_TRUST_MODE : configuredMode;
  if (!TRUST_MODES.includes(mode)) {
    throw new Error(
      `trust-mode: 未知の configuredMode "${configuredMode}"（許可: ${TRUST_MODES.join(', ')}）`,
    );
  }

  if (killSwitch === true) return 'off';
  if (repoSlug !== TRUST_SHADOW_REPO_SLUG) return 'off';
  return mode;
}

// TRUST_LAYERS 全てについて resolveLayerMode を適用し {surfaceproof, evalseal, effectdelta}
// を返す純粋関数。config は各 layer キーを持つ部分 object（未指定は DEFAULT_TRUST_MODE）。
// config 内の未知 key は closed（throw）。
export function resolveAllLayerModes({ config, repoSlug, killSwitch }) {
  const safeConfig = config ?? {};
  for (const key of Object.keys(safeConfig)) {
    if (!TRUST_LAYERS.includes(key)) {
      throw new Error(
        `trust-mode: 未知の config key "${key}"（許可: ${TRUST_LAYERS.join(', ')}）`,
      );
    }
  }

  const result = {};
  for (const layer of TRUST_LAYERS) {
    result[layer] = resolveLayerMode({
      layer,
      configuredMode: safeConfig[layer],
      repoSlug,
      killSwitch,
    });
  }
  return result;
}

// mode が既存 gate を変更する（gating）かどうかを判定する純粋関数。
// blocking のときのみ true。shadow/advisory/off は既存 gate を一切変えない
// （epic #390 AC-11 / AC-15 非緩和）。TRUST_MODES 外は throw。
export function isGatingMode(mode) {
  if (!TRUST_MODES.includes(mode)) {
    throw new Error(
      `trust-mode: 未知の mode "${mode}"（許可: ${TRUST_MODES.join(', ')}）`,
    );
  }
  return mode === 'blocking';
}
