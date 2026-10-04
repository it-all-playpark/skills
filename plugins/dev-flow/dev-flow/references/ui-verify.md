# ui-verify: project が宣言する起動手順

dev-flow の ui-verify（Evaluate / Final reconcile の実ブラウザ検証）は、検証対象アプリの
起動方法を知らない。project が `skill-config.json`（または `.claude/skill-config.json`、前者優先）の
`"dev-flow".ui_verify` に起動手順を宣言し、dev-flow は `ui-verify-stack` でそれを
**宣言順に起動・待機し、検証後に片付ける** だけ。DB・backend・frontend をどう起動するか、
sandbox で何が要るか（ポーリング監視・フォントのモック・一時ディレクトリなど）は宣言側の責務。

宣言されたコマンドは dev-flow の他の処理と同じく **sandbox 内** で実行される。
`ui-verify-stack` を sandbox の `excludedCommands` に入れてはならない（入れると repo の任意コードが
sandbox 外で動く脱出口になる）。

## スキーマ

```jsonc
{
  "dev-flow": {
    "ui_verify": {
      "base_port": 6100,                 // 既定 4000。1 本目の port は base_port + issue % 1000
      "ports": ["web", "api", "db"],     // 既定 ["app"]。2 本目以降は 1000 刻み。使用中なら次の空きへずらす
      "env": { "DATABASE_URL": "postgresql://...:{port.db}/postgres" },  // 全 step 共通
      "env_files": ["packages/frontend/.env"],  // main checkout から worktree へコピー（gitignored な path のみ）
      "up": [                            // 宣言順に実行。run は一回限り（exit 0 で次へ）、serve は常駐（ready で次へ）
        { "name": "install", "run": "pnpm install --frozen-lockfile", "timeout_sec": 600 },
        { "name": "db", "serve": "pglite-server --db={state_dir}/pglite --port={port.db}", "ready": { "tcp": "{port.db}" } },
        { "name": "migrate", "run": "pnpm --filter backend exec prisma migrate deploy" },
        { "name": "api", "serve": "node --import tsx src/server.ts", "cwd": "packages/backend",
          "env": { "PORT": "{port.api}" }, "ready": { "http": "http://127.0.0.1:{port.api}/health" } },
        { "name": "web", "serve": "pnpm --filter frontend dev --port {port.web}", "ready": { "log": "Ready in" } }
      ],
      "down": [ { "name": "note", "run": "echo stopped" } ],  // serve を止めた後に実行（best-effort）
      "base_url": "http://127.0.0.1:{port.web}",   // 既定 http://127.0.0.1:{port}（ports の先頭）
      "smoke_path": "/",                            // smoke で開く path（既定 /）
      "login": { "commands": [                      // smoke / scenario の前段。agent-browser の argv 配列
        ["open", "{base_url}/login"],
        ["fill", "input[name=email]", "e2e@test.local"],
        ["fill", "input[name=password]", "password123"],
        ["click", "button[type=submit]"],
        ["wait", "--url", "**/dashboard"]
      ] },
      "console_ignore": ["\\[HMR\\]", "ResizeObserver loop"],  // smoke で除外する console error（正規表現。既定あり）
      "ttl_sec": 1800,                              // teardown が来なくてもこの秒数で自ら停止（既定 1800）
      "scenarios": [ { "name": "...", "steps": ["..."], "checks": ["..."], "ac_index": 0 } ]
    }
  }
}
```

- step 共通: `name`（英字始まりの `[A-Za-z0-9_-]`、up / down 通して一意）、`cwd`（worktree 相対、既定は worktree）、
  `env`、`timeout_sec`（run 既定 600 / serve の ready 待ち既定 180）。コマンドは `bash -c` で実行する。
- `ready` は serve に必須で、次のどれか 1 つ: `http`（2xx / 3xx が返る URL）、`tcp`（port 番号）、
  `log`（その step の log にマッチする正規表現）。
- placeholder: `{port.<name>}`、`{port}`（ports の先頭）、`{state_dir}`、`{worktree}`、`{base_url}`。
  コマンド・env・ready・base_url で使える。シェルの `${VAR}` には触らない。未宣言の `{port.<name>}` は config 不正。
- 各 step には env `UI_VERIFY_STATE_DIR` / `UI_VERIFY_BASE_URL` / `UI_VERIFY_PORT_<NAME>` も渡る。
- `login.commands` は agent-browser の argv 配列の列（`--session` は dev-flow が付けるので書かない）。
  シェルを通さず宣言順に実行し、1 つでも失敗したらそこで止める。先頭に書ける subcommand はページ操作と待機だけ
  （open / click / dblclick / fill / type / press / keyboard / select / check / uncheck / hover / focus / scroll /
  scrollintoview / wait / find / back / forward / reload）。placeholder は各要素で使える。
- `console_ignore` は smoke で拾った console error / page error から除外する正規表現。
  省略時は dev モードの既知ノイズ（`[HMR]` / `[Fast Refresh]` / webpack / favicon.ico / React DevTools）。

### 旧形式（後方互換）

`install_command` / `dev_command`（`{port}` 必須）/ `cwd` / `base_port` / `ready_path` / `env_files` / `scenarios` の
旧形式はそのまま使える。`up: [{run: install_command}, {serve: dev_command, ready: {http: ready_path}}]`、
`ports: ["app"]` に変換して新形式と同じ経路（sandbox 内）で実行する。smoke は従来どおり `/` を開く。
`up` と旧形式のキーの併記は config 不正。

## 実行モデル

```
ui-verify-stack up --worktree <WT> --state-dir <WT>/.devflow-tmp/ui-verify --issue <N>
ui-verify-stack down --state-dir <WT>/.devflow-tmp/ui-verify
ui-verify-stack status --state-dir <...>
ui-verify-stack login --state-dir <...> --session devflow-<issue>[-final]
ui-verify-stack smoke --state-dir <...> --session devflow-<issue>[-final]
```

- LLM の判断が要らないところに LLM を入れない。smoke（load 成否と console error）と login は決定的な手順なので
  `ui-verify-stack` が agent-browser を直接呼び、LLM の ui-verifier は判断が要る scenario だけに使う。
  - `smoke`: login（宣言があれば）→ console / errors を clear → `open <smoke_url>` → `wait --load networkidle` →
    `errors` / `console`（level=error のみ、`console_ignore` で除外）→ `screenshot <state_dir>/smoke.png` を行い、
    ui-verifier と同じ `{ok, mode:"smoke", checks, console_errors, screenshots, summary}` を返す。
  - `login`: scenario の前段。同じ session でログインを済ませてから ui-verifier に渡す。失敗したら ui-verifier は
    呼ばず UI 検証 NG（findings）。agent-browser の session は Bash 呼び出しをまたいで残る。
- workflow の実行環境は Node API もシェルも持たないため、up / down / login / smoke の実行は exec-proxy
  （dev-runner-haiku。stdout をそのまま返すだけで判断はしない）経由になる。

- `up` は detached な supervisor を 1 本起こし、ready（全 step 完了）か失敗まで待って JSON を返す。
  返り値: `{ok, phase, base_url, smoke_url, ports, port, step?, error?, log?}`。
  `phase` は `config`（宣言不正）/ `setup`（run の失敗）/ `start`（serve が ready 前に終了）/ `ready` / `timeout`。
  dev-flow は `config` / `setup` を `setup_failed`、それ以外の失敗を `failed_open` として扱う（どちらも fail-open）。
- service は supervisor の子として各自の process group で動き、Bash 呼び出しや起動した agent が終わっても残る。
- sandbox では **別の Bash 呼び出しから kill できない**（Seatbelt が別 sandbox 実体への signal を拒否し、
  ps / pgrep / pkill も使えない）。そのため `down` は state dir に stop file を置き、supervisor が自分の子を
  process group ごと止めてから `down` steps を実行する。止まらなかった port は `leftover` で返る。
- teardown が呼ばれない場合（run の中断など）も `ttl_sec` で supervisor が自ら同じ片付けをする。
- `up` は同じ state dir に前回の stack が残っていれば先に止めてから起動する。
- log は `<state_dir>/logs/<NN>-<name>.log` と `logs/supervisor.log`、状態は `stack.json`。
