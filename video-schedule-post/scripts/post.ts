#!/usr/bin/env npx tsx
/**
 * Social media scheduled post using Late API (getlate.dev)
 *
 * Supports: Instagram, YouTube, TikTok
 *
 * Usage:
 *   # From JSON (video-announce output)
 *   npx tsx post.ts --json posts.json
 *
 *   # Direct post (Instagram)
 *   npx tsx post.ts --media video.mp4 --caption "Caption text" --type reel --schedule "2026-03-12 19:00"
 *
 *   # Carousel
 *   npx tsx post.ts --media img1.jpg,img2.jpg,img3.jpg --caption "Carousel" --type carousel
 *
 * JSON format (video-announce output - array or single object):
 *   [
 *     {
 *       "content": "Caption #hashtag",
 *       "mediaItems": [{"type": "video", "path": "/path/to/video.mp4"}],
 *       "platforms": [{"platform": "instagram", "platformSpecificData": {"contentType": "reels"}}],
 *       "schedule": "2026-03-12 19:00"
 *     },
 *     { ... youtube entry ... },
 *     { ... tiktok entry ... }
 *   ]
 *
 * YouTube JSON:
 *   {
 *     "content": "Description text",
 *     "mediaItems": [{"type": "video", "path": "/path/to/video.mp4", "thumbnail": {"url": "path/to/thumb.jpg"}}],
 *     "platforms": [{"platform": "youtube", "platformSpecificData": {"title": "...", "visibility": "public", "categoryId": "28"}}],
 *     "schedule": "2026-03-12 19:00"
 *   }
 *
 * TikTok JSON:
 *   {
 *     "content": "Caption with #hashtags",
 *     "mediaItems": [{"type": "video", "path": "/path/to/video.mp4"}],
 *     "platforms": [{"platform": "tiktok"}],
 *     "tiktokSettings": {"privacy_level": "PUBLIC_TO_EVERYONE", "allow_comment": true, ...},
 *     "schedule": "2026-03-12 19:00"
 *   }
 *
 * Environment variables (.env):
 *   LATE_API_KEY - Late API key from https://getlate.dev
 */

import { readFileSync, existsSync, statSync } from "fs";
import { parseArgs } from "util";
import { dirname, join, extname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = "https://getlate.dev/api/v1";

// --- .env loading ---

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

// Try skill-specific .env first, then fall back to sns-schedule-post .env
const envPath = join(__dirname, "..", ".env");
const fallbackEnvPath = join(__dirname, "..", "..", "sns-schedule-post", ".env");
loadEnv(envPath);
loadEnv(fallbackEnvPath);

// --- Types ---

type ContentType = "feed" | "reels" | "story" | "carousel";
type TargetPlatform = "instagram" | "youtube" | "tiktok";

interface MediaItem {
  type: "image" | "video";
  path?: string;
  url?: string;
  thumbnail?: { url: string };
}

interface PlatformSpecificData {
  contentType?: string;
  shareToFeed?: boolean;
  firstComment?: string;
  collaborators?: string[];
  userTags?: Array<{
    username: string;
    x: number;
    y: number;
    mediaIndex?: number;
  }>;
  thumbOffset?: number;
  instagramThumbnail?: string;
  audioName?: string;
  // YouTube-specific
  title?: string;
  visibility?: string;
  categoryId?: string;
  madeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  thumbnail?: string;
}

interface TikTokSettings {
  privacy_level: string;
  allow_comment: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  content_preview_confirmed: boolean;
  express_consent_given: boolean;
  video_cover_timestamp_ms?: number;
  video_made_with_ai?: boolean;
}

interface PostInput {
  content: string;
  mediaItems: MediaItem[];
  platforms: Array<{
    platform: string;
    platformSpecificData?: PlatformSpecificData;
  }>;
  tiktokSettings?: TikTokSettings;
  firstComment?: string;
  schedule?: string;
}

interface Account {
  _id: string;
  platform: string;
  name?: string;
  username?: string;
}

interface PresignedUrlResponse {
  uploadUrl: string;
  publicUrl: string;
}

// --- Helpers ---

function isUrl(str: string): boolean {
  return str.startsWith("http://") || str.startsWith("https://");
}

async function uploadFile(
  apiKey: string,
  filePath: string
): Promise<string> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const fileName = basename(filePath);
  const mimeType = getMimeType(filePath);
  const fileSize = statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

  console.log(`  Uploading thumbnail: ${fileName} (${sizeMB} MB, ${mimeType})`);

  const { uploadUrl, publicUrl } = await getPresignedUrl(apiKey, fileName, mimeType);
  await uploadMedia(uploadUrl, filePath, mimeType);
  console.log(`  Uploaded thumbnail: ${publicUrl}`);
  return publicUrl;
}

async function resolveThumbnail(
  apiKey: string,
  platformData: PlatformSpecificData | undefined,
  dryRun: boolean
): Promise<void> {
  if (!platformData?.instagramThumbnail) return;
  const thumb = platformData.instagramThumbnail;
  if (isUrl(thumb)) return;

  // Local file path — upload it
  if (dryRun) {
    const exists = existsSync(thumb);
    const sizeMB = exists ? (statSync(thumb).size / 1024 / 1024).toFixed(1) : "?";
    console.log(`  [dry-run] Would upload thumbnail: ${basename(thumb)} (${sizeMB} MB)${exists ? "" : " [FILE NOT FOUND]"}`);
    platformData.instagramThumbnail = `<local:${thumb}>`;
    return;
  }

  platformData.instagramThumbnail = await uploadFile(apiKey, thumb);
}

async function resolveYouTubeThumbnail(
  apiKey: string,
  mediaItems: MediaItem[],
  platformData: PlatformSpecificData | undefined,
  dryRun: boolean
): Promise<void> {
  // Find thumbnail from mediaItems[].thumbnail.url (video-announce output format)
  const thumbItem = mediaItems.find((item) => item.thumbnail?.url);
  if (!thumbItem?.thumbnail?.url) return;

  const thumbSource = thumbItem.thumbnail.url;
  // Remove thumbnail from mediaItems (Late API doesn't accept it on mediaItems for YT)
  delete thumbItem.thumbnail;

  if (!platformData) return;

  if (isUrl(thumbSource)) {
    // Already a URL — set directly on platformSpecificData
    platformData.thumbnail = thumbSource;
    return;
  }

  // Local file path — upload it
  if (dryRun) {
    const exists = existsSync(thumbSource);
    const sizeMB = exists ? (statSync(thumbSource).size / 1024 / 1024).toFixed(1) : "?";
    console.log(`  [dry-run] Would upload YT thumbnail: ${basename(thumbSource)} (${sizeMB} MB)${exists ? "" : " [FILE NOT FOUND]"}`);
    platformData.thumbnail = `<local:${thumbSource}>`;
    return;
  }

  platformData.thumbnail = await uploadFile(apiKey, thumbSource);
}

function getEnvOrExit(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Error: Missing environment variable: ${key}`);
    console.error(`Set it in ${envPath} or ${fallbackEnvPath}`);
    process.exit(1);
  }
  return value;
}

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function detectMediaType(filePath: string): "image" | "video" {
  const ext = extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return "image";
  return "video";
}

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
  if (mediaItems.length === 1 && mediaItems[0].type === "video") {
    return "feed";
  }
  return "feed";
}

function parseSchedule(scheduleStr: string): Date {
  let dt = new Date(scheduleStr);
  if (!isNaN(dt.getTime())) return dt;

  const match = scheduleStr.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/
  );
  if (match) {
    const [, year, month, day, hour, minute] = match;
    const jstDate = new Date(
      `${year}-${month}-${day}T${hour}:${minute}:00+09:00`
    );
    if (!isNaN(jstDate.getTime())) return jstDate;
  }

  throw new Error(`Invalid schedule format: ${scheduleStr}. Expected: "YYYY-MM-DD HH:MM" (JST) or ISO 8601`);
}

function findAccountByPlatform(accounts: Account[], platform: string): Account | null {
  return accounts.find((a) => a.platform === platform) || null;
}

// --- API calls ---

let cachedAccounts: Account[] | null = null;

async function fetchAccounts(apiKey: string): Promise<Account[]> {
  if (cachedAccounts) return cachedAccounts;

  const response = await fetch(`${BASE_URL}/accounts`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    const error = await response.json();
    console.error("Error fetching accounts:", JSON.stringify(error, null, 2));
    process.exit(1);
  }

  const data = (await response.json()) as { accounts: Account[] };
  cachedAccounts = data.accounts;
  return cachedAccounts;
}

async function getPresignedUrl(
  apiKey: string,
  fileName: string,
  fileType: string
): Promise<PresignedUrlResponse> {
  const response = await fetch(`${BASE_URL}/media/presign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filename: fileName, contentType: fileType }),
  });

  if (!response.ok) {
    const text = await response.text();
    let errorMsg: string;
    try {
      errorMsg = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      errorMsg = text.slice(0, 200);
    }
    throw new Error(`Error getting presigned URL: ${errorMsg}`);
  }

  return (await response.json()) as PresignedUrlResponse;
}

async function uploadMedia(
  uploadUrl: string,
  filePath: string,
  contentType: string
): Promise<void> {
  const fileBuffer = readFileSync(filePath);
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fileBuffer,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Error uploading media: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
  }
}

async function uploadMediaItem(
  apiKey: string,
  item: MediaItem
): Promise<{ type: string; url: string; thumbnail?: { url: string } }> {
  // If URL already provided (already uploaded or external URL)
  if (item.url && !item.path) {
    const result: { type: string; url: string; thumbnail?: { url: string } } = { type: item.type, url: item.url };
    if (item.thumbnail) result.thumbnail = item.thumbnail;
    return result;
  }

  const filePath = item.path!;
  if (!existsSync(filePath)) {
    throw new Error(`Media file not found: ${filePath}`);
  }

  const fileName = basename(filePath);
  const mimeType = getMimeType(filePath);
  const fileSize = statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

  console.log(`  Uploading: ${fileName} (${sizeMB} MB, ${mimeType})`);

  const { uploadUrl, publicUrl } = await getPresignedUrl(
    apiKey,
    fileName,
    mimeType
  );

  await uploadMedia(uploadUrl, filePath, mimeType);
  console.log(`  Uploaded: ${publicUrl}`);

  const result: { type: string; url: string; thumbnail?: { url: string } } = { type: item.type, url: publicUrl };
  if (item.thumbnail) result.thumbnail = item.thumbnail;
  return result;
}

async function createPost(
  apiKey: string,
  accountId: string,
  targetPlatform: TargetPlatform,
  content: string,
  mediaUrls: Array<{ type: string; url: string; thumbnail?: { url: string } }>,
  contentType: ContentType,
  platformData: PlatformSpecificData | undefined,
  tiktokSettings: TikTokSettings | undefined,
  firstComment: string | undefined,
  schedule: Date | null,
  dryRun: boolean
): Promise<boolean> {
  if (dryRun) {
    console.log("=== DRY RUN ===");
    console.log(`Platform: ${targetPlatform}`);
    console.log(`Caption (${content.length} chars): ${content.slice(0, 80)}...`);
    console.log(`Type: ${contentType}`);
    console.log(`Media: ${mediaUrls.map((m) => `${m.type}:${m.url}`).join(", ")}`);
    if (targetPlatform === "youtube" && platformData?.title) {
      console.log(`YT Title (${platformData.title.length}/100): ${platformData.title}`);
    }
    if (platformData?.firstComment || firstComment) {
      const fc = platformData?.firstComment || firstComment;
      console.log(`First comment: ${fc!.slice(0, 60)}...`);
    }
    if (tiktokSettings) {
      console.log(`TikTok settings: privacy=${tiktokSettings.privacy_level}, cover=${tiktokSettings.video_cover_timestamp_ms}ms`);
    }
    if (schedule) {
      console.log(
        `Scheduled: ${schedule.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST`
      );
    } else {
      console.log("Would post immediately");
    }
    console.log("");
    return true;
  }

  // Build platform-specific data
  const cleanPlatformData: Record<string, unknown> = { ...platformData };

  // Instagram: handle thumbnail on mediaItems
  let finalMediaItems = [...mediaUrls];
  if (targetPlatform === "instagram") {
    // Set contentType for reels/stories (omit for feed)
    if (contentType === "reels" || contentType === "story") {
      cleanPlatformData.contentType = contentType;
    }
    // Attach instagramThumbnail to the video mediaItem
    if (cleanPlatformData.instagramThumbnail) {
      finalMediaItems = finalMediaItems.map((m) => {
        if (m.type === "video") {
          return { ...m, instagramThumbnail: cleanPlatformData.instagramThumbnail as string };
        }
        return m;
      });
      delete cleanPlatformData.instagramThumbnail;
    }
  }

  // YouTube: thumbnail is on mediaItems[].thumbnail.url (already set from JSON)
  // No additional processing needed — thumbnails are resolved before createPost

  // Remove internal-only fields from platformSpecificData
  delete cleanPlatformData.thumbOffset;

  const body: Record<string, unknown> = {
    content,
    mediaItems: finalMediaItems,
    platforms: [
      {
        platform: targetPlatform,
        accountId,
        platformSpecificData: cleanPlatformData,
      },
    ],
    timezone: "Asia/Tokyo",
  };

  // TikTok: tiktokSettings at top-level body
  if (targetPlatform === "tiktok" && tiktokSettings) {
    body.tiktokSettings = {
      ...tiktokSettings,
      content_preview_confirmed: true,
      express_consent_given: true,
    };
  }

  // First comment: YouTube uses platformSpecificData.firstComment, others use body top-level
  if (firstComment) {
    if (targetPlatform === "youtube") {
      cleanPlatformData.firstComment = firstComment;
    } else {
      body.firstComment = firstComment;
    }
  }

  if (schedule) {
    body.scheduledFor = schedule.toISOString();
  } else {
    body.publishNow = true;
  }

  const response = await fetch(`${BASE_URL}/posts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("Error: Unexpected response:", text.slice(0, 300));
    return false;
  }

  if (!response.ok) {
    console.error("Error:", JSON.stringify(data, null, 2));
    return false;
  }

  const post = (data as { post: { _id: string; status: string; scheduledFor?: string; platforms: Array<{ platform: string; status: string }> } }).post;
  console.log(`Post created (ID: ${post._id})`);
  console.log(`  Status: ${post.status}`);
  if (post.scheduledFor) {
    const scheduledDate = new Date(post.scheduledFor);
    console.log(
      `  Scheduled: ${scheduledDate.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST`
    );
  }
  console.log(
    `  Platforms: ${post.platforms.map((p) => `${p.platform}(${p.status})`).join(", ")}`
  );
  return true;
}

// --- Dry-run helpers ---

function dryRunMediaItem(item: MediaItem): { type: string; url: string; thumbnail?: { url: string } } {
  if (item.url && !item.path) {
    const result: { type: string; url: string; thumbnail?: { url: string } } = { type: item.type, url: item.url };
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
  const result: { type: string; url: string; thumbnail?: { url: string } } = { type: item.type, url: `<local:${filePath}>` };
  if (item.thumbnail) {
    console.log(`  [dry-run] Would upload YT thumbnail: ${basename(item.thumbnail.url)}`);
    result.thumbnail = { url: `<local:${item.thumbnail.url}>` };
  }
  return result;
}

// --- JSON mode ---

async function processSingleEntry(
  input: PostInput,
  apiKey: string,
  accounts: Account[] | null,
  dryRun: boolean,
  index?: number
): Promise<boolean> {
  const prefix = index !== undefined ? `[${index + 1}] ` : "";

  if (!input.mediaItems || input.mediaItems.length === 0) {
    throw new Error("At least one media item is required");
  }

  // Determine target platform from JSON
  const targetPlatform = (input.platforms?.[0]?.platform || "instagram") as TargetPlatform;
  const platformEntry = input.platforms?.find((p) => p.platform === targetPlatform);
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
    await createPost(
      "", "dry-run", targetPlatform, input.content, mediaUrls,
      contentType, platformData, input.tiktokSettings, input.firstComment,
      schedule, true
    );
    return true;
  }

  const account = findAccountByPlatform(accounts!, targetPlatform);

  if (!account) {
    throw new Error(
      `No ${targetPlatform} account connected. Available: ${accounts!.map((a) => `${a.platform}(${a.username || a.name})`).join(", ")}`
    );
  }

  console.log(`${prefix}${targetPlatform} account: ${account.username || account.name || account._id}\n`);

  // Upload media
  console.log(`${prefix}Uploading media...`);
  let mediaUrls: Array<{ type: string; url: string; thumbnail?: { url: string } }> = [];
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
  // TikTok: no thumbnail upload needed (uses video_cover_timestamp_ms)

  console.log("");

  return await createPost(
    apiKey, account._id, targetPlatform, input.content, mediaUrls,
    contentType, platformData, input.tiktokSettings, input.firstComment,
    schedule, false
  );
}

async function processBatchPosts(jsonPath: string, dryRun: boolean): Promise<void> {
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

  // Support both array and single object (backward compatible)
  const entries: PostInput[] = Array.isArray(parsed) ? parsed : [parsed as PostInput];

  console.log(`Processing ${entries.length} post(s)...\n`);

  const apiKey = dryRun ? "" : getEnvOrExit("LATE_API_KEY");
  const accounts = dryRun ? null : await fetchAccounts(apiKey);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i++) {
    try {
      const ok = await processSingleEntry(
        entries[i],
        apiKey,
        accounts,
        dryRun,
        entries.length > 1 ? i : undefined
      );
      if (ok) {
        success++;
      } else {
        failed++;
      }
    } catch (err) {
      const prefix = entries.length > 1 ? `[${i + 1}] ` : "";
      console.error(`${prefix}Error: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  if (entries.length > 1) {
    console.log(`\n=== Summary ===`);
    console.log(`Success: ${success}`);
    console.log(`Failed: ${failed}`);
  }

  if (failed > 0 && success === 0) process.exit(1);
}

// --- CLI mode ---

async function processCliPost(
  mediaStr: string,
  caption: string,
  type: string | undefined,
  scheduleStr: string | undefined,
  firstComment: string | undefined,
  thumbnail: string | undefined,
  dryRun: boolean
): Promise<void> {
  const mediaPaths = mediaStr.split(",").map((p) => p.trim());

  const mediaItems: MediaItem[] = mediaPaths.map((p) => ({
    type: detectMediaType(p),
    path: p,
  }));

  const contentType = detectContentType(mediaItems, type);
  const platformData: PlatformSpecificData = {};
  if (firstComment) platformData.firstComment = firstComment;
  if (thumbnail) platformData.instagramThumbnail = thumbnail;
  const schedule = scheduleStr ? parseSchedule(scheduleStr) : null;

  // CLI mode defaults to Instagram (backward compatible)
  const targetPlatform: TargetPlatform = "instagram";

  if (dryRun) {
    console.log("Resolving media...");
    const mediaUrls = mediaItems.map((item) => dryRunMediaItem(item));
    await resolveThumbnail("", platformData, true);
    console.log("");
    await createPost(
      "", "dry-run", targetPlatform, caption, mediaUrls,
      contentType, platformData, undefined, firstComment,
      schedule, true
    );
    return;
  }

  const apiKey = getEnvOrExit("LATE_API_KEY");
  const accounts = await fetchAccounts(apiKey);
  const account = findAccountByPlatform(accounts, targetPlatform);

  if (!account) {
    console.error("Error: No Instagram account connected");
    console.error(
      `Available platforms: ${accounts.map((a) => a.platform).join(", ")}`
    );
    process.exit(1);
  }

  console.log(`Instagram account: ${account.username || account.name || account._id}\n`);

  // Upload media
  console.log("Uploading media...");
  const mediaUrls: Array<{ type: string; url: string; thumbnail?: { url: string } }> = [];
  for (const item of mediaItems) {
    const uploaded = await uploadMediaItem(apiKey, item);
    mediaUrls.push(uploaded);
  }
  await resolveThumbnail(apiKey, platformData, false);
  console.log("");

  const ok = await createPost(
    apiKey, account._id, targetPlatform, caption, mediaUrls,
    contentType, platformData, undefined, firstComment,
    schedule, false
  );

  if (!ok) process.exit(1);
}

// --- Main ---

async function main() {
  const { values } = parseArgs({
    options: {
      json: { type: "string", short: "j" },
      media: { type: "string", short: "m" },
      caption: { type: "string", short: "c" },
      type: { type: "string", short: "t" },
      schedule: { type: "string", short: "s" },
      "first-comment": { type: "string" },
      thumbnail: { type: "string" },
      "dry-run": { type: "boolean", short: "n", default: false },
    },
  });

  const dryRun = values["dry-run"] ?? false;

  if (values.json) {
    await processBatchPosts(values.json, dryRun);
    return;
  }

  if (values.media && values.caption) {
    await processCliPost(
      values.media,
      values.caption,
      values.type,
      values.schedule,
      values["first-comment"],
      values.thumbnail,
      dryRun
    );
    return;
  }

  console.error("Error: Provide --json FILE or --media FILE --caption TEXT");
  console.error("");
  console.error("Usage:");
  console.error('  npx tsx post.ts --json posts.json');
  console.error('  npx tsx post.ts --media video.mp4 --caption "text" [--type reel]');
  process.exit(1);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
