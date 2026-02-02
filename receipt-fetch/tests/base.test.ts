import { describe, it, expect } from "vitest";
import { interpolateCredentials } from "../scripts/handlers/base.js";

describe("interpolateCredentials", () => {
  const credentials = {
    username: "test@example.com",
    password: "secret123",
    totp: "123456",
  };

  it("should replace {{username}} placeholder", () => {
    const result = interpolateCredentials("{{username}}", credentials);
    expect(result).toBe("test@example.com");
  });

  it("should replace {{password}} placeholder", () => {
    const result = interpolateCredentials("{{password}}", credentials);
    expect(result).toBe("secret123");
  });

  it("should replace {{totp}} placeholder", () => {
    const result = interpolateCredentials("{{totp}}", credentials);
    expect(result).toBe("123456");
  });

  it("should replace multiple placeholders in one string", () => {
    const result = interpolateCredentials(
      "user={{username}}&pass={{password}}",
      credentials
    );
    expect(result).toBe("user=test@example.com&pass=secret123");
  });

  it("should replace multiple occurrences of same placeholder", () => {
    const result = interpolateCredentials(
      "{{username}} and {{username}} again",
      credentials
    );
    expect(result).toBe("test@example.com and test@example.com again");
  });

  it("should handle string with no placeholders", () => {
    const result = interpolateCredentials("plain text", credentials);
    expect(result).toBe("plain text");
  });

  it("should handle empty string", () => {
    const result = interpolateCredentials("", credentials);
    expect(result).toBe("");
  });

  it("should handle missing totp gracefully", () => {
    const credentialsWithoutTotp = {
      username: "user",
      password: "pass",
    };
    const result = interpolateCredentials(
      "totp={{totp}}",
      credentialsWithoutTotp
    );
    expect(result).toBe("totp=");
  });

  it("should handle undefined totp", () => {
    const credentialsWithUndefinedTotp = {
      username: "user",
      password: "pass",
      totp: undefined,
    };
    const result = interpolateCredentials(
      "code={{totp}}",
      credentialsWithUndefinedTotp
    );
    expect(result).toBe("code=");
  });

  it("should not replace partial matches", () => {
    const result = interpolateCredentials("{username}", credentials);
    expect(result).toBe("{username}");
  });

  it("should not replace malformed placeholders", () => {
    const result = interpolateCredentials("{{username}", credentials);
    expect(result).toBe("{{username}");
  });

  it("should handle special characters in credentials", () => {
    const specialCredentials = {
      username: "user+tag@example.com",
      password: "p@ss$w0rd!#%",
      totp: "000000",
    };
    const result = interpolateCredentials(
      "{{username}}:{{password}}",
      specialCredentials
    );
    expect(result).toBe("user+tag@example.com:p@ss$w0rd!#%");
  });

  it("should handle all placeholders together", () => {
    const result = interpolateCredentials(
      "Login with {{username}} using {{password}} and code {{totp}}",
      credentials
    );
    expect(result).toBe(
      "Login with test@example.com using secret123 and code 123456"
    );
  });
});
