import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONCERN_ENV_PATTERNS, classifyConcern, classifyConcerns } from './concern-classify.mjs';

test('classifyConcern: turbopack-sandbox パターンに該当', () => {
  const text = 'sandbox 内で next build が TurbopackInternalError で失敗（os error 1）';
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'turbopack-sandbox' });
});

test('classifyConcern: npm-cache-eperm パターンに該当', () => {
  const text = 'npm install が EPERM: operation not permitted で失敗。cache folder contains root-owned files';
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'npm-cache-eperm' });
});

test('classifyConcern: edit-write-isolation パターンに該当', () => {
  const text = "Edit tool blocked: parent bg session hasn't isolated ため heredoc で代替した";
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'edit-write-isolation' });
});

test('classifyConcern: sandbox-denied パターンに該当', () => {
  const text = 'サンドボックスの権限で npx の実行が拒否された';
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'sandbox-denied' });
});

test('classifyConcern: 非該当文は concern のまま', () => {
  const text = 'ORDER BY 句のバリデーション未実装';
  assert.deepEqual(classifyConcern(text), { kind: 'concern' });
});

test('classifyConcern: 複数行 concern（改行を含む turbopack 文）も match する（s フラグ検証）', () => {
  const text = 'sandbox 内で next build を実行したところ以下のエラーが発生した:\nTurbopackInternalError: build failed\n(os error 1)';
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'turbopack-sandbox' });
});

test('classifyConcerns: 同一 turbopack 文 x3 + 非該当 1 件 → env 1 要素・count 3・representative は 1 件目全文', () => {
  const dup = 'sandbox 内で next build が TurbopackInternalError で失敗（os error 1）';
  const other = 'ORDER BY 句のバリデーション未実装';
  const result = classifyConcerns([dup, dup, dup, other]);
  assert.deepEqual(result.env, [{ key: 'turbopack-sandbox', count: 3, representative: dup }]);
  assert.deepEqual(result.concerns, [other]);
});

test('classifyConcerns: 異なる env key 混在時に出現順が保持される', () => {
  const turbo = 'next build が TurbopackInternalError で失敗（os error 1）';
  const eperm = 'npm install が EPERM: operation not permitted で失敗';
  const isolation = "Edit tool blocked: parent bg session hasn't isolated";
  const result = classifyConcerns([eperm, turbo, isolation, turbo]);
  assert.deepEqual(result.env, [
    { key: 'npm-cache-eperm', count: 1, representative: eperm },
    { key: 'turbopack-sandbox', count: 2, representative: turbo },
    { key: 'edit-write-isolation', count: 1, representative: isolation },
  ]);
  assert.deepEqual(result.concerns, []);
});

test('classifyConcerns: null 要素は "null" 文字列として concern 側に落ちる', () => {
  const result = classifyConcerns([null, undefined]);
  assert.deepEqual(result.concerns, ['null', 'undefined']);
  assert.deepEqual(result.env, []);
});

test('classifyConcern: 複数パターン同時該当は配列順 first-match（turbopack→eperm→isolation→denied）', () => {
  const text = 'sandbox で EPERM 拒否';
  // turbopack パターンは非該当、eperm パターンが最初にマッチするはず
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'npm-cache-eperm' });
});

test('CONCERN_ENV_PATTERNS: 5 パターンが配列順 turbopack→bats→eperm→isolation→denied で定義されている', () => {
  assert.deepEqual(
    CONCERN_ENV_PATTERNS.map((p) => p.key),
    ['turbopack-sandbox', 'bats-sandbox', 'npm-cache-eperm', 'edit-write-isolation', 'sandbox-denied'],
  );
});

test('classifyConcern: bats-sandbox パターンに該当（未インストール文脈）', () => {
  const text = 'sandbox 環境に bats がインストールされていないため bats テストは CI に委譲した';
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'bats-sandbox' });
});

test('classifyConcern: bats-sandbox パターンに該当（command not found）', () => {
  const text = 'bats: command not found のため tests/run-all-bats.sh が graceful skip した';
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'bats-sandbox' });
});

test('classifyConcern: bats-sandbox は sandbox-denied より優先される（non-vacuous first-match）', () => {
  const text = 'sandbox で bats の実行が拒否されたため bats は未インストール状態';
  // この fixture は sandbox-denied 側にも実際にマッチすることを確認した上で、
  // 配列順（bats-sandbox が先）により bats-sandbox が返ることを検証する。
  const sandboxDeniedRe = CONCERN_ENV_PATTERNS.find((p) => p.key === 'sandbox-denied').re;
  assert.equal(sandboxDeniedRe.test(text), true);
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'bats-sandbox' });
});

test('classifyConcern: bats-sandbox は npm-cache-eperm より優先される（non-vacuous first-match）', () => {
  const text = 'bats install が EPERM で失敗し bats は未インストールのまま';
  // この fixture は npm-cache-eperm 側にも実際にマッチすることを確認した上で、
  // 配列順（bats-sandbox が先）により bats-sandbox が返ることを検証する。
  const epermRe = CONCERN_ENV_PATTERNS.find((p) => p.key === 'npm-cache-eperm').re;
  assert.equal(epermRe.test(text), true);
  assert.deepEqual(classifyConcern(text), { kind: 'environment', key: 'bats-sandbox' });
});

test('classifyConcern: bats の skip 単独言及は環境ノートに吸収されない（過剰マッチ防止）', () => {
  const text = 'bats テストの一部 case を skip した（フレーク対策）';
  assert.deepEqual(classifyConcern(text), { kind: 'concern' });
});

test('classifyConcerns: 入力配列を mutate しない', () => {
  const input = ['ORDER BY 句のバリデーション未実装'];
  const frozen = Object.freeze([...input]);
  assert.doesNotThrow(() => classifyConcerns(frozen));
});
