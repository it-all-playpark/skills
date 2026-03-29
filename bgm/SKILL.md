---
name: bgm
description: |
  動画にBGMを追加。ロイヤリティフリー音源の選定、FFmpegミキシング、音量バランス調整、フェード効果に対応。
  Use when: (1) 動画にBGMを追加したい, (2) ナレーションとBGMの音量バランスを調整したい,
  (3) keywords: BGM, 背景音楽, ミキシング, 音量調整, フェード, background music
  Accepts args: [動画タイプ: epic|corporate|upbeat|ambient]
---

# BGM スキル

動画にBGMを追加し、ナレーションとの音量バランスを最適化する。

## Usage

```
/bgm [epic|corporate|upbeat|ambient]
```

## Workflow

```
1. 動画タイプ確認 → 2. BGM選定 → 3. 音量決定 → 4. ミキシング → 5. 正規化 → 6. 動画統合
```

| Step | Action | 完了条件 |
|------|--------|---------|
| 1 | 動画タイプとナレーション密度を確認 | タイプ・密度が決定 |
| 2 | フリー音源サイトからBGM選定 | BGMファイル取得済み |
| 3 | 音量パラメータ決定 | volume値が確定 |
| 4 | `scripts/process-bgm.sh` でミキシング | ミックス音声生成 |
| 5 | `scripts/normalize-audio.sh` で正規化 | ラウドネス統一 |
| 6 | Remotion または FFmpeg で動画に統合 | 最終出力完成 |

## Step 1-2: BGM 選定

動画タイプに合った BGM をフリー音源サイトから選ぶ。動画の長さ以上の BGM を優先選択。

詳細: [音楽素材と選び方](references/music-sources.md)

## Step 3: 音量パラメータ決定

ナレーション密度に応じて BGM 音量を決定:

| ナレーション密度 | BGM volume |
|-----------------|-----------|
| 高（>70%） | 0.05 |
| 中 | 0.08-0.10 |
| なし | 0.25-0.40 |

詳細: [音量バランスガイド](references/volume-guide.md)

## Step 4-5: ミキシングと正規化

```bash
# BGM処理 + ミキシング
$SKILLS_DIR/bgm/scripts/process-bgm.sh <bgm> <voiceover> <output> [duration] [volume] [fade]

# ラウドネス正規化
$SKILLS_DIR/bgm/scripts/normalize-audio.sh <input> [output]
```

FFmpeg の詳細オプション: [FFmpeg ガイド](references/ffmpeg-guide.md)

## Step 6: 動画統合

Remotion で動的音量制御を使う場合: [Remotion ガイド](references/remotion-guide.md)

## References

- [音楽素材と選び方](references/music-sources.md) - フリー音源サイト、スタイル選定、BGM長さ
- [音量バランスガイド](references/volume-guide.md) - 音量設定表、決定フロー、テスト方法
- [FFmpeg ガイド](references/ffmpeg-guide.md) - ミキシングコマンド、動的音量、サイドチェーン
- [Remotion ガイド](references/remotion-guide.md) - 動的音量コンポーネント、スムーズトランジション
