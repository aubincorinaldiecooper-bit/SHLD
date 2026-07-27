import { describe, expect, it } from "vitest";
import { signWebhookPayload, verifyWebhookSignature } from "../../src/webhooks/sign-payload.js";

describe("webhook payload signing", () => {
  it("round-trips: a signature it produces verifies successfully", () => {
    const payload = JSON.stringify({ run_id: "run_1", status: "completed" });
    const signature = signWebhookPayload(payload, "secret");
    expect(verifyWebhookSignature(payload, signature, "secret")).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ run_id: "run_1" });
    const signature = signWebhookPayload(payload, "secret");
    expect(verifyWebhookSignature(JSON.stringify({ run_id: "run_2" }), signature, "secret")).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const payload = JSON.stringify({ run_id: "run_1" });
    const signature = signWebhookPayload(payload, "secret");
    expect(verifyWebhookSignature(payload, signature, "wrong-secret")).toBe(false);
  });

  it("rejects a malformed signature header", () => {
    expect(verifyWebhookSignature("payload", "not-a-signature", "secret")).toBe(false);
  });
});
