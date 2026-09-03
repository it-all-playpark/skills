# Scene Patterns

Common scene compositions and timing strategies for Remotion videos.

## Scene Architecture

Every scene follows this structure:

```tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

export const SceneName: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Animation values derived from frame
  const opacity = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {/* Scene content */}
    </AbsoluteFill>
  );
};
```

**Rules**:
- Scene receives local frames (0-based) from parent `<Sequence>` or `<Series.Sequence>`
- All timing in `seconds * fps` — never hardcode frame numbers
- Use `extrapolateRight: "clamp"` on all interpolations to prevent runaway values

---

## Timing Patterns

### Staggered entrance

Elements appear one after another with a delay.

```tsx
const items = ["Item 1", "Item 2", "Item 3"];
const staggerDelay = 0.15 * fps; // 150ms between items

{items.map((item, i) => {
  const itemOpacity = interpolate(
    frame,
    [i * staggerDelay, i * staggerDelay + 0.3 * fps],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const translateY = interpolate(
    frame,
    [i * staggerDelay, i * staggerDelay + 0.3 * fps],
    [20, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return (
    <div key={i} style={{ opacity: itemOpacity, transform: `translateY(${translateY}px)` }}>
      {item}
    </div>
  );
})}
```

### Enter → Hold → Exit

3-phase animation pattern.

```tsx
const enterEnd = 0.5 * fps;
const holdEnd = durationInFrames - 0.5 * fps;
const exitEnd = durationInFrames;

const opacity = interpolate(
  frame,
  [0, enterEnd, holdEnd, exitEnd],
  [0, 1, 1, 0],
  { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
);
```

### Scale pop

Element scales from 0 to slightly above 1, then settles to 1.

```tsx
const scale = interpolate(
  frame,
  [0, 0.2 * fps, 0.35 * fps],
  [0, 1.1, 1],
  { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
);
```

---

## Common Scene Types

### Text-only scene (hook, CTA)

```tsx
<AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: gradient }}>
  <div style={{ opacity, transform: `translateY(${translateY}px)` }}>
    <h1 style={{ fontSize: 64, fontWeight: 700 }}>{title}</h1>
    <p style={{ fontSize: 28, opacity: subtitleOpacity }}>{subtitle}</p>
  </div>
</AbsoluteFill>
```

### Screenshot showcase

```tsx
<AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background }}>
  {/* Optional step indicator */}
  <div style={{ position: "absolute", top: 40, opacity: labelOpacity }}>
    Step {stepNumber}
  </div>

  {/* Screenshot with device frame */}
  <div style={{
    width: "70%",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
    transform: `scale(${scale})`,
    opacity: screenshotOpacity,
  }}>
    <Img src={staticFile(screenshotPath)} style={{ width: "100%", display: "block" }} />
  </div>

  {/* Caption below */}
  <div style={{ position: "absolute", bottom: 60, opacity: captionOpacity }}>
    <p style={{ fontSize: 24 }}>{caption}</p>
  </div>
</AbsoluteFill>
```

### Feature badge grid

```tsx
const BADGES = [
  { icon: "⚡", label: "高速" },
  { icon: "🔒", label: "安全" },
  { icon: "📱", label: "モバイル対応" },
  { icon: "🤖", label: "AI搭載" },
];

<AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40 }}>
    {BADGES.map((badge, i) => {
      const badgeOpacity = interpolate(
        frame,
        [i * 0.2 * fps, i * 0.2 * fps + 0.4 * fps],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      );
      return (
        <div key={i} style={{ opacity: badgeOpacity, textAlign: "center" }}>
          <span style={{ fontSize: 48 }}>{badge.icon}</span>
          <p style={{ fontSize: 24 }}>{badge.label}</p>
        </div>
      );
    })}
  </div>
</AbsoluteFill>
```

### Multi-screenshot carousel

Multiple screenshots displayed sequentially within a single scene.

```tsx
const screenshots = ["/img/step1.webp", "/img/step2.webp", "/img/step3.webp"];
const perScreenshot = Math.floor(durationInFrames / screenshots.length);

{screenshots.map((src, i) => {
  const localStart = i * perScreenshot;
  const isActive = frame >= localStart && frame < localStart + perScreenshot;
  const localFrame = frame - localStart;

  if (!isActive) return null;

  const screenshotScale = interpolate(localFrame, [0, 0.3 * fps], [0.9, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill key={i} style={{ justifyContent: "center", alignItems: "center" }}>
      <Img src={staticFile(src)} style={{ width: "70%", transform: `scale(${screenshotScale})` }} />
    </AbsoluteFill>
  );
})}
```

---

## Scene Duration Guidelines

| Scene type | Min | Typical | Max |
|-----------|-----|---------|-----|
| Text hook | 2s | 3-5s | 8s |
| Logo reveal | 2s | 3s | 5s |
| Screenshot (single) | 3s | 5-8s | 12s |
| Screenshot carousel | 8s | 15-30s | 45s |
| Feature badges | 5s | 7-10s | 15s |
| Data/chart | 5s | 8-15s | 20s |
| CTA | 3s | 5-8s | 10s |

**Total transition overhead**: Subtract ~0.5s per transition from total duration.
