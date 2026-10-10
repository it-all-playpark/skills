import { describe, expect, test } from 'claude-code/testing'

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

describe('host-exec', () => {
  test('許可リスト外は承認を聞かずに拒否', async ($, on) => {
    const asked: string[] = []
    answer(on, [], asked)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['bash', '-c', 'ls'], reason: 'x' } as any)
    expect(String(r.deny ?? r.text)).toContain('not on the allow list')
    expect(asked.length).toBe(0)
  })

  test('トークン出力系コマンドは拒否', async ($, on) => {
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'auth', 'print-access-token'], reason: 'x' } as any)
    expect(String(r.deny ?? r.text)).toContain('refused')
  })

  test('ユーザーが拒否したら実行しない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    answer(on, ['拒否'], asked)
    stubProcess(on, { stdout: 'ok' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'run', 'services', 'list'], reason: 'x' } as any)
    expect(String(r.deny ?? r.text)).toContain('declined')
    expect(ran.length).toBe(0)
  })

  test('承認・機密なしなら出力をそのまま返す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    answer(on, ['実行する'], asked)
    stubProcess(on, { stdout: 'SERVICE  REGION\napi  asia-northeast1' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'run', 'services', 'list'], reason: 'x' } as any)
    expect(ran.length).toBe(1)
    expect(asked.length).toBe(1)
    expect(JSON.stringify(r)).toContain('asia-northeast1')
  })

  test('機密を含む出力は止めて、マスクを選べばマスク済みで返す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    answer(on, ['実行する', 'マスクして渡す'], asked)
    stubProcess(on, { stdout: 'DATABASE_URL=postgresql://app:s3cretPass@10.0.0.3:5432/app\nok' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'run', 'services', 'describe', 'api'], reason: 'x' } as any)
    const s = JSON.stringify(r)
    expect(asked.length).toBe(2)
    expect(s).not.toContain('s3cretPass')
    expect(s).toContain('REDACTED')
  })

  test('機密を含む出力で「渡さない」なら値を一切返さない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
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
    answer(on, ['実行する', 'あとで見る'], asked)
    stubProcess(on, { stdout: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'api', 'user'], reason: 'x' } as any)
    const s = JSON.stringify(r)
    expect(s).toContain('withheld')
    expect(s).not.toContain('ghp_abcdef')
  })
})
