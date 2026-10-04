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
      "ttl_sec": 1800,                              // teardown が来なくても ready からこの秒数で自ら停止（既定 1800）
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

- top-level の `install_command` / `dev_command` / `ready_path` / `cwd` は受理しない（変換もしない）。
  検出したら移行先（`run` / `serve` + `ready` / step の `cwd`）を示して config 不正（`phase:"config"`）にする。

## 実行モデル

```
ui-verify-stack up --worktree <WT> --state-dir <WT>/.devflow-tmp/ui-verify --issue <N> --wait-sec 480
ui-verify-stack wait --state-dir <WT>/.devflow-tmp/ui-verify --wait-sec 480
ui-verify-stack down --state-dir <WT>/.devflow-tmp/ui-verify
ui-verify-stack status --state-dir <...>
ui-verify-stack login --state-dir <...> --session devflow-<issue>[-final]
ui-verify-stack smoke --state-dir <...> --session devflow-<issue>[-final]
```

- LLM の判断が要らないところに LLM を入れない。smoke（load 成否と console error）と login は決定的な手順なので
  `ui-verify-stack` が agent-browser を直接呼び、LLM の ui-verifier は判断が要る scenario だけに使う。
  - `smoke`: login（宣言があれば）→ console / errors を clear → `open <smoke_url>` → `wait --load networkidle` →
    `errors` / `console`（level=error のみ、`console_ignore` で除外）→ `screenshot <state_dir>/smoke.png` を行い、
    ui-verifier と同じ `{ok, mode:"smoke", checks, console_errors, screenshots, summary, env_failure?}` を返す。
    `open` が通れば load は成功なので、`wait --load networkidle` の失敗（常時 polling するページ等）は非致命として
    check を `skip` にし、理由を `evidence` に残す（`ok:true`、summary は「load ok（networkidle 待ちは失敗）」）。
  - `login`: scenario の前段。同じ session でログインを済ませてから ui-verifier に渡す。操作の失敗（セレクタが
    見つからない等）なら ui-verifier は呼ばず UI 検証 NG（findings）。agent-browser の session は Bash 呼び出しをまたいで残る。
  - 環境起因の失敗には `env_failure: true` が付き、dev-flow は findings ではなく `failed_open`（fail-open で skip）にする。
    検証できていないので raw result は evaluator に渡さない。線引きは次のとおり。

    | 区分 | 例 | 扱い |
    |------|----|------|
    | 環境起因（`env_failure: true`） | stack が無い / ready でない（ttl 切れ・down 済み）/ supervisor が居ない、agent-browser を実行できない（ENOENT / EACCES）、URL に接続できない（`net::ERR_CONNECTION_REFUSED` / `ERR_NAME_NOT_RESOLVED` / `ERR_ADDRESS_UNREACHABLE` / `ERR_ADDRESS_INVALID` / `ERR_UNSAFE_PORT` / `ERR_INTERNET_DISCONNECTED`） | `failed_open` |
    | アプリ起因 | 接続後の失敗（`ERR_EMPTY_RESPONSE` / `ERR_CONNECTION_RESET` / timeout 等）、login の操作失敗、console / page error | findings |

    接続後の失敗や timeout は変更でサーバーが応答を壊した可能性があるため、環境起因に含めない。
- workflow の実行環境は Node API もシェルも持たないため、up / down / login / smoke の実行は exec-proxy
  （dev-runner-haiku。stdout をそのまま返すだけで判断はしない）経由になる。
- agent 呼び出しの label（Final reconcile では `-final` が付く。wait は `ui-verify-wait-final#<n>`）: `ui-verify-stack`（up）/
  `ui-verify-wait#<n>`（wait）/ `ui-verify-smoke`（smoke）/ `ui-verify-login`（login）/ `ui-verify`（ui-verifier の scenario）/
  `ui-verify-teardown`（down）。telemetry は label で回数・失敗率・コストを数えるので、決定的な smoke と
  LLM を使う scenario に同じ label を付けない。

- `up` は detached な supervisor を 1 本起こし、ready（全 step 完了）か失敗まで、最長 `--wait-sec` 秒待って JSON を返す。
  1 回の Bash 呼び出し（上限 600 秒）に収めるため、まだ起動中なら停止を要求せず `phase:"starting"` を返す。
  workflow は `starting` の間 `wait` を短い exec-proxy で繰り返す。総上限 `wait_ceiling_sec` は
  up の `timeout_sec` 合計 + 60 秒で、超えたら `wait` が stop を要求して `phase:"timeout"` を返す。
  返り値: `{ok, phase, base_url, smoke_url, ports, port, wait_ceiling_sec, step?, error?, log?}`。
  `phase` は `config`（宣言不正）/ `setup`（run の失敗）/ `start`（serve が ready 前に終了）/ `starting` / `ready` / `timeout`。
- supervisor は up の途中（run の実行中・serve の ready 待ち）でも stop file と期限を見る。
  up timeout 直後の `down` で止まり、停止要求の後に残りの step は起動しない。
  期限は ready までは「起動時刻 + up_ceiling_sec + `ttl_sec`」（各 step の timeout で上限がある上の保険）、
  ready 後は「ready の時刻 + `ttl_sec`」。起動にかかった時間で検証の時間は削られない。
  dev-flow は `config` / `setup` を `setup_failed`、それ以外の失敗を `failed_open` として扱う（どちらも fail-open）。
- service は supervisor の子として各自の process group で動き、Bash 呼び出しや起動した agent が終わっても残る。
- sandbox では **別の Bash 呼び出しから kill できない**（Seatbelt が別 sandbox 実体への signal を拒否し、
  ps / pgrep / pkill も使えない）。そのため `down` は state dir に stop file を置き、supervisor が自分の子を
  process group ごと止めてから `down` steps を実行する。止まらなかった port は `leftover` で返る。
- teardown が呼ばれない場合（run の中断など）も、上の期限で supervisor が自ら同じ片付けをする。
- `up` は同じ state dir に前回の stack が残っていれば先に止めてから起動する。
- log は `<state_dir>/logs/<NN>-<name>.log` と `logs/supervisor.log`、状態は `stack.json`。
