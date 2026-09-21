// _lib/analyze-fetch-no-redirect.test.mjs
// Analyze phase の issue 取得形を pin する静的 + VM テスト。
//
// analyze-issue は issue 取得（bare `gh issue view … --json …`）を script 内蔵で行い、caller は
// `analyze-issue N [--repo R] …` の 1 単文だけを実行する。caller 側に「`gh issue view` の stdout を
// file へリダイレクトして script に渡す」取得段が再登場すると、リダイレクト付きの gh は bare `gh`
// 単文として扱われず取得が失敗し、contract 経路と sonnet 経路の両方が構造的に取得失敗して
// needs_clarification に終端する（再起動しても同じ結果になる）。同型の再発を以下で pin する:
//
//   (a-static) dev-flow.js 全文: `gh issue view` の直後 400 字以内にリダイレクト（`>` / 'リダイレクト'）が無い、
//              '--issue-json' が無い
//   (b-static) dev-issue-analyze/SKILL.md: 同上（Execution 手順が 1 単文形）
//   (c-vm) contract-probe#1 prompt: `analyze-issue 1 --contract` の 1 単文で、gh issue view /
//          --issue-json / mktemp の取得段を含まない
//   (d-vm) setup.repo が渡ると `--repo <repo>` が analyze-issue / Skill 呼び出しに載る
//   (e-vm) analyze#1 prompt（sonnet 経路）: 取得済み issue JSON ファイルの Read 指示が無く、
//          切断時は body_dump_path を Read させる
//   (f-vm) success run の全 agent prompt に `gh issue view` + リダイレクトの組が無い
//
// Run: npx vitest run _lib/analyze-fetch-no-redirect.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const devFlowSrc = readFileSync(join(pluginRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8');
const skillSrc = readFileSync(join(pluginRoot, 'dev-issue-analyze', 'SKILL.md'), 'utf8');

// シェルのリダイレクト形（` > file` / ` >> file` / ` > $TMPDIR/...` / ` > <ISSUE_JSON>`）。
// `<n>` `<owner/repo>` のような placeholder の閉じ `>`（直前が非空白）や `->` `=>` には一致しない。
const REDIRECT_RE = /(^|\s)>{1,2}\s*(\$|<|\/|~|"|'|[A-Za-z])/;
const FETCH_TOKEN = 'gh issue view';
const WINDOW = 400;

// text 中の各 `gh issue view` について、直後 WINDOW 字にリダイレクト形または 'リダイレクト' が
// 同居する箇所を返す（同居なしは []）。
function fetchRedirectHits(text) {
  const hits = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(FETCH_TOKEN, from);
    if (idx < 0) break;
    const window = text.slice(idx, idx + WINDOW);
    if (REDIRECT_RE.test(window) || window.includes('リダイレクト')) hits.push(window);
    from = idx + FETCH_TOKEN.length;
  }
  return hits;
}

async function runDevFlow(extra = {}) {
  const { ctx, calls } = makeDevFlowSandbox({ extra });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'dev-flow');
  assert.equal(error, null, `dev-flow run が throw した: ${error?.message}`);
  return calls;
}

// ---- (a-static) dev-flow.js ----

test('[analyze-fetch] (a-static) dev-flow.js に `gh issue view` + リダイレクトの取得段が無い', () => {
  const hits = fetchRedirectHits(devFlowSrc);
  assert.equal(hits.length, 0, `dev-flow.js に gh issue view の stdout をリダイレクトする取得段が残っている:\n${hits.join('\n---\n')}`);
});

test('[analyze-fetch] (a-static) dev-flow.js に `--issue-json` が無い', () => {
  assert.ok(!devFlowSrc.includes('--issue-json'), 'dev-flow.js に --issue-json（file 入力の二段取得形）が残っている');
});

// ---- (b-static) dev-issue-analyze/SKILL.md ----

test('[analyze-fetch] (b-static) SKILL.md に `gh issue view` + リダイレクトの取得段が無い', () => {
  const hits = fetchRedirectHits(skillSrc);
  assert.equal(hits.length, 0, `SKILL.md に gh issue view の stdout をリダイレクトする取得段が残っている:\n${hits.join('\n---\n')}`);
});

test('[analyze-fetch] (b-static) SKILL.md に `--issue-json` が無く、Execution が analyze-issue の 1 単文形である', () => {
  assert.ok(!skillSrc.includes('--issue-json'), 'SKILL.md に --issue-json が残っている');
  const execIdx = skillSrc.indexOf('## Execution');
  assert.ok(execIdx >= 0, 'SKILL.md に ## Execution 節が無い');
  const execSection = skillSrc.slice(execIdx, skillSrc.indexOf('## Options'));
  const codeLines = execSection.split('\n').filter((l) => /^(analyze-issue|gh) /.test(l));
  assert.deepEqual(
    codeLines.map((l) => l.split(' ')[0]),
    ['analyze-issue'],
    `Execution 節のコマンド行は analyze-issue の 1 行のみであるべきだが: ${JSON.stringify(codeLines)}`,
  );
  assert.ok(execSection.includes('--dump-body'), 'Execution 節に --dump-body の案内が無い');
});

// ---- (c-vm) contract-probe#1 ----

test('[analyze-fetch] (c-vm) contract-probe#1 prompt は analyze-issue の 1 単文で、subagent 側の取得段を含まない', async () => {
  const call = (await runDevFlow()).find((c) => c.label === 'contract-probe#1');
  assert.ok(call, 'contract-probe#1 が呼ばれていない');
  assert.ok(call.prompt.includes('`analyze-issue 1 --contract`'), `analyze-issue 1 --contract の単文指示が無い:\n${call.prompt}`);
  assert.ok(!call.prompt.includes(FETCH_TOKEN), `contract-probe prompt に gh issue view の取得段が残っている:\n${call.prompt}`);
  assert.ok(!call.prompt.includes('--issue-json'), `contract-probe prompt に --issue-json が残っている:\n${call.prompt}`);
  assert.ok(!call.prompt.includes('mktemp'), `contract-probe prompt に mktemp（file 中継）が残っている:\n${call.prompt}`);
  assert.equal(fetchRedirectHits(call.prompt).length, 0, `contract-probe prompt に gh issue view + リダイレクトが残っている:\n${call.prompt}`);
});

// ---- (d-vm) --repo の伝播 ----

test('[analyze-fetch] (d-vm) setup.repo があると contract-probe / Skill 呼び出しに --repo が載る', async () => {
  const calls = await runDevFlow({ args: devFlowArgs(1, { repo: 'acme/skills' }) });
  const probe = calls.find((c) => c.label === 'contract-probe#1');
  assert.ok(probe, 'contract-probe#1 が呼ばれていない');
  assert.ok(probe.prompt.includes('`analyze-issue 1 --repo acme/skills --contract`'), `--repo 付きの単文指示が無い:\n${probe.prompt}`);
  const analyze = calls.find((c) => c.label === 'analyze#1');
  assert.ok(analyze, 'analyze#1 が呼ばれていない');
  assert.ok(analyze.prompt.includes('Skill: dev-issue-analyze 1 --repo acme/skills --depth standard'), `Skill 呼び出しに --repo が無い:\n${analyze.prompt.slice(0, 200)}`);
});

// ---- (e-vm) analyze#1（sonnet 経路） ----

test('[analyze-fetch] (e-vm) analyze#1 prompt は取得済み issue JSON ファイルではなく body_dump_path を Read させる', async () => {
  const call = (await runDevFlow()).find((c) => c.label === 'analyze#1');
  assert.ok(call, 'analyze#1 が呼ばれていない');
  assert.ok(call.prompt.includes('Skill: dev-issue-analyze 1 --depth standard'), `Skill 呼び出し形が想定と異なる:\n${call.prompt.slice(0, 200)}`);
  assert.ok(!call.prompt.includes('$TMPDIR/issue-'), `analyze#1 prompt に取得済み issue JSON ファイル（$TMPDIR/issue-N.json）の参照が残っている:\n${call.prompt}`);
  assert.ok(!call.prompt.includes('--issue-json'), 'analyze#1 prompt に --issue-json が残っている');
  assert.ok(call.prompt.includes('body_dump_path'), 'analyze#1 prompt に切断時の body_dump_path Read 指示が無い');
});

// ---- (f-vm) 全 prompt ----

test('[analyze-fetch] (f-vm) success run の全 agent prompt に `gh issue view` + リダイレクトの組が無い', async () => {
  for (const c of await runDevFlow()) {
    const hits = fetchRedirectHits(c.prompt);
    assert.equal(hits.length, 0, `${c.label} の prompt に gh issue view + リダイレクトが含まれる:\n${hits.join('\n---\n')}`);
    assert.ok(!c.prompt.includes('--issue-json'), `${c.label} の prompt に --issue-json が含まれる`);
  }
});
