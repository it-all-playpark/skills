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

// plan の file_changes（`path: 説明` 形も許容）から path 部分を取り出す。
function planPaths(plan) {
  const out = [];
  for (const t of [...arr(plan?.serial), ...arr(plan?.parallel)]) {
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

function taskRows(plan) {
  const rows = [];
  for (const [group, tasks] of [['serial', arr(plan?.serial)], ['parallel', arr(plan?.parallel)]]) {
    for (const t of tasks) {
      const files = arr(t?.file_changes).map((f) => `\`${cell(f)}\``).join(', ');
      rows.push(`| ${cell(t?.id)} | ${group} | ${cell(t?.desc)} | ${files} |`);
    }
  }
  return rows;
}

function hitLines(label, hits, keyOf) {
  if (hits.length === 0) return `- ${label}: なし`;
  const items = hits.map((h) => `${str(keyOf(h)) || 'unknown'}: \`${cell(h?.file) || '?'}\``);
  return `- ${label}: ${hits.length} 件（${items.join('、')}）`;
}

// PR body: 要約 / 受入条件（ledger の AC-n checked を反映した checkbox）/ 設計判断 / 変更 task /
// 検証状況（danger-grep / test-surface hit）/ Closes #<issue> の固定セクション。
export function buildPrBody({ issue, req, plan, ledger, testsurfHits, dangerHits }) {
  const acs = arr(req?.acceptance_criteria);
  const items = arr(ledger?.items);
  const acLines = acs.map((ac, i) => {
    const it = items.find((x) => x?.id === `AC-${i + 1}`);
    return `- [${it?.checked === true ? 'x' : ' '}] ${str(ac).trim()}`;
  });
  const decisions = arr(plan?.architecture_decisions).map(decisionLine).filter(Boolean).map((d) => `- ${d}`);
  const rows = taskRows(plan);
  const summary = str(plan?.summary).trim();
  const sections = [
    `## 要約\n${summary || '（なし）'}`,
    `## 受入条件\n${acLines.length ? acLines.join('\n') : '（なし）'}`,
    `## 設計判断\n${decisions.length ? decisions.join('\n') : '（なし）'}`,
    `## 変更 task\n${rows.length ? ['| id | group | 内容 | files |', '|---|---|---|---|', ...rows].join('\n') : '（なし）'}`,
    `## 検証状況\n${hitLines('danger-grep', arr(dangerHits), (h) => h?.class)}\n${hitLines('test-surface', arr(testsurfHits), (h) => h?.pattern)}`,
    `Closes #${issue}`,
  ];
  return sections.join('\n\n') + '\n';
}

// PR phase の dev-runner-haiku 向け prompt。commit message / PR body を delimiter 内に verbatim で
// 埋め込み、Write で `.devflow-tmp/` に保存させた後、bare 単文（cd 前置・bash 前置・env 代入前置・
// && 連結禁止）で git add / commit -F / push / gh pr create を順に実行させる。gh は subagent の
// bare 単文で実行する（script 内に認証付き I/O を持たない exec-proxy 規範）。
export function prPhasePrompt({ wt, base, branch, repo, issue, commitMessage, prBody }) {
  const msgFile = `${wt}/.devflow-tmp/commit-msg.txt`;
  const bodyFile = `${wt}/.devflow-tmp/pr-body.md`;
  const title = str(commitMessage).split('\n')[0].replace(/"/g, '\\"');
  const repoArg = repo ? ` --repo ${repo}` : '';
  const bare = '（cd 前置・`bash` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止。-C で worktree を渡しているため cd は不要）';
  return `## Objective\nissue #${issue} の変更を commit + push し draft PR を作成して、PR URL と番号を返す。\n\n`
    + `## 本文の保存\n`
    + `**Write tool** を使い、下記 2 つの delimiter 内の本文を **一字一句そのまま**（要約・整形・追記・改変・shell 経由の書き出し禁止）保存せよ。\n`
    + `1. <<<COMMIT_MSG_BEGIN>>> 〜 <<<COMMIT_MSG_END>>> の本文 → \`${msgFile}\`\n`
    + `2. <<<PR_BODY_BEGIN>>> 〜 <<<PR_BODY_END>>> の本文 → \`${bodyFile}\`\n`
    + `<<<COMMIT_MSG_BEGIN>>>\n${commitMessage}<<<COMMIT_MSG_END>>>\n`
    + `<<<PR_BODY_BEGIN>>>\n${prBody}<<<PR_BODY_END>>>\n\n`
    + `## Steps\n以下を順に bare 単文で実行せよ${bare}:\n`
    + `1. \`git -C ${wt} add -A\`\n`
    + `2. \`git -C ${wt} commit -F ${msgFile}\`（exit 非0 かつ stdout/stderr に "nothing to commit" があれば commit 済みとして続行。それ以外の失敗は中断して committed:false で返す）\n`
    + `3. \`git -C ${wt} push -u origin HEAD\`\n`
    + `4. \`gh pr create${repoArg} --draft --base ${base} --head ${branch} --title "${title}" --body-file ${bodyFile}\`\n`
    + `5. 手順 4 の stdout の PR URL を pr_url、その末尾の数字を pr_number として返す。\n\n`
    + `## Output format\n{ "pr_url": string, "pr_number": number, "committed": boolean, "epoch": number }\nprose 禁止。JSON のみ返せ。\n\n`
    + `## Tools\n使用可: Bash, Write\n\n`
    + `## Boundary\n上記 2 ファイル以外を書かない。上記以外の git / gh 操作禁止。本文の要約・判断・書き換え禁止。\n\n`
    + `## Token cap\nJSON のみ。1 行以内。`;
}
