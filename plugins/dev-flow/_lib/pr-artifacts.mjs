// pr-artifacts: dev-flow PR phase の commit message / PR body / spawn prompt を state（issue / req /
// plan / ledger / risk hits）から組み立てる純関数群 (issue #642)。
//
// PR phase 時点で必要な材料（issue title / type / AC / plan.summary / architecture_decisions /
// task 一覧 / ledger の AC checked 状態 / danger・testsurf hit）は workflow が全て state に持っている。
// LLM に diff を読み直させて文章を再生成させる代わりに、ここで決定論的に組み立てた本文を
// dev-runner-haiku が verbatim で `.devflow-tmp/` へ保存し、bare 単文の git / gh を順に実行する
// （agent 側の要約・判断を挟まない転写契約。pr-iterate の commit-ensure と同型）。
// 同一入力 → 同一出力（決定論）。I/O なし。
//
// PR body は「結論1行 → 変更(component別) → 受入条件 checkbox → 設計判断(≤5件) → 検証 → Closes」の
// 6 セクション固定構成で、各セクションを PR_BODY_* 定数で決定論 clip する（issue #661）。
// Closes 行の存在検証（hasClosesLine / verifyPrBody / extractPrBody / closesVerdict）と、`gh pr view --json body` /
// `gh pr edit --body-file` の exec-proxy prompt（prBodyViewPrompt / prBodyEditPrompt）もここに置き、
// 判定は本ファイルの純関数のみが行う（agent は verbatim 転写・bare 単文実行のみ）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// Conventional Commits の type/scope prefix（`type(scope)!: rest`）。issue title が既に prefix 付きの
// 場合に type/scope を再利用し、`refactor(x): refactor(x): ...` の二重 prefix を避ける。
const CONVENTIONAL_PREFIX_RE = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/;

function str(v) {
  return v == null ? '' : String(v);
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// code point 単位で数え、超過時は先頭 max-1 文字 + '…' に切り詰める決定論 truncation。
export function clip(s, max) {
  const text = str(s);
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

// 改行・連続空白（タブ含む）を 1 空白に畳んで trim する。
function collapseWhitespace(s) {
  return str(s).replace(/\s+/g, ' ').trim();
}

// plan の file_changes（`path: 説明` 形も許容）から path 部分を取り出す。
function planPaths(plan) {
  const out = [];
  for (const t of arr(plan?.serial)) {
    for (const fc of arr(t?.file_changes)) {
      const p = str(fc).split(':')[0].trim();
      if (p) out.push(p);
    }
  }
  return out;
}

// 全 path に共通する先頭ディレクトリの末尾セグメントを scope とする（`plugins/dev-flow/_lib/a.mjs` +
// `plugins/dev-flow/.claude/workflows/dev-flow.js` → `dev-flow`）。共通 dir が無ければ null。
function scopeFromPaths(paths) {
  if (paths.length === 0) return null;
  let common = paths[0].split('/').slice(0, -1);
  for (const p of paths.slice(1)) {
    const segs = p.split('/').slice(0, -1);
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) return null;
  }
  return common.length ? common[common.length - 1] : null;
}

// commit message: `<type>(<scope>): <title> (#<issue>)` + 空行 + plan.summary。末尾改行付き
// （`git commit -F` 用）。type は req.issue_type > title の prefix > 'chore'、scope は title の
// prefix > plan.file_changes の共通 dir > 無し。
export function buildCommitMessage({ issue, req, plan }) {
  const rawTitle = str(req?.issue_title).trim();
  const m = CONVENTIONAL_PREFIX_RE.exec(rawTitle);
  const type = str(req?.issue_type).trim() || (m ? m[1] : '') || 'chore';
  const scope = (m && m[2] ? m[2].trim() : '') || scopeFromPaths(planPaths(plan)) || '';
  const title = m ? m[3].trim() : rawTitle;
  const subject = `${type}${scope ? `(${scope})` : ''}: ${title} (#${issue})`;
  const body = str(plan?.summary).trim();
  return body ? `${subject}\n\n${body}\n` : `${subject}\n`;
}

function decisionLine(d) {
  if (d != null && typeof d === 'object') {
    const decision = str(d.decision).trim();
    const rationale = str(d.rationale).trim();
    if (decision) return rationale ? `${decision} — ${rationale}` : decision;
    return JSON.stringify(d);
  }
  return str(d).trim();
}

function cell(v) {
  return str(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

// PR body の上限定数（issue #661: planner 出力は無制限 verbatim ではなく決定論 clip で埋め込む）。
export const PR_BODY_SUMMARY_MAX = 120;
export const PR_BODY_CHANGE_BULLET_MAX = 140;
export const PR_BODY_CHANGE_BULLETS_MAX = 6;
export const PR_BODY_AC_MAX = 300;
export const PR_BODY_DECISIONS_MAX = 5;
export const PR_BODY_DECISION_MAX = 120;
export const PR_BODY_HIT_ITEMS_MAX = 5;
export const PR_BODY_MAX_CHARS = 3500;
// PR_BODY_MAX_CHARS 超過時に buildPrBody が決定論的に詰める順序と刻み（issue #665）:
// 1. hit item の file path を PR_BODY_HIT_PATH_MAX まで clip
// 2. それでも超過なら受入条件の clip 幅を PR_BODY_AC_MAX から PR_BODY_AC_SHRINK_STEP 刻みで
//    PR_BODY_AC_MIN まで縮小
export const PR_BODY_HIT_PATH_MAX = 80;
export const PR_BODY_AC_MIN = 40;
export const PR_BODY_AC_SHRINK_STEP = 20;
export const PR_BODY_HEADINGS = ['## 変更', '## 受入条件', '## 設計判断', '## 検証'];

// plan.serial の file_changes を component（path の dirname。無ければ '(root)'）ごとに
// 初出順でグループ化し、[{ component, files }] を返す（files は basename を初出順・重複排除）。
function changeGroups(plan) {
  const order = [];
  const byComponent = new Map();
  for (const p of planPaths(plan)) {
    const idx = p.lastIndexOf('/');
    const component = idx === -1 ? '(root)' : p.slice(0, idx);
    const basename = idx === -1 ? p : p.slice(idx + 1);
    if (!byComponent.has(component)) {
      byComponent.set(component, []);
      order.push(component);
    }
    const files = byComponent.get(component);
    if (!files.includes(basename)) files.push(basename);
  }
  return order.map((component) => ({ component, files: byComponent.get(component) }));
}

// `## 変更` セクション本文: component 別 bullet を PR_BODY_CHANGE_BULLETS_MAX 件まで、超過分は
// `（他 N component）` 1 行で畳む。
function changeSection(plan) {
  const groups = changeGroups(plan);
  if (groups.length === 0) return '（なし）';
  const bullets = groups.map((g) => clip(`- \`${g.component}/\`: ${g.files.join(', ')}`, PR_BODY_CHANGE_BULLET_MAX));
  const shown = bullets.slice(0, PR_BODY_CHANGE_BULLETS_MAX);
  const excess = bullets.length - shown.length;
  return excess > 0 ? `${shown.join('\n')}\n（他 ${excess} component）` : shown.join('\n');
}

// `## 受入条件` セクション本文: index 順に `- [x]`/`- [ ]` + clip(ac, acMax)。checked 判定は acResults
// 優先、無ければ ledger.items の `AC-<i+1>`。acMax は PR_BODY_MAX_CHARS 超過時の詰め処理で縮小される。
function acceptanceSection(req, ledger, acResults, acMax = PR_BODY_AC_MAX) {
  const acs = arr(req?.acceptance_criteria);
  if (acs.length === 0) return '（なし）';
  const items = arr(ledger?.items);
  const results = arr(acResults);
  const lines = acs.map((ac, i) => {
    const fromResults = results.find((r) => r?.ac_index === i);
    const checked = fromResults ? fromResults.satisfied === true : items.find((x) => x?.id === `AC-${i + 1}`)?.checked === true;
    return `- [${checked ? 'x' : ' '}] ${clip(str(ac).trim(), acMax)}`;
  });
  return lines.join('\n');
}

// `## 設計判断` セクション本文: 先頭 PR_BODY_DECISIONS_MAX 件を `- <decisionLine>` で clip、超過分は
// `（他 N 件は plan 参照）` 1 行。
function decisionsSection(plan) {
  const all = arr(plan?.architecture_decisions).map(decisionLine).filter(Boolean);
  if (all.length === 0) return '（なし）';
  const shown = all.slice(0, PR_BODY_DECISIONS_MAX).map((d) => clip(`- ${d}`, PR_BODY_DECISION_MAX));
  const excess = all.length - shown.length;
  return excess > 0 ? `${shown.join('\n')}\n（他 ${excess} 件は plan 参照）` : shown.join('\n');
}

// 1 種別（danger-grep / test-surface）分の hit 行。総数は維持しつつ列挙 item を
// PR_BODY_HIT_ITEMS_MAX 件で打ち切り「他 N 件」を付す。file path は pathMax で clip する
// （PR_BODY_MAX_CHARS 超過時の詰め処理で有限値に絞られる。既定は無制限）。
function hitLine(label, hits, keyOf, pathMax = Infinity) {
  const list = arr(hits);
  if (list.length === 0) return `- ${label}: なし`;
  const shown = list.slice(0, PR_BODY_HIT_ITEMS_MAX).map((h) => `${str(keyOf(h)) || 'unknown'}: \`${clip(cell(h?.file) || '?', pathMax)}\``);
  const excess = list.length - shown.length;
  const items = excess > 0 ? [...shown, `他 ${excess} 件`] : shown;
  return `- ${label}: ${list.length} 件（${items.join('、')}）`;
}

// PR body: 結論1行 / 変更(component別) / 受入条件(checkbox) / 設計判断(≤5件) / 検証(hit) /
// Closes #<issue> の 6 セクション固定構成。各セクションは PR_BODY_* 定数で決定論 clip する
// （issue #661。旧 `## 要約` 無制限 verbatim + `## 変更 task` table 構成を置き換え）。
// acResults（[{ac_index, satisfied}]）が指定されればチェック判定に優先利用する。
// 組み立て後の総長が PR_BODY_MAX_CHARS を超えたら (1) hit item の file path を
// PR_BODY_HIT_PATH_MAX まで clip → (2) それでも超過なら受入条件 clip 幅を PR_BODY_AC_SHRINK_STEP
// 刻みで PR_BODY_AC_MIN まで縮小、の順に決定論的に詰める（issue #665）。
export function buildPrBody({ issue, req, plan, ledger, testsurfHits, dangerHits, acResults }) {
  let conclusionText = collapseWhitespace(plan?.summary);
  if (!conclusionText) conclusionText = collapseWhitespace(req?.issue_title);
  if (!conclusionText) conclusionText = `issue #${issue} の変更`;
  const conclusionLine = `**${clip(conclusionText, PR_BODY_SUMMARY_MAX)}**`;

  const assemble = (hitPathMax, acMax) => {
    const verify = `${hitLine('danger-grep', arr(dangerHits), (h) => h?.class, hitPathMax)}\n${hitLine('test-surface', arr(testsurfHits), (h) => h?.pattern, hitPathMax)}`;
    const sections = [
      conclusionLine,
      `## 変更\n${changeSection(plan)}`,
      `## 受入条件\n${acceptanceSection(req, ledger, acResults, acMax)}`,
      `## 設計判断\n${decisionsSection(plan)}`,
      `## 検証\n${verify}`,
      `Closes #${issue}`,
    ];
    return sections.join('\n\n') + '\n';
  };

  let body = assemble(Infinity, PR_BODY_AC_MAX);
  if (Array.from(body).length > PR_BODY_MAX_CHARS) {
    body = assemble(PR_BODY_HIT_PATH_MAX, PR_BODY_AC_MAX);
  }
  for (let acMax = PR_BODY_AC_MAX - PR_BODY_AC_SHRINK_STEP; Array.from(body).length > PR_BODY_MAX_CHARS && acMax >= PR_BODY_AC_MIN; acMax -= PR_BODY_AC_SHRINK_STEP) {
    body = assemble(PR_BODY_HIT_PATH_MAX, acMax);
  }
  return body;
}

// body 内に `Closes #<issue>` 行（行全体一致）が存在するか。
export function hasClosesLine(body, issue) {
  const re = new RegExp(`^Closes #${Number(issue)}\\s*$`, 'm');
  return re.test(str(body));
}

// PR body の構造検証: 結論行 / PR_BODY_HEADINGS の各見出し / Closes 行の存在を決定論的に判定する。
export function verifyPrBody(body, issue) {
  const s = str(body);
  const missing = [];
  const lines = s.split('\n');
  const firstNonEmpty = lines.find((l) => l.trim() !== '');
  if (!firstNonEmpty || !firstNonEmpty.trim().startsWith('**')) missing.push('結論');
  for (const heading of PR_BODY_HEADINGS) {
    const re = new RegExp(`^${heading}$`, 'm');
    if (!re.test(s)) missing.push(heading);
  }
  const closes = hasClosesLine(s, issue);
  if (!closes) missing.push('Closes');
  return { ok: missing.length === 0, missing, closes, length: Array.from(s).length };
}

// `gh pr view --json body` の stdout 全文（exec-proxy が無加工で返す raw）から body を取り出す。
// JSON として不正・object でない・.body が string でない場合は null。body の取り出しを agent に
// 任せると haiku が自前の `{"ok":true,"body":...}` を body に詰めて二重 JSON 化し、改行がエスケープ
// されたまま Closes 行を見落とす（issue #713）ため、取り出しは本関数だけが行う。
export function extractPrBody(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || typeof parsed.body !== 'string') return null;
  return parsed.body;
}

// gh pr view --json body の exec-proxy 応答（{ok, raw}）から Closes 行の有無を判定する。取得失敗・
// raw が不正 JSON・body 非 string は 'unknown'（fail-open。再投入しない）。
export function closesVerdict({ view, issue }) {
  if (view == null || view.ok !== true) return 'unknown';
  const body = extractPrBody(view.raw);
  if (body == null) return 'unknown';
  return hasClosesLine(body, issue) ? 'present' : 'missing';
}

// PR phase / Final reconcile 後の Closes 検証・再投入で dev-flow.js が持つ状態の closed enum。
export const PR_CLOSES_STATUS_VALUES = ['verified', 'reinjected', 'missing', 'unverified'];

// gh pr view --json body の exec-proxy 応答の agent() schema。
export const PR_BODY_VIEW = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    raw: { type: ['string', 'null'] },
    error: { type: 'string' },
    epoch: { type: 'number' },
  },
};

// gh pr edit --body-file の exec-proxy 応答の agent() schema。
export const PR_BODY_EDIT = {
  type: 'object',
  required: ['edited'],
  properties: {
    edited: { type: 'boolean' },
    error: { type: 'string' },
    epoch: { type: 'number' },
  },
};

// PR #<pr> の本文 (body) を読み取り専用で取得する exec-proxy 向け prompt（closes-check / closes-recheck
// label で使う。final-ci.mjs の finalCiPrompt と同型）。
export function prBodyViewPrompt({ pr, repo }) {
  const cmd = `gh pr view ${pr}${repo ? ' --repo ' + repo : ''} --json body`;
  return `## Objective\n`
    + `PR #${pr} の本文 (body) を取得し、コマンドの stdout を加工せずそのまま返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n\n`
    + `## Steps\n`
    + `1. \`${cmd}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ`
    + `（cd 前置・bash 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止）。\n`
    + `2. stdout が空、JSON として不正、またはコマンドが実行できなかった場合は `
    + `\`{"ok": false, "error": "<stderr の要約>"}\` を返せ。失敗時に ok:true を生成してはならない。`
    + `原因調査はするな。再試行禁止。\n`
    + `3. それ以外は stdout の全文を 1 つの文字列として \`raw\` に入れ、\`{"ok": true, "raw": <stdout 全文>}\` を返せ。`
    + `stdout を JSON として解釈して body を取り出す・別の object に包み直す・要約・整形・省略はすべて禁止`
    + `（body の取り出しは呼び出し側が行う）。\n\n`
    + `## Output format\n`
    + `{"ok": true, "raw": string} または {"ok": false, "error": string}\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内（raw を除く）。`;
}

// PR #<pr> の本文を prBody の内容で上書きする exec-proxy 向け prompt（closes-reinject / ac-checkbox-sync
// label で使う）。Write で bodyFile へ verbatim 保存させた後、bare 単文で gh pr edit する。
export function prBodyEditPrompt({ wt, pr, repo, prBody, fileName }) {
  const bodyFile = `${wt}/.devflow-tmp/${fileName}`;
  const repoArg = repo ? ` --repo ${repo}` : '';
  return `## Objective\n`
    + `PR #${pr} の本文を渡された内容で上書きし、成否を返す。\n\n`
    + `## 本文の保存\n`
    + `**Write tool** を使い、下記 delimiter 内の本文を **一字一句そのまま**（要約・整形・追記・改変・shell 経由の書き出し禁止）`
    + `\`${bodyFile}\` へ保存せよ。\n`
    + `<<<PR_BODY_BEGIN>>>\n${prBody}<<<PR_BODY_END>>>\n\n`
    + `## Steps\n以下を bare 単文で 1 回だけ実行せよ`
    + `（cd 前置・bash 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止）:\n`
    + `1. \`gh pr edit ${pr}${repoArg} --body-file ${bodyFile}\`\n`
    + `2. 成功したら \`{"edited": true}\` を返せ。失敗しても throw せず `
    + `\`{"edited": false, "error": "<stderr の要約>"}\` を返せ。\n\n`
    + `## Output format\n{"edited": boolean, "error"?: string}\nprose 禁止。JSON のみ 1 行で返せ。\n\n`
    + `## Tools\n使用可: Bash, Write\n\n`
    + `## Boundary\n${bodyFile} 以外を書かない。git 操作禁止。本文の書き換え禁止。\n\n`
    + `## Token cap\nJSON のみ。1 行以内。`;
}

// PR phase の dev-runner-haiku 向け prompt。commit message / PR body を delimiter 内に verbatim で
// 埋め込み、Write で `.devflow-tmp/` に保存させた後、bare 単文（cd 前置・bash 前置・env 代入前置・
// && 連結禁止）で git add / commit -F / push / gh pr create を順に実行させる。gh は subagent の
// bare 単文で実行する（script 内に認証付き I/O を持たない exec-proxy 規範）。
// 手順 1〜4 のどれかが失敗したらそこで中断し、`failed_step`（commit / push / pr-create）と
// `failure_reason`（失敗コマンドの stderr 末尾 1〜3 行 verbatim）を埋めて返す — どこで何に失敗したかは
// proxy しか観測できず、workflow 側はこの 2 値を abort のエラー文に載せて人間に見せる（prPhaseFailure）。
// git は `-C <wt>` を付けない bare 形にする（issue #700）: `git -C` 形は sandbox の excludedCommands に
// 当たらず sandbox 内で走り、push は credential helper が `~/.config/gh` / keychain を読めずに、
// add / commit は `.git` が sandbox の write deny 下にある repo（skills 等）で index.lock を作れずに失敗する。
// subagent の cwd は worktree（EnterWorktree 済み）なので -C を外しても対象 worktree は変わらない。
// -C を外した以上、add -A / commit / push の対象は subagent の cwd のみで決まる。dev-flow-run は
// cwd がその worktree であることを検証しない（isolation probe は worktree 絶対パスへの Write 可否
// しか見ない）ため、resume や直接起動で cwd が共有 checkout のまま渡ってくると無関係な変更を
// commit・push しうる（issue #700）。よって手順 0 として `git rev-parse --abbrev-ref HEAD` を
// branch と照合し、不一致なら git add 等を実行せず failed_step:"commit" で中断する。
export function prPhasePrompt({ wt, base, branch, repo, issue, commitMessage, prBody }) {
  const msgFile = `${wt}/.devflow-tmp/commit-msg.txt`;
  const bodyFile = `${wt}/.devflow-tmp/pr-body.md`;
  const title = str(commitMessage).split('\n')[0].replace(/"/g, '\\"');
  const repoArg = repo ? ` --repo ${repo}` : '';
  const bare = '（cd 前置・`bash` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止。cwd は worktree（EnterWorktree 済み）なので git には -C も cd も付けない）';
  return `## Objective\nissue #${issue} の変更を commit + push し draft PR を作成して、PR URL と番号を返す。\n\n`
    + `## 本文の保存\n`
    + `**Write tool** を使い、下記 2 つの delimiter 内の本文を **一字一句そのまま**（要約・整形・追記・改変・shell 経由の書き出し禁止）保存せよ。\n`
    + `1. <<<COMMIT_MSG_BEGIN>>> 〜 <<<COMMIT_MSG_END>>> の本文 → \`${msgFile}\`\n`
    + `2. <<<PR_BODY_BEGIN>>> 〜 <<<PR_BODY_END>>> の本文 → \`${bodyFile}\`\n`
    + `<<<COMMIT_MSG_BEGIN>>>\n${commitMessage}<<<COMMIT_MSG_END>>>\n`
    + `<<<PR_BODY_BEGIN>>>\n${prBody}<<<PR_BODY_END>>>\n\n`
    + `## Steps\n**手順 0（branch 確認・中断判定）**を bare 単文で実行せよ${bare}: \`git rev-parse --abbrev-ref HEAD\` の stdout（末尾改行を除く）が \`${branch}\` と一致するか確認する。`
    + `一致しなければ cwd が対象 worktree でない（resume・直接起動等で共有 checkout のまま実行している）ため、`
    + `git add 等の後続手順を一切実行せず、failed_step:"commit"、failure_reason に \`"cwd branch mismatch: expected ${branch}, got <rev-parse の実際の出力>"\` を入れて中断する`
    + `（pr_url は空文字、pr_number は 0、committed は false、head_sha は空文字）。\n`
    + `一致したら以下を順に bare 単文で実行せよ${bare}。手順 1〜4 のいずれかが失敗（exit 非0）したら**そこで中断**し、後続の手順を実行せず、failed_step にその手順名（1〜2 → "commit"、3 → "push"、4 → "pr-create"）、failure_reason に失敗したコマンドの stderr 末尾 1〜3 行を**一字一句そのまま**（要約・言い換え禁止）入れて返す。中断時は pr_url は空文字、pr_number は 0、committed は手順 2 が成功済みなら true・それ以外は false、head_sha は空文字:\n`
    + `1. \`git add -A\`（失敗は failed_step:"commit" で中断）\n`
    + `2. \`git commit -F ${msgFile}\`（exit 非0 かつ stdout/stderr に "nothing to commit" があれば commit 済みとして続行。それ以外の失敗は failed_step:"commit" で中断）\n`
    + `3. \`git push -u origin HEAD\`（失敗は failed_step:"push" で中断）\n`
    + `4. \`gh pr create${repoArg} --draft --base ${base} --head ${branch} --title "${title}" --body-file ${bodyFile}\`（失敗は failed_step:"pr-create" で中断）\n`
    + `5. 手順 4 の stdout の PR URL を pr_url、その末尾の数字を pr_number として返す。\n`
    + `6. \`git rev-parse HEAD\` の stdout（40 桁 hex）をそのまま head_sha として返す（失敗時は空文字）。\n\n`
    + `## Output format\n{ "pr_url": string, "pr_number": number, "committed": boolean, "head_sha": string, "failed_step": "" | "commit" | "push" | "pr-create", "failure_reason": string, "epoch": number }\n`
    + `failed_step / failure_reason は成功時は空文字。failure_reason は失敗コマンドの stderr 末尾 1〜3 行 verbatim。prose 禁止。JSON のみ返せ。\n\n`
    + `## Tools\n使用可: Bash, Write\n\n`
    + `## Boundary\n上記 2 ファイル以外を書かない。上記以外の git / gh 操作禁止。本文の要約・判断・書き換え禁止。\n\n`
    + `## Token cap\nJSON のみ。1 行以内。`;
}

// PR phase exec-proxy（`pr#<issue>`）の失敗判定。proxy の中断契約（prPhasePrompt の Steps）は
// `committed:false` / `pr_url:""` / `pr_number:0` のいずれかで現れる。null 判定だけの `need()` は
// この形を通してしまい、pr_number:0 が nested pr-iterate の引数検証で throw して abort の場所と原因
// （proxy が踏んだ git / gh の stderr）が消える。ここで proxy が返した failed_step / failure_reason と
// 生の 3 値を 1 文に載せて返し、workflow はそれを throw する（fail-closed。リトライ・fallback は持たない —
// 失敗理由を人間に見せて止めるだけ）。成功なら null。
export const PR_FAILED_STEP_VALUES = ['commit', 'push', 'pr-create'];

export function prPhaseFailure(pr) {
  const prUrl = str(pr?.pr_url).trim();
  const prNumber = Number(pr?.pr_number);
  const committed = pr?.committed;
  const failed = committed === false || prUrl === '' || !(Number.isInteger(prNumber) && prNumber > 0);
  if (!failed) return null;
  const failedStep = str(pr?.failed_step).trim();
  const step = PR_FAILED_STEP_VALUES.includes(failedStep) ? failedStep : 'unknown';
  const reason = str(pr?.failure_reason).trim() || '（proxy が failure_reason を返さず）';
  const raw = `pr_url=${JSON.stringify(pr?.pr_url ?? null)} pr_number=${JSON.stringify(pr?.pr_number ?? null)} committed=${JSON.stringify(committed ?? null)}`;
  return `dev-flow: PR phase 失敗（step: ${step}、reason: ${reason}）— proxy 応答 ${raw}。closes-check / nested pr-iterate へは進まない`;
}
