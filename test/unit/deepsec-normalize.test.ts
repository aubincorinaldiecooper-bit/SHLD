import { describe, expect, it } from "vitest";
import {
  computeFindingFingerprint,
  DeepSecOutputError,
  normalizeConfidence,
  normalizeDeepSecFinding,
  normalizeSeverity,
} from "../../src/adapters/deepsec/normalize.js";

describe("normalizeSeverity / normalizeConfidence", () => {
  it("maps known severity aliases", () => {
    expect(normalizeSeverity("Critical")).toBe("critical");
    expect(normalizeSeverity("moderate")).toBe("medium");
    expect(normalizeSeverity("INFORMATIONAL")).toBe("info");
  });

  it("throws on an unrecognized severity", () => {
    expect(() => normalizeSeverity("catastrophic")).toThrow(DeepSecOutputError);
  });

  it("maps confidence values case-insensitively", () => {
    expect(normalizeConfidence("HIGH")).toBe("high");
  });

  it("throws on an unrecognized confidence", () => {
    expect(() => normalizeConfidence("certain")).toThrow(DeepSecOutputError);
  });
});

describe("computeFindingFingerprint", () => {
  it("is stable across differing line numbers (not part of the input)", () => {
    const a = computeFindingFingerprint({
      repositoryId: "repo_1",
      category: "Authorization",
      filePath: "src/api/projects/[id].ts",
      symbol: "getProject",
      title: "Cross-tenant project access",
    });
    const b = computeFindingFingerprint({
      repositoryId: "repo_1",
      category: "authorization",
      filePath: "src/api/projects/[id].ts",
      symbol: "getProject",
      title: "  Cross-tenant project access  ",
    });
    expect(a).toBe(b);
  });

  it("differs when the file path differs", () => {
    const a = computeFindingFingerprint({
      repositoryId: "repo_1",
      category: "authorization",
      filePath: "src/api/projects/[id].ts",
      title: "Cross-tenant project access",
    });
    const b = computeFindingFingerprint({
      repositoryId: "repo_1",
      category: "authorization",
      filePath: "src/api/other/[id].ts",
      title: "Cross-tenant project access",
    });
    expect(a).not.toBe(b);
  });

  it("differs across repositories for otherwise-identical findings", () => {
    const a = computeFindingFingerprint({
      repositoryId: "repo_1",
      category: "authorization",
      filePath: "src/api/projects/[id].ts",
      title: "Cross-tenant project access",
    });
    const b = computeFindingFingerprint({
      repositoryId: "repo_2",
      category: "authorization",
      filePath: "src/api/projects/[id].ts",
      title: "Cross-tenant project access",
    });
    expect(a).not.toBe(b);
  });
});

describe("normalizeDeepSecFinding", () => {
  it("normalizes a raw finding into the platform schema", () => {
    const normalized = normalizeDeepSecFinding(
      {
        title: "Cross-tenant project access",
        description: "A standard user may retrieve another tenant's project.",
        category: "authorization",
        cwe: "CWE-639",
        severity: "High",
        confidence: "high",
        file_path: "src/api/projects/[id].ts",
        start_line: 82,
        end_line: 113,
        symbol: "getProject",
        recommendation: "Verify the requesting user's tenant matches the project's tenant.",
      },
      "repo_1",
    );

    expect(normalized.severity).toBe("high");
    expect(normalized.confidence).toBe("high");
    expect(normalized.fingerprint).toBe(
      computeFindingFingerprint({
        repositoryId: "repo_1",
        category: "authorization",
        filePath: "src/api/projects/[id].ts",
        symbol: "getProject",
        title: "Cross-tenant project access",
      }),
    );
  });

  it("carries the revalidation verdict through for fix-revalidation output", () => {
    const normalized = normalizeDeepSecFinding(
      {
        title: "Cross-tenant project access",
        description: "...",
        category: "authorization",
        severity: "high",
        confidence: "high",
        file_path: "src/api/projects/[id].ts",
        revalidation_verdict: "false_positive",
      },
      "repo_1",
    );
    expect(normalized.revalidationVerdict).toBe("false_positive");
  });
});
