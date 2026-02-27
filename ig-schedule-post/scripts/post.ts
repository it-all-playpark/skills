#!/usr/bin/env npx tsx
/**
 * Instagram scheduled post using Late API (getlate.dev)
 *
 * Usage:
 *   # From JSON (ig-announce output)
 *   npx tsx post.ts --json posts.json
 *
 *   # Direct post
 *   npx tsx post.ts --media video.mp4 --caption "Caption text" --type reel --schedule "2026-03-12 19:00"
 *
 *   # Carousel
 *   npx tsx post.ts --media img1.jpg,img2.jpg,img3.jpg --caption "Carousel" --type carousel
 *
 * JSON format (ig-announce output):
 *   {
 *     "content": "Caption #hashtag",
 *     "mediaItems": [{"type": "video", "path": "/path/to/video.mp4"}],
 *     "platforms": [{"platform": "instagram", "platformSpecificData": {"contentType": "reels"}}],
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

interface MediaItem {
  type: "image" | "video";
  path?: string;
  url?: string;
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
}

interface PostInput {
  content: string;
  mediaItems: MediaItem[];
  platforms: Array<{
    platform: string;
    platformSpecificData?: PlatformSpecificData;
  }>;
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
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
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
    // Could be reel based on aspect ratio, but we default to feed
    // and let the user override with --type reel
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

  console.error(`Error: Invalid schedule format: ${scheduleStr}`);
  console.error('Expected: "YYYY-MM-DD HH:MM" (JST) or ISO 8601');
  process.exit(1);
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

function findInstagramAccount(accounts: Account[]): Account | null {
  return accounts.find((a) => a.platform === "instagram") || null;
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
    console.error("Error getting presigned URL:", errorMsg);
    process.exit(1);
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
    console.error(`Error uploading media: ${response.status} ${response.statusText}`);
    const text = await response.text();
    if (text) console.error(text);
    process.exit(1);
  }
}

async function uploadMediaItem(
  apiKey: string,
  item: MediaItem
): Promise<{ type: string; url: string }> {
  // If URL already provided (already uploaded or external URL)
  if (item.url && !item.path) {
    return { type: item.type, url: item.url };
  }

  const filePath = item.path!;
  if (!existsSync(filePath)) {
    console.error(`Error: Media file not found: ${filePath}`);
    process.exit(1);
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

  return { type: item.type, url: publicUrl };
}

async function createPost(
  apiKey: string,
  accountId: string,
  content: string,
  mediaUrls: Array<{ type: string; url: string }>,
  contentType: ContentType,
  platformData: PlatformSpecificData | undefined,
  schedule: Date | null,
  dryRun: boolean
): Promise<boolean> {
  if (dryRun) {
    console.log("=== DRY RUN ===");
    console.log(`Caption (${content.length} chars): ${content.slice(0, 80)}...`);
    console.log(`Type: ${contentType}`);
    console.log(`Media: ${mediaUrls.map((m) => `${m.type}:${m.url}`).join(", ")}`);
    if (platformData?.firstComment) {
      console.log(`First comment: ${platformData.firstComment.slice(0, 60)}...`);
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

  const platformSpecificData: PlatformSpecificData = {
    ...platformData,
  };

  // Set contentType for reels/stories (omit for feed)
  if (contentType === "reels" || contentType === "story") {
    platformSpecificData.contentType = contentType;
  }

  // Attach instagramThumbnail to the video mediaItem (Late expects it there, not in platformSpecificData)
  const finalMediaItems = mediaUrls.map((m) => {
    if (m.type === "video" && platformSpecificData.instagramThumbnail) {
      return { ...m, instagramThumbnail: platformSpecificData.instagramThumbnail };
    }
    return m;
  });
  // Remove from platformSpecificData to avoid duplication
  const { instagramThumbnail: _thumb, ...cleanPlatformData } = platformSpecificData;

  const body: Record<string, unknown> = {
    content,
    mediaItems: finalMediaItems,
    platforms: [
      {
        platform: "instagram",
        accountId,
        platformSpecificData: cleanPlatformData,
      },
    ],
    timezone: "Asia/Tokyo",
  };

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

function dryRunMediaItem(item: MediaItem): { type: string; url: string } {
  if (item.url && !item.path) {
    return { type: item.type, url: item.url };
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
  return { type: item.type, url: `<local:${filePath}>` };
}

// --- JSON mode ---

async function processJsonPost(jsonPath: string, dryRun: boolean): Promise<void> {
  if (!existsSync(jsonPath)) {
    console.error(`Error: JSON file not found: ${jsonPath}`);
    process.exit(1);
  }

  let input: PostInput;
  try {
    const content = readFileSync(jsonPath, "utf-8");
    input = JSON.parse(content);
  } catch {
    console.error(`Error: Invalid JSON file: ${jsonPath}`);
    process.exit(1);
  }

  if (!input.mediaItems || input.mediaItems.length === 0) {
    console.error("Error: Instagram requires at least one media item");
    process.exit(1);
  }

  // Determine content type
  const igPlatform = input.platforms?.find((p) => p.platform === "instagram");
  const platformData = igPlatform?.platformSpecificData;
  const contentType = detectContentType(
    input.mediaItems,
    platformData?.contentType
  );
  const schedule = input.schedule ? parseSchedule(input.schedule) : null;

  if (dryRun) {
    console.log("Resolving media...");
    const mediaUrls = input.mediaItems.map((item) => dryRunMediaItem(item));
    await resolveThumbnail("", platformData, true);
    console.log("");
    await createPost("", "dry-run", input.content, mediaUrls, contentType, platformData, schedule, true);
    return;
  }

  const apiKey = getEnvOrExit("LATE_API_KEY");
  const accounts = await fetchAccounts(apiKey);
  const igAccount = findInstagramAccount(accounts);

  if (!igAccount) {
    console.error("Error: No Instagram account connected");
    console.error(
      `Available platforms: ${accounts.map((a) => a.platform).join(", ")}`
    );
    process.exit(1);
  }

  console.log(`Instagram account: ${igAccount.username || igAccount.name || igAccount._id}\n`);

  // Upload media
  console.log("Uploading media...");
  const mediaUrls: Array<{ type: string; url: string }> = [];
  for (const item of input.mediaItems) {
    const uploaded = await uploadMediaItem(apiKey, item);
    mediaUrls.push(uploaded);
  }
  await resolveThumbnail(apiKey, platformData, false);
  console.log("");

  const ok = await createPost(
    apiKey,
    igAccount._id,
    input.content,
    mediaUrls,
    contentType,
    platformData,
    schedule,
    false
  );

  if (!ok) process.exit(1);
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

  if (dryRun) {
    console.log("Resolving media...");
    const mediaUrls = mediaItems.map((item) => dryRunMediaItem(item));
    await resolveThumbnail("", platformData, true);
    console.log("");
    await createPost("", "dry-run", caption, mediaUrls, contentType, platformData, schedule, true);
    return;
  }

  const apiKey = getEnvOrExit("LATE_API_KEY");
  const accounts = await fetchAccounts(apiKey);
  const igAccount = findInstagramAccount(accounts);

  if (!igAccount) {
    console.error("Error: No Instagram account connected");
    console.error(
      `Available platforms: ${accounts.map((a) => a.platform).join(", ")}`
    );
    process.exit(1);
  }

  console.log(`Instagram account: ${igAccount.username || igAccount.name || igAccount._id}\n`);

  // Upload media
  console.log("Uploading media...");
  const mediaUrls: Array<{ type: string; url: string }> = [];
  for (const item of mediaItems) {
    const uploaded = await uploadMediaItem(apiKey, item);
    mediaUrls.push(uploaded);
  }
  await resolveThumbnail(apiKey, platformData, false);
  console.log("");

  const ok = await createPost(
    apiKey,
    igAccount._id,
    caption,
    mediaUrls,
    contentType,
    platformData,
    schedule,
    false
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
    await processJsonPost(values.json, dryRun);
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
