adopted_effort: low

# mechanical exec-proxy effort A/B 実測 (issue #323, task F1)

## 結論（先頭サマリ）

- **採用値: `effort: low`**
- 4 代表ケース × `effort: low` / `effort: high` × N=5 で schema 成功率を比較した結果、
  全ケースで `low` は `high` に劣後しなかった（8 セル全て 5/5 = 100%）。
- F1 の判定ルール（「全ケースで low が high を下回らなければ low を採用」）に従い `low` を採用する。
- `dev-runner-haiku-ro` / `dev-runner-haiku`（mechanical exec-proxy 専任）へこの値を適用する。
  `dev-runner`（sonnet、fix/analyze で推論を要する）は本測定の対象外で `effort: high` 据え置き
  （architecture_decisions 通り）。

## 測定条件

| 項目 | 値 |
|------|----|
| model | `haiku`（claude-haiku-4-5, CLI `--model haiku`） |
| effort 条件 | `low` / `high`（`--settings '{"effortLevel":"low"}'` / `'{"effortLevel":"high"}'`、一時ファイルとして `.devflow-tmp/settings-{low,high}.json` に書き出して渡した） |
| N | 各ケース×各 effort で 5 回 |
| ケース数 | 4（danger-grep / diff-hash / changed-files / test 実行） |
| 総試行数 | 4 × 2 × 5 = 40 |
| 実行方法 | `env -u ANTHROPIC_API_KEY claude -p '<prompt>' --model haiku --settings <file> --disallowedTools <all tools> --output-format json`（詳細は「実行方法の制約」節参照） |
| 判定 | 各 run の `result` テキストがコードフェンス除去後に JSON としてパース可能で、期待 schema/値と一致すれば成功 |

### 4 ケースの定義（実 dev-flow.js prompt を簡約・流用）

1. **danger-grep**: `bash _shared/scripts/diff-risk-classify.sh --working-tree origin/main` の実 stdout
   （実測: `{"ok":true,"hits":[]}`）を、判定・脚色なしで verbatim 返却できるか。
2. **diff-hash**: `bash _shared/scripts/worktree-diff-hash.sh <worktree> origin/main` の実 stdout
   （実測: `{"hash":"b4b271e77c89c9b19626cd90391e3d8412c4e844","empty":false}`）を verbatim 返却できるか。
3. **changed-files**: `git status --porcelain --untracked-files=all` の実 stdout
   （実測: `.devflow-tmp/settings-{high,low}.json` の2行の `??` エントリ）から、
   ステータスコード除去・パス抽出をして `{"files": [...]}` に変換できるか。
4. **test 実行**: `node --test _lib/resolve-arg.test.mjs` の実 stdout（`tests 10 / pass 10 / fail 0`）
   から green 判定して `{"tests":"passed","green":true,"summary":"..."}` を返せるか。

## 実行方法の制約（重要 — 測定方法論の変更理由）

本 worktree の sandbox 環境下では、`claude -p` を **実際に `--allowedTools Bash` で
Bash tool を使わせて** 起動すると、以下の理由で **決定論的に失敗**することを確認した:

```
EPERM: operation not permitted, mkdir '/Users/naramotoyuuji/.claude/session-env/<uuid>'
```

これはネストした `claude -p` プロセス自身が Bash tool 実行の内部管理（cwd/env フック追跡）
のために `~/.claude/session-env/<session-id>` ディレクトリを作成しようとして発生するもので、
このディレクトリは本 worktree の sandbox write allowlist に含まれておらず、
**effort やモデルに関係なく常に失敗する**（danger-grep の実行結果ではなく、
nested Bash tool 自体の起動失敗）。この事象は以下 3 方式で回避を試みたがいずれも解消しなかった:

1. デフォルト設定のまま `--allowedTools Bash` を許可 → 上記 EPERM
2. `CLAUDE_CONFIG_DIR` を書込み可能な代替パスへ変更 → session-env の EPERM は回避できるが
   認証情報（OAuth ログイン）もそのパス配下に切り替わり `Not logged in` で失敗（トレードオフとして不採用）
3. `CLAUDE_CODE_DISABLE_WORKING_SYNC=1` / `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1` 等の
   env var toggle → 同じ EPERM が再発（この機能はこれらのフラグでは無効化されない）

`dangerouslyDisableSandbox` は policy で無効化されているため、これ以上の回避は不可能と判断した。

### 採用した代替方法論

真の「Bash tool 経由でコマンドを実行させて出力を検証する」測定はこの環境では実行不能なため、
**各ケースの実スクリプト stdout を（我々自身の非ネスト Bash で）事前に取得し、
その生テキストをプロンプトへ埋め込んで nested `claude -p`（`--disallowedTools` で
全 tool を無効化 = tool 呼び出し不要な純テキスト応答）に「そのまま整形して返せ」
と指示する** 形に変更した。これにより測定対象は「Bash 実行そのものの成否」ではなく
「exec-proxy の中核責務である "生出力を判定・脚色せず schema へ忠実に転写/整形できるか"
という認知的信頼性」に絞られる。mechanical exec-proxy が壊れる典型的な失敗モード
（コードフェンスで包む、コメントを付す、値を要約・改変する、フィールドを捏造する）は
この方法でも十分に観測可能であり、F1 が測定したい「low effort で品質劣化しないか」という
問いに対する妥当な代理指標として採用した。

**この代替法固有の制約**: Bash tool 呼び出し自体の成否（コマンド解決・実行環境の差異・
長大 stdout のストリーミング処理）は本測定の対象外である。将来 sandbox 制約が解消され
実行方法1が使えるようになった時点で、同一ケース定義を使った再測定を推奨する
（W7 の capability-bound / harness-capability-bound 分類には該当しない — これは
sandbox のファイルシステム制約であり LLM 能力とは無関係の測定インフラ制約のため、
再評価トリガは「sandbox write allowlist に `~/.claude/session-env` が追加される」
または「別環境で再測定できる」時点）。

## 結果: ケース × effort 成功率テーブル

| ケース | effort: low | effort: high |
|--------|:-----------:|:-------------:|
| case1: danger-grep（verbatim 転写） | 5/5 (100%) | 5/5 (100%) |
| case2: diff-hash（verbatim 転写） | 5/5 (100%) | 5/5 (100%) |
| case3: changed-files（ステータスコード除去 + 抽出） | 5/5 (100%) | 5/5 (100%) |
| case4: test 実行結果の green 判定 | 5/5 (100%) | 5/5 (100%) |
| **合計** | **20/20 (100%)** | **20/20 (100%)** |

参考情報（判定には使わない副次指標。同一 haiku モデルでの API 応答時間・コスト）:

| effort | 平均 API 応答時間 | 平均コスト/call |
|--------|-------------------|-----------------|
| low | 3,822 ms | $0.0081 |
| high | 3,873 ms | $0.0047 |

（応答時間はほぼ同等。コスト差はプロンプトキャッシュのヒット/ミスのばらつきによるノイズで、
effort 自体の差ではないと考えられる — token 単価は effort に依存しない。）

失敗した run: なし（0/40）。

## 採用根拠

F1 の判定ルール:「各ケース別に成功率を集計し、全ケースで low の成功率が high を下回らなければ
effort: low を採用。1 ケースでも劣後したら medium で再測定し、劣後しない最小 effort を採用する」。

今回の実測では 4 ケース全てで `low` と `high` が同率（5/5）であり、1 件も劣後していない。
したがって medium 再測定は不要で、**`effort: low` を採用**する。

## F2/F3 への申し送り

- `dev-runner-haiku-ro`（新設、read-only exec-proxy: danger-grep / diff-hash / changed-files /
  CI read 系）: `effort: low`
- `dev-runner-haiku`（write/Skill 系 exec-proxy 専任、mechanical 実行が主）: `effort: low`
- `dev-runner`（sonnet、fix/analyze で推論を要する）: 本測定の対象外。`effort: high` 据え置き
  （architecture_decisions の既定通り、変更なし）
