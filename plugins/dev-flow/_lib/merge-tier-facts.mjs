// parseMergeTierFacts: dev-flow Merge tier が使う統合 exec-proxy
// (`_shared/scripts/merge-tier-facts.sh`) の応答をサブ結果ごとに独立に検証する純関数 (issue #637)。
//
// 統合スクリプトは {diffhash, risk, changed, pr, head_tree, checks, epoch} の 1 JSON object を返し、
// サブ結果は全て {ok, value, error?} 形。本関数は「1 サブ結果の不正が他サブ結果の判定に影響しない」
// ことを保証するため、各サブ結果を完全に独立して検証し、旧 6 spawn（diff-hash-merge /
// danger-grep-final / changed-files / gh-pr-view / head-tree-oid / ci-checks）が個別に返していた
// 形へ写す。呼び出し側の判定ロジック（reuseSecFloor / reconcileDanger / classifyMergeableState /
// hash_reconverged / envChecksGreen）はこの写像の上で不変。
//
// サブ結果別失敗ポリシー（旧 spawn の fail-closed / fail-open 区別と同一）:
//   mergeDiffHash - fail-open。diffhash.ok===true かつ value.hash が string のときのみ採用、それ以外 null
//                   （null は「Security floor 結果の再利用不可 → danger-grep 再判定」と
//                   「hash_reconverged 判定不能 → hash_mismatch 維持」に倒れる）。
//   risk          - fail-closed。risk.ok===true かつ value が {ok:boolean, hits:array} のときのみ採用。
//                   それ以外は {ok:false, hits:[], error} を合成（null は返さない — hits 欠落を clean と
//                   同一視しない。呼び出し側は risk.ok!==true を dangerFailClosed として HOLD 強制）。
//   changedFiles  - fail-safe。changed.ok===true かつ value.files が string[] のときのみ採用、それ以外 null
//                   （null は isDocsOrTestOnly が false を返し AUTO 昇格しない安全側）。
//   prMeta        - fail-open。pr.ok===true かつ value が object のときのみ {ok:true, mergeable,
//                   mergeStateStatus, headRefOid}、それ以外 {ok:false, error}
//                   （classifyMergeableState が 'unknown' → conflict gate は HOLD しない）。
//   headTreeOid   - fail-open。head_tree.ok===true かつ value.tree が非空 string のときのみ trim して採用
//                   （旧 head-tree-oid spawn と同じ受理条件。40hex 検証は script 側）、それ以外 null
//                   （hash_mismatch 維持 = HOLD）。
//   checks        - fail-open。checks.ok===true かつ value.checks が array のときのみ {ok:true, checks}、
//                   それ以外 {ok:false, error}（ENV item 据え置き + 警告 log）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// mergeTierFactsPrompt({ wt, base, pr, repo }): 統合 exec-proxy の prompt。
// gh の 2 コマンドは subagent が bare 単文で実行し、stdout を argv で merge-tier-facts へ verbatim 転写する
// （exec-proxy スクリプトは認証付き network I/O を内部に持たない契約。check-ci / finalCiPrompt と同型）。
// base は origin/ 無しの branch 名を受け、prompt 側で origin/ を付ける（既存 call site と同じ）。
export function mergeTierFactsPrompt({ wt, base, pr, repo }) {
  const repoArg = repo ? ' --repo ' + repo : '';
  const bare = '（cd 前置・`bash` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクトは禁止）';
  return `## Objective\nPR #${pr} の Merge tier 判定に使う事実を取得し、merge-tier-facts の stdout JSON をそのまま返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push, git fetch, git pull\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。git mutation（commit/push/reset/fetch/pull 等）禁止。ファイルを変更しない\n\n`
    + `## Steps\n`
    + `1. \`gh pr view ${pr}${repoArg} --json mergeable,mergeStateStatus,headRefOid\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ${bare}。stdout を <PR_VIEW> とする。\n`
    + `2. \`gh pr checks ${pr}${repoArg} --json name,bucket\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ${bare}。`
    + `このコマンドの exit code を判定に使ってはならない（pending で 8、失敗ありで 1 を返す仕様であり、fetch 自体の成否とは無関係）。stdout を <CHECKS> とする。\n`
    + `3. \`merge-tier-facts --worktree ${wt} --base origin/${base} --pr-view-data '<手順1の stdout を一字一句そのまま。要約・整形・省略禁止>' `
    + `--checks-data '<手順2の stdout を一字一句そのまま。要約・整形・省略禁止>'\` を先頭トークンが merge-tier-facts の bare 単文で 1 回だけ実行せよ。`
    + `手順 1 / 2 の stdout が空、またはコマンドが実行できなかった場合は当該オプション自体を省略せよ（値を捏造してはならない）。`
    + `argv は一字一句そのまま実行する — which による絶対パス解決・絶対パスへの書き換え・cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結は禁止`
    + `（--worktree で worktree 絶対パスを渡しているため cd は不要）。\n`
    + `4. 手順 3 の stdout の JSON 1 行を **そのまま** 返せ（判定・要約・整形・省略禁止）。`
    + `手順 3 自体が実行できなかった、または stdout が JSON でない場合のみ \`{"risk":{"ok":false,"value":null,"error":"<stderr の要約>"}}\` を返せ。`
    + `失敗時に ok:true を生成してはならない。原因調査はするな。再試行禁止。\n\n`
    + `## Output format\n`
    + `merge-tier-facts の stdout JSON（{diffhash, risk, changed, pr, head_tree, checks, epoch}。各サブ結果は {ok, value, error?}）\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}

// サブ結果が契約通りの形か（{ok:boolean} を持つ object）。error は ok:false 時の診断値。
function subOk(sub) {
  return sub != null && typeof sub === 'object' && sub.ok === true;
}

function subError(sub, fallback) {
  if (sub != null && typeof sub === 'object' && typeof sub.error === 'string' && sub.error !== '') return sub.error;
  return fallback;
}

export function parseMergeDiffHash(facts) {
  const sub = facts?.diffhash;
  const hash = subOk(sub) ? sub.value?.hash : null;
  return typeof hash === 'string' && hash !== '' ? hash : null;
}

// risk サブ結果が契約通りの形か。fail-closed に倒れた 2 原因 — proxy が契約外形状を返した /
// スクリプトが契約通りの形で ok:false を報告した — を呼び出し側が区別するための述語。
export function isWellFormedRiskFact(facts) {
  const sub = facts?.risk;
  if (!subOk(sub)) return false;
  const v = sub.value;
  return v != null && typeof v === 'object' && typeof v.ok === 'boolean' && Array.isArray(v.hits);
}

export function parseRiskFact(facts) {
  if (isWellFormedRiskFact(facts)) return facts.risk.value;
  return { ok: false, hits: [], error: subError(facts?.risk, 'merge-tier-facts risk unavailable (fail-closed)') };
}

export function parseChangedFiles(facts) {
  const sub = facts?.changed;
  const files = subOk(sub) ? sub.value?.files : null;
  if (Array.isArray(files) && files.every((f) => typeof f === 'string')) return files;
  return null;
}

export function parsePrMeta(facts) {
  const sub = facts?.pr;
  if (subOk(sub) && sub.value != null && typeof sub.value === 'object') {
    const v = sub.value;
    return {
      ok: true,
      mergeable: typeof v.mergeable === 'string' ? v.mergeable : null,
      mergeStateStatus: typeof v.mergeStateStatus === 'string' ? v.mergeStateStatus : null,
      headRefOid: typeof v.headRefOid === 'string' ? v.headRefOid : null,
    };
  }
  return { ok: false, error: subError(sub, 'merge-tier-facts pr unavailable') };
}

export function parseHeadTreeOid(facts) {
  const sub = facts?.head_tree;
  const tree = subOk(sub) ? sub.value?.tree : null;
  return typeof tree === 'string' && tree.trim() !== '' ? tree.trim() : null;
}

export function parseChecks(facts) {
  const sub = facts?.checks;
  if (subOk(sub) && Array.isArray(sub.value?.checks)) return { ok: true, checks: sub.value.checks };
  return { ok: false, error: subError(sub, 'merge-tier-facts checks unavailable') };
}

// 診断用: facts の top-level キー一覧（契約外形状のとき log に出す）
export function mergeTierFactsTopLevelKeys(facts) {
  if (facts == null) return 'null';
  if (typeof facts !== 'object') return typeof facts;
  const keys = Object.keys(facts);
  return keys.length ? keys.join(',') : '(none)';
}

export function parseMergeTierFacts(facts) {
  return {
    mergeDiffHash: parseMergeDiffHash(facts),
    risk: parseRiskFact(facts),
    changedFiles: parseChangedFiles(facts),
    prMeta: parsePrMeta(facts),
    headTreeOid: parseHeadTreeOid(facts),
    checks: parseChecks(facts),
  };
}
