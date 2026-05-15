# CI Skip Recipe (dev-flow child-split mode)

`dev-flow --child-split` で生成される child PR は `integration/issue-*` を base
として draft で開かれる。これらの中間 PR で全 CI を走らせると、N child × N
workflow で実行時間が爆発する。本 recipe は **child PR の CI を抑え、最終
integration → dev/main PR でのみ full CI を走らせる** ための GitHub Actions
設定例を配布する。

## 推奨パターン

### Pattern A: draft + integration base の両方で skip

最もシンプルかつ堅牢。

```yaml
# .github/workflows/ci.yml
on:
  pull_request:
    branches: [main, dev]      # ① final integration PR の base のみ trigger
  push:
    branches: [main, dev]

jobs:
  test:
    if: github.event.pull_request.draft == false  # ② draft をスキップ
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

- ① `branches: [main, dev]` で `integration/issue-*` 宛 PR が trigger
  されないようにする (child PR は CI skip)
- ② 万一 draft の最終 PR が trigger された場合のセーフネット

### Pattern B: pull_request_target を使わない場合の fallback

`on.pull_request.branches` が使えない構成では、job 側 `if` のみで skip:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  test:
    if: |
      github.event.pull_request.draft == false &&
      !startsWith(github.event.pull_request.base.ref, 'integration/')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

### Pattern C: paths-ignore を併用

light な smoke test だけは child PR でも走らせたい場合:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  smoke:
    # smoke は draft / integration でも走る (軽量、早期 fail 検出用)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run smoke

  full-test:
    if: |
      github.event.pull_request.draft == false &&
      !startsWith(github.event.pull_request.base.ref, 'integration/')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

## チェックリスト

各 repo の CI workflow に以下のいずれかを適用:

- [ ] Pattern A: `on.pull_request.branches: [main, dev]`
- [ ] Pattern A: job-level `if: github.event.pull_request.draft == false`
- [ ] (代替) Pattern B: job-level `!startsWith(...base.ref, 'integration/')`
- [ ] required check 設定を見直し、`integration/*` base での緑が必要な
      check は最終 PR でだけ要求するよう調整

## 補足

- night-patrol が作る `nightly/*` base も基本同じ扱い (auto-merge-guard.sh が
  許可する base 集合は `integration/issue-*` / `nightly/*` の両方)
- ただし nightly は autonomous patrol 専用で、人間レビューを通さずに
  `--admin` merge する設計のため、CI は最低限必要 (smoke 等)。本 recipe は
  child PR (= integration 宛) の draft skip を主目的とする。

## 関連スキル

- [`dev-flow --child-split`](../dev-flow/SKILL.md) - 本フローの呼び出し元
- [`auto-merge-guard.sh`](../_lib/scripts/auto-merge-guard.sh) - admin merge の base 制限
- [`integration-branch.sh`](../_lib/scripts/integration-branch.sh) - integration branch helper
- [`git-pr --draft`](../git-pr/SKILL.md) - child PR を draft で作成
