import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGithubWebhookSignature } from "../../src/auth/github-webhook.js";

const secret = "test-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyGithubWebhookSignature", () => {
  it("accepts a correctly signed payload", () => {
    const body = JSON.stringify({ action: "opened" });
    expect(verifyGithubWebhookSignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = sign(body);
    const tampered = JSON.stringify({ action: "closed" });
    expect(verifyGithubWebhookSignature(tampered, signature, secret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyGithubWebhookSignature("body", undefined, secret)).toBe(false);
  });

  it("rejects a malformed signature header", () => {
    expect(verifyGithubWebhookSignature("body", "not-sha256=abc", secret)).toBe(false);
  });

  it("rejects a signature produced with the wrong secret", () => {
    const body = "payload";
    const wrongSignature = `sha256=${createHmac("sha256", "wrong-secret").update(body).digest("hex")}`;
    expect(verifyGithubWebhookSignature(body, wrongSignature, secret)).toBe(false);
  });
});
