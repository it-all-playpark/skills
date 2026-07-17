// devflow-durations: dev-flow run の duration_seconds / phase_durations 算出用の純関数群。
// I/O なし・Date.now/Math.random 不使用。時刻取得は dev-runner-haiku-ro exec-proxy（clockProbePrompt）
// に委譲し、recordClockMark/computeDurations が結果を集計する（fail-open — probe 失敗は当該区間欠落）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// dev-flow.js の probe 発火順と一致する序列。
export const CLOCK_MARK_ORDER = [
  'start',
  'analyze_start',
  'analyze_end',
  'plan_end',
  'implement_end',
  'validate_end',
  'evaluate_end',
  'pr_end',
  'iterate_end',
  'final_end',
  'end',
];

// phase キー → 終端 mark 名。
export const CLOCK_PHASE_ENDS = [
  ['analyze', 'analyze_end'],
  ['plan', 'plan_end'],
  ['implement', 'implement_end'],
  ['validate', 'validate_end'],
  ['evaluate', 'evaluate_end'],
  ['pr', 'pr_end'],
  ['iterate', 'iterate_end'],
  ['final', 'final_end'],
];

/**
 * exec-proxy（dev-runner-haiku-ro）向けの現在時刻取得 prompt を返す。
 */
export function clockProbePrompt() {
  return '## Objective\n'
    + '現在時刻の epoch 秒を取得する。\n'
    + '\n'
    + '## Instructions\n'
    + '`date +%s` を実行し、出力の整数を epoch として返せ。成功なら ok:true。失敗しても throw せず ok:false を返すこと。\n'
    + '\n'
    + '## Output format\n'
    + '{ "ok": boolean, "epoch": number }\n'
    + '\n'
    + '## Tools\n'
    + '使用可: Bash のみ\n'
    + '\n'
    + '## Boundary\n'
    + 'ファイル変更禁止。git 操作禁止。\n'
    + '\n'
    + '## Token cap\n'
    + '30 語以内で完結すること。';
}

// marks から number 値のみを取り出す内部ヘルパー（null/undefined/非数値/NaN は null 扱い）。
function readMark(marks, name) {
  const v = marks ? marks[name] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * exec-proxy の応答 res を marks[name] へ記録する。
 * 成功（ok:true かつ epoch が有限数値）なら marks[name]=epoch を設定し null を返す。
 * 失敗（null / ok:false / schema 不一致）は marks[name]=null を設定し警告文字列を返す（fail-open）。
 * @param {object} marks - mutate 対象の mark 集計 object
 * @param {string} name - CLOCK_MARK_ORDER 上の mark 名
 * @param {{ok?: boolean, epoch?: number}|null} res - exec-proxy 応答
 * @returns {string|null} 警告文字列、または成功時 null
 */
export function recordClockMark(marks, name, res) {
  const ok = res && res.ok === true && typeof res.epoch === 'number' && Number.isFinite(res.epoch);
  if (ok) {
    marks[name] = res.epoch;
    return null;
  }
  marks[name] = null;
  return `⚠️ clock#${name} の取得に失敗 — duration telemetry は当該区間を欠落させる（fail-open）`;
}

/**
 * marks から duration_seconds（run 全体）と phase_durations（8 phase）を算出する。
 * @param {object} marks - CLOCK_MARK_ORDER の各 mark 名をキーに持つ object（値は epoch 秒 or null）
 * @returns {{duration_seconds: number|null, phase_durations: object}}
 */
export function computeDurations(marks) {
  const start = readMark(marks, 'start');
  const end = readMark(marks, 'end');
  let duration_seconds = null;
  if (start !== null && end !== null) {
    const diff = end - start;
    if (diff >= 0) {
      duration_seconds = diff;
    }
  }

  const phase_durations = {};
  for (const [key, endMarkName] of CLOCK_PHASE_ENDS) {
    const endVal = readMark(marks, endMarkName);
    if (endVal === null) {
      continue;
    }
    const endIdx = CLOCK_MARK_ORDER.indexOf(endMarkName);
    let startVal = null;
    for (let i = endIdx - 1; i >= 0; i--) {
      const v = readMark(marks, CLOCK_MARK_ORDER[i]);
      if (v !== null) {
        startVal = v;
        break;
      }
    }
    if (startVal === null) {
      continue;
    }
    const diff = endVal - startVal;
    if (diff < 0) {
      continue;
    }
    phase_durations[key] = diff;
  }

  return { duration_seconds, phase_durations };
}
