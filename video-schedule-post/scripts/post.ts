#!/usr/bin/env npx tsx
/**
 * @deprecated Use late-schedule-post instead.
 * This script forwards all arguments to late-schedule-post/scripts/post.ts.
 */
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetScript = join(
  __dirname,
  "..",
  "..",
  "late-schedule-post",
  "scripts",
  "post.ts"
);

console.error(
  "video-schedule-post is deprecated. Use /late-schedule-post instead.\n"
);

try {
  execFileSync("npx", ["tsx", targetScript, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
} catch (err: unknown) {
  process.exit((err as { status?: number }).status || 1);
}
