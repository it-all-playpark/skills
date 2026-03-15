/**
 * Late API shared module
 *
 * Common library for all Late API skills (late-schedule-post, late-sync).
 * Extracted from sns-schedule-post, video-schedule-post, and late-sync.
 */

import { readFileSync, existsSync, writeFileSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";

// ── Core Types ──

export interface Account {
  _id: string;
  platform: string;
  name?: string;
  username?: string;
}

export interface PlatformTarget {
  platform: string;
  accountId: string;
  platformSpecificData?: Record<string, unknown>;
}

export interface MediaItem {
  type: "image" | "video";
  path?: string;
  url?: string;
  thumbnail?: { url: string };
}

export interface PlatformSpecificData {
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
  // YouTube
  title?: string;
  visibility?: string;
  categoryId?: string;
  madeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  thumbnail?: string;
}

export interface TikTokSettings {
  privacy_level: string;
  allow_comment: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  content_preview_confirmed: boolean;
  express_consent_given: boolean;
  video_cover_timestamp_ms?: number;
  video_made_with_ai?: boolean;
}

export interface PostRequest {
  content: string;
  platforms: PlatformTarget[];
  mediaItems?: Array<{
    type: string;
    url: string;
    thumbnail?: { url: string };
    instagramThumbnail?: string;
  }>;
  scheduledFor?: string;
  timezone?: string;
  publishNow?: boolean;
  firstComment?: string;
  tiktokSettings?: TikTokSettings;
  customContent?: Record<string, unknown>;
}

export interface PostResponse {
  post: {
    _id: string;
    content: string;
    status: string;
    scheduledFor?: string;
    platforms: Array<{ platform: string; status: string }>;
  };
}

export interface PresignedUrlResponse {
  uploadUrl: string;
  publicUrl: string;
  expires?: string;
}

// ── JSON Input Types (sns-announce / video-announce output compatible) ──

/** sns-announce output format */
export interface TextPostInput {
  content: string;
  schedule?: string;
  platforms: string | string[];
}

/** video-announce output format */
export interface MediaPostInput {
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

/** Unified input: auto-detect TextPostInput | MediaPostInput */
export type UnifiedPostInput = TextPostInput | MediaPostInput;

// ── Environment ──

export function loadEnv(path: string, verbose?: boolean): void {
  if (!existsSync(path)) {
    if (verbose) {
      console.error(`[late-api] loadEnv: ${path} (not found, skipped)`);
    }
    return;
  }
  const content = readFileSync(path, "utf-8");
  let keyCount = 0;
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
      keyCount++;
    }
  }
  if (verbose) {
    console.error(
      `[late-api] loadEnv: ${path} (${keyCount} keys loaded)`
    );
  }
}

export function getEnvOrExit(key: string, envPath?: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Error: Missing environment variable: ${key}`);
    if (envPath) {
      console.error(`Set it in ${envPath}`);
    }
    process.exit(1);
  }
  return value;
}

// ── Config ──

export function deepMerge(
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

export function loadSkillConfig(
  skillName: string,
  verbose?: boolean
): Record<string, unknown> {
  const sources: string[] = [];

  // Layer 1: Global (~/.claude/skill-config.json)
  let globalCfg: Record<string, unknown> = {};
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  if (homedir) {
    const globalPath = join(homedir, ".claude", "skill-config.json");
    if (existsSync(globalPath)) {
      try {
        const data = JSON.parse(readFileSync(globalPath, "utf-8"));
        const section = data[skillName];
        if (section && typeof section === "object") {
          globalCfg = section as Record<string, unknown>;
          sources.push(`global(${globalPath})`);
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Layer 2: Project (.claude/skill-config.json)
  let projectCfg: Record<string, unknown> = {};
  let gitRoot: string;
  try {
    gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
    }).trim();
  } catch {
    if (verbose && sources.length > 0) {
      console.error(
        `[late-api] loadSkillConfig("${skillName}"): ${sources.join(" + ")}`
      );
    }
    return globalCfg;
  }
  const configPath = join(gitRoot, ".claude", "skill-config.json");
  if (existsSync(configPath)) {
    try {
      const data = JSON.parse(readFileSync(configPath, "utf-8"));
      const section = data[skillName];
      if (section && typeof section === "object") {
        projectCfg = section as Record<string, unknown>;
        sources.push(`project(${configPath})`);
      }
    } catch {
      // ignore parse errors
    }
  }

  if (verbose && sources.length > 0) {
    console.error(
      `[late-api] loadSkillConfig("${skillName}"): ${sources.join(" + ")}`
    );
  }

  // Merge: global + project (project wins)
  if (Object.keys(globalCfg).length === 0) return projectCfg;
  if (Object.keys(projectCfg).length === 0) return globalCfg;
  return deepMerge(globalCfg, projectCfg);
}

// ── Schedule ──

export function parseSchedule(scheduleStr: string, timezone?: string): Date {
  // Try "YYYY-MM-DD HH:MM" (assume JST by default)
  const match = scheduleStr.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/
  );
  if (match) {
    const [, year, month, day, hour, minute] = match;
    const tz = timezone || "Asia/Tokyo";
    // Map common timezone names to UTC offsets for Date parsing
    const tzOffset = tz === "Asia/Tokyo" ? "+09:00" : "+00:00";
    const jstDate = new Date(
      `${year}-${month}-${day}T${hour}:${minute}:00${tzOffset}`
    );
    if (!isNaN(jstDate.getTime())) {
      return jstDate;
    }
  }

  // Try ISO 8601
  const dt = new Date(scheduleStr);
  if (!isNaN(dt.getTime())) {
    return dt;
  }

  throw new Error(
    `Invalid schedule format: ${scheduleStr}. Expected: "YYYY-MM-DD HH:MM" (JST) or ISO 8601`
  );
}

export function isoToJstDatetime(isoString: string): string {
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

// ── Platform ──

export const ALL_PLATFORMS = [
  "x",
  "linkedin",
  "facebook",
  "googlebusiness",
  "threads",
  "bluesky",
] as const;

export const PLATFORM_ALIASES: Record<string, string> = {
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
  instagram: "instagram",
  youtube: "youtube",
  tiktok: "tiktok",
};

export const LATE_PLATFORM_NAMES: Record<string, string> = {
  x: "twitter",
  linkedin: "linkedin",
  facebook: "facebook",
  googlebusiness: "googlebusiness",
  threads: "threads",
  bluesky: "bluesky",
  instagram: "instagram",
  youtube: "youtube",
  tiktok: "tiktok",
};

export function resolveLatePlatformName(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  return PLATFORM_ALIASES[normalized] || LATE_PLATFORM_NAMES[normalized] || normalized;
}

export function parsePlatformsList(input: string | string[]): string[] {
  const items = Array.isArray(input) ? input : input.split(",");

  if (items.length === 1 && items[0].trim().toLowerCase() === "all") {
    return ALL_PLATFORMS.map((p) => resolveLatePlatformName(p));
  }

  const platforms: string[] = [];
  for (const p of items) {
    const resolved = resolveLatePlatformName(p);
    if (!platforms.includes(resolved)) {
      platforms.push(resolved);
    }
  }
  return platforms;
}

// ── API Client ──

export const BASE_URL = "https://getlate.dev/api/v1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sleep };

export async function rateLimitedRequest(
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

const accountsCache = new Map<string, Account[]>();

export async function fetchAccounts(
  apiKey: string,
  profileId?: string
): Promise<Account[]> {
  const cacheKey = profileId || "__all__";
  if (accountsCache.has(cacheKey)) return accountsCache.get(cacheKey)!;

  let url = `${BASE_URL}/accounts`;
  if (profileId) url += `?profileId=${profileId}`;

  const response = await rateLimitedRequest(() =>
    fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to fetch accounts: ${JSON.stringify(error)}`);
  }

  const data = (await response.json()) as { accounts: Account[] };
  accountsCache.set(cacheKey, data.accounts);
  return data.accounts;
}

// ── Media Upload ──

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

export function detectMediaType(filePath: string): "image" | "video" {
  const ext = extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return "image";
  return "video";
}

export async function getPresignedUrl(
  apiKey: string,
  fileName: string,
  contentType: string
): Promise<PresignedUrlResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000); // 30s
  const response = await rateLimitedRequest(() =>
    fetch(`${BASE_URL}/media/presign`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filename: fileName, contentType }),
      signal: controller.signal,
    })
  );
  clearTimeout(timeout);

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

export async function uploadMedia(
  uploadUrl: string,
  filePath: string,
  contentType: string,
  maxRetries = 3
): Promise<void> {
  const fileBuffer = readFileSync(filePath);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000); // 2min
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: fileBuffer,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Error uploading media: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`
        );
      }
      return;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const wait = attempt * 3000;
      console.log(`  Retry ${attempt}/${maxRetries} after ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export async function uploadMediaItem(
  apiKey: string,
  item: MediaItem
): Promise<{ type: string; url: string; thumbnail?: { url: string } }> {
  // If URL already provided (already uploaded or external URL)
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

  const result: {
    type: string;
    url: string;
    thumbnail?: { url: string };
  } = { type: item.type, url: publicUrl };
  if (item.thumbnail) result.thumbnail = item.thumbnail;
  return result;
}

// ── Upload Cache [C1] ──

interface UploadCacheEntry {
  hash: string;
  publicUrl: string;
  uploadedAt: string;
}

const UPLOAD_CACHE_FILE = ".late-upload-cache.json";

function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function loadUploadCache(cacheFile: string): Map<string, string> {
  if (!existsSync(cacheFile)) return new Map();
  try {
    const entries: UploadCacheEntry[] = JSON.parse(
      readFileSync(cacheFile, "utf-8")
    );
    return new Map(entries.map((e) => [e.hash, e.publicUrl]));
  } catch {
    return new Map();
  }
}

function saveUploadCache(
  cacheFile: string,
  cache: Map<string, string>
): void {
  const entries: UploadCacheEntry[] = [...cache.entries()].map(
    ([hash, publicUrl]) => ({
      hash,
      publicUrl,
      uploadedAt: new Date().toISOString(),
    })
  );
  writeFileSync(cacheFile, JSON.stringify(entries, null, 2));
}

export async function uploadMediaItemCached(
  apiKey: string,
  item: MediaItem,
  cacheFile: string = UPLOAD_CACHE_FILE
): Promise<{ type: string; url: string; thumbnail?: { url: string } }> {
  // URL already provided -> skip upload
  if (item.url && !item.path) {
    return {
      type: item.type,
      url: item.url,
      ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
    };
  }

  const filePath = item.path!;
  const hash = computeFileHash(filePath);
  const cache = loadUploadCache(cacheFile);

  // Cache hit -> reuse publicUrl
  if (cache.has(hash)) {
    const cachedUrl = cache.get(hash)!;
    console.log(`  Cache hit: ${basename(filePath)} -> ${cachedUrl}`);
    return {
      type: item.type,
      url: cachedUrl,
      ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
    };
  }

  // Cache miss -> upload
  const result = await uploadMediaItem(apiKey, item);

  // Save to cache
  cache.set(hash, result.url);
  saveUploadCache(cacheFile, cache);

  return result;
}

// ── Input Detection ──

export function isMediaPost(
  input: UnifiedPostInput
): input is MediaPostInput {
  return (
    "mediaItems" in input &&
    Array.isArray((input as MediaPostInput).mediaItems) &&
    (input as MediaPostInput).mediaItems.length > 0 // [N1] empty array = text post
  );
}

export function isTextPost(
  input: UnifiedPostInput
): input is TextPostInput {
  return !isMediaPost(input);
}

// ── Platform extraction helper ──

export function extractPlatforms(
  platforms: string[] | Array<{ platform: string }> | string
): string[] {
  if (typeof platforms === "string") {
    return parsePlatformsList(platforms);
  }
  if (!Array.isArray(platforms)) return [];
  if (platforms.length === 0) return [];
  if (typeof platforms[0] === "string") return platforms as string[];
  return (platforms as Array<{ platform: string }>).map((p) => p.platform);
}

// ── Content normalization ──

export function normalizeContent(content: string): string {
  return content
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
}

/**
 * Media-aware content normalization [C2]
 * Combines text fingerprint + media fingerprint to distinguish
 * entries with same content but different media.
 */
export function normalizeContentWithMedia(
  content: string,
  mediaItems?: MediaItem[]
): string {
  const textPart = normalizeContent(content);
  if (!mediaItems || mediaItems.length === 0) return textPart;

  // Media fingerprint: sort basenames and join
  const mediaPart = mediaItems
    .map((m) => basename(m.path || m.url || "unknown"))
    .sort()
    .join("+");
  return `${textPart}|media:${mediaPart}`;
}
