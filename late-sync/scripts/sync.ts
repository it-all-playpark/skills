#!/usr/bin/env npx tsx
/**
 * Late Sync - Synchronize Late API scheduled posts with local post/blog/*.json
 *
 * Supports both text and media posts.
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
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { parseArgs } from "util";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

import {
  loadEnv,
  getEnvOrExit,
  loadSkillConfig,
  parseSchedule,
  isoToJstDatetime,
  fetchAccounts,
  rateLimitedRequest,
  uploadMediaItemCached,
  resolveLatePlatformName,
  isMediaPost,
  normalizeContent,
  normalizeContentWithMedia,
  sleep,
  BASE_URL,
  type Account,
  type MediaItem,
  type PlatformTarget,
  type TikTokSettings,
} from "../../_shared/scripts/late-api.ts";

// ── Paths ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillsDir = process.env.SKILLS_DIR || join(__dirname, "../..");
const envPath = join(skillsDir, "sns-schedule-post/.env");

loadEnv(envPath);

// ── Config ──

const skillConfig = loadSkillConfig("late-sync");
const TIMEZONE = (skillConfig.timezone as string) || "Asia/Tokyo";
const POST_DIR = (skillConfig.post_dir as string) || "post/blog";
const PROFILE_ID = (skillConfig.profile_id as string) || "";

// ── Platform display mapping ──

const LATE_TO_DISPLAY: Record<string, string> = {
  twitter: "twitter",
  linkedin: "linkedin",
  facebook: "facebook",
  googlebusiness: "googlebusiness",
  threads: "threads",
  bluesky: "bluesky",
  instagram: "instagram",
  youtube: "youtube",
  tiktok: "tiktok",
};

// ── Types ──

interface LatePost {
  _id: string;
  content: string;
  platforms: Array<{
    platform: string;
    status: string;
  }>;
  mediaItems?: Array<{ type: string; url: string }>;
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

interface LocalPost {
  content: string;
  schedule: string;
  platforms:
    | string[]
    | Array<{
        platform: string;
        platformSpecificData?: Record<string, unknown>;
      }>;
  // Media (optional)
  mediaItems?: MediaItem[];
  tiktokSettings?: TikTokSettings;
  firstComment?: string;
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

/**
 * Generate matching key: "YYYY-MM-DDTHH:MM|platform"
 */
function makeMatchKey(datetime: string, latePlatform: string): MatchKey {
  const normalized = datetime.replace(" ", "T");
  return {
    key: `${normalized}|${latePlatform}`,
    datetime,
    platform: latePlatform,
  };
}

/**
 * Extract platforms from mixed format
 */
function extractPlatforms(
  platforms: string[] | Array<{ platform: string }>
): string[] {
  if (!Array.isArray(platforms)) return [];
  if (platforms.length === 0) return [];
  if (typeof platforms[0] === "string") return platforms as string[];
  return (platforms as Array<{ platform: string }>).map((p) => p.platform);
}

// ── API ──

async function fetchScheduledPosts(
  apiKey: string,
  fromDate: string,
  profileId: string
): Promise<LatePost[]> {
  const allPosts: LatePost[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    let url = `${BASE_URL}/posts?status=scheduled&dateFrom=${fromDate}&sortBy=scheduled-asc&limit=${limit}&page=${page}`;
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

  // Client-side double-filter: ensure scheduledFor >= fromDate
  return allPosts.filter((post) => {
    const jstDatetime = isoToJstDatetime(post.scheduledFor);
    return jstDatetime >= fromDate;
  });
}

async function deletePost(apiKey: string, postId: string): Promise<boolean> {
  await sleep(500);
  const response = await rateLimitedRequest(() =>
    fetch(`${BASE_URL}/posts/${postId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  );

  if (response.status === 404) {
    console.error(`  Warning: Post ${postId} already deleted (404)`);
    return true;
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

  const platformList = extractPlatforms(post.platforms);
  const latePlatform = resolveLatePlatformName(platformList[0]);
  const account = accounts.find((a) => a.platform === latePlatform);
  if (!account) {
    console.error(`  Error: No account for platform ${latePlatform}`);
    return false;
  }

  const scheduledFor = parseSchedule(post.schedule).toISOString();

  // Build platform target
  const platformTarget: PlatformTarget = {
    platform: latePlatform,
    accountId: account._id,
  };

  // Attach platformSpecificData if present
  if (
    Array.isArray(post.platforms) &&
    post.platforms.length > 0 &&
    typeof post.platforms[0] === "object"
  ) {
    const entry = (
      post.platforms as Array<{
        platform: string;
        platformSpecificData?: Record<string, unknown>;
      }>
    )[0];
    if (entry.platformSpecificData) {
      platformTarget.platformSpecificData = entry.platformSpecificData;
    }
  }

  const body: Record<string, unknown> = {
    content: post.content,
    platforms: [platformTarget],
    scheduledFor,
    timezone: TIMEZONE,
  };

  // Media items: upload with cache [C1]
  if (post.mediaItems && post.mediaItems.length > 0) {
    const uploadedMedia = [];
    for (const item of post.mediaItems) {
      const uploaded = await uploadMediaItemCached(apiKey, item);
      uploadedMedia.push(uploaded);
    }
    body.mediaItems = uploadedMedia;
  }

  // TikTok settings
  if (post.tiktokSettings) {
    body.tiktokSettings = {
      ...post.tiktokSettings,
      content_preview_confirmed: true,
      express_consent_given: true,
    };
  }

  // First comment
  if (post.firstComment) {
    if (latePlatform === "youtube") {
      (
        (platformTarget.platformSpecificData ??= {}) as Record<string, unknown>
      ).firstComment = post.firstComment;
    } else {
      body.firstComment = post.firstComment;
    }
  }

  const response = await rateLimitedRequest(() =>
    fetch(`${BASE_URL}/posts`, {
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

      const platformList = extractPlatforms(post.platforms);

      for (const platform of platformList) {
        const latePlatform = resolveLatePlatformName(platform);
        const matchKey = makeMatchKey(post.schedule, latePlatform);
        // [C2] Use media-aware normalization
        const contentNorm = normalizeContentWithMedia(
          post.content,
          post.mediaItems
        );
        entries.push({
          matchKey,
          post,
          filename: file,
          contentNorm,
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
      // [C2] Use media-aware normalization for Late entries too
      const mediaItems = post.mediaItems?.map((m) => ({
        type: m.type as "image" | "video",
        url: m.url,
      }));
      const contentNorm = normalizeContentWithMedia(post.content, mediaItems);
      entries.push({
        matchKey,
        post,
        contentNorm,
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
): {
  orphaned: DiffItem[];
  missing: DiffItem[];
  changed: DiffItem[];
  matched: DiffItem[];
} {
  const localByKey = new Map<string, LocalEntry>();
  for (const entry of localEntries) {
    localByKey.set(entry.matchKey.key, entry);
  }

  const lateByKey = new Map<string, LateEntry>();
  for (const entry of lateEntries) {
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
          `  [MISSING] ${localEntry.matchKey.datetime} [${LATE_TO_DISPLAY[localEntry.matchKey.platform] || localEntry.matchKey.platform}] <- ${localEntry.filename}`
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
    `Local: ${result.localFileCount} files -> ${result.localPostCount} posts (${result.fromDate}~)`
  );
  console.log(
    `Late:  ${result.latePostCount} scheduled (${result.fromDate}~)`
  );
  console.log("");

  if (result.orphaned.length > 0) {
    console.log(
      `Orphaned (DELETE from Late): ${result.orphaned.length}`
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
      `Missing (CREATE to Late): ${result.missing.length}`
    );
    for (const item of result.missing) {
      console.log(
        `  ${item.datetime} [${item.platform}] <- ${item.filename}`
      );
    }
    console.log("");
  }

  if (result.changed.length > 0) {
    console.log(
      `Changed (DELETE + CREATE): ${result.changed.length}`
    );
    for (const item of result.changed) {
      console.log(
        `  ${item.datetime} [${item.platform}] ID:${item.lateId} <- ${item.filename}`
      );
    }
    console.log("");
  }

  console.log(`Matched: ${result.matched.length}`);
  console.log("");

  if (result.executed && result.execResults) {
    const r = result.execResults;
    console.log(`=== Execution Results ===`);
    console.log(
      `DELETE: ${r.deleteSuccess} success, ${r.deleteFailed} failed`
    );
    console.log(
      `CREATE: ${r.createSuccess} success, ${r.createFailed} failed`
    );
    if (r.deleteFailed > 0 || r.createFailed > 0) {
      console.log(`Some operations failed. Run again to retry.`);
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

  const apiKey = getEnvOrExit("LATE_API_KEY", envPath);

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
    console.error(
      `Fetching scheduled posts from Late API (from ${fromDate})${profileInfo}...`
    );
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
        ? await fetchAccounts(apiKey, PROFILE_ID || undefined)
        : [];

    // DELETE orphaned
    for (const item of diff.orphaned) {
      if (!jsonOutput) {
        console.error(
          `  Deleting ${item.lateId} (${item.datetime} [${item.platform}])...`
        );
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
