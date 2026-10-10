import type { Register } from 'claude-code'

// ─────────────────────────────────────────────────────────────
// host-exec
// sandbox で動かないコマンドを、Claude が人間に「これ実行して」と
// 頼む代わりに呼べるツール `mcp__host-exec__run` を追加する。
//
//   ゲート1: 許可リスト / 拒否パターン（静的チェック）
//   ゲート2: 毎回の実行承認（ダイアログ）
//   ゲート3: 出力の機密チェック → 引っかかったら Claude に渡す前に停止
//
// どのゲートも「判断できない・答えがない」ときは渡さない側に倒す（fail closed）。
// ─────────────────────────────────────────────────────────────

/** 実行してよいコマンド（argv[0] のベース名）。必要に応じて増減してください。 */
const ALLOWED_BINARIES = new Set([
  'gcloud',
  'gsutil',
  'docker',
  'gh',
  'git',
  'npm',
  'pnpm',
  'npx',
  'node',
  'cargo',
  'rustup',
  'mise',
  'nix',
  'home-manager',
  'prisma',
  'curl',
])

/** 許可リスト内でも実行前に拒否するもの（argv を空白で連結した文字列に当てる）。 */
const DENY_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, '再帰的な強制削除'],
  [/\bgit\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, 'force push'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, '作業ツリーの破棄'],
  [/\bprisma\s+(migrate\s+reset|db\s+push\b.*--force-reset)/, 'DB のリセット'],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, '破壊的 SQL'],
  [/\bgcloud\b.*\s(delete|remove-iam-policy-binding)\b/, 'GCP リソースの削除'],
  [/\bdocker\s+(system|volume|image)\s+prune\b/, 'Docker の一括削除'],
  // 実行するとほぼ確実に秘密情報を出力するもの
  [/\bgcloud\s+auth\s+(print-access-token|print-identity-token|application-default\s+print-access-token)\b/, 'アクセストークンの出力'],
  [/\bgcloud\s+secrets\s+versions\s+access\b/, 'Secret Manager の値の出力'],
  [/\bgcloud\s+iam\s+service-accounts\s+keys\s+create\b/, 'サービスアカウント鍵の発行'],
  [/\bgh\s+auth\s+token\b/, 'GitHub トークンの出力'],
  [/\bcurl\b.*\s(-d|--data|--data-binary|-F|--form|-T|--upload-file)\b/, 'curl でのデータ送信'],
]

/** 出力に含まれていたら Claude に渡す前に止める秘密情報のパターン。 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '秘密鍵'],
  [/"private_key(_id)?"\s*:\s*"[^"]+"/g, 'サービスアカウント鍵 (JSON)'],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, 'Google OAuth アクセストークン'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API キー'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS アクセスキー'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/g, 'GitHub トークン'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}/g, 'API キー (sk-)'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'Slack トークン'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT'],
  [/\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:\s/@]+:[^@\s]+@/gi, 'パスワード入り接続文字列'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, 'Bearer トークン'],
  [/\b[A-Z0-9_]*(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"']{6,}/g, '秘密っぽい環境変数'],
]

const MAX_TIMEOUT_SEC = 600
const RUN = '実行する'
const PASS_MASKED = 'マスクして渡す'
const WITHHOLD = '渡さない'
const PASS_RAW = 'そのまま渡す'

type Finding = { kind: string; count: number }

function scan(text: string): Finding[] {
  const found: Finding[] = []
  for (const [re, kind] of SECRET_PATTERNS) {
    const n = (text.match(new RegExp(re.source, re.flags)) ?? []).length
    if (n > 0) found.push({ kind, count: n })
  }
  return found
}

function mask(text: string): string {
  let out = text
  for (const [re, kind] of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), `[REDACTED: ${kind}]`)
  }
  return out
}

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

function format(argv: readonly string[], r: { exitCode: number; stdout: string; stderr: string }): string {
  return [
    `$ ${argv.join(' ')}`,
    `exit code: ${r.exitCode}`,
    '--- stdout ---',
    r.stdout || '(empty)',
    '--- stderr ---',
    r.stderr || '(empty)',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'run',
      description: [
        'Run a command on the user\'s host machine, OUTSIDE the sandbox, after the user approves it.',
        'Use this instead of asking the user to run a command themselves and paste the output back,',
        'whenever a command fails or cannot run because of the sandbox (network, gcloud/docker auth, sockets, etc.).',
        'Pass the command as an argument vector (no shell: no pipes, redirects, globs, && or env-var expansion).',
        `Only these executables are allowed: ${[...ALLOWED_BINARIES].join(', ')}.`,
        'Destructive commands and commands that print credentials are refused.',
        'If the output contains secrets, the user may mask or withhold it; do not try to obtain the secret another way.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          argv: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'e.g. ["gcloud","run","services","list","--region","asia-northeast1"]' },
          cwd: { type: 'string', description: 'Working directory; defaults to the session\'s' },
          reason: { type: 'string', description: 'One sentence, in Japanese, on why this needs to run outside the sandbox' },
          timeoutSec: { type: 'number', description: `Default 30, max ${MAX_TIMEOUT_SEC}` },
        },
        required: ['argv', 'reason'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__host-exec__run' }, async ($, e) => {
    const input = e as unknown as { argv?: unknown; cwd?: unknown; reason?: unknown; timeoutSec?: unknown }
    const argv = Array.isArray(input.argv) ? input.argv.map(String) : []
    if (argv.length === 0) return { deny: 'argv must be a non-empty array of strings.' }
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined
    const reason = typeof input.reason === 'string' ? input.reason : '(理由なし)'
    const timeoutSec = Math.min(
      Math.max(typeof input.timeoutSec === 'number' ? input.timeoutSec : 30, 1),
      MAX_TIMEOUT_SEC,
    )
    const line = argv.join(' ')

    // ── ゲート1: 静的チェック ──
    const bin = basename(argv[0] ?? '')
    if (!ALLOWED_BINARIES.has(bin)) {
      return {
        deny: `host-exec: "${bin}" is not on the allow list. Do not retry with a shell wrapper. Ask the user to run it themselves, or to add it to the allow list.`,
      }
    }
    for (const [re, why] of DENY_PATTERNS) {
      if (re.test(line)) {
        return { deny: `host-exec: refused (${why}). Do not retry this command another way; explain to the user what you wanted to do and let them decide.` }
      }
    }

    // ── ゲート2: 実行承認 ──
    let approval = ''
    try {
      approval = await $.ui.ask(
        `sandbox 外で実行しますか？\n\n$ ${line}\ncwd: ${cwd ?? '(セッションの作業ディレクトリ)'}\n理由: ${reason}`,
        { options: [RUN, '拒否'], header: 'host-exec' },
      )
    } catch {
      return { deny: 'host-exec: nobody approved the command (dialog dismissed or unavailable). Wait for the user.' }
    }
    if (approval !== RUN) {
      // 「その他」に書かれた自由記述は指示として Claude に返す
      const note = approval && approval !== '拒否' ? ` The user said: ${approval}` : ''
      return { deny: `host-exec: the user declined to run this command.${note}` }
    }

    // ── 実行 ──
    let r: { exitCode: number; stdout: string; stderr: string }
    try {
      r = await $.process.run(argv, { cwd, timeoutMs: timeoutSec * 1000 })
    } catch (err) {
      return { result: `host-exec: the command could not start or timed out after ${timeoutSec}s: ${String(err)}` }
    }
    const text = format(argv, r)

    // ── ゲート3: 出力の機密チェック ──
    const findings = scan(text)
    if (findings.length === 0) return { result: text }

    const summary = findings.map(f => `・${f.kind} ×${f.count}`).join('\n')
    let choice = ''
    try {
      choice = await $.ui.ask(
        `出力に秘密情報らしきものがあります。Claude に渡す前に止めました。\n\n$ ${line}\n${summary}\n\nどうしますか？`,
        { options: [PASS_MASKED, WITHHOLD, PASS_RAW], header: 'secrets' },
      )
    } catch {
      choice = WITHHOLD
    }

    if (choice === PASS_RAW) return { result: text }
    if (choice === PASS_MASKED) {
      $.ui.toast(`host-exec: ${findings.length} 種類の秘密情報をマスクして渡しました`)
      return { result: mask(text) + '\n\n[host-exec: secrets in this output were redacted by the user\'s choice]' }
    }
    // 渡さない（既定）: 実行結果の事実だけ返す
    return {
      result:
        `host-exec: the command ran (exit code ${r.exitCode}), but its output was withheld because it contained: ` +
        findings.map(f => f.kind).join(', ') +
        '. Do not try to read these values another way. Ask the user for the specific non-secret information you need.',
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'host-exec: its guard failed, so the command was not run.' },
  )
}
