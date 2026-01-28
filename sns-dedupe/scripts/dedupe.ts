#!/usr/bin/env npx tsx
/**
 * SNS Dedupe - Filter out posts that are already scheduled in Late API
 *
 * Usage:
 *   npx tsx dedupe.ts input.json [--output output.json] [--dry-run]
 *
 * Environment variables:
 *   LATE_API_KEY - Late API key from https://getlate.dev
 *   (Uses ~/.claude/skills/sns-schedule-post/.env)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
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

interface InputPost {
  content: string;
  schedule: string;
  platforms: string | string[];
}

interface LatePost {
  _id: string;
  content: string;
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

// Extract date part (YYYY-MM-DD) from schedule string
function extractDate(scheduleStr: string): string {
  // Handle "YYYY-MM-DD HH:MM" format
  const match = scheduleStr.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) {
    return match[1];
  }

  // Handle ISO 8601 format
  const dt = new Date(scheduleStr);
  if (!isNaN(dt.getTime())) {
    // Convert to JST and extract date
    const jstDate = new Date(dt.getTime() + 9 * 60 * 60 * 1000);
    return jstDate.toISOString().split("T")[0];
  }

  return scheduleStr;
}

// Normalize platform names to Late API format
function normalizePlatforms(platforms: string | string[]): string[] {
  const items = Array.isArray(platforms) ? platforms : [platforms];
  return items.map((p) => {
    const normalized = p.trim().toLowerCase();
    return PLATFORM_TO_LATE[normalized] || normalized;
  });
}

async function fetchScheduledPosts(apiKey: string): Promise<LatePost[]> {
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
    allPosts.push(...data.posts);

    if (page >= data.pagination.pages) {
      break;
    }
    page++;
  }

  return allPosts;
}

// Check if a post is already scheduled
function isAlreadyScheduled(
  inputPost: InputPost,
  scheduledPosts: LatePost[]
): { isDuplicate: boolean; matchedPost?: LatePost } {
  const inputDate = extractDate(inputPost.schedule);
  const inputPlatforms = normalizePlatforms(inputPost.platforms);

  for (const scheduled of scheduledPosts) {
    const scheduledDate = extractDate(scheduled.scheduledFor);

    // Check if dates match
    if (inputDate !== scheduledDate) continue;

    // Check if any platform matches
    for (const inputPlatform of inputPlatforms) {
      const hasMatchingPlatform = scheduled.platforms.some(
        (p) => p.platform === inputPlatform && p.status !== "failed"
      );
      if (hasMatchingPlatform) {
        return { isDuplicate: true, matchedPost: scheduled };
      }
    }
  }

  return { isDuplicate: false };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      "dry-run": { type: "boolean", short: "n", default: false },
      verbose: { type: "boolean", short: "v", default: false },
    },
  });

  const inputFile = positionals[0];
  if (!inputFile) {
    console.error("Usage: npx tsx dedupe.ts <input.json> [--output <output.json>] [--dry-run] [--verbose]");
    process.exit(1);
  }

  if (!existsSync(inputFile)) {
    console.error(`Error: Input file not found: ${inputFile}`);
    process.exit(1);
  }

  let inputPosts: InputPost[];
  try {
    const content = readFileSync(inputFile, "utf-8");
    inputPosts = JSON.parse(content);
  } catch (e) {
    console.error(`Error: Invalid JSON file: ${inputFile}`);
    process.exit(1);
  }

  if (!Array.isArray(inputPosts)) {
    console.error("Error: JSON must be an array of posts");
    process.exit(1);
  }

  const dryRun = values["dry-run"] ?? false;
  const verbose = values.verbose ?? false;

  console.error(`Input: ${inputPosts.length} posts from ${inputFile}`);

  // Fetch scheduled posts from Late API
  const apiKey = getEnvOrExit("LATE_API_KEY");
  console.error("Fetching scheduled posts from Late API...");
  const scheduledPosts = await fetchScheduledPosts(apiKey);
  console.error(`Found ${scheduledPosts.length} scheduled posts in Late\n`);

  // Filter out duplicates
  const filteredPosts: InputPost[] = [];
  const duplicates: Array<{ post: InputPost; matchedPost: LatePost }> = [];

  for (const post of inputPosts) {
    const { isDuplicate, matchedPost } = isAlreadyScheduled(post, scheduledPosts);

    if (isDuplicate && matchedPost) {
      duplicates.push({ post, matchedPost });
      if (verbose) {
        console.error(`[SKIP] ${extractDate(post.schedule)} ${normalizePlatforms(post.platforms).join(",")}`);
        console.error(`       Already scheduled: ${matchedPost._id}`);
      }
    } else {
      filteredPosts.push(post);
      if (verbose) {
        console.error(`[KEEP] ${extractDate(post.schedule)} ${normalizePlatforms(post.platforms).join(",")}`);
      }
    }
  }

  // Summary
  console.error(`\n=== Summary ===`);
  console.error(`Total input:  ${inputPosts.length}`);
  console.error(`Duplicates:   ${duplicates.length}`);
  console.error(`Remaining:    ${filteredPosts.length}`);

  if (duplicates.length > 0) {
    console.error(`\nSkipped (already scheduled):`);
    for (const { post } of duplicates) {
      const platforms = normalizePlatforms(post.platforms);
      console.error(`  - ${extractDate(post.schedule)} [${platforms.join(", ")}]`);
    }
  }

  // Output
  const output = JSON.stringify(filteredPosts, null, 2);

  if (dryRun) {
    console.error(`\n[DRY RUN] Would output ${filteredPosts.length} posts`);
    console.log(output);
  } else if (values.output) {
    writeFileSync(values.output, output);
    console.error(`\nWritten to: ${values.output}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
