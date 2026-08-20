// isolation-stale-cleanup.integration.test.mjs
//
// issue #482 の再発（前 run が残した stale な `.devflow-tmp/.isolation-probe` により isolation が
// 正常でも probe が written:false → fail-closed abort する）が、probe prompt の Read-then-Write
// 冪等化を外しても起きないことを実 git リポジトリで検証する統合テスト（issue #493 AC-3）。
//
// 検証するのは isolationCleanupPrompt が指示する実コマンドそのもの。prompt から backtick で
// 括られたコマンドを取り出して実行するため、prompt とテストの間にコマンド文字列の drift が起きない。
//
// 検証項目:
//   1. stale artifact を事前配置した状態で cleanup を実行すると `.devflow-tmp/` ごと消える
//      → 後続の probe は「存在しないファイルへの Write」になり、Read 無しで成功しうる（#482 解消）
//   2. cleanup は `.devflow-tmp` の外（tracked / 他の untracked / 他の gitignored）を消さない
//      → 除去範囲が worktree 内 gitignored の run 専用 scratch に限定されている（AC-2）
//   3. `.devflow-tmp` が存在しない状態でも成功する（no-op 冪等 — 新規 worktree の初回 run）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolationCleanupPrompt, isolationProbePrompt } from './isolation-probe.mjs';

// prompt 内の `git -C <wt> clean -fdx -- <target>` を取り出す（drift 防止）。
function cleanupCommandFor(worktree, target = '.devflow-tmp') {
  const prompt = isolationCleanupPrompt(worktree, target);
  const m = prompt.match(/`(git -C [^`]+)`/);
  assert.ok(m, `isolationCleanupPrompt の出力から git コマンドを抽出できない:\n${prompt}`);
  return m[1].split(' ');
}

// prompt 内の probe 対象絶対パス（`` `<worktree>/.devflow-tmp/.isolation-probe-<token>` ``）を
// 取り出す（drift 防止。cleanupCommandFor と同スタイル）。
function probePathFor(worktree, token) {
  const prompt = isolationProbePrompt(worktree, token);
  const m = prompt.match(/`([^`]*\.isolation-probe-[^`]+)`/);
  assert.ok(m, `isolationProbePrompt の出力から probe パスを抽出できない:\n${prompt}`);
  return m[1];
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'iso-stale-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, '.gitignore'), '.devflow-tmp/\nother-ignored.txt\n');
  writeFileSync(join(dir, 'tracked.txt'), 'tracked\n');
  git('add', '.gitignore', 'tracked.txt');
  git('commit', '-m', 'init');
  return dir;
}

function placeStaleArtifacts(dir) {
  mkdirSync(join(dir, '.devflow-tmp'), { recursive: true });
  writeFileSync(join(dir, '.devflow-tmp', '.isolation-probe'), 'ok');
  writeFileSync(join(dir, '.devflow-tmp', 'trust-test-latest.json'), '{"tests":"green"}');
}

test('[stale-cleanup] 事前配置した stale probe artifact が cleanup で除去される（#482 の再発なし）', () => {
  const dir = makeRepo();
  try {
    placeStaleArtifacts(dir);
    assert.ok(existsSync(join(dir, '.devflow-tmp', '.isolation-probe')), '前提: stale artifact が配置されている');

    const [cmd, ...args] = cleanupCommandFor(dir);
    execFileSync(cmd, args, { encoding: 'utf8' });

    assert.ok(!existsSync(join(dir, '.devflow-tmp')), 'cleanup 後も .devflow-tmp/ が残っている');
    // 後続 probe と同じ状況: 未 Read のまま新規ファイルとして書ける
    mkdirSync(join(dir, '.devflow-tmp'), { recursive: true });
    writeFileSync(join(dir, '.devflow-tmp', '.isolation-probe'), 'ok');
    assert.ok(existsSync(join(dir, '.devflow-tmp', '.isolation-probe')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[stale-cleanup] 前 run の trust 証跡（.devflow-tmp 配下）も同時に除去される', () => {
  const dir = makeRepo();
  try {
    placeStaleArtifacts(dir);
    const [cmd, ...args] = cleanupCommandFor(dir);
    execFileSync(cmd, args, { encoding: 'utf8' });
    assert.ok(
      !existsSync(join(dir, '.devflow-tmp', 'trust-test-latest.json')),
      '前 run の trust 証跡が .devflow-tmp 配下に残っている',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[stale-cleanup] .devflow-tmp の外（tracked / 他 untracked / 他 gitignored）は消えない', () => {
  const dir = makeRepo();
  try {
    placeStaleArtifacts(dir);
    writeFileSync(join(dir, 'untracked.txt'), 'untracked\n');
    writeFileSync(join(dir, 'other-ignored.txt'), 'ignored\n');

    const [cmd, ...args] = cleanupCommandFor(dir);
    execFileSync(cmd, args, { encoding: 'utf8' });

    assert.ok(existsSync(join(dir, 'tracked.txt')), 'tracked ファイルが消えている');
    assert.ok(existsSync(join(dir, 'untracked.txt')), '.devflow-tmp 外の untracked が消えている');
    assert.ok(existsSync(join(dir, 'other-ignored.txt')), '.devflow-tmp 外の gitignored が消えている');
    assert.ok(!existsSync(join(dir, '.devflow-tmp')), '.devflow-tmp/ は除去されるべき');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// pr-iterate（nested 起動時は実行中 dev-flow run の worktree が対象）が使う file 単位の target。
// probe artifact だけを消し、当該 run が既に書いた trust 証跡は run 途中で失わないこと。
test('[stale-cleanup] target を probe artifact 単体に絞ると同じ .devflow-tmp 内の trust 証跡は残る', () => {
  const dir = makeRepo();
  try {
    placeStaleArtifacts(dir);
    const [cmd, ...args] = cleanupCommandFor(dir, '.devflow-tmp/.isolation-probe');
    execFileSync(cmd, args, { encoding: 'utf8' });

    assert.ok(
      !existsSync(join(dir, '.devflow-tmp', '.isolation-probe')),
      'probe artifact は除去されるべき',
    );
    assert.ok(
      existsSync(join(dir, '.devflow-tmp', 'trust-test-latest.json')),
      '同じ .devflow-tmp 配下の trust 証跡まで消えている（nested run の証跡喪失）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[stale-cleanup] probe artifact 単体 target も不在時は成功する（no-op 冪等）', () => {
  const dir = makeRepo();
  try {
    const [cmd, ...args] = cleanupCommandFor(dir, '.devflow-tmp/.isolation-probe');
    execFileSync(cmd, args, { encoding: 'utf8' });
    assert.ok(!existsSync(join(dir, '.devflow-tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[stale-cleanup] .devflow-tmp が無い新規 worktree でも成功する（no-op 冪等）', () => {
  const dir = makeRepo();
  try {
    const [cmd, ...args] = cleanupCommandFor(dir);
    // 1 回目: そもそも存在しない / 2 回目: 直前の実行で消えた状態
    execFileSync(cmd, args, { encoding: 'utf8' });
    execFileSync(cmd, args, { encoding: 'utf8' });
    assert.ok(!existsSync(join(dir, '.devflow-tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// issue #521: probe 対象パスを run 毎に一意な token 付きにしたことで、cleanup を実行しなくても
// （= 前 run の stale 残置物が cleanup 失敗により残っていても）probe 自体は成立することを検証する。
test('[stale-cleanup] stale 残置物（token 付き旧 run 分・legacy 無 token 分）が存在しても cleanup 不実行で probe が成立する', () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, '.devflow-tmp'), { recursive: true });
    writeFileSync(join(dir, '.devflow-tmp', '.isolation-probe-1000'), 'ok'); // 前 run の token 付き残置物
    writeFileSync(join(dir, '.devflow-tmp', '.isolation-probe'), 'ok'); // legacy（無 token）残置物

    // cleanup は実行しない（blocked/skip されたケースを模す）。
    const probePath = probePathFor(dir, '2000');
    assert.notEqual(probePath, join(dir, '.devflow-tmp', '.isolation-probe-1000'));
    assert.notEqual(probePath, join(dir, '.devflow-tmp', '.isolation-probe'));
    assert.ok(!existsSync(probePath), '前提: 今回 run の probe パスはまだ存在しない');

    writeFileSync(probePath, 'ok');
    assert.ok(existsSync(probePath), '今回 run の probe パスへの新規書き込みが成立するべき');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
