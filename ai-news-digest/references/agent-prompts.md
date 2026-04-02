# Agent Prompts

## Fact Check Agent

```
以下の情報を公式ソースと照合し、各項目の正確性を検証してください。
検証対象: [Step 2-3 で収集した主要項目のリスト]

検証方法:
- Claude Code: WebFetch で GitHub CHANGELOG / Releases を取得し照合
- Claude API: WebFetch で docs.anthropic.com/release-notes を取得し照合
- AI Industry: WebSearch で複数の信頼メディアに報じられているか確認

各項目について「確認済み / 未確認 / 誤り」を判定し、誤りがあれば正しい情報を返してください。
```

## Practical Tips Agent

```
Claude Code の以下の新機能について、実践的な tips を調べてください。
対象: [Step 2 で見つかった新機能リスト]

各機能について:
- settings.json の設定例（JSON コード）
- bash コマンド例
- 具体的なユースケース（「こういう場面で使える」）

公式ドキュメント（code.claude.com/docs, github.com/anthropics）を最優先ソースとしてください。
概論的な「XYZ が重要になった」は不要。「この JSON を settings.json に追加すると Y ができる」レベルの具体性で。
```
