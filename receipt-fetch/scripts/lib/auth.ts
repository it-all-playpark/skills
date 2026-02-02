import { execFileSync, execSync } from "node:child_process";

export interface Credentials {
  username: string;
  password: string;
  totp?: string;
}

function runOp(args: string[]): string {
  try {
    const result = execFileSync("op", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`1Password CLI error: ${msg}`);
  }
}

export function getCredentials(
  itemName: string,
  needsTotp = false
): Credentials {
  const username = runOp([
    "item",
    "get",
    itemName,
    "--fields",
    "username",
  ]);

  const password = runOp([
    "item",
    "get",
    itemName,
    "--fields",
    "password",
  ]);

  let totp: string | undefined;
  if (needsTotp) {
    try {
      totp = runOp(["item", "get", itemName, "--otp"]);
    } catch {
      console.warn(`TOTP not available for ${itemName}`);
    }
  }

  return { username, password, totp };
}

export function isOpAvailable(): boolean {
  try {
    execSync("op --version", { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function checkOpSignedIn(): boolean {
  try {
    execSync("op account list", { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}
