#!/usr/bin/env npx tsx
import { program } from "commander";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getEnabledServices } from "./lib/config.js";
import { getCredentials, isOpAvailable, checkOpSignedIn } from "./lib/auth.js";
import { initBrowser, closeBrowser } from "./lib/browser.js";
import {
  createHandler,
  supportedServices,
  isSupported,
  type FetchResult,
} from "./handlers/index.js";

interface ProgramOptions {
  month: string;
  service?: string;
  config?: string;
  headed: boolean;
  dryRun: boolean;
  verbose: boolean;
  listServices: boolean;
}

function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

async function main() {
  program
    .name("receipt-fetch")
    .description("Automated receipt/invoice fetching from web services")
    .option("-m, --month <YYYY-MM>", "Target month", getCurrentMonth())
    .option(
      "-s, --service <names>",
      "Comma-separated service names (default: all enabled)"
    )
    .option("-c, --config <path>", "Config file path")
    .option("--headed", "Run browser in headed mode for debugging", false)
    .option("--dry-run", "Show what would be downloaded without downloading", false)
    .option("-v, --verbose", "Verbose output", false)
    .option("--list-services", "List available services and exit", false)
    .parse();

  const options = program.opts<ProgramOptions>();

  if (options.listServices) {
    console.log("Supported services:");
    supportedServices.forEach((s) => console.log(`  - ${s}`));
    process.exit(0);
  }

  if (!isOpAvailable()) {
    console.error("Error: 1Password CLI (op) is not installed");
    console.error("Install: https://developer.1password.com/docs/cli/");
    process.exit(1);
  }

  if (!checkOpSignedIn()) {
    console.error("Error: Not signed in to 1Password CLI");
    console.error("Run: eval $(op signin)");
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(options.config);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Config error: ${msg}`);
    process.exit(1);
  }

  let targetServices: string[];
  if (options.service) {
    targetServices = options.service.split(",").map((s) => s.trim());
    for (const s of targetServices) {
      if (!isSupported(s)) {
        console.error(`Unknown service: ${s}`);
        console.error(`Supported: ${supportedServices.join(", ")}`);
        process.exit(1);
      }
      if (!config.services[s]) {
        console.error(`Service not configured: ${s}`);
        process.exit(1);
      }
    }
  } else {
    targetServices = getEnabledServices(config);
  }

  if (targetServices.length === 0) {
    console.error("No services to fetch from");
    process.exit(1);
  }

  console.log(`Receipt Fetch - ${options.month}`);
  console.log(`Services: ${targetServices.join(", ")}`);
  console.log(`Output: ${config.output_dir}`);
  if (options.dryRun) console.log("Mode: DRY RUN");
  console.log("");

  const results: FetchResult[] = [];
  let page;

  try {
    page = await initBrowser({
      headed: options.headed,
      verbose: options.verbose,
    });

    for (const serviceName of targetServices) {
      console.log(`\n=== ${serviceName} ===`);

      const serviceConfig = config.services[serviceName];
      if (!serviceConfig) {
        console.error(`Service config not found: ${serviceName}`);
        continue;
      }

      let credentials;
      try {
        credentials = getCredentials(serviceConfig.op_item, serviceConfig.totp);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Failed to get credentials: ${msg}`);
        results.push({
          service: serviceName,
          success: false,
          files: [],
          errors: [`Credential error: ${msg}`],
        });
        continue;
      }

      const handler = createHandler(serviceName, {
        page,
        config: serviceConfig,
        credentials,
        outputDir: config.output_dir,
        month: options.month,
        dryRun: options.dryRun,
        verbose: options.verbose,
        headed: options.headed,
      });

      const result = await handler.execute();
      results.push(result);

      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    await closeBrowser();
  }

  console.log("\n=== Summary ===");
  let totalFiles = 0;
  let totalErrors = 0;

  for (const r of results) {
    const status = r.success ? "✓" : "✗";
    console.log(`${status} ${r.service}: ${r.files.length} files`);
    if (r.errors.length > 0) {
      r.errors.forEach((e) => console.log(`  Error: ${e}`));
    }
    totalFiles += r.files.length;
    totalErrors += r.errors.length;
  }

  console.log(`\nTotal: ${totalFiles} files, ${totalErrors} errors`);

  const reportDir = join(config.output_dir, options.month);
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }
  const reportPath = join(reportDir, "report.json");
  const report = {
    month: options.month,
    timestamp: new Date().toISOString(),
    results,
    summary: {
      total_files: totalFiles,
      total_errors: totalErrors,
      services: results.length,
    },
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportPath}`);

  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
