# Project Setup

## Monorepo Package Setup

### Directory structure

```
<monorepo-root>/
└── packages/
    └── video/                    # Remotion package
        ├── package.json
        ├── tsconfig.json
        ├── remotion.config.ts
        ├── src/
        │   ├── Root.tsx
        │   ├── index.ts
        │   ├── <VideoName>.tsx
        │   ├── scenes/
        │   ├── components/
        │   └── lib/
        │       ├── theme.ts
        │       └── constants.ts
        └── public/
            └── (static assets)
```

### package.json

```json
{
  "name": "@org/video",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "studio": "remotion studio src/index.ts",
    "render": "remotion render src/index.ts",
    "render:all": "remotion render src/index.ts --concurrency=50%",
    "upgrade": "remotion upgrade"
  },
  "dependencies": {
    "remotion": "^4.0.0",
    "@remotion/cli": "^4.0.0",
    "@remotion/bundler": "^4.0.0",
    "@remotion/renderer": "^4.0.0",
    "@remotion/transitions": "^4.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/react": "^19.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### remotion.config.ts

```ts
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
```

### src/index.ts

```ts
export { RemotionRoot } from "./Root.js";
```

### src/Root.tsx (template)

```tsx
import { Composition } from "remotion";
import { MyVideo } from "./MyVideo.js";
import { FPS, WIDTH, HEIGHT, TOTAL_FRAMES } from "./lib/constants.js";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="MyVideo"
      component={MyVideo}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
```

### src/lib/constants.ts (template)

```ts
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const TOTAL_DURATION_SEC = 60;
export const TOTAL_FRAMES = TOTAL_DURATION_SEC * FPS;

// Scene timing map (seconds)
export const SCENES = {
  intro: { start: 0, duration: 5 },
  main: { start: 5, duration: 45 },
  cta: { start: 50, duration: 10 },
} as const;

// Convert to frames helper
export const toFrames = (seconds: number) => Math.round(seconds * FPS);
```

### src/lib/theme.ts (template)

```ts
export const theme = {
  // Override with project brand colors
  primary: "#3b82f6",
  primaryLight: "#dbeafe",
  primaryDark: "#1d4ed8",
  accent: "#10b981",
  bg: "#ffffff",
  text: "#1a1a1a",
  textMuted: "#6b7280",
  white: "#ffffff",

  // Typography
  fontFamily: "Inter, system-ui, sans-serif",
  fontSizeH1: 64,
  fontSizeH2: 40,
  fontSizeBody: 24,
  fontSizeSmall: 18,

  // Spacing
  padding: 60,
  gap: 24,
  borderRadius: 12,
};
```

---

## Render Commands

```bash
# Preview in browser
npx remotion studio src/index.ts

# Render specific composition
npx remotion render src/index.ts <CompositionId> out/<filename>.mp4

# Render with custom resolution (overrides composition)
npx remotion render src/index.ts <CompositionId> out/<filename>.mp4 --width=1080 --height=1920

# Render as WebM
npx remotion render src/index.ts <CompositionId> out/<filename>.webm --codec=vp8

# Render with concurrency
npx remotion render src/index.ts <CompositionId> out/<filename>.mp4 --concurrency=50%
```

---

## Adding to Existing Monorepo

If the monorepo uses npm workspaces, add the package path to root `package.json`:

```json
{
  "workspaces": ["packages/*"]
}
```

Then install from root:

```bash
npm install
```
