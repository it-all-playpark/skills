// devflow-durations: dev-flow run の duration_seconds / phase_durations 算出用の純関数群。
// I/O なし・Date.now/Math.random 不使用。専用 clock probe は 0 回 —
// start は Setup 冒頭の setup-base probe（resolve-base + worktree-base-check 統合 exec-proxy）の
// optional epoch、end は Merge tier 末尾の post-summary 応答の optional epoch から給電し、
// 全 11 mark（start/analyze_start/analyze_end/plan_end/implement_end/validate_end/evaluate_end/
// pr_end/iterate_end/final_end/end）が隣接する既存 exec-proxy / agent 応答の optional epoch
// フィールドから recordClockMark へ給電される（fail-open — 給電元失敗は当該 mark null →
// 対応 duration キー欠落）。contract 経路の analyze_end は Analyze 冒頭の contract-probe epoch を
// 使うため shape 判定の時間が plan 区間へ付け替わる — phase_durations は
// 相対比較・分布用途のため許容する（計測意味は経路間で非対称）。
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
 * 隣接する既存 exec-proxy / agent 応答から recordClockMark 給電用の {ok:true, epoch} を抽出する。
 * ok フラグの有無は見ない（LLM agent 応答には ok が無いため）。epoch が有限数値でなければ null。
 * @param {{epoch?: unknown}|null|undefined} res - 給電元の応答 object
 * @returns {{ok: true, epoch: number}|null}
 */
export function epochResOf(res) {
  if (!res || typeof res !== 'object') {
    return null;
  }
  const epoch = res.epoch;
  if (typeof epoch === 'number' && Number.isFinite(epoch)) {
    return { ok: true, epoch };
  }
  return null;
}

/**
 * epochResOf 由来の候補配列（null 混在可）から最大 epoch の給電結果を選ぶ。
 * 並列 implementer など完了順が不定な複数給電元から「最後に完了したもの」を採用するために使う。
 * @param {Array<{ok: true, epoch: number}|null>|null|undefined} list - epochResOf の適用結果配列
 * @returns {{ok: true, epoch: number}|null}
 */
export function maxEpochRes(list) {
  if (!Array.isArray(list)) {
    return null;
  }
  let best = null;
  for (const item of list) {
    const res = epochResOf(item);
    if (res !== null && (best === null || res.epoch > best.epoch)) {
      best = res;
    }
  }
  return best;
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
