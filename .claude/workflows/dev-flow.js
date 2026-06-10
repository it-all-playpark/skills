export const meta = {
  name: 'dev-flow',
  description: 'Issue から LGTM まで: 分析→計画(レビュー上限20)→実装(並列/直列)→test green→評価(差し戻し上限10)→PR→pr-iterate。merge は手動',
  phases: [
    { title: 'Setup' },
    { title: 'Analyze' },
    { title: 'Plan' },
    { title: 'Implement' },
    { title: 'Validate' },
    { title: 'Evaluate' },
    { title: 'PR' },
    // 注: 最終の PR レビュー&fix ループは workflow('pr-iterate') がサブ workflow として
    //     自前の 'Iterate' phase を持つ。親 meta には現れない。
  ],
}

// ---- 品質ゲート系 agent（dev-planner / plan-reviewer / evaluator）の model override ----
// frontmatter 既定は opus。Fable 5 試験運用中は 'fable' を指定し、戻すときはこの 1 行を 'opus' にする。
// effort は agent() opts に存在しないため引き続き frontmatter（high）固定。pr-reviewer は pr-iterate.js 側の同名定数。
const QUALITY_MODEL = 'fable'

function resolvePositiveIntArg(args, name) {
  const raw = (typeof args === 'string' || typeof args === 'number')
    ? args
    : (args?.[name] ?? args?.[0]);
  const s = String(raw ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error(`${name}: 正の整数が必要です（受信: ${JSON.stringify(s)}）`);
  }
  return s;
}

// ---- Goal Ledger エンジン (canonical: _lib/goal-ledger.mjs。修正時は両者を同期。byte 一致は _lib/goal-ledger.sync.test.mjs が保証) ----
const SEVERITY_RANK = { minor: 0, major: 1, critical: 2 };
const SHAPE_RANK = { micro: 0, standard: 1, complex: 2 };

function makeLedger() {
  return { items: [], round: 0 };
}

function laneOf(item) {
  if (item.severity === 'critical') return 'blocking';
  if (item.check && item.check.kind === 'deterministic') return 'blocking';
  if (item.source === 'seed') return 'blocking';
  return 'advisory';
}

function topicKey(item) {
  const norm = String(item.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${item.dimension ?? '?'}::${norm}`;
}

function canAppend(ledger, item) {
  if (ledger.round === 0) return true;
  if (item.severity === 'critical') return true;
  const key = topicKey(item);
  return ledger.items.some((it) => topicKey(it) === key);
}

function appendItem(ledger, item) {
  if (!canAppend(ledger, item)) return { ledger, accepted: false };
  const key = topicKey(item);
  const idx = ledger.round > 0 ? ledger.items.findIndex((it) => topicKey(it) === key) : -1;
  const items = ledger.items.slice();
  if (idx >= 0) items[idx] = { ...items[idx], ...item, id: items[idx].id };
  else items.push({ checked: false, evidence: null, floor: false, check: null, ...item, check: item.check ? { ...item.check } : null });
  return { ledger: { ...ledger, items }, accepted: true };
}

function applySeverityFloor(item, floorSeverity) {
  const raised = SEVERITY_RANK[floorSeverity] > SEVERITY_RANK[item.severity] ? floorSeverity : item.severity;
  return { ...item, severity: raised, floor: true };
}

function mergeSeverity(item, llmSeverity) {
  if (item.floor && SEVERITY_RANK[llmSeverity] < SEVERITY_RANK[item.severity]) return item;
  const raised = SEVERITY_RANK[llmSeverity] > SEVERITY_RANK[item.severity] ? llmSeverity : item.severity;
  return { ...item, severity: raised };
}

function checkItem(ledger, id, evidence) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], checked: true, evidence: evidence ?? null };
  return { ...ledger, items };
}

function reopenItem(ledger, id, reason) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  if (!reason) throw new Error('goal-ledger: reopen には reason が必要');
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], checked: false, reopen_reason: reason };
  return { ...ledger, items };
}

function setCheck(ledger, id, check) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], check };
  return { ...ledger, items };
}

function blockingItems(ledger) {
  return ledger.items.filter((it) => laneOf(it) === 'blocking');
}

function advisoryItems(ledger) {
  return ledger.items.filter((it) => laneOf(it) === 'advisory');
}

function isConverged(ledger) {
  return blockingItems(ledger).every((it) => it.checked);
}

function nextRound(ledger) {
  return { ...ledger, round: ledger.round + 1 };
}
// ---- /Goal Ledger エンジン ----

// ---- merge-tier エンジン (canonical: _lib/merge-tier.mjs。修正時は両者を同期。byte 一致は _lib/merge-tier.sync.test.mjs が保証) ----
// diff-risk-classify.sh が出力する 7 danger クラス（固定順）。
const DANGER_CLASSES = [
  'auth', 'crypto', 'config', 'data-migration', 'public-api', 'exec-sink', 'dependency',
];

const SEC_TEXT = {
  'auth': '認証/認可ファイルの変更が安全か（権限昇格・認可バイパスなし）',
  'crypto': '暗号処理の変更が安全か（弱いアルゴリズム・鍵漏洩なし）',
  'config': 'config/secret の変更が安全か（秘密情報の平文混入なし）',
  'data-migration': 'data migration が安全か（不可逆・データ欠損なし）',
  'public-api': 'public API 変更が後方互換か（破壊的変更の明示）',
  'exec-sink': 'exec/deserialization sink が安全か（任意コード実行なし）',
  'dependency': '依存追加が安全か（既知脆弱性・supply chain リスクなし）',
};

// 7 danger クラスを常時 blocking seed する。danger-grep clean なら reconcileDanger が
// 自動 check し、hit したクラスは critical へ raise して block 据え置きにする。
function seedSecurityLedger() {
  return DANGER_CLASSES.map((cls) => ({
    id: `SEC-${cls.toUpperCase()}`,
    text: SEC_TEXT[cls],
    dimension: 'security',
    severity: 'major',
    source: 'seed',
    check: { kind: 'deterministic' },
    danger_class: cls,
  }));
}

const SEC_SEVERITY_RANK = { minor: 0, major: 1, critical: 2 };

// danger-grep の hit クラス集合で SEC seed item を解決する。
// clean クラス → checked(evidence='danger-grep clean')。
// hit クラス → critical へ raise(floor=true)。
//   - floor=true かつ checked=true(evaluator が evidence で clearance 済み) → checked を維持する(HOLD に巻き戻さない)。
//   - floor=false かつ checked=true(前回 "danger-grep clean" 自動解決済み) → 今回 hit に転じたので unchecked 復活。
//   - checked=false → checked=false 据え置き(evaluator が次ラウンドで解消するまで block)。
// SEC 以外の item は touch しない。
//
// 再 reconcile ポリシー(pr-iterate 後の Merge tier phase での呼び出しを含む):
//   danger が増えた(新クラスが hit に転じた)場合 → floor=false なので unchecked 復活 = HOLD。
//   danger が減った(以前 hit だったクラスが clean に転じた)場合 → checked=true に解放(自動解消)。
//   danger が同じ hit クラスで残る かつ evaluator clearance 済み(floor=true, checked=true) → checked 維持(温存)。
function reconcileDanger(ledger, hitClasses) {
  const hits = new Set(hitClasses);
  const items = ledger.items.map((it) => {
    if (it.source !== 'seed' || it.dimension !== 'security') return it;
    if (hits.has(it.danger_class)) {
      // floor=true かつ checked=true → evaluator が danger floor を evidence 付きで clearance 済み。
      // 同クラスが依然 hit でも checked を維持して HOLD に巻き戻さない。
      // floor=false かつ checked=true → 前回 reconcile で "danger-grep clean" 自動解決されたが
      // 今回 hit に転じた(pr-iterate で増えた) → 再度 unchecked にして block を復活させる。
      if (it.checked && it.floor) return it;
      const severity = SEC_SEVERITY_RANK['critical'] > SEC_SEVERITY_RANK[it.severity] ? 'critical' : it.severity;
      return { ...it, severity, floor: true, checked: false };
    }
    return { ...it, checked: true, evidence: 'danger-grep clean' };
  });
  return { ...ledger, items };
}

// 変更ファイルが docs(.md/.mdx/.txt, docs/) か test(*test*, *spec*, .bats) のみか。
function isDocsOrTestOnly(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((f) =>
    /\.(md|mdx|txt)$/i.test(f) || /(^|\/)docs\//i.test(f)
    || /(^|\/|\.)(test|spec)([./]|$)/i.test(f) || /\.bats$/i.test(f));
}

// merge tier を算出する。merge は全 tier 人間(AUTO も推奨ラベルのみ。真 auto-merge は W6)。
// HOLD: 未収束 / 未解消 danger / breaking / ESCALATE 項目あり（人間 required-block）。
// AUTO: micro かつ docs/test-only かつ danger clean かつ収束（推奨ラベル）。
// REVIEW: それ以外（標準。人間が LGTM して merge）。
function classifyMergeTier(s) {
  const reasons = [];
  if (!s.converged) reasons.push('ledger 未収束（未 checked blocking 残）');
  if (s.unresolvedDanger) reasons.push('danger-grep hit 未解消（security 要確認）');
  if (s.breaking) reasons.push('breaking/migration 検出');
  if (s.escalateCount > 0) reasons.push(`ESCALATE-TO-HUMAN 項目 ${s.escalateCount} 件`);
  if (s.unsatisfiedAc) reasons.push('AC 未達（acceptance_criteria が satisfied:false — gate_policy に依らず人間確認必須）');
  if (reasons.length) return { tier: 'HOLD', reasons };
  if (s.shape === 'micro' && s.docsOrTestOnly) {
    return { tier: 'AUTO', reasons: ['micro + docs/test-only + danger clean + 収束済 — 推奨ラベル（merge は人間）'] };
  }
  return { tier: 'REVIEW', reasons: ['標準 — 人間が LGTM して merge'] };
}
// ---- /merge-tier エンジン ----

// ---- gate-policy エンジン (canonical: _lib/gate-policy.mjs。修正時は両者を同期。byte 一致は _lib/gate-policy.sync.test.mjs が保証) ----
// gate_policy の trust 昇順 4 値。
const GATE_POLICIES = [
  'deterministic-only',
  'llm-major-advisory',
  'llm-major-blocking',
  'llm-autonomous',
];

// デフォルト gate_policy。
const DEFAULT_GATE_POLICY = 'llm-major-advisory';

// gate_policy 値を解決する。null/undefined/空文字は DEFAULT_GATE_POLICY を返す。
// 有効値はそのまま返す。未知の値は Error を throw する。
function resolveGatePolicy(value) {
  if (value == null || value === '') return DEFAULT_GATE_POLICY;
  if (GATE_POLICIES.includes(value)) return value;
  throw new Error(
    `gate-policy: 未知の gate_policy "${value}"（許可: ${GATE_POLICIES.join(', ')}）`,
  );
}

// item を 'blocking' | 'advisory' に分類する純粋関数。
//
// 軸A invariant（policy によらず常に blocking）:
//   - item.severity === 'critical'
//   - item.check && item.check.kind === 'deterministic'
//   - item.source === 'seed'
//
// LLM major（critical でなく deterministic でなく seed でない major）の写像:
//   deterministic-only  → advisory
//   llm-major-advisory  → advisory
//   llm-major-blocking  → blocking
//   llm-autonomous      → advisory
//
// LLM minor は全 policy で advisory。
function gateLane(item, policy) {
  // 軸A invariant: 決定論 oracle / critical / seed は policy に依らず blocking
  if (item.severity === 'critical') return 'blocking';
  if (item.check && item.check.kind === 'deterministic') return 'blocking';
  if (item.source === 'seed') return 'blocking';
  // LLM major の写像
  if (item.severity === 'major') {
    return policy === 'llm-major-blocking' ? 'blocking' : 'advisory';
  }
  // LLM minor（および未知 severity）は advisory
  return 'advisory';
}

// ledger.items のうち blocking に分類される item を返す純粋関数。
function policyBlockingItems(ledger, policy) {
  return ledger.items.filter((it) => gateLane(it, policy) === 'blocking');
}

// ledger.items のうち advisory に分類される item を返す純粋関数。
function policyAdvisoryItems(ledger, policy) {
  return ledger.items.filter((it) => gateLane(it, policy) === 'advisory');
}

// 全 blocking item が checked かどうかを判定する純粋関数（空は true）。
function isConvergedUnderPolicy(ledger, policy) {
  return policyBlockingItems(ledger, policy).every((it) => it.checked);
}
// ---- /gate-policy エンジン ----

function mergeShape(floor, llmShape) {
  if (!(llmShape in SHAPE_RANK)) {
    return floor;
  }
  return SHAPE_RANK[llmShape] > SHAPE_RANK[floor] ? llmShape : floor;
}

function classifyShape(req) {
  const count = req.estimated_change_file_count;
  if (typeof count !== 'number' || count < 0) {
    const floor = 'complex';
    const reason = `estimated_change_file_count missing or invalid → safe floor=complex`;
    const shape = mergeShape(floor, req.shape);
    return { shape, reason: shape !== floor ? `LLM raised ${floor}→${shape}` : reason };
  }

  const ac = req.acceptance_criteria;
  if (!Array.isArray(ac)) {
    const floor = 'complex';
    const reason = `acceptance_criteria missing or not array → safe floor=complex`;
    const shape = mergeShape(floor, req.shape);
    return { shape, reason: shape !== floor ? `LLM raised ${floor}→${shape}` : reason };
  }

  const validTypes = ['feat', 'fix', 'docs', 'refactor'];
  if (!validTypes.includes(req.issue_type)) {
    const floor = 'complex';
    const reason = `issue_type '${req.issue_type}' not in allowed set → floor=complex`;
    const shape = mergeShape(floor, req.shape);
    return { shape, reason: shape !== floor ? `LLM raised ${floor}→${shape}` : reason };
  }

  const breakingPattern = /breaking|incompatible|migration|破壊的|非互換/i;
  const combined = `${req.scope ?? ''} ${req.summary ?? ''}`;
  if (breakingPattern.test(combined)) {
    const floor = 'complex';
    const reason = `breaking change detected in scope/summary → floor=complex`;
    const shape = mergeShape(floor, req.shape);
    return { shape, reason: shape !== floor ? `LLM raised ${floor}→${shape}` : reason };
  }

  let floor;
  if (count <= 2 && ac.length <= 3) {
    floor = 'micro';
  } else if (count <= 5 && ac.length <= 6) {
    floor = 'standard';
  } else {
    floor = 'complex';
  }

  const shape = mergeShape(floor, req.shape);
  let reason;
  if (shape !== floor) {
    reason = `LLM raised ${floor}→${shape}`;
  } else {
    reason = `estimated ${count} file(s), ${ac.length} AC, type=${req.issue_type} → floor=${floor}`;
  }
  return { shape, reason };
}
function refloorShape(estimatedShape, realizedCount) {
  let realizedFloor;
  if (typeof realizedCount !== 'number' || realizedCount < 0 || !Number.isFinite(realizedCount)) {
    realizedFloor = 'complex';
  } else if (realizedCount <= 2) {
    realizedFloor = 'micro';
  } else if (realizedCount <= 5) {
    realizedFloor = 'standard';
  } else {
    realizedFloor = 'complex';
  }

  const effective = SHAPE_RANK[realizedFloor] > SHAPE_RANK[estimatedShape] ? realizedFloor : estimatedShape;
  return {
    shape: effective,
    refloored: effective !== estimatedShape,
    realizedFloor,
    realizedCount,
  };
}
// ---- parallel-disjoint エンジン (canonical: _lib/parallel-disjoint.mjs。修正時は両者を同期。byte 一致は _lib/parallel-disjoint.sync.test.mjs が保証) ----
/**
 * normalizePath: file_changes エントリを正規化したパス文字列に変換する。
 * - ':' で分割した先頭要素を取る（'src/foo.ts: 新規作成' → 'src/foo.ts'）
 * - trim して先頭の './' を1回除去する（'./src/foo.ts' → 'src/foo.ts'、'  src/bar.ts  ' → 'src/bar.ts'）
 *
 * @param {string} s - file_changes の1エントリ
 * @returns {string} 正規化されたパス文字列
 */
function normalizePath(s) {
  const base = s.split(':')[0].trim();
  return base.startsWith('./') ? base.slice(2) : base;
}

/**
 * enforceDisjointParallel: parallel task 群の file_changes が互いに disjoint であることを保証する。
 * 衝突する task を serial 末尾に降格（demote）して返す。
 *
 * @param {Object} plan - { summary, serial: Task[], parallel: Task[] }
 *   Task = { id, desc?, file_changes?: string[], test_plan?, depends_on? }
 * @returns {{ plan: Object, demoted: Array<{id, conflictsWith, paths}> }}
 *   plan: 元 plan を mutate せず浅いコピーしたもの（parallel = accepted のみ、serial = 元 serial + demoted）
 *   demoted: 降格した task の { id, conflictsWith: 先に accept された衝突相手の id, paths: 交差パス配列 } の配列
 */
function enforceDisjointParallel(plan) {
  const parallelTasks = plan.parallel;

  // parallel が無い/空の場合はコピーして即返す
  if (!parallelTasks || parallelTasks.length === 0) {
    return {
      plan: { ...plan, parallel: parallelTasks ? [] : plan.parallel },
      demoted: [],
    };
  }

  // accepted task 群の正規化パス和集合（パス → 最初に accept した task id のマップ）
  const acceptedPaths = new Map(); // normalizedPath → task id
  const accepted = [];
  const demotedTasks = [];
  const demoted = [];

  for (const task of parallelTasks) {
    const taskPaths = new Set(
      (task.file_changes ?? []).map(normalizePath)
    );

    // 先行 accepted task 群との交差を検出
    const intersectingPaths = [];
    let firstConflictId = null;

    for (const p of taskPaths) {
      if (acceptedPaths.has(p)) {
        intersectingPaths.push(p);
        if (firstConflictId === null) {
          firstConflictId = acceptedPaths.get(p);
        }
      }
    }

    if (intersectingPaths.length > 0) {
      // 衝突あり → demote
      demotedTasks.push(task);
      demoted.push({
        id: task.id,
        conflictsWith: firstConflictId,
        paths: intersectingPaths,
      });
    } else {
      // 衝突なし → accept し、パスを登録
      accepted.push(task);
      for (const p of taskPaths) {
        acceptedPaths.set(p, task.id);
      }
    }
  }

  const newPlan = {
    ...plan,
    parallel: accepted,
    serial: [...(plan.serial ?? []), ...demotedTasks],
  };

  return { plan: newPlan, demoted };
}

/**
 * diffDeclaredPaths: plan の全 task の file_changes と git status の変更ファイルを突合し、
 * 宣言外の変更ファイルパスの配列を返す純粋関数。
 *
 * normalizePath を共用して表記ゆれを正規化する。
 * @param {Array<{id: string, file_changes?: string[]}>} planTasks - serial + parallel の全 task 配列
 * @param {string[]} changedFiles - git status --porcelain の変更ファイル一覧
 * @returns {string[]} 宣言外変更ファイルパスの配列
 */
function diffDeclaredPaths(planTasks, changedFiles) {
  // plan の全 task の file_changes を正規化した宣言パス集合を構築
  const declaredSet = new Set();
  for (const task of planTasks) {
    for (const fc of (task.file_changes ?? [])) {
      declaredSet.add(normalizePath(fc));
    }
  }

  // changedFiles のうち宣言集合に含まれないものを宣言外として抽出
  const undeclared = [];
  for (const f of changedFiles) {
    const normalized = normalizePath(f);
    if (!declaredSet.has(normalized)) {
      undeclared.push(f);
    }
  }
  return undeclared;
}
// ---- /parallel-disjoint エンジン ----

// ---- devflow-summary-format inline コピー (canonical: _lib/devflow-summary-format.mjs。修正時は両者を同期。byte 一致は _lib/devflow-summary-format.sync.test.mjs が保証) ----
// bodySaveInstr: PR body 保存 + 投稿の共通指示文を組み立てるヘルパー（pr-iterate.js と同型）。
function bodySaveInstr(body) {
  return `## 本文の保存\n`
    + `まず Bash で \`mktemp /tmp/dev-flow-XXXXXX.md\` を実行して一時ファイルを作成し、\n`
    + `そのパスを <BODY_FILE> とする。次に **Write tool** を使い、下記 delimiter 内の本文を\n`
    + `**一字一句そのまま** <BODY_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。backtick やコードフェンスを\n`
    + `エスケープ・改変しないこと。以降のコマンドの \`--body-file\` には <BODY_FILE> を指定する。\n`
    + `<<<DEV_FLOW_BODY_BEGIN>>>\n${body}\n<<<DEV_FLOW_BODY_END>>>\n\n`
}

// POST_RESULT schema（dev-runner 経由の PR 投稿結果）
const POST_RESULT = {
  type: 'object',
  required: ['posted'],
  properties: {
    posted: { type: 'boolean' },
    method: { type: 'string' },
    url: { type: 'string' },
  },
}

function buildDevflowSummaryBody({
  pr,
  mergeTier,
  mergeTierReasons,
  gatePolicy,
  blockingItems,
  advisoryItems,
  ledgerConverged,
  acResults,
  securityClearance,
  planConcerns,
  dangerHits,
  shape,
  testGreen,
  evalVerdict,
}) {
  const lines = [];

  // 1. 見出し
  lines.push(`## dev-flow 終端サマリー — PR #${pr}`);
  lines.push('');

  // 2. Merge tier セクション
  lines.push(`### Merge tier: ${mergeTier}`);
  if (!mergeTierReasons || mergeTierReasons.length === 0) {
    lines.push('- 理由記載なし');
  } else {
    for (const reason of mergeTierReasons) {
      lines.push(`- ${reason}`);
    }
  }
  lines.push('');

  // 3. 実行結果サマリー（shape / test_green / eval_verdict）
  lines.push('### 実行結果');
  lines.push(`- shape: ${shape != null ? shape : '不明'}`);
  lines.push(`- test_green: ${testGreen != null ? String(testGreen) : '不明'}`);
  lines.push(`- eval_verdict: ${evalVerdict != null ? evalVerdict : '不明'}`);
  lines.push('');

  // 4. Goal Ledger セクション
  lines.push('### Goal Ledger');
  lines.push(`- gate_policy: ${gatePolicy}`);
  lines.push(`- 収束: ${ledgerConverged ? '済' : '未収束'}`);

  // blocking items
  if (!blockingItems || blockingItems.length === 0) {
    lines.push('- blocking item なし');
  } else {
    for (const item of blockingItems) {
      const status = item.checked ? 'checked' : '未解消';
      const dimension = item.dimension ? ` [${item.dimension}]` : '';
      const evidence = item.evidence ? ': ' + item.evidence : '';
      lines.push(`- [${status}] ${item.id}${dimension} ${item.text}${evidence}`);
    }
  }

  // advisory items
  if (!advisoryItems || advisoryItems.length === 0) {
    lines.push('- advisory item なし');
  } else {
    for (const item of advisoryItems) {
      const status = item.checked ? 'checked' : '未解消';
      const escalateSuffix = item.escalate ? ' (ESCALATE)' : '';
      const dimension = item.dimension ? ` [${item.dimension}]` : '';
      const evidence = item.evidence ? ': ' + item.evidence : '';
      lines.push(`- [${status}] ${item.id}${dimension} ${item.text}${evidence}${escalateSuffix}`);
    }
  }
  lines.push('');

  // 5. AC evidence セクション
  lines.push('### Acceptance Criteria');
  if (!acResults || acResults.length === 0) {
    lines.push('AC 判定なし（evaluator 未実行 or AC 欠落）');
  } else {
    for (const ac of acResults) {
      const satisfiedLabel = ac.satisfied ? 'satisfied' : '未達';
      const verifiedBy = ac.verified_by != null ? ac.verified_by : 'inspection';
      const evidenceSuffix = ac.evidence ? ': ' + ac.evidence : '';
      lines.push(`- AC#${ac.ac_index + 1}: ${satisfiedLabel}（${verifiedBy}）${evidenceSuffix}`);
    }
  }
  lines.push('');

  // 6. Security clearance セクション
  lines.push('### Security clearance');
  if (!securityClearance || securityClearance.length === 0) {
    lines.push('- danger-grep clean（clearance 不要）');
  } else {
    for (const sc of securityClearance) {
      const clearedLabel = sc.cleared ? 'cleared' : '未確認';
      const evidenceSuffix = sc.evidence ? ': ' + sc.evidence : '';
      lines.push(`- ${sc.danger_class}: ${clearedLabel}${evidenceSuffix}`);
    }
  }
  if (dangerHits && dangerHits.length > 0) {
    lines.push(`- 検出クラス: ${dangerHits.join(', ')}`);
  }
  lines.push('');

  // 7. Plan concerns セクション（空なら省略）
  if (planConcerns && planConcerns.length > 0) {
    lines.push('### Plan 未解消 concerns');
    for (const concern of planConcerns) {
      lines.push(`- ${concern}`);
    }
    lines.push('');
  }

  // 8. 末尾
  lines.push('---');
  lines.push('*このコメントは dev-flow により自動生成されました。*');
  lines.push(`<!-- dev-flow:${mergeTier} -->`);

  return lines.join('\n');
}
// ---- /devflow-summary-format inline コピー ----

function applyDisjoint(p, label) {
  const { plan: np, demoted } = enforceDisjointParallel(p);
  if (demoted.length) log(`⚠️ ${label}: file_changes 衝突 ${demoted.length} task を parallel→serial 降格: ${demoted.map((d) => `${d.id}(vs ${d.conflictsWith})`).join(', ')}`);
  return np;
}

// ---- args ----
const ISSUE = resolvePositiveIntArg(args, 'issue')
const BASE = args?.base ?? 'dev'
const TESTING = args?.testing ?? 'tdd'
const DEPTH = args?.depth ?? 'standard'
const GATE_POLICY = resolveGatePolicy(args?.gate_policy)
const PLAN_MAX = 8         // 計画レビュー上限（収束モデルにより happy path は数回で抜ける。issue #123）
const PLAN_STUCK = 2       // 同一 topic がこの回数出たら stuck と判定（moving target 打ち切り。issue #123）
const PLAN_RELAX_FROM = 2  // この iteration 以降は critical 無しなら収束を許容（issue #123）
const EVAL_MAX = 10        // 評価差し戻し上限（収束モデルにより happy path は数回で抜ける。issue #125）
const EVAL_STUCK = 2       // 同一 topic がこの回数出たら stuck と判定（design churn 打ち切り。issue #125）
const GREEN_MAX = 3   // test green までの実装差し戻し上限
const BLOCK_MAX = 2   // BLOCKED 由来の再計画上限
if (!ISSUE) throw new Error('dev-flow: issue 番号が必要です（args.issue）')

// agent() は user skip 時 null を返しうる。load-bearing な結果はここで弾く。
function need(result, what) {
  if (result == null) throw new Error(`dev-flow: ${what} が結果を返しませんでした（skip された可能性）`)
  return result
}

// ---- Plan 収束モデル（issue #123）----
// cold start の plan-reviewer は moving target を生む（毎回 fresh context で新しい観点の major を
// 捻り出し、major 1 件で revise 確定 → 上限まで収束しない）。orchestrator 側で収束を判断する:
//   1. 既出 findings を planner/reviewer に渡し「対応済み・新規 critical/major のみ」を強制（蒸し返し抑制）
//   2. 同一 topic が PLAN_STUCK 回出たら stuck と判定（fingerprint を JS 側で突合）
//   3. iteration >= PLAN_RELAX_FROM、または stuck なら、critical が無い限り収束を許容
//   4. critical は常にブロック（大 issue の品質ゲートは後退させない）
//   5. 上限到達でも throw せず、未解消 findings を concerns として Evaluate phase へ委譲
function planHasCritical(rev) {
  return (rev.findings ?? []).some((f) => f && f.severity === 'critical')
}
// 収束判定。critical が残る限り収束しない。pass / relax(iteration 経過) / stuck で受理。
function planConverged(rev, iteration, stuck) {
  if (rev.verdict === 'pass') return true
  if (planHasCritical(rev)) return false
  return stuck || iteration >= PLAN_RELAX_FROM
}
// 未解消 findings を Evaluate 用 concerns 文字列に整形する。
function findingsToConcerns(rev) {
  return (rev.findings ?? []).map(
    (f) => `[plan:${f?.severity ?? '?'}] ${f?.topic ?? ''}: ${f?.description ?? ''}`)
}

// ---- Evaluate 収束モデル（issue #125）----
// Evaluate ループは Plan ループと同型の cold start moving target を抱える。evaluator は毎回 fresh
// context で full diff を再評価するため、別観点を上乗せし続けて収束しない。さらに design 差し戻しは
// replan + 全 task 再実装を走らせるため、1 反復のコストが Plan/Review より桁違いに高い（#123 が潰した
// 抽象的な Plan 空間の moving target をループへ戻す）。Plan と同じ部品を Evaluate に適用する:
//   1. 既出 feedback を evaluator に渡し「対応済み・新規 critical/major のみ」を強制（蒸し返し抑制）
//   2. 同一 topic が EVAL_STUCK 回出たら stuck と判定（fingerprint を JS 側で突合）
//   3. stuck かつ design パスが反復するなら replan+reimpl を繰り返さず早期打ち切り（コスト保護）
//   4. critical は常にブロック（品質ゲートは後退させない。#123 と同一原則）
//   5. stuck/上限到達でも throw せず現状で PR へ進む（後段は review のみ、merge は手動 = human review 委譲）
// feedback 項目から stuck 検出用の fingerprint（topic）を取り出す。
function feedbackTopic(f) {
  if (!f) return ''
  if (typeof f === 'string') return f
  return f.topic ?? f.description ?? JSON.stringify(f)
}
// feedback に critical が含まれるか。critical は常にブロック（収束を許さない）。
function evalHasCritical(ev) {
  return (ev.feedback ?? []).some((f) => f && typeof f === 'object' && f.severity === 'critical')
}

// ---- schemas ----
const SETUP = {
  type: 'object', required: ['worktree', 'branch'],
  properties: { worktree: { type: 'string' }, branch: { type: 'string' } },
}
const REQ = {
  type: 'object', required: ['summary', 'acceptance_criteria'],
  properties: {
    summary: { type: 'string' },
    issue_type: { type: 'string' },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    scope: { type: 'string' },
    estimated_change_file_count: { type: 'number' },
    shape: { type: 'string', enum: ['micro', 'standard', 'complex'] },
  },
}
const TASK = {
  type: 'object', required: ['id', 'desc'],
  properties: {
    id: { type: 'string' }, desc: { type: 'string' },
    file_changes: { type: 'array', items: { type: 'string' } },
    test_plan: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
  },
}
const PLAN = {
  type: 'object', required: ['summary', 'serial', 'parallel'],
  properties: {
    summary: { type: 'string' },
    architecture_decisions: { type: 'array' },
    serial: { type: 'array', items: TASK },
    parallel: { type: 'array', items: TASK },
    edge_cases: { type: 'array' },
    notes_for_retry: { type: 'string' },
  },
}
const VERDICT = {
  type: 'object', required: ['score', 'verdict', 'findings', 'summary'],
  properties: {
    score: { type: 'number' },
    verdict: { type: 'string', enum: ['pass', 'revise', 'block'] },
    pass_threshold: { type: 'number' },
    findings: { type: 'array' },
    summary: { type: 'string' },
  },
}
const IMPL = {
  type: 'object', required: ['status', 'task_id'],
  properties: {
    status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'] },
    task_id: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    concerns: { type: 'array' },
    blocking_reason: { type: ['string', 'null'] },
    missing_context: { type: ['string', 'null'] },
  },
}
const GREEN = {
  type: 'object', required: ['tests', 'green'],
  properties: {
    tests: { type: 'string', enum: ['passed', 'failed', 'no_tests'] },
    green: { type: 'boolean' },
    summary: { type: 'string' },
  },
}
const EVAL = {
  type: 'object', required: ['verdict', 'total'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    score: { type: 'object' },
    total: { type: 'number' },
    threshold: { type: 'number' },
    feedback: { type: 'array' },
    feedback_level: { type: 'string', enum: ['design', 'implementation'] },
    task_type: { type: 'string' },
    ac_results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ac_index', 'satisfied'],
        properties: {
          ac_index: { type: 'number' },
          satisfied: { type: 'boolean' },
          evidence: { type: 'string' },
          verified_by: { type: 'string', enum: ['test', 'inspection'] },
          test_files: { type: 'array', items: { type: 'string' } },
          impl_files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    security_clearance: {
      type: 'array',
      items: {
        type: 'object',
        required: ['danger_class', 'cleared'],
        properties: {
          danger_class: { type: 'string' },
          cleared: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}
const RG = {
  type: 'object', required: ['red', 'green'],
  properties: { red: { type: 'boolean' }, green: { type: 'boolean' }, reason: { type: 'string' } },
}
const PRURL = {
  type: 'object', required: ['pr_url', 'pr_number'],
  properties: {
    pr_url: { type: 'string' }, pr_number: { type: ['string', 'number'] },
    committed: { type: 'boolean' },
  },
}
const RISK = {
  type: 'object', required: ['hits'],
  properties: {
    hits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'class'],
        properties: {
          file: { type: 'string' },
          class: { type: 'string' },
          severity: { type: 'string' },
        },
      },
    },
  },
}
const CHANGED = {
  type: 'object', required: ['files'],
  properties: { files: { type: 'array', items: { type: 'string' } } },
}

// ---- helpers ----
let WT // Setup で確定

function implPrompt(t, fixFeedback) {
  return `cd ${WT} で作業（Bash 呼び出しごとに必ず先頭で cd ${WT} すること。agent の cwd は毎回リセットされる）。`
    + `次の task を ${TESTING} 戦略で実装せよ。共有 worktree のため自分の task の file_changes 以外は触るな。`
    + `git add / commit はするな。\n`
    + `task: ${JSON.stringify(t)}\n`
    + (fixFeedback ? `修正指摘（各項目を解消）:\n${JSON.stringify(fixFeedback)}\n` : '')
}

// 計画の serial → 順次、parallel → 同時。drop（throw→null）を可視化して返す。
async function runImplement(p, fixFeedback, tag) {
  const results = []
  for (const t of (p.serial ?? [])) {
    const r = await agent(implPrompt(t, fixFeedback),
      { agentType: 'implementer', schema: IMPL, label: `${tag}:serial:${t.id}`, phase: 'Implement' })
    if (r) results.push(r)
  }
  const par = (p.parallel ?? []).map((t) => () =>
    agent(implPrompt(t, fixFeedback),
      { agentType: 'implementer', schema: IMPL, label: `${tag}:par:${t.id}`, phase: 'Implement' }))
  const parResults = await parallel(par)
  const ok = parResults.filter(Boolean)
  const dropped = parResults.length - ok.length
  if (dropped) log(`⚠️ ${tag}: parallel implementer ${dropped} 件が失敗(null) — 要確認`)
  results.push(...ok)
  return results
}

// ============================================================
// Phase Setup: 単一 worktree + branch を作る。全 agent が同じパスで作業し成果を集約する。
// （isolation:'worktree' は使わない — 各 agent が別 worktree になり並列実装の成果が分散するため。
//  並列は同一 worktree 内で「file_changes が disjoint な」task のみ。plan-reviewer が検証する。）
// ============================================================
phase('Setup')
const branch = `feature/issue-${ISSUE}`
const setup = need(await agent(
  `git worktree を 1 つ作って絶対パスを返せ。手順:\n`
  + `1. リポジトリルートで \`git fetch origin\`\n`
  + `2. worktree dir \`<repo>/.claude/worktrees/df-${ISSUE}\` が既に存在すれば再利用、無ければ\n`
  + `   \`git worktree add -b ${branch} <repo>/.claude/worktrees/df-${ISSUE} origin/${BASE}\`\n`
  + `   （branch が既に存在する場合は -b を外して既存 branch を checkout）\n`
  + `3. 作成/再利用した worktree の絶対パスと branch 名を返す`,
  { agentType: 'dev-runner-haiku', schema: SETUP, label: 'worktree', phase: 'Setup' },
), 'Setup(worktree)')
WT = setup.worktree
log(`worktree: ${WT} (branch ${setup.branch})`)

// ============================================================
// Phase Analyze: issue 分析（dev-issue-analyze skill を dev-runner 経由で呼ぶ）
// ============================================================
phase('Analyze')
const req = need(await agent(
  `cd ${WT} で作業。\`Skill: dev-issue-analyze ${ISSUE} --depth ${DEPTH}\` を実行し、`
  + `issue #${ISSUE} の要件・受入条件・issue type を抽出して返せ。`
  + `さらに、この issue を実装する際に新規作成/変更すると見込まれるファイル数を整数で見積もり estimated_change_file_count として返せ。`
  + `issue 本文に列挙されたパス数ではなく、実装に実際に必要なファイル数の見積りであること。判断に迷えば大きめ(安全側)に見積もれ。`
  + `さらに、この issue の実装規模を micro / standard / complex のいずれかで評価し shape として返せ。micro=単一ファイル軽微変更・AC 少数、standard=複数ファイルの通常実装、complex=多数ファイル・破壊的変更・設計判断を要する。判断に迷えば大きめ（安全側=complex 寄り）に評価せよ。`,
  { agentType: 'dev-runner', schema: REQ, label: `analyze#${ISSUE}`, phase: 'Analyze' },
), 'Analyze')

const triage = classifyShape(req)
const SHAPE = triage.shape
const TRIVIAL = SHAPE === 'micro'
log(`shape: ${SHAPE} — ${triage.reason}`)
const PLAN_SOLO = !TRIVIAL && SHAPE === 'standard'   // standard: plan 1発・reviewer 0回

// ============================================================
// Phase Plan: dev-planner ⇄ plan-reviewer ループ。
// 収束は planConverged() が判断する（issue #123。基準は同関数上のコメント参照）:
//   既出 findings 累積で cold start を補償 / 同一 topic 反復で stuck 打ち切り /
//   iteration 経過で relax / critical は常にブロック / 上限到達でも throw せず Evaluate へ委譲。
// ============================================================
phase('Plan')
let plan = null
let planVerdict = null
const planSeen = {}        // topic → { finding, count }（findings 累積 & stuck 検出。issue #123）
let planConcerns = []      // 収束時に残った未解消 findings（Evaluate の focus_areas へ）
if (TRIVIAL) {
  plan = need(await agent(
    `cd ${WT} で作業。issue 要件に基づき実装計画を立てよ。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `testing: ${TESTING}\n`
    + `serial（依存あり）と parallel（独立かつ file_changes が disjoint）に分解し、各 task は self-contained に書け。`,
    { agentType: 'dev-planner', model: QUALITY_MODEL, schema: PLAN, label: 'plan#trivial', phase: 'Plan' },
  ), 'Plan(planner#trivial)')
  plan = applyDisjoint(plan, 'plan#trivial')
  log('triviality gate: plan-review ループを skip(reviewer 0 回起動)')
} else if (PLAN_SOLO) {
  plan = need(await agent(
    `cd ${WT} で作業。issue 要件に基づき実装計画を立てよ。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `testing: ${TESTING}\n`
    + `serial（依存あり）と parallel（独立かつ file_changes が disjoint）に分解し、各 task は self-contained に書け。`,
    { agentType: 'dev-planner', model: QUALITY_MODEL, schema: PLAN, label: 'plan#standard', phase: 'Plan' },
  ), 'Plan(planner#standard)')
  plan = applyDisjoint(plan, 'plan#standard')
  log('standard 経路: plan 1発（plan-reviewer 0 回起動）')
} else {
for (let i = 1; i <= PLAN_MAX; i++) {
  const prior = Object.values(planSeen).map((s) => s.finding)   // 前 iteration までの累積 findings
  plan = need(await agent(
    `cd ${WT} で作業。issue 要件と${prior.length ? 'レビュー指摘' : '初回計画'}に基づき実装計画を立てよ。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `testing: ${TESTING}\n`
    + (prior.length
        ? `これまでの plan-reviewer findings（過去 iteration 全件の累積。既に解消した項目は再対応不要。`
          + `同じ topic が繰り返し残るなら同じ直し方をやめてアプローチを変えよ）:\n${JSON.stringify(prior)}\n`
        : '')
    + `serial（依存あり）と parallel（独立かつ file_changes が disjoint）に分解し、各 task は self-contained に書け。`,
    { agentType: 'dev-planner', model: QUALITY_MODEL, schema: PLAN, label: `plan#${i}`, phase: 'Plan' },
  ), `Plan(planner#${i})`)
  plan = applyDisjoint(plan, `plan#${i}`)
  const rev = need(await agent(
    `cd ${WT} で作業。次の実装計画を批判的にレビューせよ（実コードベースに照合）。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `plan: ${JSON.stringify(plan)}\n`
    + (prior.length
        ? `既出 findings（前 iteration までに指摘済み。planner は対応済みのはず）:\n${JSON.stringify(prior)}\n`
          + `**新規の critical/major のみ報告**せよ。既出論点の蒸し返し・別観点の上乗せ（moving target）は禁止。`
          + `同一問題には既出と同じ topic 文字列を再利用せよ。`
        : ''),
    { agentType: 'plan-reviewer', model: QUALITY_MODEL, schema: VERDICT, label: `review#${i}`, phase: 'Plan' },
  ), `Plan(reviewer#${i})`)
  planVerdict = rev

  // findings を topic 単位で累積し出現回数を数える（stuck 検出 fingerprint）
  for (const f of (rev.findings ?? [])) {
    if (!f) continue
    const t = f.topic ?? f.description ?? JSON.stringify(f)
    if (planSeen[t]) { planSeen[t].finding = f; planSeen[t].count += 1 }
    else planSeen[t] = { finding: f, count: 1 }
  }
  const stuckTopics = Object.entries(planSeen).filter(([, s]) => s.count >= PLAN_STUCK).map(([t]) => t)
  const stuck = stuckTopics.length > 0
  log(`plan iteration ${i}: ${rev.verdict} (score ${rev.score})${stuck ? ` [stuck: ${stuckTopics.join(' / ')}]` : ''}`)

  if (planConverged(rev, i, stuck)) {
    if (rev.verdict !== 'pass') {
      planConcerns = findingsToConcerns(rev)
      log(`plan 収束（verdict=${rev.verdict}, iter ${i}${stuck ? ', stuck' : ', relaxed'}）— `
        + `未解消 ${planConcerns.length} 件を Evaluate へ委譲`)
    }
    break
  }
  if (i === PLAN_MAX) {
    planConcerns = findingsToConcerns(rev)
    log(`⚠️ plan は ${PLAN_MAX} iteration で収束せず（verdict=${rev.verdict}）— `
      + `throw せず未解消 ${planConcerns.length} 件を Evaluate/human review へ委譲`)
  }
}

}

// ============================================================
// Phase Implement: 実装 → BLOCKED があれば別アプローチで再計画して再実装（上限 BLOCK_MAX）
// ============================================================
phase('Implement')
let implResults = await runImplement(plan, null, 'impl')
let blockedConcerns = []
for (let b = 1; b <= BLOCK_MAX; b++) {
  const blocked = implResults.filter((r) => r && r.status === 'BLOCKED')
  if (!blocked.length) break
  log(`implement: ${blocked.length} task が BLOCKED — 別アプローチで再計画 (${b}/${BLOCK_MAX})`)
  const blockFindings = blocked.map((r) => ({
    severity: 'critical', dimension: 'approach_mismatch',
    topic: String(r.blocking_reason ?? '').slice(0, 60),
    description: r.blocking_reason ?? 'BLOCKED',
    suggestion: '同アプローチでは進行不可。代替設計を立案すること（現アプローチの再試行は禁止）。',
  }))
  plan = need(await agent(
    `cd ${WT} で作業。前回実装が BLOCKED になった。別アプローチで計画を立て直せ。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `現計画: ${JSON.stringify(plan)}\n`
    + `approach_mismatch findings:\n${JSON.stringify(blockFindings)}`,
    { agentType: 'dev-planner', model: QUALITY_MODEL, schema: PLAN, label: `replan-blocked#${b}`, phase: 'Implement' },
  ), `Implement(replan#${b})`)
  plan = applyDisjoint(plan, `replan-blocked#${b}`)
  implResults = await runImplement(plan, null, `reimpl-blocked#${b}`)
  if (b === BLOCK_MAX) {
    const stillBlocked = implResults.filter((r) => r && r.status === 'BLOCKED')
    if (stillBlocked.length) {
      blockedConcerns = stillBlocked.map((r) => r.blocking_reason ?? 'BLOCKED')
      log(`⚠️ ${BLOCK_MAX} 回再計画しても ${stillBlocked.length} task が BLOCKED — Evaluate/human review へ`)
    }
  }
}
// DONE_WITH_CONCERNS / 未解消 BLOCKED を evaluator の focus_areas に渡す材料にする
const concerns = [
  ...planConcerns,
  ...implResults.flatMap((r) => (r && Array.isArray(r.concerns)) ? r.concerns : []),
  ...blockedConcerns,
]

// ============================================================
// Phase Validate: test green を確認し、green でなければ implementer に差し戻し（上限 GREEN_MAX）
// （format/lint は hook 責務でここでは扱わない）
// ============================================================
phase('Validate')
let val = null
for (let i = 1; i <= GREEN_MAX; i++) {
  val = need(await agent(
    `cd ${WT} で作業。テストスイートを実行し（npm test / pytest / cargo test 等、プロジェクトに合わせる）、`
    + `green かどうか判定せよ。format/lint はこの phase の責務外。test の結果のみ報告せよ。`,
    { agentType: 'dev-runner-haiku', schema: GREEN, label: `test#${i}`, phase: 'Validate' },
  ), `Validate(test#${i})`)
  log(`validate iteration ${i}: tests=${val.tests} green=${val.green}`)
  if (val.green || val.tests === 'no_tests') break
  if (i === GREEN_MAX) {
    log(`⚠️ ${GREEN_MAX} 回試行しても test green にならず — Evaluate へ（human review 想定）`)
    break
  }
  await agent(
    `cd ${WT} で作業（Bash ごとに先頭で cd すること）。テストが失敗している。原因を分析して実装/テストを修正し`
    + `green を目指せ。共有 worktree のため無関係ファイルは触るな。git add / commit はするな。\n`
    + `失敗内容: ${val.summary ?? '(詳細はテスト出力を確認)'}`,
    { agentType: 'implementer', schema: IMPL, label: `green-fix#${i}`, phase: 'Validate' },
  )
}

// ============================================================
// Phase Security floor: realized diff に diff-risk-classify(W1)を当て、
// 7 danger クラスを常時 seed した Goal Ledger に反映する(W5)。
// clean クラスは自動 check、hit クラスは critical 据え置きで evaluator が evidence 解消する。
// danger hit があれば micro でも Evaluate を走らせる(tier 無視の security path 強制)。
// ============================================================
phase('Security floor')
let ledger = makeLedger()
for (const seed of seedSecurityLedger()) {
  ledger = appendItem(ledger, seed).ledger
}
const risk = need(await agent(
  `cd ${WT} で作業。次を実行し **stdout の JSON 配列をそのまま** \`{"hits": <配列>}\` に包んで返せ`
  + `（判定や脚色をしない。空配列なら hits:[]）:\n`
  + `bash ${WT}/_shared/scripts/diff-risk-classify.sh --working-tree origin/${BASE}`,
  { agentType: 'dev-runner-haiku', schema: RISK, label: 'danger-grep', phase: 'Security floor' },
), 'Security floor(danger-grep)')
const dangerHits = [...new Set((risk.hits ?? []).map((h) => h.class))]
ledger = reconcileDanger(ledger, dangerHits)
log(`danger-grep: ${dangerHits.length ? 'HIT ' + dangerHits.join(',') : 'clean'} — `
  + `SEC blocking 未 checked ${blockingItems(ledger).filter((it) => !it.checked).length} 件`)
// Step F2: realized diff のファイル数を取得して re-floor を算出する
// realized が null（agent drop／skip）のときは NaN を refloorShape へ渡し complex 安全弁へ流す。
// ?? [] は取得失敗と空 diff（正常な 0 ファイル）を同じ 0 に潰すため使わない。
// 注: この時点で implementer はコミットしていない（git add / commit 禁止）ため、
//     --working-tree モード（worktree 変更を merge-base 基点の二点 diff + untracked -uall で分類）
//     を使う。commit 後の三点 diff（origin/${BASE}...HEAD）は HEAD==origin/BASE で空を返すため
//     Merge tier 側はフラグなしのまま（通常の三点 diff が正しい）。
const realized = await agent(
  `cd ${WT} で作業。\`git -C ${WT} status --porcelain --untracked-files=all\` を実行し、`
  + `変更ファイル一覧を取得せよ（ステージ済み・未ステージどちらも含む）。`
  + `各行の先頭2文字はステータスコードなので除去し、パス部分のみ取り出すこと。`
  + `リネームは -> の右側（新ファイル名）を使え。空白行は除く。`
  + `結果を {"files": ["path1", ...]} 形式で返せ。`,
  { agentType: 'dev-runner-haiku', schema: CHANGED, label: 'realized-diff', phase: 'Security floor' },
)
const realizedCount = realized?.files ? realized.files.length : NaN
const refloor = refloorShape(SHAPE, realizedCount)
const EFFECTIVE_SHAPE = refloor.shape
const EVAL_PASSES = EFFECTIVE_SHAPE === 'standard' ? 1 : EVAL_MAX
if (refloor.refloored) log(`⚠️ re-floor: 見積もり ${SHAPE} → realized ${realizedCount} file(s) で ${EFFECTIVE_SHAPE} へ昇格 (raise-only)`)
const runEval = EFFECTIVE_SHAPE !== 'micro' || dangerHits.length > 0
if (TRIVIAL && dangerHits.length > 0) {
  log(`⚠️ micro だが danger hit(${dangerHits.join(',')}) → Evaluate を実行（security path 強制）`)
}

// ============================================================
// Step DeclaredPath check: git status と plan 宣言パスを突合し、
// 宣言外変更を concerns へ注入する（evaluator focus_areas 経由で重点監査）。
// ============================================================
{
  const planAllTasks = [...(plan.serial ?? []), ...(plan.parallel ?? [])]
  const gitStat = await agent(
    `cd ${WT} で作業。\`git -C ${WT} status --porcelain --untracked-files=all\` を実行し、`
    + `変更ファイル一覧を取得せよ（ステージ・未ステージどちらも含む）。`
    + `各行の先頭2文字はステータスコードなので除去し、パス部分のみ取り出すこと。`
    + `リネームは -> の右側（新ファイル名）を使え。空白行は除く。`
    + `結果を {"files": ["path1", ...]} 形式で返せ。`,
    { agentType: 'dev-runner-haiku', schema: CHANGED, label: 'declared-path-check', phase: 'Validate' },
  )
  const changedFiles = gitStat?.files ?? []
  const undeclared = diffDeclaredPaths(planAllTasks, changedFiles)
  if (undeclared.length > 0) {
    if (runEval) {
      for (const p of undeclared) {
        concerns.push(`宣言外変更: ${p} が plan の file_changes に無い。意図的か確認`)
      }
      log(`declared-path-check: 宣言外 ${undeclared.length} 件 → concerns へ注入: ${undeclared.join(', ')}`)
    } else {
      log(`declared-path-check(warn): 宣言外 ${undeclared.length} 件だが Evaluate=skip: ${undeclared.join(', ')}`)
    }
  } else {
    log('declared-path-check: 宣言外変更なし（全変更が plan file_changes 内）')
  }
}

// ============================================================
// Phase Evaluate: evaluator → fail なら design=再計画+再実装 / implementation=implementer 修正。
// 収束は evalConverged() 相当のロジックがインライン判断する（issue #125。基準は EVAL 収束モデルの
// コメント参照）: 既出 feedback 累積で cold start を補償 / 同一 topic 反復で stuck 検出 /
// stuck かつ design 反復なら早期打ち切り（コスト保護）/ critical は常にブロック /
// stuck・上限到達でも throw せず現状で PR へ進む（human review 委譲）。
// 初回は implement で出た concerns / 未解消 BLOCKED を focus_areas として重点監査させる。
// ============================================================
let evalResult = null
let unsatisfiedAc = false
if (runEval) {
phase('Evaluate')
// Security floor で build 済みの ledger(SEC seed + danger 反映済)に AC + concerns を足す。
// makeLedger で作り直さない(SEC seed を失わないため)。
for (const [i, crit] of (req.acceptance_criteria ?? []).entries()) {
  // AC は現状 inspection-blocking(LLM 判定)。W4 で red→green 実証済みのものを deterministic 化する。
  ledger = appendItem(ledger, {
    id: `AC-${i + 1}`, text: String(crit), dimension: 'ac',
    severity: 'major', source: 'ac', check: { kind: 'inspection' },
  }).ledger
}
for (const [i, c] of concerns.entries()) {
  ledger = appendItem(ledger, {
    id: `CONCERN-${i + 1}`, text: String(c), dimension: 'concern',
    severity: 'major', source: 'evaluator', check: { kind: 'inspection' },
  }).ledger
}
log(`ledger 初期化: blocking ${blockingItems(ledger).length} / advisory ${advisoryItems(ledger).length} 件`)
const evalSeen = {}        // topic → { feedback, count }（feedback 累積 & stuck 検出。issue #125）
for (let i = 1; i <= EVAL_PASSES; i++) {
  const priorFeedback = Object.values(evalSeen).map((s) => s.feedback)   // 前 iteration までの累積 feedback
  const ev = need(await agent(
    `cd ${WT} で作業。実装品質を独立評価せよ（base は origin/${BASE}。`
    + `\`git diff $(git merge-base HEAD origin/${BASE})..HEAD\` で実 diff を確認し、テストを実際に走らせる）。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `plan: ${JSON.stringify(plan)}\n`
    + ((i === 1 && concerns.length) ? `focus_areas（重点監査せよ。implementer の自己申告した弱点/未解消BLOCKED）:\n${JSON.stringify(concerns)}\n` : '')
    + (dangerHits.length
        ? `security_focus（danger-grep が realized diff で検出した危険クラス。各クラスの変更が安全かを判定し `
          + `security_clearance:[{danger_class, cleared, evidence}] で返せ。安全確認できないものは cleared:false。`
          + `evidence は具体的な根拠を1文で）:\n${JSON.stringify(dangerHits)}\n`
        : '')
    + (priorFeedback.length
        ? `既出 feedback（前 iteration までに指摘済み。implementer/planner は対応済みのはず）:\n${JSON.stringify(priorFeedback)}\n`
          + `**新規の critical/major のみ報告**せよ。対応済み論点の蒸し返し・別観点の上乗せ（moving target）は禁止。`
          + `同一問題には既出と同じ topic 文字列を再利用せよ（orchestrator が topic で stuck を突合する）。\n`
        : ''),
    { agentType: 'evaluator', model: QUALITY_MODEL, schema: EVAL, label: `eval#${i}`, phase: 'Evaluate' },
  ), `Evaluate(eval#${i})`)
  evalResult = ev
  unsatisfiedAc = (ev.ac_results ?? []).some((r) => r && r.satisfied === false)

  // feedback を topic 単位で累積し出現回数を数える（stuck 検出 fingerprint）
  for (const f of (ev.feedback ?? [])) {
    if (f == null) continue
    const t = feedbackTopic(f)
    if (evalSeen[t]) { evalSeen[t].feedback = f; evalSeen[t].count += 1 }
    else evalSeen[t] = { feedback: f, count: 1 }
  }
  const stuckTopics = Object.entries(evalSeen).filter(([, s]) => s.count >= EVAL_STUCK).map(([t]) => t)
  const stuck = stuckTopics.length > 0
  log(`evaluate iteration ${i}: ${ev.verdict} (total ${ev.total})${stuck ? ` [stuck: ${stuckTopics.join(' / ')}]` : ''}`)
  // evaluator の critical feedback を ledger に append(単調性は appendItem が強制)。
  for (const f of (ev.feedback ?? [])) {
    if (f && typeof f === 'object' && f.severity === 'critical') {
      const r = appendItem(ledger, {
        id: `EVAL-${i}-${feedbackTopic(f).slice(0, 24)}`, text: feedbackTopic(f),
        dimension: f.dimension ?? 'eval', severity: 'critical', source: 'evaluator',
        check: { kind: 'inspection' },
      })
      ledger = r.ledger
    }
  }
  // 現 iteration の feedback に無くなった critical ledger item は解消とみなし checkItem(収束を妨げない)
  const liveCriticalKeys = new Set(
    (ev.feedback ?? []).filter((f) => f && typeof f === 'object' && f.severity === 'critical')
      .map((f) => topicKey({ dimension: f.dimension ?? 'eval', text: feedbackTopic(f) })))
  for (const it of ledger.items) {
    if (it.source === 'evaluator' && it.severity === 'critical' && !it.checked
        && !liveCriticalKeys.has(topicKey(it))) {
      ledger = checkItem(ledger, it.id, '現 iteration で未報告=解消')
    }
  }
  // W4: evaluator の per-AC 判定を ledger に反映。test 実証できる AC は red→green を
  // dev-runner-haiku で決定論検証し、取れたら deterministic 昇格(blocking)。
  for (const r of (ev.ac_results ?? [])) {
    if (!r || typeof r.ac_index !== 'number') continue
    const acId = `AC-${r.ac_index + 1}`
    if (!ledger.items.some((it) => it.id === acId)) continue   // 知らない AC は無視
    if (r.satisfied && r.verified_by === 'test' && Array.isArray(r.test_files) && r.test_files.length
        && Array.isArray(r.impl_files) && r.impl_files.length) {
      const rg = await agent(
        `cd ${WT} で作業。次を実行して **stdout の JSON 1 行だけ** を verbatim で返せ(判定や脚色をしない):\n`
        + `bash ${WT}/_shared/scripts/redgreen-verify.sh ${WT} `
        + `'${r.test_files.join(',')}' '${r.impl_files.join(',')}'`,
        { agentType: 'dev-runner-haiku', schema: RG, label: `redgreen:AC-${r.ac_index + 1}`, phase: 'Evaluate' })
      if (rg && rg.red === true && rg.green === true) {
        ledger = setCheck(ledger, acId, { kind: 'deterministic' })
        ledger = checkItem(ledger, acId, `red→green 実証: ${(r.test_files || []).join(',')}`)
        log(`AC-${r.ac_index + 1}: red→green 実証 → deterministic 昇格 + checked`)
      } else {
        if (r.satisfied) ledger = checkItem(ledger, acId, r.evidence ?? 'inspection(red→green 未成立)')
        log(`AC-${r.ac_index + 1}: red→green 未成立(${rg ? rg.reason : 'null'})→ inspection 据え置き`)
      }
    } else if (r.satisfied) {
      ledger = checkItem(ledger, acId, r.evidence ?? 'inspection')
    }
  }
  // W5: danger-grep hit の SEC item(critical 据え置き)を evaluator が evidence 付きで
  // 安全確認したら checkItem(resolve-with-evidence)。確認できなければ block 据え置き。
  for (const sc of (ev.security_clearance ?? [])) {
    if (!sc || typeof sc.danger_class !== 'string') continue
    const secId = `SEC-${sc.danger_class.toUpperCase()}`
    if (!ledger.items.some((it) => it.id === secId)) continue
    if (sc.cleared === true && typeof sc.evidence === 'string' && sc.evidence.length > 0) {
      ledger = checkItem(ledger, secId, `security cleared: ${sc.evidence}`)
      log(`${secId}: evaluator が安全確認 → checked`)
    }
  }
  ledger = nextRound(ledger)
  log(`ledger: blocking ${blockingItems(ledger).filter((it) => !it.checked).length} 件未 checked / `
    + `converged(observe)=${isConvergedUnderPolicy(ledger, GATE_POLICY)}`)

  if (isConvergedUnderPolicy(ledger, GATE_POLICY) && ev.verdict === 'pass') {
    log(`evaluate 収束（ledger 全 blocking checked + verdict pass, iter ${i}）— PR へ進む`)
    break
  }
  // critical は常にブロック。critical が無く design パスが stuck したら早期打ち切り（replan+reimpl の
  // コスト保護）。critical が残るうちは stuck でも打ち切らず差し戻しを続ける（品質ゲート後退なし）。
  if (stuck && ev.feedback_level === 'design' && !evalHasCritical(ev)) {
    log(`⚠️ evaluate 早期打ち切り（stuck design churn, iter ${i}, topics: ${stuckTopics.join(' / ')}）— `
      + `replan+reimpl を繰り返さず現状で PR へ進む（human review に委ねる）`)
    break
  }
  if (i === EVAL_MAX) {
    log(`⚠️ evaluate は ${EVAL_MAX} iteration で pass せず（verdict=${ev.verdict}）— `
      + `throw せず現状で PR へ進む（human review に委ねる）`)
    break
  }
  if (EFFECTIVE_SHAPE === 'standard') {
    log('standard 経路: 1 パス評価のみ（差し戻しなし仕様）。未解消 critical があれば merge tier HOLD + human review で担保')
    break
  }
  if (ev.feedback_level === 'design') {
    plan = need(await agent(
      `cd ${WT} で作業。evaluator が設計レベルの問題を指摘した。計画を revise せよ。\n`
      + `requirements: ${JSON.stringify(req)}\n`
      + `現計画: ${JSON.stringify(plan)}\n`
      + `evaluator feedback: ${JSON.stringify(ev.feedback)}`,
      { agentType: 'dev-planner', model: QUALITY_MODEL, schema: PLAN, label: `replan#${i}`, phase: 'Evaluate' },
    ), `Evaluate(replan#${i})`)
    plan = applyDisjoint(plan, `replan#${i}`)
    await runImplement(plan, ev.feedback, `reimpl#${i}`)
  } else {
    await agent(
      `cd ${WT} で作業（Bash ごとに先頭で cd すること）。evaluator が実装レベルの問題を指摘した。`
      + `既存計画のまま修正せよ。無関係ファイルは触るな。git add / commit はするな。\n`
      + `evaluator feedback: ${JSON.stringify(ev.feedback)}`,
      { agentType: 'implementer', schema: IMPL, label: `fix#${i}`, phase: 'Evaluate' })
  }
}
} else {
  log('micro path: Evaluate phase を skip(evaluator 0 回起動。danger-grep clean。reason: ' + triage.reason + ')')
}

// ============================================================
// Phase PR: git-commit + git-pr skill を dev-runner で実行し PR URL を取得。
// ============================================================
phase('PR')
const pr = need(await agent(
  `cd ${WT} で作業。次を順に実行せよ:\n`
  + `1. \`Skill: git-commit --all --worktree ${WT}\`（変更を日本語メッセージで commit）\n`
  + `2. \`Skill: git-pr ${ISSUE} --base ${BASE} --lang ja --worktree ${WT}\`（PR 作成）\n`
  + `作成された PR の URL と番号を返せ。`,
  { agentType: 'dev-runner', schema: PRURL, label: `pr#${ISSUE}`, phase: 'PR' },
), 'PR')
log(`PR created: ${pr.pr_url}`)

// ============================================================
// pr-iterate をサブ workflow として呼ぶ（review ⇄ fix, LGTM まで, 上限10）。
// 注: これは「親 workflow の中の workflow()」= ネスト1段で合法。
//     pr-iterate.js 内に workflow() を足すと2段になり throw するので入れないこと。
// ============================================================
const iterate = await workflow('pr-iterate', { pr: pr.pr_number })

// ============================================================
// Phase Merge tier: 最終 diff に danger-grep を再実行し、merge tier を算出して提示する(W5)。
// merge は全 tier 人間。AUTO は推奨ラベルのみ(真 auto-merge は W6 earned-autonomy)。
// ============================================================
phase('Merge tier')
const riskFinal = need(await agent(
  `cd ${WT} で作業。次を実行し **stdout の JSON 配列をそのまま** \`{"hits": <配列>}\` に包んで返せ:\n`
  + `bash ${WT}/_shared/scripts/diff-risk-classify.sh origin/${BASE}`,
  { agentType: 'dev-runner-haiku', schema: RISK, label: 'danger-grep-final', phase: 'Merge tier' },
), 'Merge tier(danger-grep-final)')
const dangerHitsFinal = [...new Set((riskFinal.hits ?? []).map((h) => h.class))]
const changed = need(await agent(
  `cd ${WT} で作業。次を実行し **stdout の各行(ファイルパス)を** \`{"files": [...]}\` に包んで返せ:\n`
  + `git -C ${WT} diff --name-only origin/${BASE}...HEAD`,
  { agentType: 'dev-runner-haiku', schema: CHANGED, label: 'changed-files', phase: 'Merge tier' },
), 'Merge tier(changed-files)')

// 最終 danger を ledger に再反映(PR 中の修正で hit が消えた/増えた場合に追従)。
ledger = reconcileDanger(ledger, dangerHitsFinal)
const unresolvedDanger = ledger.items.some(
  (it) => it.dimension === 'security' && it.source === 'seed' && it.floor && !it.checked)
const breaking = /breaking|incompatible|migration|破壊的|非互換/i.test(`${req.scope ?? ''} ${req.summary ?? ''}`)
const escalateCount = policyAdvisoryItems(ledger, GATE_POLICY).filter((it) => it.escalate === true).length
const mergeTier = classifyMergeTier({
  shape: SHAPE,
  converged: isConvergedUnderPolicy(ledger, GATE_POLICY),
  unresolvedDanger,
  breaking,
  docsOrTestOnly: isDocsOrTestOnly(changed.files ?? []),
  escalateCount,
  unsatisfiedAc,
})
log(`merge tier: ${mergeTier.tier} — ${mergeTier.reasons.join(' / ')}`)

// ============================================================
// Post-summary: Merge tier 算出後に終端サマリーを PR にコメント投稿する。
// 投稿失敗は log 警告のみで workflow は正常 return（issue #162 AC#4）。
// ============================================================
const summaryBody = buildDevflowSummaryBody({
  pr: pr.pr_number,
  mergeTier: mergeTier.tier,
  mergeTierReasons: mergeTier.reasons,
  gatePolicy: GATE_POLICY,
  blockingItems: policyBlockingItems(ledger, GATE_POLICY),
  advisoryItems: policyAdvisoryItems(ledger, GATE_POLICY),
  ledgerConverged: isConvergedUnderPolicy(ledger, GATE_POLICY),
  acResults: evalResult?.ac_results ?? null,
  securityClearance: evalResult?.security_clearance ?? null,
  planConcerns: planConcerns ?? [],
  dangerHits: dangerHitsFinal,
  shape: EFFECTIVE_SHAPE,
  testGreen: val?.green ?? null,
  evalVerdict: evalResult?.verdict ?? null,
})
const summaryPost = await agent(
  `## Objective\nPR #${pr.pr_number} に dev-flow の終端サマリーコメントを投稿する（merge tier: ${mergeTier.tier}）。\n\n`
  + bodySaveInstr(summaryBody)
  + `## Instructions\n`
  + `保存した <BODY_FILE> を使い、以下のコマンドをそのまま実行せよ: \`gh pr comment ${pr.pr_number} --body-file <BODY_FILE>\`\n`
  + `投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
  + `投稿失敗時でも posted:false を返し throw しないこと。\n`
  + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
  + `\n## Tools\n使用可: Bash, Write\n`
  + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
  + `\n## Token cap\n200 語以内で完結すること。`,
  { agentType: 'dev-runner', schema: POST_RESULT, label: 'post-summary', phase: 'Merge tier' },
)
if (!summaryPost?.posted) {
  log(`⚠️ post-summary の投稿に失敗しました（posted=${summaryPost?.posted ?? 'null'}）。ワークフローは継続します。`)
}


return {
  issue: ISSUE,
  worktree: WT,
  branch: setup.branch,
  pr_url: pr.pr_url,
  pr_number: pr.pr_number,
  plan_verdict: planVerdict?.verdict ?? null,
  eval_verdict: evalResult?.verdict ?? null,
  test_green: val?.green ?? null,
  iterate_status: iterate?.status ?? null,
  shape: SHAPE,
  effective_shape: EFFECTIVE_SHAPE,
  shape_refloored: refloor.refloored,
  realized_file_count: realizedCount,
  triviality: TRIVIAL,
  triviality_reason: triage.reason,
  gate_policy: GATE_POLICY,
  ledger_blocking: policyBlockingItems(ledger, GATE_POLICY).length,
  ledger_advisory: policyAdvisoryItems(ledger, GATE_POLICY).length,
  ledger_converged: isConvergedUnderPolicy(ledger, GATE_POLICY),
  merge_tier: mergeTier.tier,
  merge_tier_reasons: mergeTier.reasons,
  danger_hits: dangerHitsFinal,
  note: mergeTier.tier === 'HOLD'
    ? `HOLD: 人間 review 必須。merge 前に reasons を確認してください（${mergeTier.reasons.join(' / ')}）`
    : mergeTier.tier === 'AUTO'
    ? 'AUTO 推奨（低リスク）。最終判断と merge は人間が行ってください'
    : 'REVIEW: 人間が LGTM を確認して merge してください',
}
