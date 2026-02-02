import { BaseHandler, type HandlerContext } from "./base.js";
import {
  downloadFile,
  formatDownloadPath,
  aiAction,
  aiExtract,
} from "../lib/browser.js";
import { z } from "zod";

const LOGIN_URL = "https://id.moneyforward.com/sign_in";
const EXPENSE_URL = "https://erp.moneyforward.com/office_usage_detail_statements";

export class MoneyForwardHandler extends BaseHandler {
  constructor(ctx: HandlerContext) {
    super("moneyforward", ctx);
  }

  getLoginPageIndicator(): string {
    return "sign_in";
  }

  async tryAutoLogin(): Promise<boolean> {
    const { page, credentials, config } = this.ctx;

    await page.goto(LOGIN_URL);
    await page.waitForLoadState("networkidle");

    try {
      await page.fill('input[type="email"], #email', credentials.username);
      await page.click('button[type="submit"], input[type="submit"]');
      await page.waitForLoadState("networkidle");

      await page.fill('input[type="password"], #password', credentials.password);
      await page.click('button[type="submit"], input[type="submit"]');
      await page.waitForLoadState("networkidle");

      if (config.totp && credentials.totp) {
        this.log("Entering TOTP code...");
        await page.fill('input[name="otp"], input[type="tel"]', credentials.totp);
        await page.click('button[type="submit"], input[type="submit"]');
        await page.waitForLoadState("networkidle");
      }
    } catch {
      this.log("Fixed selector login failed, trying AI fallback for login");
      await page.fill('input[type="email"], input[name="email"], #email', credentials.username);
      await page.fill('input[type="password"], input[name="password"], #password', credentials.password);
      await aiAction(
        `ログインフォームが入力済みです。ログインボタンをクリックしてログインを完了してください。`
      );
    }

    const currentUrl = page.url();
    return !currentUrl.includes("sign_in");
  }

  async fetchReceipts(): Promise<string[]> {
    const { page, outputDir, month, dryRun } = this.ctx;
    const downloadedFiles: string[] = [];

    await page.goto(EXPENSE_URL);
    await page.waitForLoadState("networkidle");

    try {
      await this.navigateToReceiptList(month);
    } catch {
      this.log("Navigation failed, using AI to find receipts");
      await aiAction(
        `${month}の経費精算または請求書一覧ページに移動してください`
      );
    }

    const receipts = await this.extractReceiptList();

    for (const receipt of receipts) {
      if (dryRun) {
        this.log(`[DRY-RUN] Would download: ${receipt.name}`);
        continue;
      }

      try {
        const filename = `${receipt.id}_${receipt.name}.pdf`;
        const outputPath = formatDownloadPath(
          outputDir,
          this.serviceName,
          month,
          filename
        );

        if (receipt.downloadSelector) {
          await downloadFile(page, outputPath, receipt.downloadSelector);
        } else {
          await aiAction(
            `「${receipt.name}」の領収書PDFをダウンロードしてください`
          );
          await page.waitForTimeout(2000);
        }

        downloadedFiles.push(outputPath);
        this.log(`Downloaded: ${filename}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`Failed to download ${receipt.name}: ${msg}`, "error");
      }
    }

    return downloadedFiles;
  }

  private async navigateToReceiptList(month: string): Promise<void> {
    const { page } = this.ctx;

    const menuSelector = 'a[href*="expense"], [data-testid="expense-menu"]';
    await page.click(menuSelector);
    await page.waitForLoadState("networkidle");

    const [year, monthNum] = month.split("-");
    const dateFilterSelector = `select[name="year"], input[name="year"]`;
    if (await page.isVisible(dateFilterSelector)) {
      await page.selectOption('select[name="year"]', year);
      await page.selectOption('select[name="month"]', monthNum);
    }
  }

  private async extractReceiptList(): Promise<
    Array<{ id: string; name: string; downloadSelector?: string }>
  > {
    const ReceiptSchema = z.object({
      receipts: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          downloadSelector: z.string().optional(),
        })
      ),
    });

    try {
      const result = await aiExtract(
        "このページにある領収書・請求書の一覧を抽出してください。各アイテムのID、名前、ダウンロードボタンのセレクタを含めてください。",
        ReceiptSchema
      );
      const parsed = ReceiptSchema.parse(result);
      return parsed.receipts;
    } catch {
      this.log("AI extraction failed, returning empty list");
      return [];
    }
  }
}
