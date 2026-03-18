#!/usr/bin/env npx tsx
/**
 * Zernio Schedule Post (formerly Late) - Unified SNS posting (text + media)
 *
 * Usage:
 *   # Text post
 *   npx tsx post.ts --text "投稿内容" --schedule "2026-01-20 09:00" --platforms x,linkedin
 *
 *   # Batch (JSON: text, media, or mixed)
 *   npx tsx post.ts --json posts.json
 *
 *   # Media post (Instagram)
 *   npx tsx post.ts --media video.mp4 --caption "Caption" --type reel --schedule "2026-03-12 19:00"
 *
 *   # Dry run
 *   npx tsx post.ts --json posts.json --dry-run
 */

import { readFileSync, existsSync, statSync } from "fs";
import { parseArgs } from "util";
import { dirname, join, basename, extname } from "path";
import { fileURLToPath } from "url";

import {
  loadEnv,
  getEnvOrExit,
  loadSkillConfig,
  parseSchedule,
  parsePlatformsList,
  resolveLatePlatformName,
  fetchAccounts,
  rateLimitedRequest,
  uploadMediaItem,
  getMimeType,
  detectMediaType,
  isMediaPost,
  extractPlatforms,
  BASE_URL,
  type Account,
  type MediaItem,
  type MediaPostInput,
  type TextPostInput,
  type PlatformTarget,
  type PlatformSpecificData,
  type TikTokSettings,
  type UnifiedPostInput,
} from "../../_shared/scripts/late-api.ts";

// ── Setup ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");
const fallbackEnvPath = join(__dirname, "..", "..", "sns-schedule-post", ".env");
loadEnv(envPath);
loadEnv(fallbackEnvPath);

// Config: late-schedule-post, fallback to sns-schedule-post
let skillConfig = loadSkillConfig("late-schedule-post");
if (Object.keys(skillConfig).length === 0) {
  skillConfig = loadSkillConfig("sns-schedule-post");
}

const PROFILE_ID = (skillConfig.profile_id as string) || "";
const TIMEZONE = (skillConfig.timezone as string) || "Asia/Tokyo";
const DEFAULT_PLATFORMS = (skillConfig.default_platforms as string[]) || [
  "x",
  "linkedin",
  "googlebusiness",
  "facebook",
  "bluesky",
];

// ── Content type detection (media) ──

type ContentType = "feed" | "reels" | "story" | "carousel";

function detectContentType(
  mediaItems: MediaItem[],
  explicit?: string
): ContentType {
  if (explicit) {
    const map: Record<string, ContentType> = {
      feed: "feed",
      reel: "reels",
      reels: "reels",
      story: "story",
      carousel: "carousel",
    };
    return map[explicit.toLowerCase()] || "feed";
  }
  if (mediaItems.length > 1) return "carousel";
  if (mediaItems.length === 1 && mediaItems[0].type === "video") return "feed";
  return "feed";
}

// ── Helpers ──

function isUrl(str: string): boolean {
  return str.startsWith("http://") || str.startsWith("https://");
}

function dryRunMediaItem(
  item: MediaItem
): { type: string; url: string; thumbnail?: { url: string } } {
  if (item.url && !item.path) {
    const result: {
      type: string;
      url: string;
      thumbnail?: { url: string };
    } = { type: item.type, url: item.url };
    if (item.thumbnail) result.thumbnail = item.thumbnail;
    return result;
  }
  const filePath = item.path!;
  const fileName = basename(filePath);
  const mimeType = getMimeType(filePath);
  const exists = existsSync(filePath);
  const sizeMB = exists
    ? (statSync(filePath).size / 1024 / 1024).toFixed(1)
    : "?";
  console.log(
    `  [dry-run] Would upload: ${fileName} (${sizeMB} MB, ${mimeType})${exists ? "" : " [FILE NOT FOUND]"}`
  );
  const result: {
    type: string;
    url: string;
    thumbnail?: { url: string };
  } = { type: item.type, url: `<local:${filePath}>` };
  if (item.thumbnail) {
    console.log(
      `  [dry-run] Would upload YT thumbnail: ${basename(item.thumbnail.url)}`
    );
    result.thumbnail = { url: `<local:${item.thumbnail.url}>` };
  }
  return result;
}

async function uploadFile(apiKey: string, filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const result = await uploadMediaItem(apiKey, {
    type: "image",
    path: filePath,
  });
  return result.url;
}

async function resolveThumbnail(
  apiKey: string,
  platformData: PlatformSpecificData | undefined,
  dryRun: boolean
): Promise<void> {
  if (!platformData?.instagramThumbnail) return;
  const thumb = platformData.instagramThumbnail;
  if (isUrl(thumb)) return;

  if (dryRun) {
    const exists = existsSync(thumb);
    const sizeMB = exists
      ? (statSync(thumb).size / 1024 / 1024).toFixed(1)
      : "?";
    console.log(
      `  [dry-run] Would upload thumbnail: ${basename(thumb)} (${sizeMB} MB)${exists ? "" : " [FILE NOT FOUND]"}`
    );
    platformData.instagramThumbnail = `<local:${thumb}>`;
    return;
  }

  platformData.instagramThumbnail = await uploadFile(apiKey, thumb);
}

async function resolveYouTubeThumbnail(
  apiKey: string,
  mediaItems: Array<{
    type: string;
    url: string;
    thumbnail?: { url: string };
  }>,
  platformData: PlatformSpecificData | undefined,
  dryRun: boolean
): Promise<void> {
  const thumbItem = mediaItems.find((item) => item.thumbnail?.url);
  if (!thumbItem?.thumbnail?.url) return;

  const thumbSource = thumbItem.thumbnail.url;
  delete thumbItem.thumbnail;

  if (!platformData) return;

  if (isUrl(thumbSource)) {
    platformData.thumbnail = thumbSource;
    return;
  }

  if (dryRun) {
    const exists = existsSync(thumbSource);
    const sizeMB = exists
      ? (statSync(thumbSource).size / 1024 / 1024).toFixed(1)
      : "?";
    console.log(
      `  [dry-run] Would upload YT thumbnail: ${basename(thumbSource)} (${sizeMB} MB)${exists ? "" : " [FILE NOT FOUND]"}`
    );
    platformData.thumbnail = `<local:${thumbSource}>`;
    return;
  }

  platformData.thumbnail = await uploadFile(apiKey, thumbSource);
}

// ── Text post ──

async function processTextPost(
  apiKey: string,
  accounts: Account[],
  content: string,
  platforms: string[],
  schedule: Date | null,
  dryRun: boolean,
  index?: number
): Promise<boolean> {
  const prefix = index !== undefined ? `[${index + 1}] ` : "";

  const platformTargets: PlatformTarget[] = [];
  const notFound: string[] = [];

  for (const platform of platforms) {
    const latePlatformName = resolveLatePlatformName(platform);
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
    console.error(
      `${prefix}Error: No connected accounts found for requested platforms`
    );
    console.error(`${prefix}Requested: ${platforms.join(", ")}`);
    console.error(
      `${prefix}Available: ${accounts.map((a) => a.platform).join(", ")}`
    );
    return false;
  }

  if (notFound.length > 0) {
    console.warn(
      `${prefix}Warning: No account connected for: ${notFound.join(", ")}`
    );
  }

  if (dryRun) {
    console.log(`${prefix}=== DRY RUN (text) ===`);
    console.log(
      `${prefix}Content (${content.length} chars): ${content.slice(0, 50)}...`
    );
    console.log(
      `${prefix}Platforms: ${platformTargets.map((p) => p.platform).join(", ")}`
    );
    if (schedule) {
      console.log(
        `${prefix}Scheduled: ${schedule.toLocaleString("ja-JP", { timeZone: TIMEZONE })} JST`
      );
    } else {
      console.log(`${prefix}Would post immediately`);
    }
    console.log("");
    return true;
  }

  const body: Record<string, unknown> = {
    content,
    platforms: platformTargets,
    timezone: TIMEZONE,
  };

  if (schedule) {
    body.scheduledFor = schedule.toISOString();
  } else {
    body.publishNow = true;
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

  const data = await response.json();

  if (!response.ok) {
    console.error(`${prefix}Error:`, JSON.stringify(data, null, 2));
    return false;
  }

  const post = (data as { post: { _id: string; status: string; scheduledFor?: string; platforms: Array<{ platform: string; status: string }> } }).post;
  console.log(`${prefix}Post created (ID: ${post._id})`);
  console.log(`${prefix}  Status: ${post.status}`);
  if (post.scheduledFor) {
    const scheduledDate = new Date(post.scheduledFor);
    console.log(
      `${prefix}  Scheduled: ${scheduledDate.toLocaleString("ja-JP", { timeZone: TIMEZONE })} JST`
    );
  }
  console.log(
    `${prefix}  Platforms: ${post.platforms.map((p) => `${p.platform}(${p.status})`).join(", ")}`
  );
  console.log("");
  return true;
}

// ── Media post ──

async function processMediaPost(
  apiKey: string,
  accounts: Account[],
  input: MediaPostInput,
  dryRun: boolean,
  index?: number
): Promise<boolean> {
  const prefix = index !== undefined ? `[${index + 1}] ` : "";

  if (!input.mediaItems || input.mediaItems.length === 0) {
    console.error(`${prefix}Error: At least one media item is required`);
    return false;
  }

  const targetPlatform = input.platforms?.[0]?.platform || "instagram";
  const platformEntry = input.platforms?.find(
    (p) => p.platform === targetPlatform
  );
  const platformData = platformEntry?.platformSpecificData;
  const contentType = detectContentType(
    input.mediaItems,
    platformData?.contentType
  );
  const schedule = input.schedule ? parseSchedule(input.schedule) : null;

  console.log(`${prefix}Target platform: ${targetPlatform}`);

  if (dryRun) {
    console.log(`${prefix}Resolving media...`);
    const mediaUrls = input.mediaItems.map((item) => dryRunMediaItem(item));
    if (targetPlatform === "instagram") {
      await resolveThumbnail("", platformData, true);
    } else if (targetPlatform === "youtube") {
      await resolveYouTubeThumbnail("", mediaUrls, platformData, true);
    }
    console.log("");

    console.log(`${prefix}=== DRY RUN (media) ===`);
    console.log(`${prefix}Platform: ${targetPlatform}`);
    console.log(
      `${prefix}Caption (${input.content.length} chars): ${input.content.slice(0, 80)}...`
    );
    console.log(`${prefix}Type: ${contentType}`);
    console.log(
      `${prefix}Media: ${mediaUrls.map((m) => `${m.type}:${m.url}`).join(", ")}`
    );
    if (targetPlatform === "youtube" && platformData?.title) {
      console.log(
        `${prefix}YT Title (${platformData.title.length}/100): ${platformData.title}`
      );
    }
    if (platformData?.firstComment || input.firstComment) {
      const fc = platformData?.firstComment || input.firstComment;
      console.log(`${prefix}First comment: ${fc!.slice(0, 60)}...`);
    }
    if (input.tiktokSettings) {
      console.log(
        `${prefix}TikTok settings: privacy=${input.tiktokSettings.privacy_level}, cover=${input.tiktokSettings.video_cover_timestamp_ms}ms`
      );
    }
    if (schedule) {
      console.log(
        `${prefix}Scheduled: ${schedule.toLocaleString("ja-JP", { timeZone: TIMEZONE })} JST`
      );
    } else {
      console.log(`${prefix}Would post immediately`);
    }
    console.log("");
    return true;
  }

  // Find account
  const account = accounts.find((a) => a.platform === targetPlatform);
  if (!account) {
    console.error(
      `${prefix}Error: No ${targetPlatform} account connected. Available: ${accounts.map((a) => `${a.platform}(${a.username || a.name})`).join(", ")}`
    );
    return false;
  }

  console.log(
    `${prefix}${targetPlatform} account: ${account.username || account.name || account._id}\n`
  );

  // Upload media
  console.log(`${prefix}Uploading media...`);
  const mediaUrls: Array<{
    type: string;
    url: string;
    thumbnail?: { url: string };
  }> = [];
  for (const item of input.mediaItems) {
    const uploaded = await uploadMediaItem(apiKey, item);
    mediaUrls.push(uploaded);
  }

  // Handle thumbnails per platform
  if (targetPlatform === "instagram") {
    await resolveThumbnail(apiKey, platformData, false);
  } else if (targetPlatform === "youtube") {
    await resolveYouTubeThumbnail(apiKey, mediaUrls, platformData, false);
  }

  console.log("");

  // Build platform-specific data
  const cleanPlatformData: Record<string, unknown> = { ...platformData };

  let finalMediaItems = [...mediaUrls];
  if (targetPlatform === "instagram") {
    if (contentType === "reels" || contentType === "story") {
      cleanPlatformData.contentType = contentType;
    }
    if (cleanPlatformData.instagramThumbnail) {
      finalMediaItems = finalMediaItems.map((m) => {
        if (m.type === "video") {
          return {
            ...m,
            instagramThumbnail: cleanPlatformData.instagramThumbnail as string,
          };
        }
        return m;
      });
      delete cleanPlatformData.instagramThumbnail;
    }
  }

  delete cleanPlatformData.thumbOffset;

  const body: Record<string, unknown> = {
    content: input.content,
    mediaItems: finalMediaItems,
    platforms: [
      {
        platform: targetPlatform,
        accountId: account._id,
        platformSpecificData: cleanPlatformData,
      },
    ],
    timezone: TIMEZONE,
  };

  // TikTok settings
  if (targetPlatform === "tiktok" && input.tiktokSettings) {
    body.tiktokSettings = {
      ...input.tiktokSettings,
      content_preview_confirmed: true,
      express_consent_given: true,
    };
  }

  // First comment
  if (input.firstComment) {
    if (targetPlatform === "youtube") {
      cleanPlatformData.firstComment = input.firstComment;
    } else {
      body.firstComment = input.firstComment;
    }
  }

  if (schedule) {
    body.scheduledFor = schedule.toISOString();
  } else {
    body.publishNow = true;
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

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`${prefix}Error: Unexpected response:`, text.slice(0, 300));
    return false;
  }

  if (!response.ok) {
    console.error(`${prefix}Error:`, JSON.stringify(data, null, 2));
    return false;
  }

  const post = (
    data as {
      post: {
        _id: string;
        status: string;
        scheduledFor?: string;
        platforms: Array<{ platform: string; status: string }>;
      };
    }
  ).post;
  console.log(`${prefix}Post created (ID: ${post._id})`);
  console.log(`${prefix}  Status: ${post.status}`);
  if (post.scheduledFor) {
    const scheduledDate = new Date(post.scheduledFor);
    console.log(
      `${prefix}  Scheduled: ${scheduledDate.toLocaleString("ja-JP", { timeZone: TIMEZONE })} JST`
    );
  }
  console.log(
    `${prefix}  Platforms: ${post.platforms.map((p) => `${p.platform}(${p.status})`).join(", ")}`
  );
  return true;
}

// ── Main ──

async function main() {
  const { values } = parseArgs({
    options: {
      // Text mode
      text: { type: "string", short: "t" },
      file: { type: "string", short: "f" },
      // Common
      json: { type: "string", short: "j" },
      schedule: { type: "string", short: "s" },
      platforms: { type: "string", short: "p", default: "all" },
      "dry-run": { type: "boolean", short: "n", default: false },
      // Media mode
      media: { type: "string", short: "m" },
      caption: { type: "string", short: "c" },
      type: { type: "string" },
      "first-comment": { type: "string" },
      thumbnail: { type: "string" },
    },
  });

  const dryRun = values["dry-run"] ?? false;

  // ── JSON batch mode ──
  if (values.json) {
    const jsonPath = values.json;
    if (!existsSync(jsonPath)) {
      console.error(`Error: JSON file not found: ${jsonPath}`);
      process.exit(1);
    }

    let parsed: unknown;
    try {
      const content = readFileSync(jsonPath, "utf-8");
      parsed = JSON.parse(content);
    } catch {
      console.error(`Error: Invalid JSON file: ${jsonPath}`);
      process.exit(1);
    }

    const entries: UnifiedPostInput[] = Array.isArray(parsed)
      ? parsed
      : [parsed as UnifiedPostInput];

    console.log(`Processing ${entries.length} post(s)...\n`);

    const apiKey = dryRun ? "" : getEnvOrExit("LATE_API_KEY", envPath);
    const accounts = dryRun
      ? []
      : await fetchAccounts(apiKey, PROFILE_ID || undefined);

    let success = 0;
    let failed = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const idx = entries.length > 1 ? i : undefined;

      try {
        let ok: boolean;
        if (isMediaPost(entry)) {
          ok = await processMediaPost(
            apiKey,
            accounts,
            entry,
            dryRun,
            idx
          );
        } else {
          const platforms = parsePlatformsList(
            (entry as TextPostInput).platforms || DEFAULT_PLATFORMS
          );
          const schedule = (entry as TextPostInput).schedule
            ? parseSchedule((entry as TextPostInput).schedule!)
            : null;
          ok = await processTextPost(
            apiKey,
            accounts,
            entry.content,
            platforms,
            schedule,
            dryRun,
            idx
          );
        }
        if (ok) success++;
        else failed++;
      } catch (err) {
        const prefix = entries.length > 1 ? `[${i + 1}] ` : "";
        console.error(
          `${prefix}Error: ${err instanceof Error ? err.message : err}`
        );
        failed++;
      }
    }

    if (entries.length > 1) {
      console.log(`\n=== Summary ===`);
      console.log(`Success: ${success}`);
      console.log(`Failed: ${failed}`);
    }

    if (failed > 0 && success === 0) process.exit(1);
    return;
  }

  // ── Text single mode ──
  if (values.text || values.file) {
    let content: string;

    if (values.file) {
      if (!existsSync(values.file)) {
        console.error(`Error: File not found: ${values.file}`);
        process.exit(1);
      }
      content = readFileSync(values.file, "utf-8").trim();
    } else {
      content = values.text!;
    }

    const apiKey = getEnvOrExit("LATE_API_KEY", envPath);
    const accounts = await fetchAccounts(apiKey, PROFILE_ID || undefined);
    const platforms = parsePlatformsList(values.platforms ?? DEFAULT_PLATFORMS);
    const schedule = values.schedule ? parseSchedule(values.schedule) : null;

    await processTextPost(
      apiKey,
      accounts,
      content,
      platforms,
      schedule,
      dryRun
    );
    return;
  }

  // ── Media single mode ──
  if (values.media && values.caption) {
    const mediaPaths = values.media.split(",").map((p) => p.trim());
    const mediaItems: MediaItem[] = mediaPaths.map((p) => ({
      type: detectMediaType(p),
      path: p,
    }));

    const contentType = detectContentType(mediaItems, values.type);
    const platformData: PlatformSpecificData = {};
    if (values["first-comment"])
      platformData.firstComment = values["first-comment"];
    if (values.thumbnail) platformData.instagramThumbnail = values.thumbnail;

    const input: MediaPostInput = {
      content: values.caption,
      mediaItems,
      platforms: [
        {
          platform: "instagram",
          platformSpecificData: {
            ...platformData,
            contentType: contentType,
          },
        },
      ],
      firstComment: values["first-comment"],
      schedule: values.schedule,
    };

    const apiKey = dryRun ? "" : getEnvOrExit("LATE_API_KEY", envPath);
    const accounts = dryRun
      ? []
      : await fetchAccounts(apiKey, PROFILE_ID || undefined);

    await processMediaPost(apiKey, accounts, input, dryRun);
    return;
  }

  // ── Error: no valid input ──
  console.error(
    "Error: Provide --text, --file, --json, or --media + --caption"
  );
  console.error("");
  console.error("Usage:");
  console.error(
    '  npx tsx post.ts --text "投稿内容" --schedule "2026-01-20 09:00"'
  );
  console.error("  npx tsx post.ts --json posts.json [--dry-run]");
  console.error(
    '  npx tsx post.ts --media video.mp4 --caption "text" [--type reel]'
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
