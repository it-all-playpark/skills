import { Stagehand } from "@browserbasehq/stagehand";
import type { Page } from "@playwright/test";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AnyZodObject } from "zod";

export interface BrowserOptions {
  headed?: boolean;
  verbose?: boolean;
}

let stagehandInstance: Stagehand | null = null;

export async function initBrowser(options: BrowserOptions = {}): Promise<Page> {
  if (stagehandInstance) {
    return stagehandInstance.page;
  }

  stagehandInstance = new Stagehand({
    env: "LOCAL",
    headless: !options.headed,
    verbose: options.verbose ? 1 : 0,
    enableCaching: true,
  });

  await stagehandInstance.init();
  return stagehandInstance.page;
}

export async function closeBrowser(): Promise<void> {
  if (stagehandInstance) {
    await stagehandInstance.close();
    stagehandInstance = null;
  }
}

export function getStagehand(): Stagehand {
  if (!stagehandInstance) {
    throw new Error("Browser not initialized. Call initBrowser() first.");
  }
  return stagehandInstance;
}

export async function downloadFile(
  page: Page,
  outputPath: string,
  clickSelector?: string
): Promise<string> {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const downloadPromise = page.waitForEvent("download");

  if (clickSelector) {
    await page.click(clickSelector);
  }

  const download = await downloadPromise;
  await download.saveAs(outputPath);

  return outputPath;
}

export async function waitForSelector(
  page: Page,
  selector: string,
  timeout = 10000
): Promise<void> {
  await page.waitForSelector(selector, { timeout });
}

export async function fillInput(
  page: Page,
  selector: string,
  value: string
): Promise<void> {
  await page.fill(selector, value);
}

export async function clickElement(
  page: Page,
  selector: string
): Promise<void> {
  await page.click(selector);
}

export async function aiAction(prompt: string): Promise<void> {
  const stagehand = getStagehand();
  await stagehand.act({ action: prompt });
}

export async function aiExtract(
  instruction: string,
  schema: AnyZodObject
): Promise<unknown> {
  const stagehand = getStagehand();
  return stagehand.extract({ instruction, schema });
}

export function formatDownloadPath(
  outputDir: string,
  service: string,
  month: string,
  filename: string
): string {
  return join(outputDir, month, service, filename);
}
