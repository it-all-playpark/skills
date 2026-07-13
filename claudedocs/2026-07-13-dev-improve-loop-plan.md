# dev-improve 自己改善ループ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dev-flow を telemetry 駆動で継続的に自己改善するループ（Reconcile → Mine → Rank → File → dev-flow 実装）を、新規 dynamic workflow `dev-improve` + 起動 skill `/dev-flow-improve` として実装する。

**Architecture:** 仕様は `claudedocs/2026-07-13-dev-improve-loop-design.md`（承認済み）。orchestration は `.claude/workflows/dev-improve.js` が JS で保持し、決定論ロジックは `_lib/` canonical（sync-inlines で inline 生成）と `dev-flow-improve/scripts/` の bash oracle に分離。state は GitHub issue のみ（外部 state JSON なし）。判断系 leaf は新規 subagent `improve-miner`、exec-proxy は既存 3 agent を再利用。

**Tech Stack:** dynamic workflow (plain JS, ESM import 不可) / `_lib/*.mjs` canonical + `node:test` / bash + jq + bats / gh CLI / launchd (週次 schedule)。

## Global Constraints

- canonical（`_lib/*.mjs`）は **ESM import / require / Date.now / Math.random 禁止**（generator が error）。`export const` / `export function` 形のみ（`export default` / `export { }` 不可）
- workflow 内も Date 系 API 禁止 — 現在時刻は `args.today` で受け取る
- `IMPROVE_MAX = 2`（1 サイクルの issue 化上限）、`IMPROVE_BACKPRESSURE_OPEN = 2`（open self-improve issue がこの数以上で新規 issue 化 skip）
- 仮説 metric enum は 3 値 closed: `iterate_unhealthy_rate`(lte) / `micro_share`(gte) / `cap_pinned_count`(lte)。out-of-enum は明示 error（legacy fallback 禁止）
- label: 起票 issue = `self-improve`、backlog issue = `self-improve-backlog`（単一・タイトル固定 `dev-improve backlog`）
- 失敗ポリシー: miner/issue 作成/journal = **fail-open**（skip + log）、open issue 数取得失敗 = **fail-closed**（backpressure 扱いで issue 化 skip）、仮説突合は**決定論 script のみ**が判定（LLM に verdict を出させない）
- subagent dispatch は必須 5 要素（Objective / Output format / Tools / Boundary / Token cap）
- commit は Conventional Commits。本 plan は branch `worktree-dev-improve-loop-design`（PR #344）上で実装を継続する
- インストール済み skill script の起動は `bash ~/.claude/skills/<skill>/scripts/<script>.sh` の固定パス形（check-ci.sh と同じ規約）

## File Structure

| ファイル | 責務 |
|---|---|
| `_lib/improve-hypothesis.mjs` (新規) | hypothesis ブロックの build/parse/status 更新 + metric enum。inline 対象 |
| `_lib/improve-rank.mjs` (新規) | 候補 validate / dedup key / 決定論 rank / cap+backpressure / issue body 生成。inline 対象 |
| `skill-retrospective/scripts/journal.sh` (変更) | `--telemetry-json` 汎用 flag 追加（dev-improve telemetry の直接記録用） |
| `dev-flow-improve/scripts/hypothesis-check.sh` (新規) | 仮説突合の決定論 oracle（journal 集計 → verdict 3 値） |
| `.claude/agents/improve-miner.md` (新規) | 4 ソース miner + rank judge の判断系 subagent（read-only） |
| `.claude/workflows/dev-improve.js` (新規) | Reconcile/Mine/Rank/File の orchestration |
| `dev-flow-improve/SKILL.md` (新規) | 起動 skill（workflow 起動 → dev-flow 順次実行 → 報告） |
| `dev-flow-improve/scripts/install-schedule.sh` (新規) | 週次 launchd ジョブの登録/解除 |
| `AGENTS.md` (変更) | dev-improve 節 + W7 distrust 分類の追記 |

仕様からの確定済み逸脱（spec self-review で解決）:
- backpressure の分母は「open self-improve **PR**」ではなく「open self-improve **issue**」— PR は issue の label を継承せず決定論で数えられないため。open issue は PR merge（`Closes #N`）まで open のまま残るので、意味的に上位互換の proxy
- telemetry の `dev_flow_runs` は削除 — dev-flow 実行は workflow 完了後に launcher が行うため workflow は知り得ない。dev-flow の各 run は dev-flow 自身が journal に記録する
- telemetry 記録は pending+Stop hook ではなく journal.sh **直接呼び出し** — Stop hook（dotfiles 側）は merge_tier 必須の dev-flow 専用 parser であり、cross-repo 変更を避ける。journal dir は sandbox 書込み許可済みで journal.sh は gh 非依存のため直接呼び出しで成立する

---

### Task 1: `_lib/improve-hypothesis.mjs` — hypothesis ブロック canonical

**Files:**
- Create: `_lib/improve-hypothesis.mjs`
- Test: `_lib/improve-hypothesis.test.mjs`

**Interfaces:**
- Consumes: なし（葉モジュール）
- Produces:
  - `IMPROVE_METRIC_DIRECTIONS: Object` — `{iterate_unhealthy_rate:'lte', micro_share:'gte', cap_pinned_count:'lte'}`
  - `improveMetricNames(): string[]`
  - `buildHypothesisBlock({metric, current, target, min_runs}): string`（status は常に pending）
  - `parseHypothesisBlock(body: string): {metric, current, target, min_runs, status} | null`（マーカー不在 = null、不正 = throw）
  - `setHypothesisStatus(body: string, newStatus: string): string`
  - 定数 `HYPOTHESIS_BEGIN` / `HYPOTHESIS_END` / `HYPOTHESIS_STATUSES`

- [ ] **Step 1: failing test を書く**

`_lib/improve-hypothesis.test.mjs`:

```js
// _lib/improve-hypothesis.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPROVE_METRIC_DIRECTIONS,
  improveMetricNames,
  buildHypothesisBlock,
  parseHypothesisBlock,
  setHypothesisStatus,
} from './improve-hypothesis.mjs';

test('metric enum は 3 値 closed', () => {
  assert.deepEqual(Object.keys(IMPROVE_METRIC_DIRECTIONS).sort(), [
    'cap_pinned_count', 'iterate_unhealthy_rate', 'micro_share',
  ]);
  assert.equal(IMPROVE_METRIC_DIRECTIONS.iterate_unhealthy_rate, 'lte');
  assert.equal(IMPROVE_METRIC_DIRECTIONS.micro_share, 'gte');
  assert.deepEqual(improveMetricNames().sort(), Object.keys(IMPROVE_METRIC_DIRECTIONS).sort());
});

test('build → parse round-trip', () => {
  const block = buildHypothesisBlock({
    metric: 'iterate_unhealthy_rate', current: 0.31, target: 0.15, min_runs: 5,
  });
  const body = `## 背景\n本文\n\n${block}\n\n---\nfooter`;
  assert.deepEqual(parseHypothesisBlock(body), {
    metric: 'iterate_unhealthy_rate', current: 0.31, target: 0.15, min_runs: 5, status: 'pending',
  });
});

test('build: out-of-enum metric は throw', () => {
  assert.throws(
    () => buildHypothesisBlock({ metric: 'bogus', current: 1, target: 0, min_runs: 3 }),
    /out-of-enum metric/,
  );
});

test('build: min_runs が正の整数でなければ throw', () => {
  assert.throws(
    () => buildHypothesisBlock({ metric: 'micro_share', current: 0, target: 0.3, min_runs: 0 }),
    /min_runs/,
  );
  assert.throws(
    () => buildHypothesisBlock({ metric: 'micro_share', current: 0, target: 0.3, min_runs: 1.5 }),
    /min_runs/,
  );
});

test('parse: マーカー不在は null', () => {
  assert.equal(parseHypothesisBlock('hypothesis の無い issue body'), null);
  assert.equal(parseHypothesisBlock(null), null);
});

test('parse: end マーカー欠落は throw', () => {
  assert.throws(
    () => parseHypothesisBlock('<!-- dev-improve:hypothesis:begin -->\nmetric: micro_share'),
    /end マーカー/,
  );
});

test('parse: out-of-enum metric / status は throw', () => {
  const bad = [
    '<!-- dev-improve:hypothesis:begin -->',
    '```yaml', 'metric: bogus', 'current: 1', 'target: 0', 'min_runs: 3', 'status: pending', '```',
    '<!-- dev-improve:hypothesis:end -->',
  ].join('\n');
  assert.throws(() => parseHypothesisBlock(bad), /out-of-enum metric/);

  const badStatus = bad.replace('metric: bogus', 'metric: micro_share').replace('status: pending', 'status: maybe');
  assert.throws(() => parseHypothesisBlock(badStatus), /out-of-enum status/);
});

test('setHypothesisStatus: block 内の status のみ置換し他の本文は不変', () => {
  const block = buildHypothesisBlock({ metric: 'micro_share', current: 0.05, target: 0.2, min_runs: 4 });
  const body = `status: これは本文の status 行ではない\n\n${block}\n\nfooter`;
  const updated = setHypothesisStatus(body, 'confirmed');
  assert.equal(parseHypothesisBlock(updated).status, 'confirmed');
  assert.match(updated, /^status: これは本文の status 行ではない$/m);
  assert.equal(updated.split('\n').length, body.split('\n').length);
});

test('setHypothesisStatus: out-of-enum status / block 不在は throw', () => {
  const block = buildHypothesisBlock({ metric: 'micro_share', current: 0.05, target: 0.2, min_runs: 4 });
  assert.throws(() => setHypothesisStatus(block, 'bogus'), /out-of-enum status/);
  assert.throws(() => setHypothesisStatus('no block here', 'confirmed'), /存在しません/);
});
```

- [ ] **Step 2: テストが FAIL することを確認**

Run: `node --test _lib/improve-hypothesis.test.mjs`
Expected: FAIL（`Cannot find module ... improve-hypothesis.mjs`）

- [ ] **Step 3: canonical を実装**

`_lib/improve-hypothesis.mjs`:

```js
// _lib/improve-hypothesis.mjs
// dev-improve の hypothesis ブロック（issue body 埋め込み）の build / parse / status 更新と
// metric enum。I/O なし・非決定性なし。verdict（confirmed/not_confirmed/insufficient_data）の
// 判定は dev-flow-improve/scripts/hypothesis-check.sh（決定論 oracle）が単一実装 —
// 本ファイルでは重複実装しない（軸A: LLM/orchestrator 側に効果判定を持たせない）。
// metric enum は hypothesis-check.sh の case 分岐と 1:1 対応を保つこと。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// 仮説 metric の閉じた enum。direction: 'lte' = target 以下で confirmed / 'gte' = target 以上で confirmed。
export const IMPROVE_METRIC_DIRECTIONS = Object.freeze({
  iterate_unhealthy_rate: 'lte',
  micro_share: 'gte',
  cap_pinned_count: 'lte',
});

export const HYPOTHESIS_BEGIN = '<!-- dev-improve:hypothesis:begin -->';
export const HYPOTHESIS_END = '<!-- dev-improve:hypothesis:end -->';
export const HYPOTHESIS_STATUSES = Object.freeze(['pending', 'confirmed', 'not_confirmed']);

export function improveMetricNames() {
  return Object.keys(IMPROVE_METRIC_DIRECTIONS);
}

// buildHypothesisBlock({metric, current, target, min_runs}) → markdown 文字列（status は常に pending）。
// out-of-enum metric / 非数値 / min_runs 非正整数は throw。
export function buildHypothesisBlock({ metric, current, target, min_runs }) {
  if (!IMPROVE_METRIC_DIRECTIONS[metric]) {
    throw new Error(`improve-hypothesis: out-of-enum metric: ${JSON.stringify(metric ?? null)}`);
  }
  for (const [k, v] of [['current', current], ['target', target]]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`improve-hypothesis: ${k} は有限数が必要です（受信: ${JSON.stringify(v)}）`);
    }
  }
  if (!Number.isInteger(min_runs) || min_runs < 1) {
    throw new Error(`improve-hypothesis: min_runs は正の整数が必要です（受信: ${JSON.stringify(min_runs)}）`);
  }
  return [
    HYPOTHESIS_BEGIN,
    '```yaml',
    `metric: ${metric}`,
    `current: ${current}`,
    `target: ${target}`,
    `min_runs: ${min_runs}`,
    'status: pending',
    '```',
    HYPOTHESIS_END,
  ].join('\n');
}

// parseHypothesisBlock(body) → {metric, current, target, min_runs, status} | null。
// マーカー不在は null（hypothesis 無し issue）。マーカーはあるが中身が不正なら throw
//（呼び出し側が per-issue try/catch で fail-open する）。
export function parseHypothesisBlock(body) {
  const src = String(body ?? '');
  const beginIdx = src.indexOf(HYPOTHESIS_BEGIN);
  if (beginIdx === -1) return null;
  const endIdx = src.indexOf(HYPOTHESIS_END, beginIdx);
  if (endIdx === -1) {
    throw new Error('improve-hypothesis: end マーカーがありません');
  }
  const zone = src.slice(beginIdx + HYPOTHESIS_BEGIN.length, endIdx);
  const fields = {};
  for (const line of zone.split('\n')) {
    const m = line.match(/^(metric|current|target|min_runs|status):\s*(\S+)\s*$/);
    if (m) fields[m[1]] = m[2];
  }
  const metric = fields.metric;
  if (!IMPROVE_METRIC_DIRECTIONS[metric]) {
    throw new Error(`improve-hypothesis: out-of-enum metric: ${JSON.stringify(metric ?? null)}`);
  }
  const current = Number(fields.current);
  const target = Number(fields.target);
  const min_runs = Number(fields.min_runs);
  if (!Number.isFinite(current) || !Number.isFinite(target)
    || !Number.isInteger(min_runs) || min_runs < 1) {
    throw new Error('improve-hypothesis: current/target/min_runs が不正です');
  }
  if (!HYPOTHESIS_STATUSES.includes(fields.status)) {
    throw new Error(`improve-hypothesis: out-of-enum status: ${JSON.stringify(fields.status ?? null)}`);
  }
  return { metric, current, target, min_runs, status: fields.status };
}

// setHypothesisStatus(body, newStatus) → block 内の status 行のみ置換した body を返す。
// out-of-enum status / block 不在・不正 body は throw。
export function setHypothesisStatus(body, newStatus) {
  if (!HYPOTHESIS_STATUSES.includes(newStatus)) {
    throw new Error(`improve-hypothesis: out-of-enum status: ${JSON.stringify(newStatus)}`);
  }
  const parsed = parseHypothesisBlock(body);
  if (parsed == null) {
    throw new Error('improve-hypothesis: hypothesis ブロックが存在しません');
  }
  const src = String(body);
  const beginIdx = src.indexOf(HYPOTHESIS_BEGIN);
  const endIdx = src.indexOf(HYPOTHESIS_END, beginIdx);
  const zone = src.slice(beginIdx, endIdx);
  const newZone = zone.replace(/^status: .*$/m, `status: ${newStatus}`);
  return src.slice(0, beginIdx) + newZone + src.slice(endIdx);
}
```

- [ ] **Step 4: テストが PASS することを確認**

Run: `node --test _lib/improve-hypothesis.test.mjs`
Expected: PASS（9 tests）

- [ ] **Step 5: Commit**

```bash
git add _lib/improve-hypothesis.mjs _lib/improve-hypothesis.test.mjs
git commit -m "feat(dev-improve): hypothesis ブロック canonical (_lib/improve-hypothesis.mjs)"
```

---

### Task 2: `_lib/improve-rank.mjs` — validate / rank / cap / issue body canonical

**Files:**
- Create: `_lib/improve-rank.mjs`
- Test: `_lib/improve-rank.test.mjs`

**Interfaces:**
- Consumes: なし（cross-canonical import 禁止のため metric enum は引数 `metricNames` で受ける）
- Produces:
  - `IMPROVE_MAX = 2`, `IMPROVE_BACKPRESSURE_OPEN = 2`, `IMPROVE_SOURCES`, `IMPROVE_RISKS`, `IMPROVE_CORE_PREFIXES`
  - `candidateKey(c): string` — title の正規化 fingerprint
  - `validateCandidate(c, metricNames: string[]): boolean`
  - `rankCandidates(cands, scores: [{index, score}]): cand[]` — score 降順 → risk 昇順 → key 昇順
  - `selectTop(ranked, openImproveCount): {file, backlog, backpressure}`
  - `buildImproveIssueBody(c, {hypothesisBlock: string}): string` — core path 接触時は canary AC 自動追記
  - `buildBacklogSection({today, losers}): string`

- [ ] **Step 1: failing test を書く**

`_lib/improve-rank.test.mjs`:

```js
// _lib/improve-rank.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPROVE_MAX,
  IMPROVE_BACKPRESSURE_OPEN,
  candidateKey,
  validateCandidate,
  rankCandidates,
  selectTop,
  buildImproveIssueBody,
  buildBacklogSection,
} from './improve-rank.mjs';

const METRICS = ['iterate_unhealthy_rate', 'micro_share', 'cap_pinned_count'];

function validCand(over = {}) {
  return {
    source: 'doctor-anomaly',
    title: '改善候補X',
    evidence: ['journal entry 20260712T211350-dev-flow: iterate_status=stuck'],
    acceptance_criteria: ['stuck 終端率が下がる仕組みを実装する'],
    expected_metric_delta: { metric: 'iterate_unhealthy_rate', current: 0.3, target: 0.15, min_runs: 5 },
    risk: 'low',
    target_paths: ['dev-flow-doctor/scripts/run-diagnostics.sh'],
    ...over,
  };
}

test('定数: cap=2 / backpressure=2', () => {
  assert.equal(IMPROVE_MAX, 2);
  assert.equal(IMPROVE_BACKPRESSURE_OPEN, 2);
});

test('candidateKey: 記号・空白を無視した fingerprint（日本語対応）', () => {
  assert.equal(candidateKey({ title: 'Fix: eval loop（改善）!' }), candidateKey({ title: 'fix eval loop 改善' }));
  assert.notEqual(candidateKey({ title: 'A案' }), candidateKey({ title: 'B案' }));
  assert.equal(candidateKey(null), '');
});

test('validateCandidate: 正常系 true', () => {
  assert.equal(validateCandidate(validCand(), METRICS), true);
});

test('validateCandidate: evidence 空 / 空文字列要素は false', () => {
  assert.equal(validateCandidate(validCand({ evidence: [] }), METRICS), false);
  assert.equal(validateCandidate(validCand({ evidence: ['  '] }), METRICS), false);
});

test('validateCandidate: out-of-enum source / risk / metric は false', () => {
  assert.equal(validateCandidate(validCand({ source: 'llm-freeform' }), METRICS), false);
  assert.equal(validateCandidate(validCand({ risk: 'unknown' }), METRICS), false);
  const c = validCand();
  c.expected_metric_delta = { ...c.expected_metric_delta, metric: 'bogus' };
  assert.equal(validateCandidate(c, METRICS), false);
});

test('validateCandidate: AC 空 / min_runs 非正整数は false', () => {
  assert.equal(validateCandidate(validCand({ acceptance_criteria: [] }), METRICS), false);
  const c = validCand();
  c.expected_metric_delta = { ...c.expected_metric_delta, min_runs: 0 };
  assert.equal(validateCandidate(c, METRICS), false);
});

test('rankCandidates: score 降順 → risk 昇順 → key 昇順の決定論', () => {
  const a = validCand({ title: 'aaa', risk: 'high' });
  const b = validCand({ title: 'bbb', risk: 'low' });
  const c = validCand({ title: 'ccc', risk: 'low' });
  const ranked = rankCandidates([a, b, c], [
    { index: 0, score: 50 }, { index: 1, score: 50 }, { index: 2, score: 90 },
  ]);
  assert.deepEqual(ranked.map((x) => x.title), ['ccc', 'bbb', 'aaa']);
  // score 不在 index は 0 扱い
  const ranked2 = rankCandidates([a, b], [{ index: 1, score: 10 }]);
  assert.deepEqual(ranked2.map((x) => x.title), ['bbb', 'aaa']);
});

test('selectTop: 上位 IMPROVE_MAX 件が file、残りは backlog', () => {
  const cands = [validCand({ title: '1' }), validCand({ title: '2' }), validCand({ title: '3' })];
  const r = selectTop(cands, 0);
  assert.equal(r.file.length, 2);
  assert.equal(r.backlog.length, 1);
  assert.equal(r.backpressure, false);
});

test('selectTop: open 数 >= 2 で backpressure（全候補 backlog へ）', () => {
  const cands = [validCand({ title: '1' })];
  const r = selectTop(cands, 2);
  assert.deepEqual(r.file, []);
  assert.equal(r.backlog.length, 1);
  assert.equal(r.backpressure, true);
  // fail-closed 経路: openImproveCount=Infinity でも backpressure
  assert.equal(selectTop(cands, Infinity).backpressure, true);
});

test('buildImproveIssueBody: evidence / AC / hypothesis を含む', () => {
  const body = buildImproveIssueBody(validCand(), { hypothesisBlock: '<HYP>' });
  assert.match(body, /## Evidence/);
  assert.match(body, /journal entry 20260712T211350/);
  assert.match(body, /- \[ \] stuck 終端率が下がる/);
  assert.match(body, /<HYP>/);
  assert.doesNotMatch(body, /dev-flow-canary/);
});

test('buildImproveIssueBody: core path 接触で canary AC を自動追記', () => {
  const body = buildImproveIssueBody(
    validCand({ target_paths: ['.claude/workflows/dev-flow.js'] }),
    { hypothesisBlock: '<HYP>' },
  );
  assert.match(body, /dev-flow-canary/);
});

test('buildBacklogSection: cycle 見出しと候補行', () => {
  const s = buildBacklogSection({ today: '2026-07-13T00:00:00Z', losers: [validCand()] });
  assert.match(s, /### cycle 2026-07-13T00:00:00Z/);
  assert.match(s, /\[doctor-anomaly\] 改善候補X/);
});
```

- [ ] **Step 2: テストが FAIL することを確認**

Run: `node --test _lib/improve-rank.test.mjs`
Expected: FAIL（module not found）

- [ ] **Step 3: canonical を実装**

`_lib/improve-rank.mjs`:

```js
// _lib/improve-rank.mjs
// dev-improve の候補 validate / dedup fingerprint / 決定論 rank / throughput cap +
// backpressure / issue body 生成。I/O なし・非決定性なし。
// LLM judge はスコア付けのみ — 最終順位・cut・棄却は本ファイルの決定論で行う
//（W7: cap は incentive-structural — ループに自分の提案量を自己増幅させない）。
// cross-canonical import 禁止のため metric enum は validateCandidate の引数で受ける。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

export const IMPROVE_MAX = 2;
export const IMPROVE_BACKPRESSURE_OPEN = 2;
export const IMPROVE_SOURCES = Object.freeze([
  'doctor-anomaly', 'failure-rca', 'sunset', 'pr-signal', 'reconcile-revert',
]);
export const IMPROVE_RISKS = Object.freeze(['low', 'medium', 'high']);
// dev-flow 本体（自己改変）に該当する path prefix。触れる候補は canary AC を自動追記する。
export const IMPROVE_CORE_PREFIXES = Object.freeze([
  '.claude/workflows/', '_lib/', '.claude/agents/', 'tools/',
]);

// candidateKey(c): dedup 用の正規化 fingerprint。unicode 文字・数字以外を除去し lowercase。
export function candidateKey(c) {
  return String(c?.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// validateCandidate(c, metricNames): 共通 candidate schema の決定論バリデーション。
// evidence 空・AC 空・out-of-enum source/risk/metric・数値不正は false（棄却）。
export function validateCandidate(c, metricNames) {
  if (c == null || typeof c !== 'object') return false;
  if (!IMPROVE_SOURCES.includes(c.source)) return false;
  if (typeof c.title !== 'string' || !c.title.trim()) return false;
  if (!Array.isArray(c.evidence) || c.evidence.length === 0) return false;
  if (!c.evidence.every((e) => typeof e === 'string' && e.trim())) return false;
  if (!Array.isArray(c.acceptance_criteria) || c.acceptance_criteria.length === 0) return false;
  if (!c.acceptance_criteria.every((a) => typeof a === 'string' && a.trim())) return false;
  if (!IMPROVE_RISKS.includes(c.risk)) return false;
  const d = c.expected_metric_delta;
  if (d == null || typeof d !== 'object') return false;
  if (!Array.isArray(metricNames) || !metricNames.includes(d.metric)) return false;
  if (typeof d.current !== 'number' || !Number.isFinite(d.current)) return false;
  if (typeof d.target !== 'number' || !Number.isFinite(d.target)) return false;
  if (!Number.isInteger(d.min_runs) || d.min_runs < 1) return false;
  return true;
}

// rankCandidates(cands, scores): judge の {index, score} を突合し決定論順に整列した新配列を返す。
// score 降順 → risk 昇順（low < medium < high）→ candidateKey 昇順。score 不在 index は 0 扱い。
export function rankCandidates(cands, scores) {
  const scoreByIndex = {};
  for (const s of Array.isArray(scores) ? scores : []) {
    if (s != null && Number.isInteger(s.index) && typeof s.score === 'number' && Number.isFinite(s.score)) {
      scoreByIndex[s.index] = s.score;
    }
  }
  const riskOrder = { low: 0, medium: 1, high: 2 };
  return cands
    .map((c, i) => ({ c, score: scoreByIndex[i] ?? 0 }))
    .sort((a, b) => (b.score - a.score)
      || (riskOrder[a.c.risk] - riskOrder[b.c.risk])
      || (candidateKey(a.c) < candidateKey(b.c) ? -1 : candidateKey(a.c) > candidateKey(b.c) ? 1 : 0))
    .map((x) => x.c);
}

// selectTop(ranked, openImproveCount): backpressure + IMPROVE_MAX cut。
// openImproveCount が取得不能な場合は Infinity を渡す（fail-closed = backpressure 扱い）。
export function selectTop(ranked, openImproveCount) {
  if (Number(openImproveCount) >= IMPROVE_BACKPRESSURE_OPEN) {
    return { file: [], backlog: ranked.slice(), backpressure: true };
  }
  return { file: ranked.slice(0, IMPROVE_MAX), backlog: ranked.slice(IMPROVE_MAX), backpressure: false };
}

// buildImproveIssueBody(c, {hypothesisBlock}): 起票 issue body markdown を生成する。
// c.target_paths が IMPROVE_CORE_PREFIXES に触れる場合は canary AC（自己改変 floor）を自動追記。
export function buildImproveIssueBody(c, { hypothesisBlock }) {
  const lines = [];
  lines.push('## 背景');
  lines.push('');
  lines.push(`dev-improve サイクル（source: ${c.source}）が telemetry / PR シグナルから起票した自己改善 issue。`);
  if (typeof c.body_notes === 'string' && c.body_notes.trim()) {
    lines.push('');
    lines.push(c.body_notes.trim());
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  for (const e of c.evidence) lines.push(`- ${e}`);
  lines.push('');
  lines.push('## 受入条件');
  lines.push('');
  for (const a of c.acceptance_criteria) lines.push(`- [ ] ${a}`);
  const touchesCore = Array.isArray(c.target_paths)
    && c.target_paths.some((p) => IMPROVE_CORE_PREFIXES.some((pre) => String(p).startsWith(pre)));
  if (touchesCore) {
    lines.push('- [ ] PR 作成後に /dev-flow-canary を実行し、read-only capability canary が green であること（自己改変 floor）');
  }
  lines.push('');
  lines.push('## 効果検証仮説（dev-improve managed — 手動編集禁止）');
  lines.push('');
  lines.push(hypothesisBlock);
  lines.push('');
  lines.push('---');
  lines.push('*この issue は dev-improve（自己改善ループ）により自動起票されました。*');
  return lines.join('\n');
}

// buildBacklogSection({today, losers}): backlog issue へ追記する markdown セクション。
export function buildBacklogSection({ today, losers }) {
  const lines = [];
  lines.push(`### cycle ${today}`);
  lines.push('');
  for (const c of losers) {
    lines.push(`- [${c.source}] ${c.title}（risk: ${c.risk} / metric: ${c.expected_metric_delta.metric}）`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: テストが PASS することを確認**

Run: `node --test _lib/improve-rank.test.mjs`
Expected: PASS（11 tests）

- [ ] **Step 5: Commit**

```bash
git add _lib/improve-rank.mjs _lib/improve-rank.test.mjs
git commit -m "feat(dev-improve): 候補 rank/cap/issue-body canonical (_lib/improve-rank.mjs)"
```

---

### Task 3: journal.sh に `--telemetry-json` 汎用 flag を追加

**Files:**
- Modify: `skill-retrospective/scripts/journal.sh`（cmd_log 内 3 箇所）
- Test: `skill-retrospective/scripts/journal.bats`（末尾に 4 test 追記）

**Interfaces:**
- Consumes: 既存 cmd_log の locals / telemetry build セクション
- Produces: `journal.sh log <skill> <outcome> --telemetry-json '<JSON object>'` — object を `.telemetry` にマージ（既存 flag と併用可、`--telemetry-json` が後勝ち）。非 JSON / 非 object は error exit

- [ ] **Step 1: failing test を書く（journal.bats 末尾に追記）**

```bash
# ---------------------------------------------------------------------------
# --telemetry-json (dev-improve improve-cycle telemetry 用の汎用 flag)
# ---------------------------------------------------------------------------
@test "--telemetry-json: 任意 object が telemetry にマージされる" {
    run "$SCRIPT" log dev-improve success \
        --telemetry-json '{"candidates_found":3,"issues_filed":2,"backpressure_skipped":false}'
    [ "$status" -eq 0 ]
    entry_file=$(latest_entry)
    [ -n "$entry_file" ]
    [ "$(jq -r '.telemetry.candidates_found' "$entry_file")" = "3" ]
    [ "$(jq -r '.telemetry.issues_filed' "$entry_file")" = "2" ]
    [ "$(jq -r '.telemetry.backpressure_skipped' "$entry_file")" = "false" ]
}

@test "--telemetry-json: 既存 telemetry flag と併用できる" {
    run "$SCRIPT" log dev-flow success \
        --merge-tier REVIEW \
        --telemetry-json '{"candidates_found":1}'
    [ "$status" -eq 0 ]
    entry_file=$(latest_entry)
    [ "$(jq -r '.telemetry.merge_tier' "$entry_file")" = "REVIEW" ]
    [ "$(jq -r '.telemetry.candidates_found' "$entry_file")" = "1" ]
}

@test "--telemetry-json: JSON でない値は error" {
    run "$SCRIPT" log dev-improve success --telemetry-json 'not-json'
    [ "$status" -ne 0 ]
}

@test "--telemetry-json: object 以外（配列）は error" {
    run "$SCRIPT" log dev-improve success --telemetry-json '[1,2]'
    [ "$status" -ne 0 ]
}
```

- [ ] **Step 2: テストが FAIL することを確認**

Run: `bats skill-retrospective/scripts/journal.bats`
Expected: 新 4 test が FAIL（`Unknown option: --telemetry-json`）、既存 test は PASS

- [ ] **Step 3: journal.sh を実装**

(a) cmd_log の locals（`local ci_wait_seconds="" ci_poll_attempts=""` の直後）に追加:

```bash
    local telemetry_json=""
```

(b) option parse の case（`--ci-poll-attempts)` の行の直後）に追加:

```bash
            --telemetry-json) telemetry_json="$2"; shift 2 ;;
```

(c) option parse loop 終了後の validation 群（error category validation の後）に追加:

```bash
    # Validate --telemetry-json (must be a JSON object)
    if [[ -n "$telemetry_json" ]]; then
        if ! echo "$telemetry_json" | jq -e 'type == "object"' >/dev/null 2>&1; then
            die_json "Invalid --telemetry-json: must be a JSON object" 1
        fi
    fi
```

(d) telemetry build セクション（`ci_poll_attempts` のマージ block の直後、`if [[ "$has_telemetry" == true ]]` の前）に追加:

```bash
    if [[ -n "$telemetry_json" ]]; then
        telemetry=$(echo "$telemetry" | jq --argjson extra "$telemetry_json" '. + $extra')
        has_telemetry=true
    fi
```

- [ ] **Step 4: テストが PASS することを確認**

Run: `bats skill-retrospective/scripts/journal.bats`
Expected: 全 test PASS（既存 + 新 4）

- [ ] **Step 5: Commit**

```bash
git add skill-retrospective/scripts/journal.sh skill-retrospective/scripts/journal.bats
git commit -m "feat(skill-retrospective): journal.sh に --telemetry-json 汎用 flag を追加"
```

---

### Task 4: `hypothesis-check.sh` — 仮説突合の決定論 oracle

**Files:**
- Create: `dev-flow-improve/scripts/hypothesis-check.sh`（chmod +x）
- Test: `dev-flow-improve/scripts/hypothesis-check.bats`

**Interfaces:**
- Consumes: `$CLAUDE_JOURNAL_DIR`（default `~/.claude/journal`）の `*.json`、`_lib/common.sh` の `die_json` / `require_cmd`
- Produces: stdout JSON `{ok:true, metric, value:<num>, runs:<int>, verdict:"confirmed"|"not_confirmed"|"insufficient_data"}`。metric enum と direction は Task 1 の `IMPROVE_METRIC_DIRECTIONS` と 1:1（コメントで相互参照）

- [ ] **Step 1: failing test を書く**

`dev-flow-improve/scripts/hypothesis-check.bats`:

```bash
#!/usr/bin/env bats
# Tests for dev-flow-improve/scripts/hypothesis-check.sh

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-flow-improve/scripts/hypothesis-check.sh"
    export CLAUDE_JOURNAL_DIR="$BATS_TMPDIR/journal-$$"
    mkdir -p "$CLAUDE_JOURNAL_DIR"
}

teardown() {
    rm -rf "$CLAUDE_JOURNAL_DIR"
}

# $1=filename $2=timestamp $3=iterate_status $4=shape $5=eval_iter(省略時1)
write_entry() {
    jq -n --arg ts "$2" --arg it "$3" --arg sh "$4" --argjson ei "${5:-1}" \
        '{version:"1.0.0", timestamp:$ts, skill:"dev-flow", outcome:"success",
          telemetry:{iterate_status:$it, shape:$sh, eval_iter:$ei, plan_iter:1}}' \
        > "$CLAUDE_JOURNAL_DIR/$1"
}

@test "iterate_unhealthy_rate: 半数 unhealthy → value 0.5、lte 0.5 で confirmed" {
    write_entry a.json 2026-07-01T00:00:00Z lgtm standard
    write_entry b.json 2026-07-02T00:00:00Z stuck standard
    run bash "$SCRIPT" --metric iterate_unhealthy_rate --since 2026-06-30T00:00:00Z --target 0.5 --min-runs 2
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.value')" = "0.5" ]
    [ "$(echo "$output" | jq -r '.runs')" = "2" ]
    [ "$(echo "$output" | jq -r '.verdict')" = "confirmed" ]
}

@test "since フィルタ: 窓外 entry は分母に入らない" {
    write_entry old.json 2026-01-01T00:00:00Z stuck standard
    write_entry new.json 2026-07-02T00:00:00Z lgtm standard
    run bash "$SCRIPT" --metric iterate_unhealthy_rate --since 2026-06-30T00:00:00Z --target 0.1 --min-runs 1
    [ "$(echo "$output" | jq -r '.runs')" = "1" ]
    [ "$(echo "$output" | jq -r '.value')" = "0" ]
    [ "$(echo "$output" | jq -r '.verdict')" = "confirmed" ]
}

@test "min-runs 未達 → insufficient_data" {
    write_entry a.json 2026-07-01T00:00:00Z lgtm standard
    run bash "$SCRIPT" --metric iterate_unhealthy_rate --since 2026-06-30T00:00:00Z --target 0.5 --min-runs 5
    [ "$(echo "$output" | jq -r '.verdict')" = "insufficient_data" ]
}

@test "micro_share: gte direction（target 以上で confirmed）" {
    write_entry a.json 2026-07-01T00:00:00Z lgtm micro
    write_entry b.json 2026-07-02T00:00:00Z lgtm standard
    run bash "$SCRIPT" --metric micro_share --since 2026-06-30T00:00:00Z --target 0.3 --min-runs 2
    [ "$(echo "$output" | jq -r '.value')" = "0.5" ]
    [ "$(echo "$output" | jq -r '.verdict')" = "confirmed" ]
}

@test "cap_pinned_count: eval_iter>=10 を数え、lte 0 で not_confirmed" {
    write_entry a.json 2026-07-01T00:00:00Z lgtm standard 10
    write_entry b.json 2026-07-02T00:00:00Z lgtm standard 2
    run bash "$SCRIPT" --metric cap_pinned_count --since 2026-06-30T00:00:00Z --target 0 --min-runs 2
    [ "$(echo "$output" | jq -r '.value')" = "1" ]
    [ "$(echo "$output" | jq -r '.verdict')" = "not_confirmed" ]
}

@test "out-of-enum metric は error exit" {
    run bash "$SCRIPT" --metric bogus_metric --since 2026-06-30T00:00:00Z --target 0 --min-runs 1
    [ "$status" -ne 0 ]
}

@test "引数不足 / 不正 --since は error exit" {
    run bash "$SCRIPT" --metric micro_share --target 0.3 --min-runs 1
    [ "$status" -ne 0 ]
    run bash "$SCRIPT" --metric micro_share --since not-a-date --target 0.3 --min-runs 1
    [ "$status" -ne 0 ]
}
```

- [ ] **Step 2: テストが FAIL することを確認**

Run: `bats dev-flow-improve/scripts/hypothesis-check.bats`
Expected: 全 FAIL（script 不在）

- [ ] **Step 3: script を実装**

`dev-flow-improve/scripts/hypothesis-check.sh`:

```bash
#!/usr/bin/env bash
# hypothesis-check.sh - dev-improve 仮説突合の決定論 oracle
#
# journal (~/.claude/journal/*.json、$CLAUDE_JOURNAL_DIR 優先) の dev-flow entries を
# --since 以降で集計し、--metric の実測値を --target と突合して verdict を返す。
# 効果判定はこの script が単一実装（軸A: LLM に self-judge させない）。
# metric enum は _lib/improve-hypothesis.mjs の IMPROVE_METRIC_DIRECTIONS と 1:1 を保つこと。
#
# Usage:
#   hypothesis-check.sh --metric <name> --since <ISO8601 UTC> --target <num> --min-runs <int>
#
# Metrics (closed enum — out-of-enum は error):
#   iterate_unhealthy_rate  telemetry.iterate_status が unhealthy
#                           (stuck/fix_failed/max_reached/ci_error/review_contract_error)
#                           の割合。分母 = iterate_status 非 null の dev-flow entries。lte
#   micro_share             telemetry.shape == "micro" の割合。分母 = shape 非 null。gte
#   cap_pinned_count        eval_iter >= 10 または plan_iter >= 8 の entry 数。lte
#
# Output (stdout JSON):
#   {"ok":true,"metric":...,"value":<num>,"runs":<int>,
#    "verdict":"confirmed"|"not_confirmed"|"insufficient_data"}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}"

METRIC="" SINCE="" TARGET="" MIN_RUNS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --metric) METRIC="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --min-runs) MIN_RUNS="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

if [[ -z "$METRIC" || -z "$SINCE" || -z "$TARGET" || -z "$MIN_RUNS" ]]; then
  die_json "Usage: hypothesis-check.sh --metric <name> --since <ISO> --target <num> --min-runs <int>" 1
fi
[[ "$MIN_RUNS" =~ ^[1-9][0-9]*$ ]] || die_json "Invalid --min-runs: $MIN_RUNS" 1
[[ "$TARGET" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] || die_json "Invalid --target: $TARGET" 1
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || die_json "Invalid --since: $SINCE (ISO8601 UTC expected)" 1

DIRECTION=""
case "$METRIC" in
  iterate_unhealthy_rate|cap_pinned_count) DIRECTION="lte" ;;
  micro_share) DIRECTION="gte" ;;
  *) die_json "Out-of-enum metric: $METRIC" 1 ;;
esac

# journal load（ARG_MAX-safe: find + xargs cat → jq -s）
ENTRIES='[]'
if [[ -d "$JOURNAL_DIR" ]]; then
  ENTRIES=$(find "$JOURNAL_DIR" -maxdepth 1 -name '*.json' -print0 2>/dev/null \
    | xargs -0 cat 2>/dev/null \
    | jq -s '[.[] | select(type == "object")]' 2>/dev/null || echo '[]')
fi

WINDOW=$(echo "$ENTRIES" | jq --arg since "$SINCE" \
  '[.[] | select(.skill == "dev-flow" and ((.timestamp // "") >= $since))]')

case "$METRIC" in
  iterate_unhealthy_rate)
    RESULT=$(echo "$WINDOW" | jq '
      [.[] | .telemetry.iterate_status // empty] as $st
      | ($st | length) as $runs
      | ([$st[] | select(. == "stuck" or . == "fix_failed" or . == "max_reached"
          or . == "ci_error" or . == "review_contract_error")] | length) as $bad
      | {runs: $runs, value: (if $runs == 0 then 0 else (($bad / $runs) * 1000 | round / 1000) end)}')
    ;;
  micro_share)
    RESULT=$(echo "$WINDOW" | jq '
      [.[] | .telemetry.shape // empty] as $sh
      | ($sh | length) as $runs
      | ([$sh[] | select(. == "micro")] | length) as $micro
      | {runs: $runs, value: (if $runs == 0 then 0 else (($micro / $runs) * 1000 | round / 1000) end)}')
    ;;
  cap_pinned_count)
    RESULT=$(echo "$WINDOW" | jq '
      length as $runs
      | ([.[] | select(((.telemetry.eval_iter // -1) >= 10) or ((.telemetry.plan_iter // -1) >= 8))]
          | length) as $pinned
      | {runs: $runs, value: $pinned}')
    ;;
esac

RUNS=$(echo "$RESULT" | jq '.runs')
VALUE=$(echo "$RESULT" | jq '.value')

VERDICT="insufficient_data"
if (( RUNS >= MIN_RUNS )); then
  if [[ "$DIRECTION" == "lte" ]]; then
    CMP=$(jq -n --argjson v "$VALUE" --argjson t "$TARGET" '$v <= $t')
  else
    CMP=$(jq -n --argjson v "$VALUE" --argjson t "$TARGET" '$v >= $t')
  fi
  if [[ "$CMP" == "true" ]]; then VERDICT="confirmed"; else VERDICT="not_confirmed"; fi
fi

jq -n --arg metric "$METRIC" --argjson value "$VALUE" --argjson runs "$RUNS" --arg verdict "$VERDICT" \
  '{ok: true, metric: $metric, value: $value, runs: $runs, verdict: $verdict}'
```

実装後: `chmod +x dev-flow-improve/scripts/hypothesis-check.sh`

- [ ] **Step 4: テストが PASS することを確認**

Run: `bats dev-flow-improve/scripts/hypothesis-check.bats`
Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add dev-flow-improve/scripts/hypothesis-check.sh dev-flow-improve/scripts/hypothesis-check.bats
git commit -m "feat(dev-flow-improve): 仮説突合の決定論 oracle hypothesis-check.sh"
```

---

### Task 5: `.claude/agents/improve-miner.md` — miner/judge subagent

**Files:**
- Create: `.claude/agents/improve-miner.md`
- Test: `_lib/improve-miner-frontmatter.test.mjs`

**Interfaces:**
- Consumes: なし
- Produces: `agentType: 'improve-miner'` で dev-improve workflow から呼ばれる（Mine 4 miner + Rank judge。judge 時のみ `model: QUALITY_MODEL` override）

- [ ] **Step 1: failing test を書く**

`_lib/improve-miner-frontmatter.test.mjs`:

```js
// _lib/improve-miner-frontmatter.test.mjs
// improve-miner agent frontmatter の invariant: read-only tools / model sonnet / effort high。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, '.claude/agents/improve-miner.md'), 'utf8');
const frontmatter = src.split('---')[1] ?? '';

test('improve-miner: name / model sonnet / effort high', () => {
  assert.match(frontmatter, /^name: improve-miner$/m);
  assert.match(frontmatter, /^model: sonnet$/m);
  assert.match(frontmatter, /^effort: high$/m);
});

test('improve-miner: read-only tools（Write/Edit/Skill/TodoWrite を持たない）', () => {
  for (const tool of ['Bash', 'Read', 'Grep', 'Glob']) {
    assert.match(frontmatter, new RegExp(`^  - ${tool}$`, 'm'));
  }
  assert.doesNotMatch(frontmatter, /^  - (Write|Edit|Skill|TodoWrite)$/m);
});
```

- [ ] **Step 2: テストが FAIL することを確認**

Run: `node --test _lib/improve-miner-frontmatter.test.mjs`
Expected: FAIL（ENOENT）

- [ ] **Step 3: agent 定義を書く**

`.claude/agents/improve-miner.md`:

```markdown
---
name: improve-miner
description: |
  Mine dev-flow improvement candidates from one signal source (doctor telemetry
  anomalies, failed-run RCA, W7 capability-bound sunset triggers, or PR-derived
  signals) and return them in the dev-improve common candidate schema. Also
  serves as the Rank-phase scoring judge over mined candidates. Strictly
  read-only: never mutates files, never runs git mutations, never creates
  issues or PRs.
  Use when: dev-improve workflow Mine phase dispatches a source-specific miner,
  or Rank phase dispatches the candidate scoring judge.
model: sonnet
effort: high
tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# improve-miner

dev-improve（自己改善ループ）の判断系 leaf。1 呼び出し = 1 ソースのマイニング、
または Rank phase のスコアリング judge。呼び出し prompt が Objective / Output format /
Tools / Boundary / Token cap（dispatch 必須 5 要素）を必ず指定する。

## 共通ルール

- **evidence 必須**: 根拠（journal entry id・PR 番号・anomaly type と実測値）を示せない
  候補は返さない。evidence 空の候補は orchestrator の決定論バリデーションで棄却される。
- **expected_metric_delta は enum から**: metric は prompt で与えられる enum
  （iterate_unhealthy_rate / micro_share / cap_pinned_count）のみ。効果検証仮説として
  現実的な target と min_runs を設定する。
- **read-only**: ファイル変更・git mutation（commit/push/reset）・issue/PR 作成は一切しない。
  Bash は読み取りコマンド（jq / gh の read 系 / git log / 固定パスの分析 script）のみ。
- **返り値は JSON のみ**: 最終メッセージは schema に従う JSON（prose 禁止）。
  Workflow の `agent()` schema バリデーションが型を強制する。
- **候補は少数精鋭**: 1 呼び出し最大 3 件。確度の低い候補・重複気味の候補は返さない。
  ゼロ件なら空配列を返す（無理に捻り出さない — moving target の抑制）。
```

- [ ] **Step 4: テストが PASS することを確認**

Run: `node --test _lib/improve-miner-frontmatter.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add .claude/agents/improve-miner.md _lib/improve-miner-frontmatter.test.mjs
git commit -m "feat(dev-improve): improve-miner subagent 定義（miner/judge 兼用・read-only）"
```

---

### Task 6: `.claude/workflows/dev-improve.js` — workflow 本体

**Files:**
- Create: `.claude/workflows/dev-improve.js`
- Test: `_lib/dev-improve-workflow.test.mjs`
- 生成: `node tools/sync-inlines.mjs --write`（inline 区間の充填）

**Interfaces:**
- Consumes: Task 1/2 の canonical（inline 生成）、`_lib/quality-model.mjs` / `_lib/workflow-post-helpers.mjs`（既存 canonical を inline）、Task 4 の hypothesis-check.sh、Task 5 の improve-miner、既存 exec-proxy agents（dev-runner / dev-runner-haiku / dev-runner-haiku-ro）
- Produces: `Workflow('dev-improve', {today: '<ISO UTC>'})` → `{issues_filed: number[], candidates_found: number, reconcile: {checked, confirmed, not_confirmed, insufficient, unavailable}, backlog_added: number, backpressure_skipped: boolean}`

- [ ] **Step 1: failing test を書く**

`_lib/dev-improve-workflow.test.mjs`:

```js
// _lib/dev-improve-workflow.test.mjs
// dev-improve.js の構造 invariant。挙動の決定論部分は inline 元 canonical のテストが担保し、
// 構文・ロード安全性は workflow-load-smoke.test.mjs / workflow-inlines.sync.test.mjs が
// 自動カバーする（両テストは .claude/workflows/*.js を自動発見する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanMarkers } from '../tools/sync-inlines.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, '.claude/workflows/dev-improve.js'), 'utf8');

test('dev-improve.js: meta name と 4 phase', () => {
  assert.match(src, /name: 'dev-improve'/);
  for (const t of ['Reconcile', 'Mine', 'Rank', 'File']) {
    assert.match(src, new RegExp(`title: '${t}'`));
  }
});

test('dev-improve.js: 必要な canonical が inline されている', () => {
  const sources = scanMarkers(src, 'dev-improve.js').map((m) => m.source).sort();
  assert.deepEqual(sources, [
    '_lib/improve-hypothesis.mjs',
    '_lib/improve-rank.mjs',
    '_lib/quality-model.mjs',
    '_lib/workflow-post-helpers.mjs',
  ]);
});

test('dev-improve.js: args.today を検証し Date 系 API を使わない', () => {
  assert.match(src, /args\?\.today/);
  assert.doesNotMatch(src, /\bDate\.now\b/);
  assert.doesNotMatch(src, /\bnew Date\b/);
  assert.doesNotMatch(src, /\bMath\.random\b/);
});

test('dev-improve.js: journal telemetry を --telemetry-json で記録する', () => {
  assert.match(src, /journal\.sh log dev-improve success --telemetry-json/);
});

test('dev-improve.js: 4 miner ソースが揃っている', () => {
  for (const key of ['doctor-anomaly', 'failure-rca', 'sunset', 'pr-signal']) {
    assert.match(src, new RegExp(`key: '${key}'`));
  }
});
```

- [ ] **Step 2: テストが FAIL することを確認**

Run: `node --test _lib/dev-improve-workflow.test.mjs`
Expected: FAIL（ENOENT）

- [ ] **Step 3: workflow を実装（inline 区間は空マーカーで作成 → generator が充填）**

`.claude/workflows/dev-improve.js` を以下の内容で作成する。
**注意**: 4 つの `BEGIN inline` 区間は BEGIN/END 行のみ書き、本文は直後の
`node tools/sync-inlines.mjs --write` に充填させる（手書き複製禁止）。

```js
export const meta = {
  name: 'dev-improve',
  description: 'dev-flow 自己改善サイクル: 仮説突合→4ソースマイニング→rank→issue化（上限2件/回、実装は呼び出し元が dev-flow を起動、merge は人間）',
  whenToUse: '週次 self-improve サイクル。/dev-flow-improve 起動 skill から呼ばれる。単体起動も可（issue 化まで）',
  phases: [
    { title: 'Reconcile', detail: '前サイクル仮説の実測突合' },
    { title: 'Mine', detail: '4ソース並列マイニング' },
    { title: 'Rank', detail: 'dedup + 優先度 rank + 上位2件' },
    { title: 'File', detail: 'issue 作成 + backlog 追記 + telemetry' },
  ],
}

// ==== BEGIN inline: _lib/quality-model.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// ==== END inline: _lib/quality-model.mjs ====

// ==== BEGIN inline: _lib/improve-hypothesis.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// ==== END inline: _lib/improve-hypothesis.mjs ====

// ==== BEGIN inline: _lib/improve-rank.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// ==== END inline: _lib/improve-rank.mjs ====

// ==== BEGIN inline: _lib/workflow-post-helpers.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// ==== END inline: _lib/workflow-post-helpers.mjs ====

// ---- args 正規化（workflow は Date 系 API 禁止 — 現在時刻は起動側から受け取る）----
const TODAY = (() => {
  const raw = (typeof args === 'string') ? args : args?.today
  const s = String(raw ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) {
    throw new Error(`dev-improve: args.today に ISO8601 UTC timestamp が必要です（受信: ${JSON.stringify(s)}）`)
  }
  return s
})()

const METRIC_NAMES = improveMetricNames()

// ---- schemas ----
const ISSUE_LIST = {
  type: 'object',
  required: ['ok', 'issues'],
  properties: {
    ok: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'title'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          body: { type: 'string' },
          closedAt: { type: 'string' },
        },
      },
    },
  },
}

const HYP_CHECK = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    metric: { type: 'string' },
    value: { type: 'number' },
    runs: { type: 'number' },
    verdict: { type: 'string', enum: ['confirmed', 'not_confirmed', 'insufficient_data'] },
  },
}

const CANDIDATES = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'title', 'evidence', 'acceptance_criteria', 'expected_metric_delta', 'risk'],
        properties: {
          source: { type: 'string', enum: ['doctor-anomaly', 'failure-rca', 'sunset', 'pr-signal'] },
          title: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          acceptance_criteria: { type: 'array', items: { type: 'string' } },
          body_notes: { type: 'string' },
          target_paths: { type: 'array', items: { type: 'string' } },
          expected_metric_delta: {
            type: 'object',
            required: ['metric', 'current', 'target', 'min_runs'],
            properties: {
              metric: { type: 'string', enum: METRIC_NAMES },
              current: { type: 'number' },
              target: { type: 'number' },
              min_runs: { type: 'number' },
            },
          },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
  },
}

const RANKING = {
  type: 'object',
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'score'],
        properties: {
          index: { type: 'number' },
          score: { type: 'number' },
          duplicate_of_existing: { type: 'boolean' },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

const ISSUE_CREATED = {
  type: 'object',
  required: ['created'],
  properties: {
    created: { type: 'boolean' },
    number: { type: 'number' },
    url: { type: 'string' },
  },
}

// ============================================================================
// Phase 1: Reconcile — 前サイクル仮説の実測突合（fail-open: 突合不能は skip + log）
// ============================================================================
phase('Reconcile')

const reconcile = { checked: 0, confirmed: 0, not_confirmed: 0, insufficient: 0, unavailable: 0 }
const revertCandidates = []

const closedList = await agent(
  `## Objective\nlabel self-improve の closed issue 一覧を取得する（dev-improve Reconcile 用）。\n\n`
  + `## Instructions\n次のコマンドをそのまま実行し、stdout の JSON 配列を issues に入れて返せ:\n`
  + `\`gh issue list --label self-improve --state closed --limit 20 --json number,title,body,closedAt\`\n`
  + `コマンド失敗時（label 不存在含む）は throw せず ok:false, issues:[] を返すこと。\n`
  + `\n## Output format\n{ "ok": boolean, "issues": [{number, title, body, closedAt}] }\n`
  + `\n## Tools\n使用可: Bash のみ\n\n## Boundary\n読み取り専用。ファイル変更・git 操作禁止。\n\n## Token cap\nJSON のみ返す。`,
  { agentType: 'dev-runner-haiku-ro', schema: ISSUE_LIST, label: 'list-closed', phase: 'Reconcile' },
)

const pendingIssues = []
for (const it of (closedList?.ok ? closedList.issues : [])) {
  try {
    const hyp = parseHypothesisBlock(it.body ?? '')
    if (hyp && hyp.status === 'pending') pendingIssues.push({ ...it, hyp })
  } catch (e) {
    reconcile.unavailable++
    log(`⚠️ Reconcile: issue #${it.number} の hypothesis parse 失敗 — skip（${e.message}）`)
  }
}
log(`Reconcile: pending 仮説 ${pendingIssues.length} 件`)

for (const it of pendingIssues) {
  const since = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(it.closedAt ?? '')) ? it.closedAt : null
  if (!since) {
    reconcile.unavailable++
    log(`⚠️ Reconcile: issue #${it.number} closedAt 不正 — skip`)
    continue
  }
  reconcile.checked++
  const check = await agent(
    `## Objective\nissue #${it.number} の改善仮説を telemetry 実測と突合する。\n\n`
    + `## Instructions\nインストール済み skills の**固定パス**で次のコマンドをそのまま実行し、stdout JSON をそのまま返せ:\n`
    + `\`bash ~/.claude/skills/dev-flow-improve/scripts/hypothesis-check.sh --metric ${it.hyp.metric} --since ${since} --target ${it.hyp.target} --min-runs ${it.hyp.min_runs}\`\n`
    + `必ずリテラルの \`~/.claude/skills/...\` 絶対パス形で起動せよ（worktree 相対パス禁止）。\n`
    + `コマンド失敗時は throw せず ok:false を返すこと。\n`
    + `\n## Output format\n{ "ok": boolean, "metric": string, "value": number, "runs": number, "verdict": "confirmed"|"not_confirmed"|"insufficient_data" }\n`
    + `\n## Tools\n使用可: Bash, Read\n\n## Boundary\n読み取り専用。ファイル変更・git 操作禁止。\n\n## Token cap\nJSON のみ。`,
    { agentType: 'dev-runner-haiku-ro', schema: HYP_CHECK, label: `hyp-check#${it.number}`, phase: 'Reconcile' },
  )
  if (!check?.ok || !check.verdict) {
    reconcile.unavailable++
    log(`⚠️ Reconcile: issue #${it.number} 突合不能（fail-open）— skip`)
    continue
  }
  if (check.verdict === 'insufficient_data') {
    reconcile.insufficient++
    log(`Reconcile: #${it.number} データ不足（runs=${check.runs}）— 次サイクル持越し`)
    continue
  }

  const newStatus = check.verdict === 'confirmed' ? 'confirmed' : 'not_confirmed'
  reconcile[newStatus]++
  let newBody
  try {
    newBody = setHypothesisStatus(it.body, newStatus)
  } catch (e) {
    reconcile.unavailable++
    log(`⚠️ Reconcile: #${it.number} status 更新失敗 — skip（${e.message}）`)
    continue
  }

  const editRes = await agent(
    `## Objective\nissue #${it.number} の body を hypothesis status=${newStatus} に更新する。\n\n`
    + bodySaveInstr(newBody, 'dev-improve-body', 'DEV_IMPROVE')
    + `## Instructions\n保存した <BODY_FILE> で次を実行: \`gh issue edit ${it.number} --body-file <BODY_FILE>\`\n`
    + `成功時 posted:true。失敗時も throw せず posted:false。\n`
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。\n\n## Token cap\n100 語以内。`,
    { agentType: 'dev-runner', schema: POST_RESULT, label: `hyp-update#${it.number}`, phase: 'Reconcile' },
  )
  if (!editRes?.posted) log(`⚠️ Reconcile: #${it.number} body 更新の投稿に失敗（fail-open）`)

  const resultNote = [
    `## dev-improve 仮説突合結果（cycle ${TODAY}）`,
    '',
    `- verdict: **${check.verdict}**`,
    `- metric: \`${it.hyp.metric}\` — 実測 ${check.value}（target: ${it.hyp.target} / 観測 runs: ${check.runs} / since: ${since}）`,
    check.verdict === 'not_confirmed'
      ? '- 効果未確認のため revert / 再設計候補として次サイクルの候補プールに登録（自動 revert はしない — 判断は人間）'
      : '- 期待どおりの telemetry 変化を確認',
  ].join('\n')
  const noteRes = await agent(
    `## Objective\nissue #${it.number} に仮説突合結果コメントを投稿する。\n\n`
    + bodySaveInstr(resultNote, 'dev-improve-note', 'DEV_IMPROVE')
    + `## Instructions\n保存した <BODY_FILE> で次を実行: \`gh issue comment ${it.number} --body-file <BODY_FILE>\`\n`
    + `成功時 posted:true。失敗時も throw せず posted:false。\n`
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。\n\n## Token cap\n100 語以内。`,
    { agentType: 'dev-runner', schema: POST_RESULT, label: `hyp-note#${it.number}`, phase: 'Reconcile' },
  )
  if (!noteRes?.posted) log(`⚠️ Reconcile: #${it.number} 突合コメントの投稿に失敗（fail-open）`)

  if (check.verdict === 'not_confirmed') {
    revertCandidates.push({
      source: 'reconcile-revert',
      title: `効果未確認: issue #${it.number}「${it.title}」の改善の revert / 再設計を検討`,
      evidence: [
        `hypothesis 突合: metric=${it.hyp.metric} 実測 ${check.value} が target ${it.hyp.target} に未達（runs=${check.runs}, since=${since}）`,
      ],
      acceptance_criteria: [
        `issue #${it.number} の変更を revert するか、効かなかった原因を特定して再設計するかを判断し実施する`,
        '判断根拠を issue コメントに記録する',
      ],
      expected_metric_delta: {
        metric: it.hyp.metric, current: check.value, target: it.hyp.target, min_runs: it.hyp.min_runs,
      },
      risk: 'medium',
      target_paths: [],
    })
  }
}

// ============================================================================
// Phase 2: Mine — 4 ソース並列マイニング（barrier: Rank は全 miner の結果を要する）
// ============================================================================
phase('Mine')

const MINER_COMMON = `\n## Output format（共通 candidate schema）\n`
  + `candidates 配列で返す（最大 3 件、ゼロ件可）。各要素:\n`
  + `{source, title, evidence[], acceptance_criteria[], body_notes?, target_paths?, expected_metric_delta{metric,current,target,min_runs}, risk}\n`
  + `- evidence: journal entry id / PR 番号 / anomaly type と実測値への具体的参照（非空文字列の配列）。**根拠を示せない候補は返すな**（evidence 空は決定論で棄却される）。\n`
  + `- expected_metric_delta.metric は次の enum から選ぶ: ${METRIC_NAMES.join(' / ')}。current は実測値、target は改善後の期待値、min_runs は突合に必要な最小 run 数（3〜10 程度）。\n`
  + `- acceptance_criteria: 実装 PR の受入条件（検証可能な形で 2〜5 件）。\n`
  + `- target_paths: 変更が想定されるファイル/ディレクトリの repo 相対 path。\n`
  + `- risk: low / medium / high。\n`
  + `\n## Tools\n使用可: Bash（読み取りコマンドのみ）, Read, Grep, Glob\n`
  + `\n## Boundary\n読み取り専用 — ファイル変更・git mutation・issue/PR 作成は禁止。repo root は現在の working directory。\n`
  + `\n## Token cap\n出力は JSON のみ。3000 語以内。`

const MINERS = [
  {
    key: 'doctor-anomaly',
    prompt: `## Objective\ndev-flow-doctor の telemetry 分布・anomaly から dev-flow の改善候補を掘る（source: "doctor-anomaly"）。\n\n`
      + `## Instructions\n1. \`bash ~/.claude/skills/dev-flow-doctor/scripts/analyze-dev-flow-telemetry.sh --window 30d\` を実行し JSON を得る（必ずこのリテラル固定パス形で起動）。\n`
      + `2. anomalies（cap_pinned / iterate_unhealthy / micro_nonfiring）と distributions の歪みを読み、dev-flow の仕組み側の改善候補に翻訳する。\n`
      + `3. 各候補の evidence に anomaly type と実測数値を引用する。`
      + MINER_COMMON,
  },
  {
    key: 'failure-rca',
    prompt: `## Objective\n失敗・不完走 run の個別 RCA から改善候補を掘る（source: "failure-rca"）。\n\n`
      + `## Instructions\n1. journal（環境変数 CLAUDE_JOURNAL_DIR、無ければ ~/.claude/journal の *.json）から skill が dev-flow / pr-iterate の entry を読み、timestamp が ${TODAY} から遡って 30 日以内で、iterate_status が lgtm 以外・outcome が failure/partial・final_reconcile/final_ac_reconcile が unavailable・ui_verify が setup_failed のいずれかに該当する run を列挙する（jq 推奨）。\n`
      + `2. 頻出パターン（同じ終端理由・同じ error_category）を特定し、根本原因の仮説と dev-flow/pr-iterate の仕組み側の修正候補に翻訳する。\n`
      + `3. evidence には該当 entry の id / timestamp / フィールド値を引用する。`
      + MINER_COMMON,
  },
  {
    key: 'sunset',
    prompt: `## Objective\nW7 capability-bound distrust 機構の sunset（昇格・撤去）候補を検出する（source: "sunset"）。\n\n`
      + `## Instructions\n1. repo root の AGENTS.md の「distrust 機構の正当化クラス (W7)」節を読み、capability-bound の sunset path（gate_policy / ui-verify advisory / exec-proxy 橋 / sync-inlines 橋）の再評価トリガ条件を確認する。\n`
      + `2. 各トリガ条件が現在満たせる見込みかを、ローカル情報（journal telemetry の蓄積量と分布・\`git log --oneline -20\`）から判定する。トリガ充足の見込みがある機構だけを候補化する。\n`
      + `3. 昇格・撤去は必ず issue → 人間 merge 経由 — acceptance_criteria に再評価の実証手順（calibration 突合等）を含めること。\n`
      + `4. evidence には該当する AGENTS.md の記述と、トリガ充足を示す実測値を引用する。`
      + MINER_COMMON,
  },
  {
    key: 'pr-signal',
    prompt: `## Objective\nPR 由来シグナル（findings 再発・merge tier 推奨と人間判断の乖離）から改善候補を掘る（source: "pr-signal"）。\n\n`
      + `## Instructions\n1. journal（CLAUDE_JOURNAL_DIR 優先、無ければ ~/.claude/journal の *.json）から timestamp が ${TODAY} から遡って 30 日以内の dev-flow / pr-iterate entry の pr_number・repo・telemetry.merge_tier を集める。\n`
      + `2. pr_number があるものについて \`gh pr view <n> --json state,mergedAt,closedAt,url\` で人間の実判断を取得し、merge_tier 推奨との乖離（HOLD なのに即 merge / AUTO 推奨なのに reject 等）を探す。\n`
      + `3. \`gh pr list --state merged --limit 10 --json number,title\` と \`gh pr view <n> --comments\` で pr-iterate の自動レビューコメント（「pr-iterate により自動生成」）を読み、複数 PR で再発している findings パターンを探す。\n`
      + `4. 乖離・再発パターンを dev-flow / pr-iterate の仕組み改善候補に翻訳する。evidence には PR 番号と具体値を引用する。`
      + MINER_COMMON,
  },
]

const minerResults = await parallel(MINERS.map((m) => () =>
  agent(m.prompt, { agentType: 'improve-miner', schema: CANDIDATES, label: `mine:${m.key}`, phase: 'Mine' })
))
const mined = minerResults.filter(Boolean).flatMap((r) => r.candidates)
if (minerResults.some((r) => r == null)) log('⚠️ Mine: 一部 miner が結果を返さず（fail-open）— 残りのソースで続行')

const pool = [...revertCandidates, ...mined]
const candidates = pool.filter((c) => validateCandidate(c, METRIC_NAMES))
if (candidates.length < pool.length) {
  log(`Mine: 決定論バリデーションで ${pool.length - candidates.length} 件棄却（evidence/AC 欠落・out-of-enum）`)
}
log(`Mine: 有効候補 ${candidates.length} 件（revert 候補 ${revertCandidates.length} 件含む）`)

// ============================================================================
// Phase 3: Rank — dedup + judge スコアリング + 決定論 cut
// ============================================================================
phase('Rank')

const openList = await agent(
  `## Objective\nlabel self-improve の open issue 一覧を取得する（dedup と backpressure 判定用）。\n\n`
  + `## Instructions\n次のコマンドをそのまま実行し、stdout の JSON 配列を issues に入れて返せ:\n`
  + `\`gh issue list --label self-improve --state open --limit 50 --json number,title\`\n`
  + `コマンド失敗時は throw せず ok:false, issues:[] を返すこと。\n`
  + `\n## Output format\n{ "ok": boolean, "issues": [{number, title}] }\n`
  + `\n## Tools\n使用可: Bash のみ\n\n## Boundary\n読み取り専用。\n\n## Token cap\nJSON のみ。`,
  { agentType: 'dev-runner-haiku-ro', schema: ISSUE_LIST, label: 'list-open', phase: 'Rank' },
)
// fail-closed: open 数不明のまま issue 化しない（backpressure は人間の merge ペースに同期する
// incentive-structural cap — 取得失敗で緩めない）
const openCount = openList?.ok ? openList.issues.length : Infinity
if (!openList?.ok) log('⚠️ Rank: open issue 取得失敗 — fail-closed（今回サイクルの issue 化を skip し全候補を backlog へ）')

const backlogList = await agent(
  `## Objective\ndev-improve backlog issue（label self-improve-backlog）を取得する。\n\n`
  + `## Instructions\n次のコマンドをそのまま実行し、stdout の JSON 配列を issues に入れて返せ:\n`
  + `\`gh issue list --label self-improve-backlog --state open --limit 1 --json number,title,body\`\n`
  + `コマンド失敗時は throw せず ok:false, issues:[] を返すこと。\n`
  + `\n## Output format\n{ "ok": boolean, "issues": [{number, title, body}] }\n`
  + `\n## Tools\n使用可: Bash のみ\n\n## Boundary\n読み取り専用。\n\n## Token cap\nJSON のみ。`,
  { agentType: 'dev-runner-haiku-ro', schema: ISSUE_LIST, label: 'list-backlog', phase: 'Rank' },
)
const backlogIssue = (backlogList?.ok && backlogList.issues.length > 0) ? backlogList.issues[0] : null

// 決定論 dedup prefilter: 既存 open issue と title fingerprint が一致する候補は落とす
const existingKeys = new Set((openList?.ok ? openList.issues : []).map((x) => candidateKey(x)))
const fresh = candidates.filter((c) => {
  if (existingKeys.has(candidateKey(c))) {
    log(`Rank: dedup 落選（既存 open issue と同一 fingerprint）: ${c.title}`)
    return false
  }
  return true
})

let ranked = []
if (fresh.length > 0) {
  const judge = await agent(
    `## Objective\ndev-improve の改善候補に優先度スコアを付け、既存 open issue との実質重複を検出する。\n\n`
    + `## Input\n候補（index 付き）:\n${JSON.stringify(fresh.map((c, i) => ({ index: i, source: c.source, title: c.title, evidence: c.evidence, expected_metric_delta: c.expected_metric_delta, risk: c.risk })))}\n\n`
    + `既存 open issue タイトル:\n${JSON.stringify((openList?.ok ? openList.issues : []).map((x) => x.title))}\n\n`
    + `## Instructions\n各候補に score（0-100）を付けよ。基準: evidence の定量性（実測値引用の有無）× 期待効果の大きさ × リスクの低さ。`
    + `既存 open issue と実質同一の候補は duplicate_of_existing: true にせよ（score も返す）。全候補に同点を付けない。\n`
    + `\n## Output format\n{ "scores": [{ "index": number, "score": number, "duplicate_of_existing": boolean, "rationale": string }] }\n`
    + `\n## Tools\n使用可: Read, Grep, Glob, Bash（読み取りのみ）\n\n## Boundary\n読み取り専用。\n\n## Token cap\nrationale は各 30 語以内。`,
    { agentType: 'improve-miner', model: QUALITY_MODEL, schema: RANKING, label: 'rank-judge', phase: 'Rank' },
  )
  // judge は gate ではない（絞り込みのみ）— null でも決定論 tie-break で続行（fail-open）
  if (judge == null) log('⚠️ Rank: rank-judge が結果を返さず — score 0 扱いで決定論 tie-break のみで続行')
  const dupIdx = new Set((judge?.scores ?? []).filter((s) => s.duplicate_of_existing === true).map((s) => s.index))
  const dupKeys = new Set(fresh.filter((_, i) => dupIdx.has(i)).map((c) => candidateKey(c)))
  ranked = rankCandidates(fresh, judge?.scores).filter((c) => !dupKeys.has(candidateKey(c)))
  if (dupKeys.size > 0) log(`Rank: judge が実質重複 ${dupKeys.size} 件を検出 — 除外`)
}

const { file: winners, backlog: losers, backpressure } = selectTop(ranked, openCount)
log(`Rank: 通過 ${winners.length} 件 / backlog ${losers.length} 件 / backpressure=${backpressure}（open=${openList?.ok ? openCount : 'unknown'}）`)

// ============================================================================
// Phase 4: File — issue 作成 + backlog 追記 + telemetry
// ============================================================================
phase('File')

const filed = []
for (const c of winners) {
  const hypBlock = buildHypothesisBlock(c.expected_metric_delta)
  const body = buildImproveIssueBody(c, { hypothesisBlock: hypBlock })
  const created = await agent(
    `## Objective\ndev-improve の自己改善 issue を 1 件作成する。\n\n`
    + bodySaveInstr(body, 'dev-improve-issue', 'DEV_IMPROVE')
    + `## Instructions\n`
    + `1. \`gh label create self-improve --color 1D76DB --description "dev-improve self-improvement" --force\` を実行（既存でも成功する）。\n`
    + `2. 保存した <BODY_FILE> で issue を作成: \`gh issue create --title <TITLE> --label self-improve --body-file <BODY_FILE>\`\n`
    + `   <TITLE> は次のタイトルを一字一句そのまま、shell 安全にクォートして渡す: ${JSON.stringify(c.title)}\n`
    + `3. 出力 URL 末尾の issue 番号を number に入れ created:true を返す。失敗時は throw せず created:false。\n`
    + `\n## Output format\n{ "created": boolean, "number": number, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。issue 作成は 1 件のみ。\n\n## Token cap\n100 語以内。`,
    { agentType: 'dev-runner', schema: ISSUE_CREATED, label: `file-issue#${filed.length + 1}`, phase: 'File' },
  )
  if (created?.created && Number.isInteger(created.number)) {
    filed.push(created.number)
    log(`File: issue #${created.number} 起票 — ${c.title}`)
  } else {
    log(`⚠️ File: issue 作成失敗（fail-open）— ${c.title}`)
  }
}

// backlog 追記（dedup: 既に backlog body に同一タイトルがあれば追記しない）
let backlogAdded = 0
if (losers.length > 0) {
  const backlogBody = String(backlogIssue?.body ?? '')
  const newLosers = losers.filter((c) => !backlogBody.includes(c.title))
  if (newLosers.length > 0) {
    const section = buildBacklogSection({ today: TODAY, losers: newLosers })
    const newBody = backlogBody
      ? `${backlogBody}\n\n${section}`
      : `dev-improve の落選候補 backlog。再浮上は telemetry シグナル駆動（miner が再発見する）。\n\n${section}`
    const res = await agent(
      `## Objective\ndev-improve backlog issue を更新（なければ作成）する。\n\n`
      + bodySaveInstr(newBody, 'dev-improve-backlog', 'DEV_IMPROVE')
      + `## Instructions\n`
      + (backlogIssue
        ? `保存した <BODY_FILE> で次を実行: \`gh issue edit ${backlogIssue.number} --body-file <BODY_FILE>\`\n`
        : `1. \`gh label create self-improve-backlog --color C5DEF5 --description "dev-improve backlog" --force\`\n`
          + `2. \`gh issue create --title "dev-improve backlog" --label self-improve-backlog --body-file <BODY_FILE>\`\n`)
      + `成功時 created:true と issue 番号を返す。失敗時は throw せず created:false。\n`
      + `\n## Output format\n{ "created": boolean, "number": number, "url": string }\n`
      + `\n## Tools\n使用可: Bash, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。\n\n## Token cap\n100 語以内。`,
      { agentType: 'dev-runner', schema: ISSUE_CREATED, label: 'backlog-append', phase: 'File' },
    )
    if (res?.created) backlogAdded = newLosers.length
    else log('⚠️ File: backlog 更新失敗（fail-open）')
  }
}

// improve-cycle telemetry（journal.sh 直接呼び出し — 値は数値/boolean のみで quoting 安全）
const improveTelemetry = JSON.stringify({
  candidates_found: candidates.length,
  issues_filed: filed.length,
  hypotheses_confirmed: reconcile.confirmed,
  hypotheses_not_confirmed: reconcile.not_confirmed,
  hypotheses_insufficient: reconcile.insufficient,
  hypotheses_unavailable: reconcile.unavailable,
  backlog_added: backlogAdded,
  backpressure_skipped: backpressure,
})
const journalRes = await agent(
  `## Objective\ndev-improve サイクルの telemetry を journal に記録する。\n\n`
  + `## Instructions\n次のコマンドをそのまま実行せよ（リテラル固定パス形）:\n`
  + `\`bash ~/.claude/skills/skill-retrospective/scripts/journal.sh log dev-improve success --telemetry-json '${improveTelemetry}'\`\n`
  + `exit 0 なら logged:true、失敗しても throw せず logged:false を返すこと。\n`
  + `\n## Output format\n{ "logged": boolean, "summary": string }\n`
  + `\n## Tools\n使用可: Bash, Read, Skill\n\n## Boundary\n~/.claude/journal 以外のファイル変更禁止。git 操作禁止。\n\n## Token cap\n50 語以内。`,
  { agentType: 'dev-runner-haiku', schema: JOURNAL_RESULT, label: 'journal-log', phase: 'File' },
)
if (!journalRes?.logged) log('⚠️ journal-log 失敗（fail-open）— telemetry 記録漏れの可能性')

log(`dev-improve 完了: issue化 ${filed.length} 件 / backlog ${backlogAdded} 件 / backpressure=${backpressure}`)

return {
  issues_filed: filed,
  candidates_found: candidates.length,
  reconcile,
  backlog_added: backlogAdded,
  backpressure_skipped: backpressure,
}
```

- [ ] **Step 4: inline 区間を生成し、検証を回す**

```bash
node tools/sync-inlines.mjs --write
node tools/sync-inlines.mjs --check
node --test _lib/dev-improve-workflow.test.mjs _lib/workflow-inlines.sync.test.mjs _lib/workflow-load-smoke.test.mjs
```

Expected: `--write` が dev-improve.js の 4 区間を更新、`--check` exit 0、3 テストファイル全 PASS

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/dev-improve.js _lib/dev-improve-workflow.test.mjs
git commit -m "feat(dev-improve): dev-improve workflow (Reconcile/Mine/Rank/File)"
```

---

### Task 7: 起動 skill `/dev-flow-improve` + 週次 schedule installer

**Files:**
- Create: `dev-flow-improve/SKILL.md`
- Create: `dev-flow-improve/scripts/install-schedule.sh`（chmod +x）
- Test: `dev-flow-improve/scripts/install-schedule.bats`

**Interfaces:**
- Consumes: Task 6 の `Workflow('dev-improve', {today})` 返り値、既存 `dev-flow` skill（workflow）
- Produces: `/dev-flow-improve`（1 サイクル実行）、`install-schedule.sh --print|--install|--uninstall`

- [ ] **Step 1: failing test を書く**

`dev-flow-improve/scripts/install-schedule.bats`:

```bash
#!/usr/bin/env bats
# Tests for dev-flow-improve/scripts/install-schedule.sh (--print のみ検証。--install は launchctl 副作用のため対象外)

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-flow-improve/scripts/install-schedule.sh"
    # claude CLI を PATH stub でモック
    STUB_DIR="$BATS_TMPDIR/stub-$$"
    mkdir -p "$STUB_DIR"
    printf '#!/bin/sh\nexit 0\n' > "$STUB_DIR/claude"
    chmod +x "$STUB_DIR/claude"
    export PATH="$STUB_DIR:$PATH"
}

teardown() {
    rm -rf "$STUB_DIR"
}

@test "--print: plist に Label / claude / /dev-flow-improve / 週次スケジュールを含む" {
    run bash "$SCRIPT" --print
    [ "$status" -eq 0 ]
    [[ "$output" == *"com.playpark.dev-flow-improve"* ]]
    [[ "$output" == *"$STUB_DIR/claude"* ]]
    [[ "$output" == *"/dev-flow-improve"* ]]
    [[ "$output" == *"<key>Weekday</key><integer>1</integer>"* ]]
}

@test "--print: claude CLI 不在なら error" {
    export PATH="/usr/bin:/bin"
    run bash "$SCRIPT" --print
    [ "$status" -ne 0 ]
}

@test "引数なし / 不明引数は usage を出して exit 1" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    run bash "$SCRIPT" --bogus
    [ "$status" -eq 1 ]
}
```

- [ ] **Step 2: テストが FAIL することを確認**

Run: `bats dev-flow-improve/scripts/install-schedule.bats`
Expected: 全 FAIL（script 不在）

- [ ] **Step 3: installer script を実装**

`dev-flow-improve/scripts/install-schedule.sh`:

```bash
#!/usr/bin/env bash
# install-schedule.sh - dev-flow-improve の週次 launchd ジョブ登録（macOS）
#
# 毎週月曜 09:00（ローカル時刻）に `claude -p "/dev-flow-improve"` を skills リポジトリの
# root で headless 実行する LaunchAgent を登録する。
#
# Usage:
#   install-schedule.sh --print       # plist を stdout に出力（登録しない・CI/テスト用）
#   install-schedule.sh --install     # ~/Library/LaunchAgents へ書き込み + bootstrap
#   install-schedule.sh --uninstall   # bootout + plist 削除
set -euo pipefail

LABEL="com.playpark.dev-flow-improve"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.claude/logs"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

print_plist() {
  local claude_bin
  claude_bin="$(command -v claude || true)"
  if [[ -z "$claude_bin" ]]; then
    echo "error: claude CLI が PATH に見つかりません" >&2
    return 1
  fi
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${claude_bin}</string>
    <string>-p</string>
    <string>/dev-flow-improve</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/dev-flow-improve.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/dev-flow-improve.err.log</string>
</dict>
</plist>
PLIST
}

case "${1:-}" in
  --print)
    print_plist
    ;;
  --install)
    mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR"
    print_plist > "$PLIST_PATH"
    launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
    echo "installed: $PLIST_PATH"
    ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "uninstalled: $PLIST_PATH"
    ;;
  *)
    echo "Usage: install-schedule.sh --print|--install|--uninstall" >&2
    exit 1
    ;;
esac
```

実装後: `chmod +x dev-flow-improve/scripts/install-schedule.sh`

- [ ] **Step 4: installer テストが PASS することを確認**

Run: `bats dev-flow-improve/scripts/install-schedule.bats`
Expected: PASS（3 tests）

- [ ] **Step 5: SKILL.md を書く**

`dev-flow-improve/SKILL.md`:

```markdown
---
name: dev-flow-improve
description: |
  Runs one dev-improve self-improvement cycle for the dev-flow pipeline:
  reconciles previous improvement hypotheses against journal telemetry, mines
  improvement candidates from 4 sources (doctor anomalies, failed-run RCA,
  W7 sunset triggers, PR-derived signals), files at most 2 self-improve
  issues, then implements each filed issue by running dev-flow serially.
  Merge is always human (existing invariant preserved).
  Use when: (1) weekly self-improvement cycle (cron/launchd 起動),
  (2) user asks to improve dev-flow itself from telemetry,
  (3) keywords: dev-flow改善, 自己改善, self-improve, improve cycle, dev-improve,
  自己改善ループ, 改善サイクル.
---

# dev-flow-improve

dev-flow 自己改善ループの起動 skill。orchestration の実体は dynamic workflow
`dev-improve`（`.claude/workflows/dev-improve.js`）が持つ。本 skill は
(1) workflow 起動、(2) 起票 issue への dev-flow 実行、(3) サマリ報告のみを行う。
設計: `claudedocs/2026-07-13-dev-improve-loop-design.md` / W7 分類は AGENTS.md 参照。

## Workflow

1. **現在時刻を取得**（workflow は Date API 禁止のため args で渡す）:
   Bash で `date -u +%Y-%m-%dT%H:%M:%SZ` を実行し `<TODAY>` とする。
2. **Workflow tool で dev-improve を起動**: `{ name: 'dev-improve', args: { today: '<TODAY>' } }`
   返り値: `{ issues_filed, candidates_found, reconcile, backlog_added, backpressure_skipped }`
3. **起票 issue を dev-flow で順次実装**: `issues_filed` の各番号について、返却順に
   **1 件ずつ直列に** Skill tool で `dev-flow` を起動する（並列禁止 — worktree / CI 競合回避）。
   - dev-flow が `needs_clarification` を返した場合: headless/cron 文脈では人間に即答できない。
     該当 issue に状況が記録されていることを確認し、その issue は保留のまま次へ進む
     （worktree は保持される。次に人間がセッションで再起動する）。
   - 1 件の dev-flow 失敗は次の issue の実行を妨げない（1 issue = 1 PR で独立）。
4. **サマリ報告**: 仮説突合結果（confirmed / not_confirmed / insufficient / unavailable）、
   起票 issue 番号とタイトル、各 dev-flow の PR URL と終端 status、backpressure_skipped を報告する。
   improve-cycle telemetry は workflow が journal 記録済み。dev-flow 各 run の telemetry は
   dev-flow 自身が記録する。

## 安全弁（詳細は AGENTS.md の W7 分類）

- issue 化は 1 サイクル最大 2 件（IMPROVE_MAX）+ open self-improve issue 2 件以上で
  backpressure skip（人間の merge ペースに自動同期）
- merge は常に人間 — dev-flow の merge tier / human merge invariant をそのまま継承
- 自動 revert なし — not_confirmed 仮説は revert 候補 issue として人間判断に委ねる
- workflow 内の失敗は fail-open（issue 0 件で終了）。ただし open issue 数の取得失敗のみ
  fail-closed（backpressure 扱い）

## Schedule 登録（週次）

macOS launchd に毎週月曜 09:00 のジョブを登録する（1 回だけ手動実行）:

```
bash dev-flow-improve/scripts/install-schedule.sh --install
```

`--print` で plist 内容の確認、`--uninstall` で解除。
```

- [ ] **Step 6: Commit**

```bash
git add dev-flow-improve/SKILL.md dev-flow-improve/scripts/install-schedule.sh dev-flow-improve/scripts/install-schedule.bats
git commit -m "feat(dev-flow-improve): 起動 skill + 週次 launchd schedule installer"
```

---

### Task 8: AGENTS.md 追記 + 全体検証

**Files:**
- Modify: `AGENTS.md`（`### dev-flow (dynamic workflow)` セクションの直後に新セクション追加 + W7 表に行追加）

**Interfaces:**
- Consumes: Task 1〜7 の成果物（ドキュメント化対象）
- Produces: cross-vendor agent 向けの dev-improve 規約

- [ ] **Step 1: AGENTS.md に dev-improve セクションを追加**

`### dev-flow (dynamic workflow)` セクション末尾（`#### inline 生成区間` の前）に以下を挿入:

```markdown
### dev-improve (self-improvement loop)

dev-flow を telemetry 駆動で継続的に自己改善するループ。orchestration は
`.claude/workflows/dev-improve.js`（dynamic workflow）、起動は `/dev-flow-improve`
skill（週次 launchd: `dev-flow-improve/scripts/install-schedule.sh --install`）。
設計: `claudedocs/2026-07-13-dev-improve-loop-design.md`。

```
/dev-flow-improve → Workflow('dev-improve')
                      Reconcile(仮説突合) → Mine(4ソース並列) → Rank(dedup+cut) → File(issue化)
                    → 起票 issue ごとに Skill('dev-flow') を直列実行 → 人間 merge
```

- **改善ソース 4 系統**: doctor-anomaly（telemetry 分布・anomaly）/ failure-rca（失敗 run 個別掘り）/
  sunset（W7 capability-bound の再評価トリガ検知）/ pr-signal（findings 再発・merge_tier と人間判断の乖離）。
  miner は `.claude/agents/improve-miner.md`（read-only 判断系 leaf）。
- **仮説駆動の効果検証**: 起票 issue の body に hypothesis ブロック
  （metric/current/target/min_runs/status — canonical `_lib/improve-hypothesis.mjs`）を埋め込み、
  次サイクルの Reconcile が `dev-flow-improve/scripts/hypothesis-check.sh`（決定論 oracle）で
  実測突合する。metric は 3 値 closed enum（iterate_unhealthy_rate / micro_share / cap_pinned_count、
  out-of-enum は error）。not_confirmed は revert 候補として候補プールに入る（自動 revert なし）。
- **throughput cap**: `IMPROVE_MAX=2`/サイクル + open self-improve issue >= 2 で backpressure skip
  （canonical `_lib/improve-rank.mjs`）。open 数取得失敗は fail-closed（skip）。他の失敗は fail-open。
- **state は GitHub issue のみ**: label `self-improve`（起票）/ `self-improve-backlog`（落選 backlog、
  単一 issue）。外部 state JSON なし。
- **telemetry**: 完走時に `journal.sh log dev-improve success --telemetry-json '{...}'` を直接呼ぶ
  （candidates_found / issues_filed / hypotheses_* / backlog_added / backpressure_skipped）。
  dev-flow-doctor がループ自体の不調も診断できる。
- **自己改変 floor**: 候補の target_paths が dev-flow 本体（`.claude/workflows/` / `_lib/` /
  `.claude/agents/` / `tools/`）に触れる場合、issue AC に `/dev-flow-canary` 実行を自動追記。
  merge tier は既存ロジックで REVIEW 以上になる（コード変更は micro AUTO の対象外）。
```

W7 の分類表（incentive-structural / blast-radius 行）に以下を追記:

- incentive-structural 行の代表機構に追加: `dev-improve IMPROVE_MAX + backpressure（ループが自分の提案量を自己増幅させない）`
- blast-radius 行の代表機構に追加: `dev-improve 自動 revert 禁止・sunset 昇格の issue→人間 merge 経由・仮説突合の決定論 oracle（hypothesis-check.sh — LLM に効果の self-judge をさせない）`

- [ ] **Step 2: 全体検証を回す**

```bash
node tools/sync-inlines.mjs --check
node --test _lib/ tools/
bash tests/run-all-bats.sh
```

Expected: すべて exit 0 / 全 test PASS（bats 未インストール環境では run-all-bats.sh は graceful skip）

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): dev-improve 自己改善ループの規約と W7 分類を追記"
```

---

## 運用開始手順（実装完了後・人間が 1 回だけ実行）

1. PR #344 のレビューと merge（人間）
2. skills のインストール同期（`~/.claude/skills/` に dev-flow-improve が配置されること）
3. `bash dev-flow-improve/scripts/install-schedule.sh --install`
4. 初回は手動で `/dev-flow-improve` を 1 回実行し、issue 起票 → dev-flow → PR → 仮説ブロックまでの
   全経路を目視確認する
