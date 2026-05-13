# Behavioral / Causal Claims — `behavioral_claims` カテゴリ ガイドライン

`blog-fact-check` skill の `behavioral_claims` カテゴリの検出原理・verify 手順・ヘッジ表現・除外ルールを記載する。

## 背景

既存カテゴリは「対象（noun）の正しさ」を検証する（数値・バージョン・日付・料金・URL liveness など）。
一方、LLM writer が generate しやすい hallucination の中には「**動作・因果関係（verb / mechanism）**」を捏造するタイプがある。

典型例（issue #76 より）:

> `curl` を実行すると permission deny で 403 が返ってきます。subagent はそれを 200 と虚偽報告します。

`curl` / `permission deny` / `subagent` / `403` / `200` の**個別 noun はすべて実在**するが、因果連鎖（permission deny は Bash 実行自体をブロックするため HTTP ステータスは返らない）が**捏造**されている。各 noun は実在するため `statistics` / `urls` / `entities` 等の既存検査をすり抜ける。

このような claim を抽出してフラグ立てし、**human/orchestrator が一次ソース（公式 doc / commit body / 実装ファイル / 実測ログ）で verify する**ためのカテゴリが `behavioral_claims`。

---

## パターン一覧 (BC1〜BC5)

検出は「**パターン正規表現マッチ** + **同一文に fabrication-signal トークンが 1 個以上存在**」の AND 条件。
パターンだけでは plain な技術解説文（factually correct）も hit するため、signal 共起を必須化することで precision を確保する。

検出単位は **1 文** (句点 `。` または空行で区切る)。コードブロック (``` ``` ```)・blockquote (`>`) ・YAML frontmatter は除外。

**実装上の注意**: macOS BSD `grep -E` の `[^[:space:]]+` は multi-byte (日本語) 文字との
マッチが不安定なため、各パターン正規表現の前方アンカーは省略し、`.*` で sentence 内のどこに
出てもマッチするようにしてある。precision は signal 共起 AND 検査と sentence 単位の区切り
(`。` または空行) で確保している。

### BC1: 結果型「〜すると〜になる」「〜したら〜が返る」

実行・呼び出し・発行 等の動作と「なる / 返る / 出る / 起きる」の結末をつなぐ言い方。
凝縮形 (`を呼び出すと` / `を実行すると` 等) と分解形 (`を呼び出 ... すると`) の双方を拾う。

```
((を実行する?と|を呼び出す?と|を叩くと|を投げると|を打つと|に渡すと|を発行すると|を呼ぶと).*(になる|になります|が返る|が返ります|を返す|を返します|が出る|が出ます|が起きる|が起きます|が返って|が返って?きます|が出て|が起こり|が走る|が走ります|が呼ばれる|が呼ばれます))
|((を実行|を呼び出|を叩|を投げ|を打|に渡|を発行).*(すると|したら).*(になる|になります|が返る|が返ります|を返す|を返します|が出る|が出ます|が起きる|が起きます|が返って|が返って?きます|が出て|が起こり))
|((すると|したら).*(が返って|が返り|が返る|を返す|を返し|が出る|が出ます|が起き|になり))
```

- Positive: 「`curl` を実行すると 403 が返ります。」(BC1 + signal `403` / `` `curl` ``)
- Positive: 「`bind()` を呼び出すと EADDRINUSE が返ります。」(BC1 凝縮形 + signal `EADDRINUSE`)
- Negative: 「設定を変更すると挙動が変わる場合もあります。」(BC1 マッチするが signal なし → drop)

### BC2: 実行→内部動作「〜を実行すると〜が走る／呼ばれる／起きる」

```
(を実行|を呼び出|を発火|を trigger).*(が走る|が走ります|が呼ばれる|が呼ばれます|が起動する|が起動します|が発火する|が発火します)
```

- Positive: 「`PreToolUse` を実行すると hook が呼ばれます。」(BC2 + signal `PreToolUse`)
- Negative: 「Step 1 を実行すると Step 2 が呼ばれます。」(signal なし → drop)

### BC3: 内部実装「〜は内部で〜を返す／受け取る／実行する」

`内部で / 裏側で / 内部的に` を**必須**にすることで「実行スキルは `--task-id` を受け取り」のような plain な技術解説文を構造的に drop する。

```
(は|では).*(内部で|裏側で|内部的に).*(を返す|を返します|を受け取る|を受け取ります|を実行する|を実行します|を発行する|を発行します|を投げる|を投げます|を返して|を返し)
```

- Positive: 「DNS resolver は内部で UDP port 53 にクエリを投げます。」(BC3 + signal `port 53`)
- Negative: 「実行スキルは `--task-id` と `--flow-state` を受け取ります。」(`内部で` 不在 → drop)

### BC4: 原因型「〜が原因で〜が起きる」「〜により〜される」

```
(が原因で.*(が起きる|が起きます|が発生する|が発生します|が起き|が発生し))
|((により|によって).*((が|を).*(発生|起動|終了|kill|abort)(される|されます)?|される|されます|を返す|を返します|abort される|kill される))
```

- Positive: 「`SIGTERM` により nginx プロセスが終了されます。」(BC4 + signal `SIGTERM`)
- Negative: 「この『単一ライター設計』により、競合状態を構造的に防ぎます。」(signal なし → drop)

### BC5: 場所＋呼出「〜では〜が呼ばれる」

`では` は頻出するため signal 共起検査の比重が特に大きい。

```
(では).*(が呼ばれる|が呼ばれます|が走る|が走ります|がフック(される|されます))
```

- Positive: 「`PostToolUse` では cleanup hook が呼ばれます。」(BC5 + signal `PostToolUse`)
- Negative: 「弊社では Slack が使われています。」(signal なし → drop)

---

## Fabrication-signal トークン

文中に**少なくとも 1 個**含まれていることを必須要件とする。すべて ERE で記述、grep -E 互換。

| Signal class | 検出ターゲット | 例 |
|--------------|---------------|----|
| HTTP status code | allowlist (200/201/204/301/302/304/400/401/403/404/405/410/422/429/500/502/503/504) | `403`, `429`, `502` |
| Exit code / signal name | `EXIT`, `SIGKILL`, `SIGTERM`, `SIGHUP`, `SIGINT`, `SIGQUIT`, `SIGPIPE`, `SIGABRT`, `SIGSEGV`, `SIGUSR1`, `SIGUSR2`, `EADDRINUSE`, `EACCES`, `ENOENT`, `ETIMEDOUT`, `EPIPE` | `SIGTERM`, `EADDRINUSE` |
| Command identifier | バックティック `` ` `` で囲まれた英数字 + 内部に `-` / `_` / `/` / `.` を含む識別子 | `` `curl` ``, `` `--task-id` ``, `` `permissions.deny` `` |
| Env / config / namespace | `NODE_ENV`, `HTTP_PROXY`, `PATH`, `HOME`, `PWD`, `XDG_*`, `CLAUDE_*`, `GITHUB_*`, `AWS_*`, `DB_*` | `NODE_ENV`, `CLAUDE_PROJECT_DIR` |
| Network / protocol element | `TCP`, `UDP`, `TLS`, `SSL`, `DNS`, `gRPC`, `WebSocket`, `RST`, `FIN`, `SYN`, `ACK`, `HTTP/2`, `port <数字>` | `TCP RST`, `port 53` |
| Version-pinned product | `<大文字始まり製品名> <セマバー>` (例: `Node.js 20.10`, `MySQL 8.0`) | `MySQL 8.0` |
| Claude Code lifecycle | `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification` | `PreToolUse` |
| Numeric + unit | `\d+(\.\d+)?` + `ms / sec / 秒 / 分 / MB / GB / KB / %` | `500ms`, `30秒`, `200MB` |

---

## verify 方法

flag された claim は orchestrator / writer が以下の優先順位で一次ソースを参照して verify する。

1. **公式 doc**（プロジェクト公式サイト・README・API リファレンス・RFC）
2. **commit body / changelog**（リリース notes / コミットメッセージ）
3. **実装ファイル**（OSS なら該当関数・hook のソース）
4. **実測ログ** (`man` / `curl --verbose` / `strace` / `lsof` 等の出力)
5. **論文・公式 blog**（HTTP / TCP / DNS など標準仕様系）

**verify できない場合の選択肢**:

- 削除する
- ヘッジ表現に書き換える（後述）
- 一次ソース URL を本文中に添える
- 「実測したわけではないが」「ドキュメント上は」式の前置きを付ける

⚠️ **auto-fix は厳禁**。verify できていない因果主張を別の verify されていない因果主張に書き換えると、フィクションを別のフィクションに置き換える結果になる。

---

## ヘッジ表現の例

verify が完全でない場合、以下のような hedging で「主張」を「観察 / 推測」に弱める。
detect 側はこれらの表現を含む sentence を**抽出対象から除外**する。

| 不適切 (確定主張) | 推奨 (ヘッジ) |
|------------------|--------------|
| 「`curl` を実行すると 403 が返ります」 | 「permission deny の Bash 実行は `curl` 自体が起動せず、HTTP リクエストは送られないと思われます」 |
| 「`SIGTERM` により nginx プロセスが終了されます」 | 「`SIGTERM` を受け取ると graceful shutdown を試みる nginx の挙動が公式 doc に記載されています」 |
| 「`PostToolUse` では cleanup hook が呼ばれます」 | 「`PostToolUse` で cleanup を行う設定例が公式 doc に紹介されています」 |

検出側で**ヘッジ判定**として除外するトリガ語:

- `かもしれな(い|ません)`
- `得る` / `うる`
- `と思われ(る|ます)`
- `ではないか`
- `でしょうか` / `ますか[？?]` / `ですか[？?]`（疑問形）
- `〜場合があ(る|ります)`
- `〜することがあ(る|ります)`
- `〜することができ(る|ます)`
- `〜することもあ(る|ります)`

---

## 除外ルール（false positive 抑制）

`extract-behavioral-claims.sh` は以下を抽出対象から構造的に除外する:

1. **YAML frontmatter** (`---` ... `---` で囲まれた先頭ブロック)
2. **コードブロック** (``` ``` ``` または `~~~`)
3. **blockquote** (`>` で始まる行) — 引用ブロックは「他者発言の引用」なので writer の主張ではない
4. **疑問形 / 仮定形 / ヘッジ表現** (上表のトリガ語)
5. **signal トークンを 1 個も含まない sentence** — pure regex マッチだけでは hit させない
6. **空行 / frontmatter 終了前の line** — 解析対象に含まれない

### 除外しない / 検出する代表例

- 普通の地の文中に書かれた挙動主張で、signal トークンを含むもの
- inline code (`` `…` ``) 内に signal がある場合は signal として認識する（コードブロック全体は除外、inline は地の文の一部）

---

## 検出後の運用フロー

1. `extract-behavioral-claims.sh <mdx>` を実行し JSON を取得
2. `claims[]` が 0 件なら問題なし
3. 1 件以上ある場合、writer / orchestrator が claim 単位で **一次ソース** を参照して verify
4. verify 通過 → そのまま公開
5. verify 失敗または不能 → 削除 or ヘッジ書き換え（auto-fix は禁止）

JSON 出力 schema:

```json
{
  "file": "/abs/path/to/article.mdx",
  "claims": [
    {
      "line": 122,
      "text": "`curl` を実行すると 403 が返ります。",
      "pattern_id": "BC1",
      "signal_tokens": ["403", "`curl`"],
      "extra_patterns": [],
      "surrounding_context": ""
    }
  ]
}
```

| Field | 型 | 説明 |
|-------|----|------|
| `line` | int | sentence 先頭が出現する MDX の 1-based 行番号 |
| `text` | string | sentence 本文（句点を含む元の表現） |
| `pattern_id` | string | first-match パターン (`BC1` / `BC2` / `BC3` / `BC4` / `BC5`) |
| `signal_tokens` | string[] | 検出された fabrication-signal トークン (unique sorted) |
| `extra_patterns` | string[] | 同一 sentence にマッチした他の pattern_id (BC1 が first-match なら BC2-5 のうち hit したもの) |
| `surrounding_context` | string | 将来の拡張用 (現在は空文字列) |
