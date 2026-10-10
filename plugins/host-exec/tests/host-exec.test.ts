import { describe, expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__host-exec__run'

/** AskUserQuestion への回答を、質問ごとに順番に返すスタブ */
function answer(on: any, labels: string[], asked: string[]) {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($: any, e: any) => {
    const q = e.questions[0].question as string
    asked.push(q)
    const label = labels.shift() ?? '拒否'
    return { result: { questions: e.questions, answers: { [q]: label } } }
  })
}

function stubProcess(on: any, out: { stdout: string; stderr?: string; exitCode?: number }, ran: string[][]) {
  on('process.run', async ($: any, e: any) => {
    ran.push([...e.argv])
    return { value: { exitCode: out.exitCode ?? 0, stdout: out.stdout, stderr: out.stderr ?? '' } }
  })
}

/**
 * ホストのファイルシステム・PATH・セッションのディレクトリ。
 * macOS と同じく /tmp と /var/folders は /private 配下へのリンクとして置く。
 */
const DIRS: Record<string, string> = {
  '/w/repo': '/w/repo',
  '/w/other': '/w/other',
  '/tmp': '/private/tmp',
  '/tmp/evil': '/private/tmp/evil',
  '/var/folders': '/private/var/folders',
  '/var/folders/xx/T': '/private/var/folders/xx/T',
}
const FILES: Record<string, string> = {
  '/opt/homebrew/bin/gcloud': '/opt/homebrew/bin/gcloud',
  '/opt/homebrew/bin/gh': '/opt/homebrew/bin/gh',
  '/opt/homebrew/bin/terraform': '/opt/homebrew/Cellar/terraform/1.9.0/bin/terraform',
  '/opt/homebrew/bin/node': '/opt/homebrew/bin/node',
  '/opt/homebrew/bin/pnpm': '/opt/homebrew/bin/pnpm',
  '/usr/bin/printf': '/usr/bin/printf',
  '/var/folders/xx/T/x/git': '/private/var/folders/xx/T/x/git',
}

function host(on: any) {
  mock.env(on, { PATH: '/usr/bin:/opt/homebrew/bin', TMPDIR: '/var/folders/xx/T' })
  on('session.cwd', async () => ({ value: '/w/repo' }))
  on('session.root', async () => ({ value: '/w/repo' }))
  on('fs.stat', async ($: any, e: any) => {
    const p = e.path as string
    const kind = p in DIRS ? 'dir' : p in FILES ? 'file' : undefined
    if (!kind) return { deny: `ENOENT: ${p}` }
    return { value: { kind, size: 0, mtimeMs: 0, isLink: false, realPath: DIRS[p] ?? FILES[p] } }
  })
}

describe('host-exec', () => {
  test('許可リストの無い任意の実行ファイルも、PATH で解決したパスを見せて承認後に実行する', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する'], asked)
    stubProcess(on, { stdout: 'No changes.' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['terraform', 'plan'], reason: 'x' } as any)
    expect(asked.length).toBe(1)
    expect(asked[0]).toContain('実行ファイル: "/opt/homebrew/bin/terraform" → "/opt/homebrew/Cellar/terraform/1.9.0/bin/terraform"')
    expect(asked[0]).toContain('argv: ["terraform", "plan"]')
    expect(asked[0]).toContain('cwd: "/w/repo"')
    expect(asked[0]).not.toContain('⚠')
    expect(ran).toEqual([['/opt/homebrew/bin/terraform', 'plan']])
    expect(JSON.stringify(r)).toContain('No changes.')
  })

  test('トークン出力系・再帰的な強制削除は承認を聞かずに拒否', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, [], asked)
    for (const argv of [['gcloud', 'auth', 'print-access-token'], ['rm', '-rf', '/w/repo']]) {
      const r: any = await $.tool.call({ tool: TOOL, argv, reason: 'x' } as any)
      expect(String(r.deny ?? r.text)).toContain('refused')
    }
    expect(asked.length).toBe(0)
  })

  test('PATH に無い実行ファイルは承認を聞かずに拒否', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, [], asked)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['kubectl', 'get', 'pods'], reason: 'x' } as any)
    expect(String(r.deny ?? r.text)).toContain('not found on PATH')
    expect(asked.length).toBe(0)
  })

  test('ユーザーが拒否したら実行しない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['拒否'], asked)
    stubProcess(on, { stdout: 'ok' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'run', 'services', 'list'], reason: 'x' } as any)
    expect(String(r.deny ?? r.text)).toContain('declined')
    expect(ran.length).toBe(0)
  })

  test('承認・機密なしなら出力をそのまま返す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する'], asked)
    stubProcess(on, { stdout: 'SERVICE  REGION\napi  asia-northeast1' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'run', 'services', 'list'], reason: 'x' } as any)
    expect(ran.length).toBe(1)
    expect(asked.length).toBe(1)
    expect(JSON.stringify(r)).toContain('asia-northeast1')
  })

  test('改行・双方向制御文字はダイアログでエスケープして見せ、実行する argv はそのまま渡す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する'], asked)
    stubProcess(on, { stdout: 'ok' }, ran)
    const body = 'line1\nline2\u202eevil'
    await $.tool.call({ tool: TOOL, argv: ['gh', 'pr', 'comment', '1', '--body', body], reason: 'a\nb' } as any)
    expect(asked[0]).toContain('"line1\\nline2\\u202eevil"')
    expect(asked[0]).not.toContain('line1\nline2')
    expect(asked[0]).not.toContain('\u202e')
    expect(asked[0]).toContain('理由: a\\nb')
    expect(ran[0]?.[5]).toBe(body)
  })

  test('Claude が書ける場所の実行ファイル・一時ディレクトリの cwd は、止めずに警告を添えて聞く', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', '実行する', '実行する'], asked)
    stubProcess(on, { stdout: 'ok' }, ran)
    await $.tool.call({ tool: TOOL, argv: ['/var/folders/xx/T/x/git', 'status'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['gh', 'repo', 'view'], cwd: '/tmp/evil', reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['gh', 'repo', 'view'], cwd: '/w/other', reason: 'x' } as any)
    expect(asked[0]).toContain('⚠')
    expect(asked[0]).toContain('"/private/var/folders/xx/T/x/git" は Claude が書き換えられる場所にあります')
    expect(asked[1]).toContain('cwd が一時ディレクトリです')
    expect(asked[1]).toContain('cwd: "/private/tmp/evil"')
    expect(asked[2]).toContain('cwd がプロジェクトの外です')
    expect(ran).toEqual([
      ['/var/folders/xx/T/x/git', 'status'],
      ['/opt/homebrew/bin/gh', 'repo', 'view'],
      ['/opt/homebrew/bin/gh', 'repo', 'view'],
    ])
  })

  test('ファイルやスクリプトの中身を実行するコマンドには警告、中身が argv に見えるインライン実行には出さない', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, ['拒否', '拒否', '拒否', '拒否'], asked)
    await $.tool.call({ tool: TOOL, argv: ['node', '--no-warnings', 'scripts/deploy.js'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['pnpm', 'dev'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['pnpm', 'outdated'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['node', '-e', 'console.log(1)'], reason: 'x' } as any)
    expect(asked[0]).toContain('"scripts/deploy.js" の中身を実行します')
    expect(asked[1]).toContain('package.json のスクリプト')
    expect(asked[2]).not.toContain('⚠')
    expect(asked[3]).not.toContain('⚠')
  })

  test('機密を含む出力は止めて、マスクを選べばマスク済みで返す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', 'マスクして渡す'], asked)
    stubProcess(on, { stdout: 'DATABASE_URL=postgresql://app:s3cretPass@10.0.0.3:5432/app\nok' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'run', 'services', 'describe', 'api'], reason: 'x' } as any)
    const s = JSON.stringify(r)
    expect(asked.length).toBe(2)
    expect(s).not.toContain('s3cretPass')
    expect(s).toContain('REDACTED')
  })

  test('機密の質問と Claude に返す結果でも argv はエスケープして見せる', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', 'マスクして渡す'], asked)
    stubProcess(on, { stdout: 'AKIAABCDEFGHIJKLMNOP' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['printf', '%s%s\n', 'AKIA', 'ABCDEFGHIJKLMNOP'], reason: 'x' } as any)
    const shown = 'argv: ["printf", "%s%s\\n", "AKIA", "ABCDEFGHIJKLMNOP"]'
    expect(asked[1]).toContain(shown)
    expect(asked[1]).not.toContain('%s%s\n')
    expect(JSON.stringify(r)).toContain(JSON.stringify(shown).slice(1, -1))
    expect(JSON.stringify(r)).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })

  test('機密を含む出力で「渡さない」なら値を一切返さない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', '渡さない'], asked)
    stubProcess(on, { stdout: '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----"}' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'iam', 'service-accounts', 'list'], reason: 'x' } as any)
    const s = JSON.stringify(r)
    expect(s).toContain('withheld')
    expect(s).not.toContain('MIIabc')
  })

  test('2回目の質問に答えがなければ（AFK・自由記述など）渡さない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', 'あとで見る'], asked)
    stubProcess(on, { stdout: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'api', 'user'], reason: 'x' } as any)
    const s = JSON.stringify(r)
    expect(s).toContain('withheld')
    expect(s).not.toContain('ghp_abcdef')
  })
})
