# Implementation Guide

Phase 4 detailed implementation patterns and quick reference.

## 4a. Foundation files

1. **`lib/theme.ts`** — design tokens (colors, fonts, spacing)
2. **`lib/constants.ts`** — FPS, total duration, scene timing map
3. **Shared components** — reusable across scenes

## 4b. Scene components

Each scene is an independent React component receiving `style` from `<AbsoluteFill>`.

Key rules (from `remotion-best-practices`):
- All animation via `useCurrentFrame()` + `interpolate()` — NO CSS transitions
- Use seconds x fps for timing — NEVER hardcode frame numbers
- Each scene's `useCurrentFrame()` returns local frame (0-based within its Sequence)
- Always `premountFor` on `<Sequence>` components

## 4c. Main composition

Assemble scenes using `<Series>` (sequential) or `<TransitionSeries>` (with transitions).

```tsx
// Pattern: Series for simple sequential playback
<Series>
  {scenes.map(({ Component, duration }) => (
    <Series.Sequence key={id} durationInFrames={duration}>
      <Component />
    </Series.Sequence>
  ))}
</Series>
```

```tsx
// Pattern: TransitionSeries for transitions between scenes
<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={150}>
    <SceneA />
  </TransitionSeries.Sequence>
  <TransitionSeries.Transition
    presentation={fade()}
    timing={linearTiming({ durationInFrames: 15 })}
  />
  <TransitionSeries.Sequence durationInFrames={300}>
    <SceneB />
  </TransitionSeries.Sequence>
</TransitionSeries>
```

## 4d. Root.tsx

Register all compositions with dimensions and duration.

```tsx
export const RemotionRoot: React.FC = () => (
  <Composition
    id="VideoName"
    component={VideoName}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    defaultProps={{ /* parametrizable props */ }}
  />
);
```

## Quick Reference

### Resolution presets

| Name | Width | Height | Use case |
|------|-------|--------|----------|
| landscape-hd | 1920 | 1080 | LP, YouTube |
| landscape-720 | 1280 | 720 | Web embed |
| portrait-hd | 1080 | 1920 | Instagram Story, TikTok |
| square | 1080 | 1080 | Instagram Post, X |
| square-sm | 720 | 720 | Thumbnail |

### Common dependencies

```
remotion @remotion/cli @remotion/bundler @remotion/renderer
@remotion/transitions          # fade, slide, wipe
@remotion/light-leaks          # overlay effects
@remotion/media-utils          # audio/video duration
```

### remotion-best-practices rule index

Load the corresponding rule file when implementing:

| Task | Rule file |
|------|-----------|
| Animation basics | `animations.md` |
| Interpolation curves | `timing.md` |
| Scene sequencing | `sequencing.md` |
| Transitions between scenes | `transitions.md` |
| Text animation | `text-animations.md` |
| Images | `images.md` |
| Videos (embed) | `videos.md` |
| Audio | `audio.md` |
| Fonts | `fonts.md` |
| Tailwind | `tailwind.md` |
| Parameters (Zod schema) | `parameters.md` |
| Charts / data-viz | `charts.md` |
| Captions / subtitles | `display-captions.md` |
