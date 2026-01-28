#!/usr/bin/env npx tsx
/**
 * Check Scheduled Platforms - Pre-query for sns-announce --dedupe optimization
 *
 * Returns platforms that are NOT yet scheduled for a given date.
 * Use this BEFORE generating posts to skip unnecessary AI generation.
 *
 * Usage:
 *   npx tsx check-scheduled.ts --date 2026-01-20 --platforms x,linkedin,facebook
 *
 * Output (JSON):
 *   { "needed": ["x", "facebook"], "scheduled": ["linkedin"] }
 *
 * Environment variables:
 *   LATE_API_KEY - Late API key from https://getlate.dev
 */

import { readFileSync, existsSync } from "fs";
import { parseArgs } from "util";
import { join } from "path";
import { homedir } from "os";

// Load .env from sns-schedule-post skill directory
const envPath = join(homedir(), ".claude/skills/sns-schedule-post/.env");

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
loadEnv(envPath);

// Platform name mapping (input format -> Late API format)
const PLATFORM_TO_LATE: Record<string, string> = {
  x: "twitter",
  twitter: "twitter",
  linkedin: "linkedin",
  facebook: "facebook",
  fb: "facebook",
  googlebusiness: "googlebusiness",
  google: "googlebusiness",
  gbp: "googlebusiness",
  threads: "threads",
  bluesky: "bluesky",
  bsky: "bluesky",
};

interface LatePost {
  _id: string;
  platforms: Array<{
    platform: string;
    status: string;
  }>;
  scheduledFor: string;
  status: string;
}

interface LateResponse {
  posts: LatePost[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

function getEnvOrExit(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Error: Missing environment variable: ${key}`);
    console.error(`Set it in ${envPath}`);
    process.exit(1);
  }
  return value;
}

// Extract date part (YYYY-MM-DD) from ISO string
function extractDate(isoString: string): string {
  const dt = new Date(isoString);
  if (!isNaN(dt.getTime())) {
    // Convert to JST and extract date
    const jstDate = new Date(dt.getTime() + 9 * 60 * 60 * 1000);
    return jstDate.toISOString().split("T")[0];
  }
  return isoString.split("T")[0];
}

async function fetchScheduledPostsForDate(apiKey: string, targetDate: string): Promise<LatePost[]> {
  const allPosts: LatePost[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const url = `https://getlate.dev/api/v1/posts?status=scheduled&limit=${limit}&page=${page}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      console.error("Error fetching scheduled posts:", JSON.stringify(error, null, 2));
      process.exit(1);
    }

    const data = (await response.json()) as LateResponse;

    // Filter to only posts for the target date
    for (const post of data.posts) {
      const postDate = extractDate(post.scheduledFor);
      if (postDate === targetDate) {
        allPosts.push(post);
      }
    }

    if (page >= data.pagination.pages) {
      break;
    }
    page++;
  }

  return allPosts;
}

function getScheduledPlatformsForDate(posts: LatePost[]): Set<string> {
  const scheduled = new Set<string>();

  for (const post of posts) {
    for (const p of post.platforms) {
      // Only count as scheduled if not failed
      if (p.status !== "failed") {
        scheduled.add(p.platform);
      }
    }
  }

  return scheduled;
}

async function main() {
  const { values } = parseArgs({
    options: {
      date: { type: "string", short: "d" },
      platforms: { type: "string", short: "p" },
      verbose: { type: "boolean", short: "v", default: false },
    },
  });

  if (!values.date) {
    console.error("Usage: npx tsx check-scheduled.ts --date YYYY-MM-DD --platforms x,linkedin,facebook");
    console.error("       Returns platforms NOT yet scheduled for the given date.");
    process.exit(1);
  }

  // Validate date format
  const dateMatch = values.date.match(/^\d{4}-\d{2}-\d{2}$/);
  if (!dateMatch) {
    console.error("Error: Date must be in YYYY-MM-DD format");
    process.exit(1);
  }

  // Parse platforms (default to all if not specified)
  const allPlatforms = ["x", "linkedin", "googlebusiness", "facebook", "bluesky", "threads"];
  const requestedPlatforms = values.platforms
    ? values.platforms.split(",").map((p) => p.trim().toLowerCase())
    : allPlatforms;

  const verbose = values.verbose ?? false;

  if (verbose) {
    console.error(`Checking scheduled platforms for: ${values.date}`);
    console.error(`Requested platforms: ${requestedPlatforms.join(", ")}`);
  }

  // Fetch scheduled posts for the date
  const apiKey = getEnvOrExit("LATE_API_KEY");
  const scheduledPosts = await fetchScheduledPostsForDate(apiKey, values.date);

  if (verbose) {
    console.error(`Found ${scheduledPosts.length} scheduled posts for ${values.date}`);
  }

  // Get scheduled platforms
  const scheduledPlatformsLate = getScheduledPlatformsForDate(scheduledPosts);

  // Convert to input format and filter
  const scheduled: string[] = [];
  const needed: string[] = [];

  for (const platform of requestedPlatforms) {
    const latePlatform = PLATFORM_TO_LATE[platform] || platform;
    if (scheduledPlatformsLate.has(latePlatform)) {
      scheduled.push(platform);
    } else {
      needed.push(platform);
    }
  }

  // Output result
  const result = {
    date: values.date,
    needed,
    scheduled,
  };

  if (verbose) {
    console.error(`\nResult:`);
    console.error(`  Needed (not scheduled): ${needed.length > 0 ? needed.join(", ") : "(none)"}`);
    console.error(`  Already scheduled: ${scheduled.length > 0 ? scheduled.join(", ") : "(none)"}`);
    console.error("");
  }

  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
