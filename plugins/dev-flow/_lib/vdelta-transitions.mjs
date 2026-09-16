// vdelta-transitions: redgreen R1↔R2 の veridelta verdict から deny-only チェックを判定する。
// 用途: red&&green の決定論昇格を維持したまま、test 変更込みの「勝利宣言」を deny する
// advisory シグナル（INV-10: record_integrity=advisory 恒久、blocking gate 化はしない）。
// test_cmd 経路が走らなかった invocation 向けの redgreen headdiff digest も本ファイルで持つ。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

export function vdeltaDenies(verdict) {
  if (verdict === null || verdict === undefined) {
    return { deny: false, reasons: [], status: 'fail_open' };
  }

  let parsed = verdict;
  if (typeof verdict === 'string') {
    try {
      parsed = JSON.parse(verdict);
    } catch {
      return { deny: false, reasons: [], status: 'fail_open' };
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { deny: false, reasons: [], status: 'fail_open' };
  }

  const { transitions } = parsed;
  if (typeof transitions !== 'object' || transitions === null || Array.isArray(transitions)) {
    return { deny: false, reasons: [], status: 'fail_open' };
  }

  if (parsed.comparability !== 'exact') {
    return { deny: false, reasons: [], status: 'abstain' };
  }

  const reasons = [];

  const repaired = transitions.repaired_with_test_change;
  if (Array.isArray(repaired) && repaired.length > 0) {
    reasons.push(`repaired_with_test_change(${repaired.length}件)`);
  }

  const surfaceStatus = parsed.verification_surface?.status;
  if (surfaceStatus !== undefined && surfaceStatus !== 'intact') {
    reasons.push(`verification_surface:${surfaceStatus}`);
  }

  if (reasons.length > 0) {
    return { deny: true, reasons, status: 'deny' };
  }

  return { deny: false, reasons: [], status: 'clean' };
}

// vdeltaVerdictDigest: raw verdict（テスト名・anchors・run_id・transitions 配列本体等を含み得る）を
// telemetry に安全に載せられる閉じた 4 キー scalar digest へ還元する（issue #433 方式 B）。
// redaction 原則: 生の verdict フィールドは一切保持しない。
export function vdeltaVerdictDigest(verdict) {
  const status = vdeltaDenies(verdict).status;

  let parsed = verdict;
  if (typeof verdict === 'string') {
    try {
      parsed = JSON.parse(verdict);
    } catch {
      parsed = null;
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status, comparability: null, verification_surface: null, repaired_with_test_change: 0 };
  }

  const comparability = typeof parsed.comparability === 'string' ? parsed.comparability.slice(0, 64) : null;

  const surfaceStatus = parsed.verification_surface?.status;
  const verification_surface = typeof surfaceStatus === 'string' ? surfaceStatus.slice(0, 64) : null;

  const repaired = parsed.transitions?.repaired_with_test_change;
  const repaired_with_test_change = Array.isArray(repaired) ? repaired.length : 0;

  return { status, comparability, verification_surface, repaired_with_test_change };
}

// redgreenHeaddiffDigest: redgreen-verify.sh が test_cmd 経路の走らなかった invocation で返す
// headdiff {new, modified, unchanged, total}（test_files の HEAD 基準三分類件数）を、telemetry に載せる
// 閉じた digest へ還元する。status は clean / test_modified / fail_open の 3 値。
// HEAD に存在する test を書き換えた（modified>0）場合だけ test_modified — 新規 test（new）は
// 実装と同時に書かれるのが期待値なので改変扱いにしない。記録専用で deny / 昇格の入力にはしない。
export function redgreenHeaddiffDigest(headdiff) {
  const zero = { new: 0, modified: 0, unchanged: 0, total: 0 };
  if (typeof headdiff !== 'object' || headdiff === null || Array.isArray(headdiff)) {
    return { status: 'fail_open', ...zero };
  }
  const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const { new: n, modified, unchanged, total } = headdiff;
  if (!isCount(n) || !isCount(modified) || !isCount(unchanged) || !isCount(total)) {
    return { status: 'fail_open', ...zero };
  }
  return { status: modified > 0 ? 'test_modified' : 'clean', new: n, modified, unchanged, total };
}
