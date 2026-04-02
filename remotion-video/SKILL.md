---
name: remotion-video
description: >-
  Create videos with Remotion (React-based video framework).
  End-to-end workflow: requirements → scene design → project setup → component implementation → preview → render.
  Use when: (1) creating any type of video with Remotion (promo, tutorial, data visualization, social media),
  (2) keywords like "動画作成", "ビデオ", "Remotion", "video", "promo video", "demo video",
  (3) setting up a new Remotion project in a monorepo or standalone,
  (4) designing video scenes and compositions programmatically.
  Works with remotion-best-practices skill for domain-specific patterns.
---

# Remotion Video Creation

End-to-end workflow for creating videos with Remotion.

**Companion skill**: `remotion-best-practices` — load specific rule files for animation, transition, and asset patterns.

## Workflow

### Phase 1: Requirements

Gather from user:

| Item | Example |
|------|---------|
| Video type | promo, tutorial, data-viz, social-short |
| Duration | 30s, 60s, 90s |
| Resolution | 1920x1080 (landscape), 1080x1920 (portrait), 1080x1080 (square) |
| FPS | 30 (default), 60 (smooth) |
| Output | MP4 (default), WebM, GIF |
| Assets | screenshots, logos, icons, audio |
| Brand | colors, fonts, tone |

For detailed patterns by video type, see [references/video-types.md](references/video-types.md).

### Phase 2: Scene Design

Design scenes BEFORE coding. Create a scene table:

```markdown
| # | Scene | Time | Content | Assets | Transition |
|---|-------|------|---------|--------|------------|
| 1 | Intro | 0-5s | Title + hook text | logo | fade |
| 2 | Demo  | 5-20s | Product walkthrough | screenshots | slide |
| 3 | CTA   | 20-25s | Call to action | logo | fade |
```

For common scene compositions, see [references/scene-patterns.md](references/scene-patterns.md).

**Frame calculation**: `frames = seconds × fps` (e.g., 5s at 30fps = 150 frames)

### Phase 3: Project Setup

Run the init script to scaffold a Remotion package:

```bash
scripts/init-remotion.sh <package-path> [--name <package-name>]
# Example: scripts/init-remotion.sh packages/video --name @myorg/video
```

The script creates the standard structure. For manual setup details, see [references/project-setup.md](references/project-setup.md).

**Standard project structure**:

```
<package-path>/
├── package.json
├── tsconfig.json
├── remotion.config.ts
├── src/
│   ├── Root.tsx              # Composition definitions
│   ├── index.ts              # Entry point (re-exports Root)
│   ├── <VideoName>.tsx       # Main composition (assembles scenes)
│   ├── scenes/               # Individual scene components
│   ├── components/           # Shared components (frames, text, etc.)
│   └── lib/
│       ├── theme.ts          # Design tokens
│       └── constants.ts      # FPS, timing, dimensions
└── public/                   # Static assets (images, audio)
```

### Phase 4: Implementation

#### 4a. Foundation files

1. **`lib/theme.ts`** — design tokens (colors, fonts, spacing)
2. **`lib/constants.ts`** — FPS, total duration, scene timing map
3. **Shared components** — reusable across scenes

#### 4b. Scene components

Each scene is an independent React component receiving `style` from `<AbsoluteFill>`.

Key rules (from `remotion-best-practices`):
- All animation via `useCurrentFrame()` + `interpolate()` — NO CSS transitions
- Use seconds × fps for timing — NEVER hardcode frame numbers
- Each scene's `useCurrentFrame()` returns local frame (0-based within its Sequence)
- Always `premountFor` on `<Sequence>` components

#### 4c. Main composition

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

#### 4d. Root.tsx

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

### Phase 5: Preview & Iterate

```bash
cd <package-path>
npx remotion studio     # Open browser preview
```

Iterate: adjust timing, transitions, colors in the preview.

### Phase 6: Render

```bash
# MP4 output
npx remotion render src/index.ts VideoName out/video.mp4

# WebM output
npx remotion render src/index.ts VideoName out/video.webm --codec=vp8

# GIF output (short clips only)
npx remotion render src/index.ts VideoName out/video.gif --image-format=png
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

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log remotion-video success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log remotion-video failure \
  --error-category <category> --error-msg "<message>"
```
