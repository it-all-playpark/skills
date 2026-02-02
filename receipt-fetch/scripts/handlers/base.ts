import type { Page } from "@playwright/test";
import type { ServiceConfig } from "../lib/config.js";
import type { Credentials } from "../lib/auth.js";
import {
  aiAction,
  fillInput,
  clickElement,
  waitForSelector,
} from "../lib/browser.js";

export interface FetchResult {
  service: string;
  success: boolean;
  files: string[];
  errors: string[];
}

export interface HandlerContext {
  page: Page;
  config: ServiceConfig;
  credentials: Credentials;
  outputDir: string;
  month: string;
  dryRun: boolean;
  verbose: boolean;
}

export abstract class BaseHandler {
  protected serviceName: string;
  protected ctx: HandlerContext;

  constructor(serviceName: string, ctx: HandlerContext) {
    this.serviceName = serviceName;
    this.ctx = ctx;
  }

  abstract login(): Promise<void>;
  abstract fetchReceipts(): Promise<string[]>;

  async execute(): Promise<FetchResult> {
    const result: FetchResult = {
      service: this.serviceName,
      success: false,
      files: [],
      errors: [],
    };

    try {
      this.log("Starting login...");
      await this.login();
      this.log("Login successful");

      this.log("Fetching receipts...");
      const files = await this.fetchReceipts();
      result.files = files;
      result.success = true;
      this.log(`Downloaded ${files.length} receipts`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(msg);
      this.log(`Error: ${msg}`, "error");

      if (this.ctx.config.fallback?.ai_prompt) {
        this.log("Attempting AI fallback...");
        try {
          await this.aiFallback();
          result.success = true;
        } catch (fallbackError) {
          const fallbackMsg =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          result.errors.push(`AI fallback failed: ${fallbackMsg}`);
        }
      }
    }

    return result;
  }

  protected async aiFallback(): Promise<void> {
    const prompt = this.ctx.config.fallback?.ai_prompt;
    if (!prompt) {
      throw new Error("No AI fallback prompt configured");
    }
    await aiAction(prompt);
  }

  protected async executeStep(step: {
    action: string;
    url?: string;
    selector?: string;
    value?: string;
    timeout?: number;
  }): Promise<void> {
    const { page } = this.ctx;
    const timeout = step.timeout ?? 10000;

    switch (step.action) {
      case "goto":
        if (!step.url) throw new Error("goto requires url");
        await page.goto(step.url);
        break;
      case "fill":
        if (!step.selector || !step.value)
          throw new Error("fill requires selector and value");
        await fillInput(page, step.selector, this.interpolate(step.value));
        break;
      case "click":
        if (!step.selector) throw new Error("click requires selector");
        await clickElement(page, step.selector);
        break;
      case "wait":
        if (step.selector) {
          await waitForSelector(page, step.selector, timeout);
        } else {
          await page.waitForTimeout(timeout);
        }
        break;
      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  protected interpolate(value: string): string {
    const { credentials } = this.ctx;
    return value
      .replace(/\{\{username\}\}/g, credentials.username)
      .replace(/\{\{password\}\}/g, credentials.password)
      .replace(/\{\{totp\}\}/g, credentials.totp ?? "");
  }

  protected log(message: string, level: "info" | "error" = "info"): void {
    if (this.ctx.verbose || level === "error") {
      const prefix = `[${this.serviceName}]`;
      if (level === "error") {
        console.error(`${prefix} ${message}`);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  }
}
