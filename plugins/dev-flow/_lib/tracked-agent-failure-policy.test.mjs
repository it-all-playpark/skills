import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from '../../../tools/sync-inlines.mjs';
import { neutralizeRegexLiterals, blankStringLiterals } from './test-helpers/source-scan.mjs';

/**
 * tracked-agent-failure-policy.test.mjs — trackedAgent( 全出現の 3 分類強制（issue #605）
 *
 * dev-flow.js / pr-iterate.js の call site は必ず以下のいずれかに属する:
 *   1. need() 内                — 契約の null は中断（fail-closed。既存の need() throw 経路）。
 *   2. failOpenAgent wrapper 内 — trackedAgent の throw を吸収し null へ倒す（fail-open、issue #499/#605）。
 *   3. 明示 ALLOWLIST           — 上記いずれでもない bare `await trackedAgent(...)` 呼び出し。throw は
 *      run を abort させる。ALLOWLIST は「据え置き」の可視化そのものであり、各 entry は
 *      policy（'fail-safe' | 'fail-closed'）+ reason（20 字以上）を明示する。
 *
 * 'fail-safe' は「throw を吸収する try{}/pipeline() に call site が実際に包まれているか」を
 * 機械検証する（reason だけの自己申告を認めない）。dev-flow.js / pr-iterate.js には run 全体を
 * 保護する安全網 try（Setup 直後 〜 末尾 catch。throw を log して rethrow するのみで継続しない）が
 * 存在するため、この安全網に包まれているだけの occurrence は fail-safe とは判定しない
 * （TOP_LEVEL_TRY_MARKER で特定し除外する）。
 *
 * 新規 call site を追加するときは上記 3 択のいずれかを選ぶ: need() で包む / failOpenAgent 経由にする /
 * ALLOWLIST に policy と reason を登録する。ALLOWLIST に無い bare 出現はこのテストが red になり、
 * 失敗メッセージが未分類 key の一覧と 3 択を提示する。
 *
 * 'fail-closed（据え置き）' entry は「null は fail-open だが throw は未吸収」という既存動作を
 * 変えないまま可視化するためのもの。fail-open 化は本 issue（#605）のスコープ外で別 issue に送る。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 構造検出ヘルパー ────────────────────────────────────────────────

// blanked（regex literal 中和 + コメント除去 + 文字列/テンプレート中身空白化済み）上で
// openIdx の対応する閉じ括弧の index を返す（見つからなければ -1）。
function findMatchingClose(str, openIdx, openCh, closeCh) {
  let depth = 1;
  let j = openIdx + 1;
  while (j < str.length && depth > 0) {
    if (str[j] === openCh) depth++;
    else if (str[j] === closeCh) depth--;
    j++;
  }
  return depth === 0 ? j - 1 : -1;
}

// index i が「i より前で最後に出現した pipeline( 呼び出し」の引数 span 内にあるかを判定する。
function isWithinPipelineArgs(blanked, i) {
  const marker = 'pipeline(';
  let searchFrom = 0;
  let lastSpan = null;
  let idx;
  while ((idx = blanked.indexOf(marker, searchFrom)) !== -1 && idx < i) {
    const openParen = idx + marker.length - 1;
    const closeParen = findMatchingClose(blanked, openParen, '(', ')');
    lastSpan = closeParen === -1 ? null : [openParen, closeParen];
    searchFrom = idx + marker.length;
  }
  if (!lastSpan) return false;
  return i > lastSpan[0] && i < lastSpan[1];
}

// index i から blanked を後方走査し、直近の包囲ブロックが try{} かどうかを判定する。
// - `}` で depth++、`{` で depth>0 なら depth-- / depth===0 ならブロックの opener とみなす。
// - opener が run 全体の安全網 try（topLevelTryBraceIdx。throw を rethrow するのみで
//   fail-safe な継続を提供しない）なら NG（try 包囲扱いしない）。
// - opener 直前の非空白テキストが `try` で終われば OK。
// - `finally` で終わる場合は NG（throw は伝播する — try 包囲に数えない）。
// - `=>` または `function <name>(...)` の関数境界で終わる場合は NG（ここで走査を止める —
//   ローカルな try に包まれないまま関数スコープを抜けたことが確定するため）。
// - それ以外（if/for/while 等の透過的なブロック）は継続して外側を探索する。
function isTryWrapped(blanked, i, topLevelTryBraceIdx) {
  let depth = 0;
  let j = i - 1;
  while (j >= 0) {
    const c = blanked[j];
    if (c === '}') { depth++; j--; continue; }
    if (c === '{') {
      if (depth > 0) { depth--; j--; continue; }
      if (j === topLevelTryBraceIdx) return false;
      const before = blanked.slice(0, j).replace(/\s+$/, '');
      if (/\btry\s*$/.test(before)) return true;
      if (/\bfinally\s*$/.test(before)) return false;
      if (/=>\s*$/.test(before)) return false;
      if (/function\s*[A-Za-z0-9_$]*\s*\([^()]*\)\s*$/.test(before)) return false;
      j--;
      continue;
    }
    j--;
  }
  return false;
}

// 引数 span の label: 式テキストを抽出する。blankedSpan（string/template 中身が空白化済み・
// 元 codeSpan と同長・同 index 対応）で label: キーの位置とその値の「トップレベルの , または
// 閉じ } まで」を depth 追跡し、対応する index 範囲を codeSpan（raw テキスト、クオート等保持）から
// 切り出す。shorthand property（`label,` — pr-iterate.js の callReviewAgent(prompt, label) 呼び出し）
// は key テキストとして 'label' を返す。label が取れなければ null。
function extractLabelKey(blankedSpan, codeSpan) {
  const colonMatch = blankedSpan.match(/(?<![A-Za-z0-9_$])label\s*:/);
  if (colonMatch) {
    let start = colonMatch.index + colonMatch[0].length;
    while (start < blankedSpan.length && /\s/.test(blankedSpan[start])) start++;
    let depth = 0;
    let end = start;
    while (end < blankedSpan.length) {
      const c = blankedSpan[end];
      if (c === '(' || c === '[' || c === '{') { depth++; end++; continue; }
      if (c === ')' || c === ']') { depth--; end++; continue; }
      if (c === '}') {
        if (depth === 0) break;
        depth--; end++; continue;
      }
      if (c === ',' && depth === 0) break;
      end++;
    }
    return codeSpan.slice(start, end).trim();
  }
  const shorthandMatch = blankedSpan.match(/(?<![A-Za-z0-9_$])label(?=\s*(?:,|\}))/);
  if (shorthandMatch) return 'label';
  return null;
}

// TARGET のソースを分類する: { need, wrapper, bare } の 3 バケツ。
// bare は label key ごとにグルーピングし { count, occurrences:[{index, tryOk, pipelineOk}] } を持つ。
function classify(rawSrc) {
  const code = stripComments(neutralizeRegexLiterals(rawSrc));
  const blanked = blankStringLiterals(code);
  assert.equal(code.length, blanked.length, 'blankStringLiterals は入力長を保つ invariant を満たすこと');

  const wrapperMarker = 'async function failOpenAgent(prompt, opts) {';
  const wrapperStart = blanked.indexOf(wrapperMarker);
  assert.ok(wrapperStart !== -1, 'failOpenAgent wrapper 定義が見つからない');
  const wrapperOpenBrace = wrapperStart + wrapperMarker.length - 1;
  const wrapperEnd = findMatchingClose(blanked, wrapperOpenBrace, '{', '}');
  assert.ok(wrapperEnd !== -1, 'failOpenAgent wrapper の閉じ } が見つからない');

  // run 全体の安全網 try（列頭=インデント無しの `try {`。throw を log して rethrow するのみで
  // fail-safe な継続を提供しない — dev-flow.js/pr-iterate.js の abort-telemetry 用 top-level
  // try/catch。他の全ローカル try はインデントされているため列頭マーカーで一意に特定できる）。
  const topLevelTryMarker = '\ntry {\n';
  const topLevelTryIdx = blanked.indexOf(topLevelTryMarker);
  assert.ok(topLevelTryIdx !== -1, '列頭（非インデント）の安全網 try が見つからない');
  const topLevelTryBraceIdx = topLevelTryIdx + topLevelTryMarker.indexOf('{');

  const re = /(?<![A-Za-z0-9_$.])trackedAgent\s*\(/g;
  let m;
  const need = [];
  const wrapper = [];
  const bare = new Map(); // label key -> { occurrences: [{index, tryOk, pipelineOk}] }
  const unlabeled = [];

  while ((m = re.exec(blanked))) {
    const i = m.index;
    // trackedAgent 自身の function 宣言（`async function trackedAgent(prompt, opts) {`）は
    // 呼び出し site ではないので分類対象から除外する。
    const before20 = blanked.slice(Math.max(0, i - 20), i);
    if (/function\s+$/.test(before20)) continue;

    const before40 = blanked.slice(Math.max(0, i - 40), i).replace(/\s+/g, ' ');
    if (/need\( ?await ?$/.test(before40)) { need.push(i); continue; }

    if (i > wrapperOpenBrace && i < wrapperEnd) { wrapper.push(i); continue; }

    const openIdx = blanked.indexOf('(', i);
    const closeIdx = findMatchingClose(blanked, openIdx, '(', ')');
    assert.ok(closeIdx !== -1, `trackedAgent( 呼び出し（index ${i}）の閉じ ) が見つからない`);
    const argSpanCode = code.slice(openIdx + 1, closeIdx);
    const argSpanBlanked = blanked.slice(openIdx + 1, closeIdx);
    const label = extractLabelKey(argSpanBlanked, argSpanCode);
    if (label == null) { unlabeled.push(i); continue; }

    const tryOk = isTryWrapped(blanked, i, topLevelTryBraceIdx);
    const pipelineOk = isWithinPipelineArgs(blanked, i);
    if (!bare.has(label)) bare.set(label, { occurrences: [] });
    bare.get(label).occurrences.push({ index: i, tryOk, pipelineOk });
  }

  assert.equal(unlabeled.length, 0, `label が取得できない trackedAgent( 出現が ${unlabeled.length} 件（index: ${unlabeled.join(', ')}）— need() で包む / failOpenAgent 経由にする / opts に label を追加すること`);

  return { need, wrapper, bare };
}

// ── ALLOWLIST（issue #605）────────────────────────────────────────
//
// policy: 'fail-safe'   — try{}/pipeline() 包囲を機械検証する（分類が満たさなければテストが fail）。
// policy: 'fail-closed' — reason（20 字以上）のみで根拠づける（機械検証は無し）。
//   - 「意図的」= null 時に downstream が明示的に fail-closed へ倒す設計。
//   - 「据え置き」= null は fail-open だが throw は未吸収（本 issue のスコープ外。reason に
//     「別 issue で fail-open 化」を明記する）。

const ALLOWLIST = {
  'dev-flow.js': {
    // ---- fail-safe（try 包囲）----
    "'contract-probe#' + ISSUE": {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し sonnet analyze へ fallback する既存の fail-open 経路（issue #374）',
    },
    "'issue-meta'": {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し fail-closed（取得検証不能扱い）として続行する（issue #451）',
    },
    'isRetry ? `test#retry-${i}` : `test#${i}`': {
      policy: 'fail-safe',
      reason: 'try/catch で throw を red 扱いの合成 GREEN オブジェクトへ変換し継続する（issue #359）',
    },
    "'danger-grep'": {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し unified=null → per-field fail-closed フォールバックへ倒す',
    },
    "'ui-verify-config'": {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し setup_failed（fail-open な advisory gate）として skip する',
    },
    "'ui-verify-server' + labelSuffix": {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し failed_open（advisory な UI 検証 gate）として継続する',
    },
    "'ui-verify' + labelSuffix": {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し failed_open（advisory な UI 検証 gate）として継続する',
    },
    "'test#final'": {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し null 扱い（unavailable → merge tier HOLD）で継続する（issue #359）',
    },
    "'ui-verify-config-final'": {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し setup_failed（advisory・test gate は維持）として skip する',
    },
    "'ci-final'": {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し null 扱い（fail-closed → unavailable 維持）で継続する（issue #599）',
    },
    // ---- fail-safe（pipeline 包囲）----
    '`${tag}:par:${t.id}`': {
      policy: 'fail-safe',
      reason: 'pipeline() の callback throw は harness-native の fail-open で per-item null に落ちる（issue #332）',
    },

    // ---- fail-closed（意図的）----
    "'setup-base'": {
      policy: 'fail-closed',
      reason: 'base/worktree 起点が確定しないまま進むと PR diff に base 間差分が乗る。null は resolveBase の fail-closed throw と同側。契約違反は retryOnContractViolation で 1 回リトライ済み',
    },
    '`analyze-retry#${ISSUE}`': {
      policy: 'fail-closed',
      reason: '再分析不能のまま再実装させない。null は needs_clarification 中断で run は abort しない',
    },
    'isRetry ? `green-fix#retry-${i}` : `green-fix#${i}`': {
      policy: 'fail-closed',
      reason: 'ファイル編集の副作用を伴う fix agent。throw 時は tree が部分変更の可能性があり黙って Evaluate へ進めない',
    },
    '`fix#${i}`': {
      policy: 'fail-closed',
      reason: '同上（Evaluate の implementation fix）。ファイル編集副作用があるため throw を黙って吸収しない',
    },
    "'issue-labels'": {
      policy: 'fail-closed',
      reason: 'empty-diff gate の cross-repo 判定材料。取得不能で gate を通過させない（issue #432）',
    },
    "'cross-repo-artifacts'": {
      policy: 'fail-closed',
      reason: 'empty-diff gate の cross-repo 判定材料。取得不能で gate を通過させない（issue #432）',
    },
    "'final-ac-reconcile'": {
      policy: 'fail-closed',
      reason: '最終 AC 再検証の結果不明のまま merge tier を確定しない（軸A 決定論検証、issue #331）',
    },
    "'security-clearance-final'": {
      policy: 'fail-closed',
      reason: 'W7 軸A: security clearance 不能を clear と同一視しない（security floor invariant）',
    },

    // ---- fail-closed（据え置き — null は fail-open/fail-safe だが throw は未吸収。
    //      fail-open 化は issue #605 非スコープで別 issue へ送る）----
    "'isolation-probe'": {
      policy: 'fail-closed',
      reason: 'bg-isolation 検知は fail-closed 設計（throw で回避手順を提示）。fail-open 化は別 issue の検討対象',
    },
    "'worktree-deps'": {
      policy: 'fail-closed',
      reason: 'deps install 結果不明のまま以降の実装を進めるべきでない。throw 吸収は別 issue の検討対象',
    },
    '`redgreen:AC-${r.ac_index + 1}`': {
      policy: 'fail-closed',
      reason: 'red→green 昇格判定の throw 吸収は未整備（据え置き）。fail-open 化は issue #605 の非スコープ',
    },
    "'pr-review-lite'": {
      policy: 'fail-closed',
      reason: 'lite route の pr-reviewer 1-pass。throw 吸収は未整備（据え置き）。別 issue で fail-open 化を検討',
    },
    "'reconcile-sync'": {
      policy: 'fail-closed',
      reason: 'Final reconcile の worktree 同期。throw 吸収は未整備（据え置き）。別 issue で fail-open 化を検討',
    },
    "'changed-files-final'": {
      policy: 'fail-closed',
      reason: 'Final reconcile の最終 changed-files 取得。throw 吸収は未整備（据え置き。別 issue の検討対象）',
    },
    "'ui-verify-teardown' + labelSuffix": {
      policy: 'fail-closed',
      reason: 'finally 内の呼び出しで try 包囲ではない（throw は伝播する）。teardown 失敗は手動確認の余地を残す設計として据え置き',
    },
    "'gh-pr-view'": {
      policy: 'fail-closed',
      reason: 'Merge tier の PR meta 取得。throw 吸収は未整備（据え置き）。別 issue で fail-open 化を検討',
    },
    "'ci-checks'": {
      policy: 'fail-closed',
      reason: 'ENV item auto-close の CI 状態取得。throw 吸収は未整備（据え置き）。別 issue で fail-open 化を検討',
    },
    "'post-summary'": {
      policy: 'fail-closed',
      reason: 'PR summary コメント投稿。throw 吸収は未整備（据え置き）。別 issue で fail-open 化を検討',
    },
  },
  'pr-iterate.js': {
    '`fix#${i}`': {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し fix=null（null-retry 経路）として継続する（issue #437/#520）',
    },
    '`fix#${i}-retry`': {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し fix=null として継続する（issue #437/#520 の retry 経路）',
    },
    label: {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し review=null（schema-retry 経路）として継続する（issue #437）',
    },
    '`${label}-schema-retry`': {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し review=null として継続する（issue #437 の retry 経路）',
    },
    '`commit-ensure#${i}`': {
      policy: 'fail-safe',
      reason: 'try/catch で throw を吸収し ensured=null（fail-safe → fix_failed エスカレーション）で継続する',
    },
  },
};

const POLICY_VALUES = new Set(['fail-safe', 'fail-closed']);

// ── target 定義・分類・テスト ────────────────────────────────────

const TARGETS = [
  { name: 'dev-flow.js', path: join(HERE, '..', '.claude', 'workflows', 'dev-flow.js') },
  { name: 'pr-iterate.js', path: join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js') },
];

for (const { name, path } of TARGETS) {
  const rawSrc = readFileSync(path, 'utf8');
  const { need, wrapper, bare } = classify(rawSrc);
  const allow = ALLOWLIST[name] ?? {};

  test(`${name}: bare trackedAgent( 出現は全て ALLOWLIST に登録されている`, () => {
    const missing = [...bare.keys()].filter((k) => !(k in allow));
    assert.equal(
      missing.length,
      0,
      `未分類の bare trackedAgent( 呼び出しが ${missing.length} 件: ${JSON.stringify(missing)}。\n` +
      `新規 call site は以下いずれかで解消すること:\n` +
      `  1. need(await trackedAgent(...)) で包む（契約 null は中断）\n` +
      `  2. failOpenAgent(...) 経由にする（throw を fail-open で吸収）\n` +
      `  3. このファイルの ALLOWLIST['${name}'] に { policy, reason } を明示登録する`,
    );
  });

  test(`${name}: ALLOWLIST の各 entry は bare 出現とちょうど 1 件対応する（stale entry / 重複を検出）`, () => {
    for (const [key, entry] of Object.entries(allow)) {
      const occ = bare.get(key);
      assert.ok(occ, `ALLOWLIST['${name}']['${key}'] に対応する bare 出現が無い（stale entry — 削除するか key を修正すること）`);
      const expectedCount = entry.count ?? 1;
      assert.equal(
        occ.occurrences.length,
        expectedCount,
        `ALLOWLIST['${name}']['${key}'] の想定件数 ${expectedCount} に対し実際の出現が ${occ.occurrences.length} 件。` +
        `重複 label なら entry に count を明示すること`,
      );
    }
  });

  test(`${name}: ALLOWLIST の policy は closed enum ('fail-safe' | 'fail-closed')`, () => {
    for (const [key, entry] of Object.entries(allow)) {
      assert.ok(POLICY_VALUES.has(entry.policy), `ALLOWLIST['${name}']['${key}'].policy が不正な値: ${entry.policy}`);
    }
  });

  test(`${name}: ALLOWLIST の reason は 20 文字以上の非空文字列`, () => {
    for (const [key, entry] of Object.entries(allow)) {
      assert.equal(typeof entry.reason, 'string', `ALLOWLIST['${name}']['${key}'].reason が文字列でない`);
      assert.ok(entry.reason.trim().length >= 20, `ALLOWLIST['${name}']['${key}'].reason が 20 字未満: ${JSON.stringify(entry.reason)}`);
    }
  });

  test(`${name}: policy:'fail-safe' の entry は try{}/pipeline() 包囲を機械検証で満たす`, () => {
    for (const [key, entry] of Object.entries(allow)) {
      if (entry.policy !== 'fail-safe') continue;
      const occ = bare.get(key);
      assert.ok(occ, `ALLOWLIST['${name}']['${key}'] に対応する bare 出現が無い`);
      for (const o of occ.occurrences) {
        assert.ok(
          o.tryOk || o.pipelineOk,
          `ALLOWLIST['${name}']['${key}']（index ${o.index}）は policy:'fail-safe' だが try{}/pipeline() 包囲が機械検証で確認できない`,
        );
      }
    }
  });
}

// ── 参照 sanity（走査ズレ検出）────────────────────────────────────

test('dev-flow.js: need() 分類が 10 件以上・wrapper 分類がちょうど 1 件（走査ズレ検出）', () => {
  const rawSrc = readFileSync(join(HERE, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');
  const { need, wrapper } = classify(rawSrc);
  assert.ok(need.length >= 10, `need() 分類が ${need.length} 件（10 件以上を期待）`);
  assert.equal(wrapper.length, 1, `wrapper 分類が ${wrapper.length} 件（1 件を期待）`);
});

test('pr-iterate.js: wrapper 分類がちょうど 1 件（走査ズレ検出）', () => {
  const rawSrc = readFileSync(join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js'), 'utf8');
  const { wrapper } = classify(rawSrc);
  assert.equal(wrapper.length, 1, `wrapper 分類が ${wrapper.length} 件（1 件を期待）`);
});

// ── drift pin: .claude/rules/dev-flow.md の diff-hash 行 ↔ 実装 ──────

test('.claude/rules/dev-flow.md の diff-hash 行の失敗検出セルに agent throw が明記されている（AC-4）', () => {
  const rulesPath = join(HERE, '..', '..', '..', '.claude', 'rules', 'dev-flow.md');
  const rulesSrc = readFileSync(rulesPath, 'utf8');
  const diffHashLine = rulesSrc.split('\n').find((line) => line.startsWith('| diff-hash |'));
  assert.ok(diffHashLine, '.claude/rules/dev-flow.md に `| diff-hash |` で始まる行が見つからない');
  const cols = diffHashLine.split('|').map((c) => c.trim());
  // cols[0] は空文字（先頭 `|` の前）、cols[1] は 'diff-hash'、cols[2] が失敗検出セル
  const failureDetectionCell = cols[2];
  assert.ok(
    failureDetectionCell && failureDetectionCell.includes('agent throw'),
    `diff-hash 行の失敗検出セルに 'agent throw' が含まれない: ${JSON.stringify(failureDetectionCell)}`,
  );
});

test('dev-flow.js: diff-hash 3 箇所が failOpenAgent(state.dhPrompt 経由・trackedAgent(state.dhPrompt は 0 件（S1 実装の pin）', () => {
  const rawSrc = readFileSync(join(HERE, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');
  const failOpenCount = (rawSrc.match(/failOpenAgent\(state\.dhPrompt/g) ?? []).length;
  const bareTrackedCount = (rawSrc.match(/trackedAgent\(state\.dhPrompt/g) ?? []).length;
  assert.equal(failOpenCount, 3, `failOpenAgent(state.dhPrompt 呼び出しが ${failOpenCount} 件（3 件を期待 — diff-hash-eval/pr/merge）`);
  assert.equal(bareTrackedCount, 0, `bare trackedAgent(state.dhPrompt 呼び出しが ${bareTrackedCount} 件残存（0 件を期待 — failOpenAgent 経由に置換済みのはず）`);
});
