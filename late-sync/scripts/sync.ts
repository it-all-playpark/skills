#!/usr/bin/env npx tsx
/**
 * Late Sync - Synchronize Late API scheduled posts with local post/blog/*.json
 *
 * Usage:
 *   npx tsx sync.ts [OPTIONS]
 *
 * Options:
 *   --from, -f DATE      Start date (default: tomorrow)
 *   --execute            Actually perform DELETE/CREATE (default: dry-run)
 *   --json               JSON output
 *   --verbose, -v        Detailed matching info
 *
 * Environment variables:
 *   LATE_API_KEY - Late API key from https://getlate.dev
 *   (Uses sns-schedule-post/.env relative to skills repo root)
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { parseArgs } from "util";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

// ── Paths ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillsDir = process.env.SKILLS_DIR || join(__dirname, "../..");
const envPath = join(skillsDir, "sns-schedule-post/.env");

// ── Env loading (shared pattern) ──

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
loadEnv(envPath);

// ── Config loading (shared pattern) ──

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      key in result &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadSkillConfig(skillName: string): Record<string, unknown> {
  let globalCfg: Record<string, unknown> = {};
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  if (homedir) {
    const globalPath = join(homedir, ".claude", "skill-config.json");
    if (existsSync(globalPath)) {
      try {
        const data = JSON.parse(readFileSync(globalPath, "utf-8"));
        const section = data[skillName];
        if (section && typeof section === "object")
          globalCfg = section as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
  }

  let projectCfg: Record<string, unknown> = {};
  let gitRoot: string;
  try {
    gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return globalCfg;
  }
  const configPath = join(gitRoot, ".claude", "skill-config.json");
  if (existsSync(configPath)) {
    try {
      const data = JSON.parse(readFileSync(configPath, "utf-8"));
      const section = data[skillName];
      if (section && typeof section === "object")
        projectCfg = section as Record<string, unknown>;
    } catch {
      // ignore
    }
  }

  if (Object.keys(globalCfg).length === 0) return projectCfg;
  if (Object.keys(projectCfg).length === 0) return globalCfg;
  return deepMerge(globalCfg, projectCfg);
}

const skillConfig = loadSkillConfig("late-sync");
const TIMEZONE = (skillConfig.timezone as string) || "Asia/Tokyo";
const POST_DIR = (skillConfig.post_dir as string) || "post/blog";
const PROFILE_ID = (skillConfig.profile_id as string) || "";

// ── Platform mapping (shared pattern) ──

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

const LATE_TO_DISPLAY: Record<string, string> = {
  twitter: "twitter",
  linkedin: "linkedin",
  facebook: "facebook",
  googlebusiness: "googlebusiness",
  threads: "threads",
  bluesky: "bluesky",
};

// ── Types ──

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

interface Account {
  _id: string;
  platform: string;
  name?: string;
  username?: string;
}

interface AccountsResponse {
  accounts: Account[];
}

interface LocalPost {
  content: string;
  schedule: string;
  platforms: string[];
}

interface MatchKey {
  key: string; // "YYYY-MM-DDTHH:MM|platform"
  datetime: string; // "YYYY-MM-DD HH:MM"
  platform: string; // Late platform name (e.g. "twitter")
}

interface LocalEntry {
  matchKey: MatchKey;
  post: LocalPost;
  filename: string;
  contentNorm: string;
}

interface LateEntry {
  matchKey: MatchKey;
  post: LatePost;
  contentNorm: string;
}

type DiffKind = "orphaned" | "missing" | "changed" | "matched";

interface DiffItem {
  kind: DiffKind;
  datetime: string;
  platform: string;
  lateId?: string;
  filename?: string;
  localPost?: LocalPost;
}

interface SyncResult {
  fromDate: string;
  localFileCount: number;
  localPostCount: number;
  latePostCount: number;
  orphaned: DiffItem[];
  missing: DiffItem[];
  changed: DiffItem[];
  matched: DiffItem[];
  executed: boolean;
  execResults?: {
    deleteSuccess: number;
    deleteFailed: number;
    createSuccess: number;
    createFailed: number;
  };
}

// ── Helpers ──

function getEnvOrExit(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Error: Missing environment variable: ${key}`);
    console.error(`Set it in ${envPath}`);
    process.exit(1);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert ISO string to JST "YYYY-MM-DD HH:MM" format
 */
function isoToJstDatetime(isoString: string): string {
  const dt = new Date(isoString);
  if (isNaN(dt.getTime())) return "";
  const jst = new Date(dt.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const min = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * Parse "YYYY-MM-DD HH:MM" (JST) to Date object
 */
function parseSchedule(scheduleStr: string): Date {
  const match = scheduleStr.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/
  );
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:00+09:00`);
  }
  const dt = new Date(scheduleStr);
  if (!isNaN(dt.getTime())) return dt;
  throw new Error(`Invalid schedule format: ${scheduleStr}`);
}

/**
 * Generate matching key: "YYYY-MM-DDTHH:MM|platform"
 */
function makeMatchKey(datetime: string, latePlatform: string): MatchKey {
  // datetime is "YYYY-MM-DD HH:MM"
  const normalized = datetime.replace(" ", "T");
  return {
    key: `${normalized}|${latePlatform}`,
    datetime,
    platform: latePlatform,
  };
}

/**
 * Normalize content for comparison: first 50 chars, collapse whitespace
 */
function normalizeContent(content: string): string {
  return content
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
}

/**
 * Get tomorrow's date in YYYY-MM-DD (JST)
 */
function getTomorrowJST(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + 1);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── API ──

async function rateLimitedRequest(
  fn: () => Promise<Response>
): Promise<Response> {
  const res = await fn();
  if (res.status === 429) {
    const retryAfter =
      parseInt(res.headers.get("retry-after") || "2") * 1000;
    console.error(`Rate limited, waiting ${retryAfter}ms...`);
    await sleep(retryAfter);
    return fn();
  }
  return res;
}

async function fetchScheduledPosts(
  apiKey: string,
  fromDate: string,
  profileId: string
): Promise<LatePost[]> {
  const allPosts: LatePost[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    let url = `https://getlate.dev/api/v1/posts?status=scheduled&dateFrom=${fromDate}&sortBy=scheduled-asc&limit=${limit}&page=${page}`;
    if (profileId) {
      url += `&profileId=${profileId}`;
    }
    const response = await rateLimitedRequest(() =>
      fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    );

    if (!response.ok) {
      if (response.status === 401) {
        console.error("Error: Invalid API key");
        process.exit(1);
      }
      const error = await response.json();
      console.error(
        "Error fetching scheduled posts:",
        JSON.stringify(error, null, 2)
      );
      process.exit(1);
    }

    const data = (await response.json()) as LateResponse;
    allPosts.push(...data.posts);

    if (page >= data.pagination.pages) break;
    page++;
  }

  // Client-side double-filter: ensure scheduledFor >= fromDate (in case dateFrom filters by createdAt)
  return allPosts.filter((post) => {
    const jstDatetime = isoToJstDatetime(post.scheduledFor);
    return jstDatetime >= fromDate;
  });
}

let cachedAccounts: Account[] | null = null;

async function fetchAccounts(apiKey: string): Promise<Account[]> {
  if (cachedAccounts) return cachedAccounts;

  const response = await rateLimitedRequest(() =>
    fetch("https://getlate.dev/api/v1/accounts", {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  );

  if (!response.ok) {
    const error = await response.json();
    console.error("Error fetching accounts:", JSON.stringify(error, null, 2));
    process.exit(1);
  }

  const data = (await response.json()) as AccountsResponse;
  cachedAccounts = data.accounts;
  return cachedAccounts;
}

async function deletePost(apiKey: string, postId: string): Promise<boolean> {
  await sleep(500);
  const response = await rateLimitedRequest(() =>
    fetch(`https://getlate.dev/api/v1/posts/${postId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  );

  if (response.status === 404) {
    console.error(`  Warning: Post ${postId} already deleted (404)`);
    return true; // treat as success
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    console.error(`  Error deleting ${postId}:`, JSON.stringify(error));
    return false;
  }

  return true;
}

async function createPost(
  apiKey: string,
  accounts: Account[],
  post: LocalPost
): Promise<boolean> {
  await sleep(500);

  const latePlatform = PLATFORM_TO_LATE[post.platforms[0]] || post.platforms[0];
  const account = accounts.find((a) => a.platform === latePlatform);
  if (!account) {
    console.error(`  Error: No account for platform ${latePlatform}`);
    return false;
  }

  const scheduledFor = parseSchedule(post.schedule).toISOString();

  const body = {
    content: post.content,
    platforms: [
      {
        platform: latePlatform,
        accountId: account._id,
      },
    ],
    scheduledFor,
    timezone: TIMEZONE,
  };

  const response = await rateLimitedRequest(() =>
    fetch("https://getlate.dev/api/v1/posts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    console.error(`  Error creating post:`, JSON.stringify(error));
    return false;
  }

  return true;
}

// ── Local file loading ──

function loadLocalPosts(
  postDir: string,
  fromDate: string
): { entries: LocalEntry[]; fileCount: number } {
  if (!existsSync(postDir)) {
    console.error(`Error: post directory not found: ${postDir}`);
    console.error(
      "Run this script from the project root (where post/blog/ exists)"
    );
    process.exit(1);
  }

  const files = readdirSync(postDir).filter((f) => f.endsWith(".json"));
  const entries: LocalEntry[] = [];

  for (const file of files) {
    const filepath = join(postDir, file);
    let posts: LocalPost[];
    try {
      const content = readFileSync(filepath, "utf-8");
      posts = JSON.parse(content);
    } catch {
      console.error(`Warning: Failed to parse ${file}, skipping`);
      continue;
    }

    if (!Array.isArray(posts)) continue;

    for (const post of posts) {
      if (!post.content || !post.schedule || !post.platforms) continue;

      // Extract date from schedule "YYYY-MM-DD HH:MM"
      const dateMatch = post.schedule.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;

      const postDate = dateMatch[1];
      if (postDate < fromDate) continue;

      for (const platform of post.platforms) {
        const latePlatform = PLATFORM_TO_LATE[platform] || platform;
        const matchKey = makeMatchKey(post.schedule, latePlatform);
        entries.push({
          matchKey,
          post,
          filename: file,
          contentNorm: normalizeContent(post.content),
        });
      }
    }
  }

  return { entries, fileCount: files.length };
}

// ── Late entries ──

function buildLateEntries(latePosts: LatePost[]): LateEntry[] {
  const entries: LateEntry[] = [];

  for (const post of latePosts) {
    const jstDatetime = isoToJstDatetime(post.scheduledFor);
    if (!jstDatetime) continue;

    for (const platform of post.platforms) {
      if (platform.status === "failed") continue;
      const matchKey = makeMatchKey(jstDatetime, platform.platform);
      entries.push({
        matchKey,
        post,
        contentNorm: normalizeContent(post.content),
      });
    }
  }

  return entries;
}

// ── Diff ──

function computeDiff(
  localEntries: LocalEntry[],
  lateEntries: LateEntry[],
  verbose: boolean
): { orphaned: DiffItem[]; missing: DiffItem[]; changed: DiffItem[]; matched: DiffItem[] } {
  const localByKey = new Map<string, LocalEntry>();
  for (const entry of localEntries) {
    localByKey.set(entry.matchKey.key, entry);
  }

  const lateByKey = new Map<string, LateEntry>();
  for (const entry of lateEntries) {
    // If duplicate keys in Late (shouldn't happen), keep first
    if (!lateByKey.has(entry.matchKey.key)) {
      lateByKey.set(entry.matchKey.key, entry);
    }
  }

  const orphaned: DiffItem[] = [];
  const missing: DiffItem[] = [];
  const changed: DiffItem[] = [];
  const matched: DiffItem[] = [];

  // Check Late entries against local
  for (const [key, lateEntry] of lateByKey) {
    const localEntry = localByKey.get(key);
    if (!localEntry) {
      if (verbose) {
        console.error(
          `  [ORPHANED] ${lateEntry.matchKey.datetime} [${LATE_TO_DISPLAY[lateEntry.matchKey.platform] || lateEntry.matchKey.platform}] ID:${lateEntry.post._id}`
        );
      }
      orphaned.push({
        kind: "orphaned",
        datetime: lateEntry.matchKey.datetime,
        platform:
          LATE_TO_DISPLAY[lateEntry.matchKey.platform] ||
          lateEntry.matchKey.platform,
        lateId: lateEntry.post._id,
      });
    } else {
      // Content comparison
      if (localEntry.contentNorm !== lateEntry.contentNorm) {
        if (verbose) {
          console.error(
            `  [CHANGED] ${lateEntry.matchKey.datetime} [${LATE_TO_DISPLAY[lateEntry.matchKey.platform] || lateEntry.matchKey.platform}]`
          );
          console.error(`    Late:  "${lateEntry.contentNorm}"`);
          console.error(`    Local: "${localEntry.contentNorm}"`);
        }
        changed.push({
          kind: "changed",
          datetime: lateEntry.matchKey.datetime,
          platform:
            LATE_TO_DISPLAY[lateEntry.matchKey.platform] ||
            lateEntry.matchKey.platform,
          lateId: lateEntry.post._id,
          filename: localEntry.filename,
          localPost: localEntry.post,
        });
      } else {
        if (verbose) {
          console.error(
            `  [MATCHED] ${lateEntry.matchKey.datetime} [${LATE_TO_DISPLAY[lateEntry.matchKey.platform] || lateEntry.matchKey.platform}]`
          );
        }
        matched.push({
          kind: "matched",
          datetime: lateEntry.matchKey.datetime,
          platform:
            LATE_TO_DISPLAY[lateEntry.matchKey.platform] ||
            lateEntry.matchKey.platform,
          lateId: lateEntry.post._id,
          filename: localEntry.filename,
        });
      }
    }
  }

  // Check local entries not in Late
  for (const [key, localEntry] of localByKey) {
    if (!lateByKey.has(key)) {
      if (verbose) {
        console.error(
          `  [MISSING] ${localEntry.matchKey.datetime} [${LATE_TO_DISPLAY[localEntry.matchKey.platform] || localEntry.matchKey.platform}] ← ${localEntry.filename}`
        );
      }
      missing.push({
        kind: "missing",
        datetime: localEntry.matchKey.datetime,
        platform:
          LATE_TO_DISPLAY[localEntry.matchKey.platform] ||
          localEntry.matchKey.platform,
        filename: localEntry.filename,
        localPost: localEntry.post,
      });
    }
  }

  // Sort by datetime
  const sortByDatetime = (a: DiffItem, b: DiffItem) =>
    a.datetime.localeCompare(b.datetime);
  orphaned.sort(sortByDatetime);
  missing.sort(sortByDatetime);
  changed.sort(sortByDatetime);
  matched.sort(sortByDatetime);

  return { orphaned, missing, changed, matched };
}

// ── Output ──

function printSummary(result: SyncResult) {
  console.log(`=== Late Sync ===`);
  console.log(`From: ${result.fromDate}`);
  console.log(
    `Local: ${result.localFileCount} files → ${result.localPostCount} posts (${result.fromDate}~)`
  );
  console.log(`Late:  ${result.latePostCount} scheduled (${result.fromDate}~)`);
  console.log("");

  if (result.orphaned.length > 0) {
    console.log(
      `🗑  Orphaned (DELETE from Late): ${result.orphaned.length}`
    );
    for (const item of result.orphaned) {
      console.log(
        `  ${item.datetime} [${item.platform}] ID:${item.lateId}`
      );
    }
    console.log("");
  }

  if (result.missing.length > 0) {
    console.log(
      `📝 Missing (CREATE to Late): ${result.missing.length}`
    );
    for (const item of result.missing) {
      console.log(
        `  ${item.datetime} [${item.platform}] ← ${item.filename}`
      );
    }
    console.log("");
  }

  if (result.changed.length > 0) {
    console.log(
      `🔄 Changed (DELETE + CREATE): ${result.changed.length}`
    );
    for (const item of result.changed) {
      console.log(
        `  ${item.datetime} [${item.platform}] ID:${item.lateId} ← ${item.filename}`
      );
    }
    console.log("");
  }

  console.log(`✅ Matched: ${result.matched.length}`);
  console.log("");

  if (result.executed && result.execResults) {
    const r = result.execResults;
    console.log(`=== Execution Results ===`);
    console.log(`DELETE: ${r.deleteSuccess} success, ${r.deleteFailed} failed`);
    console.log(`CREATE: ${r.createSuccess} success, ${r.createFailed} failed`);
    if (r.deleteFailed > 0 || r.createFailed > 0) {
      console.log(`⚠️  Some operations failed. Run again to retry.`);
    }
  } else {
    console.log(`Mode: DRY RUN (pass --execute to apply)`);
  }
}

// ── Main ──

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string", short: "f" },
      execute: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
    },
  });

  const fromDate = values.from || getTomorrowJST();
  const execute = values.execute ?? false;
  const jsonOutput = values.json ?? false;
  const verbose = values.verbose ?? false;

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    console.error("Error: --from must be YYYY-MM-DD format");
    process.exit(1);
  }

  const apiKey = getEnvOrExit("LATE_API_KEY");

  // Resolve post directory relative to git root
  let gitRoot: string;
  try {
    gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
    }).trim();
  } catch {
    gitRoot = process.cwd();
  }
  const postDir = join(gitRoot, POST_DIR);

  if (!PROFILE_ID && !jsonOutput) {
    console.error(
      "Warning: profile_id not set in skill-config.json. All Late profiles will be synced."
    );
    console.error(
      "Set late-sync.profile_id to avoid affecting other projects' posts.\n"
    );
  }

  if (!jsonOutput) {
    const profileInfo = PROFILE_ID ? ` (profile: ${PROFILE_ID})` : "";
    console.error(`Fetching scheduled posts from Late API (from ${fromDate})${profileInfo}...`);
  }

  // Parallel: fetch Late posts + load local posts
  const [latePosts, { entries: localEntries, fileCount }] = await Promise.all([
    fetchScheduledPosts(apiKey, fromDate, PROFILE_ID),
    Promise.resolve(loadLocalPosts(postDir, fromDate)),
  ]);

  const lateEntries = buildLateEntries(latePosts);

  if (!jsonOutput) {
    console.error(
      `Found ${latePosts.length} scheduled posts in Late, ${localEntries.length} local entries from ${fileCount} files\n`
    );
  }

  if (verbose) {
    console.error("--- Matching ---");
  }

  const diff = computeDiff(localEntries, lateEntries, verbose);

  if (verbose) {
    console.error("");
  }

  const result: SyncResult = {
    fromDate,
    localFileCount: fileCount,
    localPostCount: localEntries.length,
    latePostCount: lateEntries.length,
    orphaned: diff.orphaned,
    missing: diff.missing,
    changed: diff.changed,
    matched: diff.matched,
    executed: false,
  };

  // Execute if requested
  if (execute) {
    result.executed = true;
    const execResults = {
      deleteSuccess: 0,
      deleteFailed: 0,
      createSuccess: 0,
      createFailed: 0,
    };

    // Fetch accounts for CREATE operations
    const accounts =
      diff.missing.length > 0 || diff.changed.length > 0
        ? await fetchAccounts(apiKey)
        : [];

    // DELETE orphaned
    for (const item of diff.orphaned) {
      if (!jsonOutput) {
        console.error(`  Deleting ${item.lateId} (${item.datetime} [${item.platform}])...`);
      }
      const ok = await deletePost(apiKey, item.lateId!);
      if (ok) execResults.deleteSuccess++;
      else execResults.deleteFailed++;
    }

    // DELETE + CREATE changed
    for (const item of diff.changed) {
      if (!jsonOutput) {
        console.error(
          `  Replacing ${item.lateId} (${item.datetime} [${item.platform}])...`
        );
      }
      const deleteOk = await deletePost(apiKey, item.lateId!);
      if (deleteOk) {
        execResults.deleteSuccess++;
        const createOk = await createPost(apiKey, accounts, item.localPost!);
        if (createOk) execResults.createSuccess++;
        else execResults.createFailed++;
      } else {
        execResults.deleteFailed++;
      }
    }

    // CREATE missing
    for (const item of diff.missing) {
      if (!jsonOutput) {
        console.error(
          `  Creating ${item.datetime} [${item.platform}] (${item.filename})...`
        );
      }
      const ok = await createPost(apiKey, accounts, item.localPost!);
      if (ok) execResults.createSuccess++;
      else execResults.createFailed++;
    }

    result.execResults = execResults;
  }

  // Output
  if (jsonOutput) {
    // Strip localPost from JSON output (too verbose)
    const jsonResult = {
      ...result,
      orphaned: result.orphaned.map(({ localPost, ...rest }) => rest),
      missing: result.missing.map(({ localPost, ...rest }) => rest),
      changed: result.changed.map(({ localPost, ...rest }) => rest),
      matched: result.matched.map(({ localPost, ...rest }) => rest),
    };
    console.log(JSON.stringify(jsonResult, null, 2));
  } else {
    printSummary(result);
  }

  // Exit code
  if (result.executed && result.execResults) {
    const { deleteFailed, createFailed } = result.execResults;
    if (deleteFailed > 0 || createFailed > 0) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
