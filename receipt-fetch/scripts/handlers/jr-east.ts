import { BaseHandler, type HandlerContext } from "./base.js";
import {
  downloadFile,
  formatDownloadPath,
  aiAction,
  aiExtract,
} from "../lib/browser.js";
import { z } from "zod";

const LOGIN_URL = "https://id.jreast.co.jp/idcs/contents/login?AUTHENTICATED=http%3A%2F%2Ffo-alb.pri.nsc-idcs.net%2Fsso%2FInternalAuthoriEndpoint%3FtranVerifyCode%3DzLf1L96Q6N87stCn%26acr_values%3D2%26redirect_uri%3Dhttps%253A%252F%252Fwww.eki-net.com%252FPersonal%252Fmember%252Fwb%252FJreid%252FJreidInfomationLink%253FSeq%253D501%26state%3DtMU%26client_name%3D%25E3%2581%2588%25E3%2581%258D%25E3%2581%25AD%25E3%2581%25A3%25E3%2581%25A8%26client_id%3DRelyingParty1002&SITE_ID=co&AUTH_TYPE=AUTH_THREEKEY&MESSAGE_AUTH=OFhPEXKf5%2B%2BYfKijCDut7A%3D%3D";
const HISTORY_URL =
  "https://www.eki-net.com/Personal/reserve/wb/ApplicationHistoryList/Index";

export class JREastHandler extends BaseHandler {
  constructor(ctx: HandlerContext) {
    super("jr-east", ctx);
  }

  getLoginPageIndicator(): string {
    return "login";
  }

  async tryAutoLogin(): Promise<boolean> {
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
      await page.fill('input[name="userId"], #txtUserID, #userId', credentials.username);
      await page.fill('input[name="password"], #txtPassword, #password', credentials.password);
      await aiAction(
        `ログインフォームが入力済みです。ログインボタンをクリックしてログインを完了してください。`
      );
    }

    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    return !currentUrl.toLowerCase().includes("login");
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
