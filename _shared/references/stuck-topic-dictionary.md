# Stuck-Topic Dictionary

dev-flow の stuck 検出（planSeen / evalSeen / blockSeen）は `topicKey`（`_lib/goal-ledger.mjs`
の `dimension::lowercase + 空白圧縮` 正規化、dev-flow.js へ inline 生成）による topic 文字列の
完全一致突合である。同義語 rewrite・ハイフン / 空白ゆれで検出が漏れるため、本辞書で問題クラスを
半構造化 enum に集約する。

## 形式ルール

topic は `<problem-class>` 単独、または `<problem-class>::<詳細>` 形式で記述する。

- **problem-class**: 本辞書の enum から選ぶ。**辞書に該当クラスがあれば必ず enum 値を使う（自由作文禁止）**。
  該当なしのみ新語を kebab-case 英小文字で作る。
- **`<詳細>` suffix**: ファイルパス・関数名・AC index 等の**安定識別子**のみ（形容文を書かない）。
  topicKey は lowercase + 空白圧縮するため大小文字・連続空白の差は吸収されるが、
  kebab-case / path 表記を推奨する。
- **再利用**: 同一問題は iteration を跨いで**同じ文字列を完全一致で再利用**する。

例: `input-validation-missing::createUser`、`test-missing::_lib/goal-ledger.mjs`

## 網羅基準

3 agent（plan-reviewer / evaluator / pr-reviewer）の checklist dimension で発生しうる
問題クラスを各 1 つ以上カバーする。新クラス遭遇時は新語使用 + 本辞書への追記を提案する（append-only）。

## Fallback

辞書が読めない環境では、従来通り安定した短い文字列を自作する（stuck 検出精度は落ちるが動作は壊れない）。

## Problem-Class Enum

| problem-class | 意味 | 主な検出元 | 例 |
|---|---|---|---|
| `scope-mismatch` | 要件の過不足・スコープ逸脱（実装が AC を超える / 足りない） | plan-reviewer / evaluator | `scope-mismatch::AC-3` |
| `yagni-violation` | 投機的機能・過剰実装（YAGNI 違反） | plan-reviewer / evaluator | `yagni-violation::_lib/foo.mjs` |
| `untestable-ac` | 受入条件が測定不能・検証困難（テスト不能な AC） | plan-reviewer | `untestable-ac::AC-2` |
| `missing-file-reference` | 計画参照ファイルが実在しない | plan-reviewer | `missing-file-reference::src/bar.ts` |
| `wrong-file-target` | 変更対象ファイルの取り違え（誤ったファイルを変更） | plan-reviewer / evaluator | `wrong-file-target::dev-flow.js` |
| `file-conflict-in-parallel` | parallel task 間で file_changes が重複している | plan-reviewer | `file-conflict-in-parallel::_lib/goal-ledger.mjs` |
| `dependency-contradiction` | 依存関係の矛盾・serial / parallel 分解の不整合 | plan-reviewer | `dependency-contradiction::F2->F1` |
| `self-containment-violation` | task 記述の曖昧参照（「上述の通り」等、self-contained でない） | plan-reviewer | `self-containment-violation::F3` |
| `edge-case-unhandled` | edge case の handling 未定義 / 未実装 | evaluator / pr-reviewer | `edge-case-unhandled::empty-input` |
| `error-handling-missing` | 異常系処理の欠落（エラー時のハンドリングなし） | evaluator / pr-reviewer | `error-handling-missing::readFile` |
| `input-validation-missing` | 入力検証漏れ（null / 型 / 範囲チェック欠如） | evaluator / pr-reviewer | `input-validation-missing::createUser` |
| `security-vuln` | 脆弱性（injection・権限昇格・SSRF 等） | pr-reviewer | `security-vuln::SQL-injection` |
| `secret-exposure` | credential / 機密の露出（ハードコード・ログ出力等） | pr-reviewer | `secret-exposure::API_KEY` |
| `logic-bug` | ロジック誤り・宣言意図との不一致（誤った条件分岐等） | evaluator / pr-reviewer | `logic-bug::resolveGatePolicy` |
| `regression` | 既存挙動の破壊（後退バグ） | evaluator / pr-reviewer | `regression::classifyShape` |
| `test-missing` | テスト欠落・カバレッジ穴 | evaluator | `test-missing::_lib/goal-ledger.mjs` |
| `test-weakening` | テスト弱体化（assert 削除・skip 追加・条件緩和） | evaluator / pr-reviewer | `test-weakening::gate-policy.test.mjs` |
| `test-not-asserting` | テストが非自明な assert をしていない（常に pass する等） | evaluator / pr-reviewer | `test-not-asserting::topic-dictionary-refs.test.mjs` |
| `performance-issue` | N+1・不要ループ・計算量超過等のパフォーマンス問題 | pr-reviewer | `performance-issue::findAllFiles` |
| `naming-convention` | 命名・規約違反（kebab-case 違反・接頭辞漏れ等） | pr-reviewer / plan-reviewer | `naming-convention::TopicKey` |
