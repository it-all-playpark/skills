import { BaseHandler, type HandlerContext } from "./base.js";
import {
  downloadFile,
  formatDownloadPath,
  aiAction,
  aiExtract,
} from "../lib/browser.js";
import { z } from "zod";

const LOGIN_URL = "https://www.amazon.co.jp/ap/signin";
const ORDERS_URL = "https://www.amazon.co.jp/gp/css/order-history";

export class AmazonHandler extends BaseHandler {
  constructor(ctx: HandlerContext) {
    super("amazon", ctx);
  }

  async login(): Promise<void> {
    const { page, credentials, config } = this.ctx;

    await page.goto(LOGIN_URL);
    await page.waitForLoadState("networkidle");

    try {
      await page.fill('#ap_email, input[name="email"]', credentials.username);
      await page.click("#continue, .a-button-input");
      await page.waitForLoadState("networkidle");

      await page.fill(
        '#ap_password, input[name="password"]',
        credentials.password
      );
      await page.click("#signInSubmit, .a-button-input");
      await page.waitForLoadState("networkidle");

      if (config.totp && credentials.totp) {
        this.log("Entering OTP code...");
        const otpInput = await page.$('#auth-mfa-otpcode, input[name="otpCode"]');
        if (otpInput) {
          await page.fill(
            '#auth-mfa-otpcode, input[name="otpCode"]',
            credentials.totp
          );
          await page.click("#auth-signin-button, .a-button-input");
          await page.waitForLoadState("networkidle");
        }
      }
    } catch {
      this.log("Fixed selector login failed, trying AI");
      // Note: AI fallback fills the form fields; credentials are passed separately via page.fill
      await page.fill('input[type="email"], input[name="email"], #ap_email', credentials.username);
      await page.fill('input[type="password"], input[name="password"], #ap_password', credentials.password);
      await aiAction(
        `ログインフォームが入力済みです。ログインボタンをクリックしてログインを完了してください。`
      );
    }

    const currentUrl = page.url();
    if (currentUrl.includes("signin") || currentUrl.includes("ap/")) {
      throw new Error("Login appears to have failed");
    }
  }

  async fetchReceipts(): Promise<string[]> {
    const { page, outputDir, month, dryRun } = this.ctx;
    const downloadedFiles: string[] = [];

    const [year] = month.split("-");
    await page.goto(`${ORDERS_URL}?orderFilter=year-${year}`);
    await page.waitForLoadState("networkidle");

    const orders = await this.extractOrderList(month);

    for (const order of orders) {
      if (dryRun) {
        this.log(`[DRY-RUN] Would download: ${order.id}`);
        continue;
      }

      try {
        const filename = `order_${order.id}.pdf`;
        const outputPath = formatDownloadPath(
          outputDir,
          this.serviceName,
          month,
          filename
        );

        if (order.invoiceUrl) {
          await page.goto(order.invoiceUrl);
          await page.waitForLoadState("networkidle");

          const printButton = await page.$(
            'a[href*="invoice"], .print-invoice, [data-action="print"]'
          );
          if (printButton) {
            await downloadFile(page, outputPath);
          }
        } else {
          await aiAction(
            `注文番号${order.id}の領収書/請求書をダウンロードしてください`
          );
          await page.waitForTimeout(2000);
        }

        downloadedFiles.push(outputPath);
        this.log(`Downloaded: ${filename}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`Failed to download ${order.id}: ${msg}`, "error");
      }
    }

    return downloadedFiles;
  }

  private async extractOrderList(
    month: string
  ): Promise<Array<{ id: string; date: string; invoiceUrl?: string }>> {
    const OrderSchema = z.object({
      orders: z.array(
        z.object({
          id: z.string(),
          date: z.string(),
          invoiceUrl: z.string().optional(),
        })
      ),
    });

    const [, monthNum] = month.split("-");
    const targetMonth = parseInt(monthNum, 10);

    try {
      const result = await aiExtract(
        `このページにある注文履歴から、${targetMonth}月の注文を抽出してください。注文番号、日付、請求書/領収書ページへのURLを含めてください。`,
        OrderSchema
      );
      const parsed = OrderSchema.parse(result);
      return parsed.orders;
    } catch {
      this.log("AI extraction failed");
      return [];
    }
  }
}
