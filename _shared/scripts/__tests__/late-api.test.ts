/**
 * Late API shared module unit tests
 *
 * Run: npx vitest run _shared/scripts/__tests__/late-api.test.ts
 * (from a directory with vitest installed, e.g. corporate-site)
 */

import { describe, expect, it } from "vitest";
import {
  parseSchedule,
  parsePlatformsList,
  isMediaPost,
  isTextPost,
  extractPlatforms,
  normalizeContent,
  normalizeContentWithMedia,
  resolveLatePlatformName,
  isoToJstDatetime,
  deepMerge,
  type TextPostInput,
  type MediaPostInput,
  type UnifiedPostInput,
} from "../late-api";

// ── parseSchedule ──

describe("parseSchedule", () => {
  it("parses 'YYYY-MM-DD HH:MM' as JST by default", () => {
    const dt = parseSchedule("2026-03-12 09:00");
    // JST = UTC+9, so 09:00 JST = 00:00 UTC
    expect(dt.toISOString()).toBe("2026-03-12T00:00:00.000Z");
  });

  it("parses 'YYYY-MM-DD HH:MM' with custom timezone", () => {
    const dt = parseSchedule("2026-03-12 09:00", "Asia/Tokyo");
    expect(dt.toISOString()).toBe("2026-03-12T00:00:00.000Z");
  });

  it("parses ISO 8601 format", () => {
    const dt = parseSchedule("2026-03-12T09:00:00+09:00");
    expect(dt.toISOString()).toBe("2026-03-12T00:00:00.000Z");
  });

  it("parses ISO 8601 UTC format", () => {
    const dt = parseSchedule("2026-03-12T00:00:00.000Z");
    expect(dt.toISOString()).toBe("2026-03-12T00:00:00.000Z");
  });

  it("throws on invalid format", () => {
    expect(() => parseSchedule("not-a-date")).toThrow("Invalid schedule format");
  });

  it("throws on empty string", () => {
    expect(() => parseSchedule("")).toThrow("Invalid schedule format");
  });

  it("handles midnight correctly", () => {
    const dt = parseSchedule("2026-01-01 00:00");
    // 00:00 JST = 15:00 UTC previous day
    expect(dt.toISOString()).toBe("2025-12-31T15:00:00.000Z");
  });
});

// ── parsePlatformsList ──

describe("parsePlatformsList", () => {
  it("parses comma-separated string", () => {
    const result = parsePlatformsList("x,linkedin,facebook");
    expect(result).toEqual(["twitter", "linkedin", "facebook"]);
  });

  it("parses array input", () => {
    const result = parsePlatformsList(["x", "linkedin"]);
    expect(result).toEqual(["twitter", "linkedin"]);
  });

  it("resolves aliases", () => {
    const result = parsePlatformsList("x,fb,gbp,bsky");
    expect(result).toEqual([
      "twitter",
      "facebook",
      "googlebusiness",
      "bluesky",
    ]);
  });

  it("handles 'all' keyword", () => {
    const result = parsePlatformsList("all");
    expect(result).toHaveLength(6);
    expect(result).toContain("twitter");
    expect(result).toContain("linkedin");
    expect(result).toContain("facebook");
    expect(result).toContain("googlebusiness");
    expect(result).toContain("threads");
    expect(result).toContain("bluesky");
  });

  it("deduplicates platforms", () => {
    const result = parsePlatformsList("x,twitter,x");
    expect(result).toEqual(["twitter"]);
  });

  it("handles media platforms", () => {
    const result = parsePlatformsList("instagram,youtube,tiktok");
    expect(result).toEqual(["instagram", "youtube", "tiktok"]);
  });
});

// ── resolveLatePlatformName ──

describe("resolveLatePlatformName", () => {
  it("resolves 'x' to 'twitter'", () => {
    expect(resolveLatePlatformName("x")).toBe("twitter");
  });

  it("resolves 'google' to 'googlebusiness'", () => {
    expect(resolveLatePlatformName("google")).toBe("googlebusiness");
  });

  it("resolves 'gbp' to 'googlebusiness'", () => {
    expect(resolveLatePlatformName("gbp")).toBe("googlebusiness");
  });

  it("resolves 'fb' to 'facebook'", () => {
    expect(resolveLatePlatformName("fb")).toBe("facebook");
  });

  it("preserves already-resolved names", () => {
    expect(resolveLatePlatformName("linkedin")).toBe("linkedin");
    expect(resolveLatePlatformName("instagram")).toBe("instagram");
  });

  it("handles case-insensitive input", () => {
    expect(resolveLatePlatformName("X")).toBe("twitter");
    expect(resolveLatePlatformName("LinkedIn")).toBe("linkedin");
  });

  it("returns unknown platform as-is", () => {
    expect(resolveLatePlatformName("mastodon")).toBe("mastodon");
  });
});

// ── isMediaPost / isTextPost ──

describe("isMediaPost", () => {
  it("returns true for MediaPostInput with mediaItems", () => {
    const input: MediaPostInput = {
      content: "test",
      mediaItems: [{ type: "video", path: "/path/to/video.mp4" }],
      platforms: [{ platform: "instagram" }],
    };
    expect(isMediaPost(input)).toBe(true);
  });

  it("returns false for empty mediaItems array [N1]", () => {
    const input: UnifiedPostInput = {
      content: "test",
      mediaItems: [],
      platforms: [{ platform: "instagram" }],
    } as unknown as UnifiedPostInput;
    expect(isMediaPost(input)).toBe(false);
  });

  it("returns false for TextPostInput", () => {
    const input: TextPostInput = {
      content: "test",
      platforms: ["x", "linkedin"],
    };
    expect(isMediaPost(input)).toBe(false);
  });

  it("returns false when mediaItems is absent", () => {
    const input: TextPostInput = {
      content: "test",
      platforms: "x,linkedin",
    };
    expect(isMediaPost(input)).toBe(false);
  });
});

describe("isTextPost", () => {
  it("is inverse of isMediaPost", () => {
    const textInput: TextPostInput = {
      content: "test",
      platforms: ["x"],
    };
    const mediaInput: MediaPostInput = {
      content: "test",
      mediaItems: [{ type: "image", path: "/img.jpg" }],
      platforms: [{ platform: "instagram" }],
    };
    expect(isTextPost(textInput)).toBe(true);
    expect(isTextPost(mediaInput)).toBe(false);
  });
});

// ── extractPlatforms ──

describe("extractPlatforms", () => {
  it("extracts from string array", () => {
    expect(extractPlatforms(["x", "linkedin"])).toEqual(["x", "linkedin"]);
  });

  it("extracts from object array (MediaPostInput format)", () => {
    expect(
      extractPlatforms([
        { platform: "instagram" },
        { platform: "youtube" },
      ])
    ).toEqual(["instagram", "youtube"]);
  });

  it("parses comma-separated string", () => {
    const result = extractPlatforms("x,linkedin,facebook");
    expect(result).toEqual(["twitter", "linkedin", "facebook"]);
  });

  it("handles empty array", () => {
    expect(extractPlatforms([])).toEqual([]);
  });
});

// ── normalizeContent ──

describe("normalizeContent", () => {
  it("collapses whitespace and truncates to 50 chars", () => {
    const long = "a".repeat(100);
    expect(normalizeContent(long)).toHaveLength(50);
  });

  it("replaces newlines with spaces", () => {
    expect(normalizeContent("hello\nworld")).toBe("hello world");
  });

  it("trims whitespace", () => {
    expect(normalizeContent("  hello  ")).toBe("hello");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeContent("hello   world")).toBe("hello world");
  });
});

// ── normalizeContentWithMedia [C2] ──

describe("normalizeContentWithMedia", () => {
  it("returns text-only fingerprint when no media", () => {
    const result = normalizeContentWithMedia("hello world");
    expect(result).toBe("hello world");
    expect(result).not.toContain("|media:");
  });

  it("returns text-only fingerprint for empty mediaItems", () => {
    const result = normalizeContentWithMedia("hello world", []);
    expect(result).toBe("hello world");
  });

  it("includes media fingerprint with mediaItems", () => {
    const result = normalizeContentWithMedia("hello", [
      { type: "video", path: "/path/to/video.mp4" },
    ]);
    expect(result).toContain("|media:");
    expect(result).toContain("video.mp4");
  });

  it("sorts media basenames for consistent fingerprint", () => {
    const result1 = normalizeContentWithMedia("test", [
      { type: "image", path: "/a.jpg" },
      { type: "video", path: "/b.mp4" },
    ]);
    const result2 = normalizeContentWithMedia("test", [
      { type: "video", path: "/b.mp4" },
      { type: "image", path: "/a.jpg" },
    ]);
    expect(result1).toBe(result2);
  });

  it("uses URL basename when path is absent", () => {
    const result = normalizeContentWithMedia("test", [
      { type: "image", url: "https://cdn.example.com/image.jpg" },
    ]);
    expect(result).toContain("image.jpg");
  });

  it("distinguishes same content with different media", () => {
    const result1 = normalizeContentWithMedia("same content", [
      { type: "video", path: "/video1.mp4" },
    ]);
    const result2 = normalizeContentWithMedia("same content", [
      { type: "video", path: "/video2.mp4" },
    ]);
    expect(result1).not.toBe(result2);
  });
});

// ── isoToJstDatetime ──

describe("isoToJstDatetime", () => {
  it("converts UTC to JST datetime string", () => {
    expect(isoToJstDatetime("2026-03-12T00:00:00.000Z")).toBe(
      "2026-03-12 09:00"
    );
  });

  it("handles ISO with offset", () => {
    // 09:00 JST = 00:00 UTC -> JST display = 09:00
    expect(isoToJstDatetime("2026-03-12T09:00:00+09:00")).toBe(
      "2026-03-12 09:00"
    );
  });

  it("returns empty string for invalid input", () => {
    expect(isoToJstDatetime("not-a-date")).toBe("");
  });
});

// ── deepMerge ──

describe("deepMerge", () => {
  it("merges flat objects", () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("override wins for same keys", () => {
    const result = deepMerge({ a: 1 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
  });

  it("deep merges nested objects", () => {
    const result = deepMerge(
      { config: { a: 1, b: 2 } },
      { config: { b: 3, c: 4 } }
    );
    expect(result).toEqual({ config: { a: 1, b: 3, c: 4 } });
  });

  it("override replaces arrays (no array merge)", () => {
    const result = deepMerge(
      { list: [1, 2] },
      { list: [3, 4, 5] }
    );
    expect(result).toEqual({ list: [3, 4, 5] });
  });

  it("does not mutate base", () => {
    const base = { a: 1, nested: { x: 1 } };
    deepMerge(base, { nested: { y: 2 } });
    expect(base).toEqual({ a: 1, nested: { x: 1 } });
  });
});
