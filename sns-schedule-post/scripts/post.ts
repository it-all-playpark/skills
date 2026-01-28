#!/usr/bin/env npx tsx
/**
 * SNS scheduled post using Late API (getlate.dev)
 *
 * Usage:
 *   # Single post
 *   npx tsx post.ts --text "投稿内容" --schedule "2026-01-20 09:00" --platforms x,linkedin
 *
 *   # Batch posts from JSON
 *   npx tsx post.ts --json posts.json
 *
 * JSON format:
 *   [
 *     { "content": "X用投稿", "schedule": "2026-03-12 09:00", "platforms": ["x"] },
 *     { "content": "LinkedIn用投稿", "schedule": "2026-03-12 09:00", "platforms": ["linkedin"] }
 *   ]
 *
 * Environment variables (.env):
 *   LATE_API_KEY - Late API key from https://getlate.dev
 *
 * Supported platforms: x, linkedin, facebook, googlebusiness, threads, bluesky
 */

import { readFileSync, existsSync } from "fs";
import { parseArgs } from "util";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Load .env from skill directory
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");

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

const SUPPORTED_PLATFORMS = ["x", "linkedin", "facebook", "googlebusiness", "threads", "bluesky"] as const;
type Platform = (typeof SUPPORTED_PLATFORMS)[number];

const PLATFORM_ALIASES: Record<string, Platform> = {
  x: "x",
  twitter: "x",
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

// Late API uses different platform names
const LATE_PLATFORM_NAMES: Record<Platform, string> = {
  x: "twitter",
  linkedin: "linkedin",
  facebook: "facebook",
  googlebusiness: "googlebusiness",
  threads: "threads",
  bluesky: "bluesky",
};

function getEnvOrExit(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Error: Missing environment variable: ${key}`);
    console.error(`Set it in ${envPath}`);
    process.exit(1);
  }
  return value;
}

function parsePlatformsList(input: string | string[]): Platform[] {
  const items = Array.isArray(input) ? input : input.split(",");

  if (items.length === 1 && items[0] === "all") {
    return [...SUPPORTED_PLATFORMS];
  }

  const platforms: Platform[] = [];
  for (const p of items) {
    const normalized = p.trim().toLowerCase();
    const platform = PLATFORM_ALIASES[normalized];
    if (!platform) {
      console.error(`Error: Unknown platform: ${p}`);
      console.error(`Supported: ${SUPPORTED_PLATFORMS.join(", ")}`);
      process.exit(1);
    }
    if (!platforms.includes(platform)) {
      platforms.push(platform);
    }
  }
  return platforms;
}

function parseSchedule(scheduleStr: string): Date {
  // Try ISO 8601
  let dt = new Date(scheduleStr);
  if (!isNaN(dt.getTime())) {
    return dt;
  }

  // Try "YYYY-MM-DD HH:MM" (assume JST)
  const match = scheduleStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    const jstDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+09:00`);
    if (!isNaN(jstDate.getTime())) {
      return jstDate;
    }
  }

  console.error(`Error: Invalid schedule format: ${scheduleStr}`);
  console.error('Expected: "YYYY-MM-DD HH:MM" (JST) or ISO 8601');
  process.exit(1);
}

interface Account {
  _id: string;
  platform: string;
  name?: string;
  username?: string;
}

interface AccountsResponse {
  accounts: Account[];
}

interface PlatformTarget {
  platform: string;
  accountId: string;
}

interface PostRequest {
  content: string;
  platforms: PlatformTarget[];
  scheduledFor?: string;
  timezone?: string;
  publishNow?: boolean;
}

interface PostResponse {
  post: {
    _id: string;
    content: string;
    status: string;
    scheduledFor?: string;
    platforms: Array<{
      platform: string;
      status: string;
    }>;
  };
}

interface BatchPostInput {
  content: string;
  schedule?: string;
  platforms: string | string[];
}

let cachedAccounts: Account[] | null = null;

async function fetchAccounts(apiKey: string): Promise<Account[]> {
  if (cachedAccounts) return cachedAccounts;

  const response = await fetch("https://getlate.dev/api/v1/accounts", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    console.error("Error fetching accounts:", JSON.stringify(error, null, 2));
    process.exit(1);
  }

  const data = (await response.json()) as AccountsResponse;
  cachedAccounts = data.accounts;
  return cachedAccounts;
}

async function createSinglePost(
  apiKey: string,
  accounts: Account[],
  content: string,
  platforms: Platform[],
  schedule: Date | null,
  dryRun: boolean,
  index?: number
): Promise<boolean> {
  const prefix = index !== undefined ? `[${index + 1}] ` : "";

  // Map requested platforms to account IDs
  const platformTargets: PlatformTarget[] = [];
  const notFound: string[] = [];

  for (const platform of platforms) {
    const latePlatformName = LATE_PLATFORM_NAMES[platform];
    const account = accounts.find((a) => a.platform === latePlatformName);
    if (account) {
      platformTargets.push({
        platform: latePlatformName,
        accountId: account._id,
      });
    } else {
      notFound.push(platform);
    }
  }

  if (platformTargets.length === 0) {
    console.error(`${prefix}Error: No connected accounts found for requested platforms`);
    console.error(`${prefix}Requested: ${platforms.join(", ")}`);
    console.error(`${prefix}Available: ${accounts.map((a) => a.platform).join(", ")}`);
    return false;
  }

  if (notFound.length > 0) {
    console.warn(`${prefix}Warning: No account connected for: ${notFound.join(", ")}`);
  }

  if (dryRun) {
    console.log(`${prefix}=== DRY RUN ===`);
    console.log(`${prefix}Content (${content.length} chars): ${content.slice(0, 50)}...`);
    console.log(`${prefix}Platforms: ${platformTargets.map((p) => p.platform).join(", ")}`);
    if (schedule) {
      console.log(`${prefix}Scheduled: ${schedule.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST`);
    } else {
      console.log(`${prefix}Would post immediately`);
    }
    console.log("");
    return true;
  }

  const body: PostRequest = {
    content,
    platforms: platformTargets,
    timezone: "Asia/Tokyo",
  };

  if (schedule) {
    body.scheduledFor = schedule.toISOString();
  } else {
    body.publishNow = true;
  }

  const response = await fetch("https://getlate.dev/api/v1/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as PostResponse | { error: string; message?: string; details?: string };

  if (!response.ok) {
    console.error(`${prefix}Error:`, JSON.stringify(data, null, 2));
    return false;
  }

  const post = (data as PostResponse).post;
  console.log(`${prefix}✅ Post created (ID: ${post._id})`);
  console.log(`${prefix}   Status: ${post.status}`);
  if (post.scheduledFor) {
    const scheduledDate = new Date(post.scheduledFor);
    console.log(`${prefix}   Scheduled: ${scheduledDate.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST`);
  }
  console.log(`${prefix}   Platforms: ${post.platforms.map((p) => `${p.platform}(${p.status})`).join(", ")}`);
  console.log("");
  return true;
}

async function processBatchPosts(jsonPath: string, dryRun: boolean): Promise<void> {
  if (!existsSync(jsonPath)) {
    console.error(`Error: JSON file not found: ${jsonPath}`);
    process.exit(1);
  }

  let posts: BatchPostInput[];
  try {
    const content = readFileSync(jsonPath, "utf-8");
    posts = JSON.parse(content);
  } catch (e) {
    console.error(`Error: Invalid JSON file: ${jsonPath}`);
    process.exit(1);
  }

  if (!Array.isArray(posts)) {
    console.error("Error: JSON must be an array of posts");
    process.exit(1);
  }

  console.log(`Processing ${posts.length} posts...\n`);

  const apiKey = getEnvOrExit("LATE_API_KEY");
  const accounts = await fetchAccounts(apiKey);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];

    if (!post.content) {
      console.error(`[${i + 1}] Error: Missing content`);
      failed++;
      continue;
    }

    const platforms = parsePlatformsList(post.platforms || "all");
    const schedule = post.schedule ? parseSchedule(post.schedule) : null;

    const ok = await createSinglePost(apiKey, accounts, post.content, platforms, schedule, dryRun, i);
    if (ok) {
      success++;
    } else {
      failed++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Success: ${success}`);
  console.log(`Failed: ${failed}`);
}

// Main
async function main() {
  const { values } = parseArgs({
    options: {
      text: { type: "string", short: "t" },
      file: { type: "string", short: "f" },
      json: { type: "string", short: "j" },
      schedule: { type: "string", short: "s" },
      platforms: { type: "string", short: "p", default: "all" },
      "dry-run": { type: "boolean", short: "n", default: false },
    },
  });

  const dryRun = values["dry-run"] ?? false;

  // Batch mode with JSON
  if (values.json) {
    await processBatchPosts(values.json, dryRun);
    return;
  }

  // Single post mode
  let content: string;

  if (values.file) {
    if (!existsSync(values.file)) {
      console.error(`Error: File not found: ${values.file}`);
      process.exit(1);
    }
    content = readFileSync(values.file, "utf-8").trim();
  } else if (values.text) {
    content = values.text;
  } else {
    console.error("Error: Provide --text, --file, or --json");
    process.exit(1);
  }

  const apiKey = getEnvOrExit("LATE_API_KEY");
  const accounts = await fetchAccounts(apiKey);
  const platforms = parsePlatformsList(values.platforms ?? "all");
  const schedule = values.schedule ? parseSchedule(values.schedule) : null;

  await createSinglePost(apiKey, accounts, content, platforms, schedule, dryRun);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
