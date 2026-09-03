#!/usr/bin/env bash
set -euo pipefail

# Initialize a Remotion video package in a monorepo or standalone project.
# Usage: init-remotion.sh <package-path> [--name <package-name>]
# Example: init-remotion.sh packages/video --name @myorg/video

PACKAGE_PATH="${1:?Usage: init-remotion.sh <package-path> [--name <package-name>]}"
PACKAGE_NAME=""

# Parse optional args
shift
while [[ $# -gt 0 ]]; do
  case $1 in
    --name) PACKAGE_NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Default package name from directory
if [[ -z "$PACKAGE_NAME" ]]; then
  PACKAGE_NAME=$(basename "$PACKAGE_PATH")
fi

echo "Creating Remotion package at: $PACKAGE_PATH"
echo "Package name: $PACKAGE_NAME"

# Create directory structure
mkdir -p "$PACKAGE_PATH/src/scenes"
mkdir -p "$PACKAGE_PATH/src/components"
mkdir -p "$PACKAGE_PATH/src/lib"
mkdir -p "$PACKAGE_PATH/public"
mkdir -p "$PACKAGE_PATH/out"

# package.json
cat > "$PACKAGE_PATH/package.json" << ENDJSON
{
  "name": "$PACKAGE_NAME",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "studio": "remotion studio src/index.ts",
    "render": "remotion render src/index.ts",
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
ENDJSON

# tsconfig.json
cat > "$PACKAGE_PATH/tsconfig.json" << 'ENDJSON'
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
ENDJSON

# remotion.config.ts
cat > "$PACKAGE_PATH/remotion.config.ts" << 'ENDTS'
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
ENDTS

# src/index.ts
cat > "$PACKAGE_PATH/src/index.ts" << 'ENDTS'
export { RemotionRoot } from "./Root.js";
ENDTS

# src/lib/constants.ts
cat > "$PACKAGE_PATH/src/lib/constants.ts" << 'ENDTS'
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const TOTAL_DURATION_SEC = 60;
export const TOTAL_FRAMES = TOTAL_DURATION_SEC * FPS;

/** Convert seconds to frames */
export const toFrames = (seconds: number) => Math.round(seconds * FPS);
ENDTS

# src/lib/theme.ts
cat > "$PACKAGE_PATH/src/lib/theme.ts" << 'ENDTS'
export const theme = {
  // Brand colors — override with project values
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
ENDTS

# src/Root.tsx (placeholder)
cat > "$PACKAGE_PATH/src/Root.tsx" << 'ENDTSX'
import React from "react";
import { Composition } from "remotion";
import { FPS, WIDTH, HEIGHT, TOTAL_FRAMES } from "./lib/constants.js";

// TODO: Import your main composition component
// import { MyVideo } from "./MyVideo.js";

const Placeholder: React.FC = () => (
  <div style={{ flex: 1, justifyContent: "center", alignItems: "center", display: "flex", background: "#f9f8f6" }}>
    <h1 style={{ fontSize: 48, fontFamily: "system-ui" }}>Replace with your video</h1>
  </div>
);

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Main"
      component={Placeholder}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
ENDTSX

# .gitignore
cat > "$PACKAGE_PATH/.gitignore" << 'ENDGIT'
node_modules/
dist/
out/
ENDGIT

echo ""
echo "Done! Next steps:"
echo "  1. cd $PACKAGE_PATH && npm install"
echo "  2. Edit src/lib/theme.ts with brand colors"
echo "  3. Edit src/lib/constants.ts with timing"
echo "  4. Create scene components in src/scenes/"
echo "  5. npx remotion studio src/index.ts"
