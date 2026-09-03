# FFmpeg BGM ミキシングガイド

## 基本ミキシング（ナレーション優先）

```bash
# BGM とナレーションを混合、BGM 音量を下げる
# ナレーション密な場合は volume=0.05 推奨
ffmpeg -i voiceover.mp3 -i bgm.mp3 \
  -filter_complex "[1:a]volume=0.05[bgm];[0:a][bgm]amix=inputs=2:duration=first[out]" \
  -map "[out]" mixed_audio.mp3
```

## フェードイン/フェードアウト付き

```bash
# BGM にフェードイン 3 秒、フェードアウト 3 秒
ffmpeg -i voiceover.mp3 -i bgm.mp3 \
  -filter_complex "
    [1:a]volume=0.05,afade=t=in:st=0:d=3,afade=t=out:st=82:d=3[bgm];
    [0:a][bgm]amix=inputs=2:duration=first[out]
  " \
  -map "[out]" mixed_audio.mp3
```

## 完全な処理パイプライン

```bash
# 1. BGM 処理（ループ、フェード、音量調整）
ffmpeg -stream_loop -1 -i bgm_original.mp3 \
  -t 85 \
  -af "volume=0.05,afade=t=in:st=0:d=3,afade=t=out:st=82:d=3" \
  bgm_processed.mp3

# 2. ナレーションと BGM をミックス
ffmpeg -i voiceover.mp3 -i bgm_processed.mp3 \
  -filter_complex "[0:a][1:a]amix=inputs=2:duration=first[out]" \
  -map "[out]" final_audio.mp3

# 3. ラウドネス正規化
ffmpeg -i final_audio.mp3 \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
  final_audio_normalized.mp3
```

## シーン別動的音量

```bash
# aeval でシーンごとの音量を動的制御
# オープニング(0-8s): 0.15, 本編(8-72s): 0.05, エンディング(72-85s): 0.12
ffmpeg -i voiceover.mp3 -i bgm.mp3 \
  -filter_complex "
    [1:a]volume='if(lt(t,8),0.15,if(lt(t,72),0.05,0.12))':eval=frame,
    afade=t=in:st=0:d=3,
    afade=t=out:st=82:d=3[bgm];
    [0:a][bgm]amix=inputs=2:duration=first[out]
  " \
  -map "[out]" mixed_audio.mp3
```

## サイドチェーンコンプレッション（上級）

ナレーション検出時に自動で BGM を下げる:

```bash
ffmpeg -i voiceover.mp3 -i bgm.mp3 \
  -filter_complex "
    [0:a]asplit=2[vo][vo_sidechain];
    [1:a]volume=0.3[bgm];
    [bgm][vo_sidechain]sidechaincompress=threshold=0.02:ratio=8:attack=50:release=500[bgm_ducked];
    [vo][bgm_ducked]amix=inputs=2:duration=first[out]
  " \
  -map "[out]" ducked_audio.mp3
```

## よくある問題

| 問題 | 解決策 |
|------|--------|
| BGM が大きすぎてナレーションが聞こえない | volume を 0.04-0.06 に下げる（密な場合 0.05 推奨） |
| BGM の長さが足りない | より長い BGM を選択。ループ必須ならシーン境界で接合 |
| フェードが急すぎる | fade_duration を 4-5 秒に延長 |
| ミックス後の音量が不均一 | loudnorm フィルタで正規化 |
| ループ接合が目立つ | クロスフェードまたはシーン転換点でループ |
