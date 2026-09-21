#!/usr/bin/env node
// tools/jev-backtest.mjs
//
// pr-iterate の過去 finding（journal の iterate_history、file+line 付き）を正解データとして、
// 「PR diff の hunk を Jev（TypeSafe AI System One）でスコアし低スコア hunk を reviewer から除外する」
// ポリシーが blocking finding をどれだけ取りこぼすかを事後測定する。
//
// 決定論ベースライン（lockfile / 生成区間 / docs の除外）を同じ指標で並べる:
// Jev が無料のヒューリスティクスに勝てなければ導入理由が無い。
//
// 実行形: 絶対パス bare 形で呼ぶ（sandbox excludedCommands は先頭トークン一致。
//         gh と api.typesafe.ai への到達に必要。`node <path>` 前置は登録外）。
//   /abs/path/tools/jev-backtest.mjs [--journal DIR] [--out DIR] [--no-jev] [--limit N]
//                                    [--repo OWNER/NAME] [--concurrency N]
//
// Jev 経路: 既定は Vercel AI Gateway の TypeSafe 互換 endpoint（dotfiles の jev-classify.sh と同じ規約）。
//   JEV_API_URL   既定 https://ai-gateway.vercel.sh/typesafe/v1/systemone
//   JEV_MODEL     既定 typesafe-ai/jev
//   key: $AI_GATEWAY_API_KEY → macOS Keychain `security find-generic-password -s $JEV_KEYCHAIN_SERVICE -w`
//        （既定 service: vercel-ai-gateway）。TYPESAFE_API_KEY があれば直叩き
//        （https://api.typesafe.ai/v1/systemone、model jev-latest）にフォールバック。
//   key が無ければ Jev 部分をスキップし、収集・照合・ベースラインだけ出す。
//
// 既知の限界: diff は `gh pr diff` の最終状態。round 1 の finding は fix 前 tree の行番号なので
// 行ズレが起きる。±TOL 行で hunk に当たらなければ file 一致に落として評価する（file 一致の
// finding は「そのファイルの全 hunk が除外されたら miss」）。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
export const GATEWAY_MODEL = 'typesafe-ai/jev';
export const DIRECT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DIRECT_MODEL = 'jev-latest';
export const KEYCHAIN_SERVICE = 'vercel-ai-gateway';
export const LINE_TOL = 3;
// state 上限 32k tokens。コードは ~3.5 chars/token 程度なので余裕を見て文字数で切る。
export const MAX_STATE_CHARS = 90_000;
export const DEFAULT_REPO = 'it-all-playpark/skills';
export const THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5];

// ---------------------------------------------------------------------------
// unified diff parser
// ---------------------------------------------------------------------------

/**
 * `git diff` / `gh pr diff` の出力を file → hunk に分解する。
 * @returns {Array<{path:string, oldPath:string|null, binary:boolean,
 *   hunks: Array<{index:number, header:string, oldStart:number, oldLines:number,
 *                 newStart:number, newLines:number, text:string, added:number, removed:number}>}>}
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      cur = { path: null, oldPath: null, binary: false, hunks: [] };
      hunk = null;
      files.push(cur);
      // rename / 削除で +++ が無い場合に備え、`diff --git a/x b/y` から仮の path を取る
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m) { cur.oldPath = m[1]; cur.path = m[2]; }
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      cur.oldPath = p === '/dev/null' ? null : p.replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      cur.path = p === '/dev/null' ? cur.path : p.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('Binary files ')) { cur.binary = true; continue; }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hm) {
      hunk = {
        index: cur.hunks.length,
        header: line,
        oldStart: Number(hm[1]), oldLines: hm[2] == null ? 1 : Number(hm[2]),
        newStart: Number(hm[3]), newLines: hm[4] == null ? 1 : Number(hm[4]),
        text: line + '\n', added: 0, removed: 0,
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\ No newline')) continue;
    hunk.text += line + '\n';
    if (line.startsWith('+')) hunk.added++;
    else if (line.startsWith('-')) hunk.removed++;
  }
  return files.filter((f) => f.path != null);
}

export function hunkId(repo, pr, path, index) {
  return `${repo}#${pr}:${path}@${index}`;
}

/** hunk 本文のハッシュ。Jev cache のキー（同 id でも diff が変われば再問い合わせ）。 */
export function hunkDigest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// finding → hunk 照合
// ---------------------------------------------------------------------------

/**
 * finding を diff に当てる。
 * @returns {{level:'hunk'|'file'|'outside', hunkIndex:number|null, path:string|null}}
 */
export function matchFinding(finding, files, tol = LINE_TOL) {
  const path = normalizePath(finding.file);
  if (!path) return { level: 'outside', hunkIndex: null, path: null };
  const file = files.find((f) => f.path === path || f.path.endsWith('/' + path) || path.endsWith('/' + f.path));
  if (!file) return { level: 'outside', hunkIndex: null, path };
  const line = Number(finding.line);
  if (!Number.isFinite(line) || line <= 0) return { level: 'file', hunkIndex: null, path: file.path };
  for (const h of file.hunks) {
    const lo = h.newStart - tol;
    const hi = h.newStart + Math.max(h.newLines, 1) - 1 + tol;
    if (line >= lo && line <= hi) return { level: 'hunk', hunkIndex: h.index, path: file.path };
  }
  return { level: 'file', hunkIndex: null, path: file.path };
}

function normalizePath(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (!s) return null;
  s = s.replace(/^\.\//, '').replace(/:\d+(-\d+)?$/, '');
  return s;
}

// ---------------------------------------------------------------------------
// 決定論ベースライン
// ---------------------------------------------------------------------------

const LOCKFILE_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|skills-lock\.json|flake\.lock|bun\.lockb?)$/;
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst']);
const INLINE_MARKER_RE = /^[+-].*==== (BEGIN|END) inline: /m;
const INLINE_POLICY_RE = /^[+-].*INLINE COPY POLICY/m;

/** hunk の決定論的分類。Jev の kind と同じ語彙を使い、比較しやすくする。 */
export function baselineKind(path, hunk) {
  if (LOCKFILE_RE.test(path)) return 'generated';
  if (INLINE_MARKER_RE.test(hunk.text) || INLINE_POLICY_RE.test(hunk.text)) return 'generated';
  if (/\.snap$/.test(path) || /(^|\/)__snapshots__\//.test(path)) return 'generated';
  if (DOC_EXT.has(extname(path))) return 'docs';
  if (/(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec|bats)\.[a-z]+$/.test(path) || /\.bats$/.test(path)) return 'test';
  return 'logic';
}

export const BASELINE_POLICIES = {
  'baseline:lock+gen': (k) => k === 'generated',
  'baseline:lock+gen+docs': (k) => k === 'generated' || k === 'docs',
};

// ---------------------------------------------------------------------------
// journal 読み込み
// ---------------------------------------------------------------------------

/**
 * pr-iterate journal から (repo, pr, findings[]) を集める。
 * findings は (file, line, topic) で dedupe し、severity は blocking / minor の 2 値に落とす。
 */
export function loadJournal(dir) {
  const out = new Map(); // key repo#pr → { repo, pr, findings: [], runs: [] }
  const names = readdirSync(dir).filter((n) => /pr-iterate.*\.json$/.test(n)).sort();
  for (const name of names) {
    let j;
    try { j = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const hist = j?.telemetry?.iterate_history;
    if (!Array.isArray(hist) || hist.length === 0) continue;
    const pr = j?.context?.pr_number;
    if (pr == null) continue;
    const repo = j?.context?.repo || DEFAULT_REPO;
    const key = `${repo}#${pr}`;
    if (!out.has(key)) out.set(key, { repo, pr: Number(pr), findings: [], runs: [] });
    const entry = out.get(key);
    entry.runs.push(name);
    for (const it of hist) {
      for (const kind of ['blocking', 'minor']) {
        for (const f of it?.[kind] ?? []) {
          if (!f || typeof f !== 'object') continue;
          const fk = `${f.file ?? ''}|${f.line ?? ''}|${f.topic ?? f.description ?? ''}`;
          if (entry.findings.some((x) => x._k === fk)) continue;
          entry.findings.push({
            _k: fk, kind, severity: f.severity ?? kind, file: f.file ?? null, line: f.line ?? null,
            topic: f.topic ?? null, iteration: it.iteration ?? null, description: f.description ?? null,
          });
        }
      }
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// diff 取得（gh、キャッシュ付き）
// ---------------------------------------------------------------------------

export function fetchDiff(repo, pr, cacheDir) {
  const file = join(cacheDir, `${repo.replace('/', '__')}__${pr}.diff`);
  if (existsSync(file)) return { text: readFileSync(file, 'utf8'), cached: true, error: null };
  const r = spawnSync('gh', ['pr', 'diff', String(pr), '-R', repo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { text: null, cached: false, error: (r.stderr || r.error?.message || `exit ${r.status}`).trim() };
  writeFileSync(file, r.stdout);
  return { text: r.stdout, cached: false, error: null };
}

// ---------------------------------------------------------------------------
// Jev
// ---------------------------------------------------------------------------

export const JEV_QUESTIONS = {
  needs_review: {
    type: 'noul',
    instructions: 'Does this diff hunk change program behavior, data, configuration, or documented requirements in a way a code reviewer must read to catch a bug, regression, or requirement mismatch?',
    criteria: {
      true: 'Adds, removes, or alters logic, control flow, data handling, error handling, interfaces, tests that encode requirements, config that affects runtime, or normative documentation that other code or agents must follow.',
      false: 'Pure formatting or whitespace, comment-only wording, generated or lockfile content, mechanical rename with no semantic change, or prose that does not state a rule anyone must follow.',
    },
  },
  kind: {
    type: 'choice',
    instructions: 'Classify the primary nature of this diff hunk.',
    criteria: {
      logic: 'Source code whose runtime behavior changes.',
      test: 'Test code or test fixtures.',
      config: 'Build, CI, dependency, or runtime configuration.',
      docs: 'Documentation or prose (README, guides, comments only).',
      generated: 'Machine-generated content: lockfiles, snapshots, synced/inlined copies.',
      formatting_only: 'Whitespace, indentation, line wrapping, or import ordering with no semantic change.',
      rename_only: 'Identifier or path rename with no behavior change.',
    },
  },
};

export function buildJevState(repo, path, hunk) {
  let text = hunk.text;
  const budget = MAX_STATE_CHARS - 512;
  if (text.length > budget) text = text.slice(0, budget) + '\n[... hunk truncated for length ...]\n';
  return { repository: repo, file: path, hunk_header: hunk.header, added_lines: hunk.added, removed_lines: hunk.removed, diff: text };
}

/**
 * Jev の接続先と key を解決する。優先順は dotfiles の jev-classify.sh と同じ。
 * @param {NodeJS.ProcessEnv} env
 * @param {(service:string)=>string|null} keychain
 * @returns {{url:string, model:string, apiKey:string, source:string}|null}
 */
export function resolveJev(env = process.env, keychain = readKeychain) {
  const url = env.JEV_API_URL || null;
  const model = env.JEV_MODEL || null;
  if (env.AI_GATEWAY_API_KEY) {
    return { url: url ?? GATEWAY_ENDPOINT, model: model ?? GATEWAY_MODEL, apiKey: env.AI_GATEWAY_API_KEY.trim(), source: 'env:AI_GATEWAY_API_KEY' };
  }
  const service = env.JEV_KEYCHAIN_SERVICE || KEYCHAIN_SERVICE;
  const kc = keychain(service);
  if (kc) return { url: url ?? GATEWAY_ENDPOINT, model: model ?? GATEWAY_MODEL, apiKey: kc, source: `keychain:${service}` };
  if (env.TYPESAFE_API_KEY) {
    return { url: url ?? DIRECT_ENDPOINT, model: model ?? DIRECT_MODEL, apiKey: env.TYPESAFE_API_KEY.trim(), source: 'env:TYPESAFE_API_KEY' };
  }
  return null;
}

function readKeychain(service) {
  if (process.platform !== 'darwin') return null;
  const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const v = (r.stdout || '').trim();
  return v || null;
}

export async function jevScore(state, conn, fetchImpl = fetch) {
  const res = await fetchImpl(conn.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conn.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: conn.model, state, questions: JEV_QUESTIONS }),
  });
  if (!res.ok) {
    const err = new Error(`jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const a = j.answers ?? {};
  return {
    model: j.model ?? null,
    needs_review: a.needs_review?.noul ?? null,
    kind: a.kind?.choice ?? null,
    kind_confidence: a.kind?.confidence ?? null,
    kind_probabilities: a.kind?.probabilities ?? null,
    input_tokens: j.usage?.input_tokens ?? null,
  };
}

export const RETRY_MAX = 7;
export const RETRY_BASE_MS = 1000;

/** 429 / 5xx / network エラーを指数バックオフ（1s, 2s, … ≤64s、jitter 付き）で再試行する。 */
export async function jevScoreWithRetry(state, conn, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rand = Math.random) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      return await jevScore(state, conn, fetchImpl);
    } catch (e) {
      lastErr = e;
      const retriable = e.status == null || e.status === 429 || e.status >= 500;
      if (!retriable || attempt === RETRY_MAX) throw e;
      await sleep(RETRY_BASE_MS * 2 ** attempt * (0.5 + rand()));
    }
  }
  throw lastErr;
}

export function loadJevCache(file) {
  const m = new Map();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); m.set(r.key, r); } catch { /* skip */ }
  }
  return m;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// ポリシー評価
// ---------------------------------------------------------------------------

/**
 * @param {Array<{id:string, path:string, repo:string, pr:number, lines:number, baseKind:string, jev:object|null}>} hunks
 * @param {Array<{kind:'blocking'|'minor', match:{level,hunkIndex,path}, hunkId:string|null, repo, pr, file, line, topic}>} findings
 * @param {(h)=>boolean} exclude
 */
export function evaluatePolicy(hunks, findings, exclude) {
  const excluded = new Set();
  let linesTotal = 0; let linesExcluded = 0;
  const byFile = new Map(); // repo#pr:path → { total, excluded }
  for (const h of hunks) {
    linesTotal += h.lines;
    const fk = `${h.repo}#${h.pr}:${h.path}`;
    if (!byFile.has(fk)) byFile.set(fk, { total: 0, excluded: 0 });
    byFile.get(fk).total++;
    if (exclude(h)) { excluded.add(h.id); linesExcluded += h.lines; byFile.get(fk).excluded++; }
  }
  const res = { blocking: { n: 0, hit: 0, missed: [] }, minor: { n: 0, hit: 0, missed: [] } };
  for (const f of findings) {
    if (f.match.level === 'outside') continue;
    const bucket = res[f.kind];
    bucket.n++;
    let miss;
    if (f.match.level === 'hunk') miss = excluded.has(f.hunkId);
    else { const s = byFile.get(`${f.repo}#${f.pr}:${f.match.path}`); miss = s ? s.excluded === s.total : false; }
    if (miss) bucket.missed.push(f); else bucket.hit++;
  }
  return {
    hunks_total: hunks.length, hunks_excluded: excluded.size,
    hunks_excluded_pct: pct(excluded.size, hunks.length),
    lines_total: linesTotal, lines_excluded: linesExcluded, lines_excluded_pct: pct(linesExcluded, linesTotal),
    blocking_n: res.blocking.n, blocking_recall: ratio(res.blocking.hit, res.blocking.n), blocking_missed: res.blocking.missed,
    minor_n: res.minor.n, minor_recall: ratio(res.minor.hit, res.minor.n), minor_missed: res.minor.missed,
  };
}

function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : 0; }
function ratio(a, b) { return b ? Math.round((a / b) * 1000) / 1000 : null; }

export function buildPolicies(hasJev) {
  const p = {};
  for (const [name, fn] of Object.entries(BASELINE_POLICIES)) p[name] = (h) => fn(h.baseKind);
  if (!hasJev) return p;
  for (const t of THRESHOLDS) p[`jev:needs_review<${t}`] = (h) => h.jev != null && h.jev.needs_review != null && h.jev.needs_review < t;
  p['jev:kind∈{generated,formatting_only,rename_only}∧conf≥0.9'] = (h) => h.jev != null
    && ['generated', 'formatting_only', 'rename_only'].includes(h.jev.kind) && (h.jev.kind_confidence ?? 0) >= 0.9;
  p['jev:needs_review<0.2 ∨ baseline:lock+gen'] = (h) => (h.jev != null && h.jev.needs_review != null && h.jev.needs_review < 0.2) || h.baseKind === 'generated';
  return p;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export function renderReport(summary) {
  const L = [];
  L.push(`# Jev diff-triage backtest — ${summary.date}`);
  L.push('');
  L.push(`- PRs: ${summary.prs_total}（diff 取得成功 ${summary.prs_with_diff} / 失敗 ${summary.prs_failed.length}）`);
  L.push(`- hunks: ${summary.hunks_total}（${summary.lines_total} 変更行）`);
  L.push(`- findings: blocking ${summary.findings.blocking.total}（hunk 一致 ${summary.findings.blocking.hunk} / file 一致 ${summary.findings.blocking.file} / diff 外 ${summary.findings.blocking.outside}）、minor ${summary.findings.minor.total}（${summary.findings.minor.hunk} / ${summary.findings.minor.file} / ${summary.findings.minor.outside}）`);
  L.push(`- Jev: ${summary.jev.enabled ? `${summary.jev.model} via ${summary.jev.endpoint} — scored ${summary.jev.scored} hunks（cache hit ${summary.jev.cache_hits}、error ${summary.jev.errors}、input ${summary.jev.input_tokens} tokens ≈ $${summary.jev.cost_usd}）` : `skipped（API key 無し）— 全 hunk を流した場合の推定 input ≈ ${summary.jev.est_input_tokens} tokens ≈ $${summary.jev.est_cost_usd}`}`);
  L.push('');
  L.push('## ポリシー別（除外した hunk が reviewer から隠れると仮定）');
  L.push('');
  L.push('| policy | hunks 除外 | 行除外 | blocking recall | minor recall |');
  L.push('|---|---:|---:|---:|---:|');
  for (const [name, r] of Object.entries(summary.policies)) {
    L.push(`| ${name} | ${r.hunks_excluded}/${r.hunks_total} (${r.hunks_excluded_pct}%) | ${r.lines_excluded_pct}% | ${fmt(r.blocking_recall)} (${r.blocking_n - r.blocking_missed.length}/${r.blocking_n}) | ${fmt(r.minor_recall)} (${r.minor_n - r.minor_missed.length}/${r.minor_n}) |`);
  }
  L.push('');
  L.push('## 取りこぼした blocking finding');
  L.push('');
  for (const [name, r] of Object.entries(summary.policies)) {
    if (!r.blocking_missed.length) continue;
    L.push(`### ${name}`);
    for (const f of r.blocking_missed) L.push(`- ${f.repo}#${f.pr} ${f.file}:${f.line} [${f.match.level}] ${f.topic ?? ''}`);
    L.push('');
  }
  if (summary.jev.enabled) {
    L.push('## Jev kind 分布 vs 決定論分類');
    L.push('');
    L.push('| baseline kind | ' + summary.kind_matrix.cols.join(' | ') + ' |');
    L.push('|---|' + summary.kind_matrix.cols.map(() => '---:').join('|') + '|');
    for (const row of summary.kind_matrix.rows) L.push(`| ${row.kind} | ${row.counts.join(' | ')} |`);
    L.push('');
  }
  if (summary.prs_failed.length) {
    L.push('## diff 取得失敗');
    L.push('');
    for (const p of summary.prs_failed) L.push(`- ${p.repo}#${p.pr}: ${p.error}`);
    L.push('');
  }
  L.push('## 限界');
  L.push('');
  L.push(`- diff は PR の最終状態。fix 前の行番号は ±${LINE_TOL} 行で hunk に当て、外れたら file 一致に落としている（file 一致は「ファイルの全 hunk 除外」でのみ miss 扱い = 楽観側）。`);
  L.push('- blocking の母数が小さいので recall 1 件差 ≈ ' + (summary.findings.blocking.total ? (100 / summary.findings.blocking.total).toFixed(1) : '?') + ' pt。閾値は minor recall と行除外率の傾きも併せて読む。');
  return L.join('\n') + '\n';
}

function fmt(x) { return x == null ? '-' : x.toFixed(3); }

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { journal: join(homedir(), '.claude', 'journal'), out: null, jev: true, limit: Infinity, repo: null, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--journal') a.journal = v();
    else if (k === '--out') a.out = v();
    else if (k === '--no-jev') a.jev = false;
    else if (k === '--limit') a.limit = Number(v());
    else if (k === '--repo') a.repo = v();
    else if (k === '--concurrency') a.concurrency = Number(v());
    else if (k === '-h' || k === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
    else throw new Error(`unknown arg: ${k}`);
  }
  const date = new Date().toISOString().slice(0, 10);
  if (!a.out) a.out = join(homedir(), '.claude', 'journal', 'ab-runs', `jev-backtest-${date}`);
  a.date = date;
  return a;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const diffDir = join(args.out, 'diffs');
  mkdirSync(diffDir, { recursive: true });

  let prs = loadJournal(args.journal);
  if (args.repo) prs = prs.filter((p) => p.repo === args.repo);
  prs = prs.slice(0, args.limit);
  console.error(`journal: ${prs.length} PRs with findings`);

  const hunks = [];
  const findings = [];
  const failed = [];
  for (const p of prs) {
    const d = fetchDiff(p.repo, p.pr, diffDir);
    if (d.error) { failed.push({ repo: p.repo, pr: p.pr, error: d.error.split('\n')[0] }); continue; }
    const files = parseUnifiedDiff(d.text);
    for (const f of files) {
      for (const h of f.hunks) {
        hunks.push({ id: hunkId(p.repo, p.pr, f.path, h.index), repo: p.repo, pr: p.pr, path: f.path, hunk: h,
          lines: h.added + h.removed, baseKind: baselineKind(f.path, h), jev: null });
      }
    }
    for (const f of p.findings) {
      const match = matchFinding(f, files);
      findings.push({ ...f, repo: p.repo, pr: p.pr, match, hunkId: match.level === 'hunk' ? hunkId(p.repo, p.pr, match.path, match.hunkIndex) : null });
    }
  }
  console.error(`diffs: ${prs.length - failed.length} ok, ${failed.length} failed; ${hunks.length} hunks; ${findings.length} findings`);

  const estTokens = Math.round(hunks.reduce((s, h) => s + Math.min(h.hunk.text.length, MAX_STATE_CHARS) / 3.5 + 250, 0));
  const jevInfo = { enabled: false, scored: 0, cache_hits: 0, errors: 0, input_tokens: 0, cost_usd: 0,
    est_input_tokens: estTokens, est_cost_usd: (estTokens * 0.042 / 1e6).toFixed(4) };

  const conn = args.jev ? resolveJev() : null;
  if (args.jev && !conn) console.error('Jev の key が無い（AI_GATEWAY_API_KEY / Keychain vercel-ai-gateway / TYPESAFE_API_KEY）ので scoring をスキップ');
  if (conn) {
    jevInfo.enabled = true;
    jevInfo.endpoint = conn.url;
    jevInfo.model = conn.model;
    jevInfo.key_source = conn.source;
    console.error(`jev: ${conn.model} via ${conn.url} (key: ${conn.source})`);
    const cacheFile = join(args.out, 'jev-cache.jsonl');
    const cache = loadJevCache(cacheFile);
    let done = 0;
    await mapLimit(hunks, args.concurrency, async (h) => {
      const key = `${h.id}#${hunkDigest(h.hunk.text)}`;
      const hit = cache.get(key);
      if (hit && hit.answer) { h.jev = hit.answer; jevInfo.cache_hits++; return; }
      try {
        const answer = await jevScoreWithRetry(buildJevState(h.repo, h.path, h.hunk), conn);
        h.jev = answer;
        jevInfo.scored++;
        jevInfo.input_tokens += answer.input_tokens ?? 0;
        appendFileSync(cacheFile, JSON.stringify({ key, id: h.id, path: h.path, baseKind: h.baseKind, answer }) + '\n');
      } catch (e) {
        jevInfo.errors++;
        if (jevInfo.errors <= 5) console.error(`jev error ${h.id}: ${e.message.slice(0, 160)}`);
        else if (jevInfo.errors === 6) console.error('jev error: 以降は省略（件数は report に出る）');
      }
      if (++done % 50 === 0) console.error(`jev: ${done}/${hunks.length}`);
    });
    jevInfo.cost_usd = (jevInfo.input_tokens * 0.042 / 1e6).toFixed(4);
  }

  const policies = {};
  for (const [name, ex] of Object.entries(buildPolicies(jevInfo.enabled))) policies[name] = evaluatePolicy(hunks, findings, ex);

  const count = (kind) => {
    const fs = findings.filter((f) => f.kind === kind);
    return { total: fs.length, hunk: fs.filter((f) => f.match.level === 'hunk').length, file: fs.filter((f) => f.match.level === 'file').length, outside: fs.filter((f) => f.match.level === 'outside').length };
  };
  const kindCols = Object.keys(JEV_QUESTIONS.kind.criteria);
  const kindRows = ['logic', 'test', 'docs', 'generated'].map((k) => ({ kind: k, counts: kindCols.map((c) => hunks.filter((h) => h.baseKind === k && h.jev?.kind === c).length) }));

  const summary = {
    date: args.date, journal: args.journal, out: args.out,
    prs_total: prs.length, prs_with_diff: prs.length - failed.length, prs_failed: failed,
    hunks_total: hunks.length, lines_total: hunks.reduce((s, h) => s + h.lines, 0),
    findings: { blocking: count('blocking'), minor: count('minor') },
    jev: jevInfo, policies, kind_matrix: { cols: kindCols, rows: kindRows },
  };
  writeFileSync(join(args.out, 'report.json'), JSON.stringify(summary, null, 2));
  const md = renderReport(summary);
  writeFileSync(join(args.out, 'report.md'), md);
  writeFileSync(join(args.out, 'hunks.jsonl'), hunks.map((h) => JSON.stringify({ id: h.id, path: h.path, lines: h.lines, baseKind: h.baseKind, jev: h.jev })).join('\n') + '\n');
  writeFileSync(join(args.out, 'findings.jsonl'), findings.map((f) => JSON.stringify(f)).join('\n') + '\n');
  process.stdout.write(md);
  console.error(`written: ${args.out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
