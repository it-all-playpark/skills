export const meta = {
  name: 'dev-flow-canary-child',
  description: 'dev-flow-canary 専用の nested workflow probe。引数 token を echo して返すのみ（read-only、agent 呼び出しゼロ）。単体起動は不要',
  phases: [
    { title: 'Echo' },
  ],
}

phase('Echo')
const token = (args && typeof args === 'object') ? (args.token ?? null) : (args ?? null)
log(`canary-child: echo token=${JSON.stringify(token)}`)
return { child_ok: true, echo: token }
