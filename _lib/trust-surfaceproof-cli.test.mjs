// issue #416 review 指摘の regression test: trust-surfaceproof-cli.mjs の
// cmdReconcile（および cmdFreeze）が buildInventory 直後の units
// （全 unit が presentation:'presented' 固定）をそのまま reconcileSource へ渡すと、
// pack.presentation_map による --presented の omission が units 側に反映されず、
// comment-only AC unit を presented から省いても reconcile.status/verdict が
// pass になってしまう（AC-4 の omission 検出が CLI 境界で無効化される）バグの再発防止。
//
// CLI をサブプロセスとして spawn し、実際の stdin/stdout/argv 境界を通して検証する
// （fixtures テストの runPipeline は _lib 関数呼び出しの単体検証であり、CLI 側の
// presentation_map マージ漏れは検出できないため、この回帰は CLI 境界で検証する必要がある）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'trust-surfaceproof-cli.mjs');
const FIXTURE_PATH = join(__dirname, 'fixtures', 'trust', 'surfaceproof', 'comment-only-ac.json');

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

function runCli(subcommand, argv, stdinObj) {
  const res = spawnSync(process.execPath, [CLI_PATH, subcommand, ...argv], {
    input: `${JSON.stringify(stdinObj)}\n`,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`CLI ${subcommand} failed (status=${res.status}): stdout=${res.stdout} stderr=${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

test('cli reconcile: comment unit を --presented から省くと REQUIRED_UNIT_OMITTED になり verdict は pass にならない', () => {
  const fixture = loadFixture();
  const tmp = mkdtempSync(join(os.tmpdir(), 'surfaceproof-cli-'));
  try {
    // fixture の全 unit を提示した状態で freeze する（comment unit も含めて fetched 済みにする）。
    const allUnitIds = ['body', 'comment:1', 'label:needs-triage'];
    const frozenPath = join(tmp, 'frozen.json');
    const freezeResult = runCli('freeze', [], fixture.snapshot);
    writeFileSync(frozenPath, JSON.stringify(freezeResult.frozen), 'utf8');
    // freeze 直後の units から comment unit の fetch 状態を確認（fetched でなければ
    // REQUIRED_UNIT_OMITTED が立たずテストの前提が崩れるため sanity check する）。
    const commentUnit = freezeResult.units.find((u) => u.unit_id === 'comment:1');
    assert.ok(commentUnit, 'comment:1 unit が buildInventory で生成されること');
    assert.equal(commentUnit.fetch, 'fetched');

    // reconcile 時、comment unit（受入条件が書かれている required unit）を --presented から
    // 意図的に省く（fixture の presented_unit_ids と同じ planted omission）。
    const presentedPath = join(tmp, 'presented.json');
    writeFileSync(presentedPath, JSON.stringify(fixture.presented_unit_ids), 'utf8');

    const { reconcile, receipt } = runCli(
      'reconcile',
      ['--frozen', frozenPath, '--presented', presentedPath],
      fixture.snapshot,
    );

    assert.equal(reconcile.status, 'REQUIRED_UNIT_OMITTED');
    assert.ok(
      reconcile.reasons.some((r) => r.unit_id === 'comment:1' && r.reason_code === 'REQUIRED_UNIT_OMITTED'),
      `reasons に comment:1 の REQUIRED_UNIT_OMITTED が含まれること: ${JSON.stringify(reconcile.reasons)}`,
    );
    assert.notEqual(receipt.outcome.verdict, 'pass');
    assert.equal(receipt.outcome.verdict, 'fail');

    void allUnitIds;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli reconcile: --presented 省略（全 unit 提示）なら reconcile.status=OK で verdict=pass になる', () => {
  const fixture = loadFixture();
  const tmp = mkdtempSync(join(os.tmpdir(), 'surfaceproof-cli-'));
  try {
    const frozenPath = join(tmp, 'frozen.json');
    const freezeResult = runCli('freeze', [], fixture.snapshot);
    writeFileSync(frozenPath, JSON.stringify(freezeResult.frozen), 'utf8');

    const { reconcile, receipt } = runCli('reconcile', ['--frozen', frozenPath], fixture.snapshot);

    assert.equal(reconcile.status, 'OK');
    assert.deepEqual(reconcile.reasons, []);
    assert.equal(receipt.outcome.verdict, 'pass');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
