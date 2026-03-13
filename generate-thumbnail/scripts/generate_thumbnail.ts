#!/usr/bin/env npx tsx
/**
 * Generate blog thumbnail using Gemini API
 *
 * Usage: npx tsx generate_thumbnail.ts <mdx-path>
 *
 * Requires: GEMINI_API_KEY in .env.local
 * Config loaded from skill-config.json "generate-thumbnail" section
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import matter from 'gray-matter';
import * as path from 'path';

// ============================================================================
// Configuration from skill-config.json
// ============================================================================

const SKILLS_DIR =
  process.env.SKILLS_DIR || path.join(process.env.HOME || '~', '.claude/skills');
const COMMON_SH = path.join(SKILLS_DIR, '_lib/common.sh');

function loadSkillConfig(): Record<string, string> {
  try {
    const result = execSync(
      `bash -c 'source "${COMMON_SH}" && load_skill_config "generate-thumbnail"'`,
      { encoding: 'utf-8' }
    ).trim();
    return result ? JSON.parse(result) : {};
  } catch {
    return {};
  }
}

const skillConfig = loadSkillConfig();

const GEMINI_MODEL =
  (skillConfig as Record<string, string>).gemini_model ||
  'gemini-3-pro-image-preview';
const ASPECT_RATIO =
  (skillConfig as Record<string, string>).aspect_ratio || '16:9';
const OUTPUT_DIR_CONFIG =
  (skillConfig as Record<string, string>).output_dir || 'public/blog';
const BRAND_PROMPT_PATH =
  (skillConfig as Record<string, string>).brand_prompt_path || '';

const GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ============================================================================
// Brand Prompt Loading
// ============================================================================

function loadBrandPrompt(): string {
  // 1. Check project-level brand prompt via config
  if (BRAND_PROMPT_PATH) {
    // Resolve relative to git root
    let promptPath = BRAND_PROMPT_PATH;
    if (!path.isAbsolute(promptPath)) {
      try {
        const gitRoot = execSync('git rev-parse --show-toplevel', {
          encoding: 'utf-8',
        }).trim();
        promptPath = path.join(gitRoot, promptPath);
      } catch {
        promptPath = path.resolve(process.cwd(), promptPath);
      }
    }
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf-8');
    }
    console.warn(`⚠️ Brand prompt not found: ${promptPath}, using default`);
  }

  // 2. Fallback to default prompt
  const defaultPrompt = path.join(
    SKILLS_DIR,
    'generate-thumbnail/prompts/default-brand-prompt.md'
  );
  if (fs.existsSync(defaultPrompt)) {
    return fs.readFileSync(defaultPrompt, 'utf-8');
  }

  // 3. Minimal fallback
  return 'Generate a clean, minimal blog thumbnail image based on the provided information.';
}

const SYSTEM_INSTRUCTION = loadBrandPrompt();

// ============================================================================
// Types
// ============================================================================

interface BlogFrontmatter {
  title: string;
  description?: string;
  tags?: string[];
  category?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
      }>;
    };
  }>;
  error?: {
    message: string;
    code: number;
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

function loadEnvFile(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env.local');
  const env: Record<string, string> = {};

  if (!fs.existsSync(envPath)) {
    return env;
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    env[key] = value;
  }

  return env;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMdxFrontmatter(mdxPath: string): BlogFrontmatter {
  const content = fs.readFileSync(mdxPath, 'utf-8');
  const { data } = matter(content);

  return {
    title: data.title || 'Untitled',
    description: data.description,
    tags: data.tags,
    category: data.category,
  };
}

function buildUserPrompt(frontmatter: BlogFrontmatter): string {
  const parts: string[] = ['## ブログ情報\n'];

  parts.push(`- **タイトル**: ${frontmatter.title}`);

  if (frontmatter.description) {
    parts.push(`- **概要**: ${frontmatter.description}`);
  }

  if (frontmatter.category) {
    parts.push(`- **カテゴリ**: ${frontmatter.category}`);
  }

  if (frontmatter.tags && frontmatter.tags.length > 0) {
    parts.push(`- **タグ**: ${frontmatter.tags.join(', ')}`);
  }

  parts.push(
    '\n上記の情報をもとに、ブランドガイドラインに従ったサムネイル画像を生成してください。'
  );

  return parts.join('\n');
}

// ============================================================================
// Gemini API
// ============================================================================

async function callGeminiApi(
  apiKey: string,
  userPrompt: string
): Promise<string> {
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const requestBody = {
    system_instruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        parts: [
          {
            text:
              userPrompt +
              `\n\nアスペクト比は${ASPECT_RATIO}（横長）で生成してください。`,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      imageConfig: {
        aspectRatio: ASPECT_RATIO,
        imageSize: '2K',
      },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as GeminiResponse;

  if (data.error) {
    throw new Error(`API error: ${data.error.message}`);
  }

  const candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error('No candidates in API response');
  }

  const parts = candidates[0].content?.parts;
  if (!parts) {
    throw new Error('No parts in API response');
  }

  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart || !imagePart.inlineData) {
    throw new Error('No image data in API response');
  }

  return imagePart.inlineData.data;
}

async function generateWithRetry(
  apiKey: string,
  userPrompt: string
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`🔄 Attempt ${attempt}/${MAX_RETRIES}...`);
      const imageData = await callGeminiApi(apiKey, userPrompt);
      return imageData;
    } catch (error) {
      lastError = error as Error;
      console.error(`❌ Attempt ${attempt} failed: ${lastError.message}`);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npx tsx generate_thumbnail.ts <mdx-path>');
    process.exit(1);
  }

  const mdxPath = args[0];

  if (!fs.existsSync(mdxPath)) {
    console.error(`❌ File not found: ${mdxPath}`);
    process.exit(1);
  }

  if (!mdxPath.endsWith('.mdx')) {
    console.error(`❌ File must be .mdx format: ${mdxPath}`);
    process.exit(1);
  }

  // Load API key
  const env = loadEnvFile();
  const apiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;

  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    console.error(`❌ GEMINI_API_KEY not set in .env.local`);
    console.error(
      `   Get your API key from: https://aistudio.google.com/apikey`
    );
    process.exit(1);
  }

  // Parse MDX
  console.log(`📄 Reading: ${mdxPath}`);
  const frontmatter = parseMdxFrontmatter(mdxPath);
  console.log(`   Title: ${frontmatter.title}`);

  // Build prompt
  const userPrompt = buildUserPrompt(frontmatter);

  // Generate image
  console.log(`🎨 Generating thumbnail with Gemini API...`);
  const imageBase64 = await generateWithRetry(apiKey, userPrompt);

  // Determine output path
  const basename = path.basename(mdxPath, '.mdx');

  // Resolve output dir relative to git root
  let outputDir: string;
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
    }).trim();
    outputDir = path.join(gitRoot, OUTPUT_DIR_CONFIG);
  } catch {
    outputDir = path.resolve(process.cwd(), OUTPUT_DIR_CONFIG);
  }

  const outputPath = path.join(outputDir, `${basename}.png`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Save image
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  fs.writeFileSync(outputPath, imageBuffer);

  console.log(`✅ Thumbnail saved: ${outputPath}`);
}

main().catch((error) => {
  console.error(`❌ Error: ${error.message}`);
  process.exit(1);
});
