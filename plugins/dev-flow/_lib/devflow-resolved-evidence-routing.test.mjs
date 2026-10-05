// 終端サマリーの「解消済み証跡」セクション（issue #603 / #707）を dev-flow.js の VM 実行で pin する。
// 解消済みの ledger item が大量にある run（PR #595 相当: critical 21 件 resolved）でも、post-summary の本文は
// <details> 1 つに折りたたまれ、evidence セルは 1 行 200 字 cap で切られ、raw の全文（改行入り）は流れ込まない。
// post-summary は telemetry handoff（journal-save）より前に呼ばれ、telemetry には解消済み証跡を載せない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

// EVID(i): SENTINEL-EVIDENCE-<i> に | / ` / 改行 / 二重引用符 を含む合計 200 字の evidence。
function EVID(i) {
  const base = `SENTINEL-EVIDENCE-${i} | \`code\` \n"q"`;
  const pad = 'x'.repeat(Math.max(0, 200 - base.length));
  return base + pad;
}

const CRITICAL_FEEDBACK = Array.from({ length: 21 }, (_, i) => ({
  severity: 'critical',
  topic: `topic-${String(i).padStart(2, '0')}`,
  dimension: 'quality',
  description: 'd',
}));

const CRITICAL_RESOLUTIONS = Array.from({ length: 21 }, (_, i) => ({
  id: `EVAL-1-topic-${String(i).padStart(2, '0')}`,
  resolved: true,
  evidence: EVID(i),
}));

function parseHandoff(prompt) {
  const m = prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(m, `journal-save prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない:\n${prompt}`);
  return JSON.parse(m[1]);
}

async function runResolvedHeavy() {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'eval#1': {
        verdict: 'pass', total: 100, threshold: 80,
        feedback: CRITICAL_FEEDBACK, feedback_level: 'implementation',
        critical_resolutions: CRITICAL_RESOLUTIONS,
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      },
    },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'resolved-heavy');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls };
}

test('[resolved-evidence-routing] post-summary は journal-save より前に呼ばれ、telemetry に解消済み証跡を載せない', async () => {
  const { result, calls } = await runResolvedHeavy();
  const postIdx = calls.findIndex((c) => c.label === 'post-summary');
  const saveIdx = calls.findIndex((c) => c.label === 'journal-save');
  assert.ok(postIdx >= 0 && saveIdx >= 0, `post-summary / journal-save が呼ばれていない: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(postIdx < saveIdx, `post-summary(idx=${postIdx}) は journal-save(idx=${saveIdx}) より前に呼ばれるべき`);
  const payload = parseHandoff(calls[saveIdx].prompt);
  assert.equal(payload.telemetry.merge_tier, result.merge_tier, 'telemetry.merge_tier が result.merge_tier と一致しない');
  assert.equal(Object.hasOwn(payload.telemetry, 'resolved_evidence'), false, 'telemetry に resolved_evidence が載っている');
  assert.ok(!calls[saveIdx].prompt.includes('SENTINEL-EVIDENCE-'), 'journal-save payload に解消済み証跡の evidence が流れ込んでいる');
});

test('[resolved-evidence-routing] critical 21 件 resolved の run でも post-summary の解消済み証跡は <details> 1 つに折りたたまれ、evidence は 1 行 200 字 cap', async () => {
  const { result, calls } = await runResolvedHeavy();
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が呼ばれていない');
  const prompt = post.prompt;
  assert.ok(prompt.includes(`<!-- dev-flow:${result.merge_tier} -->`), `post-summary prompt に merge tier marker が無い`);
  // 21 件の EVAL-* に、checked になった SEC seed / AC item が加わる
  const resolvedCount = Number(prompt.match(/✅ Goal Ledger 解消済み (\d+) 件/)?.[1] ?? NaN);
  assert.ok(resolvedCount >= 21, `解消済み件数行が無い、または 21 件未満（${resolvedCount}）:\n${prompt.slice(0, 3000)}`);
  const detailsCount = (prompt.match(/<details>/g) ?? []).length;
  assert.equal(detailsCount, 1, `post-summary prompt の '<details>' は 1 回のはずだが ${detailsCount} 回だった`);

  const evidenceLines = prompt.split('\n').filter((l) => l.includes('SENTINEL-EVIDENCE-7'));
  assert.equal(evidenceLines.length, 1, `SENTINEL-EVIDENCE-7 を含む行は 1 行のはずだが ${evidenceLines.length} 行だった`);
  const [line] = evidenceLines;
  assert.ok(!line.includes('<br>'), `evidence 行に '<br>'（生の改行の変換痕跡）が含まれている: ${line}`);
  assert.ok(line.length <= 260, `SENTINEL-EVIDENCE-7 を含む行は 200 字 cap で切られているはずだが ${line.length} 字だった: ${line}`);
  assert.ok(!prompt.includes(EVID(7)), 'post-summary prompt に raw の全文 evidence（改行含む）がそのまま含まれている');
});
