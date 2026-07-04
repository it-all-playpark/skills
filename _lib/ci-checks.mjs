// dev-flow Merge tier phase: gh pr checks の結果から build 系 CI check が全 green かを
// 判定する純関数群。CI green を根拠に auto-close してよい ENV item を allowlist で限定する
// （AC-3。npm-cache-eperm 等 build 検証系でない ENV key は含めない）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// build 検証系 CI check 名の判定 regex。
export const BUILD_CHECK_RE = /build|vercel|ci/i;

// CI green で auto-close してよい ENV key の allowlist（npm-cache-eperm 等は含めない）。
export const CI_VERIFIABLE_ENV_KEYS = ['turbopack-sandbox'];

// gh pr checks exec-proxy の agent() schema。
export const CHECKS = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'bucket'],
        properties: {
          name: { type: 'string' },
          bucket: { type: 'string' },
        },
      },
    },
    error: { type: 'string' },
  },
};

// gh pr checks --json name,bucket の出力から build 系 check が全 pass かを判定する純関数。
export function buildChecksGreen(checks) {
  if (!Array.isArray(checks)) {
    return { green: false, reason: 'invalid', checkNames: [] };
  }
  const builds = checks.filter((c) => c && typeof c.name === 'string' && BUILD_CHECK_RE.test(c.name));
  if (builds.length === 0) {
    return { green: false, reason: 'no-build-checks', checkNames: [] };
  }
  const checkNames = builds.map((c) => c.name);
  if (builds.every((c) => c.bucket === 'pass')) {
    return { green: true, reason: 'all-pass', checkNames };
  }
  if (builds.some((c) => c.bucket === 'pending')) {
    return { green: false, reason: 'pending', checkNames };
  }
  return { green: false, reason: 'not-pass', checkNames };
}
