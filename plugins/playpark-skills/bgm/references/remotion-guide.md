# Remotion BGM 動的音量制御

FFmpeg による事前処理の代わりに、Remotion 内で直接動的音量制御が可能。リアルタイムプレビューで調整しやすい。

## FFmpeg vs Remotion

| 観点 | FFmpeg 事前処理 | Remotion 動的制御 |
|------|----------------|------------------|
| デバッグ | 再処理が必要 | リアルタイムプレビュー |
| 柔軟性 | 固定 | 随時調整可能 |
| レンダリング性能 | オーバーヘッド無し | 微小なオーバーヘッド |
| ファイルサイズ | 事前ミックスで大きい | 分離保存で小さい |
| 推奨用途 | 最終納品 | 開発・デバッグ |

**推奨ワークフロー**: 開発中は Remotion で調整 → パラメータ確定後、FFmpeg で最終版生成

## 基本: シーン別音量

```tsx
import { Audio, staticFile, useVideoConfig } from "remotion";

const SCENE_VOLUMES = {
  opening: 0.15,  // ナレーション無し
  scene1: 0.05,   // ナレーション密
  scene2: 0.05,
  closing: 0.12,  // ナレーション疎
};

const getDynamicVolume = (
  frame: number,
  fps: number,
  scenes: Record<string, { start: number; duration: number }>,
  volumes: Record<string, number>,
): number => {
  const currentTime = frame / fps;
  for (const [name, scene] of Object.entries(scenes)) {
    if (currentTime >= scene.start && currentTime < scene.start + scene.duration) {
      return volumes[name] ?? 0.05;
    }
  }
  return 0.05;
};
```

## スムーズトランジション

```tsx
import { interpolate } from "remotion";

const getSmoothVolume = (frame: number, fps: number): number => {
  const t = frame / fps;

  if (t < 7.5) return 0.15;                                    // オープニング
  if (t < 8) return interpolate(t, [7.5, 8], [0.15, 0.05]);    // 過渡
  if (t < 71.5) return 0.05;                                    // 本編
  if (t < 72) return interpolate(t, [71.5, 72], [0.05, 0.12]); // 過渡
  return 0.12;                                                   // エンディング
};
```

## 汎用コンポーネント

```tsx
import React from "react";
import { Audio, staticFile, useVideoConfig } from "remotion";

interface DynamicBGMProps {
  src: string;
  sceneVolumes: Record<string, number>;
  scenes: Record<string, { start: number; duration: number }>;
  smoothTransition?: boolean;
  transitionDuration?: number;
}

export const DynamicBGM: React.FC<DynamicBGMProps> = ({
  src,
  sceneVolumes,
  scenes,
}) => {
  const { fps } = useVideoConfig();

  const getVolume = (frame: number): number => {
    const currentTime = frame / fps;
    for (const [name, scene] of Object.entries(scenes)) {
      if (currentTime >= scene.start && currentTime < scene.start + scene.duration) {
        return sceneVolumes[name] ?? 0.05;
      }
    }
    return 0.05;
  };

  return <Audio src={staticFile(src)} volume={(frame) => getVolume(frame)} />;
};
```

## 使用例

```tsx
export const FinalVideo: React.FC = () => (
  <>
    <Audio src={staticFile("audio/voiceover.mp3")} volume={1} />
    <Audio
      src={staticFile("audio/bgm.mp3")}
      volume={(f) => {
        const fps = 30;
        if (f < 3 * fps) return (f / (3 * fps)) * 0.12;
        if (f > 82 * fps) return ((85 * fps - f) / (3 * fps)) * 0.12;
        return 0.12;
      }}
    />
  </>
);
```
