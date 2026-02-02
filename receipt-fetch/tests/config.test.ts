import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  expandPath,
  loadConfig,
  getEnabledServices,
  ConfigSchema,
  ServiceConfigSchema,
  type Config,
} from "../scripts/lib/config.js";

describe("expandPath", () => {
  it("should expand ~ to home directory", () => {
    const result = expandPath("~/Documents");
    expect(result).toBe(join(homedir(), "Documents"));
  });

  it("should expand ~/nested/path correctly", () => {
    const result = expandPath("~/foo/bar/baz");
    expect(result).toBe(join(homedir(), "foo/bar/baz"));
  });

  it("should resolve relative paths without ~", () => {
    const result = expandPath("./relative/path");
    expect(result).toContain("relative/path");
    expect(result.startsWith("/")).toBe(true);
  });

  it("should return absolute paths unchanged", () => {
    const result = expandPath("/absolute/path");
    expect(result).toBe("/absolute/path");
  });
});

describe("ConfigSchema validation", () => {
  it("should accept valid minimal config", () => {
    const config = {
      services: {
        test: {
          op_item: "Test Item",
        },
      },
    };
    const result = ConfigSchema.parse(config);
    expect(result.output_dir).toBe("~/Documents/receipts");
    expect(result.services.test.enabled).toBe(true);
    expect(result.services.test.totp).toBe(false);
  });

  it("should accept full config with all options", () => {
    const config = {
      output_dir: "~/custom/path",
      services: {
        moneyforward: {
          enabled: true,
          op_item: "MoneyForward Login",
          totp: true,
          steps: [
            { action: "goto", url: "https://example.com" },
            { action: "fill", selector: "#email", value: "{{username}}" },
          ],
          fallback: {
            ai_prompt: "Login to the service",
          },
        },
      },
    };
    const result = ConfigSchema.parse(config);
    expect(result.output_dir).toBe("~/custom/path");
    expect(result.services.moneyforward.totp).toBe(true);
    expect(result.services.moneyforward.steps).toHaveLength(2);
  });

  it("should reject config without services", () => {
    expect(() => ConfigSchema.parse({})).toThrow();
  });

  it("should reject service without op_item", () => {
    const config = {
      services: {
        test: {
          enabled: true,
        },
      },
    };
    expect(() => ConfigSchema.parse(config)).toThrow();
  });

  it("should reject invalid step action", () => {
    const config = {
      services: {
        test: {
          op_item: "Test",
          steps: [{ action: "invalid_action" }],
        },
      },
    };
    expect(() => ConfigSchema.parse(config)).toThrow();
  });
});

describe("ServiceConfigSchema validation", () => {
  it("should accept minimal service config", () => {
    const result = ServiceConfigSchema.parse({
      op_item: "Test Item",
    });
    expect(result.enabled).toBe(true);
    expect(result.totp).toBe(false);
    expect(result.steps).toBeUndefined();
  });

  it("should validate step actions", () => {
    const validActions = ["goto", "fill", "click", "wait", "download"];
    for (const action of validActions) {
      const result = ServiceConfigSchema.parse({
        op_item: "Test",
        steps: [{ action }],
      });
      expect(result.steps?.[0].action).toBe(action);
    }
  });
});

describe("loadConfig", () => {
  const testDir = join(tmpdir(), "receipt-fetch-test-" + Date.now());
  const configPath = join(testDir, "config.yaml");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it("should load valid YAML config", () => {
    const yaml = `
output_dir: ~/test/receipts
services:
  amazon:
    op_item: "Amazon Login"
    totp: false
`;
    writeFileSync(configPath, yaml);
    const config = loadConfig(configPath);

    expect(config.output_dir).toBe(join(homedir(), "test/receipts"));
    expect(config.services.amazon.op_item).toBe("Amazon Login");
  });

  it("should throw error for non-existent file", () => {
    expect(() => loadConfig("/nonexistent/path/config.yaml")).toThrow(
      "Config file not found"
    );
  });

  it("should throw error for invalid YAML structure", () => {
    writeFileSync(configPath, "invalid: yaml: structure:");
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("should throw error for missing required fields", () => {
    const yaml = `
output_dir: ~/test
services:
  test:
    enabled: true
`;
    writeFileSync(configPath, yaml);
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("should expand output_dir path", () => {
    const yaml = `
output_dir: ~/expanded/path
services:
  test:
    op_item: "Test"
`;
    writeFileSync(configPath, yaml);
    const config = loadConfig(configPath);
    expect(config.output_dir).toBe(join(homedir(), "expanded/path"));
  });
});

describe("getEnabledServices", () => {
  it("should return only enabled services", () => {
    const config: Config = {
      output_dir: "/test",
      services: {
        enabled1: { enabled: true, op_item: "Item1", totp: false },
        disabled: { enabled: false, op_item: "Item2", totp: false },
        enabled2: { enabled: true, op_item: "Item3", totp: false },
      },
    };
    const result = getEnabledServices(config);
    expect(result).toContain("enabled1");
    expect(result).toContain("enabled2");
    expect(result).not.toContain("disabled");
    expect(result).toHaveLength(2);
  });

  it("should return empty array when no services enabled", () => {
    const config: Config = {
      output_dir: "/test",
      services: {
        disabled1: { enabled: false, op_item: "Item1", totp: false },
        disabled2: { enabled: false, op_item: "Item2", totp: false },
      },
    };
    const result = getEnabledServices(config);
    expect(result).toHaveLength(0);
  });

  it("should return all services when all enabled", () => {
    const config: Config = {
      output_dir: "/test",
      services: {
        svc1: { enabled: true, op_item: "Item1", totp: false },
        svc2: { enabled: true, op_item: "Item2", totp: false },
        svc3: { enabled: true, op_item: "Item3", totp: false },
      },
    };
    const result = getEnabledServices(config);
    expect(result).toHaveLength(3);
  });

  it("should handle empty services object", () => {
    const config: Config = {
      output_dir: "/test",
      services: {},
    };
    const result = getEnabledServices(config);
    expect(result).toHaveLength(0);
  });
});
