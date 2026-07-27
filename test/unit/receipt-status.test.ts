import { describe, expect, it } from "vitest";
import { computeReceiptStatus } from "../../src/receipts/receipt-status.js";

describe("computeReceiptStatus", () => {
  it("maps a failed run to failed", () => {
    expect(computeReceiptStatus("failed", [])).toBe("failed");
  });

  it("maps a cancelled run to failed", () => {
    expect(computeReceiptStatus("cancelled", [])).toBe("failed");
  });

  it("maps a blocked run to blocked", () => {
    expect(computeReceiptStatus("blocked", ["confirmed"])).toBe("blocked");
  });

  it("maps an awaiting_fix run to awaiting_fix", () => {
    expect(computeReceiptStatus("awaiting_fix", ["source_confirmed"])).toBe("awaiting_fix");
  });

  it("maps a completed run with no findings to passed", () => {
    expect(computeReceiptStatus("completed", [])).toBe("passed");
  });

  it("maps a completed run with only benign findings to passed_with_findings", () => {
    expect(computeReceiptStatus("completed", ["verified_fixed", "not_reproduced", "dismissed"])).toBe(
      "passed_with_findings",
    );
  });

  it("maps a completed run with an inconclusive finding to inconclusive", () => {
    expect(computeReceiptStatus("completed", ["verified_fixed", "inconclusive"])).toBe("inconclusive");
  });
});
