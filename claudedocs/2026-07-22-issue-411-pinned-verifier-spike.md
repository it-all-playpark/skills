# issue #411 (epic #390 Phase 3) spike: pinned verifier feasibility — AC-3

## 0. スコープ

本 spike の AC は「PR から変更不能な verifier のみが `trusted-environment` を取得できることを、
Check Run または署名 receipt の最小経路で実証する」こと。dev-flow への配線は行わない（配線は
epic #390 Phase 5 の Go/No-Go 後）。実証物は非配線 prototype
`_shared/scripts/evalseal-verify.mjs` + テスト `_shared/scripts/evalseal-verify.test.mjs`。

以降、「agent write 圏」= このリポジトリ内で PR/agent が commit・push・書き込みできる範囲
（worktree・repo tree 全体）を指す。「圏外」= その範囲の外にあり PR からは触れない場所
（別ホスト・別 repo・secrets store・ローカル tmpdir 等）。

## 1. 3 方式比較

### (A) GitHub App による Check Run

GitHub App を登録し、PR の head SHA に対して App の秘密鍵で署名された Check Run を作成する。
Check Run の `conclusion` を pinned verifier の判定として扱う。

- **agent write 圏の境界**: App の private key は GitHub App 管理画面でのみ発行・回転でき、
  リポジトリ内のどのファイルにも存在しない。PR 作成者（agent 含む）が Check Run を偽造するには
  App 自体の秘密鍵か installation token が要る。境界は明確に repo 外。
- **必要な外部インフラ**: GitHub App 登録（Organization owner 権限）、App の webhook endpoint
  （常時稼働する server or serverless function）、installation の許可、秘密鍵の安全な保管・
  ローテーション運用。ローカル環境だけでは feasibility を実証できない（webhook を受ける
  endpoint が要る）。
- **強み**: `mergeStateStatus` / required check として GitHub 標準機能に統合でき、
  branch protection と自然に噛み合う。verifier 判定が GitHub の一次データ（Check Run API）に
  なるため、後から改竄されたかどうかの検証を GitHub 自体に委ねられる。
- **弱み**: 本 spike のようにローカル完結で最小経路を即座に実証することができない
  （App 登録・webhook endpoint のデプロイが前提条件になる）。障害点が増える（App のダウン、
  webhook 配送失敗、installation 権限剥奪）。

### (B) 別 repo の immutable reusable workflow

verifier ロジックを別 repo（本 repo からは書き込めない）の reusable workflow として実装し、
本 repo の CI から `uses: other-org/verifier-repo/.github/workflows/verify.yml@<pinned-sha>`
の形で SHA pin して呼び出す。

- **agent write 圏の境界**: reusable workflow 本体（別 repo・SHA pin）は agent write 圏の外。
  しかし **呼び出し側の workflow file は本 repo 内にあり PR で改変可能**という穴がある —
  PR が呼び出し元の `uses:` 行の pin を書き換える、または呼び出し元 job の前段に
  verifier の判定結果を上書きする step を差し込めば、verifier 自体は不変でも
  「verifier を呼ぶかどうか」「verifier の結果をどう扱うか」を PR 側が制御できてしまう。
  境界が「verifier ロジック」と「verifier の呼び出し・結果の扱い」に分裂しており、
  後者が repo 内に残る限り完全な圏外化にならない。
- **必要な外部インフラ**: 別 repo の作成・維持、SHA pin の運用（更新時に pin を手動で
  progress させる必要があり、stale pin の検出も別途要る）。
- **強み**: (A) ほど外部インフラが重くない（既存 GitHub Actions の枠組みだけで完結）。
  reusable workflow 自体は改変不能という点は真。
- **弱み**: 呼び出し側 workflow file が PR 可変という穴が本質的（`.github/workflows/*.yml`
  も repo 内ファイルであり、agent write 圏に含まれる）。この穴を塞ぐには呼び出し側も
  branch protection で「特定 path の変更は別途 required review」等の追加ガードが要り、
  「pinned verifier だけで完結する」という前提が崩れる。

### (C) 外部 pinned 鍵による署名 receipt（本 spike で採用）

verifier（PR から独立した外部主体）が秘密鍵で receipt に対して ed25519 署名し、
署名検証側は「公開鍵が agent write 圏の外にあるか」を tamper 境界の判定基準にする。

- **agent write 圏の境界**: 公開鍵ファイルの実体パス（`realpath`）が repo-root 配下に
  **無い**ことをもって圏外と判定する。秘密鍵は最初から repo に一切存在しない
  （keygen で外部の tmpdir/secrets store に生成する想定）。
- **必要な外部インフラ**: なし（feasibility の実証段階では）。本番配線時は鍵の配布・
  ローテーション・失効の運用が必要になるが、それは Phase 5 以降の課題であり spike の
  ブロッカーではない。
- **強み**: 外部サーバー・別 repo・webhook を一切必要とせず、**ローカルで
  end-to-end 実証できる**。`_lib/trust-schema.mjs` の `resolveTrustLevel({verifier:
  'external-pinned', tamper_evident: true})` という Phase 1 で既に定義済みの語彙と
  直結する（Phase 1 は「決定ロジックの語彙」を固定しただけで、決定に使う実データを
  誰が持ち込むかは Phase 3 の課題だった。本 spike がその実データ供給源の最小形）。
  署名は receipt の内容（`canonicalJsonBytes`）に対して行うため、receipt の
  1 byte でも改竄されれば署名検証が落ちる（tamper-evidence が構造的に成立する）。
- **弱み**: 「公開鍵ファイルの物理的な置き場所」だけが境界の根拠であり、CI 環境で
  鍵をどこに置くか（secrets store・別マシン・HSM 等）の運用設計は本 spike の範囲外。
  Check Run のような GitHub 一次データとの統合はなく、receipt は自前の JSON ファイルで
  あり、改竄不能な「置き場所」（例: GitHub の別 API・外部 KMS）は別途要検討。

### 選定根拠

3 方式とも「agent write 圏の外に判定の根拠を置く」という設計原理は共通するが、
(A)(B) は外部インフラ（App registration・webhook server、または別 repo・SHA pin 運用）
を前提としており、ローカル環境だけでの feasibility 実証が事実上不可能だった。
(C) は Phase 1 の `resolveTrustLevel` 語彙をそのまま使い、鍵の物理的な置き場所という
単一の変数だけで「圏外か圏内か」を可変にでき、テストで両方のケース
（圏外 → `trusted-environment`、圏内 → `advisory`）を同一プロセス内で再現できる。
このため本 spike は (C) を採用し、(A)(B) は Phase 5 以降で CI 統合方式を選定する際の
比較材料として文書化のみ行う。

## 2. `evalseal-verify.mjs` の実測結果

実装: `_shared/scripts/evalseal-verify.mjs`（非配線 prototype）。
テスト: `_shared/scripts/evalseal-verify.test.mjs`（vitest、9 test、全て pass）。

実行コマンドと結果:

```
$ node node_modules/.bin/vitest run --configLoader runner _shared/scripts/evalseal-verify.test.mjs

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

### ケース要約

| ケース | 条件 | 結果 |
|--------|------|------|
| keygen | `--out-dir` に `.key`(PKCS8 PEM) / `.pub`(SPKI PEM) を生成 | `ok:true` + 両ファイル生成を確認 |
| (a) 正常系 | 鍵が repo 外 pinned dir、署名有効、schema 合格 | `trust_level:'trusted-environment'`, `reason:'ok'` |
| (b) receipt 改竄 | `outcome.verdict` を書き換え、`receipt_id` は攻撃者が改竄後の内容で再計算し自己整合させる（schema は通す） | `trust_level:'advisory'`, `reason:'invalid-signature'`（署名は元 bytes に対するものなので改竄後 bytes と不一致） |
| (c) 別鍵で署名 | verify 時の pubkey とは異なる鍵ペアで sign したシグネチャ | `trust_level:'advisory'`, `reason:'invalid-signature'` |
| (d) **AC-3 の核心** | 鍵自体は正当・署名も有効・schema も合格だが、公開鍵ファイルを `--repo-root` 配下に **複製**（= agent write 圏内に鍵が存在する状態を模擬） | `trust_level:'advisory'`, `reason:'pubkey-inside-repo'`（他条件が全て正当でも圏内なら trusted-environment に到達しない） |
| (e) schema 不正 | `_lib/fixtures/trust/adversarial-schema-invalid.json` をそのまま receipt として検証 | `trust_level:'advisory'`, `reason:'schema-invalid'` |
| (f) canonical 決定論 | 同一 receipt を top-level / nested object の key 挿入順序だけ入れ替えた JSON ファイルに対し、元の署名で検証 | `trust_level:'trusted-environment'`, `reason:'ok'`（`canonicalJsonBytes` の key sort により bytes が一致） |
| CLI usage | 未知サブコマンド／`verify` の必須引数欠落 | usage を stderr 出力 + exit 1 |

(d) が AC-3 の核心実証: 署名の正当性・receipt の schema 合格という他の条件が全て
満たされていても、公開鍵の物理的な置き場所が agent write 圏内（repo-root 配下）に
あるというただ一点だけで `trusted-environment` への到達が構造的に遮断される。
`evalseal-verify.mjs` の `runVerify` は `trust_level:'trusted-environment'` を返す
`return` 文を 1 箇所しか持たず、(i)(ii)(iii) の 3 条件を全て通過した経路以外は
必ず `resolveTrustLevel({verifier:'same-harness'})`（= `'advisory'`）を返す
`advisory()` ヘルパーに収束する（他経路で `'trusted-environment'` を出力するコード
パスを作っていない）。

## 3. 残課題（Phase 5 以降）

- **鍵配布**: CI 環境（GitHub Actions runner）で pinned 秘密鍵をどこに保管し、
  署名処理をどこで実行するか。runner 上に秘密鍵を置けば runner 自体が agent write
  圏に片足を突っ込むため、署名処理自体は runner の外（別サービス・別マシン・
  外部 KMS 呼び出し）で行う設計が必要。
- **鍵失効**: 秘密鍵が漏洩した場合のローテーション・失効手順、失効した鍵で署名された
  過去 receipt の扱い（`trusted-environment` から `advisory` へ格下げする再検証フロー）。
- **Check Run 化する場合の App 設計**: (A) を採用する場合、App 登録・webhook endpoint・
  installation 権限のスコープ設計、Check Run の `conclusion` と本 EvalSeal receipt の
  対応付け（Check Run 自体を receipt の代替にするか、receipt を Check Run の
  output に添付するか）。
- **公開鍵の配布経路自体の tamper-evidence**: 現状 `--pubkey-file` の中身が「本当に
  pinned verifier のものか」は呼び出し側が信頼する前提（差し替えられた偽の pubkey を
  渡されれば偽の署名でも `trusted-environment` になり得る）。本番配線では公開鍵自体を
  agent write 圏外の固定 URL・KMS 参照 digest 等で pin する必要がある。

### Phase 5 昇格条件（W7 capability-bound 的 sunset）

AGENTS.md W7 節の `gate_policy` 系 capability-bound distrust 機構と同様の考え方を
pinned verifier の実運用昇格にも適用する。以下が実証されるまでは shadow/advisory 固定
とし、`trusted-environment` を dev-flow の gating 判断に用いない:

- **2x2x2 dogfood**: 少なくとも 2 リポジトリ × 2 CI 環境（例: GitHub-hosted runner と
  self-hosted runner）× 2 鍵ローテーションサイクルを跨いで、鍵配布・失効・署名検証の
  運用が実障害なく回ることを実地で確認する。
- **calibration 実証**: W6b の calibration monitor が pinned verifier receipt の
  `trusted-environment` 判定と実際の tamper 有無（意図的な adversarial テスト含む）の
  一致率を計測し、偽陽性（改竄されたのに `trusted-environment` になる）が実質ゼロで
  あることを実証する。

この 2 条件が揃うまでは、Phase 3 の EvalSeal receipt は現行どおり
`resolveTrustLevel({verifier:'same-harness'})`（`advisory`）のみを出力し続け
（`_shared/scripts/evalseal-seal.mjs` は `'trusted-environment'` を出力する分岐・
CLI オプションを一切持たない）、本 spike の pinned verifier 経路は実装方式の
比較材料としてのみ存在する。
