# issue #433 AC-3: park 済み malformed journal の replay 記録

対象: `~/.claude/journal/pending/malformed/devflow-411-*.json`

## devflow-411-1784690841.json

- **元の parse error**: `jq -e .` → `jq: parse error: Objects must consist of key:value pairs at line 1, column 5106`
- **崩壊パターン**: `telemetry.vdelta_verdicts` 配列内、各 verdict エントリの境界（`{"ac":"AC-1",...}` から次の `{"ac":"AC-2",...}` への遷移、および AC-2 → AC-4 への遷移）で、本来 2 個であるべき closing brace（`anchors` object の close + `verdict` 内側 root object の close）の直前に、余分な closing brace が 1 個混入していた。
  - 実際のバイト列（AC-1 → AC-2 境界、byte offset 5100 付近）: `--raw\"}"}},{"ac":"AC-2"`
  - 期待されるバイト列: `--raw\"}"},{"ac":"AC-2"`（`}}` ではなく `}` 1 個で `verdict` wrapper object を閉じてから次エントリへ）
  - 同一パターンが AC-2 → AC-4 の境界にも存在（`--raw\"}"}},{"ac":"AC-4"`）
  - 対照として AC-4 → AC-6、および AC-6 → 配列末尾の境界（pretty-print された verdict を含む）は同パターンの余分な brace が無く、正しい構造だった（jq がエラーを検出したのは最初に出現した AC-1→AC-2 境界の时点のみ）
- **修復試行**: 1 回で成功（3 回試行の上限内）。上記 2 箇所の余分な `}` を機械的に除去（テキスト置換、`$TMPDIR` 内の作業用コピーに対して実施）。
- **semantic 検証**: `jq -r '.skill'` → `dev-flow`、`.outcome` → `success`（enum 内）、`.telemetry | type` → `object`。`vdelta_verdicts` は AC-1/AC-2/AC-4/AC-6 の 4 件を保持したまま。
- **disposition**: replayed to `devflow-411-effect-a040a243c65242ac.json`（`~/.claude/journal/pending/`）。F1 と同一の finalize 手順（`jq -e` 検証 → pending 内 dot-prefix mktemp → cp → sha256 先頭16桁を effect-ID として mv -f）で回収。元の malformed ファイルは `rip` で破棄済み（復元可能）。Stop hook (`stop-devflow-telemetry.sh`) が次回セッション終了時に journal へ flush する。本 task は pending 到達までを回収成立の範囲とし、flush 完了までは待たない。

## devflow-412-1784711720.json

対象外（別事象）。本 issue のエスケープ崩壊とは無関係の park 済みファイル（内容は valid JSON `{"skill":"dev-flow","outcome":"failure"}`）。触っていない。
