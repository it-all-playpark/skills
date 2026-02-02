import { BaseHandler, type HandlerContext } from "./base.js";
import {
  downloadFile,
  formatDownloadPath,
  aiAction,
  aiExtract,
} from "../lib/browser.js";
import { z } from "zod";

const LOGIN_URL = "https://www.eki-net.com/Personal/member/Login.aspx";
const HISTORY_URL =
  "https://www.eki-net.com/Personal/member/wb/PurchaseHistory/Index";

export class JREastHandler extends BaseHandler {
  constructor(ctx: HandlerContext) {
    super("jr-east", ctx);
  }

  async login(): Promise<void> {
    const { page, credentials } = this.ctx;

    await page.goto(LOGIN_URL);
    await page.waitForLoadState("networkidle");

    try {
      await page.fill("#txtUserID, #userId", credentials.username);
      await page.fill("#txtPassword, #password", credentials.password);
      await page.click(
        'input[type="submit"], button[type="submit"], .login-button'
      );
      await page.waitForLoadState("networkidle");
    } catch {
      this.log("Fixed selector login failed, trying AI");
      await aiAction(
        `えきねっとにログインしてください。ユーザーIDは${credentials.username}、パスワードは${credentials.password}です。`
      );
    }

    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    if (currentUrl.includes("Login")) {
      throw new Error("Login appears to have failed");
    }
  }

  async fetchReceipts(): Promise<string[]> {
    const { page, outputDir, month, dryRun } = this.ctx;
    const downloadedFiles: string[] = [];

    await page.goto(HISTORY_URL);
    await page.waitForLoadState("networkidle");

    try {
      const [year, monthNum] = month.split("-");
      const startDate = `${year}/${monthNum}/01`;
      const endDate = `${year}/${monthNum}/31`;

      if (await page.isVisible('input[name="startDate"]')) {
        await page.fill('input[name="startDate"]', startDate);
        await page.fill('input[name="endDate"]', endDate);
        await page.click('button[type="submit"], .search-button');
        await page.waitForLoadState("networkidle");
      }
    } catch {
      this.log("Date filter failed, using AI");
      await aiAction(`${month}の購入履歴を表示してください`);
    }

    const tickets = await this.extractTicketList();

    for (const ticket of tickets) {
      if (dryRun) {
        this.log(`[DRY-RUN] Would download: ${ticket.name}`);
        continue;
      }

      try {
        const filename = `receipt_${ticket.date}_${ticket.id}.pdf`;
        const outputPath = formatDownloadPath(
          outputDir,
          this.serviceName,
          month,
          filename
        );

        if (ticket.receiptSelector) {
          await downloadFile(page, outputPath, ticket.receiptSelector);
        } else {
          await aiAction(`「${ticket.name}」の領収書をダウンロードしてください`);
          await page.waitForTimeout(2000);
        }

        downloadedFiles.push(outputPath);
        this.log(`Downloaded: ${filename}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`Failed to download ${ticket.name}: ${msg}`, "error");
      }
    }

    return downloadedFiles;
  }

  private async extractTicketList(): Promise<
    Array<{
      id: string;
      name: string;
      date: string;
      receiptSelector?: string;
    }>
  > {
    const TicketSchema = z.object({
      tickets: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          date: z.string(),
          receiptSelector: z.string().optional(),
        })
      ),
    });

    try {
      const result = await aiExtract(
        "このページにある購入履歴・予約一覧を抽出してください。各アイテムのID、名前（区間など）、日付、領収書ダウンロードボタンのセレクタを含めてください。",
        TicketSchema
      );
      const parsed = TicketSchema.parse(result);
      return parsed.tickets;
    } catch {
      this.log("AI extraction failed");
      return [];
    }
  }
}
