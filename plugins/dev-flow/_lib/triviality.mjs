// classifyShape: realized diff の file 数と REQ 由来の決定論特徴量（AC 数 / issue_type / 構造化
// breaking_change）から実効 shape を決める純粋関数。dev-flow の Security floor（realized diff 取得後）
// で 1 回だけ呼ばれ、返り値が EFFECTIVE_SHAPE（Evaluate 深さ・LITE gate・merge tier の入力）になる。
//
// 入力は実装後の realized diff のみ。Analyze で LLM が出す事前見積もり（shape / 見込み file 数）は
// decision に使わない（issue #676）— 実装前の予測は log と失敗 telemetry にしか効かず、決定論なのは
// 写像と「欠損 → complex」の既定則だけだったため。micro の LITE 経路に対する意味的リスクの安全網は
// runEval 強制条件（danger-grep / testsurf / greenFix / dropped task / undeclared file / UI 接触）が担う。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// issue #272: AC 粒度と floor の較正 — micro floor の AC 境界を 3→4 に緩和。
// issue #278: breaking 判定を LLM 自由文 (scope/summary への regex) から、analyze REQ の
// 構造化 breaking_change フィールド + issue 本文への決定論 keyword scan の OR に変更。
// issue #364: keyword scan 単独 (breaking_keyword_scan=true && breaking_change!==true) は
// complex floor に採用しない (低 precision ヒューリスティック、実測 FP: #359/#361)。
// 構造化判定 breaking_change===true との corroboration があるときのみ floor へ採用する。
// issue #442: issue_type enum ドリフト修正 — AGENTS.md の正規 Conventional Commits 型 (chore/test/perf/ci) を validTypes に追加。

/**
 * @param {object} req - analyze REQ（acceptance_criteria / issue_type / breaking_change / breaking_keyword_scan を読む）
 * @param {number} realizedCount - realized diff の file 数（宣言外・format-only・ephemeral 除外後の整数。
 *   取得不能は NaN）
 * @returns {{ shape: 'micro'|'standard'|'complex', reason: string }}
 */
export function classifyShape(req, realizedCount) {
  const count = realizedCount;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    return { shape: 'complex', reason: `realized file count missing or invalid → safe floor=complex` };
  }

  const ac = req.acceptance_criteria;
  if (!Array.isArray(ac)) {
    return { shape: 'complex', reason: `acceptance_criteria missing or not array → safe floor=complex` };
  }

  const validTypes = ['feat', 'fix', 'docs', 'refactor', 'chore', 'test', 'perf', 'ci'];
  if (!validTypes.includes(req.issue_type)) {
    return { shape: 'complex', reason: `issue_type '${req.issue_type}' not in allowed set → floor=complex` };
  }

  // keyword-alone (breaking_keyword_scan=true かつ breaking_change!==true) は complex floor に
  // 採用しない (issue #364)。構造化判定とのみ組合せたときに blocking へ採用する。
  const keywordAlone = req.breaking_keyword_scan === true && req.breaking_change !== true;

  if (req.breaking_change === true) {
    const reason = `breaking change detected (analyze structured breaking_change=true`
      + (req.breaking_keyword_scan === true ? ' + issue title/body keyword scan hit' : '')
      + `) → floor=complex`;
    return { shape: 'complex', reason };
  }

  let shape;
  if (count <= 2 && ac.length <= 4) {
    shape = 'micro';
  } else if (count <= 5 && ac.length <= 6) {
    shape = 'standard';
  } else {
    shape = 'complex';
  }

  let reason = `realized ${count} file(s), ${ac.length} AC, type=${req.issue_type} → shape=${shape}`;
  if (keywordAlone) {
    reason += `（breaking keyword hit は構造化判定 breaking_change=false のため floor 不採用 — 可視化のみ。issue #364）`;
  }
  return { shape, reason };
}
