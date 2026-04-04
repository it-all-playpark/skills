---
name: remotion-video
description: >-
  Create videos with Remotion (React-based). E2E: requirements → scene design → setup → implement → preview → render.
  Use when: (1) creating video with Remotion (promo, tutorial, data-viz, social),
  (2) keywords: 動画作成, ビデオ, Remotion, video, promo video, demo video,
  (3) setting up Remotion project, (4) designing video scenes programmatically.
  Pair with remotion-best-practices for animation/transition patterns.
---

# Remotion Video Creation

E2E workflow for Remotion videos. **Companion**: `remotion-best-practices` for animation/transition patterns.

## Workflow

### Phase 1: Requirements

Gather from user:

| Item | Example |
|------|---------|
| Video type | promo, tutorial, data-viz, social-short |
| Duration | 30s, 60s, 90s |
| Resolution | 1920x1080 / 1080x1920 / 1080x1080 |
| FPS | 30 (default), 60 (smooth) |
| Output | MP4 (default), WebM, GIF |
| Assets | screenshots, logos, icons, audio |
| Brand | colors, fonts, tone |

See [video-types](references/video-types.md) for detailed patterns.

### Phase 2: Scene Design

Design scenes BEFORE coding. Create a scene table:

| # | Scene | Time | Content | Assets | Transition |
|---|-------|------|---------|--------|------------|
| 1 | Intro | 0-5s | Title + hook | logo | fade |
| 2 | Demo  | 5-20s | Walkthrough | screenshots | slide |
| 3 | CTA   | 20-25s | Call to action | logo | fade |

Frame calc: `frames = seconds x fps` (5s@30fps = 150). See [scene-patterns](references/scene-patterns.md).

### Phase 3: Project Setup

```bash
scripts/init-remotion.sh <package-path> [--name <package-name>]
```

Creates: `src/{Root.tsx, index.ts, scenes/, components/, lib/}`, `public/`, config files. Details: [project-setup](references/project-setup.md).

### Phase 4: Implementation

1. Foundation: `lib/theme.ts` (design tokens), `lib/constants.ts` (FPS, timing)
2. Scenes: Independent React components with `useCurrentFrame()` + `interpolate()`
3. Main composition: `<Series>` or `<TransitionSeries>`
4. Root.tsx: Register compositions

Details: [Implementation Guide](references/implementation-guide.md)
Key rules: Load `remotion-best-practices` skill for animation/transition patterns.

### Phase 5: Preview & Iterate

`npx remotion studio` — adjust timing, transitions, colors in browser preview.

### Phase 6: Render

```bash
npx remotion render src/index.ts VideoName out/video.mp4              # MP4
npx remotion render src/index.ts VideoName out/video.webm --codec=vp8 # WebM
npx remotion render src/index.ts VideoName out/video.gif --image-format=png # GIF
```

## References

- [implementation-guide](references/implementation-guide.md) - Phase 4 details, presets, dependencies, rule index
- [video-types](references/video-types.md) | [scene-patterns](references/scene-patterns.md) | [project-setup](references/project-setup.md)

## Journal Logging

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log remotion-video success --duration-turns $TURNS
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log remotion-video failure --error-category <cat> --error-msg "<msg>"
```
