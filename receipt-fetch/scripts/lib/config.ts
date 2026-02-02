import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const StepSchema = z.object({
  action: z.enum(["goto", "fill", "click", "wait", "download"]),
  url: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
  timeout: z.number().optional(),
});

export const ServiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  op_item: z.string().describe("1Password item name for credentials"),
  totp: z.boolean().default(false),
  steps: z.array(StepSchema).optional(),
  fallback: z
    .object({
      ai_prompt: z.string(),
    })
    .optional(),
});

export const ConfigSchema = z.object({
  output_dir: z.string().default("~/Documents/receipts"),
  services: z.record(z.string(), ServiceConfigSchema),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type Step = z.infer<typeof StepSchema>;

export function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

export function loadConfig(configPath?: string): Config {
  const defaultPath = expandPath("~/.config/receipt-fetch/config.yaml");
  const path = configPath ? expandPath(configPath) : defaultPath;

  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const content = readFileSync(path, "utf-8");
  const raw = parseYaml(content);
  const config = ConfigSchema.parse(raw);

  config.output_dir = expandPath(config.output_dir);

  return config;
}

export function getEnabledServices(config: Config): string[] {
  return Object.entries(config.services)
    .filter(([, svc]) => svc.enabled)
    .map(([name]) => name);
}
