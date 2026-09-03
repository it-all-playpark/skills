# Video Type Patterns

## Promo / Product Demo

**Goal**: Show product value in 30-90 seconds.

**Structure** (storytelling arc):
1. **Hook** (3-5s) — Pain point or question
2. **Solution reveal** (3-5s) — Product introduction + logo
3. **Feature walkthrough** (40-60% of total) — Screenshots/screen recordings with annotations
4. **Social proof / badges** (5-10s) — Key features, stats, testimonials
5. **CTA** (5-8s) — Call to action with gradient/brand background

**Assets**: Screenshots, logos, icons, brand colors
**Resolution**: 1920x1080 (LP) or 1080x1920 (SNS)
**Transitions**: fade between sections, slide for feature steps

**Scene timing formula**:
```
hookSeconds = Math.max(3, totalSeconds * 0.07)
ctaSeconds = Math.max(5, totalSeconds * 0.1)
walkthroughSeconds = totalSeconds - hookSeconds - ctaSeconds - revealSeconds - badgeSeconds
```

**Common components**:
- `ScreenshotFrame` — Device mockup with screenshot inside
- `AnimatedText` — Fade/slide-in text with stagger
- `StepIndicator` — Step 1, 2, 3 numbered badges
- `FeatureBadge` — Icon + label grid
- `BrandLogo` — Animated logo reveal

---

## Tutorial / How-to

**Goal**: Teach a process step-by-step.

**Structure**:
1. **Title card** (3-5s) — "How to [task]"
2. **Steps** (bulk of video) — Sequential screenshots with numbered indicators
3. **Summary** (5s) — Key takeaways
4. **End card** (3-5s) — Logo + links

**Assets**: Step-by-step screenshots, numbered icons
**Resolution**: 1920x1080 or 1280x720
**Transitions**: slide (from-right) for step progression

**Key pattern**: Each step gets equal time allocation with a consistent layout.

```tsx
// Step scene pattern
const StepScene: React.FC<{ stepNumber: number; title: string; screenshot: string }> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // 1. Number appears (0-0.5s)
  // 2. Title slides in (0.3-1s)
  // 3. Screenshot scales in (0.5-1.5s)
  // 4. Hold (1.5s - end)
};
```

---

## Data Visualization

**Goal**: Animate data/metrics into a compelling narrative.

**Structure**:
1. **Context** (3-5s) — What data this is, why it matters
2. **Data scenes** (bulk) — Animated charts, counters, comparisons
3. **Insight** (5-10s) — Key takeaway
4. **CTA/Source** (3-5s) — Data source, next steps

**Assets**: Data JSON, brand colors for charts
**Resolution**: 1920x1080 or 1080x1080
**Transitions**: fade

**Key pattern**: Use `interpolate()` to animate values from 0 to target.

```tsx
// Animated counter
const count = interpolate(frame, [0, 2 * fps], [0, targetValue], {
  extrapolateRight: "clamp",
});
return <span>{Math.round(count).toLocaleString()}</span>;
```

Load `remotion-best-practices/rules/charts.md` for chart patterns.

---

## Social Media Short

**Goal**: Attention-grabbing 15-30s clip for X, Instagram, TikTok.

**Structure**:
1. **Hook** (1-3s) — Bold text or question (large font)
2. **Content** (10-20s) — 2-4 rapid scenes
3. **CTA** (2-3s) — Follow, visit, try

**Assets**: Bold typography, vibrant colors, minimal screenshots
**Resolution**: 1080x1920 (portrait) or 1080x1080 (square)
**Transitions**: fast slide/wipe (8-10 frames)

**Key differences from other types**:
- Faster pacing (shorter scene durations)
- Larger text (readability on mobile)
- Higher contrast colors
- Less content per scene

---

## Comparison Table

| Aspect | Promo | Tutorial | Data-Viz | Social |
|--------|-------|----------|----------|--------|
| Duration | 30-90s | 60-180s | 30-120s | 15-30s |
| Pacing | Medium | Slow | Medium | Fast |
| Primary assets | Screenshots | Screenshots | Data/charts | Text/icons |
| Text size | Medium | Small-Medium | Large numbers | Large |
| Transitions | fade/slide | slide | fade | fast wipe |
| Resolution | HD/Portrait | HD | HD/Square | Portrait/Square |
